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

  // What kind of discount this code is (commerce build-out, plan §9.4;
  // priced by services/pricingEngine.js). "percent" is the original
  // behaviour — `discount` % off — and stays the default, so every code
  // created before this field existed keeps working exactly as it did.
  // The other kinds are honoured by the multi-attendee checkout
  // (routes/orders.js) and the quote endpoint (routes/ticketsQuote.js);
  // the single-ticket checkout (routes/payments.js) applies "percent"
  // codes only:
  //   "fixed"         amountCents off the order
  //   "bogo"          buy buyQuantity, get getQuantity free
  //   "group-percent" `discount` % off when the order reaches minQuantity tickets
  //   "group-fixed"   amountCents off when the order reaches minQuantity tickets
  kind: {
    type: String,
    enum: ["percent", "fixed", "bogo", "group-percent", "group-fixed"],
    default: "percent",
  },
  // Fixed amount off, in cents (kind "fixed" / "group-fixed").
  amountCents: { type: Number, min: 0, default: null },
  // BOGO shape (kind "bogo"): in every complete group of
  // buyQuantity + getQuantity tickets, getQuantity are free.
  buyQuantity: { type: Number, min: 1, default: null },
  getQuantity: { type: Number, min: 1, default: null },
  // Group threshold (kind "group-percent" / "group-fixed"): the discount
  // applies at this many tickets or more.
  minQuantity: { type: Number, min: 1, default: null },

  // Staff-made codes past the safeguard (services/promoApproval.js) wait for a manager, switched off.
  createdBy: { type: String, default: "" },
  approval: {
    needed: { type: Boolean, default: false },
    reasons: { type: [String], default: [] },
    requestedBy: { type: String, default: "" },
    requestedAt: { type: Date, default: null },
    by: { type: String, default: "" },
    at: { type: Date, default: null },
  },

  createdAt: { type: Date, default: Date.now },

  // The event the code is for (Nov 23 2026). Missing = the 2026 main event. Listing only: checkout doesn't check it yet.
  eventKey: { type: String, default: undefined, index: true },
});

export default mongoose.model("Promo", promoSchema);
