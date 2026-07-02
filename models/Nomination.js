import mongoose from "mongoose";
 
const nominationSchema = new mongoose.Schema({
  // ═════ SECTION 1 — Award Category ═════
  categoryType: { type: String, enum: ["matrix", "special"], required: true },
  pillar: { type: String, default: "" },
  sector: { type: String, default: "" },
  specialAward: { type: String, enum: ["", "lifetime", "rising", "crossborder"], default: "" },
 
  // ═════ SECTION 2 — Nominee ═════
  nomineeType: { type: String, enum: ["Individual", "Organisation", "Team / Project"], required: true },
  nomineeName: { type: String, required: true, trim: true },
  nomineeTitle: { type: String, default: "" },
  nomineeOrganisation: { type: String, required: true, trim: true },
  nomineeSector: { type: String, default: "" },
  nomineeLocation: { type: String, required: true, trim: true },
  nomineeWebsite: { type: String, default: "" },
  nomineeLinkedIn: { type: String, default: "" },
  nomineeEmail: { type: String, required: true, trim: true, lowercase: true },
  nomineePhone: { type: String, default: "" },
 
  // ═════ SECTION 3 — Nominator ═════
  selfNomination: { type: Boolean, default: false },
  nominatorName: { type: String, required: true, trim: true },
  nominatorTitle: { type: String, default: "" },
  nominatorOrganisation: { type: String, required: true, trim: true },
  nominatorRelationship: { type: String, required: true, trim: true },
  nominatorEmail: { type: String, required: true, trim: true, lowercase: true },
  nominatorPhone: { type: String, default: "" },
 
  // ═════ SECTION 4 — Statement ═════
  statementOverview: { type: String, required: true },
  statementImpact: { type: String, required: true },
  statementAchievements: { type: String, required: true },
  statementEvidence: { type: String, default: "" },
 
  // ═════ SECTION 5 — Declaration ═════
  declaration1: { type: Boolean, required: true },
  declaration2: { type: Boolean, required: true },
  declaration3: { type: Boolean, required: true },
  declaration4: { type: Boolean, required: true },
  signatureName: { type: String, required: true, trim: true },
 
  // ═════ ADMIN STATUS ═════
  status: {
    type: String,
    enum: ["pending", "shortlisted", "winner", "rejected"],
    default: "pending",
    index: true,
  },
  adminNotes: { type: String, default: "" },
  submittedAt: { type: Date, default: Date.now },
}, { timestamps: true });
 
// Helpful compound index for admin queries
nominationSchema.index({ status: 1, createdAt: -1 });
nominationSchema.index({ nomineeEmail: 1 });
 
export default mongoose.model("Nomination", nominationSchema);
