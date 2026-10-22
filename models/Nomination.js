import mongoose from "mongoose";

/* A Catalyst Awards nomination (website form, services/nominations.js).
   Only the category and nominee name are required: nominations recovered
   from the emails sent before Oct 2026 can be missing other fields. */
// What the nominator submitted (category + the nominee's focus), kept when staff change them.
const submittedSchema = new mongoose.Schema({
  categoryType: { type: String, default: "" },
  pillar: { type: String, default: "" },
  sector: { type: String, default: "" },
  specialAward: { type: String, default: "" },
  nomineeSector: { type: String, default: "" },
  nomineePillar: { type: String, default: "" },
}, { _id: false });

const nominationSchema = new mongoose.Schema({
  // ═════ SECTION 1 — Award Category ═════
  categoryType: { type: String, enum: ["matrix", "special"], required: true },
  pillar: { type: String, default: "" },
  sector: { type: String, default: "" },
  specialAward: { type: String, enum: ["", "lifetime", "rising", "crossborder"], default: "" },
 
  // ═════ SECTION 2 — Nominee ═════
  nomineeType: { type: String, enum: ["Individual", "Organisation", "Team / Project"], default: "Individual" },
  nomineeName: { type: String, required: true, trim: true },
  nomineeTitle: { type: String, default: "" },
  nomineeOrganisation: { type: String, trim: true },
  nomineeSector: { type: String, default: "" },
  // The startup's focus pillar (staff set it in the admin panel; the form doesn't ask). "" = none.
  nomineePillar: { type: String, default: "" },
  nomineeLocation: { type: String, trim: true },
  nomineeWebsite: { type: String, default: "" },
  nomineeLinkedIn: { type: String, default: "" },
  nomineeEmail: { type: String, trim: true, lowercase: true },
  nomineePhone: { type: String, default: "" },
 
  // ═════ SECTION 3 — Nominator ═════
  selfNomination: { type: Boolean, default: false },
  nominatorName: { type: String, trim: true },
  nominatorTitle: { type: String, default: "" },
  nominatorOrganisation: { type: String, trim: true },
  nominatorRelationship: { type: String, trim: true },
  nominatorEmail: { type: String, trim: true, lowercase: true },
  nominatorPhone: { type: String, default: "" },
 
  // ═════ SECTION 4 — Statement ═════
  statementOverview: { type: String },
  statementImpact: { type: String },
  statementAchievements: { type: String },
  statementEvidence: { type: String, default: "" },
 
  // ═════ SECTION 5 — Declaration ═════
  declaration1: { type: Boolean },
  declaration2: { type: Boolean },
  declaration3: { type: Boolean },
  declaration4: { type: Boolean },
  signatureName: { type: String, trim: true },
 
  // ═════ ADMIN STATUS ═════
  status: {
    type: String,
    enum: ["pending", "shortlisted", "winner", "rejected"],
    default: "pending",
    index: true,
  },
  adminNotes: { type: String, default: "" },
  /* Category and focus changed by staff (Admin → Catalyst Awards → Nominations, "Edit category & focus";
     services/nominations.js). The live fields above are what everything reads (jury, results, award counts,
     CSV, filters); `submitted` keeps what came in, copied once, at the first change. */
  submitted: { type: submittedSchema, default: undefined },
  categoryChangedBy: { type: String, default: "" },
  categoryChangedAt: { type: Date, default: null },
  categoryNote: { type: String, default: "" },
  focusChangedBy: { type: String, default: "" },
  focusChangedAt: { type: Date, default: null },
  focusNote: { type: String, default: "" },
  statusChangedAt: { type: Date, default: null },
  updatedBy: { type: String, default: "" },
  submittedAt: { type: Date, default: Date.now },
  // "website" (saved by POST /api/nominations) or "email" (recovered from the email service's log).
  source: { type: String, enum: ["website", "email"], default: "website" },
  // The Resend id of the "[Catalyst Nomination]" email to staff: a recovered email is never imported twice.
  resendId: { type: String, default: undefined },
}, { timestamps: true });
 
// Helpful compound index for admin queries
nominationSchema.index({ status: 1, createdAt: -1 });
nominationSchema.index({ nomineeEmail: 1 });
// Admin search: a nominator's email, exactly (services/adminSearchSources.js).
nominationSchema.index({ nominatorEmail: 1 });
nominationSchema.index({ resendId: 1 }, { unique: true, sparse: true });
 
export default mongoose.model("Nomination", nominationSchema);
