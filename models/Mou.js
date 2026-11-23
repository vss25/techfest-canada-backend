import mongoose from "mongoose";

/* MOU drafts and the catalogue they're built from (Nov 23 2026; rules in services/mou.js, routes in
   routes/mous.js). Private: MongoDB only, never Sanity. Money is whole cents (CAD). */

/* One item in the MOU catalogue: something TTFC offers (LinkedIn shoutout, free passes, a discount
   code…) or something the partner delivers (a newsletter mention, a ticket sales target…), with its
   default wording. Only the super admin creates or changes these. */
const mouItemSchema = new mongoose.Schema({
  side: { type: String, enum: ["ttfc", "partner"], required: true, index: true },
  name: { type: String, required: true },
  category: { type: String, default: "other" },     // services/mou.js ITEM_CATEGORIES
  fields: { type: [String], default: [] },          // qty, schedule, code, value: what an MOU asks for
  wording: { type: String, default: "" },           // with placeholders: {partner} {event} {qty} {s} {when} {code} {value}
  qty: { type: Number, default: null },             // defaults for a new line
  value: { type: String, default: "" },
  code: { type: String, default: "" },
  active: { type: Boolean, default: true },         // false = retired: off new MOUs, old ones keep it
  sort: { type: Number, default: 0 },
  createdBy: { type: String, default: "" },
  updatedBy: { type: String, default: "" },
}, { timestamps: true });

/* A line on an MOU: a copy of the catalogue item when it was ticked, customised for this partner. */
const lineSchema = new mongoose.Schema({
  itemId: String, side: String, name: String, category: String, fields: [String],
  baseWording: String,                              // the catalogue's wording when it was ticked
  wording: { type: String, default: "" },           // this MOU's own wording ("" = baseWording)
  qty: { type: Number, default: null },
  schedule: {
    mode: { type: String, default: "none" },        // none | dates | repeat | note
    dates: { type: [String], default: [] }, every: { type: String, default: "" },
    from: { type: String, default: "" }, to: { type: String, default: "" }, note: { type: String, default: "" },
  },
  code: { type: String, default: "" },
  value: { type: String, default: "" },
  unlockAt: { type: Number, default: null },        // TTFC lines: only once ticket sales with the partner's code reach this
}, { _id: false });

const mouSchema = new mongoose.Schema({
  number: { type: String, unique: true, sparse: true },
  eventKey: { type: String, required: true, index: true },
  eventName: { type: String, default: "" },
  partner: { name: String, address: String, website: String },
  contact: { name: String, title: String, email: String, phone: String },
  lines: { type: [lineSchema], default: [] },
  terms: {
    binding: { type: Boolean, default: false },
    financial: { type: Boolean, default: false },
    payer: { type: String, default: "partner" },    // partner pays TTFC, or TTFC pays the partner
    amount: { type: Number, default: null },        // cents
    paymentNote: { type: String, default: "" },
    startDate: { type: String, default: "" }, endDate: { type: String, default: "" },
    purpose: { type: String, default: "" },
    clauses: { type: [{ _id: false, key: String, on: Boolean }], default: [] },
    custom: { type: String, default: "" },
  },
  ttfcSignatoryIds: { type: [String], default: [] }, // Contract settings' signing authorities
  partnerSigners: { type: [{ _id: false, name: String, title: String, email: String }], default: [] },
  notes: { type: String, default: "" },              // internal, never printed
  status: { type: String, enum: ["draft", "review", "exported"], default: "draft", index: true },
  frozen: { type: mongoose.Schema.Types.Mixed, default: null }, // TTFC's details and signatories as exported
  reviewAt: Date, reviewBy: { type: String, default: "" },
  exportedAt: Date, exportedBy: { type: String, default: "" }, exports: { type: Number, default: 0 },
  createdBy: { type: String, default: "" }, createdById: { type: String, default: "" },
  updatedBy: { type: String, default: "" },
}, { timestamps: true });

export const MouItem = mongoose.models.MouItem || mongoose.model("MouItem", mouItemSchema);
export const Mou = mongoose.models.Mou || mongoose.model("Mou", mouSchema);
