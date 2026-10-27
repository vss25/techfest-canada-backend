import os from "node:os";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import JobLock from "../models/JobLock.js";
import AppNotification from "../models/AppNotification.js";
import SurveyResponse from "../models/SurveyResponse.js";
import CampaignSend from "../models/CampaignSend.js";
import Subscription from "../models/Subscription.js";
import CheckinMark from "../models/CheckinMark.js";
import { AppContent } from "../models/Admin.js";
import { hiddenState } from "./appHide.js";
import { pushToUsers } from "./push.js";
import { ipHash, shortUserAgent } from "./waitlist.js";
import { unsubscribeFor } from "./unsubscribe.js";
import { campaignSendStore } from "./rsvpReminder.js";
import { ENQUIRE_EMAIL } from "./appInviteEmail.js";
import { surveyMessage, sendSurveyBatch, BATCH_SIZE } from "./surveyEmail.js";
import {
  SURVEY_KEY, NOTIFY_BATCH, EMAIL_CAMPAIGN, AUDIENCES, surveyConfig, surveyOpen, cleanSurveySave, cleanAnswers,
  respondentFields, signSurveyToken, verifySurveyToken, surveyUrl, checkedInAudience, scoreGroup, averagesOf, naCountsOf,
  cleanEmail,
} from "./surveyRules.js";

/* =========================================================
   The post-event survey (Oct 26 2026): storage, who's answering, the
   app prompt and the email. Rules: services/surveyRules.js; routes:
   routes/survey.js.
   ---------------------------------------------------------
   The config is AppContent "survey.config" (defaults until management
   saves it; a save writes only the fields it changes, value.<field>,
   so it never undoes notifiedAt). Answers: models/SurveyResponse.js,
   one row per person ("u:<account>" or "e:<email>"), upserted.

   Nothing is sent by itself with the defaults (the organiser: nothing
   until they've reviewed the survey):
     - the app prompt goes when management clicks Send (POST
       /api/console/survey/notify), or, only once management turns
       autoNotify on, by the minute job at opensAt (JobLock
       "survey-notify", the swag snapshot's pattern; it also needs a
       saved config). Either way: one AppNotification (kind "personal",
       batchId "survey-2026", link = their personal survey link) to
       everyone on the app (appOnboarded or lastActiveAt) who isn't
       suspended, hidden from the app or already answered, never twice
       to anyone (the batch is checked), and one push (Settings ›
       Notifications › Announcements off = no push). The apps already
       out there show it in their inbox and open https links. A send
       holds JobLock "survey-notify-send" so two can't run at once.
     - the email goes only when management clicks Send (POST
       /api/console/survey/email): people with a door check-in that day
       (or both days), each address once, never twice (CampaignSend
       "survey-2026", claimed before each batch), never to the
       unsubscribe list (checked again just before), not to people who
       already answered; Resend's batch API, 100 a call.
========================================================= */

const INSTANCE = `${os.hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
const JOB_ID = "survey-notify";
const SEND_LOCK = "survey-notify-send";
const FOREVER_MS = 100 * 365 * 864e5;   // a sent survey email is never sent again (failed ones may be retried)
const isDup = (err) => err?.code === 11000 || /E11000/.test(String(err?.message || ""));
const str = (v) => (v === null || v === undefined ? "" : String(v));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- the config ---------- */

let cache = { at: 0, value: null };
const CACHE_MS = 15_000;

/** The config (defaults filled in), kept 15 s on this server (a save here forgets it at once). */
export async function loadSurvey({ fresh = false } = {}) {
  if (!fresh && cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;
  const row = await AppContent.findOne({ key: SURVEY_KEY }).lean();
  const value = { ...surveyConfig(row?.value ?? null), updatedAt: row?.updatedAt || null, updatedBy: row?.updatedBy || "" };
  cache = { at: Date.now(), value };
  return value;
}
export const forgetSurvey = () => { cache = { at: 0, value: null }; };

/** Management's save → { config } or { error, field, index }. Only the fields sent change. */
export async function saveSurvey(body, { by = "", now = new Date() } = {}) {
  const current = await loadSurvey({ fresh: true });
  const c = cleanSurveySave(body, current);
  if (c.error) return c;
  const set = { updatedBy: by, updatedAt: now };
  for (const [k, v] of Object.entries(c.config)) set[`value.${k}`] = v;
  // The raw driver: AppContent.value is Mixed, and value.<field> must not meet Mongoose's insert defaults.
  await AppContent.collection.updateOne({ key: SURVEY_KEY }, { $set: set, $setOnInsert: { createdAt: now } }, { upsert: true });
  forgetSurvey();
  return { config: await loadSurvey({ fresh: true }), changed: Object.keys(c.config).filter((k) => k !== "retired") };
}

/* ---------- who's answering ---------- */

const USER_FIELDS = "name email jobTitle organization role banned appOnboarded lastActiveAt";
const passTitle = (d = {}) => str(d.jobTitle || d.title).trim();
const passCompany = (d = {}) => str(d.organization || d.organisation || d.company).trim();
const passName = (a) => str(a?.name).trim() || [a?.details?.firstName, a?.details?.lastName].filter(Boolean).join(" ").trim();

const fromUser = (u, via) => ({
  kind: "user", via, user: u, key: `u:${u._id}`, userId: String(u._id), attendeeId: null,
  known: { name: str(u.name).trim(), email: cleanEmail(u.email), title: str(u.jobTitle).trim(), company: str(u.organization).trim() },
});

/** The app's sign-in (Authorization: Bearer <JWT>) → the account, or null. Never throws. */
export async function bearerUser(authorization) {
  const h = str(authorization);
  if (!h.startsWith("Bearer ")) return null;
  try {
    const decoded = jwt.verify(h.slice(7), process.env.JWT_SECRET);
    if (!mongoose.isValidObjectId(decoded?.id)) return null;
    return await User.findById(decoded.id).select(USER_FIELDS).lean();
  } catch {
    return null;
  }
}

/**
 * Who is answering: the app's sign-in first, else a personal link (?t=). → { kind: "user" | "pass", via, key, userId,
 * attendeeId, known: { name, email, title, company }, user? } or null (nobody we know: the shared link).
 */
export async function identify({ authorization = "", token = "" } = {}) {
  const u = await bearerUser(authorization);
  if (u) return fromUser(u, "auth");
  const t = verifySurveyToken(token);
  if (!t) return null;
  if (t.kind === "u") {
    const user = await User.findById(t.id).select(USER_FIELDS).lean();
    return user ? fromUser(user, "token") : null;
  }
  const a = await Attendee.findById(t.id).select("name email details claimedBy").lean();
  if (!a) return null;
  // A pass someone has claimed since: answered as that account.
  if (a.claimedBy) {
    const user = await User.findById(a.claimedBy).select(USER_FIELDS).lean();
    if (user) return fromUser(user, "token");
  }
  const email = cleanEmail(a.email);
  return {
    kind: "pass", via: "pass", key: email ? `e:${email}` : `p:${a._id}`, userId: null, attendeeId: String(a._id),
    known: { name: passName(a), email, title: passTitle(a.details || {}), company: passCompany(a.details || {}) },
  };
}

/** Has this person answered? Their own row, or one with their email (the shared link). */
export async function hasResponded(who) {
  if (!who) return false;
  const or = [{ key: who.key }];
  if (who.known?.email) or.push({ email: who.known.email });
  return !!(await SurveyResponse.exists({ $or: or }));
}

/**
 * Saves a submission (POST /api/survey/responses). → { ok: true, first } or { ok: false, status, code?, field?, error }.
 * One row per person: answering again updates it (its current questions' answers replaced, a deleted question's kept).
 */
export async function submitResponse({ who = null, body = {}, now = new Date(), ip = "", userAgent = "" } = {}) {
  const cfg = await loadSurvey();
  if (!surveyOpen(cfg, now)) return { ok: false, status: 403, code: "closed", error: "The survey isn't open." };
  const b = body && typeof body === "object" ? body : {};
  const known = who?.known || {};
  const fill = {};
  for (const k of ["name", "email", "title", "company"]) fill[k] = str(b[k]).trim() || known[k] || "";
  const c = cleanAnswers(cfg.questions, b.answers, { fill });
  if (!c.ok) return { ok: false, status: 400, field: c.field, error: c.error };
  const fields = respondentFields(c.answers, b, known);
  if (!who && !fields.email) return { ok: false, status: 400, field: "email", error: "Please enter your email address." };
  const key = who?.key || `e:${fields.email}`;
  const set = {
    source: who?.kind === "user" ? "app" : "link", via: who?.via || "anonymous",
    userId: who?.userId ? new mongoose.Types.ObjectId(who.userId) : null,
    attendeeId: who?.attendeeId ? new mongoose.Types.ObjectId(who.attendeeId) : null,
    ...fields, submittedAt: now, updatedAt: now, userAgent: shortUserAgent(userAgent), ipHash: ipHash(ip),
  };
  for (const [id, v] of Object.entries(c.answers)) set[`answers.${id}`] = v;
  const update = { $set: set, $inc: { count: 1 }, $setOnInsert: { createdAt: now } };
  if (c.unanswered.length) update.$unset = Object.fromEntries(c.unanswered.map((id) => [`answers.${id}`, ""]));
  // The raw driver: answers.<id> paths on a Mixed field, no Mongoose insert defaults in the way.
  const run = () => SurveyResponse.collection.updateOne({ key }, update, { upsert: true });
  let r;
  try {
    r = await run();
  } catch (err) {
    if (!isDup(err)) throw err;
    r = await run();   // two first answers at once: the second updates the first's row
  }
  return { ok: true, first: !!r.upsertedCount };
}

/* ---------- the admin panel's numbers ---------- */

/** { counts: { responses, app, link }, averages: { [id]: n | null }, na: { [id]: n } }: the current questions'. */
export async function surveyStats(cfg) {
  const [responses, app, rows] = await Promise.all([
    SurveyResponse.estimatedDocumentCount(),
    SurveyResponse.countDocuments({ source: "app" }),
    SurveyResponse.aggregate([{ $group: scoreGroup(cfg.questions) }]),
  ]);
  return {
    counts: { responses, app, link: Math.max(0, responses - app) },
    averages: averagesOf(cfg.questions, rows[0] || {}),
    na: naCountsOf(cfg.questions, rows[0] || {}),
  };
}

/* ---------- the app prompt ---------- */

async function claimLock(id, now, ms) {
  try {
    const r = await JobLock.findOneAndUpdate({ _id: id, until: { $lte: now } }, { $set: { until: new Date(now.getTime() + ms), owner: INSTANCE } },
      { upsert: true, returnDocument: "after", projection: { owner: 1 } }).lean();
    return r?.owner === INSTANCE;
  } catch (err) {
    if (isDup(err)) return false;
    throw err;
  }
}
const releaseLock = (id) => JobLock.updateOne({ _id: id, owner: INSTANCE }, { $set: { until: new Date(0) } }).catch(() => {});

/** Everyone the prompt is for now: on the app, not suspended, not hidden from the app, not answered, not prompted. */
export async function promptAudience() {
  const users = await User.find({ $or: [{ appOnboarded: true }, { lastActiveAt: { $ne: null } }], banned: { $ne: true } }).select("_id email").lean();
  if (!users.length) return { ids: [], already: 0, answered: 0, hidden: 0 };
  const hidden = await hiddenState();
  const ids = users.map((u) => u._id);
  const [answeredRows, prompted] = await Promise.all([
    SurveyResponse.find({ $or: [{ userId: { $in: ids } }, { email: { $in: users.map((u) => cleanEmail(u.email)).filter(Boolean) } }] }).select("userId email").lean(),
    AppNotification.distinct("userId", { batchId: NOTIFY_BATCH }),
  ]);
  const answeredIds = new Set(answeredRows.map((r) => str(r.userId)).filter(Boolean));
  const answeredEmails = new Set(answeredRows.map((r) => r.email).filter(Boolean));
  const promptedIds = new Set(prompted.map(str));
  const out = { ids: [], already: 0, answered: 0, hidden: 0 };
  for (const u of users) {
    const id = str(u._id);
    if (hidden.ids.has(id)) { out.hidden += 1; continue; }
    if (answeredIds.has(id) || answeredEmails.has(cleanEmail(u.email))) { out.answered += 1; continue; }
    if (promptedIds.has(id)) { out.already += 1; continue; }
    out.ids.push(id);
  }
  return out;
}

/**
 * Sends the prompt now (management's click, or the job at opensAt): each person in promptAudience() an in-app
 * notification with their own link, and a push. → { sent, already, answered, hidden } or { busy: true } when another
 * send is running.
 */
export async function sendPrompt({ cfg = null, by = "TTFC", byId = null, now = new Date() } = {}) {
  const c = cfg || (await loadSurvey({ fresh: true }));
  if (!(await claimLock(SEND_LOCK, now, 5 * 60_000))) return { busy: true };
  try {
    const aud = await promptAudience();
    for (let i = 0; i < aud.ids.length; i += 500) {
      const chunk = aud.ids.slice(i, i + 500);
      await AppNotification.insertMany(chunk.map((id) => ({
        userId: id, title: c.notifyTitle.slice(0, 80), body: c.notifyBody.slice(0, 500), link: surveyUrl(signSurveyToken("u", id)),
        kind: "personal", batchId: NOTIFY_BATCH, ...(byId ? { sentBy: byId } : {}), sentByName: by,
      })));
    }
    // One push for all (each person's own link is in their inbox, where it opens): not to people who switched
    // "Announcements from TTFC" off, like the other messages to everyone.
    if (aud.ids.length) {
      pushToUsers(aud.ids, { title: c.notifyTitle, body: c.notifyBody, link: "", kind: "personal", id: NOTIFY_BATCH, url: "/app/notifications" }, { pref: "announcements" });
    }
    await AppContent.collection.updateOne({ key: SURVEY_KEY },
      { $set: { "value.notifiedAt": now, updatedAt: now }, $inc: { "value.notifiedCount": aud.ids.length }, $setOnInsert: { createdAt: now, updatedBy: by } },
      { upsert: true });
    forgetSurvey();
    return { sent: aud.ids.length, already: aud.already, answered: aud.answered, hidden: aud.hidden };
  } finally {
    await releaseLock(SEND_LOCK);
  }
}

/**
 * One run of the minute job: with a saved config that's on, open, autoNotify on and not prompted yet → the prompt,
 * once (notifiedAt claimed first). With the defaults (autoNotify off) it never sends. Never throws.
 */
export async function runSurveyNotify({ now = new Date(), held = false } = {}) {
  try {
    const cfg = await loadSurvey({ fresh: true });
    if (!cfg.saved || !cfg.enabled || !cfg.autoNotify || cfg.notifiedAt || !surveyOpen(cfg, now)) return null;
    if (!held && !(await claimLock(JOB_ID, now, 50_000))) return null;
    // Claimed in the database: whichever server gets here first sends, once.
    const r = await AppContent.collection.updateOne({ key: SURVEY_KEY, "value.autoNotify": true, "value.notifiedAt": null }, { $set: { "value.notifiedAt": now } });
    if (!r.modifiedCount) return null;
    const out = await sendPrompt({ cfg, by: "TTFC", now });
    if (out.busy) {
      await AppContent.collection.updateOne({ key: SURVEY_KEY, "value.notifiedAt": now }, { $set: { "value.notifiedAt": null } });   // try again next minute
      return null;
    }
    return out;
  } catch (err) {
    console.error("SURVEY NOTIFY ERROR:", err?.message || err);
    return null;
  }
}

/** server.js, once connected: a check every minute (it sends nothing unless management turned autoNotify on). */
export function startSurveyNotify({ everyMs = 60_000 } = {}) {
  const t = setInterval(() => { runSurveyNotify(); }, everyMs);
  t.unref?.();
  return t;
}

/* ---------- the email ---------- */

/** A person's link: their account's token, else their pass's, else the plain page. */
export const linkFor = (row) => surveyUrl(row.userId ? signSurveyToken("u", row.userId) : row.attendeeId ? signSurveyToken("p", row.attendeeId) : "");

/**
 * Who the email would go to for this audience ("day1" | "day2" | "both"), from the People directory (`dir`:
 * routes/people.js directory()) and the check-in desk's marks. → { audience, days, rows (each with `skip`: "" |
 * "unsubscribed" | "alreadySent" | "responded"), toSend, counts: { checkedIn, toSend, unsubscribed, alreadySent,
 * responded, noEmail } }
 */
export async function emailPlan(audience, dir) {
  const days = AUDIENCES[audience];
  if (!days) throw Object.assign(new Error("audience must be day1, day2 or both."), { status: 400 });
  const marks = await CheckinMark.find({ day: { $in: days }, point: { $in: ["arrived", "checked_in"] }, at: { $ne: null }, practice: { $ne: true } })
    .select("subject day point at practice").lean();
  const aud = checkedInAudience({ byId: dir?.byId || new Map(), marks, days });
  const emails = aud.rows.map((r) => r.email);
  const userIds = aud.rows.map((r) => r.userId).filter(Boolean);
  const [optedOut, sends, answered] = emails.length ? await Promise.all([
    Subscription.find({ subscribed: false, email: { $in: emails } }).select("email").lean(),
    CampaignSend.find({ campaign: EMAIL_CAMPAIGN, email: { $in: emails }, status: { $in: ["sent", "sending"] } }).select("email").lean(),
    SurveyResponse.find({ $or: [{ email: { $in: emails } }, { userId: { $in: userIds } }] }).select("email userId").lean(),
  ]) : [[], [], []];
  const off = new Set(optedOut.map((s) => s.email));
  const sent = new Set(sends.map((s) => s.email));
  const answeredEmails = new Set(answered.map((r) => r.email).filter(Boolean));
  const answeredIds = new Set(answered.map((r) => str(r.userId)).filter(Boolean));
  const rows = aud.rows.map((r) => ({
    ...r,
    skip: off.has(r.email) ? "unsubscribed" : sent.has(r.email) ? "alreadySent"
      : answeredEmails.has(r.email) || (r.userId && answeredIds.has(r.userId)) ? "responded" : "",
  }));
  const toSend = rows.filter((r) => !r.skip);
  const n = (why) => rows.filter((r) => r.skip === why).length;
  return {
    audience, days, rows, toSend,
    counts: { checkedIn: rows.length + aud.noEmail, toSend: toSend.length, unsubscribed: n("unsubscribed"), alreadySent: n("alreadySent"), responded: n("responded"), noEmail: aud.noEmail },
  };
}

/**
 * Sends the survey email to everyone in the plan who should get it, 100 to a Resend batch call. Each address is
 * claimed first (CampaignSend "survey-2026": a sent one is never sent again, one being sent is left alone, a failed
 * one may be retried) and checked against the unsubscribe list just before. → { sent, skipped, failed, counts }
 */
export async function sendSurveyEmails({ plan, cfg, by = "", send = sendSurveyBatch, gapMs = 600, now = () => new Date() }) {
  const store = campaignSendStore(CampaignSend, { campaign: EMAIL_CAMPAIGN, cooldownMs: FOREVER_MS, Subscription });
  let sent = 0;
  let skipped = plan.rows.length - plan.toSend.length;
  let failed = 0;
  for (let i = 0; i < plan.toSend.length; i += BATCH_SIZE) {
    const chunk = plan.toSend.slice(i, i + BATCH_SIZE);
    const claimed = [];
    await Promise.all(chunk.map(async (r) => {
      if (await store.optedOut(r.email)) { skipped += 1; return; }
      if (!(await store.claim(r.email, { name: r.name, by, now: now() }))) { skipped += 1; return; }
      claimed.push(r);
    }));
    if (!claimed.length) continue;
    const messages = claimed.map((r) => surveyMessage({
      to: r.email, firstName: r.firstName, url: linkFor(r), copy: cfg,
      unsubscribe: unsubscribeFor(r.email, { real: true, mailto: ENQUIRE_EMAIL }),
    }));
    try {
      const out = await send(messages);
      const at = now();
      await Promise.all(out.map((o) => store.sent(o.to, { sentAt: at, resendId: o.id })));
      sent += out.length;
    } catch (err) {
      const why = String(err?.message || err || "Send failed").slice(0, 300);
      console.error("SURVEY EMAIL BATCH ERROR:", why);
      await Promise.all(claimed.map((r) => store.failed(r.email, why)));
      failed += claimed.length;
    }
    if (gapMs && i + BATCH_SIZE < plan.toSend.length) await pause(gapMs);   // Resend: a couple of calls a second
  }
  return { sent, skipped, failed, counts: plan.counts };
}
