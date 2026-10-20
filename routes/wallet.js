import express from "express";
import jwt from "jsonwebtoken";
import QRCode from "qrcode";
import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import { buildPass, isConfigured, walletTagFor } from "../services/walletPass.js";
import { loadExhibitors } from "../services/exhibitorCache.js";
import { verifyTicketSig, walletPassUrl } from "../services/walletLink.js";
import { displayName } from "../services/attendeeDetails.js";
import { escapeHtml } from "../services/ticketInfo.js";
import { signedInWithoutPassword } from "../services/signInMethod.js";

/* =========================================================
   GET /api/wallet/pass/:ticketId
     Either   Authorization: Bearer <user token>  (iOS app / website;
              the ticket must be on the caller's account, staff
              signed in with a password may fetch any)
     or       ?sig=<hmac>  — the signed link in the ticket email/PDF,
              for guests without an account (services/walletLink.js)
   → application/vnd.apple.pkpass. 503 until the Pass Type ID cert
     is configured — see services/walletPass.js. The pass is in the
     holder's Profile colour (Oct 20 2026, services/walletPass.js
     walletTagFor): the account that has the ticket (its types, VIP
     flag and passes, as GET /api/auth/me), else the pass-only
     person's Attendee record (VIP / Media marks, Speaker Pass,
     exhibitor, the pass type).

   GET /api/wallet/link/:ticketId
     Authorization: Bearer <user token>, same ticket rule as /pass.
   → { url }: the signed /pass link (the one the ticket email carries),
     for the web app. Safari can't follow a Bearer fetch into the Wallet
     sheet, so the page sets window.location.href to this URL instead.
     503 until Apple Wallet is set up (Pass certificate or link secret).

   GET /api/wallet/qr/:ticketId?sig=<hmac>
   → PNG of the ticket QR (bare ticket ID, same as the PDF) for the
     confirmation email. Needs only the link secret, no DB lookup.

   GET /api/wallet/status → { configured }
========================================================= */

const router = express.Router();

router.get("/status", (_req, res) => res.json({ configured: isConfigured() }));

const wantsHtml = (req) => !req.headers.authorization && req.accepts(["json", "html"]) === "html";

/** JSON for API clients; a small branded page for people who tapped the email button. */
function sendProblem(req, res, status, message) {
  if (!wantsHtml(req)) return res.status(status).json({ error: message });
  res.status(status).type("html").send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>TTFC 2026 — Apple Wallet</title></head>
<body style="margin:0;background:#06020f;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<div style="max-width:440px;margin:0 auto;padding:56px 24px;text-align:center;">
<div style="font-weight:800;letter-spacing:2px;font-size:22px;">TTFC 2026</div>
<p style="font-size:17px;line-height:1.5;margin:28px 0 12px;">${escapeHtml(message)}</p>
<p style="color:#c9bfe3;font-size:15px;line-height:1.5;margin:0;">The ticket PDF attached to your confirmation email works at the door — show its QR code on your phone or printed.
Questions? <a style="color:#fff" href="mailto:enquire@thetechfestival.com">enquire@thetechfestival.com</a></p>
</div></body></html>`);
}

// What the Profile colour needs from an account (services/profileTag.js via walletTagFor).
const HOLDER_SELECT = "name role tickets types typesOff vip";
/** Passes marked VIP / Media / exhibitor, for an account's colour (cached for a minute; none if it can't load). */
const passMarks = () => loadExhibitors().catch(() => null);

/** Tier + display name + whose ticket it is, for a ticket ID, from an account or a guest purchase. */
async function findTicket(ticketId) {
  const owner = await User.findOne({ "tickets.ticketId": ticketId }).select(HOLDER_SELECT);
  const t = owner?.tickets.find((x) => x.ticketId === ticketId);
  if (t) return { tier: t.type, name: displayName(t.details, owner.name), purchaseDate: t.purchaseDate, account: owner };
  const a = await Attendee.findOne({ ticketId }).select("name ticketType details purchaseDate promoCode vip media exhibitor").lean();
  if (a) return { tier: a.ticketType, name: displayName(a.details, a.name), purchaseDate: a.purchaseDate, attendee: a };
  return null;
}

/** Bearer caller → { owner, ticket } when the ticket is on their account (staff
    signed in with a password: on any account), else { status, error }. Shared by /pass and /link. */
async function ticketForCaller(req, ticketId) {
  const h = req.headers.authorization;
  if (!h) return { status: 401, error: "Unauthorized" };
  let decoded;
  try { decoded = jwt.verify(h.split(" ")[1], process.env.JWT_SECRET); }
  catch { return { status: 401, error: "Invalid token" }; }

  const user = await User.findById(decoded.id).select(HOLDER_SELECT);
  if (!user) return { status: 401, error: "Unauthorized" };

  let owner = user;
  let ticket = user.tickets.find((t) => t.ticketId === ticketId);
  // Staff may fetch anyone's pass, but only with a password sign-in (like the admin panel).
  if (!ticket && user.role === "admin" && !signedInWithoutPassword(decoded)) {
    owner = await User.findOne({ "tickets.ticketId": ticketId }).select(HOLDER_SELECT);
    ticket = owner?.tickets.find((t) => t.ticketId === ticketId);
  }
  if (!ticket) return { status: 404, error: "Ticket not found on this account" };
  return { owner, ticket };
}

router.get("/link/:ticketId", async (req, res) => {
  try {
    const ticketId = String(req.params.ticketId);
    const found = await ticketForCaller(req, ticketId);
    if (found.error) return res.status(found.status).json({ error: found.error });
    const url = isConfigured() ? walletPassUrl(ticketId) : "";
    if (!url) return res.status(503).json({ error: "Apple Wallet passes are not set up yet" });
    res.set("Cache-Control", "private, no-store");
    res.json({ url });
  } catch (err) {
    console.error("WALLET LINK ERROR:", err);
    res.status(500).json({ error: "Could not make the Apple Wallet link" });
  }
});

router.get("/pass/:ticketId", async (req, res) => {
  try {
    const ticketId = String(req.params.ticketId);
    const sig = typeof req.query.sig === "string" ? req.query.sig : "";
    let pass;

    if (sig) {
      // Signed public link (email / PDF). A bad signature looks the same as an unknown ticket.
      if (!verifyTicketSig(ticketId, sig)) return sendProblem(req, res, 404, "This Apple Wallet link isn't valid.");
      if (!isConfigured()) {
        return sendProblem(req, res, 503, "Apple Wallet passes aren't available just yet. Please try again later.");
      }
      const found = await findTicket(ticketId);
      if (!found) return sendProblem(req, res, 404, "We couldn't find this ticket.");
      const { account, attendee, ...ticket } = found;
      const tag = walletTagFor({ account, attendee, index: account ? await passMarks() : null });
      pass = { ticketId, ...ticket, tag };
    } else {
      const found = await ticketForCaller(req, ticketId);
      if (found.error) return res.status(found.status).json({ error: found.error });
      const { owner, ticket } = found;
      if (!isConfigured()) return res.status(503).json({ error: "Apple Wallet passes are not set up yet" });
      // The colour is the ticket holder's (staff fetching someone's pass get that person's colour).
      const tag = walletTagFor({ account: owner, index: await passMarks() });
      pass = { ticketId, tier: ticket.type, name: owner.name, purchaseDate: ticket.purchaseDate, tag };
    }

    const buf = await buildPass(pass);
    res.set("Content-Type", "application/vnd.apple.pkpass");
    res.set("Content-Disposition", `attachment; filename="TTFC-${ticketId}.pkpass"`);
    res.set("Cache-Control", "private, no-store");
    res.send(buf);
  } catch (err) {
    console.error("WALLET PASS ERROR:", err);
    sendProblem(req, res, 500, "We couldn't build your Apple Wallet pass right now. Please try again in a few minutes.");
  }
});

router.get("/qr/:ticketId", async (req, res) => {
  try {
    const ticketId = String(req.params.ticketId);
    const sig = typeof req.query.sig === "string" ? req.query.sig : "";
    if (!verifyTicketSig(ticketId, sig)) return res.status(404).json({ error: "Not found" });
    const png = await QRCode.toBuffer(ticketId, {
      errorCorrectionLevel: "H", margin: 1, width: 360,
      color: { dark: "#140a26", light: "#ffffff" },
    });
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.send(png);
  } catch (err) {
    console.error("WALLET QR ERROR:", err);
    res.status(500).json({ error: "Could not render the QR code" });
  }
});

export default router;
