/* =========================================================
   RSVPs for TTFC 2026 (website /rsvp, a page with no links to it)
   ---------------------------------------------------------
   The ONE copy of what each pass includes on the day. The website
   reads it from GET /api/rsvp/options, so it is never duplicated.
   It must match the Tickets page matrix (techfest-canada-frontend
   src/pages/Tickets.jsx `passFeatureMap`) and PASS_INCLUSIONS in
   services/ticketInfo.js.

   Also here, all pure so they can be unit-tested (test/rsvp.test.js):
   ticket type → pass mapping, name matching (accents, honorifics,
   middle names, nicknames), the speaker list cache, validation,
   the "one RSVP per person" keys and edit tokens, and the admin rows,
   totals, CSV and duplicate merge.
   The request handlers are in services/rsvpHandler.js; routes/rsvp.js
   and routes/console.js wire them to the database.
========================================================= */

import { createHash, randomBytes } from "node:crypto";
import { cleanText, cleanPage, csvCell } from "./brochureDownloads.js";
import { normalizeTicketId } from "./ticketAccess.js";

/* ---------- Passes ---------- */
/* The four passes on sale, and the internal Speaker Pass (Oct 19 2026): never sold or listed on the
   website; Power's options plus the two CxO Breakfasts (no Apex meetings or Scotch lounge). */
export const PASS_TIERS = ["connect", "influence", "power", "apex"];
export const TIERS = [...PASS_TIERS, "speaker"];
export const TIER_LABELS = {
  connect: "Connect Pass", influence: "Influence Pass", power: "Power Pass", apex: "Apex Pass", speaker: "Speaker Pass",
};

/* ---------- Days ---------- */
export const DAYS = [
  { key: "day1", label: "Day 1", date: "2026-10-26", long: "Monday 26 October" },
  { key: "day2", label: "Day 2", date: "2026-10-27", long: "Tuesday 27 October" },
];
export const DAY_KEYS = DAYS.map((d) => d.key);

const EVERYONE = [...TIERS];
const INFLUENCE_UP = ["influence", "power", "apex", "speaker"];
const POWER_UP = ["power", "apex", "speaker"];
const APEX_UP = ["apex", "speaker"];

/* ---------- What each pass includes ----------
   `day`: the day it happens on, so it is only offered to people coming that
   day (null = not tied to a day the person picks). `tiers`: who may choose it. */
export const RSVP_OPTIONS = [
  { key: "day1", kind: "day", day: "day1", label: "Day 1 conference (Mon 26 Oct)", tiers: EVERYONE,
    description: "Keynotes, panels and the expo floor." },
  { key: "day2", kind: "day", day: "day2", label: "Day 2 conference (Tue 27 Oct)", tiers: EVERYONE,
    description: "Keynotes, panels and the expo floor." },
  // What every pass includes on the day (Tickets page: conference days, expo floor, networking breaks).
  // Asked like the rest, so the headcounts say who will actually be in the room.
  { key: "sessions_d1", kind: "experience", day: "day1", label: "Keynotes, panels & sessions", tiers: EVERYONE,
    description: "The main stage and the breakout sessions." },
  { key: "sessions_d2", kind: "experience", day: "day2", label: "Keynotes, panels & sessions", tiers: EVERYONE,
    description: "The main stage and the breakout sessions." },
  { key: "expo_d1", kind: "experience", day: "day1", label: "Expo Floor", tiers: EVERYONE,
    description: "Exhibitors, product demos and partner stands." },
  { key: "expo_d2", kind: "experience", day: "day2", label: "Expo Floor", tiers: EVERYONE,
    description: "Exhibitors, product demos and partner stands." },
  { key: "breaks_d1", kind: "experience", day: "day1", label: "Networking Breaks & Coffee", tiers: EVERYONE,
    description: "Coffee and conversation between sessions." },
  { key: "breaks_d2", kind: "experience", day: "day2", label: "Networking Breaks & Coffee", tiers: EVERYONE,
    description: "Coffee and conversation between sessions." },
  // Each day in the order it happens. `time` is only a fallback: the page shows the start time of the
  // matching agenda session (AGENDA_MATCH below, read from the CMS), so moving a session moves it here.
  // CxO Breakfasts (Oct 19 2026): Apex and Speaker Passes, plus speakers on any pass and passes staff
  // switched on (`cxo` in allowedExperiences, services/cxoBreakfast.js). Power no longer includes them.
  { key: "cxo_d1", kind: "experience", day: "day1", time: "7:55 AM", label: "CxO Breakfast", tiers: APEX_UP,
    description: "Invitation-only breakfast for senior leaders." },
  { key: "lunch_d1", kind: "experience", day: "day1", time: "12:35 PM", label: "Networking Luncheon", tiers: INFLUENCE_UP,
    description: "Seated lunch with fellow delegates." },
  { key: "awards", kind: "experience", day: "day1", time: "5:30 PM", label: "Catalyst Awards Night", tiers: POWER_UP,
    description: "The Catalyst Awards ceremony on the evening of Day 1." },
  { key: "cxo_d2", kind: "experience", day: "day2", time: "7:55 AM", label: "CxO Breakfast", tiers: APEX_UP,
    description: "Invitation-only breakfast for senior leaders." },
  { key: "lunch_d2", kind: "experience", day: "day2", time: "12:00 PM", label: "Networking Luncheon", tiers: INFLUENCE_UP,
    description: "Seated lunch with fellow delegates." },
  // Day 2 evening, as on the website agenda (src/data/agenda.js "d2-21") and the CMS session (17:30).
  { key: "gala", kind: "experience", day: "day2", time: "5:30 PM", label: "Gala Dinner & Networking Reception", tiers: POWER_UP,
    description: "Dinner and drinks with speakers, partners and delegates on the evening of Day 2." },
  // Apex only: speakers don't get pre-matched meetings or the Scotch lounge (client decision, Oct 2026).
  { key: "meetings", kind: "experience", day: null, label: "Two Pre-Matched Business Meetings", tiers: ["apex"],
    description: "Two meetings we line up for you in advance, matched to your objectives." },
  { key: "lounge", kind: "experience", day: null, label: "Private Scotch & Cocktail Lounge (19+)", tiers: ["apex"],
    description: "A quiet room for conversations over Scotch and cocktails.", note: "19+ only. Bring photo ID." },
];
export const OPTION_KEYS = RSVP_OPTIONS.map((o) => o.key);
/** The two CxO Breakfasts: offered by pass, the speaker type or staff's per-pass switch (services/cxoBreakfast.js). */
export const CXO_KEYS = ["cxo_d1", "cxo_d2"];
export const EXPERIENCE_KEYS = RSVP_OPTIONS.filter((o) => o.kind === "experience").map((o) => o.key);
/** The meals and events staff can switch per pass (services/passExtras.js: Automatic / Yes / No), and the
    RSVP options each one is. Automatic follows `tiers` above (CxO Breakfasts: also anyone of the speaker type). */
export const EXTRA_OPTIONS = Object.freeze({
  cxo: Object.freeze([...CXO_KEYS]), lunch: Object.freeze(["lunch_d1", "lunch_d2"]), gala: Object.freeze(["gala"]), awards: Object.freeze(["awards"]),
});
export const EXTRA_KEYS = Object.freeze(Object.keys(EXTRA_OPTIONS));
/** Every RSVP option a pass extra decides, in display order. */
export const EXTRA_OPTION_KEYS = EXPERIENCE_KEYS.filter((k) => EXTRA_KEYS.some((x) => EXTRA_OPTIONS[x].includes(k)));
/** "lunch_d2" → "lunch"; "" when the option isn't a pass extra. */
export const extraForOption = (key) => EXTRA_KEYS.find((x) => EXTRA_OPTIONS[x].includes(key)) || "";
const OPTION_BY_KEY = Object.fromEntries(RSVP_OPTIONS.map((o) => [o.key, o]));
export const optionLabel = (key) => {
  const o = OPTION_BY_KEY[key];
  if (!o) return String(key || "");
  return o.day && o.kind === "experience" && !/day \d/i.test(o.label) ? `${o.label} (${o.day === "day1" ? "Day 1" : "Day 2"})` : o.label;
};

/* ---------- Dietary ---------- */
export const DIETARY = [
  { key: "none", label: "None" },
  { key: "vegetarian", label: "Vegetarian" },
  { key: "vegan", label: "Vegan" },
  { key: "halal", label: "Halal" },
  { key: "kosher", label: "Kosher" },
  { key: "gluten_free", label: "Gluten-free" },
  { key: "dairy_free", label: "Dairy-free" },
  { key: "nut_allergy", label: "Nut allergy" },
  { key: "shellfish_allergy", label: "Shellfish allergy" },
  { key: "other", label: "Other" },
];
export const DIETARY_KEYS = DIETARY.map((d) => d.key);
const DIETARY_LABEL = Object.fromEntries(DIETARY.map((d) => [d.key, d.label]));

/* ---------- Times from the agenda (Sanity `session` docs, the admin Agenda editor) ----------
   Which agenda session each timed experience is: same day, title matching. */
export const AGENDA_MATCH = {
  cxo_d1: { day: 1, title: /cxo\s*breakfast/i },
  lunch_d1: { day: 1, title: /lunch/i },
  awards: { day: 1, title: /award|catalyst/i },
  cxo_d2: { day: 2, title: /cxo\s*breakfast/i },
  lunch_d2: { day: 2, title: /lunch/i },
  gala: { day: 2, title: /gala/i },
};
const RSVP_AGENDA_QUERY = '*[_type=="session" && !(_id in path("drafts.**"))]{day,time,title}';
export const RSVP_AGENDA_URL =
  `https://021qtoci.apicdn.sanity.io/v2021-10-21/data/query/production?query=${encodeURIComponent(RSVP_AGENDA_QUERY)}`;

/** Sanity result → [{ day, time: "HH:MM", title }], or null when there are none (keep the last good copy). */
export function parseRsvpAgenda(json) {
  const out = [];
  for (const s of Array.isArray(json?.result) ? json.result : []) {
    const day = Number(s?.day);
    const time = typeof s?.time === "string" ? s.time.trim() : "";
    const title = typeof s?.title === "string" ? s.title.trim() : "";
    if ((day === 1 || day === 2) && /^\d{1,2}:\d{2}$/.test(time) && title) out.push({ day, time: time.padStart(5, "0"), title });
  }
  return out.length ? out : null;
}

/** "07:55" → "7:55 AM", "17:30" → "5:30 PM". */
export function clock12(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** Agenda sessions → { optionKey: "7:55 AM" } for every experience whose session is on the agenda (earliest match). */
export function agendaTimes(sessions) {
  const out = {};
  for (const [key, m] of Object.entries(AGENDA_MATCH)) {
    const hit = (sessions || []).filter((s) => s.day === m.day && m.title.test(s.title)).sort((a, b) => a.time.localeCompare(b.time))[0];
    if (hit) out[key] = clock12(hit.time);
  }
  return out;
}

/** What GET /api/rsvp/options serves (the website builds the form from this).
    `times` (from agendaTimes) replaces the fallback times. */
export function rsvpOptionsPayload(times = null) {
  return {
    event: { name: "The Tech Festival Canada 2026", venue: "The Westin Harbour Castle, Toronto", start: "2026-10-26", end: "2026-10-27" },
    tiers: TIERS.map((key) => ({ key, label: TIER_LABELS[key], sold: key !== "speaker" })),
    days: DAYS,
    options: RSVP_OPTIONS.map(({ tiers, ...o }) => ({ ...o, ...(o.time && times?.[o.key] ? { time: times[o.key] } : {}), tiers: [...tiers] })),
    dietary: DIETARY,
  };
}

/**
 * May someone on `tier` choose `key`? (Ignores days.) `extras`: their pass's effective extras
 * ({ cxo, lunch, gala, awards }: true / false, services/passExtras.js), which decide those options;
 * one that isn't a boolean goes by tier. `cxo`: the CxO Breakfasts alone (older callers), when `extras.cxo` isn't set.
 */
export function tierIncludes(tier, key, { cxo, extras } = {}) {
  const o = OPTION_BY_KEY[key];
  if (!o) return false;
  const x = extraForOption(key);
  const v = !x ? undefined : typeof extras?.[x] === "boolean" ? extras[x] : x === "cxo" ? cxo : undefined;
  if (typeof v === "boolean") return v;
  return o.tiers.includes(tier);
}

/**
 * Experiences someone on `tier` coming on `days` can choose, in display order.
 *   extras — their pass's effective extras (true / false each, services/passExtras.js); a missing one = by tier
 *   cxo    — the CxO Breakfasts alone (true / false), for callers without `extras`
 *   extra  — keys they keep whatever the pass says (an extra already on their RSVP, extraOptionsFor)
 */
export function allowedExperiences(tier, days = [], { cxo, extras, extra = [] } = {}) {
  const d = new Set(days);
  const keep = new Set(extra || []);
  return RSVP_OPTIONS
    .filter((o) => o.kind === "experience" && (tierIncludes(tier, o.key, { cxo, extras }) || keep.has(o.key)) && (!o.day || d.has(o.day)))
    .map((o) => o.key);
}

/**
 * Pass extras (CxO Breakfasts, luncheons, the Gala Dinner, the Awards Night) already on someone's RSVP rows
 * (theirs or staff's): they keep being offered to them, so a re-sent RSVP never loses one that a pass change
 * or staff's "No" took away. We never change an RSVP the attendee made.
 */
export function extraOptionsFor(rows = []) {
  const have = new Set();
  for (const r of rows || []) for (const k of r?.options || []) if (EXTRA_OPTION_KEYS.includes(k)) have.add(k);
  return EXTRA_OPTION_KEYS.filter((k) => have.has(k));
}

/**
 * Check the chosen experiences against the matrix (`extras`, `cxo`, `extra`: see allowedExperiences).
 * @returns {{ ok: true, options: string[] } | { ok: false, error: string, invalid: string[] }}
 */
export function checkOptions(tier, days, options, { cxo, extras, extra = [] } = {}) {
  const allowed = new Set(allowedExperiences(tier, days, { cxo, extras, extra }));
  const picked = [...new Set((Array.isArray(options) ? options : []).map((o) => cleanText(o)).filter(Boolean))]
    .filter((k) => !DAY_KEYS.includes(k)); // days travel in `days`
  const invalid = picked.filter((k) => !allowed.has(k));
  if (invalid.length) {
    const what = invalid.map((k) => (OPTION_BY_KEY[k] ? optionLabel(k) : `"${k.slice(0, 40)}"`)).join(", ");
    return { ok: false, invalid, error: `Not included with the ${TIER_LABELS[tier] || "selected pass"} on the days you picked: ${what}` };
  }
  return { ok: true, options: EXPERIENCE_KEYS.filter((k) => picked.includes(k)) };
}

/* ---------- Ticket type → pass ----------
   Stored ticket types are lower-case keys ("connect", "power"…) on new
   tickets, but older ones hold retired keys ("vip", "discover", "early",
   "festival", "session") and a few hold display names ("TTFC Apex Pass").
   Retired/unknown passes get the base Connect entitlements, the same as
   inclusionsFor() in services/ticketInfo.js does. */
export function tierFromTicketType(type) {
  const s = String(type || "").toLowerCase().replace(/ttfc|20\d\d|pass|ticket/g, " ").replace(/[^a-z-]+/g, " ").trim();
  if (!s) return "connect";
  if (/\bspeaker\b/.test(s)) return "speaker"; // Speaker Pass (staff-issued, never sold): Power + the CxO Breakfasts
  if (/\b(apex|vip)\b/.test(s)) return "apex";
  // "All Access Pass" is the Power Pass, never Apex (Oct 19 2026).
  if (/\b(power|all[- ]access)\b/.test(s)) return "power";
  if (/\binfluence\b/.test(s)) return "influence";
  return "connect";
}

/* ---------- Names ---------- */
const HONORIFICS = new Set([
  "mr", "mrs", "ms", "miss", "mx", "dr", "doctor", "prof", "professor", "sir", "dame", "lord", "lady",
  "hon", "honourable", "honorable", "rev", "reverend", "fr", "capt", "captain", "col", "gen", "maj", "lt",
  "senator", "the", "rt", "right", "his", "her", "excellency", "shri", "smt",
]);
const SUFFIXES = new Set([
  "jr", "sr", "ii", "iii", "iv", "phd", "md", "mba", "msc", "bsc", "llb", "llm", "jd", "esq",
  "obe", "mbe", "cbe", "kc", "qc", "peng", "cpa", "cfa", "pmp", "frsc", "facs", "frcpc", "frcp", "mp", "mpp",
]);
// Letters NFD doesn't split into base + accent.
const SPECIAL = { ß: "ss", ẞ: "ss", æ: "ae", Æ: "ae", œ: "oe", Œ: "oe", ø: "o", Ø: "o", ł: "l", Ł: "l", đ: "d", Đ: "d", ð: "d", þ: "th", ı: "i" };

/** "Aspuru-Guzik" → "aspuruguzik", "Alán" → "alan". Letters and digits of any script survive. */
export function foldName(s) {
  return String(s || "")
    .replace(/[ßẞæÆœŒøØłŁđĐðþı]/g, (c) => SPECIAL[c])
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Words of a name with honorifics, post-nominals, brackets and "Jane Doe, PhD" tails removed. */
export function nameWords(s) {
  const base = String(s || "").replace(/\([^)]*\)/g, " ").split(",")[0];
  const words = base.split(/[\s]+/).map(foldName).filter(Boolean);
  while (words.length > 1 && HONORIFICS.has(words[0])) words.shift();
  while (words.length > 1 && SUFFIXES.has(words[words.length - 1])) words.pop();
  return words;
}

/**
 * A name as written plus its nickname forms: Kulbir "Colin" Singh Dhillon → [kulbir singh dhillon],
 * [colin singh dhillon]; Heling (Alex) Pu → [heling pu], [alex pu].
 */
export function nameVariants(full) {
  const raw = String(full || "");
  // Double quotes or brackets; single quotes are apostrophes (O'Brien, D’Souza).
  const nicks = [
    ...[...raw.matchAll(/["“”]([^"“”]{2,})["“”]/g)].map((m) => m[1]),
    ...[...raw.matchAll(/\(([^()]{2,})\)/g)].map((m) => m[1]),
  ];
  const plain = raw.replace(/["“”][^"“”]{2,}["“”]/g, " ");
  const words = nameWords(plain);
  const out = words.length ? [words] : [];
  for (const nick of nicks) {
    const n = nameWords(nick);
    // "(PhD)", "(Dr)" and the like are not names.
    if (n.length === 1 && (HONORIFICS.has(n[0]) || SUFFIXES.has(n[0]))) continue;
    if (n.length && words.length > 1) out.push([...n, ...words.slice(1)]);
  }
  return out;
}

/**
 * Does `candidate` (a full name, or { firstName, lastName }) name the same person as
 * `first` + `last`? Case, accents, honorifics, post-nominals, hyphens and middle names
 * are ignored: "Dr. Rulan S. Parekh" matches Rulan / Parekh, "Alán Aspuru-Guzik" matches
 * Alan / Aspuru Guzik. Both the first and the last name must match in full.
 */
export function fullNameMatches(candidate, first, last) {
  const f = foldName(nameWords(first).join(""));
  const l = foldName(nameWords(last).join(""));
  if (!f || l.length < 2) return false;
  if (candidate && typeof candidate === "object") {
    const cf = foldName(nameWords(candidate.firstName).join(""));
    const cl = foldName(nameWords(candidate.lastName).join(""));
    if (cf && cl && cf === f && cl === l) return true;
    return fullNameMatches([candidate.firstName, candidate.lastName].filter(Boolean).join(" "), first, last);
  }
  for (const words of nameVariants(candidate)) {
    if (words.length < 2) continue;
    // A prefix of the words is the first name, a later suffix is the last name.
    for (let i = 1; i < words.length; i++) {
      if (words.slice(0, i).join("") !== f) continue;
      for (let j = i; j < words.length; j++) {
        if (words.slice(j).join("") === l) return true;
      }
    }
  }
  return false;
}

/**
 * Is `last` the last name of `candidate` (a full name, or { firstName, lastName })? The same
 * folding as fullNameMatches: "Christopher Golden" and "Dr. Chris A. Golden" both have the last
 * name "Golden"; a one-word name has no last name to match.
 */
export function lastNameIs(candidate, last) {
  const l = foldName(nameWords(last).join(""));
  if (l.length < 2) return false;
  if (candidate && typeof candidate === "object") {
    const cl = foldName(nameWords(candidate.lastName).join(""));
    if (cl && cl === l) return true;
    return lastNameIs([candidate.firstName, candidate.lastName].filter(Boolean).join(" "), last);
  }
  for (const words of nameVariants(candidate)) {
    for (let j = 1; j < words.length; j++) if (words.slice(j).join("") === l) return true;
  }
  return false;
}

/** "José  Núñez" → "jose nunez": the person's key when they gave no ticket. */
export function personNameKey(first, last) {
  return [...nameWords(first), ...nameWords(last)].join(" ");
}

/* ---------- Speakers (Sanity, public CDN) ---------- */
export const SANITY_PROJECT = "021qtoci";
export const SPEAKERS_URL =
  `https://${SANITY_PROJECT}.apicdn.sanity.io/v2021-10-21/data/query/production?query=${encodeURIComponent('*[_type=="speaker"]{name}')}`;
export const SPEAKER_TTL_MS = 10 * 60 * 1000;

export function parseSpeakers(json) {
  const list = Array.isArray(json?.result) ? json.result : [];
  return list.map((s) => cleanText(s?.name)).filter(Boolean);
}

/**
 * Speaker names, cached for 10 minutes. A failed fetch keeps the last good list
 * (or an empty one) and is retried after a minute. Never throws.
 */
export function makeSpeakerCache({ fetchImpl = globalThis.fetch, url = SPEAKERS_URL, ttlMs = SPEAKER_TTL_MS, retryMs = 60 * 1000, now = () => Date.now(), log = console } = {}) {
  let names = [];
  let expires = 0;
  let pending = null;
  async function load() {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`Sanity ${res.status}`);
      names = parseSpeakers(await res.json());
      expires = now() + ttlMs;
    } catch (err) {
      log.error?.("RSVP SPEAKER LIST ERROR:", err?.message || err);
      expires = now() + retryMs;
    }
    return names;
  }
  return {
    async get() {
      if (now() < expires) return names;
      if (!pending) pending = load().finally(() => { pending = null; });
      return pending;
    },
  };
}

/** The speaker's public name when first + last match one, else "". */
export function matchSpeaker(speakers, first, last) {
  for (const name of speakers || []) if (fullNameMatches(name, first, last)) return name;
  return "";
}

/* ---------- Ticket holders (for name-only lookups) ----------
   One entry per ticket: who owns it, its pass and the names of the person it is
   for (the name given at checkout; without one, the account or purchase name). */
const isBooth = (id) => /^BOOTH-/i.test(String(id || ""));
const TIER_RANK = { connect: 1, influence: 2, power: 3, apex: 4 };

/**
 * Who a ticket is for. The account or purchase name can be the buyer's (someone who
 * bought a pass for a colleague), so the name given at checkout wins when there is one.
 */
export function ticketPersonNames(accountName, details) {
  const d = details || {};
  if (d.firstName || d.lastName) return [{ firstName: d.firstName || "", lastName: d.lastName || "" }];
  return accountName ? [accountName] : [];
}

export function buildHolderIndex(users = [], guests = []) {
  const byTicket = new Map();
  for (const u of users) {
    for (const t of u.tickets || []) {
      if (!t?.ticketId || isBooth(t.ticketId) || t.hiddenByStaff) continue;
      byTicket.set(normalizeTicketId(t.ticketId), {
        owner: `u:${u._id}`,
        tier: tierFromTicketType(t.type),
        names: ticketPersonNames(u.name, t.details),
      });
    }
  }
  for (const g of guests) {
    if (!g?.ticketId || isBooth(g.ticketId) || g.hiddenByStaff || g.syncDuplicate) continue;
    const id = normalizeTicketId(g.ticketId);
    const names = ticketPersonNames(g.name, g.details);
    const held = byTicket.get(id);
    if (held) { held.names.push(...names); continue; } // claimed: same ticket, original names count too
    byTicket.set(id, {
      owner: g.email ? `e:${String(g.email).toLowerCase()}` : `g:${g._id || id}`,
      tier: tierFromTicketType(g.ticketType),
      names,
    });
  }
  return [...byTicket.values()];
}

/**
 * Ticket holders called first + last. Exactly one person → their (highest) pass;
 * nobody or several people → null, so a common name never guesses.
 */
export function matchHolder(holders, first, last) {
  const owners = new Map();
  for (const h of holders || []) {
    if (!h.names.some((n) => fullNameMatches(n, first, last))) continue;
    const prev = owners.get(h.owner);
    if (!prev || TIER_RANK[h.tier] > TIER_RANK[prev]) owners.set(h.owner, h.tier);
  }
  return owners.size === 1 ? { tier: [...owners.values()][0] } : null;
}

/* ---------- Validation ---------- */
export const MAX_LENGTH = { firstName: 80, lastName: 80, email: 254, ticketId: 64, dietaryOther: 200, accessibility: 600 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const LINKISH_RE = /(https?:\/\/|www\.|<|>)/i;
const LABELS = { firstName: "First name", lastName: "Last name", email: "Email", dietaryOther: "Dietary note", accessibility: "Accessibility note" };

function cleanLong(v, max) {
  if (typeof v !== "string") return "";
  return v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}

/** The lookup request: { firstName, lastName, ticketId? }. */
export function cleanLookup(body) {
  const b = body && typeof body === "object" ? body : {};
  return {
    firstName: cleanText(b.firstName).slice(0, MAX_LENGTH.firstName),
    lastName: cleanText(b.lastName).slice(0, MAX_LENGTH.lastName),
    ticketId: normalizeTicketId(cleanText(b.ticketId)),
  };
}

/**
 * Check an RSVP. Pass, days and options are checked again once the server has
 * worked out the pass (resolvePass + checkOptions).
 * @returns {{ ok: true, value: object } | { ok: false, error: string, field: string }}
 */
export function validateRsvp(body) {
  const b = body && typeof body === "object" ? body : {};
  const fail = (field, error) => ({ ok: false, field, error });
  const v = {
    firstName: cleanText(b.firstName),
    lastName: cleanText(b.lastName),
    email: cleanText(b.email).toLowerCase(),
    ticketId: normalizeTicketId(cleanText(b.ticketId)),
    tier: cleanText(b.tier).toLowerCase(),
    dietaryOther: cleanText(b.dietaryOther),
    accessibility: cleanLong(b.accessibility, MAX_LENGTH.accessibility + 1),
    page: cleanPage(b.page),
  };
  if (!v.firstName) return fail("firstName", "First name is required");
  if (!v.lastName) return fail("lastName", "Last name is required");
  for (const k of ["firstName", "lastName", "email", "dietaryOther", "accessibility"]) {
    if (v[k].length > MAX_LENGTH[k]) return fail(k, `${LABELS[k]} is too long`);
  }
  if (cleanText(b.ticketId).length > MAX_LENGTH.ticketId) return fail("ticketId", "Ticket ID is too long");
  for (const k of ["firstName", "lastName"]) {
    if (LINKISH_RE.test(v[k])) return fail(k, `${LABELS[k]} can't contain links`);
    if (!foldName(v[k])) return fail(k, `Enter your ${k === "firstName" ? "first" : "last"} name`);
  }
  if (v.email && !EMAIL_RE.test(v.email)) return fail("email", "Enter a valid email address");
  if (v.tier && !TIERS.includes(v.tier)) return fail("tier", "Choose your pass");

  const rawDays = Array.isArray(b.days) ? b.days : [];
  const days = DAY_KEYS.filter((k) => rawDays.includes(k));
  if (rawDays.some((d) => !DAY_KEYS.includes(d))) return fail("days", "Unknown day");
  if (!days.length) return fail("days", "Choose at least one day");

  if (b.options != null && !Array.isArray(b.options)) return fail("options", "Options must be a list");
  const options = [...new Set((b.options || []).map((o) => cleanText(o)).filter(Boolean))];
  if (options.length > OPTION_KEYS.length || options.some((o) => !OPTION_KEYS.includes(o))) return fail("options", "Unknown option");

  if (b.dietary != null && !Array.isArray(b.dietary)) return fail("dietary", "Dietary needs must be a list");
  const rawDiet = (b.dietary || []).map((d) => cleanText(d));
  if (rawDiet.some((d) => !DIETARY_KEYS.includes(d))) return fail("dietary", "Unknown dietary option");
  let dietary = DIETARY_KEYS.filter((k) => rawDiet.includes(k));
  if (dietary.length > 1) dietary = dietary.filter((k) => k !== "none"); // a real need beats "None"
  if (!dietary.includes("other")) v.dietaryOther = "";
  if (dietary.includes("other") && !v.dietaryOther) return fail("dietaryOther", "Tell us about your dietary need");

  return { ok: true, value: { ...v, days, options, dietary } };
}

/**
 * The pass an RSVP is saved with. A verified ticket wins, then a speaker; otherwise
 * what the person chose (one of the four passes) is kept, marked unverified.
 * Speakers are found by name on the public speaker list, so a speaker RSVP is never
 * "verified": staff confirm it (`detectedTier` notes the pass of a verified ticket).
 * Without a ticket, nobody can claim more than the one ticket holder with their name has.
 * @param {{kind: string, tier?: string, verified: boolean, ticket?: object}} found  the server-side lookup
 */
export function resolvePass(found, chosenTier) {
  if (found?.kind === "speaker") {
    const detectedTier = found.ticket ? tierFromTicketType(found.ticket.type) : "";
    // A verified Speaker Pass ticket proves it; a name on the public list alone doesn't.
    return { ok: true, tier: "speaker", tierVerified: detectedTier === "speaker", kind: "speaker", detectedTier };
  }
  if (found?.kind === "ticket" && found.verified) return { ok: true, tier: found.tier, tierVerified: true, kind: "ticket" };
  if (!PASS_TIERS.includes(chosenTier)) return { ok: false, field: "tier", error: "Choose your pass" };
  const detected = found?.kind === "ticket" && TIER_RANK[found.tier] ? found.tier : "";
  if (detected && TIER_RANK[chosenTier] > TIER_RANK[detected]) {
    return { ok: false, field: "ticketId", error: `Add your ticket ID so we can confirm your ${TIER_LABELS[chosenTier]}.` };
  }
  return { ok: true, tier: chosenTier, tierVerified: false, kind: detected ? "ticket" : "none", detectedTier: detected };
}

/**
 * The keys of the one RSVP per person. `ticket`: "t:<id>" for a verified ticket.
 * `name`: the folded full name, only when it is the ticket holder's own name (or there is
 * no verified ticket): someone signing in with their own ticket under another person's
 * name must not reach that person's RSVP.
 */
export function rsvpKeys({ ticketId = "", ticketVerified = false, holderMatch = false, firstName, lastName }) {
  const ticket = ticketId && ticketVerified ? `t:${normalizeTicketId(ticketId)}` : "";
  const name = !ticket || holderMatch ? personNameKey(firstName, lastName) : "";
  return { ticket, name };
}

/* ---------- Edit tokens ----------
   A name is not a secret, so a name alone never changes an RSVP. The first save
   hands the browser a random token (only its hash is kept); sending it back with a
   later RSVP, or the verified ticket the RSVP was saved under, proves it is theirs. */
export const newEditToken = () => randomBytes(24).toString("base64url");

/** sha256 of a well-formed token, else "". */
export function hashEditToken(token) {
  const t = typeof token === "string" ? token.trim() : "";
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(t)) return "";
  return createHash("sha256").update(t).digest("hex");
}

/* ---------- Admin console ---------- */
const escRx = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

/** Rows that are listed: not bots, not merged into another RSVP by staff. */
export const LIVE_RSVPS = Object.freeze({ spam: { $ne: true }, mergedInto: { $in: ["", null] } });

/** ?q= name, email or ticket ID; ?tier=; ?option= (a day or an experience); ?verified=0|1; ?review=1 possible duplicates */
export function rsvpsFilter({ q, tier, option, verified, review } = {}) {
  const filter = { ...LIVE_RSVPS };
  const t = cleanText(tier).toLowerCase();
  if (TIERS.includes(t)) filter.tier = t;
  const o = cleanText(option);
  if (DAY_KEYS.includes(o)) filter.days = o;
  else if (EXPERIENCE_KEYS.includes(o)) filter.options = o;
  if (verified === "1") filter.tierVerified = true;
  if (verified === "0") filter.tierVerified = { $ne: true };
  if (review === "1") filter.duplicateOf = { $nin: ["", null] };
  const s = cleanText(q).slice(0, 100);
  if (s) {
    const rx = escRx(s);
    const or = ["name", "firstName", "lastName", "email", "ticketId"].map((k) => ({ [k]: rx }));
    const parts = s.split(" ");
    if (parts.length > 1) or.push({ firstName: escRx(parts[0]), lastName: escRx(parts.slice(1).join(" ")) });
    filter.$or = or;
  }
  return filter;
}

const nameOf = (d) => d.name || [d.firstName, d.lastName].filter(Boolean).join(" ");

const isDuplicate = (d) => !!d.duplicateOf;

/**
 * Headcounts for catering, over every (non-bot) RSVP. Possible duplicates (a second RSVP
 * for a name that already has one, not proven to be the same person) wait for staff and
 * are left out. `verifiedCounts` is the same per day/experience, from verified passes only.
 */
export function summarizeRsvps(docs = []) {
  const zero = () => Object.fromEntries(OPTION_KEYS.map((k) => [k, 0]));
  const counts = zero();
  const verifiedCounts = zero();
  const dietary = Object.fromEntries(DIETARY_KEYS.map((k) => [k, 0]));
  const tiers = Object.fromEntries(TIERS.map((k) => [k, { total: 0, verified: 0 }]));
  let unverified = 0, duplicates = 0, total = 0;
  const dietaryNotes = []; // "Other" needs, spelled out for catering
  for (const d of docs) {
    if (d.spam || d.mergedInto) continue;
    if (isDuplicate(d)) { duplicates += 1; continue; }
    total += 1;
    if ((d.dietary || []).includes("other") && d.dietaryOther && dietaryNotes.length < 200) {
      dietaryNotes.push({ name: nameOf(d), note: d.dietaryOther });
    }
    for (const k of [...(d.days || []), ...(d.options || [])]) {
      if (!(k in counts)) continue;
      counts[k] += 1;
      if (d.tierVerified) verifiedCounts[k] += 1;
    }
    for (const k of d.dietary || []) if (k in dietary) dietary[k] += 1;
    if (tiers[d.tier]) {
      tiers[d.tier].total += 1;
      if (d.tierVerified) tiers[d.tier].verified += 1;
    }
    if (!d.tierVerified) unverified += 1;
  }
  return { total, counts, verifiedCounts, dietary, dietaryNotes, tiers, unverified, duplicates };
}

/** GET /api/console/rsvps. `catalog` is the options payload, so the staff page has the
    labels without a second call to GET /api/rsvp/options. */
/** `codes`: Map(ticket ID → the coupon code its ticket was bought with, services/promoCodes.js codesForTickets). */
export function rsvpListPayload({ total = 0, page = 0, size = 50, everyone = [], rows = [], codes = null } = {}) {
  return { total, page, size, summary: summarizeRsvps(everyone), rows: rows.map((d) => rsvpRow(d, codes)), catalog: rsvpOptionsPayload() };
}

/** The ticket an RSVP belongs to: its verified ticket ID, else the ticket its key names ("t:<id>"); "" = none
    (a speaker matched by name, or an unverified name-only RSVP). Normalised. */
export function rsvpTicketId(d) {
  if (d?.ticketVerified && d?.ticketId) return normalizeTicketId(d.ticketId);
  const key = String(d?.key || "");
  return key.startsWith("t:") ? normalizeTicketId(key.slice(2)) : "";
}

const NO_TICKET_CODE = Object.freeze({ kind: "unknown", code: "", discount: null, label: "—" });
/** The coupon code of an RSVP's ticket from `codes` (codesForTickets), or "—" with no ticket. */
export const rsvpCode = (d, codes) => (codes instanceof Map ? codes.get(rsvpTicketId(d)) || NO_TICKET_CODE : undefined);

/** A row of the admin table. `codes`: as rsvpListPayload's (adds `code`). */
export function rsvpRow(d, codes = null) {
  const code = rsvpCode(d, codes);
  return {
    ...(code ? { code } : {}),
    id: String(d._id),
    name: nameOf(d),
    email: d.email || "",
    kind: d.kind || "none",
    tier: d.tier || "",
    tierLabel: TIER_LABELS[d.tier] || d.tier || "",
    tierVerified: !!d.tierVerified,
    days: d.days || [],
    options: d.options || [],
    dietary: d.dietary || [],
    dietaryOther: d.dietaryOther || "",
    hasAccessibility: !!d.accessibility,
    duplicateOf: d.duplicateOf ? String(d.duplicateOf) : "", // possible duplicate: not in the headcounts until staff decide
    separated: !!d.separatedAt, // staff kept it as a person of their own: never flagged again
    submissions: d.submissions ?? 1, // 0: entered by staff, never sent by the attendee
    // Who set the answers (services/rsvpStaff.js): rows from before `source` existed are the attendee's.
    source: d.source === "staff" ? "staff" : "attendee",
    staffUpdatedBy: d.staffUpdatedBy || "",
    staffUpdatedAt: d.staffUpdatedAt || null,
    staffOverride: !!d.staffOverride,
    // Special events staff added on top of the attendee's own answers (kept when the attendee sends theirs again).
    staffAdded: Array.isArray(d.staffAdded) ? d.staffAdded : [],
    passLimitOverride: (d.source === "staff" || (d.staffAdded || []).length > 0) && !!d.passLimitOverride,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

/** Everything about one RSVP, for the drawer. `codes`: as rsvpListPayload's. */
export function rsvpDetail(d, codes = null) {
  return {
    ...rsvpRow(d, codes),
    firstName: d.firstName || "",
    lastName: d.lastName || "",
    ticketId: d.ticketId || "",
    ticketVerified: !!d.ticketVerified,
    chosenTier: d.chosenTier || "",
    detectedTier: d.detectedTier || "",
    matchedSpeaker: d.matchedSpeaker || "",
    accessibility: d.accessibility || "",
    attendeeSubmittedAt: d.attendeeSubmittedAt || null,
    page: d.page || "",
    userAgent: d.userAgent || "",
    fillMs: d.fillMs ?? null,
    spam: !!d.spam,
    spamReason: d.spamReason || "",
    separatedAt: d.separatedAt || null,
    separatedBy: d.separatedBy || "",
    optionLabels: (d.options || []).map(optionLabel),
    staffAddedLabels: (d.staffAdded || []).map(optionLabel),
    dietaryLabels: (d.dietary || []).map((k) => DIETARY_LABEL[k] || k),
  };
}

const KIND_LABEL = { ticket: "Ticket holder", speaker: "Speaker", none: "Not matched" };
const stamp = (t) => (t ? new Date(t).toISOString().replace("T", " ").slice(0, 19) : "");

export const CSV_HEAD = [
  "Updated (UTC)", "First name", "Last name", "Email", "Pass", "Pass verified", "Matched as", "Ticket ID", "Code",
  ...OPTION_KEYS.map(optionLabel), "Dietary", "Dietary (other)", "Accessibility", "Times submitted", "First RSVP (UTC)",
  "Entered by", "In headcounts",
];

/** Spreadsheet for management: one Yes column per day/experience so catering can sum them.
    `codes`: as rsvpListPayload's ("Code": the coupon code of the RSVP's ticket, "No code", a staff pass, or "—"). */
export function rsvpsCsv(docs, codes = null) {
  const lines = docs.map((d) => {
    const picked = new Set([...(d.days || []), ...(d.options || [])]);
    return [
      stamp(d.updatedAt || d.createdAt), d.firstName, d.lastName, d.email, TIER_LABELS[d.tier] || d.tier,
      !!d.tierVerified, KIND_LABEL[d.kind] || "", d.ticketId, (rsvpCode(d, codes) || NO_TICKET_CODE).label,
      ...OPTION_KEYS.map((k) => (picked.has(k) ? "Yes" : "")),
      (d.dietary || []).map((k) => DIETARY_LABEL[k] || k).join("; "), d.dietaryOther, d.accessibility,
      d.submissions ?? 1, stamp(d.createdAt),
      d.source === "staff" ? `Staff${d.staffUpdatedBy ? `: ${d.staffUpdatedBy}` : ""}`
        : (d.staffAdded || []).length ? `Attendee + staff added ${d.staffAdded.map(optionLabel).join(", ")}${d.staffUpdatedBy ? ` (${d.staffUpdatedBy})` : ""}` : "Attendee",
      isDuplicate(d) ? "No: possible duplicate" : "Yes",
    ].map(csvCell).join(",");
  });
  return "﻿" + [CSV_HEAD.map(csvCell).join(","), ...lines].join("\n");
}

const isVerifiedRow = (r) => !!(r?.ticketVerified || r?.tierVerified);
const msOf = (t) => {
  const n = t ? new Date(t).getTime() : 0;
  return Number.isFinite(n) ? n : 0;
};
/** The row whose answers are the latest: last changed, then last created; a tie keeps `fallback`'s. */
function newerRow(a, b, fallback) {
  const byUpdate = msOf(a.updatedAt || a.createdAt) - msOf(b.updatedAt || b.createdAt);
  if (byUpdate) return byUpdate > 0 ? a : b;
  const byCreate = msOf(a.createdAt) - msOf(b.createdAt);
  if (byCreate) return byCreate > 0 ? a : b;
  return fallback;
}

/**
 * Staff merge a possible duplicate (`dup`) with the RSVP it may duplicate (`keep`): one person.
 *  - The row that stays listed (`survivor`): the ticket-verified one, with its key and verified
 *    pass; when neither (or both) is verified, `keep`. The other (`retired`) is kept for the record.
 *  - The answers (days, experiences, dietary, accessibility) are the NEWER row's (updatedAt, then
 *    createdAt; a tie keeps the survivor's), so a merge never rolls back a later change. Except: when
 *    one row was sent by the attendee and the other entered by staff (`source`, services/rsvpStaff.js),
 *    the attendee's answers win whichever is newer.
 *    The email is the newer one's, or the older one's when the newer RSVP left it out.
 *  - The pass: the verified row's; with no verified row, the newer row's (it is their latest answer).
 *    Experiences that pass doesn't include on those days are dropped and reported.
 *  - The browser that sent the newer answers keeps its edit token.
 * @returns {{ survivor: object, retired: object, newer: object, set: object, inc: object, dropped: string[] }}
 *          `set` / `inc` for the survivor
 */
export function planRsvpMerge(keep, dup) {
  const survivor = isVerifiedRow(dup) && !isVerifiedRow(keep) ? dup : keep;
  const retired = survivor === keep ? dup : keep;
  const sourceOf = (r) => (r.source === "staff" ? "staff" : "attendee");
  // The attendee's own answers beat staff's; otherwise the newer answers win.
  const newer = sourceOf(dup) !== sourceOf(keep)
    ? (sourceOf(dup) === "attendee" ? dup : keep)
    : newerRow(dup, keep, survivor);
  const older = newer === dup ? keep : dup;
  const passRow = isVerifiedRow(survivor) ? survivor : newer;

  const days = DAY_KEYS.filter((k) => (newer.days || []).includes(k));
  // Seats staff added on top of either row stay; so does a pass extra (a breakfast, luncheon, the Gala…) either row already had.
  const staffAdded = EXPERIENCE_KEYS.filter((k) => [...(keep.staffAdded || []), ...(dup.staffAdded || [])].includes(k));
  const allowed = new Set(allowedExperiences(passRow.tier, days, { extra: [...extraOptionsFor([keep, dup]), ...staffAdded] }));
  // Staff answers saved past the pass's limits on purpose keep them.
  const pastLimits = sourceOf(newer) === "staff" && !!newer.passLimitOverride;
  const options = EXPERIENCE_KEYS.filter((k) => ((newer.options || []).includes(k) && (pastLimits || allowed.has(k))) || staffAdded.includes(k));
  const set = {
    days, options, dietary: [...(newer.dietary || [])], dietaryOther: newer.dietaryOther || "",
    accessibility: newer.accessibility || "",
    email: newer.email || older.email || "",
    ...(staffAdded.length ? { staffAdded } : {}),
  };
  if (sourceOf(dup) === "staff" || sourceOf(keep) === "staff") {
    // Who set the answers that stay (two RSVPs the attendee sent need nothing more).
    Object.assign(set, {
      source: sourceOf(newer), staffOverride: !!newer.staffOverride, passLimitOverride: pastLimits,
      ...(sourceOf(newer) === "staff"
        ? { staffUpdatedBy: newer.staffUpdatedBy || "", staffUpdatedById: newer.staffUpdatedById || "", staffUpdatedAt: newer.staffUpdatedAt || null }
        : { attendeeSubmittedAt: newer.attendeeSubmittedAt || newer.updatedAt || newer.createdAt || null }),
    });
  }
  if (passRow !== survivor) {
    // Neither row is verified: the newer one's pass, as it was worked out when it was saved.
    Object.assign(set, {
      kind: passRow.kind || "none", tier: passRow.tier || "", tierVerified: false,
      chosenTier: passRow.chosenTier || "", detectedTier: passRow.detectedTier || "", matchedSpeaker: passRow.matchedSpeaker || "",
      ticketId: passRow.ticketId || survivor.ticketId || "", ticketVerified: false,
    });
  }
  if (survivor === dup) set.duplicateOf = ""; // the verified row is the RSVP now
  if (newer === retired && retired.editTokenHash) set.editTokenHash = retired.editTokenHash;
  return {
    survivor, retired, newer, set, inc: { submissions: retired.submissions || 1 },
    dropped: (newer.options || []).filter((k) => !options.includes(k)),
  };
}

/* ---------- Email to the team (enquire@) for each RSVP ---------- */
const escHtml = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * What the team's alert is built from: the saved RSVP as a plain object, with the pass it was checked against
 * (`final`: kind, tier…) on top, minus the row id and the edit token's hash. Pure.
 * A Mongoose document (what Rsvp.create() hands back) keeps its fields behind getters over `_doc`, so spreading
 * one copies none of them: every first RSVP reached the team as "[RSVP] Someone · Power Pass" with no ticket ID
 * and no days (Oct 2026). Documents are turned into plain objects first.
 * null when it isn't one real person's complete RSVP (a bot's or possible duplicate's row, no name, or no day):
 * no alert goes out for it.
 */
export function rsvpAlertRow(saved, final = null) {
  const plain = saved && typeof saved.toObject === "function" ? saved.toObject() : saved;
  if (!plain || typeof plain !== "object" || plain.spam || plain.duplicateOf) return null;
  const { _id, editTokenHash, __v, ...row } = plain;
  const out = { ...row, ...(final && typeof final === "object" ? final : {}) };
  if (!foldName(out.firstName) && !foldName(out.lastName)) return null;
  if (!Array.isArray(out.days) || !out.days.some((d) => DAY_KEYS.includes(d))) return null;
  return out;
}

/** Subject, HTML and text for the team's copy of one RSVP. Every value is escaped. Pure. */
export function buildRsvpEmail(r, { updated = false } = {}) {
  const name = [r.firstName, r.lastName].filter(Boolean).join(" ") || "Someone";
  const dayLabel = Object.fromEntries(DAYS.map((d) => [d.key, d.label]));
  const days = (r.days || []).map((d) => dayLabel[d] || d).join(", ") || "None";
  const optLabel = (k) => {
    const o = OPTION_BY_KEY[k];
    if (!o) return k;
    return o.day ? `${o.label} (${dayLabel[o.day] || o.day})` : o.label;
  };
  const events = (r.options || []).filter((k) => OPTION_BY_KEY[k]?.kind === "experience").map(optLabel);
  const dietMap = Object.fromEntries(DIETARY.map((d) => [d.key, d.label]));
  const diet = (r.dietary || []).map((k) => (k === "other" && r.dietaryOther ? `Other: ${r.dietaryOther}` : dietMap[k] || k));
  const rows = [
    ["Name", name],
    ["Pass", TIER_LABELS[r.tier] || r.tier || ""],
    ["Ticket ID", r.ticketId || ""],
    ["Days", days],
    ["Special events", events.length ? events.join("\n") : "None"],
    ["Dietary", diet.length ? diet.join(", ") : "None"],
    ["Accessibility", r.accessibility || "None"],
  ];
  const subject = `${updated ? "[RSVP updated]" : "[RSVP]"} ${name} · ${TIER_LABELS[r.tier] || r.tier || "Pass"}`.replace(/[\r\n]+/g, " ");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:620px">
<h2 style="margin:0 0 12px;color:#0d0520">${updated ? "RSVP updated" : "New RSVP"}: ${escHtml(name)}</h2>
<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%">
${rows.map(([k, v]) => `<tr><td style="padding:8px 12px;border-bottom:1px solid #ece6f7;font-weight:600;color:#5b4b7a;width:150px;vertical-align:top">${escHtml(k)}</td><td style="padding:8px 12px;border-bottom:1px solid #ece6f7;color:#0d0520">${escHtml(v).replace(/\n/g, "<br>")}</td></tr>`).join("\n")}
</table>
<p style="color:#777;font-size:12px;margin-top:14px">All RSVPs: Admin panel → Leads → RSVPs.</p></div>`;
  const text = `${updated ? "RSVP updated" : "New RSVP"}: ${name}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\nAll RSVPs: Admin panel → Leads → RSVPs.`;
  return { subject, html, text };
}
