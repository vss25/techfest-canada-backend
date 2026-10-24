// server.js
import dotenv from "dotenv";
// TTFC_IMPORT_ONLY=1: a test imports this file for the app alone (test/volunteer-panel-db.test.js walks every route):
// no .env, no database, no jobs, no listening. Unset (production, npm start, npm run dev): everything as always.
const IMPORT_ONLY = process.env.TTFC_IMPORT_ONLY === "1";
if (!IMPORT_ONLY) dotenv.config();
import express from "express";
import mongoose from "mongoose";
import { startPriceScheduler } from "./services/scheduledPrices.js";
import { startSessionGroups } from "./services/sessionGroups.js";
import { startSpeakerPhotos } from "./services/speakerPhotoStore.js";
import { startDigests } from "./services/digest.js";
import { startSwagSnapshot } from "./services/swag.js";
import { publicRouter as swagPublicRouter, adminRouter as swagAdminRouter } from "./routes/swag.js";   // "Win the TTFC swag kit"
import { attendeeRouter as sosAttendeeRouter, staffRouter as sosStaffRouter } from "./routes/sos.js";   // Help & SOS
import digestAdminRouter, { publicRouter as digestPublicRouter } from "./routes/digest.js";   // "What you missed" emails
import { appRouter as linkedinAppRouter, publicRouter as linkedinSharePageRouter, linkedinShareCallback } from "./routes/linkedinShare.js";
import { migrateDirectorySelfHideOnce } from "./services/directoryHide.js";
import { migrateVipTypeOnce } from "./services/vipFlag.js";
import { migratePassNamesOnce } from "./services/passNames.js";
import AttendeeModel from "./models/Attendee.js";
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
import checkinDeskRoutes from "./routes/checkinDesk.js"; // TTFC Check-in desk app (lobby, pass desk, meals, media, AV, exhibitors)
import adminRoutes, { repairStripeSyncOnce } from "./routes/admin.js";
import leadsRoutes from "./routes/leads.js";
import kycRoutes from "./routes/kyc.js";
import brochureRoutes from "./routes/brochure.js";
import formsRoutes from "./routes/forms.js";
import rsvpRoutes from "./routes/rsvp.js";           // TTFC 2026 RSVPs (website /rsvp, unlinked)
import { publicRouter as stayUpdatedRouter, adminRouter as waitlistAdminRouter } from "./routes/stayUpdated.js"; // "Stay updated": the TTFC 2027 waitlist
import agendaRoutes from "./routes/agenda.js";
import subscriptionRoutes from "./routes/subscriptions.js";
import campaignRoutes from "./routes/campaigns.js";
import trackingRoutes from "./routes/tracking.js";
import campaignAutomationRoutes from "./routes/campaignAutomation.js";
import promosRouter from "./routes/promos.js";
import nominationsRouter from "./routes/nominations.js";
import nominationsAdminRouter from "./routes/nominationsAdmin.js";                 // Catalyst Awards nominations (admin console)
import juryRouter from "./routes/jury.js";                                           // Catalyst Awards jury portal (website /awards/jury-admin)
import juryAdminRouter from "./routes/juryAdmin.js";                                // Catalyst Awards jury: jurors, allocation, rubric, results (admin console)
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
import { appOrganisationsRouter, consoleOrganisationsRouter } from "./routes/appOrganisations.js"; // the apps' organisations list + Admin › Attending organisations
import appAwardsRouter from "./routes/appAwards.js";   // Catalyst Awards numbers + applications in the apps
import consoleRouter from "./routes/console.js";       // admin console API
import cmsRouter, { siteFileBody, uploadSiteFile } from "./routes/cms.js"; // edit Sanity speakers/partners from the admin panel
import { requireManagementAdmin } from "./middleware/adminAuth.js";
import filesRouter from "./routes/files.js";           // post photos + profile photos
import completeProfileRouter from "./routes/completeProfile.js"; // attendee "complete your profile" form (signed link)
import attendingRouter, { attendingLinkedinCallback, attendingPostDraft } from "./routes/attending.js"; // website /attending: LinkedIn photo + proxy
import attendingCampaignRouter from "./routes/attendingCampaign.js";              // "I'm attending" email (admin console)
import appInviteRouter from "./routes/appInvite.js";                                // app invite email (admin console)
import rsvpRemindersRouter from "./routes/rsvpReminders.js";                         // RSVP reminder email (admin console)
import issuedPassesRouter, { issuedPassRouter } from "./routes/issuedPasses.js";                           // staff-issued passes (admin console)
import purchaseEmailRouter from "./routes/purchaseEmail.js";                                         // Admin › Purchase email
import peopleRouter, { companiesRouter } from "./routes/people.js";                   // Admin → People directory + company logos
import eventSummaryRouter from "./routes/eventSummary.js";                          // Admin › Event summary (headcounts, read only)
import engagementRouter from "./routes/engagement.js";                              // GET /api/t/o/<token>.gif: email open pixel
import unsubscribeRouter from "./routes/unsubscribe.js";                            // the unsubscribe link in every bulk email (no sign-in)
import unsubscribesRouter from "./routes/unsubscribes.js";                          // Admin › Unsubscribed emails
import { statusHandler } from "./services/siteStatus.js"; // GET /api/status: always live (the kill switch was removed Oct 23 2026)
import { installGracefulShutdown } from "./services/gracefulShutdown.js";
import { endStreams } from "./services/checkinDeskLog.js";
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
// Large site files (the home video, the brochure PDF): the raw file, up to 40 MB, before the JSON parsers.
// Management is checked first, so nobody else can make the server read 40 MB.
app.post("/api/cms/upload-file", requireManagementAdmin, siteFileBody, uploadSiteFile);
// CMS uploads (speaker photos, logos) need a bigger body than everything else.
app.use("/api/cms", express.json({ limit: "9mb" }), cmsRouter);
// "I'm attending" Post to LinkedIn: the finished image arrives as a base64 PNG.
app.post("/api/attending/post", express.json({ limit: "9mb" }), attendingPostDraft);
// Company logos uploaded in Admin → People (2 MB images, as base64).
app.use("/api/console/companies", express.json({ limit: "4mb" }), companiesRouter);
// Feed photos and profile photos arrive as base64 JSON.
app.use(express.json({ limit: "1mb" }));

// The email open pixel.
app.use("/api/t", engagementRouter);
// The unsubscribe link in every bulk email.
app.use("/api/unsubscribe", unsubscribeRouter);

/* ==========================================
   SITE STATUS — always live
   The kill switch (website + apps offline from the admin panel) was removed
   on Oct 23 2026 (the organiser: "Its risky"). The website and the apps
   already out there ask GET /api/status on launch, so it stays and always
   answers { live: true, message: "" } (services/siteStatus.js). An emergency
   take-down is done by the developers on the hosting (Vercel / Render).
========================================== */
app.get("/api/status", statusHandler);

/* ==========================================
   ROUTES
========================================== */
// "I'm attending" LinkedIn photo: its callbacks (state "ttfc-att.…") share the registered redirect URI; others fall through.
app.get("/api/auth/linkedin/callback", attendingLinkedinCallback);
// "Share on LinkedIn" from the apps (state "ttfc-shr.…", routes/linkedinShare.js): the same registered redirect URI.
app.get("/api/auth/linkedin/callback", linkedinShareCallback);
app.use("/api/auth", authRoutes);
app.use("/api/auth", ticketAuthRouter); // POST /ticket-login, /claim-ticket, /refresh
app.use("/api/auth", emailLinkRouter);  // POST /email-link, /email-link/verify
app.use("/api/jury", juryRouter);       // the jury portal: jury tokens only (services/juryAuth.js)
app.use("/api/payments", paymentRoutes);
app.use("/api/checkin/desk", checkinDeskRoutes); // the desk app: under /api/checkin so the kill switch leaves it on
app.use("/api/checkin", checkinRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/leads", leadsRoutes);
app.use("/api/kyc", kycRoutes);
app.use("/api/brochure", brochureRoutes);
app.use("/api/forms", formsRoutes);         // POST /:form (volunteer, speaker, exhibit, sponsor, partnership, inquiry)
app.use("/api/rsvp", rsvpRoutes);           // GET /options, POST /lookup, POST /
app.use("/api/stay-updated", stayUpdatedRouter); // POST / : join the TTFC 2027 waitlist (website /stay-updated, the web app, the apps)
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
app.use("/api/app/swag", swagPublicRouter);   // the swag kit contest's settings and rules (no sign-in)
app.use("/api/app/sos", sosAttendeeRouter);   // Help & SOS: attendees' urgent messages to staff (signed in)
app.use("/api/app/digest", digestPublicRouter); // "What you missed" email: one-click unsubscribe (no sign-in)
app.use("/api/app", linkedinAppRouter);       // GET /attending-link, POST /linkedin/share (signed in)
app.use("/api/linkedin-share", linkedinSharePageRouter); // the website's /share/linkedin page (the link's token)
app.use("/api/app", appOrganisationsRouter); // GET /organisations (no sign-in)
app.use("/api/app", appAwardsRouter);        // GET /awards/summary (no sign-in), /awards/applications (pass holders)
app.use("/api/app", appApiRouter);          // /events, /content, /report, /block, /account
app.use("/api/attending", attendingRouter);  // GET /linkedin, /photo?u= (website /attending)
app.use("/api/console/attending-campaign", attendingCampaignRouter); // "I'm attending" email (before the console router)
app.use("/api/console/app-invite", appInviteRouter);
app.use("/api/console/swag", swagAdminRouter); // the swag kit winners: review, announce (before the console router) // app invite email: Website & app › App invite email (before the console router)
app.use("/api/console/nominations", nominationsAdminRouter); // Catalyst Awards (before the console router)
app.use("/api/console/jury", juryAdminRouter); // Catalyst Awards jury (before the console router)
app.use("/api/console/rsvp-reminders", rsvpRemindersRouter); // RSVP reminder email (before the console router)
app.use("/api/console/issued-passes", issuedPassesRouter); // Issue passes (before the console router)
app.use("/api/console/exhibitor-passes", issuedPassRouter("exhibitor")); // Exhibitor passes + manual PDF (before the console router)
app.use("/api/console/purchase-email", purchaseEmailRouter); // the purchase confirmation's wording (before the console router)
app.use("/api/console/sos", sosStaffRouter);   // Help & SOS inbox: staff and moderators (app or admin sign-in), before the console router
app.use("/api/console/digest", digestAdminRouter); // "What you missed" emails: switch, test, counts (before the console router)
app.use("/api/console/unsubscribes", unsubscribesRouter); // Unsubscribed emails: the list, add, resubscribe (before the console router)
app.use("/api/console/waitlist", waitlistAdminRouter); // 2027 waitlist: the list, counts, CSV (before the console router)
app.use("/api/console/people", peopleRouter); // People directory, profiles, staff RSVPs (before the console router)
app.use("/api/console/summary", eventSummaryRouter); // Event summary: passes, RSVPs, meals, check-in (read only, before the console router)
app.use("/api/console/organisations", consoleOrganisationsRouter); // Attending organisations: hide, merge, logos (before the console router)
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
// Reads from the primary whatever MONGO_URI says (options here win over the URI's), so a post, comment or message
// someone just wrote is always found by the next request (no read-after-write gap on a lagging secondary).
// Not when a test imports this file for the app alone (IMPORT_ONLY, above).
if (!IMPORT_ONLY) mongoose
  .connect(process.env.MONGO_URI, { readPreference: "primary" })
  .then(() => {
    console.log("✅ MongoDB connected"); repairStripeSyncOnce(); startPriceScheduler();
    // Every minute, one server: session chats 30 min before each agenda session (services/sessionGroups.js).
    startSessionGroups();
    // Speakers' website photos as their avatar until they upload one: loaded now, then every 10 min (services/speakerPhotoStore.js).
    startSpeakerPhotos();
    // Every minute, one server: "What you missed" emails, while staff have them switched on (services/digest.js).
    startDigests();
    // Every minute: at the swag kit cutoff, keep the leaderboard as it is then (services/swag.js).
    startSwagSnapshot();
    // Once: people who hid themselves from the attendee list are shown again (staff hides kept).
    migrateDirectorySelfHideOnce({ User: UserModel, AdminAudit, AppContent });
    // Once: the VIP person type becomes the VIP yes / no switch, and leaves the app rights matrix.
    migrateVipTypeOnce({ User: UserModel, AppContent, AdminAudit, onDone: () => { clearRightsCache(); clearExhibitorCache(); } });
    // Once: exhibitor passes named "Connect Pass", "All Access Pass" gone (it's the Power Pass), issued Speaker Passes "Speaker Pass".
    migratePassNamesOnce({ Attendee: AttendeeModel, EmailTemplate: EmailTemplateModel, AppContent, AdminAudit });
  })
  .catch((err) => console.error("❌ MongoDB connection error:", err));

/* ==========================================
   SERVER START
========================================== */
const PORT = process.env.PORT || 5000;
if (!IMPORT_ONLY) {
  const server = app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
  // SIGTERM (every Render deploy / restart): no new connections, the check-in desk's live streams told to reconnect,
  // requests in flight (a desk tap half-written) finish for up to 10 s, then the database closes and the process exits
  // (a second first, for work the last answers started: the door scan records the desk's check-in after answering).
  installGracefulShutdown(server, {
    timeoutMs: 10 * 1000, beforeClose: endStreams,
    onClosed: async () => { await new Promise((r) => setTimeout(r, 1000)); await mongoose.disconnect(); },
  });
}

// The app itself, for the tests' route sweep (IMPORT_ONLY).
export default app;
