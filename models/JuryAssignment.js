import mongoose from "mongoose";

/* One juror × one nomination (Catalyst Awards jury, Oct 2026): the allocation and
   that juror's assessment of it. services/jury.js has the rules.
     active      allocated now (false = unassigned by staff; the scores stay, they just don't count)
     conflict    the juror declared a conflict of interest: off their list, staff reassign it
     draft       work in progress (autosaved), never counted
     submission  the assessment that counts (the latest one submitted)
     editing     the juror reopened a submitted assessment: `draft` holds the changes,
                 `submission` still counts until they submit again
     history     every earlier submitted version, newest last (audit)
   Scores are stored by criterion key with the rubric version they were given on
   (models/JuryRubric.js), so changing the rubric never rewrites them. */
const scoreSet = {
  _id: false,
  scores: { type: Map, of: Number, default: undefined },
  recommendation: { type: String, default: "" },
  comment: { type: String, default: "" },
  rubricVersion: { type: Number, default: 0 },
};

const juryAssignmentSchema = new mongoose.Schema(
  {
    juror: { type: mongoose.Schema.Types.ObjectId, ref: "Juror", required: true },
    nomination: { type: mongoose.Schema.Types.ObjectId, ref: "Nomination", required: true },
    active: { type: Boolean, default: true },
    assignedBy: { type: String, default: "" },
    assignedAt: { type: Date, default: Date.now },
    unassignedBy: { type: String, default: "" },
    unassignedAt: { type: Date },
    conflict: {
      _id: false,
      at: { type: Date },
      reason: { type: String, default: "" },
      clearedAt: { type: Date },
      clearedBy: { type: String, default: "" },
    },
    draft: { ...scoreSet, savedAt: { type: Date } },
    submission: { ...scoreSet, submittedAt: { type: Date } },
    editing: { type: Boolean, default: false },
    history: {
      type: [{ ...scoreSet, submittedAt: Date, replacedAt: Date }],
      default: [],
    },
    lastSavedAt: { type: Date },
  },
  { timestamps: true }
);

juryAssignmentSchema.index({ juror: 1, nomination: 1 }, { unique: true });
juryAssignmentSchema.index({ nomination: 1, active: 1 });

export default mongoose.models.JuryAssignment || mongoose.model("JuryAssignment", juryAssignmentSchema);
