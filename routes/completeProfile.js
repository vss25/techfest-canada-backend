import express from "express";
import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import { makeLimiter } from "../services/ticketAccess.js";
import {
  verifyProfileSig, publicProfileView, cleanAttendeeSubmission, hasAnswers, mergeAttendeeSubmission,
} from "../services/profileRequest.js";

/* =========================================================
   /api/complete-profile — the attendee's own "complete your
   profile" form (website /complete-profile). No login: the link
   emailed by staff carries ?t=<ticketId>&s=<sig> (services/
   profileRequest.js). A missing or wrong signature looks exactly
   like an unknown ticket (404).

   GET  /api/complete-profile?t=&s=        → names, pass, what we have, completed?
   POST /api/complete-profile  { t, s, …answers } → saves into the ticket's details
========================================================= */

const router = express.Router();
// Light per-IP limits (offices share IPs, so not too tight). The HMAC is the real protection.
const readLimiter = makeLimiter({ max: 120, windowMs: 15 * 60 * 1000 });
const writeLimiter = makeLimiter({ max: 30, windowMs: 15 * 60 * 1000 });
const NOT_FOUND = "This link isn't valid. It may have been copied incompletely.";

// server.js trusts one proxy hop, so req.ip is the visitor's address.
const clientIp = (req) => String(req.ip || "unknown");

/** The ticket behind a signed link: account tickets first (same as the staff list), then guest checkouts. */
async function findTicket(ticketId) {
  if (!ticketId || /^BOOTH-/i.test(ticketId)) return null;
  const owner = await User.findOne({ "tickets.ticketId": ticketId }).select("name email tickets").lean();
  const t = owner?.tickets?.find((x) => x.ticketId === ticketId);
  if (t) return { kind: "account", ownerId: owner._id, name: owner.name, email: owner.email, tier: t.type, ticketId, details: t.details };
  const a = await Attendee.findOne({ ticketId }).select("name email ticketType details").lean();
  if (a) return { kind: "guest", name: a.name, email: a.email, tier: a.ticketType, ticketId, details: a.details };
  return null;
}

function signedTicketId(src) {
  const ticketId = typeof src?.t === "string" ? src.t.trim().slice(0, 100) : "";
  const sig = typeof src?.s === "string" ? src.s.trim().slice(0, 200) : "";
  return ticketId && sig && verifyProfileSig(ticketId, sig) ? ticketId : "";
}

router.get("/", async (req, res) => {
  try {
    if (!readLimiter.hit(clientIp(req))) return res.status(429).json({ error: "Too many requests. Please try again in a few minutes." });
    res.set("Cache-Control", "private, no-store");
    const ticketId = signedTicketId(req.query);
    const t = ticketId && await findTicket(ticketId);
    if (!t) return res.status(404).json({ error: NOT_FOUND });
    res.json(publicProfileView(t));
  } catch (err) {
    console.error("COMPLETE PROFILE GET ERROR:", err);
    res.status(500).json({ error: "Something went wrong. Please try again in a few minutes." });
  }
});

router.post("/", async (req, res) => {
  try {
    if (!writeLimiter.hit(clientIp(req))) return res.status(429).json({ error: "Too many requests. Please try again in a few minutes." });
    const ticketId = signedTicketId(req.body);
    const t = ticketId && await findTicket(ticketId);
    if (!t) return res.status(404).json({ error: NOT_FOUND });

    const clean = cleanAttendeeSubmission(req.body);
    if (!hasAnswers(clean)) return res.status(400).json({ error: "Please fill in at least one answer." });
    const details = mergeAttendeeSubmission(t.details, clean);

    let name = t.name;
    if (t.kind === "account") {
      // The account's own name belongs to the person's profile; only the ticket's details change.
      await User.updateOne({ _id: t.ownerId, "tickets.ticketId": ticketId }, { $set: { "tickets.$.details": details } });
    } else {
      // Guest tickets: the attendee's name is the ticket's name (often the card holder's until now).
      if (clean.firstName || clean.lastName) {
        const cur = publicProfileView(t);
        name = [clean.firstName || cur.firstName, clean.lastName || cur.lastName].filter(Boolean).join(" ").slice(0, 120);
      }
      await Attendee.updateOne({ ticketId }, { $set: { details, ...(name && name !== t.name ? { name } : {}) } });
    }
    res.json({ ok: true, ...publicProfileView({ ...t, name, details }) });
  } catch (err) {
    console.error("COMPLETE PROFILE POST ERROR:", err);
    res.status(500).json({ error: "We couldn't save your answers. Please try again in a few minutes." });
  }
});

export default router;
