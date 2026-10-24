import mongoose from "mongoose";

/* TTFC Check-in desk: every change, in order (services/checkinDeskLog.js). `seq` comes from one counter
   (CheckinCounter), so every server instance hands out numbers from the same sequence; devices keep a cursor (the
   last number they have with none missing before it) and catch up from it after a reconnect.
   kind: mark | undo | reset | note | inclusions | guest | query | unknown_arrival | unknown_done | unknown_link. `subject`: the pass's normalized ticket ID (or
   "booth:<booth>"); `marks`: the rows it changed, as they are after it (with their `rev`); `pass`: the ticket's
   pass-collected state after it; `clientId`: the device's id for the tap (unique: the same tap sent twice is done
   once). `clientAt`: when it was tapped on the device. Kept: it is the desk's log (who did what, where, when).
   kind "void": a number a failed write spent (nothing happened; readers needn't wait for it), or a tap that failed
   half-way (no subject; `marks` / `pass`: what it had written, taken back). An undo whose tap hasn't reached the
   server is a `tombstone` (ref = that tap's clientId): when the tap arrives it isn't applied; one stored while a
   request was recording the tap carries what it took back (`marks`, `pass`, subject, point) like any undo.
   `practice`: on a day that isn't Day 1 / Day 2 (never the ticket's pass collection). `queuedOffline`: tapped
   offline by `byId` / `byName`, sent later from `recordedById`'s sign-in. `lateSync`: reached the server more than a
   minute after it was tapped. `guest`: on guest / inclusions events, the guest's desk row after the change.
   NO DETAILS FOUND (contract C8): kind unknown_arrival (subject "u:<its clientId>": the lobby couldn't find the
   person; `name` / `company` / `note` as typed, `arrivedAt` = when it was tapped), unknown_done (`outcome`) and
   unknown_link (`guestKey`: staff found them on the list) on the same subject; an undo of the arrival too. */
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
  guest: { type: mongoose.Schema.Types.Mixed, default: undefined },
  tombstone: { type: Boolean, default: undefined },
  practice: { type: Boolean, default: undefined },
  lateSync: { type: Boolean, default: undefined },
  queuedOffline: { type: Boolean, default: undefined },
  recordedById: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: undefined },
  recordedByName: { type: String, default: undefined },
  name: { type: String, default: undefined },
  company: { type: String, default: undefined },
  arrivedAt: { type: Date, default: undefined },
  outcome: { type: String, default: undefined },
  guestKey: { type: String, default: undefined },
}, { versionKey: false });
checkinEventSchema.index({ clientId: 1 }, { unique: true, partialFilterExpression: { clientId: { $type: "string" } } });
checkinEventSchema.index({ kind: 1, subject: 1, seq: 1 });
checkinEventSchema.index({ kind: 1, seq: 1 });   // the guest generation (newest guest / inclusions event)
checkinEventSchema.index({ kind: 1, ref: 1 });   // undos (and tombstones) of a tap

/* The one sequence: { _id: "events", seq }. */
const checkinCounterSchema = new mongoose.Schema({
  _id: { type: String },
  seq: { type: Number, default: 0 },
}, { versionKey: false });

export const CheckinCounter = mongoose.models.CheckinCounter || mongoose.model("CheckinCounter", checkinCounterSchema);
export default mongoose.models.CheckinEvent || mongoose.model("CheckinEvent", checkinEventSchema);
