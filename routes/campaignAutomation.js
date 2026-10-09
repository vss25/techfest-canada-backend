import express from "express";
import jwt from "jsonwebtoken";
import CampaignTemplate from "../models/CampaignTemplate.js";
import Campaign from "../models/Campaign.js";
import Audience from "../models/Audience.js";
import EmailTracking from "../models/EmailTracking.js";
import { requireAdmin } from "../middleware/adminAuth.js";
import { sendCampaignEmail, wrapLinksWithTracking, generateCampaignFooter, sanitizeEmailHtml, sendBatchCampaignEmails } from "../services/emailService.js";
import { seedCampaignTemplates, createDefaultAudiences, markCampaignSent } from "../services/campaignAutomation.js";

const router = express.Router();
const FRONTEND_URL = process.env.FRONTEND_URL || "https://www.thetechfestival.com";
const API_URL = process.env.API_URL || "https://techfest-canada-backend.onrender.com";

const authMiddleware = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "No token provided" });
    }
    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
};

// Staff-only routes check the database, not the token's "role" claim, so
// removing someone's staff access takes effect immediately.
const adminMiddleware = (req, res, next) => requireAdmin(req, res, next);

// Helper: Wrap HTML with proper email structure (Gmail/Outlook compatible)
function wrapEmailHtml(html) {
  // Sanitize: Remove <title> tags
  html = sanitizeEmailHtml(html);
  
  console.log(`[WRAP] Input HTML length: ${html ? html.length : 0}, starts with: ${html ? html.substring(0, 80) : 'null/undefined'}`);
  
  if (!html || (typeof html === 'string' && html.trim() === "")) {
    console.log(`[WRAP] HTML is empty or whitespace only, returning null`);
    return null;
  }
  
  // Check if already has COMPLETE HTML structure - DOCTYPE + html + head + body
  const hasDoctype = html.includes("<!DOCTYPE html>");
  const hasHtmlOpen = html.includes("<html");
  const hasHtmlClose = html.includes("</html>");
  const hasBodyOpen = html.includes("<body");
  const hasBodyClose = html.includes("</body>");
  
  // If has DOCTYPE AND closing html/body tags, it's complete - return as-is
  if (hasDoctype && hasHtmlClose && hasBodyClose) {
    console.log(`[WRAP] HTML already has COMPLETE structure (DOCTYPE + html + body), returning as-is`);
    return html;
  }
  
  // If has html/body open AND closing tags, it's complete enough - return as-is
  if (hasHtmlOpen && hasHtmlClose && hasBodyOpen && hasBodyClose) {
    console.log(`[WRAP] HTML already has complete structure (html + body tags), returning as-is`);
    return html;
  }
  
  // If it's just a simple table without any HTML structure, wrap it
  console.log(`[WRAP] HTML needs wrapping - wrapping with email-friendly structure`);
  
  // Wrap with email-friendly structure - Gmail/Outlook compatible
  const wrapped = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
  <!--[if mso]>
  <style type="text/css">body, table, td {font-family: Arial, Helvetica, sans-serif !important;}</style>
  <![endif]-->
  <style type="text/css">
    body { margin: 0 !important; padding: 0 !important; -webkit-text-size-adjust: 100% !important; -ms-text-size-adjust: 100% !important; }
    img { border: 0 !important; height: auto !important; line-height: 100% !important; outline: none !important; text-decoration: none !important; }
    table { border-collapse: collapse !important; mso-table-lspace: 0pt !important; mso-table-rspace: 0pt !important; }
    @media only screen and (max-width: 600px) {
      .email-container { width: 100% !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f0ff; font-family: Arial, Helvetica, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f0ff;">
    <tr>
      <td align="center" style="padding: 20px 10px;">
        <table width="600" cellpadding="0" cellspacing="0" class="email-container" style="background-color: #ffffff; border-radius: 12px; overflow: hidden;">
          <tr>
            <td style="padding: 20px;">
              ${html}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  
  console.log(`[WRAP] Wrapped HTML length: ${wrapped.length}`);
  return wrapped;
}

router.post("/seed", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const [templateResults, audiences] = await Promise.all([
      seedCampaignTemplates(),
      createDefaultAudiences(),
    ]);
    res.json({ success: true, ...templateResults, audiencesCreated: audiences.length });
  } catch (err) {
    console.error("Seed error:", err);
    res.status(500).json({ error: "Seed failed" });
  }
});

router.get("/templates", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { phase, audience, status } = req.query;
    const filter = {};
    
    if (phase) filter.phase = phase;
    if (audience) filter.audience = audience;
    if (status) filter.status = status;

    const templates = await CampaignTemplate.find(filter)
      .sort({ sendDate: 1, audience: 1 });

    const stats = {
      total: templates.length,
      pending: templates.filter(t => t.status === "pending").length,
      sent: templates.filter(t => t.status === "sent").length,
      draft: templates.filter(t => t.status === "draft").length,
    };

    res.json({ templates, stats });
  } catch (err) {
    console.error("Fetch templates error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/templates/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const template = await CampaignTemplate.findById(req.params.id);
    if (!template) {
      return res.status(404).json({ error: "Template not found" });
    }
    res.json(template);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/templates", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { phase, audience, subject, purpose, sendDate } = req.body;

    if (!phase || !audience || !subject || !purpose || !sendDate) {
      return res.status(400).json({ error: "Missing required fields: phase, audience, subject, purpose, sendDate" });
    }

    const templateId = `manual-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const template = new CampaignTemplate({
      templateId,
      phase,
      audience,
      subject,
      purpose,
      sendDate: new Date(sendDate),
      bodySummary: "Click to edit campaign content",
      ctaText: "Learn More",
      ctaLink: "www.thetechfestival.com",
      segment: "All contacts",
      status: "pending",
      autoGenerated: false,
    });

    await template.save();
    res.json(template);
  } catch (err) {
    console.error("Create template error:", err);
    res.status(500).json({ error: "Failed to create campaign" });
  }
});

router.delete("/templates/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const template = await CampaignTemplate.findById(req.params.id);
    if (!template) {
      return res.status(404).json({ error: "Template not found" });
    }

    await CampaignTemplate.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Campaign deleted" });
  } catch (err) {
    console.error("Delete template error:", err);
    res.status(500).json({ error: "Failed to delete campaign" });
  }
});

router.put("/templates/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { subject, bodySummary, ctaText, ctaLink, status, sendDate, htmlBody, textBody } = req.body;
    
    const template = await CampaignTemplate.findById(req.params.id);
    if (!template) {
      return res.status(404).json({ error: "Template not found" });
    }

    if (subject) template.subject = subject;
    if (bodySummary) template.bodySummary = bodySummary;
    if (ctaText) template.ctaText = ctaText;
    if (ctaLink) template.ctaLink = ctaLink;
    if (status) template.status = status;
    if (sendDate) template.sendDate = new Date(sendDate);
    if (htmlBody !== undefined) {
      template.htmlBody = htmlBody;
    }
    if (textBody !== undefined) template.textBody = textBody;

    await template.save();
    res.json(template);
  } catch (err) {
    console.error("Update template error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/templates/:id/send", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { subject, htmlBody, textBody, audienceId } = req.body;
    console.log(`[SEND] Received request - audienceId: "${audienceId}", template.audience: "${req.body.audience || 'not provided'}"`);
    
    const template = await CampaignTemplate.findById(req.params.id);
    if (!template) {
      return res.status(404).json({ error: "Template not found" });
    }

    let audience;
    if (audienceId && audienceId.trim() !== "") {
      console.log(`[SEND] Looking up audience by ID: ${audienceId}`);
      audience = await Audience.findById(audienceId);
      if (!audience) {
        console.log(`[SEND] Audience not found by ID, checking all audiences`);
        const allAudiences = await Audience.find({});
        console.log(`[SEND] Available audiences:`, allAudiences.map(a => ({ id: a._id, name: a.name, contacts: a.contacts?.length })));
        return res.status(400).json({ error: "Audience not found", receivedId: audienceId });
      }
      console.log(`[SEND] Found audience by ID: ${audience.name}, contacts: ${audience.contacts?.length || 0}`);
    } else {
      console.log(`[SEND] No audienceId provided, using fallback logic`);
      const audienceMap = {
        "Sponsors": "Sponsor Leads",
        "Exhibitors": "Exhibitor Leads",
        "Delegates": "Delegate Prospects",
        "Visitors": "Visitor Prospects",
      };
      const audienceName = audienceMap[template.audience];
      console.log(`[SEND] Looking for audience by name: "${audienceName}"`);
      audience = await Audience.findOne({ name: audienceName });
      if (audience) {
        console.log(`[SEND] Found audience by name: ${audience.name}, contacts: ${audience.contacts?.length || 0}`);
      } else {
        console.log(`[SEND] Audience not found by name, checking all audiences`);
        const allAudiences = await Audience.find({});
        console.log(`[SEND] Available audiences:`, allAudiences.map(a => ({ id: a._id, name: a.name, contacts: a.contacts?.length })));
      }
    }

    if (!audience || audience.contacts.length === 0) {
      return res.status(400).json({ error: `No contacts in the selected audience` });
    }

    const finalSubject = subject || template.subject;
    let html = htmlBody || template.htmlBody;
    
    console.log(`[SEND] htmlBody param: ${htmlBody ? 'provided' : 'not provided'}`);
    console.log(`[SEND] template.htmlBody: ${template.htmlBody ? 'exists (' + template.htmlBody.length + ' chars)' : 'null/undefined'}`);
    console.log(`[SEND] Using html: ${html ? 'yes (' + html.length + ' chars)' : 'no - will generate'}`);
    
    if (!html) {
      console.log(`[SEND] HTML is empty, generating default template`);
      html = generateEmailHtml(template);
      console.log(`[SEND] Generated HTML length: ${html.length}`);
    }

    // Validate template before sending
    const wrappedHtml = wrapEmailHtml(html);
    if (!wrappedHtml) {
      return res.status(400).json({ error: "Email template is empty. Please add content and save the template before sending." });
    }
    console.log(`[SEND] After wrap, HTML length: ${wrappedHtml.length}`);
    console.log(`[SEND] HTML preview:\n${wrappedHtml.substring(0, 500)}`);

    const trackingRecords = [];
    const templateIdStr = template._id.toString();
    const campaignIdPrefix = `tpl-${templateIdStr}`;

    // Delete existing tracking records to avoid duplicate key errors
    try {
      await EmailTracking.deleteMany({ campaignId: campaignIdPrefix });
      console.log(`[AUTOMATION] Cleared existing tracking records for ${campaignIdPrefix}`);
    } catch (err) {
      console.error(`[AUTOMATION] Error clearing tracking:`, err.message);
    }
    
    const emailPromises = audience.contacts.map((contact) => {
      try {
        console.log(`[AUTOMATION] Processing contact: ${contact.email}`);
        console.log(`[AUTOMATION] Contact data:`, { firstName: contact.firstName, lastName: contact.lastName, company: contact.company });
        
        const personalizedHtml = wrappedHtml
          .replace(/\{\{name\}\}/g, contact.name || contact.email.split("@")[0])
          .replace(/\{\{email\}\}/g, contact.email)
          .replace(/\/firstname/gi, contact.firstName || contact.name || contact.email.split("@")[0])
          .replace(/\/lastname/gi, contact.lastName || "")
          .replace(/\/company/gi, contact.company || "")
          .replace(/\/title/gi, contact.title || "")
          .replace(/\/location/gi, contact.location || "");

        console.log(`[AUTOMATION] Personalized HTML sample:`, personalizedHtml.substring(0, 300));

        const htmlWithLinksTracked = wrapLinksWithTracking(
          personalizedHtml,
          campaignIdPrefix,
          contact.email,
          API_URL
        );

        const trackingPixel = `<img src="${API_URL}/api/track/open/${campaignIdPrefix}/${encodeURIComponent(contact.email)}" width="1" height="1" style="display:none" alt="" />`;
        
        // Build dynamic footer using shared function
        const footer = generateCampaignFooter(API_URL, campaignIdPrefix, contact.email);
        
        // Insert tracking pixel and footer INSIDE body tag
        let htmlWithTracking = htmlWithLinksTracked;
        if (htmlWithLinksTracked.includes('</body>')) {
          htmlWithTracking = htmlWithLinksTracked.replace('</body>', footer + trackingPixel + '</body>');
        } else {
          htmlWithTracking = htmlWithLinksTracked.replace('</html>', footer + trackingPixel + '</html>');
        }

        const tracking = new EmailTracking({
          campaignId: campaignIdPrefix,
          email: contact.email,
          status: "pending",
        });
        trackingRecords.push(tracking.save());

        return sendCampaignEmail({
          to: contact.email,
          subject: finalSubject,
          html: htmlWithTracking,
          campaignId: campaignIdPrefix,
          recipientEmail: contact.email,
          text: textBody || template.textBody,
        });
      } catch (err) {
        console.error(`Error sending to ${contact.email}:`, err);
        return Promise.resolve({ success: false, error: err.message });
      }
    });

    await Promise.allSettled(emailPromises);
    await Promise.all(trackingRecords);

    const sentCount = audience.contacts.length;

    if (subject) template.subject = subject;
    if (htmlBody) template.htmlBody = htmlBody;
    if (textBody) template.textBody = textBody;
    template.status = "sent";
    template.sentAt = new Date();
    await template.save();

    const audienceMap = {
      "Sponsors": "Sponsor Leads",
      "Exhibitors": "Exhibitor Leads",
      "Delegates": "Delegate Prospects",
      "Visitors": "Visitor Prospects",
    };
    const audienceName = audienceMap[template.audience] || template.audience;
    const campaignName = `${template.purpose || 'Campaign'} - ${template.phase || ''} (${template.audience || 'General'})`;
    
    let campaign = await Campaign.findOne({ name: campaignName });
    if (!campaign) {
      const audienceDoc = await Audience.findOne({ name: audienceName });
      campaign = new Campaign({
        name: campaignName,
        subject: finalSubject,
        audienceId: audienceDoc?._id || null,
        template: html,
        status: "sent",
        sentAt: new Date(),
        stats: {
          sent: sentCount,
          uniqueOpens: 0,
          totalOpens: 0,
          uniqueClicks: 0,
          totalClicks: 0,
          bounces: 0,
          hardBounces: 0,
          softBounces: 0,
          unsubscribes: 0,
        },
        createdBy: req.user?.userId,
      });
    } else {
      campaign.stats.sent = sentCount;
      campaign.status = "sent";
      campaign.sentAt = new Date();
      campaign.template = html;
    }
    await campaign.save();

    template.campaign = campaign._id;
    await template.save();

    console.log(`[AUTOMATION CAMPAIGN] Template "${template.templateId}" sent to ${sentCount} recipients via audience "${audienceName}"`);
    console.log(`[AUTOMATION CAMPAIGN] Campaign entry created/updated: "${campaign.name}" (ID: ${campaign._id}), stats.sent=${sentCount}`);

    res.json({ success: true, sent: sentCount, template, campaignId: campaign._id });
  } catch (err) {
    console.error("Send template error:", err);
    console.error("Error stack:", err.stack);
    res.status(500).json({ error: "Failed to send", details: err.message });
  }
});

router.get("/calendar", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const templates = await CampaignTemplate.find().sort({ sendDate: 1 });

    const calendar = {};
    const phases = ["Phase 1", "Phase 2", "Phase 3", "Phase 4", "Phase 5"];
    const audiences = ["Sponsors", "Exhibitors", "Delegates", "Visitors"];

    for (const phase of phases) {
      calendar[phase] = {};
      for (const audience of audiences) {
        calendar[phase][audience] = [];
      }
    }

    for (const t of templates) {
      if (calendar[t.phase] && calendar[t.phase][t.audience]) {
        calendar[t.phase][t.audience].push({
          id: t._id,
          templateId: t.templateId,
          sendDate: t.sendDate,
          subject: t.subject,
          purpose: t.purpose,
          status: t.status,
          sentAt: t.sentAt,
          htmlBody: t.htmlBody || null,
          textBody: t.textBody || null,
        });
      }
    }

    res.json({ calendar, phases, audiences });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/upcoming", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const now = new Date();
    const future = new Date();
    future.setDate(future.getDate() + parseInt(days));

    const templates = await CampaignTemplate.find({
      sendDate: { $gte: now, $lte: future },
      status: "pending",
    }).sort({ sendDate: 1, audience: 1 });

    res.json(templates);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

function generateEmailHtml(template) {
  console.log(`[GENERATE] Creating fallback email for template: ${template.subject}`);
  
  const ctaFullLink = (template.ctaLink && template.ctaLink.startsWith("http")) 
    ? template.ctaLink 
    : `https://${template.ctaLink || 'www.thetechfestival.com'}`;

  const bodyContent = template.bodySummary || "Thank you for your interest in The Tech Festival Canada 2026. We look forward to seeing you in Toronto!";
  const ctaText = template.ctaText || "Learn More";
  const phase = template.phase || "Phase 1";
  const audience = template.audience || "General";
  const purpose = template.purpose || "Event Updates";

  // Use shared footer function (fallback uses generic ID)
  const fallbackFooter = generateCampaignFooter(API_URL, "fallback", "recipient@example.com");

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f4f0ff;font-family:Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:20px;">
    <div style="background:white;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.1);">
      <div style="background:linear-gradient(135deg,#7a3fd1,#f5a623);padding:40px 30px;text-align:center;">
        <h1 style="color:white;margin:0;font-size:24px;">The Tech Festival Canada 2026</h1>
        <p style="color:rgba(255,255,255,0.9);margin:10px 0 0;font-size:14px;">October 26-27, 2026 • Toronto, ON</p>
      </div>
      
      <div style="padding:40px 30px;">
        <p style="color:#333;font-size:16px;line-height:1.6;">
          ${bodyContent}
        </p>
        
        <div style="text-align:center;margin:30px 0;">
          <a href="${ctaFullLink}" style="display:inline-block;background:linear-gradient(135deg,#7a3fd1,#f5a623);color:white;padding:16px 32px;border-radius:50px;text-decoration:none;font-weight:bold;font-size:16px;">
            ${ctaText} →
          </a>
        </div>
        
        <div style="background:#f9f5ff;border-radius:8px;padding:20px;margin-top:30px;">
          <p style="margin:0;color:#666;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Campaign Info</p>
          <p style="margin:5px 0 0;color:#333;font-size:14px;">
            <strong>Phase:</strong> ${phase} | 
            <strong>Audience:</strong> ${audience} | 
            <strong>Purpose:</strong> ${purpose}
          </p>
        </div>
      </div>
      
      ${fallbackFooter}
    </div>
  </div>
</body>
</html>
  `;
}

router.post("/cleanup-templates", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const templates = await CampaignTemplate.find({ htmlBody: { $exists: true, $ne: null } });
    
    res.json({
      success: true,
      message: "HTML sanitization has been removed. All templates are used as-is without modification.",
      totalTemplates: templates.length
    });
  } catch (err) {
    console.error("[CLEANUP] Error:", err);
    res.status(500).json({ error: "Failed to check templates", details: err.message });
  }
});

export default router;
