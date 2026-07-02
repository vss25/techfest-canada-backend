import express from "express";
import { Resend } from "resend";

const router = express.Router();
const resend = new Resend(process.env.RESEND_API_KEY);

/* ═══════════════════════════════════════════════════════
   HELPER — Build the pretty HTML email
   ═══════════════════════════════════════════════════════ */
function buildEmail(n) {
  const specialAwardLabels = {
    lifetime: "Lifetime Achievement Award",
    rising: "Rising Innovator Award",
    crossborder: "Cross-Border Impact Award",
  };

  const category = n.categoryType === "matrix"
    ? `The Catalyst Award for ${n.pillar} in ${n.sector}`
    : specialAwardLabels[n.specialAward] || "Special Recognition";

  const safe = (v) => (v || "").toString().replace(/\n/g, "<br>");

  return `
<div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 640px; margin: 0 auto; padding: 32px 24px; color: #0d0520;">

  <div style="background: linear-gradient(135deg, #7a3fd1, #f5a623); padding: 24px; border-radius: 16px 16px 0 0;">
    <p style="margin: 0; color: rgba(255,255,255,0.85); font-size: 11px; letter-spacing: 2px; text-transform: uppercase; font-weight: 700;">New Nomination Received</p>
    <h1 style="margin: 8px 0 0; color: #fff; font-size: 24px; font-weight: 900;">The Catalyst Awards</h1>
  </div>

  <div style="background: #f7f5fc; padding: 24px; border-radius: 0 0 16px 16px; border: 1px solid #e8e2f5;">

    <h2 style="margin: 0 0 6px; font-size: 18px; color: #7a3fd1;">${category}</h2>
    <p style="margin: 0 0 24px; color: #666; font-size: 14px;">
      Submitted ${new Date().toLocaleString("en-CA", { dateStyle: "full", timeStyle: "short" })}
    </p>

    <div style="background: #fff; padding: 18px; border-radius: 10px; margin-bottom: 16px;">
      <p style="margin: 0 0 4px; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: #999; font-weight: 700;">Nominee</p>
      <h3 style="margin: 0 0 12px; font-size: 16px;">${safe(n.nomineeName)}</h3>
      <table style="width: 100%; font-size: 13px; color: #444;">
        ${n.nomineeTitle ? `<tr><td style="padding: 3px 0; width: 130px; color: #888;">Title</td><td>${safe(n.nomineeTitle)}</td></tr>` : ""}
        <tr><td style="padding: 3px 0; color: #888;">Organisation</td><td>${safe(n.nomineeOrganisation)}</td></tr>
        <tr><td style="padding: 3px 0; color: #888;">Type</td><td>${safe(n.nomineeType)}</td></tr>
        <tr><td style="padding: 3px 0; color: #888;">Location</td><td>${safe(n.nomineeLocation)}</td></tr>
        ${n.nomineeSector ? `<tr><td style="padding: 3px 0; color: #888;">Sector</td><td>${safe(n.nomineeSector)}</td></tr>` : ""}
        <tr><td style="padding: 3px 0; color: #888;">Email</td><td><a href="mailto:${safe(n.nomineeEmail)}" style="color: #7a3fd1;">${safe(n.nomineeEmail)}</a></td></tr>
        ${n.nomineePhone ? `<tr><td style="padding: 3px 0; color: #888;">Phone</td><td>${safe(n.nomineePhone)}</td></tr>` : ""}
        ${n.nomineeWebsite ? `<tr><td style="padding: 3px 0; color: #888;">Website</td><td><a href="${safe(n.nomineeWebsite)}" style="color: #7a3fd1;">${safe(n.nomineeWebsite)}</a></td></tr>` : ""}
        ${n.nomineeLinkedIn ? `<tr><td style="padding: 3px 0; color: #888;">LinkedIn</td><td><a href="${safe(n.nomineeLinkedIn)}" style="color: #7a3fd1;">${safe(n.nomineeLinkedIn)}</a></td></tr>` : ""}
      </table>
    </div>

    <div style="background: #fff; padding: 18px; border-radius: 10px; margin-bottom: 16px;">
      <p style="margin: 0 0 4px; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: #999; font-weight: 700;">Nominator ${n.selfNomination ? "(Self-nomination)" : ""}</p>
      <h3 style="margin: 0 0 12px; font-size: 16px;">${safe(n.nominatorName)}</h3>
      <table style="width: 100%; font-size: 13px; color: #444;">
        ${n.nominatorTitle ? `<tr><td style="padding: 3px 0; width: 130px; color: #888;">Title</td><td>${safe(n.nominatorTitle)}</td></tr>` : ""}
        <tr><td style="padding: 3px 0; color: #888;">Organisation</td><td>${safe(n.nominatorOrganisation)}</td></tr>
        <tr><td style="padding: 3px 0; color: #888;">Relationship</td><td>${safe(n.nominatorRelationship)}</td></tr>
        <tr><td style="padding: 3px 0; color: #888;">Email</td><td><a href="mailto:${safe(n.nominatorEmail)}" style="color: #7a3fd1;">${safe(n.nominatorEmail)}</a></td></tr>
        ${n.nominatorPhone ? `<tr><td style="padding: 3px 0; color: #888;">Phone</td><td>${safe(n.nominatorPhone)}</td></tr>` : ""}
      </table>
    </div>

    <div style="background: #fff; padding: 18px; border-radius: 10px;">
      <p style="margin: 0 0 12px; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: #999; font-weight: 700;">Nomination Statement</p>

      <p style="margin: 12px 0 6px; font-weight: 700; font-size: 13px; color: #7a3fd1;">Overview</p>
      <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #333;">${safe(n.statementOverview)}</p>

      <p style="margin: 20px 0 6px; font-weight: 700; font-size: 13px; color: #7a3fd1;">Innovation &amp; Impact</p>
      <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #333;">${safe(n.statementImpact)}</p>

      <p style="margin: 20px 0 6px; font-weight: 700; font-size: 13px; color: #7a3fd1;">Key Achievements</p>
      <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #333;">${safe(n.statementAchievements)}</p>

      ${n.statementEvidence ? `
      <p style="margin: 20px 0 6px; font-weight: 700; font-size: 13px; color: #7a3fd1;">Supporting Evidence</p>
      <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #333;">${safe(n.statementEvidence)}</p>
      ` : ""}
    </div>

    <p style="margin: 24px 0 0; padding-top: 20px; border-top: 1px solid #e0d8f0; text-align: center; font-size: 12px; color: #999;">
      Signed by <strong>${safe(n.signatureName)}</strong>
    </p>
  </div>
</div>
  `.trim();
}

/* ═══════════════════════════════════════════════════════
   POST /api/nominations
   Receives form data, emails it to admin, done.
   No database, no admin routes.
   ═══════════════════════════════════════════════════════ */
router.post("/nominations", async (req, res) => {
  try {
    const n = req.body || {};

    // Basic validation
    if (!n.categoryType) {
      return res.status(400).json({ error: "Please choose an award category" });
    }
    if (n.categoryType === "matrix" && (!n.pillar || !n.sector)) {
      return res.status(400).json({ error: "Both a pillar and sector are required" });
    }
    if (n.categoryType === "special" && !n.specialAward) {
      return res.status(400).json({ error: "Please select a Special Recognition award" });
    }
    if (!n.nomineeName || !n.nomineeEmail || !n.nominatorName || !n.nominatorEmail) {
      return res.status(400).json({ error: "Nominee and nominator names + emails are required" });
    }

    // Build a nice subject line
    const specialAwardLabels = {
      lifetime: "Lifetime Achievement",
      rising: "Rising Innovator",
      crossborder: "Cross-Border Impact",
    };
    const categoryShort = n.categoryType === "matrix"
      ? `${n.pillar} × ${n.sector}`
      : specialAwardLabels[n.specialAward] || "Special Recognition";

    // Fire the email via Resend
    await resend.emails.send({
      from: "TTFC Catalyst Awards <noreply@thetechfestival.com>",
      to: "baldeep@thetechfestival.com",
      replyTo: n.nominatorEmail,
      subject: `[Catalyst Nomination] ${n.nomineeName} — ${categoryShort}`,
      html: buildEmail(n),
    });

    res.status(201).json({
      success: true,
      message: "Nomination received. Thank you!",
    });
  } catch (err) {
    console.error("Nomination submit error:", err);
    res.status(500).json({ error: "Server error. Please try again." });
  }
});

export default router;
