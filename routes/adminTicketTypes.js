import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import TicketType from "../models/TicketType.js";
import { requireAdmin, requireManagement } from "../middleware/adminAuth.js";
import { recordAudit } from "../services/auditLog.js";
import Order from "../models/Order.js";
import { DEFAULT_BRIEFING_KEY, copyOf, ticketTypeKey, usesBriefingDefaults } from "../services/ticketTypeDefaults.js";

const router = express.Router();

const authMiddleware = (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "No token provided" });
    }
    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
};

// Ticket types are staff-only, like events (routes/adminEvents.js) and the
// sales CRM (routes/leads.js). Routes check the database, not the token's
// "role" claim, so removing someone's staff access takes effect immediately.
const adminMiddleware = (req, res, next) => requireAdmin(req, res, next);
// Reading the list is any staff; creating, changing and removing ticket types
// (prices, capacity, sales windows) is management only (Nov 2026).

// Fields a create/update may set. eventKey is set at create and never changes.
const EDITABLE = [
  "name", "slug", "description", "inclusions", "exclusions", "priceCents",
  "currency", "capacity", "active", "salesStart", "salesEnd", "sortOrder"
];

// Returns an error message, or null when the value is a valid string list.
function stringListError(v, field) {
  if (v === undefined) return null;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    return `${field} must be a list of strings`;
  }
  return null;
}

// Validates the ticket-type fields present in `body`. Returns an error
// message, or null. `creating` additionally requires eventKey/name/price.
function ticketTypeError(body, { creating = false } = {}) {
  if (creating) {
    if (typeof body.eventKey !== "string" || !body.eventKey.trim()) {
      return "eventKey is required";
    }
    if (typeof body.name !== "string" || !body.name.trim()) {
      return "name is required";
    }
    if (body.priceCents === undefined) return "priceCents is required";
  }
  if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim())) {
    return "name must be a non-empty string";
  }
  if (body.priceCents !== undefined) {
    const p = Number(body.priceCents);
    if (!Number.isInteger(p) || p < 0) {
      return "priceCents must be a whole number of cents, 0 or more";
    }
  }
  if (body.capacity !== undefined && body.capacity !== null) {
    const c = Number(body.capacity);
    if (!Number.isInteger(c) || c < 0) {
      return "capacity must be a whole number of 0 or more (or null for no cap)";
    }
  }
  if (body.sortOrder !== undefined && !Number.isFinite(Number(body.sortOrder))) {
    return "sortOrder must be a number";
  }
  const listErr =
    stringListError(body.inclusions, "inclusions") ||
    stringListError(body.exclusions, "exclusions");
  if (listErr) return listErr;
  for (const field of ["salesStart", "salesEnd"]) {
    if (body[field] !== undefined && body[field] !== null) {
      if (Number.isNaN(new Date(body[field]).getTime())) {
        return `${field} must be a valid date`;
      }
    }
  }
  if (body.salesStart && body.salesEnd) {
    if (new Date(body.salesEnd) <= new Date(body.salesStart)) {
      return "salesEnd must be after salesStart";
    }
  }
  return null;
}

function applyEditable(doc, body) {
  for (const field of EDITABLE) {
    if (body[field] !== undefined) doc[field] = body[field];
  }
}

// ================= LIST TICKET TYPES =================
// Optional ?eventKey= filter; staff see inactive types too (they manage them).
router.get("/", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const filter = {};
    if (req.query.eventKey) filter.eventKey = String(req.query.eventKey);
    const ticketTypes = await TicketType.find(filter).sort({
      eventKey: 1,
      sortOrder: 1,
      name: 1
    });
    res.json({ ticketTypes });
  } catch (err) {
    console.error("GET admin ticket types error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ================= ONE EVENT'S TICKETS (defaults or its own) =================
// → { eventKey, usesDefaults (a Briefing), source: "event" | "default", defaultKey, ticketTypes }
router.get("/for-event", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const eventKey = String(req.query.eventKey || "").trim();
    if (!eventKey) return res.status(400).json({ error: "eventKey is required" });
    const key = await ticketTypeKey(eventKey);
    const ticketTypes = await TicketType.find({ eventKey: key }).sort({ sortOrder: 1, name: 1 });
    res.json({
      eventKey, usesDefaults: usesBriefingDefaults(eventKey), defaultKey: DEFAULT_BRIEFING_KEY,
      source: key === eventKey ? "event" : "default", ticketTypes,
    });
  } catch (err) {
    console.error("GET admin ticket types for event error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ================= CUSTOMISE: copy the default Briefing tickets onto this event =================
router.post("/customise", authMiddleware, adminMiddleware, requireManagement, async (req, res) => {
  try {
    const eventKey = String(req.body?.eventKey || "").trim();
    if (!usesBriefingDefaults(eventKey)) return res.status(400).json({ error: "Only a Briefing uses the default tickets." });
    if (await TicketType.exists({ eventKey })) return res.status(409).json({ error: "This event already has its own tickets." });
    const defaults = await TicketType.find({ eventKey: DEFAULT_BRIEFING_KEY }).lean();
    const created = defaults.length ? await TicketType.insertMany(defaults.map((t) => copyOf(t, eventKey))) : [];
    recordAudit(req, "create", "ticket-type", eventKey, `Customised tickets for ${eventKey} (${created.length} copied from the defaults)`);
    res.status(201).json({ eventKey, source: "event", ticketTypes: created });
  } catch (err) {
    console.error("POST admin ticket types customise error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ================= BACK TO DEFAULTS: remove this event's own tickets =================
// Refused once any order uses them (their orders and passes keep pointing at them).
router.post("/use-defaults", authMiddleware, adminMiddleware, requireManagement, async (req, res) => {
  try {
    const eventKey = String(req.body?.eventKey || "").trim();
    if (!usesBriefingDefaults(eventKey)) return res.status(400).json({ error: "Only a Briefing uses the default tickets." });
    const own = await TicketType.find({ eventKey }, { _id: 1 }).lean();
    if (own.length && await Order.exists({ "items.ticketTypeId": { $in: own.map((t) => t._id) } })) {
      return res.status(409).json({ error: "People have already ordered these tickets, so they can't be removed. Edit them instead." });
    }
    const out = await TicketType.deleteMany({ eventKey });
    recordAudit(req, "delete", "ticket-type", eventKey, `Back to the default tickets for ${eventKey} (${out.deletedCount} removed)`);
    res.json({ eventKey, source: "default", removed: out.deletedCount });
  } catch (err) {
    console.error("POST admin ticket types use-defaults error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ================= CREATE TICKET TYPE =================
router.post("/", authMiddleware, adminMiddleware, requireManagement, async (req, res) => {
  try {
    const body = req.body || {};
    const err = ticketTypeError(body, { creating: true });
    if (err) return res.status(400).json({ error: err });

    const ticketType = new TicketType({ eventKey: String(body.eventKey).trim() });
    applyEditable(ticketType, body);
    await ticketType.save();
    recordAudit(req, "create", "ticket-type", String(ticketType._id),
      `Created ticket type "${ticketType.name}" for ${ticketType.eventKey}`);
    res.status(201).json({ ticketType });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(400).json({ error: "A ticket type with that slug already exists for this event" });
    }
    console.error("POST admin ticket types error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ================= UPDATE TICKET TYPE =================
router.patch("/:id", authMiddleware, adminMiddleware, requireManagement, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: "Ticket type not found" });
    }
    const body = req.body || {};
    const err = ticketTypeError(body);
    if (err) return res.status(400).json({ error: err });

    const ticketType = await TicketType.findById(req.params.id);
    if (!ticketType) return res.status(404).json({ error: "Ticket type not found" });

    applyEditable(ticketType, body);
    await ticketType.save();
    recordAudit(req, "update", "ticket-type", String(ticketType._id),
      `Updated ticket type "${ticketType.name}" for ${ticketType.eventKey}`,
      { fields: Object.keys(body) });
    res.json({ ticketType });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(400).json({ error: "A ticket type with that slug already exists for this event" });
    }
    console.error("PATCH admin ticket type error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ================= DELETE TICKET TYPE =================
// Hard delete, like the promo codes (routes/promos.js). Deactivating
// (PATCH active=false) is the softer option: the type disappears from
// sale but its orders and passes keep their snapshots.
router.delete("/:id", authMiddleware, adminMiddleware, requireManagement, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: "Ticket type not found" });
    }
    const ticketType = await TicketType.findByIdAndDelete(req.params.id);
    if (!ticketType) return res.status(404).json({ error: "Ticket type not found" });
    recordAudit(req, "delete", "ticket-type", String(ticketType._id),
      `Deleted ticket type "${ticketType.name}" for ${ticketType.eventKey}`);
    res.json({ deleted: true });
  } catch (err) {
    console.error("DELETE admin ticket type error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
