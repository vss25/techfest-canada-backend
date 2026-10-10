import mongoose from "mongoose";

/* One row per brochure download on the website (/brochures).
   Rows saved before Oct 2026 only have the form fields; the admin
   panel shows those as "not emailed". */
const brochureSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName:  { type: String, required: true },
  company:   { type: String },
  jobTitle:  { type: String },
  industry:  { type: String },
  email:     { type: String, required: true },
  phone:     { type: String },

  // Which brochure (key in services/brochureDownloads.js BROCHURES), and where they were
  brochure:  { type: String, default: "sponsorship" },
  page:      { type: String, default: "" },
  referrer:  { type: String, default: "" },
  userAgent: { type: String, default: "" },

  // sending → sent | failed; duplicate = already emailed this brochure in the last 10 minutes
  emailStatus:   { type: String, enum: ["sending", "sent", "failed", "duplicate", "blocked"] },
  delivery:      { type: String, default: "" }, // "attached" | "link"
  emailError:    { type: String, default: "" },
  emailedAt:     { type: Date },
  salesNotified: { type: Boolean, default: false },

  // Bot sign-up (services/brochureDownloads.js botReason): kept for review, never emailed, hidden in the admin list
  spam:          { type: Boolean },
  spamReason:    { type: String, default: "" },
}, { timestamps: true });

brochureSchema.index({ createdAt: -1 });
brochureSchema.index({ email: 1, brochure: 1, createdAt: -1 });

export default mongoose.models.Brochure || mongoose.model("Brochure", brochureSchema);
