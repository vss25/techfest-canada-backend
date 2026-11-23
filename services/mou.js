/* =========================================================
   MOU drafts (memoranda of understanding with community, media and ecosystem partners), Nov 23 2026.
   The organiser: "add offerings like LinkedIn shoutouts, Insta shoutouts, email marketing shoutouts,
   free passes, discounted passes etc. as general offerings, and then customize the offering specific
   to an MOU, such as how many LinkedIn shoutouts, month/day/cadence, and even an offer code. In the
   same MOU, put terms: financial vs non-financial, binding vs non-binding, what the partners should
   be delivering ... target ticket sales that trigger an offering from TTFC ... signing authority ...
   review the draft and export it."

   Pure parts only (no database): the two catalogues' starter items, cleaning what the panel sends,
   wording with placeholders, schedules in words, the review checks and the document every export
   (PDF and Word) is drawn from. Money is whole cents (CAD). Private: MongoDB only, never Sanity.
========================================================= */

import { money, toCents } from "./contracts.js";

/** Which side gives an item: TTFC to the partner, or the partner to TTFC. */
export const SIDES = [
  { key: "ttfc", label: "TTFC offers" },
  { key: "partner", label: "Partner delivers" },
];
const SIDE_KEYS = SIDES.map((s) => s.key);

export const ITEM_CATEGORIES = [
  { key: "linkedin", label: "LinkedIn" },
  { key: "instagram", label: "Instagram" },
  { key: "social", label: "Other social media" },
  { key: "email", label: "Email and newsletters" },
  { key: "passes", label: "Passes" },
  { key: "discount", label: "Discount codes" },
  { key: "tickets", label: "Ticket sales" },
  { key: "branding", label: "Logo and branding" },
  { key: "speaking", label: "Speaking and stage" },
  { key: "other", label: "Other" },
];
const CATEGORY_KEYS = ITEM_CATEGORIES.map((c) => c.key);

/** The details an item asks for on an MOU (the panel shows only these boxes). */
export const ITEM_FIELDS = [
  { key: "qty", label: "How many" },
  { key: "schedule", label: "When" },
  { key: "code", label: "Code" },
  { key: "value", label: "Detail (pass type, discount…)" },
];
const FIELD_KEYS = ITEM_FIELDS.map((f) => f.key);

export const PLACEHOLDERS = [
  { key: "{partner}", label: "the partner's name" },
  { key: "{event}", label: "the event's name" },
  { key: "{qty}", label: "how many" },
  { key: "{s}", label: "an s when how many isn't 1 (post{s})" },
  { key: "{es}", label: "es when how many isn't 1 (pass{es})" },
  { key: "{when}", label: "the dates or cadence in words" },
  { key: "{code}", label: "the code" },
  { key: "{value}", label: "the detail" },
];

/* The starting catalogue (the super admin adds it with one click, then edits it). */
export const STARTER_ITEMS = [
  // What TTFC offers
  { side: "ttfc", category: "linkedin", name: "LinkedIn shoutout", fields: ["qty", "schedule"], qty: 2,
    wording: "TTFC will feature {partner} in {qty} LinkedIn post{s} on the TTFC company page{when}." },
  { side: "ttfc", category: "instagram", name: "Instagram shoutout", fields: ["qty", "schedule"], qty: 1,
    wording: "TTFC will feature {partner} in {qty} Instagram post{s} or stor{ies}{when}." },
  { side: "ttfc", category: "email", name: "Email newsletter shoutout", fields: ["qty", "schedule"], qty: 1,
    wording: "TTFC will feature {partner} in {qty} TTFC email newsletter{s}{when}." },
  { side: "ttfc", category: "passes", name: "Free passes", fields: ["qty", "value", "code"], qty: 2, value: "Connect Pass",
    wording: "TTFC will give {partner} {qty} free pass{es} to {event} ({value})." },
  { side: "ttfc", category: "discount", name: "Discounted passes for the partner's community", fields: ["value", "code", "schedule"], value: "15% off",
    wording: "TTFC will give {partner}'s community {value} passes to {event} with the code {code}{when}." },
  { side: "ttfc", category: "branding", name: "Logo on the event website", fields: ["value"], value: "Community Partner",
    wording: "TTFC will show {partner}'s logo on the {event} website as a {value}." },
  { side: "ttfc", category: "speaking", name: "Speaking slot", fields: ["qty", "value"], qty: 1, value: "panel",
    wording: "TTFC will offer {partner} {qty} speaking slot{s} at {event} ({value})." },
  { side: "ttfc", category: "branding", name: "Mention from the stage", fields: [],
    wording: "TTFC will thank {partner} from the stage at {event}." },
  // What the partner delivers
  { side: "partner", category: "linkedin", name: "LinkedIn shoutout", fields: ["qty", "schedule"], qty: 2,
    wording: "{partner} will share {qty} LinkedIn post{s} promoting {event}{when}." },
  { side: "partner", category: "instagram", name: "Instagram shoutout", fields: ["qty", "schedule"], qty: 1,
    wording: "{partner} will share {qty} Instagram post{s} or stor{ies} promoting {event}{when}." },
  { side: "partner", category: "email", name: "Email newsletter shoutout", fields: ["qty", "schedule"], qty: 1,
    wording: "{partner} will feature {event} in {qty} email newsletter{s} to its members{when}." },
  { side: "partner", category: "discount", name: "Share a ticket discount code", fields: ["code", "value", "schedule"], value: "15% off",
    wording: "{partner} will promote the code {code} ({value}) to its community{when}." },
  { side: "partner", category: "tickets", name: "Ticket sales target", fields: ["qty", "code"], qty: 25,
    wording: "{partner} will aim to sell {qty} ticket{s} to {event} with the code {code}." },
  { side: "partner", category: "branding", name: "Logo and description", fields: ["schedule"],
    wording: "{partner} will send its logo and a short description for TTFC's website and materials{when}." },
  { side: "partner", category: "social", name: "Event listing on the partner's website", fields: ["schedule"],
    wording: "{partner} will list {event} on its website or events calendar{when}." },
];

/* Standard MOU clauses, each switched on or off per MOU. A starting point only: have a lawyer review them. */
export const MOU_CLAUSES = [
  { key: "confidentiality", title: "Confidentiality", on: true, body: "Each party will keep the terms of this memorandum and any confidential information it receives from the other party confidential, except where disclosure is required by law." },
  { key: "logos", title: "Use of names and logos", on: true, body: "Each party may use the other's name and logo only to promote the event and as set out in this memorandum, and only in the form the other party approved." },
  { key: "exclusivity", title: "No exclusivity", on: true, body: "This memorandum does not stop either party from working with others, including competitors of the other party." },
  { key: "costs", title: "Costs", on: true, body: "Unless set out under Financial terms, each party pays its own costs of doing what this memorandum describes." },
  { key: "termination", title: "Ending this memorandum", on: true, body: "Either party may end this memorandum by giving the other 14 days' notice in writing. Anything already delivered stays delivered." },
  { key: "changes", title: "Changes", on: true, body: "Changes to this memorandum must be agreed in writing by both parties." },
  { key: "law", title: "Governing law", on: true, body: "This memorandum is governed by the laws of the Province of Ontario and the federal laws of Canada that apply there." },
];

export const STATUSES = [
  { key: "draft", label: "Draft" },
  { key: "review", label: "In review" },
  { key: "exported", label: "Exported" },
];

export const SCHEDULE_MODES = [
  { key: "none", label: "No date" },
  { key: "dates", label: "On these days" },
  { key: "repeat", label: "Repeating" },
  { key: "note", label: "In my own words" },
];
export const REPEAT_EVERY = [
  { key: "week", label: "Every week" },
  { key: "2weeks", label: "Every 2 weeks" },
  { key: "month", label: "Every month" },
];

const str = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const text = (v, max) => String(v ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v) => ISO_DAY.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`));
const noDashes = (s) => String(s || "").replace(/\s*[—–]\s*/g, ", ");

/** "2027-01-15" → "January 15, 2027". */
export const longDay = (iso) => (isDay(iso)
  ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })
  : "");

/** One catalogue item from the panel → { value } | { error }. */
export function cleanItem(body = {}) {
  const side = SIDE_KEYS.includes(body.side) ? body.side : null;
  if (!side) return { error: "Choose who gives it: TTFC or the partner." };
  const name = str(body.name, 120);
  if (!name) return { error: "Give it a name." };
  const fields = [...new Set((Array.isArray(body.fields) ? body.fields : []).filter((f) => FIELD_KEYS.includes(f)))];
  const qty = body.qty === "" || body.qty === null || body.qty === undefined ? null : Number(body.qty);
  if (qty !== null && (!Number.isInteger(qty) || qty < 0 || qty > 100000)) return { error: "How many is a whole number." };
  return { value: {
    side, name,
    category: CATEGORY_KEYS.includes(body.category) ? body.category : "other",
    fields,
    wording: noDashes(text(body.wording, 1000)) || defaultWording(side, name),
    qty, value: str(body.value, 120), code: str(body.code, 40).toUpperCase(),
    active: body.active !== false,
    sort: Number.isFinite(Number(body.sort)) ? Number(body.sort) : 0,
  } };
}

const defaultWording = (side, name) => (side === "ttfc" ? `TTFC will provide ${name}{when}.` : `{partner} will provide ${name}{when}.`);

/** A schedule from the panel → a clean one (never an error: bad days are dropped). */
export function cleanSchedule(s = {}) {
  const mode = SCHEDULE_MODES.some((m) => m.key === s?.mode) ? s.mode : "none";
  const dates = [...new Set((Array.isArray(s?.dates) ? s.dates : []).filter(isDay))].sort().slice(0, 24);
  return {
    mode,
    dates: mode === "dates" ? dates : [],
    every: mode === "repeat" && REPEAT_EVERY.some((r) => r.key === s?.every) ? s.every : (mode === "repeat" ? "month" : ""),
    from: mode === "repeat" && isDay(s?.from) ? s.from : "",
    to: mode === "repeat" && isDay(s?.to) ? s.to : "",
    note: mode === "note" ? noDashes(str(s?.note, 200)) : "",
  };
}

const list = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** A schedule in words, starting with a space (so it can end a sentence), or "". */
export function scheduleText(s = {}) {
  const c = cleanSchedule(s);
  if (c.mode === "dates" && c.dates.length) return ` on ${list(c.dates.map(longDay))}`;
  if (c.mode === "repeat") {
    const every = { week: "every week", "2weeks": "every 2 weeks", month: "every month" }[c.every] || "every month";
    return ` ${every}${c.from ? ` from ${longDay(c.from)}` : ""}${c.to ? ` to ${longDay(c.to)}` : ""}`;
  }
  if (c.mode === "note" && c.note) return ` ${c.note.replace(/^[,.\s]+/, "")}`;
  return "";
}

/** Fill a wording's placeholders. */
export function fillWording(wording, { partner = "", event = "", qty = null, value = "", code = "", schedule = null } = {}) {
  const n = qty === null || qty === undefined || qty === "" ? null : Number(qty);
  const plural = n !== 1;
  return noDashes(String(wording || "")
    .replace(/\{partner\}/g, partner || "the partner")
    .replace(/\{event\}/g, event || "the event")
    .replace(/\{qty\}/g, n === null ? "" : String(n))
    .replace(/\{s\}/g, plural ? "s" : "")
    .replace(/\{es\}/g, plural ? "es" : "")
    .replace(/\{ies\}/g, plural ? "ies" : "y")
    .replace(/\{when\}/g, scheduleText(schedule || {}))
    .replace(/\{code\}/g, code || "[code to be set]")
    .replace(/\{value\}/g, value || ""))
    .replace(/ {2,}/g, " ").replace(/ ([.,)])/g, "$1").replace(/\(\)/g, "").trim();
}

/** One MOU line from the panel, against its catalogue item (or the line's own snapshot) → { value } | { error }. */
export function lineFrom(input = {}, item) {
  if (!item) return { error: "One of the items is no longer in the catalogue." };
  const qty = input.qty === "" || input.qty === null || input.qty === undefined ? (item.qty ?? null) : Number(input.qty);
  if (qty !== null && (!Number.isInteger(qty) || qty < 0 || qty > 100000)) return { error: `${item.name}: how many is a whole number.` };
  const unlockAt = input.unlockAt === "" || input.unlockAt === null || input.unlockAt === undefined ? null : Number(input.unlockAt);
  if (unlockAt !== null && (!Number.isInteger(unlockAt) || unlockAt < 1 || unlockAt > 100000)) return { error: `${item.name}: the ticket milestone is a whole number.` };
  return { value: {
    itemId: String(item.itemId || item._id || ""),
    side: item.side, name: str(input.name, 120) || item.name, category: item.category || "other",
    fields: item.fields || [], baseWording: item.baseWording || item.wording || "",
    qty: (item.fields || []).includes("qty") ? qty : null,
    schedule: cleanSchedule(input.schedule),
    code: str(input.code ?? item.code, 40).toUpperCase(),
    value: str(input.value ?? item.value, 120),
    wording: noDashes(text(input.wording, 1500)),   // "" = the catalogue's wording, filled in
    unlockAt: item.side === "ttfc" ? unlockAt : null, // TTFC gives it only once ticket sales with the partner's code reach this
  } };
}

/** The sentence a line prints as. */
export function lineText(line, { partner, event }) {
  const base = fillWording(line.wording || line.baseWording, { partner, event, qty: line.qty, value: line.value, code: line.code, schedule: line.schedule });
  const sentence = /[.!?]$/.test(base) ? base : `${base}.`;
  return line.unlockAt ? `Once ticket sales with ${partner || "the partner"}'s code reach ${line.unlockAt}: ${sentence}` : sentence;
}

/** The terms from the panel → clean terms (never an error). */
export function cleanTerms(t = {}) {
  const amount = t.financial ? toCents(t.amount) : null;
  const known = new Map((Array.isArray(t.clauses) ? t.clauses : []).map((c) => [c?.key, c]));
  return {
    binding: !!t.binding,
    financial: !!t.financial,
    payer: t.payer === "ttfc" ? "ttfc" : "partner",
    amount: amount ?? null,
    paymentNote: noDashes(text(t.paymentNote, 1000)),
    startDate: isDay(t.startDate) ? t.startDate : "",
    endDate: isDay(t.endDate) ? t.endDate : "",
    purpose: noDashes(text(t.purpose, 1500)),
    clauses: MOU_CLAUSES.map((c) => ({ key: c.key, on: known.has(c.key) ? !!known.get(c.key).on : c.on })),
    custom: noDashes(text(t.custom, 6000)),
  };
}

export const defaultTerms = () => cleanTerms({});

/** Partner signers: up to three people. */
export function cleanSigners(list = []) {
  return (Array.isArray(list) ? list : []).slice(0, 3)
    .map((s) => ({ name: str(s?.name, 120), title: str(s?.title, 120), email: str(s?.email, 160).toLowerCase() }))
    .filter((s) => s.name || s.title || s.email);
}

/** What must be right before review ("block") and what is worth a look ("warn"). */
export function reviewChecks(m, { signatories = [] } = {}) {
  const out = [];
  const add = (level, text) => out.push({ level, text });
  if (!m.partner?.name) add("block", "Add the partner's name.");
  const ttfc = (m.lines || []).filter((l) => l.side === "ttfc"), partner = (m.lines || []).filter((l) => l.side === "partner");
  if (!ttfc.length && !partner.length) add("block", "Tick at least one thing TTFC offers or the partner delivers.");
  else {
    if (!ttfc.length) add("warn", "TTFC offers nothing in this MOU.");
    if (!partner.length) add("warn", "The partner delivers nothing in this MOU.");
  }
  const chosen = (m.ttfcSignatoryIds || []).filter((id) => signatories.some((s) => s.id === id && s.name));
  if (!chosen.length) add("block", "Tick who signs for TTFC.");
  if (!(m.partnerSigners || []).some((s) => s.name)) add("block", "Add who signs for the partner.");
  for (const l of m.lines || []) {
    if (l.fields?.includes("qty") && !l.qty) add("warn", `${l.name}: how many?`);
    if (l.fields?.includes("code") && !l.code) add("warn", `${l.name}: no code yet.`);
    if (l.fields?.includes("schedule") && (!l.schedule || l.schedule.mode === "none")) add("warn", `${l.name}: no date or cadence.`);
  }
  if (m.terms?.financial && !m.terms.amount) add("warn", "Financial terms are on but there's no amount.");
  if (m.terms?.startDate && m.terms?.endDate && m.terms.endDate < m.terms.startDate) add("block", "The end date is before the start date.");
  return out;
}

export const mouNumber = (year, seq, digits = 4) => `MOU-${year}-${String(seq).padStart(digits, "0")}`;

/* ---------------- The document (one model for the PDF and the Word file) ---------------- */

/** → { title, number, dateLabel, banner, parties, sections: [{ title, paras: [{ text, bold?, bullet? }] }], signers } */
export function mouDocument(m, issuer = {}, { final = false } = {}) {
  const co = issuer.company || {};
  const ttfcName = co.legalName || "The Tech Festival Canada";
  const partner = m.partner?.name || "the partner";
  const event = m.eventName || m.eventKey || "the event";
  const ctx = { partner, event };
  const t = { ...defaultTerms(), ...(m.terms || {}) };
  const sections = [];
  const para = (text, extra = {}) => ({ text: noDashes(text), ...extra });

  sections.push({ title: "PURPOSE", paras: [
    para(t.purpose || `${ttfcName} ("TTFC") and ${partner} want to work together to promote ${event}. This memorandum sets out what each party will do.`),
    para(t.binding
      ? "This memorandum is a binding agreement between the parties."
      : "This memorandum records what the parties intend to do. It is not legally binding, except the clauses on confidentiality and use of names and logos, which bind both parties."),
    ...(t.startDate || t.endDate ? [para(`It runs${t.startDate ? ` from ${longDay(t.startDate)}` : ""}${t.endDate ? ` to ${longDay(t.endDate)}` : ""}.`)] : []),
  ] });

  const lines = m.lines || [];
  const ttfcNow = lines.filter((l) => l.side === "ttfc" && !l.unlockAt);
  const ttfcLater = lines.filter((l) => l.side === "ttfc" && l.unlockAt).sort((a, b) => a.unlockAt - b.unlockAt);
  const partnerLines = lines.filter((l) => l.side === "partner");
  if (ttfcNow.length) sections.push({ title: "WHAT TTFC WILL DO", paras: ttfcNow.map((l) => para(lineText(l, ctx), { bullet: true })) });
  if (partnerLines.length) sections.push({ title: `WHAT ${partner.toUpperCase()} WILL DO`, paras: partnerLines.map((l) => para(lineText(l, ctx), { bullet: true })) });
  if (ttfcLater.length) sections.push({ title: "TICKET SALES MILESTONES", paras: [
    para(`Ticket sales are counted on paid passes bought with ${partner}'s code. When a milestone is reached, TTFC will also do the following.`),
    ...ttfcLater.map((l) => para(lineText(l, ctx), { bullet: true })),
  ] });

  sections.push({ title: "FINANCIAL TERMS", paras: t.financial
    ? [para(t.amount
        ? `${t.payer === "ttfc" ? "TTFC" : partner} will pay ${t.payer === "ttfc" ? partner : "TTFC"} ${money(t.amount)} (CAD, plus any applicable tax).`
        : `${t.payer === "ttfc" ? "TTFC" : partner} will pay ${t.payer === "ttfc" ? partner : "TTFC"} an amount to be agreed in writing.`),
       ...(t.paymentNote ? [para(t.paymentNote)] : [])]
    : [para("No money changes hands under this memorandum. Each party covers its own costs.")] });

  if (t.custom) sections.push({ title: "OTHER TERMS AGREED WITH THIS PARTNER", paras: t.custom.split(/\n{2,}/).map((p) => para(p)) });

  const on = new Map((t.clauses || []).map((c) => [c.key, c.on]));
  const clauses = MOU_CLAUSES.filter((c) => (on.has(c.key) ? on.get(c.key) : c.on))
    .filter((c) => !(c.key === "costs" && !t.financial)); // already said under Financial terms
  if (clauses.length) sections.push({ title: "GENERAL", paras: clauses.map((c, i) => para(c.body, { lead: `${i + 1}. ${c.title}. ` })) });

  const signers = [
    ...(m.partnerSigners || []).filter((s) => s.name).map((s) => ({ side: partner, name: s.name, title: s.title, signature: null })),
    ...(issuer.signatories || []).filter((s) => s.name).map((s) => ({ side: ttfcName, name: s.name, title: s.title, signature: final ? s.signature || null : null })),
  ];

  return {
    title: "MEMORANDUM OF UNDERSTANDING",
    number: m.number || "Draft",
    dateLabel: longDay(String(m.exportedAt ? new Date(m.exportedAt).toISOString() : new Date().toISOString()).slice(0, 10)),
    banner: final ? "" : (m.status === "review" ? "DRAFT FOR REVIEW" : "DRAFT"),
    company: co,
    parties: {
      ttfc: [ttfcName, co.address, [co.website, co.email].filter(Boolean).join("  ·  ")].filter(Boolean),
      partner: [partner, m.partner?.address, m.partner?.website,
        [m.contact?.name, m.contact?.title].filter(Boolean).join(", "), m.contact?.email].filter(Boolean),
    },
    event,
    sections,
    signers,
  };
}

/** A file name for an export. */
export const exportName = (m, ext) =>
  `${m.number || "MOU"}-${String(m.partner?.name || "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}.${ext}`.replace(/-\./, ".");
