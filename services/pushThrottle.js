import PushThrottle from "../models/PushThrottle.js";

/* =========================================================
   Push throttles kept in MongoDB (Oct 22 2026), so every server
   agrees: "at most one push per <what> per person per <window>".
   One row per (scope, person) (models/PushThrottle.js). Taking a
   slot moves `until` to now + window in one conditional upsert:
   a row still inside its window doesn't match, so the upsert tries
   to insert a second row with the same _id and fails (that person
   is throttled), and two servers taking the same slot at once can't
   both win. Each throttled person's `missed` goes up; the next push
   they get says how many it covers ("5 new messages in …").
========================================================= */

const DAY_MS = 24 * 3_600_000;
const BATCH = 50;
const isDup = (err) => err?.code === 11000 || /E11000/.test(String(err?.message || ""));

export const throttleKey = (scope, userId) => `${scope}:${userId}`;

/**
 * For each of `userIds`: may they get a push about `scope` now? → Map(userId → { ok, missed }):
 * ok: the slot is theirs (the window starts now; `missed` = what was held back in the last one);
 * not ok: still inside the window (counted in their `missed`).
 */
export async function takeSlots(scope, userIds, gapMs, { now = new Date() } = {}) {
  const ids = [...new Set((userIds || []).map(String).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  const t = now instanceof Date ? now : new Date(now);
  const until = new Date(t.getTime() + gapMs);
  const expireAt = new Date(until.getTime() + DAY_MS);
  const rows = await PushThrottle.find({ _id: { $in: ids.map((u) => throttleKey(scope, u)) } }).select("until").lean();
  const open = new Map(rows.map((r) => [r._id, r.until]));
  const held = [];
  const tryTake = async (uid) => {
    const key = throttleKey(scope, uid);
    const end = open.get(key);
    if (end && end > t) { held.push(key); out.set(uid, { ok: false, missed: 0 }); return; }
    try {
      const before = await PushThrottle.findOneAndUpdate(
        { _id: key, until: { $lte: t } },
        { $set: { until, missed: 0, expireAt } },
        { upsert: true, returnDocument: "before", projection: { missed: 1 } },
      ).lean();
      out.set(uid, { ok: true, missed: Number(before?.missed) || 0 });
    } catch (err) {
      if (!isDup(err)) throw err;
      held.push(key);
      out.set(uid, { ok: false, missed: 0 });
    }
  };
  for (let i = 0; i < ids.length; i += BATCH) await Promise.all(ids.slice(i, i + BATCH).map(tryTake));
  if (held.length) await PushThrottle.updateMany({ _id: { $in: held } }, { $inc: { missed: 1 } });
  return out;
}

/** The people whose slot it is now ([{ userId, missed }]), in `userIds` order. Never throws (none on an error). */
export async function allowed(scope, userIds, gapMs, opts = {}) {
  try {
    const slots = await takeSlots(scope, userIds, gapMs, opts);
    return [...slots].filter(([, s]) => s.ok).map(([userId, s]) => ({ userId, missed: s.missed }));
  } catch (err) {
    console.error("PUSH THROTTLE ERROR:", err?.message || err);
    return [];
  }
}
