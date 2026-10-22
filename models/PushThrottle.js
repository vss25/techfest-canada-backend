import mongoose from "mongoose";

/* One row per (what, person) for pushes that mustn't come too often (services/pushThrottle.js), so several
   servers agree: `_id` "<scope>:<id>:<userId>" (e.g. "group:<groupId>:<userId>", "like:<postId>:<authorId>"),
   `until` the end of the quiet window that started with the last push, `missed` what happened since (folded
   into the next push: "5 new messages in …"). Rows go away by themselves a day after the window (TTL). */
const pushThrottleSchema = new mongoose.Schema({
  _id: { type: String },
  until: { type: Date, required: true },
  missed: { type: Number, default: 0 },
  expireAt: { type: Date, required: true },
}, { versionKey: false });
pushThrottleSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.PushThrottle || mongoose.model("PushThrottle", pushThrottleSchema);
