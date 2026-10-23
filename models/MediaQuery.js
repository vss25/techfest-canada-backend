import mongoose from "mongoose";

/* TTFC Check-in desk › Media desk: the queue of media queries (the organiser's "media query queue"). Who asked
   (`who`, or a media guest's pass as `subject`), their outlet, what they asked for ("interview with …", "press kit",
   "photo pit access"), status new → in_progress → done, and who on the team has it. Anyone on the desk app adds one;
   staff reassign and close. `clientId`: the device's id for the add (the same tap sent twice adds one). */
const mediaQuerySchema = new mongoose.Schema({
  who: { type: String, default: "" },
  outlet: { type: String, default: "" },
  request: { type: String, required: true },
  subject: { type: String, default: "" },
  status: { type: String, enum: ["new", "in_progress", "done"], default: "new" },
  assigneeId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  assigneeName: { type: String, default: "" },
  createdById: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  createdByName: { type: String, default: "" },
  clientId: { type: String, required: true, unique: true },
  doneAt: { type: Date, default: null },
  rev: { type: Number, default: 0 },
}, { timestamps: true, versionKey: false });
mediaQuerySchema.index({ status: 1, createdAt: -1 });

export default mongoose.models.MediaQuery || mongoose.model("MediaQuery", mediaQuerySchema);
