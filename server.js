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
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
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

app.use(express.json());

/* ==========================================
   ROUTES
========================================== */

app.use("/api/auth", authRoutes);
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
app.use("/api", promosRouter);

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
