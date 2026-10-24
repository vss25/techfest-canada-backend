import mongoose from "mongoose";

/* TTFC Check-in desk: who is recording a tap, and whether it was undone (contract C2, services/checkinDeskActions.js).
   One row per undoable tap (a mark, a NO DETAILS FOUND arrival), `_id` = the tap's clientId. Only the request that
   holds a row in state "pending" writes that tap's marks, so the same tap sent twice at once (a retry after a timeout)
   is recorded by one request, and an undo is never lost to a race:
     waiting  undos arrived before the tap (`tombs`: who sent them); nothing recorded yet
     pending  a request (`owner`, since `claimedAt`) is recording it: an undo that may take it back turns it "undone",
              and that request takes back what it wrote when it finishes
     done     recorded (its CheckinEvent is stored)
     undone   undone (`undo`: by whom): never recorded, or taken back
   `byId` / `byRole` / `sentFromId`: the tap's author and the sign-in that sent it (whose undo may take it back). A
   "pending" row older than the lease is a request that died: a retry takes it over. Kept with the desk's log. */
const tombSchema = new mongoose.Schema({
  byId: { type: mongoose.Schema.Types.ObjectId, default: null },
  byName: { type: String, default: "" },
  byRole: { type: String, default: "" },
  // A volunteer's undo queued offline by someone else (contract C3): it only covers a tap sent from this sign-in.
  signedInId: { type: mongoose.Schema.Types.ObjectId, default: null },
  clientId: { type: String, default: "" },
  at: { type: Date, default: null },
}, { _id: false });

const checkinTapSchema = new mongoose.Schema({
  _id: { type: String },
  state: { type: String, required: true },
  kind: { type: String, default: "" },
  byId: { type: mongoose.Schema.Types.ObjectId, default: null },
  byRole: { type: String, default: "" },
  sentFromId: { type: mongoose.Schema.Types.ObjectId, default: null },
  owner: { type: String, default: null },
  claimedAt: { type: Date, default: null },
  tombs: { type: [tombSchema], default: [] },
  undo: { type: tombSchema, default: undefined },
}, { timestamps: true, versionKey: false });

export default mongoose.models.CheckinTap || mongoose.model("CheckinTap", checkinTapSchema);
