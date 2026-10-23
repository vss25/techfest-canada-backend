import express from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import CheckinMark from "../models/CheckinMark.js";
import CheckinEvent from "../models/CheckinEvent.js";
import MediaQuery from "../models/MediaQuery.js";
import { AppContent, AdminAudit } from "../models/Admin.js";
import { requireCheckIn, requireAdmin } from "../middleware/adminAuth.js";
import { signedInWithoutPassword } from "../services/signInMethod.js";
import { makeLimiter, normalizeTicketId } from "../services/ticketAccess.js";
import { makeAgendaCache } from "../services/points.js";
import { SANITY_PROJECT } from "../services/rsvp.js";
import { directory } from "./people.js";
import {
  MAX_BATCH, buildDeskIndex, cleanAction, eventView, guestKey, guestView, markView, queryView, sessionsIndex,
} from "../services/checkinDesk.js";
import {
  STATIONS, agendaTimes, cleanSettings, eventDayInfo, resolveWindows, stationEnabled, stationState, DEFAULT_BUFFERS, FALLBACK_AGENDA, DEFAULT_WINDOWS,
} from "../services/checkinDeskTime.js";
import { currentCursor, deskNow, readSince, subscribe } from "../services/checkinDeskLog.js";
import { performAction } from "../services/checkinDeskActions.js";

/* =========================================================
   TTFC Check-in desk app API (Oct 23 2026): /api/checkin/desk
   ---------------------------------------------------------
   Under /api/checkin so the kill switch leaves it working, like the
   door scanner. Every route needs a staff or volunteer sign-in with
   the checkIn right (requireCheckIn: volunteers and staff by default).
   "Staff" here = a staff account (role admin) signed in with its
   password (as the admin panel requires); everyone else is a volunteer.

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

/** requireCheckIn, then: staff = a staff account signed in with its password (the admin panel's rule). */
function deskAuth(req, res, next) {
  requireCheckIn(req, res, () => {
    let decoded = null;
    try { decoded = jwt.verify(String(req.headers.authorization || "").split(" ")[1], process.env.JWT_SECRET); } catch { /* requireCheckIn checked it */ }
    req.deskStaff = req.user?.role === "admin" && !signedInWithoutPassword(decoded);
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
  const [settings, sessions] = await Promise.all([loadSettings(), agendaCache.get()]);
  return { settings, sessions, agenda: sessions ? agendaTimes(sessions) : null, windows: resolveWindows({ settings, agenda: sessions ? agendaTimes(sessions) : null }) };
}

let indexCache = { dir: null, sessions: undefined, index: null };
/** The desk's guest index, rebuilt when the People directory (20 s copy) or the agenda changes. */
async function deskIndex({ fresh = false } = {}) {
  const [d, sessions] = await Promise.all([directory({ fresh }), agendaCache.get()]);
  if (indexCache.dir === d && indexCache.sessions === sessions && indexCache.index) return indexCache.index;
  const index = buildDeskIndex(d.people, { sessionsOf: sessionsIndex(sessions || []) });
  index.builtAt = d.builtAt || new Date();
  indexCache = { dir: d, sessions, index };
  return index;
}
async function resolveKey(key) {
  let idx = await deskIndex();
  let hit = idx.byKey.get(key);
  if (!hit) { idx = await deskIndex({ fresh: true }); hit = idx.byKey.get(key); }
  return hit || null;
}

const stationList = (settings) => STATIONS.map((s) => ({ ...s, enabled: stationEnabled(s.key, settings) }));
const meOf = (req) => ({ id: String(req.user._id), name: req.user.name || req.user.email, role: req.deskStaff ? "staff" : "volunteer" });

/* ---------- Routes ---------- */

router.use(deskAuth);
router.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

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
  const [idx, w, marks, notes, queries, attendance] = await Promise.all([
    deskIndex({ fresh: req.query.refresh === "1" }),
    windowsNow(),
    CheckinMark.find({ day: today.date }).lean(),
    CheckinEvent.aggregate([{ $match: { kind: "note" } }, { $sort: { seq: 1 } }, { $group: { _id: "$subject", last: { $last: "$$ROOT" } } }]),
    MediaQuery.find({ $or: [{ status: { $ne: "done" } }, { doneAt: { $gte: new Date(now.getTime() - 24 * 3600 * 1000) } }] }).sort({ createdAt: -1 }).limit(200).lean(),
    staff ? CheckinMark.aggregate([{ $match: { at: { $ne: null }, point: { $in: ["arrived", "checked_in"] } } }, { $group: { _id: { day: "$day", point: "$point" }, n: { $sum: 1 } } }]) : [],
  ]);
  // The directory is a copy up to 20 s old: passes collected (or given back) since it was read come from the log.
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
  const noteMap = {};
  for (const n of notes) {
    const text = String(n.last.note || "").trim();
    if (text) noteMap[guestKey(n._id)] = { text, by: n.last.byName || "", at: n.last.at };
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
    guests: idx.guests.map(guestOut),
    booths: idx.booths.map((b) => ({ key: b.key, booth: b.booth, companies: b.companies, guests: b.guests })),
    marks: marks.map((m) => markView(m)),
    notes: noteMap,
    queries: queries.map(queryView),
    // Staff: rows per day and point (each pass once a day; the app counts people).
    attendance: attendance.map((r) => ({ day: r._id.day, point: r._id.point, rows: r.n })),
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
    send: (events, cursor) => {
      if (events.length) write("events", { events, cursor }, cursor ?? undefined);
      else if (cursor !== null && cursor !== undefined) write("cursor", { cursor }, cursor);
    },
  };
  // Join first, then catch up: nothing written in between is missed (each stream skips numbers it has sent).
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
  for (let i = 0; i < 20 && open; i++) {
    const r = await readSince(since, { limit: 500 });
    if (r.reset) { write("reset", { cursor: r.cursor }); break; }
    const fresh = r.events.filter((e) => !client.sent.has(e.seq));
    for (const e of r.events) client.sent.add(e.seq);
    write("events", { events: fresh.map((e) => eventView(e, { staff: req.deskStaff })), cursor: r.cursor, catchUp: true }, r.cursor);
    if (r.events.length < 500 || r.cursor === since) break;
    since = r.cursor;
  }
}));

router.post("/actions", limit("actions"), wrap(async (req, res) => {
  const batch = Array.isArray(req.body?.actions);
  const list = batch ? req.body.actions : [req.body];
  if (!list.length || list.length > MAX_BATCH) return res.status(400).json({ error: `Send 1 to ${MAX_BATCH} actions.` });
  const w = await windowsNow();
  const idx = await deskIndex();
  const ctx = {
    user: req.user,
    staff: req.deskStaff,
    windows: w.windows,
    stationOn: (s) => stationEnabled(s, w.settings),
    resolve: resolveKey,
    resolveNorm: async (norm) => (await deskIndex()).byNorm.get(norm) || null,
    booth: (key) => idx.boothByKey.get(key) || null,
  };
  const results = [];
  for (const raw of list) {
    const clean = cleanAction(raw);
    if (!clean.ok) { results.push({ ok: false, status: 400, clientId: String(raw?.clientId || ""), error: clean.error, field: clean.field }); continue; }
    const r = await performAction(clean.value, ctx);
    results.push({ clientId: clean.value.clientId, ...r });
  }
  if (batch) return res.json({ results });
  const r = results[0];
  res.status(r.ok ? 200 : r.status || 400).json(r);
}));

router.post("/lookup", limit("lookup"), wrap(async (req, res) => {
  const norm = normalizeTicketId(req.body?.ticketId);
  if (norm.length < 6) return res.status(400).json({ error: "Type the whole ticket ID." });
  const idx = await deskIndex();
  const g = idx.byNorm.get(norm);
  if (!g) return res.status(404).json({ error: "No guest on the list has this ticket ID." });
  res.json({ key: g.key });
}));

router.get("/team", staffOnly, wrap(async (req, res) => {
  const team = await User.find({ role: { $in: ["admin", "volunteer"] }, banned: { $ne: true } }).select("name email role").sort({ name: 1 }).limit(300).lean();
  res.json({ team: team.map((u) => ({ id: String(u._id), name: u.name || u.email, role: u.role === "admin" ? "staff" : "volunteer" })) });
}));

router.get("/history/:key", staffOnly, wrap(async (req, res) => {
  const hit = await resolveKey(String(req.params.key || ""));
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
