import mongoose from "mongoose";

/* Tiers a promo code can be scoped to.
   Empty `tiers` array still means "everything" — passes and booths alike.
   Keep this list in sync with ALLOWED_TIERS in routes/promos.js. */
export const PROMO_TIERS = [
  "connect",
  "influence",
  "power",
  "apex",
  "booth-single",
  "booth-double",
  "booth-triple",
  "booth-quadruple",
];

const promoSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true, index: true },
  discount: { type: Number, required: true, min: 1, max: 100 }, // percent

  // Empty array = applies to ALL passes AND booths.
  // Otherwise only the listed tiers can use it.
  tiers: { type: [String], default: [], enum: PROMO_TIERS },

  active: { type: Boolean, default: true },
  timesUsed: { type: Number, default: 0 },   // webhook counter; the admin list and the limit use Stripe paid uses instead

  // Usage limit: the code stops working once its paid uses reach this.
  // null = unlimited. See services/promoLimits.js.
  maxUses: { type: Number, min: 1, default: null },

  // The code stops working after this moment (checkout and validation refuse it).
  // null = no end date. See services/promoLimits.js promoExpired().
  expiresAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model("Promo", promoSchema);
