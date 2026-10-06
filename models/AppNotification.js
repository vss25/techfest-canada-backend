import mongoose from "mongoose";

const { Schema, Types } = mongoose;

/* A notification staff sent to one person from the admin panel
   (Broadcast → "Send to a person"). There's no APNs/FCM push yet: the apps
   poll GET /api/social/notifications and show new ones as local
   notifications + in their in-app inbox. One document per recipient;
   everything sent in one go shares a batchId. */
const appNotificationSchema = new Schema({
  userId:     { type: Types.ObjectId, ref: "User", required: true, index: true },
  title:      { type: String, required: true, maxlength: 80 },
  body:       { type: String, required: true, maxlength: 500 },
  link:       { type: String, default: "" },          // ttfc://… or https://… (see services/notifyHelpers.js)
  kind:       { type: String, enum: ["personal"], default: "personal" },
  batchId:    { type: String, default: "", index: true },
  sentBy:     { type: Types.ObjectId, ref: "User" },
  sentByName: { type: String, default: "" },
  readAt:     { type: Date, default: null },
}, { timestamps: true });
appNotificationSchema.index({ userId: 1, createdAt: -1 });
appNotificationSchema.index({ createdAt: -1 });

export default mongoose.model("AppNotification", appNotificationSchema);
