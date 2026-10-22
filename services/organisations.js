/* =========================================================
   The apps' organisations list (Oct 21 2026)
   ---------------------------------------------------------
   The organiser: "Map organisation names, logos and attendees well.
   Remove any duplicates." and "Update the attending-organisation logo
   list automatically as soon as someone from an organisation joins.
   If unsure about a logo, use the logo that is live on the website."

   GET /api/app/organisations (routes/appOrganisations.js) answers
   { updatedAt, featured: [Org], attending: [Org] } with
     Org = { key, name, logo, logoSource, website, kind, topics,
             description, scale, attendeeCount, speakerCount, aliases }
   Formats: key = companyKey (lower case, words, no legal suffix); logo
   an absolute https URL or ""; logoSource "website" | "company" |
   "auto" | ""; website an http(s) URL or ""; kind = the partner record's
   CMS `category` key as the apps read it ("governmentPartners",
   "startupEcosystemPartners", … PARTNER_CATEGORIES) or "" (not a
   partner); topics = full topic names ("Artificial Intelligence");
   scale = the CMS logoScale, a percentage 30…250 (100 when unset or not
   a partner); aliases = every other key counted as this organisation.
   from three sources, merged by key (companyKey, services/companies.js)
   after aliases:
     a) the website's partner records (Sanity `partner`, the ones the apps
        show: active and showInApp not false). Featured = the Featured
        Partners row (matrixGroup "featured", or the website's built-in
        four while the row is Automatic), in the admin panel's display
        order. A partner switched off for the app keeps its organisation
        out of the list altogether.
     b) the CMS speakers' companies (speakerCount).
     c) the organisation of everyone attending: any pass (not a booth, not
        a test or duplicate ticket staff hid), minus people hidden from the
        app, kept out of the directory or suspended, and minus junk names
        (isJunkOrgName). attendeeCount = distinct such people.
   Aliases: BUILTIN_ALIASES (kept small and conservative: "IBM Consulting"
   is never "IBM"), a partner's own short CMS name ("dell" for Dell
   Technologies), and staff's "merge X into Y" (OrgSetting.aliasOf).
   Staff can hide an organisation (OrgSetting.hidden).

   Logo, first hit wins: (1) the website: the partner's logo, else a logo
   of the same organisation on the website's logo strips ("website");
   (2) its Company record (Admin › People › company logo, "company");
   (3) the automatic search ("auto"): in the background, at most one
   lookup at a time and AUTO_PER_HOUR an hour per server, each organisation
   at most once a day across servers (an atomic claim on OrgSetting), the
   company's site icons and Google / DuckDuckGo icons for the domain of its
   people's work email (never personal mailboxes) or the website staff set.
   A work domain is only used when it looks like the organisation's name
   (domainMatchesOrg); Wikimedia name searches are never used. The image is
   re-hosted (services/logoStore.js) on the Company record (logoSource
   "auto", updatedBy "Automatic"), never over a logo staff chose or cleared;
   (4) none: logo "" (the apps draw a monogram).

   Built at most once a minute per server (forgetOrganisations() after a
   staff change on this server; other servers within the minute). Only
   counts leave the server: never a person's name, email or domain.
   The pure parts are exported and unit-tested (test/organisations.test.js).
========================================================= */

import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import Company from "../models/Company.js";
import CompanyLogo from "../models/CompanyLogo.js";
import OrgSetting from "../models/OrgSetting.js";
import { companyKey, cleanCompanyName, cleanDomain } from "./companies.js";
import { workDomain } from "./attendeeDetails.js";
import { guestWork, guestName } from "./ticketAccess.js";
import { hiddenState, isHiddenGuest, shadowFor, PLACEHOLDER } from "./appHide.js";
import { makeAgendaCache } from "./points.js";
import { SANITY_PROJECT } from "./rsvp.js";
import { safeWebsite } from "./awardApplications.js";
import { CMS_FIELDS } from "./cmsSchema.js";
import { findLogoCandidates, safeFetch } from "./logoFetch.js";
import { prepareLogo, storeLogo } from "./logoStore.js";

/* ================= the rules (pure) ================= */

/** CMS short names → display names (the same map as the apps' PartnerService and the web app's cms.js). */
const PARTNER_NAMES = {
  hackensack: "Hackensack Meridian Health", nejm: "NEJM Group", nyu: "NYU", dell: "Dell Technologies", amazon: "Amazon", broadcom: "Broadcom",
  cbc: "CBC/Radio-Canada", dhl: "DHL", helaba: "Helaba", hexaware: "Hexaware Technologies", ibm: "IBM", "intl seaways inc.": "International Seaways",
  christy: "The Christy Clark Show", jpmorgan: "JPMorgan Chase & Co.", kpmg: "KPMG", "lawrence harvey": "Lawrence Harvey", "mc'd": "McDonald's",
  pint: "Pinterest", tmobile: "T-Mobile", vm: "VMware", "wells fargo": "Wells Fargo", adp: "ADP", osif: "Office of the Superintendent of Financial Institutions",
  "public health agency of canada": "Public Health Agency of Canada", bdc: "BDC", "global affairs canada": "Global Affairs Canada",
  "canadian cybersecurity network": "Canadian Cybersecurity Network", "national association of corporate directors": "National Association of Corporate Directors",
  "ai collective": "The AI Collective", iris: "Iris Software", "rtm nexus": "RTM Nexus", "doc without border": "Doctors Without Borders",
  wef: "World Economic Forum", iapp: "IAPP", oqd: "Open Quantum Design", nvidia: "NVIDIA", "rockwell automation": "Rockwell Automation",
  xanadu: "Xanadu", kraken: "Kraken", "magna international": "Magna International", marsh: "Marsh", "1000 days out": "1000 Days Out",
  "fusion collective": "Fusion Collective", "worktango inc.": "WorkTango", branksome: "Branksome Hall", csa: "Canada Startup Association",
  foresight: "Foresight Canada", metafundwe: "MetaFundWe", schneider: "Schneider Electric", sparrow: "Sparrow BioAcoustics", terranova: "Terranova Aerospace & Defense",
};

/** `kind` is the partner record's own `category` key, exactly as the apps read it from the CMS (they label it:
    "governmentPartners" → "Government", …). One of these, or "" (not a partner, or no category). */
export const PARTNER_CATEGORIES = Object.freeze([...CMS_FIELDS.partner.category.values]);
/** The CMS's logo size (logoScale): a percentage of the default, 30…250; 100 when unset (services/cmsSchema.js). */
export const DEFAULT_SCALE = 100;
const scaleOf = (p) => {
  const n = Math.round(Number(p?.logoScale));
  return Number.isFinite(n) && n > 0 ? Math.min(250, Math.max(30, n)) : DEFAULT_SCALE;
};
/** Logos leave the server as absolute https URLs only (else ""). */
export const httpsUrl = (u) => (/^https:\/\/[^\s/]+\.[^\s]+$/i.test(String(u || "").trim()) ? String(u).trim() : "");

/** The apps' topic map (MockData.topicCompanies / the web app's TOPIC_COMPANIES). */
export const TOPIC_COMPANIES = Object.freeze({
  "Artificial Intelligence": ["IBM Consulting", "Dell Technologies", "NVIDIA", "VAST Data", "Hexaware Technologies", "ADP", "McDonald's", "Pinterest"],
  "Quantum Computing": ["IBM", "Xanadu", "Open Quantum Design", "Broadcom"],
  "Cybersecurity": ["Canadian Cybersecurity Network", "T-Mobile", "Broadcom", "Terranova Aerospace & Defense", "Wells Fargo", "IAPP"],
  "Robotics & Automation": ["Terranova Aerospace & Defense", "Dell Technologies", "DHL"],
  "Sustainability & CleanTech": ["Foresight Canada", "Ontario Centre of Innovation", "BDC"],
  "Healthcare & Lifesciences": ["Public Health Agency of Canada", "NEJM Group", "Hackensack Meridian Health", "Doctors Without Borders", "Sparrow BioAcoustics"],
  "Banking, Financial Services & Insurance": ["JPMorgan Chase & Co.", "Wells Fargo", "Helaba", "BDC", "Kraken", "Marsh", "KPMG"],
  "Supply Chain, Manufacturing & Infrastructure": ["DHL", "Amazon", "International Seaways", "LCBO", "Magna International", "Rockwell Automation"],
  "Defence & Public Safety": ["Global Affairs Canada", "Terranova Aerospace & Defense", "Public Health Agency of Canada"],
  "Energy & Utilities": ["Ontario IESO", "BC Hydro", "Schneider Electric", "Foresight Canada"],
});
const EXTRA_TOPICS = {
  ibm: ["Artificial Intelligence", "Cybersecurity"], kpmg: ["Cybersecurity", "Artificial Intelligence"], osif: ["Banking, Financial Services & Insurance"],
  nvidia: ["Robotics & Automation"], schneider: ["Sustainability & CleanTech"], "ai collective": ["Artificial Intelligence"], nyu: ["Artificial Intelligence"],
  wef: ["Artificial Intelligence", "Cybersecurity"], vm: ["Cybersecurity"], iris: ["Artificial Intelligence"],
};
/** The Partners page rows that are topics (website src/data/partnerMatrix.js). */
export const MATRIX_TOPICS = Object.freeze({
  ai: "Artificial Intelligence", quantum: "Quantum Computing", cyber: "Cybersecurity", robotics: "Robotics & Automation",
  cleantech: "Sustainability & CleanTech", health: "Healthcare & Lifesciences", bfsi: "Banking, Financial Services & Insurance",
  supply: "Supply Chain, Manufacturing & Infrastructure", defence: "Defence & Public Safety", energy: "Energy & Utilities",
});
const MATRIX_GROUPS = new Set(["featured", ...Object.keys(MATRIX_TOPICS), "ecosystem"]);
/** The website's built-in Featured Partners, used while a record's row is Automatic (src/data/partnerMatrix.js). */
export const DEFAULT_SPONSOR_IDS = Object.freeze(new Set([
  "pd7BC9mehWAqIUtnYVm0zi", "82f1d0a0-0167-479a-94e3-4b9ffeefb24d", "inoqRsrtOZgDGk9v20EIqV", "inoqRsrtOZgDGk9v20m52d",
]));

/** Same organisation, other names (companyKey → companyKey). Only names that can't mean anything else. */
export const BUILTIN_ALIASES = Object.freeze({
  "ontario government": "government of ontario",
  "govt of ontario": "government of ontario",
  "province of ontario": "government of ontario",
  "canadian government": "government of canada",
  "govt of canada": "government of canada",
  "royal bank of canada": "rbc",
  "rbc royal bank": "rbc",
  "td bank": "td",
  "td bank group": "td",
  "toronto dominion bank": "td",
  "bank of montreal": "bmo",
  "bmo financial group": "bmo",
  "canadian imperial bank of commerce": "cibc",
  "bank of nova scotia": "scotiabank",
  "amazon web services": "aws",
  "ernst and young": "ey",
  "pricewaterhousecoopers": "pwc",
  "jp morgan": "jpmorgan chase and",
  "jp morgan chase": "jpmorgan chase and",
  "jpmorgan chase": "jpmorgan chase and",
  "u of t": "university of toronto",
  "uoft": "university of toronto",
  "tmu": "toronto metropolitan university",
  "ryerson university": "toronto metropolitan university",
  "innovation science and economic development canada": "ised",
  "ised canada": "ised",
  "meta platforms": "meta",
});

/* Not organisations (compared without spaces, after companyKey). */
const JUNK = new Set([
  "na", "none", "nil", "null", "undefined", "unknown", "self", "selfemployed", "independent", "freelance", "freelancer", "student",
  "retired", "personal", "private", "tbd", "tba", "confidential", "notapplicable", "notavailable", "test", "consultant",
  "independentconsultant", "freelanceconsultant", "unemployed",
]);
/* A personal mailbox's name given as the organisation ("Gmail"); the domains themselves are caught by workDomain. */
const MAIL_BRANDS = new Set(["gmail", "googlemail", "hotmail", "yahoo", "ymail", "icloud", "aol", "protonmail", "outlook", "gmx", "msn"]);

/** Not an organisation: blank, "n/a", "Self-employed", "Student", "gmail.com", an email address, or the person's own name. */
export function isJunkOrgName(name, personName = "") {
  const raw = String(name ?? "").replace(/\s+/g, " ").trim();
  if (!raw || raw.includes("@")) return true;
  const key = companyKey(raw);
  if (!key) return true;
  const squashed = key.replace(/ /g, "");
  if (JUNK.has(squashed) || MAIL_BRANDS.has(squashed)) return true;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(raw) && !workDomain(`x@${raw.toLowerCase()}`)) return true;   // "gmail.com"
  const own = companyKey(personName);
  return !!own && own === key;
}

/** Follow aliases from a key to the organisation's key (cycles and long chains stop where they are). */
export function resolveKey(key, aliases = {}) {
  let k = key;
  const seen = new Set([k]);
  for (let i = 0; i < 8 && Object.prototype.hasOwnProperty.call(aliases, k); i++) {
    const next = aliases[k];
    if (!next || seen.has(next)) break;
    seen.add(next);
    k = next;
  }
  return k;
}

const titleCase = (s) => String(s || "").split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
const line = (v, max = 160) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** A partner's name as the apps show it: displayName, else the short-name map, else title case. */
export const partnerDisplayName = (p) => line(p?.displayName) || PARTNER_NAMES[String(p?.name || "").toLowerCase()] || titleCase(line(p?.name));

/** A sponsor (Featured Partners row): matrixGroup "featured", or one of the built-in four while it's Automatic. */
export function isSponsorPartner(p) {
  const g = p?.matrixGroup;
  if (g && MATRIX_GROUPS.has(g)) return g === "featured";
  return !!p?._id && DEFAULT_SPONSOR_IDS.has(p._id);
}

/** Shown in the apps: master switch on, app switch not off (missing = on). */
export const partnerInApp = (p) => !!p && p.active !== false && p.showInApp !== false;

/** The partner's own short CMS name as a second key ("dell" → Dell Technologies), when it's its first word(s). */
export function partnerShortKey(p) {
  const main = companyKey(partnerDisplayName(p));
  const short = companyKey(p?.name);
  if (!short || short === main || short.length < 3) return "";
  return main.startsWith(`${short} `) ? short : "";
}

const sameFirstWord = (a, b) => (a.split(" ")[0] || "") === (b.split(" ")[0] || "");

/** Topic filters an organisation appears under: its Partners page row, the apps' topic map, a few extras. */
export function topicsFor(name, { partner = null } = {}) {
  const key = companyKey(name);
  const out = new Set();
  if (partner && MATRIX_TOPICS[partner.matrixGroup]) out.add(MATRIX_TOPICS[partner.matrixGroup]);
  for (const [topic, companies] of Object.entries(TOPIC_COMPANIES)) {
    // Partners match the way the apps always did (same first word); anyone else needs the same name.
    if (companies.some((c) => companyKey(c) === key || (partner && sameFirstWord(companyKey(c), key)))) out.add(topic);
  }
  for (const t of (partner && EXTRA_TOPICS[String(partner.name || "").toLowerCase()]) || []) out.add(t);
  return [...out].sort();
}

const STOP = new Set(["of", "and", "the", "for", "de", "du", "des", "la", "le", "les", "et", "a", "an", "in", "on", "at"]);
const GENERIC = new Set([
  "bank", "banks", "group", "canada", "canadian", "global", "international", "tech", "technology", "technologies", "solutions",
  "services", "service", "consulting", "consultants", "capital", "partners", "ventures", "health", "healthcare", "digital",
  "systems", "labs", "lab", "university", "college", "school", "government", "ministry", "city", "foundation", "institute",
  "association", "network", "media", "financial", "finance", "insurance", "energy", "data", "cloud", "software", "security",
  "cyber", "quantum", "robotics", "research", "innovation", "innovations", "holdings", "management", "industries", "enterprises",
  "north", "america", "american", "national", "public", "office", "agency", "council", "centre", "center", "studio", "studios",
]);

/** Does this work domain ("acme.com", "ised-isde.gc.ca") look like this organisation's? Its first label matches the
    name, its initials, or contains one of its distinctive words ("utoronto" ← University of Toronto). */
export function domainMatchesOrg(domain, names = []) {
  const label = String(domain || "").toLowerCase().split(".")[0].replace(/-/g, "");
  if (label.length < 2) return false;
  for (const n of Array.isArray(names) ? names : [names]) {
    const all = companyKey(n).split(" ").filter(Boolean);
    const words = all.filter((w) => !STOP.has(w));
    if (!words.length) continue;
    if (label === words.join("") || label === all.join("")) return true;
    if (words.length > 1 && (label === words.map((w) => w[0]).join("") || label === all.map((w) => w[0]).join(""))) return true;
    if (words.includes(label)) return true;
    if (words.some((w) => w.length >= 3 && !GENERIC.has(w) && (label.includes(w) || (label.length >= 4 && w.includes(label))))) return true;
  }
  return false;
}

/** The automatic search's pick: the company's own icons first, then Google's and DuckDuckGo's (never Wikimedia or a
    social image), at least 64 px unless it's an SVG. `candidates`: findLogoCandidates' list, best first. */
export function pickAutoLogo(candidates = []) {
  return (candidates || []).find((c) => c && ["site", "google", "duckduckgo"].includes(c.source) && c.kind !== "og:image"
    && (c.contentType === "image/svg+xml" || Math.max(c.width || 0, c.height || 0) >= 64)) || null;
}

const bySponsorOrder = (a, b) => ((typeof a.order === "number" ? a.order : 9999) - (typeof b.order === "number" ? b.order : 9999))
  || a.name.localeCompare(b.name, "en", { sensitivity: "base" });
const byAttending = (a, b) => (b.attendeeCount - a.attendeeCount) || a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.key.localeCompare(b.key);

/** The most common spelling (ties: the one with capitals, then alphabetical). */
function bestSpelling(votes) {
  let best = "";
  let bestN = 0;
  for (const [name, n] of votes) {
    const better = n > bestN || (n === bestN && (/[A-Z]/.test(name) && !/[A-Z]/.test(best) || (/[A-Z]/.test(name) === /[A-Z]/.test(best) && name.localeCompare(best) < 0)));
    if (better) { best = name; bestN = n; }
  }
  return best;
}

/**
 * Every alias in force: built-in ones (unless staff switched one off), partners' short names, staff's merges
 * (they win). `settings`: OrgSetting docs. → { key: intoKey }
 */
export function aliasTable({ partners = [], settings = [] } = {}) {
  const out = { ...BUILTIN_ALIASES };
  for (const p of partners || []) {
    const short = partnerShortKey(p);
    if (short && !(short in out)) out[short] = companyKey(partnerDisplayName(p));
  }
  for (const s of settings || []) {
    if (!s?.key) continue;
    if (s.aliasOf) out[s.key] = s.aliasOf;
    else if (s.aliasOff) delete out[s.key];
  }
  return out;
}

/** name → the organisation's key in the list ("" for a junk name). */
export function orgKeyOf(name, aliases = BUILTIN_ALIASES, personName = "") {
  if (isJunkOrgName(name, personName)) return "";
  return resolveKey(companyKey(name), aliases);
}

/**
 * The list, from what loadInputs() read (pure).
 *   partners  Sanity partner docs { _id, name, displayName, category, order, website, logoScale, logo, matrixGroup,
 *             description, active, showInApp }
 *   logos     the website's other logos { name, url, logo } (logo strips): logo sources only, never organisations
 *   speakers  CMS speakers { _id, name, company }
 *   people    attending people, already filtered and one per person: { id, name, org, domain } (domain: work email's)
 *   companies Company docs; settings: OrgSetting docs
 * → { featured, attending, rows (everything, hidden ones too, for the admin panel), needsLogo, aliases }
 */
export function buildOrganisations({ partners = [], logos = [], speakers = [], people = [], companies = [], settings = [] } = {}) {
  const aliases = aliasTable({ partners, settings });
  const settingOf = new Map((settings || []).filter((s) => s?.key).map((s) => [s.key, s]));
  const orgs = new Map();
  const entry = (key) => {
    if (!orgs.has(key)) orgs.set(key, { key, partner: null, votes: new Map(), rawKeys: new Set(), people: new Set(), speakerCount: 0, domains: new Map() });
    return orgs.get(key);
  };
  const vote = (e, name) => { const n = line(name); if (n) e.votes.set(n, (e.votes.get(n) || 0) + 1); };

  // a) partners. One per organisation: an app-visible one wins over one switched off; a sponsor over the rest.
  const blocked = new Set();
  for (const p of partners || []) {
    if (!p || !line(p.name)) continue;
    const raw = companyKey(partnerDisplayName(p));
    if (!raw) continue;
    const key = resolveKey(raw, aliases);
    if (!partnerInApp(p)) { blocked.add(key); continue; }
    const e = entry(key);
    e.rawKeys.add(raw);
    if (!e.partner || (isSponsorPartner(p) && !isSponsorPartner(e.partner))) e.partner = p;
  }
  // b) speakers' companies
  for (const s of speakers || []) {
    const key = orgKeyOf(s?.company, aliases, s?.name);
    if (!key) continue;
    const e = entry(key);
    e.rawKeys.add(companyKey(s.company));
    e.speakerCount += 1;
    vote(e, s.company);
  }
  // c) attending people
  for (const p of people || []) {
    const key = orgKeyOf(p?.org, aliases, p?.name);
    if (!key) continue;
    const e = entry(key);
    e.rawKeys.add(companyKey(p.org));
    e.people.add(String(p.id));
    vote(e, p.org);
    if (p.domain) e.domains.set(p.domain, (e.domains.get(p.domain) || 0) + 1);
  }

  // Logo sources by key: the website's logo strips, Company records (staff's before automatic ones).
  const siteLogo = new Map();
  for (const l of logos || []) {
    const key = l?.logo ? resolveKey(companyKey(l.name), aliases) : "";
    if (key && !siteLogo.has(key)) siteLogo.set(key, l.logo);
  }
  const companyOf = new Map();
  for (const c of companies || []) {
    if (!c?.nameKey) continue;
    const key = resolveKey(c.nameKey, aliases);
    const have = companyOf.get(key);
    const rank = (x) => (!x ? -1 : (x.logoUrl ? 2 : 0) + (x.logoSource !== "auto" ? 1 : 0) + (x.nameKey === key ? 0.5 : 0));
    if (rank(c) > rank(have)) companyOf.set(key, c);
  }

  // Alias keys by the organisation they end up at.
  const aliasesInto = new Map();
  for (const from of Object.keys(aliases)) {
    const into = resolveKey(from, aliases);
    if (into === from) continue;
    if (!aliasesInto.has(into)) aliasesInto.set(into, new Set());
    aliasesInto.get(into).add(from);
  }

  const featured = [];
  const attending = [];
  const rows = [];
  const needsLogo = [];
  for (const e of orgs.values()) {
    const p = e.partner;
    const company = companyOf.get(e.key) || null;
    const staffCompany = company && company.updatedBy !== "Automatic";
    const name = p ? partnerDisplayName(p) : (staffCompany && line(company.name)) || bestSpelling(e.votes) || titleCase(e.key);
    let logo = "";
    let logoSource = "";
    if (httpsUrl(p?.logo)) { logo = httpsUrl(p.logo); logoSource = "website"; }
    else if (httpsUrl(siteLogo.get(e.key))) { logo = httpsUrl(siteLogo.get(e.key)); logoSource = "website"; }
    else if (httpsUrl(company?.logoUrl)) { logo = httpsUrl(company.logoUrl); logoSource = company.logoSource === "auto" ? "auto" : "company"; }
    const website = (p && safeWebsite(p.website)) || (company?.domain && safeWebsite(company.domain)) || "";
    const org = {
      key: e.key,
      name,
      logo,
      logoSource,
      website,
      kind: p && PARTNER_CATEGORIES.includes(p.category) ? p.category : "",
      topics: topicsFor(name, { partner: p }),
      description: p ? line(p.description, 600) : "",
      scale: p ? scaleOf(p) : DEFAULT_SCALE,
      attendeeCount: e.people.size,
      speakerCount: e.speakerCount,
      // Every other key counted as this organisation: the ones seen (people's, speakers', the partner's) and every
      // alias pointing here, so a client can match a person whose organisation was merged in.
      aliases: aliasesInto.get(e.key) ? [...new Set([...e.rawKeys, ...aliasesInto.get(e.key)])].filter((k) => k && k !== e.key).sort()
        : [...e.rawKeys].filter((k) => k && k !== e.key).sort(),
    };
    const s = settingOf.get(e.key);
    const hiddenBy = blocked.has(e.key) && !p ? "partner" : s?.hidden ? "staff" : "";
    const section = p && isSponsorPartner(p) ? "featured" : "attending";
    // Automatic logo: no logo yet, not a partner, and staff haven't cleared one (a Company record they emptied).
    let autoDomain = "";
    if (!logo && !p && !hiddenBy && !(staffCompany && !company.logoUrl)) {
      autoDomain = (company?.domain && cleanDomain(company.domain)?.domain) || "";
      if (!autoDomain) {
        const names = [name, ...e.votes.keys()];
        autoDomain = [...e.domains.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([d]) => d)
          .find((d) => domainMatchesOrg(d, names)) || "";
      }
      if (autoDomain) needsLogo.push({ key: e.key, name, domain: autoDomain });
    }
    rows.push({
      ...org, section, hidden: !!hiddenBy, hiddenBy, partnerId: p?._id || "",
      mergedKeys: [...e.rawKeys].filter((k) => k && k !== e.key).sort(),   // the keys actually seen (aliases also lists unused ones)
      company: company ? { name: company.name || "", logoUrl: company.logoUrl || "", logoSource: company.logoSource || "", updatedBy: company.updatedBy || "" } : null,
      autoLogo: s?.logoCheckedAt ? { checkedAt: s.logoCheckedAt, domain: s.logoCheckDomain || "", result: s.logoCheckResult || "" } : null,
      autoDomain,
      order: p && typeof p.order === "number" ? p.order : null,
    });
    if (hiddenBy) continue;
    if (section === "featured") featured.push({ ...org, order: rows[rows.length - 1].order });
    else attending.push(org);
  }
  featured.sort(bySponsorOrder);
  attending.sort(byAttending);
  rows.sort((a, b) => (a.section === b.section ? (a.section === "featured" ? bySponsorOrder(a, b) : byAttending(a, b)) : a.section === "featured" ? -1 : 1));
  return { featured: featured.map(({ order: _o, ...o }) => o), attending, rows, needsLogo, aliases };
}

/* ================= reading the sources ================= */

const GROQ = `{
  "partners": *[_type=="partner" && !(_id in path("drafts.**"))]{_id,name,displayName,category,order,"website":coalesce(url, website),logoScale,"logo":logo.asset->url,matrixGroup,description,active,showInApp},
  "logos": *[_type in ["sponsor","sponsorMarquee","homeSponsor"] && defined(logo) && active != false && !(_id in path("drafts.**"))]{name,url,"logo":logo.asset->url},
  "speakers": *[_type=="speaker" && !(_id in path("drafts.**"))]{_id,name,company}
}`;
const CMS_URL = `https://${SANITY_PROJECT}.apicdn.sanity.io/v2021-10-21/data/query/production?query=${encodeURIComponent(GROQ)}`;
const parseCms = (json) => {
  const r = json?.result;
  if (!r || typeof r !== "object") return null;
  const list = (v) => (Array.isArray(v) ? v : []);
  const out = { partners: list(r.partners), logos: list(r.logos), speakers: list(r.speakers) };
  return out.partners.length || out.speakers.length ? out : null;
};
const newCmsCache = () => makeAgendaCache({ url: CMS_URL, parse: parseCms, label: "ORGANISATIONS CMS", ttlMs: 60_000, fetchImpl: (...a) => globalThis.fetch(...a) });
let cms = newCmsCache();

const SITE_DOMAINS = new Set(["thetechfestival.com"]);
const RESERVED = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost|local)$/;   // RFC 2606 / 6761
/** The domain of someone's work email, or "" (personal mailboxes, pass placeholders, our own, reserved names). */
export function personDomain(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || PLACEHOLDER.test(e)) return "";
  const d = workDomain(e);
  return d && !SITE_DOMAINS.has(d) && !RESERVED.test(d) ? d : "";
}

const isBooth = (t) => /^BOOTH-/i.test(String(t?.ticketId || "")) || /^booth/i.test(String(t?.type ?? t?.ticketType ?? ""));

/** Everyone attending, one per person: { id, name, org, domain }. */
export function attendingPeople({ users = [], guests = [], hidden = null } = {}) {
  const shadow = hidden ? shadowFor(hidden, {}) : null;
  const out = [];
  const seen = new Set();   // accounts' emails: their unclaimed passes are the same person (or someone left out)
  for (const u of users || []) {
    if (!u) continue;
    const email = String(u.email || "").trim().toLowerCase();
    if (email) seen.add(email);
    if (u.banned || u.directoryHidden || shadow?.ids.has(String(u._id))) continue;
    const passes = (u.tickets || []).filter((t) => t && !isBooth(t) && !t.hiddenByStaff);
    if (!passes.length) continue;
    const fromPass = passes.map((t) => guestWork(t.details).organization).find(Boolean) || "";
    out.push({ id: `u:${u._id}`, name: line(u.name), org: line(u.organization) || fromPass, domain: personDomain(email) });
  }
  const guestSeen = new Set();
  for (const g of guests || []) {
    if (!g || g.directoryHidden || g.hiddenByStaff || g.syncDuplicate || g.claimedBy || isBooth(g)) continue;
    if (/^guest$/i.test(line(g.name))) continue;
    if (shadow && isHiddenGuest(g, shadow)) continue;
    const email = String(g.email || "").trim().toLowerCase();
    if (email && seen.has(email)) continue;
    const { name } = guestName(g);
    const org = guestWork(g.details).organization;
    const dedupe = email || `${companyKey(name)}|${companyKey(org)}`;
    if (guestSeen.has(dedupe)) continue;
    guestSeen.add(dedupe);
    out.push({ id: `g:${g._id}`, name, org, domain: personDomain(email) });
  }
  return out;
}

const GUEST_SELECT = "name email ticketId ticketType directoryHidden hiddenByStaff syncDuplicate claimedBy details.organisation details.organization details.company details.firstName details.lastName";
const USER_SELECT = "name email organization banned directoryHidden tickets.ticketId tickets.type tickets.hiddenByStaff tickets.details.organisation tickets.details.organization tickets.details.company";

async function loadInputs() {
  const [source, users, guests, companies, settings, hidden] = await Promise.all([
    cms.get(),
    // Suspended and directory-hidden accounts are read too, so their unclaimed passes (same email) stay out.
    User.find({ $or: [{ "tickets.0": { $exists: true } }, { banned: true }, { directoryHidden: true }] }).select(USER_SELECT).lean(),
    Attendee.find({ claimedBy: { $exists: false }, directoryHidden: { $ne: true }, hiddenByStaff: { $ne: true }, syncDuplicate: { $ne: true } })
      .select(GUEST_SELECT).lean(),
    Company.find({}).select("nameKey name domain logoUrl logoSource updatedBy").lean(),
    OrgSetting.find({}).lean(),
    hiddenState(),
  ]);
  return {
    partners: source?.partners || [], logos: source?.logos || [], speakers: source?.speakers || [], cmsOk: !!source,
    people: attendingPeople({ users, guests, hidden }), companies, settings,
  };
}

/* ================= the memo (≤ 60 s) ================= */

const TTL_MS = 60_000;
let memo = { at: 0, value: null, pending: null, gen: 0 };

/** The built list → { updatedAt, featured, attending, rows, needsLogo, aliases, cmsOk }. */
export async function organisations({ fresh = false } = {}) {
  if (!fresh && memo.value && Date.now() - memo.at < TTL_MS) return memo.value;
  if (memo.pending) return memo.pending;
  const gen = memo.gen;
  const pending = loadInputs().then((inputs) => {
    const value = { updatedAt: new Date().toISOString(), cmsOk: inputs.cmsOk, ...buildOrganisations(inputs) };
    if (memo.gen === gen) memo = { at: Date.now(), value, pending: null, gen };
    queueLogoLookups(value.needsLogo, inputs.settings);
    return value;
  }).catch((err) => {
    if (memo.pending === pending) memo.pending = null;
    if (memo.value) { console.error("ORGANISATIONS ERROR (kept the last list):", err?.message || err); return memo.value; }
    throw err;
  });
  memo.pending = pending;
  return pending;
}

/** The public payload. */
export async function organisationsPayload() {
  const v = await organisations();
  return { updatedAt: v.updatedAt, featured: v.featured, attending: v.attending };
}

/** A staff change here: the next read rebuilds (other servers within a minute). */
export function forgetOrganisations({ cmsToo = false } = {}) {
  memo = { at: 0, value: null, pending: null, gen: memo.gen + 1 };
  if (cmsToo) cms = newCmsCache();
}

/** name → the organisation's key in the list ("" when it isn't one), with the aliases now in force. Waits at most
    `waitMs` for a cold list (then the built-in aliases only), so the directory is never held up by the CMS. */
export async function orgKeyResolver({ waitMs = 1500 } = {}) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), waitMs); });
  const v = await Promise.race([organisations().catch(() => null), late]);
  clearTimeout(timer);
  const aliases = v?.aliases || BUILTIN_ALIASES;
  return (name, personName = "") => orgKeyOf(name, aliases, personName);
}

/* ================= the automatic logo search ================= */

export const AUTO_PER_HOUR = 40;
const DAY_MS = 24 * 3600 * 1000;
const auto = {
  // Off with TTFC_AUTO_LOGOS=off, and under `node --test` unless a test switches it on with its own fetcher.
  enabled: process.env.TTFC_AUTO_LOGOS !== "off" && !process.env.NODE_TEST_CONTEXT,
  fetcher: safeFetch,
  gapMs: 4000,
  apiBase: () => process.env.API_URL || "https://techfest-canada-backend.onrender.com",
  queue: [],
  queued: new Set(),
  running: false,
  recent: [],
  log: console,
};

/** For tests: { enabled, fetcher, gapMs, log }. */
export function configureAutoLogo(opts = {}) {
  for (const k of ["enabled", "fetcher", "gapMs", "log"]) if (k in opts) auto[k] = opts[k];
  if (opts.reset) { auto.queue = []; auto.queued = new Set(); auto.recent = []; }
}

/** Settles when the queue is empty (tests). */
export async function autoLogoIdle() {
  while (auto.running || auto.queue.length) await new Promise((r) => setTimeout(r, 20));
}

function queueLogoLookups(list = [], settings = []) {
  if (!auto.enabled) return;
  const checked = new Map((settings || []).map((s) => [s.key, s.logoCheckedAt ? new Date(s.logoCheckedAt).getTime() : 0]));
  for (const item of list) {
    if (auto.queued.has(item.key) || Date.now() - (checked.get(item.key) || 0) < DAY_MS) continue;
    auto.queued.add(item.key);
    auto.queue.push(item);
  }
  if (!auto.running && auto.queue.length) drain().catch(() => { auto.running = false; });
}

async function drain() {
  auto.running = true;
  try {
    while (auto.queue.length) {
      const now = Date.now();
      auto.recent = auto.recent.filter((t) => now - t < 3600_000);
      if (auto.recent.length >= AUTO_PER_HOUR) { auto.queue = []; auto.queued = new Set(); break; }   // next build queues again
      const item = auto.queue.shift();
      auto.queued.delete(item.key);
      auto.recent.push(now);
      await lookUpLogo(item);
      if (auto.queue.length && auto.gapMs) await new Promise((r) => setTimeout(r, auto.gapMs));
    }
  } finally {
    auto.running = false;
  }
}

/** Take this organisation's lookup for today (any server): true when it's ours. */
async function claimLookup(key, domain, now) {
  try {
    const r = await OrgSetting.findOneAndUpdate(
      { key, $or: [{ logoCheckedAt: { $exists: false } }, { logoCheckedAt: { $lte: new Date(now.getTime() - DAY_MS) } }] },
      { $set: { logoCheckedAt: now, logoCheckDomain: domain, logoCheckResult: "" } },
      { upsert: true, returnDocument: "after", projection: { logoCheckedAt: 1 } },
    ).lean();
    return !!r && +new Date(r.logoCheckedAt) === +now;
  } catch (err) {
    if (err?.code === 11000) return false;
    throw err;
  }
}

async function saveToDb(logo) {
  const doc = await CompanyLogo.findOneAndUpdate(
    { sha256: logo.sha },
    { $setOnInsert: { sha256: logo.sha, contentType: logo.type, bytes: logo.buffer.length, data: logo.buffer } },
    { upsert: true, new: true },
  ).select("_id").lean();
  return String(doc._id);
}

/** One lookup: never throws, never logs a domain or URL (they come from people's emails). */
async function lookUpLogo({ key, name, domain }) {
  const now = new Date();
  let result = "none";
  try {
    if (!(await claimLookup(key, domain, now))) return;
    const found = await findLogoCandidates({ name, domain, wikimedia: false, fetcher: auto.fetcher });
    const pick = pickAutoLogo(found.candidates);
    if (pick) {
      const r = await auto.fetcher(pick.url, { kind: "image" });
      const logo = prepareLogo(r.body);
      if (!logo.error) {
        const stored = await storeLogo({ logo, name, saveToDb, apiBase: auto.apiBase() });
        // Only where no logo is set: never over one staff chose or cleared (an existing record makes the upsert fail).
        try {
          const w = await Company.updateOne(
            { nameKey: key, logoUrl: "", updatedBy: "Automatic" },
            { $set: { name: cleanCompanyName(name), domain, logoUrl: stored.url, logoSource: "auto", logoStore: stored.store, logoRef: stored.ref,
                      sourceUrl: String(r.url || pick.url).slice(0, 500), updatedBy: "Automatic", updatedById: "" },
              $setOnInsert: { nameKey: key } },
            { upsert: true },
          );
          result = w.modifiedCount || w.upsertedCount ? "found" : "none";
        } catch (err) {
          if (err?.code !== 11000) throw err;   // a Company record staff made: theirs stays
          result = "none";
        }
      }
    }
  } catch (err) {
    result = "error";
    auto.log.error?.("AUTO LOGO ERROR:", err?.code || err?.name || "failed");
  }
  await OrgSetting.updateOne({ key }, { $set: { logoCheckResult: result } }).catch(() => {});
  if (result === "found") forgetOrganisations();
}
