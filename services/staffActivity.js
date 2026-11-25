import StaffSession from "../models/StaffSession.js";
import StaffActivityHour from "../models/StaffActivityHour.js";

/* =========================================================
   Staff activity (Nov 24 2026): when each staff member worked in the admin panel, for how long, and how
   many pages they opened and records they changed, by hour. Read by the super admin only
   (routes/staffActivity.js, Settings › Staff activity).

   What comes in:
     - "signin"  a password sign-in to the panel (routes/auth.js, body.panel === "admin")
     - "view"    the panel opened a page (POST /api/admin/staff-activity/ping)
     - "beat"    the panel's heartbeat: sent once a minute ONLY while someone is using it (a key, click,
                 scroll or mouse move in the last 5 minutes, and the tab visible). An idle open tab sends
                 nothing.
     - "edit"    a successful POST / PUT / PATCH / DELETE through a requireAdmin route from a browser
                 (trackPanelEdits below; searches, previews and the pings themselves don't count)
     - sign-out  POST /api/admin/staff-activity/signout

   Time: each activity credits the gap since the previous one in the same session, capped at
   CREDIT_CAP_SECONDS (2 min). A gap over IDLE_SECONDS (15 min) closes the session at its last activity
   and starts a new one, crediting nothing. So time is counted only while the panel reports use.

   Storage: StaffSession (one row per session) and StaffActivityHour (one row per person per UTC hour,
   $inc). Both expire after 180 days. MongoDB only (never Sanity).
========================================================= */

export const IDLE_SECONDS = 15 * 60;
export const CREDIT_CAP_SECONDS = 120;
export const DEFAULT_TZ = "America/Toronto";
export const MAX_RANGE_DAYS = 31;

let clock = () => new Date();
/** Tests only: fix "now". Pass nothing to restore the real clock. */
export function setStaffActivityClock(fn) { clock = fn || (() => new Date()); }

/** Seconds to credit for activity at `now` after the session's last activity, or null when the gap is
 *  past the idle cutoff (the session is over and a new one starts). */
export function creditFor(lastSeenAt, now) {
  const gap = (new Date(now).getTime() - new Date(lastSeenAt).getTime()) / 1000;
  if (!Number.isFinite(gap)) return null;
  if (gap > IDLE_SECONDS) return null;
  return Math.max(0, Math.min(CREDIT_CAP_SECONDS, Math.round(gap)));
}

const hourStart = (d) => { const h = new Date(d); h.setUTCMinutes(0, 0, 0); return h; };

async function bumpHour(userId, now, inc, credit) {
  const $inc = { pageViews: inc.pageViews, edits: inc.edits, activeSeconds: credit };
  await StaffActivityHour.updateOne({ userId, hour: hourStart(now) }, { $inc }, { upsert: true });
}

/** Record one activity (kind "signin" | "view" | "beat" | "edit") for a staff member. Throws on DB errors;
 *  callers fire and forget (recordActivitySafe). */
export async function recordActivity(userId, kind, now = clock()) {
  const inc = { pageViews: kind === "view" ? 1 : 0, edits: kind === "edit" ? 1 : 0 };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const open = await StaffSession.findOne({ userId, endedAt: null }).sort({ lastSeenAt: -1 }).lean();
    const credit = open ? creditFor(open.lastSeenAt, now) : null;
    if (kind === "signin" || credit === null) {
      if (open) {
        await StaffSession.updateOne({ _id: open._id, endedAt: null },
          { $set: { endedAt: open.lastSeenAt, endReason: "idle" } });
      }
      await StaffSession.create({ userId, startedAt: now, lastSeenAt: now, via: kind === "signin" ? "sign-in" : "resumed", ...inc });
      await bumpHour(userId, now, inc, 0);
      return;
    }
    // Only the request that moves lastSeenAt from the value it read gets the credit (no double counting
    // when two pings arrive together).
    const r = await StaffSession.updateOne(
      { _id: open._id, endedAt: null, lastSeenAt: open.lastSeenAt },
      { $set: { lastSeenAt: now }, $inc: { activeSeconds: credit, ...inc } },
    );
    if (r.modifiedCount) { await bumpHour(userId, now, inc, credit); return; }
  }
  // Lost the race twice: still count the page or edit, with no time.
  await StaffSession.updateOne({ userId, endedAt: null }, { $max: { lastSeenAt: now }, $inc: inc });
  await bumpHour(userId, now, inc, 0);
}

const inFlight = new Set();
export function recordActivitySafe(userId, kind) {
  if (!userId) return;
  const p = recordActivity(userId, kind)
    .catch((err) => console.error("staff activity write failed:", err?.message || err))
    .finally(() => inFlight.delete(p));
  inFlight.add(p);
}
/** Tests: resolves once every background write started so far has finished. */
export async function staffActivitySettled() {
  while (inFlight.size) await Promise.all([...inFlight]);
}

/** Sign-out: close the open session now (crediting the last gap) or, when it already went idle, at its
 *  last activity. */
export async function recordSignOut(userId, now = clock()) {
  const open = await StaffSession.findOne({ userId, endedAt: null }).sort({ lastSeenAt: -1 }).lean();
  if (!open) return;
  const credit = creditFor(open.lastSeenAt, now);
  if (credit === null) {
    await StaffSession.updateOne({ _id: open._id, endedAt: null }, { $set: { endedAt: open.lastSeenAt, endReason: "idle" } });
    return;
  }
  await StaffSession.updateOne({ _id: open._id, endedAt: null },
    { $set: { endedAt: now, lastSeenAt: now, endReason: "signout" }, $inc: { activeSeconds: credit } });
  await bumpHour(userId, now, { pageViews: 0, edits: 0 }, credit);
}

/* ---------- Edits: every successful staff-panel write ---------- */

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// Writes that change no record: searches, previews, quotes, look-ups, test sends, and our own pings.
const NOT_AN_EDIT = /\/(search|staff-activity|preview|quote|lookup|test|test-send|count|counts)(\/|$)/i;

/** True when this finished request is a staff member changing something in the admin panel. requireAdmin
 *  marks req.staffPanel; a browser sends Origin (the native apps don't). */
export function isPanelEdit(req, statusCode) {
  if (!MUTATING.has(req.method)) return false;
  if (!req.staffPanel || statusCode >= 400 || !req.headers?.origin) return false;
  const p = String(req.originalUrl || req.url || "").split("?")[0];
  return !NOT_AN_EDIT.test(p);
}

/** Global middleware (server.js, before the routes): counts panel edits once the response is sent. */
export function trackPanelEdits(req, res, next) {
  if (MUTATING.has(req.method)) {
    res.on("finish", () => {
      if (!isPanelEdit(req, res.statusCode)) return;
      recordActivitySafe(req.user?._id || req.user?.id, "edit");
    });
  }
  next();
}

/* ---------- Reading: grouped by the viewer's local day and hour ---------- */

export function validTz(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try { new Intl.DateTimeFormat("en-CA", { timeZone: tz }); return true; } catch { return false; }
}

const partsCache = new Map();
/** { date: "YYYY-MM-DD", hour: 0-23 } of a moment in a time zone. */
export function localParts(d, tz) {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
    partsCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(d)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** The day range to read: from / to (YYYY-MM-DD, inclusive), defaulting to the last 7 days in tz, at most
 *  MAX_RANGE_DAYS. Returns { from, to, start, end } (start / end: a UTC window wide enough for any zone)
 *  or { error }. */
export function rangeOf({ from, to, tz, now = clock() }) {
  const today = localParts(now, tz).date;
  const t = to === undefined || to === "" ? today : to;
  const f = from === undefined || from === "" ? addDays(t, -6) : from;
  if (!DAY_RE.test(f) || !DAY_RE.test(t) || Number.isNaN(Date.parse(f)) || Number.isNaN(Date.parse(t))) return { error: "Dates must be YYYY-MM-DD" };
  if (f > t) return { error: "from must be on or before to" };
  const days = Math.round((Date.parse(t) - Date.parse(f)) / 86400000) + 1;
  if (days > MAX_RANGE_DAYS) return { error: `At most ${MAX_RANGE_DAYS} days at a time` };
  return { from: f, to: t, start: new Date(Date.parse(`${f}T00:00:00Z`) - 15 * 3600000), end: new Date(Date.parse(`${t}T23:59:59.999Z`) + 15 * 3600000) };
}

export function sessionStatus(s, now = clock()) {
  if (s.endedAt) return s.endReason || "idle";
  return creditFor(s.lastSeenAt, now) === null ? "idle" : "active";
}

/**
 * Pure: staff + their sessions and hour rows → one entry per staff member with totals and days (newest
 * first). Sessions count on the day they started; day time, pages and edits come from the hour rows.
 * Hour rows are UTC hours shown in tz (whole-hour zones are exact; a half-hour zone shifts by 30 min).
 */
export function summarize({ users = [], sessions = [], hours = [], tz = DEFAULT_TZ, from, to, now = clock() }) {
  const inRange = (date) => (!from || date >= from) && (!to || date <= to);
  const byUser = new Map();
  const entry = (id) => {
    const k = String(id);
    if (!byUser.has(k)) byUser.set(k, { days: new Map(), lastSeenAt: null });
    return byUser.get(k);
  };
  const day = (e, date) => {
    if (!e.days.has(date)) e.days.set(date, { date, activeSeconds: 0, pageViews: 0, edits: 0, sessions: [], hours: new Map() });
    return e.days.get(date);
  };
  for (const s of sessions) {
    const { date } = localParts(s.startedAt, tz);
    if (!inRange(date)) continue;
    const e = entry(s.userId);
    const status = sessionStatus(s, now);
    day(e, date).sessions.push({
      id: String(s._id), startedAt: s.startedAt, lastSeenAt: s.lastSeenAt,
      endedAt: s.endedAt || (status === "idle" ? s.lastSeenAt : null),
      status, via: s.via || "resumed",
      activeSeconds: s.activeSeconds || 0, pageViews: s.pageViews || 0, edits: s.edits || 0,
    });
    if (!e.lastSeenAt || new Date(s.lastSeenAt) > new Date(e.lastSeenAt)) e.lastSeenAt = s.lastSeenAt;
  }
  for (const h of hours) {
    const { date, hour } = localParts(h.hour, tz);
    if (!inRange(date)) continue;
    const d = day(entry(h.userId), date);
    d.activeSeconds += h.activeSeconds || 0;
    d.pageViews += h.pageViews || 0;
    d.edits += h.edits || 0;
    const slot = d.hours.get(hour) || { hour, activeSeconds: 0, pageViews: 0, edits: 0 };
    slot.activeSeconds += h.activeSeconds || 0;
    slot.pageViews += h.pageViews || 0;
    slot.edits += h.edits || 0;
    d.hours.set(hour, slot);
  }
  const staff = users.map((u) => {
    const e = byUser.get(String(u._id)) || { days: new Map(), lastSeenAt: null };
    const days = [...e.days.values()]
      .map((d) => ({
        ...d,
        sessions: d.sessions.sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt)),
        hours: [...d.hours.values()].sort((a, b) => a.hour - b.hour),
      }))
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    const totals = days.reduce((t, d) => ({
      activeSeconds: t.activeSeconds + d.activeSeconds, pageViews: t.pageViews + d.pageViews,
      edits: t.edits + d.edits, sessions: t.sessions + d.sessions.length,
    }), { activeSeconds: 0, pageViews: 0, edits: 0, sessions: 0 });
    return { userId: String(u._id), name: u.name || "", email: u.email || "", lastSeenAt: e.lastSeenAt, totals, days };
  });
  staff.sort((a, b) => b.totals.activeSeconds - a.totals.activeSeconds || a.name.localeCompare(b.name));
  return staff;
}
