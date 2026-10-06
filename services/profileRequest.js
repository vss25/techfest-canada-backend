/* =========================================================
   "Complete your attendee profile" — signed links, the public
   form's data, and who staff may email. Pure, unit-tested
   (test/profile-request.test.js).

   Many people bought tickets before the checkout form's answers
   were saved, so staff don't know their job, company or goals.
   Each ticket gets a personal link (no login):

     ${FRONTEND_URL}/complete-profile?t=<ticketId>&s=<sig>

   The signature is an HMAC of the ticket ID with its own purpose
   ("ttfc-profile:v1"), using the same secret as the wallet links
   (WALLET_LINK_SECRET, falling back to JWT_SECRET). A wallet
   signature never works here and vice versa.
========================================================= */

import { signForPurpose, verifyForPurpose, walletLinkSecret } from "./walletLink.js";
import { duplicateKeys } from "./staffTickets.js";
import { displayPassName, firstNameFor } from "./ticketInfo.js";

export const PROFILE_PURPOSE = "ttfc-profile:v1";
const DEFAULT_FRONTEND = "https://www.thetechfestival.com";
const DAY = 864e5;
/** Nobody is emailed twice within this window (unless staff force a single resend). */
export const RESEND_AFTER_MS = 3 * DAY;

export function frontendUrl(env = process.env) {
  return String(env.FRONTEND_URL || DEFAULT_FRONTEND).trim().replace(/\/+$/, "");
}

export const signProfileTicket = (ticketId, secret = walletLinkSecret()) =>
  signForPurpose(PROFILE_PURPOSE, String(ticketId || ""), secret);

export const verifyProfileSig = (ticketId, sig, secret = walletLinkSecret()) =>
  verifyForPurpose(PROFILE_PURPOSE, String(ticketId || ""), sig, secret);

/** False when no signing secret is configured (links can't be made). */
export const profileLinksReady = (secret = walletLinkSecret()) => !!secret;

/** The personal form link for a ticket, or "" when no secret is configured. */
export function profileLink(ticketId, { base = frontendUrl(), secret = walletLinkSecret() } = {}) {
  const sig = signProfileTicket(ticketId, secret);
  if (!sig) return "";
  return `${base}/complete-profile?t=${encodeURIComponent(String(ticketId))}&s=${encodeURIComponent(sig)}`;
}

/** "jane.doe@acme.com" → "ja•••@acme.com" (enough to recognise, not to harvest). */
export function maskEmail(email) {
  const [local = "", domain = ""] = String(email || "").trim().toLowerCase().split("@");
  if (!local || !domain) return "";
  const keep = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${keep}•••@${domain}`;
}

/* ---------- What the public form shows ---------- */

/** Fields the attendee sees and may fill in. Never staff notes or bookkeeping. */
export const PROFILE_FIELDS = [
  "salutation", "firstName", "lastName", "jobTitle", "organisation", "phone", "country", "linkedin",
  "jobLevel", "jobFunction", "topics", "objectives", "consentUpdates",
];

/**
 * What GET /api/complete-profile returns for one ticket.
 * @param {{ name?: string, email?: string, tier?: string, ticketId: string, details?: object }} t
 */
export function publicProfileView({ name = "", email = "", tier = "", ticketId = "", details } = {}) {
  const d = details && typeof details === "object" ? details : {};
  const n = String(name || "").trim();
  const realName = n && n.toLowerCase() !== "guest" ? n : "";
  const [first, ...rest] = realName.split(/\s+/);
  const out = {};
  for (const k of PROFILE_FIELDS) {
    const v = d[k];
    if (Array.isArray(v)) { if (v.length) out[k] = v.filter((x) => typeof x === "string"); }
    else if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  return {
    firstName: out.firstName || firstNameFor({ name: realName }) || "",
    lastName: out.lastName || (first ? rest.join(" ") : ""),
    pass: displayPassName(tier, ticketId),
    email: maskEmail(email),
    details: out,
    completed: !!d.profileCompletedAt,
    completedAt: d.profileCompletedAt || null,
  };
}

/* ---------- Cleaning what the attendee sends ---------- */

const CAPS = {
  salutation: 20, firstName: 80, lastName: 80, jobTitle: 150, organisation: 150, phone: 40,
  country: 80, linkedin: 300, jobLevel: 120, jobFunction: 120,
};
const LIST_CAPS = { topics: 20, objectives: 15 };
// Control characters (incl. newlines) are never useful in a one-line answer.
const oneLine = (v, max) => String(v).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** "linkedin.com/in/jane" → https URL; a bare handle → profile URL; other schemes dropped. */
export function normaliseLinkedin(v) {
  const s = oneLine(v, CAPS.linkedin);
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return "";             // javascript:, data:, mailto: …
  if (/^(www\.)?linkedin\.com\//i.test(s)) return `https://${s.replace(/^www\./i, "www.")}`;
  if (/^@?[\w-]{3,100}$/.test(s)) return `https://www.linkedin.com/in/${s.replace(/^@/, "")}`;
  return s.includes(".") ? `https://${s}` : "";
}

const truthy = (v) => v === true || v === "true";
const falsy = (v) => v === false || v === "false";

/**
 * Whitelists an attendee's form submission.
 * Strings: trimmed, one line, length-capped ("" = left blank).
 * Lists: only plain strings, trimmed, de-duplicated, capped.
 * consentUpdates: only a real true/false.
 */
export function cleanAttendeeSubmission(body) {
  const b = body && typeof body === "object" ? body : {};
  const out = {};
  for (const [k, max] of Object.entries(CAPS)) {
    if (typeof b[k] !== "string" && typeof b[k] !== "number") continue;
    out[k] = k === "linkedin" ? normaliseLinkedin(b[k]) : oneLine(b[k], max);
  }
  if (out.phone) out.phone = out.phone.replace(/[^\d\s+().-]/g, "").trim().slice(0, CAPS.phone);
  // "Other" job level carries its own description (same shape as the checkout form)
  if (out.jobLevel === "Other" && typeof b.jobLevelOther === "string" && oneLine(b.jobLevelOther, 100)) {
    out.jobLevel = `Other: ${oneLine(b.jobLevelOther, 100)}`;
  }
  for (const [k, max] of Object.entries(LIST_CAPS)) {
    if (!Array.isArray(b[k])) continue;
    const seen = new Set();
    out[k] = b[k].filter((x) => typeof x === "string").map((x) => oneLine(x, 120)).filter((x) => {
      if (!x || seen.has(x.toLowerCase())) return false;
      seen.add(x.toLowerCase());
      return true;
    }).slice(0, max);
  }
  if (truthy(b.consentUpdates)) out.consentUpdates = true;
  else if (falsy(b.consentUpdates)) out.consentUpdates = false;
  return out;
}

/** True when the cleaned submission says anything at all. */
export const hasAnswers = (clean) => Object.values(clean || {}).some((v) => (Array.isArray(v) ? v.length : typeof v === "boolean" ? true : !!v));

/**
 * Applies an attendee's answers on top of what we have.
 * Blank answers never erase existing data; staff notes and request
 * bookkeeping are always kept.
 */
export function mergeAttendeeSubmission(details, clean, now = new Date()) {
  const next = { ...(details && typeof details === "object" ? details : {}) };
  for (const [k, v] of Object.entries(clean || {})) {
    if (!PROFILE_FIELDS.includes(k)) continue;
    if (Array.isArray(v)) { if (v.length) next[k] = v; }
    else if (typeof v === "boolean") next[k] = v;
    else if (v) next[k] = v;
  }
  next.source = "attendee";
  next.profileCompletedAt = new Date(now).toISOString();
  return next;
}

/* ---------- Who staff may email ---------- */

/** Missing key details = no job title or no organisation. */
export const missingKeyDetails = (row) =>
  !String(row?.details?.jobTitle || "").trim() || !String(row?.details?.organisation || "").trim();

export const recentlyAsked = (row, now = new Date()) => {
  const at = row?.details?.profileRequestedAt;
  return !!at && new Date(now) - new Date(at) < RESEND_AFTER_MS;
};

/**
 * Splits staff ticket rows into who would be emailed and who is skipped (with why).
 *  - Everyone: visible tickets only, not duplicates, missing key details,
 *    not already completed by the attendee, not asked in the last 3 days.
 *  - `keys`: only those tickets.
 *  - A single key is a deliberate one-off send by staff: it skips the
 *    "already has details" rule, and `force` also allows a resend within
 *    3 days or after the attendee completed it.
 *
 * @returns {{ eligible: object[], skipped: { key: string, reason: string }[] }}
 */
export function planProfileRequests(rows = [], { keys, force = false, now = new Date() } = {}) {
  const dupes = new Set(duplicateKeys(rows));
  const wanted = Array.isArray(keys) && keys.length ? new Set(keys.map(String)) : null;
  const single = !!wanted && wanted.size === 1;
  const forced = single && force === true;
  const eligible = [], skipped = [];
  const seen = new Set();
  for (const r of rows) {
    if (wanted && !wanted.has(r.key)) continue;
    seen.add(r.key);
    const skip = (reason) => skipped.push({ key: r.key, reason });
    if (!r.email || !r.email.includes("@")) { skip("no_email"); continue; }
    if (/^BOOTH-/i.test(r.ticketId || "")) { skip("booth"); continue; }
    if (!single && r.hidden) { skip("hidden"); continue; }
    if (!single && dupes.has(r.key)) { skip("duplicate"); continue; }
    if (r.details?.profileCompletedAt && !forced) { skip("completed"); continue; }
    if (!single && !missingKeyDetails(r)) { skip("has_details"); continue; }
    if (recentlyAsked(r, now) && !forced) { skip("recently_asked"); continue; }
    eligible.push(r);
  }
  if (wanted) for (const k of wanted) if (!seen.has(k)) skipped.push({ key: k, reason: "not_found" });
  return { eligible, skipped };
}

/** { reason: count } for the preview. */
export const countReasons = (skipped = []) =>
  skipped.reduce((m, s) => ({ ...m, [s.reason]: (m[s.reason] || 0) + 1 }), {});

/** Bookkeeping stored on the ticket after an email goes out. */
export function requestStamp(details, now = new Date()) {
  const d = details && typeof details === "object" ? details : {};
  return { profileRequestedAt: new Date(now).toISOString(), profileRequestCount: (Number(d.profileRequestCount) || 0) + 1 };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends one at a time with a pause between (Resend allows ~2 requests/second).
 * `send(item)` resolves on success and throws on failure; one failure never stops the rest.
 */
export async function sendSequentially(items, send, { delayMs = 600, wait = sleep } = {}) {
  const sent = [], failed = [];
  for (let i = 0; i < items.length; i++) {
    if (i > 0 && delayMs > 0) await wait(delayMs);
    try { await send(items[i]); sent.push(items[i]); }
    catch (err) { failed.push({ item: items[i], error: String(err?.message || err || "Send failed").slice(0, 200) }); }
  }
  return { sent, failed };
}
