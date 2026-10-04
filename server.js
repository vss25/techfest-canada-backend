// server.js
import dotenv from "dotenv";
dotenv.config();
import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import authRoutes from "./routes/auth.js";
import paymentRoutes from "./routes/payments.js";
import webhookRoutes from "./routes/webhook.js";
import checkinRoutes from "./routes/checkin.js";
import adminRoutes from "./routes/admin.js";
import leadsRoutes from "./routes/leads.js";
import kycRoutes from "./routes/kyc.js";
import brochureRoutes from "./routes/brochure.js";
import agendaRoutes from "./routes/agenda.js";
import subscriptionRoutes from "./routes/subscriptions.js";
import campaignRoutes from "./routes/campaigns.js";
import trackingRoutes from "./routes/tracking.js";
import campaignAutomationRoutes from "./routes/campaignAutomation.js";
import promosRouter from "./routes/promos.js";
import nominationsRouter from "./routes/nominations.js";
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
import appApiRouter from "./routes/appApi.js";         // analytics, app texts, report/block, account deletion
import consoleRouter from "./routes/console.js";       // admin console API
import cmsRouter from "./routes/cms.js";               // edit Sanity speakers/partners from the admin panel
import filesRouter from "./routes/files.js";           // post photos + profile photos
import { killSwitchMiddleware, statusHandler } from "./services/killSwitch.js";
import path from "path";
import { fileURLToPath } from "url";

const app = express();

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
app.use("/api/auth", authRoutes);
app.use("/api/auth", ticketAuthRouter); // POST /ticket-login, /claim-ticket, /refresh
app.use("/api/payments", paymentRoutes);
app.use("/api/checkin", checkinRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/leads", leadsRoutes);
app.use("/api/kyc", kycRoutes);
app.use("/api/brochure", brochureRoutes);
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
app.use("/api/wallet", walletRouter);       // GET /api/wallet/pass/:ticketId
app.use("/api/app", appApiRouter);          // /events, /content, /report, /block, /account
app.use("/api/console", consoleRouter);     // admin console (staff only)
app.use("/api/files", filesRouter);         // GET /post/:id, /avatar/:id
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
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

/* ==========================================
   SERVER START
========================================== */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
