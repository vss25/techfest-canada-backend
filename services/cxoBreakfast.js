/* =========================================================
   CxO Breakfast: who gets it (Oct 19 2026)
   ---------------------------------------------------------
   "There are only 4 passes. When attendees are selected as speakers,
   they will by default have access to the breakfast." So, per pass:
     automatic  Yes for an Apex Pass and a Speaker Pass, and for anyone
                whose person types include speaker (staff-set or from a
                Speaker Pass), whatever their pass; No otherwise (Power
                no longer includes it).
     override   staff's per-pass switch "CxO Breakfast included":
                true / false on the ticket record, unset = automatic.
                Attendee.cxoBreakfast on a guest / issued / speaker pass,
                User.tickets[].cxoBreakfast on a ticket bought on an
                account (those have no Attendee row); both are written
                together when both exist, and the account's wins when
                they disagree.
   On top of that, an RSVP that already has a CxO Breakfast keeps it
   (services/rsvp.js extraOptionsFor): we never change an RSVP.
   Since Oct 19 2026 this is one of four pass extras (CxO Breakfasts,
   luncheons, the Gala Dinner, the Awards Night: services/passExtras.js);
   these are the CxO Breakfasts' own names for it, kept for callers.
   Pure, unit-tested (test/cxo-breakfast.test.js).
========================================================= */

import { CXO_KEYS } from "./rsvp.js";
import { autoExtras, cleanExtraSwitch, extraLabel, ticketsWithExtras } from "./passExtras.js";

export { CXO_KEYS };

/** The first true / false among the records' `cxoBreakfast` (account ticket first), else undefined (automatic). */
export function cxoOverride(...records) {
  for (const r of records) if (typeof r?.cxoBreakfast === "boolean") return r.cxoBreakfast;
  return undefined;
}

/** Automatic: an Apex or Speaker Pass, or a speaker-type holder. Booths never. */
export const autoCxo = (ticketType, types = []) => autoExtras(ticketType, types).cxo;

/** Effective value for one pass: staff's switch when set, else automatic. */
export function effectiveCxo({ ticketType = "", types = [], override } = {}) {
  return typeof override === "boolean" ? override : autoCxo(ticketType, types);
}

/** `cxoBreakfast` body value → true | false | null (automatic), or undefined when it isn't one of those. */
export const cleanCxoSwitch = cleanExtraSwitch;

/** "Yes" / "No" / "automatic (Yes)" for audit lines. */
export const cxoLabel = extraLabel;

/**
 * The signed-in person's tickets (GET /api/auth/me) with `cxoBreakfast: true|false` on each (the
 * effective value) and `inclusions` (services/passExtras.js ticketsWithExtras, which this is).
 */
export const ticketsWithCxo = ticketsWithExtras;
