import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import { holderIsAccount } from "./checkinCard.js";
import { passVariants, pickHolder, passIsOut } from "./passConnect.js";
import { cachedStripeSessions } from "./stripeSales.js";

/* =========================================================
   Who holds a pass: the person, never just whoever's account or
   email it sits on. The door check-in card (routes/checkin.js) and
   connect by pass (POST /api/social/connections/by-pass, Oct 24
   2026) both ask here.
     - a ticket on an account (User.tickets) is that account's,
       unless the checkout form names someone else on it (a buyer
       signed in and bought for a colleague);
     - a guest / issued / speaker / exhibitor pass (Attendee) is the
       account that claimed it, else the account with its email AND
       an agreeing name (services/checkinCard.js holderIsAccount).
   A buyer's email on a colleague's pass is never the colleague's
   account, and the buyer is never the colleague.
========================================================= */

// What the door card reads from an account (types, VIP flag, passes, photo, job). The email only to find their speaker photo.
export const HOLDER_SELECT = "name email role types typesOff vip tickets jobTitle organization avatarVersion";
const PLACEHOLDER_EMAIL = /@ticket\.thetechfestival\.com$/i;

/** The account behind a guest / issued / speaker / exhibitor pass: the one that claimed it, else the one with its
    email whose name agrees (a buyer's email on a colleague's pass isn't the colleague's account). null: none. */
export async function accountForPass(attendee, { select = HOLDER_SELECT } = {}) {
  if (!attendee) return null;
  if (attendee.claimedBy) {
    const claimer = await User.findById(attendee.claimedBy).select(select).lean();
    if (claimer) return claimer;
  }
  const email = String(attendee.email || "").trim().toLowerCase();
  if (!email || PLACEHOLDER_EMAIL.test(email)) return null;
  const owner = await User.findOne({ email }).select(select).lean();
  return owner && holderIsAccount({ account: owner, attendee }) ? owner : null;
}

// Connect by pass: what the route needs of the account (whether they're on the app, banned) and of the pass record
// (hidden from staff lists, a sync copy, its Stripe session for refunds, the name on it, its email for "hidden").
const CONNECT_HOLDER_SELECT = "name email tickets banned lastActiveAt appOnboarded";
const PASS_SELECT = "name email ticketId ticketType claimedBy hiddenByStaff syncDuplicate stripeSessionId details.firstName details.lastName";

/**
 * The person holding the pass in a scanned entry QR, for connect by pass. `raw`: any form of the door QR
 * ("TECHFEST:<ticketId>", the bare ID, any case, stray spaces; services/doorQr.js).
 * → { found: false }                 no such pass, or one that doesn't count: hidden by staff, a Stripe-sync
 *                                    duplicate, or fully refunded (from the Stripe sessions this instance already
 *                                    has cached, services/stripeSales.js; never a Stripe call from a scan)
 *   { found: true, ticketId, attendee, account }   ticketId as stored; attendee = the pass record (or the claimed
 *                                    copy of an account's ticket) or null; account = the holder's User
 *                                    ({ _id, name, email, banned, lastActiveAt, appOnboarded }) or null when the
 *                                    holder has no account we can tell is theirs.
 */
export async function resolvePassHolder(raw) {
  const { typed, variants } = passVariants(raw);
  if (!typed) return { found: false };
  const holders = await User.find({ "tickets.ticketId": { $in: variants } }).select(CONNECT_HOLDER_SELECT).limit(5).lean();
  const stored = holders.flatMap((h) => (h.tickets || []).map((t) => t?.ticketId)).filter((id) => variants.includes(id));
  const attendee = await Attendee.findOne({ ticketId: { $in: [...new Set([...variants, ...stored])] } }).select(PASS_SELECT).lean();
  if (!holders.length && !attendee) return { found: false };

  const picked = pickHolder({ holders, typed, attendee });
  const ticket = picked.ticket || holders.map((h) => (h.tickets || []).find((t) => variants.includes(t?.ticketId))).find(Boolean) || null;
  if (passIsOut({ ticket, attendee, stripeRows: cachedStripeSessions()?.rows || null })) return { found: false };

  // A ticket on an account that names someone else: the colleague's own account (claimed it, or their email with
  // their name on the pass record), never the buyer's.
  let account = picked.account || (attendee ? await accountForPass(attendee, { select: CONNECT_HOLDER_SELECT }) : null);
  // An account whose ticket names someone else is never that someone, whichever way it was found.
  if (!picked.account && account && holders.some((h) => String(h._id) === String(account._id))) account = null;
  return { found: true, ticketId: ticket?.ticketId || attendee?.ticketId || typed, attendee, account: account || null };
}
