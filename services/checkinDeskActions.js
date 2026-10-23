import crypto from "node:crypto";
import CheckinMark from "../models/CheckinMark.js";
import MediaQuery from "../models/MediaQuery.js";
import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import { AdminAudit } from "../models/Admin.js";
import {
  POINTS, POINT_LABELS, STAFF_KINDS, auditLine, boothSubject, canUndo, entitlement, eventView, markView, mealStationOf, queryView, tapTime,
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
========================================================= */

const fail = (status, error, extra = {}) => ({ ok: false, status, error, ...extra });
const isDup = (err) => err?.code === 11000;

/** The person acting, as marks and events store them. */
export const actorOf = (user, staff) => ({ id: user._id, name: String(user.name || user.email || "").trim().slice(0, 80), role: staff ? "staff" : "volunteer" });

async function audit(actor, action, targetId, detail) {
  await AdminAudit.create({ adminId: actor.id, adminName: actor.name, action, targetType: "checkin_desk", targetId: String(targetId || ""), detail: String(detail).slice(0, 500) }).catch(() => {});
}

/* ---------- Marks ---------- */

const CLEARED = { at: null, byId: null, byName: "", byRole: "", station: "", ref: "", override: "", note: "", item: "", passSetAt: null };

/** Set a mark if it isn't set. → { doc, changed, mine } (mine: it was already set by this very tap). */
async function setMark({ subject, day, point, at, actor, station, ref, override = "", note = "", item = "" }) {
  const set = { at, byId: actor.id, byName: actor.name, byRole: actor.role, station, ref, override, note, item, passSetAt: null };
  try {
    const doc = await CheckinMark.findOneAndUpdate({ subject, day, point, at: null }, { $set: set, $inc: { rev: 1 } }, { upsert: true, returnDocument: "after" }).lean();
    return { doc, changed: true, mine: false };
  } catch (err) {
    if (!isDup(err)) throw err;
    const doc = await CheckinMark.findOne({ subject, day, point }).lean();
    if (!doc) throw err;
    // Cleared in between (rare): try once more.
    if (!doc.at) return setMark({ subject, day, point, at, actor, station, ref, override, note, item });
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
  const u = await User.updateOne({ tickets: { $elemMatch: { ticketId: { $in: variants }, checkedIn: { $ne: true } } } },
    { $set: { "tickets.$.checkedIn": true, "tickets.$.checkedInAt": at } });
  const a = await Attendee.updateMany({ ticketId: { $in: variants }, checkedIn: { $ne: true } }, { $set: { checkedIn: true, checkedInAt: at } });
  const now = await collectedAt(variants);
  return { set: (u.modifiedCount || 0) + (a.modifiedCount || 0) > 0, collected: now.collected, at: now.at };
}

/** Take back a pass collection made at exactly `at` (by the check-in being undone). */
async function uncollectPass(ids, at) {
  const variants = variantsOf(ids);
  await User.updateOne({ tickets: { $elemMatch: { ticketId: { $in: variants }, checkedInAt: at } } },
    { $set: { "tickets.$.checkedIn": false }, $unset: { "tickets.$.checkedInAt": 1 } });
  await Attendee.updateMany({ ticketId: { $in: variants }, checkedInAt: at }, { $set: { checkedIn: false }, $unset: { checkedInAt: 1 } });
  const now = await collectedAt(variants);
  return { collected: now.collected, at: now.at };
}

/* ---------- Actions ---------- */

/**
 * One action (cleanAction's value) by `user`.
 *   ctx: { user, staff, resolve(key) → { guest, norm } | null, booth(key) → booth | null, windows, stationOn(station) }
 * → { ok: true, events: [view], already?, mark?, query?, message? } | { ok: false, status, error, code? }
 */
export async function performAction(action, ctx) {
  const { user, staff } = ctx;
  const actor = actorOf(user, staff);
  const view = (evs) => evs.map((e) => eventView(e, { staff }));
  if (STAFF_KINDS.includes(action.kind) && !staff) return fail(403, "Only staff can do that.", { code: "staff_only" });

  // The same tap again: answer from what it did.
  const prior = await eventForClientId(action.clientId);
  if (prior) return { ok: true, duplicate: true, events: view([prior]) };

  try {
    switch (action.kind) {
      case "mark": return await doMark(action, ctx, actor, view);
      case "undo": return await doUndo(action, ctx, actor, view);
      case "reset": return await doReset(action, ctx, actor, view);
      case "note": return await doNote(action, ctx, actor, view);
      case "query_add": return await doQueryAdd(action, ctx, actor, view);
      case "query_update": return await doQueryUpdate(action, ctx, actor, view);
      default: return fail(400, "Unknown action.");
    }
  } catch (err) {
    if (err instanceof DuplicateTap) {
      const ev = await eventForClientId(action.clientId);
      return { ok: true, duplicate: true, events: ev ? view([ev]) : [] };
    }
    throw err;
  }
}

function whenText(at) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Toronto", hour: "numeric", minute: "2-digit" }).format(new Date(at));
}

async function doMark(a, ctx, actor, view) {
  const point = a.point;
  const pointStation = POINTS[point];
  const at = tapTime(a.clientAt, deskNow());
  if (!ctx.stationOn(pointStation)) return fail(409, `${STATION_LABELS[pointStation]} is switched off.`, { code: "station_off" });

  let guest = null;
  let booth = null;
  let subject;
  if (point === "booth") {
    booth = ctx.booth(a.key);
    if (!booth) return fail(404, "That booth isn't on the exhibitor list. Refresh and try again.", { code: "not_found" });
    subject = boothSubject(a.key);
  } else {
    const hit = await ctx.resolve(a.key);
    if (!hit) return fail(404, "This guest isn't on the list any more. Refresh and try again.", { code: "not_found" });
    guest = hit.guest;
    subject = hit.norm;
  }

  // Time-appropriate: today's event day and the station's window, at the moment of the tap.
  const state = stationState({ station: pointStation, at, windows: ctx.windows });
  const day = state.date;
  if (!state.open && !a.override) {
    return fail(409, `${state.text}. Tap “Admit anyway” to record it.`, { code: "outside_window", window: { text: state.text, detail: state.detail, code: state.code } });
  }
  const override = state.open ? "" : "outside_window";

  // Meals and evenings: the guest's pass must include today's item (staff switch it on first; volunteers send them to staff).
  const mealStation = mealStationOf(point);
  let item = null;
  if (mealStation) {
    const ent = entitlement(guest, mealStation, state.eventDay);
    item = ent.item;
    if (item && !ent.included) {
      return fail(409, `Not on their pass: ${item.label}. ${ctx.staff ? "Switch it on for this pass first." : "Send them to a staff member."}`, { code: "not_included", item });
    }
  }

  const ref = a.clientId;
  const res = await setMark({ subject, day, point, at, actor, station: a.station, ref, override, note: point === "av" ? a.note || "" : "", item: item?.key || "" });
  if (!res.changed && !res.mine) {
    const d = res.doc;
    const what = { checked_in: "Already checked in", arrived: "Already marked arrived", booth: "Booth already set up", av: "AV already checked" }[point]
      || (mealStation ? "Already admitted" : point.startsWith("flag_") ? "Already sent to staff" : "Already checked in");
    return { ok: true, already: true, events: [], mark: markView(d), message: `${what} at ${whenText(d.at)}${d.byName ? ` by ${d.byName}` : ""}` };
  }
  const changed = [res.doc];
  let pass;
  if (point === "checked_in") {
    // Checked in at the desk means they arrived too (attendance for the day), and their pass is now collected.
    const arr = await setMark({ subject, day, point: "arrived", at, actor, station: a.station, ref, override });
    if (arr.changed || arr.mine) changed.push(arr.doc);
    const ids = guest ? [guest.ticketIds[guest.norms.indexOf(subject)] || subject, subject] : [subject];
    const p = await collectPass(ids, at);
    if (p.set) {
      const upd = await CheckinMark.findOneAndUpdate({ _id: res.doc._id, ref }, { $set: { passSetAt: at }, $inc: { rev: 1 } }, { returnDocument: "after" }).lean();
      if (upd) changed[0] = upd;
    }
    pass = { ticketId: subject, collected: p.collected, collectedAt: p.at };
  }
  const ev = await appendEvent({
    kind: "mark", point, subject, day, clientAt: a.clientAt, station: a.station, byId: actor.id, byName: actor.name, byRole: actor.role,
    clientId: a.clientId, override, note: point === "av" ? a.note || "" : "", marks: changed, pass,
  });
  if (override) await audit(actor, "checkin_desk_override", subject, auditLine({ guest, booth, kind: "mark", point, station: a.station, override, item }));
  return { ok: true, events: view([ev]), mark: markView(changed[0]) };
}

async function doUndo(a, ctx, actor, view) {
  const target = await eventForClientId(a.ref);
  const allowed = canUndo({ target, actorId: String(actor.id), staff: ctx.staff, undoClientAt: a.clientAt, now: deskNow() });
  if (!allowed.ok) return fail(allowed.status, allowed.error, { code: "undo_refused" });
  const { subject, day, point } = target;
  if (point === "arrived") {
    const desk = await CheckinMark.findOne({ subject, day, point: "checked_in", at: { $ne: null } }).lean();
    if (desk && desk.ref !== target.clientId) return fail(409, "They're already checked in at the pass desk. A staff member can reset them there.", { code: "checked_in" });
  }
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
  if (!changed.length) return { ok: true, events: [], noop: true, message: "Nothing to undo: it was already undone." };
  const ev = await appendEvent({
    kind: "undo", point, subject, day, clientAt: a.clientAt, station: a.station, byId: actor.id, byName: actor.name, byRole: actor.role,
    clientId: a.clientId, ref: target.clientId, refPoint: point, marks: changed, pass,
  });
  if (String(target.byId) !== String(actor.id)) {
    const hit = subject.startsWith("booth:") ? null : await ctx.resolveNorm?.(subject);
    await audit(actor, "checkin_desk_undo", subject, `${auditLine({ guest: hit, kind: "undo", point, station: a.station })} (tap by ${target.byName || "someone else"})`);
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
  // today gives it back.
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
    clientId: a.clientId, marks: changed, pass,
  });
  await audit(actor, "checkin_desk_reset", subjects[0], auditLine({ guest, booth, kind: "reset", point: a.point, station: a.station }));
  return { ok: true, events: view([ev]) };
}

async function doNote(a, ctx, actor, view) {
  const hit = await ctx.resolve(a.key);
  if (!hit) return fail(404, "This guest isn't on the list any more.", { code: "not_found" });
  const subject = hit.guest.norm;
  const ev = await appendEvent({
    kind: "note", subject, clientAt: a.clientAt, station: a.station, byId: actor.id, byName: actor.name, byRole: actor.role,
    clientId: a.clientId, note: a.note,
  });
  await audit(actor, "checkin_desk_note", subject, auditLine({ guest: hit.guest, kind: "note", note: a.note, station: a.station }));
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
    query: q.toObject ? q.toObject() : q,
  });
  return { ok: true, events: view([ev]), query: queryView(q) };
}

async function doQueryUpdate(a, ctx, actor, view) {
  const q = await MediaQuery.findById(a.id).lean();
  if (!q) return fail(404, "That query isn't on the list any more.", { code: "not_found" });
  const mine = String(q.assigneeId || "") === String(actor.id);
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
    clientId: a.clientId, query: after,
  });
  if (ctx.staff && (a.status === "done" || (a.assignee !== undefined && a.assignee !== "me"))) {
    await audit(actor, "checkin_desk_media_query", String(q._id), `Media query “${q.request.slice(0, 80)}” (${q.who || "?"}): ${a.status ? `status → ${a.status}` : ""}${a.assignee !== undefined ? ` assignee → ${after.assigneeName || "nobody"}` : ""}`);
  }
  return { ok: true, events: view([ev]), query: queryView(after) };
}

/* ---------- The door's QR scanner (routes/checkin.js) ---------- */

/**
 * A QR scan at the door also checks the guest in on the desk app for today: success = the scan just collected the pass
 * (it set checkedIn / checkedInAt); already = collected before (Day 2, or a second scan): today's check-in is still
 * recorded once. Never fails the scan (errors are logged). → the event, or null.
 */
export async function recordScan({ ticketId, user, outcome, collectedAt = null }) {
  try {
    const subject = normalizeTicketId(ticketId);
    if (!subject || !user) return null;
    const actor = actorOf(user, user.role === "admin");
    const at = deskNow();
    const day = stationState({ station: "desk", at }).date;
    const ref = `scan-${crypto.randomBytes(8).toString("hex")}`;
    const res = await setMark({ subject, day, point: "checked_in", at, actor, station: "scanner", ref });
    if (!res.changed) return null;
    const changed = [res.doc];
    if (outcome === "success" && collectedAt) {
      const upd = await CheckinMark.findOneAndUpdate({ _id: res.doc._id, ref }, { $set: { passSetAt: new Date(collectedAt) }, $inc: { rev: 1 } }, { returnDocument: "after" }).lean();
      if (upd) changed[0] = upd;
    }
    const arr = await setMark({ subject, day, point: "arrived", at, actor, station: "scanner", ref });
    if (arr.changed) changed.push(arr.doc);
    const now = await collectedAt_(subject);
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
