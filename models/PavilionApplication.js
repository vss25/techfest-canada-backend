import mongoose from "mongoose";

/* One row per India Startup Pavilion application (website /exhibit/india-pavilion).
   Saved before any email goes out, so an application is never lost to a mail
   failure. Field list and labels: services/pavilionApplications.js SECTIONS.
   Applications sent before Oct 2026 were only emailed and aren't here. */
const str = { type: String, default: "" };
const yn = { type: String, enum: ["", "yes", "no"], default: "" };

const pavilionApplicationSchema = new mongoose.Schema({
  reference: { type: String, unique: true, sparse: true }, // "IP-7K3QXM", quoted on the deposit page

  // 1. Company details
  legalName: { type: String, required: true },
  tradingName: str, cin: str, incorporationDate: str, yearFounded: str, employees: str,
  registeredOffice: str, website: str, linkedIn: str,

  // 2. Eligibility & qualification
  isIndian: yn, isMcaRegistered: yn, cinNumber: str, roc: str,
  isDpiitRecognised: yn, dpiitNumber: str, isIncubatorEndorsed: yn, incubator: str,
  hasCanadianOps: yn, canadianPresence: str,
  businessStage: str, otherStage: str, latestFunding: str, annualRevenue: str,

  // 3. Business overview
  techDomain: str, sector: str, otherSector: str,
  companyDescription: str, traction: str, objective: str,

  // 4. Booth & programme
  boothTier: str,
  programmeInterests: { type: [String], default: [] },

  // 5. Representative & delegates
  repName: { type: String, required: true },
  repTitle: str,
  repEmail: { type: String, required: true },
  repMobile: str, secondaryContact: str, delegate1: str, delegate2: str,
  needsVisa: yn, visaCount: str,

  // 6. Declaration & signature
  declaration1: Boolean, declaration2: Boolean, declaration3: Boolean,
  declaration4: Boolean, declaration5: Boolean, declaration6: Boolean,
  signatureName: str, signatureTitle: str,

  // Anything else the form sent (newer form fields), kept as-is
  raw: { type: mongoose.Schema.Types.Mixed, default: {} },

  // Where from (no IP addresses)
  page: str, userAgent: str,
  clientSubmittedAt: Date,
  fillMs: Number, // how long the form was open

  // Staff
  status: { type: String, enum: ["new", "contacted", "accepted", "declined"], default: "new" },
  notes: str,
  statusChangedAt: Date,
  lastEditedBy: str,
  lastEditedAt: Date,

  // Emails: sending → sent | failed; blocked = bot, never emailed
  emailStatus: { type: String, enum: ["sending", "sent", "failed", "blocked"] },
  salesNotified: { type: Boolean, default: false },
  confirmationSent: { type: Boolean, default: false },
  emailError: str,

  // $500 deposit (services/pavilionDeposits.js links paid Stripe deposits here)
  depositPaid: { type: Boolean, default: false },
  depositAmount: Number,   // before HST
  depositTotal: Number,    // what was charged, with HST
  depositRefunded: { type: Number, default: 0 },
  depositCurrency: str,
  depositPaidAt: Date,
  depositStripeId: str,    // Checkout Session id
  depositMatchedBy: str,   // reference | email | company | deposit
  // Created from a paid Stripe deposit because the application itself was only ever emailed
  // (before Oct 2026). Filled in by the form if that company applies again.
  fromDeposit: Boolean,
  formReceivedAt: Date,

  // Bot (honeypot / random text / instant fill): kept for review, never emailed, hidden in the admin list
  spam: { type: Boolean, default: false },
  spamReason: str,
}, { timestamps: true });

pavilionApplicationSchema.index({ createdAt: -1 });
pavilionApplicationSchema.index({ repEmail: 1 });
pavilionApplicationSchema.index({ status: 1, createdAt: -1 });

export default mongoose.models.PavilionApplication || mongoose.model("PavilionApplication", pavilionApplicationSchema);
