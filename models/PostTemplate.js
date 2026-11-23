import mongoose from "mongoose";

/* A post template staff uploaded (Nov 23 2026; rules in services/postTemplateLibrary.js): the blank artwork per
   channel (Sanity image URLs: public marketing art) and the boxes where the post's words, photos and logos go.
   Mixed-typed `channels` because the boxes are validated by cleanTemplate before every save. */
const postTemplateSchema = new mongoose.Schema({
  name: { type: String, required: true },
  kind: { type: String, enum: ["keynote", "session", "partner", "event"], required: true },
  status: { type: String, enum: ["draft", "ready"], default: "draft", index: true },
  channels: { type: mongoose.Schema.Types.Mixed, default: () => ({ linkedin: null, x: null, instagram: null }) },
  notes: { type: String, default: "" },
  createdBy: { type: String, default: "" }, updatedBy: { type: String, default: "" },
}, { timestamps: true, minimize: false });

export default mongoose.models.PostTemplate || mongoose.model("PostTemplate", postTemplateSchema);
