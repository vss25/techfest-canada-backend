import mongoose from "mongoose";

/* Help & SOS (Oct 22 2026, routes/sos.js): an attendee's urgent message to TTFC staff during the event, and the
   thread with staff's replies. `name`, `email` and `phone` are as they were when it was sent (staff can reach them
   even if the profile changes). status: open (sent) → acknowledged (seen by staff) → resolved. Never in the
   "What you missed" emails, never logged with its text. */
const { Schema, Types } = mongoose;

const messageSchema = new Schema({
  from: { type: String, enum: ["attendee", "staff"], required: true },
  staffId: { type: Types.ObjectId, ref: "User" },
  staffName: { type: String, default: "" },
  body: { type: String, required: true, maxlength: 1000 },
  at: { type: Date, default: Date.now },
}, { _id: false });

const sosRequestSchema = new Schema({
  userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
  name: { type: String, default: "" },
  email: { type: String, default: "" },
  phone: { type: String, default: "" },
  category: { type: String, enum: ["medical", "safety", "lost", "accessibility", "other"], required: true },
  location: { type: String, default: "" },
  message: { type: String, required: true, maxlength: 1000 },
  status: { type: String, enum: ["open", "acknowledged", "resolved"], default: "open", index: true },
  messages: { type: [messageSchema], default: [] },
  acknowledgedBy: { type: Types.ObjectId, ref: "User" },
  acknowledgedByName: { type: String, default: "" },
  acknowledgedAt: { type: Date },
  resolvedBy: { type: Types.ObjectId, ref: "User" },
  resolvedByName: { type: String, default: "" },
  resolvedAt: { type: Date },
  lastMessageAt: { type: Date },
}, { timestamps: true });
sosRequestSchema.index({ status: 1, createdAt: -1 });

export default mongoose.models.SosRequest || mongoose.model("SosRequest", sosRequestSchema);
