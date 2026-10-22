import mongoose from "mongoose";

/* When someone last opened a group chat (a people's group or a session chat): GET /api/community/groups/:id/messages
   (not ?peek=1) moves it forward. The "What you missed" emails (services/digest.js) count only messages after it. */
const groupSeenSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  groupId: { type: mongoose.Schema.Types.ObjectId, ref: "CommunityGroup", required: true },
  at: { type: Date, required: true },
}, { versionKey: false });
groupSeenSchema.index({ userId: 1, groupId: 1 }, { unique: true });

export default mongoose.models.GroupSeen || mongoose.model("GroupSeen", groupSeenSchema);
