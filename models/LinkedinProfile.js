import mongoose from "mongoose";

/* One staff member's "LinkedIn posts for my profile" settings and their current writing round (Nov 22 2026;
   rules in services/linkedinProfilePosts.js). One row per staff account (`userId`). MongoDB only, never Sanity. */

const settingsSchema = new mongoose.Schema({
  displayName: String, role: String, about: String,
  voice: String, length: String,
  topics: [String], pillars: [String], sectors: [String],
  inviteWho: [String], inviteEvent: String,
  emoji: Boolean, hashtags: Number, sourcesInPost: Boolean,
  avoid: String, notes: String, spelling: String, count: Number,
}, { _id: false });

const linkedinProfileSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
  settings: { type: settingsSchema, default: () => ({}) },
  savedAt: { type: Date, default: null },          // null = never saved (the panel shows the defaults)
  // The writing round in progress or last finished: working | done | failed.
  run: {
    state: { type: String, enum: ["", "working", "done", "failed"], default: "" },
    startedAt: Date, finishedAt: Date,
    made: { type: Number, default: 0 },
    dropped: { type: [{ headline: String, why: String, _id: false }], default: [] },
    error: { type: String, default: "" },
    costUsd: { type: Number, default: 0 },
  },
  rounds: { day: { type: String, default: "" }, count: { type: Number, default: 0 } },  // rounds today (Toronto day)
}, { timestamps: true });

export default mongoose.models.LinkedinProfile || mongoose.model("LinkedinProfile", linkedinProfileSchema);
