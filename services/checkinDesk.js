import crypto from "node:crypto";
import { countingPasses, entitledExtras, mainPass } from "./eventSummary.js";
import { TIER_LABELS, DIETARY, tierFromTicketType, personNameKey, nameVariants, fullNameMatches } from "./rsvp.js";
import { rsvpStatusOf, splitName } from "./rsvpStaff.js";
import { EXTRA_KEYS, extrasView } from "./passExtras.js";
import { personBand } from "./checkinCard.js";
import { normalizeTicketId } from "./ticketAccess.js";
import { STATION_KEYS, STATION_LABELS, OTHER_STATIONS, MEAL_POINTS, mealItem, isHHMM, toMin } from "./checkinDeskTime.js";

/* =========================================================
   TTFC Check-in: the guest check-in desk app (Oct 23 2026)
   ---------------------------------------------------------
   The organiser: "I need a web app that works well for completing
   the checking of the guest. I will be installing this app on
   ipads. There should be a volunteer access and staff access …
   The guest will arrive in lobby and will take 30 seconds to
   escalator/elevator and then they will come up and get their
   individual pass. The person in the lobby below will ask the
   person their name and put a check mark on arrived. The person on
   the first floor would get a notification that this person is
   coming upstairs and would look for passes …"
   And later the same day: "Also pick a station as breakfast, media
   query queue, av station, exhibitor, lunch. Remember check in should
   be time appropriate." (stations and windows: services/checkinDeskTime.js)

   One sign-in (staff and volunteer accounts, POST /api/auth/login
   staffOnly), eight stations: Lobby (Arrived), Floor 1 pass desk
   (Checked in = pass handed over), CxO Breakfast, Lunch, Evening entry
   (Admitted), Media desk, AV station (AV checked), Exhibitor desk
   (Checked in, Booth set up).

   Who is a guest: the People directory (routes/people.js directory(),
   services/people.js buildPeople), with the Event summary's rules
   (services/eventSummary.js): one row per person with a counting pass
   (not hidden by staff, not refunded, not a booth), under their main
   pass (a Speaker Pass first, else the pass People shows). Inclusions
   are the directory's (services/passExtras.js), and a person is
   entitled to an extra when ANY of their counting passes includes it
   (the Event summary's rule, eventSummary.js entitledExtras): nothing
   is worked out again here. ISSUE PASS (contract C7): people on the list
   with no pass on file (a speaker with no Speaker Pass, Media or an
   exhibitor with no pass) are guests too, with `noPass: true` and an "n"
   key of their directory id (deskNoPassFrom).

   Keys: guests and their passes travel as opaque keys ("g" + 20 hex of
   an HMAC of the ticket ID), never ticket IDs, for volunteers: a ticket
   ID with a last name is an app sign-in, so a volunteer's iPad never
   holds the list of them. Staff rows carry the ticket IDs too. A booth
   is "b-<booth>".

   Marks (models/CheckinMark.js): one row per pass (or booth), Toronto
   date and point (arrived, checked_in, cxo, lunch, evening, media, av,
   exhibitor, booth, flag_cxo …). A person's status is the earliest of
   their passes' rows. A second mark the same day changes nothing
   ("Already admitted at 7:52"). "Pass collected" is the ticket's own
   checkedIn / checkedInAt (the field the QR scanner sets, so the scanner,
   Admin › Check-in and the Event summary agree): set once, by the first
   check-in on any day; Day 2 shows "Has pass (collected Mon)".

   Events (models/CheckinEvent.js): every change is one event with a
   sequence number from one counter (`seq`), carrying the rows' state
   after it (with a per-row `rev`, so applying events in any order, or
   twice, ends the same). The live stream and the polling fallback read
   the database (any number of server instances), with a cursor that
   never skips an event still being written (safeCursor).

   Pure (no database): unit-tested in test/checkin-desk.test.js; the
   database side is services/checkinDeskLog.js + checkinDeskActions.js,
   the routes routes/checkinDesk.js.
========================================================= */

export { STATION_KEYS, STATION_LABELS };

/** Every point a mark can record, and the station it belongs to. */
export const POINTS = Object.freeze({
  arrived: "lobby",
  checked_in: "desk",
  cxo: "breakfast",
  lunch: "lunch",
  evening: "evening",
  media: "media",
  av: "av",
  exhibitor: "exhibitor",
  booth: "exhibitor",
  // "Sent to staff": a volunteer at a meal station with a guest whose pass doesn't include it.
  flag_cxo: "breakfast",
  flag_lunch: "lunch",
  flag_evening: "evening",
});
export const POINT_KEYS = Object.freeze(Object.keys(POINTS));
export const POINT_LABELS = Object.freeze({
  arrived: "Arrived", checked_in: "Checked in", cxo: "Admitted", lunch: "Admitted", evening: "Admitted",
  media: "Checked in at the media desk", av: "AV checked", exhibitor: "Checked in at the exhibitor desk", booth: "Booth set up",
  flag_cxo: "Sent to staff", flag_lunch: "Sent to staff", flag_evening: "Sent to staff",
});
/** What can be sent. Staff only: reset (clear a mark), desk notes, linking a NO DETAILS FOUND arrival to a guest
    (contract C8); undo of someone else's tap. */
export const ACTION_KINDS = Object.freeze(["mark", "undo", "reset", "note", "query_add", "query_update", "unknown_arrival", "unknown_done", "unknown_link"]);
export const STAFF_KINDS = Object.freeze(["reset", "note", "unknown_link"]);
/** The taps an undo can take back: check-in marks, and a NO DETAILS FOUND arrival (contract C8). */
export const UNDOABLE_KINDS = Object.freeze(["mark", "unknown_arrival"]);
export const QUERY_STATUSES = Object.freeze(["new", "in_progress", "done"]);
export const QUERY_STATUS_LABELS = Object.freeze({ new: "New", in_progress: "In progress", done: "Done" });

/** A volunteer can undo their own last tap for 15 s (the app's toast); the server allows a little more for the
    round trip, measured on the iPad's own clock between the two taps (an undo queued offline still counts). */
export const UNDO_WINDOW_MS = 15 * 1000;
export const UNDO_GRACE_MS = 25 * 1000;
/** …and never later than this after the server stored the tap. */
export const UNDO_SERVER_MAX_MS = 15 * 60 * 1000;
/** When a tap was made (its clientAt: the device's clock corrected by the server's, contract C4) is clamped to
    [now − 12 h, now + 2 min] on the server. A tap more than LATE_SYNC_MS old when it arrives is a late sync (an
    offline queue): judged at its own time, and flagged (override "late_sync", audited) when that is outside the
    station's hours and the device didn't ask for "Admit anyway". */
export const CLIENT_AT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
export const CLIENT_AT_MAX_AHEAD_MS = 2 * 60 * 1000;
export const LATE_SYNC_MS = 60 * 1000;
/** Why a mark is an override, for the log and the apps. */
export const OVERRIDE_REASONS = Object.freeze({
  outside_window: "admitted outside its hours (Admit anyway)",
  late_sync: "late sync outside hours",
  // Contract C11: staff admitted a guest whose passes don't include today's item (the pass unchanged).
  not_included: "not on their pass: admitted by staff (override)",
  "outside_window+not_included": "not on their pass and outside its hours: admitted by staff (override)",
  "late_sync+not_included": "not on their pass, late sync outside hours: admitted by staff (override)",
});
export const NOTE_MAX = 140;
export const AV_NOTE_MAX = 80;
export const QUERY_LIMITS = Object.freeze({ who: 80, outlet: 80, request: 240 });
/** NO DETAILS FOUND (contract C8): the lobby couldn't find the person; it records the arrival with the name as typed.
    The pass desk closes the card with one of these outcomes (or staff link it to a guest: "linked"). */
export const UNKNOWN_LIMITS = Object.freeze({ name: 80, company: 80, note: 200 });
export const UNKNOWN_OUTCOMES = Object.freeze(["sent_to_help", "pass_issued", "left"]);
export const UNKNOWN_OUTCOME_TEXT = Object.freeze({ sent_to_help: "sent to the help desk", pass_issued: "pass issued", left: "left", linked: "found on the list" });
/** A sequence number missing for longer than this, counted from when a reader FIRST saw it missing, is a write that
    failed: the cursor moves past it. (Counting from the next event's own `at` would skip a write that commits late.) */
export const HOLE_MS = 15 * 1000;
/** …and a gap whose next event is older than this was a failed write long ago: skipped at once. */
export const HOLE_ANCIENT_MS = 5 * 60 * 1000;
export const MAX_BATCH = 25;

const str = (v) => String(v ?? "").trim();
const line = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const ms = (d) => { const n = d ? new Date(d).getTime() : NaN; return Number.isFinite(n) ? n : NaN; };
const iso = (d) => { const n = ms(d); return Number.isFinite(n) ? new Date(n).toISOString() : null; };

/* ---------- Keys ---------- */

/** The secret the keys are made with: derived from the tracking secret (or the JWT secret), never used as is. */
export function deskSecret(env = process.env) {
  const base = String(env.TRACKING_SECRET || env.JWT_SECRET || "");
  return crypto.createHmac("sha256", base || "ttfc-desk-no-secret").update("ttfc-checkin-desk-key:v1").digest();
}
let secretCache = null;
const secret = () => (secretCache ||= deskSecret());

/** A pass's key: "g" + 20 hex characters. The same on every server (same secret), and for every spelling of the ID. */
export function guestKey(ticketId, key = secret()) {
  const norm = normalizeTicketId(ticketId);
  if (!norm) return "";
  return `g${crypto.createHmac("sha256", key).update(norm).digest("hex").slice(0, 20)}`;
}
/** A guest's key: a pass's ("g…"), or an ISSUE PASS person's ("n…", contract C7). */
export const isGuestKey = (k) => /^[gn][0-9a-f]{20}$/.test(String(k || ""));

/** ISSUE PASS (contract C7): someone on the list with no pass on file has no ticket ID, so their marks are stored under
    their directory id ("person:<id>": u-<account>, s-<speaker>, a-…, r-…) and they travel as "n" + 20 hex characters
    of an HMAC of it (stable: the same person id gives the same key on every server; never a ticket). */
export const personSubject = (personId) => `person:${String(personId || "")}`;
export const isPersonSubject = (s) => String(s || "").startsWith("person:");
export function personKey(subject, key = secret()) {
  const s = isPersonSubject(subject) ? String(subject) : personSubject(subject);
  return `n${crypto.createHmac("sha256", key).update(s).digest("hex").slice(0, 20)}`;
}

/** A booth's key and the subject its marks are stored under: "b-A12" and "booth:a12". */
export const boothNorm = (booth) => String(booth || "").trim().replace(/[^A-Za-z0-9-]/g, "").slice(0, 20).toLowerCase();
export const boothKey = (booth) => (boothNorm(booth) ? `b-${boothNorm(booth).toUpperCase()}` : "");
export const isBoothKey = (k) => /^b-[A-Z0-9-]{1,20}$/.test(String(k || ""));
export const boothSubject = (key) => `booth:${String(key).slice(2).toLowerCase()}`;
/** A NO DETAILS FOUND card's key (contract C8): "u:" + the clientId of the lobby tap that recorded the arrival. It is
    also the subject its events are stored under. */
export const unknownKeyOf = (clientId) => `u:${clientId}`;
export const isUnknownKey = (k) => /^u:[A-Za-z0-9_-]{8,64}$/.test(String(k || ""));
/** The key a stored subject travels as. */
export const keyOfSubject = (subject, keyOf = guestKey) => {
  const s = String(subject);
  if (s.startsWith("booth:")) return `b-${s.slice(6).toUpperCase()}`;
  if (s.startsWith("u:")) return s;
  if (isPersonSubject(s)) return personKey(s);
  return keyOf(subject);
};

/* ---------- Guests ---------- */

/** Accent-free, lower-case. */
const fold = (s) => String(s || "").normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();

/** The person's marks the app shows next to the pass colour. */
function marksOf(p, main) {
  const types = new Set(p.types || []);
  return {
    vip: !!p.vip,
    media: types.has("media"),
    speaker: types.has("speaker") || main?.tier === "speaker",
    // The directory's answer (People's Exhibitor yes / no): an exhibitor pass makes them one unless staff switched it
    // off (typesOff on an account, Attendee.exhibitor false on a pass). Never the promo code on its own.
    exhibitor: types.has("exhibitor"),
    staff: types.has("staff"),
    volunteer: types.has("volunteer"),
  };
}

/** When their pass was first collected (any counting pass checked in), as an ISO string; `true` without a time. */
function collectedOf(passes) {
  const times = passes.filter((t) => t.checkedIn).map((t) => ms(t.checkedInAt)).filter(Number.isFinite);
  if (times.length) return new Date(Math.min(...times)).toISOString();
  return passes.some((t) => t.checkedIn) ? true : null;
}

const DIET_KEYS = new Set(DIETARY.map((d) => d.key).filter((k) => k !== "none"));
/** Their RSVP as the meal stations need it: did they RSVP, the days and meals on it, and their dietary needs. */
function rsvpOf(p) {
  const r = rsvpStatusOf(p.rsvp);
  const rsvpd = r.status !== "none";
  const dietary = rsvpd && Array.isArray(p.rsvp?.dietary) ? p.rsvp.dietary.filter((k) => DIET_KEYS.has(k)) : [];
  return {
    rsvpd,
    by: rsvpd ? r.status : "",
    days: rsvpd ? r.days.filter((d) => d === "day1" || d === "day2") : [],
    options: rsvpd ? r.options.map(String).slice(0, 20) : [],
    dietary,
    dietaryOther: dietary.includes("other") ? line(p.rsvp?.dietaryOther, 160) : "",
  };
}

/* ---------- Pass types (the colour) ---------- */

/** The five passes (services/rsvp.js TIERS), and "other" for a ticket type none of them names. */
export const DESK_TIERS = Object.freeze(["connect", "influence", "power", "apex", "speaker", "other"]);
const KNOWN_TIER_WORDS = /\b(connect|influence|power|all[- ]access|apex|vip|speaker|exhibitor)\b/;
const cleanType = (t) => String(t || "").toLowerCase().replace(/ttfc|20\d\d|pass|ticket/g, " ").replace(/[^a-z-]+/g, " ").trim();
const warnedTypes = new Set();

/**
 * A ticket type → the desk's pass: { tier, passName }. The five passes as everywhere (services/rsvp.js
 * tierFromTicketType: "All Access" is Power, an exhibitor pass is a Connect Pass, empty is Connect); any other value
 * (an old "Discover" or "Festival" pass staff didn't hide) is "other", named "Other: Discover", never blank. Logged once.
 */
export function deskTier(rawType, { log = console } = {}) {
  const s = cleanType(rawType);
  if (!s || KNOWN_TIER_WORDS.test(s)) {
    const tier = tierFromTicketType(rawType);
    return { tier, passName: TIER_LABELS[tier] };
  }
  const shown = String(rawType).replace(/\s+/g, " ").trim().slice(0, 30);
  if (!warnedTypes.has(s)) { warnedTypes.add(s); log.warn?.(`CHECKIN DESK: pass type "${shown}" isn't one of the five; shown as Other`); }
  return { tier: "other", passName: `Other: ${shown.charAt(0).toUpperCase()}${shown.slice(1)}` };
}

/** A booth for this person: their main pass's, else any of their exhibitor passes'. */
const boothOf = (passes, main) => str(main.booth) || str(passes.find((t) => t.booth)?.booth);

const passView = (t) => extrasView(t.extrasOverride || {}, t.extrasAuto || {}, t.extras || {});

/**
 * A person's inclusions on the desk (the Event summary's rule: an extra any counting pass includes) and, for staff,
 * each extra's switch on the pass that decides it: the main pass when it includes the extra (or nothing does), else
 * the first other pass that includes it, with that pass's `ticketId`.
 * → { extras: { cxo, lunch, gala, awards }, extrasView: { <extra>: { override, auto, included, ticketId } } }
 */
export function guestExtras(passes = [], main = passes[0]) {
  const extras = entitledExtras(passes);
  const mainView = main ? passView(main) : {};
  const extrasViewOut = {};
  for (const k of EXTRA_KEYS) {
    const from = main?.extras?.[k] || !extras[k] ? main : passes.find((t) => t.extras?.[k]) || main;
    const v = from === main ? mainView[k] : passView(from)[k];
    extrasViewOut[k] = { ...(v || { override: null, auto: false, included: false }), included: !!extras[k], ticketId: from?.ticketId || "" };
  }
  return { extras, extrasView: extrasViewOut };
}

/**
 * A desk guest from a directory person, or null (no counting pass). Everything staff may see; guestView() cuts it
 * down for volunteers. `keyOf`: ticket ID → key; `sessionsOf`: person → their agenda sessions (speakers).
 */
export function deskGuestFrom(p, { keyOf = (id) => guestKey(id), sessionsOf = () => [] } = {}) {
  const passes = countingPasses(p);
  if (!passes.length) return null;
  const main = mainPass(passes);
  const { extras, extrasView: extrasViewOut } = guestExtras(passes, main);
  const collected = collectedOf(passes);
  const marks = marksOf(p, main);
  const { tier, passName } = deskTier(main.type);
  const booth = marks.exhibitor ? boothOf(passes, main) : "";
  return {
    key: keyOf(main.ticketId),
    keys: passes.map((t) => keyOf(t.ticketId)),
    name: str(p.name) || "No name",
    firstName: str(p.firstName),
    lastName: str(p.lastName),
    company: str(p.company),
    title: str(p.jobTitle),
    tier,
    passName,
    marks,
    extras,
    passCollectedAt: collected === true ? null : collected,
    passCollected: !!collected,
    pending: passes.every((t) => t.status === "pending"),
    rsvp: rsvpOf(p),
    booth,
    boothKey: booth ? boothKey(booth) : "",
    sessions: marks.speaker ? sessionsOf(p) : [],
    // Staff only (guestView drops them for volunteers):
    personId: p.id,
    email: str(p.email),
    ticketId: main.ticketId,
    ticketIds: passes.map((t) => t.ticketId),
    extrasView: extrasViewOut,
    // Each counting pass's own switches, when they hold more than one (the inclusions editor can point at the right one).
    passExtras: passes.length > 1 ? passes.map((t) => ({ ticketId: t.ticketId, passName: deskTier(t.type, { log: { warn() {} } }).passName, extrasView: passView(t) })) : [],
    // Server only:
    norm: normalizeTicketId(main.ticketId),
    norms: passes.map((t) => normalizeTicketId(t.ticketId)),
  };
}

/* ---------- ISSUE PASS: on the list, no pass on file (contract C7) ---------- */

export const NO_PASS_LABEL = "No pass on file";
const isBoothId = (id) => /^BOOTH-/i.test(String(id || ""));
const NO_EXTRAS = Object.freeze(Object.fromEntries(EXTRA_KEYS.map((k) => [k, false])));

/**
 * Is this directory person on the list with no pass on file (the organiser, Oct 23: "If their pass isn't found but
 * name is there, mark it as issue pass")? A speaker (the speaker type: the website's speaker list, an account's type)
 * with no Speaker Pass row, or someone marked Media or Exhibitor, who holds no pass at all. Anyone with a pass row
 * that doesn't count (hidden by staff, refunded) stays out, as on the Event summary, also when the directory left that
 * hidden pass out (an unclaimed one: services/people.js `hiddenPasses`); so does everyone else without a pass
 * (staff, RSVPs). A booth order isn't a pass (an exhibitor with only a booth is in).
 */
export function noPassPerson(p) {
  if (!p) return false;
  if ((p.passList || []).some((t) => !isBoothId(t.ticketId))) return false;
  if ((p.hiddenPasses || []).some((id) => !isBoothId(id))) return false;
  const types = new Set(p.types || []);
  return types.has("speaker") || types.has("media") || types.has("exhibitor");
}

/**
 * A desk guest for an ISSUE PASS person (noPassPerson), or null: { key "n…", noPass: true, tier: null, passName: null,
 * marks, band, no inclusions, … } with the same fields as a pass holder's row. Marked Arrived in the lobby and
 * Checked in at the pass desk ("pass issued at the desk": the mark only, there's no ticket to collect).
 */
export function deskNoPassFrom(p, { sessionsOf = () => [] } = {}) {
  if (!noPassPerson(p)) return null;
  const subject = personSubject(p.id);
  const key = personKey(subject);
  const marks = marksOf(p, null);
  const noView = { override: null, auto: false, included: false, ticketId: "" };
  return {
    key,
    keys: [key],
    name: str(p.name) || "No name",
    firstName: str(p.firstName),
    lastName: str(p.lastName),
    company: str(p.company),
    title: str(p.jobTitle),
    tier: null,
    passName: null,
    noPass: true,
    marks,
    // The People band (services/checkinCard.js personBand): Speaker red, Media dark blue, VIP gold; "No pass on file".
    band: personBand({ vip: !!p.vip, types: p.types || [], passes: [], passName: NO_PASS_LABEL }),
    extras: { ...NO_EXTRAS },
    passCollectedAt: null,
    passCollected: false,
    pending: false,
    rsvp: rsvpOf(p),
    booth: "",
    boothKey: "",
    sessions: marks.speaker ? sessionsOf(p) : [],
    personId: p.id,
    email: str(p.email),
    ticketId: "",
    ticketIds: [],
    extrasView: Object.fromEntries(EXTRA_KEYS.map((k) => [k, { ...noView }])),
    passExtras: [],
    norm: subject,
    norms: [subject],
  };
}

/** The desk's row for a directory person: a pass holder's (deskGuestFrom), else an ISSUE PASS one (deskNoPassFrom), else null. */
export const deskRowFrom = (p, opts = {}) => deskGuestFrom(p, opts) || deskNoPassFrom(p, opts);

const PERSON_ALIAS = /^[uasr]-/;

/** Every id a directory person goes by that can be an ISSUE PASS subject (services/people.js buildPeople's aliases:
    their own id, u-<account>, a-<pass record>, s-<speaker>, r-<RSVP>; never t-<ticket>). */
export function personAliasIds(p) {
  if (!p) return [];
  const ids = [p.id];
  if (p.user?._id) ids.push(`u-${p.user._id}`);
  for (const a of p.attendees || []) if (a?._id) ids.push(`a-${a._id}`);
  if (p.speaker?._id) ids.push(`s-${p.speaker._id}`);
  for (const r of [...(p.rsvps || []), ...(p.dupRsvps || [])]) if (r?._id) ids.push(`r-${r._id}`);
  return [...new Set(ids.map((id) => String(id || "")).filter((id) => PERSON_ALIAS.test(id)))];
}

/** Every guest, by name, and the lookups the routes need: key → { guest, norm, subjects } (every counting pass), norm
    → guest, and the booths (exhibitor desk): [{ key, booth, companies, guests: [key] }] by booth. ISSUE PASS people
    (contract C7) are guests too. `aliases`: the directory's id → person map (routes/people.js byId): every person id
    a guest goes by also resolves ("n" keys of their u- / a- / s- / r- ids), so marks made on an ISSUE PASS row still
    find the person once a pass is given (a tap on such a key is recorded on their main pass when they hold one).
    `subjects` (also `subjectsOf`: guest → the same list): every subject the guest's marks can be under, their passes
    and those "person:<id>" ids, for staff's reset and history. `aliasKeysOf`: guest → the "n" keys of those ids. */
export function buildDeskIndex(people = [], { keyOf = (id) => guestKey(id), sessionsOf = () => [], aliases = null } = {}) {
  const guests = [];
  const byKey = new Map();
  const byNorm = new Map();
  const byPerson = new Map();
  const subjectsOf = new Map();
  const aliasKeysOf = new Map();
  for (const p of people || []) {
    const g = deskRowFrom(p, { keyOf, sessionsOf });
    if (!g) continue;
    guests.push(g);
    byPerson.set(p, g);
    const subjects = [...g.norms];
    subjectsOf.set(g, subjects);
    g.keys.forEach((k, i) => { byKey.set(k, { guest: g, norm: g.norms[i], subjects }); byNorm.set(g.norms[i], g); });
  }
  for (const [id, p] of aliases instanceof Map ? aliases : []) {
    const g = byPerson.get(p);
    if (!g || !PERSON_ALIAS.test(id)) continue;
    const subject = personSubject(id);
    const k = personKey(subject);
    const have = byKey.get(k);
    if (have && have.guest !== g) continue;
    const subjects = subjectsOf.get(g);
    if (!subjects.includes(subject)) subjects.push(subject);
    if (have) continue;
    byKey.set(k, { guest: g, norm: g.noPass ? subject : g.norm, alias: subject, subjects });
    if (g.noPass) byNorm.set(subject, g);
    if (!aliasKeysOf.has(g)) aliasKeysOf.set(g, []);
    aliasKeysOf.get(g).push(k);
  }
  guests.sort((a, b) => fold(a.name).localeCompare(fold(b.name)));
  const boothList = boothsOf(guests);
  return { guests, byKey, byNorm, subjectsOf, aliasKeysOf, booths: boothList, boothByKey: new Map(boothList.map((b) => [b.key, b])) };
}

/** The exhibitor desk's booths from guest rows: [{ key, booth, companies, guests: [key] }] by booth. */
export function boothsOf(guests = []) {
  const booths = new Map();
  for (const g of guests || []) {
    if (!g?.boothKey) continue;
    const b = booths.get(g.boothKey) || { key: g.boothKey, booth: String(g.booth).toUpperCase(), companies: [], guests: [] };
    if (g.company && !b.companies.includes(g.company)) b.companies.push(g.company);
    b.guests.push(g.key);
    booths.set(g.boothKey, b);
  }
  return [...booths.values()].sort((a, b) => a.booth.localeCompare(b.booth, "en", { numeric: true }));
}

const VOLUNTEER_FIELDS = ["key", "keys", "name", "firstName", "lastName", "company", "title", "tier", "passName", "noPass", "band", "marks", "extras",
  "passCollectedAt", "passCollected", "pending", "rsvp", "booth", "boothKey", "sessions"];
const STAFF_FIELDS = [...VOLUNTEER_FIELDS, "personId", "email", "ticketId", "ticketIds", "extrasView", "passExtras"];

/** What a device gets about a guest: volunteers name, job, company, pass, marks, inclusions, RSVP'd meals and dietary
    needs (the meal stations), booth, sessions (never an email, phone or ticket ID); staff also the email (to check who
    someone is), the ticket IDs and the inclusions' switches. */
export function guestView(g, { staff = false } = {}) {
  const out = {};
  for (const k of staff ? STAFF_FIELDS : VOLUNTEER_FIELDS) if (g[k] !== undefined) out[k] = g[k];
  return out;
}

/* ---------- Speakers' sessions (AV station) ---------- */

const DEFAULT_ROOM = "Main Stage, Harbour Ballroom";
const dayOfSession = (d) => {
  const s = String(d ?? "").trim().toLowerCase();
  if (s === "1" || s === "day1" || s === "day 1" || s === "2026-10-26") return "day1";
  if (s === "2" || s === "day2" || s === "day 2" || s === "2026-10-27") return "day2";
  return "";
};

/* Matching a speaker's names to the names the agenda prints. The agenda's session speakers are inline { name, org }
   objects (no speaker ids), so names it is: case, accents, punctuation and hyphens, honorifics and ranks ("Dr.",
   "Hon.", "Prof.", "BGen"), post-nominals, middle names and initials, bracketed or quoted nicknames ("Heling (Alex)
   Pu"), everyday first-name forms ("Chris" / "Christopher", "Vic" / "Victor"), a one-letter slip in a long last name
   ("Fedelli" / "Fedeli"), and a last name on its own ("Prof. Aspuru-Guzik"). */
const RANK_WORDS = new Set(["bgen", "mgen", "lgen", "brig", "brigadier", "general", "lcol", "ltcol", "cdr", "cmdr", "commander", "adm",
  "admiral", "vadm", "radm", "cmdre", "commodore", "sgt", "cpl", "insp", "supt", "honourable", "honorable", "hon", "dr", "prof"]);
const foldWord = (w) => String(w || "").normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
/** Ranks and titles the RSVP matcher doesn't know, off the front: "BGen Jane Roe" → "Jane Roe". */
function withoutRanks(name) {
  const words = String(name || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  while (words.length > 1 && RANK_WORDS.has(foldWord(words[0]))) words.shift();
  return words.join(" ");
}
const NICK_GROUPS = [
  ["christopher", "chris", "kit"], ["christian", "chris"], ["christine", "christina", "chris", "tina"], ["michael", "mike", "mick"],
  ["robert", "rob", "bob", "bobby", "robbie"], ["william", "will", "bill", "billy", "liam"], ["james", "jim", "jimmy", "jamie"], ["david", "dave"],
  ["daniel", "dan", "danny"], ["thomas", "tom", "tommy"], ["anthony", "tony"], ["alexander", "alex", "sandy"], ["alexandra", "alex", "sandra"],
  ["samuel", "sam"], ["samantha", "sam"], ["benjamin", "ben"], ["nicholas", "nick", "nico"], ["matthew", "matt"], ["steven", "steve"],
  ["stephen", "steve"], ["joseph", "joe", "joey"], ["katherine", "kate", "kathy", "katie"], ["catherine", "cathy", "kate", "katie"],
  ["elizabeth", "liz", "beth", "betty", "eliza"], ["jennifer", "jen", "jenny"], ["andrew", "andy", "drew"], ["gregory", "greg"],
  ["jeffrey", "jeff"], ["patrick", "pat"], ["patricia", "pat", "patty", "trish"], ["richard", "rick", "rich", "dick"], ["edward", "ed", "eddie", "ted"],
  ["victor", "vic"], ["ronald", "ron"], ["donald", "don"], ["kenneth", "ken"], ["jonathan", "jon"], ["joshua", "josh"], ["zachary", "zach"],
  ["frederick", "fred"], ["lawrence", "larry"], ["timothy", "tim"], ["peter", "pete"], ["philip", "phil"], ["phillip", "phil"], ["raymond", "ray"],
  ["gerald", "gerry"], ["margaret", "maggie", "meg", "peggy"], ["deborah", "deb", "debbie"], ["susan", "sue"], ["rebecca", "becky", "becca"],
  ["victoria", "vicky", "tori"], ["nathaniel", "nate", "nat"], ["nathan", "nate"], ["vincent", "vince"], ["douglas", "doug"],
  ["charles", "charlie", "chuck"], ["henry", "hank", "harry"], ["harold", "harry"], ["abigail", "abby"], ["pamela", "pam"], ["kimberly", "kim"],
  ["jacqueline", "jackie"], ["theodore", "theo", "ted"], ["leonard", "leo", "len"], ["gabriel", "gabe"], ["john", "jack", "johnny"],
  ["mohammed", "mohammad", "muhammad", "mohamed"],
];
const NICKS = new Map();
NICK_GROUPS.forEach((g, i) => { for (const w of g) { if (!NICKS.has(w)) NICKS.set(w, new Set()); NICKS.get(w).add(i); } });
const sameFirst = (a, b) => a === b || [...(NICKS.get(a) || [])].some((i) => NICKS.get(b)?.has(i));
/** Two words one edit apart (a slip in a long last name: "fedelli" / "fedeli"). */
function oneEditApart(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}
/** A name as matching needs it: its word forms (nameVariants: nicknames in brackets / quotes) and its first / last split. */
function nameForms(raw) {
  const name = withoutRanks(raw);
  const variants = nameVariants(name).filter((w) => w.length);
  return { name, variants, split: splitName(String(name).replace(/\([^)]*\)|["“”][^"“”]*["“”]/g, " ")) };
}
/** Does an agenda name name this person (one of their names)? */
export function speakerNameMatches(agendaName, personName) {
  const a = typeof agendaName === "string" ? nameForms(agendaName) : agendaName;
  const b = typeof personName === "string" ? nameForms(personName) : personName;
  if (!a.variants.length || !b.variants.length) return false;
  for (const x of a.variants) {
    for (const y of b.variants) {
      if (x.join(" ") === y.join(" ")) return true;
      if (x.length >= 2 && y.length >= 2) {
        const [xf, xl, yf, yl] = [x[0], x[x.length - 1], y[0], y[y.length - 1]];
        // Middle names and initials don't matter; first names may be the everyday form.
        if (xl === yl && sameFirst(xf, yf)) return true;
        if (sameFirst(xf, yf) && xl.length >= 5 && yl.length >= 5 && oneEditApart(xl, yl)) return true;
      }
      // Only a last name on the agenda (or on their record).
      if (x.length === 1 && y.length >= 2 && x[0].length >= 4 && x[0] === y[y.length - 1]) return true;
      if (y.length === 1 && x.length >= 2 && y[0].length >= 4 && y[0] === x[x.length - 1]) return true;
    }
  }
  // Hyphens and spaces in first or last names ("Jo-Anne" / "Jo Anne").
  return (!!b.split.lastName && fullNameMatches(a.name, b.split.firstName, b.split.lastName))
    || (!!a.split.lastName && fullNameMatches(b.name, a.split.firstName, a.split.lastName));
}

/**
 * The agenda (Sanity sessions: their speakers' and moderator's names) → a lookup for the AV station:
 * person → [{ day, start, end, title, room }] by day and time. A person's sessions are the ones whose speaker or
 * moderator names them (speakerNameMatches) under any of their names: the website speaker profile linked to them
 * (p.speaker.name, usually spelled as the agenda spells it), their name, their first + last name. Breaks (meals,
 * the evening) aren't sessions.
 */
export function sessionsIndex(sessions = []) {
  const entries = [];
  const byKey = new Map();
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (s?.isBreak) continue;
    const day = dayOfSession(s?.day);
    const start = String(s?.time || "").slice(0, 5);
    if (!day || !isHHMM(start)) continue;
    const end = isHHMM(String(s?.endTime || "").slice(0, 5)) ? String(s.endTime).slice(0, 5) : "";
    const row = { day, start, end, title: line(s.title, 140) || "Session", room: line(s.stage, 60) || DEFAULT_ROOM };
    for (const sp of [...(Array.isArray(s.speakers) ? s.speakers : []), s.moderator].filter(Boolean)) {
      const name = str(sp?.name);
      if (!name) continue;
      const key = personNameKey(withoutRanks(name), "");
      if (!byKey.has(key)) { const e = { forms: nameForms(name), rows: [] }; byKey.set(key, e); entries.push(e); }
      byKey.get(key).rows.push(row);
    }
  }
  const sort = (list) => [...new Map(list.map((r) => [`${r.day} ${r.start} ${r.title}`, r])).values()]
    .sort((a, b) => a.day.localeCompare(b.day) || toMin(a.start) - toMin(b.start));
  return (p) => {
    const names = [...new Set([p?.speaker?.name, p?.name, [p?.firstName, p?.lastName].filter(Boolean).join(" ")].map(str).filter(Boolean))];
    if (!names.length || !entries.length) return [];
    const forms = names.map(nameForms);
    const list = [];
    for (const e of entries) if (forms.some((f) => speakerNameMatches(e.forms, f))) list.push(...e.rows);
    return sort(list).slice(0, 8);
  };
}

/* ---------- Marks and events on the wire ---------- */

const who = (id, name) => (id || name ? { id: id ? String(id) : "", name: str(name) } : null);

/** A CheckinMark row as devices get it (keyed by the pass's key, never its ticket ID). at null = cleared. */
export function markView(doc, { keyOf = (id) => guestKey(id) } = {}) {
  if (!doc) return null;
  const set = Number.isFinite(ms(doc.at));
  return {
    key: keyOfSubject(doc.subject, keyOf),
    day: doc.day,
    point: doc.point,
    rev: Number(doc.rev) || 0,
    at: set ? iso(doc.at) : null,
    by: set ? who(doc.byId, doc.byName) : null,
    station: set ? doc.station || "" : "",
    override: set ? doc.override || "" : "",
    note: set ? str(doc.note) : "",
    // The device id of the tap that set it (random, made on the iPad): lets a device undo its own tap before the server answers.
    ref: set ? str(doc.ref) : "",
    ...(set && doc.override ? { overrideReason: OVERRIDE_REASONS[doc.override] || doc.override } : {}),
    // A practice mark (a day that isn't Day 1 or Day 2, contract C6): never the ticket's pass collection.
    ...(set && doc.practice ? { practice: true } : {}),
    // Tapped offline by `by`, sent later from someone else's sign-in (`recordedBy`, contract C3).
    ...(set && doc.queuedOffline ? { queuedOffline: true, recordedBy: who(doc.recordedById, doc.recordedByName) } : {}),
    ...(set && doc.lateSync ? { lateSync: true } : {}),
  };
}

/** A media query as devices get it. */
export function queryView(q) {
  if (!q) return null;
  return {
    id: String(q._id),
    rev: Number(q.rev) || 0,
    who: str(q.who),
    outlet: str(q.outlet),
    request: str(q.request),
    key: q.subject ? keyOfSubject(q.subject) : "",
    status: q.status,
    assignee: q.assigneeId || q.assigneeName ? { id: q.assigneeId ? String(q.assigneeId) : "", name: str(q.assigneeName) } : null,
    createdBy: { id: q.createdById ? String(q.createdById) : "", name: str(q.createdByName) },
    createdAt: iso(q.createdAt),
    updatedAt: iso(q.updatedAt),
    doneAt: iso(q.doneAt),
  };
}

/** An event as devices get it. `pass`: the pass-collected state of its ticket after it ({ key, collected, collectedAt }). */
export function eventView(ev, { keyOf = (id) => guestKey(id), staff = false } = {}) {
  if (!ev) return null;
  const out = {
    seq: ev.seq,
    kind: ev.kind,
    point: ev.point || "",
    key: ev.subject ? keyOfSubject(ev.subject, keyOf) : "",
    day: ev.day || "",
    at: iso(ev.at),
    station: ev.station || "",
    by: { id: ev.byId ? String(ev.byId) : "", name: str(ev.byName), role: ev.byRole || "" },
    clientId: ev.clientId || "",
  };
  if (ev.ref) { out.ref = ev.ref; out.target = ev.ref; }
  if (ev.refPoint) out.refPoint = ev.refPoint;
  if (ev.override) { out.override = ev.override; out.overrideReason = OVERRIDE_REASONS[ev.override] || ev.override; }
  if (ev.tombstone) out.tombstone = true;
  if (ev.practice) out.practice = true;
  if (ev.lateSync) out.lateSync = true;
  if (ev.queuedOffline) { out.queuedOffline = true; out.recordedBy = who(ev.recordedById, ev.recordedByName); }
  if (ev.kind === "note") out.note = str(ev.note);
  if (Array.isArray(ev.marks) && ev.marks.length) out.marks = ev.marks.map((m) => markView(m, { keyOf }));
  if (ev.pass) out.pass = { key: keyOf(ev.pass.ticketId || ev.subject), collected: !!ev.pass.collected, collectedAt: iso(ev.pass.collectedAt) };
  if (ev.extras) out.extras = Object.fromEntries(EXTRA_KEYS.map((k) => [k, !!ev.extras[k]]));
  if (staff && ev.extrasView) out.extrasView = ev.extrasView;
  // A guest or inclusions event carries the guest's row as it is after the change (the directory rebuilt where the
  // change was made), so a device can update it without a reload, and a snapshot from any instance can use it.
  if (ev.guest && typeof ev.guest === "object") out.guest = guestView(ev.guest, { staff });
  if (ev.query) out.query = queryView(ev.query);
  // NO DETAILS FOUND (contract C8): the arrival as typed (`at` = when it was tapped), how the pass desk closed it.
  if (ev.kind === "unknown_arrival") {
    Object.assign(out, { name: str(ev.name), company: str(ev.company), note: str(ev.note), byName: str(ev.byName) });
    if (ev.arrivedAt) out.at = iso(ev.arrivedAt);
  }
  if (ev.kind === "unknown_done") Object.assign(out, { outcome: ev.outcome || "", byName: str(ev.byName) });
  if (ev.kind === "unknown_link") Object.assign(out, { guestKey: ev.guestKey || "", byName: str(ev.byName) });
  if (ev.kind === "undo" && String(ev.subject || "").startsWith("u:")) out.byName = str(ev.byName);
  return out;
}

/**
 * A day's NO DETAILS FOUND cards for a snapshot (contract C8), from their unknown_arrival events and the events after
 * them on the same key (undo / unknown_done / unknown_link: the newest wins, as on the devices). Undone ones are left
 * out. → [{ key, clientId, name, company, note, at (when it was tapped), day, byName, station, status: "open" |
 * <outcome> | "linked", outcome, doneAt, doneBy, guestKey }], oldest first.
 */
export function unknownRows(arrivals = [], after = []) {
  const rows = new Map();
  for (const e of [...arrivals].sort((a, b) => a.seq - b.seq)) {
    if (!e?.clientId || e.kind !== "unknown_arrival") continue;
    const key = unknownKeyOf(e.clientId);
    rows.set(key, {
      seq: e.seq, key, clientId: e.clientId, name: str(e.name), company: str(e.company), note: str(e.note), at: iso(e.arrivedAt || e.at), day: e.day || "",
      byName: str(e.byName), station: e.station || "lobby", status: "open", outcome: "", doneAt: null, doneBy: "", guestKey: "",
      ...(e.practice ? { practice: true } : {}),
    });
  }
  for (const e of [...after].sort((a, b) => a.seq - b.seq)) {
    const u = rows.get(e?.subject);
    if (!u || !(e.seq > u.seq)) continue;
    if (e.kind === "undo") { u.status = "undone"; continue; }
    if (e.kind !== "unknown_done" && e.kind !== "unknown_link") continue;
    u.status = e.kind === "unknown_link" ? "linked" : e.outcome || "done";
    if (e.kind === "unknown_done") u.outcome = e.outcome || "";
    else u.guestKey = e.guestKey || "";
    u.doneAt = iso(e.at);
    u.doneBy = str(e.byName);
  }
  return [...rows.values()].filter((u) => u.status !== "undone").map(({ seq, ...u }) => u);
}

/**
 * How far a reader can safely move its cursor after reading `events` (sorted by seq, all > since): up to the last
 * sequence number with none missing before it. A missing number is a write still in flight (numbers are handed out
 * just before the event is saved), unless this reader first saw it missing more than `holeMs` ago (`firstSeen(seq)`
 * → ms, on `seenNow`'s clock), or the event after it is older than `ancientMs` (on `now`'s clock, the events' own):
 * then that write failed and the cursor moves past it. Without `firstSeen`, the gap counts from the next event's
 * `at` (a pure caller with no memory). Events after a gap are still delivered (devices skip ones they've seen); the
 * cursor just stays before the gap, so the next read asks again from there.
 */
export function safeCursor(events = [], since = 0, {
  now = Date.now(), holeMs = HOLE_MS, ancientMs = HOLE_ANCIENT_MS, firstSeen = null, seenNow = Date.now(),
} = {}) {
  let cursor = Number(since) || 0;
  for (const ev of events) {
    const seq = Number(ev.seq);
    if (!(seq > cursor)) continue;
    if (seq === cursor + 1) { cursor = seq; continue; }
    // A gap before this one: still being written, unless it has been missing too long (or the next event is ancient).
    const age = now - ms(ev.at);
    let missingFor = age;
    // (A gap of more than 100 numbers isn't writes in flight: judged by the next event's age.)
    if (firstSeen && seq - cursor - 1 <= 100) {
      missingFor = Infinity;
      for (let k = cursor + 1; k < seq; k++) missingFor = Math.min(missingFor, seenNow - firstSeen(k));
    }
    if (missingFor > holeMs || age > ancientMs) { cursor = seq; continue; }
    break;
  }
  return cursor;
}

/* ---------- Actions from the app ---------- */

const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
const OBJECT_ID = /^[0-9a-f]{24}$/;
const bad = (error, field) => ({ ok: false, error, field });

/**
 * One action as the app sends it → { ok: true, value } | { ok: false, error, field }:
 *   clientId  made on the device (8–64 letters, digits, _ -): the same tap sent twice is done once
 *   kind      mark | undo | reset | note | query_add | query_update | unknown_arrival | unknown_done | unknown_link
 *   station   the station it was made at (lobby, desk, breakfast, lunch, evening, media, av, exhibitor)
 *   clientAt  when it was tapped, on the device's server-corrected clock (ISO; contract C4: clamped and judged there)
 *   queuedBy  { id, name }: who made the tap, when it was made offline and is sent from someone else's sign-in (C3)
 *   mark:   key (a guest's pass, or a booth for point "booth"), point, override (true: "Admit anyway" after the
 *           outside-the-window warning), notIncluded (true: staff's "Admit anyway (override)" at a meal door for a
 *           guest whose passes don't include today's item, contract C11), note (AV: "slides on USB", ≤ 80)
 *   undo:   target (the clientId of the tap to undo; `ref`, the older name, works too): contract C2
 *   reset:  key, point (staff: clears it; clearing "arrived" also clears "checked_in")
 *   note:   key, note (staff: the desk note, ≤ 140; "" clears it)
 *   query_add:    who, outlet, request, key? (a media guest)
 *   query_update: id, status? (new | in_progress | done), assignee? ("me", a user id, or null)
 *   unknown_arrival: name (as typed, 1–80), company? (≤ 80), note? (≤ 200): NO DETAILS FOUND (contract C8)
 *   unknown_done:    target ("u:<clientId of the arrival>"), outcome (sent_to_help | pass_issued | left)
 *   unknown_link:    target, guestKey (staff: "Found them": that guest is marked arrived, the card closes)
 */
export function cleanAction(raw) {
  const a = raw && typeof raw === "object" ? raw : {};
  const clientId = str(a.clientId);
  if (!CLIENT_ID.test(clientId)) return bad("Missing or bad clientId.", "clientId");
  const kind = str(a.kind);
  if (!ACTION_KINDS.includes(kind)) return bad("Unknown action.", "kind");
  const station = str(a.station);
  if (!STATION_KEYS.includes(station)) return bad("Unknown station.", "station");
  const value = { clientId, kind, station, clientAt: null };
  const at = ms(a.clientAt);
  if (Number.isFinite(at)) value.clientAt = new Date(at);
  // Tapped offline by someone else (contract C3): { id, name } of who made the tap.
  if (a.queuedBy !== undefined && a.queuedBy !== null) {
    const q = a.queuedBy;
    const id = str(q?.id);
    if (typeof q !== "object" || (id && !OBJECT_ID.test(id))) return bad("queuedBy must be { id, name }.", "queuedBy");
    const name = line(q.name, 80);
    if (id || name) value.queuedBy = { id, name };
  }

  if (kind === "undo") {
    // Undo by reference (contract C2): `target` = the clientId of the tap to undo (`ref`, the older name, still works).
    const ref = str(a.target ?? a.ref);
    if (!CLIENT_ID.test(ref)) return bad("What to undo is missing.", "ref");
    if (ref === clientId) return bad("An undo can't undo itself.", "ref");
    value.ref = ref;
    return { ok: true, value };
  }
  if (kind === "unknown_arrival") {
    for (const f of ["name", "company", "note"]) {
      if (a[f] !== undefined && a[f] !== null && typeof a[f] !== "string") return bad(`The ${f} must be text.`, f);
      const v = line(a[f], UNKNOWN_LIMITS[f] + 1);
      if (v.length > UNKNOWN_LIMITS[f]) return bad(`${f === "name" ? "The name" : f === "company" ? "The company" : "The note"} is ${UNKNOWN_LIMITS[f]} characters at most.`, f);
      value[f] = v;
    }
    if (!value.name) return bad("Type their name as they said it.", "name");
    return { ok: true, value };
  }
  if (kind === "unknown_done" || kind === "unknown_link") {
    const target = str(a.target);
    if (!isUnknownKey(target)) return bad("Which arrival is missing.", "target");
    value.target = target;
    if (kind === "unknown_done") {
      const outcome = str(a.outcome);
      if (!UNKNOWN_OUTCOMES.includes(outcome)) return bad("Outcome must be sent_to_help, pass_issued or left.", "outcome");
      value.outcome = outcome;
    } else {
      const guestKeyIn = str(a.guestKey);
      if (!isGuestKey(guestKeyIn)) return bad("Pick the guest.", "guestKey");
      value.guestKey = guestKeyIn;
    }
    return { ok: true, value };
  }
  if (kind === "query_add") {
    const request = line(a.request, QUERY_LIMITS.request + 1);
    if (!request) return bad("Say what they're asking for.", "request");
    if (request.length > QUERY_LIMITS.request) return bad(`The request is ${QUERY_LIMITS.request} characters at most.`, "request");
    value.who = line(a.who, QUERY_LIMITS.who);
    value.outlet = line(a.outlet, QUERY_LIMITS.outlet);
    value.request = request;
    const key = str(a.key);
    if (key && !isGuestKey(key)) return bad("Unknown guest.", "key");
    value.key = key;
    if (!value.who && !value.key) return bad("Say who's asking.", "who");
    return { ok: true, value };
  }
  if (kind === "query_update") {
    const id = str(a.id);
    if (!OBJECT_ID.test(id)) return bad("Unknown query.", "id");
    value.id = id;
    if (a.status !== undefined) {
      if (!QUERY_STATUSES.includes(str(a.status))) return bad("Status must be new, in_progress or done.", "status");
      value.status = str(a.status);
    }
    if (a.assignee !== undefined) {
      if (a.assignee === null || a.assignee === "") value.assignee = null;
      else if (a.assignee === "me") value.assignee = "me";
      else if (OBJECT_ID.test(str(a.assignee))) value.assignee = str(a.assignee);
      else return bad("Unknown assignee.", "assignee");
    }
    if (value.status === undefined && value.assignee === undefined) return bad("Nothing to change.", "status");
    return { ok: true, value };
  }

  const key = str(a.key);
  if (kind === "mark" || kind === "reset") {
    const point = str(a.point);
    if (!POINT_KEYS.includes(point)) return bad("Unknown point.", "point");
    if (point === "booth" ? !isBoothKey(key) : !isGuestKey(key)) return bad("Missing guest.", "key");
    value.point = point;
    value.key = key;
    if (kind === "mark") {
      value.override = a.override === true;
      // Contract C11: staff admit a guest at a meal door though today's item isn't on their pass.
      if (a.notIncluded === true) value.notIncluded = true;
      if (a.note !== undefined && a.note !== null) {
        if (typeof a.note !== "string") return bad("The note must be text.", "note");
        const note = line(a.note, AV_NOTE_MAX + 1);
        if (note.length > AV_NOTE_MAX) return bad(`Notes are ${AV_NOTE_MAX} characters at most.`, "note");
        value.note = note;
      }
    }
    return { ok: true, value };
  }
  // note
  if (!isGuestKey(key)) return bad("Missing guest.", "key");
  value.key = key;
  if (typeof a.note !== "string") return bad("The note must be text.", "note");
  const note = a.note.replace(/\s+/g, " ").trim();
  if (note.length > NOTE_MAX) return bad(`Notes are ${NOTE_MAX} characters at most.`, "note");
  value.note = note;
  return { ok: true, value };
}

/** When a tap counts as made: its clientAt (the device's server-corrected clock) clamped to [now − 12 h, now + 2 min];
    none → now. */
export function tapTime(clientAt, now = new Date()) {
  return tapClock(clientAt, now).at;
}
/** tapTime, and whether it is a late sync (made more than LATE_SYNC_MS before it reached the server) or was clamped.
    → { at: Date, late, clamped } */
export function tapClock(clientAt, now = new Date()) {
  const t = ms(clientAt);
  const n = ms(now);
  if (!Number.isFinite(t)) return { at: new Date(n), late: false, clamped: false };
  const at = Math.min(n + CLIENT_AT_MAX_AHEAD_MS, Math.max(n - CLIENT_AT_MAX_AGE_MS, t));
  return { at: new Date(at), late: n - at > LATE_SYNC_MS, clamped: at !== t };
}

/**
 * May this person undo `target` (an event)? Staff: any mark. Volunteers: their own, within the undo window on their
 * device's clock (both taps carry clientAt; else the server's), and never long after the server stored it; their own
 * practice mark (a day that isn't Day 1 / Day 2, contract C6) at any time.
 *   signedInId: the sign-in that sent the undo, when it was queued offline by someone else (`actorId`, contract C3):
 *   then (not staff) only a tap that was itself sent from that sign-in (the same offline queue), so naming someone in
 *   queuedBy never undoes their taps from another sign-in.
 * → { ok: true } | { ok: false, error, status }
 */
export function canUndo({ target, actorId = "", staff = false, undoClientAt = null, now = new Date(), signedInId = "" } = {}) {
  if (!target) return { ok: false, status: 404, error: "Nothing to undo: that tap never reached the server." };
  if (!UNDOABLE_KINDS.includes(target.kind)) return { ok: false, status: 400, error: "Only check-in taps can be undone." };
  if (staff) return { ok: true };
  const own = { ok: false, status: 403, error: "You can only undo your own taps. Ask a staff member." };
  if (String(target.byId || "") !== String(actorId || "")) return own;
  if (signedInId && String(target.recordedById || target.byId || "") !== String(signedInId)) return own;
  if (target.practice) return { ok: true };
  const served = ms(now) - ms(target.at);
  if (!(served <= UNDO_SERVER_MAX_MS)) return { ok: false, status: 409, error: "Too late to undo. Ask a staff member." };
  const a = ms(target.clientAt);
  const b = ms(undoClientAt);
  const gap = Number.isFinite(a) && Number.isFinite(b) ? b - a : served;
  if (!(gap <= UNDO_GRACE_MS)) return { ok: false, status: 409, error: "Too late to undo. Ask a staff member." };
  return { ok: true };
}

/**
 * Is this guest entitled to today's meal / evening item at a meal station? → { item, included, rsvpd }
 * (item null: not a meal station, or not an event day). Included = an extra any of their counting passes includes
 * (guest.extras: guestExtras, the Event summary's rule; services/passExtras.js, staff's switch first); RSVP'd = the
 * option is on their RSVP.
 */
export function entitlement(guest, station, eventDay) {
  const item = mealItem(station, eventDay);
  if (!item) return { item: null, included: null, rsvpd: null };
  return { item, included: !!guest?.extras?.[item.extra], rsvpd: !!guest?.rsvp?.options?.includes(item.key) };
}

/** The meal station a point admits to (cxo → breakfast …), or "". */
export const mealStationOf = (point) => MEAL_POINTS[point] || "";

/** Which stations an arrival in the lobby notifies: every arrival the pass desk; speakers also AV, exhibitors also the
    exhibitor desk, media also the media desk. */
export function notifyStations(guest) {
  const m = guest?.marks || {};
  return ["desk", ...(m.speaker ? ["av"] : []), ...(m.exhibitor ? ["exhibitor"] : []), ...(m.media ? ["media"] : [])];
}

/** The audit line for an action that's audited (overrides, staff powers): "Priya Sharma · Power Pass: …". */
export function auditLine({ guest = null, booth = null, kind, point = "", to = "", note = "", station = "", override = "", item = null } = {}) {
  const whoTxt = booth ? `Booth ${booth.booth}` : guest ? `${guest.name} · ${guest.passName}` : "Unknown guest";
  const where = STATION_LABELS[station] ? ` (${STATION_LABELS[station]})` : "";
  const what = item ? `${POINT_LABELS[point]} to ${item.label}` : POINT_LABELS[point] || point;
  if (kind === "reset") return `${whoTxt}: cleared ${what}${where}`;
  if (kind === "note") return `${whoTxt}: desk note ${note ? `“${note}”` : "cleared"}${where}`;
  if (kind === "undo") return `${whoTxt}: undid ${what}${where}`;
  if (String(override).endsWith("not_included")) {
    const hours = override === "not_included" ? "" : override.startsWith("late_sync") ? ", outside its hours (late sync from an offline device)" : ", outside its hours";
    return `${whoTxt}: ${what} though it isn't on their pass${hours} (staff override)${where}`;
  }
  if (override === "late_sync") return `${whoTxt}: ${what} outside its hours (late sync from an offline device)${where}`;
  if (override) return `${whoTxt}: ${what} outside its hours (override)${where}`;
  return `${whoTxt}: ${what}${to ? ` ${to}` : ""}${where}`;
}

export const ALL_STATIONS = Object.freeze([...STATION_KEYS, ...OTHER_STATIONS]);
