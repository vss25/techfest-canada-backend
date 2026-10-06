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
  ["consentUpdates", "Agreed to updates"],
];
