import mongoose from "mongoose";

/* One staff work session in the admin panel (Nov 24 2026, Settings › Staff activity, super admin only).
   A session starts at a password sign-in to the panel (via "sign-in") or when activity comes back after
   more than 15 idle minutes (via "resumed": the panel keeps its token for days, so most mornings start this
   way). It ends at sign-out (endReason "signout") or, once nothing has come in for 15 minutes, at its last
   activity (endReason "idle", closed lazily by the next activity or read as idle when lastSeenAt is old).
   activeSeconds only grows while the panel reports use (services/staffActivity.js): never more than two
   minutes per gap, so an open tab nobody touches adds nothing.
   Private: MongoDB only. Rows expire after 180 days (TTL on startedAt). */
export const STAFF_ACTIVITY_TTL_DAYS = 180;

const staffSessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  startedAt: { type: Date, required: true },
  lastSeenAt: { type: Date, required: true },
  endedAt: { type: Date, default: null },
  endReason: { type: String, enum: ["signout", "idle", null], default: null },
  via: { type: String, enum: ["sign-in", "resumed"], default: "resumed" },
  activeSeconds: { type: Number, default: 0 },
  pageViews: { type: Number, default: 0 },
  edits: { type: Number, default: 0 },
}, { versionKey: false });

staffSessionSchema.index({ userId: 1, endedAt: 1, lastSeenAt: -1 });
staffSessionSchema.index({ startedAt: 1 }, { expireAfterSeconds: STAFF_ACTIVITY_TTL_DAYS * 86400 });

export default mongoose.models.StaffSession || mongoose.model("StaffSession", staffSessionSchema);
