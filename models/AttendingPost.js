import mongoose from "mongoose";

/* A finished "I'm attending" image and post text, waiting while the
   person approves posting on LinkedIn (routes/attending.js). Deleted
   as soon as it's posted, and by MongoDB after 30 minutes if not.
   `trackEmail`: whose email link the page was opened from (its signed
   token checked when the draft was made), so the post is theirs in
   People; "" for a link without one. */
const attendingPostSchema = new mongoose.Schema({
  draftId: { type: String, required: true, unique: true },
  state: { type: String, default: "", index: true },
  png: { type: Buffer, required: true },
  text: { type: String, default: "" },
  trackEmail: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now, expires: 30 * 60 },
});

export default mongoose.model("AttendingPost", attendingPostSchema);
