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
export const PASS_TIERS = ["connect", "influence", "power", "apex"];
export const TIERS = [...PASS_TIERS, "speaker"]; // speakers aren't sold; they see everything
export const TIER_LABELS = {
  connect: "Connect Pass", influence: "Influence Pass", power: "Power Pass", apex: "Apex Pass", speaker: "Speaker",
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
  { key: "lunch_d1", kind: "experience", day: "day1", label: "Networking Luncheon", tiers: INFLUENCE_UP,
    description: "Seated lunch with fellow delegates." },
  { key: "lunch_d2", kind: "experience", day: "day2", label: "Networking Luncheon", tiers: INFLUENCE_UP,
    description: "Seated lunch with fellow delegates." },
  { key: "cxo_d1", kind: "experience", day: "day1", label: "CxO Breakfast", tiers: POWER_UP,
    description: "Invitation-only breakfast for senior leaders." },
  { key: "cxo_d2", kind: "experience", day: "day2", label: "CxO Breakfast", tiers: POWER_UP,
    description: "Invitation-only breakfast for senior leaders." },
  // Day 2 evening, as on the website agenda (src/data/agenda.js "d2-21", 27 Oct 17:20-19:15).
  { key: "gala", kind: "experience", day: "day2", label: "Gala Dinner & Networking Reception (Day 2 evening)", tiers: POWER_UP,
    description: "Dinner and drinks with speakers, partners and delegates on the evening of Day 2." },
  { key: "awards", kind: "experience", day: "day1", label: "Catalyst Awards Night (Day 1 evening)", tiers: POWER_UP,
    description: "The Catalyst Awards ceremony on the evening of Day 1." },
  { key: "meetings", kind: "experience", day: null, label: "2 pre-matched business meetings", tiers: APEX_UP,
    description: "Two meetings we line up for you in advance, matched to your objectives." },
  { key: "lounge", kind: "experience", day: null, label: "Private Scotch & Cocktail Lounge (19+)", tiers: APEX_UP,
    description: "A quiet room for conversations over Scotch and cocktails.", note: "19+ only. Bring photo ID." },
];
export const OPTION_KEYS = RSVP_OPTIONS.map((o) => o.key);
export const EXPERIENCE_KEYS = RSVP_OPTIONS.filter((o) => o.kind === "experience").map((o) => o.key);
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

/** What GET /api/rsvp/options serves (the website builds the form from this). */
export function rsvpOptionsPayload() {
  return {
    event: { name: "The Tech Festival Canada 2026", venue: "The Westin Harbour Castle, Toronto", start: "2026-10-26", end: "2026-10-27" },
    tiers: TIERS.map((key) => ({ key, label: TIER_LABELS[key], sold: key !== "speaker" })),
    days: DAYS,
    options: RSVP_OPTIONS.map(({ tiers, ...o }) => ({ ...o, tiers: [...tiers] })),
    dietary: DIETARY,
  };
}

/** May someone on `tier` choose `key`? (Ignores days.) */
export function tierIncludes(tier, key) {
  const o = OPTION_BY_KEY[key];
  return !!o && o.tiers.includes(tier);
}

/** Experiences someone on `tier` coming on `days` can choose, in display order. */
export function allowedExperiences(tier, days = []) {
  const d = new Set(days);
  return RSVP_OPTIONS
    .filter((o) => o.kind === "experience" && o.tiers.includes(tier) && (!o.day || d.has(o.day)))
    .map((o) => o.key);
}

/**
 * Check the chosen experiences against the matrix.
 * @returns {{ ok: true, options: string[] } | { ok: false, error: string, invalid: string[] }}
 */
export function checkOptions(tier, days, options) {
  const allowed = new Set(allowedExperiences(tier, days));
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
  if (/\b(apex|vip|all[- ]access)\b/.test(s)) return "apex";
  if (/\bpower\b/.test(s)) return "power";
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
    return { ok: true, tier: "speaker", tierVerified: false, kind: "speaker", detectedTier: found.ticket ? tierFromTicketType(found.ticket.type) : "" };
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

/** A row of the admin table. */
export function rsvpRow(d) {
  return {
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
    submissions: d.submissions || 1,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

/** Everything about one RSVP, for the drawer. */
export function rsvpDetail(d) {
  return {
    ...rsvpRow(d),
    firstName: d.firstName || "",
    lastName: d.lastName || "",
    ticketId: d.ticketId || "",
    ticketVerified: !!d.ticketVerified,
    chosenTier: d.chosenTier || "",
    detectedTier: d.detectedTier || "",
    matchedSpeaker: d.matchedSpeaker || "",
    accessibility: d.accessibility || "",
    page: d.page || "",
    userAgent: d.userAgent || "",
    fillMs: d.fillMs ?? null,
    spam: !!d.spam,
    spamReason: d.spamReason || "",
    optionLabels: (d.options || []).map(optionLabel),
    dietaryLabels: (d.dietary || []).map((k) => DIETARY_LABEL[k] || k),
  };
}

const KIND_LABEL = { ticket: "Ticket holder", speaker: "Speaker", none: "Not matched" };
const stamp = (t) => (t ? new Date(t).toISOString().replace("T", " ").slice(0, 19) : "");

export const CSV_HEAD = [
  "Updated (UTC)", "First name", "Last name", "Email", "Pass", "Pass verified", "Matched as", "Ticket ID",
  ...OPTION_KEYS.map(optionLabel), "Dietary", "Dietary (other)", "Accessibility", "Times submitted", "First RSVP (UTC)",
  "In headcounts",
];

/** Spreadsheet for management: one Yes column per day/experience so catering can sum them. */
export function rsvpsCsv(docs) {
  const lines = docs.map((d) => {
    const picked = new Set([...(d.days || []), ...(d.options || [])]);
    return [
      stamp(d.updatedAt || d.createdAt), d.firstName, d.lastName, d.email, TIER_LABELS[d.tier] || d.tier,
      !!d.tierVerified, KIND_LABEL[d.kind] || "", d.ticketId,
      ...OPTION_KEYS.map((k) => (picked.has(k) ? "Yes" : "")),
      (d.dietary || []).map((k) => DIETARY_LABEL[k] || k).join("; "), d.dietaryOther, d.accessibility,
      d.submissions || 1, stamp(d.createdAt),
      isDuplicate(d) ? "No: possible duplicate" : "Yes",
    ].map(csvCell).join(",");
  });
  return "﻿" + [CSV_HEAD.map(csvCell).join(","), ...lines].join("\n");
}

/**
 * Staff merge a possible duplicate into the RSVP it duplicates: its answers (days,
 * experiences, dietary, accessibility, email) replace the earlier ones, while the earlier
 * row keeps its pass and verification. Experiences that pass doesn't include are dropped.
 * @returns {{ set: object, dropped: string[] }}  `set` for the kept row
 */
export function planRsvpMerge(keep, dup) {
  const days = DAY_KEYS.filter((k) => (dup.days || []).includes(k));
  const allowed = new Set(allowedExperiences(keep.tier, days));
  const options = EXPERIENCE_KEYS.filter((k) => (dup.options || []).includes(k) && allowed.has(k));
  const set = {
    days, options, dietary: [...(dup.dietary || [])], dietaryOther: dup.dietaryOther || "",
    accessibility: dup.accessibility || "",
  };
  if (dup.email) set.email = dup.email;
  return { set, dropped: (dup.options || []).filter((k) => !options.includes(k)) };
}
