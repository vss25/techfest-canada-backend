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
};
export function passName(type) {
  const k = String(type || "").toLowerCase();
  return TIER_NAMES[k] || (k ? k.charAt(0).toUpperCase() + k.slice(1) + " Pass" : "");
}

/**
 * Builds the attendee directory.
 *   users  — User docs that hold at least one ticket (lean)
 *   guests — unclaimed Attendee docs (lean)
 * People are merged by email; guest-only duplicates are also merged by
 * name. Each person keeps their most recent ticket. Never returns email.
 */
export function buildDirectory(users, guests, { excludeUserId = null, excludeEmail = "" } = {}) {
  const byEmail = new Map();
  const skipEmail = String(excludeEmail || "").toLowerCase();

  for (const u of users || []) {
    if (excludeUserId && String(u._id) === String(excludeUserId)) continue;
    if (u.directoryHidden) continue;
    const t = latestTicket(u.tickets);
    if (!t) continue;
    const email = String(u.email || "").toLowerCase();
    byEmail.set(email || `user:${u._id}`, {
      id: String(u._id),
      // Only people who have signed into the app can be connected with or messaged.
      onApp: !!(u.appOnboarded || u.lastActiveAt),
      name: u.name || "",
      jobTitle: u.jobTitle || "",
      organization: u.organization || "",
      linkedinUrl: u.linkedinUrl || "",
      country: u.country || "",
      topics: Array.isArray(u.topics) ? u.topics : [],
      avatarUrl: u.avatarVersion ? `/api/files/avatar/${u._id}?v=${u.avatarVersion}` : "",
      ticketType: t.type,
      purchaseDate: t.purchaseDate,
    });
  }

  const guestByName = new Map();
  for (const g of guests || []) {
    const name = String(g.name || "").trim();
    if (!name || /^guest$/i.test(name)) continue;
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
      continue;
    }
    const nameKey = fold(name);
    const twin = guestByName.get(nameKey);
    if (twin) {
      if (new Date(g.purchaseDate || 0) > new Date(twin.purchaseDate || 0)) {
        twin.ticketType = g.ticketType;
        twin.purchaseDate = g.purchaseDate;
      }
      continue;
    }
    const person = {
      id: `guest:${g._id}`,
      onApp: false,
      name,
      jobTitle: "",
      organization: "",
      linkedinUrl: "",
      country: "",
      topics: [],
      ticketType: g.ticketType,
      purchaseDate: g.purchaseDate,
    };
    guestByName.set(nameKey, person);
    if (email) byEmail.set(email, person);
    else byEmail.set(`guest:${g._id}`, person);
  }

  return [...byEmail.values()]
    .map(({ purchaseDate, ticketType, ...p }) => ({ ...p, tier: passName(ticketType) }))
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
