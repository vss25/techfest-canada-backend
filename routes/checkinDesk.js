import express from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import CheckinMark from "../models/CheckinMark.js";
import CheckinEvent from "../models/CheckinEvent.js";
import MediaQuery from "../models/MediaQuery.js";
import { AppContent, AdminAudit } from "../models/Admin.js";
import { requireCheckIn, requireAdmin } from "../middleware/adminAuth.js";
import { signedInWithoutPassword, PASSWORD_REQUIRED_CODE } from "../services/signInMethod.js";
import { canUseStaffSignIn } from "../services/teamRoles.js";
import { makeLimiter, normalizeTicketId } from "../services/ticketAccess.js";
import { makeAgendaCache } from "../services/points.js";
import { SANITY_PROJECT } from "../services/rsvp.js";
import { directory, personNow } from "./people.js";
import {
  MAX_BATCH, boothsOf, buildDeskIndex, cleanAction, deskGuestFrom, eventView, guestExtras, guestKey, guestView, isGuestKey, markView, queryView, sessionsIndex,
} from "../services/checkinDesk.js";
import {
  STATIONS, agendaTimes, cleanSettings, eventDayInfo, resolveWindows, stationEnabled, stationState, DEFAULT_BUFFERS, FALLBACK_AGENDA, DEFAULT_WINDOWS,
} from "../services/checkinDeskTime.js";
import {
  currentCursor, deskNow, guestGeneration, guestRowsSince, readSince, ready, setGuestRowBuilder, subscribe,
} from "../services/checkinDeskLog.js";
import { performAction } from "../services/checkinDeskActions.js";

/* =========================================================
   TTFC Check-in desk app API (Oct 23 2026): /api/checkin/desk
   ---------------------------------------------------------
   Under /api/checkin so the kill switch leaves it working, like the
   door scanner. Every route needs a staff or volunteer PASSWORD sign-in
   (contract C1): the checkIn right (requireCheckIn), an account that can
   use the apps' staff sign-in (canUseStaffSignIn: role admin / volunteer,
   or the Staff / Volunteer type), and never a passwordless token (pass ID
   + last name, emailed code): 403 { code: "password_required" }. "Staff"
   here = a staff account (role admin); everyone else is a volunteer.

     GET  /info           staff: { path } the desk app's unlisted address (contract C5: the admin card reads it here,
                          so it isn't in any public website file)
     GET  /me             who's signed in, staff or volunteer, the stations, today
     GET  /clock          the time, today and each station's window state (each device every 30 s)
     GET  /snapshot       everything a device needs: guests (staff see emails and ticket IDs; volunteers never),
                          today's marks, desk notes, booths, media queries, the stations' windows, the cursor
     GET  /events?since=  the events after a cursor (the polling fallback) → { events, cursor, reset }
     GET  /stream?since=  the same as Server-Sent Events (Authorization header: the app reads it with fetch, so no
                          token ever goes in a URL); a ping every 5 s; ends after 10 minutes (the app reconnects)
     POST /actions        one action, or { actions: [...] } (≤ 25, in order: the offline queue) → { results }
     POST /lookup         { ticketId } → { key } : a volunteer typed a ticket ID (they don't hold the list of them)
     GET  /team           staff: the team's names (media query assignees)
     GET  /history/:key   staff: one guest's events (latest 60)
     GET  /settings       staff: the windows, where they come from, the buffers, the evening switch
     PUT  /settings       staff: { windows?, buffers?, stations? } (audited checkin_desk_settings)
   Nothing here sends email or pushes. Rules: services/checkinDesk.js, checkinDeskTime.js; writes:
   services/checkinDeskActions.js; the log and live fan-out: services/checkinDeskLog.js.
========================================================= */

const router = express.Router();
const SETTINGS_KEY = "checkin.windows";

/* ---------- Who ---------- */

export const DESK_PASSWORD_REQUIRED = "This app needs your staff or volunteer password sign-in.";
export const DESK_TEAM_ONLY = "This app is for TTFC staff and volunteers.";

/** Contract C1: requireCheckIn, a password sign-in (never a pass ID or an emailed code) and a staff or volunteer
    account (canUseStaffSignIn). Staff = a staff account (role admin). */
function deskAuth(req, res, next) {
  requireCheckIn(req, res, () => {
    let decoded = null;
    try { decoded = jwt.verify(String(req.headers.authorization || "").split(" ")[1], process.env.JWT_SECRET); } catch { /* requireCheckIn checked it */ }
    if (!decoded || signedInWithoutPassword(decoded)) return res.status(403).json({ error: DESK_PASSWORD_REQUIRED, code: PASSWORD_REQUIRED_CODE });
    if (!canUseStaffSignIn(req.user)) return res.status(403).json({ error: DESK_TEAM_ONLY, code: "team_only" });
    req.deskStaff = req.user?.role === "admin";
    next();
  });
}
const staffOnly = (req, res, next) => (req.deskStaff ? next() : res.status(403).json({ error: "Only staff can do that." }));

const limiters = {
  snapshot: makeLimiter({ max: 40, windowMs: 60 * 1000 }),
  events: makeLimiter({ max: 300, windowMs: 60 * 1000 }),
  stream: makeLimiter({ max: 40, windowMs: 60 * 1000 }),
  actions: makeLimiter({ max: 600, windowMs: 60 * 1000 }),
  lookup: makeLimiter({ max: 30, windowMs: 60 * 1000 }),
};
const limit = (name) => (req, res, next) => (limiters[name].hit(`${name}:${req.user._id}`) ? next()
  : res.status(429).json({ error: "Too many requests from this sign-in. Wait a minute and try again." }));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error("CHECKIN DESK ERROR:", err);
  if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Try again." });
});

/* ---------- The agenda (the website's /agenda: Sanity sessions), staff's settings, the guest index ---------- */

const AGENDA_GROQ = '*[_type=="session" && !(_id in path("drafts.**"))]{_id,day,time,endTime,title,type,format,isBreak,stage,'
  + '"speakers":speakers[]{name},"moderator":moderator{name}}';
const agendaCache = makeAgendaCache({
  url: `https://${SANITY_PROJECT}.apicdn.sanity.io/v2021-10-21/data/query/production?query=${encodeURIComponent(AGENDA_GROQ)}`,
  parse: (json) => (Array.isArray(json?.result) && json.result.length ? json.result : null),
  label: "CHECKIN DESK AGENDA", ttlMs: 60 * 1000, retryMs: 30 * 1000,
});

/* A tap never waits for Sanity: the last agenda read is used while a new one loads in the background (and, before the
   first read lands, at most AGENDA_WAIT_MS, then the Oct 23 fallback times). */
const AGENDA_WAIT_MS = 1500;
let lastAgenda; // undefined: never read; null: the agenda couldn't be read
async function agendaNow({ waitMs = AGENDA_WAIT_MS } = {}) {
  const read = agendaCache.get().then((v) => { lastAgenda = v; return v; });
  if (lastAgenda !== undefined) return lastAgenda;
  let timer;
  const slow = new Promise((ok) => { timer = setTimeout(() => ok(null), waitMs); timer.unref?.(); });
  try { return await Promise.race([read, slow]); } finally { clearTimeout(timer); }
}

let settingsCache = { at: 0, value: null };
async function loadSettings({ fresh = false } = {}) {
  if (!fresh && settingsCache.value && Date.now() - settingsCache.at < 10 * 1000) return settingsCache.value;
  const doc = await AppContent.findOne({ key: SETTINGS_KEY }).lean();
  const c = cleanSettings(doc?.value || {});
  const value = { ...(c.ok ? c.value : { windows: {}, buffers: {}, stations: {} }), updatedBy: doc?.updatedBy || "", updatedAt: doc?.updatedAt || null };
  settingsCache = { at: Date.now(), value };
  return value;
}

/** The windows now: staff's, else the live agenda ± buffers, else the fallback / defaults. */
async function windowsNow() {
  const [settings, sessions] = await Promise.all([loadSettings(), agendaNow()]);
  const agenda = sessions ? agendaTimes(sessions) : null;
  return { settings, sessions, agenda, windows: resolveWindows({ settings, agenda }) };
}

/* ---------- The guest index: served at once, rebuilt in the background ----------
   Requests use the last built index (stale-while-revalidate): a tap never waits for the People directory (all users,
   passes, RSVPs, engagement, Stripe) or Sanity. One rebuild at a time per instance, started when the index is older
   than INDEX_TTL_MS, when the agenda changed, or when the guest generation (the newest guest / inclusions event, any
   instance's: services/checkinDeskLog.js guestGeneration) is newer than the index: then with a fresh directory read,
   so a change staff made on another instance is in it. An unknown key waits for one fresh rebuild only when the index
   is older than MISS_GAP_MS (and once per request); otherwise it's a real miss (keys are a fixed HMAC of the ticket ID).
   Entitlement at the meal doors is read from the database for that one person (personNow), never from the index. */
const INDEX_TTL_MS = 30 * 1000;
const MISS_GAP_MS = 10 * 1000;
const deskIdx = { index: null, pending: null, pendingFresh: false, builds: 0, freshBuilds: 0, lastMissBuild: 0 };
let sessionsOfNow = () => [];
// The guest row that guest / inclusions events carry (services/checkinDeskLog.js), with the agenda's sessions.
setGuestRowBuilder((p) => deskGuestFrom(p, { sessionsOf: (x) => sessionsOfNow(x) }));
const logError = (label) => (err) => console.error(`CHECKIN DESK ${label} ERROR:`, err?.message || err);

function startBuild({ fresh = false } = {}) {
  if (deskIdx.pending) return deskIdx.pending;
  const pending = (async () => {
    const checkedAt = Date.now();
    const gen = await guestGeneration({ fresh: true });
    const prev = deskIdx.index;
    const useFresh = fresh || !prev || gen > prev.gen;
    if (useFresh) { deskIdx.freshBuilds += 1; if (deskIdx.pending === pending) deskIdx.pendingFresh = true; }
    const [d, sessions] = await Promise.all([directory(useFresh ? { fresh: true } : {}), agendaNow()]);
    const genOf = useFresh ? gen : prev.gen;
    if (prev && prev.dir === d && prev.sessions === sessions) {
      prev.checkedAt = checkedAt;
      prev.gen = Math.max(prev.gen, genOf);
      return prev;
    }
    const sessionsOf = sessionsIndex(sessions || []);
    const index = buildDeskIndex(d.people, { sessionsOf });
    Object.assign(index, { builtAt: d.builtAt || new Date(), dir: d, sessions, gen: genOf, checkedAt, sessionsOf });
    deskIdx.index = index;
    deskIdx.builds += 1;
    sessionsOfNow = sessionsOf;
    return index;
  })();
  deskIdx.pending = pending;
  deskIdx.pendingFresh = fresh;
  pending.then(() => {}, () => {}).finally(() => { if (deskIdx.pending === pending) { deskIdx.pending = null; deskIdx.pendingFresh = false; } });
  return pending;
}

/** Rebuild in the background when it's due. */
function refreshSoon(idx) {
  if (deskIdx.pending) return;
  if (Date.now() - idx.checkedAt > INDEX_TTL_MS || (lastAgenda !== undefined && lastAgenda !== idx.sessions)) {
    startBuild().catch(logError("INDEX"));
    return;
  }
  guestGeneration().then((g) => { if (g > idx.gen && !deskIdx.pending && deskIdx.index === idx) startBuild().catch(logError("INDEX")); })
    .catch(logError("GENERATION"));
}

/** The desk's guest index (the last one built; the first one is waited for). */
async function deskIndex() {
  const idx = deskIdx.index;
  if (!idx) return startBuild();
  refreshSoon(idx);
  return idx;
}

/** An index at least as new as guest generation `minGen` (waits for the rebuild; a few tries at most). */
async function indexWithGen(minGen) {
  for (let i = 0; i < 3; i++) {
    const idx = deskIdx.index;
    if (idx && idx.gen >= minGen) return idx;
    await (deskIdx.pending || startBuild({ fresh: true })).catch(logError("INDEX"));
  }
  return deskIdx.index || startBuild({ fresh: true });
}

/** Wait for one fresh rebuild for something the index doesn't have (an unknown key): only when the index is older
    than MISS_GAP_MS, at most one such rebuild per MISS_GAP_MS per instance (others join it), once per request. */
async function rebuildForMiss(memo = {}) {
  if (memo.waited) return null;
  memo.waited = true;
  const idx = deskIdx.index;
  const age = idx ? Date.now() - new Date(idx.builtAt).getTime() : Infinity;
  if (deskIdx.pending && deskIdx.pendingFresh) return deskIdx.pending.catch(() => deskIdx.index);
  if (age < MISS_GAP_MS || Date.now() - deskIdx.lastMissBuild < MISS_GAP_MS) return null;
  if (deskIdx.pending) await deskIdx.pending.catch(() => null);
  if (deskIdx.index && Date.now() - new Date(deskIdx.index.builtAt).getTime() < MISS_GAP_MS) return deskIdx.index;
  deskIdx.lastMissBuild = Date.now();
  return startBuild({ fresh: true }).catch(() => deskIdx.index);
}

async function resolveKey(key, memo = {}) {
  const hit = (await deskIndex()).byKey.get(key);
  if (hit) return hit;
  const again = await rebuildForMiss(memo);
  return again?.byKey.get(key) || null;
}

/** The guest with their inclusions as the database has them now (one person's records: personNow), across the passes
    the index counts for them. null: not found (the caller keeps the index's). */
async function freshGuest(hit, idx) {
  const p = idx?.dir?.byId?.get(hit?.guest?.personId);
  if (!p) return null;
  const now = await personNow(p);
  if (!now) return null;
  const counted = new Set(hit.guest.norms);
  const passes = (now.passList || []).filter((t) => counted.has(t.norm) && !t.hidden);
  if (!passes.length) return null;
  return { ...hit.guest, extras: guestExtras(passes).extras };
}

/** Tests: how many index builds this instance has made. */
export const deskIndexStats = () => ({ builds: deskIdx.builds, freshBuilds: deskIdx.freshBuilds, gen: deskIdx.index?.gen ?? null, pending: !!deskIdx.pending });

/* The desk app's unlisted address (contract C5): CHECKIN_DESK_PATH when set (a new token = a new link), else today's. */
const DESK_PATH_RE = /^\/checkin-[a-z0-9]{8,40}\/$/;
export const DEFAULT_DESK_PATH = "/checkin-j0s8e5p4akvh/";
export function deskAppPath(env = process.env) {
  const v = String(env.CHECKIN_DESK_PATH || "").trim();
  return DESK_PATH_RE.test(v) ? v : DEFAULT_DESK_PATH;
}

const stationList = (settings) => STATIONS.map((s) => ({ ...s, enabled: stationEnabled(s.key, settings) }));
const meOf = (req) => ({ id: String(req.user._id), name: req.user.name || req.user.email, role: req.deskStaff ? "staff" : "volunteer" });

/* ---------- Routes ---------- */

router.use(deskAuth);
router.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

router.get("/info", staffOnly, (req, res) => res.json({ path: deskAppPath() }));

router.get("/me", wrap(async (req, res) => {
  const { settings } = await windowsNow();
  res.json({ user: meOf(req), staff: req.deskStaff, stations: stationList(settings), serverTime: deskNow().toISOString(), today: eventDayInfo(deskNow()) });
}));

// Every 30 s from each device: the time, today, and where each station is (open, opens at…, closed: next is…).
router.get("/clock", limit("events"), wrap(async (req, res) => {
  const now = deskNow();
  const w = await windowsNow();
  res.json({
    serverTime: now.toISOString(), today: eventDayInfo(now), stations: stationList(w.settings), windows: w.windows, agendaRead: !!w.sessions,
    stationStates: Object.fromEntries(STATIONS.map((s) => [s.key, stationState({ station: s.key, at: now, windows: w.windows })])),
  });
}));

router.get("/snapshot", limit("snapshot"), wrap(async (req, res) => {
  const staff = req.deskStaff;
  // The cursor first: anything written after it reaches the device as events, on top of what's read below.
  const cursor = await currentCursor();
  const now = deskNow();
  const today = eventDayInfo(now);
  // The index: the last one, unless staff changed a guest since it was built (on any instance: the guest generation).
  // Then the rows those events carry are used at once (the directory where the change was made, just rebuilt), or,
  // when one has no row, a fresh rebuild is waited for. ?refresh=1 (the menu's "Reload the guest list"): a fresh
  // rebuild when the index is older than MISS_GAP_MS.
  let idx = await deskIndex();
  const gen = await guestGeneration({ fresh: true });
  let overlay = [];
  if (gen > idx.gen) {
    const rows = await guestRowsSince(idx.gen);
    if (rows.length && rows.every((r) => r.guest)) overlay = rows.map((r) => r.guest);
    else idx = await indexWithGen(gen);
  }
  if (req.query.refresh === "1" && Date.now() - new Date(idx.builtAt).getTime() > MISS_GAP_MS) {
    idx = await rebuildForMiss({}) || await indexWithGen(gen);
    overlay = overlay.filter(() => idx.gen < gen);
  }
  const [w, marks, notes, queries, attendance] = await Promise.all([
    windowsNow(),
    CheckinMark.find({ day: today.date }).lean(),
    CheckinEvent.aggregate([{ $match: { kind: "note" } }, { $sort: { seq: 1 } }, { $group: { _id: "$subject", last: { $last: "$$ROOT" } } }]),
    MediaQuery.find({ $or: [{ status: { $ne: "done" } }, { doneAt: { $gte: new Date(now.getTime() - 24 * 3600 * 1000) } }] }).sort({ createdAt: -1 }).limit(200).lean(),
    // Staff: who arrived / checked in each day, each person once (the rows are per pass; practice marks don't count).
    staff ? CheckinMark.aggregate([
      { $match: { at: { $ne: null }, point: { $in: ["arrived", "checked_in"] }, practice: { $ne: true } } },
      { $group: { _id: { day: "$day", point: "$point", subject: "$subject" } } },
    ]) : [],
  ]);
  // The directory is a copy up to a little while old: passes collected (or given back) since it was read come from the log.
  const passEvents = await CheckinEvent.find({ pass: { $exists: true }, at: { $gte: new Date(new Date(idx.builtAt).getTime() - 60 * 1000) } })
    .sort({ seq: 1 }).select("pass").lean();
  const passNow = new Map();
  for (const e of passEvents) if (e.pass?.ticketId) passNow.set(guestKey(e.pass.ticketId), e.pass);
  const guestOut = (g) => {
    const v = guestView(g, { staff });
    const p = passNow.get(g.key) || (g.keys.length === 1 ? passNow.get(g.keys[0]) : null);
    if (p) { v.passCollected = !!p.collected; v.passCollectedAt = p.collected && p.collectedAt ? new Date(p.collectedAt).toISOString() : null; }
    return v;
  };
  // Guests changed since the index was built: their rows from the events (the newest wins), in place of the old ones.
  let guests = idx.guests;
  let booths = idx.booths;
  if (overlay.length) {
    const byKey = new Map();
    for (const row of overlay) for (const k of row.keys || [row.key]) byKey.set(k, row);
    const seen = new Set();
    const out = [];
    for (const g of [...idx.guests, ...overlay]) {
      const row = g.keys.map((k) => byKey.get(k)).find(Boolean) || g;
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      out.push(row);
    }
    guests = out;
    booths = boothsOf(guests);
  }
  const noteMap = {};
  for (const n of notes) {
    const text = String(n.last.note || "").trim();
    if (text) noteMap[guestKey(n._id)] = { text, by: n.last.byName || "", at: n.last.at };
  }
  // Each person once: a pass's rows count for the guest whose pass it is (a pass that isn't a guest's doesn't count).
  const byNorm = new Map();
  for (const g of guests) for (const nm of g.norms || []) byNorm.set(nm, g.key);
  const people = new Map();
  for (const r of attendance) {
    const k = `${r._id.day}|${r._id.point}`;
    if (!people.has(k)) people.set(k, { day: r._id.day, point: r._id.point, keys: new Set(), passes: 0 });
    const line = people.get(k);
    line.passes += 1;
    const gk = byNorm.get(r._id.subject);
    if (gk) line.keys.add(gk);
  }
  res.json({
    serverTime: now.toISOString(),
    cursor,
    today,
    user: meOf(req),
    staff,
    stations: stationList(w.settings),
    windows: w.windows,
    stationStates: Object.fromEntries(STATIONS.map((s) => [s.key, stationState({ station: s.key, at: now, windows: w.windows })])),
    agendaRead: !!w.sessions,
    guests: guests.map(guestOut),
    booths: booths.map((b) => ({ key: b.key, booth: b.booth, companies: b.companies, guests: b.guests })),
    marks: marks.map((m) => markView(m)),
    notes: noteMap,
    queries: queries.map(queryView),
    // Staff: people per day and point (each person once; `rows` = the same, for app versions that read it; `passes`:
    // the pass rows behind it).
    attendance: [...people.values()].sort((a, b) => a.day.localeCompare(b.day) || a.point.localeCompare(b.point))
      .map((l) => ({ day: l.day, point: l.point, people: l.keys.size, rows: l.keys.size, passes: l.passes })),
    builtAt: idx.builtAt,
  });
}));

router.get("/events", limit("events"), wrap(async (req, res) => {
  const r = await readSince(req.query.since, { limit: 500 });
  res.json({ events: r.events.map((e) => eventView(e, { staff: req.deskStaff })), cursor: r.cursor, reset: r.reset, serverTime: deskNow().toISOString() });
}));

const STREAM_MAX_MS = 10 * 60 * 1000;
const PING_MS = 5 * 1000;
router.get("/stream", limit("stream"), wrap(async (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  let open = true;
  const write = (event, data, id) => {
    if (!open) return;
    res.write(`${id !== undefined && id !== null ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  // 2 KB of padding first: some proxies and browsers hold back a stream's first bytes until there are enough of them.
  res.write(`:${" ".repeat(2048)}\n\nretry: 2000\n\n`);
  const client = {
    staff: req.deskStaff,
    ready: false,
    // Until its catch-up is written, the stream gets new events without a cursor (services/checkinDeskLog.js publish).
    send: (events, cursor) => {
      const has = cursor !== null && cursor !== undefined;
      if (events.length) write("events", has ? { events, cursor } : { events }, has ? cursor : undefined);
      else if (has) write("cursor", { cursor }, cursor);
    },
  };
  // Join first, then catch up: nothing written in between is missed (each stream skips numbers it has sent), and no
  // frame carries a cursor before the catch-up's.
  const leave = subscribe(client);
  const close = () => {
    if (!open) return;
    open = false;
    leave();
    clearInterval(ping);
    clearTimeout(stop);
    try { res.end(); } catch { /* gone */ }
  };
  req.on("close", close);
  const ping = setInterval(() => write("ping", { serverTime: deskNow().toISOString() }), PING_MS);
  const stop = setTimeout(() => { write("bye", { reason: "reconnect" }); close(); }, STREAM_MAX_MS);
  ping.unref?.(); stop.unref?.();

  write("hello", { serverTime: deskNow().toISOString(), today: eventDayInfo(deskNow()) });
  let since = Math.max(0, Math.floor(Number(req.query.since) || 0));
  let caughtUp = since;
  try {
    for (let i = 0; i < 20 && open; i++) {
      const r = await readSince(since, { limit: 500 });
      if (!open) return;
      if (r.reset) { write("reset", { cursor: r.cursor }); caughtUp = r.cursor; break; }
      const fresh = r.events.filter((e) => !client.sent.has(e.seq));
      for (const e of r.events) client.sent.add(e.seq);
      write("events", { events: fresh.map((e) => eventView(e, { staff: req.deskStaff })), cursor: r.cursor, catchUp: true }, r.cursor);
      caughtUp = r.cursor;
      if (r.events.length < 500 || r.cursor === since) break;
      since = r.cursor;
    }
  } catch (err) {
    // No catch-up, no live stream: end it, so the device polls and reconnects from its own cursor.
    console.error("CHECKIN DESK STREAM CATCH-UP ERROR:", err?.message || err);
    write("error", { error: "The live updates couldn't catch up. Reconnecting." });
    close();
    return;
  }
  if (open) ready(client, caughtUp);
}));

router.post("/actions", limit("actions"), wrap(async (req, res) => {
  const batch = Array.isArray(req.body?.actions);
  const list = batch ? req.body.actions : [req.body];
  if (!list.length || list.length > MAX_BATCH) return res.status(400).json({ error: `Send 1 to ${MAX_BATCH} actions.` });
  // Never waits for the directory or Sanity (the last index and agenda; both refresh in the background).
  const [w, idx] = await Promise.all([windowsNow(), deskIndex()]);
  const memo = { waited: false };
  const ctx = {
    user: req.user,
    staff: req.deskStaff,
    windows: w.windows,
    stationOn: (s) => stationEnabled(s, w.settings),
    resolve: (key) => resolveKey(key, memo),
    resolveNorm: async (norm) => (await deskIndex()).byNorm.get(norm) || null,
    booth: (key) => idx.boothByKey.get(key) || null,
    // Meal doors: that guest's inclusions as the database has them now (a switch staff just made, on any instance).
    freshGuest: (hit) => freshGuest(hit, deskIdx.index || idx),
  };
  const results = [];
  for (const raw of list) {
    const clean = cleanAction(raw);
    if (!clean.ok) { results.push({ ok: false, status: 400, clientId: String(raw?.clientId || ""), error: clean.error, field: clean.field }); continue; }
    const r = await performAction(clean.value, ctx);
    results.push({ clientId: clean.value.clientId, ...r });
  }
  // The server's time with every answer (the device keeps its clock offset from it, contract C4).
  const serverTime = deskNow().toISOString();
  if (batch) return res.json({ results, serverTime });
  const r = results[0];
  res.status(r.ok ? 200 : r.status || 400).json({ ...r, serverTime });
}));

router.post("/lookup", limit("lookup"), wrap(async (req, res) => {
  const norm = normalizeTicketId(req.body?.ticketId);
  if (norm.length < 6) return res.status(400).json({ error: "Type the whole ticket ID." });
  let g = (await deskIndex()).byNorm.get(norm);
  if (!g) g = (await rebuildForMiss({}))?.byNorm.get(norm);
  if (!g) return res.status(404).json({ error: "No guest on the list has this ticket ID." });
  res.json({ key: g.key });
}));

router.get("/team", staffOnly, wrap(async (req, res) => {
  const team = await User.find({ role: { $in: ["admin", "volunteer"] }, banned: { $ne: true } }).select("name email role").sort({ name: 1 }).limit(300).lean();
  res.json({ team: team.map((u) => ({ id: String(u._id), name: u.name || u.email, role: u.role === "admin" ? "staff" : "volunteer" })) });
}));

router.get("/history/:key", staffOnly, wrap(async (req, res) => {
  const key = String(req.params.key || "");
  if (!isGuestKey(key)) return res.status(404).json({ error: "Guest not found." });
  const hit = await resolveKey(key);
  if (!hit) return res.status(404).json({ error: "Guest not found." });
  const subjects = hit.guest.norms;
  const events = await CheckinEvent.find({ subject: { $in: subjects } }).sort({ seq: -1 }).limit(60).lean();
  res.json({ events: events.map((e) => eventView(e, { staff: true })) });
}));

/* ---------- Settings (staff): Admin › Event day › Check-in › Desk settings ---------- */

async function settingsPayload() {
  const [settings, sessions] = await Promise.all([loadSettings({ fresh: true }), agendaCache.get()]);
  const agenda = sessions ? agendaTimes(sessions) : null;
  return {
    settings, agendaRead: !!sessions, agenda, windows: resolveWindows({ settings, agenda }), stations: stationList(settings),
    defaults: { buffers: DEFAULT_BUFFERS, fallbackAgenda: FALLBACK_AGENDA, windows: DEFAULT_WINDOWS },
  };
}

router.get("/settings", staffOnly, wrap(async (req, res) => res.json(await settingsPayload())));

router.put("/settings", staffOnly, requireAdmin, wrap(async (req, res) => {
  const c = cleanSettings(req.body || {});
  if (!c.ok) return res.status(400).json({ error: c.error });
  await AppContent.updateOne({ key: SETTINGS_KEY }, { $set: { value: c.value, updatedBy: req.user.name || req.user.email || "" } }, { upsert: true });
  settingsCache = { at: 0, value: null };
  await AdminAudit.create({ adminId: req.user._id, adminName: req.user.name, action: "checkin_desk_settings", targetType: "checkin_desk", targetId: SETTINGS_KEY,
    detail: `Desk windows / buffers / stations now: ${JSON.stringify(c.value)}`.slice(0, 500) }).catch(() => {});
  res.json(await settingsPayload());
}));

export default router;
