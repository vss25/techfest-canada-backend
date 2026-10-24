import CheckinEvent, { CheckinCounter } from "../models/CheckinEvent.js";
import { deskGuestFrom, eventView, safeCursor } from "./checkinDesk.js";
import { normalizeTicketId } from "./ticketAccess.js";

/* =========================================================
   TTFC Check-in desk: the event log, the cursor and the live fan-out
   ---------------------------------------------------------
   Every change is one CheckinEvent with the next number of one
   counter (CheckinCounter "events"), so all server instances share
   one sequence. Readers (the live stream, the polling fallback, a
   device catching up after sleep) ask for events after their cursor
   and get a new cursor from safeCursor (services/checkinDesk.js): it
   never moves past a number that is still being written.

   Live: each server instance keeps the streams connected to it
   (subscribe). An event written here goes to them at once (publish);
   events written by other instances arrive through one database read
   per second per instance while it has at least one stream (the tail).
   The database is the only source of truth, so any number of Render
   instances work, and a device that missed anything catches up from
   its cursor. A stream is sent its catch-up first: until then it gets
   new events without a cursor (so a device's cursor never moves past
   events it hasn't been sent), and the tail starts from the first
   stream's catch-up cursor (nothing written between the two is
   missed). A missing number counts as a failed write only once a
   reader has seen it missing for HOLE_MS (a write that commits late
   is still delivered); a number spent by a failed write is filled
   with a "void" event at once.

   Guests: staff's changes in Admin › People send `guest` / `inclusions`
   events carrying the guest's row as it is after the change, and the
   newest of them is the desk's guest generation (guestGeneration): an
   instance whose index is older rebuilds it, and a snapshot uses the
   rows meanwhile, so every instance answers with the change.

   The desk's clock: deskNow() (setDeskClock for tests and a local
   rehearsal; production never sets it).
========================================================= */

let clock = () => new Date();
/** Now, as the desk sees it. */
export const deskNow = () => clock();
/** Tests and local rehearsals only: fn → Date. */
export function setDeskClock(fn) { clock = typeof fn === "function" ? fn : () => new Date(); }

/* A sequence number this instance has seen missing → when it first saw it (Date.now(): real elapsed time, whatever the
   desk's clock says), so a gap is judged by how long it has been missing here (services/checkinDesk.js safeCursor). */
const holeSeen = new Map();
function firstSeen(seq) {
  let t = holeSeen.get(seq);
  if (t === undefined) {
    t = Date.now();
    holeSeen.set(seq, t);
    if (holeSeen.size > 2000) for (const [k, v] of holeSeen) if (t - v > 10 * 60 * 1000 || holeSeen.size > 1000) holeSeen.delete(k);
  }
  return t;
}
const cursorOf = (events, from) => {
  for (const e of events) holeSeen.delete(Number(e.seq));
  return safeCursor(events, from, { now: deskNow().getTime(), firstSeen, seenNow: Date.now() });
};

/** The next sequence number. */
async function nextSeq() {
  const c = await CheckinCounter.findOneAndUpdate({ _id: "events" }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" }).lean();
  return c.seq;
}

/** Thrown when an event with the same clientId is already stored (the same tap, sent again at the same moment). */
export class DuplicateTap extends Error {
  constructor(clientId) { super("duplicate tap"); this.clientId = clientId; }
}

/**
 * Store an event (the number is taken just before the write, so a gap is short-lived) and send it to this instance's
 * streams. → the stored event (plain object).
 */
export async function appendEvent(fields) {
  const seq = await nextSeq();
  const doc = { ...fields, seq, at: deskNow() };
  if (!doc.clientId) delete doc.clientId;
  try {
    await CheckinEvent.create(doc);
  } catch (err) {
    // The number is spent: fill it, so readers don't wait for it (best effort; a write that did land keeps its number).
    await CheckinEvent.create({ seq, kind: "void", at: deskNow() }).catch(() => {});
    if (err?.code === 11000 && doc.clientId && /clientId/.test(String(err?.message || ""))) throw new DuplicateTap(doc.clientId);
    throw err;
  }
  publish([doc]);
  return doc;
}

/** The event a tap made, if it's stored. */
export const eventForClientId = (clientId) => (clientId ? CheckinEvent.findOne({ clientId }).lean() : null);

/**
 * Events after `since`, oldest first (at most `limit`), and the cursor to ask from next time.
 * → { events, cursor, reset } (reset: the cursor is ahead of the log, e.g. a wiped test database: reload everything).
 */
export async function readSince(since = 0, { limit = 500 } = {}) {
  const from = Math.max(0, Math.floor(Number(since) || 0));
  const [events, counter] = await Promise.all([
    CheckinEvent.find({ seq: { $gt: from } }).sort({ seq: 1 }).limit(limit).lean(),
    from > 0 ? CheckinCounter.findById("events").lean() : null,
  ]);
  if (from > 0 && (!counter || counter.seq < from)) return { events: [], cursor: counter?.seq || 0, reset: true };
  return { events, cursor: cursorOf(events, from), reset: false };
}

/** The cursor as it stands (for a snapshot: read it BEFORE the marks, so later events are applied on top). */
export async function currentCursor() {
  const recent = await CheckinEvent.find({}).sort({ seq: -1 }).limit(200).select("seq at").lean();
  if (!recent.length) return 0;
  recent.reverse();
  return cursorOf(recent, recent[0].seq - 1);
}

/* ---------- The guest generation: the newest guest / inclusions event ---------- */

let genCache = { at: 0, value: 0, pending: null };
/** The seq of the newest `guest` / `inclusions` event (0: none), read at most once a second per instance (`fresh`: now). */
export async function guestGeneration({ fresh = false } = {}) {
  if (!fresh && Date.now() - genCache.at < 1000) return genCache.value;
  if (genCache.pending && !fresh) return genCache.pending;
  const pending = CheckinEvent.findOne({ kind: { $in: ["guest", "inclusions"] } }).sort({ seq: -1 }).select("seq").lean()
    .then((e) => { genCache = { at: Date.now(), value: Number(e?.seq) || 0, pending: null }; return genCache.value; })
    .catch((err) => { genCache.pending = null; throw err; });
  genCache.pending = pending;
  return pending;
}

/** The guest rows the guest / inclusions events after `seq` carry, oldest first: [{ seq, guest | null }]. */
export async function guestRowsSince(seq = 0) {
  const evs = await CheckinEvent.find({ kind: { $in: ["guest", "inclusions"] }, seq: { $gt: Number(seq) || 0 } }).sort({ seq: 1 }).limit(200).select("seq guest").lean();
  return evs.map((e) => ({ seq: e.seq, guest: e.guest && typeof e.guest === "object" ? e.guest : null }));
}

/* ---------- Live fan-out (this instance) ---------- */

const TAIL_MS = 1000;
const clients = new Set();
let tailCursor = null;
let tailTimer = null;
let tailBusy = false;
// Bumped whenever the tail stops: a read still in flight from a stopped tail throws its answer away.
let tailGen = 0;

/**
 * A stream joins: `client` = { send(events: [view], cursor|null), staff }. Events are turned into views per client
 * (staff see a little more). Until the stream calls ready(cursor) after writing its catch-up, it gets new events
 * without a cursor (and no cursor-only frames). → unsubscribe().
 */
export function subscribe(client) {
  client.sent = client.sent || new Set();
  if (client.ready === undefined) client.ready = false;
  clients.add(client);
  if (!tailTimer) {
    tailCursor = null; // seeded by the first catch-up (ready)
    tailTimer = setInterval(tick, TAIL_MS);
    tailTimer.unref?.();
  }
  return () => {
    if (!clients.delete(client)) return;
    if (!clients.size && tailTimer) { clearInterval(tailTimer); tailTimer = null; tailCursor = null; tailGen += 1; }
  };
}

/** A stream wrote its catch-up up to `cursor`: from now on its frames carry cursors, and an idle tail starts there. */
export function ready(client, cursor) {
  client.ready = true;
  if (tailTimer && tailCursor === null && Number.isFinite(Number(cursor))) tailCursor = Number(cursor);
}

export const streamCount = () => clients.size;
/** Tests: where this instance's tail is. */
export const tailState = () => ({ running: !!tailTimer, cursor: tailCursor, gen: tailGen, busy: tailBusy, streams: clients.size });

/** Send events to every stream on this instance that hasn't had them (each remembers the last 5000 numbers). */
export function publish(events, cursor = null) {
  for (const c of clients) {
    const fresh = events.filter((e) => !c.sent.has(e.seq));
    const cur = c.ready ? cursor : null;
    if (!fresh.length && cur === null) continue;
    for (const e of fresh) c.sent.add(e.seq);
    if (c.sent.size > 5000) {
      const keep = [...c.sent].slice(-2500);
      c.sent = new Set(keep);
    }
    try { c.send(fresh.map((e) => eventView(e, { staff: !!c.staff })), cur); } catch { /* a closed stream drops out on its own */ }
  }
}

/** Once a second while anyone's connected (and the first catch-up is done): whatever other instances wrote. */
async function tick() {
  if (tailBusy || tailCursor === null) return;
  const gen = tailGen;
  const from = tailCursor;
  tailBusy = true;
  try {
    const { events, cursor } = await readSince(from, { limit: 500 });
    if (gen !== tailGen || tailCursor === null) return; // the tail stopped meanwhile
    if (events.length || cursor !== from) publish(events, cursor);
    tailCursor = cursor;
  } catch (err) {
    console.error("CHECKIN DESK TAIL ERROR:", err?.message || err);
  } finally {
    tailBusy = false;
  }
}

/* ---------- Changes made elsewhere that the desks should see ---------- */

/* The desk's guest row for a directory person (routes/checkinDesk.js sets one that knows the agenda's sessions). */
let rowOf = (p) => deskGuestFrom(p);
export function setGuestRowBuilder(fn) { rowOf = typeof fn === "function" ? fn : (p) => deskGuestFrom(p); }
const rowFor = (person) => {
  if (!person) return null;
  try { return rowOf(person) || null; } catch (err) { console.error("CHECKIN DESK GUEST ROW ERROR:", err?.message || err); return null; }
};
const byOf = (user) => ({ station: "admin", byId: user?._id || null, byName: user?.name || "", byRole: user?.role === "admin" ? "staff" : "" });

/**
 * Staff changed a pass's extras (Admin › People, or the desk app through it): the desks update that guest's inclusions.
 * `person`: the directory's person after the change: the event then carries the guest's row and the guest's
 * inclusions (any counting pass's, services/checkinDesk.js guestExtras) under their main pass; without it, the edited
 * pass's `extras` / `extrasView`.
 */
export async function deskInclusionsChanged({ ticketId, extras, extrasView = null, user = null, person = null } = {}) {
  const guest = rowFor(person);
  try {
    await appendEvent(guest
      ? { kind: "inclusions", subject: guest.norm, extras: guest.extras, extrasView: guest.extrasView, guest, ...byOf(user) }
      : { kind: "inclusions", subject: normalizeTicketId(ticketId), extras, extrasView: extrasView || undefined, ...byOf(user) });
  } catch (err) {
    console.error("CHECKIN DESK INCLUSIONS EVENT ERROR:", err?.message || err);
  }
}

/** Staff changed something else about a guest (name, company, Media / VIP / Exhibitor, the pass): the desks reload,
    or (`person`: the directory's person after the change) take the row the event carries. */
export async function deskGuestChanged({ ticketIds = [], user = null, person = null } = {}) {
  const guest = rowFor(person);
  const subject = guest?.norm || normalizeTicketId(ticketIds.find(Boolean) || "");
  try {
    await appendEvent({ kind: "guest", subject, ...(guest ? { guest } : {}), ...byOf(user) });
  } catch (err) {
    console.error("CHECKIN DESK GUEST EVENT ERROR:", err?.message || err);
  }
}
