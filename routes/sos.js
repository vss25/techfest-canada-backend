import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import User from "../models/User.js";
import SosRequest from "../models/SosRequest.js";
import { AdminAudit } from "../models/Admin.js";
import { makeLimiter } from "../services/ticketAccess.js";
import { personAccess } from "../services/appRights.js";
import { rightsContext, RIGHTS_SELECT } from "../services/rightsStore.js";
import { pushToUsers } from "../services/push.js";
import {
  CATEGORIES, LOCATIONS, STATUS_LABELS, NEW_PER_HOUR, RATE_LIMITED, EMERGENCY_NOTE,
  cleanSosRequest, cleanBody, attendeeDTO, staffDTO, sortForStaff, isResponder, staffNote, attendeeNote,
  alertResponders, emailAlert,
} from "../services/sos.js";

/* =========================================================
   Help & SOS (Oct 22 2026), services/sos.js.

   Attendees (any signed-in account, people hidden from the app and suspended accounts included: safety first),
   mounted at /api/app/sos:
     GET  /options            → { categories: [{ key, label }], locations: [...], note }   (no sign-in needed)
     POST / { category, location?, message, phone? } → 201 { request }   (category: a key or its label; phone: else
          their contact card's)
          Alerts every staff account and moderator (push, always) and emails SOS_ALERT_TO. 429 { error, code:
          "rate_limited" } after 3 new requests in an hour (the message says to call 911 or find staff).
     GET  /                   → { requests: [request, …] theirs, newest first, phone: their contact card's phone ("" none) }
     POST /:id/messages { body } → { request }   (their own, not resolved: 409 once it is; pushes staff)
   request: { id, category, categoryLabel, location, message, phone, status: "open" | "acknowledged" | "resolved",
              statusLabel: "Sent" | "Seen by staff" | "Resolved", messages: [{ from: "attendee" | "staff", staffName, body, at }],
              createdAt, updatedAt }

   Staff (the app's sign-in or the admin panel's: staff accounts, anyone with the moderate right, so volunteers with
   the staff type too), mounted at /api/console/sos:
     GET  /?status=active|open|acknowledged|resolved|all  (default active = open + acknowledged)
          → { status, requests: [staff request…] open first, counts: { open, acknowledged, resolved } }
     GET  /:id                → { request }
     POST /:id/reply { body } → { request } (a staff message; an open request becomes acknowledged; pushes the attendee)
     POST /:id/status { status: "acknowledged" | "resolved" | "open" } → { request }
   staff request: the attendee's fields + { userId, name, email, phone, messages[].staffId, acknowledgedBy: { id, name },
              acknowledgedAt, resolvedBy, resolvedAt, lastMessageAt, links: { app, tel, mailto } }
   Every staff action is audited (sos_reply, sos_status; never the text). Nothing logs what anyone wrote.
========================================================= */

export const attendeeRouter = express.Router();
export const staffRouter = express.Router();

const followUps = makeLimiter({ max: 30, windowMs: 10 * 60 * 1000 });
const staffReplies = makeLimiter({ max: 120, windowMs: 10 * 60 * 1000 });
const isId = (v) => mongoose.isValidObjectId(String(v || "")) && /^[a-f0-9]{24}$/i.test(String(v));
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error("SOS ROUTE ERROR:", err?.message || err);
  if (!res.headersSent) res.status(500).json({ error: "Something went wrong. If this is urgent, call 911 or find a staff member." });
});

/** The signed-in account from the app's JWT (any sign-in method), or null after answering 401. */
async function signedIn(req, res, select = "name email role contactItems") {
  try {
    const h = String(req.headers.authorization || "");
    if (!h.startsWith("Bearer ")) throw new Error("no token");
    const decoded = jwt.verify(h.slice(7), process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select(select).lean();
    if (!user) throw new Error("no user");
    return user;
  } catch {
    res.status(401).json({ error: "Sign in to message staff. In an emergency, call 911 or find a TTFC staff member at the registration desk, Harbour Ballroom foyer." });
    return null;
  }
}

/* ---------- attendees ---------- */

/** The phone on their contact card (phone, else WhatsApp), to prefill the form and to fall back on. */
const profilePhone = (user) => {
  const items = Array.isArray(user?.contactItems) ? user.contactItems : [];
  return String((items.find((i) => i?.kind === "phone") || items.find((i) => i?.kind === "whatsapp"))?.value || "").slice(0, 30);
};

attendeeRouter.get("/options", (req, res) => res.json({ categories: CATEGORIES, locations: LOCATIONS, statusLabels: STATUS_LABELS, note: EMERGENCY_NOTE }));

attendeeRouter.post("/", wrap(async (req, res) => {
  const user = await signedIn(req, res);
  if (!user) return;
  const r = cleanSosRequest(req.body);
  if (r.error) return res.status(400).json({ error: r.error });
  // Counted in the database, so every server agrees.
  const lastHour = await SosRequest.countDocuments({ userId: user._id, createdAt: { $gt: new Date(Date.now() - 3_600_000) } });
  if (lastHour >= NEW_PER_HOUR) return res.status(429).json({ error: RATE_LIMITED, code: "rate_limited" });
  const doc = await SosRequest.create({
    userId: user._id, name: user.name || "", email: user.email || "", phone: r.phone || profilePhone(user),
    category: r.category, location: r.location, message: r.message, lastMessageAt: new Date(),
  });
  // Every responder hears now; staff also get the email. Neither waits for the other or slows the answer.
  alertResponders(staffNote(doc));
  emailAlert(doc.toObject());
  res.status(201).json({ request: attendeeDTO(doc) });
}));

attendeeRouter.get("/", wrap(async (req, res) => {
  const user = await signedIn(req, res, "_id contactItems");
  if (!user) return;
  const rows = await SosRequest.find({ userId: user._id }).sort({ createdAt: -1 }).limit(20).lean();
  res.set("Cache-Control", "no-store");
  res.json({ requests: rows.map(attendeeDTO), phone: profilePhone(user) });
}));

attendeeRouter.post("/:id/messages", wrap(async (req, res) => {
  const user = await signedIn(req, res, "_id name");
  if (!user) return;
  if (!isId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const body = cleanBody(req.body?.body);
  if (!body) return res.status(400).json({ error: "Write a message first." });
  if (!followUps.hit(String(user._id))) return res.status(429).json({ error: RATE_LIMITED, code: "rate_limited" });
  const at = new Date();
  const doc = await SosRequest.findOneAndUpdate(
    { _id: req.params.id, userId: user._id, status: { $ne: "resolved" } },
    { $push: { messages: { from: "attendee", body, at } }, $set: { lastMessageAt: at } },
    { returnDocument: "after" },
  ).lean();
  if (!doc) {
    const mine = await SosRequest.exists({ _id: req.params.id, userId: user._id });
    return mine
      ? res.status(409).json({ error: "This request is resolved. Send a new one if you need help again.", code: "resolved" })
      : res.status(404).json({ error: "Not found" });
  }
  alertResponders(staffNote(doc, { followUp: true, body }));
  res.json({ request: attendeeDTO(doc) });
}));

/* ---------- staff ---------- */

/** Staff accounts and anyone with the moderate right, signed in with the app's or the admin panel's token. */
async function requireResponder(req, res, next) {
  const user = await signedIn(req, res, `${RIGHTS_SELECT} email staffRole`);
  if (!user) return;
  if (user.banned) return res.status(403).json({ error: "This account is suspended." });
  const rights = personAccess(user, await rightsContext()).rights;
  if (!isResponder(user, rights)) return res.status(403).json({ error: "Only TTFC staff can see SOS requests." });
  req.user = user;
  next();
}
staffRouter.use((req, res, next) => { requireResponder(req, res, next).catch((err) => {
  console.error("SOS AUTH ERROR:", err?.message || err);
  if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Try again." });
}); });

async function audit(req, action, id, detail = "") {
  await AdminAudit.create({ adminId: req.user._id, adminName: req.user.name, action, targetType: "sos", targetId: String(id), detail: String(detail).slice(0, 200) })
    .catch(() => {});
}

const STATUS_FILTER = {
  active: { status: { $in: ["open", "acknowledged"] } }, open: { status: "open" }, acknowledged: { status: "acknowledged" },
  resolved: { status: "resolved" }, all: {},
};

staffRouter.get("/", wrap(async (req, res) => {
  const key = Object.hasOwn(STATUS_FILTER, String(req.query.status || "")) ? String(req.query.status) : "active";
  const [rows, counts] = await Promise.all([
    SosRequest.find(STATUS_FILTER[key]).sort({ createdAt: -1 }).limit(300).lean(),
    SosRequest.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
  ]);
  const c = { open: 0, acknowledged: 0, resolved: 0 };
  for (const x of counts) if (x._id in c) c[x._id] = x.n;
  res.set("Cache-Control", "no-store");
  res.json({ status: key, requests: sortForStaff(rows).map(staffDTO), counts: c });
}));

staffRouter.get("/:id", wrap(async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const doc = await SosRequest.findById(req.params.id).lean();
  if (!doc) return res.status(404).json({ error: "Not found" });
  res.set("Cache-Control", "no-store");
  res.json({ request: staffDTO(doc) });
}));

staffRouter.post("/:id/reply", wrap(async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const body = cleanBody(req.body?.body);
  if (!body) return res.status(400).json({ error: "Write a reply first." });
  if (!staffReplies.hit(String(req.user._id))) return res.status(429).json({ error: "Too many replies in a row. Try again in a minute." });
  const at = new Date();
  const msg = { from: "staff", staffId: req.user._id, staffName: req.user.name || "TTFC staff", body, at };
  let doc = await SosRequest.findByIdAndUpdate(req.params.id, { $push: { messages: msg }, $set: { lastMessageAt: at } }, { returnDocument: "after" }).lean();
  if (!doc) return res.status(404).json({ error: "Not found" });
  // A reply means staff have seen it.
  if (doc.status === "open") {
    doc = await SosRequest.findOneAndUpdate({ _id: doc._id, status: "open" },
      { $set: { status: "acknowledged", acknowledgedBy: req.user._id, acknowledgedByName: req.user.name || "", acknowledgedAt: at } },
      { returnDocument: "after" }).lean() || doc;
  }
  // The attendee hears now, whatever their notification switches (no `from`, no `pref`).
  pushToUsers([doc.userId], attendeeNote(doc, { staffName: req.user.name, body }));
  await audit(req, "sos_reply", doc._id, doc.status);
  res.json({ request: staffDTO(doc) });
}));

staffRouter.post("/:id/status", wrap(async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const status = String(req.body?.status || "");
  if (!["open", "acknowledged", "resolved"].includes(status)) return res.status(400).json({ error: "status must be acknowledged, resolved or open" });
  const at = new Date();
  const set = { status };
  if (status === "acknowledged") Object.assign(set, { acknowledgedBy: req.user._id, acknowledgedByName: req.user.name || "", acknowledgedAt: at });
  if (status === "resolved") Object.assign(set, { resolvedBy: req.user._id, resolvedByName: req.user.name || "", resolvedAt: at });
  const before = await SosRequest.findById(req.params.id).select("status").lean();
  if (!before) return res.status(404).json({ error: "Not found" });
  const doc = await SosRequest.findByIdAndUpdate(req.params.id, { $set: set }, { returnDocument: "after" }).lean();
  await audit(req, "sos_status", doc._id, `${before.status} → ${status}`);
  res.json({ request: staffDTO(doc) });
}));
