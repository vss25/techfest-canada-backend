import express from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import csvParser from "csv-parser";
import { Readable } from "stream";
import crypto from "crypto";

import Campaign from "../models/Campaign.js";
import Audience from "../models/Audience.js";
import EmailTracking from "../models/EmailTracking.js";
import { requireAdmin } from "../middleware/adminAuth.js";
import { sendCampaignEmail, wrapLinksWithTracking, generateCampaignFooter, sanitizeEmailHtml, sendBatchCampaignEmails } from "../services/emailService.js";

const router = express.Router();

const FRONTEND_URL = process.env.FRONTEND_URL || "https://www.thetechfestival.com";

const authMiddleware = (req, res, next) => {
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

const upload = multer({ storage: multer.memoryStorage() });

function generateTrackingId() {
  return crypto.randomBytes(16).toString("hex");
}

// Helper: Wrap HTML with proper email structure (Gmail/Outlook compatible)
// Optional params for dynamic footer links
function wrapEmailHtml(html, options = {}) {
  const { campaignId, recipientEmail, baseUrl } = options;
  
  // Sanitize: Remove <title> tags
  html = sanitizeEmailHtml(html);
  
  console.log(`[WRAP] Input HTML length: ${html ? html.length : 0}, starts with: ${html ? html.substring(0, 80) : 'null/undefined'}`);
  
  if (!html || (typeof html === 'string' && html.trim() === "")) {
    console.log(`[WRAP] HTML is empty or whitespace only, returning null`);
    return null;
  }
   
  // Build dynamic footer if campaign info provided
  let footerHtml = "";
  if (campaignId && recipientEmail && baseUrl) {
    footerHtml = generateCampaignFooter(baseUrl, campaignId, recipientEmail);
  }
  
  // Check if already has COMPLETE HTML structure - DOCTYPE + html + head + body
  const hasDoctype = html.includes("<!DOCTYPE html>");
  const hasHtmlOpen = html.includes("<html");
  const hasHtmlClose = html.includes("</html>");
  const hasBodyOpen = html.includes("<body");
  const hasBodyClose = html.includes("</body>");
  
  let resultHtml = html;
  
  // If has DOCTYPE AND closing html/body tags, it's complete - use as-is
  if (hasDoctype && hasHtmlClose && hasBodyClose) {
    console.log(`[WRAP] HTML already has COMPLETE structure (DOCTYPE + html + body)`);
    resultHtml = html;
  }
  // If has html/body open AND closing tags, it's complete enough - use as-is
  else if (hasHtmlOpen && hasHtmlClose && hasBodyOpen && hasBodyClose) {
    console.log(`[WRAP] HTML already has complete structure (html + body tags)`);
    resultHtml = html;
  }
  // If it's just a simple table without any HTML structure, wrap it
  else {
    console.log(`[WRAP] HTML needs wrapping - wrapping with email-friendly structure`);
    resultHtml = `<!DOCTYPE html>
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
    console.log(`[WRAP] Wrapped HTML length: ${resultHtml.length}`);
  }
  
  // Add footer if we have it - insert before </body>
  if (footerHtml) {
    if (resultHtml.includes('</body>')) {
      resultHtml = resultHtml.replace('</body>', footerHtml + '</body>');
      console.log(`[WRAP] Added footer to HTML`);
    } else {
      // No </body> tag found, append before </html>
      resultHtml = resultHtml.replace('</html>', footerHtml + '</html>');
      console.log(`[WRAP] Added footer before </html>`);
    }
  }
  
  return resultHtml;
}

router.get("/audiences", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const audiences = await Audience.find().sort({ createdAt: -1 });
    const result = audiences.map((a) => ({
      _id: a._id,
      name: a.name,
      description: a.description,
      contactCount: a.contactCount,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    }));
    res.json(result);
  } catch (err) {
    console.error("Fetch audiences error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/audiences", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { name, description, emails } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Audience name is required" });
    }

    const contacts = (emails || []).map((email) => ({
      email: email.toLowerCase().trim(),
      addedAt: new Date(),
    }));

    const audience = new Audience({
      name,
      description: description || "",
      contacts,
      createdBy: req.user.userId,
    });

    await audience.save();

    res.json({
      _id: audience._id,
      name: audience.name,
      description: audience.description,
      contactCount: audience.contactCount,
      createdAt: audience.createdAt,
      updatedAt: audience.updatedAt,
    });
  } catch (err) {
    console.error("Create audience error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/audiences/import", authMiddleware, adminMiddleware, upload.single("file"), async (req, res) => {
  try {
    const { name } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: "CSV file is required" });
    }

    const contacts = [];
    const stream = Readable.from(req.file.buffer.toString());

    await new Promise((resolve, reject) => {
      stream
        .pipe(csvParser())
        .on("data", (row) => {
          // Get all keys and trim them to handle "First Name " with trailing space
          const keys = Object.keys(row);
          const getValue = (patterns) => {
            for (const pattern of patterns) {
              for (const key of keys) {
                if (key.trim().toLowerCase() === pattern.toLowerCase()) {
                  return row[key];
                }
              }
            }
            return "";
          };

          const email = getValue(["email", "Email", "EMAIL", "EmailAddress", "Email Address", "Person Email"]);
          const nameField = getValue(["name", "Name", "NAME", "Person FullName"]);
          const firstName = getValue(["firstname", "firstName", "First Name", "FirstName", "Person FirstName", "Person_FirstName"]);
          const lastName = getValue(["lastname", "lastName", "Last Name", "LastName", "Person LastName", "Person_LastName"]);
          const company = getValue(["company", "Company", "companyName", "Company Name", "Company_Name", "CompanyName"]);
          const title = getValue(["title", "Title", "jobTitle", "Job Title", "Person Title", "Person_Title"]);
          const location = getValue(["location", "Location", "Person Location", "Person_Location"]);
          
          if (email && email.includes("@")) {
            contacts.push({
              email: email.toLowerCase().trim(),
              name: String(nameField).trim(),
              firstName: String(firstName).trim(),
              lastName: String(lastName).trim(),
              company: String(company).trim(),
              title: String(title).trim(),
              location: String(location).trim(),
              addedAt: new Date(),
            });
          }
        })
        .on("end", resolve)
        .on("error", reject);
    });

    const audience = new Audience({
      name: name || `Import ${new Date().toLocaleDateString()}`,
      contacts,
      createdBy: req.user.userId,
    });

    await audience.save();

    res.json({
      success: true,
      _id: audience._id,
      name: audience.name,
      contactCount: audience.contactCount,
    });
  } catch (err) {
    console.error("Import audience error:", err);
    res.status(500).json({ error: "Failed to import CSV" });
  }
});

router.get("/audiences/:id/stats", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const audience = await Audience.findById(req.params.id);
    if (!audience) {
      return res.status(404).json({ error: "Audience not found" });
    }

    res.json({
      _id: audience._id,
      name: audience.name,
      contactCount: audience.contactCount,
      contacts: audience.contacts.slice(0, 100),
    });
  } catch (err) {
    console.error("Audience stats error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/audiences/:id/contacts", authMiddleware, adminMiddleware, async (req, res) => {
  console.log("Contacts route hit for ID:", req.params.id);
  try {
    const audience = await Audience.findById(req.params.id);
    console.log("Audience found:", audience ? "yes" : "no");
    if (!audience) {
      return res.status(404).json({ error: "Audience not found" });
    }

    res.json({
      _id: audience._id,
      name: audience.name,
      contactCount: audience.contactCount,
      contacts: audience.contacts,
    });
  } catch (err) {
    console.error("Audience contacts error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.delete("/audiences/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await Audience.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error("Delete audience error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.put("/audiences/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { name, description } = req.body;
    const audience = await Audience.findById(req.params.id);
    
    if (!audience) {
      return res.status(404).json({ error: "Audience not found" });
    }

    if (name) audience.name = name;
    if (description !== undefined) audience.description = description;
    
    await audience.save();

    res.json({
      _id: audience._id,
      name: audience.name,
      description: audience.description,
      contactCount: audience.contactCount,
      updatedAt: audience.updatedAt,
    });
  } catch (err) {
    console.error("Update audience error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/audiences/:id/contacts", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { emails, contacts } = req.body;
    const audience = await Audience.findById(req.params.id);
    
    if (!audience) {
      return res.status(404).json({ error: "Audience not found" });
    }

    const existingEmails = new Set(audience.contacts.map((c) => c.email));
    let addedCount = 0;
    let skippedCount = 0;

    // Handle single contacts with full details
    if (contacts && Array.isArray(contacts)) {
      for (const contact of contacts) {
        if (contact.email && contact.email.includes("@")) {
          const normalizedEmail = contact.email.toLowerCase().trim();
          if (!existingEmails.has(normalizedEmail)) {
            audience.contacts.push({
              email: normalizedEmail,
              firstName: contact.firstName?.trim() || "",
              lastName: contact.lastName?.trim() || "",
              company: contact.company?.trim() || "",
              title: contact.title?.trim() || "",
              location: contact.location?.trim() || "",
              addedAt: new Date(),
            });
            existingEmails.add(normalizedEmail);
            addedCount++;
          } else {
            skippedCount++;
          }
        }
      }
    }

    // Handle legacy email-only contacts
    if (emails && Array.isArray(emails)) {
      const newContacts = (emails || [])
        .map((email) => email.toLowerCase().trim())
        .filter((email) => email && email.includes("@") && !existingEmails.has(email))
        .map((email) => ({
          email,
          addedAt: new Date(),
        }));

      audience.contacts.push(...newContacts);
      addedCount += newContacts.length;
      skippedCount += (emails.length || 0) - newContacts.length;
    }

    await audience.save();

    res.json({
      success: true,
      contactCount: audience.contactCount,
      addedCount,
      skippedCount,
    });
  } catch (err) {
    console.error("Add contacts error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/audiences/:id/import", authMiddleware, adminMiddleware, upload.single("file"), async (req, res) => {
  try {
    const audience = await Audience.findById(req.params.id);
    
    if (!audience) {
      return res.status(404).json({ error: "Audience not found" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "CSV file is required" });
    }

    const existingEmails = new Set(audience.contacts.map((c) => c.email));
    const contacts = [];
    
    const stream = Readable.from(req.file.buffer.toString());

    await new Promise((resolve, reject) => {
      stream
        .pipe(csvParser())
        .on("data", (row) => {
          const keys = Object.keys(row);
          const getValue = (patterns) => {
            for (const pattern of patterns) {
              for (const key of keys) {
                if (key.trim().toLowerCase() === pattern.toLowerCase()) {
                  return row[key];
                }
              }
            }
            return "";
          };

          const email = getValue(["email", "Email", "EMAIL", "EmailAddress", "Email Address", "Person Email"]);
          const nameField = getValue(["name", "Name", "NAME", "Person FullName"]);
          const firstName = getValue(["firstname", "firstName", "First Name", "FirstName", "Person FirstName", "Person_FirstName"]);
          const lastName = getValue(["lastname", "lastName", "Last Name", "LastName", "Person LastName", "Person_LastName"]);
          const company = getValue(["company", "Company", "companyName", "Company Name", "Company_Name", "CompanyName"]);
          const title = getValue(["title", "Title", "jobTitle", "Job Title", "Person Title", "Person_Title"]);
          const location = getValue(["location", "Location", "Person Location", "Person_Location"]);
          
          if (email && email.includes("@")) {
            const normalizedEmail = email.toLowerCase().trim();
            if (!existingEmails.has(normalizedEmail)) {
              contacts.push({
                email: normalizedEmail,
                name: String(nameField).trim(),
                firstName: String(firstName).trim(),
                lastName: String(lastName).trim(),
                company: String(company).trim(),
                title: String(title).trim(),
                location: String(location).trim(),
                addedAt: new Date(),
              });
              existingEmails.add(normalizedEmail);
            }
          }
        })
        .on("end", resolve)
        .on("error", reject);
    });

    audience.contacts.push(...contacts);
    await audience.save();

    res.json({
      success: true,
      contactCount: audience.contactCount,
      addedCount: contacts.length,
    });
  } catch (err) {
    console.error("Import to audience error:", err);
    res.status(500).json({ error: "Failed to import CSV" });
  }
});

router.get("/", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const campaigns = await Campaign.find()
      .sort({ createdAt: -1 })
      .populate("audienceId", "name");

    const result = campaigns.map((c) => ({
      _id: c._id,
      name: c.name,
      subject: c.subject,
      status: c.status,
      audienceId: c.audienceId?._id,
      audienceName: c.audienceId?.name,
      template: c.template,  // Include template field
      stats: c.stats,
      scheduledAt: c.scheduledAt,
      sentAt: c.sentAt,
      createdAt: c.createdAt,
    }));

    res.json(result);
  } catch (err) {
    console.error("Fetch campaigns error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { name, subject, audienceId, template, scheduledAt } = req.body;

    if (!name || !subject || !audienceId || !template) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const campaign = new Campaign({
      name,
      subject,
      audienceId,
      template,
      status: "draft",
      scheduledAt: scheduledAt || null,
      createdBy: req.user.userId,
    });

    await campaign.save();

    res.json({
      _id: campaign._id,
      name: campaign.name,
      subject: campaign.subject,
      status: campaign.status,
      stats: campaign.stats,
      createdAt: campaign.createdAt,
    });
  } catch (err) {
    console.error("Create campaign error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET single campaign by ID
router.get("/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const campaign = await Campaign.findById(req.params.id).populate("audienceId", "name");
    
    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    console.log(`[GET /campaigns/:id] Found campaign: ${campaign.name}, template length: ${campaign.template ? campaign.template.length : 0}`);
    
    res.json({
      _id: campaign._id,
      name: campaign.name,
      subject: campaign.subject,
      status: campaign.status,
      audienceId: campaign.audienceId?._id,
      audienceName: campaign.audienceId?.name,
      template: campaign.template,
      stats: campaign.stats,
      scheduledAt: campaign.scheduledAt,
      sentAt: campaign.sentAt,
      createdAt: campaign.createdAt,
      createdBy: campaign.createdBy,
    });
  } catch (err) {
    console.error("Fetch campaign error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.put("/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { name, subject, template, scheduledAt } = req.body;

    const campaign = await Campaign.findById(req.params.id);
    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    if (name) campaign.name = name;
    if (subject) campaign.subject = subject;
    if (template !== undefined) {
      campaign.template = template;
      console.log(`[PUT /campaigns/:id] Saved template length: ${template ? template.length : 0}`);
    }
    if (scheduledAt) campaign.scheduledAt = scheduledAt;

    await campaign.save();
    
    console.log(`[PUT /campaigns/:id] Saved template length: ${campaign.template ? campaign.template.length : 0}`);
    console.log(`[PUT /campaigns/:id] Campaign template now: ${campaign.template ? campaign.template.substring(0, 100) : 'empty'}`);

    res.json({
      _id: campaign._id,
      name: campaign.name,
      subject: campaign.subject,
      status: campaign.status,
      stats: campaign.stats,
    });
  } catch (err) {
    console.error("Update campaign error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.delete("/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await Campaign.findByIdAndDelete(req.params.id);
    await EmailTracking.deleteMany({ campaignId: req.params.id });
    res.json({ success: true });
  } catch (err) {
    console.error("Delete campaign error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/:id/launch", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const campaign = await Campaign.findById(req.params.id).populate("audienceId");
    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    console.log(`[LAUNCH] ===== START LAUNCH =====`);
    console.log(`[LAUNCH] Campaign: ${campaign.name} (ID: ${campaign._id})`);
    console.log(`[LAUNCH] Template exists: ${!!campaign.template}`);
    console.log(`[LAUNCH] Template length: ${campaign.template ? campaign.template.length : 0}`);
    console.log(`[LAUNCH] Template first 200 chars:\n${campaign.template ? campaign.template.substring(0, 200) : 'EMPTY'}`);
    console.log(`[LAUNCH] Template last 200 chars:\n${campaign.template ? campaign.template.substring(campaign.template.length - 200) : 'EMPTY'}`);

    if (campaign.status === "sent") {
      return res.status(400).json({ error: "Campaign already sent" });
    }

    const audience = campaign.audienceId;
    if (!audience || audience.contacts.length === 0) {
      return res.status(400).json({ error: "No contacts in audience" });
    }

    campaign.status = "sending";
    campaign.sentAt = new Date();
    await campaign.save();

    const trackingId = generateTrackingId();
    const trackingRecords = [];
    const baseUrl = process.env.API_URL || "https://techfest-canada-backend.onrender.com";

    // Delete existing tracking records for this campaign to avoid duplicate key errors
    try {
      await EmailTracking.deleteMany({ campaignId: campaign._id });
      console.log(`[LAUNCH] Cleared existing tracking records for campaign ${campaign._id}`);
    } catch (err) {
      console.error(`[LAUNCH] Error clearing tracking records:`, err.message);
    }

    for (const contact of audience.contacts) {
      const tracking = new EmailTracking({
        campaignId: campaign._id,
        email: contact.email,
        status: "pending",
      });
      trackingRecords.push(tracking.save());
    }

    await Promise.all(trackingRecords).catch(err => {
      console.error(`[LAUNCH] Error saving tracking records:`, err.message);
    });

    const campaignIdStr = campaign._id.toString();

    // Validate template before sending
    const wrappedHtml = wrapEmailHtml(campaign.template);
    if (!wrappedHtml) {
      return res.status(400).json({ error: "Email template is empty. Please add content and save the template before launching." });
    }
    console.log(`[LAUNCH] After wrap, HTML length: ${wrappedHtml.length}`);
    
    // Send immediate response, process in background
    res.json({
      success: true,
      message: `Campaign launch started for ${audience.contacts.length} recipients. Emails will be sent in background.`,
      recipientCount: audience.contacts.length,
    });
    
    // Process in background
    (async () => {
      try {
        console.log(`[LAUNCH BACKGROUND] Starting batch send for ${audience.contacts.length} recipients`);
        
        // Prepare email list with full contact details for personalization
        const emailList = audience.contacts.map((contact) => ({
          contact: {
            email: contact.email,
            name: contact.name || "",
            firstName: contact.firstName || "",
            lastName: contact.lastName || "",
            company: contact.company || "",
            title: contact.title || "",
            location: contact.location || "",
          },
        }));
        
        // Use Resend batch API - sends up to 100 emails per request (no rate limits!)
        const batchResult = await sendBatchCampaignEmails(
          emailList,
          campaign.subject,
          wrappedHtml,
          campaignIdStr,
          baseUrl
        );
        
        console.log(`[LAUNCH BACKGROUND] Batch send complete:`, batchResult);
        
        // Update campaign stats
        campaign.stats.sent = audience.contacts.length;
        campaign.status = "sent";
        await campaign.save();
        
        console.log(`[CAMPAIGN LAUNCH] Campaign "${campaign.name}" (ID: ${campaign._id}) sent to ${audience.contacts.length} recipients`);
      } catch (err) {
        console.error("[LAUNCH BACKGROUND] Batch send error:", err);
        campaign.status = "failed";
        await campaign.save();
      }
    })();
  } catch (err) {
    console.error("Launch campaign error:", err);
    console.error("Error stack:", err.stack);
    res.status(500).json({ error: "Failed to launch campaign", details: err.message });
  }
});

router.post("/:id/test", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { email } = req.body;
    const campaign = await Campaign.findById(req.params.id);

    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const baseUrl = process.env.API_URL || "https://techfest-canada-backend.onrender.com";

    // Validate and wrap template like production
    const wrappedHtml = wrapEmailHtml(campaign.template);
    if (!wrappedHtml) {
      return res.status(400).json({ error: "Email template is empty. Please add content and save the template before sending test." });
    }
    console.log(`[TEST EMAIL] After wrap, HTML length: ${wrappedHtml.length}`);

    // Apply personalization tokens for test email
    const personalizedHtml = wrappedHtml
      .replace(/\{\{name\}\}/g, email.split("@")[0])
      .replace(/\{\{email\}\}/g, email)
      .replace(/\/firstname/gi, "Test")
      .replace(/\/lastname/gi, "User")
      .replace(/\/company/gi, "Test Company")
      .replace(/\/title/gi, "CEO")
      .replace(/\/location/gi, "Toronto");

    console.log(`[TEST EMAIL] Personalized HTML sample:`, personalizedHtml.substring(0, 300));

    const htmlWithLinksTracked = wrapLinksWithTracking(
      personalizedHtml,
      campaign._id.toString(),
      email,
      baseUrl
    );

    // Insert tracking pixel and footer INSIDE body tag
    const trackingPixel = `<img src="${baseUrl}/api/track/open/${campaign._id}/${email}" width="1" height="1" style="display:none" alt="" />`;
    
    // Add footer before tracking pixel
    const footer = generateCampaignFooter(baseUrl, campaign._id.toString(), email);
    
    let htmlWithTracking = htmlWithLinksTracked;
    if (htmlWithLinksTracked.includes('</body>')) {
      htmlWithTracking = htmlWithLinksTracked.replace('</body>', footer + trackingPixel + '</body>');
    } else {
      htmlWithTracking = htmlWithLinksTracked.replace('</html>', footer + trackingPixel + '</html>');
    }

    await sendCampaignEmail({
      to: email,
      subject: `[TEST] ${campaign.subject}`,
      html: htmlWithTracking,
      campaignId: campaign._id.toString(),
      recipientEmail: email,
    });

    // Delete existing tracking record for this test email to avoid duplicate key errors
    await EmailTracking.deleteOne({ campaignId: campaign._id, email: email });
    
    const tracking = new EmailTracking({
      campaignId: campaign._id,
      email: email,
      status: "delivered",
    });
    await tracking.save();

    campaign.stats.sent = (campaign.stats.sent || 0) + 1;
    await campaign.save();

    console.log(`[TEST EMAIL] Sent test email to ${email} for campaign "${campaign.name}" (ID: ${campaign._id})`);
    console.log(`[TEST EMAIL] Campaign "${campaign.name}" sent count is now: ${campaign.stats.sent}`);

    res.json({ success: true, message: "Test email sent", sentCount: campaign.stats.sent });
  } catch (err) {
    console.error("Send test error:", err);
    res.status(500).json({ error: "Failed to send test email" });
  }
});

router.get("/:id/tracking", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const campaign = await Campaign.findById(req.params.id);
    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const { page = 1, limit = 50 } = req.query;
    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 50;
    const skip = (pageNum - 1) * limitNum;

    // Get total count for pagination
    const totalRecords = await EmailTracking.countDocuments({ campaignId: req.params.id });
    const totalPages = Math.ceil(totalRecords / limitNum);

    // Fetch paginated tracking data
    const trackingData = await EmailTracking.find({ campaignId: req.params.id })
      .sort({ lastOpenAt: -1, lastClickAt: -1 })
      .skip(skip)
      .limit(limitNum);

    const recipients = trackingData.map((t) => ({
      email: t.email,
      status: t.status,
      opened: t.opens.length > 0,
      clicked: t.clicks.length > 0,
      lastActivity: t.lastOpenAt || t.lastClickAt || null,
    }));

    const timeline = [];
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const trackingByDate = {};
    trackingData.forEach((t) => {
      t.opens.forEach((o) => {
        const date = new Date(o.timestamp).toISOString().split("T")[0];
        trackingByDate[date] = trackingByDate[date] || { opens: 0, clicks: 0 };
        trackingByDate[date].opens++;
      });
      t.clicks.forEach((c) => {
        const date = new Date(c.timestamp).toISOString().split("T")[0];
        trackingByDate[date] = trackingByDate[date] || { opens: 0, clicks: 0 };
        trackingByDate[date].clicks++;
      });
    });

    Object.entries(trackingByDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([date, data]) => {
        timeline.push({ date, ...data });
      });

    res.json({
      stats: campaign.stats,
      recipients,
      timeline,
      totalSent: campaign.stats.sent,
      pagination: {
        page: pageNum,
        limit: limitNum,
        totalRecords,
        totalPages,
      },
    });
  } catch (err) {
    console.error("Tracking error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/cleanup-templates", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const campaigns = await Campaign.find({ template: { $exists: true, $ne: null } });
    
    res.json({
      success: true,
      message: "HTML sanitization has been removed. All templates are used as-is without modification.",
      totalCampaigns: campaigns.length
    });
  } catch (err) {
    console.error("[CLEANUP] Error:", err);
    res.status(500).json({ error: "Failed to check templates", details: err.message });
  }
});

export default router;
