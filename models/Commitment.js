import mongoose from "mongoose";

/* A tracked promise: what, who owns it, due when (services/commitments.js, routes/commitments.js).
   Called a task in the admin panel (Home › My work). Private: never sent to Sanity. */
const commitmentSchema = new mongoose.Schema({
  title: { type: String, required: true, maxlength: 200 },
  notes: { type: String, default: "", maxlength: 2000 },
  dueDate: { type: String, default: "" },            // "YYYY-MM-DD" (a whole day, Toronto) or "" for no date
  area: { type: String, default: "other" },          // partners | speakers | marketing | sales | vendors | other
  eventKey: { type: String, default: "" },
  about: { type: String, default: "", maxlength: 160 }, // the partner, speaker or vendor it concerns (free text for now)
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  ownerName: { type: String, default: "" },
  status: { type: String, enum: ["open", "done"], default: "open" },
  doneAt: { type: Date, default: null },
  doneByName: { type: String, default: "" },
  // "Raise a flag": something is wrong. Open until someone resolves it with a note.
  flag: {
    open: { type: Boolean, default: false },
    severity: { type: String, default: "" },         // blocked | at_risk
    note: { type: String, default: "" },
    raisedById: { type: mongoose.Schema.Types.ObjectId, default: null },
    raisedByName: { type: String, default: "" },
    raisedAt: { type: Date, default: null },
    resolvedByName: { type: String, default: "" },
    resolvedAt: { type: Date, default: null },
    resolution: { type: String, default: "" },
  },
  source: { type: String, default: "manual" },       // manual | flag (later: meeting, contract)
  createdById: { type: mongoose.Schema.Types.ObjectId, default: null },
  createdByName: { type: String, default: "" },
}, { timestamps: true, versionKey: false });

commitmentSchema.index({ status: 1, ownerId: 1, dueDate: 1 });
commitmentSchema.index({ "flag.open": 1 });

export default mongoose.models.Commitment || mongoose.model("Commitment", commitmentSchema);
