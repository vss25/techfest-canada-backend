import mongoose from "mongoose";

/* A social media post planned in Marketing › Social posts (Nov 18 2026; rules in
   services/socialPosts.js). Not the app's feed posts (models/Social.js SocialPost). */

const versionSchema = new mongoose.Schema({ text: String, ai: Boolean, edited: Boolean, at: Date }, { _id: false });
const channelVersions = new mongoose.Schema({
  own: { type: Boolean, default: false },   // false = this channel posts the main text
  list: { type: [versionSchema], default: [] },
  chosen: { type: Number, default: 0 },
}, { _id: false });
const postedSchema = new mongoose.Schema({ at: Date, url: String, by: String }, { _id: false });

const marketingPostSchema = new mongoose.Schema({
  title: { type: String, default: "" },
  text: { type: String, default: "" },                       // the main post (LinkedIn)
  channels: { linkedin: { type: Boolean, default: true }, instagram: { type: Boolean, default: true }, x: { type: Boolean, default: true } },
  versions: { x: { type: channelVersions, default: () => ({}) }, instagram: { type: channelVersions, default: () => ({}) } },
  image: { url: String, alt: String },
  // Nov 23 2026: a templated post's own designed image per channel (Sanity image URLs); a channel without one
  // posts `image` cropped for it.
  images: { linkedin: { url: String, alt: String }, instagram: { url: String, alt: String }, x: { url: String, alt: String } },
  template: { type: String, default: "" },   // services/socialPosts.js POST_TEMPLATES key, "" = written by hand
  scheduledAt: { type: Date, default: null, index: true },
  timezone: { type: String, default: "America/Toronto" },
  eventKey: { type: String, default: "" }, eventName: { type: String, default: "" },
  source: { kind: String, id: String, label: String },
  contractRef: { contractId: String, key: String, label: String }, // a contract's promised post this fulfils
  review: {
    state: { type: String, enum: ["", "pending", "approved", "changes", "rejected"], default: "" },
    to: { type: [String], default: [] },                       // the approvers' names, as picked
    requestedBy: String, requestedAt: Date,
    by: String, at: Date, note: String,
  },
  posted: { linkedin: postedSchema, instagram: postedSchema, x: postedSchema },
  createdBy: { type: String, default: "" }, createdById: { type: String, default: "" },
  updatedBy: { type: String, default: "" },
}, { timestamps: true });

export default mongoose.models.MarketingPost || mongoose.model("MarketingPost", marketingPostSchema);
