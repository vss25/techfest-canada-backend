import mongoose from "mongoose";

/* The Catalyst Awards scoring rubric, one row per version (Oct 2026). A save in
   Admin › Catalyst Awards › Scoring rubric that changes anything adds a new
   version; earlier versions stay as they were, and every score records the
   version it was given on (models/JuryAssignment.js). No row = the built-in
   rubric (services/jury.js DEFAULT_CRITERIA), version 1. Criterion keys never
   change once made, so renaming a criterion keeps its scores. */
const criterionSchema = new mongoose.Schema({
  key: { type: String, required: true },
  label: { type: String, required: true },
  help: { type: String, default: "" },
  weight: { type: Number, default: 1 },
  anchors: {
    _id: false,
    1: { type: String, default: "" },
    3: { type: String, default: "" },
    5: { type: String, default: "" },
  },
}, { _id: false });

const juryRubricSchema = new mongoose.Schema(
  {
    version: { type: Number, required: true, unique: true },
    criteria: { type: [criterionSchema], default: [] },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true }
);

export default mongoose.models.JuryRubric || mongoose.model("JuryRubric", juryRubricSchema);
