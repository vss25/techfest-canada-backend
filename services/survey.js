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
import { normalizeTicketId } from "./ticketAccess.js";
import { ENQUIRE_EMAIL } from "./appInviteEmail.js";
import { surveyMessage, sendSurveyBatch, BATCH_SIZE } from "./surveyEmail.js";
import {
  SURVEY_KEY, NOTIFY_BATCH, EMAIL_CAMPAIGN, AUDIENCES, EVENT_DAYS, DOOR_POINTS, INVITE_ONLY_MESSAGE, NOT_ATTENDED_MESSAGE,
  surveyConfig, surveyOpen, cleanSurveySave, cleanAnswers, respondentFields, signSurveyToken, verifySurveyToken, surveyUrl,
  checkedInAudience, checkedInPersons, checkedInKeys, personsMatching, personSubjects, personEmails, linkTarget, scoreGroup,
  averagesOf, naCountsOf, cleanEmail, waveDue, notifyWindow, trackingRows, trackingIndex, personKeys, filterTracking,
  trackingCounts,
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

   What goes out by itself (Oct 26 2026, late: "prompted/notified some
   time after 4 pm. All of them don't need to be notified
   immediately"; earlier that evening nothing went by itself):
     - the app prompt, in waves (autoNotify, on by default): the minute
       job (JobLock "survey-notify", the swag snapshot's pattern) from
       opensAt + notifyStartDelayMin sends notifyBatchSize people every
       notifyIntervalMin minutes, until 10 PM Toronto on the opening
       day; management's Send (POST /api/console/survey/notify) sends
       everyone left at once. Either way: one AppNotification (kind "personal",
       batchId "survey-2026", link = their personal survey link) to
       everyone on the app (appOnboarded or lastActiveAt, the most
       recently active first) who checked in and isn't suspended, hidden
       from the app or already answered, never twice
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

   By invitation, for people who attended (Oct 26 2026, later that
   night): no answers without a personal link or the app's sign-in (the
   typed-email path is gone); nobody without a door check-in on Day 1 or
   Day 2 sees the questions, answers, gets the app's card or the prompt
   (isCheckedIn per request, checkedInIndex for the prompt: people still
   check in on Day 2, so it's never cached beyond the request). The
   People directory (routes/people.js directory(), its 20-second copy)
   joins a person's passes and addresses; the marks are read fresh. The
   email skips people it can't give a personal link (no account, no
   pass: noLink). Staff get one person's link, or a list's, for
   one-on-one sharing (personalLinks).
========================================================= */

const INSTANCE = `${os.hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
const JOB_ID = "survey-notify";
const SEND_LOCK = "survey-notify-send";
const FOREVER_MS = 100 * 365 * 864e5;   // a sent survey email is never sent again (failed ones may be retried)
const isDup = (err) => err?.code === 11000 || /E11000/.test(String(err?.message || ""));
const str = (v) => (v === null || v === undefined ? "" : String(v));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
/** The People directory (routes/people.js, loaded when first needed so this file stays importable on its own). */
const peopleDirectory = async () => (await import("../routes/people.js")).directory();

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

const USER_FIELDS = "name email jobTitle organization role banned appOnboarded lastActiveAt tickets.ticketId";
const passTitle = (d = {}) => str(d.jobTitle || d.title).trim();
const passCompany = (d = {}) => str(d.organization || d.organisation || d.company).trim();
const passName = (a) => str(a?.name).trim() || [a?.details?.firstName, a?.details?.lastName].filter(Boolean).join(" ").trim();

/** An account as identify() gives it (the app's card and the prompt check the same way). */
export const asRespondent = (u, via = "auth") => fromUser(u, via);
const fromUser = (u, via) => ({
  kind: "user", via, user: u, key: `u:${u._id}`, userId: String(u._id), attendeeId: null,
  tickets: (u.tickets || []).map((t) => t?.ticketId).filter(Boolean),
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
 * attendeeId, tickets, known: { name, email, title, company }, user? } or null (nobody we know: refused, by invitation).
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
  const a = await Attendee.findById(t.id).select("name email details claimedBy ticketId").lean();
  if (!a) return null;
  // A pass someone has claimed since: answered as that account.
  if (a.claimedBy) {
    const user = await User.findById(a.claimedBy).select(USER_FIELDS).lean();
    if (user) return fromUser(user, "token");
  }
  const email = cleanEmail(a.email);
  return {
    kind: "pass", via: "pass", key: email ? `e:${email}` : `p:${a._id}`, userId: null, attendeeId: String(a._id),
    tickets: a.ticketId ? [a.ticketId] : [],
    known: { name: passName(a), email, title: passTitle(a.details || {}), company: passCompany(a.details || {}) },
  };
}

/* ---------- who checked in ---------- */

/** Door check-ins (CheckinMark: arrived, checked_in) on these days, practice left out. */
const doorFilter = (days = EVENT_DAYS) => ({ day: { $in: days }, point: { $in: DOOR_POINTS }, at: { $ne: null }, practice: { $ne: true } });

/**
 * Did this person (identify()'s answer, or { userId, attendeeId, email, tickets }) have a door check-in on Day 1 or
 * Day 2? Their account's or pass's person in the People directory, everyone on their email address, and (in case the
 * directory's copy is older than a pass) the passes on the account or the link itself. Read now, every time.
 */
export async function isCheckedIn(who, { directory = peopleDirectory } = {}) {
  if (!who) return false;
  const dir = await directory().catch((err) => { console.error("SURVEY DIRECTORY ERROR:", err?.message || err); return null; });
  const email = who.known?.email || who.email || "";
  const subjects = new Set(personSubjects(personsMatching(dir, { userId: who.userId, attendeeId: who.attendeeId, email })));
  for (const t of who.tickets || []) { const n = normalizeTicketId(t); if (n) subjects.add(n); }
  if (who.userId) subjects.add(`person:u-${who.userId}`);
  if (who.attendeeId) subjects.add(`person:a-${who.attendeeId}`);
  if (!subjects.size) return false;
  return !!(await CheckinMark.exists({ subject: { $in: [...subjects] }, ...doorFilter() }));
}

/** May this person (identify()'s answer) see and answer the survey? Anyone invited, unless the config keeps it to
    people who checked in (checkedInOnly). */
export async function canAnswer(who, cfg, { checkedIn = () => isCheckedIn(who) } = {}) {
  if (!who) return false;
  return cfg?.checkedInOnly ? !!(await checkedIn()) : true;
}

/** Everyone with a door check-in now, for the prompt and staff's links: { persons, userIds: Set, emails: Set }. */
export async function checkedInIndex({ directory = peopleDirectory } = {}) {
  const [dir, marks] = await Promise.all([directory(), CheckinMark.find(doorFilter()).select("subject day point at practice").lean()]);
  const { persons } = checkedInPersons({ byId: dir?.byId || new Map(), marks, days: EVENT_DAYS });
  return { dir, persons: new Set(persons), ...checkedInKeys(persons) };
}

/** Has this person answered? Their own row, or one with their email (a pass's link, or a row from before it was by
    invitation). */
export async function hasResponded(who) {
  if (!who) return false;
  const or = [{ key: who.key }];
  if (who.known?.email) or.push({ email: who.known.email });
  return !!(await SurveyResponse.exists({ $or: or }));
}

/**
 * Saves a submission (POST /api/survey/responses). → { ok: true, first } or { ok: false, status, code?, field?, error }.
 * By invitation: `who` (a personal link or the app's sign-in) is required (403 link_required), and they must have
 * checked in (`checkedIn()`, 403 not_checked_in). One row per person: answering again updates it (its current
 * questions' answers replaced, a deleted question's kept).
 */
export async function submitResponse({ who = null, body = {}, now = new Date(), ip = "", userAgent = "", checkedIn = () => isCheckedIn(who) } = {}) {
  if (!who) return { ok: false, status: 403, code: "link_required", error: INVITE_ONLY_MESSAGE };
  const cfg = await loadSurvey();
  if (!surveyOpen(cfg, now)) return { ok: false, status: 403, code: "closed", error: "The survey isn't open." };
  if (!(await canAnswer(who, cfg, { checkedIn }))) return { ok: false, status: 403, code: "not_checked_in", error: NOT_ATTENDED_MESSAGE };
  const b = body && typeof body === "object" ? body : {};
  const known = who?.known || {};
  const fill = {};
  for (const k of ["name", "email", "title", "company"]) fill[k] = str(b[k]).trim() || known[k] || "";
  const c = cleanAnswers(cfg.questions, b.answers, { fill });
  if (!c.ok) return { ok: false, status: 400, field: c.field, error: c.error };
  const fields = respondentFields(c.answers, b, known);
  const key = who.key;
  const set = {
    source: who.kind === "user" ? "app" : "link", via: who.via,
    userId: who.userId ? new mongoose.Types.ObjectId(who.userId) : null,
    attendeeId: who.attendeeId ? new mongoose.Types.ObjectId(who.attendeeId) : null,
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

/**
 * Everyone the prompt is for now: on the app, not suspended, not hidden from the app, checked in (`checked`:
 * checkedInIndex()), not answered, not prompted.
 */
export async function promptAudience({ checked = null } = {}) {
  // The most recently active first (the paced waves take them in this order).
  const users = await User.find({ $or: [{ appOnboarded: true }, { lastActiveAt: { $ne: null } }], banned: { $ne: true } })
    .select("_id email lastActiveAt").sort({ lastActiveAt: -1, _id: 1 }).lean();
  if (!users.length) return { ids: [], already: 0, answered: 0, hidden: 0, notCheckedIn: 0 };
  const [hidden, ci] = await Promise.all([hiddenState(), checked || checkedInIndex()]);
  const ids = users.map((u) => u._id);
  const [answeredRows, prompted] = await Promise.all([
    SurveyResponse.find({ $or: [{ userId: { $in: ids } }, { email: { $in: users.map((u) => cleanEmail(u.email)).filter(Boolean) } }] }).select("userId email").lean(),
    AppNotification.distinct("userId", { batchId: NOTIFY_BATCH }),
  ]);
  const answeredIds = new Set(answeredRows.map((r) => str(r.userId)).filter(Boolean));
  const answeredEmails = new Set(answeredRows.map((r) => r.email).filter(Boolean));
  const promptedIds = new Set(prompted.map(str));
  const out = { ids: [], already: 0, answered: 0, hidden: 0, notCheckedIn: 0 };
  for (const u of users) {
    const id = str(u._id);
    if (hidden.ids.has(id)) { out.hidden += 1; continue; }
    if (!ci.userIds.has(id) && !ci.emails.has(cleanEmail(u.email))) { out.notCheckedIn += 1; continue; }
    if (answeredIds.has(id) || answeredEmails.has(cleanEmail(u.email))) { out.answered += 1; continue; }
    if (promptedIds.has(id)) { out.already += 1; continue; }
    out.ids.push(id);
  }
  return out;
}

/**
 * Sends the prompt now (management's click: everyone left; a wave of the job: the first `limit`): each person in
 * promptAudience() an in-app notification with their own link, and a push, once ever (batchId "survey-2026"; its
 * createdAt is when they were prompted: appNotifiedAt). → { sent, remaining, already, answered, hidden, notCheckedIn }
 * or { busy: true } when another send is running.
 */
export async function sendPrompt({ cfg = null, by = "TTFC", byId = null, now = new Date(), checked = null, limit = Infinity } = {}) {
  const c = cfg || (await loadSurvey({ fresh: true }));
  if (!(await claimLock(SEND_LOCK, now, 5 * 60_000))) return { busy: true };
  try {
    const aud = await promptAudience({ checked });
    const all = aud.ids;
    aud.ids = all.slice(0, Math.max(0, limit));
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
    if (aud.ids.length) {
      await AppContent.collection.updateOne({ key: SURVEY_KEY },
        { $min: { "value.notifiedAt": now }, $set: { updatedAt: now }, $inc: { "value.notifiedCount": aud.ids.length }, $setOnInsert: { createdAt: now, updatedBy: by } },
        { upsert: true });
    }
    forgetSurvey();
    return {
      sent: aud.ids.length, remaining: all.length - aud.ids.length, already: aud.already, answered: aud.answered, hidden: aud.hidden,
      notCheckedIn: aud.notCheckedIn,
    };
  } finally {
    await releaseLock(SEND_LOCK);
  }
}

/**
 * One run of the minute job (the paced prompt): when a wave is due (services/surveyRules.js waveDue: on, autoNotify
 * on, from opensAt + the delay, an interval since the last wave, before 10 PM Toronto on the opening day), the next
 * notifyBatchSize people in promptAudience() order. One server per wave: the JobLock, then the wave itself claimed in
 * the config (notifyLastWaveAt moved from the value this server read, so a second server's claim misses). People who
 * check in or come to the app later get theirs in a later wave. → sendPrompt's answer, or null. Never throws.
 */
export async function runSurveyNotify({ now = new Date(), held = false } = {}) {
  try {
    const cfg = await loadSurvey({ fresh: true });
    if (!surveyOpen(cfg, now)) return null;
    const last = cfg.notifyLastWaveAt ? new Date(cfg.notifyLastWaveAt) : null;
    if (!waveDue(cfg, { now, lastWaveAt: last }).due) return null;
    if (!held && !(await claimLock(JOB_ID, now, 50_000))) return null;
    // The wave, claimed in the database (an upsert when nothing is saved yet: the unique key turns a second insert away).
    try {
      const r = await AppContent.collection.updateOne({ key: SURVEY_KEY, "value.notifyLastWaveAt": last },
        { $set: { "value.notifyLastWaveAt": now }, $setOnInsert: { createdAt: now, updatedBy: "TTFC" } }, { upsert: true });
      if (!r.modifiedCount && !r.upsertedCount) return null;
    } catch (err) {
      if (isDup(err)) return null;
      throw err;
    }
    forgetSurvey();
    const out = await sendPrompt({ cfg, by: "TTFC", now, limit: cfg.notifyBatchSize });
    if (out.busy) {
      // Management's Send is running: give this wave back (it's tried again next minute).
      await AppContent.collection.updateOne({ key: SURVEY_KEY, "value.notifyLastWaveAt": now }, { $set: { "value.notifyLastWaveAt": last } });
      return null;
    }
    if (out.sent) console.log(`SURVEY PROMPT WAVE: ${out.sent} sent, ${out.remaining} left`);
    return out;
  } catch (err) {
    console.error("SURVEY NOTIFY ERROR:", err?.message || err);
    return null;
  }
}

/** The admin page's view of the paced prompt: { sent, remaining, nextAt, done, auto, startsAt, endsAt, batchSize,
    intervalMin, lastWaveAt }. done = nobody is waiting and a wave has gone, or the automatic window is over. */
export async function notifyProgress(cfg, { now = new Date() } = {}) {
  const [sent, aud] = await Promise.all([AppNotification.countDocuments({ batchId: NOTIFY_BATCH }), promptAudience()]);
  const w = notifyWindow(cfg);
  const due = waveDue(cfg, { now, lastWaveAt: cfg.notifyLastWaveAt });
  const over = !!w && new Date(now) >= w.endsAt;
  const remaining = aud.ids.length;
  return {
    sent, remaining, auto: !!(cfg.enabled && cfg.autoNotify),
    nextAt: due.nextAt && !over ? new Date(Math.max(due.nextAt.getTime(), new Date(now).getTime())).toISOString() : null,
    done: over || (sent > 0 && remaining === 0),
    startsAt: w ? w.startsAt.toISOString() : null, endsAt: w ? w.endsAt.toISOString() : null,
    batchSize: cfg.notifyBatchSize, intervalMin: cfg.notifyIntervalMin, lastWaveAt: cfg.notifyLastWaveAt,
  };
}

/** server.js, once connected: a check every minute (the paced prompt's waves; nothing outside its window). */
export function startSurveyNotify({ everyMs = 60_000 } = {}) {
  const t = setInterval(() => { runSurveyNotify(); }, everyMs);
  t.unref?.();
  return t;
}

/* ---------- who answered: the admin panel's tracking list ---------- */

/** The sends and answers so far → statusOf (services/surveyRules.js trackingIndex). */
export async function loadTracking() {
  const [sends, notes, responses] = await Promise.all([
    CampaignSend.find({ campaign: EMAIL_CAMPAIGN, status: "sent" }).select("email sentAt").lean(),
    AppNotification.find({ batchId: NOTIFY_BATCH }).select("userId createdAt").lean(),
    SurveyResponse.find({}).select("userId attendeeId email createdAt submittedAt updatedAt source").lean(),
  ]);
  return trackingIndex({ sends, notes, responses });
}

/** Everyone with a door check-in, with when they were emailed, prompted and answered (filterTracking order). */
export async function trackingList({ directory = peopleDirectory } = {}) {
  const [dir, marks, statusOf] = await Promise.all([
    directory(), CheckinMark.find(doorFilter()).select("subject day point at practice").lean(), loadTracking(),
  ]);
  const byId = dir?.byId || new Map();
  const byDay = {};
  for (const [key, days] of [["day1", AUDIENCES.day1], ["day2", AUDIENCES.day2]]) byDay[key] = checkedInPersons({ byId, marks, days }).persons;
  return trackingRows({ byDay, statusOf });
}

export const PEOPLE_PAGE = 50;

/** GET /api/console/survey/people → { total, page, size, counts, rows }. */
export async function surveyPeople({ status = "all", q = "", page = 0 } = {}, opts = {}) {
  const all = await trackingList(opts);
  const rows = filterTracking(all, { status, q });
  const p = Math.max(0, Math.floor(Number(page)) || 0);
  return { total: rows.length, page: p, size: PEOPLE_PAGE, counts: trackingCounts(all), rows: rows.slice(p * PEOPLE_PAGE, (p + 1) * PEOPLE_PAGE) };
}

/* ---------- the email ---------- */

/** A person's link: their account's token, else their pass's, else the plain page. */
export const linkFor = (row) => surveyUrl(row.userId ? signSurveyToken("u", row.userId) : row.attendeeId ? signSurveyToken("p", row.attendeeId) : "");

/* ---------- staff's personal links ---------- */

export const NOT_CHECKED_IN_WARNING = "Hasn't checked in — the survey will refuse them.";
export const MAX_LINKS = 500;

/**
 * Personal survey links for one-on-one sharing (Admin, management): for each email (or People id), the person with an
 * account or a pass → { email, name, url, checkedIn, warning? } (warning when they haven't checked in: the survey
 * will refuse them, but staff still see the link), or { email, error } when nobody with a pass or an account has it.
 * `queries`: [{ email } | { person }].
 */
export async function personalLinks(queries = [], { directory = peopleDirectory } = {}) {
  const [ci, statusOf, cfg] = await Promise.all([checkedInIndex({ directory }), loadTracking(), loadSurvey()]);
  const dir = ci.dir;
  return queries.map((q) => {
    const asked = q.person ? str(q.person) : cleanEmail(q.email);
    const key = q.person ? "person" : "email";
    if (!asked) return { [key]: str(q.email || q.person).slice(0, 254), error: "That isn't an email address." };
    const persons = q.person ? [dir?.byId?.get(asked)].filter(Boolean) : personsMatching(dir, { email: asked });
    // An account first, else a pass on that address.
    const p = persons.find((x) => x.user?._id) || persons.find((x) => linkTarget(x, asked)) || null;
    const target = linkTarget(p, q.person ? "" : asked);
    if (!p || !target) return { [key]: asked, error: q.person ? "Nobody in People with a pass or an account has that id." : "Nobody with a TTFC pass or account has that email." };
    const email = q.person ? (cleanEmail(p.email) || personEmails(p)[0] || "") : asked;
    const same = q.person ? [p, ...personsMatching(dir, { email })] : persons;
    const checkedIn = same.some((x) => ci.persons.has(x)) || personEmails(p).some((e) => ci.emails.has(e)) || (p.user?._id && ci.userIds.has(str(p.user._id)));
    const name = str(p.name) === "No name" ? "" : str(p.name).trim();
    // Answered already, emailed, prompted: so nobody sends it again by hand to someone who has filled it in.
    const st = statusOf(personKeys(same));
    return {
      email, name, url: surveyUrl(signSurveyToken(target.kind, target.id)), kind: target.kind === "u" ? "account" : "pass",
      checkedIn: !!checkedIn, ...(checkedIn || !cfg.checkedInOnly ? {} : { warning: NOT_CHECKED_IN_WARNING }),
      answeredAt: st.answeredAt, emailedAt: st.emailedAt, appNotifiedAt: st.appNotifiedAt,
    };
  });
}

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
    SurveyResponse.find({ $or: [{ email: { $in: emails } }, { userId: { $in: userIds } }, { attendeeId: { $in: aud.rows.map((r) => r.attendeeId).filter(Boolean) } }] }).select("email userId attendeeId").lean(),
  ]) : [[], [], []];
  const off = new Set(optedOut.map((s) => s.email));
  const sent = new Set(sends.map((s) => s.email));
  const answeredEmails = new Set(answered.map((r) => r.email).filter(Boolean));
  const answeredIds = new Set(answered.map((r) => str(r.userId)).filter(Boolean));
  const answeredAttendees = new Set(answered.map((r) => str(r.attendeeId)).filter(Boolean));
  // By invitation: someone with neither an account nor a pass (an ISSUE PASS person) can't be given a personal link.
  // Answered comes before already sent: someone who answered after an earlier email is never sent it again, whatever
  // its send record says (a failed row would otherwise be tried again).
  const rows = aud.rows.map((r) => ({
    ...r,
    skip: !r.userId && !r.attendeeId ? "noLink" : off.has(r.email) ? "unsubscribed"
      : answeredEmails.has(r.email) || (r.userId && answeredIds.has(r.userId)) || (r.attendeeId && answeredAttendees.has(r.attendeeId)) ? "responded"
        : sent.has(r.email) ? "alreadySent" : "",
  }));
  const toSend = rows.filter((r) => !r.skip);
  const n = (why) => rows.filter((r) => r.skip === why).length;
  return {
    audience, days, rows, toSend,
    counts: {
      checkedIn: rows.length + aud.noEmail, toSend: toSend.length, unsubscribed: n("unsubscribed"), alreadySent: n("alreadySent"),
      responded: n("responded"), noEmail: aud.noEmail, noLink: n("noLink"),
    },
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
