import mongoose from "mongoose";

/* =========================================================
   Community layer for the iOS app: discussions with threaded
   replies, interest groups with members and group chat.
   Same moderation statuses as models/Social.js.
========================================================= */

const { Schema, Types } = mongoose;
const STATUS = ["approved", "held", "hidden", "pending"];

const discussionSchema = new Schema({
  authorId:   { type: Types.ObjectId, ref: "User", required: true },
  authorName: { type: String, required: true },
  title:      { type: String, required: true, maxlength: 200 },
  body:       { type: String, required: true, maxlength: 4000 },
  tags:       { type: [String], default: [] },
  replyCount: { type: Number, default: 0 },
  status:     { type: String, enum: STATUS, default: "pending", index: true },   // new threads go to review
  // Who hears about new replies (activity dot + push). The author is added on
  // create, repliers on their first reply. No default on purpose: threads from
  // before following existed have no list, and their author counts as the one
  // follower until it's written out (services/discussionFollow.js).
  followers:  { type: [Types.ObjectId], default: undefined, index: true },
  // People who unfollowed: replying again doesn't re-follow them.
  unfollowed: { type: [Types.ObjectId], default: undefined },
}, { timestamps: true });

const discussionReplySchema = new Schema({
  discussionId: { type: Types.ObjectId, ref: "Discussion", required: true, index: true },
  parentId:     { type: Types.ObjectId, ref: "DiscussionReply", default: null },  // reply-to-reply
  authorId:     { type: Types.ObjectId, ref: "User", required: true },
  authorName:   { type: String, required: true },
  body:         { type: String, required: true, maxlength: 2000 },
  status:       { type: String, enum: STATUS, default: "approved" },
}, { timestamps: true });

const groupSchema = new Schema({
  name:        { type: String, required: true, maxlength: 80 },
  description: { type: String, default: "", maxlength: 500 },
  tags:        { type: [String], default: [] },
  ownerId:     { type: Types.ObjectId, ref: "User", required: true },
  ownerName:   { type: String, required: true },
  members:     { type: [Types.ObjectId], default: [], index: true },
  status:      { type: String, enum: STATUS, default: "pending", index: true },   // new groups go to review
  // Session chats (Oct 21 2026, services/sessionGroups.js): made by the server 30 min before an agenda session,
  // one per session (the unique index below), owned by the system (ownerId SYSTEM_ID). Unset on people's groups.
  sessionId:       { type: String },          // the id the apps use for the session (Sanity sessionId, else _id)
  sessionDocId:    { type: String },          // the Sanity _id (registrations may carry either)
  sessionStartsAt: { type: Date },
  sessionEndsAt:   { type: Date },
  system:          { type: Boolean },
  welcomePostedAt: { type: Date },            // the one welcome message was posted (claimed before posting)
  // People who left a session chat themselves: never added back automatically (registering again does).
  leftBy:          { type: [Types.ObjectId], default: undefined },
}, { timestamps: true });
groupSchema.index({ sessionId: 1 }, { unique: true, partialFilterExpression: { sessionId: { $type: "string" } } });
groupSchema.index({ sessionDocId: 1 }, { partialFilterExpression: { sessionDocId: { $type: "string" } } });

const groupMessageSchema = new Schema({
  groupId:    { type: Types.ObjectId, ref: "CommunityGroup", required: true, index: true },
  authorId:   { type: Types.ObjectId, ref: "User", required: true },
  authorName: { type: String, required: true },
  body:       { type: String, required: true, maxlength: 2000 },
  status:     { type: String, enum: STATUS, default: "approved" },
}, { timestamps: true });
groupMessageSchema.index({ groupId: 1, createdAt: 1 });

export const Discussion = mongoose.model("Discussion", discussionSchema);
export const DiscussionReply = mongoose.model("DiscussionReply", discussionReplySchema);
export const CommunityGroup = mongoose.model("CommunityGroup", groupSchema);
export const GroupMessage = mongoose.model("GroupMessage", groupMessageSchema);
