/* What a buyer told us on the website checkout form, saved with their ticket.

   The form's answers ride to Stripe as Checkout Session metadata (string
   values, max 500 chars each) and come back on checkout.session.completed.
   detailsFromMetadata() turns them into the stored shape; it is also used
   to backfill tickets bought before details were saved. Pure, unit-tested. */

const TEXT_FIELDS = [
  "salutation", "firstName", "lastName", "jobTitle", "organisation", "phone",
  "country", "linkedin", "jobLevel", "jobFunction",
];

const str = (v) => String(v ?? "").trim();
// Lists travel as "A; B" (topic names contain commas, e.g. "Banking, Financial Services & Insurance")
const list = (v) => (Array.isArray(v) ? v : String(v ?? "").split(";"))
  .map((x) => String(x).trim()).filter(Boolean);
const yes = (v) => v === true || /^(true|yes|1)$/i.test(str(v));

/** Stripe metadata (or the raw form) → stored details, or null when nothing was given. */
export function detailsFromMetadata(meta) {
  if (!meta || typeof meta !== "object") return null;
  const out = {};
  for (const k of TEXT_FIELDS) {
    const v = str(meta[k] ?? (k === "phone" ? meta.businessNumber : undefined));
    if (v) out[k] = v;
  }
  // "Other" job level carries its own description
  if (out.jobLevel === "Other" && str(meta.jobLevelOther)) out.jobLevel = `Other: ${str(meta.jobLevelOther)}`;
  const topics = list(meta.topics), objectives = list(meta.objectives);
  if (topics.length) out.topics = topics;
  if (objectives.length) out.objectives = objectives;
  if (meta.consentTerms !== undefined) out.consentTerms = yes(meta.consentTerms);
  if (meta.consentUpdates !== undefined) out.consentUpdates = yes(meta.consentUpdates);
  if (!Object.keys(out).length) return null;
  out.source = "checkout";
  return out;
}

/** "Jane Doe" from the details, falling back to the card-holder name Stripe collected. */
export function displayName(details, fallback = "") {
  const n = [details?.firstName, details?.lastName].filter(Boolean).join(" ").trim();
  return n || str(fallback);
}

/** Flat columns for the staff CSV export. */
export const DETAIL_COLUMNS = [
  ["salutation", "Salutation"], ["firstName", "First name"], ["lastName", "Last name"],
  ["jobTitle", "Job title"], ["organisation", "Organisation"], ["phone", "Phone"],
  ["country", "Country"], ["linkedin", "LinkedIn"], ["jobLevel", "Job level"],
  ["jobFunction", "Job function"], ["topics", "Topics"], ["objectives", "Objectives"],
  ["consentUpdates", "Agreed to updates"], ["notes", "Staff notes"],
];

/* ---------- Organisation from a work email ----------
   Shown to staff as a hint ("from email") when the buyer didn't give a
   company. Personal mailboxes give no hint. */
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "live.ca", "msn.com",
  "yahoo.com", "yahoo.ca", "yahoo.co.in", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com",
  "proton.me", "protonmail.com", "gmx.com", "mail.com", "zoho.com", "rogers.com", "bell.net", "sympatico.ca", "shaw.ca", "telus.net",
]);
const KNOWN_ORGS = {
  "nbc.ca": "National Bank of Canada", "bnc.ca": "National Bank of Canada",
  "uwo.ca": "Western University", "brocku.ca": "Brock University", "utoronto.ca": "University of Toronto",
  "yorku.ca": "York University", "torontomu.ca": "Toronto Metropolitan University", "uwaterloo.ca": "University of Waterloo",
  "mcmaster.ca": "McMaster University", "queensu.ca": "Queen's University", "uottawa.ca": "University of Ottawa",
  "ised-isde.gc.ca": "Innovation, Science and Economic Development Canada",
  "feddevontario.gc.ca": "FedDev Ontario", "international.gc.ca": "Global Affairs Canada", "ontario.ca": "Government of Ontario",
  "rbc.com": "RBC", "td.com": "TD Bank", "scotiabank.com": "Scotiabank", "bmo.com": "BMO", "cibc.com": "CIBC",
};

/** "jane@sub.deepcovecyber.com" → "deepcovecyber.com"; "" for personal mailboxes. */
export function workDomain(email) {
  const d = String(email || "").trim().toLowerCase().split("@")[1] || "";
  if (!d || FREE_MAIL.has(d)) return "";
  const known = Object.keys(KNOWN_ORGS).find((k) => d === k || d.endsWith("." + k));
  if (known) return known;
  const parts = d.split(".");
  // keep two labels, or three for country second-levels like co.uk / gc.ca / on.ca
  const keep = parts.length > 2 && /^(co|com|gc|on|org|ac|gov|net)$/.test(parts[parts.length - 2]) ? 3 : 2;
  return parts.slice(-keep).join(".");
}

/** Best guess at the organisation from a work email: a known name, else the domain. */
export function orgFromEmail(email) {
  const domain = workDomain(email);
  return domain ? (KNOWN_ORGS[domain] || domain) : "";
}

/* ---------- Staff edits ---------- */
export const EDITABLE_FIELDS = ["organisation", "jobTitle", "phone", "linkedin", "country", "notes"];

/** Whitelists a staff edit: trimmed strings, "" clears a field. */
export function cleanStaffEdit(body) {
  const out = {};
  for (const k of EDITABLE_FIELDS) {
    if (body?.[k] === undefined) continue;
    out[k] = String(body[k] ?? "").trim().slice(0, k === "notes" ? 2000 : 300);
  }
  return out;
}

/** Applies a staff edit on top of stored details (empty values removed). */
export function mergeStaffEdit(details, edit) {
  const next = { ...(details || {}) };
  for (const [k, v] of Object.entries(edit)) {
    if (v) next[k] = v; else delete next[k];
  }
  if (Object.keys(edit).length) next.editedByStaff = true;
  return next;
}
