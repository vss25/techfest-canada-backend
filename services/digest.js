import os from "node:os";
import crypto from "node:crypto";
import mongoose from "mongoose";
import User from "../models/User.js";
import JobLock from "../models/JobLock.js";
import CampaignSend from "../models/CampaignSend.js";
import Subscription from "../models/Subscription.js";
import DigestState from "../models/DigestState.js";
import GroupSeen from "../models/GroupSeen.js";
import ActivityEvent from "../models/ActivityEvent.js";
import { AppContent, Block } from "../models/Admin.js";
import { SocialMessage, SocialConnection, SocialPost } from "../models/Social.js";
import { Discussion, CommunityGroup, GroupMessage } from "../models/Community.js";
import { viewerHide, unseenOf, oids } from "./appHide.js";
import { personAccess } from "./appRights.js";
import { rightsContext, RIGHTS_SELECT } from "./rightsStore.js";
import { isOnApp } from "./socialHelpers.js";
import { usableEmail } from "./attendingCampaign.js";
import { prefsOf } from "./notifyPrefs.js";
import { trackSecret } from "./trackToken.js";
import { isUnsubscribed } from "./unsubscribe.js";
import { apiBaseUrl } from "./walletLink.js";
import { snippet } from "./notify.js";
import { nextDigest, slotKey, dayKey, afterSend, DELAY_MS } from "./digestRules.js";
import { sendDigestEmail, sortItems } from "./digestEmail.js";
import { SYSTEM_ID } from "./sessionGroups.js";

/* =========================================================
   "What you missed" emails (Oct 22 2026)
   ---------------------------------------------------------
   Every minute one server (JobLock row "digests") does a run while
   staff have the emails switched on (Admin › Website & app › "What
   you missed" emails, AppContent "digest.enabled", OFF by default):
     1. Scan what's new since the last run (approved DMs, new
        connection requests, activity rows: likes, comments, mentions,
        replies, and approved group / session chat messages, for each
        member but the author) and note each recipient's oldest one
        not yet emailed (DigestState.pendingSince).
     2. Everyone whose digest is due now (services/digestRules.js:
        3 h after, 5 PM, 4–5 PM skip, quiet hours, 60-minute gap, 3 a
        day) gets one, worked out again at that moment (missedFor):
        only what they still haven't seen (DMs not read, requests not
        answered, activity after their seen marker, chat messages after
        they last opened the chat, and nothing from before they last
        used the app, models/User.lastActiveAt), never from hidden or
        blocked people, each item at most once (emailedUntil). Nothing
        left → no email.
   Recipients: app accounts with a real email, not suspended, with
   "Email me a summary of what I missed" on, and not on the
   unsubscribed list (services/unsubscribe.js; checked at send time). One email per person per
   slot (a CampaignSend row "digest:<YYYY-MM-DD>T<HH:MM>" + email,
   claimed before sending), at most RUN_LIMIT a run, a short gap
   between sends, a retry with backoff when Resend is busy, and a
   global daily cap (DIGEST_DAILY_CAP, default 4,000): past it nothing
   more goes out that day and it's logged. Logs counts only.
========================================================= */

export const ENABLED_KEY = "digest.enabled";
export const JOB_KEY = "digest.job";
export const CAMPAIGN_PREFIX = "digest:";
export const RUN_LIMIT = 150;
export const SEND_GAP_MS = 250;
export const DEFAULT_DAILY_CAP = 4000;
const JOB_ID = "digests";
const CLAIM_MS = 50_000;
const EVERY_MS = 60_000;
const LOOKBACK_MS = DELAY_MS;              // first run after switching on: the last 3 hours
const MAX_AGE_MS = 7 * 24 * 3_600_000;     // never older than a week
const INSTANCE = `${os.hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
const isDup = (err) => err?.code === 11000 || /E11000/.test(String(err?.message || ""));
const str = (v) => String(v ?? "");

export const dailyCap = (env = process.env) => {
  const n = Math.floor(Number(env.DIGEST_DAILY_CAP));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_CAP;
};

/* ---------- the switch ---------- */

let switchCache = { at: 0, on: false };
export async function digestEnabled({ fresh = false } = {}) {
  if (!fresh && Date.now() - switchCache.at < 10_000) return switchCache.on;
  const doc = await AppContent.findOne({ key: ENABLED_KEY }).lean();
  switchCache = { at: Date.now(), on: doc?.value === true };
  return switchCache.on;
}
export async function setDigestEnabled(on, by = "") {
  await AppContent.updateOne({ key: ENABLED_KEY }, { $set: { value: !!on, updatedBy: str(by) } }, { upsert: true });
  switchCache = { at: 0, on: false };
}

/* ---------- one-click unsubscribe tokens ---------- */

const PURPOSE = "ttfc-digest-off:v1";
const mac = (id, secret) => crypto.createHmac("sha256", secret).update(`${PURPOSE}:${id}`).digest().subarray(0, 16).toString("base64url");
/** "<userId>.<sig>" ("" without a secret). */
export function unsubscribeToken(userId, secret = trackSecret()) {
  const id = str(userId);
  return secret && /^[a-f0-9]{24}$/i.test(id) ? `${id}.${mac(id, secret)}` : "";
}
/** The user id a token is for, or "" (not ours). */
export function verifyUnsubscribe(token, secret = trackSecret()) {
  const m = /^([a-f0-9]{24})\.([A-Za-z0-9_-]{22})$/i.exec(str(token));
  if (!secret || !m) return "";
  const want = Buffer.from(mac(m[1], secret));
  const got = Buffer.from(m[2]);
  return got.length === want.length && crypto.timingSafeEqual(got, want) ? m[1] : "";
}
export const unsubscribeUrl = (userId) => {
  const t = unsubscribeToken(userId);
  return t ? `${apiBaseUrl()}/api/app/digest/unsubscribe?t=${t}` : "";
};

/* ---------- 1. what's new → who has something waiting ---------- */

/** Recipient id → their oldest new item in (from, to]. */
export async function newItemsByRecipient(from, to) {
  const window = { $gt: from, $lte: to };
  const [dms, requests, activity, chat] = await Promise.all([
    SocialMessage.find({ createdAt: window, status: "approved" }).select("toUserId createdAt").lean(),
    SocialConnection.find({ createdAt: window, status: "pending" }).select("toUserId createdAt").lean(),
    ActivityEvent.find({ createdAt: window }).select("userId createdAt").lean(),
    // Not the session chats' own welcome line (posted by "TTFC" when each opens): only what people wrote.
    GroupMessage.find({ createdAt: window, status: "approved", authorId: { $ne: SYSTEM_ID } }).select("groupId authorId createdAt").lean(),
  ]);
  const first = new Map();
  const note = (id, at) => {
    const k = str(id);
    if (k && (!first.has(k) || at < first.get(k))) first.set(k, at);
  };
  for (const m of dms) note(m.toUserId, m.createdAt);
  for (const c of requests) note(c.toUserId, c.createdAt);
  for (const a of activity) note(a.userId, a.createdAt);
  if (chat.length) {
    const groups = await CommunityGroup.find({ _id: { $in: [...new Set(chat.map((m) => str(m.groupId)))] }, status: "approved" }).select("members").lean();
    const members = new Map(groups.map((g) => [str(g._id), (g.members || []).map(str)]));
    for (const m of chat) for (const id of members.get(str(m.groupId)) || []) if (id !== str(m.authorId)) note(id, m.createdAt);
  }
  return first;
}

/** Marks who has something waiting (the oldest item not emailed yet). */
export async function notePending(first) {
  if (!first.size) return 0;
  const ops = [...first].map(([id, at]) => ({
    updateOne: {
      filter: { _id: new mongoose.Types.ObjectId(id), $or: [{ emailedUntil: { $exists: false } }, { emailedUntil: { $lt: at } }] },
      update: { $min: { pendingSince: at } },
      upsert: true,
    },
  }));
  try {
    await DigestState.bulkWrite(ops, { ordered: false });
  } catch (err) {
    // Rows emailed past that item already exist: their upsert tries a second row and is refused. Fine.
    const errors = err?.writeErrors || err?.result?.writeErrors || [];
    if (!errors.length || errors.some((e) => (e?.code ?? e?.err?.code) !== 11000)) throw err;
  }
  return ops.length;
}

/* ---------- 2. what one person missed ---------- */

const RECIPIENT_SELECT = `${RIGHTS_SELECT} email appOnboarded lastActiveAt activitySeen notifyPrefs`;
const maxDate = (...ds) => new Date(Math.max(...ds.filter(Boolean).map((d) => new Date(d).getTime())));

/** May this person get digests at all? (an app account, a real email, not suspended, the switch on) */
export const canGetDigest = (user) => !!user && !user.banned && !!usableEmail(user.email) && isOnApp(user) && prefsOf(user).digestEmail;

/**
 * What `user` missed in (`since`, `now`] that they still haven't seen, as email items (services/digestEmail.js),
 * newest-first within each kind. Never from people hidden from them or blocked either way.
 */
export async function missedFor(user, { since = null, now = new Date() } = {}) {
  const me = user._id;
  const floor = maxDate(since, user.lastActiveAt, new Date(now.getTime() - MAX_AGE_MS));
  const window = { $gt: floor, $lte: now };
  const ctx = await rightsContext();
  const hide = await viewerHide(user, personAccess(user, ctx).rights);
  const blocks = await Block.find({ $or: [{ userId: me }, { blockedId: me }] }).lean();
  const blocked = new Set(blocks.map((r) => str(str(r.userId) === str(me) ? r.blockedId : r.userId)));
  const unseen = unseenOf(blocked, hide.ids);
  const nin = oids(unseen);
  const items = [];

  // Unread messages, one line per person.
  const dms = await SocialMessage.aggregate([
    { $match: { toUserId: me, status: "approved", readAt: null, createdAt: window, fromUserId: { $nin: nin } } },
    { $sort: { createdAt: 1 } },
    { $group: { _id: "$fromUserId", n: { $sum: 1 }, last: { $last: "$body" }, at: { $max: "$createdAt" } } },
  ]);
  // Connection requests waiting for them.
  const requests = await SocialConnection.find({ toUserId: me, status: "pending", createdAt: window, fromUserId: { $nin: nin } })
    .sort({ createdAt: -1 }).limit(20).select("fromUserId note createdAt").lean();
  const people = new Map((await User.find({ _id: { $in: [...dms.map((d) => d._id), ...requests.map((r) => r.fromUserId)] } }).select("name").lean())
    .map((u) => [str(u._id), u.name || "Someone"]));
  for (const d of dms) items.push({ kind: "dm", name: people.get(str(d._id)) || "Someone", count: d.n, text: snippet(d.last, 120), url: `/app/chat/${d._id}`, at: d.at });
  for (const r of requests) items.push({ kind: "request", name: people.get(str(r.fromUserId)) || "Someone", text: snippet(r.note, 120), url: "/app/network", at: r.createdAt });

  // Likes, comments, mentions and replies, after they last opened that tab's activity.
  const seen = user.activitySeen || {};
  const rows = await ActivityEvent.find({
    userId: me, createdAt: window, actorId: { $nin: nin },
    $or: [{ section: "feed", createdAt: { $gt: seen.feed || new Date(0) } }, { section: "discussions", createdAt: { $gt: seen.discussions || new Date(0) } }],
  }).sort({ createdAt: -1 }).limit(300).lean();
  const grouped = new Map();
  for (const a of rows) {
    const k = `${a.kind}:${a.section}:${a.refId}`;
    if (!grouped.has(k)) grouped.set(k, { kind: a.kind, section: a.section, refId: str(a.refId), names: [], actors: new Set(), count: 0, at: a.createdAt });
    const g = grouped.get(k);
    g.count += 1;
    if (!g.actors.has(str(a.actorId))) { g.actors.add(str(a.actorId)); g.names.push(a.actorName || "Someone"); }
  }
  const postIds = [...grouped.values()].filter((g) => g.section === "feed").map((g) => g.refId);
  const discIds = [...grouped.values()].filter((g) => g.section === "discussions").map((g) => g.refId);
  const [posts, discussions] = await Promise.all([
    postIds.length ? SocialPost.find({ _id: { $in: oids(postIds) }, status: { $ne: "hidden" } }).select("body").lean() : [],
    discIds.length ? Discussion.find({ _id: { $in: oids(discIds) }, status: "approved" }).select("title").lean() : [],
  ]);
  const postText = new Map(posts.map((p) => [str(p._id), p.body || ""]));
  const discTitle = new Map(discussions.map((d) => [str(d._id), d.title || ""]));
  for (const g of grouped.values()) {
    const feed = g.section === "feed";
    if (feed ? !postText.has(g.refId) : !discTitle.has(g.refId)) continue;   // deleted or taken down since
    const text = snippet(feed ? postText.get(g.refId) : discTitle.get(g.refId), 100);
    const url = feed ? `/app/post/${g.refId}` : `/app/discussion/${g.refId}`;
    const count = g.kind === "reply" ? g.count : g.actors.size;
    items.push({ kind: g.kind, names: g.names, count, where: feed ? "post" : "discussion", text, url, at: g.at });
  }

  // Group and session chats they're in: messages after they last opened each one.
  const groups = await CommunityGroup.find({ members: me, status: "approved" }).select("name ownerId").lean();
  const shown = groups.filter((g) => !unseen.has(str(g.ownerId)));
  if (shown.length) {
    const marks = new Map((await GroupSeen.find({ userId: me, groupId: { $in: shown.map((g) => g._id) } }).lean()).map((s) => [str(s.groupId), s.at]));
    const counts = await GroupMessage.aggregate([
      { $match: {
        $or: shown.map((g) => ({ groupId: g._id, createdAt: { $gt: maxDate(floor, marks.get(str(g._id))), $lte: now } })),
        status: "approved", authorId: { $nin: [me, SYSTEM_ID, ...nin] },
      } },
      { $group: { _id: "$groupId", n: { $sum: 1 }, at: { $max: "$createdAt" } } },
    ]);
    const names = new Map(shown.map((g) => [str(g._id), g.name]));
    for (const c of counts) items.push({ kind: "group", name: names.get(str(c._id)) || "Group chat", count: c.n, url: `/app/group/${c._id}`, at: c.at });
  }
  return sortItems(items);
}

/* ---------- 3. the run ---------- */

export async function claimRun({ owner = INSTANCE, now = new Date(), ms = CLAIM_MS } = {}) {
  try {
    const r = await JobLock.findOneAndUpdate(
      { _id: JOB_ID, until: { $lte: now } },
      { $set: { until: new Date(now.getTime() + ms), owner } },
      { upsert: true, returnDocument: "after", projection: { owner: 1 } },
    ).lean();
    return r?.owner === owner;
  } catch (err) {
    if (isDup(err)) return false;
    throw err;
  }
}

async function jobState() {
  const doc = await AppContent.findOne({ key: JOB_KEY }).lean();
  return doc?.value && typeof doc.value === "object" ? doc.value : {};
}
const saveJob = (patch) => AppContent.updateOne({ key: JOB_KEY }, [{ $set: { value: { $mergeObjects: [{ $ifNull: ["$value", {}] }, patch] }, updatedBy: "digest job" } }], { upsert: true, updatePipeline: true });

/** Digests that went out on the Toronto day of `now`. */
export const sentOn = (now = new Date()) =>
  CampaignSend.countDocuments({ campaign: { $regex: `^${CAMPAIGN_PREFIX}${dayKey(now)}T` }, status: "sent" });

const pause = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

/** One send with up to 3 retries when Resend is busy (429 / 5xx), backing off 1 s, 2 s, 4 s. */
async function sendWithBackoff(send, args, { wait = pause } = {}) {
  for (let i = 0; ; i++) {
    try { return await send(args); } catch (err) {
      const s = Number(err?.status) || 0;
      if (i >= 3 || !(s === 429 || s >= 500)) throw err;
      await wait(1000 * 2 ** i);
    }
  }
}

/** Claims this person's slot ("sending"); false when it's taken (sent, or being sent) or failed 3 times. */
async function claimSlot(campaign, email, name) {
  try {
    await CampaignSend.findOneAndUpdate(
      { campaign, email, status: "failed", attempts: { $lt: 3 } },
      { $set: { status: "sending", name, lastTriedAt: new Date() }, $inc: { attempts: 1 } },
      { upsert: true },
    );
    return true;
  } catch (err) {
    if (isDup(err)) return false;
    throw err;
  }
}

/**
 * One run (every minute; one server). → { claimed, enabled, noted, due, sent, skipped, failed, capped }.
 * `send`: services/digestEmail.js sendDigestEmail (tests pass a stub). `held`: the caller already has the claim.
 */
export async function runDigests({ now = new Date(), owner = INSTANCE, send = sendDigestEmail, held = false, log = console, gapMs = SEND_GAP_MS, wait = pause } = {}) {
  const out = { claimed: false, enabled: false, noted: 0, due: 0, sent: 0, skipped: 0, failed: 0, capped: false };
  try {
    if (!held && !(await claimRun({ owner, now }))) return out;
    out.claimed = true;
    if (!(await digestEnabled({ fresh: true }))) return out;
    out.enabled = true;

    const job = await jobState();
    const from = maxDate(job.lastScanAt, new Date(now.getTime() - LOOKBACK_MS));
    out.noted = await notePending(await newItemsByRecipient(from, now));
    await saveJob({ lastScanAt: now });

    const waiting = await DigestState.find({ pendingSince: { $ne: null } }).sort({ pendingSince: 1 }).limit(5000).lean();
    const due = waiting.map((s) => ({ s, n: nextDigest(s) })).filter((x) => x.n && x.n.at <= now).sort((a, b) => a.n.at - b.n.at);
    out.due = due.length;
    if (!due.length) return out;

    let room = dailyCap() - (await sentOn(now));
    for (const { s, n } of due.slice(0, RUN_LIMIT)) {
      if (room <= 0) {
        out.capped = true;
        log.warn?.(`DIGEST DAILY CAP reached (${dailyCap()} today): ${due.length - out.sent - out.skipped - out.failed} left for later`);
        break;
      }
      const user = await User.findById(s._id).select(RECIPIENT_SELECT).lean();
      if (!canGetDigest(user) || (await isUnsubscribed(Subscription, user.email))) {
        await DigestState.updateOne({ _id: s._id }, { $unset: { pendingSince: 1 } });
        out.skipped++;
        continue;
      }
      const items = await missedFor(user, { since: s.emailedUntil, now });
      if (!items.length) {
        // They've seen it all (or it was from someone they can't see): nothing to send. Later items mark them again.
        await DigestState.updateOne({ _id: s._id, pendingSince: s.pendingSince }, { $unset: { pendingSince: 1 } });
        out.skipped++;
        continue;
      }
      const email = usableEmail(user.email);
      const campaign = `${CAMPAIGN_PREFIX}${slotKey(n.at)}`;
      if (!(await claimSlot(campaign, email, user.name || ""))) { out.skipped++; continue; }
      try {
        const r = await sendWithBackoff(send, { to: email, firstName: str(user.name).trim().split(/\s+/)[0] || "", items, unsubscribeUrl: unsubscribeUrl(user._id) }, { wait });
        await CampaignSend.updateOne({ campaign, email }, { $set: { status: "sent", resendId: str(r?.id), sentAt: new Date(), error: "" }, $inc: { sends: 1 } });
        await DigestState.updateOne({ _id: s._id }, { $set: afterSend(s, now), $unset: { pendingSince: 1 } });
        out.sent++;
        room--;
      } catch (err) {
        await CampaignSend.updateOne({ campaign, email }, { $set: { status: "failed", error: str(err?.message).slice(0, 300) } });
        out.failed++;
      }
      if (gapMs) await wait(gapMs);
    }
    return out;
  } catch (err) {
    log.error?.("DIGEST RUN ERROR:", err?.message || err);
    return out;
  } finally {
    if (out.enabled) {
      const { claimed, ...counts } = out;
      saveJob({ lastRun: { at: now, ...counts } }).catch(() => {});
      if (out.sent || out.failed || out.capped) log.log?.(`DIGESTS: ${out.sent} sent, ${out.skipped} skipped, ${out.failed} failed, ${out.due} due${out.capped ? ", daily cap reached" : ""}`);
    }
  }
}

/** server.js, once connected: a run every minute (a server that doesn't get the claim does nothing). */
export function startDigests({ everyMs = EVERY_MS } = {}) {
  const tick = () => { runDigests(); };
  const t = setInterval(tick, everyMs);
  t.unref?.();
  return t;
}

/** Admin › "What you missed" emails: the switch, today's numbers and the last run. */
export async function digestStatus(now = new Date()) {
  const day = dayKey(now);
  const [enabled, sentToday, failedToday, waiting, job] = await Promise.all([
    digestEnabled({ fresh: true }),
    sentOn(now),
    CampaignSend.countDocuments({ campaign: { $regex: `^${CAMPAIGN_PREFIX}${day}T` }, status: "failed" }),
    DigestState.countDocuments({ pendingSince: { $ne: null } }),
    jobState(),
  ]);
  return { enabled, sentToday, failedToday, waiting, dailyCap: dailyCap(), day, lastRun: job.lastRun || null };
}
