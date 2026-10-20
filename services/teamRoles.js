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

// Same value as SPEAKER_PROMO in services/speakerPasses.js (Admin › Speaker passes).
export const SPEAKER_PROMO = "SPEAKER";

/** A Speaker Pass: the internal fifth pass (tier "speaker", Oct 19 2026: never sold or listed on the website),
    from Admin › Speaker passes (promo SPEAKER) or Issue passes. Holding one makes someone a speaker
    automatically (autoTypes, passKind), like an exhibitor pass makes an exhibitor. */
export function isSpeakerPass(rec) {
  return String(rec?.type || rec?.ticketType || "").trim().toLowerCase() === "speaker"
    || String(rec?.promoCode || "").toUpperCase() === SPEAKER_PROMO;
}

export const holdsSpeakerPass = (tickets) => (Array.isArray(tickets) ? tickets : []).some(isSpeakerPass);
export const holdsExhibitorPass = (tickets) => (Array.isArray(tickets) ? tickets : []).some((t) => String(t?.promoCode || "").toUpperCase() === EXHIBITOR_PROMO);

/* ================= PERSON TYPES =================
   What someone is at TTFC, for the app rights matrix (services/appRights.js)
   and the badges on their card. Effective types =
     (User.types set by staff ∪ automatic types) − User.typesOff
   Automatic: staff (role admin), volunteer (role volunteer), speaker (a Speaker
   Pass: isSpeakerPass), exhibitor (an exhibitor pass), media (a pass staff marked
   Media: Attendee.media, Oct 20 2026). Attendee is automatic for anyone holding
   a pass or ticket who has no other type; staff can also add it by hand. typesOff
   is the only way to take an automatic type away from one person. `role` stays
   the sign-in / admin panel switch.

   Media (Oct 20 2026, the organiser: "allow the ability to mark people as media
   (yes/no)"): a type like the others, with the attendee's rights by default. It
   isn't a badge (not in KIND_PRIORITY / PUBLIC_TYPES): only the person's own app
   Profile page shows it (services/profileTag.js). The staff type is called
   "Staff" (it said "Organizer" before).

   VIP is not a type (since Oct 19 2026): it's a yes / no flag staff set
   (User.vip on an account, Attendee.vip on a pass, see isVip below). It gives no
   rights of its own; the apps still get kind "vip" (badge priority below) so no
   app release is needed. Stored "vip" types are moved to the flag on start
   (services/vipFlag.js). */

export const PERSON_TYPES = ["attendee", "speaker", "exhibitor", "staff", "vendor", "volunteer", "media"];
/** Values older documents may still hold in User.types / typesOff (moved to User.vip on start). Read, never written. */
export const LEGACY_TYPES = ["vip"];
/** What the User model accepts in types / typesOff, so a document saved before the move still validates. */
export const STORED_TYPE_VALUES = [...PERSON_TYPES, ...LEGACY_TYPES];
/** How the admin panel and the CSV name each type. */
export const TYPE_LABELS = Object.freeze({
  attendee: "Delegate", speaker: "Speaker", exhibitor: "Exhibitor", staff: "Staff", vendor: "Vendor", volunteer: "Volunteer", media: "Media",
});
/** Badge priority: `kind` is the first of these someone has ("vip" comes from the VIP flag). Media isn't a badge. */
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

/** Types an account gets without staff choosing them, attendee aside: [{ type, from: "role" | "pass" }].
    `media`: a pass of theirs is marked Media (Attendee.media true, isMediaPass). */
export function autoTypes(user, { exhibitor = false, media = false } = {}) {
  if (!user) return [];
  const out = [];
  if (isStaff(user)) out.push({ type: "staff", from: "role" });
  if (isVolunteer(user)) out.push({ type: "volunteer", from: "role" });
  if (holdsSpeakerPass(user.tickets)) out.push({ type: "speaker", from: "pass" });
  if (exhibitor || holdsExhibitorPass(user.tickets)) out.push({ type: "exhibitor", from: "pass" });
  if (media) out.push({ type: "media", from: "pass" });
  return out;
}

/** Effective types, in PERSON_TYPES order ([] = none: they get the attendee column). */
export function effectiveTypes(user, { exhibitor = false, media = false } = {}) {
  if (!user) return [];
  const off = new Set(storedTypes(user.typesOff));
  const on = new Set([...storedTypes(user.types), ...autoTypes(user, { exhibitor, media }).map((a) => a.type)]);
  for (const t of off) on.delete(t);
  if (!on.size && !off.has("attendee") && holdsPass(user, { exhibitor })) on.add("attendee");
  return PERSON_TYPES.filter((t) => on.has(t));
}

/* ================= VIP (a flag, not a type) =================
   Account: User.vip true / false is staff's choice; unset = VIP when a pass of
   theirs says so (Attendee.vip true: claimed by them or one of their tickets), or,
   until services/vipFlag.js has run, a stored "vip" type. Pass-only people:
   Attendee.vip true on any of their passes. The same pattern as exhibitor
   (types / typesOff on an account, Attendee.exhibitor on a pass). */

/** A stored "vip" type that wasn't switched off (documents from before the flag). */
export const legacyVip = (u) => {
  const has = (k) => (Array.isArray(u?.[k]) ? u[k] : []).some((t) => String(t ?? "").trim().toLowerCase() === "vip");
  return has("types") && !has("typesOff");
};

/** Is this account a VIP? `vipPass`: a pass of theirs has Attendee.vip true. */
export function isVip(user, { vipPass = false } = {}) {
  if (!user) return false;
  if (typeof user.vip === "boolean") return user.vip;
  return legacyVip(user) || !!vipPass;
}

/** Badge types: effective types plus "vip" for a VIP (for kind and publicTypes only, never rights). */
export const badgeTypes = (types = [], vip = false) => (vip ? [...(types || []), "vip"] : [...(types || [])]);

/** The badge type: staff > volunteer > vip > speaker > exhibitor > vendor > "". */
export const primaryKind = (types = []) => KIND_PRIORITY.find((t) => (types || []).includes(t)) || "";

/** The types other people may see, in badge order (never attendee, never rights). */
export const publicTypes = (types = []) => PUBLIC_TYPES.filter((t) => (types || []).includes(t));

const KIND_RANK = Object.fromEntries([...KIND_PRIORITY].reverse().map((k, i) => [k, i + 1]));
/** The higher of two kinds (staff > volunteer > vip > speaker > exhibitor > vendor > ""). */
export const strongerKind = (a = "", b = "") => ((KIND_RANK[b] || 0) > (KIND_RANK[a] || 0) ? b : a);

/** Kind for an account: its primary badge type ("staff" … "vendor", or "").
    `exhibitor`: an exhibitor pass was found for them (claimed Attendee row); `vipPass`: a VIP pass. */
export function cardKind(user, { exhibitor = false, vipPass = false } = {}) {
  return primaryKind(badgeTypes(effectiveTypes(user, { exhibitor }), isVip(user, { vipPass })));
}

/** Can use the apps' staff sign-in (password): role admin / volunteer, or the staff / volunteer type. */
export function canUseStaffSignIn(user) {
  if (!user) return false;
  if (isTeam(user)) return true;
  const types = effectiveTypes(user);
  return types.includes("staff") || types.includes("volunteer");
}

/** Is this ticket record an exhibitor's? Staff's switch (Attendee.exhibitor true / false) wins;
    unset = an exhibitor pass (promo EXHIBITOR) is, anything else isn't. */
export const isExhibitorPass = (a) => (typeof a?.exhibitor === "boolean"
  ? a.exhibitor
  : String(a?.promoCode || "").toUpperCase() === EXHIBITOR_PROMO);

/** Kind for a ticket record (Attendee): "speaker" | "exhibitor" | "". */
export function passKind(a) {
  if (isSpeakerPass(a)) return "speaker";
  if (isExhibitorPass(a)) return "exhibitor";
  return "";
}

/** Staff marked this pass's holder as a VIP (Attendee.vip). */
export const isVipPass = (a) => a?.vip === true;

/** Staff marked this pass's holder as Media (Attendee.media, Oct 20 2026). An account that claims the pass
    is Media too (autoTypes, from "pass"), unless staff switch media off on the account (typesOff). */
export const isMediaPass = (a) => a?.media === true;

/** Booth on an exhibitor pass ("" when none). */
export const boothOf = (a) => String(a?.issuedPass?.booth?.booth || "").trim().slice(0, 20);

/** Index of exhibitor passes (Attendee rows) → finds the booth for an account.
    Matched by the account that claimed the pass, then by ticket ID.
    `vipRows`: passes staff marked VIP (Attendee.vip true), found the same way (hasVipPass);
    `mediaRows`: passes staff marked Media (Attendee.media true, hasMediaPass). */
export function exhibitorIndex(rows = [], { vipRows = [], mediaRows = [] } = {}) {
  const byUser = new Map();
  const byTicket = new Map();
  for (const a of rows || []) {
    const booth = boothOf(a);
    if (a?.claimedBy && !(byUser.get(String(a.claimedBy)))) byUser.set(String(a.claimedBy), booth);
    if (a?.ticketId) byTicket.set(String(a.ticketId), booth);
  }
  const flagged = (list) => {
    const users = new Set();
    const tickets = new Set();
    for (const a of list || []) {
      if (a?.claimedBy) users.add(String(a.claimedBy));
      if (a?.ticketId) tickets.add(String(a.ticketId));
    }
    return (user) => {
      if (!user) return false;
      if (users.has(String(user._id || user.id || ""))) return true;
      return (Array.isArray(user.tickets) ? user.tickets : []).some((t) => t?.ticketId && tickets.has(String(t.ticketId)));
    };
  };
  const vipPass = flagged(vipRows);
  const mediaPass = flagged(mediaRows);
  return {
    /** Does this account hold a pass staff marked VIP? */
    hasVipPass: vipPass,
    /** Does this account hold a pass staff marked Media? */
    hasMediaPass: mediaPass,
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

/** What other attendees see in `tier` on a card, post or comment: the person's type, "Speaker"
    or "Exhibitor" (Oct 19 2026; it said "Speaker Pass" before, and posts from then still store that). */
export const SPEAKER_TIER = "Speaker";
export const EXHIBITOR_TIER = "Exhibitor";
const LEGACY_SPEAKER_TIER = "Speaker Pass";

/** The `tier` other attendees see on someone's card, post or comment: "Speaker" for speakers,
    "Exhibitor" for exhibitors; every pass stays private (""). The person still sees their own
    pass (/social/me, /auth/me). `tier` is a display name ("Apex Pass"); a stored "Exhibitor"
    passes through and a stored "Speaker Pass" (older posts) reads as "Speaker". */
export function publicTier(tier, kind = "") {
  const t = String(tier || "").trim();
  if (kind === "speaker" || t === SPEAKER_TIER || t === LEGACY_SPEAKER_TIER) return SPEAKER_TIER;
  if (kind === "exhibitor" || t === EXHIBITOR_TIER) return EXHIBITOR_TIER;
  return "";
}

/** The `tier` others see for someone with these effective types: "Speaker", "Exhibitor" or "". */
export function typesTier(types = []) {
  if ((types || []).includes("speaker")) return SPEAKER_TIER;
  if ((types || []).includes("exhibitor")) return EXHIBITOR_TIER;
  return "";
}

/** { types (effective, all), vip, kind, booth } for an account. `index` = exhibitorIndex().
    `types` decide rights; `kind` (the badge) also counts the VIP flag. */
export function typeInfo(user, index = null) {
  const booth = index ? index.boothFor(user) : null;
  const types = effectiveTypes(user, { exhibitor: booth !== null, media: !!index?.hasMediaPass?.(user) });
  const vip = isVip(user, { vipPass: !!index?.hasVipPass?.(user) });
  const kind = primaryKind(badgeTypes(types, vip));
  return { types, vip, kind, booth: kind === "exhibitor" ? booth || "" : "" };
}

/** { kind, booth } for an account's card. */
export function kindFields(user, index = null) {
  const { kind, booth } = typeInfo(user, index);
  return { kind, booth };
}
