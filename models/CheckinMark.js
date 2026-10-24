import mongoose from "mongoose";

/* TTFC Check-in desk (services/checkinDesk.js): one row per pass (or booth), Toronto date and point.
   `subject` is the pass's ticket ID as normalizeTicketId gives it ("booth:<booth>" for a booth); `day` the Toronto
   date ("2026-10-26"), so each day starts empty; `point` what was recorded: arrived (lobby), checked_in (pass desk,
   or a QR scan at the door), cxo / lunch / evening (admitted), media, av, exhibitor, booth (set up), flag_cxo /
   flag_lunch / flag_evening (sent to staff).
   `at` null = not (or no longer) set: a row is never deleted, so its `rev` keeps counting up and devices can apply
   changes in any order (the newest rev wins). `ref` = the clientId of the tap that set it (undo checks it).
   `override`: "outside_window" when it was set outside the station's hours ("Admit anyway"). `passSetAt`: a check-in
   that also marked the ticket's pass collected (User.tickets[].checkedInAt / Attendee.checkedInAt), so undoing it
   can take that back. `practice`: set on a day that isn't Day 1 / Day 2 (contract C6: a rehearsal, never the
   ticket's pass collection). `queuedOffline`: tapped offline by `byId` / `byName`, sent later from `recordedById`'s
   sign-in (contract C3). `lateSync`: it reached the server more than a minute after the tap (contract C4); override
   "late_sync" = judged at its own time it was outside the station's hours and the device didn't ask for it. */
const checkinMarkSchema = new mongoose.Schema({
  subject: { type: String, required: true },
  day: { type: String, required: true },
  point: { type: String, required: true },
  at: { type: Date, default: null },
  byId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  byName: { type: String, default: "" },
  byRole: { type: String, default: "" },
  station: { type: String, default: "" },
  ref: { type: String, default: "" },
  override: { type: String, default: "" },
  note: { type: String, default: "" },
  item: { type: String, default: "" },
  passSetAt: { type: Date, default: null },
  practice: { type: Boolean, default: false },
  lateSync: { type: Boolean, default: false },
  queuedOffline: { type: Boolean, default: false },
  recordedById: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  recordedByName: { type: String, default: "" },
  rev: { type: Number, default: 0 },
}, { timestamps: true, versionKey: false });
checkinMarkSchema.index({ subject: 1, day: 1, point: 1 }, { unique: true });
checkinMarkSchema.index({ day: 1, point: 1 });

export default mongoose.models.CheckinMark || mongoose.model("CheckinMark", checkinMarkSchema);
