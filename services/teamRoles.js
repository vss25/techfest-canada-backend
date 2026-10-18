/* Who someone is at TTFC: User.role, their person types, and the "kind" the
   apps' Network sections use (All / Speakers / Exhibitors / Staff). Pure, so
   it's unit-tested (test/team-roles.test.js, test/app-rights.test.js) and safe
   to import anywhere.

   Roles: "user" (attendee), "admin" (staff: the admin panel) and "volunteer"
   (the apps' staff sign-in). What anyone may do in the app (moderation, post
   removal, check-in, contact) comes from their types and the app rights
   matrix (services/appRights.js); role admin always keeps the staff powers. */

export const ROLES = ["user", "admin", "volunteer"];

const roleOf = (u) => String(u?.role || "").toLowerCase();
export const isStaff = (u) => roleOf(u) === "admin";
export const isVolunteer = (u) => roleOf(u) === "volunteer";
/** Staff or volunteer account: may use the apps' staff sign-in (check-in itself is the checkIn right). */
export const isTeam = (u) => isStaff(u) || isVolunteer(u);

/** A role from the console, or null when it isn't one of ROLES. */
export function cleanRole(v) {
  const r = String(v ?? "").trim().toLowerCase();
  return ROLES.includes(r) ? r : null;
}

// Same value as EXHIBITOR_PROMO in services/exhibitorPasses.js (not imported:
// that module pulls in pdfkit and would make an import cycle with ticketAccess).
export const EXHIBITOR_PROMO = "EXHIBITOR";

export const holdsSpeakerPass = (tickets) => (Array.isArray(tickets) ? tickets : []).some((t) => String(t?.type || "").toLowerCase() === "speaker");
export const holdsExhibitorPass = (tickets) => (Array.isArray(tickets) ? tickets : []).some((t) => String(t?.promoCode || "").toUpperCase() === EXHIBITOR_PROMO);

/* ================= PERSON TYPES =================
   What someone is at TTFC, for the app rights matrix (services/appRights.js)
   and the badges on their card. Effective types =
     (User.types set by staff ∪ automatic types) − User.typesOff
   Automatic: staff (role admin), volunteer (role volunteer), speaker (a Speaker
   Pass), exhibitor (an exhibitor pass). Attendee is automatic for anyone holding
   a pass or ticket who has no other type; staff can also add it by hand (so a VIP
   with a pass only gets the attendee column when staff say so). typesOff is the
   only way to take an automatic type away from one person (e.g. show a speaker
   as VIP only). `role` stays the sign-in / admin panel switch. */

export const PERSON_TYPES = ["attendee", "speaker", "exhibitor", "vip", "staff", "vendor", "volunteer"];
/** Badge priority: `kind` is the first of these someone has. */
export const KIND_PRIORITY = ["staff", "volunteer", "vip", "speaker", "exhibitor", "vendor"];
/** Types other attendees may see on a card (attendee is everyone, so it isn't shown). Same order as KIND_PRIORITY. */
export const PUBLIC_TYPES = KIND_PRIORITY;

/** A list of types from the console → the valid subset in PERSON_TYPES order, or null if it isn't a list or has an unknown type. */
export function cleanTypes(v) {
  if (!Array.isArray(v)) return null;
  const seen = new Set();
  for (const t of v) {
    const k = typeof t === "string" ? t.trim().toLowerCase() : "";
    if (!PERSON_TYPES.includes(k)) return null;
    seen.add(k);
  }
  return PERSON_TYPES.filter((t) => seen.has(t));
}

/** A stored list read leniently (unknown values dropped), for documents already saved. */
export const storedTypes = (v) => cleanTypes((Array.isArray(v) ? v : []).filter((t) => PERSON_TYPES.includes(String(t ?? "").trim().toLowerCase()))) || [];

/** Holds any ticket or pass (`exhibitor`: a claimed exhibitor pass was found for them). */
export const holdsPass = (user, { exhibitor = false } = {}) => !!exhibitor || (Array.isArray(user?.tickets) && user.tickets.length > 0);

/** Types an account gets without staff choosing them, attendee aside: [{ type, from: "role" | "pass" }]. */
export function autoTypes(user, { exhibitor = false } = {}) {
  if (!user) return [];
  const out = [];
  if (isStaff(user)) out.push({ type: "staff", from: "role" });
  if (isVolunteer(user)) out.push({ type: "volunteer", from: "role" });
  if (holdsSpeakerPass(user.tickets)) out.push({ type: "speaker", from: "pass" });
  if (exhibitor || holdsExhibitorPass(user.tickets)) out.push({ type: "exhibitor", from: "pass" });
  return out;
}

/** Effective types, in PERSON_TYPES order ([] = none: they get the attendee column). */
export function effectiveTypes(user, { exhibitor = false } = {}) {
  if (!user) return [];
  const off = new Set(storedTypes(user.typesOff));
  const on = new Set([...storedTypes(user.types), ...autoTypes(user, { exhibitor }).map((a) => a.type)]);
  for (const t of off) on.delete(t);
  if (!on.size && !off.has("attendee") && holdsPass(user, { exhibitor })) on.add("attendee");
  return PERSON_TYPES.filter((t) => on.has(t));
}

/** The badge type: staff > volunteer > vip > speaker > exhibitor > vendor > "". */
export const primaryKind = (types = []) => KIND_PRIORITY.find((t) => (types || []).includes(t)) || "";

/** The types other people may see, in badge order (never attendee, never rights). */
export const publicTypes = (types = []) => PUBLIC_TYPES.filter((t) => (types || []).includes(t));

const KIND_RANK = Object.fromEntries([...KIND_PRIORITY].reverse().map((k, i) => [k, i + 1]));
/** The higher of two kinds (staff > volunteer > vip > speaker > exhibitor > vendor > ""). */
export const strongerKind = (a = "", b = "") => ((KIND_RANK[b] || 0) > (KIND_RANK[a] || 0) ? b : a);

/** Kind for an account: its primary effective type ("staff" … "vendor", or "").
    `exhibitor`: an exhibitor pass was found for them (claimed Attendee row). */
export function cardKind(user, { exhibitor = false } = {}) {
  return primaryKind(effectiveTypes(user, { exhibitor }));
}

/** Can use the apps' staff sign-in (password): role admin / volunteer, or the staff / volunteer type. */
export function canUseStaffSignIn(user) {
  if (!user) return false;
  if (isTeam(user)) return true;
  const types = effectiveTypes(user);
  return types.includes("staff") || types.includes("volunteer");
}

/** Kind for a ticket record (Attendee): "speaker" | "exhibitor" | "".
    Exhibitor: an exhibitor pass (promo EXHIBITOR) or a pass staff marked as an exhibitor's (Attendee.exhibitor). */
export function passKind(a) {
  if (String(a?.ticketType || "").toLowerCase() === "speaker") return "speaker";
  if (String(a?.promoCode || "").toUpperCase() === EXHIBITOR_PROMO || a?.exhibitor === true) return "exhibitor";
  return "";
}

/** Booth on an exhibitor pass ("" when none). */
export const boothOf = (a) => String(a?.issuedPass?.booth?.booth || "").trim().slice(0, 20);

/** Index of exhibitor passes (Attendee rows) → finds the booth for an account.
    Matched by the account that claimed the pass, then by ticket ID. */
export function exhibitorIndex(rows = []) {
  const byUser = new Map();
  const byTicket = new Map();
  for (const a of rows || []) {
    const booth = boothOf(a);
    if (a?.claimedBy && !(byUser.get(String(a.claimedBy)))) byUser.set(String(a.claimedBy), booth);
    if (a?.ticketId) byTicket.set(String(a.ticketId), booth);
  }
  return {
    /** Booth string for this account ("" = exhibitor without a booth), or null if not an exhibitor. */
    boothFor(user) {
      if (!user) return null;
      const id = String(user._id || user.id || "");
      if (byUser.has(id)) return byUser.get(id);
      for (const t of Array.isArray(user.tickets) ? user.tickets : []) {
        if (t?.ticketId && byTicket.has(String(t.ticketId))) return byTicket.get(String(t.ticketId));
      }
      return null;
    },
  };
}

export const SPEAKER_TIER = "Speaker Pass";
export const EXHIBITOR_TIER = "Exhibitor";

/** The pass other attendees see on someone's card, post or comment: a Speaker
    Pass, or "Exhibitor" for exhibitors; every other tier stays private ("").
    The person still sees their own pass (/social/me, /auth/me). `tier` is a
    display name ("Apex Pass"); a stored "Exhibitor" passes through. */
export function publicTier(tier, kind = "") {
  const t = String(tier || "").trim();
  if (kind === "speaker" || t === SPEAKER_TIER) return SPEAKER_TIER;
  if (kind === "exhibitor" || t === EXHIBITOR_TIER) return EXHIBITOR_TIER;
  return "";
}

/** The pass others see for someone with these effective types: a Speaker Pass, "Exhibitor" or "". */
export function typesTier(types = []) {
  if ((types || []).includes("speaker")) return SPEAKER_TIER;
  if ((types || []).includes("exhibitor")) return EXHIBITOR_TIER;
  return "";
}

/** { types (effective, all), kind, booth } for an account. `index` = exhibitorIndex(). */
export function typeInfo(user, index = null) {
  const booth = index ? index.boothFor(user) : null;
  const types = effectiveTypes(user, { exhibitor: booth !== null });
  const kind = primaryKind(types);
  return { types, kind, booth: kind === "exhibitor" ? booth || "" : "" };
}

/** { kind, booth } for an account's card. */
export function kindFields(user, index = null) {
  const { kind, booth } = typeInfo(user, index);
  return { kind, booth };
}
