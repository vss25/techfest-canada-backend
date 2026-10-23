import mongoose from "mongoose";

/* TTFC Check-in desk: every change, in order (services/checkinDeskLog.js). `seq` comes from one counter
   (CheckinCounter), so every server instance hands out numbers from the same sequence; devices keep a cursor (the
   last number they have with none missing before it) and catch up from it after a reconnect.
   kind: mark | undo | reset | note | inclusions | guest | query. `subject`: the pass's normalized ticket ID (or
   "booth:<booth>"); `marks`: the rows it changed, as they are after it (with their `rev`); `pass`: the ticket's
   pass-collected state after it; `clientId`: the device's id for the tap (unique: the same tap sent twice is done
   once). `clientAt`: when it was tapped on the device. Kept: it is the desk's log (who did what, where, when). */
const checkinEventSchema = new mongoose.Schema({
  seq: { type: Number, required: true, unique: true },
  kind: { type: String, required: true },
  point: { type: String, default: "" },
  subject: { type: String, default: "" },
  day: { type: String, default: "" },
  at: { type: Date, required: true },
  clientAt: { type: Date, default: null },
  station: { type: String, default: "" },
  byId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  byName: { type: String, default: "" },
  byRole: { type: String, default: "" },
  clientId: { type: String },
  ref: { type: String, default: "" },
  refPoint: { type: String, default: "" },
  override: { type: String, default: "" },
  note: { type: String, default: "" },
  marks: { type: [mongoose.Schema.Types.Mixed], default: undefined },
  pass: { type: mongoose.Schema.Types.Mixed, default: undefined },
  extras: { type: mongoose.Schema.Types.Mixed, default: undefined },
  extrasView: { type: mongoose.Schema.Types.Mixed, default: undefined },
  query: { type: mongoose.Schema.Types.Mixed, default: undefined },
}, { versionKey: false });
checkinEventSchema.index({ clientId: 1 }, { unique: true, partialFilterExpression: { clientId: { $type: "string" } } });
checkinEventSchema.index({ kind: 1, subject: 1, seq: 1 });

/* The one sequence: { _id: "events", seq }. */
const checkinCounterSchema = new mongoose.Schema({
  _id: { type: String },
  seq: { type: Number, default: 0 },
}, { versionKey: false });

export const CheckinCounter = mongoose.models.CheckinCounter || mongoose.model("CheckinCounter", checkinCounterSchema);
export default mongoose.models.CheckinEvent || mongoose.model("CheckinEvent", checkinEventSchema);
