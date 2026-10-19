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
   Pure, unit-tested (test/cxo-breakfast.test.js).
========================================================= */

import { tierFromTicketType, CXO_KEYS } from "./rsvp.js";
import { normalizeTicketId } from "./ticketAccess.js";

export { CXO_KEYS };

/** The first true / false among the records' `cxoBreakfast` (account ticket first), else undefined (automatic). */
export function cxoOverride(...records) {
  for (const r of records) if (typeof r?.cxoBreakfast === "boolean") return r.cxoBreakfast;
  return undefined;
}

/** Automatic: an Apex or Speaker Pass, or a speaker-type holder. Booths never. */
export function autoCxo(ticketType, types = []) {
  if (/^booth/i.test(String(ticketType || ""))) return false;
  const tier = tierFromTicketType(ticketType);
  return tier === "apex" || tier === "speaker" || (Array.isArray(types) && types.includes("speaker"));
}

/** Effective value for one pass: staff's switch when set, else automatic. */
export function effectiveCxo({ ticketType = "", types = [], override } = {}) {
  return typeof override === "boolean" ? override : autoCxo(ticketType, types);
}

/** `cxoBreakfast` body value → true | false | null (automatic), or undefined when it isn't one of those. */
export function cleanCxoSwitch(v) {
  if (v === true || v === false || v === null) return v;
  if (v === "auto" || v === "automatic" || v === "") return null;
  return undefined;
}

/** "Yes" / "No" / "automatic (Yes)" for audit lines. */
export const cxoLabel = (override, effective) => (typeof override === "boolean" ? (override ? "Yes" : "No") : `automatic (${effective ? "Yes" : "No"})`);

/**
 * The signed-in person's tickets (GET /api/auth/me) with `cxoBreakfast: true|false` on each,
 * the effective value. `types`: their effective person types; `attendees`: Attendee rows for
 * those ticket IDs ({ ticketId, cxoBreakfast }) whose switch applies when the account ticket has none.
 */
export function ticketsWithCxo(tickets = [], { types = [], attendees = [] } = {}) {
  const byTicket = new Map();
  for (const a of attendees || []) if (a?.ticketId && typeof a.cxoBreakfast === "boolean") byTicket.set(normalizeTicketId(a.ticketId), a);
  return (Array.isArray(tickets) ? tickets : []).map((t) => {
    const { cxoBreakfast: stored, ...rest } = t || {};
    const override = cxoOverride({ cxoBreakfast: stored }, byTicket.get(normalizeTicketId(t?.ticketId)));
    const booth = /^BOOTH-/i.test(String(t?.ticketId || ""));
    return { ...rest, cxoBreakfast: !booth && effectiveCxo({ ticketType: t?.type, types, override }) };
  });
}
