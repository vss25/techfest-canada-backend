/* =========================================================
   Ticket-based access for the iOS app
   ---------------------------------------------------------
   - Sign in with last name + ticket ID (for people whose ticket
     email isn't the one they want to use, or who never set a password).
   - Link ("claim") a ticket bought under another email to an account.
   - One attendee directory built from every ticket holder: app users
     plus guest purchases in the Attendee collection, de-duplicated so a
     person who bought ten tickets appears once with their most recent one.
   Pure helpers are exported for unit tests.
========================================================= */

import { passKind, strongerKind, boothOf, typesTier, storedTypes, PUBLIC_TYPES } from "./teamRoles.js";
import { personAccess } from "./appRights.js";
import { spotsOf } from "./availability.js";

/** "TECHFEST:A1B2C3D4E5F6 " → "a1b2c3d4e5f6" */
export function normalizeTicketId(raw) {
  return String(raw || "")
    .trim()
    .replace(/^TECHFEST:/i, "")
    .replace(/\s+/g, "")
    .toLowerCase()
    .slice(0, 64);
}

function fold(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/**
 * True when `lastName` matches the end of `fullName`, ignoring case,
 * accents, spaces and hyphens. "Gunant Singh Pahwa" matches "Pahwa"
 * and "Singh Pahwa"; a one-word name must match in full.
 */
export function lastNameMatches(fullName, lastName) {
  const want = fold(lastName);
  if (want.length < 2) return false;
  const parts = String(fullName || "").trim().split(/\s+/).map(fold).filter(Boolean);
  if (!parts.length) return false;
  if (parts.length === 1) return parts[0] === want;
  for (let i = 1; i < parts.length; i++) {
    if (parts.slice(i).join("") === want) return true;
  }
  return false;
}

/** Most recent ticket on a user (by purchaseDate), or null. */
export function latestTicket(tickets) {
  const list = (Array.isArray(tickets) ? tickets : []).filter((t) => t && !/^BOOTH-/i.test(String(t.ticketId || "")));
  if (!list.length) return null;
  return list.reduce((a, b) => (new Date(b.purchaseDate || 0) > new Date(a.purchaseDate || 0) ? b : a));
}

const TIER_NAMES = {
  discover: "Discover Pass", connect: "Connect Pass", influence: "Influence Pass",
  power: "Power Pass", apex: "Apex Pass", vip: "Apex Pass", session: "Session Pass",
  speaker: "Speaker Pass",
};
export function passName(type) {
  const k = String(type || "").toLowerCase();
  return TIER_NAMES[k] || (k ? k.charAt(0).toUpperCase() + k.slice(1) + " Pass" : "");
}

export const GUEST_FALLBACK_NAME = "TTFC attendee";

const oneLine = (v, max = 120) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max).trim() : "");

/** True when a stored name is really a number: all digits (an order number) or the ticket ID itself. */
export function looksLikeTicketNumber(name, ticketId = "") {
  const n = String(name || "").trim();
  if (!n) return false;
  if (/^\d+$/.test(n.replace(/[\s#-]/g, ""))) return true;
  const id = normalizeTicketId(ticketId);
  return !!id && normalizeTicketId(n) === id;
}

/**
 * Name to show for an unclaimed pass: the stored name, else the first + last
 * name from the checkout details, else "TTFC attendee" (never a ticket or
 * order number). → { name, real } (real: false for the fallback, which must
 * not be used to merge people).
 */
export function guestName(g) {
  const stored = oneLine(g?.name, 120);
  if (stored && !looksLikeTicketNumber(stored, g?.ticketId)) return { name: stored, real: true };
  const fromDetails = oneLine([g?.details?.firstName, g?.details?.lastName].map((x) => oneLine(x)).filter(Boolean).join(" "));
  if (fromDetails && !looksLikeTicketNumber(fromDetails, g?.ticketId)) return { name: fromDetails, real: true };
  return { name: GUEST_FALLBACK_NAME, real: false };
}

/** Company and job title from a pass holder's checkout details (nothing else from them). */
export function guestWork(details) {
  const d = details && typeof details === "object" ? details : {};
  return {
    organization: oneLine(d.organisation) || oneLine(d.organization) || oneLine(d.company),
    jobTitle: oneLine(d.jobTitle) || oneLine(d.title),
  };
}

/** Fields of Attendee.details the directory reads (select only these: no phone, email or the rest). */
export const GUEST_DETAILS_SELECT = "details.firstName details.lastName details.organisation details.organization details.company details.jobTitle details.title";

/** Fill a guest entry's empty company / title from another of their passes. */
function addGuestWork(entry, g) {
  if (!String(entry.id).startsWith("guest:")) return;   // app users keep their own profile
  const w = guestWork(g.details);
  if (!entry.organization && w.organization) entry.organization = w.organization;
  if (!entry.jobTitle && w.jobTitle) entry.jobTitle = w.jobTitle;
}

/**
 * Builds the attendee directory.
 *   users  — User docs that hold at least one ticket (lean)
 *   guests — unclaimed Attendee docs (lean)
 * People are merged by email; guest-only duplicates are also merged by
 * name. Each person keeps their most recent ticket. Never returns email.
 */
/** An unclaimed pass (speaker / exhibitor) adds its type to a directory entry and can raise its kind, never
    lower it. `off`: the account's typesOff (a type staff switched off stays off). A pass staff marked VIP adds
    nothing since Oct 21 2026 ("Don't label anyone as VIP", services/teamRoles.js). */
function addPassKind(entry, g, off = []) {
  for (const k of [passKind(g)]) {
    if (!k || off.includes(k)) continue;
    if (!entry.types.includes(k)) entry.types = PUBLIC_TYPES.filter((t) => t === k || entry.types.includes(t));
    const kind = strongerKind(entry.kind || "", k);
    if (kind === entry.kind) continue;
    entry.kind = kind;
    entry.booth = kind === "exhibitor" ? boothOf(g) : "";
  }
}

/** An account's uploaded photo ("" when none): buildDirectory's default `avatarOf` (routes/social.js passes
    services/socialHelpers.js avatarFor, which falls back to a speaker's website photo). */
const uploadedAvatar = (u) => (u.avatarVersion ? `/api/files/avatar/${u._id}?v=${u.avatarVersion}` : "");

export function buildDirectory(users, guests, { excludeUserId = null, excludeEmail = "", exhibitors = null, matrix = undefined, avatarOf = uploadedAvatar } = {}) {
  const offById = new Map();   // entry id → that account's typesOff
  const byEmail = new Map();
  const skipEmail = String(excludeEmail || "").toLowerCase();

  for (const u of users || []) {
    if (excludeUserId && String(u._id) === String(excludeUserId)) continue;
    if (u.directoryHidden) continue;
    const onApp = !!(u.appOnboarded || u.lastActiveAt);
    // Ticket holders, plus anyone who's on the app even without a ticket yet.
    const t = latestTicket(u.tickets) || (onApp ? { type: "", purchaseDate: null } : null);
    if (!t) continue;
    const email = String(u.email || "").toLowerCase();
    const acc = personAccess(u, { exhibitors, matrix });
    byEmail.set(email || `user:${u._id}`, {
      id: String(u._id),
      // Only people who have signed into the app can be connected with or messaged.
      onApp,
      name: u.name || "",
      jobTitle: u.jobTitle || "",
      organization: u.organization || "",
      linkedinUrl: u.linkedinUrl || "",
      country: u.country || "",
      topics: Array.isArray(u.topics) ? u.topics : [],
      avatarUrl: avatarOf(u),
      tagline: u.tagline || "",
      availabilitySlots: Array.isArray(u.availabilitySlots) ? u.availabilitySlots : [],
      meetingSpot: u.meetingSpot || "",
      availabilitySpots: spotsOf(u),   // place per block; meetingSpot for the rest (services/availability.js)
      // Receive rights, same as userCard (routes/social.js corrects them per viewer).
      acceptsMessages: acc.rights.receiveMessages,
      acceptsRequests: acc.rights.receiveRequests,
      // Network sections (services/teamRoles.js); exhibitors = exhibitorIndex() for claimed exhibitor passes.
      kind: acc.kind,
      booth: acc.booth,
      types: acc.publicTypes,
      ticketType: t.type,
      purchaseDate: t.purchaseDate,
    });
    offById.set(String(u._id), storedTypes(u.typesOff));
  }

  const guestByName = new Map();
  for (const g of guests || []) {
    // "Guest" placeholders stay out; blank or number-like names fall back (guestName).
    if (/^guest$/i.test(String(g.name || "").trim())) continue;
    const { name, real } = guestName(g);
    if (/^BOOTH-/i.test(String(g.ticketId || ""))) continue;
    const email = String(g.email || "").toLowerCase();
    if (email && email === skipEmail) continue;
    const existing = email ? byEmail.get(email) : null;
    if (existing) {
      // Same person: keep their app profile, but the pass is the most recent purchase.
      if (new Date(g.purchaseDate || 0) > new Date(existing.purchaseDate || 0)) {
        existing.ticketType = g.ticketType;
        existing.purchaseDate = g.purchaseDate;
      }
      addPassKind(existing, g, offById.get(existing.id));
      addGuestWork(existing, g);
      continue;
    }
    // Only a real name merges people; "TTFC attendee" is many different people.
    const nameKey = real ? fold(name) : "";
    const twin = nameKey ? guestByName.get(nameKey) : null;
    if (twin) {
      if (new Date(g.purchaseDate || 0) > new Date(twin.purchaseDate || 0)) {
        twin.ticketType = g.ticketType;
        twin.purchaseDate = g.purchaseDate;
      }
      addPassKind(twin, g);
      addGuestWork(twin, g);
      continue;
    }
    const work = guestWork(g.details);
    const person = {
      id: `guest:${g._id}`,
      onApp: false,
      name,
      // From their checkout form; never email, phone or the other details.
      jobTitle: work.jobTitle,
      organization: work.organization,
      linkedinUrl: "",
      country: "",
      topics: [],
      acceptsMessages: true,   // no switches on a guest; onApp: false already rules out contact
      acceptsRequests: true,
      kind: "",
      booth: "",
      types: [],
      ticketType: g.ticketType,
      purchaseDate: g.purchaseDate,
    };
    addPassKind(person, g);
    if (nameKey) guestByName.set(nameKey, person);
    if (email) byEmail.set(email, person);
    else byEmail.set(`guest:${g._id}`, person);
  }

  return [...byEmail.values()]
    // Others only see a Speaker Pass or "Exhibitor"; the viewer is never in their own directory.
    .map(({ purchaseDate, ticketType, ...p }) => ({ ...p, tier: typesTier(p.types) }))
    .sort((a, b) => (a.onApp === b.onApp ? a.name.localeCompare(b.name) : a.onApp ? -1 : 1));
}

/** Simple in-memory attempt limiter (per key) for ticket sign-in. */
export function makeLimiter({ max = 8, windowMs = 15 * 60 * 1000 } = {}) {
  const hits = new Map();
  return {
    hit(key) {
      const now = Date.now();
      const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
      list.push(now);
      hits.set(key, list);
      return list.length <= max;
    },
    reset(key) { hits.delete(key); },
  };
}

/**
 * Last-name guesses per ticket ID. A ticket ID + last name is the app's sign-in,
 * so every endpoint that checks the pair (ticket sign-in, RSVP lookup, RSVP
 * submit) draws on the one shared budget below: `max` different last names per
 * ticket per window, from any address. Trying the same last name again tells
 * nothing new, so it doesn't count twice (the RSVP page re-checks as people type).
 */
export function makeGuessLimiter({ max = 5, windowMs = 15 * 60 * 1000 } = {}) {
  const tries = new Map(); // ticket key → Map(folded last name → first tried at)
  return {
    hit(key, guess) {
      const now = Date.now();
      const seen = tries.get(key) || new Map();
      for (const [g, t] of seen) if (now - t >= windowMs) seen.delete(g);
      const g = fold(guess);
      let ok = true;
      if (!seen.has(g)) {
        if (seen.size >= max) ok = false;
        else seen.set(g, now);
      }
      if (seen.size) tries.set(key, seen);
      else tries.delete(key);
      return ok;
    },
    reset(key) { tries.delete(key); },
  };
}

/** The guess-limiter key for a ticket ID, however it was typed ("TECHFEST:AB12…", "ab12…"). */
export const ticketGuessKey = (id) => `t:${normalizeTicketId(id)}`;

/** Shared by routes/ticketAuth.js and the RSVP handlers (services/rsvpHandler.js). */
export const ticketGuesses = makeGuessLimiter({ max: 5, windowMs: 15 * 60 * 1000 });
