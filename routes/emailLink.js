import express from "express";
import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import SignInRequest from "../models/SignInRequest.js";
import { makeLimiter, SHARED_ADDRESS } from "../services/ticketAccess.js";
import {
  normalizeEmail, isValidEmail, createSignInSecrets, hashToken, looksLikeToken, requestState,
  checkCode, cleanCode, messageFor, signInLink, frontendBase, cleanClient, emailRegex, LINK_TTL_MS, MAX_CODE_ATTEMPTS, codeMessageFor,
  linkDecision,
} from "../services/emailLink.js";
import { signAppToken, ticketFromAttendee, hasTicket } from "./ticketAuth.js";
import { isStaff } from "../services/teamRoles.js";
import { VIA_EMAIL } from "../services/signInMethod.js";
import { autoLinkPasses } from "../services/passAutoLink.js";

/* =========================================================
   "Email me a sign-in link" — mounted at /api/auth
   POST /api/auth/email-link         { email, client }        → { sent: true } (always)
   POST /api/auth/email-link/verify  { token } | { email, code } → { token, created }
   ---------------------------------------------------------
   The email holds a link to ${FRONTEND_URL}/app-login?token=… (which
   opens ttfc://login?token=… or signs in on the website) and a 6-digit
   code for typing into the app. Pure parts: services/emailLink.js.

   Everyone with an account can sign in this way, staff and volunteers
   included (they can also use the apps' staff sign-in with a password).
   The token says `via: "email"`: it works everywhere in the apps, door
   check-in and moderation included, but not in the admin panel
   (requireAdmin wants a password token, services/signInMethod.js).
========================================================= */

// Render sits behind a proxy, so req.ip is the proxy; use the client's address
// the same way routes/completeProfile.js does. Venue Wi-Fi puts many attendees
// behind one address, so the per-IP caps are looser than the per-email one.
// server.js trusts one proxy hop, so req.ip is the visitor (a client-sent
// X-Forwarded-For can't be used to dodge the limits).
const clientIp = (req) => String(req.ip || "unknown");

const TOO_MANY = "Too many sign-in emails. Please wait 15 minutes and try again.";
const TOO_MANY_TRIES = "Too many attempts. Please wait 15 minutes and try again.";

/** Finds the account and guest tickets for an email (case-insensitive). */
async function lookup(email) {
  const user = (await User.findOne({ email })) || (await User.findOne({ email: emailRegex(email) }));
  const guests = await Attendee.find({ email: emailRegex(email), syncDuplicate: { $ne: true } }).sort({ purchaseDate: -1 });
  return { user, guests };
}

/** The account for this email — created for a guest ticket holder — with their guest tickets attached. */
async function accountFor(email) {
  const { user: found, guests } = await lookup(email);
  let user = found;
  let created = false;
  if (!user) {
    if (!guests.length) return { user: null, created };
    user = new User({ name: guests[0].name || "TTFC attendee", email, provider: "ticket", tickets: [] });
    created = true;
  }
  // Staff accounts just sign in. Passes staff issue can carry a staff member's own email
  // (e.g. Speaker Passes), so guest tickets are never moved onto a staff account here; their
  // own ticket can still be linked with claim-ticket.
  // Since Oct 24 2026 a staff account gets the passes sent to its email that name it (services/passAutoLink.js: the
  // name on the pass must be theirs, so a speaker's pass under a staff member's email stays the speaker's).
  if (isStaff(user)) {
    if ((await autoLinkPasses(user, { trigger: "emailed-code sign-in" })).length) user = await User.findById(user._id);
    return { user, created };
  }
  const claim = [];
  for (const a of guests) {
    // A ticket someone else has already linked to their own account stays with them.
    if (a.claimedBy && String(a.claimedBy) !== String(user._id)) continue;
    if (!hasTicket(user, a.ticketId)) user.tickets.push(ticketFromAttendee(a));
    if (!a.claimedBy) claim.push(a._id);
  }
  await user.save();
  if (claim.length) await Attendee.updateMany({ _id: { $in: claim } }, { $set: { claimedBy: user._id } });
  // Anything the loop above leaves (it links every pass with this email, as before): audited links and the desks told.
  await autoLinkPasses(user, { trigger: "emailed-code sign-in" });
  return { user, created };
}

async function defaultSend(kind, payload) {
  // Imported lazily so unit tests can build the router without a Resend key.
  const mail = await import("../services/emailService.js");
  if (kind === "signin") return mail.sendSignInLinkEmail(payload);
  return mail.sendNoTicketEmail(payload);
}

/**
 * @param {object} [deps]
 * @param {(kind: "signin"|"no-ticket", payload: object) => Promise<any>} [deps.send]
 */
export function createEmailLinkRouter({ send = defaultSend } = {}) {
  const router = express.Router();
  const perEmail = makeLimiter({ max: 5, windowMs: 15 * 60 * 1000 });
  // Per address, sized for a venue's shared Wi-Fi; codes are guarded per email and per request (MAX_CODE_ATTEMPTS).
  const perIp = makeLimiter(SHARED_ADDRESS);
  const verifyPerIp = makeLimiter({ ...SHARED_ADDRESS, max: SHARED_ADDRESS.max * 2 });

  /* ---------- Send the link ---------- */
  router.post("/email-link", async (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email);
      if (!isValidEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
      if (!perIp.hit(`ip:${clientIp(req)}`) || !perEmail.hit(`email:${email}`)) {
        return res.status(429).json({ error: TOO_MANY });
      }

      const { user, guests } = await lookup(email);
      const base = frontendBase();

      // Same answer as always (no account enumeration). Every account gets a link + code
      // (staff, volunteers and ticketless accounts too), so does an email a guest ticket was
      // bought with; an email with neither gets the "no ticket" email.
      const decision = linkDecision(user, guests.length);

      if (decision === "no-ticket") {
        send("no-ticket", { email, ticketsUrl: `${base}/tickets` })
          .catch((err) => console.error("NO-TICKET EMAIL ERROR:", err.message));
        return res.json({ sent: true });
      }

      // A new link replaces any older one still waiting.
      await SignInRequest.updateMany({ email, status: "pending" }, { $set: { status: "replaced" } });
      const { token, code, record } = createSignInSecrets(email);
      await SignInRequest.create({ ...record, client: cleanClient(req.body?.client), ip: clientIp(req) });

      send("signin", { email, link: signInLink(token, base), code, minutes: Math.round(LINK_TTL_MS / 60000) })
        .catch((err) => console.error("SIGN-IN EMAIL ERROR:", err.message));
      res.json({ sent: true });
    } catch (err) {
      console.error("EMAIL LINK ERROR:", err);
      res.status(500).json({ error: "Something went wrong. Please try again." });
    }
  });

  /* ---------- Use the link or the code ---------- */
  router.post("/email-link/verify", async (req, res) => {
    try {
      if (!verifyPerIp.hit(`ip:${clientIp(req)}`)) return res.status(429).json({ error: TOO_MANY_TRIES });
      const now = Date.now();
      const { token } = req.body || {};
      let request;

      if (token !== undefined && token !== null && token !== "") {
        if (!looksLikeToken(token)) return res.status(400).json({ error: messageFor("missing") });
        request = await SignInRequest.findOne({ tokenHash: hashToken(token) });
        const state = requestState(request, now);
        if (state !== "ok") return res.status(400).json({ error: messageFor(state) });
      } else {
        const email = normalizeEmail(req.body?.email);
        if (!isValidEmail(email)) return res.status(400).json({ error: "Enter the email the code was sent to." });
        if (!cleanCode(req.body?.code)) return res.status(400).json({ error: "Enter the 6-digit code from the email." });
        request = (await SignInRequest.findOne({ email, status: "pending" }).sort({ createdAt: -1 }))
          || (await SignInRequest.findOne({ email }).sort({ createdAt: -1 }));
        // Reserve this try atomically before comparing, so a burst of parallel
        // guesses can't all see "0 attempts" and get more than MAX_CODE_ATTEMPTS.
        let counted = false;
        if (request && request.status === "pending") {
          const reserved = await SignInRequest.findOneAndUpdate(
            { _id: request._id, status: "pending", attempts: { $lt: MAX_CODE_ATTEMPTS } },
            { $inc: { attempts: 1 } },
            { new: true }
          );
          if (!reserved) {
            await SignInRequest.updateOne({ _id: request._id, status: "pending" }, { $set: { status: "locked" } });
            return res.status(400).json({ error: codeMessageFor("locked") });
          }
          request = reserved;
          counted = true;
        }
        // checkCode counts the try itself, so give it the count before this one.
        const asBefore = counted ? { ...request.toObject(), attempts: request.attempts - 1 } : request;
        const result = checkCode(asBefore, email, req.body.code, now);
        if (!result.ok) {
          if (request && result.lock && request.status === "pending") {
            await SignInRequest.updateOne({ _id: request._id, status: "pending" }, { $set: { status: "locked" } });
          }
          return res.status(400).json({ error: result.error });
        }
      }

      // Single use: only the first caller to flip it from pending gets in.
      const claimed = await SignInRequest.findOneAndUpdate(
        { _id: request._id, status: "pending", expiresAt: { $gt: new Date(now) } },
        { $set: { status: "used", usedAt: new Date(now) } },
        { new: true }
      );
      if (!claimed) return res.status(400).json({ error: messageFor("used") });

      const { user, created } = await accountFor(claimed.email);
      // The account or guest ticket went away after the email was sent.
      if (!user) return res.status(400).json({ error: "We couldn't find a TTFC account or ticket for this email." });
      res.json({ token: signAppToken(user, { via: VIA_EMAIL }), created });
    } catch (err) {
      console.error("EMAIL LINK VERIFY ERROR:", err);
      res.status(500).json({ error: "Something went wrong. Please try again." });
    }
  });

  return router;
}

export default createEmailLinkRouter();
