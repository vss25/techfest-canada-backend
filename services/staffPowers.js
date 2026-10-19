/* =========================================================
   What staff (role admin, not management) may do in event week.
   The organiser's decisions on the admin review (Oct 19 2026):

   Staff may now
     - give a SINGLE pass: create one issued pass (Admin › Give a
       pass), then send it, one request at a time and rate-limited.
       Editing, deleting, the email template, exhibitor and speaker
       passes stay management only;
     - send ONE RSVP reminder or ONE "I'm attending" LinkedIn nudge
       to one person, from their People profile, with the same
       cool-downs as the bulk sends.
   Management only (refused on the server with 403, shown disabled
   with "Management only" in the panel)
     - selling switches: ticket sales on / off and its message, pass
       upgrades, and the guest offer settings;
     - Broadcast (POST /console/broadcast: the push to every phone);
     - every send to many people (RSVP reminders, nudges, speaker
       passes), prices, revenue and staff settings, as before.
   Staff keep the app switches (posts, groups, polls, Q&A, …) and
   one-person notifications.

   Promotions are banned (the organiser, Oct 18 2026): the guest
   offer (flag.guestOffer, the web app's APP50 banner) can't be
   switched on by anyone, management included. There is no unlock:
   GUEST_OFFER_UNLOCKED is false and nothing sets it. Switching it
   off stays allowed (management).

   Pure, unit-tested (test/admin-simplify.test.js); the routes use it
   (routes/console.js, routes/issuedPasses.js, routes/people.js).
========================================================= */

export const GUEST_OFFER_FLAG = "flag.guestOffer";
/** The web app's guest offer: the switch and its four unlabelled settings (code, discount, end, passes). */
export const GUEST_OFFER_KEYS = Object.freeze([GUEST_OFFER_FLAG, "offer.guest_code", "offer.guest_discount", "offer.guest_ends", "offer.guest_passes"]);
/** Never true: a new, explicit unlock would have to be added (and asked for) before the offer could come back. */
export const GUEST_OFFER_UNLOCKED = false;

/** App content keys only management may change (PUT /console/app-content/:key). */
export const MANAGEMENT_CONTENT_KEYS = Object.freeze([
  "site.ticket_sales_open", "site.ticket_sales_message", "flag.upgrades", ...GUEST_OFFER_KEYS,
]);
const MANAGEMENT_SET = new Set(MANAGEMENT_CONTENT_KEYS);

export const MANAGEMENT_ONLY_ERROR = "Only management can change this.";
export const PROMOTIONS_OFF_ERROR = "Promotions are switched off for TTFC 2026, so the guest offer can't be turned on.";

/** { managementOnly, locked } for a content key (GET /console/app-content shows them; the panel disables the row). */
export function contentAccess(key) {
  return { managementOnly: MANAGEMENT_SET.has(key), locked: key === GUEST_OFFER_FLAG && !GUEST_OFFER_UNLOCKED };
}

/**
 * May this person save this value? `value` is the cleaned value (services/adminHelpers.js cleanContent).
 * @returns {null | { status: 403, code: "promotions_off" | "management_only", error: string }}
 */
export function contentEditRefusal(key, value, { management = false } = {}) {
  if (key === GUEST_OFFER_FLAG && value === true && !GUEST_OFFER_UNLOCKED) {
    return { status: 403, code: "promotions_off", error: PROMOTIONS_OFF_ERROR };
  }
  if (MANAGEMENT_SET.has(key) && !management) return { status: 403, code: "management_only", error: MANAGEMENT_ONLY_ERROR };
  return null;
}

/* ---------- one at a time, never bulk: per-staff budgets for single sends ---------- */

/** Single passes a staff member may create, and sends they may make, in an hour (management has no budget). */
export const STAFF_PASS_LIMIT = Object.freeze({ max: 30, windowMs: 60 * 60 * 1000 });
/** Single RSVP reminders or LinkedIn nudges from a profile, per staff member (or manager) per hour. */
export const SINGLE_SEND_LIMIT = Object.freeze({ max: 60, windowMs: 60 * 60 * 1000 });

/** "by staff" note for the audit log, so a send by someone who isn't management stands out. */
export const staffNote = (management) => (management ? "" : " (by staff)");
