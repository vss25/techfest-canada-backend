import mongoose from "mongoose";
import { STAFF_ACTIVITY_TTL_DAYS } from "./StaffSession.js";

/* One staff member's admin-panel use in one clock hour (UTC hour start): pages opened, records changed
   (successful POST / PUT / PATCH / DELETE through a requireAdmin route, from a browser) and active seconds.
   Upserted with $inc by services/staffActivity.js, so it's one small row per person per hour they work.
   Private: MongoDB only. Rows expire after 180 days (TTL on hour). */
const staffActivityHourSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  hour: { type: Date, required: true },
  pageViews: { type: Number, default: 0 },
  edits: { type: Number, default: 0 },
  activeSeconds: { type: Number, default: 0 },
}, { versionKey: false });

staffActivityHourSchema.index({ userId: 1, hour: 1 }, { unique: true });
staffActivityHourSchema.index({ hour: 1 }, { expireAfterSeconds: STAFF_ACTIVITY_TTL_DAYS * 86400 });

export default mongoose.models.StaffActivityHour || mongoose.model("StaffActivityHour", staffActivityHourSchema);
