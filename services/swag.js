import os from "node:os";
import mongoose from "mongoose";
import User from "../models/User.js";
import JobLock from "../models/JobLock.js";
import AppNotification from "../models/AppNotification.js";
import { AppContent } from "../models/Admin.js";
import { rankedBoard } from "./points.js";
import { hiddenState } from "./appHide.js";
import { personAccess } from "./appRights.js";
import { rightsContext, RIGHTS_SELECT } from "./rightsStore.js";
import { pushToUsers } from "./push.js";
import { avatarFor } from "./socialHelpers.js";
import {
  SWAG_KEYS, SWAG_PAGE, WINNER_NOTE, swagSettings, swagEligible, pickWinners, snapshotCounts, publicWinners,
} from "./swagRules.js";

/* =========================================================
   "Win the TTFC swag kit": the leaderboard at the cutoff and the
   winners (Oct 22 2026). Rules: services/swagRules.js.
   ---------------------------------------------------------
   At the cutoff (swag.cutoff) one server (JobLock row
   "swag-snapshot", checked every minute while the contest is on)
   keeps the leaderboard as it is then (AppContent "swag.snapshot":
   { takenAt, rows: [{ userId, name, organization, points, rank }] },
   the top 100), so points earned later don't change who won. The
   winners are the first `swag.kits` of it who can win (checked
   again when they're worked out: suspended or hidden since, or now
   staff). Nothing is announced automatically: management reviews
   the list and clicks "Announce winners" (routes/swag.js), which
   sends each winner an in-app notification and a push, once
   (AppContent "swag.announced").
   Oct 26 2026: the cutoff can move after the leaderboard was kept
   (it moved from Day 1, 4 PM to Day 2, 5 PM that evening). A kept
   leaderboard counts only for the cutoff it was kept at
   (services/swagRules.js snapshotCounts); a stale one is ignored
   (the winners are live until the new cutoff), and at the new cutoff
   the job keeps a fresh one in its place. Nothing is deleted: the
   stale one is first added to AppContent "swag.snapshot.previous"
   ({ snapshots: [...] }, $addToSet, so two servers add it once), then
   replaced only if it's still the row this server read (a filter on
   its takenAt), so two servers (or the job and an "Announce" click)
   racing each other replace it once and both answer the same fresh
   leaderboard.
========================================================= */

export const SNAPSHOT_KEY = "swag.snapshot";
export const PREVIOUS_SNAPSHOT_KEY = "swag.snapshot.previous";
export const ANNOUNCED_KEY = "swag.announced";
export const WINNERS_BATCH = "swag-winners-2026";
const SNAPSHOT_ROWS = 100;
const JOB_ID = "swag-snapshot";
const INSTANCE = `${os.hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
const isDup = (err) => err?.code === 11000 || /E11000/.test(String(err?.message || ""));

const valueOf = async (key) => (await AppContent.findOne({ key }).lean())?.value ?? null;

/** The settings as saved (defaults for the rest), parsed (services/swagRules.js swagSettings). */
export async function loadSwag() {
  const rows = await AppContent.find({ key: { $in: SWAG_KEYS } }).lean();
  return swagSettings(Object.fromEntries(rows.map((r) => [r.key, r.value])));
}

export const loadSnapshot = () => valueOf(SNAPSHOT_KEY);
export const loadAnnounced = () => valueOf(ANNOUNCED_KEY);

/** The leaderboard now → snapshot rows. */
async function boardRows() {
  const board = await rankedBoard();
  return board.slice(0, SNAPSHOT_ROWS).map((r) => ({ userId: r.user.id, name: r.user.name, organization: r.user.organization || "", points: r.points, rank: r.rank }));
}

/** The kept leaderboard if it counts for the current cutoff, else null (none yet, or kept at an earlier cutoff). */
export async function validSnapshot(settings = null) {
  const [s, snap] = await Promise.all([settings || loadSwag(), loadSnapshot()]);
  return snapshotCounts(snap, s.cutoff) ? snap : null;
}

/**
 * Keeps the leaderboard at the cutoff (once per cutoff; a later run does nothing). → the snapshot that counts.
 * A snapshot kept at an earlier cutoff is kept under swag.snapshot.previous and replaced (see the header).
 */
export async function takeSnapshot({ now = new Date(), settings = null } = {}) {
  const s = settings || (await loadSwag());
  const existing = await loadSnapshot();
  if (snapshotCounts(existing, s.cutoff)) return existing;
  const snap = { takenAt: now, cutoff: s.cutoff, rows: await boardRows() };
  if (existing?.takenAt) {
    // Kept first (the raw driver: no casting, the stale row exactly as read, so $addToSet adds it once), then replaced.
    await AppContent.collection.updateOne(
      { key: PREVIOUS_SNAPSHOT_KEY },
      { $addToSet: { "value.snapshots": existing }, $set: { updatedBy: "swag job", updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );
    const r = await AppContent.updateOne({ key: SNAPSHOT_KEY, "value.takenAt": existing.takenAt }, { $set: { value: snap, updatedBy: "swag job" } });
    if (!r.modifiedCount) return loadSnapshot();   // another server replaced it first: theirs counts
    return snap;
  }
  try {
    await AppContent.create({ key: SNAPSHOT_KEY, value: snap, updatedBy: "swag job" });
  } catch (err) {
    if (!isDup(err)) throw err;
    return loadSnapshot();   // another server kept it first
  }
  return snap;
}

/** Who can win among these user ids right now (eligibility checked fresh) → Set of ids. */
async function eligibleIds(ids) {
  const [ctx, hidden, users] = await Promise.all([
    rightsContext(), hiddenState(),
    User.find({ _id: { $in: ids.filter((id) => mongoose.isValidObjectId(id)) } }).select(`${RIGHTS_SELECT} hideFromLeaderboard directoryHidden`).lean(),
  ]);
  const out = new Set();
  for (const u of users) {
    if (hidden.ids.has(String(u._id))) continue;
    const acc = personAccess(u, ctx);
    if (swagEligible(u, { types: acc.types, rights: acc.rights })) out.add(String(u._id));
  }
  return out;
}

/**
 * The winners as they'd be announced now: the first `kits` who can win, from the leaderboard kept at the cutoff
 * (or the live one before it's kept, marked `live: true`). → { winners, live, takenAt, settings }
 */
export async function currentWinners({ now = new Date() } = {}) {
  const settings = await loadSwag();
  const kept = await loadSnapshot();
  const snap = snapshotCounts(kept, settings.cutoff) ? kept : null;   // kept at an earlier cutoff: live instead
  const rows = snap?.rows || (await boardRows());
  const ok = await eligibleIds(rows.map((r) => String(r.userId)));
  const winners = pickWinners(rows.map((r) => ({ user: { id: String(r.userId), name: r.name, organization: r.organization }, points: r.points, rank: r.rank })),
    (id) => ok.has(id), settings.kits);
  return {
    winners, live: !snap, takenAt: snap?.takenAt || null, staleTakenAt: !snap && kept?.takenAt ? kept.takenAt : null,
    settings, cutoffPassed: now >= settings.cutoff,
  };
}

/** The announced winners for GET /api/app/swag (services/swagRules.js publicWinners), each with their photo now. */
export async function announcedWinners(announced) {
  const ids = (Array.isArray(announced?.winners) ? announced.winners : []).map((w) => String(w?.userId || "")).filter((id) => mongoose.isValidObjectId(id));
  const users = ids.length ? await User.find({ _id: { $in: ids } }).select("name email avatarVersion tickets.ticketId").lean() : [];
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return publicWinners(announced, (id) => avatarFor(byId.get(id)));
}

/**
 * Announces these winners (management confirmed exactly them): an in-app notification and a push each, once.
 * → { announced: { at, by, winners } }. Throws { code: "already_announced" } on a second time.
 */
export async function announceWinners(winners, { by = "", byId = null, now = new Date() } = {}) {
  const record = { at: now, by, winners };
  try {
    await AppContent.create({ key: ANNOUNCED_KEY, value: record, updatedBy: by });
  } catch (err) {
    if (isDup(err)) throw Object.assign(new Error("The winners were already announced."), { code: "already_announced" });
    throw err;
  }
  const ids = winners.map((w) => w.userId);
  if (ids.length) {
    await AppNotification.insertMany(ids.map((id) => ({
      userId: id, title: WINNER_NOTE.title, body: WINNER_NOTE.body, link: SWAG_PAGE, kind: "personal", batchId: WINNERS_BATCH,
      ...(byId ? { sentBy: byId } : {}), sentByName: by,
    })));
    // Always (no notification switch): it's about their prize.
    pushToUsers(ids, { title: WINNER_NOTE.title, body: WINNER_NOTE.body, link: SWAG_PAGE, kind: "personal", id: WINNERS_BATCH, url: "/app/notifications" });
  }
  return { announced: record };
}

/* ---------- the minute job ---------- */

async function claimRun(now) {
  try {
    const r = await JobLock.findOneAndUpdate({ _id: JOB_ID, until: { $lte: now } }, { $set: { until: new Date(now.getTime() + 50_000), owner: INSTANCE } },
      { upsert: true, returnDocument: "after", projection: { owner: 1 } }).lean();
    return r?.owner === INSTANCE;
  } catch (err) {
    if (isDup(err)) return false;
    throw err;
  }
}

/** One run: past the cutoff, with the contest on and nothing kept for this cutoff yet → keep the leaderboard. Never throws. */
export async function runSwagSnapshot({ now = new Date(), held = false } = {}) {
  try {
    const s = await loadSwag();
    if (!s.enabled || now < s.cutoff) return null;
    if (snapshotCounts(await loadSnapshot(), s.cutoff)) return null;   // kept for this cutoff already
    if (!held && !(await claimRun(now))) return null;
    return await takeSnapshot({ now, settings: s });
  } catch (err) {
    console.error("SWAG SNAPSHOT ERROR:", err?.message || err);
    return null;
  }
}

/** server.js, once connected: a check every minute. */
export function startSwagSnapshot({ everyMs = 60_000 } = {}) {
  const t = setInterval(() => { runSwagSnapshot(); }, everyMs);
  t.unref?.();
  return t;
}
