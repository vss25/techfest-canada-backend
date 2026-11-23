import express from "express";
import mongoose from "mongoose";
import Order from "../models/Order.js";
import Outreach from "../models/Outreach.js";
import Commitment from "../models/Commitment.js";
import { AdminAudit } from "../models/Admin.js";
import { requireAdmin, isManagement } from "../middleware/adminAuth.js";
import { soldForEvent } from "../services/ticketSales.js";
import { directory } from "./people.js";
import { SANITY_PROJECT } from "../services/rsvp.js";
import { addDays, torontoDay } from "../services/commitments.js";
import { OUTREACH, ROLES, cleanOutreach, pastOrgs, pastPeople, withOutreach } from "../services/pastParticipants.js";

/* =========================================================
   Sales for ONE event (Nov 20 2026). Mounted at /api/console/sales-event before the console router.

     GET  /past?event=<eventKey>   (any staff) → { event, rows, counts, roles, statuses, partnersLoaded }
          People and organisations from earlier events who aren't part of this one yet
          (services/pastParticipants.js): what they were, and whether someone reached out about this event.
     POST /reach { event, kind: person|org, key, name, role, eventName? } → 201 { outreach, task }
          Records "we reached out" and adds a task for the person who clicked (due in 3 days).
     PATCH /reach/:id { status?, note? } → { outreach }
     GET  /summary?event=<eventKey> (management) → { event, orders, tickets, ownTickets, passTickets, passes,
          subtotalCents, totalCents }: what this event has actually sold (paid orders for it). tickets = its own
          tickets + multi-event passes covering it (Nov 22 2026); revenue is only orders placed on this event.
   Private: MongoDB only. Audited (outreach_*; names only).
========================================================= */

const router = express.Router();
export default router;

export const salesEventDeps = {
  /** Website partners with the events each is linked to. Replaced in tests. */
  partners: async () => {
    const q = `*[_type=="partner" && !(_id in path("drafts.**")) && active != false]{_id,name,url,matrixGroup,"events":events[]._ref}`;
    const r = await fetch(`https://${SANITY_PROJECT}.apicdn.sanity.io/v2021-10-21/data/query/production?query=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(`partners ${r.status}`);
    return (await r.json()).result || [];
  },
  people: () => directory(),
};

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error("SALES EVENT ERROR:", err?.message || err);
  if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Try again." });
});
const who = (req) => String(req.user?.name || req.user?.email || "Staff").slice(0, 120);
const eventOf = (v) => (/^[a-z0-9-]{1,80}$/.test(String(v || "")) ? String(v) : "");
const audit = (req, action, id, detail) => AdminAudit.create({ adminId: req.user._id, adminName: req.user.name, action, targetType: "outreach",
  targetId: String(id).slice(0, 120), detail: String(detail).slice(0, 500) }).catch(() => {});
const dto = (o) => ({ id: String(o._id), status: o.status, byName: o.byName || "", at: o.at ? new Date(o.at).toISOString() : null, note: o.note || "" });

router.use(requireAdmin);

router.get("/past", wrap(async (req, res) => {
  const event = eventOf(req.query.event);
  if (!event) return res.status(400).json({ error: "Choose an event first." });
  const [d, partners, outreach] = await Promise.all([
    salesEventDeps.people(),
    salesEventDeps.partners().catch(() => null),
    Outreach.find({ eventKey: event }).lean(),
  ]);
  const rows = [...pastOrgs(partners || [], `event-${event}`), ...pastPeople(d.people, event)];
  const { list, counts } = withOutreach(rows, outreach);
  res.json({ event, rows: list, counts, roles: ROLES, statuses: OUTREACH, partnersLoaded: partners !== null });
}));

router.post("/reach", wrap(async (req, res) => {
  const b = req.body || {};
  const event = eventOf(b.event);
  const kind = b.kind === "org" ? "org" : b.kind === "person" ? "person" : "";
  const key = String(b.key || "").trim().slice(0, 120);
  const name = String(b.name || "").trim().slice(0, 160);
  if (!event || !kind || !key || !name) return res.status(400).json({ error: "That person or organisation couldn't be found. Refresh the page and try again." });
  const role = ROLES.includes(b.role) ? b.role : "";
  const eventName = String(b.eventName || "").trim().slice(0, 120) || event;
  let o;
  try {
    o = await Outreach.create({ eventKey: event, kind, key, name, role, status: "contacted", byId: req.user._id, byName: who(req), at: new Date() });
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const had = await Outreach.findOne({ eventKey: event, kind, key }).lean();
    return res.status(409).json({ error: `${had?.byName || "Someone"} already reached out to them about this event.`, outreach: had ? dto(had) : null });
  }
  const task = await Commitment.create({ title: `Follow up with ${name} about ${eventName}`.slice(0, 200), area: kind === "org" ? "partners" : "sales",
    about: name, eventKey: event, dueDate: addDays(torontoDay(), 3), ownerId: req.user._id, ownerName: who(req), source: "reconnect",
    createdById: req.user._id, createdByName: who(req),
    notes: `They took part before${role ? ` as ${role.toLowerCase()}` : ""}. You reached out about ${eventName}; follow up if they haven't answered.` }).catch(() => null);
  audit(req, "outreach_add", o._id, `${name} · ${eventName}`);
  res.status(201).json({ outreach: dto(o), task: task ? { id: String(task._id), dueDate: task.dueDate } : null });
}));

router.patch("/reach/:id", wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const o = await Outreach.findById(req.params.id);
  if (!o) return res.status(404).json({ error: "Not found" });
  const b = req.body || {};
  if ("status" in b) { const s = cleanOutreach(b.status); if (!s) return res.status(400).json({ error: "Pick a status from the list." }); o.status = s; }
  if ("note" in b) o.note = String(b.note ?? "").trim().slice(0, 1000);
  await o.save();
  audit(req, "outreach_edit", o._id, `${o.name}: ${o.status}`);
  res.json({ outreach: dto(o) });
}));

router.get("/summary", wrap(async (req, res) => {
  if (!isManagement(req.user)) return res.status(403).json({ error: "Management only", code: "management_only" });
  const event = eventOf(req.query.event);
  if (!event) return res.status(400).json({ error: "Choose an event first." });
  const orders = await Order.find({ eventKey: event, status: { $in: ["paid", "fulfilled"] } }).select("amounts items").lean();
  const sum = (f) => orders.reduce((n, o) => n + (Number(o.amounts?.[f]) || 0), 0);
  // Tickets = this event's own tickets + multi-event passes covering it (Nov 22 2026: pass holders count
  // towards every event's delegate target). Revenue stays with the event the order was placed on.
  const sold = await soldForEvent(event);
  res.json({ event, orders: orders.length, tickets: sold.ownTickets + sold.passTickets, ownTickets: sold.ownTickets, passTickets: sold.passTickets,
    passes: sold.passes, subtotalCents: sum("subtotalCents"), totalCents: sum("totalCents") });
}));
