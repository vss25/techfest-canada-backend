import express from "express";
import { Resend } from "resend";

const router = express.Router();
const resend = new Resend(process.env.RESEND_API_KEY);

const safe = (v) => (v || "").toString().replace(/\n/g, "<br>");

function buildLeadEmail(lead) {
  return `
<div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px; color: #0d0520;">

  <div style="background: linear-gradient(135deg, #0077B5, #7a3fd1); padding: 24px; border-radius: 16px 16px 0 0;">
    <p style="margin: 0; color: rgba(255,255,255,0.9); font-size: 11px; letter-spacing: 2px; text-transform: uppercase; font-weight: 700;">New Lead · LinkedIn</p>
    <h1 style="margin: 8px 0 0; color: #fff; font-size: 22px; font-weight: 900;">${safe(lead.fullName)}</h1>
    <p style="margin: 6px 0 0; color: rgba(255,255,255,0.85); font-size: 13px;">
      <a href="mailto:${safe(lead.email)}" style="color: #fff; text-decoration: underline;">${safe(lead.email)}</a>
    </p>
  </div>

  <div style="background: #f7f5fc; padding: 24px; border-radius: 0 0 16px 16px; border: 1px solid #e8e2f5;">

    <div style="background: #fff; padding: 18px; border-radius: 10px; margin-bottom: 16px;">
      <p style="margin: 0 0 12px; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: #999; font-weight: 700;">Lead Details</p>
      <table style="width: 100%; font-size: 13px; color: #444;">
        <tr><td style="padding: 5px 0; width: 130px; color: #888;">Full Name</td><td><strong style="color: #0d0520;">${safe(lead.fullName)}</strong></td></tr>
        <tr><td style="padding: 5px 0; color: #888;">Email</td><td><a href="mailto:${safe(lead.email)}" style="color: #7a3fd1;">${safe(lead.email)}</a></td></tr>
        <tr><td style="padding: 5px 0; color: #888;">Source</td><td>LinkedIn (/linkedin landing page)</td></tr>
        <tr><td style="padding: 5px 0; color: #888;">Submitted</td><td>${new Date().toLocaleString("en-CA", { dateStyle: "full", timeStyle: "short" })}</td></tr>
      </table>
    </div>

    <div style="background: #fff; padding: 18px; border-radius: 10px;">
      <p style="margin: 0 0 8px; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: #999; font-weight: 700;">Suggested Action</p>
      <p style="margin: 0; font-size: 13px; color: #444; line-height: 1.6;">
        Reach out within 24 hours with event overview, ticket options, and any relevant partnership or exhibitor info based on their profile.
      </p>
    </div>
  </div>
</div>
  `.trim();
}

/* ═══════════════════════════════════════════════════════
   POST /api/linkedin-lead
   Captures name + email from the /linkedin landing page
   ═══════════════════════════════════════════════════════ */
router.post("/linkedin-lead", async (req, res) => {
  try {
    const { fullName, email } = req.body || {};

    if (!fullName || !fullName.trim()) {
      return res.status(400).json({ error: "Full name is required" });
    }
    if (!email || !email.trim()) {
      return res.status(400).json({ error: "Email is required" });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ error: "Invalid email address" });
    }

    const lead = {
      fullName: fullName.trim(),
      email: email.trim(),
    };

    await resend.emails.send({
      from: "TTFC Leads <noreply@thetechfestival.com>",
      to: "sales@thetechfestival.com",
      replyTo: lead.email,
      subject: `[LinkedIn Lead] ${lead.fullName} — ${lead.email}`,
      html: buildLeadEmail(lead),
    });

    res.status(201).json({ success: true });
  } catch (err) {
    console.error("LinkedIn lead submit error:", err);
    res.status(500).json({ error: "Server error. Please try again." });
  }
});

export default router;
