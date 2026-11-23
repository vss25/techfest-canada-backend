import mongoose from "mongoose";

/* A draft LinkedIn post for one staff member's own profile (Nov 22 2026; rules in services/linkedinProfilePosts.js,
   routes in routes/linkedinProfilePosts.js). Only its owner sees, edits and posts it. MongoDB only. */

const sourceSchema = new mongoose.Schema({ url: String, title: String, supports: String }, { _id: false });

const linkedinProfileDraftSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  headline: { type: String, default: "" },
  topic: { type: String, default: "" },
  event: { key: String, name: String, city: String, when: String },
  body: { type: String, default: "" },               // what Claude wrote and the check passed (no sources, no hashtags)
  hashtags: { type: [String], default: [] },
  sources: { type: [sourceSchema], default: [] },
  check: { verdict: String, notes: String, at: Date },
  text: { type: String, default: "" },               // the post as it stands now (edited by its owner)
  generatedText: { type: String, default: "" },      // the post as first written
  edited: { type: Boolean, default: false },
  status: { type: String, enum: ["draft", "copied", "posted", "dismissed"], default: "draft", index: true },
  postedAt: Date, postUrl: { type: String, default: "" }, postedVia: { type: String, default: "" }, // "linkedin" | "by hand"
  copiedAt: Date,
  // Post to LinkedIn: a one-time key for the hop to LinkedIn, then the OAuth state (both short-lived).
  goKey: { type: String, default: undefined }, goExpiresAt: Date,
  state: { type: String, default: undefined }, stateExpiresAt: Date,
  returnTo: { type: String, default: "" },
  round: { type: Date },                              // which writing round made it
}, { timestamps: true });

linkedinProfileDraftSchema.index({ goKey: 1 }, { sparse: true });
linkedinProfileDraftSchema.index({ state: 1 }, { sparse: true });
linkedinProfileDraftSchema.index({ createdAt: -1 });

export default mongoose.models.LinkedinProfileDraft || mongoose.model("LinkedinProfileDraft", linkedinProfileDraftSchema);
