import mongoose from "mongoose";
import { AUDIENCES } from "../services/scheduledBroadcastRules.js";

const { Schema, Types } = mongoose;

/* A message management schedules for later (Oct 27 2026, services/scheduledBroadcasts.js): at `sendAt` the minute job
   sends it once, on the channels that are on:
     feedPost  an official announcement post, like POST /api/console/broadcast (kind "announcement", with linkUrl);
     banner    the Home banner (AppContent home.announcement = body, first 280 characters; home.announcement_link =
               linkUrl, or "" when there is none);
     notify    an inbox row (AppNotification kind "personal", batchId "sched:<_id>") for each recipient + a push.
   audience (notify only): "app" = everyone signed into the app (POST /console/notify's rule), "checkedIn" = those of
   them with a door check-in on Day 1 or Day 2, "outdated" = those on an older iOS / Android app than the newest
   version in the "App updates" keys (app.ios_latest / app.android_latest).
   status: scheduled → sending (claimed by one server, atomically) → sent | failed; scheduled → cancelled (management)
   or missed (the job found it more than 2 hours late: the server was down; never sent late). Never deleted. */
export const STATUSES = Object.freeze(["scheduled", "sending", "sent", "cancelled", "failed", "missed"]);

const scheduledBroadcastSchema = new Schema({
  sendAt:        { type: Date, required: true },
  title:         { type: String, default: "", maxlength: 80 },     // required when notify (checked by the rules)
  body:          { type: String, required: true, maxlength: 500 },
  linkUrl:       { type: String, default: "" },                     // "" | ttfc://… | https://… (services/notifyHelpers.js cleanLink)
  feedPost:      { type: Boolean, default: false },
  banner:        { type: Boolean, default: false },
  notify:        { type: Boolean, default: false },
  audience:      { type: String, enum: AUDIENCES, default: "app" },
  status:        { type: String, enum: STATUSES, default: "scheduled" },
  sentAt:        { type: Date, default: null },
  recipients:    { type: Number, default: 0 },                       // inbox rows written (0 without notify)
  postId:        { type: Types.ObjectId, ref: "SocialPost", default: null },
  batchId:       { type: String, default: "" },                      // "sched:<_id>" (the AppNotification rows')
  error:         { type: String, default: "" },
  claimedAt:     { type: Date, default: null },                      // when a server took it (status sending)
  claimedBy:     { type: String, default: "" },                      // which process (logs only)
  createdBy:     { type: Types.ObjectId, ref: "User", required: true },   // the feed post's authorId and the rows' sentBy
  createdByName: { type: String, default: "" },
  updatedByName: { type: String, default: "" },
}, { timestamps: true });
scheduledBroadcastSchema.index({ status: 1, sendAt: 1 });
scheduledBroadcastSchema.index({ sendAt: -1 });

export default mongoose.models.ScheduledBroadcast || mongoose.model("ScheduledBroadcast", scheduledBroadcastSchema);
