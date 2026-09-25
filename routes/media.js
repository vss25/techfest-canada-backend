import express from "express";
import mongoose from "mongoose";
import { Resend } from "resend";

const router = express.Router();

/* =========================================================
   📰 MEDIA ACCREDITATION

   Mounted in server.js as:
       app.use("/api/media", mediaRouter);
   → POST /api/media/apply

   Uses Resend, the same mailer as routes/pavilion.js — no new
   dependency. (An earlier version imported nodemailer, which
   isn't in package.json, and that crashed the Render deploy.)

   Deliberately SELF-CONTAINED: the mongoose schema lives in
   this file rather than models/, so there is no cross-file
   import that has to be deployed in a particular order.
========================================================= */

/* Who gets the notification. Both addresses are on the same send, so
   one email lands in both inboxes and replies stay on one thread.
   MEDIA_INBOX in env overrides this list — comma-separate for several. */
const RECIPIENTS = (
  process.env.MEDIA_INBOX ||
  "sales@thetechfestival.com,nicole@thetechfestival.com,marcom@thetechfestival.com"
)
  .split(",")
  .map((a) => a.trim())
  .filter(Boolean);

// Address the applicant's confirmation email replies to
const REPLY_TO = "marcom@thetechfestival.com";
const FROM = "TTFC 2026 Media <noreply@thetechfestival.com>";

/* Instantiated lazily so a missing RESEND_API_KEY can never throw
   while Express is still wiring up routes. */
let resendClient = null;
function getResend() {
  if (resendClient) return resendClient;
  if (!process.env.RESEND_API_KEY) {
    console.warn("📰 Media form: RESEND_API_KEY missing — submissions will be saved but not emailed.");
    return null;
  }
  resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

/* ---------------- model ---------------- */
const mediaSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    organization: { type: String, required: true, trim: true },
    coverage: { type: [String], default: [] },
    coverageOther: { type: String, default: "", trim: true },
    website: { type: String, required: true, trim: true },
    emailed: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "mediaapplications" }
);

// Guard against "Cannot overwrite model" when the module is re-evaluated
const MediaApplication =
  mongoose.models.MediaApplication || mongoose.model("MediaApplication", mediaSchema);

/* ---------------- helpers ---------------- */
const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Prefix a bare domain so the link in the email is clickable. */
function normalizeUrl(raw) {
  const v = String(raw || "").trim();
  if (!v) return "";
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

/* Light in-memory throttle: 5 submissions per IP per hour.
   Resets on restart, which is fine — it only exists to blunt
   bulk spam, not to be an audit trail. */
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  if (list.length >= 5) {
    hits.set(ip, list);
    return true;
  }
  list.push(now);
  hits.set(ip, list);
  return false;
}

const torontoTime = (d) =>
  new Date(d).toLocaleString("en-CA", { timeZone: "America/Toronto" });

function buildAdminEmail(doc) {
  const areas = [
    ...doc.coverage.filter((c) => c !== "Other"),
    ...(doc.coverageOther ? [`Other: ${doc.coverageOther}`] : []),
  ];

  const url = normalizeUrl(doc.website);

  const row = (label, value) => `
    <tr>
      <td style="padding:9px 14px 9px 0;font:600 12px/1.4 Arial,sans-serif;color:#6b6480;white-space:nowrap;vertical-align:top;text-transform:uppercase;letter-spacing:.6px">${esc(label)}</td>
      <td style="padding:9px 0;font:400 15px/1.5 Arial,sans-serif;color:#0d0520">${value}</td>
    </tr>`;

  return `
  <div style="background:#f5f3fa;padding:28px 12px;font-family:Arial,Helvetica,sans-serif">
    <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 14px rgba(13,5,32,.08)">
      <div style="background:linear-gradient(135deg,#7a3fd1,#f5a623);padding:22px 26px">
        <div style="font:800 11px/1 Arial,sans-serif;letter-spacing:2.4px;text-transform:uppercase;color:rgba(255,255,255,.85)">TTFC 2026 &middot; Press &amp; Media</div>
        <div style="font:800 21px/1.25 Arial,sans-serif;color:#ffffff;margin-top:7px">New Media Accreditation Request</div>
      </div>
      <div style="padding:24px 26px">
        <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">
          ${row("Full name", esc(doc.fullName))}
          ${row("Email", `<a href="mailto:${esc(doc.email)}" style="color:#7a3fd1;text-decoration:none">${esc(doc.email)}</a>`)}
          ${row("Organization", esc(doc.organization))}
          ${row("Website", url ? `<a href="${esc(url)}" style="color:#7a3fd1;word-break:break-all;text-decoration:none">${esc(doc.website)}</a>` : "&mdash;")}
        </table>

        <div style="margin-top:20px;padding-top:18px;border-top:1px solid #ece8f5">
          <div style="font:600 12px/1.4 Arial,sans-serif;color:#6b6480;text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px">Coverage areas</div>
          ${areas
            .map(
              (a) =>
                `<span style="display:inline-block;margin:0 6px 6px 0;padding:6px 11px;border-radius:999px;background:#f2ecff;color:#5b2ba8;font:600 12.5px/1 Arial,sans-serif">${esc(a)}</span>`
            )
            .join("")}
        </div>

        <div style="margin-top:22px;font:400 12px/1.5 Arial,sans-serif;color:#8a839c">
          Submitted ${esc(torontoTime(doc.createdAt))} (Toronto) &middot; Reply directly to this email to reach the applicant.
        </div>
      </div>
    </div>
  </div>`;
}

function buildAckEmail(doc) {
  const first = esc(String(doc.fullName).split(" ")[0]);
  return `
  <div style="background:#f5f3fa;padding:28px 12px;font-family:Arial,Helvetica,sans-serif">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden">
      <div style="background:linear-gradient(135deg,#7a3fd1,#f5a623);padding:20px 26px;font:800 18px/1.3 Arial,sans-serif;color:#fff">
        Request received
      </div>
      <div style="padding:24px 26px;font:400 15px/1.65 Arial,sans-serif;color:#0d0520">
        <p style="margin:0 0 14px">Hi ${first},</p>
        <p style="margin:0 0 14px">Thanks for requesting media accreditation for <strong>The Tech Festival Canada 2026</strong> &mdash; 26&ndash;27 October, Westin Harbour Castle, Toronto.</p>
        <p style="margin:0 0 14px">Our press team reviews requests on a rolling basis and will be in touch at this address.</p>
        <p style="margin:22px 0 0;font-size:13px;color:#6b6480">
          The Tech Festival Canada<br />
          <a href="mailto:marcom@thetechfestival.com" style="color:#7a3fd1;text-decoration:none">marcom@thetechfestival.com</a>
        </p>
      </div>
    </div>
  </div>`;
}

/* =========================================================
   POST /api/media/apply
========================================================= */
router.post("/apply", async (req, res) => {
  try {
    const ip = (req.headers["x-forwarded-for"] || req.ip || "unknown")
      .toString()
      .split(",")[0]
      .trim();

    // Honeypot: only bots fill the off-screen input. Return 200 so
    // they don't learn they were caught.
    if (req.body?._hp) return res.json({ success: true });

    if (rateLimited(ip)) {
      return res
        .status(429)
        .json({ error: "Too many submissions. Please email marcom@thetechfestival.com." });
    }

    const fullName = String(req.body.fullName || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const organization = String(req.body.organization || "").trim();
    const website = String(req.body.website || "").trim();
    const coverageOther = String(req.body.coverageOther || "").trim();
    const coverage = Array.isArray(req.body.coverage)
      ? req.body.coverage.map((c) => String(c).trim()).filter(Boolean).slice(0, 40)
      : [];

    if (!fullName) return res.status(400).json({ error: "Full name is required" });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "A valid email address is required" });
    if (!organization) return res.status(400).json({ error: "Organization is required" });
    if (!website) return res.status(400).json({ error: "Website / media link is required" });
    if (coverage.length === 0) return res.status(400).json({ error: "Select at least one coverage area" });
    if (coverage.includes("Other") && !coverageOther) {
      return res.status(400).json({ error: "Please specify your other coverage area" });
    }

    // Save FIRST so a mail failure never loses the lead
    const doc = await MediaApplication.create({
      fullName,
      email,
      organization,
      coverage,
      coverageOther,
      website,
    });

    const resend = getResend();

    if (resend) {
      // Notification to the press team
      try {
        await resend.emails.send({
          from: FROM,
          to: RECIPIENTS,
          replyTo: [email],
          subject: `Media Accreditation — ${fullName}, ${organization}`,
          html: buildAdminEmail(doc),
        });

        doc.emailed = true;
        await doc.save();
      } catch (mailErr) {
        // Already saved in Mongo, so this is recoverable — don't fail the user
        console.error("📰 Media form: notification email failed:", mailErr?.message || mailErr);
      }

      // Confirmation to the applicant (best effort)
      try {
        await resend.emails.send({
          from: FROM,
          to: [email],
          replyTo: [REPLY_TO],
          subject: "We received your media accreditation request — TTFC 2026",
          html: buildAckEmail(doc),
        });
      } catch (ackErr) {
        console.error("📰 Media form: applicant confirmation failed:", ackErr?.message || ackErr);
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("Media apply error:", err);
    return res
      .status(500)
      .json({ error: "Could not submit right now. Please email marcom@thetechfestival.com." });
  }
});

/* =========================================================
   GET /api/media/applications?key=...
   Quick read-only export so nothing is stranded in Mongo if
   an email ever fails. Requires ADMIN_EXPORT_KEY in env; if
   that isn't set the route is disabled.
========================================================= */
router.get("/applications", async (req, res) => {
  try {
    const key = process.env.ADMIN_EXPORT_KEY;
    if (!key) return res.status(404).json({ error: "Not found" });
    if (req.query.key !== key) return res.status(401).json({ error: "Unauthorized" });

    const rows = await MediaApplication.find().sort({ createdAt: -1 }).lean();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
