import mongoose from "mongoose";

/* =========================================================
   Social layer for the iOS app: feed, comments, connections,
   messages, session registrations, audience Q&A and polls.
   Everything user-authored carries a moderation `status`:
     approved | held (moderation flagged, visible to author only) | hidden (staff)
========================================================= */

const { Schema, Types } = mongoose;
const STATUS = ["approved", "held", "hidden"];

const socialPostSchema = new Schema({
  authorId:    { type: Types.ObjectId, ref: "User", required: true, index: true },
  authorName:  { type: String, required: true },
  authorTitle: { type: String, default: "" },
  authorOrg:   { type: String, default: "" },
  authorTier:  { type: String, default: "" },
  kind:        { type: String, enum: ["member", "speaker", "announcement"], default: "member" },
  body:        { type: String, required: true, maxlength: 4000 },
  topicTags:   { type: [String], default: [] },
  linkUrl:     { type: String, default: "" },
  /** data:image/jpeg;base64,… — capped at ~350 KB by the route. */
  imageData:   { type: String, default: "" },
  likes:       { type: [Types.ObjectId], default: [] },
  likeCount:   { type: Number, default: 0 },
  commentCount:{ type: Number, default: 0 },
  status:      { type: String, enum: STATUS, default: "approved", index: true },
}, { timestamps: true });
socialPostSchema.index({ createdAt: -1 });

const socialCommentSchema = new Schema({
  postId:     { type: Types.ObjectId, ref: "SocialPost", required: true, index: true },
  authorId:   { type: Types.ObjectId, ref: "User", required: true },
  authorName: { type: String, required: true },
  authorTier: { type: String, default: "" },
  body:       { type: String, required: true, maxlength: 2000 },
  status:     { type: String, enum: STATUS, default: "approved" },
}, { timestamps: true });

const socialConnectionSchema = new Schema({
  fromUserId: { type: Types.ObjectId, ref: "User", required: true, index: true },
  toUserId:   { type: Types.ObjectId, ref: "User", required: true, index: true },
  status:     { type: String, enum: ["pending", "accepted", "declined"], default: "pending" },
  kind:       { type: String, enum: ["online", "inPerson"], default: "online" },
  note:       { type: String, default: "", maxlength: 300 },
  respondedAt: Date,
}, { timestamps: true });
socialConnectionSchema.index({ fromUserId: 1, toUserId: 1 }, { unique: true });

const socialMessageSchema = new Schema({
  threadKey:  { type: String, required: true, index: true },   // "<lowId>:<highId>"
  fromUserId: { type: Types.ObjectId, ref: "User", required: true },
  toUserId:   { type: Types.ObjectId, ref: "User", required: true, index: true },
  body:       { type: String, required: true, maxlength: 2000 },
  status:     { type: String, enum: STATUS, default: "approved" },
  readAt:     Date,
}, { timestamps: true });
socialMessageSchema.index({ threadKey: 1, createdAt: 1 });

const sessionRegistrationSchema = new Schema({
  userId:    { type: Types.ObjectId, ref: "User", required: true },
  sessionId: { type: String, required: true, index: true },
}, { timestamps: true });
sessionRegistrationSchema.index({ userId: 1, sessionId: 1 }, { unique: true });

const sessionQuestionSchema = new Schema({
  sessionId:  { type: String, required: true, index: true },
  authorId:   { type: Types.ObjectId, ref: "User", required: true },
  authorName: { type: String, required: true },
  body:       { type: String, required: true, maxlength: 600 },
  upvotes:    { type: [Types.ObjectId], default: [] },
  status:     { type: String, enum: STATUS, default: "approved" },
}, { timestamps: true });

const sessionVoteSchema = new Schema({
  sessionId:   { type: String, required: true },
  pollId:      { type: String, required: true },
  userId:      { type: Types.ObjectId, ref: "User", required: true },
  optionIndex: { type: Number, required: true, min: 0, max: 15 },
}, { timestamps: true });
sessionVoteSchema.index({ sessionId: 1, pollId: 1, userId: 1 }, { unique: true });
sessionVoteSchema.index({ sessionId: 1, pollId: 1 });

export const SocialPost = mongoose.model("SocialPost", socialPostSchema);
export const SocialComment = mongoose.model("SocialComment", socialCommentSchema);
export const SocialConnection = mongoose.model("SocialConnection", socialConnectionSchema);
export const SocialMessage = mongoose.model("SocialMessage", socialMessageSchema);
export const SessionRegistration = mongoose.model("SessionRegistration", sessionRegistrationSchema);
export const SessionQuestion = mongoose.model("SessionQuestion", sessionQuestionSchema);
export const SessionVote = mongoose.model("SessionVote", sessionVoteSchema);
