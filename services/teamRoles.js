/* Who someone is at TTFC: User.role, and the "kind" the apps' Network
   sections use (All / Speakers / Exhibitors / Staff). Pure, so it's
   unit-tested (test/team-roles.test.js) and safe to import anywhere.

   Roles: "user" (attendee), "admin" (staff: the admin panel and every staff
   power) and "volunteer" (the apps' staff sign-in and door check-in only;
   no admin panel, moderation, post removal, report alerts or contact-switch
   override; those all check role "admin"). */

export const ROLES = ["user", "admin", "volunteer"];

const roleOf = (u) => String(u?.role || "").toLowerCase();
export const isStaff = (u) => roleOf(u) === "admin";
export const isVolunteer = (u) => roleOf(u) === "volunteer";
/** Staff or volunteer: may use the apps' staff sign-in and check tickets in. */
export const isTeam = (u) => isStaff(u) || isVolunteer(u);

/** A role from the console, or null when it isn't one of ROLES. */
export function cleanRole(v) {
  const r = String(v ?? "").trim().toLowerCase();
  return ROLES.includes(r) ? r : null;
}

// Same value as EXHIBITOR_PROMO in services/exhibitorPasses.js (not imported:
// that module pulls in pdfkit and would make an import cycle with ticketAccess).
export const EXHIBITOR_PROMO = "EXHIBITOR";

const KIND_RANK = { "": 0, exhibitor: 1, speaker: 2, volunteer: 3, staff: 4 };
/** The higher of two kinds (staff > volunteer > speaker > exhibitor > ""). */
export const strongerKind = (a = "", b = "") => ((KIND_RANK[b] || 0) > (KIND_RANK[a] || 0) ? b : a);

const holdsSpeakerPass = (tickets) => (Array.isArray(tickets) ? tickets : []).some((t) => String(t?.type || "").toLowerCase() === "speaker");
const holdsExhibitorPass = (tickets) => (Array.isArray(tickets) ? tickets : []).some((t) => String(t?.promoCode || "").toUpperCase() === EXHIBITOR_PROMO);

/** Kind for an account: "staff" | "volunteer" | "speaker" | "exhibitor" | "".
    `exhibitor`: an exhibitor pass was found for them (claimed Attendee row). */
export function cardKind(user, { exhibitor = false } = {}) {
  if (!user) return "";
  if (isStaff(user)) return "staff";
  if (isVolunteer(user)) return "volunteer";
  if (holdsSpeakerPass(user.tickets)) return "speaker";
  if (exhibitor || holdsExhibitorPass(user.tickets)) return "exhibitor";
  return "";
}

/** Kind for a ticket record (Attendee): "speaker" | "exhibitor" | "". */
export function passKind(a) {
  if (String(a?.ticketType || "").toLowerCase() === "speaker") return "speaker";
  if (String(a?.promoCode || "").toUpperCase() === EXHIBITOR_PROMO) return "exhibitor";
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

/** { kind, booth } for an account's card. */
export function kindFields(user, index = null) {
  const booth = index ? index.boothFor(user) : null;
  const kind = cardKind(user, { exhibitor: booth !== null });
  return { kind, booth: kind === "exhibitor" ? booth || "" : "" };
}
