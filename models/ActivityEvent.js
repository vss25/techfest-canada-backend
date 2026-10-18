import mongoose from "mongoose";

const { Schema, Types } = mongoose;

/* Personal activity: someone liked or commented on your post, mentioned you
   in one, or replied in a discussion you follow. No AppNotification: the
   apps poll GET /api/social/activity/unread and show a dot on the Feed or
   Discussions tab until the person opens it (POST /activity/seen). Discussion
   replies also push (throttled, routes/community.js); the rest don't.
   Rules for who gets a row are in services/socialActivity.js (buildActivity)
   and, for discussion followers, services/discussionFollow.js. */
const activityEventSchema = new Schema({
  userId:    { type: Types.ObjectId, ref: "User", required: true },   // recipient
  actorId:   { type: Types.ObjectId, ref: "User", required: true },
  actorName: { type: String, default: "" },
  kind:      { type: String, enum: ["like", "comment", "mention", "reply"], required: true },
  section:   { type: String, enum: ["feed", "discussions"], required: true },
  refId:     { type: Types.ObjectId, required: true },                // SocialPost or Discussion id
}, { timestamps: { createdAt: true, updatedAt: false } });
activityEventSchema.index({ userId: 1, section: 1, createdAt: -1 });
activityEventSchema.index({ refId: 1 });

const ActivityEvent = mongoose.model("ActivityEvent", activityEventSchema);
export default ActivityEvent;

/** Saves activity rows (from buildActivity) in the background; never throws. */
export function recordActivity(rows) {
  if (!rows?.length) return;
  ActivityEvent.insertMany(rows, { ordered: false }).catch((err) => console.error("ACTIVITY SAVE ERROR:", err?.message || err));
}
