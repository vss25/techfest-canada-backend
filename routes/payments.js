import express from "express";
import jwt from "jsonwebtoken";
import Stripe from "stripe";
import User from "../models/User.js";
import TicketInventory from "../models/TicketInventory.js";
import Promo from "../models/Promo.js";

const router = express.Router();

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY missing in env");
  }
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

/* =========================================================
   🇨🇦 HST — 13% ONTARIO SALES TAX
   =========================================================
   Every ticket, booth and deposit is sold from Ontario, so
   13% HST is added ON TOP of the listed price.

   TAX_MODE (env, optional):
     "manual"    — DEFAULT. Attaches an explicit 13% Stripe
                   TaxRate to the line item. Works whether or
                   not Stripe Tax is enabled on the account,
                   which is why it is the default: the ticket
                   branch previously relied on nothing at all
                   and charged the bare price.
     "automatic" — Uses Stripe Tax (automatic_tax). Only pick
                   this once Stripe Tax is enabled AND your
                   origin address + registrations are set up
                   in the Stripe dashboard, otherwise Stripe
                   silently charges $0 tax.
     "none"      — No tax added (testing only).

   HST_PERCENT (env, optional): defaults to 13.

   Order of operations with a promo code: Stripe applies the
   coupon first, then charges tax on the discounted subtotal —
   which is the correct treatment.
========================================================= */
const TAX_MODE = (process.env.TAX_MODE || "manual").toLowerCase();
const HST_PERCENT = Number(process.env.HST_PERCENT || 13);

/* Stripe TaxRate objects are immutable and cheap to reuse, so we
   look one up once per process and cache it. */
let cachedTaxRateId = null;

async function getHstTaxRateId(stripe) {
  if (cachedTaxRateId) return cachedTaxRateId;

  // Reuse an existing 13% exclusive HST rate if one is already on the account
  const existing = await stripe.taxRates.list({ active: true, limit: 100 });
  const match = existing.data.find(
    (r) =>
      Number(r.percentage) === HST_PERCENT &&
      r.inclusive === false &&
      (r.display_name || "").toUpperCase() === "HST"
  );

  if (match) {
    cachedTaxRateId = match.id;
    return cachedTaxRateId;
  }

  const created = await stripe.taxRates.create({
    display_name: "HST",
    description: `Ontario HST ${HST_PERCENT}%`,
    jurisdiction: "CA-ON",
    percentage: HST_PERCENT,
    inclusive: false, // added on top of the listed price
    country: "CA",
    state: "ON",
    tax_type: "hst",
  });

  console.log("🧾 Created Stripe tax rate:", created.id, `(${HST_PERCENT}% HST)`);
  cachedTaxRateId = created.id;
  return cachedTaxRateId;
}

/**
 * Returns the pieces a Checkout Session needs so that HST is charged
 * on top of the listed price.
 *
 *   { lineItemExtras, sessionExtras }
 *
 * lineItemExtras → spread into the line_items[0] object
 * sessionExtras  → spread into the sessions.create({...}) object
 */
async function buildTaxConfig(stripe) {
  if (TAX_MODE === "none") {
    return { lineItemExtras: {}, sessionExtras: {} };
  }

  if (TAX_MODE === "automatic") {
    return {
      lineItemExtras: {},
      sessionExtras: {
        automatic_tax: { enabled: true },
        billing_address_collection: "required",
        tax_id_collection: { enabled: true },
      },
    };
  }

  // "manual" — explicit tax rate, independent of Stripe Tax settings
  const taxRateId = await getHstTaxRateId(stripe);
  return {
    lineItemExtras: { tax_rates: [taxRateId] },
    sessionExtras: { billing_address_collection: "required" },
  };
}

// middleware to get user from token (optional — used when a logged-in user is buying)
async function getUserFromReq(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) throw new Error("No token");
  const token = authHeader.split(" ")[1];
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  const user = await User.findById(decoded.id);
  if (!user) throw new Error("User not found");
  return user;
}

const titleCase = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

/** "booth-single" → "TTFC 2026 Exhibition Booth — Single"
 *  "apex"         → "TTFC Apex Pass"                        */
function productNameFor(tier) {
  const t = String(tier);
  if (t.startsWith("booth-")) {
    return `TTFC 2026 Exhibition Booth — ${titleCase(t.replace("booth-", ""))}`;
  }
  return `TTFC ${titleCase(t)} Pass`;
}

/** Stripe metadata values must be strings and are capped at 500 chars. */
function cleanMetadata(obj) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") continue;
    const value = Array.isArray(v) ? v.join(", ") : String(v);
    out[String(k).slice(0, 40)] = value.slice(0, 500);
  }
  return out;
}

// ================= CREATE CHECKOUT =================
// NOTE: server.js mounts this at /api/payments, so the path here is just /create-checkout
// Frontend calls: POST /api/payments/create-checkout
router.post("/create-checkout", async (req, res) => {
  try {
    const { type, tier, promoCode, metadata } = req.body;

    // ═══════════════════════════════════════════════════════
    // BRANCH 1: INDIA PAVILION DEPOSIT ($500 CAD + 13% HST)
    // ═══════════════════════════════════════════════════════
    if (type === "pavilion-deposit") {
      const stripe = getStripe();

      const companyName = metadata?.companyName || "Pavilion Applicant";
      const contactEmail = metadata?.contactEmail;
      const applicationRef = metadata?.applicationRef || "N/A";

      if (!contactEmail) {
        return res.status(400).json({ error: "Contact email is required" });
      }

      const { lineItemExtras, sessionExtras } = await buildTaxConfig(stripe);

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: contactEmail,
        line_items: [{
          price_data: {
            currency: "cad",
            product_data: {
              name: "India Startup Pavilion — Application Deposit",
              description: `TTFC 2026 · ${companyName} · Ref: ${applicationRef}`,
              // General tax code; used when TAX_MODE="automatic".
              tax_code: "txcd_10000000",
            },
            unit_amount: 50000, // $500.00 CAD base amount (HST added on top)
            tax_behavior: "exclusive", // HST added on top, not included
          },
          quantity: 1,
          ...lineItemExtras,
        }],
        ...sessionExtras,
        success_url: `${process.env.FRONTEND_URL}/exhibit/india-pavilion/pay?success=true`,
        cancel_url: `${process.env.FRONTEND_URL}/exhibit/india-pavilion/pay?canceled=true`,
        metadata: {
          type: "pavilion-deposit",
          companyName,
          contactEmail,
          applicationRef,
        },
      });

      return res.json({ url: session.url });
    }

    // ═══════════════════════════════════════════════════════
    // BRANCH 2: TIER PURCHASE — delegate passes AND exhibition booths
    // Booths arrive as tier "booth-single", "booth-double", etc.
    // ═══════════════════════════════════════════════════════
    if (!tier) return res.status(400).json({ error: "Tier required" });

    const inventoryItem = await TicketInventory.findOne({ tier });
    if (!inventoryItem) return res.status(404).json({ error: "Tier not found" });

    const basePriceCAD = inventoryItem.price;
    const isBooth = String(tier).startsWith("booth-");

    // A tier seeded without a price would otherwise create a $0 Stripe session
    if (!basePriceCAD || basePriceCAD <= 0) {
      return res.status(409).json({ error: "This tier is not available for purchase yet." });
    }

    // Don't sell past the allocation (total 0 = unlimited / not yet capped)
    if (inventoryItem.total > 0 && inventoryItem.sold >= inventoryItem.total) {
      return res.status(409).json({ error: "This tier is sold out." });
    }

    const stripe = getStripe();

    // ===== PROMO CODE HANDLING (with tier check) =====
    let appliedDiscount = 0;
    let appliedPromo = null;

    if (promoCode) {
      const code = String(promoCode).trim().toUpperCase();
      const promo = await Promo.findOne({ code, active: true });

      if (promo) {
        // Per-tier scoping: empty tiers array = valid for all passes AND booths
        const tiersOk = !Array.isArray(promo.tiers) || promo.tiers.length === 0
          || promo.tiers.includes(String(tier).toLowerCase());

        if (tiersOk) {
          appliedDiscount = promo.discount;
          appliedPromo = promo;
        }
      }
      // If invalid/wrong-tier, silently ignore — frontend already showed an error to user.
    }

    // ===== STRIPE: use a coupon for percent-off =====
    let discountsArg = undefined;
    if (appliedDiscount > 0) {
      const coupon = await stripe.coupons.create({
        percent_off: appliedDiscount,
        duration: "once",
        name: appliedPromo ? `${appliedPromo.code} (${appliedDiscount}% off)` : `${appliedDiscount}% off`,
      });
      discountsArg = [{ coupon: coupon.id }];
    }

    // ===== TAX: 13% HST on top of the listed price =====
    const { lineItemExtras, sessionExtras } = await buildTaxConfig(stripe);

    // Attendee details captured on the checkout form (may be absent for booths)
    const attendee = cleanMetadata(metadata);
    const buyerEmail = metadata?.email || metadata?.contactEmail || undefined;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      ...(buyerEmail ? { customer_email: buyerEmail } : {}),
      line_items: [{
        price_data: {
          currency: "cad",
          product_data: {
            name: productNameFor(tier),
            // General tax code; used when TAX_MODE="automatic".
            tax_code: "txcd_10000000",
          },
          unit_amount: Math.round(basePriceCAD * 100),
          tax_behavior: "exclusive", // HST is added on top of this amount
        },
        quantity: 1,
        ...lineItemExtras,
      }],
      discounts: discountsArg,
      ...sessionExtras,
      success_url: isBooth
        ? `${process.env.FRONTEND_URL}/exhibit?success=true`
        : `${process.env.FRONTEND_URL}/tickets?success=true`,
      cancel_url: isBooth
        ? `${process.env.FRONTEND_URL}/exhibit`
        : `${process.env.FRONTEND_URL}/tickets`,
      metadata: {
        ...attendee,
        type: isBooth ? "booth" : "ticket",
        tier,
        basePrice: String(basePriceCAD),
        taxMode: TAX_MODE,
        taxPercent: String(HST_PERCENT),
        promoCode: appliedPromo ? appliedPromo.code : "",
        discount: String(appliedDiscount),
      },
    });

    if (appliedPromo) {
      await Promo.updateOne({ _id: appliedPromo._id }, { $inc: { timesUsed: 1 } });
    }

    res.json({ url: session.url });
  } catch (err) {
    console.error("Checkout error:", err);
    res.status(500).json({ error: err.message || "Checkout failed" });
  }
});

export default router;
