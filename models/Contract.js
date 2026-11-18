import mongoose from "mongoose";

/* Sales contracts and the offerings catalogue they're built from (Nov 18 2026; rules in
   services/contracts.js, routes in routes/contracts.js). Private: MongoDB only, never Sanity.
   Money is whole cents (CAD). */

/* One item in the catalogue: an offering (booth, pass, LinkedIn post, spotlight…) or a package
   of offerings at one price. Only the super admin creates or changes these. */
const offeringSchema = new mongoose.Schema({
  kind: { type: String, enum: ["offering", "package"], default: "offering" },
  name: { type: String, required: true },
  category: { type: String, default: "other" },      // services/contracts.js CATEGORIES, or "package"
  description: { type: String, default: "" },         // printed on the contract
  unit: { type: String, default: "each" },
  price: { type: Number, default: 0 },                // cents, before tax
  taxable: { type: Boolean, default: true },
  eventKeys: { type: [String], default: [] },         // empty = every event
  limit: { type: Number, default: null },             // units per event across sent and signed contracts; null = no limit
  track: { type: String, enum: ["each", "once", "none"], default: "once" },
  items: { type: [{ _id: false, offeringId: String, qty: Number }], default: [] }, // packages only
  active: { type: Boolean, default: true },           // false = retired: off new contracts, old ones keep it
  sort: { type: Number, default: 0 },
  createdBy: { type: String, default: "" },
  updatedBy: { type: String, default: "" },
}, { timestamps: true });

/* What a contract line copied from the catalogue when it was added: the catalogue can change later
   without changing a contract. */
const lineSchema = new mongoose.Schema({
  offeringId: String, kind: String, name: String, category: String, description: String, unit: String,
  taxable: Boolean, track: String, qty: Number, listPrice: Number, unitPrice: Number,
  items: { type: [{ _id: false, offeringId: String, name: String, category: String, unit: String, qty: Number, track: String }], default: [] },
}, { _id: false });

/* A promise to deliver once the contract is signed ("LinkedIn post 1 of 2"). */
const deliverableSchema = new mongoose.Schema({
  key: String, lineIndex: Number, label: String, category: String, unit: String,
  dueDate: { type: String, default: "" },   // YYYY-MM-DD
  owner: { type: String, default: "" },
  link: { type: String, default: "" },
  note: { type: String, default: "" },
  done: { type: Boolean, default: false },
  doneAt: Date, doneBy: { type: String, default: "" },
}, { _id: false });

const contractSchema = new mongoose.Schema({
  number: { type: String, unique: true, sparse: true },
  eventKey: { type: String, required: true, index: true },
  eventName: { type: String, default: "" },
  company: { name: String, address: String, website: String },
  contact: { name: String, title: String, email: String, phone: String },
  lines: { type: [lineSchema], default: [] },
  taxRate: { type: Number, default: 13 },
  paymentTerms: { type: String, default: "" },
  terms: { type: String, default: "" },              // this contract's special terms (the standard clauses come from settings)
  frozen: { type: mongoose.Schema.Types.Mixed, default: null }, // TTFC's details, signatories, document text, clauses as sent / signed
  notes: { type: String, default: "" },              // internal, never printed
  status: { type: String, enum: ["draft", "sent", "signed", "cancelled"], default: "draft", index: true },
  approval: {                                        // a price further below the catalogue than the limit
    needed: { type: Boolean, default: false },
    key: { type: String, default: "" },              // the prices approved (services/contracts.js pricingKey)
    by: { type: String, default: "" }, at: Date,
  },
  sentAt: Date, sentBy: { type: String, default: "" },
  signedAt: Date, signedBy: { type: String, default: "" }, signerName: { type: String, default: "" },
  cancelledAt: Date, cancelledBy: { type: String, default: "" },
  signedCopy: { name: String, size: Number, at: Date, by: String },
  deliverables: { type: [deliverableSchema], default: [] },
  createdBy: { type: String, default: "" }, createdById: { type: String, default: "" },
  updatedBy: { type: String, default: "" },
}, { timestamps: true });

/* The signed PDF the partner sent back (≤ 10 MB), kept apart so lists never load it. */
const contractFileSchema = new mongoose.Schema({
  contractId: { type: String, required: true, unique: true },
  name: String, size: Number, data: Buffer, uploadedBy: String,
}, { timestamps: true });

export const Offering = mongoose.models.Offering || mongoose.model("Offering", offeringSchema);
export const Contract = mongoose.models.Contract || mongoose.model("Contract", contractSchema);
export const ContractFile = mongoose.models.ContractFile || mongoose.model("ContractFile", contractFileSchema);
