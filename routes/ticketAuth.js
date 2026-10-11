import express from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import { normalizeTicketId, lastNameMatches, latestTicket, makeLimiter } from "../services/ticketAccess.js";

/* =========================================================
   Mounted at /api/auth alongside routes/auth.js (website auth):
   POST /api/auth/ticket-login  { lastName, ticketId }  → { token, created }
   POST /api/auth/claim-ticket  { lastName, ticketId }  (Bearer) → { user }
   POST /api/auth/refresh       (Bearer)                → { token }
========================================================= */

const router = express.Router();
const limiter = makeLimiter({ max: 8, windowMs: 15 * 60 * 1000 });
// Per ticket too, so guessing one person's last name can't be spread across addresses.
const perTicket = makeLimiter({ max: 5, windowMs: 15 * 60 * 1000 });
const APP_TOKEN_TTL = "30d";
const NO_MATCH = "That ticket ID and last name don't match a TTFC ticket.";

function sign(user, expiresIn = APP_TOKEN_TTL) {
  return jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn });
}

async function userFromToken(req) {
  const h = req.headers.authorization;
  if (!h) return null;
  try {
    const decoded = jwt.verify(h.split(" ")[1], process.env.JWT_SECRET);
    return await User.findById(decoded.id);
  } catch {
    return null;
  }
}

/** Finds a ticket in users' tickets first, then guest Attendee records. */
async function findTicket(rawId) {
  const id = normalizeTicketId(rawId);
  if (!id || id.length < 6) return null;
  const variants = [...new Set([id, id.toUpperCase(), String(rawId || "").trim()])];
  const owner = await User.findOne({ "tickets.ticketId": { $in: variants } });
  if (owner) {
    const ticket = owner.tickets.find((t) => variants.includes(t.ticketId));
    return { kind: "user", owner, ticket, ticketId: ticket.ticketId };
  }
  const attendee = await Attendee.findOne({ ticketId: { $in: variants } });
  if (attendee) return { kind: "attendee", attendee, ticketId: attendee.ticketId };
  return null;
}

function ticketFromAttendee(a) {
  return {
    ticketId: a.ticketId,
    type: a.ticketType,
    purchaseDate: a.purchaseDate || new Date(),
    checkedIn: !!a.checkedIn,
    checkedInAt: a.checkedInAt,
    // What they told us at checkout comes along, so the app doesn't ask again.
    ...(a.details ? { details: a.details } : {}),
  };
}

/** Last name check for a ticket held by an account: the account's current name, the name
    given at checkout (ticket details), or the name on the original purchase (Attendee). */
async function ticketNameMatches(found, lastName) {
  if (lastNameMatches(found.owner.name, lastName)) return true;
  const d = found.ticket?.details || {};
  if (d.lastName && lastNameMatches(d.lastName, lastName)) return true;
  if (d.firstName || d.lastName) {
    if (lastNameMatches([d.firstName, d.lastName].filter(Boolean).join(" "), lastName)) return true;
  }
  const original = await Attendee.findOne({ ticketId: found.ticketId }).select("name").lean();
  return !!original && lastNameMatches(original.name, lastName);
}

function hasTicket(user, ticketId) {
  return (user.tickets || []).some((t) => t.ticketId === ticketId);
}

/* ---------- Sign in with last name + ticket ID ---------- */
router.post("/ticket-login", async (req, res) => {
  try {
    const key = `${req.ip}`;
    if (!limiter.hit(key)) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });

    const { lastName, ticketId } = req.body || {};
    if (typeof lastName !== "string" || typeof ticketId !== "string" || !lastName.trim() || !ticketId.trim()) {
      return res.status(400).json({ error: "Last name and ticket ID are required." });
    }
    if (!perTicket.hit(`t:${ticketId.trim().toUpperCase()}`)) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });

    const found = await findTicket(ticketId);
    if (!found) return res.status(401).json({ error: NO_MATCH });

    if (found.kind === "user") {
      // The name on the ticket itself also counts, so changing your profile name can't lock you out.
      if (!(await ticketNameMatches(found, lastName))) return res.status(401).json({ error: NO_MATCH });
      // Staff accounts reach the admin panel: they always sign in with their password.
      if (String(found.owner.role || "").toLowerCase() === "admin") {
        return res.status(400).json({ error: "Staff accounts sign in with their password." });
      }
      limiter.reset(key);
      return res.json({ token: sign(found.owner), created: false });
    }

    const a = found.attendee;
    if (!lastNameMatches(a.name, lastName)) return res.status(401).json({ error: NO_MATCH });

    // Guest purchase → the account for that email (create one if needed).
    let user = a.claimedBy ? await User.findById(a.claimedBy) : null;
    if (!user && a.email) user = await User.findOne({ email: String(a.email).toLowerCase() });
    let created = false;
    if (!user) {
      user = new User({
        name: a.name,
        email: String(a.email || `${a.ticketId}@ticket.thetechfestival.com`).toLowerCase(),
        provider: "ticket",
        tickets: [],
      });
      created = true;
    }
    if (!hasTicket(user, a.ticketId)) user.tickets.push(ticketFromAttendee(a));
    await user.save();
    if (!a.claimedBy) { a.claimedBy = user._id; await a.save(); }

    limiter.reset(key);
    res.json({ token: sign(user), created });
  } catch (err) {
    console.error("TICKET LOGIN ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------- Link a ticket bought under another email ---------- */
router.post("/claim-ticket", async (req, res) => {
  try {
    const me = await userFromToken(req);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    if (!limiter.hit(`claim:${me._id}`)) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });

    const { lastName, ticketId } = req.body || {};
    if (!lastName || !ticketId) return res.status(400).json({ error: "Last name and ticket ID are required." });

    const found = await findTicket(ticketId);
    if (!found) return res.status(404).json({ error: NO_MATCH });

    if (found.kind === "user") {
      if (String(found.owner._id) === String(me._id)) return res.json({ user: await User.findById(me._id).select("-password"), already: true });
      // The name on the original purchase also counts (a linked guest ticket keeps it).
      const original = await Attendee.findOne({ ticketId: found.ticketId }).select("name").lean();
      if (!lastNameMatches(found.owner.name, lastName) && !lastNameMatches(original?.name, lastName)) {
        return res.status(404).json({ error: NO_MATCH });
      }
      // Only move tickets off auto-created ticket accounts, never off a real account.
      if (found.owner.provider !== "ticket" || found.owner.password) {
        return res.status(409).json({ error: "This ticket is already linked to another TTFC account. Contact info@thetechfestival.com to move it." });
      }
      const t = found.ticket.toObject ? found.ticket.toObject() : found.ticket;
      found.owner.tickets = found.owner.tickets.filter((x) => x.ticketId !== found.ticketId);
      await found.owner.save();
      me.tickets.push({ ticketId: t.ticketId, type: t.type, purchaseDate: t.purchaseDate, checkedIn: t.checkedIn, checkedInAt: t.checkedInAt });
      await me.save();
      await Attendee.updateOne({ ticketId: found.ticketId }, { $set: { claimedBy: me._id } });
      return res.json({ user: await User.findById(me._id).select("-password") });
    }

    const a = found.attendee;
    if (!lastNameMatches(a.name, lastName)) return res.status(404).json({ error: NO_MATCH });
    if (a.claimedBy && String(a.claimedBy) !== String(me._id)) {
      const holder = await User.findById(a.claimedBy);
      if (holder && (holder.provider !== "ticket" || holder.password)) {
        return res.status(409).json({ error: "This ticket is already linked to another TTFC account. Contact info@thetechfestival.com to move it." });
      }
      if (holder) {
        holder.tickets = holder.tickets.filter((x) => x.ticketId !== a.ticketId);
        await holder.save();
      }
    }
    if (!hasTicket(me, a.ticketId)) me.tickets.push(ticketFromAttendee(a));
    await me.save();
    a.claimedBy = me._id;
    await a.save();
    res.json({ user: await User.findById(me._id).select("-password") });
  } catch (err) {
    console.error("CLAIM TICKET ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------- Keep the app signed in (sliding 30-day token) ---------- */
router.post("/refresh", async (req, res) => {
  const me = await userFromToken(req);
  if (!me) return res.status(401).json({ error: "Invalid token" });
  res.json({ token: sign(me) });
});

export default router;
export { latestTicket, sign as signAppToken, ticketFromAttendee, hasTicket };
