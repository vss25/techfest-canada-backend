import Attendee from "../models/Attendee.js";
import { EXHIBITOR_PROMO, exhibitorIndex } from "./teamRoles.js";

/* Exhibitor passes are issued Attendee rows (promo EXHIBITOR), a few hundred
   at most, plus passes staff marked as an exhibitor's, minus exhibitor passes staff
   switched off (Attendee.exhibitor true / false, set in Admin → People; the same
   rule as isExhibitorPass in services/teamRoles.js); kept for a minute so card
   lists and rights checks don't query them every time. Used by services/cards.js
   and services/rightsStore.js. */

const EXHIBITOR_TTL_MS = 60_000;
export const EXHIBITOR_FILTER = Object.freeze({ $or: [{ promoCode: EXHIBITOR_PROMO, exhibitor: { $ne: false } }, { exhibitor: true }] });
let cached = { at: 0, index: null };

/** exhibitorIndex() over every exhibitor pass, plus the passes staff marked VIP (Attendee.vip,
    for hasVipPass), cached for a minute. Admin → People clears it after either switch. */
export async function loadExhibitors() {
  if (cached.index && Date.now() - cached.at < EXHIBITOR_TTL_MS) return cached.index;
  const [rows, vipRows] = await Promise.all([
    Attendee.find(EXHIBITOR_FILTER).select("claimedBy ticketId issuedPass.booth").lean(),
    Attendee.find({ vip: true }).select("claimedBy ticketId").lean(),
  ]);
  cached = { at: Date.now(), index: exhibitorIndex(rows, { vipRows }) };
  return cached.index;
}
export const clearExhibitorCache = () => { cached = { at: 0, index: null }; };
