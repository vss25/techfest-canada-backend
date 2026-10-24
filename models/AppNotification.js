import mongoose from "mongoose";

const { Schema, Types } = mongoose;

/* A notification for one person in the apps' inbox:
   - "personal": staff sent it from the admin panel (Broadcast → "Send to a person");
   - "report": someone reported content; every staff account gets one
     (batchId "report:<Report _id>", link ttfc://moderation);
   - "conn": someone scanned their entry QR and is now connected with them
     (POST /api/social/connections/by-pass, Oct 24 2026): sentBy = the
     scanner, sentByName their name, batchId "conn:<SocialConnection _id>",
     link ttfc://tab/network. Left out for them while the scanner is hidden
     from the app or blocked either way (GET /api/social/notifications).
   The apps poll GET /api/social/notifications and show new ones as local
   notifications + in their in-app inbox (and get a push when it's configured).
   One document per recipient; everything sent in one go shares a batchId. */
const appNotificationSchema = new Schema({
  userId:     { type: Types.ObjectId, ref: "User", required: true, index: true },
  title:      { type: String, required: true, maxlength: 80 },
  body:       { type: String, required: true, maxlength: 500 },
  link:       { type: String, default: "" },          // ttfc://… or https://… (see services/notifyHelpers.js)
  kind:       { type: String, enum: ["personal", "report", "conn"], default: "personal" },
  batchId:    { type: String, default: "", index: true },
  sentBy:     { type: Types.ObjectId, ref: "User" },
  sentByName: { type: String, default: "" },
  readAt:     { type: Date, default: null },
}, { timestamps: true });
appNotificationSchema.index({ userId: 1, createdAt: -1 });
appNotificationSchema.index({ createdAt: -1 });

export default mongoose.model("AppNotification", appNotificationSchema);
