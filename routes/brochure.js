import express from "express";
import Brochure from "../models/Brochure.js";
import { makeLimiter } from "../services/ticketAccess.js";
import {
  BROCHURES, validateBrochureRequest, isHoneypotFilled, dedupeSince, websiteBase, brochureUrl,
  salesInbox, attachMaxBytes, loadAttachment, cleanText,
} from "../services/brochureDownloads.js";
import { sendBrochureEmail, sendBrochureReceiptEmail } from "../services/emailService.js";

/* =========================================================
   Brochure downloads — mounted at /api/brochure
   POST /api/brochure/submit  { firstName, lastName, email, company?, jobTitle?,
                                industry?, phone?, brochure?, page?, referrer?, _hp }
   ---------------------------------------------------------
   Saves the download, answers straight away, then (in the
   background) emails the person the brochure and sends a receipt
   to sales@. The website unlocks the PDF without waiting for this,
   so a slow or failed email never blocks a download.
   Staff see the list in Admin → Brochure downloads (routes/console.js).
   Pure parts: services/brochureDownloads.js, services/brochureEmail.js.
========================================================= */

const router = express.Router();

// server.js trusts one proxy hop, so req.ip is the visitor (a client-sent
// X-Forwarded-For can't be used to dodge the limits).
const clientIp = (req) => String(req.ip || "unknown");

// In memory, reset on restart: only there to blunt bulk spam.
const ipLimiter = makeLimiter({ max: 10, windowMs: 15 * 60 * 1000 });
const emailLimiter = makeLimiter({ max: 5, windowMs: 60 * 60 * 1000 });

const TOO_MANY = "Too many requests. Please try again later or email sales@thetechfestival.com.";

/** Email the brochure, then the sales receipt, and record what happened. Never throws. */
async function deliverBrochure(doc) {
  const brochure = BROCHURES[doc.brochure];
  const base = websiteBase();
  const link = brochureUrl(brochure, base);
  let delivery = "failed";
  let emailError = "";

  try {
    // Attached only when the website's PDF is small enough; otherwise link only.
    const attachment = await loadAttachment(brochure, { base, maxBytes: attachMaxBytes() });
    await sendBrochureEmail({ email: doc.email, firstName: doc.firstName, brochure, link, attachment });
    delivery = attachment ? "attached" : "link";
  } catch (err) {
    emailError = String(err?.message || err).slice(0, 300);
    console.error("BROCHURE EMAIL ERROR:", emailError);
  }

  let salesNotified = false;
  try {
    await sendBrochureReceiptEmail({ to: salesInbox(), lead: doc, brochure, delivery });
    salesNotified = true;
  } catch (err) {
    console.error("BROCHURE RECEIPT ERROR:", err?.message || err);
  }

  const sent = delivery !== "failed";
  const set = { emailStatus: sent ? "sent" : "failed", delivery: sent ? delivery : "", emailError, salesNotified };
  if (sent) set.emailedAt = new Date();
  await Brochure.updateOne({ _id: doc._id }, { $set: set }).catch((err) => console.error("BROCHURE STATUS SAVE ERROR:", err?.message || err));
}

router.post("/submit", async (req, res) => {
  try {
    const body = req.body || {};

    // Honeypot: only bots fill the off-screen input. Same answer as a real
    // submission so they don't learn they were caught.
    if (isHoneypotFilled(body)) return res.status(201).json({ success: true, message: "Saved successfully" });

    if (!ipLimiter.hit(clientIp(req))) return res.status(429).json({ success: false, message: TOO_MANY });

    const check = validateBrochureRequest(body);
    if (!check.ok) return res.status(400).json({ success: false, message: check.error, field: check.field });
    const v = check.value;

    if (!emailLimiter.hit(v.email)) return res.status(429).json({ success: false, message: TOO_MANY });

    // Same person, same brochure, emailed in the last 10 minutes → save, don't email again.
    const recent = await Brochure.exists({
      email: v.email, brochure: v.brochure, emailStatus: { $in: ["sending", "sent"] }, createdAt: { $gte: dedupeSince() },
    });

    const doc = await Brochure.create({
      ...v,
      userAgent: cleanText(req.headers["user-agent"]).slice(0, 300),
      emailStatus: recent ? "duplicate" : "sending",
    });

    res.status(201).json({ success: true, message: "Saved successfully", emailed: !recent });

    if (!recent) deliverBrochure(doc);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ success: false, message: "Server error" });
  }
});

export default router;
