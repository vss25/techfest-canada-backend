import CheckinEvent, { CheckinCounter } from "../models/CheckinEvent.js";
import { eventView, safeCursor } from "./checkinDesk.js";
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
   its cursor.

   The desk's clock: deskNow() (setDeskClock for tests and a local
   rehearsal; production never sets it).
========================================================= */

let clock = () => new Date();
/** Now, as the desk sees it. */
export const deskNow = () => clock();
/** Tests and local rehearsals only: fn → Date. */
export function setDeskClock(fn) { clock = typeof fn === "function" ? fn : () => new Date(); }

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
  return { events, cursor: safeCursor(events, from, { now: deskNow().getTime() }), reset: false };
}

/** The cursor as it stands (for a snapshot: read it BEFORE the marks, so later events are applied on top). */
export async function currentCursor() {
  const recent = await CheckinEvent.find({}).sort({ seq: -1 }).limit(200).select("seq at").lean();
  if (!recent.length) return 0;
  recent.reverse();
  return safeCursor(recent, recent[0].seq - 1, { now: deskNow().getTime() });
}

/* ---------- Live fan-out (this instance) ---------- */

const TAIL_MS = 1000;
const clients = new Set();
let tailCursor = null;
let tailTimer = null;
let tailBusy = false;

/**
 * A stream joins: `client` = { send(events: [view], cursor|null), staff }. Events are turned into views per client
 * (staff see a little more). → unsubscribe().
 */
export function subscribe(client) {
  client.sent = client.sent || new Set();
  clients.add(client);
  if (!tailTimer) {
    tailTimer = setInterval(tick, TAIL_MS);
    tailTimer.unref?.();
  }
  return () => {
    clients.delete(client);
    if (!clients.size && tailTimer) { clearInterval(tailTimer); tailTimer = null; tailCursor = null; }
  };
}

export const streamCount = () => clients.size;

/** Send events to every stream on this instance that hasn't had them (each remembers the last 5000 numbers). */
export function publish(events, cursor = null) {
  for (const c of clients) {
    const fresh = events.filter((e) => !c.sent.has(e.seq));
    if (!fresh.length && cursor === null) continue;
    for (const e of fresh) c.sent.add(e.seq);
    if (c.sent.size > 5000) {
      const keep = [...c.sent].slice(-2500);
      c.sent = new Set(keep);
    }
    try { c.send(fresh.map((e) => eventView(e, { staff: !!c.staff })), cursor); } catch { /* a closed stream drops out on its own */ }
  }
}

/** Once a second while anyone's connected: whatever other instances wrote. */
async function tick() {
  if (tailBusy) return;
  tailBusy = true;
  try {
    if (tailCursor === null) tailCursor = await currentCursor();
    const { events, cursor } = await readSince(tailCursor, { limit: 200 });
    if (events.length || cursor !== tailCursor) publish(events, cursor);
    tailCursor = cursor;
  } catch (err) {
    console.error("CHECKIN DESK TAIL ERROR:", err?.message || err);
  } finally {
    tailBusy = false;
  }
}

/* ---------- Changes made elsewhere that the desks should see ---------- */

/** Staff changed a pass's extras (Admin › People, or the desk app through it): the desks update that guest's inclusions. */
export async function deskInclusionsChanged({ ticketId, extras, extrasView = null, user = null } = {}) {
  try {
    await appendEvent({
      kind: "inclusions", subject: normalizeTicketId(ticketId), extras, extrasView: extrasView || undefined,
      station: "admin", byId: user?._id || null, byName: user?.name || "", byRole: user?.role === "admin" ? "staff" : "",
    });
  } catch (err) {
    console.error("CHECKIN DESK INCLUSIONS EVENT ERROR:", err?.message || err);
  }
}

/** Staff changed something else about a guest (name, company, Media / VIP / Exhibitor, the pass): the desks reload. */
export async function deskGuestChanged({ ticketIds = [], user = null } = {}) {
  const subject = normalizeTicketId(ticketIds.find(Boolean) || "");
  try {
    await appendEvent({
      kind: "guest", subject, station: "admin", byId: user?._id || null, byName: user?.name || "", byRole: user?.role === "admin" ? "staff" : "",
    });
  } catch (err) {
    console.error("CHECKIN DESK GUEST EVENT ERROR:", err?.message || err);
  }
}
