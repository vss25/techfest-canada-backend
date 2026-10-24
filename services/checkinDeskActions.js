import crypto from "node:crypto";
import CheckinMark from "../models/CheckinMark.js";
import MediaQuery from "../models/MediaQuery.js";
import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import { AdminAudit } from "../models/Admin.js";
import CheckinEvent from "../models/CheckinEvent.js";
import {
  POINTS, POINT_LABELS, STAFF_KINDS, auditLine, boothSubject, canUndo, entitlement, eventView, markView, mealStationOf, queryView, tapClock,
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
        recorded (and one recorded meanwhile is taken back at once).
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
========================================================= */

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

/** Clear a mark (only if `ref` set it, when given). → the row after, or null when nothing changed. */
function clearMark({ subject, day, point, ref = "" }) {
  return CheckinMark.findOneAndUpdate({ subject, day, point, at: { $ne: null }, ...(ref ? { ref } : {}) }, { $set: CLEARED, $inc: { rev: 1 } }, { returnDocument: "after" }).lean();
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

/* ---------- Actions ---------- */

/** May this undo (by its stored event) take back a tap by `actor`? Its own author, or staff. */
const undoCovers = (undo, actor) => !!undo && (undo.byRole === "staff" || (!!undo.byId && !!actor.id && String(undo.byId) === String(actor.id)));
/** An undo (or tombstone) of this tap that may take it back (undoCovers: staff's, or the tap's own author's), if one is
    stored: any of them, not just the first one stored (someone else's tombstone, which can't take the tap back, never
    hides the author's own). */
async function undoOf(clientId, actor) {
  if (!clientId) return null;
  const who = [{ byRole: "staff" }, ...(actor?.id ? [{ byId: actor.id }] : [])];
  const undo = await CheckinEvent.findOne({ kind: "undo", ref: clientId, $or: who }).sort({ seq: 1 }).lean();
  return undoCovers(undo, actor) ? undo : null;
}

/**
 * One action (cleanAction's value) by `user`.
 *   ctx: { user, staff, resolve(key) → { guest, norm } | null, booth(key) → booth | null, windows, stationOn(station),
 *          freshGuest?(hit) → the guest with their inclusions read from the database now (meal stations) }
 * → { ok: true, events: [view], already?, mark?, query?, message?, tombstone?, undone? } | { ok: false, status, error, code? }
 */
export async function performAction(action, ctx) {
  const who = await whoTapped(action, ctx);
  const { actor, staff, recordedBy } = who;
  const c = { ...ctx, staff, recordedBy, signedInStaff: !!ctx.staff };
  const view = (evs) => evs.map((e) => eventView(e, { staff }));
  if (STAFF_KINDS.includes(action.kind) && !staff) return fail(403, "Only staff can do that.", { code: "staff_only" });

  // The same tap again: answer from what it did.
  const prior = await eventForClientId(action.clientId);
  if (prior) return { ok: true, duplicate: true, events: view([prior]) };

  // Undone on the device before it reached the server (a tombstone, contract C2): not recorded.
  if (action.kind === "mark") {
    const undo = await undoOf(action.clientId, actor);
    if (undo) return { ok: true, undone: true, events: [], message: "Undone on the device before it reached the server: not recorded." };
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
      default: return fail(400, "Unknown action.");
    }
    // A tombstone stored while this tap was being recorded (the same device, two requests in flight): take it back.
    if (r.ok && !r.already) await settleUndone(action.clientId, actor);
    return r;
  } catch (err) {
    if (err instanceof DuplicateTap) {
      const ev = await eventForClientId(action.clientId);
      // Recorded twice at once and undone in between: make sure it ends undone.
      if (action.kind === "mark") await settleUndone(action.clientId, actor);
      return { ok: true, duplicate: true, events: ev ? view([ev]) : [] };
    }
    throw err;
  }
}

/** If an undo of this tap is stored, make sure its marks are cleared (an undo that raced the tap). */
async function settleUndone(clientId, actor) {
  const undo = await undoOf(clientId, actor);
  if (!undo) return;
  const target = await eventForClientId(clientId);
  if (!target || target.kind !== "mark") return;
  const { changed, pass } = await clearTap(target);
  if (!changed.length) return;
  await appendEvent({
    kind: "undo", point: target.point, subject: target.subject, day: target.day, station: target.station, byId: undo.byId, byName: undo.byName,
    byRole: undo.byRole, ref: clientId, refPoint: target.point, marks: changed, pass,
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
    if (!practice) {
      const ids = guest ? [guest.ticketIds[guest.norms.indexOf(subject)] || subject, subject] : [subject];
      const p = await collectPass(ids, at);
      if (p.set) {
        const upd = await CheckinMark.findOneAndUpdate({ _id: res.doc._id, ref }, { $set: { passSetAt: at }, $inc: { rev: 1 } }, { returnDocument: "after" }).lean();
        if (upd) changed[0] = upd;
      }
      pass = { ticketId: subject, collected: p.collected, collectedAt: p.at };
    }
  }
  const ev = await appendEvent({
    kind: "mark", point, subject, day, clientAt: a.clientAt, station: a.station, byId: actor.id, byName: actor.name, byRole: actor.role,
    clientId: a.clientId, override, note: point === "av" ? a.note || "" : "", marks: changed, pass,
    ...(practice ? { practice: true } : {}), ...(clock.late ? { lateSync: true } : {}), ...queuedFields(ctx.recordedBy),
  });
  if (override) await audit(actor, "checkin_desk_override", subject, auditLine({ guest, booth, kind: "mark", point, station: a.station, override, item }), ctx.recordedBy);
  if (lateNote) await audit(actor, "checkin_desk_late_sync", subject, `${auditLine({ guest, booth, kind: "mark", point, station: a.station, item })}: ${lateNote}`, ctx.recordedBy);
  return { ok: true, events: view([ev]), mark: markView(changed[0]) };
}

/** Clear exactly what a tap (its stored event) set, and give back a pass collection it made. → { changed, pass } */
async function clearTap(target) {
  const { subject, day, point } = target;
  const changed = [];
  let pass;
  if (point === "checked_in") {
    const before = await CheckinMark.findOne({ subject, day, point, ref: target.clientId, at: { $ne: null } }).lean();
    const cleared = await clearMark({ subject, day, point, ref: target.clientId });
    if (cleared) {
      changed.push(cleared);
      const arr = await clearMark({ subject, day, point: "arrived", ref: target.clientId });
      if (arr) changed.push(arr);
      if (before?.passSetAt) {
        const p = await uncollectPass([subject], before.passSetAt);
        pass = { ticketId: subject, collected: p.collected, collectedAt: p.at };
      }
    }
  } else {
    const cleared = await clearMark({ subject, day, point, ref: target.clientId });
    if (cleared) changed.push(cleared);
  }
  return { changed, pass };
}

async function doUndo(a, ctx, actor, view) {
  const target = await eventForClientId(a.ref);
  if (!target) {
    // The tap hasn't reached the server (or never will): a tombstone, so it isn't recorded when it does (contract C2).
    if (!actor.id && !ctx.staff) return fail(403, "You can only undo your own taps. Ask a staff member.", { code: "undo_refused" });
    const ev = await appendEvent({
      kind: "undo", tombstone: true, ref: a.ref, clientAt: a.clientAt, station: a.station, byId: actor.id, byName: actor.name, byRole: actor.role,
      clientId: a.clientId, ...queuedFields(ctx.recordedBy),
    });
    return { ok: true, tombstone: true, events: view([ev]), message: "Undone. That tap hadn't reached the server, and it won't be recorded." };
  }
  if (!actor.id && !ctx.staff) return fail(403, "You can only undo your own taps. Ask a staff member.", { code: "undo_refused" });
  // Queued offline by someone else (contract C3): a volunteer sign-in only sends undos of taps sent from it (canUndo).
  const signedInId = ctx.recordedBy && !ctx.signedInStaff ? String(ctx.recordedBy.id) : "";
  const allowed = canUndo({ target, actorId: String(actor.id), staff: ctx.staff, undoClientAt: a.clientAt, now: deskNow(), signedInId });
  if (!allowed.ok) return fail(allowed.status, allowed.error, { code: "undo_refused" });
  const { subject, day, point } = target;
  if (point === "arrived") {
    const desk = await CheckinMark.findOne({ subject, day, point: "checked_in", at: { $ne: null } }).lean();
    if (desk && desk.ref !== target.clientId) return fail(409, "They're already checked in at the pass desk. A staff member can reset them there.", { code: "checked_in" });
  }
  const { changed, pass } = await clearTap(target);
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
      const before = await CheckinMark.findOne({ subject, day, point, at: { $ne: null } }).lean();
      if (!before) continue;
      const cleared = await clearMark({ subject, day, point });
      if (!cleared) continue;
      changed.push(cleared);
      if (point === "checked_in" && before.passSetAt) {
        const p = await uncollectPass([subject], before.passSetAt);
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
