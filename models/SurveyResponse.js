import mongoose from "mongoose";

/* The post-event survey's answers (Oct 26 2026, services/survey.js, routes/survey.js). One row per person: `key` is
   "u:<account id>" for someone the server knows by their account (the app's sign-in, or a personal link "u"), else
   "e:<email>" (a pass's personal link "p"; before it was by invitation, Oct 26 2026, also the email typed on the shared
   link: via "anonymous"). Answering again updates the
   row (count goes up, createdAt stays the first time). `answers` is { [questionId]: value } (rating / nps a number,
   choice a string, multi strings, text a string, consent true / false); a question deleted since keeps its answer
   here. source: "app" (an account: the app's sign-in or its personal link) | "link" (a pass's link); via: "auth" |
   "token" | "pass" (| "anonymous" on rows from before), how they were known. */
const surveyResponseSchema = new mongoose.Schema({
  key:          { type: String, required: true, unique: true },
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
  attendeeId:   { type: mongoose.Schema.Types.ObjectId, ref: "Attendee", default: null },
  source:       { type: String, enum: ["app", "link"], default: "link" },
  via:          { type: String, default: "" },
  name:         { type: String, default: "" },
  email:        { type: String, default: "", lowercase: true, trim: true, index: true },
  title:        { type: String, default: "" },
  company:      { type: String, default: "" },
  answers:      { type: mongoose.Schema.Types.Mixed, default: {} },
  submittedAt:  { type: Date, default: null },
  count:        { type: Number, default: 0 },
  userAgent:    { type: String, default: "" },
  ipHash:       { type: String, default: "" },
}, { timestamps: true, minimize: false });
surveyResponseSchema.index({ submittedAt: -1 });

export default mongoose.models.SurveyResponse || mongoose.model("SurveyResponse", surveyResponseSchema);
