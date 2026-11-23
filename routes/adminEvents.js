import express from "express";
import jwt from "jsonwebtoken";
import EventConfig from "../models/EventConfig.js";
import { ensureOwnCopy } from "../services/ticketTypeDefaults.js";
import { requireAdmin, isManagement } from "../middleware/adminAuth.js";
import { recordAudit } from "../services/auditLog.js";

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

// Events are staff-only, like the sales CRM (routes/leads.js). Routes check the database,
// not the token's "role" claim, so removing someone's staff access takes effect immediately.
const adminMiddleware = (req, res, next) => requireAdmin(req, res, next);

// Mirror of the enums on models/EventConfig.js (the schema enforces them too).
const EVENT_TYPES = ["briefing", "main-event"];
const EVENT_STATUSES = ["draft", "announced", "live", "past"];
const VISIBILITY_MODES = ["hidden", "count", "names", "profiles"];
const VISIBILITY_AUDIENCES = ["public", "own-event", "all-events", "staff-only"];

// Fields a create/update may set. eventKey is set at create and never changes.
const EDITABLE = ["name", "city", "type", "year", "startDate", "endDate", "status"];

// Returns an error message, or null when the given attendeeVisibility patch is valid.
function visibilityError(v) {
  if (v === undefined) return null;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return "attendeeVisibility must be an object";
  }
  if (v.mode !== undefined && !VISIBILITY_MODES.includes(v.mode)) {
    return `attendeeVisibility.mode must be one of: ${VISIBILITY_MODES.join(", ")}`;
  }
  if (v.audience !== undefined && !VISIBILITY_AUDIENCES.includes(v.audience)) {
    return `attendeeVisibility.audience must be one of: ${VISIBILITY_AUDIENCES.join(", ")}`;
  }
  if (
    v.sharedWith !== undefined &&
    (!Array.isArray(v.sharedWith) || v.sharedWith.some((k) => typeof k !== "string"))
  ) {
    return "attendeeVisibility.sharedWith must be a list of event keys";
  }
  return null;
}

function applyVisibility(event, v) {
  if (v.mode !== undefined) event.attendeeVisibility.mode = v.mode;
  if (v.audience !== undefined) event.attendeeVisibility.audience = v.audience;
  if (v.sharedWith !== undefined) event.attendeeVisibility.sharedWith = v.sharedWith;
}

// Returns an error message, or null. Sets the field on the event when valid.
function applyGraceDays(event, settings) {
  if (settings?.lifecycleGraceDays === undefined) return null;
  const days = Number(settings.lifecycleGraceDays);
  if (!Number.isFinite(days) || days < 0) {
    return "settings.lifecycleGraceDays must be a number of 0 or more";
  }
  event.set("settings.lifecycleGraceDays", days);
  return null;
}

// Returns an error message, or null. Sets the field on the event when valid.
// (The field has been on the model since Phase 1; this makes it settable here.)
function applyPricingAnnounced(event, settings) {
  if (settings?.pricingAnnounced === undefined) return null;
  if (typeof settings.pricingAnnounced !== "boolean") {
    return "settings.pricingAnnounced must be true or false";
  }
  event.set("settings.pricingAnnounced", settings.pricingAnnounced);
  return null;
}

// ================= LIST EVENTS =================
router.get("/", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const events = await EventConfig.find({}).sort({ year: 1, startDate: 1 });
    res.json({ events });
  } catch (err) {
    console.error("GET admin events error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ================= VISIBILITY MATRIX =================
// The cross-event view Admin works from: one row per event — what it exposes
// about its attendees (mode), to whom (audience), and the extra events it is
// shared with (sharedWith). Writing happens through PATCH /:eventKey.
router.get("/visibility-matrix", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const events = await EventConfig.find({}).sort({ year: 1, startDate: 1 });
    res.json({
      eventKeys: events.map((e) => e.eventKey),
      rows: events.map((e) => ({
        eventKey: e.eventKey,
        name: e.name || "",
        mode: e.attendeeVisibility?.mode || "hidden",
        audience: e.attendeeVisibility?.audience || "staff-only",
        sharedWith: e.attendeeVisibility?.sharedWith || []
      }))
    });
  } catch (err) {
    console.error("GET visibility matrix error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Who may change what (Nov 2026, the organiser: "everything configurable from
// the admin panel depending on the access level"). Management: creating events
// and everything that sets what is sold and when (name, city, type, year,
// dates, status, grace days, pricing announced, quantity discount). Staff:
// attendee visibility only. Volunteers never reach this router (requireAdmin).
const STAFF_FIELDS = new Set(["attendeeVisibility"]);
function managementOnly(req, res, body) {
  if (isManagement(req.user)) return false;
  const others = Object.keys(body || {}).filter((k) => !STAFF_FIELDS.has(k));
  if (others.length === 0) return false;
  res.status(403).json({ error: "Only management can change this.", code: "management_only", fields: others });
  return true;
}

// Returns an error message, or null. Sets the event's automatic quantity
// discount (models/EventConfig.js settings.quantityDiscount) when valid.
function applyQuantityDiscount(event, settings) {
  const q = settings?.quantityDiscount;
  if (q === undefined) return null;
  if (q === null || typeof q !== "object" || Array.isArray(q)) return "settings.quantityDiscount must be an object";
  if (q.enabled !== undefined) {
    if (typeof q.enabled !== "boolean") return "settings.quantityDiscount.enabled must be true or false";
    event.set("settings.quantityDiscount.enabled", q.enabled);
  }
  if (q.minQuantity !== undefined) {
    const n = Number(q.minQuantity);
    if (!Number.isInteger(n) || n < 2 || n > 100) return "settings.quantityDiscount.minQuantity must be a whole number from 2 to 100";
    event.set("settings.quantityDiscount.minQuantity", n);
  }
  if (q.percent !== undefined) {
    const p = Number(q.percent);
    if (!Number.isFinite(p) || p <= 0 || p > 100) return "settings.quantityDiscount.percent must be more than 0 and at most 100";
    event.set("settings.quantityDiscount.percent", Math.round(p * 100) / 100);
  }
  return null;
}

// Returns an error message, or null. Sets the event's targets (models/EventConfig.js
// settings.targets): whole numbers, "" / null = no target.
export function applyTargets(event, settings) {
  const t = settings?.targets;
  if (t === undefined) return null;
  if (t === null || typeof t !== "object" || Array.isArray(t)) return "settings.targets must be an object";
  const limits = { delegates: 100000, exhibitors: 10000 };
  for (const [key, max] of Object.entries(limits)) {
    if (t[key] === undefined) continue;
    if (t[key] === null || t[key] === "") { event.set(`settings.targets.${key}`, null); continue; }
    const n = Number(t[key]);
    if (!Number.isInteger(n) || n < 0 || n > max) return `settings.targets.${key} must be a whole number from 0 to ${max}`;
    event.set(`settings.targets.${key}`, n);
  }
  return null;
}

// ================= CREATE EVENT =================
router.post("/", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const body = req.body || {};
    if (!isManagement(req.user)) {
      return res.status(403).json({ error: "Only management can create events.", code: "management_only" });
    }

    const eventKey = typeof body.eventKey === "string" ? body.eventKey.trim() : "";
    if (!eventKey) {
      return res.status(400).json({ error: "eventKey is required" });
    }
    if (body.type !== undefined && !EVENT_TYPES.includes(body.type)) {
      return res.status(400).json({ error: `type must be one of: ${EVENT_TYPES.join(", ")}` });
    }
    if (body.status !== undefined && !EVENT_STATUSES.includes(body.status)) {
      return res.status(400).json({ error: `status must be one of: ${EVENT_STATUSES.join(", ")}` });
    }
    const vErr = visibilityError(body.attendeeVisibility);
    if (vErr) return res.status(400).json({ error: vErr });

    const existing = await EventConfig.findOne({ eventKey });
    if (existing) {
      return res.status(400).json({ error: `An event with eventKey "${eventKey}" already exists` });
    }

    const event = new EventConfig({ eventKey });
    for (const field of EDITABLE) {
      if (body[field] !== undefined) event[field] = body[field];
    }
    if (body.attendeeVisibility !== undefined) applyVisibility(event, body.attendeeVisibility);
    const gErr = applyGraceDays(event, body.settings);
    if (gErr) return res.status(400).json({ error: gErr });
    const pErr = applyPricingAnnounced(event, body.settings);
    if (pErr) return res.status(400).json({ error: pErr });
    const qErr = applyQuantityDiscount(event, body.settings);
    if (qErr) return res.status(400).json({ error: qErr });
    const tErr = applyTargets(event, body.settings);
    if (tErr) return res.status(400).json({ error: tErr });

    await event.save();
    // A new Briefing starts with its own copy of the default tickets (Nov 22 2026).
    await ensureOwnCopy(event.eventKey).catch((e) => console.error("Copying default tickets failed:", e.message));
    recordAudit(req, "create", "event", event.eventKey,
      `Created event ${event.eventKey} (${event.name || "unnamed"})`);
    res.status(201).json(event);
  } catch (err) {
    if (err.name === "ValidationError") {
      return res.status(400).json({ error: err.message });
    }
    console.error("CREATE admin event error:", err);
    res.status(500).json({ error: "Failed to create event" });
  }
});

// ================= UPDATE EVENT =================
router.patch("/:eventKey", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const event = await EventConfig.findOne({ eventKey: req.params.eventKey });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    const body = req.body || {};
    if (managementOnly(req, res, body)) return;
    if (body.type !== undefined && !EVENT_TYPES.includes(body.type)) {
      return res.status(400).json({ error: `type must be one of: ${EVENT_TYPES.join(", ")}` });
    }
    if (body.status !== undefined && !EVENT_STATUSES.includes(body.status)) {
      return res.status(400).json({ error: `status must be one of: ${EVENT_STATUSES.join(", ")}` });
    }
    const vErr = visibilityError(body.attendeeVisibility);
    if (vErr) return res.status(400).json({ error: vErr });

    for (const field of EDITABLE) {
      if (body[field] !== undefined) event[field] = body[field];
    }
    if (body.attendeeVisibility !== undefined) applyVisibility(event, body.attendeeVisibility);
    const gErr = applyGraceDays(event, body.settings);
    if (gErr) return res.status(400).json({ error: gErr });
    const pErr = applyPricingAnnounced(event, body.settings);
    if (pErr) return res.status(400).json({ error: pErr });
    const qErr = applyQuantityDiscount(event, body.settings);
    if (qErr) return res.status(400).json({ error: qErr });
    const tErr = applyTargets(event, body.settings);
    if (tErr) return res.status(400).json({ error: tErr });

    await event.save();
    recordAudit(req, "update", "event", event.eventKey,
      `Updated event ${event.eventKey}`, { fields: Object.keys(body) });
    res.json(event);
  } catch (err) {
    if (err.name === "ValidationError") {
      return res.status(400).json({ error: err.message });
    }
    console.error("UPDATE admin event error:", err);
    res.status(500).json({ error: "Failed to update event" });
  }
});

export default router;
