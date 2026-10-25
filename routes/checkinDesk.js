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
import { checkinPassOf, directory, peopleGeneration, personNow } from "./people.js";
import { connectRefusal, isAppQr, parseConnectQr } from "../services/connectQr.js";
import {
  MAX_BATCH, boothsOf, buildDeskIndex, cleanAction, deskRowFrom, eventView, guestExtras, guestKey, guestView, isGuestKey, isPersonSubject, keyOfSubject, markView,
  personKey, queryView, sessionsIndex, unknownKeyOf, unknownRows,
} from "../services/checkinDesk.js";
import { countingPasses } from "../services/eventSummary.js";
import { loadAttendance } from "../services/checkinAttendance.js";
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
   Under /api/checkin, next to the door scanner. Every route needs a
   staff or volunteer PASSWORD sign-in
   (contract C1): the checkIn right (requireCheckIn), an account that can
   use the apps' staff sign-in (canUseStaffSignIn: role admin / volunteer,
   or the Staff / Volunteer type), and never a passwordless token (pass ID
   + last name, emailed code): 403 { code: "password_required" }. "Staff"
   here = a staff account (role admin); everyone else is a volunteer.

     GET  /info           staff: { path } the desk app's address, /checkin/ (contract C5: the admin card reads it
                          here; the public website never links to it)
     GET  /me             who's signed in, staff or volunteer, the stations, today
     GET  /clock          the time, today and each station's window state (each device every 30 s)
     GET  /snapshot       everything a device needs: guests (staff see emails and ticket IDs; volunteers never),
                          today's marks, desk notes, booths, media queries, today's NO DETAILS FOUND cards (`unknowns`,
                          contract C8), the stations' windows, the cursor
     GET  /events?since=  the events after a cursor (the polling fallback) → { events, cursor, reset }
     GET  /stream?since=  the same as Server-Sent Events (Authorization header: the app reads it with fetch, so no
                          token ever goes in a URL); a ping every 5 s; ends after 10 minutes (the app reconnects)
     POST /actions        one action, or { actions: [...] } (≤ 25, in order: the offline queue) → { results }
     POST /lookup         { ticketId } → { key } : a volunteer typed a ticket ID (they don't hold the list of them); since
                          Oct 24 2026 also a networking QR's text (their pass: routes/people.js checkinPassOf; 404
                          { code: bad_qr | networking_qr | no_pass } as at the door, never an email)
     GET  /team           staff: the team's names (media query assignees)
     GET  /history/:key   staff: one guest's events (latest 60)
     GET  /counts         staff: attendance by day (contract C10, services/checkinAttendance.js): arrived, checked in,
                          passes collected to date, each meal's admitted / entitled / RSVP'd / no-shows / overrides,
                          by pass colour, ISSUE PASS and NO DETAILS FOUND; each person once per point and day
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
   passes, RSVPs, engagement, Stripe) or Sanity. One rebuild at a time per instance, started in the background when
   the index is older than INDEX_TTL_MS (with a directory copy at most DIR_MAX_AGE_MS old), when the agenda changed,
   when People changed on this instance (Give a pass, an RSVP edit, a delete…: routes/people.js peopleGeneration), or
   when the guest generation (the newest guest / inclusions event, any instance's: services/checkinDeskLog.js
   guestGeneration) is newer than the index: then with a fresh directory read, so a change staff made on another
   instance is in it. Give a pass, pass edits and deletes send a guest event, so every instance has them at once.
   A reload (snapshot) waits for the rebuild a People change on this instance needs; a key the index doesn't have
   waits for the index a change needs (this instance's, or a guest event's), else for one fresh rebuild only when the
   index is older than MISS_GAP_MS (and once per request); otherwise it's a real miss (keys are a fixed HMAC of the
   ticket ID). Entitlement at the meal doors is read from the database for that one person (personNow), never from
   the index. */
const INDEX_TTL_MS = 20 * 1000;
const DIR_MAX_AGE_MS = 5 * 1000;
const MISS_GAP_MS = 10 * 1000;
const deskIdx = { index: null, pending: null, pendingFresh: false, builds: 0, freshBuilds: 0, lastMissBuild: 0 };
let sessionsOfNow = () => [];
// The guest row that guest / inclusions events carry (services/checkinDeskLog.js), with the agenda's sessions.
setGuestRowBuilder((p) => deskRowFrom(p, { sessionsOf: (x) => sessionsOfNow(x) }));
const logError = (label) => (err) => console.error(`CHECKIN DESK ${label} ERROR:`, err?.message || err);

function startBuild({ fresh = false } = {}) {
  if (deskIdx.pending) return deskIdx.pending;
  const pending = (async () => {
    const checkedAt = Date.now();
    const gen = await guestGeneration({ fresh: true });
    const prev = deskIdx.index;
    const useFresh = fresh || !prev || gen > prev.gen;
    if (useFresh) { deskIdx.freshBuilds += 1; if (deskIdx.pending === pending) deskIdx.pendingFresh = true; }
    // This instance's People changes up to here are in the directory read below (one made during it moves it again).
    const pgen = peopleGeneration();
    const [d, sessions] = await Promise.all([directory(useFresh ? { fresh: true } : { maxAgeMs: DIR_MAX_AGE_MS }), agendaNow()]);
    const genOf = useFresh ? gen : prev.gen;
    if (prev && prev.dir === d && prev.sessions === sessions) {
      prev.checkedAt = checkedAt;
      prev.gen = Math.max(prev.gen, genOf);
      prev.pgen = pgen;
      return prev;
    }
    const sessionsOf = sessionsIndex(sessions || []);
    const index = buildDeskIndex(d.people, { sessionsOf, aliases: d.byId });
    Object.assign(index, { builtAt: d.builtAt || new Date(), dir: d, sessions, gen: genOf, pgen, checkedAt, sessionsOf });
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

/** People changed on this instance since the index was read (routes/people.js invalidated its directory). */
const peopleMoved = (idx) => !!idx && idx.pgen !== peopleGeneration();

/** Rebuild in the background when it's due. */
function refreshSoon(idx) {
  if (deskIdx.pending) return;
  if (Date.now() - idx.checkedAt > INDEX_TTL_MS || peopleMoved(idx) || (lastAgenda !== undefined && lastAgenda !== idx.sessions)) {
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

/** An index with this instance's People changes in it (waits for the rebuild they started; a few tries at most). */
async function indexWithPeople() {
  for (let i = 0; i < 3; i++) {
    const idx = deskIdx.index;
    if (idx && !peopleMoved(idx)) return idx;
    await (deskIdx.pending || startBuild()).catch(logError("INDEX"));
  }
  return deskIdx.index || startBuild();
}

/** For something the index doesn't have (an unknown key), once per request: the index a change made since needs (a
    People change on this instance, or a guest event from any instance, e.g. the new pass a desk was just told about);
    else one fresh rebuild, only when the index is older than MISS_GAP_MS and at most one such rebuild per MISS_GAP_MS
    per instance (others join it). → an index to look in again, or null (a real miss). */
async function rebuildForMiss(memo = {}) {
  if (memo.waited) return null;
  memo.waited = true;
  if (peopleMoved(deskIdx.index)) return indexWithPeople().catch(() => deskIdx.index);
  const gen = await guestGeneration({ fresh: true }).catch(() => 0);
  if (deskIdx.index && gen > deskIdx.index.gen) return indexWithGen(gen).catch(() => deskIdx.index);
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

/** The guest with their inclusions as the database has them now (one person's records: personNow): every counting pass
    of theirs, a pass given a moment ago (Give a pass) included, except one the index's directory knew as refunded
    (personNow can't ask Stripe). No counting pass any more (hidden just now): nothing included. null: the person
    isn't found (the caller keeps the index's). */
async function freshGuest(hit, idx) {
  const p = idx?.dir?.byId?.get(hit?.guest?.personId);
  if (!p) return null;
  const now = await personNow(p);
  if (!now) return null;
  const refunded = new Set((p.passList || []).filter((t) => t.status === "refunded").map((t) => t.norm));
  const passes = countingPasses(now).filter((t) => !refunded.has(t.norm));
  return { ...hit.guest, extras: guestExtras(passes).extras };
}

/** Tests: how many index builds this instance has made. */
export const deskIndexStats = () => ({ builds: deskIdx.builds, freshBuilds: deskIdx.freshBuilds, gen: deskIdx.index?.gen ?? null, pending: !!deskIdx.pending });

/* The desk app's address (contract C5): the plain /checkin/ since Oct 24 2026 (unlisted: no link on the public site,
   not in a sitemap; the staff / volunteer sign-in is what protects it). CHECKIN_DESK_PATH overrides it when set to
   /checkin/ or the older /checkin-<token>/ form; anything else is ignored. */
const DESK_PATH_RE = /^\/checkin(-[a-z0-9]{8,40})?\/$/;
export const DEFAULT_DESK_PATH = "/checkin/";
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
  // People changed on this instance (Give a pass, an RSVP edit…): the rebuild that change started.
  if (peopleMoved(idx)) idx = await indexWithPeople();
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
  const [w, marks, notes, queries, attendance, unknowns] = await Promise.all([
    windowsNow(),
    CheckinMark.find({ day: today.date }).lean(),
    CheckinEvent.aggregate([{ $match: { kind: "note" } }, { $sort: { seq: 1 } }, { $group: { _id: "$subject", last: { $last: "$$ROOT" } } }]),
    MediaQuery.find({ $or: [{ status: { $ne: "done" } }, { doneAt: { $gte: new Date(now.getTime() - 24 * 3600 * 1000) } }] }).sort({ createdAt: -1 }).limit(200).lean(),
    // Staff: who arrived / checked in each day, each person once (the rows are per pass; practice marks don't count).
    staff ? CheckinMark.aggregate([
      { $match: { at: { $ne: null }, point: { $in: ["arrived", "checked_in"] }, practice: { $ne: true } } },
      { $group: { _id: { day: "$day", point: "$point", subject: "$subject" } } },
    ]) : [],
    unknownsFor(today.date),
  ]);
  // The directory is a copy up to a little while old: passes collected (or given back) since it was read come from the log.
  const passEvents = await CheckinEvent.find({ pass: { $exists: true }, at: { $gte: new Date(new Date(idx.builtAt).getTime() - 60 * 1000) } })
    .sort({ seq: 1 }).select("pass").lean();
  const passNow = new Map();
  for (const e of passEvents) if (e.pass?.ticketId) passNow.set(guestKey(e.pass.ticketId), e.pass);
  const guestOut = (g) => {
    const v = guestView(g, { staff });
    const more = moreKeys.get(g.key);
    if (more) v.keys = [...new Set([...(v.keys || [v.key]), ...more])];
    const p = passNow.get(g.key) || (g.keys.length === 1 ? passNow.get(g.keys[0]) : null);
    if (p) { v.passCollected = !!p.collected; v.passCollectedAt = p.collected && p.collectedAt ? new Date(p.collectedAt).toISOString() : null; }
    return v;
  };
  // Guests changed since the index was built: their rows from the events (the newest wins), in place of the old ones,
  // matched by any of their keys or by any id they go by (an event row's `aliasSubjects`; an index row's alias keys):
  // someone given a pass on another instance replaces their ISSUE PASS row (contract C7), never shows twice.
  let guests = idx.guests;
  let booths = idx.booths;
  const overlayByKey = new Map();
  const overlayAliasKeys = new Map(overlay.map((row) => [row, (row.aliasSubjects || []).map((s) => personKey(s))]));
  const replaced = new Map(); // index row → the event row in its place
  for (const row of overlay) for (const k of [...(row.keys || [row.key]), ...overlayAliasKeys.get(row)]) overlayByKey.set(k, row);
  if (overlay.length) {
    const seen = new Set();
    const out = [];
    for (const g of [...idx.guests, ...overlay]) {
      const own = [...(g.keys || [g.key]), ...(overlayAliasKeys.get(g) || idx.aliasKeysOf?.get(g) || [])];
      const row = own.map((k) => overlayByKey.get(k)).find(Boolean) || g;
      if (row !== g) replaced.set(g, row);
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      out.push(row);
    }
    guests = out;
    booths = boothsOf(guests);
  }
  /** The row a key belongs to in this snapshot (an event row in place of the index's). */
  const rowOfKey = (k) => {
    if (overlayByKey.has(k)) return overlayByKey.get(k);
    const g = idx.byKey.get(k)?.guest;
    return g ? replaced.get(g) || g : null;
  };
  const noteMap = {};
  for (const n of notes) {
    const text = String(n.last.note || "").trim();
    if (text) noteMap[keyOfSubject(n._id)] = { text, by: n.last.byName || "", at: n.last.at };
  }
  // ISSUE PASS (contract C7): today's marks made on someone's no-pass key ("person:<id>") show on their row, also once
  // they hold a pass or go by another id (the key joins the row's keys).
  const moreKeys = new Map();
  for (const m of marks) {
    if (!m.at || !isPersonSubject(m.subject)) continue;
    const k = keyOfSubject(m.subject);
    const g = rowOfKey(k);
    if (!g || g.keys.includes(k)) continue;
    if (!moreKeys.has(g.key)) moreKeys.set(g.key, new Set());
    moreKeys.get(g.key).add(k);
  }
  // Each person once: a pass's rows count for the guest whose pass it is (a pass that isn't a guest's doesn't count),
  // and so do the rows of every id they go by (ISSUE PASS marks made before a pass was given).
  const byNorm = new Map();
  for (const g of guests) {
    for (const nm of [...(g.norms || []), ...(overlayAliasKeys.has(g) ? g.aliasSubjects || [] : idx.subjectsOf?.get(g) || [])]) if (!byNorm.has(nm)) byNorm.set(nm, g.key);
  }
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
    // Today's NO DETAILS FOUND cards (contract C8), open or closed, never undone ones; never in any count.
    unknowns,
    // Staff: people per day and point (each person once; `rows` = the same, for app versions that read it; `passes`:
    // the pass rows behind it).
    attendance: [...people.values()].sort((a, b) => a.day.localeCompare(b.day) || a.point.localeCompare(b.point))
      .map((l) => ({ day: l.day, point: l.point, people: l.keys.size, rows: l.keys.size, passes: l.passes })),
    builtAt: idx.builtAt,
  });
}));

/** A day's NO DETAILS FOUND cards (contract C8): its unknown_arrival events and what happened to them since. */
async function unknownsFor(day) {
  const arrivals = await CheckinEvent.find({ kind: "unknown_arrival", day }).sort({ seq: 1 }).limit(500).lean();
  if (!arrivals.length) return [];
  const after = await CheckinEvent.find({ kind: { $in: ["undo", "unknown_done", "unknown_link"] }, subject: { $in: arrivals.map((e) => unknownKeyOf(e.clientId)) } })
    .sort({ seq: 1 }).lean();
  return unknownRows(arrivals, after);
}

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
  // This instance is shutting down (services/checkinDeskLog.js endStreams): the device reconnects elsewhere.
  client.end = () => { write("bye", { reason: "reconnect" }); close(); };
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
  let typed = String(req.body?.ticketId ?? "").trim();
  // A networking (Connect) QR read into the search (Oct 24 2026): their pass, as at the door (routes/checkin.js).
  if (isAppQr(typed)) {
    const qr = parseConnectQr(typed);
    const refuse = (k) => { const b = connectRefusal(k); return res.status(404).json({ error: b.message, code: b.code }); };
    if (!qr?.ok) return refuse("bad_qr");
    if (!qr.userId && !qr.email) return refuse("networking_qr");
    const r = await checkinPassOf({ userId: qr.userId, email: qr.userId ? "" : qr.email });
    if (!r.found) return refuse(r.account ? "no_pass" : "networking_qr");
    typed = r.ticketId;
  }
  const norm = normalizeTicketId(typed);
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

/* Attendance by day (contract C10): the desk app's staff-only Counts screen (refreshed on each relevant live event and
   every 30 s). One computation at a time per instance, kept for a second (many iPads refresh on the same event). */
const COUNTS_TTL_MS = 1000;
let countsCache = { at: 0, dir: null, value: null, pending: null };
async function countsNow(dir) {
  if (countsCache.value && countsCache.dir === dir && Date.now() - countsCache.at < COUNTS_TTL_MS) return countsCache.value;
  if (countsCache.pending && countsCache.dir === dir) return countsCache.pending;
  const pending = loadAttendance(dir).then((value) => { countsCache = { at: Date.now(), dir, value, pending: null }; return value; })
    .catch((err) => { if (countsCache.pending === pending) countsCache.pending = null; throw err; });
  countsCache = { ...countsCache, dir, pending };
  return pending;
}
// Several iPads may share one staff sign-in, each refreshing on every counted event and every 30 s; the answer is one
// computation per instance kept for a second (countsNow), so a high limit per sign-in costs little.
limiters.counts = makeLimiter({ max: 600, windowMs: 60 * 1000 });
router.get("/counts", staffOnly, limit("counts"), wrap(async (req, res) => {
  let idx = await deskIndex();
  if (peopleMoved(idx)) idx = await indexWithPeople();
  const attendance = await countsNow(idx.dir);
  // The attendance object, and the same under `attendance` (GET /api/console/summary's field name).
  res.json({ ...attendance, attendance, serverTime: deskNow().toISOString() });
}));

router.get("/history/:key", staffOnly, wrap(async (req, res) => {
  const key = String(req.params.key || "");
  if (!isGuestKey(key)) return res.status(404).json({ error: "Guest not found." });
  const hit = await resolveKey(key);
  if (!hit) return res.status(404).json({ error: "Guest not found." });
  // Their passes and every id they go by (ISSUE PASS marks made before a pass was given, contract C7).
  const subjects = hit.subjects?.length ? hit.subjects : hit.guest.norms;
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
