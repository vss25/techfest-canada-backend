import mongoose from "mongoose";

/* One "email me a jury sign-in code" request (routes/jury.js). Kept apart from
   SignInRequest (the apps' codes) so a jury code never signs anyone in to the apps
   and an app code never opens the jury portal. Only the code's hash is stored
   (bound to the email and the jury, services/juryAuth.js); Mongo deletes the row
   once expiresAt passes (TTL index). */
const jurySignInRequestSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, index: true },
    juror: { type: mongoose.Schema.Types.ObjectId, ref: "Juror", required: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    // pending → used | replaced (a newer code was sent) | locked (too many wrong codes)
    status: { type: String, enum: ["pending", "used", "replaced", "locked"], default: "pending" },
    usedAt: { type: Date },
    ip: { type: String, default: "" },
  },
  { timestamps: true }
);

jurySignInRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.JurySignInRequest || mongoose.model("JurySignInRequest", jurySignInRequestSchema);
