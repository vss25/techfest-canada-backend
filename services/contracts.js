/* =========================================================
   Sales contracts built from an offerings catalogue (Nov 18 2026).
   The organiser: "For contracts for sales, exhibitors, the person should be able to select product
   offerings such as booth, tickets, branding commitments such as 2 linkedin posts, 3 insta posts,
   etc., spotlight on partners/website page, etc. I should be able to create as a super admin other
   offerings that can be added in other contracts."

   Pure parts only (no database): cleaning what the panel sends, money, totals, the discount rule,
   the promises a signed contract turns into, limits, and contract numbers. Money is whole cents
   (CAD) everywhere; the panel sends and shows dollars.
========================================================= */

export const CATEGORIES = [
  { key: "booth", label: "Booth" },
  { key: "tickets", label: "Tickets" },
  { key: "branding", label: "Branding" },
  { key: "social", label: "Social media" },
  { key: "spotlight", label: "Spotlight" },
  { key: "speaking", label: "Speaking" },
  { key: "other", label: "Other" },
];
const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);

/* What a signed contract turns each item into:
     each  one task per unit ("LinkedIn post 1 of 2")
     once  one task for the line ("Partner spotlight on the website")
     none  nothing to track (it's delivered with the event, e.g. a sponsor mention) */
export const TRACK = [
  { key: "each", label: "One task per unit" },
  { key: "once", label: "One task" },
  { key: "none", label: "Nothing to track" },
];
const TRACK_KEYS = TRACK.map((t) => t.key);

export const STATUSES = [
  { key: "draft", label: "Draft" },
  { key: "sent", label: "Sent" },
  { key: "signed", label: "Signed" },
  { key: "cancelled", label: "Cancelled" },
];

export const TAX_RATES = [
  { rate: 13, label: "HST 13% (Ontario)" },
  { rate: 15, label: "HST 15% (Atlantic provinces)" },
  { rate: 5, label: "GST 5%" },
  { rate: 0, label: "No tax (outside Canada)" },
];

/* Standard clauses: a starting point only. Have a lawyer review them before relying on them. */
export const DEFAULT_CLAUSES = [
  { title: "Deliverables", body: "TTFC will deliver the items listed in this agreement. Branding and social media items are delivered on dates agreed with the partner. The partner supplies logos, copy and approvals in time; TTFC is not responsible for delays caused by late materials." },
  { title: "Payment", body: "Amounts are in Canadian dollars and are due as set out under Payment terms. TTFC may withhold deliverables while an invoice is overdue." },
  { title: "Cancellation", body: "If the partner cancels, amounts already paid are not refunded, and amounts due before the cancellation remain payable. If TTFC cancels the event, TTFC will refund amounts paid for items not delivered, or credit them to a future TTFC event at the partner's choice." },
  { title: "Use of names and logos", body: "Each party may use the other's name and logo only to promote the event and as set out in this agreement, and only in the form the other party approved." },
  { title: "Indemnity", body: "Each party will indemnify the other against third-party claims arising from its own negligence, wilful misconduct or breach of this agreement, including claims that materials it supplied infringe a third party's rights." },
  { title: "Limitation of liability", body: "Except for the indemnity above, neither party is liable for indirect or consequential losses, and each party's total liability under this agreement is limited to the amounts paid or payable under it." },
  { title: "Confidentiality", body: "Each party will keep the terms of this agreement and any confidential information it receives from the other party confidential, except where disclosure is required by law." },
  { title: "Force majeure", body: "Neither party is liable for failure or delay caused by events beyond its reasonable control, including government orders, public health measures, natural disasters or venue closure." },
  { title: "Governing law", body: "This agreement is governed by the laws of the Province of Ontario and the federal laws of Canada that apply there." },
  { title: "Entire agreement", body: "This agreement is the entire agreement between the parties about its subject and replaces any earlier discussions. Changes must be in writing and signed by both parties." },
];

export const SETTING_DEFAULTS = {
  maxDiscountPct: 10,
  taxRate: 13,
  paymentTerms: "50% on signing. The balance 30 days before the event.",
  company: { legalName: "The Tech Festival Canada", address: "", hstNumber: "", email: "sales@thetechfestival.com", phone: "", website: "thetechfestival.com" },
  signatories: [{ name: "", title: "Director", signature: "" }],
  numbering: { prefix: "TTFC", digits: 4 },
  document: { header: "PARTNER AGREEMENT", footer: "", confidential: true, confidentialLabel: "CONFIDENTIAL" },
  clauses: DEFAULT_CLAUSES,
};

const MAX_CENTS = 100_000_000_00; // $100M: anything above is a typo
const str = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const text = (v, max) => String(v ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);

/** "1,250.50" / 1250.5 → 125050 cents; null when not a sensible amount. */
export function toCents(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  const c = Math.round(n * 100);
  return c > MAX_CENTS ? null : c;
}

/** 125050 → "$1,250.50" */
export const money = (cents) =>
  `$${(Math.round(Number(cents) || 0) / 100).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const cleanKeys = (list) => [...new Set((Array.isArray(list) ? list : []).map((k) => str(k, 80)).filter(Boolean))].slice(0, 20);

/** An offering or package from the panel → { value } or { error }. `packageOf`: (id) → offering, to check items. */
export function cleanOffering(body = {}, { packageOf = () => null } = {}) {
  const kind = body.kind === "package" ? "package" : "offering";
  const name = str(body.name, 120);
  if (!name) return { error: "Give it a name." };
  const price = toCents(body.price);
  if (price === null) return { error: "Enter a price in dollars (0 or more)." };
  const v = {
    kind, name, price,
    description: text(body.description, 1000),
    unit: str(body.unit, 30) || (kind === "package" ? "package" : "each"),
    taxable: body.taxable !== false,
    eventKeys: cleanKeys(body.eventKeys),
    active: body.active !== false,
  };
  if (kind === "offering") {
    if (!CATEGORY_KEYS.includes(body.category)) return { error: "Pick a category." };
    v.category = body.category;
    v.track = TRACK_KEYS.includes(body.track) ? body.track : "once";
    if (body.limit === null || body.limit === undefined || body.limit === "") v.limit = null;
    else {
      const n = Number(body.limit);
      if (!Number.isInteger(n) || n < 1 || n > 100000) return { error: "The limit is a whole number from 1, or empty for no limit." };
      v.limit = n;
    }
    v.items = [];
  } else {
    v.category = "package";
    v.track = "none";
    v.limit = null;
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return { error: "Add at least one offering to the package." };
    if (items.length > 30) return { error: "A package holds up to 30 offerings." };
    v.items = [];
    for (const it of items) {
      const id = str(it?.offeringId, 40);
      const qty = Number(it?.qty);
      const o = packageOf(id);
      if (!o) return { error: "One of the package's offerings no longer exists." };
      if (o.kind === "package") return { error: "A package can't contain another package." };
      if (!Number.isInteger(qty) || qty < 1 || qty > 999) return { error: `Quantity for ${o.name} must be 1 to 999.` };
      v.items.push({ offeringId: String(o._id), qty });
    }
  }
  return { value: v };
}

/** Whether an offering can go on a contract for this event (no events listed = every event). */
export const offeredFor = (o, eventKey) =>
  !!o && o.active !== false && (!o.eventKeys?.length || o.eventKeys.includes(eventKey));

/** One contract line from the panel + the catalogue → a snapshot that never changes when the catalogue does. */
export function lineFrom(input = {}, offering, byId = () => null) {
  const qty = Number(input.qty);
  if (!Number.isInteger(qty) || qty < 1 || qty > 9999) return { error: `Quantity for ${offering.name} must be 1 to 9999.` };
  const listPrice = Math.round(Number(offering.price) || 0);
  const unitPrice = input.unitPrice === undefined || input.unitPrice === null || input.unitPrice === "" ? listPrice : toCents(input.unitPrice);
  if (unitPrice === null) return { error: `Enter a price for ${offering.name}.` };
  const line = {
    offeringId: String(offering._id), kind: offering.kind, name: offering.name, category: offering.category,
    description: offering.description || "", unit: offering.unit || "each", taxable: offering.taxable !== false,
    track: offering.kind === "package" ? "none" : offering.track || "once",
    qty, listPrice, unitPrice, items: [],
  };
  if (offering.kind === "package") {
    for (const it of offering.items || []) {
      const o = byId(String(it.offeringId));
      if (!o) continue;
      line.items.push({ offeringId: String(o._id), name: o.name, category: o.category, unit: o.unit || "each",
                        qty: it.qty, track: o.track || "once" });
    }
  }
  return { value: line };
}

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

/** Totals in cents: subtotal (what's charged before tax), list (catalogue prices), discount, tax, total. */
export function totals(lines = [], taxRate = SETTING_DEFAULTS.taxRate) {
  let subtotal = 0, list = 0, taxable = 0;
  for (const l of lines) {
    const amount = l.unitPrice * l.qty;
    subtotal += amount;
    list += l.listPrice * l.qty;
    if (l.taxable !== false) taxable += amount;
  }
  const rate = Number(taxRate) || 0;
  const tax = Math.round((taxable * rate) / 100);
  const discount = Math.max(0, list - subtotal);
  return { subtotal, list, discount, discountPct: pct(discount, list), taxable, taxRate: rate, tax, total: subtotal + tax };
}

/** Lines priced further below the catalogue than staff may go alone. */
export function overDiscount(lines = [], maxPct = SETTING_DEFAULTS.maxDiscountPct) {
  return lines
    .map((l, i) => ({ i, name: l.name, pct: pct(Math.max(0, (l.listPrice - l.unitPrice) * l.qty), l.listPrice * l.qty) }))
    .filter((x) => x.pct > maxPct);
}

/** A fingerprint of what's charged: an approval holds only while the prices it saw are unchanged. */
export const pricingKey = (lines = [], taxRate = 0) =>
  JSON.stringify([Number(taxRate) || 0, ...lines.map((l) => [l.offeringId, l.qty, l.unitPrice])]);

/** The tasks a signed contract creates, in line order. Keys stay stable so ticks survive a re-plan. */
export function deliverablesFor(lines = []) {
  const out = [];
  const add = (lineIndex, part, name, category, track, units, unit) => {
    if (track === "none" || units < 1) return;
    if (track === "once") {
      out.push({ key: `${lineIndex}.${part}.1`, lineIndex, label: name, category });
      return;
    }
    const n = Math.min(units, 500);
    for (let k = 1; k <= n; k++) {
      out.push({ key: `${lineIndex}.${part}.${k}`, lineIndex, label: n > 1 ? `${name} ${k} of ${n}` : name, category, unit });
    }
  };
  lines.forEach((l, i) => {
    if (l.kind === "package") (l.items || []).forEach((it, j) => add(i, j, it.name, it.category, it.track, it.qty * l.qty, it.unit));
    else add(i, 0, l.name, l.category, l.track, l.qty, l.unit);
  });
  return out;
}

/** Units of each offering a contract takes (packages counted through their items). */
export function unitsTaken(lines = []) {
  const m = new Map();
  const add = (id, n) => m.set(id, (m.get(id) || 0) + n);
  for (const l of lines) {
    if (l.kind === "package") for (const it of l.items || []) add(it.offeringId, it.qty * l.qty);
    else add(l.offeringId, l.qty);
  }
  return m;
}

/** Offerings this contract would take past their limit. `used`: Map id → units on OTHER sent / signed contracts. */
export function overLimits(lines, offeringsById, used = new Map()) {
  const out = [];
  for (const [id, n] of unitsTaken(lines)) {
    const o = offeringsById(id);
    if (!o?.limit) continue;
    const left = o.limit - (used.get(id) || 0);
    if (n > left) out.push({ offeringId: id, name: o.name, limit: o.limit, left: Math.max(0, left), asked: n });
  }
  return out;
}

/** "TTFC-27-0007": the event year's two digits and a running number. */
export const contractNumber = (year, seq, { prefix = "TTFC", digits = 4 } = {}) =>
  `${prefix ? `${prefix}-` : ""}${String(year).slice(-2)}-${String(seq).padStart(digits, "0")}`;

/** Company and contact from the panel → { value } or { error }. */
export function cleanParty(body = {}) {
  const company = {
    name: str(body.company?.name, 160),
    address: text(body.company?.address, 400),
    website: str(body.company?.website, 200),
  };
  if (!company.name) return { error: "Enter the company's name." };
  const email = str(body.contact?.email, 160).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "That contact email doesn't look right." };
  const contact = {
    name: str(body.contact?.name, 120), title: str(body.contact?.title, 120),
    email, phone: str(body.contact?.phone, 40),
  };
  return { value: { company, contact } };
}

const SIGNATURE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;

/** Settings from the panel → { value } or { error }. */
export function cleanSettings(body = {}) {
  const max = Number(body.maxDiscountPct);
  if (!Number.isFinite(max) || max < 0 || max > 100) return { error: "The discount limit is a percentage from 0 to 100." };
  const rate = Number(body.taxRate);
  if (!TAX_RATES.some((t) => t.rate === rate)) return { error: "Pick a tax rate." };
  const c = body.company || {};
  const company = {
    legalName: str(c.legalName, 160), address: text(c.address, 400), hstNumber: str(c.hstNumber, 40),
    email: str(c.email, 160), phone: str(c.phone, 40), website: str(c.website, 160),
  };
  if (!company.legalName) return { error: "Enter TTFC's legal name." };
  const signatories = [];
  for (const sg of (Array.isArray(body.signatories) ? body.signatories : []).slice(0, 2)) {
    const name = str(sg?.name, 120), title = str(sg?.title, 120), signature = String(sg?.signature || "");
    if (signature && (!SIGNATURE.test(signature) || signature.length > 300_000)) return { error: "A signature must be a PNG or JPG under 200 KB." };
    if (name || title || signature) signatories.push({ name, title, signature });
  }
  const n = body.numbering || {};
  const prefix = str(n.prefix, 12).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const digits = Number(n.digits);
  if (!Number.isInteger(digits) || digits < 3 || digits > 6) return { error: "Contract numbers use 3 to 6 digits." };
  const d = body.document || {};
  const document = {
    header: str(d.header, 60) || "PARTNER AGREEMENT", footer: str(d.footer, 200),
    confidential: d.confidential !== false, confidentialLabel: str(d.confidentialLabel, 40) || "CONFIDENTIAL",
  };
  const clauses = [];
  for (const cl of (Array.isArray(body.clauses) ? body.clauses : []).slice(0, 40)) {
    const title = str(cl?.title, 120), b = text(cl?.body, 4000);
    if (title || b) clauses.push({ title, body: b });
  }
  return { value: {
    maxDiscountPct: Math.round(max * 10) / 10, taxRate: rate,
    paymentTerms: text(body.paymentTerms, 1000) || SETTING_DEFAULTS.paymentTerms,
    company, signatories, numbering: { prefix, digits }, document, clauses,
  } };
}

/** What a contract freezes when it's sent or signed: TTFC's details, signatories, document text and clauses. */
export const frozenFrom = (settings) => ({
  company: settings.company, signatories: settings.signatories, document: settings.document, clauses: settings.clauses,
});
