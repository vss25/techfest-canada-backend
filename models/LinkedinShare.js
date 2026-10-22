import mongoose from "mongoose";

/* A post LinkedIn confirmed (Posts API) that someone made through our "Post to LinkedIn" (Oct 22 2026): their
   "I'm attending" post (kind "attending"), or a share of a session discussion or a poll (kind "discussion" | "poll",
   `itemKey` what was shared). Points (services/points.js linkedin.attending / linkedin.share) are counted from
   these, never from what an app reports. Shares through the share box or a link can't be confirmed: no row. */
const linkedinShareSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  kind: { type: String, enum: ["attending", "discussion", "poll"], required: true },
  itemKey: { type: String, default: "" },
  sessionId: { type: String, default: "" },
  postUrl: { type: String, default: "" },
}, { timestamps: { createdAt: true, updatedAt: false }, versionKey: false });
linkedinShareSchema.index({ userId: 1, kind: 1, itemKey: 1 });

export default mongoose.models.LinkedinShare || mongoose.model("LinkedinShare", linkedinShareSchema);
