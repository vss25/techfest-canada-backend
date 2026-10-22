/* =========================================================
   Catalyst Awards applications in the apps (Oct 21 2026)
   ---------------------------------------------------------
   The organiser: "Don't say 28 — show the number of award
   categories that actually received eligible applications" and
   "When I click on application, I should see the list of
   companies/individuals, their basic details and the name of the
   applicant. Do not show which categories the companies applied
   for."

   Eligible = every nomination whose status isn't "rejected".
   categoriesCount = distinct categories among them: a matrix
   nomination's pillar × sector pair, a special one's award; never
   more than 28 (5 pillars × 5 sectors + 3 special awards). A
   nomination with no readable category (an old emailed one without a
   pillar or sector) is listed but counts no category.

   One item per eligible nomination: the nominee's public basics and
   who applied. Never the category, status, emails, phones, LinkedIn,
   statements, declarations, staff notes, the nominator's title /
   organisation / relationship or anything from the jury. Built from
   an explicit list of fields (applicationItem), so a field added to
   the Nomination model later can't leak. Links only when http(s).

   Pure, unit-tested (test/award-applications.test.js); the routes are
   in routes/appAwards.js. The kill switch is the site setting
   APPLICATIONS_KEY ("Show award applications in the app", on by default).
========================================================= */

import { SPECIAL_AWARDS } from "./nominations.js";
import { cleanDomain } from "./companies.js";

export const APPLICATIONS_KEY = "site.award_applications";
export const MAX_CATEGORIES = 28;
export const NOMINEE_TYPES = Object.freeze(["Individual", "Organisation", "Team / Project"]);

/** Only these leave the server, in this order. */
export const ITEM_FIELDS = Object.freeze([
  "id", "nomineeName", "nomineeType", "nomineeTitle", "nomineeOrganisation", "nomineeLocation", "nomineeWebsite",
  "applicantName", "selfNominated", "submittedAt",
]);

const line = (v, max = 200) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const norm = (v) => line(v).toLowerCase();

/** Eligible for the apps: anything but rejected. */
export const isEligible = (n) => !!n && String(n.status || "pending") !== "rejected";

/** The nomination's category as one key ("m:ai and ml|healthcare", "s:rising"), or "" when it has none. */
export function categoryKey(n = {}) {
  if (n.categoryType === "special") return SPECIAL_AWARDS[n.specialAward] ? `s:${n.specialAward}` : "";
  const pillar = norm(n.pillar);
  const sector = norm(n.sector);
  return pillar && sector ? `m:${pillar}|${sector}` : "";
}

/** Distinct categories among the eligible nominations (0 … 28). */
export function categoriesCount(nominations = []) {
  const keys = new Set();
  for (const n of nominations || []) {
    if (!isEligible(n)) continue;
    const k = categoryKey(n);
    if (k) keys.add(k);
  }
  return Math.min(MAX_CATEGORIES, keys.size);
}

/** A website as typed on the form → an http(s) link, or "" (javascript:, mailto:, junk). "acme.com" → "https://acme.com". */
export function safeWebsite(raw) {
  const s = String(raw ?? "").trim();
  if (!s || s.length > 500 || /\s/.test(s)) return "";
  let candidate = s;
  if (!/^https?:\/\//i.test(s)) {
    if (/^[^/]*:/.test(s)) return "";   // another scheme (javascript:, mailto:) or a port
    if (!cleanDomain(s)) return "";
    candidate = `https://${s}`;
  }
  try {
    const u = new URL(candidate);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || !cleanDomain(u.hostname)) return "";
    return u.href;
  } catch {
    return "";
  }
}

/** One nomination → the item the apps show (ITEM_FIELDS only). */
export function applicationItem(n) {
  const type = NOMINEE_TYPES.includes(n?.nomineeType) ? n.nomineeType : "Individual";
  const when = n?.submittedAt || n?.createdAt || null;
  return {
    id: String(n?._id ?? ""),
    nomineeName: line(n?.nomineeName),
    nomineeType: type,
    nomineeTitle: line(n?.nomineeTitle),
    nomineeOrganisation: line(n?.nomineeOrganisation),
    nomineeLocation: line(n?.nomineeLocation),
    nomineeWebsite: safeWebsite(n?.nomineeWebsite),
    applicantName: line(n?.nominatorName),
    selfNominated: n?.selfNomination === true,
    submittedAt: when ? new Date(when).toISOString() : null,
  };
}

const byName = (a, b) => a.nomineeName.localeCompare(b.nomineeName, "en", { sensitivity: "base" })
  || String(a.submittedAt || "").localeCompare(String(b.submittedAt || "")) || a.id.localeCompare(b.id);

/**
 * Nominations (only the fields NOMINATION_SELECT reads) → GET /api/app/awards/applications.
 * `enabled` false (the site setting is off): no items and total 0, the category count still worked out.
 */
export function applicationsPayload(nominations = [], { enabled = true } = {}) {
  const eligible = (nominations || []).filter(isEligible);
  const count = categoriesCount(eligible);
  if (!enabled) return { enabled: false, total: 0, categoriesCount: count, items: [] };
  const items = eligible.map(applicationItem).filter((i) => i.nomineeName).sort(byName);
  return { enabled: true, total: items.length, categoriesCount: count, items };
}

/** GET /api/app/awards/summary (public): the Awards screen's numbers. */
export function summaryPayload(nominations = [], { enabled = true } = {}) {
  const p = applicationsPayload(nominations, { enabled });
  return { enabled: p.enabled, categoriesCount: p.categoriesCount, applicationsCount: p.total };
}

/** What's read from the database: nothing private beyond what applicationItem needs (nominatorName for the
    applicant's name, the category fields only for counting). */
export const NOMINATION_SELECT = "status categoryType pillar sector specialAward nomineeName nomineeType nomineeTitle "
  + "nomineeOrganisation nomineeLocation nomineeWebsite nominatorName selfNomination submittedAt createdAt";
