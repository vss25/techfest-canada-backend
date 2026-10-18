import Attendee from "../models/Attendee.js";
import { EXHIBITOR_PROMO, exhibitorIndex } from "./teamRoles.js";

/* Exhibitor passes are issued Attendee rows (promo EXHIBITOR), a few hundred
   at most; kept for a minute so card lists and rights checks don't query them
   every time. Used by services/cards.js and services/rightsStore.js. */

const EXHIBITOR_TTL_MS = 60_000;
let cached = { at: 0, index: null };

/** exhibitorIndex() over every exhibitor pass (cached for a minute). */
export async function loadExhibitors() {
  if (cached.index && Date.now() - cached.at < EXHIBITOR_TTL_MS) return cached.index;
  const rows = await Attendee.find({ promoCode: EXHIBITOR_PROMO }).select("claimedBy ticketId issuedPass.booth").lean();
  cached = { at: Date.now(), index: exhibitorIndex(rows) };
  return cached.index;
}
export const clearExhibitorCache = () => { cached = { at: 0, index: null }; };
