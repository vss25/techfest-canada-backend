import express from "express";
import { Resend } from "resend";

const router = express.Router();
const resend = new Resend(process.env.RESEND_API_KEY);

const PROGRAMME_LABELS = {
  speaking: "Speaking opportunity",
  mou: "MoU signing ceremony",
  b2b: "Curated B2B meetings",
  forum: "India Business Forum participation",
  investor: "Investor / capital introductions",
};

const BOOTH_LABELS = {
  single: { label: "Single", size: "10' × 10'", pay: 499 },
  double: { label: "Double", size: "10' × 20'", pay: 999 },
  triple: { label: "Triple", size: "10' × 30'", pay: 1499 },
  quadruple: { label: "Quadruple", size: "10' × 40'", pay: 1999 },
};

const safe = (v) => (v || "").toString().replace(/\n/g, "<br>");
const yn = (v) => v === "yes" ? "Yes" : v === "no" ? "No" : "—";

/* ═══════════════════════════════════════════════════════
   HELPER — Admin email (goes to sales@)
   ═══════════════════════════════════════════════════════ */
function buildAdminEmail(n) {
  const booth = BOOTH_LABELS[n.boothTier] || { label: "—", size: "—", pay: 0 };
  const interests = (n.programmeInterests || []).map((k) => PROGRAMME_LABELS[k]).filter(Boolean);

  return `
<div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 680px; margin: 0 auto; padding: 32px 24px; color: #0d0520;">

  <div style="background: linear-gradient(135deg, #7a3fd1, #f5a623); padding: 24px; border-radius: 16px 16px 0 0;">
    <p style="margin: 0; color: rgba(255,255,255,0.85); font-size: 11px; letter-spacing: 2px; text-transform: uppercase; font-weight: 700;">New Application</p>
    <h1 style="margin: 8px 0 0; color: #fff; font-size: 24px; font-weight: 900;">India Startup Pavilion</h1>
    <p style="margin: 6px 0 0; color: rgba(255,255,255,0.75); font-size: 12px;">The Tech Festival Canada 2026</p>
  </div>

  <div style="background: #f7f5fc; padding: 24px; border-radius: 0 0 16px 16px; border: 1px solid #e8e2f5;">

    <h2 style="margin: 0 0 6px; font-size: 20px; color: #7a3fd1;">${safe(n.legalName)}</h2>
    <p style="margin: 0 0 24px; color: #666; font-size: 14px;">
      Submitted ${new Date().toLocaleString("en-CA", { dateStyle: "full", timeStyle: "short" })}
    </p>

    <!-- Selected booth summary at top -->
    <div style="background: linear-gradient(135deg, rgba(122,63,209,0.08), rgba(245,166,35,0.08)); padding: 18px; border-radius: 12px; border-left: 4px solid #f5a623; margin-bottom: 20px;">
      <p style="margin: 0 0 4px; font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; color: #7a3fd1; font-weight: 800;">Selected Booth</p>
      <h3 style="margin: 0 0 2px; font-size: 17px; color: #0d0520;">${booth.label} Booth (${booth.size})</h3>
      <p style="margin: 4px 0 0; font-size: 14px; color: #666;">Net payable (after subsidy): <strong style="color: #f5a623;">CAD $${booth.pay.toLocaleString()}</strong></p>
    </div>

    <!-- Company details -->
    <div style="background: #fff; padding: 18px; border-radius: 10px; margin-bottom: 16px;">
      <p style="margin: 0 0 12px; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: #999; font-weight: 700;">Company Details</p>
      <table style="width: 100%; font-size: 13px; color: #444;">
        ${n.tradingName ? `<tr><td style="padding: 3px 0; width: 160px; color: #888;">Trading Name</td><td>${safe(n.tradingName)}</td></tr>` : ""}
        ${n.cin ? `<tr><td style="padding: 3px 0; color: #888;">CIN</td><td>${safe(n.cin)}</td></tr>` : ""}
        ${n.incorporationDate ? `<tr><td style="padding: 3px 0; color: #888;">Incorporated</td><td>${safe(n.incorporationDate)}</td></tr>` : ""}
        ${n.yearFounded ? `<tr><td style="padding: 3px 0; color: #888;">Year Founded</td><td>${safe(n.yearFounded)}</td></tr>` : ""}
        ${n.employees ? `<tr><td style="padding: 3px 0; color: #888;">Employees</td><td>${safe(n.employees)}</td></tr>` : ""}
        <tr><td style="padding: 3px 0; color: #888; vertical-align: top;">Registered Office</td><td>${safe(n.registeredOffice)}</td></tr>
        ${n.website ? `<tr><td style="padding: 3px 0; color: #888;">Website</td><td><a href="${safe(n.website)}" style="color: #7a3fd1;">${safe(n.website)}</a></td></tr>` : ""}
        ${n.linkedIn ? `<tr><td style="padding: 3px 0; color: #888;">LinkedIn</td><td><a href="${safe(n.linkedIn)}" style="color: #7a3fd1;">${safe(n.linkedIn)}</a></td></tr>` : ""}
      </table>
    </div>

    <!-- Eligibility -->
    <div style="background: #fff; padding: 18px; border-radius: 10px; margin-bottom: 16px;">
      <p style="margin: 0 0 12px; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: #999; font-weight: 700;">Eligibility & Qualification</p>
      <table style="width: 100%; font-size: 13px; color: #444;">
        <tr><td style="padding: 3px 0; width: 200px; color: #888;">Indian company</td><td>${yn(n.isIndian)}</td></tr>
        <tr><td style="padding: 3px 0; color: #888;">MCA registered</td><td>${yn(n.isMcaRegistered)}${n.cinNumber ? ` — CIN: ${safe(n.cinNumber)}` : ""}${n.roc ? ` (${safe(n.roc)})` : ""}</td></tr>
        <tr><td style="padding: 3px 0; color: #888;">DPIIT recognised</td><td>${yn(n.isDpiitRecognised)}${n.dpiitNumber ? ` — ${safe(n.dpiitNumber)}` : ""}</td></tr>
        ${n.isDpiitRecognised === "no" ? `<tr><td style="padding: 3px 0; color: #888;">Incubator endorsed</td><td>${yn(n.isIncubatorEndorsed)}${n.incubator ? ` — ${safe(n.incubator)}` : ""}</td></tr>` : ""}
        <tr><td style="padding: 3px 0; color: #888;">Canadian operations</td><td>${yn(n.hasCanadianOps)}</td></tr>
        ${n.canadianPresence ? `<tr><td style="padding: 3px 0; color: #888; vertical-align: top;">Canadian presence</td><td>${safe(n.canadianPresence)}</td></tr>` : ""}
        <tr><td style="padding: 3px 0; color: #888;">Business stage</td><td>${safe(n.businessStage)}${n.otherStage ? ` — ${safe(n.otherStage)}` : ""}</td></tr>
        ${n.latestFunding ? `<tr><td style="padding: 3px 0; color: #888;">Latest funding</td><td>${safe(n.latestFunding)}</td></tr>` : ""}
        ${n.annualRevenue ? `<tr><td style="padding: 3px 0; color: #888;">Annual revenue</td><td>${safe(n.annualRevenue)}</td></tr>` : ""}
      </table>
    </div>

    <!-- Business overview -->
    <div style="background: #fff; padding: 18px; border-radius: 10px; margin-bottom: 16px;">
      <p style="margin: 0 0 12px; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: #999; font-weight: 700;">Business Overview</p>
      <p style="margin: 0 0 6px; font-size: 13px; color: #888;">Technology domain</p>
      <p style="margin: 0 0 14px; font-size: 14px; color: #333; font-weight: 600;">${safe(n.techDomain)}</p>
      <p style="margin: 0 0 6px; font-size: 13px; color: #888;">Applied sector</p>
      <p style="margin: 0 0 14px; font-size: 14px; color: #333; font-weight: 600;">${safe(n.sector)}${n.otherSector ? ` — ${safe(n.otherSector)}` : ""}</p>

      <p style="margin: 20px 0 6px; font-weight: 700; font-size: 13px; color: #7a3fd1;">Company Description</p>
      <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #333;">${safe(n.companyDescription)}</p>

      <p style="margin: 20px 0 6px; font-weight: 700; font-size: 13px; color: #7a3fd1;">Traction &amp; Milestones</p>
      <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #333;">${safe(n.traction)}</p>

      <p style="margin: 20px 0 6px; font-weight: 700; font-size: 13px; color: #7a3fd1;">Objective at TTFC 2026</p>
      <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #333;">${safe(n.objective)}</p>
    </div>

    <!-- Programme interests -->
    ${interests.length > 0 ? `
    <div style="background: #fff; padding: 18px; border-radius: 10px; margin-bottom: 16px;">
      <p style="margin: 0 0 12px; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: #999; font-weight: 700;">Programme Interests</p>
      <ul style="margin: 0; padding-left: 20px; font-size: 13px; color: #444; line-height: 1.8;">
        ${interests.map((i) => `<li>${i}</li>`).join("")}
      </ul>
    </div>` : ""}

    <!-- Contact -->
    <div style="background: #fff; padding: 18px; border-radius: 10px; margin-bottom: 16px;">
      <p style="margin: 0 0 12px; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: #999; font-weight: 700;">Primary Contact</p>
      <h3 style="margin: 0 0 4px; font-size: 15px;">${safe(n.repName)}</h3>
      <p style="margin: 0 0 10px; font-size: 13px; color: #888;">${safe(n.repTitle)}</p>
      <table style="width: 100%; font-size: 13px; color: #444;">
        <tr><td style="padding: 3px 0; width: 120px; color: #888;">Email</td><td><a href="mailto:${safe(n.repEmail)}" style="color: #7a3fd1;">${safe(n.repEmail)}</a></td></tr>
        <tr><td style="padding: 3px 0; color: #888;">Mobile</td><td>${safe(n.repMobile)}</td></tr>
        ${n.secondaryContact ? `<tr><td style="padding: 3px 0; color: #888;">Secondary</td><td>${safe(n.secondaryContact)}</td></tr>` : ""}
      </table>

      ${(n.delegate1 || n.delegate2) ? `
      <p style="margin: 18px 0 8px; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: #999; font-weight: 700;">On-Site Delegates</p>
      ${n.delegate1 ? `<p style="margin: 4px 0; font-size: 13px; color: #444;">1. ${safe(n.delegate1)}</p>` : ""}
      ${n.delegate2 ? `<p style="margin: 4px 0; font-size: 13px; color: #444;">2. ${safe(n.delegate2)}</p>` : ""}
      ` : ""}
    </div>

    <p style="margin: 24px 0 0; padding-top: 20px; border-top: 1px solid #e0d8f0; text-align: center; font-size: 12px; color: #999;">
      Signed by <strong>${safe(n.signatureName)}</strong>, ${safe(n.signatureTitle)}
    </p>
  </div>
</div>
  `.trim();
}

/* ═══════════════════════════════════════════════════════
   HELPER — Confirmation email (goes to applicant)
   ═══════════════════════════════════════════════════════ */
function buildConfirmationEmail(n) {
  const booth = BOOTH_LABELS[n.boothTier] || { label: "—", size: "—", pay: 0 };

  return `
<div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px; color: #0d0520;">

  <div style="background: linear-gradient(135deg, #7a3fd1, #f5a623); padding: 32px 24px; border-radius: 16px 16px 0 0; text-align: center;">
    <p style="margin: 0; color: rgba(255,255,255,0.85); font-size: 11px; letter-spacing: 2px; text-transform: uppercase; font-weight: 700;">Application Received</p>
    <h1 style="margin: 10px 0 0; color: #fff; font-size: 26px; font-weight: 900; letter-spacing: -0.5px;">India Startup Pavilion</h1>
    <p style="margin: 8px 0 0; color: rgba(255,255,255,0.75); font-size: 13px;">The Tech Festival Canada · 26–27 October 2026</p>
  </div>

  <div style="background: #ffffff; padding: 32px 28px; border-radius: 0 0 16px 16px; border: 1px solid #e8e2f5;">

    <p style="margin: 0 0 20px; font-size: 16px; line-height: 1.6; color: #0d0520;">
      Namaste ${safe(n.repName).split(" ")[0] || "there"},
    </p>

    <p style="margin: 0 0 20px; font-size: 15px; line-height: 1.7; color: #333;">
      Thank you for applying to the <strong>India Startup Pavilion</strong> at The Tech Festival Canada 2026. We've received your application for <strong>${safe(n.legalName)}</strong> and our team will review it on a rolling basis.
    </p>

    <div style="background: #f7f5fc; padding: 20px; border-radius: 12px; border-left: 4px solid #f5a623; margin: 24px 0;">
      <p style="margin: 0 0 6px; font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: #7a3fd1; font-weight: 800;">Your Application Summary</p>
      <h3 style="margin: 0 0 4px; font-size: 17px; color: #0d0520;">${booth.label} Booth</h3>
      <p style="margin: 0 0 12px; font-size: 13px; color: #666;">${booth.size} · Net payable: <strong style="color: #f5a623;">CAD $${booth.pay.toLocaleString()}</strong> (after Consulate subsidy)</p>
      <p style="margin: 0; font-size: 13px; color: #666;">
        Domain: <strong style="color: #0d0520;">${safe(n.techDomain)}</strong><br>
        Sector: <strong style="color: #0d0520;">${safe(n.sector)}</strong>
      </p>
    </div>

    <h3 style="margin: 28px 0 12px; font-size: 15px; color: #0d0520; font-weight: 700;">What happens next</h3>
    <ul style="margin: 0 0 20px; padding-left: 20px; font-size: 14px; line-height: 1.75; color: #444;">
      <li>Applications are reviewed on a <strong>rolling basis</strong> — booths are limited.</li>
      <li>Our team may request supporting documents (Certificate of Incorporation, DPIIT / incubator endorsement).</li>
      <li>Approved applications will receive a countersignature and payment instructions.</li>
      <li>Booth is confirmed only upon receipt of the net amount payable.</li>
      <li>Applications close <strong>30 September 2026</strong>.</li>
    </ul>

    <p style="margin: 24px 0 0; font-size: 14px; line-height: 1.7; color: #333;">
      For any questions, reply to this email or reach us at <a href="mailto:sales@thetechfestival.com" style="color: #7a3fd1;">sales@thetechfestival.com</a>.
    </p>

    <div style="margin: 32px 0 0; padding-top: 24px; border-top: 1px solid #eee; text-align: center;">
      <a href="https://www.thetechfestival.com/exhibit" style="display: inline-block; padding: 12px 28px; background: linear-gradient(135deg, #7a3fd1, #f5a623); color: #fff; text-decoration: none; border-radius: 10px; font-weight: 800; font-size: 13px; letter-spacing: 0.5px; text-transform: uppercase;">
        Learn More About Exhibiting
      </a>
    </div>
  </div>

  <p style="text-align: center; margin: 20px 0 0; font-size: 12px; color: #999; line-height: 1.6;">
    India Country Partner · Endorsed by Consulate General of India, Toronto<br>
    The Tech Festival Canada · Produced by AtlasLink Markets Inc.<br>
    <a href="https://www.thetechfestival.com" style="color: #7a3fd1; text-decoration: none;">thetechfestival.com</a>
  </p>
</div>
  `.trim();
}

/* ═══════════════════════════════════════════════════════
   POST /api/pavilion
   ═══════════════════════════════════════════════════════ */
router.post("/pavilion", async (req, res) => {
  try {
    const n = req.body || {};

    // Basic validation
    if (!n.legalName || !n.repEmail || !n.repName) {
      return res.status(400).json({ error: "Company name, contact name and email are required" });
    }
    if (!n.boothTier || !BOOTH_LABELS[n.boothTier]) {
      return res.status(400).json({ error: "Please select a valid booth tier" });
    }
    if (n.isIndian !== "yes") {
      return res.status(400).json({ error: "This pavilion is only open to Indian-incorporated companies" });
    }

    const booth = BOOTH_LABELS[n.boothTier];

    // Send to sales team
    await resend.emails.send({
      from: "TTFC India Pavilion <noreply@thetechfestival.com>",
      to: "sales@thetechfestival.com",
      replyTo: n.repEmail,
      subject: `India Pavilion Application — ${n.legalName}`,
      html: buildAdminEmail(n),
    });

    // Send confirmation to applicant (non-blocking)
    try {
      await resend.emails.send({
        from: "TTFC India Pavilion <noreply@thetechfestival.com>",
        to: n.repEmail,
        replyTo: "sales@thetechfestival.com",
        subject: `India Pavilion Application Received — ${n.legalName}`,
        html: buildConfirmationEmail(n),
      });
    } catch (confirmErr) {
      console.error("Pavilion confirmation email failed (admin email still sent):", confirmErr);
    }

    res.status(201).json({
      success: true,
      message: "Application received. Thank you!",
    });
  } catch (err) {
    console.error("Pavilion submit error:", err);
    res.status(500).json({ error: "Server error. Please try again." });
  }
});

export default router;
