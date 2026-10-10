/* =========================================================
   India Startup Pavilion applications (website /exhibit/india-pavilion)
   ---------------------------------------------------------
   Pure helpers so they can be unit-tested
   (test/pavilion-applications.test.js): the list of form fields
   (grouped like the form's six steps), cleaning what the form
   sent, the bot check, matching a paid $500 deposit to its
   application, and the staff list / detail / CSV.
   routes/pavilion.js saves and emails, services/pavilionDeposits.js
   records deposits, routes/console.js lists them for
   Admin → India Pavilion.
========================================================= */

import crypto from "crypto";
import { cleanText, cleanPage, isHoneypotFilled, botReason, csvCell } from "./brochureDownloads.js";

export { isHoneypotFilled, csvCell };

export const STATUSES = ["new", "contacted", "accepted", "declined"];
export const STATUS_LABEL = { new: "New", contacted: "Contacted", accepted: "Accepted", declined: "Declined" };

export const PROGRAMME_LABELS = {
  speaking: "Speaking opportunity",
  mou: "MoU signing ceremony",
  b2b: "Curated B2B meetings",
  forum: "India Business Forum participation",
  investor: "Investor / capital introductions",
};

export const BOOTH_LABELS = {
  single: { label: "Single", size: "10' × 10'", pay: 499 },
  double: { label: "Double", size: "10' × 20'", pay: 999 },
  triple: { label: "Triple", size: "10' × 30'", pay: 1499 },
  quadruple: { label: "Quadruple", size: "10' × 40'", pay: 1999 },
};

/* Every field the form sends, in the order of its six steps.
   Keep in step with EMPTY_FORM in src/pages/IndiaPavilion.jsx (techfest-canada-frontend).
   type: text (one line) | long (keeps line breaks) | yesno | bool | list | email */
export const SECTIONS = [
  { id: "company", title: "Company details", fields: [
    ["legalName", "Legal name", "text"],
    ["tradingName", "Trading name", "text"],
    ["cin", "CIN", "text"],
    ["incorporationDate", "Date of incorporation", "text"],
    ["yearFounded", "Year founded", "text"],
    ["employees", "Employees", "text"],
    ["registeredOffice", "Registered office", "long"],
    ["website", "Website", "text"],
    ["linkedIn", "LinkedIn", "text"],
  ] },
  { id: "eligibility", title: "Eligibility & qualification", fields: [
    ["isIndian", "Incorporated in India", "yesno"],
    ["isMcaRegistered", "Registered with MCA", "yesno"],
    ["cinNumber", "CIN (MCA)", "text"],
    ["roc", "Registrar of Companies", "text"],
    ["isDpiitRecognised", "DPIIT / Startup India recognised", "yesno"],
    ["dpiitNumber", "DPIIT number", "text"],
    ["isIncubatorEndorsed", "Incubator endorsed", "yesno"],
    ["incubator", "Incubator", "text"],
    ["hasCanadianOps", "Canadian operations", "yesno"],
    ["canadianPresence", "Canadian presence", "long"],
    ["businessStage", "Business stage", "text"],
    ["otherStage", "Business stage (other)", "text"],
    ["latestFunding", "Latest funding", "text"],
    ["annualRevenue", "Annual revenue", "text"],
  ] },
  { id: "pitch", title: "Business overview", fields: [
    ["techDomain", "Technology domain", "text"],
    ["sector", "Applied sector", "text"],
    ["otherSector", "Applied sector (other)", "text"],
    ["companyDescription", "Company description", "long"],
    ["traction", "Traction & key milestones", "long"],
    ["objective", "Objective at TTFC 2026", "long"],
  ] },
  { id: "booth", title: "Booth & programme", fields: [
    ["boothTier", "Booth tier", "text"],
    ["programmeInterests", "Programme interests", "list"],
  ] },
  { id: "representative", title: "Representative & delegates", fields: [
    ["repName", "Name", "text"],
    ["repTitle", "Title", "text"],
    ["repEmail", "Email", "email"],
    ["repMobile", "Mobile", "text"],
    ["secondaryContact", "Secondary contact", "text"],
    ["delegate1", "Delegate 1", "text"],
    ["delegate2", "Delegate 2", "text"],
    ["needsVisa", "Needs visa assistance", "yesno"],
    ["visaCount", "Visa letters needed", "text"],
  ] },
  { id: "declaration", title: "Declaration & signature", fields: [
    ["declaration1", "Incorporated in India and registered with MCA", "bool"],
    ["declaration2", "Information is true, accurate and complete", "bool"],
    ["declaration3", "Will provide supporting documents on request", "bool"],
    ["declaration4", "Authorised to apply and sign on the company's behalf", "bool"],
    ["declaration5", "Agrees to exhibitor terms and pavilion guidelines", "bool"],
    ["declaration6", "Understands acceptance is at the organiser's discretion", "bool"],
    ["signatureName", "Authorised signatory", "text"],
    ["signatureTitle", "Designation", "text"],
  ] },
];

export const FIELDS = SECTIONS.flatMap((s) => s.fields.map(([key, label, type]) => ({ key, label, type, section: s.id })));
const FIELD_KEYS = new Set(FIELDS.map((f) => f.key));
// Sent by the form but stored elsewhere (or not at all)
const META_KEYS = new Set(["_hp", "elapsedMs", "page", "submittedAt"]);

const MAX = { text: 300, long: 5000, email: 254 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // same check as the form

/** Like cleanText but keeps line breaks (addresses, descriptions). */
export function cleanLong(v) {
  if (v == null) return "";
  if (typeof v !== "string" && typeof v !== "number") return "";
  return String(v).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ")
    .split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const yesNo = (v) => {
  const s = cleanText(v).toLowerCase();
  return s === "yes" || s === "no" ? s : "";
};
const bool = (v) => v === true || v === "true" || v === "on" || v === 1 || v === "1" || v === "yes";

function cleanField(type, v) {
  if (type === "yesno") return yesNo(v);
  if (type === "bool") return bool(v);
  if (type === "list") {
    const arr = Array.isArray(v) ? v : v == null || v === "" ? [] : [v];
    return [...new Set(arr.map((x) => cleanText(x).slice(0, 60)).filter(Boolean))].slice(0, 20);
  }
  if (type === "long") return cleanLong(v).slice(0, MAX.long);
  if (type === "email") return cleanText(v).toLowerCase().slice(0, MAX.email);
  return cleanText(v).slice(0, MAX.text);
}

/* Fields the form doesn't send today (a newer form, a script): kept, made safe
   for Mongo (no "$" / "." keys) and kept small. */
export function extraFields(body) {
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(body || {})) {
    if (FIELD_KEYS.has(k) || META_KEYS.has(k) || !/^[A-Za-z0-9_-]{1,60}$/.test(k)) continue;
    if (n++ >= 40) break;
    if (v == null) continue;
    if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) out[k] = v;
    else if (typeof v === "string") out[k] = cleanLong(v).slice(0, 2000);
    else if (Array.isArray(v)) out[k] = v.slice(0, 20).map((x) => (typeof x === "object" ? JSON.stringify(x) : cleanText(x)).slice(0, 300));
    else { try { out[k] = JSON.stringify(v).slice(0, 2000); } catch { /* circular: skip */ } }
  }
  return out;
}

/**
 * Check and clean what the form sent. Over-long text is cut, never refused,
 * so a real application isn't lost over a long answer.
 * @returns {{ ok: true, value: object, raw: object } | { ok: false, error: string, field: string }}
 */
export function validatePavilionApplication(body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const v = {};
  for (const f of FIELDS) v[f.key] = cleanField(f.type, b[f.key]);
  const fail = (field, error) => ({ ok: false, field, error });

  // Same answers as before this was saved, so the form's error handling still fits.
  if (!v.legalName || !v.repEmail || !v.repName) {
    return fail(!v.legalName ? "legalName" : !v.repName ? "repName" : "repEmail", "Company name, contact name and email are required");
  }
  if (!EMAIL_RE.test(v.repEmail)) return fail("repEmail", "Enter a valid email address");
  v.boothTier = v.boothTier.toLowerCase();
  if (!v.boothTier || !BOOTH_LABELS[v.boothTier]) return fail("boothTier", "Please select a valid booth tier");
  if (v.isIndian !== "yes") return fail("isIndian", "This pavilion is only open to Indian-incorporated companies");

  const submitted = new Date(cleanText(b.submittedAt));
  const elapsed = Number(b.elapsedMs);
  return {
    ok: true,
    value: {
      ...v,
      page: cleanPage(b.page),
      clientSubmittedAt: cleanText(b.submittedAt) && !Number.isNaN(submitted.getTime()) ? submitted : undefined,
      fillMs: Number.isFinite(elapsed) && elapsed >= 0 ? Math.round(elapsed) : undefined,
    },
    raw: extraFields(b),
  };
}

/** Why this application looks like a bot, or "" (same rules as the brochure form). */
export function pavilionBotReason(v, body = {}) {
  if (isHoneypotFilled(body)) return "honeypot filled";
  const why = botReason({ firstName: v.repName, lastName: v.signatureName, company: v.legalName, jobTitle: v.repTitle }, body);
  return why
    .replace("firstName", "contact name").replace("lastName", "signatory name")
    .replace("company", "company name").replace("jobTitle", "contact title");
}

/** Short reference the applicant can quote when paying the deposit: "IP-7K3QXM". */
const REF_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O, 1/I
export function makeReference(bytes = crypto.randomBytes(6)) {
  return "IP-" + [...bytes].map((b) => REF_ALPHABET[b % REF_ALPHABET.length]).join("");
}

/* ---------- Deposits ---------- */
export const DEPOSIT_PLACEHOLDER_COMPANY = "Pavilion Applicant"; // routes/payments.js fallback

const COMPANY_SUFFIX = /\b(private|pvt|limited|ltd|llp|opc|inc|incorporated|corp|corporation|co|company|the)\b/g;
/** "Acme Technologies Pvt. Ltd." → "acme technologies" (for matching only). */
export function normalizeCompany(name) {
  return cleanText(name).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ")
    .replace(COMPANY_SUFFIX, " ").replace(/\s+/g, " ").trim();
}

const normRef = (r) => cleanText(r).toUpperCase().replace(/\s+/g, "");

/** Paid Checkout Session (webhook payload) → deposit record, or null if not a paid pavilion deposit. */
export function depositFromSession(s) {
  if (!s || s.metadata?.type !== "pavilion-deposit") return null;
  if (s.payment_status && s.payment_status !== "paid") return null;
  const subtotal = (s.amount_subtotal || 0) / 100;
  const discount = (s.total_details?.amount_discount || 0) / 100;
  return {
    stripeSessionId: s.id,
    paymentIntent: typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id || "",
    email: String(s.customer_details?.email || s.customer_email || "").toLowerCase(),
    name: s.customer_details?.name || "",
    contactEmail: String(s.metadata?.contactEmail || "").toLowerCase(),
    companyName: cleanText(s.metadata?.companyName),
    applicationRef: cleanText(s.metadata?.applicationRef),
    amount: Math.round((subtotal - discount) * 100) / 100,
    tax: (s.total_details?.amount_tax || 0) / 100,
    total: (s.amount_total || 0) / 100,
    currency: String(s.currency || "cad").toUpperCase(),
    paidAt: new Date((s.created || 0) * 1000),
  };
}

/** Row from services/stripeSales.js stripeRows (the revenue page's Stripe read) → deposit record. */
export function depositFromStripeRow(r) {
  if (!r || r.category !== "pavilion") return null;
  return {
    stripeSessionId: r.id,
    paymentIntent: r.paymentIntent || "",
    email: String(r.email || "").toLowerCase(),
    name: r.name || "",
    contactEmail: String(r.meta?.contactEmail || "").toLowerCase(),
    companyName: cleanText(r.meta?.companyName),
    applicationRef: cleanText(r.meta?.applicationRef),
    amount: Math.round(((r.total || 0) - (r.tax || 0)) * 100) / 100,
    tax: r.tax || 0,
    total: r.total || 0,
    refunded: r.refunded || 0,
    currency: String(r.currency || "cad").toUpperCase(),
    paidAt: r.at instanceof Date ? r.at : new Date(r.at),
  };
}

/* Which application a deposit pays for. Tries, in order: the application
   reference typed on the payment page, the email (Stripe receipt email or
   the contact email typed on the payment page), then the company name.
   Among several matches: a real (not bot-flagged) one, then one without a
   deposit yet, then the newest. */
export function matchDeposit(dep, apps = []) {
  if (!dep) return null;
  const pick = (list) => [...list].sort((a, b) =>
    (!!a.spam - !!b.spam)
    || (!!(a.depositStripeId && a.depositStripeId !== dep.stripeSessionId) - !!(b.depositStripeId && b.depositStripeId !== dep.stripeSessionId))
    || (new Date(b.createdAt || 0) - new Date(a.createdAt || 0)))[0];

  const ref = normRef(dep.applicationRef);
  if (ref && ref !== "N/A") {
    const hit = apps.filter((a) => a.reference && normRef(a.reference) === ref);
    if (hit.length) return { app: pick(hit), by: "reference" };
  }
  const emails = new Set([dep.email, dep.contactEmail].map((e) => cleanText(e).toLowerCase()).filter(Boolean));
  if (emails.size) {
    const hit = apps.filter((a) => emails.has(cleanText(a.repEmail).toLowerCase()));
    if (hit.length) return { app: pick(hit), by: "email" };
  }
  const co = dep.companyName === DEPOSIT_PLACEHOLDER_COMPANY ? "" : normalizeCompany(dep.companyName);
  if (co) {
    const hit = apps.filter((a) => [a.legalName, a.tradingName].some((n) => n && normalizeCompany(n) === co));
    if (hit.length) return { app: pick(hit), by: "company" };
  }
  return null;
}

/** What gets $set on an application once its deposit is known. */
export function depositFieldsFor(dep, by) {
  return {
    depositPaid: true,
    depositAmount: dep.amount,
    depositTotal: dep.total,
    depositRefunded: dep.refunded || 0,
    depositCurrency: dep.currency || "CAD",
    depositPaidAt: dep.paidAt,
    depositStripeId: dep.stripeSessionId,
    depositMatchedBy: by,
  };
}

/** "paid" | "refunded" | "unpaid" */
export function depositStatus(a) {
  if (!a?.depositPaid) return "unpaid";
  return a.depositRefunded && a.depositRefunded >= (a.depositTotal || a.depositAmount || 0) ? "refunded" : "paid";
}

/* ---------- Admin list / detail ---------- */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Search box + status filter in Admin → India Pavilion. */
export function applicationsFilter(q, status) {
  const out = {};
  const s = cleanText(q).slice(0, 100);
  if (s) {
    const rx = new RegExp(esc(s), "i");
    out.$or = ["legalName", "tradingName", "repName", "repEmail", "repMobile", "reference", "cin", "cinNumber", "dpiitNumber", "signatureName", "techDomain", "sector"]
      .map((k) => ({ [k]: rx }));
  }
  const st = cleanText(status);
  if (STATUSES.includes(st)) out.status = st;
  return out;
}

/** Staff edits: { status?, notes? } → $set, or an error. */
export function cleanPatch(body) {
  const b = body && typeof body === "object" ? body : {};
  const set = {};
  if (b.status !== undefined) {
    const st = cleanText(b.status);
    if (!STATUSES.includes(st)) return { ok: false, error: "Unknown status" };
    set.status = st;
  }
  if (b.notes !== undefined) {
    if (b.notes !== null && typeof b.notes !== "string") return { ok: false, error: "Notes must be text" };
    const notes = cleanLong(b.notes || "");
    if (notes.length > 5000) return { ok: false, error: "Notes are too long (5,000 characters max)" };
    set.notes = notes;
  }
  if (!Object.keys(set).length) return { ok: false, error: "Nothing to change" };
  return { ok: true, set };
}

const boothOf = (tier) => BOOTH_LABELS[tier] || null;

/** One application in the admin table. */
export function applicationRow(a) {
  const booth = boothOf(a.boothTier);
  return {
    id: String(a._id),
    reference: a.reference || "",
    createdAt: a.createdAt,
    company: a.legalName || "",
    tradingName: a.tradingName || "",
    contactName: a.repName || "",
    contactTitle: a.repTitle || "",
    email: a.repEmail || "",
    boothTier: a.boothTier || "",
    boothLabel: booth ? `${booth.label} (${booth.size})` : a.boothTier || "",
    netPayable: booth?.pay ?? null,
    deposit: {
      status: depositStatus(a),
      amount: a.depositAmount ?? null,
      currency: a.depositCurrency || "CAD",
      paidAt: a.depositPaidAt || null,
    },
    status: a.status || "new",
    hasNotes: !!a.notes,
    spam: !!a.spam,
    spamReason: a.spamReason || "",
    emailStatus: a.emailStatus || "",
  };
}

/** Display value for one field in the drawer / CSV. */
export function displayValue(f, v) {
  if (f.type === "bool") return v ? "Yes" : "No";
  if (f.type === "yesno") return v === "yes" ? "Yes" : v === "no" ? "No" : "";
  if (f.key === "boothTier") {
    const b = boothOf(v);
    return b ? `${b.label} booth, ${b.size}, net payable CAD $${b.pay.toLocaleString("en-CA")}` : v || "";
  }
  if (f.key === "programmeInterests") return (v || []).map((k) => PROGRAMME_LABELS[k] || k).join(", ");
  return v == null ? "" : String(v);
}

/** Everything about one application: labelled sections in form order + extras. */
export function applicationDetail(a) {
  const sections = SECTIONS.map((s) => ({
    id: s.id,
    title: s.title,
    fields: s.fields.map(([key, label, type]) => ({ key, label, type, value: displayValue({ key, type }, a[key]) })),
  }));
  const extra = Object.entries(a.raw || {}).map(([key, v]) => ({
    key, label: key, type: "text", value: typeof v === "boolean" ? (v ? "Yes" : "No") : Array.isArray(v) ? v.join(", ") : String(v ?? ""),
  }));
  if (extra.length) sections.push({ id: "extra", title: "Other answers", fields: extra });
  return {
    ...applicationRow(a),
    notes: a.notes || "",
    sections,
    meta: {
      page: a.page || "",
      userAgent: a.userAgent || "",
      clientSubmittedAt: a.clientSubmittedAt || null,
      fillMs: a.fillMs ?? null,
      salesNotified: !!a.salesNotified,
      confirmationSent: !!a.confirmationSent,
      emailError: a.emailError || "",
      statusChangedAt: a.statusChangedAt || null,
      lastEditedBy: a.lastEditedBy || "",
      lastEditedAt: a.lastEditedAt || null,
      depositMatchedBy: a.depositMatchedBy || "",
      depositStripeId: a.depositStripeId || "",
      depositTotal: a.depositTotal ?? null,
      depositRefunded: a.depositRefunded || 0,
    },
  };
}

/** A deposit nobody's application matched (shown above the table). */
export function depositRow(d) {
  return {
    id: String(d._id || d.stripeSessionId),
    stripeSessionId: d.stripeSessionId,
    companyName: d.companyName === DEPOSIT_PLACEHOLDER_COMPANY ? "" : d.companyName || "",
    email: d.contactEmail || d.email || "",
    name: d.name || "",
    applicationRef: d.applicationRef && d.applicationRef !== "N/A" ? d.applicationRef : "",
    amount: d.amount ?? null,
    total: d.total ?? null,
    refunded: d.refunded || 0,
    currency: d.currency || "CAD",
    paidAt: d.paidAt || null,
    applicationId: d.applicationId ? String(d.applicationId) : "",
    matchedBy: d.matchedBy || "",
  };
}

/* ---------- CSV ---------- */
const utc = (d) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 19) : "");

export const CSV_HEAD = [
  "Submitted (UTC)", "Reference", "Status",
  ...FIELDS.map((f) => f.label === "Name" || f.label === "Title" || f.label === "Email" || f.label === "Mobile" ? `Representative ${f.label.toLowerCase()}` : f.label),
  "Net payable (CAD)", "Deposit", "Deposit amount", "Deposit paid (UTC)", "Stripe session", "Staff notes", "Other answers", "Bot flag",
];

export function applicationsCsv(rows) {
  const lines = rows.map((a) => {
    const r = applicationRow(a);
    const dep = r.deposit.status === "unpaid" ? "Unpaid" : r.deposit.status === "refunded" ? "Refunded" : "Paid";
    return [
      utc(a.createdAt), r.reference, STATUS_LABEL[r.status] || r.status,
      ...FIELDS.map((f) => (f.key === "boothTier" ? r.boothLabel : displayValue(f, a[f.key]))),
      r.netPayable ?? "", dep, r.deposit.amount ?? "", utc(r.deposit.paidAt), a.depositStripeId || "",
      a.notes || "", Object.keys(a.raw || {}).length ? JSON.stringify(a.raw) : "", a.spam ? a.spamReason || "Yes" : "",
    ].map(csvCell).join(",");
  });
  return "﻿" + [CSV_HEAD.map(csvCell).join(","), ...lines].join("\n");
}
