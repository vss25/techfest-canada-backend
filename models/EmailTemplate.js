import mongoose from "mongoose";

/* Wording staff can change for an automated email, keyed by email
   (e.g. "speaker-pass": Admin → Speaker passes → Edit email).
   Empty fields mean "use the built-in text".
   The pass emails ("speaker-pass", "issued-pass", "exhibitor-pass", "purchase-email") keep
   every other piece of their wording in `fields` (services/passEmailCopy.js). */
const emailTemplateSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    subject: { type: String, default: "" },
    headline: { type: String, default: "" },
    message: { type: String, default: "" },
    cc: { type: [String], default: undefined }, // undefined = the default copy list
    // The pass emails' other fields: { preheader, greeting, includes: [[heading, detail]], …,
    // tiers: { power: { passName, includes, … } } } (services/passEmailCopy.js). Unset = built-in.
    fields: { type: mongoose.Schema.Types.Mixed, default: undefined },
    // Structured wording for documents (e.g. "exhibitor-manual": the Exhibitor Manual PDF's text).
    content: { type: mongoose.Schema.Types.Mixed, default: undefined },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

export default mongoose.models.EmailTemplate || mongoose.model("EmailTemplate", emailTemplateSchema);
