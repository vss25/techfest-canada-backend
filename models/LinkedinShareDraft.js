import mongoose from "mongoose";

/* A "Share on LinkedIn" from the apps (POST /api/app/linkedin/share), while the person edits it on the website
   (/share/linkedin?t=<token>) and approves posting on LinkedIn. `token` (in the link) and `state` (the OAuth state,
   also in a cookie) are random; the row goes away 2 hours after it was made (TTL) or once it's posted. */
const linkedinShareDraftSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  kind: { type: String, enum: ["discussion", "poll"], required: true },
  itemKey: { type: String, required: true },
  sessionId: { type: String, default: "" },
  sessionTitle: { type: String, default: "" },
  title: { type: String, default: "" },
  description: { type: String, default: "" },
  link: { type: String, default: "" },
  text: { type: String, default: "" },
  state: { type: String, default: "" },
  expiresAt: { type: Date, required: true },
}, { timestamps: true, versionKey: false });
linkedinShareDraftSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
linkedinShareDraftSchema.index({ state: 1 }, { sparse: true });

export default mongoose.models.LinkedinShareDraft || mongoose.model("LinkedinShareDraft", linkedinShareDraftSchema);
