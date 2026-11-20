import mongoose from "mongoose";

/* "We reached out to them about this event" (services/pastParticipants.js): one row per event and
   person or organisation. Private: MongoDB only. */
const schema = new mongoose.Schema({
  eventKey: { type: String, required: true },
  kind: { type: String, enum: ["person", "org"], required: true },
  key: { type: String, required: true },          // the People id, or the partner's record id
  name: { type: String, default: "" },
  role: { type: String, default: "" },
  status: { type: String, default: "contacted" }, // contacted | interested | not_now
  note: { type: String, default: "" },
  byId: { type: mongoose.Schema.Types.ObjectId, default: null },
  byName: { type: String, default: "" },
  at: { type: Date, default: Date.now },
}, { timestamps: true, versionKey: false });
schema.index({ eventKey: 1, kind: 1, key: 1 }, { unique: true });

export default mongoose.models.Outreach || mongoose.model("Outreach", schema);
