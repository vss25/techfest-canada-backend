import Attendee from "../models/Attendee.js";
import { userCard } from "./socialHelpers.js";
import { contactAccess, applyAccess } from "./contactAccess.js";
import { EXHIBITOR_PROMO, exhibitorIndex } from "./teamRoles.js";

/* User cards as the signed-in viewer sees them: contact switches corrected
   for the viewer (services/contactAccess.js) and the Network kind/booth
   (services/teamRoles.js). */

// Exhibitor passes are issued Attendee rows (promo EXHIBITOR), a few hundred
// at most; kept for a minute so card lists don't query them every time.
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

/** Cards for `users` (null entries stay null) as `viewer` sees them. */
export async function cardsFor(viewer, users) {
  const list = (users || []).filter(Boolean);
  const [access, exhibitors] = await Promise.all([contactAccess(viewer, list), loadExhibitors()]);
  return (users || []).map((u) => (u ? applyAccess(userCard(u, { exhibitors }), access) : null));
}
