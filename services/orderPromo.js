/* Resolving a buyer's promo code for the commerce endpoints
   (routes/ticketsQuote.js, routes/orders.js): the same validity rules as
   the single-ticket checkout (routes/payments.js) — the code must exist,
   be active, and not be expired (services/promoLimits.js), and when its
   `tiers` list is non-empty the ticket's slug must be on it (an empty
   list means every pass, as in payments.js). Usage limits (maxUses) are
   NOT checked here: checkout enforces them with lockPromo +
   promoUsageNow, exactly like payments.js; the quote only reports.

   Returns { promo, code } for a usable code, { promo: null, code } for
   no code, and { promo: null, code, invalid: true } for a code that was
   given but can't be used — callers decide whether that's a hard error
   (checkout) or a note on the quote. */

import Promo from "../models/Promo.js";
import { promoExpired } from "./promoLimits.js";

export async function resolveOrderPromo(code, ticketTypes) {
  const clean = String(code || "").trim().toUpperCase();
  if (!clean) return { promo: null, code: "" };

  const promo = await Promo.findOne({ code: clean, active: true });
  if (!promo || promoExpired(promo)) {
    return { promo: null, code: clean, invalid: true };
  }

  // Tier scoping: every ticket type in the order must be in scope.
  const tiers = Array.isArray(promo.tiers) ? promo.tiers : [];
  if (tiers.length > 0) {
    const types = Array.isArray(ticketTypes) ? ticketTypes : [ticketTypes];
    const inScope = types.every((t) =>
      tiers.includes(String(t?.slug || "").toLowerCase())
    );
    if (!inScope) return { promo: null, code: clean, invalid: true };
  }

  return { promo, code: clean };
}

export default resolveOrderPromo;
