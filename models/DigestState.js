import mongoose from "mongoose";

/* The "What you missed" emails (services/digest.js), one row per person (`_id` = their user id):
   pendingSince  the oldest missed item not emailed yet (unset = nothing waiting); the 3-hour digest is due 3 h after
   emailedUntil  everything up to here has been in a digest (each item is emailed at most once)
   lastSentAt    the last digest (never two within 60 minutes)
   sentDay / sentToday  the Toronto day ("YYYY-MM-DD") and how many digests went that day (at most 3) */
const digestStateSchema = new mongoose.Schema({
  _id: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  pendingSince: { type: Date },
  emailedUntil: { type: Date },
  lastSentAt: { type: Date },
  sentDay: { type: String, default: "" },
  sentToday: { type: Number, default: 0 },
}, { versionKey: false, timestamps: { createdAt: false, updatedAt: true } });
digestStateSchema.index({ pendingSince: 1 }, { sparse: true });

export default mongoose.models.DigestState || mongoose.model("DigestState", digestStateSchema);
