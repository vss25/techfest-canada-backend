import express from "express";
import Subscription from "../models/Subscription.js";
import Audience from "../models/Audience.js";
import { requireAdmin } from "../middleware/adminAuth.js";
import { sendUnsubscribeConfirmationEmail, sendWelcomeEmail } from "../services/emailService.js";
import { recordUnsubscribe } from "../services/unsubscribe.js";

const router = express.Router();

async function addToNewsletterAudience(email) {
  try {
    const emailLower = email.toLowerCase();
    let audience = await Audience.findOne({ name: "Newsletter" });
    
    if (!audience) {
      audience = new Audience({
        name: "Newsletter",
        description: "Website newsletter subscribers",
      });
    }
    
    const exists = audience.contacts.some(c => c.email.toLowerCase() === emailLower);
    if (!exists) {
      audience.contacts.push({
        email: emailLower,
        addedAt: new Date(),
      });
      await audience.save();
      console.log("[addToNewsletterAudience] Added:", emailLower);
    } else {
      console.log("[addToNewsletterAudience] Already exists:", emailLower);
    }
  } catch (err) {
    console.error("[addToNewsletterAudience] Error:", err);
  }
}

router.post("/subscribe", async (req, res) => {
  try {
    const { email, source = "website" } = req.body;
    console.log("[SUBSCRIBE] Request received:", { email, source });

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    const emailLower = email.toLowerCase();
    const existing = await Subscription.findOne({ email: emailLower });

    if (existing) {
      if (existing.subscribed) {
        console.log("[SUBSCRIBE] Already subscribed:", emailLower);
        return res.json({ message: "Already subscribed" });
      }
      existing.subscribed = true;
      existing.source = source;
      await existing.save();
      console.log("[SUBSCRIBE] Resubscribed:", emailLower);
      return res.json({ message: "Resubscribed successfully" });
    }

    const subscription = await Subscription.create({
      email: emailLower,
      source,
    });
    console.log("[SUBSCRIBE] Created subscription:", subscription._id);

    await addToNewsletterAudience(emailLower);
    console.log("[SUBSCRIBE] Added to audience");
    
    // MailerLite sync removed - using Resend for now
    
    res.status(201).json({ message: "Subscribed successfully" });
  } catch (err) {
    if (err.code === 11000) {
      return res.json({ message: "Already subscribed" });
    }
    console.error("Subscription error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/unsubscribe", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    // On the one unsubscribe list every bulk email reads (a row is made when there's none).
    const done = await recordUnsubscribe(Subscription, email, { source: "website" });
    if (!done) return res.status(400).json({ error: "Invalid email format" });

    try {
      await removeSubscriber(email.toLowerCase());
      console.log("[UNSUBSCRIBE] MailerLite sync: success");
    } catch (mlErr) {
      console.error("[UNSUBSCRIBE] MailerLite sync error:", mlErr.message);
    }

    res.json({ message: "Unsubscribed successfully" });
  } catch (err) {
    console.error("Unsubscribe error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ================= UNSUBSCRIBE CONFIRM (from email link) =================
// GET - shows confirmation page (redirected from tracking.js)
router.get("/unsubscribe/confirm/:campaignId/:email", async (req, res) => {
  try {
    const { campaignId, email } = req.params;
    const emailLower = decodeURIComponent(email).toLowerCase();
    const baseUrl = process.env.FRONTEND_URL || "https://www.thetechfestival.com";

    // Get campaign info for display
    let campaignName = "our emails";
    try {
      const Campaign = (await import("../models/Campaign.js")).default;
      const campaign = await Campaign.findById(campaignId);
      if (campaign) campaignName = campaign.name;
    } catch (e) {
      // Ignore - use default
    }

    const confirmUrl = `${baseUrl}/api/subscriptions/unsubscribe/confirm/${campaignId}/${encodeURIComponent(emailLower)}`;

    res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Unsubscribe - TechFest Canada</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; background: linear-gradient(135deg, #7a3fd1 0%, #f5a623 100%); min-height: 100vh; font-family: Arial, sans-serif; }
    .container { max-width: 500px; margin: 50px auto; padding: 20px; }
    .card { background: white; border-radius: 16px; padding: 40px; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,0.2); }
    h1 { color: #7a3fd1; margin: 0 0 20px; font-size: 24px; }
    p { color: #666; line-height: 1.6; margin: 0 0 20px; }
    .btn { display: inline-block; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 5px; transition: transform 0.2s; cursor: pointer; border: none; font-size: 16px; }
    .btn-primary { background: linear-gradient(135deg, #7a3fd1, #f5a623); color: white; }
    .btn-primary:hover { transform: scale(1.02); }
    .btn-secondary { background: #f3f4f6; color: #666; }
    .btn-secondary:hover { background: #e5e7eb; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>Unsubscribe from Emails</h1>
      <p>You are about to unsubscribe from <strong>${campaignName}</strong>.</p>
      <p>You will no longer receive emails from The Tech Festival Canada using this email address.</p>
      <form action="${confirmUrl}" method="POST">
        <button type="submit" class="btn btn-primary">Yes, Unsubscribe</button>
      </form>
      <a href="${baseUrl}" class="btn btn-secondary">Cancel</a>
    </div>
  </div>
</body>
</html>
    `.trim());
  } catch (err) {
    console.error("Unsubscribe confirm page error:", err);
    res.status(500).send("Error loading unsubscribe page");
  }
});

// POST - actually performs the unsubscribe
router.post("/unsubscribe/confirm/:campaignId/:email", async (req, res) => {
  try {
    const { campaignId, email } = req.params;
    const emailLower = decodeURIComponent(email).toLowerCase();
    const baseUrl = process.env.FRONTEND_URL || "https://www.thetechfestival.com";

    console.log(`[UNSUBSCRIBE CONFIRM] Processing: ${emailLower}`);

    // 1. Remove from all Audience contacts
    const audiences = await Audience.find({ "contacts.email": emailLower });
    let removedFromAudience = false;

    for (const audience of audiences) {
      const initialCount = audience.contacts.length;
      audience.contacts = audience.contacts.filter(c => c.email.toLowerCase() !== emailLower);
      
      if (audience.contacts.length < initialCount) {
        await audience.save();
        removedFromAudience = true;
        console.log(`[UNSUBSCRIBE] Removed ${emailLower} from audience: ${audience.name}`);
      }
    }

    // 2. The one unsubscribe list every bulk email reads (a row is made when there's none)
    await recordUnsubscribe(Subscription, emailLower, { source: "campaign-link" });
    console.log(`[UNSUBSCRIBE] On the unsubscribe list: ${emailLower}`);

    // 3. Sync with MailerLite
    try {
      await removeSubscriber(emailLower);
      console.log(`[UNSUBSCRIBE] MailerLite unsubscribed: ${emailLower}`);
    } catch (mlErr) {
      console.error(`[UNSUBSCRIBE] MailerLite error:`, mlErr.message);
    }

    // 4. Send confirmation email
    try {
      await sendUnsubscribeConfirmationEmail(emailLower);
      console.log(`[UNSUBSCRIBE] Sent confirmation email to: ${emailLower}`);
    } catch (emailErr) {
      console.error(`[UNSUBSCRIBE] Failed to send confirmation email:`, emailErr);
      // Don't fail the whole process if email fails
    }

    // 4. Return success page
    res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Unsubscribed - TechFest Canada</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; background: linear-gradient(135deg, #7a3fd1 0%, #f5a623 100%); min-height: 100vh; font-family: Arial, sans-serif; }
    .container { max-width: 500px; margin: 50px auto; padding: 20px; }
    .card { background: white; border-radius: 16px; padding: 40px; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,0.2); }
    h1 { color: #7a3fd1; margin: 0 0 20px; font-size: 24px; }
    p { color: #666; line-height: 1.6; margin: 0 0 20px; }
    .checkmark { font-size: 48px; margin-bottom: 20px; }
    .btn { display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #7a3fd1, #f5a623); color: white; border-radius: 8px; text-decoration: none; font-weight: bold; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="checkmark">✓</div>
      <h1>Successfully Unsubscribed</h1>
      <p>You have been unsubscribed from The Tech Festival Canada emails.</p>
      <p>We're sorry to see you go! You can always re-subscribe on our website in the future.</p>
      <a href="${baseUrl}" class="btn">Return to TechFest Canada</a>
    </div>
  </div>
</body>
</html>
    `.trim());

  } catch (err) {
    console.error("Unsubscribe confirm error:", err);
    res.status(500).send("Error processing unsubscribe request");
  }
});

router.get("/", requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, subscribed } = req.query;

    const query = {};
    if (subscribed !== undefined) {
      query.subscribed = subscribed === "true";
    }

    const subscriptions = await Subscription.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await Subscription.countDocuments(query);

    res.json({
      subscriptions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error("Admin subscriptions error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/stats", requireAdmin, async (req, res) => {
  try {
    const total = await Subscription.countDocuments();
    const active = await Subscription.countDocuments({ subscribed: true });
    const inactive = total - active;

    res.json({ total, active, inactive });
  } catch (err) {
    console.error("Subscription stats error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
