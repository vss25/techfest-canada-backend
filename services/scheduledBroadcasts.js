import os from "node:os";
import User from "../models/User.js";
import JobLock from "../models/JobLock.js";
import AppNotification from "../models/AppNotification.js";
import CheckinMark from "../models/CheckinMark.js";
import ScheduledBroadcast from "../models/ScheduledBroadcast.js";
import { SocialPost } from "../models/Social.js";
import { AppContent, AdminAudit, AppEvent } from "../models/Admin.js";
import { pushToUsers } from "./push.js";
import { recipientFilter } from "./notifyHelpers.js";
import { APP_VERSION_DEFAULTS } from "./appVersion.js";
import { EVENT_DAYS, DOOR_POINTS, checkedInPersons, checkedInKeys, cleanEmail } from "./surveyRules.js";
import {
  MISSED_AFTER_MS, STUCK_AFTER_MS, CHUNK, ORG_NAME, ORG_TITLE, ORG_COMPANY, BANNER_KEY, BANNER_LINK_KEY, BANNER_MAX,
  STORE_PLATFORMS, batchIdOf, chunks, auditLine, outdatedUserIds,
} from "./scheduledBroadcastRules.js";

/* =========================================================
   Scheduled broadcasts (Oct 27 2026): storage, who gets them, the
   send and the minute job. Rules: services/scheduledBroadcastRules.js;
   routes: routes/console.js /api/console/broadcasts/scheduled
   (management only); model: models/ScheduledBroadcast.js.
   ---------------------------------------------------------
   Every minute one server (JobLock "scheduled-broadcasts") looks for
   items due now. Each item is taken with one atomic update
   (status scheduled → sending, sendAt ≤ now), so it is sent once
   however many servers run, and "Send now" from the panel can't
   race the job. An item found more than 2 hours late (the server
   was down) is marked "missed" (the same way, atomically) and never
   sent; one left "sending" for 15 minutes (the server restarted in
   the middle) is marked "failed" and never sent again: staff check
   and send a new one.
   The send, in this order, each part only when its switch is on:
     1. feedPost: an official announcement post like POST
        /api/console/broadcast (author "The Tech Festival Canada",
        "Organizers", "AtlasLink Markets", kind "announcement",
        approved) with linkUrl; authorId = who scheduled it;
     2. banner: AppContent home.announcement = the body's first 280
        characters, and home.announcement_link = linkUrl ("" when the
        item has none, so an older link doesn't stay on the new text);
     3. notify: the audience now (audienceIds) less anyone who already
        has this batch: AppNotification rows (kind "personal", batchId
        "sched:<id>", sentBy = who scheduled it, sentByName "The Tech
        Festival Canada", the item's title, body and link), 500 at a
        time, one pushToUsers per 500 (Settings › Notifications ›
        Announcements off = no push; the inbox row is still there).
   Then status "sent" with sentAt, recipients (rows written) and
   postId; any error: "failed" with the error (what was done stays).
   Audited: sent / failed / missed here; create, edit, cancel and send
   now in the route.
========================================================= */

const JOB_ID = "scheduled-broadcasts";
const EVERY_MS = 60 * 1000;
const CLAIM_MS = 50 * 1000;
/** At most this many items per minute (the rest wait a minute). */
const PER_RUN = 20;
const INSTANCE = `${os.hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
const isDup = (err) => err?.code === 11000 || /E11000/.test(String(err?.message || ""));
const str = (v) => (v === null || v === undefined ? "" : String(v));

export const MISSED_ERROR = "Not sent: the server wasn't running at the time and it was more than 2 hours late.";
export const STUCK_ERROR = "The send was cut off (the server restarted). Check the inbox and the feed before sending it again.";

const peopleDirectory = async () => (await import("../routes/people.js")).directory();

/** This minute's run (true) unless another server holds it. */
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

/* ---------- who gets it ---------- */

/** Accounts and addresses with a door check-in on Day 1 or Day 2 (arrived / checked in; never practice), through the
    People directory (a person's passes and addresses together). The survey's rule (services/surveyRules.js). */
export async function checkedInKeysNow({ directory = peopleDirectory } = {}) {
  const [dir, marks] = await Promise.all([
    directory(),
    CheckinMark.find({ day: { $in: EVENT_DAYS }, point: { $in: DOOR_POINTS }, at: { $ne: null }, practice: { $ne: true } })
      .select("subject day point at practice").lean(),
  ]);
  const { persons } = checkedInPersons({ byId: dir?.byId || new Map(), marks, days: EVENT_DAYS });
  return checkedInKeys(persons);
}

/** The newest store versions the apps' update banner uses (GET /api/app/content: a saved value, else the default). */
export async function latestStoreVersions() {
  const keys = { ios: "app.ios_latest", android: "app.android_latest" };
  const rows = await AppContent.find({ key: { $in: Object.values(keys) } }).select("key value").lean();
  const saved = new Map(rows.map((r) => [r.key, r.value]));
  return Object.fromEntries(Object.entries(keys).map(([p, k]) => [p, str(saved.has(k) ? saved.get(k) : APP_VERSION_DEFAULTS[k])]));
}

/** Of these accounts, the ones whose app is older than the newest version for their platform (the platform of their
    newest app event, the newest version recorded on it; services/scheduledBroadcastRules.js outdatedUserIds).
    → Set of userId strings */
export async function outdatedIdsNow(userIds = []) {
  if (!userIds.length) return new Set();
  const [latest, platforms, versions] = await Promise.all([
    latestStoreVersions(),
    AppEvent.aggregate([
      { $match: { userId: { $in: userIds } } },
      { $group: { _id: { u: "$userId", p: "$platform" }, lastAt: { $max: "$at" } } },
    ]).allowDiskUse(true),
    AppEvent.aggregate([
      { $match: { userId: { $in: userIds }, platform: { $in: [...STORE_PLATFORMS] }, appVersion: { $nin: ["", null] } } },
      { $sort: { userId: 1, at: -1 } },
      { $group: { _id: { u: "$userId", p: "$platform" }, appVersion: { $first: "$appVersion" } } },
    ]).allowDiskUse(true),
  ]);
  return outdatedUserIds({
    platforms: platforms.map((r) => ({ userId: str(r._id.u), platform: r._id.p, lastAt: r.lastAt })),
    versions: versions.map((r) => ({ userId: str(r._id.u), platform: r._id.p, appVersion: r.appVersion })),
    latest,
  });
}

/**
 * Who a notification goes to now: "app" = everyone signed into the app who isn't suspended (POST /console/notify's
 * rule, services/notifyHelpers.js recipientFilter); "checkedIn" = those of them whose account or email had a door
 * check-in on Day 1 or Day 2; "outdated" = those of them on an older iOS / Android app than the "App updates" keys'
 * newest version (nobody without a version recorded, nobody whose newest event is from the web app). → [User _id]
 */
export async function audienceIds(audience = "app", { directory = peopleDirectory } = {}) {
  const users = await User.find(recipientFilter()).select("_id email").lean();
  if (!users.length || (audience !== "checkedIn" && audience !== "outdated")) return users.map((u) => u._id);
  if (audience === "outdated") {
    const behind = await outdatedIdsNow(users.map((u) => u._id));
    return users.filter((u) => behind.has(str(u._id))).map((u) => u._id);
  }
  const ci = await checkedInKeysNow({ directory });
  return users.filter((u) => ci.userIds.has(str(u._id)) || ci.emails.has(cleanEmail(u.email))).map((u) => u._id);
}

/** { app, checkedIn } → how many each audience reaches now, worked out only for the audiences asked for. */
export async function estimates(audiences = [], { directory = peopleDirectory } = {}) {
  const out = {};
  for (const a of new Set(audiences)) out[a] = (await audienceIds(a, { directory })).length;
  return out;
}

/* ---------- the audit log (the job has no request) ---------- */

async function systemAudit(item, action, detail, actor = null) {
  await AdminAudit.create({
    adminId: actor?._id || item.createdBy, adminName: actor?.name || "Scheduled send", action,
    targetType: "scheduled_broadcast", targetId: str(item._id), detail: str(detail).slice(0, 500),
  }).catch(() => {});
}

/* ---------- claiming ---------- */

/** The next due item (sendAt ≤ now, at most 2 hours late), taken by this server: status scheduled → sending. */
export function claimDue({ now = new Date(), owner = INSTANCE } = {}) {
  return ScheduledBroadcast.findOneAndUpdate(
    { status: "scheduled", sendAt: { $lte: now, $gte: new Date(now.getTime() - MISSED_AFTER_MS) } },
    { $set: { status: "sending", claimedAt: now, claimedBy: owner } },
    { sort: { sendAt: 1 }, returnDocument: "after" },
  ).lean();
}

/** One item, whatever its time ("Send now" in the panel: quiet hours and the 2 minutes don't apply to a person pressing
    it), only while it's scheduled. → the claimed item (then deliver() it), or null. */
export function claimOne(id, { now = new Date(), owner = INSTANCE } = {}) {
  return ScheduledBroadcast.findOneAndUpdate(
    { _id: id, status: "scheduled" },
    { $set: { status: "sending", claimedAt: now, claimedBy: owner } },
    { returnDocument: "after" },
  ).lean();
}

/** Items more than 2 hours late → "missed" (never sent). → how many. */
export async function markMissed({ now = new Date() } = {}) {
  let n = 0;
  for (;;) {
    const item = await ScheduledBroadcast.findOneAndUpdate(
      { status: "scheduled", sendAt: { $lt: new Date(now.getTime() - MISSED_AFTER_MS) } },
      { $set: { status: "missed", error: MISSED_ERROR } },
      { sort: { sendAt: 1 }, returnDocument: "after" },
    ).lean();
    if (!item) return n;
    n += 1;
    await systemAudit(item, "scheduled_broadcast_missed", auditLine(item));
  }
}

/** Items left "sending" for 15 minutes (cut off by a restart) → "failed" (never sent again). → how many. */
export async function failStuck({ now = new Date() } = {}) {
  let n = 0;
  for (;;) {
    const item = await ScheduledBroadcast.findOneAndUpdate(
      { status: "sending", claimedAt: { $lt: new Date(now.getTime() - STUCK_AFTER_MS) } },
      { $set: { status: "failed", error: STUCK_ERROR } },
      { returnDocument: "after" },
    ).lean();
    if (!item) return n;
    n += 1;
    await systemAudit(item, "scheduled_broadcast_failed", `${auditLine(item)} · cut off`);
  }
}

/* ---------- the send ---------- */

/**
 * Sends a claimed item (status "sending"): feed post → banner → inbox rows and pushes, each when its switch is on.
 * `actor`: who pressed "Send now" (the audit's name; null = the schedule). → the item as saved after. Never throws.
 */
export async function deliver(item, { now = new Date(), directory = peopleDirectory, actor = null, log = console } = {}) {
  const batchId = batchIdOf(item._id);
  let postId = item.postId || null;
  let recipients = 0;
  try {
    if (item.feedPost && !postId) {
      const post = await SocialPost.create({
        authorId: item.createdBy, authorName: ORG_NAME, authorTitle: ORG_TITLE, authorOrg: ORG_COMPANY,
        kind: "announcement", body: item.body, linkUrl: item.linkUrl || "", status: "approved",
      });
      postId = post._id;
      await ScheduledBroadcast.updateOne({ _id: item._id }, { $set: { postId } });
    }
    if (item.banner) {
      const updatedBy = actor?.name || item.createdByName || ORG_NAME;
      await AppContent.updateOne({ key: BANNER_KEY }, { $set: { value: str(item.body).slice(0, BANNER_MAX), updatedBy } }, { upsert: true });
      await AppContent.updateOne({ key: BANNER_LINK_KEY }, { $set: { value: item.linkUrl || "", updatedBy } }, { upsert: true });
    }
    if (item.notify) {
      const ids = await audienceIds(item.audience, { directory });
      const already = new Set((await AppNotification.distinct("userId", { batchId })).map(str));
      const fresh = ids.filter((id) => !already.has(str(id)));
      const note = { title: item.title, body: item.body, link: item.linkUrl || "", kind: "personal", id: batchId };
      for (const part of chunks(fresh, CHUNK)) {
        await AppNotification.insertMany(part.map((userId) => ({
          userId, title: item.title, body: item.body, link: item.linkUrl || "", kind: "personal", batchId,
          sentBy: item.createdBy, sentByName: ORG_NAME,
        })));
        recipients += part.length;
        pushToUsers(part, note, { pref: "announcements" });
      }
    }
    const done = await ScheduledBroadcast.findOneAndUpdate({ _id: item._id },
      { $set: { status: "sent", sentAt: now, recipients, postId, batchId, error: "" } }, { returnDocument: "after" }).lean();
    await systemAudit(item, "scheduled_broadcast_sent",
      `${auditLine(item)} · ${item.notify ? `${recipients} ${recipients === 1 ? "person" : "people"}` : "no notification"}`, actor);
    return done;
  } catch (err) {
    const error = str(err?.message || err).slice(0, 300) || "Something went wrong.";
    log.error?.(`SCHEDULED BROADCAST ERROR (${item._id}):`, error);
    const done = await ScheduledBroadcast.findOneAndUpdate({ _id: item._id },
      { $set: { status: "failed", error, recipients, postId, batchId } }, { returnDocument: "after" }).lean().catch(() => null);
    await systemAudit(item, "scheduled_broadcast_failed", `${auditLine(item)} · ${error}`, actor);
    return done || { ...item, status: "failed", error, recipients, postId, batchId };
  }
}

/**
 * One run of the minute job: claim the minute, give up on cut-off sends, mark items over 2 hours late as missed, then
 * send what's due, one claimed item at a time. → { claimed, sent, failed, missed, stuck }. Never throws.
 * `held`: the caller already took the minute (tests of several servers).
 */
export async function runScheduledBroadcasts({ now = new Date(), owner = INSTANCE, directory = peopleDirectory, log = console, held = false } = {}) {
  const out = { claimed: false, sent: 0, failed: 0, missed: 0, stuck: 0 };
  try {
    if (!held && !(await claimRun({ owner, now }))) return out;
    out.claimed = true;
    out.stuck = await failStuck({ now });
    out.missed = await markMissed({ now });
    for (let i = 0; i < PER_RUN; i++) {
      const item = await claimDue({ now, owner });
      if (!item) break;
      const done = await deliver(item, { now, directory, log });
      if (done?.status === "sent") out.sent += 1;
      else out.failed += 1;
    }
    if (out.sent || out.failed || out.missed) log.log?.(`📣 Scheduled broadcasts: ${out.sent} sent, ${out.failed} failed, ${out.missed} missed`);
  } catch (err) {
    log.error?.("SCHEDULED BROADCASTS ERROR:", err?.message || err);
  }
  return out;
}

/** Every minute while the server runs (server.js). */
export function startScheduledBroadcasts({ everyMs = EVERY_MS } = {}) {
  const tick = () => { runScheduledBroadcasts(); };
  ScheduledBroadcast.init().catch((err) => console.error("SCHEDULED BROADCASTS INDEX ERROR:", err?.message || err)).finally(tick);
  const t = setInterval(tick, everyMs);
  t.unref?.();
  return t;
}
