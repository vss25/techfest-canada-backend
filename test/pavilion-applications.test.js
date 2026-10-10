import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SECTIONS, FIELDS, STATUSES, BOOTH_LABELS, validatePavilionApplication, extraFields, cleanLong, pavilionBotReason,
  makeReference, normalizeCompany, depositFromSession, depositFromStripeRow, matchDeposit, depositFieldsFor, depositStatus,
  applicationsFilter, cleanPatch, applicationRow, applicationDetail, depositRow, applicationsCsv, isHoneypotFilled,
} from "../services/pavilionApplications.js";
import { rowFromSession } from "../services/stripeSales.js";

// What src/pages/IndiaPavilion.jsx sends (EMPTY_FORM filled in) + submittedAt / page / _hp / elapsedMs.
const FORM = {
  legalName: " Acme Technologies Private Limited ", tradingName: "Acme", cin: "U72900DL2020PTC012345", incorporationDate: "2020-04-01",
  registeredOffice: "12 MG Road\r\nBengaluru 560001", website: "https://acme.in", linkedIn: "linkedin.com/company/acme",
  yearFounded: "2020", employees: "15",
  isIndian: "yes", isMcaRegistered: "yes", cinNumber: "U72900DL2020PTC012345", roc: "RoC-Delhi",
  isDpiitRecognised: "no", dpiitNumber: "", isIncubatorEndorsed: "yes", incubator: "T-Hub",
  hasCanadianOps: "no", canadianPresence: "", businessStage: "Seed", otherStage: "",
  latestFunding: "Seed, $2M", annualRevenue: "INR 4 Cr",
  techDomain: "AI & Machine Learning", sector: "Other", otherSector: "AgriTech",
  companyDescription: "We build crop models.\n\nThey work.", traction: "3 pilots", objective: "Canadian buyers",
  boothTier: "double", programmeInterests: ["b2b", "investor"],
  repName: "Priya Sharma", repTitle: "Founder & CEO", repEmail: " Priya@Acme.IN ", repMobile: "+91 98765 43210",
  secondaryContact: "Rahul, rahul@acme.in", delegate1: "Priya Sharma, CEO", delegate2: "Rahul Kumar, CTO",
  needsVisa: "yes", visaCount: "2",
  declaration1: true, declaration2: true, declaration3: true, declaration4: true, declaration5: true, declaration6: true,
  signatureName: "Priya Sharma", signatureTitle: "Founder & CEO",
  submittedAt: "2026-10-10T12:00:00.000Z", page: "/exhibit/india-pavilion?utm=x", _hp: "", elapsedMs: 600000,
};

/* ---------- fields ---------- */
test("every field the form sends is in the field list, grouped in the form's six steps", () => {
  const formKeys = Object.keys(FORM).filter((k) => !["submittedAt", "page", "_hp", "elapsedMs"].includes(k));
  assert.deepEqual(FIELDS.map((f) => f.key).sort(), formKeys.sort());
  assert.deepEqual(SECTIONS.map((s) => s.id), ["company", "eligibility", "pitch", "booth", "representative", "declaration"]);
});

/* ---------- validation ---------- */
test("a full application is cleaned and every field kept", () => {
  const r = validatePavilionApplication(FORM);
  assert.equal(r.ok, true);
  const v = r.value;
  assert.equal(v.legalName, "Acme Technologies Private Limited");
  assert.equal(v.repEmail, "priya@acme.in");
  assert.equal(v.registeredOffice, "12 MG Road\nBengaluru 560001");
  assert.equal(v.companyDescription, "We build crop models.\n\nThey work.");
  assert.deepEqual(v.programmeInterests, ["b2b", "investor"]);
  assert.equal(v.declaration6, true);
  assert.equal(v.isDpiitRecognised, "no");
  assert.equal(v.page, "/exhibit/india-pavilion");
  assert.equal(v.fillMs, 600000);
  assert.equal(v.clientSubmittedAt.toISOString(), "2026-10-10T12:00:00.000Z");
  for (const f of FIELDS) assert.ok(f.key in v, f.key);
  assert.deepEqual(r.raw, {});
});

test("required fields, booth tier and Indian incorporation keep the old error messages", () => {
  const cases = [
    [{ ...FORM, legalName: " " }, "legalName", /Company name, contact name and email are required/],
    [{ ...FORM, repName: "" }, "repName", /required/],
    [{ ...FORM, repEmail: undefined }, "repEmail", /required/],
    [{ ...FORM, repEmail: "nope" }, "repEmail", /valid email/],
    [{ ...FORM, boothTier: "mega" }, "boothTier", /valid booth tier/],
    [{ ...FORM, boothTier: "" }, "boothTier", /valid booth tier/],
    [{ ...FORM, isIndian: "no" }, "isIndian", /Indian-incorporated/],
  ];
  for (const [body, field, msg] of cases) {
    const r = validatePavilionApplication(body);
    assert.equal(r.ok, false, field);
    assert.equal(r.field, field);
    assert.match(r.error, msg);
  }
  assert.equal(validatePavilionApplication(null).ok, false);
  assert.equal(validatePavilionApplication([1]).ok, false);
});

test("over-long answers are cut, not refused; odd types are made safe", () => {
  const r = validatePavilionApplication({
    ...FORM, traction: "x".repeat(9000), tradingName: "y".repeat(900), employees: { $gt: 1 },
    declaration1: "true", declaration2: "nope", isMcaRegistered: "YES", programmeInterests: "b2b", boothTier: "Double",
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.traction.length, 5000);
  assert.equal(r.value.tradingName.length, 300);
  assert.equal(r.value.employees, "");
  assert.equal(r.value.declaration1, true);
  assert.equal(r.value.declaration2, false);
  assert.equal(r.value.isMcaRegistered, "yes");
  assert.deepEqual(r.value.programmeInterests, ["b2b"]);
  assert.equal(r.value.boothTier, "double");
});

test("fields the form doesn't know yet are kept in raw, safely", () => {
  const r = validatePavilionApplication({ ...FORM, referralCode: " INDIA25 ", newsletter: true, "$where": "x", "a.b": 1, tags: ["a", { b: 1 }], nested: { x: 1 } });
  assert.deepEqual(r.raw, { referralCode: "INDIA25", newsletter: true, tags: ["a", '{"b":1}'], nested: '{"x":1}' });
  const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`f${i}`, "v"]));
  assert.equal(Object.keys(extraFields(many)).length, 40);
});

test("cleanLong keeps paragraphs but strips control characters", () => {
  assert.equal(cleanLong("  a\u0007b  \r\n\r\n\r\n\r\n  c  "), "a b\n\nc");
  assert.equal(cleanLong(null), "");
  assert.equal(cleanLong({}), "");
});

/* ---------- bots ---------- */
test("bot applications: honeypot, random text and instant fill are caught; real ones are not", () => {
  const v = validatePavilionApplication(FORM).value;
  assert.equal(pavilionBotReason(v, FORM), "");
  assert.equal(pavilionBotReason(v, { ...FORM, _hp: "http://spam" }), "honeypot filled");
  assert.ok(isHoneypotFilled({ _hp: "x" }));
  assert.match(pavilionBotReason({ ...v, legalName: "sBjcqBNbVdtgTqNpaFfxDebP" }, FORM), /random text in company name/);
  assert.match(pavilionBotReason({ ...v, repName: "WVELBrevkzkRIOpPLoSXg" }, FORM), /contact name/);
  assert.match(pavilionBotReason(v, { ...FORM, elapsedMs: 300 }), /too fast/);
  assert.equal(pavilionBotReason(v, { ...FORM, elapsedMs: undefined }), "");
});

test("references are short, readable and random", () => {
  assert.equal(makeReference(Buffer.from([0, 1, 2, 3, 4, 31])), "IP-23456Z");
  assert.match(makeReference(), /^IP-[2-9A-HJ-NP-Z]{6}$/);
  assert.notEqual(makeReference(), makeReference());
});

/* ---------- deposits ---------- */
const SESSION = {
  id: "cs_test_1", payment_status: "paid", payment_intent: "pi_1", currency: "cad", created: 1760000000,
  amount_subtotal: 50000, amount_total: 56500, total_details: { amount_tax: 6500, amount_discount: 0 },
  customer_details: { email: "Accounts@Acme.in", name: "Priya S" },
  metadata: { type: "pavilion-deposit", companyName: "ACME Technologies Pvt. Ltd.", contactEmail: "Priya@Acme.in", applicationRef: "ip-7k3qxm" },
};

test("a paid deposit session becomes a deposit record; other sessions don't", () => {
  const d = depositFromSession(SESSION);
  assert.deepEqual(d, {
    stripeSessionId: "cs_test_1", paymentIntent: "pi_1", email: "accounts@acme.in", name: "Priya S", contactEmail: "priya@acme.in",
    companyName: "ACME Technologies Pvt. Ltd.", applicationRef: "ip-7k3qxm", amount: 500, tax: 65, total: 565, currency: "CAD",
    paidAt: new Date(1760000000 * 1000),
  });
  assert.equal(depositFromSession({ ...SESSION, payment_status: "unpaid" }), null);
  assert.equal(depositFromSession({ ...SESSION, metadata: { type: "booth", tier: "booth-single" } }), null);
  assert.equal(depositFromSession(null), null);
});

test("the revenue page's Stripe rows carry what's needed to backfill deposits", () => {
  const row = rowFromSession(SESSION, new Map([["pi_1", 56500]]));
  assert.equal(row.category, "pavilion");
  assert.deepEqual(row.meta, { companyName: "ACME Technologies Pvt. Ltd.", contactEmail: "priya@acme.in", applicationRef: "ip-7k3qxm" });
  const d = depositFromStripeRow(row);
  assert.equal(d.stripeSessionId, "cs_test_1");
  assert.equal(d.paymentIntent, "pi_1");
  assert.equal(d.amount, 500);
  assert.equal(d.total, 565);
  assert.equal(d.refunded, 565);
  assert.equal(d.contactEmail, "priya@acme.in");
  assert.equal(d.applicationRef, "ip-7k3qxm");
  assert.equal(depositFromStripeRow(rowFromSession({ ...SESSION, metadata: { tier: "vip" } })), null);
  assert.equal(rowFromSession({ ...SESSION, metadata: { tier: "vip" } }).meta, undefined);
});

test("company names are compared without legal suffixes and punctuation", () => {
  assert.equal(normalizeCompany("Acme Technologies Pvt. Ltd."), "acme technologies");
  assert.equal(normalizeCompany("ACME TECHNOLOGIES PRIVATE LIMITED"), "acme technologies");
  assert.equal(normalizeCompany("R&D Labs LLP"), "r and d labs");
  assert.equal(normalizeCompany(""), "");
});

const app = (over) => ({ _id: over.id, reference: "", repEmail: "", legalName: "", tradingName: "", spam: false, depositStripeId: "", createdAt: new Date("2026-10-01"), ...over });

test("deposits match by reference first, then email, then company name", () => {
  const apps = [
    app({ id: "a", reference: "IP-7K3QXM", repEmail: "other@x.in", legalName: "Other Co" }),
    app({ id: "b", repEmail: "priya@acme.in", legalName: "Something Else" }),
    app({ id: "c", legalName: "Acme Technologies Private Limited" }),
  ];
  const d = depositFromSession(SESSION);
  assert.deepEqual(matchDeposit(d, apps), { app: apps[0], by: "reference" });
  assert.deepEqual(matchDeposit({ ...d, applicationRef: "N/A" }, apps), { app: apps[1], by: "email" });
  assert.deepEqual(matchDeposit({ ...d, applicationRef: "", email: "accounts@acme.in", contactEmail: "" }, apps), { app: apps[2], by: "company" });
  // The Stripe receipt email counts too, not only the one typed on the payment page
  assert.equal(matchDeposit({ ...d, applicationRef: "", contactEmail: "" }, [app({ id: "e", repEmail: "Accounts@acme.in" })]).by, "email");
  // Trading name works
  assert.equal(matchDeposit({ ...d, applicationRef: "", email: "", contactEmail: "", companyName: "acme" }, [app({ id: "t", legalName: "X", tradingName: "Acme" })]).by, "company");
});

test("no match leaves the deposit on its own; the placeholder company never matches", () => {
  const d = { ...depositFromSession(SESSION), applicationRef: "N/A", email: "z@z.in", contactEmail: "", companyName: "Pavilion Applicant" };
  assert.equal(matchDeposit(d, [app({ id: "p", legalName: "Pavilion Applicant" })]), null);
  assert.equal(matchDeposit(d, []), null);
  assert.equal(matchDeposit(null, []), null);
});

test("among several matches: a real one, then one not yet paid, then the newest", () => {
  const d = { ...depositFromSession(SESSION), applicationRef: "" };
  const older = app({ id: "old", repEmail: "priya@acme.in", createdAt: new Date("2026-09-01") });
  const newer = app({ id: "new", repEmail: "priya@acme.in", createdAt: new Date("2026-10-05") });
  const bot = app({ id: "bot", repEmail: "priya@acme.in", spam: true, createdAt: new Date("2026-10-09") });
  const paid = app({ id: "paid", repEmail: "priya@acme.in", depositStripeId: "cs_other", createdAt: new Date("2026-10-08") });
  assert.equal(matchDeposit(d, [older, newer, bot, paid]).app._id, "new");
  assert.equal(matchDeposit(d, [bot]).app._id, "bot");
  // Re-running for the deposit already on the application keeps it there
  assert.equal(matchDeposit(d, [older, { ...paid, depositStripeId: "cs_test_1" }]).app._id, "paid");
});

test("linked deposit fields and deposit status", () => {
  const d = depositFromSession(SESSION);
  const set = depositFieldsFor(d, "email");
  assert.deepEqual(set, {
    depositPaid: true, depositAmount: 500, depositTotal: 565, depositRefunded: 0, depositCurrency: "CAD",
    depositPaidAt: d.paidAt, depositStripeId: "cs_test_1", depositMatchedBy: "email",
  });
  assert.equal(depositStatus({}), "unpaid");
  assert.equal(depositStatus(set), "paid");
  assert.equal(depositStatus({ ...set, depositRefunded: 565 }), "refunded");
});

/* ---------- admin ---------- */
test("search covers company, contact, email, phone and reference; status filters", () => {
  const f = applicationsFilter(" acme.in ", "accepted");
  assert.equal(f.status, "accepted");
  assert.ok(f.$or.some((c) => c.repEmail && c.repEmail.test("priya@acme.in")));
  assert.ok(f.$or.some((c) => c.reference));
  assert.ok(f.$or[0].legalName.test("ACME.IN"));
  assert.ok(!f.$or[0].legalName.test("acmexin")); // "." is literal
  assert.deepEqual(applicationsFilter("", "bogus"), {});
  assert.deepEqual(applicationsFilter(undefined, "new"), { status: "new" });
});

test("staff edits: only known statuses, notes as text", () => {
  for (const s of STATUSES) assert.deepEqual(cleanPatch({ status: s }), { ok: true, set: { status: s } });
  assert.equal(cleanPatch({ status: "paid" }).ok, false);
  assert.deepEqual(cleanPatch({ notes: " Called\r\nback Tue " }), { ok: true, set: { notes: "Called\nback Tue" } });
  assert.deepEqual(cleanPatch({ notes: null }), { ok: true, set: { notes: "" } });
  assert.equal(cleanPatch({ notes: { $set: 1 } }).ok, false);
  assert.equal(cleanPatch({ notes: "x".repeat(5001) }).ok, false);
  assert.equal(cleanPatch({}).ok, false);
  assert.equal(cleanPatch({ status: "new", depositPaid: true }).set.depositPaid, undefined);
});

const SAVED = {
  _id: "64b000000000000000000001", reference: "IP-7K3QXM", createdAt: new Date("2026-10-10T12:00:00Z"),
  ...validatePavilionApplication(FORM).value, raw: { referralCode: "INDIA25" },
  status: "contacted", notes: "Called", emailStatus: "sent", salesNotified: true, confirmationSent: true,
  userAgent: "Mozilla/5.0", ...depositFieldsFor(depositFromSession(SESSION), "reference"),
};

test("table row: date, company, contact, email, booth, deposit, status", () => {
  const r = applicationRow(SAVED);
  assert.equal(r.company, "Acme Technologies Private Limited");
  assert.equal(r.contactName, "Priya Sharma");
  assert.equal(r.email, "priya@acme.in");
  assert.equal(r.boothLabel, "Double (10' × 20')");
  assert.equal(r.netPayable, BOOTH_LABELS.double.pay);
  assert.deepEqual(r.deposit, { status: "paid", amount: 500, currency: "CAD", paidAt: SAVED.depositPaidAt });
  assert.equal(r.status, "contacted");
  assert.equal(applicationRow({ _id: "x", legalName: "A" }).status, "new");
  assert.equal(applicationRow({ _id: "x", legalName: "A" }).deposit.status, "unpaid");
});

test("detail has every field in labelled sections, plus extras and metadata", () => {
  const d = applicationDetail(SAVED);
  const all = d.sections.flatMap((s) => s.fields);
  for (const f of FIELDS) assert.ok(all.some((x) => x.key === f.key), f.key);
  const val = (k) => all.find((x) => x.key === k).value;
  assert.equal(val("boothTier"), "Double booth, 10' × 20', net payable CAD $999");
  assert.equal(val("programmeInterests"), "Curated B2B meetings, Investor / capital introductions");
  assert.equal(val("isIndian"), "Yes");
  assert.equal(val("isDpiitRecognised"), "No");
  assert.equal(val("declaration3"), "Yes");
  assert.equal(val("canadianPresence"), "");
  assert.deepEqual(d.sections.at(-1), { id: "extra", title: "Other answers", fields: [{ key: "referralCode", label: "referralCode", type: "text", value: "INDIA25" }] });
  assert.equal(d.notes, "Called");
  assert.equal(d.meta.userAgent, "Mozilla/5.0");
  assert.equal(d.meta.depositMatchedBy, "reference");
  assert.equal(applicationDetail({ _id: "x", legalName: "A" }).sections.length, SECTIONS.length);
});

test("unmatched deposit row hides placeholder values", () => {
  const r = depositRow({ _id: "d1", ...depositFromSession(SESSION), companyName: "Pavilion Applicant", applicationRef: "N/A" });
  assert.equal(r.companyName, "");
  assert.equal(r.applicationRef, "");
  assert.equal(r.email, "priya@acme.in");
  assert.equal(r.amount, 500);
  assert.equal(r.applicationId, "");
});

test("CSV: BOM, header, every field, formula-escaped", () => {
  const csv = applicationsCsv([{ ...SAVED, legalName: "=HYPERLINK(\"x\")", notes: "+1 call back" }]);
  assert.ok(csv.startsWith("﻿"));
  const lines = csv.slice(1).split("\n");
  assert.match(lines[0], /^Submitted \(UTC\),Reference,Status,Legal name,Trading name/);
  for (const f of FIELDS.filter((x) => !["repName", "repTitle", "repEmail", "repMobile"].includes(x.key))) assert.ok(lines[0].includes(f.label), f.label);
  assert.match(lines[0], /Representative email/);
  const body = lines.slice(1).join("\n");
  assert.match(body, /^2026-10-10 12:00:00,IP-7K3QXM,Contacted,"'=HYPERLINK\(""x""\)",Acme/);
  assert.match(body, /,'\+1 call back,/);
  assert.match(body, /Paid,500,/);
  assert.match(body, /"12 MG Road\nBengaluru 560001"/);
  assert.match(body, /"\{""referralCode"":""INDIA25""\}"/);
});
