import Stripe from "stripe";

/* =========================================================
   Stripe client + HST configuration for Checkout Sessions,
   for the commerce endpoints (routes/orders.js).

   routes/payments.js (the single-ticket checkout) has its
   own copies of both and is deliberately untouched; this
   module mirrors it exactly — same env vars (TAX_MODE,
   HST_PERCENT), same default "manual" mode, and the same
   rule of reusing the account's existing 13% exclusive HST
   TaxRate before creating one — so both flows charge tax
   the same way and share the one Stripe TaxRate object.

   Every ticket is sold from Ontario, so 13% HST is added
   ON TOP of the listed price (on the discounted subtotal:
   Stripe applies discounts first, then tax).
========================================================= */

export function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY missing in env");
  }
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

export const TAX_MODE = (process.env.TAX_MODE || "manual").toLowerCase();
export const HST_PERCENT = Number(process.env.HST_PERCENT || 13);

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
 * on top of the listed price (same contract as routes/payments.js):
 *
 *   { lineItemExtras, sessionExtras }
 *
 * lineItemExtras → spread into each line_items entry
 * sessionExtras  → spread into the sessions.create({...}) object
 */
export async function buildTaxConfig(stripe) {
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
