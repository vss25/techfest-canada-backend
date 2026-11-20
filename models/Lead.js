import mongoose from "mongoose";

const contactLogSchema = new mongoose.Schema({
  date: { type: String },
  method: { type: String },
  notes: { type: String }
}, { _id: false });

const leadSchema = new mongoose.Schema({
  leadName: { type: String, required: true },
  companyName: { type: String, default: "" },
  jobTitle: { type: String, default: "" },
  industry: { type: String, default: "" },
  country: { type: String, default: "" },
  city: { type: String, default: "" },
  score: { type: Number, default: 50 },
  email: { type: String, default: "" },
  phone: { type: String, default: "" },
  linkedin: { type: String, default: "" },
  website: { type: String, default: "" },
  notes: { type: String, default: "" },
  followUpDate: { type: String, default: "" },
  followUpNotes: { type: String, default: "" },
  reminderDate: { type: String, default: "" },
  reminderNotes: { type: String, default: "" },
  meetingHeldDate: { type: String, default: "" },
  meetingNotes: { type: String, default: "" },
  contactMethod: { type: String, default: "Phone Call" },
  contactLog: [contactLogSchema],
  dealSize: { type: Number, default: 0 },
  dealCategories: [{ type: String }],
  status: { type: String, default: "new" },
  relatedLeadId: { type: String, default: "" },
  leadContact: { type: String, default: "" },
  assignedTo: { type: String, default: null },
  assignedToName: { type: String, default: null },
  assignedAt: { type: Date, default: null },
  lastContactedAt: { type: Date, default: null },
  lastContactedBy: { type: String, default: null },
  email_status: { type: String, default: "unknown" },
  functionalLevel: { type: String, default: "" },
  company_domain: { type: String, default: "" },
  company_size: { type: String, default: "" },
  company_annual_revenue_clean: { type: String, default: "" },
  company_total_funding_clean: { type: String, default: "" },
  company_founded_year: { type: String, default: "" },
  company_linkedin: { type: String, default: "" },
  company_phone: { type: String, default: "" },
  company_full_address: { type: String, default: "" },
  company_description: { type: String, default: "" },
  // Nov 20 2026: hot leads synced from Explee (services/explee.js). expleePersonId is Explee's person_id.
  source: { type: String, default: "" },                 // "" (added by hand / older imports) | "explee"
  expleePersonId: { type: String, default: undefined },
  expleeCampaignId: { type: Number, default: null },
  hotReply: { type: String, default: "" },               // the reply that made them a hot lead, word for word
  becameHotAt: { type: Date, default: null },
  repliedAt: { type: Date, default: null },
}, {
  timestamps: true
});

leadSchema.index({ expleePersonId: 1 }, { unique: true, partialFilterExpression: { expleePersonId: { $type: "string" } } });

const Lead = mongoose.models.Lead || mongoose.model("Lead", leadSchema);

export default Lead;