import crypto from "node:crypto";
import CheckinMark from "../models/CheckinMark.js";
import MediaQuery from "../models/MediaQuery.js";
import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import { AdminAudit } from "../models/Admin.js";
import CheckinEvent from "../models/CheckinEvent.js";
import CheckinTap from "../models/CheckinTap.js";
import {
  POINTS, POINT_LABELS, STAFF_KINDS, UNDOABLE_KINDS, UNKNOWN_OUTCOME_TEXT, auditLine, boothSubject, canUndo, entitlement, eventView, isUnknownKey, markView,
  mealStationOf, queryView, tapClock, unknownKeyOf,
} from "./checkinDesk.js";
import { stationState, fmtClock, STATION_LABELS } from "./checkinDeskTime.js";
import { appendEvent, deskNow, DuplicateTap, eventForClientId } from "./checkinDeskLog.js";
import { normalizeTicketId } from "./ticketAccess.js";

/* =========================================================
   TTFC Check-in desk: what each tap does to the database
   ---------------------------------------------------------
   performAction() for the app's actions (routes/checkinDesk.js), and
   recordScan() for a QR scan at the door (routes/checkin.js), so a
   scan shows on the pass desk as checked in.

   Marks (models/CheckinMark.js) change with single conditional
   updates, so two volunteers tapping the same guest at once is fine:
   one sets it, the other is told who did ("Already admitted at 7:52
   by Sam"), and nothing is counted twice. The same tap sent twice (a
   retry, the offline queue) is answered from the event it made
   (clientId).

   The pass desk's Checked in = the door scan: the ticket's checkedIn /
   checkedInAt (User.tickets[] and the Attendee row) are set by the
   first check-in only, and taken back only by undoing / resetting
   that very check-in.

   Audited (AdminAudit): every override (a tap outside the station's
   hours), and staff powers (reset, desk notes, undoing someone else's
   tap, reassigning or closing a media query). Every tap, with who,
   where and when, is in the desk's own log (CheckinEvent).

   The contract with the app (also in CLAUDE.md):
     C2 undo by reference: { kind: "undo", target: <the tap's clientId> }
        undoes exactly that tap (again: nothing more to undo). A tap the
        server hasn't had yet gets a tombstone: when it arrives it isn't
        recorded (and one being recorded meanwhile is taken back at once).
        One CheckinTap row per tap is the state machine that makes this
        atomic (waiting → pending → done, or → undone): only the request
        holding it "pending" writes the tap's marks, an undo turns it
        "undone" before it clears anything, and the recording request
        looks at it once more after its last write and takes back
        everything it wrote if it was undone meanwhile. So an undo that
        was answered "undone" always ends with the tap not marked, in
        whichever order the requests run (the same tap sent twice at once
        is recorded by one request; the other is answered once it's done,
        or 503 in_flight to be sent again).
     C3 queuedBy { id, name }: tapped offline by that person, sent from
        someone else's sign-in: recorded and audited as theirs, with
        recordedBy = the sign-in and queuedOffline; staff powers only
        when both are staff. From a volunteer sign-in, such an undo only
        takes back a tap sent from that same sign-in.
     C4 clientAt is the device's server-corrected clock, clamped to
        [now − 12 h, now + 2 min] and judged at that time; a late sync
        (> 1 min old) outside the station's hours without "Admit anyway"
        is still recorded, as override "late_sync", and audited.
     C6 a day that isn't Day 1 / Day 2 (Toronto): marks are practice
        marks, never the ticket's checkedIn / checkedInAt; undo and reset
        clear them (a volunteer's own practice tap: undo at any time).
     C8 NO DETAILS FOUND: the lobby couldn't find the person and records
        the arrival as typed (unknown_arrival: an event, card key
        "u:<its clientId>", never a mark or a ticket); the pass desk
        closes it (unknown_done: sent to help / pass issued / left), or
        staff find them on the list (unknown_link: that guest is marked
        arrived at the arrival's time, audited); undo like a lobby tap.
========================================================= */

/* Tests only: awaited at named points of a tap and of an undo, so they can be interleaved (production never sets it). */
let hooks = null;
export function setDeskActionHooks(fn) { hooks = typeof fn === "function" ? fn : null; }
const pause = (name, info) => (hooks ? hooks(name, info) : undefined);
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

const fail = (status, error, extra = {}) => ({ ok: false, status, error, ...extra });
const isDup = (err) => err?.code === 11000;

/** The person acting, as marks and events store them. */
export const actorOf = (user, staff) => ({ id: user._id, name: String(user.name || user.email || "").trim().slice(0, 80), role: staff ? "staff" : "volunteer" });

/** Where a tap made offline by someone else came from (contract C3), as marks and events store it. */
const queuedFields = (recordedBy) => (recordedBy ? { queuedOffline: true, recordedById: recordedBy.id, recordedByName: recordedBy.name } : {});
const queuedNote = (actor, recordedBy) => (recordedBy ? ` [tapped offline by ${actor.name || "someone"}; sent from ${recordedBy.name || "another"}'s sign-in]` : "");

async function audit(actor, action, targetId, detail, recordedBy = null) {
  await AdminAudit.create({
    adminId: actor.id || recordedBy?.id || null, adminName: actor.name, action, targetType: "checkin_desk", targetId: String(targetId || ""),
    detail: `${detail}${queuedNote(actor, recordedBy)}`.slice(0, 500),
  }).catch(() => {});
}

/**
 * Who made this tap (contract C3). Normally the sign-in. With `queuedBy` naming someone else: that person (their
 * account's name and role when it exists), recordedBy = the sign-in, and staff powers only when both are staff.
 * → { actor, staff, recordedBy }
 */
async function whoTapped(action, ctx) {
  const signedIn = actorOf(ctx.user, ctx.staff);
  const q = action.queuedBy;
  if (!q || (q.id && q.id === String(ctx.user._id))) return { actor: signedIn, staff: ctx.staff, recordedBy: null };
  if (!q.id && q.name && q.name === signedIn.name) return { actor: signedIn, staff: ctx.staff, recordedBy: null };
  let u = null;
  if (q.id) {
    ctx.people ||= new Map();
    if (!ctx.people.has(q.id)) ctx.people.set(q.id, User.findById(q.id).select("name email role banned").lean().catch(() => null));
    u = await ctx.people.get(q.id);
  }
  const staff = !!ctx.staff && !!u && u.role === "admin" && !u.banned;
  const name = String(u?.name || u?.email || q.name || "Someone (an offline tap)").trim().slice(0, 80);
  return { actor: { id: u?._id || null, name, role: staff ? "staff" : "volunteer" }, staff, recordedBy: { id: signedIn.id, name: signedIn.name } };
}

/* ---------- Marks ---------- */

const CLEARED = {
  at: null, byId: null, byName: "", byRole: "", station: "", ref: "", override: "", note: "", item: "", passSetAt: null,
  practice: false, lateSync: false, queuedOffline: false, recordedById: null, recordedByName: "",
};

/** Set a mark if it isn't set. → { doc, changed, mine } (mine: it was already set by this very tap). */
async function setMark(m) {
  const { subject, day, point, at, actor, station, ref, override = "", note = "", item = "", passSetAt = null, practice = false, lateSync = false, recordedBy = null } = m;
  const set = {
    at, byId: actor.id, byName: actor.name, byRole: actor.role, station, ref, override, note, item, passSetAt,
    practice: !!practice, lateSync: !!lateSync, queuedOffline: !!recordedBy, recordedById: recordedBy?.id || null, recordedByName: recordedBy?.name || "",
  };
  try {
    const doc = await CheckinMark.findOneAndUpdate({ subject, day, point, at: null }, { $set: set, $inc: { rev: 1 } }, { upsert: true, returnDocument: "after" }).lean();
    return { doc, changed: true, mine: false };
  } catch (err) {
    if (!isDup(err)) throw err;
    const doc = await CheckinMark.findOne({ subject, day, point }).lean();
    if (!doc) throw err;
    // Cleared in between (rare): try once more.
    if (!doc.at) return setMark(m);
    return { doc, changed: false, mine: !!ref && doc.ref === ref };
  }
}

/** Clear a mark (only if `ref` set it, when given), in one write. → { after, before } (the row after and as it was:
    its passSetAt says whether it had collected the pass), or null when nothing changed. */
async function takeBack({ subject, day, point, ref = "" }) {
  const before = await CheckinMark.findOneAndUpdate({ subject, day, point, at: { $ne: null }, ...(ref ? { ref } : {}) }, { $set: CLEARED, $inc: { rev: 1 } }, { returnDocument: "before" }).lean();
  if (!before) return null;
  return { before, after: { ...before, ...CLEARED, rev: (Number(before.rev) || 0) + 1 } };
}

/* ---------- Pass collected: the ticket's checkedIn / checkedInAt (the QR scanner's fields) ---------- */

const variantsOf = (ids) => [...new Set(ids.filter(Boolean).flatMap((id) => [String(id), normalizeTicketId(id), normalizeTicketId(id).toUpperCase()]))];

/** When the pass was collected (the earliest of its records), or null. */
async function collectedAt(variants) {
  const [u, a] = await Promise.all([
    User.findOne({ "tickets.ticketId": { $in: variants } }).select("tickets.ticketId tickets.checkedIn tickets.checkedInAt").lean(),
    Attendee.find({ ticketId: { $in: variants } }).select("checkedIn checkedInAt").lean(),
  ]);
  const times = [];
  let any = false;
  for (const t of u?.tickets || []) if (variants.includes(t.ticketId) && t.checkedIn) { any = true; if (t.checkedInAt) times.push(new Date(t.checkedInAt).getTime()); }
  for (const r of a) if (r.checkedIn) { any = true; if (r.checkedInAt) times.push(new Date(r.checkedInAt).getTime()); }
  return { collected: any, at: times.length ? new Date(Math.min(...times)) : null };
}

/** Mark the pass collected unless it already is (first check-in only, as the door scanner does). → { set, collected, at } */
async function collectPass(ids, at) {
  const variants = variantsOf(ids);
  const [u, a] = await Promise.all([
    User.updateOne({ tickets: { $elemMatch: { ticketId: { $in: variants }, checkedIn: { $ne: true } } } },
      { $set: { "tickets.$.checkedIn": true, "tickets.$.checkedInAt": at } }),
    Attendee.updateMany({ ticketId: { $in: variants }, checkedIn: { $ne: true } }, { $set: { checkedIn: true, checkedInAt: at } }),
  ]);
  const now = await collectedAt(variants);
  return { set: (u.modifiedCount || 0) + (a.modifiedCount || 0) > 0, collected: now.collected, at: now.at };
}

/** Take back a pass collection made at exactly `at` (by the check-in being undone). */
async function uncollectPass(ids, at) {
  const variants = variantsOf(ids);
  await Promise.all([
    User.updateOne({ tickets: { $elemMatch: { ticketId: { $in: variants }, checkedInAt: at } } },
      { $set: { "tickets.$.checkedIn": false }, $unset: { "tickets.$.checkedInAt": 1 } }),
    Attendee.updateMany({ ticketId: { $in: variants }, checkedInAt: at }, { $set: { checkedIn: false }, $unset: { checkedInAt: 1 } }),
  ]);
  const now = await collectedAt(variants);
  return { collected: now.collected, at: now.at };
}

/* ---------- Undo vs tap: the CheckinTap state machine (contract C2) ---------- */

/** A request still "recording" a tap after this long has died: the tap sent again takes it over. */
export const TAP_LEASE_MS = 30 * 1000;
/** The same tap sent again while another request records it waits at most this long for it (per request, in all). */
export const TAP_WAIT_MS = 2000;
let tapLeaseMs = TAP_LEASE_MS;
let tapWaitMs = TAP_WAIT_MS;
/** Tests only: shorter lease / wait. */
export function setTapTiming({ leaseMs = TAP_LEASE_MS, waitMs = TAP_WAIT_MS } = {}) { tapLeaseMs = leaseMs; tapWaitMs = waitMs; }
const sameId = (a, b) => !!a && !!b && String(a) === String(b);

/**
 * May this undo (`tomb`: { byId, byRole, signedInId }) take back that tap (`tap`: { byId, sentFromId })? Staff's, or the
 * tap's own author's; a volunteer's undo queued offline by someone else only one sent from the same sign-in (C3). So
 * someone else's tombstone never hides the author's tap.
 */
export const tombCovers = (tomb, tap) => !!tomb && (tomb.byRole === "staff"
  || (sameId(tomb.byId, tap?.byId) && (!tomb.signedInId || sameId(tomb.signedInId, tap?.sentFromId || tap?.byId))));

const tombOf = (actor, ctx, clientId) => ({
  byId: actor.id || null, byName: actor.name, byRole: actor.role,
  signedInId: ctx.recordedBy && !ctx.signedInStaff ? ctx.recordedBy.id : null, clientId: clientId || "", at: deskNow(),
});

/**
 * Before a tap writes anything: this request becomes the one recording it. → { own: token } | { undone } (an undo
 * that may take it back came first: never recorded) | { done } (recorded by another request) | { inFlight } (another
 * request is recording it right now and didn't finish within the wait: answered 503, the device sends it again).
 */
async function claimTap(a, actor, ctx) {
  const id = a.clientId;
  const token = crypto.randomBytes(9).toString("base64url");
  const me = { kind: a.kind, byId: actor.id || null, byRole: actor.role, sentFromId: ctx.recordedBy?.id || actor.id || null };
  const pending = () => ({ state: "pending", ...me, owner: token, claimedAt: new Date() });
  // One wait budget per request (a batch of taps), not per tap.
  const budget = (ctx.budget ||= {});
  budget.tapWaitMs ??= tapWaitMs;
  for (let tries = 0; tries < 50; tries++) {
    try {
      await CheckinTap.create({ _id: id, ...pending() });
      return { own: token };
    } catch (err) { if (!isDup(err)) throw err; }
    const doc = await CheckinTap.findById(id).lean();
    if (!doc) continue;
    if (doc.state === "undone") return { undone: true };
    if (doc.state === "done") return { done: true };
    if (doc.state === "waiting") {
      const tombs = doc.tombs || [];
      const cover = tombs.find((t) => tombCovers(t, me));
      if (cover) {
        // An undo that may take it back reached the server first: never recorded.
        await CheckinTap.updateOne({ _id: id, state: "waiting" }, { $set: { state: "undone", undo: cover, ...me } });
        continue;
      }
      // Only tombstones that can't take it back (someone else's): it's recorded, unless another undo came in meanwhile.
      const r = await CheckinTap.updateOne({ _id: id, state: "waiting", tombs: { $size: tombs.length } }, { $set: pending() });
      if (r.modifiedCount) return { own: token };
      continue;
    }
    // "pending": another request is recording this very tap (it was sent again while the first was slow).
    if (Date.now() - new Date(doc.claimedAt || 0).getTime() > tapLeaseMs) {
      const r = await CheckinTap.updateOne({ _id: id, state: "pending", owner: doc.owner }, { $set: { owner: token, claimedAt: new Date() } });
      if (r.modifiedCount) return { own: token, takenOver: true };
      continue;
    }
    if (budget.tapWaitMs <= 0) return { inFlight: true };
    budget.tapWaitMs -= 100;
    await sleep(100);
  }
  return { inFlight: true };
}

/** The tap is recorded: done, unless an undo turned it "undone" while it was being written. → that undo, or null. */
async function finishTap(id) {
  const r = await CheckinTap.updateOne({ _id: id, state: "pending" }, { $set: { state: "done", owner: null } });
  if (r.modifiedCount) return null;
  const doc = await CheckinTap.findById(id).select("state undo").lean();
  return doc?.state === "undone" ? doc.undo || {} : null;
}

/** Nothing was recorded (refused, already set by someone else): another try may record it. → that undo, if it was
    undone meanwhile (the caller takes back anything written), else null. */
async function releaseTap(id, token) {
  const r = await CheckinTap.updateOne({ _id: id, state: "pending", owner: token }, { $set: { state: "waiting", owner: null, claimedAt: null } });
  if (r.modifiedCount) return null;
  const doc = await CheckinTap.findById(id).select("state undo").lean();
  return doc?.state === "undone" ? doc.undo || {} : null;
}

/** An undo of a tap the server has: from now on it's undone (a request still recording it takes back what it wrote). */
const markUndone = (id, undo) => CheckinTap.updateOne({ _id: id }, { $set: { state: "undone", undo } }, { upsert: true }).catch((err) => {
  if (!isDup(err)) throw err;
  return CheckinTap.updateOne({ _id: id }, { $set: { state: "undone", undo } });
});

/* ---------- Actions ---------- */

/**
 * One action (cleanAction's value) by `user`.
 *   ctx: { user, staff, resolve(key) → { guest, norm } | null, booth(key) → booth | null, windows, stationOn(station),
 *          freshGuest?(hit) → the guest with their inclusions read from the database now (meal stations) }
 * → { ok: true, events: [view], already?, mark?, query?, message?, tombstone?, undone? } | { ok: false, status, error, code? }
 */
export async function performAction(action, ctx) {
  const who = await whoTapped(action, ctx);
  const { actor, staff, recordedBy } = who;
  ctx.budget ||= {};
  const c = { ...ctx, staff, recordedBy, signedInStaff: !!ctx.staff };
  const view = (evs) => evs.map((e) => eventView(e, { staff }));
  if (STAFF_KINDS.includes(action.kind) && !staff) return fail(403, "Only staff can do that.", { code: "staff_only" });

  // The same tap again: answer from what it did (and what undid it since).
  const prior = await eventForClientId(action.clientId);
  if (prior) return { ok: true, duplicate: true, events: view([prior, ...await undosOf(action.clientId)]) };

  // Contract C2: this request becomes the one recording the tap (CheckinTap), unless an undo of it came first.
  let token = null;
  if (UNDOABLE_KINDS.includes(action.kind)) {
    const claim = await claimTap(action, actor, c);
    await pause("tap:claimed", { clientId: action.clientId, claim });
    if (claim.undone) return { ok: true, undone: true, events: [], message: "Undone on the device before it reached the server: not recorded." };
    if (claim.done) {
      const ev = await eventForClientId(action.clientId);
      return { ok: true, duplicate: true, events: ev ? view([ev, ...await undosOf(action.clientId)]) : [] };
    }
    if (claim.inFlight) return fail(503, "This tap is still being recorded. It will be sent again.", { code: "in_flight" });
    token = claim.own;
  }

  try {
    let r;
    switch (action.kind) {
      case "mark": r = await doMark(action, c, actor, view); break;
      case "undo": return await doUndo(action, c, actor, view);
      case "reset": return await doReset(action, c, actor, view);
      case "note": return await doNote(action, c, actor, view);
      case "query_add": return await doQueryAdd(action, c, actor, view);
      case "query_update": return await doQueryUpdate(action, c, actor, view);
      case "unknown_arrival": r = await doUnknownArrival(action, c, actor, view); break;
      case "unknown_done": return await doUnknownDone(action, c, actor, view);
      case "unknown_link": return await doUnknownLink(action, c, actor, view);
      default: return fail(400, "Unknown action.");
    }
    if (token) {
      await pause("tap:before-finish", { clientId: action.clientId });
      // An undo that turned it "undone" while this request was writing: take back everything it wrote.
      const undo = r.ok && !r.already ? await finishTap(action.clientId) : await releaseTap(action.clientId, token);
      if (undo) {
        const back = await settleUndone(action.clientId, undo, r.event || null);
        if (back && r.events) r.events = [...r.events, ...view([back])];
        if (r.ok && !r.already) Object.assign(r, { undone: true, message: "Recorded, then taken back: it was undone on the device meanwhile." });
      }
    }
    delete r.event;
    return r;
  } catch (err) {
    if (err instanceof DuplicateTap) {
      // Recorded by another request at the same moment (one whose claim this one took over): one event, and if it was
      // undone meanwhile, nothing this request wrote stays.
      const undo = token ? await finishTap(action.clientId) : null;
      if (undo) await settleUndone(action.clientId, undo);
      const ev = await eventForClientId(action.clientId);
      return { ok: true, duplicate: true, events: ev ? view([ev, ...await undosOf(action.clientId)]) : [] };
    }
    // Failed half-way: the tap can be sent again (it's released); undone meanwhile → what it wrote is taken back.
    if (token) {
      const undo = await releaseTap(action.clientId, token).catch(() => null);
      if (undo) await settleUndone(action.clientId, undo).catch(() => {});
    }
    throw err;
  }
}

/** The undo events of a tap (for the answer to the same tap sent again). */
const undosOf = (clientId) => CheckinEvent.find({ kind: "undo", ref: clientId, tombstone: { $ne: true } }).sort({ seq: 1 }).limit(5).lean();

/**
 * The tap `clientId` was undone (`undo`: who) while it was being recorded: take back every mark it set (and a pass
 * collection it made), or the NO DETAILS FOUND card it opened, as that undo. → the undo event, or null (nothing left).
 */
async function settleUndone(clientId, undo, ev = null) {
  const target = ev || await eventForClientId(clientId);
  const by = { byId: undo.byId || null, byName: undo.byName || "", byRole: undo.byRole || "" };
  if (target?.kind === "unknown_arrival") {
    if ((await unknownCard(unknownKeyOf(clientId))).undone) return null;
    return appendEvent({ kind: "undo", subject: unknownKeyOf(clientId), day: target.day, station: target.station, ...by, ref: clientId, refPoint: "unknown_arrival" });
  }
  const { changed, pass } = await clearByRef(clientId);
  if (!changed.length) return null;
  const first = target?.kind === "mark" ? target : changed[0];
  return appendEvent({
    kind: "undo", point: first.point, subject: first.subject, day: first.day, station: target?.station || "", ...by, ref: clientId, refPoint: first.point,
    marks: changed, pass,
  });
}

function whenText(at) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Toronto", hour: "numeric", minute: "2-digit" }).format(new Date(at));
}

async function doMark(a, ctx, actor, view) {
  const point = a.point;
  const pointStation = POINTS[point];
  const now = deskNow();
  // When it was tapped (contract C4): the device's server-corrected clock, clamped; judged at that moment.
  const clock = tapClock(a.clientAt, now);
  const at = clock.at;
  if (!ctx.stationOn(pointStation)) return fail(409, `${STATION_LABELS[pointStation]} is switched off.`, { code: "station_off" });

  let guest = null;
  let booth = null;
  let subject;
  let hit = null;
  if (point === "booth") {
    booth = ctx.booth(a.key);
    if (!booth) return fail(404, "That booth isn't on the exhibitor list. Refresh and try again.", { code: "not_found" });
    subject = boothSubject(a.key);
  } else {
    hit = await ctx.resolve(a.key);
    if (!hit) return fail(404, "This guest isn't on the list any more. Refresh and try again.", { code: "not_found" });
    guest = hit.guest;
    subject = hit.norm;
  }

  // Time-appropriate: today's event day and the station's window, at the moment of the tap.
  const state = stationState({ station: pointStation, at, windows: ctx.windows });
  const day = state.date;
  // Not Day 1 or Day 2 (contract C6): a practice mark, whatever the hours; it never touches the ticket.
  const practice = !state.eventDay;
  let override = "";
  if (!practice && !state.open) {
    if (a.override) override = "outside_window";
    // Tapped offline while it was outside the hours, and the device didn't ask: recorded, flagged and audited.
    else if (clock.late) override = "late_sync";
    else return fail(409, `${state.text}. Tap “Admit anyway” to record it.`, { code: "outside_window", window: { text: state.text, detail: state.detail, code: state.code } });
  }
  // A late sync judged in the hours though the server's own clock says otherwise: recorded as tapped, and audited.
  let lateNote = "";
  if (clock.late && !practice && state.open) {
    const nowState = stationState({ station: pointStation, at: now, windows: ctx.windows });
    if (!nowState.open || nowState.date !== state.date) lateNote = `tapped ${whenText(at)} (device), reached the server ${whenText(now)}`;
  }

  // Meals and evenings: one of the guest's passes must include today's item (staff switch it on first; volunteers send
  // them to staff). Read from the database now, so a switch staff just made counts on every server instance.
  const mealStation = mealStationOf(point);
  let item = null;
  if (mealStation && !practice) {
    let g = guest;
    if (ctx.freshGuest) {
      try { g = (await ctx.freshGuest(hit)) || guest; } catch (err) { console.error("CHECKIN DESK ENTITLEMENT READ ERROR:", err?.message || err); }
    }
    const ent = entitlement(g, mealStation, state.eventDay);
    item = ent.item;
    if (item && !ent.included) {
      return fail(409, `Not on their pass: ${item.label}. ${ctx.staff ? "Switch it on for this pass first." : "Send them to a staff member."}`, { code: "not_included", item });
    }
  }

  const ref = a.clientId;
  const common = { at, actor, station: a.station, ref, override, practice, lateSync: clock.late, recordedBy: ctx.recordedBy };
  const res = await setMark({ subject, day, point, ...common, note: point === "av" ? a.note || "" : "", item: item?.key || "" });
  await pause("tap:first-mark", { clientId: a.clientId, point });
  if (!res.changed && !res.mine) {
    const d = res.doc;
    const what = { checked_in: "Already checked in", arrived: "Already marked arrived", booth: "Booth already set up", av: "AV already checked" }[point]
      || (mealStation ? "Already admitted" : point.startsWith("flag_") ? "Already sent to staff" : "Already checked in");
    return { ok: true, already: true, events: [], mark: markView(d), message: `${what} at ${whenText(d.at)}${d.byName ? ` by ${d.byName}` : ""}` };
  }
  const changed = [res.doc];
  let pass;
  if (point === "checked_in") {
    // Checked in at the desk means they arrived too (attendance for the day), and their pass is now collected (on Day 1
    // and Day 2 only: a practice check-in never collects the real pass).
    const arr = await setMark({ subject, day, point: "arrived", ...common });
    if (arr.changed || arr.mine) changed.push(arr.doc);
    await pause("tap:between-marks", { clientId: a.clientId, point });
    if (!practice) {
      const ids = guest ? [guest.ticketIds[guest.norms.indexOf(subject)] || subject, subject] : [subject];
      let p = await collectPass(ids, at);
      if (p.set) {
        await pause("tap:pass-collected", { clientId: a.clientId });
        const upd = await CheckinMark.findOneAndUpdate({ _id: res.doc._id, ref, at: { $ne: null } }, { $set: { passSetAt: at }, $inc: { rev: 1 } }, { returnDocument: "after" }).lean();
        if (upd) changed[0] = upd;
        else {
          // This check-in was taken back (an undo, a staff reset) while the pass was being marked collected: the
          // collection goes to a check-in made since, else it's given back, so no collection is left without a mark.
          const since = await CheckinMark.findOneAndUpdate({ subject, day, point, at: { $ne: null }, passSetAt: null }, { $set: { passSetAt: at }, $inc: { rev: 1 } }, { returnDocument: "after" }).lean();
          if (since) changed.push(since);
          else p = await uncollectPass(ids, at);
        }
      }
      pass = { ticketId: subject, collected: p.collected, collectedAt: p.at };
    }
  }
  await pause("tap:before-event", { clientId: a.clientId, point });
  const ev = await appendEvent({
    kind: "mark", point, subject, day, clientAt: a.clientAt, station: a.station, byId: actor.id, byName: actor.name, byRole: actor.role,
    clientId: a.clientId, override, note: point === "av" ? a.note || "" : "", marks: changed, pass,
    ...(practice ? { practice: true } : {}), ...(clock.late ? { lateSync: true } : {}), ...queuedFields(ctx.recordedBy),
  });
  if (override) await audit(actor, "checkin_desk_override", subject, auditLine({ guest, booth, kind: "mark", point, station: a.station, override, item }), ctx.recordedBy);
  if (lateNote) await audit(actor, "checkin_desk_late_sync", subject, `${auditLine({ guest, booth, kind: "mark", point, station: a.station, item })}: ${lateNote}`, ctx.recordedBy);
  return { ok: true, events: view([ev]), mark: markView(changed[0]), event: ev };
}

/** Clear exactly what a tap set: every mark it set (ref = its clientId: a check-in's own and the arrival it implied),
    and give back a pass collection one of them made. → { changed, pass } */
async function clearByRef(ref) {
  const changed = [];
  let pass;
  if (!ref) return { changed, pass };
  const rows = await CheckinMark.find({ ref, at: { $ne: null } }).select("subject day point").lean();
  rows.sort((x, y) => (y.point === "checked_in") - (x.point === "checked_in"));
  for (const row of rows) {
    const t = await takeBack({ subject: row.subject, day: row.day, point: row.point, ref });
    if (!t) continue;
    changed.push(t.after);
    if (t.before.passSetAt) {
      const p = await uncollectPass([row.subject], t.before.passSetAt);
      pass = { ticketId: row.subject, collected: p.collected, collectedAt: p.at };
    }
  }
  return { changed, pass };
}

async function doUndo(a, ctx, actor, view, again = false) {
  await pause("undo:start", { clientId: a.clientId, ref: a.ref });
  const target = await eventForClientId(a.ref);
  if (!target) {
    // The tap hasn't reached the server (or never will): a tombstone, so it isn't recorded when it does (contract C2).
    if (!actor.id && !ctx.staff) return fail(403, "You can only undo your own taps. Ask a staff member.", { code: "undo_refused" });
    await pause("undo:before-tombstone", { clientId: a.clientId, ref: a.ref });
    const tomb = tombOf(actor, ctx, a.clientId);
    const tap = await CheckinTap.findOneAndUpdate({ _id: a.ref }, { $push: { tombs: tomb }, $setOnInsert: { state: "waiting" } }, { upsert: true, returnDocument: "after" }).lean()
      .catch((err) => (isDup(err) ? CheckinTap.findOneAndUpdate({ _id: a.ref }, { $push: { tombs: tomb } }, { returnDocument: "after" }).lean() : Promise.reject(err)));
    await pause("undo:after-tombstone", { clientId: a.clientId, ref: a.ref, state: tap?.state });
    // Recorded since this undo looked (it was being recorded): the usual undo, now that it's stored.
    if (tap?.state === "done" && !again) return doUndo(a, ctx, actor, view, true);
    let message = "Undone. That tap hadn't reached the server, and it won't be recorded.";
    if (tap?.state === "pending" && tombCovers(tomb, tap)) {
      // Being recorded right now by another request: it's undone, and that request takes back what it writes.
      const r = await CheckinTap.updateOne({ _id: a.ref, state: "pending" }, { $set: { state: "undone", undo: tomb } });
      if (!r.modifiedCount && !again) {
        const now = await CheckinTap.findById(a.ref).select("state").lean();
        if (now?.state === "done") return doUndo(a, ctx, actor, view, true);
      }
      message = "Undone. That tap was still being recorded: it's taken back.";
    }
    const ev = await appendEvent({
      kind: "undo", tombstone: true, ref: a.ref, clientAt: a.clientAt, station: a.station, byId: actor.id, byName: actor.name, byRole: actor.role,
      clientId: a.clientId, ...queuedFields(ctx.recordedBy),
    });
    return { ok: true, tombstone: true, events: view([ev]), message };
  }
  if (!actor.id && !ctx.staff) return fail(403, "You can only undo your own taps. Ask a staff member.", { code: "undo_refused" });
  // Queued offline by someone else (contract C3): a volunteer sign-in only sends undos of taps sent from it (canUndo).
  const signedInId = ctx.recordedBy && !ctx.signedInStaff ? String(ctx.recordedBy.id) : "";
  const allowed = canUndo({ target, actorId: String(actor.id), staff: ctx.staff, undoClientAt: a.clientAt, now: deskNow(), signedInId });
  if (!allowed.ok) return fail(allowed.status, allowed.error, { code: "undo_refused" });
  if (target.kind === "unknown_arrival") {
    await markUndone(target.clientId, tombOf(actor, ctx, a.clientId));
    return undoUnknownArrival(a, ctx, actor, view, target);
  }
  const { subject, day, point } = target;
  if (point === "arrived") {
    const desk = await CheckinMark.findOne({ subject, day, point: "checked_in", at: { $ne: null } }).lean();
    if (desk && desk.ref !== target.clientId) return fail(409, "They're already checked in at the pass desk. A staff member can reset them there.", { code: "checked_in" });
  }
  // Undone from now on, before anything is cleared: a request still recording this tap takes back what it writes.
  await markUndone(target.clientId, tombOf(actor, ctx, a.clientId));
  await pause("undo:before-clear", { clientId: a.clientId, ref: a.ref });
  const { changed, pass } = await clearByRef(target.clientId);
  if (!changed.length) return { ok: true, events: [], noop: true, message: "Nothing to undo: it was already undone." };
  const ev = await appendEvent({
    kind: "undo", point, subject, day, clientAt: a.clientAt, station: a.station, byId: actor.id, byName: actor.name, byRole: actor.role,
    clientId: a.clientId, ref: target.clientId, refPoint: point, marks: changed, pass, ...queuedFields(ctx.recordedBy),
  });
  if (String(target.byId) !== String(actor.id)) {
    const hit = subject.startsWith("booth:") ? null : await ctx.resolveNorm?.(subject);
    await audit(actor, "checkin_desk_undo", subject, `${auditLine({ guest: hit, kind: "undo", point, station: a.station })} (tap by ${target.byName || "someone else"})`, ctx.recordedBy);
  }
  return { ok: true, events: view([ev]) };
}

async function doReset(a, ctx, actor, view) {
  const day = stationState({ station: POINTS[a.point], at: deskNow(), windows: ctx.windows }).date;
  let guest = null;
  let booth = null;
  let subjects;
  if (a.point === "booth") {
    booth = ctx.booth(a.key);
    if (!booth) return fail(404, "That booth isn't on the exhibitor list.", { code: "not_found" });
    subjects = [boothSubject(a.key)];
  } else {
    const hit = await ctx.resolve(a.key);
    if (!hit) return fail(404, "This guest isn't on the list any more.", { code: "not_found" });
    guest = hit.guest;
    subjects = guest.norms;
  }
  // Clearing "arrived" also clears today's check-in (they're back to not arrived); a check-in that collected the pass
  // today gives it back. Practice marks (not an event day) clear the same way, and never collected anything.
  const points = a.point === "arrived" ? ["checked_in", "arrived"] : [a.point];
  const changed = [];
  let pass;
  for (const subject of subjects) {
    for (const point of points) {
      const t = await takeBack({ subject, day, point });
      if (!t) continue;
      changed.push(t.after);
      if (point === "checked_in" && t.before.passSetAt) {
        const p = await uncollectPass([subject], t.before.passSetAt);
        pass = { ticketId: subject, collected: p.collected, collectedAt: p.at };
      }
    }
  }
  if (!changed.length) return { ok: true, events: [], noop: true, message: "Nothing to reset." };
  const ev = await appendEvent({
    kind: "reset", point: a.point, subject: subjects[0], day, clientAt: a.clientAt, station: a.station, byId: actor.id, byName: actor.name, byRole: actor.role,
    clientId: a.clientId, marks: changed, pass, ...queuedFields(ctx.recordedBy),
  });
  await audit(actor, "checkin_desk_reset", subjects[0], auditLine({ guest, booth, kind: "reset", point: a.point, station: a.station }), ctx.recordedBy);
  return { ok: true, events: view([ev]) };
}

async function doNote(a, ctx, actor, view) {
  const hit = await ctx.resolve(a.key);
  if (!hit) return fail(404, "This guest isn't on the list any more.", { code: "not_found" });
  const subject = hit.guest.norm;
  const ev = await appendEvent({
    kind: "note", subject, clientAt: a.clientAt, station: a.station, byId: actor.id, byName: actor.name, byRole: actor.role,
    clientId: a.clientId, note: a.note, ...queuedFields(ctx.recordedBy),
  });
  await audit(actor, "checkin_desk_note", subject, auditLine({ guest: hit.guest, kind: "note", note: a.note, station: a.station }), ctx.recordedBy);
  return { ok: true, events: view([ev]) };
}

async function doQueryAdd(a, ctx, actor, view) {
  let subject = "";
  let whoTxt = a.who;
  if (a.key) {
    const hit = await ctx.resolve(a.key);
    if (!hit) return fail(404, "This guest isn't on the list any more.", { code: "not_found" });
    subject = hit.guest.norm;
    if (!whoTxt) whoTxt = hit.guest.name;
  }
  let q;
  try {
    q = await MediaQuery.create({
      who: whoTxt, outlet: a.outlet, request: a.request, subject, status: "new", createdById: actor.id, createdByName: actor.name, clientId: a.clientId, rev: 1,
    });
  } catch (err) {
    if (!isDup(err)) throw err;
    q = await MediaQuery.findOne({ clientId: a.clientId });
  }
  const ev = await appendEvent({
    kind: "query", subject, clientAt: a.clientAt, station: a.station, byId: actor.id, byName: actor.name, byRole: actor.role, clientId: a.clientId,
    query: q.toObject ? q.toObject() : q, ...queuedFields(ctx.recordedBy),
  });
  return { ok: true, events: view([ev]), query: queryView(q) };
}

async function doQueryUpdate(a, ctx, actor, view) {
  const q = await MediaQuery.findById(a.id).lean();
  if (!q) return fail(404, "That query isn't on the list any more.", { code: "not_found" });
  const mine = !!actor.id && String(q.assigneeId || "") === String(actor.id);
  if (!ctx.staff) {
    // Volunteers can take a query that nobody (or they) has, and start on it. Staff reassign and close.
    const okAssignee = a.assignee === undefined || a.assignee === "me";
    const okStatus = a.status === undefined || a.status === "in_progress";
    if (!okAssignee || !okStatus || (q.assigneeId && !mine) || q.status === "done") {
      return fail(403, "Only staff can reassign or close a query.", { code: "staff_only" });
    }
  }
  const set = {};
  if (a.status !== undefined) {
    set.status = a.status;
    set.doneAt = a.status === "done" ? deskNow() : null;
  }
  if (a.assignee !== undefined) {
    if (a.assignee === null) { set.assigneeId = null; set.assigneeName = ""; } else if (a.assignee === "me") { set.assigneeId = actor.id; set.assigneeName = actor.name; } else {
      const u = await User.findById(a.assignee).select("name email role types").lean();
      if (!u || (u.role !== "admin" && u.role !== "volunteer")) return fail(400, "Pick someone on the team.", { code: "bad_assignee" });
      set.assigneeId = u._id;
      set.assigneeName = String(u.name || u.email || "").slice(0, 80);
    }
  }
  if (a.status === "in_progress" && a.assignee === undefined && !q.assigneeId) { set.assigneeId = actor.id; set.assigneeName = actor.name; }
  const after = await MediaQuery.findByIdAndUpdate(q._id, { $set: set, $inc: { rev: 1 } }, { returnDocument: "after" }).lean();
  const ev = await appendEvent({
    kind: "query", subject: q.subject || "", clientAt: a.clientAt, station: a.station, byId: actor.id, byName: actor.name, byRole: actor.role,
    clientId: a.clientId, query: after, ...queuedFields(ctx.recordedBy),
  });
  if (ctx.staff && (a.status === "done" || (a.assignee !== undefined && a.assignee !== "me"))) {
    await audit(actor, "checkin_desk_media_query", String(q._id), `Media query “${q.request.slice(0, 80)}” (${q.who || "?"}): ${a.status ? `status → ${a.status}` : ""}${a.assignee !== undefined ? ` assignee → ${after.assigneeName || "nobody"}` : ""}`, ctx.recordedBy);
  }
  return { ok: true, events: view([ev]), query: queryView(after) };
}

/* ---------- NO DETAILS FOUND (contract C8) ---------- */

/** A NO DETAILS FOUND card by its key ("u:<clientId>"): its arrival event (or null), whether it was undone, and how
    the pass desk closed it (the last unknown_done / unknown_link event, or null). */
async function unknownCard(key) {
  if (!isUnknownKey(key)) return { arrival: null, undone: false, closed: null };
  const [arrival, after] = await Promise.all([
    CheckinEvent.findOne({ clientId: key.slice(2), kind: "unknown_arrival" }).lean(),
    CheckinEvent.find({ kind: { $in: ["undo", "unknown_done", "unknown_link"] }, subject: key }).sort({ seq: 1 }).lean(),
  ]);
  const closes = after.filter((e) => e.kind !== "undo");
  return { arrival, undone: after.some((e) => e.kind === "undo"), closed: closes[closes.length - 1] || null };
}
const closedText = (e) => `${UNKNOWN_OUTCOME_TEXT[e.kind === "unknown_link" ? "linked" : e.outcome] || "closed"} at ${whenText(e.at)}${e.byName ? ` by ${e.byName}` : ""}`;

/** The lobby couldn't find them: the arrival as typed, for the pass desk's card (no mark, no ticket, any hour). */
async function doUnknownArrival(a, ctx, actor, view) {
  const now = deskNow();
  const clock = tapClock(a.clientAt, now);
  const state = stationState({ station: "lobby", at: clock.at, windows: ctx.windows });
  const ev = await appendEvent({
    kind: "unknown_arrival", subject: unknownKeyOf(a.clientId), day: state.date, clientAt: a.clientAt, arrivedAt: clock.at, station: a.station,
    byId: actor.id, byName: actor.name, byRole: actor.role, clientId: a.clientId, name: a.name, company: a.company || "", note: a.note || "",
    ...(!state.eventDay ? { practice: true } : {}), ...(clock.late ? { lateSync: true } : {}), ...queuedFields(ctx.recordedBy),
  });
  return { ok: true, events: view([ev]), event: ev };
}

/** Undo the lobby's NO DETAILS FOUND arrival (canUndo has allowed it): the card goes. */
async function undoUnknownArrival(a, ctx, actor, view, target) {
  const key = unknownKeyOf(target.clientId);
  if ((await unknownCard(key)).undone) return { ok: true, events: [], noop: true, message: "Nothing to undo: it was already undone." };
  const ev = await appendEvent({
    kind: "undo", subject: key, day: target.day, clientAt: a.clientAt, station: a.station, byId: actor.id, byName: actor.name, byRole: actor.role,
    clientId: a.clientId, ref: target.clientId, refPoint: "unknown_arrival", ...queuedFields(ctx.recordedBy),
  });
  if (String(target.byId) !== String(actor.id)) {
    await audit(actor, "checkin_desk_undo", key, `Undid a NO DETAILS FOUND arrival (“${target.name || "?"}”) at ${STATION_LABELS[a.station] || a.station} (tap by ${target.byName || "someone else"})`, ctx.recordedBy);
  }
  return { ok: true, events: view([ev]) };
}

/** The pass desk closes a card: sent to the help desk, pass issued, or left. */
async function doUnknownDone(a, ctx, actor, view) {
  const card = await unknownCard(a.target);
  if (!card.arrival) return fail(404, "That arrival isn't on the list any more. Refresh and try again.", { code: "not_found" });
  if (card.undone) return { ok: true, events: [], noop: true, message: "The lobby undid that arrival: nothing to close." };
  if (card.closed) return { ok: true, already: true, events: [], message: `Already closed: ${closedText(card.closed)}` };
  const ev = await appendEvent({
    kind: "unknown_done", subject: a.target, day: card.arrival.day, clientAt: a.clientAt, station: a.station, byId: actor.id, byName: actor.name,
    byRole: actor.role, clientId: a.clientId, ref: a.target, outcome: a.outcome, ...queuedFields(ctx.recordedBy),
  });
  return { ok: true, events: view([ev]) };
}

/** Staff found them on the list ("Found them"): that guest is marked arrived when the lobby recorded them, the card
    closes, and it's audited. */
async function doUnknownLink(a, ctx, actor, view) {
  const card = await unknownCard(a.target);
  if (!card.arrival) return fail(404, "That arrival isn't on the list any more. Refresh and try again.", { code: "not_found" });
  if (card.undone) return { ok: true, events: [], noop: true, message: "The lobby undid that arrival: nothing to close." };
  if (card.closed?.kind === "unknown_link") return { ok: true, already: true, events: [], message: `Already ${closedText(card.closed)}` };
  const hit = await ctx.resolve(a.guestKey);
  if (!hit) return fail(404, "This guest isn't on the list any more. Refresh and try again.", { code: "not_found" });
  const at = card.arrival.arrivedAt || card.arrival.at;
  const state = stationState({ station: "lobby", at, windows: ctx.windows });
  const day = card.arrival.day || state.date;
  const res = await setMark({ subject: hit.norm, day, point: "arrived", at, actor, station: "lobby", ref: a.clientId, practice: !state.eventDay, recordedBy: ctx.recordedBy });
  const ev = await appendEvent({
    kind: "unknown_link", subject: a.target, day, clientAt: a.clientAt, station: a.station, byId: actor.id, byName: actor.name, byRole: actor.role,
    clientId: a.clientId, ref: a.target, guestKey: a.guestKey, marks: res.changed ? [res.doc] : undefined, ...queuedFields(ctx.recordedBy),
  });
  const typed = `“${card.arrival.name || "?"}”${card.arrival.company ? ` (${card.arrival.company})` : ""}`;
  await audit(actor, "checkin_desk_unknown_link", hit.norm,
    `NO DETAILS FOUND arrival ${typed}, lobby ${whenText(at)}, found on the list: ${auditLine({ guest: hit.guest, kind: "mark", point: "arrived", station: a.station })}`, ctx.recordedBy);
  if (!res.changed) {
    const d = res.doc;
    return { ok: true, already: true, events: view([ev]), mark: markView(d), message: `Already marked arrived at ${whenText(d.at)}${d.byName ? ` by ${d.byName}` : ""}` };
  }
  return { ok: true, events: view([ev]), mark: markView(res.doc) };
}

/* ---------- The door's QR scanner (routes/checkin.js) ---------- */

/**
 * A QR scan at the door also checks the guest in on the desk app for today: success = the scan just collected the pass
 * (it set checkedIn / checkedInAt); already = collected before (Day 2, or a second scan): today's check-in is still
 * recorded once. Never fails the scan (errors are logged). The door route answers the scanner first and calls this
 * after (routes/checkin.js), so it adds nothing to the scan's wait. → the event, or null.
 */
export async function recordScan({ ticketId, user, outcome, collectedAt = null }) {
  try {
    const subject = normalizeTicketId(ticketId);
    if (!subject || !user) return null;
    const actor = actorOf(user, user.role === "admin");
    const at = deskNow();
    const day = stationState({ station: "desk", at }).date;
    const ref = `scan-${crypto.randomBytes(8).toString("hex")}`;
    const passSetAt = outcome === "success" && collectedAt ? new Date(collectedAt) : null;
    const res = await setMark({ subject, day, point: "checked_in", at, actor, station: "scanner", ref, passSetAt });
    if (!res.changed) return null;
    const changed = [res.doc];
    const [arr, now] = await Promise.all([
      setMark({ subject, day, point: "arrived", at, actor, station: "scanner", ref }),
      // The scan just collected it: that's the time; otherwise when it was collected before.
      passSetAt ? { collected: true, at: passSetAt } : collectedAt_(subject),
    ]);
    if (arr.changed) changed.push(arr.doc);
    return await appendEvent({
      kind: "mark", point: "checked_in", subject, day, station: "scanner", byId: actor.id, byName: actor.name, byRole: actor.role, clientId: ref,
      marks: changed, pass: { ticketId: subject, collected: now.collected, collectedAt: now.at },
    });
  } catch (err) {
    console.error("CHECKIN DESK SCAN ERROR:", err?.message || err);
    return null;
  }
}
const collectedAt_ = (subject) => collectedAt(variantsOf([subject]));

export { POINT_LABELS, fmtClock };
