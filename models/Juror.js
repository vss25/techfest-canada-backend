import mongoose from "mongoose";

/* A Catalyst Awards juror (Oct 2026): their own account, separate from User.
   Jurors sign in only to the jury portal (thetechfestival.com/awards/jury-admin,
   routes/jury.js) with a password or an emailed 6-digit code. Their tokens are
   signed with the jury key and audience (services/juryAuth.js), so no other
   route accepts them, and a staff or app token is never a juror's.
   Management adds and removes jurors in Admin › Catalyst Awards › Jury
   (routes/juryAdmin.js). `removedAt`: taken off the jury (kept for the audit,
   their scores no longer count); `active` false: can't sign in, scores still count.
   `tokenVersion` goes up when the password changes, the juror is switched off or
   removed: every older session stops working. */
const jurorSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    organisation: { type: String, default: "", trim: true },
    title: { type: String, default: "", trim: true },
    active: { type: Boolean, default: true },
    passwordHash: { type: String, select: false },
    passwordSetAt: { type: Date },
    passwordSetBy: { type: String, default: "" }, // "juror" or the staff member who set it
    tokenVersion: { type: Number, default: 0 },
    invitedAt: { type: Date },
    inviteCount: { type: Number, default: 0 },
    remindedAt: { type: Date },
    reminderCount: { type: Number, default: 0 },
    lastSignInAt: { type: Date },
    lastActiveAt: { type: Date },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
    removedAt: { type: Date, default: null },
    removedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

jurorSchema.index({ removedAt: 1, name: 1 });

export default mongoose.models.Juror || mongoose.model("Juror", jurorSchema);
