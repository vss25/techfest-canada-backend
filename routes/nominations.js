import express from "express";
import Nomination from "../models/Nomination.js";
import { requireAdmin } from "../middleware/adminAuth.js";
import { Resend } from "resend";

const router = express.Router();

// Resend client — uses your existing RESEND_API_KEY env var
const resend = new Resend(process.env.RESEND_API_KEY);

/* ═══════════════════════════════════════════════════════
   HELPER — Format nomination for admin email
   ═══════════════════════════════════════════════════════ */
function formatNominationEmail(n) {
  const specialAwardLabels = {
    lifetime: "Lifetime Achievement Award",
    rising: "Rising Innovator Award",
    crossborder: "Cross-Border Impact Award",
  };

  const category = n.categoryType === "matrix"
    ? `The Catalyst Award for ${n.pillar} in ${n.sector}`
    : specialAwardLabels[n.specialAward] || "Special Recognition";

  return `
<div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 640px; margin: 0 auto; padding: 32px 24px; color: #0d0520;">
  <div style="background: linear-gradient(135deg, #7a3fd1, #f5a623); padding: 24px; border-radius: 16px 16px 0 0;">
    <p style="margin: 0; color: rgba(255,255,255,0.85); font-size: 11px; letter-spacing: 2px; text-transform: uppercase; font-weight: 700;">New Nomination Received</p>
    <h1 style="margin: 8px 0 0; color: #fff; font-size: 24px; font-weight: 900;">The Catalyst Awards</h1>
  </div>
  <div style="background: #f7f5fc; padding: 24px; border-radius: 0 0 16px 16px; border: 1px solid #e8e2f5;">
    <h2 style="margin: 0 0 6px; font-size: 18px; color: #7a3fd1;">${category}</h2>
    <p style="margin: 0 0 24px; color: #666; font-size: 14px;">Submitted ${new Date(n.submittedAt || n.createdAt).toLocaleString("en-CA", { dateStyle: "full", timeStyle: "short" })}</p>

    <div style="background: #fff; padding: 18px; border-radius: 10px; margin-bottom: 16px;">
      <p style="margin: 0 0 4px; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: #999; font-weight: 700;">Nominee</p>
      <h3 style="margin: 0 0 12px; font-size: 16px;">${n.nomineeName}</h3>
      <table style="width: 100%; font-size: 13px; color: #444;">
        ${n.nomineeTitle ? `<tr><td style="padding: 3px 0; width: 130px; color: #888;">Title</td><td>${n.nomineeTitle}</td></tr>` : ""}
        <tr><td style="padding: 3px 0; color: #888;">Organisation</td><td>${n.nomineeOrganisation}</td></tr>
        <tr><td style="padding: 3px 0; color: #888;">Type</td><td>${n.nomineeType}</td></tr>
        <tr><td style="padding: 3px 0; color: #888;">Location</td><td>${n.nomineeLocation}</td></tr>
        ${n.nomineeSector ? `<tr><td style="padding: 3px 0; color: #888;">Sector</td><td>${n.nomineeSector}</td></tr>` : ""}
        <tr><td style="padding: 3px 0; color: #888;">Email</td><td><a href="mailto:${n.nomineeEmail}" style="color: #7a3fd1;">${n.nomineeEmail}</a></td></tr>
        ${n.nomineePhone ? `<tr><td style="padding: 3px 0; color: #888;">Phone</td><td>${n.nomineePhone}</td></tr>` : ""}
        ${n.nomineeWebsite ? `<tr><td style="padding: 3px 0; color: #888;">Website</td><td><a href="${n.nomineeWebsite}" style="color: #7a3fd1;">${n.nomineeWebsite}</a></td></tr>` : ""}
        ${n.nomineeLinkedIn ? `<tr><td style="padding: 3px 0; color: #888;">LinkedIn</td><td><a href="${n.nomineeLinkedIn}" style="color: #7a3fd1;">${n.nomineeLinkedIn}</a></td></tr>` : ""}
      </table>
    </div>

    <div style="background: #fff; padding: 18px; border-radius: 10px; margin-bottom: 16px;">
      <p style="margin: 0 0 4px; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: #999; font-weight: 700;">Nominator ${n.selfNomination ? "(Self-nomination)" : ""}</p>
      <h3 style="margin: 0 0 12px; font-size: 16px;">${n.nominatorName}</h3>
      <table style="width: 100%; font-size: 13px; color: #444;">
        ${n.nominatorTitle ? `<tr><td style="padding: 3px 0; width: 130px; color: #888;">Title</td><td>${n.nominatorTitle}</td></tr>` : ""}
        <tr><td style="padding: 3px 0; color: #888;">Organisation</td><td>${n.nominatorOrganisation}</td></tr>
        <tr><td style="padding: 3px 0; color: #888;">Relationship</td><td>${n.nominatorRelationship}</td></tr>
        <tr><td style="padding: 3px 0; color: #888;">Email</td><td><a href="mailto:${n.nominatorEmail}" style="color: #7a3fd1;">${n.nominatorEmail}</a></td></tr>
        ${n.nominatorPhone ? `<tr><td style="padding: 3px 0; color: #888;">Phone</td><td>${n.nominatorPhone}</td></tr>` : ""}
      </table>
    </div>

    <div style="background: #fff; padding: 18px; border-radius: 10px;">
      <p style="margin: 0 0 12px; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: #999; font-weight: 700;">Nomination Statement</p>

      <p style="margin: 12px 0 6px; font-weight: 700; font-size: 13px; color: #7a3fd1;">Overview</p>
      <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #333;">${(n.statementOverview || "").replace(/\n/g, "<br>")}</p>

      <p style="margin: 20px 0 6px; font-weight: 700; font-size: 13px; color: #7a3fd1;">Innovation &amp; Impact</p>
      <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #333;">${(n.statementImpact || "").replace(/\n/g, "<br>")}</p>

      <p style="margin: 20px 0 6px; font-weight: 700; font-size: 13px; color: #7a3fd1;">Key Achievements</p>
      <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #333;">${(n.statementAchievements || "").replace(/\n/g, "<br>")}</p>

      ${n.statementEvidence ? `
      <p style="margin: 20px 0 6px; font-weight: 700; font-size: 13px; color: #7a3fd1;">Supporting Evidence</p>
      <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #333;">${(n.statementEvidence || "").replace(/\n/g, "<br>")}</p>
      ` : ""}
    </div>

    <p style="margin: 24px 0 0; padding-top: 20px; border-top: 1px solid #e0d8f0; text-align: center; font-size: 12px; color: #999;">
      Signed by <strong>${n.signatureName}</strong> · Nomination ID: <code style="background: #eee; padding: 2px 6px; border-radius: 4px; font-size: 11px;">${n._id}</code>
    </p>
  </div>
  <p style="text-align: center; margin: 20px 0 0; font-size: 12px; color: #999;">
    View in admin: <a href="https://www.thetechfestival.com/admin" style="color: #7a3fd1;">thetechfestival.com/admin</a>
  </p>
</div>
  `.trim();
}

/* ═══════════════════════════════════════════════════════
   PUBLIC — Submit a nomination
   POST /api/nominations
   ═══════════════════════════════════════════════════════ */
router.post("/nominations", async (req, res) => {
  try {
    const payload = req.body || {};

    // Basic validation
    if (!payload.categoryType) return res.status(400).json({ error: "Please choose an award category" });
    if (payload.categoryType === "matrix" && (!payload.pillar || !payload.sector)) {
      return res.status(400).json({ error: "Both a pillar and sector are required" });
    }
    if (payload.categoryType === "special" && !payload.specialAward) {
      return res.status(400).json({ error: "Please select a Special Recognition award" });
    }
    if (!payload.nomineeName || !payload.nomineeEmail || !payload.nominatorName || !payload.nominatorEmail) {
      return res.status(400).json({ error: "Nominee and nominator names + emails are required" });
    }

    // Create the nomination
    const nomination = await Nomination.create({
      ...payload,
      submittedAt: payload.submittedAt || new Date(),
    });

    // Fire admin notification email via Resend (non-blocking)
    try {
      const specialAwardLabels = {
        lifetime: "Lifetime Achievement",
        rising: "Rising Innovator",
        crossborder: "Cross-Border Impact",
      };
      const categoryShort = nomination.categoryType === "matrix"
        ? `${nomination.pillar} × ${nomination.sector}`
        : specialAwardLabels[nomination.specialAward] || "Special Recognition";

      await resend.emails.send({
        from: "TTFC Catalyst Awards <noreply@thetechfestival.com>",
        to: "baldeep@thetechfestival.com",
        replyTo: nomination.nominatorEmail,
        subject: `[Catalyst Nomination] ${nomination.nomineeName} — ${categoryShort}`,
        html: formatNominationEmail(nomination),
      });
    } catch (emailErr) {
      console.error("Nomination email failed (submission still saved):", emailErr);
    }

    res.status(201).json({
      success: true,
      id: nomination._id,
      message: "Nomination received. Thank you!",
    });
  } catch (err) {
    console.error("Nomination submit error:", err);
    if (err.name === "ValidationError") {
      return res.status(400).json({ error: "Please check your submission — some fields are missing or invalid." });
    }
    res.status(500).json({ error: "Server error. Please try again." });
  }
});

/* ═══════════════════════════════════════════════════════
   ADMIN — List all nominations
   GET /api/admin/nominations?status=pending
   ═══════════════════════════════════════════════════════ */
router.get("/admin/nominations", requireAdmin, async (req, res) => {
  try {
    const filter = {};
    if (req.query.status && ["pending", "shortlisted", "winner", "rejected"].includes(req.query.status)) {
      filter.status = req.query.status;
    }
    const nominations = await Nomination.find(filter).sort({ createdAt: -1 });
    res.json(nominations);
  } catch (err) {
    console.error("Admin nominations list error:", err);
    res.status(500).json({ error: "Failed to load nominations" });
  }
});

/* ═══════════════════════════════════════════════════════
   ADMIN — Get single nomination
   GET /api/admin/nominations/:id
   ═══════════════════════════════════════════════════════ */
router.get("/admin/nominations/:id", requireAdmin, async (req, res) => {
  try {
    const nomination = await Nomination.findById(req.params.id);
    if (!nomination) return res.status(404).json({ error: "Not found" });
    res.json(nomination);
  } catch (err) {
    console.error("Admin nomination get error:", err);
    res.status(500).json({ error: "Failed to load nomination" });
  }
});

/* ═══════════════════════════════════════════════════════
   ADMIN — Update status / notes
   PUT /api/admin/nominations/:id
   ═══════════════════════════════════════════════════════ */
router.put("/admin/nominations/:id", requireAdmin, async (req, res) => {
  try {
    const update = {};
    if (req.body.status && ["pending", "shortlisted", "winner", "rejected"].includes(req.body.status)) {
      update.status = req.body.status;
    }
    if (typeof req.body.adminNotes === "string") {
      update.adminNotes = req.body.adminNotes;
    }

    const nomination = await Nomination.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!nomination) return res.status(404).json({ error: "Not found" });
    res.json(nomination);
  } catch (err) {
    console.error("Admin nomination update error:", err);
    res.status(500).json({ error: "Update failed" });
  }
});

/* ═══════════════════════════════════════════════════════
   ADMIN — Delete
   DELETE /api/admin/nominations/:id
   ═══════════════════════════════════════════════════════ */
router.delete("/admin/nominations/:id", requireAdmin, async (req, res) => {
  try {
    const nomination = await Nomination.findByIdAndDelete(req.params.id);
    if (!nomination) return res.status(404).json({ error: "Not found" });
    res.json({ success: true });
  } catch (err) {
    console.error("Admin nomination delete error:", err);
    res.status(500).json({ error: "Delete failed" });
  }
});

export default router;
