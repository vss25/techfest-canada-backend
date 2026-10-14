import mongoose from "mongoose";

/* A Catalyst Awards nomination (website form, services/nominations.js).
   Only the category and nominee name are required: nominations recovered
   from the emails sent before Oct 2026 can be missing other fields. */
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
nominationSchema.index({ resendId: 1 }, { unique: true, sparse: true });
 
export default mongoose.model("Nomination", nominationSchema);
