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
import { startSurveyNotify } from "./services/survey.js";
import { startScheduledBroadcasts } from "./services/scheduledBroadcasts.js";   // management's scheduled broadcasts
import { publicRouter as surveyPublicRouter, appRouter as surveyAppRouter, adminRouter as surveyAdminRouter } from "./routes/survey.js";   // the post-event survey
import { attendeeRouter as sosAttendeeRouter, staffRouter as sosStaffRouter } from "./routes/sos.js";   // Help & SOS
import digestAdminRouter, { publicRouter as digestPublicRouter } from "./routes/digest.js";   // "What you missed" emails
import { appRouter as linkedinAppRouter, publicRouter as linkedinSharePageRouter, linkedinShareCallback } from "./routes/linkedinShare.js";
import { migrateDirectorySelfHideOnce } from "./services/directoryHide.js";
import { migrateVipTypeOnce } from "./services/vipFlag.js";
import { migratePassNamesOnce } from "./services/passNames.js";
import AttendeeModel from "./models/Attendee.js";
import EventConfigModel from "./models/EventConfig.js";
import { copyDefaultsToBriefingsOnce } from "./services/ticketTypeDefaults.js";
import EmailTemplateModel from "./models/EmailTemplate.js";
import { clearRightsCache } from "./services/rightsStore.js";
import { clearExhibitorCache } from "./services/exhibitorCache.js";
import UserModel from "./models/User.js";
import { AdminAudit, AppContent } from "./models/Admin.js";
import cors from "cors";
import { corsOrigin } from "./services/corsOrigins.js";
import authRoutes from "./routes/auth.js";
import paymentRoutes from "./routes/payments.js";
import webhookRoutes from "./routes/webhook.js";
import checkinRoutes from "./routes/checkin.js";
import checkinDeskRoutes from "./routes/checkinDesk.js"; // TTFC Check-in desk app (lobby, pass desk, meals, media, AV, exhibitors)
import adminRoutes, { repairStripeSyncOnce } from "./routes/admin.js";
import leadsRoutes from "./routes/leads.js";
import adminEventsRoutes from "./routes/adminEvents.js"; // Admin › Events: event configs + attendee visibility (the event spine)
import adminTicketTypesRoutes from "./routes/adminTicketTypes.js"; // Admin › Ticket types: per-event ticket types (commerce, plan §9)
import adminSettingsRoutes from "./routes/adminSettings.js"; // Admin › Settings: the typed settings registry (Phase 3)
import adminAuditRoutes from "./routes/adminAudit.js"; // Admin › Audit log: who changed what (Phase 3)
import staffActivityRoutes from "./routes/staffActivity.js"; // Settings › Staff activity (super admin only)
import { trackPanelEdits } from "./services/staffActivity.js";
import ticketsQuoteRoutes from "./routes/ticketsQuote.js"; // POST /api/tickets/quote: the price breakdown before payment
import ordersRoutes from "./routes/orders.js"; // POST /api/orders/multi-checkout: one booker, N named attendees
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
import appExhibitorsRouter from "./routes/appExhibitors.js"; // the public exhibitor list (website /programme)
import consoleRouter from "./routes/console.js";       // admin console API
import { offeringsRouter, contractsRouter } from "./routes/contracts.js"; // sales contracts + offerings catalogue
import { mouItemsRouter, mousRouter } from "./routes/mous.js"; // MOU drafts + the MOU catalogue
import socialPostsRouter from "./routes/socialPosts.js"; // Marketing › Social posts + calendar
import postTemplatesRouter from "./routes/postTemplates.js"; // Marketing › Post templates (uploaded blank designs)
import agendaTypesRouter from "./routes/agendaTypes.js"; // Admin › Agenda: the session type dropdown staff edit
import { consoleRouter as linkedinPostsRouter, publicRouter as linkedinPostsGoRouter, linkedinProfilePostCallback } from "./routes/linkedinProfilePosts.js"; // Marketing › LinkedIn posts for my profile
import museLinkedinBridgeRouter from "./routes/museLinkedinBridge.js"; // the free Muse bridge for LinkedIn profile posts (off unless MUSE_BRIDGE_ENABLED + MUSE_BRIDGE_KEY are set)
import salesEventRouter from "./routes/salesEvent.js"; // Sales for one event: past participants to reconnect with, reach-outs, this event's sales
import contentCalendarRouter from "./routes/contentCalendar.js"; // Marketing › Social media calendar: planned items, spreadsheet upload, mark done
import expleeRouter, { startExpleeSync } from "./routes/explee.js"; // Sales › Hot leads: Explee's hot leads, synced every 10 minutes
import commitmentsRouter, { startCommitmentReminders } from "./routes/commitments.js"; // Home › My work: tasks, flags, morning reminders
import cmsRouter, { siteFileBody, uploadSiteFile } from "./routes/cms.js"; // edit Sanity speakers/partners from the admin panel
import { requireManagementAdmin } from "./middleware/adminAuth.js";
import filesRouter from "./routes/files.js";           // post photos + profile photos
import completeProfileRouter from "./routes/completeProfile.js"; // attendee "complete your profile" form (signed link)
import attendingRouter, { attendingLinkedinCallback, attendingPostDraft } from "./routes/attending.js"; // website /attending: LinkedIn photo + proxy
import awardsRouter, { awardLinkedinCallback, awardPostDraft } from "./routes/awards.js"; // website /awards: the Catalyst Awards winners
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
import { publicCache } from "./middleware/publicCache.js"; // Phase 5: stale-while-revalidate on public GET reads (allowlisted mounts only)

const app = express();
// Render terminates TLS in front of us: trust one proxy hop so req.ip is the
// visitor's address (rate limits per person, not per load balancer).
app.set("trust proxy", 1);

/* ==========================================
   CORS CONFIG (DEV + PROD)
========================================== */
// Allowed origins and why: services/corsOrigins.js (Nov 2026).
app.use(cors({
  origin: corsOrigin,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
}));

// Staff activity: counts each successful admin-panel write once its response is sent (services/staffActivity.js).
// Before every router (cms and the raw-body uploads too); it only listens for "finish".
app.use(trackPanelEdits);

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
// A Catalyst Awards winner's certificate, posted to LinkedIn from /awards/winners/<id> (a base64 JPEG, 2 MB at most).
app.post("/api/awards/post", express.json({ limit: "3mb" }), awardPostDraft);
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
// A Catalyst Awards winner's "Post to LinkedIn" (state "ttfc-awd.…", routes/awards.js): the same registered redirect URI.
app.get("/api/auth/linkedin/callback", awardLinkedinCallback);
// "I'm attending" LinkedIn photo: its callbacks (state "ttfc-att.…") share the registered redirect URI; others fall through.
app.get("/api/auth/linkedin/callback", attendingLinkedinCallback);
// "Share on LinkedIn" from the apps (state "ttfc-shr.…", routes/linkedinShare.js): the same registered redirect URI.
app.get("/api/auth/linkedin/callback", linkedinShareCallback);
// "LinkedIn posts for my profile" (state "ttfc-lip.…", routes/linkedinProfilePosts.js): the same registered redirect URI.
app.get("/api/auth/linkedin/callback", linkedinProfilePostCallback);
app.use("/api/linkedin-posts", linkedinPostsGoRouter); // the one-time hop to LinkedIn's sign-in
app.use("/api/auth", authRoutes);
app.use("/api/auth", ticketAuthRouter); // POST /ticket-login, /claim-ticket, /refresh
app.use("/api/auth", emailLinkRouter);  // POST /email-link, /email-link/verify
app.use("/api/jury", juryRouter);       // the jury portal: jury tokens only (services/juryAuth.js)
app.use("/api/payments", paymentRoutes);
app.use("/api/checkin/desk", checkinDeskRoutes); // the check-in desk app (next to the door scanner)
app.use("/api/checkin", checkinRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/admin/events", adminEventsRoutes); // event spine: GET/POST/PATCH events, GET visibility-matrix (staff only)
app.use("/api/admin/ticket-types", adminTicketTypesRoutes); // ticket types: GET/POST/PATCH/DELETE (staff only)
app.use("/api/admin/settings", adminSettingsRoutes); // settings registry: GET list/one, PUT set (staff only, known keys only)
app.use("/api/admin/staff-activity", staffActivityRoutes); // staff sessions, time, pages, edits: ping / signout (staff), GET (super admin only)
app.use("/api/admin/audit-log", adminAuditRoutes); // audit log: GET paginated, filter by resource/actor/action (staff only)
app.use("/api/tickets", ticketsQuoteRoutes); // POST /quote: public price breakdown (read-only; honours pricingAnnounced)
app.use("/api/orders", ordersRoutes); // POST /multi-checkout: multi-attendee orders
app.use("/api/leads", leadsRoutes);
app.use("/api/kyc", kycRoutes);
app.use("/api/brochure", brochureRoutes);
app.use("/api/forms", formsRoutes);         // POST /:form (volunteer, speaker, exhibit, sponsor, partnership, inquiry)
app.use("/api/rsvp", publicCache(60), rsvpRoutes);           // GET /options, POST /lookup, POST /
app.use("/api/stay-updated", stayUpdatedRouter); // POST / : join the TTFC 2027 waitlist (website /stay-updated, the web app, the apps)
app.use("/api/agenda", agendaRoutes);
app.use("/api/subscriptions", subscriptionRoutes);
app.use("/api/campaigns", campaignRoutes);
app.use("/api/track", trackingRoutes);
app.use("/api/campaigns/automation", campaignAutomationRoutes);
app.use("/api/media", mediaRouter); // 👈 NEW → POST /api/media/apply
app.use("/api/profile", profileRouter);   // GET/PATCH /api/profile
app.use("/api/moderate", moderateRouter); // POST /api/moderate
app.use("/api/intel", publicCache({ "/": 900 }), intelRouter);       // GET /api/intel?topics= (the cards only; /status stays uncached)
app.use("/api/social", socialRouter);     // see routes/social.js
app.use("/api/community", communityRouter); // see routes/community.js
app.use("/api/wallet", walletRouter);       // GET /api/wallet/pass/:ticketId, /link/:ticketId
app.use("/api/app/swag", publicCache(60), swagPublicRouter);   // the swag kit contest's settings and rules (no sign-in)
app.use("/api/survey", publicCache(300), surveyPublicRouter);     // the post-event survey: questions, answers (no sign-in; website /survey) — GET / sets its own no-store (personalized), which publicCache never overrides
app.use("/api/app/survey", surveyAppRouter);    // the post-event survey's card in the apps (signed in)
app.use("/api/app/sos", sosAttendeeRouter);   // Help & SOS: attendees' urgent messages to staff (signed in)
app.use("/api/app/digest", digestPublicRouter); // "What you missed" email: one-click unsubscribe (no sign-in)
app.use("/api/app", linkedinAppRouter);       // GET /attending-link, POST /linkedin/share (signed in)
app.use("/api/linkedin-share", linkedinSharePageRouter); // the website's /share/linkedin page (the link's token)
app.use("/api/app", publicCache({ "/organisations": 120 }), appOrganisationsRouter); // GET /organisations (no sign-in)
app.use("/api/app", publicCache({ "/awards/summary": 60 }), appAwardsRouter);        // GET /awards/summary (no sign-in), /awards/applications (pass holders)
app.use("/api/app", publicCache({ "/exhibitors": 120 }), appExhibitorsRouter);    // GET /exhibitors (no sign-in): companies, booths, zones, logos, websites
app.use("/api/app", publicCache({ "/content": 60, "/webpush-key": 300 }), appApiRouter);          // /events, /content, /report, /block, /account — only the two public reads are allowlisted
app.use("/api/attending", attendingRouter);  // GET /linkedin, /photo?u= (website /attending)
app.use("/api/console/attending-campaign", attendingCampaignRouter); // "I'm attending" email (before the console router)
app.use("/api/console/app-invite", appInviteRouter);
app.use("/api/console/survey", surveyAdminRouter); // the post-event survey: questions, responses, CSV, prompt, email (before the console router)
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
app.use("/api/console/sales-event", salesEventRouter); // past participants + this event's sales (before the console router)
app.use("/api/console/content-calendar", contentCalendarRouter); // content calendar items (before the console router)
app.use("/api/console/explee", expleeRouter); // Sales › Hot leads (before the console router)
app.use("/api/console/commitments", commitmentsRouter); // Home › My work: tasks and flags (before the console router)
app.use("/api/console/linkedin-posts", linkedinPostsRouter); // Marketing › LinkedIn posts for my profile (management; before the console router)
app.use("/api/muse/linkedin-posts", museLinkedinBridgeRouter); // the free Muse bridge: queued rounds in, finished drafts back (key-gated, inert while its env vars are unset)
app.use("/api/console/post-templates", postTemplatesRouter); // Marketing › Post templates (before the console router)
app.use("/api/console/agenda-types", agendaTypesRouter); // Admin › Agenda: session types staff add and edit (before the console router)
app.use("/api/console/social", socialPostsRouter); // Marketing › Social posts, Claude writing, calendar (before the console router)
app.use("/api/console/offerings", offeringsRouter); // Sales contracts: the offerings catalogue (super admin edits; before the console router)
app.use("/api/console/contracts", contractsRouter); // Sales contracts: build, approve, send, sign, tasks, PDF (before the console router)
app.use("/api/console/mou-items", mouItemsRouter); // MOU catalogue: what TTFC offers, what partners deliver (super admin edits; before the console router)
app.use("/api/console/mous", mousRouter); // MOU drafts: build, review, export PDF / Word (before the console router)
app.use("/api/console/people", peopleRouter); // People directory, profiles, staff RSVPs (before the console router)
app.use("/api/console/summary", eventSummaryRouter); // Event summary: passes, RSVPs, meals, check-in (read only, before the console router)
app.use("/api/console/organisations", consoleOrganisationsRouter); // Attending organisations: hide, merge, logos (before the console router)
app.use("/api/console", consoleRouter);     // admin console (staff only)
app.use("/api/files", filesRouter);         // GET /post/:id, /avatar/:id, /company-logo/:id
app.use("/api/complete-profile", completeProfileRouter); // GET/POST ?t=&s= (no login)
// The admin console website: https://<backend>/console
app.use("/console", express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "console"), { index: "index.html", maxAge: "5m" }));
app.use("/api", promosRouter);
app.use("/api/awards", publicCache(60), awardsRouter);    // GET /winners, /winners/:id, /linkedin/post (no sign-in) — /linkedin/post sets its own no-store, which publicCache never overrides
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
    // Every minute: the survey's app prompt in waves from opensAt + 15 min to 10 PM Toronto that day, while autoNotify
    // is on (the default since Oct 26 2026, late; nothing outside that window, nothing on deploy; services/survey.js).
    startSurveyNotify();
    // Every minute, one server: management's scheduled broadcasts that are due (each sent once; over 2 h late = missed;
    // services/scheduledBroadcasts.js). Nothing is scheduled by itself: management creates each one.
    startScheduledBroadcasts();
    // Every 10 minutes, one server, once a morning from 8 AM Toronto: each owner's task reminders (routes/commitments.js).
    startCommitmentReminders();
    // Every 10 minutes, one server, only once EXPLEE_API_KEY is set: new hot leads from Explee (routes/explee.js).
    startExpleeSync();
    // Once: people who hid themselves from the attendee list are shown again (staff hides kept).
    migrateDirectorySelfHideOnce({ User: UserModel, AdminAudit, AppContent });
    // Once: the VIP person type becomes the VIP yes / no switch, and leaves the app rights matrix.
    migrateVipTypeOnce({ User: UserModel, AppContent, AdminAudit, onDone: () => { clearRightsCache(); clearExhibitorCache(); } });
    // Once: exhibitor passes named "Connect Pass", "All Access Pass" gone (it's the Power Pass), issued Speaker Passes "Speaker Pass".
    migratePassNamesOnce({ Attendee: AttendeeModel, EmailTemplate: EmailTemplateModel, AppContent, AdminAudit });
    // Every Briefing without its own tickets gets a copy of the defaults (Nov 22 2026: own prices per event).
    copyDefaultsToBriefingsOnce({ EventConfig: EventConfigModel });
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

