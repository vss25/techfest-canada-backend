import mongoose from "mongoose";

const { Schema, Types } = mongoose;

/* Every tracked action from the iOS app: screen views, taps, searches,
   interests. Kept 400 days, then removed automatically. */
const appEventSchema = new Schema({
  userId:     { type: Types.ObjectId, ref: "User", index: true },
  deviceId:   { type: String, default: "", index: true },
  name:       { type: String, required: true, index: true },   // "screen_view", "tap", "search", …
  screen:     { type: String, default: "" },
  target:     { type: String, default: "" },                   // button / item the person used
  props:      { type: Schema.Types.Mixed, default: {} },
  appVersion: { type: String, default: "" },
  platform:   { type: String, default: "ios" },
  at:         { type: Date, default: Date.now },
});
appEventSchema.index({ userId: 1, at: -1 });
appEventSchema.index({ at: 1 }, { expireAfterSeconds: 400 * 24 * 3600 });

/* Text and switches the admin console can change in the app without a release. */
const appContentSchema = new Schema({
  key:       { type: String, required: true, unique: true },
  value:     { type: Schema.Types.Mixed, default: "" },
  updatedBy: { type: String, default: "" },
}, { timestamps: true });

/* Who in staff looked at or changed what — required when admins can read messages. */
const adminAuditSchema = new Schema({
  adminId:    { type: Types.ObjectId, ref: "User" },
  adminName:  { type: String, default: "" },
  action:     { type: String, required: true },     // "view_messages", "edit_user", "ban_user", …
  targetType: { type: String, default: "" },
  targetId:   { type: String, default: "" },
  detail:     { type: String, default: "" },
  at:         { type: Date, default: Date.now, index: true },
});

/* Apple guideline 1.2: users can report content and block people. */
const reportSchema = new Schema({
  reporterId:   { type: Types.ObjectId, ref: "User", required: true },
  reporterName: { type: String, default: "" },
  targetType:   { type: String, required: true },   // post | comment | message | discussion | reply | group | groupMessage | user
  targetId:     { type: String, required: true },
  reason:       { type: String, default: "", maxlength: 500 },
  status:       { type: String, enum: ["open", "resolved", "dismissed"], default: "open", index: true },
  resolvedBy:   { type: String, default: "" },
}, { timestamps: true });

const blockSchema = new Schema({
  userId:    { type: Types.ObjectId, ref: "User", required: true, index: true },
  blockedId: { type: Types.ObjectId, ref: "User", required: true },
}, { timestamps: true });
blockSchema.index({ userId: 1, blockedId: 1 }, { unique: true });

export const AppEvent = mongoose.model("AppEvent", appEventSchema);
export const AppContent = mongoose.model("AppContent", appContentSchema);
export const AdminAudit = mongoose.model("AdminAudit", adminAuditSchema);
export const Report = mongoose.model("Report", reportSchema);
export const Block = mongoose.model("Block", blockSchema);
