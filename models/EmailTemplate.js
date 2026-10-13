import mongoose from "mongoose";

/* Wording staff can change for an automated email, keyed by email
   (e.g. "speaker-pass": Admin → Speaker passes → Edit email).
   Empty fields mean "use the built-in text". */
const emailTemplateSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    subject: { type: String, default: "" },
    headline: { type: String, default: "" },
    message: { type: String, default: "" },
    cc: { type: [String], default: undefined }, // undefined = the default copy list
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

export default mongoose.models.EmailTemplate || mongoose.model("EmailTemplate", emailTemplateSchema);
