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
  body:        { type: String, default: "", maxlength: 4000 },   // may be empty on photo posts
  topicTags:   { type: [String], default: [] },
  linkUrl:     { type: String, default: "" },
  /** data:image/jpeg;base64,… — capped at ~350 KB by the route. */
  imageData:   { type: String, default: "" },
  /** Photos and ≤30 s videos on Cloudinary (services/cloudinary.js), in order. */
  media:       { type: [{ _id: false, type: { type: String, enum: ["image", "video"] }, url: String, publicId: String,
                          width: Number, height: Number, duration: Number }], default: [] },
  /** @mentions: { type: "user", id: <User _id> } or { type: "speaker", id: <Sanity id> }, ≤10. */
  mentions:    { type: [{ _id: false, type: { type: String, enum: ["user", "speaker"] }, id: String, name: String }], default: [] },
  likes:       { type: [Types.ObjectId], default: [] },
  /** Everyone who has ever liked it (kept on unlike) so only a first like makes an activity row. */
  everLiked:   { type: [Types.ObjectId], default: [] },
  likeCount:   { type: Number, default: 0 },
  commentCount:{ type: Number, default: 0 },
  status:      { type: String, enum: STATUS, default: "approved", index: true },
  /** Set when staff take the post down (status "hidden") with DELETE /api/social/feed/:id. */
  removedBy:   { type: Types.ObjectId, ref: "User" },
  removedAt:   { type: Date },
}, { timestamps: true });
socialPostSchema.index({ createdAt: -1 });

const socialCommentSchema = new Schema({
  postId:     { type: Types.ObjectId, ref: "SocialPost", required: true, index: true },
  authorId:   { type: Types.ObjectId, ref: "User", required: true },
  authorName: { type: String, required: true },
  authorTier: { type: String, default: "" },
  body:       { type: String, required: true, maxlength: 2000 },
  status:     { type: String, enum: STATUS, default: "approved" },
  /** @mentions, as on posts (Oct 22 2026): { type: "user" | "speaker", id, name }, ≤10. */
  mentions:   { type: [{ _id: false, type: { type: String, enum: ["user", "speaker"] }, id: String, name: String }], default: undefined },
}, { timestamps: true });
socialCommentSchema.index({ authorId: 1 });   // points (services/points.js)

const socialConnectionSchema = new Schema({
  fromUserId: { type: Types.ObjectId, ref: "User", required: true, index: true },
  toUserId:   { type: Types.ObjectId, ref: "User", required: true, index: true },
  status:     { type: String, enum: ["pending", "accepted", "declined"], default: "pending" },
  kind:       { type: String, enum: ["online", "inPerson"], default: "online" },
  note:       { type: String, default: "", maxlength: 300 },
  respondedAt: Date,
  /** Contact card item ids each side shares (services/contactCard.js), resolved live against
      that person's current items. Unset = that side never picked (defaults apply in person). */
  fromShare:   { type: [String], default: undefined },
  fromShareAt: Date,
  toShare:     { type: [String], default: undefined },
  toShareAt:   Date,
}, { timestamps: true });
socialConnectionSchema.index({ fromUserId: 1, toUserId: 1 }, { unique: true });

const socialMessageSchema = new Schema({
  threadKey:  { type: String, required: true, index: true },   // "<lowId>:<highId>"
  fromUserId: { type: Types.ObjectId, ref: "User", required: true },
  toUserId:   { type: Types.ObjectId, ref: "User", required: true, index: true },
  body:       { type: String, required: true, maxlength: 2000 },
  status:     { type: String, enum: STATUS, default: "approved" },
  // Read receipts (Oct 21 2026): deliveredAt = the recipient's app fetched it (chat list or the chat),
  // readAt = they opened the chat. Only approved messages get either (routes/social.js).
  deliveredAt: Date,
  readAt:     Date,
}, { timestamps: true });
socialMessageSchema.index({ threadKey: 1, createdAt: 1 });
// "Delivered" marking on every chat-list poll: { toUserId, deliveredAt: null } only walks what's still undelivered.
socialMessageSchema.index({ toUserId: 1, deliveredAt: 1 });

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
sessionQuestionSchema.index({ authorId: 1 });   // points

const sessionVoteSchema = new Schema({
  sessionId:   { type: String, required: true },
  pollId:      { type: String, required: true },
  userId:      { type: Types.ObjectId, ref: "User", required: true },
  optionIndex: { type: Number, required: true, min: 0, max: 15 },
}, { timestamps: true });
sessionVoteSchema.index({ sessionId: 1, pollId: 1, userId: 1 }, { unique: true });
sessionVoteSchema.index({ sessionId: 1, pollId: 1 });
sessionVoteSchema.index({ userId: 1 });   // points

export const SocialPost = mongoose.model("SocialPost", socialPostSchema);
export const SocialComment = mongoose.model("SocialComment", socialCommentSchema);
export const SocialConnection = mongoose.model("SocialConnection", socialConnectionSchema);
export const SocialMessage = mongoose.model("SocialMessage", socialMessageSchema);
export const SessionRegistration = mongoose.model("SessionRegistration", sessionRegistrationSchema);
export const SessionQuestion = mongoose.model("SessionQuestion", sessionQuestionSchema);
export const SessionVote = mongoose.model("SessionVote", sessionVoteSchema);
