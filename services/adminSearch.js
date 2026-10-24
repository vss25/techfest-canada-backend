/* =========================================================
   Admin panel global search (GET|POST /api/console/search).
   ---------------------------------------------------------
   Pure parts: reading the query, matching, the result rows of
   every group, who may see which group, and running the sources
   with a time limit so one slow or broken source never holds up
   the others. The route (routes/console.js) and the sources
   (services/adminSearchSources.js) do the database / CMS reads.

   Matching (the same rules for every group):
     - At least SEARCH_MIN_CHARS characters, at most SEARCH_MAX_CHARS.
     - Text: every word of the query must start a word of the
       record (accents and case ignored): "kai sp" finds
       "Kai Speaker". Names weigh most, then company, job title.
     - Emails and ticket IDs match exactly, never in part: a query
       that is an email finds the records with that email only; a
       query that is a ticket ID (TECHFEST: prefix and spaces
       ignored) finds that ticket. An exact hit comes first.
   Results: { type, id, title, subtitle, link, badges?, exact? },
   at most GROUP_CAP per group, `more` when there are others, and
   `seeAll` where a full page with its own search exists.
   Amounts (what a pass was paid) go to management only. Search
   terms are never logged (see runSearch's `log`).
   Volunteers (the volunteer panel, Oct 23 2026, viewer { volunteer:
   true }): the People group only, without emails in the subtitle or
   the staff-only "Hidden from app" badge; the title, the job title and
   company and the words matched are the safe text of
   services/volunteerSafe.js (an email typed as a name is never shown
   or matched); an exact email or ticket ID still finds the person, but
   the answer never repeats it (query.text is "" and there's no "See
   all" link with it in the address).
========================================================= */

import { normalizeTicketId } from "./ticketAccess.js";
import { TIER_LABELS, DAYS, tierFromTicketType } from "./rsvp.js";
import { PASS_STATUS_LABELS } from "./people.js";
import { TYPE_LABELS } from "./teamRoles.js";
import { rsvpStatusOf } from "./rsvpStaff.js";
import { FORMS, STATUS_LABEL as FORM_STATUS_LABEL } from "./formSubmissions.js";
import { categoryShort } from "./nominations.js";
import { BROCHURES, DEFAULT_BROCHURE } from "./brochureDownloads.js";
import { STATUS_LABEL as PAVILION_STATUS_LABEL } from "./pavilionApplications.js";
import { safeName, safeSearchFields, safeText } from "./volunteerSafe.js";

export const SEARCH_MIN_CHARS = 2;
export const SEARCH_MAX_CHARS = 100;
export const GROUP_CAP = 5;
/** How long one source (the People directory, the CMS, one collection) may take before its group is skipped. */
export const SOURCE_TIMEOUT_MS = 5000;
/** Rows a database prefilter reads at most before matching (each lead collection is small). */
export const PREFILTER_LIMIT = 300;

/* ---------- Text ---------- */

/** Accents off, lower case: "José Núñez" → "jose nunez". */
export const foldText = (s) => String(s ?? "").normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();

/** The words of a text, folded: letters and digits only ("O'Brien-Smith" → ["o", "brien", "smith"]). */
export const tokens = (s) => foldText(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Every regex special character escaped, so the text matches only itself. */
export const escapeRegex = (s) => String(s ?? "").replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

/* Accent-insensitive letters for the database prefilter: "jose" also finds "José". */
const ACCENTS = {
  a: "aàáâãäåāăą", c: "cçćĉċč", d: "dďđ", e: "eèéêëēĕėęě", g: "gĝğġģ", h: "hĥħ", i: "iìíîïĩīĭįı", j: "jĵ", k: "kķ",
  l: "lĺļľŀł", n: "nñńņňŉ", o: "oòóôõöøōŏő", r: "rŕŗř", s: "sśŝşšß", t: "tţťŧ", u: "uùúûüũūŭůűų", w: "wŵ", y: "yýÿŷ", z: "zźżž",
};

/**
 * A case- and accent-insensitive RegExp that finds `word` inside a field, for the database prefilter only (the real
 * matching is matchScore). Injection-safe: every character is either one of the fixed letter classes above or
 * escaped, so a query can never add regex syntax.
 */
export function accentRegex(word) {
  const src = [...foldText(word)].map((ch) => {
    const set = ACCENTS[ch];
    return set ? `[${set}${set.toUpperCase()}]` : escapeRegex(ch);
  }).join("");
  return new RegExp(src, "i");
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * The query as typed → { text, folded, words, email, ticket, tooShort }.
 *   email   the query, lower case, when it is an email address (then only exact email matches count)
 *   ticket  the query as a ticket ID (normalizeTicketId) when it could be one: one word, 4+ characters, a digit in it
 * Anything that isn't a string (an object from a JSON body, an array from ?q=a&q=b) counts as nothing.
 */
export function parseQuery(raw) {
  const s = typeof raw === "string" ? raw : Array.isArray(raw) && typeof raw[0] === "string" ? raw[0] : "";
  // eslint-disable-next-line no-control-regex
  const text = s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, SEARCH_MAX_CHARS);
  const folded = foldText(text);
  const words = [...new Set(tokens(text))].slice(0, 8);
  const email = EMAIL.test(text) ? text.toLowerCase() : "";
  // Ticket IDs are 12 hex characters (always with a digit in practice), booth orders BOOTH-…; a plain word isn't one.
  const bare = text.replace(/^TECHFEST:\s*/i, "");
  const norm = !email && !/\s/.test(bare) && bare.length >= 4 ? normalizeTicketId(bare) : "";
  const ticket = norm && (/\d/.test(norm) || /^booth-/.test(norm)) ? norm : "";
  const tooShort = text.length < SEARCH_MIN_CHARS || (!email && !ticket && !words.length);
  return { text, folded, words, email, ticket, tooShort };
}

/**
 * How well a record matches the query's words: 0 = it doesn't (some word starts none of its words).
 * `fields`: [[text, weight], …]; a word that is a whole word of a field counts a little more than a prefix.
 */
export function matchScore(words, fields) {
  if (!words?.length) return 0;
  const prepared = (fields || []).filter(([t]) => t).map(([t, w]) => [tokens(t), w]);
  let total = 0;
  for (const word of words) {
    let best = 0;
    for (const [toks, weight] of prepared) {
      for (const t of toks) {
        if (t === word) best = Math.max(best, weight * 1.25);
        else if (t.startsWith(word)) best = Math.max(best, weight);
      }
    }
    if (!best) return 0;
    total += best;
  }
  return total;
}

/** Text score with a small bonus when the title starts with the whole query. 0 in email mode (emails match exactly). */
function textScore(pq, fields) {
  if (pq.email) return 0;
  const s = matchScore(pq.words, fields);
  if (!s) return 0;
  const title = foldText(fields[0]?.[0] || "");
  return s + (pq.folded && title.startsWith(pq.folded) ? 3 : 0);
}

const EXACT = 1000;
const lower = (v) => String(v ?? "").trim().toLowerCase();
const PLACEHOLDER = /@ticket\.thetechfestival\.com$/i;
const realEmail = (v) => { const e = lower(v); return e && !PLACEHOLDER.test(e) ? e : ""; };
const join = (...parts) => parts.flat().filter((x) => x !== null && x !== undefined && String(x).trim() !== "").join(" · ");
const enc = encodeURIComponent;
const upperId = (id) => String(id || "").toUpperCase();

/* ---------- Groups and who sees them ---------- */

/**
 * Every group, in the order they're shown. `access`: "staff" = everyone who can open the admin panel (role admin,
 * management or not), "management" = management only, like their pages. `volunteer: true`: also the volunteer
 * panel's (People only). `sources`: what the group is built from (the first one must answer, others are optional).
 */
export const GROUPS = [
  { key: "tickets", label: "Tickets", access: "staff", sources: ["directory", "ticketDocs"], exactOnly: true,
    seeAll: (pq) => ({ label: "See it in Tickets", link: `/admin/attendees?q=${enc(pq.text)}` }) },
  { key: "people", label: "People", access: "staff", volunteer: true, sources: ["directory"],
    seeAll: (pq) => ({ label: "See all in People", link: `/admin/people?q=${enc(pq.text)}` }) },
  { key: "passes", label: "Speaker, issued and exhibitor passes", access: "staff", sources: ["directory"] },
  { key: "rsvps", label: "RSVPs", access: "staff", sources: ["directory"],
    seeAll: (pq) => ({ label: "See all in RSVPs", link: `/admin/rsvps?q=${enc(pq.text)}` }) },
  { key: "sessions", label: "Agenda sessions", access: "staff", sources: ["cms"] },
  { key: "speakers", label: "Website speakers", access: "staff", sources: ["cms"],
    seeAll: (pq) => ({ label: "See all in Speakers", link: `/admin/content/speakers?q=${enc(pq.text)}` }) },
  { key: "partners", label: "Partners and sponsors", access: "staff", sources: ["cms"],
    seeAll: (pq) => ({ label: "See all in Partners", link: `/admin/content/partners?q=${enc(pq.text)}` }) },
  { key: "logos", label: "Alumni and sponsor logos", access: "staff", sources: ["cms"] },
  { key: "nominations", label: "Award nominations", access: "staff", sources: ["nominations"],
    seeAll: (pq) => ({ label: "See all in Nominations", link: `/admin/awards?q=${enc(pq.text)}` }) },
  { key: "forms", label: "Form submissions", access: "staff", sources: ["forms"],
    seeAll: (pq) => ({ label: "See all in Form submissions", link: `/admin/form-submissions?q=${enc(pq.text)}` }) },
  { key: "brochures", label: "Brochure downloads", access: "staff", sources: ["brochures"],
    seeAll: (pq) => ({ label: "See all in Brochure downloads", link: `/admin/brochure-downloads?q=${enc(pq.text)}` }) },
  { key: "pavilion", label: "India Pavilion applications", access: "staff", sources: ["pavilion"],
    seeAll: (pq) => ({ label: "See all in India Pavilion", link: `/admin/india-pavilion?q=${enc(pq.text)}` }) },
  { key: "staff", label: "Staff accounts", access: "management", sources: ["staff"],
    seeAll: () => ({ label: "Open Staff accounts", link: "/admin/staff" }) },
];

/** The groups this viewer may search: { management } | { volunteer: true } → group definitions. */
export function groupsFor(viewer = {}) {
  if (viewer.volunteer === true) return GROUPS.filter((g) => g.volunteer === true);
  return GROUPS.filter((g) => g.access === "staff" || (g.access === "management" && viewer.management === true));
}

/* ---------- People directory groups (services/people.js buildPeople records) ---------- */

const KIND_LABELS = { account: "Account, no pass", pass: "Pass holder", speaker: "Website speaker", rsvp: "RSVP only" };
const personLink = (p) => `/admin/people/${enc(p.id)}`;
const personEmails = (p) => new Set([realEmail(p.email), realEmail(p.user?.email), ...[...(p.emails || [])].map(realEmail)].filter(Boolean));
const personFields = (p) => [[p.name === "No name" ? "" : p.name, 10], [p.company, 5], [p.jobTitle, 4]];
const ticketHit = (pq, id) => !!pq.ticket && normalizeTicketId(id) === pq.ticket;

/** CA$849.00 (management only). */
export const money = (v) => (typeof v === "number" && Number.isFinite(v) ? `CA$${v.toFixed(2)}` : "");

/** People: accounts, pass holders, website speakers and RSVP-only people, by the directory's merged person ids.
    `volunteer`: the volunteer panel: the safe name, job title and company (services/volunteerSafe.js), matched on those
    only, no email in the subtitle and no "Hidden from app" badge. */
export function peopleItems(people = [], pq, { volunteer = false } = {}) {
  const out = [];
  for (const p of people) {
    const exact = (pq.email && personEmails(p).has(pq.email))
      || (pq.ticket && ((p.passList || []).some((t) => t.norm === pq.ticket) || (p.boothOrders || []).some((b) => ticketHit(pq, b))));
    const score = exact ? EXACT : textScore(pq, volunteer ? safeSearchFields(p) : personFields(p));
    if (!score) continue;
    const work = (volunteer ? [safeText(p.jobTitle, p), safeText(p.company, p)] : [p.jobTitle, p.company]).filter(Boolean).join(", ");
    // "Hidden from app" first, so staff searching for someone see it straight away (services/appHide.js).
    const badges = [...(p.appHidden && !volunteer ? ["Hidden from app"] : []), ...(p.types || []).filter((t) => t !== "attendee").map((t) => TYPE_LABELS[t] || t), ...(p.vip ? ["VIP"] : [])].slice(0, 3);
    out.push({
      type: "person", id: p.id, title: volunteer ? safeName(p) : p.name, score, exact: !!exact,
      subtitle: join(work, volunteer ? "" : p.email, p.primary ? p.primary.label : KIND_LABELS[p.kind] || ""),
      link: personLink(p), badges,
    });
  }
  return out;
}

/**
 * Tickets, by exact ticket ID only: the person who holds it (their profile), else the Tickets page (a pass staff hid
 * that no account holds: its Hidden tab; or a booth order). `extra`: Attendee rows found by that ticket ID (sources.ticketDocs).
 * `amounts`: management only, what the pass was paid after promo codes, before HST (the People directory's value).
 */
export function ticketItems(people = [], pq, { extra = [], amounts = false } = {}) {
  if (!pq.ticket) return [];
  const out = [];
  const seen = new Set();
  for (const p of people) {
    for (const t of p.passList || []) {
      if (t.norm !== pq.ticket) continue;
      seen.add(t.norm);
      out.push({
        type: "ticket", id: t.ticketId, title: `${t.label} · ${upperId(t.ticketId)}`, score: EXACT, exact: true,
        subtitle: join(p.name, PASS_STATUS_LABELS[t.status] || "", t.checkedIn ? "Checked in" : "", t.hidden ? "Hidden from staff lists" : "",
          amounts ? money(t.value) : ""),
        link: personLink(p),
      });
    }
    for (const b of p.boothOrders || []) {
      if (!ticketHit(pq, b) || seen.has(normalizeTicketId(b))) continue;
      seen.add(normalizeTicketId(b));
      out.push({ type: "ticket", id: b, title: `Booth order · ${upperId(b)}`, score: EXACT, exact: true, subtitle: p.name, link: `/admin/attendees?q=${enc(b)}` });
    }
  }
  for (const a of extra || []) {
    const norm = normalizeTicketId(a?.ticketId);
    if (!a?.ticketId || norm !== pq.ticket || seen.has(norm)) continue;
    seen.add(norm);
    const booth = /^BOOTH-/i.test(a.ticketId);
    out.push({
      type: "ticket", id: a.ticketId, score: EXACT, exact: true,
      title: `${booth ? "Booth order" : TIER_LABELS[tierFromTicketType(a.ticketType)] || "Pass"} · ${upperId(a.ticketId)}`,
      subtitle: join(String(a.name || "").trim(), a.hiddenByStaff || a.syncDuplicate ? "Hidden from staff lists" : "", a.checkedIn ? "Checked in" : ""),
      link: `/admin/attendees?q=${enc(a.ticketId)}${a.hiddenByStaff ? "&show=hidden" : ""}`,
    });
  }
  return out;
}

/* The pass pages: Speaker passes (promo SPEAKER), Issue passes (ISSUED), Exhibitor passes (EXHIBITOR) and the
   complimentary passes made on the Tickets page (COMP). Each links to its page, searched by the ticket ID. */
const PASS_PAGES = {
  SPEAKER: { type: "speaker-pass", what: "Speaker passes", page: "/admin/speaker-passes" },
  ISSUED: { type: "issued-pass", what: "Give a pass", page: "/admin/issued-passes" },
  EXHIBITOR: { type: "exhibitor-pass", what: "Exhibitor passes", page: "/admin/exhibitor-passes" },
  COMP: { type: "comp-pass", what: "Complimentary", page: "/admin/attendees" },
};
const passPage = (t) => PASS_PAGES[String(t.promoCode || "").toUpperCase()] || (t.tier === "speaker" && !t.stripeSessionId ? PASS_PAGES.SPEAKER : null);

/** Speaker, issued, exhibitor and complimentary passes: who holds them, the pass, its state, the page that manages it. */
export function passItems(people = [], pq) {
  const out = [];
  for (const p of people) {
    for (const t of p.passList || []) {
      const page = passPage(t);
      if (!page || t.hidden) continue;
      const exact = (pq.ticket && t.norm === pq.ticket) || (pq.email && personEmails(p).has(pq.email));
      const score = exact ? EXACT : textScore(pq, [...personFields(p), [t.booth ? `booth ${t.booth}` : "", 4], [t.printedLabel, 3], [t.label, 2]]);
      if (!score) continue;
      out.push({
        type: page.type, id: t.ticketId, title: p.name, score, exact: !!exact,
        subtitle: join(`${t.label}${t.exhibitorPass ? " (exhibitor)" : ""}`, t.printedLabel && t.printedLabel !== t.label ? `“${t.printedLabel}”` : "",
          t.booth ? `Booth ${t.booth}` : "", PASS_STATUS_LABELS[t.status] || "", page.what),
        link: `${page.page}?q=${enc(t.ticketId)}`,
      });
    }
  }
  return out;
}

const DAY_LABEL = Object.fromEntries(DAYS.map((d) => [d.key, d.label]));
const rsvpName = (r) => String(r.name || [r.firstName, r.lastName].filter(Boolean).join(" ") || "").trim();

/** RSVPs (the website /rsvp answers and staff-made ones; not bots, not merged). Opens the RSVP on RSVPs & meals › Headcounts & RSVPs. */
export function rsvpItems(rsvps = [], pq) {
  const out = [];
  for (const r of rsvps) {
    if (!r?._id) continue;
    const exact = (pq.email && realEmail(r.email) === pq.email) || ticketHit(pq, r.ticketId);
    const name = rsvpName(r);
    const score = exact ? EXACT : textScore(pq, [[name, 10], [`${r.firstName || ""} ${r.lastName || ""}`, 9]]);
    if (!score) continue;
    const st = rsvpStatusOf(r);
    const days = (r.days || []).map((d) => DAY_LABEL[d] || d);
    out.push({
      type: "rsvp", id: String(r._id), title: name || "No name", score, exact: !!exact,
      subtitle: join(TIER_LABELS[r.tier] || "", days.length === 2 ? "Both days" : days.join(" & "), st.label, r.duplicateOf ? "Possible duplicate" : ""),
      link: `/admin/rsvps?id=${enc(String(r._id))}`,
    });
  }
  return out;
}

/* ---------- CMS (Sanity, read only) ---------- */

const PARTNER_CATEGORY_LABELS = {
  partnersAndSupporters: "Our Partners and Supporters", governmentPartners: "Government Partners", industryAssociates: "Industry Associates",
  academicResearchInstitutions: "Academic and Research Institutions", corporateEnterprisePartners: "Corporate and Enterprise Partners",
  startupEcosystemPartners: "Startup and Ecosystem Partners", internationalTradeBodies: "International Trade Bodies", other: "Other",
};
const LOGO_TYPES = {
  sponsor: { label: "Alumni logo strip", page: "/admin/content/alumni-logos" },
  sponsorMarquee: { label: "Sponsor marquee", page: "/admin/content/sponsor-marquee" },
  homeSponsor: { label: "Home sponsors", page: "/admin/content/home-sponsors" },
};
const names = (list) => (Array.isArray(list) ? list.map((x) => (typeof x === "string" ? x : x?.name)).filter(Boolean) : []);

/** The CMS documents (sessions, speakers, partners, logo strips) → { sessions, speakers, partners, logos } items. */
export function cmsItems(docs = [], pq) {
  const out = { sessions: [], speakers: [], partners: [], logos: [] };
  if (pq.email) return out; // nothing in the CMS has an email to match exactly
  for (const d of docs || []) {
    if (!d?._id || String(d._id).startsWith("drafts.")) continue;
    const edit = (page) => `${page}?edit=${enc(d._id)}`;
    if (d._type === "session") {
      const people = [...names(d.speakers), ...names([d.moderator])];
      const score = (pq.ticket && lower(d.sessionId) === pq.ticket ? EXACT : 0)
        || textScore(pq, [[d.title, 10], [people.join(", "), 6], [d.stage, 3], [d.type, 3]]);
      if (!score) continue;
      const day = Number(d.day) === 1 || Number(d.day) === 2 ? `Day ${Number(d.day)}` : "";
      out.sessions.push({
        type: "session", id: d._id, title: d.title || "Untitled session", score,
        subtitle: join(day, d.time ? `${d.time}${d.endTime ? `–${d.endTime}` : ""}` : "", d.stage, d.type, people.slice(0, 3).join(", ")),
        link: edit("/admin/content/agenda"),
      });
    } else if (d._type === "speaker") {
      const score = textScore(pq, [[d.name, 10], [d.company, 5], [d.title, 4]]);
      if (!score) continue;
      out.speakers.push({
        type: "cms-speaker", id: d._id, title: d.name || "No name", score,
        subtitle: join([d.title, d.company].filter(Boolean).join(", "), d.featured ? "Featured" : ""),
        link: edit("/admin/content/speakers"),
      });
    } else if (d._type === "partner") {
      const score = textScore(pq, [[d.name, 10], [PARTNER_CATEGORY_LABELS[d.category] || "", 1]]);
      if (!score) continue;
      // The website decides which partners are sponsors (src/data/sponsors.js isSponsor, with its built-in
      // Featured Partners list): `meta` lets the panel label and link them the same way.
      out.partners.push({
        type: "partner", id: d._id, title: d.name || "No name", score,
        subtitle: join(d.matrixGroup === "featured" ? "Featured Partner (sponsor)" : PARTNER_CATEGORY_LABELS[d.category] || "Partner", d.active === false ? "Hidden" : ""),
        link: edit("/admin/content/partners"),
        meta: { matrixGroup: d.matrixGroup || "", category: d.category || "", active: d.active !== false },
      });
    } else if (LOGO_TYPES[d._type]) {
      const score = textScore(pq, [[d.name, 10]]);
      if (!score) continue;
      out.logos.push({
        type: "logo", id: d._id, title: d.name || "No name", score,
        subtitle: join(LOGO_TYPES[d._type].label, d.active === false ? "Hidden" : ""),
        link: edit(LOGO_TYPES[d._type].page),
      });
    }
  }
  return out;
}

/* ---------- Leads and the rest (database rows) ---------- */

const day = (d) => {
  const t = d ? new Date(d) : null;
  return t && Number.isFinite(t.getTime()) ? t.toISOString().slice(0, 10) : "";
};

/** Catalyst Awards nominations: nominee, their organisation, the nominator; nominee / nominator email exactly. */
export function nominationItems(docs = [], pq) {
  const out = [];
  for (const n of docs || []) {
    const exact = pq.email && [n.nomineeEmail, n.nominatorEmail].map(realEmail).includes(pq.email);
    const score = exact ? EXACT : textScore(pq, [[n.nomineeName, 10], [n.nomineeOrganisation, 5], [n.nominatorName, 6], [n.nominatorOrganisation, 3]]);
    if (!score) continue;
    out.push({
      type: "nomination", id: String(n._id), title: n.nomineeName || "No name", score, exact: !!exact,
      subtitle: join(categoryShort(n), n.nomineeOrganisation, n.selfNomination ? "Self-nominated" : n.nominatorName ? `by ${n.nominatorName}` : "",
        (n.status || "pending").replace(/^./, (c) => c.toUpperCase())),
      link: `/admin/awards?id=${enc(String(n._id))}`,
    });
  }
  return out;
}

const fullName = (d) => String(d.name || [d.firstName, d.lastName].filter(Boolean).join(" ") || "").trim();

/** Website form submissions (not bots): volunteer, speaker, booth, sponsor, partnership, enquiry. */
export function formItems(docs = [], pq) {
  const out = [];
  for (const s of docs || []) {
    const exact = pq.email && realEmail(s.email) === pq.email;
    const name = fullName(s);
    const score = exact ? EXACT : textScore(pq, [[name, 10], [s.company, 5], [s.jobTitle, 4]]);
    if (!score) continue;
    out.push({
      type: "form", id: String(s._id), title: name || s.company || "No name", score, exact: !!exact,
      subtitle: join(FORMS[s.form]?.label || s.form || "", s.company, FORM_STATUS_LABEL[s.status || "new"] || "", day(s.createdAt)),
      link: `/admin/form-submissions?id=${enc(String(s._id))}`,
    });
  }
  return out;
}

/** Brochure downloads (not bots). The page has no drawer: it opens searched by the person's email. */
export function brochureItems(docs = [], pq) {
  const out = [];
  for (const b of docs || []) {
    const exact = pq.email && realEmail(b.email) === pq.email;
    const name = fullName(b);
    const score = exact ? EXACT : textScore(pq, [[name, 10], [b.company, 5], [b.jobTitle, 4]]);
    if (!score) continue;
    out.push({
      type: "brochure", id: String(b._id), title: name || "No name", score, exact: !!exact,
      subtitle: join([b.jobTitle, b.company].filter(Boolean).join(", "), BROCHURES[b.brochure || DEFAULT_BROCHURE]?.title || "Brochure", day(b.createdAt)),
      link: `/admin/brochure-downloads?q=${enc(b.email || name)}`,
    });
  }
  return out;
}

/** India Pavilion applications (not bots): company, contact, reference; the contact's email exactly. No deposit amounts. */
export function pavilionItems(docs = [], pq) {
  const out = [];
  for (const a of docs || []) {
    const exact = (pq.email && realEmail(a.repEmail) === pq.email) || (!!a.reference && lower(a.reference) === lower(pq.text));
    const score = exact ? EXACT : textScore(pq, [[a.legalName, 10], [a.tradingName, 8], [a.repName, 8], [a.reference, 6]]);
    if (!score) continue;
    out.push({
      type: "pavilion", id: String(a._id), title: a.legalName || a.tradingName || "No name", score, exact: !!exact,
      subtitle: join(a.repName, a.reference, PAVILION_STATUS_LABEL[a.status || "new"] || ""),
      link: `/admin/india-pavilion?id=${enc(String(a._id))}`,
    });
  }
  return out;
}

/** Staff accounts and volunteers (management only). */
export function staffItems(users = [], pq, { isManagement = () => false } = {}) {
  const out = [];
  for (const u of users || []) {
    if (u?.role !== "admin" && u?.role !== "volunteer") continue;
    const exact = pq.email && realEmail(u.email) === pq.email;
    const score = exact ? EXACT : textScore(pq, [[u.name, 10]]);
    if (!score) continue;
    out.push({
      type: "staff", id: String(u._id), title: u.name || u.email || "No name", score, exact: !!exact,
      subtitle: join(u.role === "volunteer" ? "Volunteer" : isManagement(u) ? "Management" : "Staff", u.email),
      link: `/admin/staff?highlight=${enc(String(u._id))}`,
    });
  }
  return out;
}

/* ---------- Database prefilter ---------- */

/**
 * A MongoDB filter that narrows a collection to rows that could match, before matchScore decides:
 * email mode → the email fields equal to it (indexed); text → the longest word inside any text field
 * (accentRegex: escaped, accent-insensitive). `base` is added (e.g. { spam: { $ne: true } }).
 */
export function prefilter(pq, { text = [], emails = [], base = {} } = {}) {
  if (pq.email) {
    if (!emails.length) return null;
    const vals = [...new Set([pq.email, pq.text])];
    return { ...base, $or: emails.map((f) => ({ [f]: { $in: vals } })) };
  }
  const word = [...pq.words].sort((a, b) => b.length - a.length)[0];
  if (!word || !text.length) return null;
  const rx = accentRegex(word);
  return { ...base, $or: text.map((f) => ({ [f]: rx })) };
}

/* ---------- Running a search ---------- */

class SearchTimeout extends Error {
  constructor() { super("timed out"); this.name = "SearchTimeout"; this.code = "TIMEOUT"; }
}
function withTimeout(promise, ms) {
  let t;
  const limit = new Promise((_, reject) => { t = setTimeout(() => reject(new SearchTimeout()), ms); });
  return Promise.race([Promise.resolve(promise), limit]).finally(() => clearTimeout(t));
}

const byScore = (a, b) => b.score - a.score || String(a.title).localeCompare(String(b.title), "en", { sensitivity: "base" });

// The four CMS groups come from one pass over the CMS documents.
const cmsCache = new WeakMap();
function cmsOnce(s, pq) {
  if (!cmsCache.has(s)) cmsCache.set(s, cmsItems(s.cms, pq));
  return cmsCache.get(s);
}

/** Group key → (sources' answers, query, viewer) → items. */
const BUILDERS = {
  tickets: (s, pq, v) => ticketItems(s.directory.people, pq, { extra: s.ticketDocs || [], amounts: v.management === true }),
  people: (s, pq, v) => peopleItems(s.directory.people, pq, { volunteer: v.volunteer === true }),
  passes: (s, pq) => passItems(s.directory.people, pq),
  rsvps: (s, pq) => rsvpItems(s.directory.rsvps, pq),
  sessions: (s, pq) => cmsOnce(s, pq).sessions,
  speakers: (s, pq) => cmsOnce(s, pq).speakers,
  partners: (s, pq) => cmsOnce(s, pq).partners,
  logos: (s, pq) => cmsOnce(s, pq).logos,
  nominations: (s, pq) => nominationItems(s.nominations, pq),
  forms: (s, pq) => formItems(s.forms, pq),
  brochures: (s, pq) => brochureItems(s.brochures, pq),
  pavilion: (s, pq) => pavilionItems(s.pavilion, pq),
  staff: (s, pq, v) => staffItems(s.staff, pq, { isManagement: v.isManagement }),
};

/**
 * Search everything this viewer may see.
 *   q        the query as typed
 *   viewer   { management: boolean, isManagement?: (user) => boolean (for the Staff accounts labels) },
 *            or { volunteer: true } (the volunteer panel: People only, see groupsFor / peopleItems)
 *   sources  { directory, ticketDocs, cms, nominations, forms, brochures, pavilion, staff }: (pq) => Promise of rows
 *            (directory → { people, rsvps }); only the ones the allowed groups need are called, each once
 *   log      where failures are reported: the source's name and the error's name / code only, never the query
 * → { query: { text, exact }, tooShort, minChars, groups: [{ key, label, items, total, more, seeAll? }],
 *     failed: [{ key, label, reason: "timeout" | "error" }], tookMs }
 * A source that fails or takes longer than `timeoutMs` only takes its own groups out (listed in `failed`).
 */
export async function runSearch({ q, viewer = {}, sources = {}, cap = GROUP_CAP, timeoutMs = SOURCE_TIMEOUT_MS, log = console, now = () => Date.now() } = {}) {
  const started = now();
  const pq = parseQuery(q);
  // A volunteer's answer never repeats an email or a ticket ID they searched for.
  const hideText = viewer.volunteer === true && !!(pq.email || pq.ticket);
  const base = { query: { text: hideText ? "" : pq.text, exact: pq.email ? "email" : pq.ticket ? "ticket" : "" }, minChars: SEARCH_MIN_CHARS };
  if (pq.tooShort) return { ...base, tooShort: true, groups: [], failed: [], tookMs: 0 };

  const allowed = groupsFor(viewer).filter((g) => !g.exactOnly || pq.ticket);
  const names = [...new Set(allowed.flatMap((g) => g.sources))];
  const answers = {};
  const errors = {};
  await Promise.all(names.map(async (name) => {
    const fn = sources[name];
    if (typeof fn !== "function") { errors[name] = "error"; return; }
    try {
      answers[name] = await withTimeout(fn(pq), timeoutMs);
    } catch (err) {
      errors[name] = err?.code === "TIMEOUT" ? "timeout" : "error";
      // Never the query or the error's message (a database error can quote the filter): what failed, and how.
      log.error?.(`ADMIN SEARCH: ${name} ${errors[name] === "timeout" ? `timed out after ${timeoutMs} ms` : `failed (${err?.name || "Error"}${err?.code ? ` ${err.code}` : ""})`}`);
    }
  }));

  const groups = [];
  const failed = [];
  for (const g of allowed) {
    const [primary] = g.sources;
    if (errors[primary]) { failed.push({ key: g.key, label: g.label, reason: errors[primary] }); continue; }
    let items;
    try {
      items = BUILDERS[g.key](answers, pq, viewer);
    } catch (err) {
      log.error?.(`ADMIN SEARCH: ${g.key} results failed (${err?.name || "Error"})`);
      failed.push({ key: g.key, label: g.label, reason: "error" });
      continue;
    }
    if (!items.length) continue;
    items.sort(byScore);
    groups.push({
      key: g.key, label: g.label, total: items.length, more: items.length > cap,
      items: items.slice(0, cap).map(({ score: _s, ...it }) => it),
      ...(g.seeAll && !hideText ? { seeAll: g.seeAll(pq) } : {}),
    });
  }
  // An exact hit (that email, that ticket ID) puts its group first; otherwise the fixed order.
  groups.sort((a, b) => Number(!!b.items[0]?.exact) - Number(!!a.items[0]?.exact));
  return { ...base, tooShort: false, groups, failed, tookMs: now() - started };
}
