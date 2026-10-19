// server.js
import dotenv from "dotenv";
dotenv.config();
import express from "express";
import mongoose from "mongoose";
import { startPriceScheduler } from "./services/scheduledPrices.js";
import { migrateDirectorySelfHideOnce } from "./services/directoryHide.js";
import { migrateVipTypeOnce } from "./services/vipFlag.js";
import { migrateFourPassesOnce } from "./services/fourPasses.js";
import AttendeeModel from "./models/Attendee.js";
import RsvpModel from "./models/Rsvp.js";
import EmailTemplateModel from "./models/EmailTemplate.js";
import { clearRightsCache } from "./services/rightsStore.js";
import { clearExhibitorCache } from "./services/exhibitorCache.js";
import UserModel from "./models/User.js";
import { AdminAudit, AppContent } from "./models/Admin.js";
import cors from "cors";
import authRoutes from "./routes/auth.js";
import paymentRoutes from "./routes/payments.js";
import webhookRoutes from "./routes/webhook.js";
import checkinRoutes from "./routes/checkin.js";
import adminRoutes, { repairStripeSyncOnce } from "./routes/admin.js";
import leadsRoutes from "./routes/leads.js";
import kycRoutes from "./routes/kyc.js";
import brochureRoutes from "./routes/brochure.js";
import formsRoutes from "./routes/forms.js";
import rsvpRoutes from "./routes/rsvp.js";           // TTFC 2026 RSVPs (website /rsvp, unlinked)
import agendaRoutes from "./routes/agenda.js";
import subscriptionRoutes from "./routes/subscriptions.js";
import campaignRoutes from "./routes/campaigns.js";
import trackingRoutes from "./routes/tracking.js";
import campaignAutomationRoutes from "./routes/campaignAutomation.js";
import promosRouter from "./routes/promos.js";
import nominationsRouter from "./routes/nominations.js";
import nominationsAdminRouter from "./routes/nominationsAdmin.js";                 // Catalyst Awards nominations (admin console)
import pavilionRouter from "./routes/pavilion.js";
import linkedinRouter from "./routes/linkedin.js";
import mediaRouter from "./routes/media.js"; // 👈 NEW — press & media accreditation
import profileRouter from "./routes/profile.js";   // attendee profile (website survey + iOS app)
import moderateRouter from "./routes/moderate.js"; // DeepCleer text-moderation proxy (iOS app)
import intelRouter from "./routes/intel.js";       // Gemini company-intel cards (iOS app home screen)
import socialRouter from "./routes/social.js";     // feed / connections / messages / sessions (iOS app)
import communityRouter from "./routes/community.js"; // discussions + groups (iOS app)
import walletRouter from "./routes/wallet.js";       // Apple Wallet passes (iOS app)
import ticketAuthRouter from "./routes/ticketAuth.js"; // ticket-ID sign-in + claim (iOS app)
import emailLinkRouter from "./routes/emailLink.js";   // "email me a sign-in link" (app + website)
import appApiRouter from "./routes/appApi.js";         // analytics, app texts, report/block, account deletion
import consoleRouter from "./routes/console.js";       // admin console API
import cmsRouter from "./routes/cms.js";               // edit Sanity speakers/partners from the admin panel
import filesRouter from "./routes/files.js";           // post photos + profile photos
import completeProfileRouter from "./routes/completeProfile.js"; // attendee "complete your profile" form (signed link)
import attendingRouter, { attendingLinkedinCallback, attendingPostDraft } from "./routes/attending.js"; // website /attending: LinkedIn photo + proxy
import attendingCampaignRouter from "./routes/attendingCampaign.js";              // "I'm attending" email (admin console)
import rsvpRemindersRouter from "./routes/rsvpReminders.js";                         // RSVP reminder email (admin console)
import issuedPassesRouter, { issuedPassRouter } from "./routes/issuedPasses.js";                           // staff-issued passes (admin console)
import peopleRouter, { companiesRouter } from "./routes/people.js";                   // Admin → People directory + company logos
import { killSwitchMiddleware, statusHandler } from "./services/killSwitch.js";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
// Render terminates TLS in front of us: trust one proxy hop so req.ip is the
// visitor's address (rate limits per person, not per load balancer).
app.set("trust proxy", 1);

/* ==========================================
   CORS CONFIG (DEV + PROD)
========================================== */
const allowedOrigins = [
   "https://www.thetechfestival.com",
  "https://thetechfestival.com",
  "http://localhost:5173",
  "https://techfest-canada-frontend.vercel.app",
  "https://techfest-canada-backend.onrender.com",
  "https://techfest-api.onrender.com"
];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("CORS not allowed"), false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
}));

/* ==========================================
   STRIPE WEBHOOK (RAW BODY REQUIRED)
   IMPORTANT: Must preserve exact raw body for Stripe signature
========================================== */
app.use(
  "/api/webhook",
  express.raw({ type: "application/json" }),
  webhookRoutes
);

/* ==========================================
   JSON PARSER
========================================== */
// CMS uploads (speaker photos, logos) need a bigger body than everything else.
app.use("/api/cms", express.json({ limit: "9mb" }), cmsRouter);
// "I'm attending" Post to LinkedIn: the finished image arrives as a base64 PNG.
app.post("/api/attending/post", express.json({ limit: "9mb" }), attendingPostDraft);
// Company logos uploaded in Admin → People (2 MB images, as base64).
app.use("/api/console/companies", express.json({ limit: "4mb" }), companiesRouter);
// Feed photos and profile photos arrive as base64 JSON.
app.use(express.json({ limit: "1mb" }));

/* ==========================================
   KILL SWITCH — site + app offline (staff routes keep working)
========================================== */
app.get("/api/status", statusHandler);
app.use(killSwitchMiddleware);

/* ==========================================
   ROUTES
========================================== */
// "I'm attending" LinkedIn photo: its callbacks (state "ttfc-att.…") share the registered redirect URI; others fall through.
app.get("/api/auth/linkedin/callback", attendingLinkedinCallback);
app.use("/api/auth", authRoutes);
app.use("/api/auth", ticketAuthRouter); // POST /ticket-login, /claim-ticket, /refresh
app.use("/api/auth", emailLinkRouter);  // POST /email-link, /email-link/verify
app.use("/api/payments", paymentRoutes);
app.use("/api/checkin", checkinRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/leads", leadsRoutes);
app.use("/api/kyc", kycRoutes);
app.use("/api/brochure", brochureRoutes);
app.use("/api/forms", formsRoutes);         // POST /:form (volunteer, speaker, exhibit, sponsor, partnership, inquiry)
app.use("/api/rsvp", rsvpRoutes);           // GET /options, POST /lookup, POST /
app.use("/api/agenda", agendaRoutes);
app.use("/api/subscriptions", subscriptionRoutes);
app.use("/api/campaigns", campaignRoutes);
app.use("/api/track", trackingRoutes);
app.use("/api/campaigns/automation", campaignAutomationRoutes);
app.use("/api/media", mediaRouter); // 👈 NEW → POST /api/media/apply
app.use("/api/profile", profileRouter);   // GET/PATCH /api/profile
app.use("/api/moderate", moderateRouter); // POST /api/moderate
app.use("/api/intel", intelRouter);       // GET /api/intel?topics=
app.use("/api/social", socialRouter);     // see routes/social.js
app.use("/api/community", communityRouter); // see routes/community.js
app.use("/api/wallet", walletRouter);       // GET /api/wallet/pass/:ticketId, /link/:ticketId
app.use("/api/app", appApiRouter);          // /events, /content, /report, /block, /account
app.use("/api/attending", attendingRouter);  // GET /linkedin, /photo?u= (website /attending)
app.use("/api/console/attending-campaign", attendingCampaignRouter); // "I'm attending" email (before the console router)
app.use("/api/console/nominations", nominationsAdminRouter); // Catalyst Awards (before the console router)
app.use("/api/console/rsvp-reminders", rsvpRemindersRouter); // RSVP reminder email (before the console router)
app.use("/api/console/issued-passes", issuedPassesRouter); // Issue passes (before the console router)
app.use("/api/console/exhibitor-passes", issuedPassRouter("exhibitor")); // Exhibitor passes + manual PDF (before the console router)
app.use("/api/console/people", peopleRouter); // People directory, profiles, staff RSVPs (before the console router)
app.use("/api/console", consoleRouter);     // admin console (staff only)
app.use("/api/files", filesRouter);         // GET /post/:id, /avatar/:id, /company-logo/:id
app.use("/api/complete-profile", completeProfileRouter); // GET/POST ?t=&s= (no login)
// The admin console website: https://<backend>/console
app.use("/console", express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "console"), { index: "index.html", maxAge: "5m" }));
app.use("/api", promosRouter);
app.use("/api", nominationsRouter);
app.use("/api", pavilionRouter);
app.use("/api", linkedinRouter);

/* ==========================================
   HEALTH CHECK
========================================== */
app.get("/", (req, res) => {
  res.send("🚀 TechFest API running");
});

/* ==========================================
   DATABASE
========================================== */
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("✅ MongoDB connected"); repairStripeSyncOnce(); startPriceScheduler();
    // Once: people who hid themselves from the attendee list are shown again (staff hides kept).
    migrateDirectorySelfHideOnce({ User: UserModel, AdminAudit, AppContent });
    // Once: the VIP person type becomes the VIP yes / no switch, and leaves the app rights matrix.
    migrateVipTypeOnce({ User: UserModel, AppContent, AdminAudit, onDone: () => { clearRightsCache(); clearExhibitorCache(); } });
    // Once: speakers' passes become Power Passes (speaker kept by a marker on the pass), exhibitor passes "Connect Pass".
    migrateFourPassesOnce({ User: UserModel, Attendee: AttendeeModel, Rsvp: RsvpModel, EmailTemplate: EmailTemplateModel, AppContent, AdminAudit,
      onDone: () => { clearRightsCache(); clearExhibitorCache(); } });
  })
  .catch((err) => console.error("❌ MongoDB connection error:", err));

/* ==========================================
   SERVER START
========================================== */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
