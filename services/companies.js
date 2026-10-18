/* =========================================================
   Companies: one small record per company (models/Company.js)
   holding its default logo, so everyone at that company shows it
   in Admin → People. Pure helpers, unit-tested (test/people.test.js).
   People are matched to a company by its normalised name
   (companyKey): "Dell Technologies Inc." and "dell technologies"
   are the same company; "Dell" is a different one.
========================================================= */

// Letters NFD doesn't split into base + accent (same set as services/rsvp.js foldName).
const SPECIAL = { ß: "ss", æ: "ae", œ: "oe", ø: "o", ł: "l", đ: "d", ð: "d", þ: "th", ı: "i" };

// Legal forms dropped from the end of a name ("Acme Holdings Ltd." → "acme holdings").
const LEGAL = new Set([
  "inc", "incorporated", "ltd", "limited", "llc", "llp", "lp", "corp", "corporation", "co", "company",
  "plc", "gmbh", "ag", "sa", "sas", "srl", "bv", "nv", "pty", "pvt", "private", "ulc", "ltee", "limitee",
]);

/** "Dell Technologies, Inc." → "dell technologies"; "AT&T" → "at and t"; "" when there's no name. */
export function companyKey(name) {
  const words = String(name || "")
    .toLowerCase()
    .replace(/[ßæœøłđðþı]/g, (c) => SPECIAL[c] || c)
    .normalize("NFKD").replace(/\p{M}+/gu, "")
    .replace(/&/g, " and ")
    .replace(/\./g, "") // "S.A." → "sa", "J.P. Morgan" → "jp morgan"
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 1 && LEGAL.has(words[words.length - 1])) words.pop();
  if (words.length > 1 && words[0] === "the") words.shift();
  return words.join(" ").slice(0, 120);
}

/** A company name as typed by staff: one line, at most 160 characters. */
export const cleanCompanyName = (v) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 160);

const HOST_RE = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/**
 * What staff typed as a company's website → { host, domain } or null.
 * "https://www.Acme.com/about" → { host: "www.acme.com", domain: "acme.com" }. IP addresses,
 * single-label names ("localhost") and anything with a user name or port are refused.
 */
export function cleanDomain(input) {
  let s = String(input ?? "").trim().toLowerCase();
  if (!s || s.length > 300) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.port) return null;
  const host = u.hostname.replace(/\.$/, "");
  if (!HOST_RE.test(host)) return null;
  return { host, domain: host.replace(/^www\./, "") };
}

/** The domain of a website link ("https://www.dell.com/en-ca" → "dell.com"), or "". */
export function domainOfUrl(url) {
  return cleanDomain(url)?.domain || "";
}

/** A Company document as the admin panel sees it. */
export function companyDTO(c) {
  if (!c) return null;
  return {
    key: c.nameKey || "",
    name: c.name || "",
    domain: c.domain || "",
    logoUrl: c.logoUrl || "",
    logoSource: c.logoSource || "",
    logoStore: c.logoStore || "",
    updatedBy: c.updatedBy || "",
    updatedAt: c.updatedAt || null,
  };
}

/* Where a picked logo came from (Company.logoSource). */
export const LOGO_SOURCES = ["current", "cms", "site", "google", "duckduckgo", "wikimedia", "url", "upload"];
export const LOGO_SOURCE_LABELS = {
  current: "Current default",
  cms: "Website partners and sponsors",
  site: "The company's website",
  google: "Google favicon service",
  duckduckgo: "DuckDuckGo icons",
  wikimedia: "Wikimedia Commons",
  url: "Image link pasted by staff",
  upload: "File uploaded by staff",
};
