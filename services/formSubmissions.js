/* =========================================================
   Website form submissions (volunteer, speaker, booth, sponsor,
   partnership and general enquiries)
   ---------------------------------------------------------
   These forms used EmailJS until Oct 2026, when its Gmail link
   broke and every submission was lost. Now routes/forms.js saves
   each one (FormSubmission) and then emails it to FORMS_INBOX.
   Staff see them in Admin → Leads → Form submissions
   (routes/console.js).

   Everything here is pure so it can be unit-tested
   (test/form-submissions.test.js): the form list, validation,
   bot checks, the notification email, the admin rows, the CSV and
   the import of submissions recovered from EmailJS's history.
========================================================= */

import { cleanText, cleanPage, cleanReferrer, isHoneypotFilled, botReason, csvCell } from "./brochureDownloads.js";
import { cleanLong } from "./pavilionApplications.js";

export { isHoneypotFilled };

export const FORMS_INBOX = "baldeep@thetechfestival.com";

/* One entry per website form. Keep in step with the website
   (techfest-canada-frontend: each form POSTs to /api/forms/<key>). */
export const FORMS = {
  volunteer: { label: "Volunteer application", tag: "Volunteer", where: "/volunteer", requireEmail: true, messageLabel: "Why they want to volunteer" },
  speaker: { label: "Speaker application", tag: "Speaker", where: "/speakers", requireEmail: true },
  exhibit: { label: "Booth enquiry", tag: "Exhibit", where: "/exhibit", requireEmail: true, messageLabel: "Goals" },
  // The sponsor pop-up never required an email (phone-only leads happen), so neither does this.
  sponsor: { label: "Sponsor enquiry", tag: "Sponsor", where: "/sponsor", requireEmail: false },
  partnership: { label: "Institutional partnership enquiry", tag: "Partnership", where: "/partners2026", requireEmail: true, requireMessage: true },
  inquiry: { label: "General enquiry", tag: "Enquiry", where: "Site-wide “Inquire” pop-up", requireEmail: true, requireMessage: true },
};
export const FORM_KEYS = Object.keys(FORMS);
export const isForm = (k) => typeof k === "string" && Object.prototype.hasOwnProperty.call(FORMS, k);

export const STATUSES = ["new", "contacted", "accepted", "declined", "archived"];
export const STATUS_LABEL = { new: "New", contacted: "Contacted", accepted: "Accepted", declined: "Declined", archived: "Archived" };
export const SOURCES = ["website", "recovered"];

/* Main columns. Longer text is cut, not refused, so a real enquiry is never
   lost over a long answer. */
export const MAX_LENGTH = {
  name: 160, firstName: 80, lastName: 80, email: 254, phone: 40, company: 160, jobTitle: 120, message: 5000,
};
const CORE_KEYS = Object.keys(MAX_LENGTH);
const LABELS = {
  name: "Name", firstName: "First name", lastName: "Last name", email: "Email", phone: "Phone",
  company: "Company", jobTitle: "Job title", message: "Message",
};

// Sent by the forms for us, not by the visitor
const META_KEYS = new Set(["_hp", "elapsedMs", "page", "referrer", "form", "fields", "submittedAt"]);

/* Extra fields: anything else the form sends, made safe for Mongo (plain keys
   only, no "$" / "." / __proto__) and kept small. */
export const FIELDS_MAX_KEYS = 30;
export const FIELD_MAX_LENGTH = 2000;
export const FIELDS_MAX_TOTAL = 12000;

// Nice labels for the extra fields the website sends today; others are worked out from the key.
const FIELD_LABELS = {
  preferredRole1: "Preferred role 1", preferredRole2: "Preferred role 2",
  industry: "Industry", experience: "Speaking experience", linkedin: "LinkedIn",
  booth: "Booth", boothSpecs: "Booth size",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Names go into the email subject; links there are spam.
const LINKISH_RE = /(https?:\/\/|www\.|<|>)/i;
const FIELD_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** "preferredRole1" → "Preferred role 1", "booth_specs" → "Booth specs". */
export function fieldLabel(key) {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  const words = String(key).replace(/_/g, " ").replace(/([a-z])([A-Z0-9])/g, "$1 $2").replace(/\s+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function fieldValue(v) {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "string") return cleanLong(v).slice(0, FIELD_MAX_LENGTH);
  if (Array.isArray(v)) {
    return v.slice(0, 20).map((x) => (typeof x === "string" || typeof x === "number" ? cleanText(x) : "")).filter(Boolean).join(", ").slice(0, FIELD_MAX_LENGTH);
  }
  return ""; // nested objects are dropped
}

/**
 * Every other field the form sent, from `body.fields` and unknown top-level keys.
 * Values become trimmed text; empty ones are dropped. Capped in count and size.
 */
export function cleanFields(body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const nested = b.fields && typeof b.fields === "object" && !Array.isArray(b.fields) ? b.fields : {};
  const out = {};
  let n = 0, size = 0;
  const add = (k, v) => {
    if (n >= FIELDS_MAX_KEYS || FORBIDDEN_KEYS.has(k) || !FIELD_KEY_RE.test(k) || CORE_KEYS.includes(k) || META_KEYS.has(k)) return;
    if (Object.prototype.hasOwnProperty.call(out, k)) return;
    const s = fieldValue(v);
    if (!s || size + s.length > FIELDS_MAX_TOTAL) return;
    out[k] = s;
    n += 1;
    size += s.length;
  };
  for (const [k, v] of Object.entries(nested)) add(k, v);
  for (const [k, v] of Object.entries(b)) add(k, v);
  return out;
}

/** "Jane Mary Doe" → ["Jane", "Mary Doe"]. */
export function splitName(name) {
  const parts = cleanText(name).split(" ").filter(Boolean);
  return [parts[0] || "", parts.slice(1).join(" ")];
}

/** What the person typed, cleaned. Shared by the website and the import. */
function cleanCore(b) {
  const v = {};
  for (const k of CORE_KEYS) {
    v[k] = (k === "message" ? cleanLong(b[k]) : cleanText(b[k])).slice(0, MAX_LENGTH[k]);
  }
  v.email = v.email.toLowerCase();
  if (!v.name) v.name = [v.firstName, v.lastName].filter(Boolean).join(" ").slice(0, MAX_LENGTH.name);
  if (!v.firstName && !v.lastName && v.name) [v.firstName, v.lastName] = splitName(v.name).map((s) => s.slice(0, 80));
  return v;
}

/**
 * Check what a website form sent to POST /api/forms/:form.
 * @returns {{ ok: true, value: object } | { ok: false, error: string, field: string, status?: number }}
 */
export function validateFormSubmission(form, body) {
  const fail = (field, error, status = 400) => ({ ok: false, field, error, status });
  if (!isForm(form)) return fail("form", "Unknown form", 404);
  const cfg = FORMS[form];
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const v = cleanCore(b);

  if (!v.name) return fail(b.firstName !== undefined || b.lastName !== undefined ? "firstName" : "name", "Name is required");
  if (cfg.requireEmail && !v.email) return fail("email", "Email is required");
  if (v.email && (v.email.length > MAX_LENGTH.email || !EMAIL_RE.test(v.email))) return fail("email", "Enter a valid email address");
  if (cfg.requireMessage && !v.message) return fail("message", "Message is required");
  // Point at the field the visitor actually filled in (name is built from first + last, and vice versa).
  const sent = ["firstName", "lastName", "name"].filter((k) => b[k] !== undefined);
  for (const k of [...sent, "firstName", "lastName", "name"]) {
    if (LINKISH_RE.test(v[k])) return fail(k, `${LABELS[k]} can't contain links`);
  }

  const elapsed = Number(b.elapsedMs);
  return {
    ok: true,
    value: {
      form, ...v,
      fields: cleanFields(b),
      page: cleanPage(b.page),
      referrer: cleanReferrer(b.referrer),
      fillMs: b.elapsedMs !== undefined && b.elapsedMs !== "" && Number.isFinite(elapsed) && elapsed >= 0 ? Math.round(elapsed) : undefined,
    },
  };
}

/** Why this submission looks like a bot, or "" (same rules as the brochure form). */
export function formBotReason(v, body = {}) {
  if (isHoneypotFilled(body)) return "hidden field filled";
  const why = botReason({
    firstName: v.firstName || v.name, lastName: v.lastName, company: v.company, jobTitle: v.jobTitle,
  }, body);
  return why.replace("firstName", "first name").replace("lastName", "last name").replace("jobTitle", "job title");
}

/** Who gets the emails. FORMS_INBOX overrides (comma-separate for several). */
export function formsInbox(env = process.env) {
  const list = String(env?.FORMS_INBOX || "").split(",").map((s) => cleanText(s).toLowerCase()).filter((s) => EMAIL_RE.test(s));
  return list.length ? list : [FORMS_INBOX];
}

/* ---------- The email to the inbox ---------- */

/** Escape for HTML text and attributes. */
export function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** An http(s) URL the email may link to, or "" (javascript:, data:, mailto:… are never links). */
export function safeHttpUrl(v) {
  const s = cleanText(v);
  if (!/^https?:\/\//i.test(s)) return "";
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : "";
  } catch {
    return "";
  }
}

/** Rows shown in the email and the admin drawer: [{ key, label, value, type }]. Empty values are left out. */
export function submissionFields(s) {
  const cfg = FORMS[s.form] || {};
  const rows = [];
  const push = (key, label, value, type = "text") => { if (value !== "" && value != null) rows.push({ key, label, value: String(value), type }); };
  const split = s.firstName || s.lastName;
  if (split) {
    push("firstName", "First name", s.firstName);
    push("lastName", "Last name", s.lastName);
  } else push("name", "Name", s.name);
  push("email", "Email", s.email, "email");
  push("phone", "Phone", s.phone);
  push("company", "Company", s.company);
  push("jobTitle", "Job title", s.jobTitle);
  for (const [k, v] of Object.entries(s.fields || {})) push(`fields.${k}`, fieldLabel(k), v, safeHttpUrl(v) ? "url" : "text");
  push("message", cfg.messageLabel || "Message", s.message, "long");
  return rows;
}

function valueHtml(f) {
  if (f.type === "email" && EMAIL_RE.test(f.value)) {
    return `<a href="mailto:${esc(f.value)}" style="color:#7a3fd1;">${esc(f.value)}</a>`;
  }
  if (f.type === "url") {
    const href = safeHttpUrl(f.value);
    if (href) return `<a href="${esc(href)}" style="color:#7a3fd1;" target="_blank" rel="noopener noreferrer">${esc(f.value)}</a>`;
  }
  return esc(f.value).replace(/\n/g, "<br>");
}

const torontoTime = (d) => new Date(d || Date.now()).toLocaleString("en-CA", {
  timeZone: "America/Toronto", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});

/**
 * The notification email for one submission.
 * Every value the visitor typed is escaped; only http(s) links are clickable.
 * @returns {{ subject: string, html: string, text: string, replyTo: string }}
 */
export function buildFormEmail(s, { adminUrl = "" } = {}) {
  const cfg = FORMS[s.form] || { label: "Website form", tag: "Form" };
  const who = cleanText(s.name || [s.firstName, s.lastName].filter(Boolean).join(" ")) || cleanText(s.email) || "Someone";
  const subject = `[${cfg.tag}] ${who}${s.company ? ` (${cleanText(s.company)})` : ""}`.slice(0, 180);
  const rows = submissionFields(s);
  const received = torontoTime(s.createdAt);
  const meta = [
    ["Received", `${received} (Toronto)`],
    s.page ? ["Page", s.page] : null,
    s.referrer ? ["Came from", s.referrer] : null,
  ].filter(Boolean);

  const tr = (label, valueCell) => `<tr>
      <td valign="top" style="padding:10px 14px;border-bottom:1px solid #ece6f7;font:600 13px/1.4 Arial,Helvetica,sans-serif;color:#5b4b7a;width:170px;">${esc(label)}</td>
      <td valign="top" style="padding:10px 14px;border-bottom:1px solid #ece6f7;font:14px/1.5 Arial,Helvetica,sans-serif;color:#1a1033;word-break:break-word;">${valueCell}</td>
    </tr>`;

  const reply = s.email && EMAIL_RE.test(s.email)
    ? `Reply to this email to answer ${esc(who)} directly.`
    : "No email address was given, so replying won't reach them.";

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f1fa;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f1fa;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;background:#ffffff;border-radius:14px;overflow:hidden;">
  <tr><td style="background:#0d0520;padding:20px 24px;">
    <div style="font:800 12px/1.2 Arial,Helvetica,sans-serif;letter-spacing:2px;color:#f5a623;text-transform:uppercase;">TTFC website · ${esc(cfg.label)}</div>
    <div style="font:700 20px/1.3 Arial,Helvetica,sans-serif;color:#ffffff;margin-top:6px;">${esc(who)}</div>
  </td></tr>
  <tr><td style="padding:8px 10px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${rows.map((f) => tr(f.label, valueHtml(f))).join("\n      ")}
    </table>
  </td></tr>
  <tr><td style="padding:16px 24px 6px;font:13px/1.5 Arial,Helvetica,sans-serif;color:#5b4b7a;">${reply}</td></tr>
  <tr><td style="padding:0 10px 8px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${meta.map(([l, v]) => `<tr><td style="padding:4px 14px;font:12px/1.4 Arial,Helvetica,sans-serif;color:#8a7fa3;width:170px;">${esc(l)}</td><td style="padding:4px 14px;font:12px/1.4 Arial,Helvetica,sans-serif;color:#8a7fa3;word-break:break-all;">${esc(v)}</td></tr>`).join("\n      ")}
    </table>
  </td></tr>
  <tr><td style="padding:12px 24px 22px;font:12px/1.5 Arial,Helvetica,sans-serif;color:#8a7fa3;border-top:1px solid #ece6f7;">
    Saved in the TTFC admin panel under Leads → Form submissions${safeHttpUrl(adminUrl) ? ` (<a href="${esc(safeHttpUrl(adminUrl))}" style="color:#7a3fd1;">open</a>)` : ""}.
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = [
    `${cfg.label}: ${who}`,
    "",
    ...rows.map((f) => (f.type === "long" ? `${f.label}:\n${f.value}` : `${f.label}: ${f.value}`)),
    "",
    ...meta.map(([l, v]) => `${l}: ${v}`),
    "",
    "Saved in the TTFC admin panel under Leads → Form submissions.",
  ].join("\n");

  return { subject, html, text, replyTo: s.email && EMAIL_RE.test(s.email) ? s.email : "" };
}

/* ---------- Admin panel ---------- */

const escRx = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

/** Mongo filter for the admin list: ?form= &status= &q= (name, email, phone, company, job title, message). */
export function submissionsFilter({ form, status, q } = {}) {
  const filter = {};
  const f = cleanText(form);
  if (isForm(f)) filter.form = f;
  const st = cleanText(status);
  if (STATUSES.includes(st)) filter.status = st === "new" ? { $in: ["new", null] } : st;
  const s = cleanText(q).slice(0, 100);
  if (s) {
    const rx = escRx(s);
    const or = ["name", "firstName", "lastName", "email", "phone", "company", "jobTitle", "message"].map((k) => ({ [k]: rx }));
    const parts = s.split(" ");
    if (parts.length > 1) or.push({ firstName: escRx(parts[0]), lastName: escRx(parts.slice(1).join(" ")) });
    filter.$or = or;
  }
  return filter;
}

/** One line of what they asked about, for the table. */
export function summaryOf(s, max = 120) {
  const f = s.fields || {};
  const bits = {
    volunteer: [f.preferredRole1, f.preferredRole2].filter(Boolean).join(" / "),
    speaker: [s.jobTitle, f.industry].filter(Boolean).join(" · "),
    exhibit: [f.boothSpecs || f.booth].filter(Boolean).join(""),
    sponsor: [s.company, s.jobTitle, f.industry].filter(Boolean).join(" · "),
  }[s.form] || "";
  const msg = cleanText(s.message);
  const out = [bits, msg].filter(Boolean).join(" — ");
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}

/** What the admin table gets for one submission. */
export function submissionRow(s) {
  return {
    id: String(s._id),
    form: s.form,
    formLabel: FORMS[s.form]?.label || s.form || "",
    name: s.name || [s.firstName, s.lastName].filter(Boolean).join(" "),
    email: s.email || "", phone: s.phone || "", company: s.company || "",
    summary: summaryOf(s),
    status: s.status || "new",
    hasNotes: !!cleanText(s.notes),
    source: s.source || "website",
    emailStatus: s.emailStatus || "",
    spam: !!s.spam,
    createdAt: s.createdAt,
  };
}

/** Everything about one submission, for the drawer. */
export function submissionDetail(s) {
  return {
    ...submissionRow(s),
    firstName: s.firstName || "", lastName: s.lastName || "", jobTitle: s.jobTitle || "",
    message: s.message || "",
    fields: submissionFields(s),
    notes: s.notes || "",
    spamReason: s.spamReason || "",
    meta: {
      page: s.page || "", referrer: s.referrer || "", userAgent: s.userAgent || "",
      fillMs: s.fillMs ?? null,
      emailTo: s.emailTo || [], emailedAt: s.emailedAt || null, emailError: s.emailError || "",
      updatedBy: s.updatedBy || "", statusChangedAt: s.statusChangedAt || null, updatedAt: s.updatedAt || null,
    },
  };
}

/** Staff edit in the drawer: { status?, notes? }. */
export function cleanSubmissionPatch(body) {
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

export const CSV_HEAD = [
  "Received (UTC)", "Form", "Name", "First name", "Last name", "Email", "Phone", "Company", "Job title",
  "Message", "Other fields", "Status", "Notes", "Source", "Emailed", "Page", "Referrer",
];

const EMAIL_LABEL = { sent: "Sent", sending: "Sending", failed: "Failed", blocked: "Not sent (bot)", skipped: "Not sent (recovered)" };

/** Spreadsheet of submissions. Every cell goes through csvCell (formula-escaped). */
export function submissionsCsv(rows) {
  const lines = rows.map((s) => [
    s.createdAt ? new Date(s.createdAt).toISOString().replace("T", " ").slice(0, 19) : "",
    FORMS[s.form]?.label || s.form || "",
    s.name || "", s.firstName || "", s.lastName || "", s.email || "", s.phone || "", s.company || "", s.jobTitle || "",
    s.message || "",
    Object.entries(s.fields || {}).map(([k, v]) => `${fieldLabel(k)}: ${v}`).join("\n"),
    STATUS_LABEL[s.status || "new"] || s.status,
    s.notes || "",
    s.source === "recovered" ? "Recovered from EmailJS" : "Website",
    EMAIL_LABEL[s.emailStatus] || s.emailStatus || "",
    s.page || "", s.referrer || "",
  ].map(csvCell).join(","));
  return "﻿" + [CSV_HEAD.map(csvCell).join(","), ...lines].join("\n");
}

/* ---------- Import (submissions recovered from EmailJS's history) ---------- */

export const IMPORT_MAX_ROWS = 500;

/**
 * One recovered row → a document to save, or an error.
 * Row: { form, name, email, phone, company, message, fields, receivedAt } (firstName/lastName/jobTitle also accepted).
 * Saved with source "recovered" and createdAt = receivedAt; never emailed.
 */
export function mapImportRow(row) {
  const fail = (error) => ({ ok: false, error });
  if (!row || typeof row !== "object" || Array.isArray(row)) return fail("Row must be an object");
  const form = cleanText(row.form).toLowerCase();
  if (!isForm(form)) return fail(`Unknown form "${cleanText(row.form).slice(0, 40)}"`);
  const received = new Date(typeof row.receivedAt === "number" ? row.receivedAt : cleanText(row.receivedAt));
  if (!cleanText(String(row.receivedAt ?? "")) || Number.isNaN(received.getTime())) return fail("receivedAt must be a date");
  if (received.getTime() > Date.now() + 24 * 60 * 60 * 1000) return fail("receivedAt is in the future");
  const v = cleanCore(row);
  if (!v.name && !v.email) return fail("Needs a name or an email");
  if (v.email && !EMAIL_RE.test(v.email)) return fail("Email isn't valid");
  return {
    ok: true,
    doc: {
      form, ...v,
      fields: cleanFields({ fields: row.fields }),
      source: "recovered",
      status: "new",
      emailStatus: "skipped",
      spam: false,
      createdAt: received,
    },
  };
}

/** Same form + email + receivedAt → the same submission. */
export const importKey = (d) => `${d.form}|${(d.email || "").toLowerCase()}|${new Date(d.createdAt).toISOString()}`;

/**
 * Map a whole import body. Rows already in `existingKeys` (or repeated in the
 * body) are skipped as duplicates.
 * @returns {{ ok: boolean, error?: string, docs: object[], skipped: {index:number, reason:string}[] }}
 */
export function planImport(body, existingKeys = new Set()) {
  const rows = body?.rows;
  if (!Array.isArray(rows)) return { ok: false, error: "Send { rows: [...] }", docs: [], skipped: [] };
  if (!rows.length) return { ok: false, error: "No rows to import", docs: [], skipped: [] };
  if (rows.length > IMPORT_MAX_ROWS) return { ok: false, error: `At most ${IMPORT_MAX_ROWS} rows at a time`, docs: [], skipped: [] };
  const seen = new Set(existingKeys);
  const docs = [], skipped = [];
  rows.forEach((row, index) => {
    const m = mapImportRow(row);
    if (!m.ok) return skipped.push({ index, reason: m.error });
    const key = importKey(m.doc);
    if (seen.has(key)) return skipped.push({ index, reason: "duplicate" });
    seen.add(key);
    docs.push(m.doc);
  });
  return { ok: true, docs, skipped };
}
