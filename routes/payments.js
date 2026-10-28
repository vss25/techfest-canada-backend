import express from "express";
import jwt from "jsonwebtoken";
import Stripe from "stripe";
import User from "../models/User.js";
import TicketInventory from "../models/TicketInventory.js";
import { applyDuePrices, priceAt } from "../services/scheduledPrices.js";
import Promo from "../models/Promo.js";
import { HOLD_MINUTES, LIMIT_REACHED, isFull, promoExpired, lockPromo, promoUsageNow } from "../services/promoLimits.js";
import { switchOn, UPGRADES_KEY, SALES_KEY, salesClosedMessage } from "../services/liveSwitches.js";
import { effectiveTypes, isSpeakerPass } from "../services/teamRoles.js";

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

/* =========================================================
   📱 NATIVE APP RETURN
   =========================================================
   The iOS app opens Stripe Checkout in an in-app browser. Stripe can only
   redirect to http(s), so for `client: "ios"` we send the buyer to a tiny
   page on this API that immediately opens the app's URL scheme
   (ttfc://checkout-complete?...) and shows a "Return to the app" link as
   a fallback. The app reopens, re-reads /auth/me and finds the new ticket.
========================================================= */
const APP_SCHEME = process.env.APP_URL_SCHEME || "ttfc";

function apiBase(req) {
  if (process.env.API_URL) return String(process.env.API_URL).replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

export function appReturnUrls(req, { tier }) {
  const base = `${apiBase(req)}/api/payments/app-return`;
  const q = (s) => `status=${s}&tier=${encodeURIComponent(tier)}`;
  return {
    success_url: `${base}?${q("success")}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}?${q("cancel")}`,
  };
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function appReturnHtml({ status, tier, sessionId }) {
  const ok = status === "success";
  const deep = `${APP_SCHEME}://checkout-complete?status=${encodeURIComponent(ok ? "success" : "cancel")}&tier=${encodeURIComponent(tier || "")}${sessionId ? `&session_id=${encodeURIComponent(sessionId)}` : ""}`;
  const title = ok ? "Payment received" : "Checkout cancelled";
  const body = ok
    ? "Your pass is being issued. Head back to The Tech Festival app — it refreshes automatically."
    : "No payment was taken. You can go back to the app and try again any time.";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · TTFC 2026</title>
<style>body{margin:0;background:#08040F;color:#fff;font-family:-apple-system,system-ui,Helvetica,Arial,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px}
h1{font-size:22px;margin:0 0 10px}p{color:rgba(255,255,255,.75);line-height:1.5;max-width:420px;margin:0 auto 22px}
a.btn{display:inline-block;background:#7A3FD1;color:#fff;text-decoration:none;padding:14px 22px;font-weight:700;letter-spacing:.5px}</style></head>
<body><div><h1>${title}</h1><p>${body}</p><a class="btn" href="${escapeHtml(deep)}">Return to the app</a></div>
<script>setTimeout(function(){window.location.href=${JSON.stringify(deep)};},250);</script></body></html>`;
}

router.get("/app-return", (req, res) => {
  const { status = "success", tier = "", session_id: sessionId = "" } = req.query;
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(appReturnHtml({ status: String(status), tier: String(tier), sessionId: String(sessionId) }));
});

/* Keys the server sets on a checkout's metadata and the webhook trusts (who the ticket belongs to,
   what was bought, the price, an upgrade's ticket). Never taken from the buyer's browser: a guest
   sending their own `userId` would otherwise put a paid ticket on someone else's account. */
export const RESERVED_METADATA = Object.freeze([
  "userId", "client", "type", "tier", "basePrice", "taxMode", "taxPercent", "promoCode", "discount",
  "upgradeFrom", "fromTier",
]);

/** Stripe metadata values must be strings and are capped at 500 chars. Reserved keys are dropped. */
export function cleanMetadata(obj) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    if (RESERVED_METADATA.includes(k)) continue;
    if (v === undefined || v === null || v === "") continue;
    const value = Array.isArray(v) ? v.join("; ") : String(v);
    out[String(k).slice(0, 40)] = value.slice(0, 500);
  }
  return out;
}

// ================= PASS UPGRADES =================
// An upgrade charges only the difference between the two passes' list
// prices (plus HST) and keeps the same ticketId, so the QR still works.
//
// Oct 19 2026, the organiser: "Don't offer upgrades to Apex for anyone who is marked as
// speakers. In fact, don't offer upgrades at all." So upgrades are refused unless staff turn
// on Admin › App text & switches › Pass upgrades (flag.upgrades, default off), and a Speaker
// Pass (tier "speaker", or promo SPEAKER) or anyone of the speaker type never upgrades,
// even with it on. An upgrade already paid is still finished by the webhook.
export const UPGRADES_OFF = Object.freeze({ status: 403, code: "upgrades_off", error: "Pass upgrades aren't available." });
export const SPEAKER_NO_UPGRADE = Object.freeze({ status: 403, code: "speaker_pass", error: "Speakers' passes can't be upgraded." });

/** Pure: whether this ticket of this account is a speaker's (never upgraded): a Speaker Pass (tier "speaker",
    or promo SPEAKER: isSpeakerPass) or anyone of the speaker type. Exported for tests. */
export function isSpeakersPass(buyer, ticket) {
  const user = typeof buyer?.toObject === "function" ? buyer.toObject() : buyer;
  const tier = String(ticket?.type || ticket?.ticketType || "").trim().toLowerCase();
  return tier === "speaker" || isSpeakerPass(ticket) || effectiveTypes(user).includes("speaker");
}

/** The JSON body of a refused upgrade: { code?, error }. */
const refusal = (r) => ({ ...(r.code ? { code: r.code } : {}), error: r.error });

/** Pure: price difference in CAD, or an error. Exported for tests. */
export function upgradeQuote(fromPrice, toPrice) {
  const from = Number(fromPrice) || 0;
  const to = Number(toPrice) || 0;
  if (!to) return { error: "That pass isn't on sale yet." };
  const difference = Math.round((to - from) * 100) / 100;
  if (difference <= 0) return { error: "You already have this pass or a higher one." };
  const hst = TAX_MODE === "manual" ? Math.round(difference * HST_PERCENT) / 100 : 0;
  return { difference, hst, total: Math.round((difference + hst) * 100) / 100 };
}

async function resolveUpgrade(buyer, ticketId, toTier) {
  if (!(await switchOn(UPGRADES_KEY))) return UPGRADES_OFF;
  if (!buyer) return { status: 401, error: "Sign in to upgrade your pass." };
  const ticket = (buyer.tickets || []).find((t) => t.ticketId === String(ticketId || "").trim());
  if (!ticket) return { status: 404, error: "That ticket isn't on your account." };
  // A Speaker Pass (the internal fifth pass), or anyone who's a speaker, is never upgraded.
  if (isSpeakersPass(buyer, ticket)) return SPEAKER_NO_UPGRADE;
  if (ticket.checkedIn) return { status: 409, error: "This pass has already been used at the door; upgrade at the registration desk." };
  await applyDuePrices();
  const [from, to] = await Promise.all([
    TicketInventory.findOne({ tier: ticket.type }).lean(),
    TicketInventory.findOne({ tier: toTier }).lean(),
  ]);
  if (!to) return { status: 404, error: "Tier not found" };
  if (to.archived) return { status: 409, error: "This pass is no longer on sale." };
  if (to.total > 0 && to.sold >= to.total) return { status: 409, error: "This tier is sold out." };
  // priceAt: today's price even if a scheduled change hasn't been written in yet
  const fromPrice = from ? priceAt(from) : 0, toPrice = priceAt(to);
  const q = upgradeQuote(fromPrice, toPrice);
  if (q.error) return { status: 409, error: q.error };
  return { ticket, fromTier: ticket.type, toTier, fromPrice: fromPrice || 0, toPrice, ...q };
}

// GET /api/payments/upgrade-quote?ticketId=…&tier=…
router.get("/upgrade-quote", async (req, res) => {
  let buyer = null;
  try { buyer = await getUserFromReq(req); } catch { buyer = null; }
  const r = await resolveUpgrade(buyer, req.query.ticketId, String(req.query.tier || ""));
  if (r.error) return res.status(r.status).json(refusal(r));
  const { ticket, ...quote } = r;
  res.json({ ticketId: ticket.ticketId, hstPercent: TAX_MODE === "manual" ? HST_PERCENT : 0, ...quote });
});

// ================= CREATE CHECKOUT =================
// NOTE: server.js mounts this at /api/payments, so the path here is just /create-checkout
// Frontend calls: POST /api/payments/create-checkout
router.post("/create-checkout", async (req, res) => {
  let releasePromo = () => {};   // see the usage-limit check below
  try {
    const { type, tier, promoCode, metadata, client } = req.body;

    // Logged-in buyer (website or app): attach the ticket to their account.
    // The webhook only links a ticket to a User when metadata.userId is set,
    // so without this every purchase became a guest Attendee record.
    let buyer = null;
    if (req.headers.authorization) {
      try { buyer = await getUserFromReq(req); } catch { buyer = null; }
    }
    const isNativeApp = client === "ios" || client === "android";

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

    // ----- Upgrade: charge the difference only -----
    if (req.body?.upgradeFrom) {
      const up = await resolveUpgrade(buyer, req.body.upgradeFrom, tier);
      if (up.error) return res.status(up.status).json(refusal(up));
      const stripe = getStripe();
      const { lineItemExtras, sessionExtras } = await buildTaxConfig(stripe);
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: buyer.email,
        line_items: [{
          price_data: {
            currency: "cad",
            product_data: {
              name: `Upgrade: ${productNameFor(up.fromTier)} → ${productNameFor(tier)}`,
              description: `Ticket ${up.ticket.ticketId} · you pay the difference`,
              tax_code: "txcd_10000000",
            },
            unit_amount: Math.round(up.difference * 100),
            tax_behavior: "exclusive",
          },
          quantity: 1,
          ...lineItemExtras,
        }],
        ...sessionExtras,
        ...(isNativeApp
          ? appReturnUrls(req, { tier })
          : {
              success_url: `${process.env.FRONTEND_URL}/tickets?success=true&tier=${encodeURIComponent(tier)}&value=${up.total}&session_id={CHECKOUT_SESSION_ID}`,
              cancel_url: `${process.env.FRONTEND_URL}/tickets`,
            }),
        metadata: {
          userId: String(buyer._id),
          client: isNativeApp ? client : "web",
          type: "upgrade",
          tier,
          fromTier: up.fromTier,
          upgradeFrom: up.ticket.ticketId,
          basePrice: String(up.difference),
          taxMode: TAX_MODE,
          taxPercent: String(HST_PERCENT),
        },
      });
      return res.json({ url: session.url, difference: up.difference, total: up.total });
    }

    await applyDuePrices();
    const inventoryItem = await TicketInventory.findOne({ tier });
    if (!inventoryItem) return res.status(404).json({ error: "Tier not found" });
    if (inventoryItem.archived) return res.status(409).json({ error: "This pass is no longer on sale." });

    const basePriceCAD = priceAt(inventoryItem);   // never the old price once a scheduled change is due
    const isBooth = String(tier).startsWith("booth-");

    // Ticket sales off in Admin (site.ticket_sales_open; TTFC 2026 over, Oct 27 2026): the website and the web app
    // already hide the buy buttons, the native apps don't read the switch, so passes are refused here, with Admin's
    // message. Booths are unaffected.
    if (!isBooth && !(await switchOn(SALES_KEY))) {
      return res.status(409).json({ error: await salesClosedMessage(), code: "sales_closed" });
    }

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

      if (promo && !promoExpired(promo)) {
        // Per-tier scoping: empty tiers array = valid for all passes AND booths
        const tiersOk = !Array.isArray(promo.tiers) || promo.tiers.length === 0
          || promo.tiers.includes(String(tier).toLowerCase());

        if (tiersOk) {
          appliedDiscount = promo.discount;
          appliedPromo = promo;
        }
      }
      // If invalid, expired or wrong-tier, silently ignore — frontend already showed an error to user.
    }

    // ===== PROMO USAGE LIMIT =====
    // Paid uses + checkouts in progress must stay under maxUses
    // (services/promoLimits.js). Checkouts for the same capped code are
    // created one at a time, so the last place can't be taken twice.
    if (appliedPromo?.maxUses) {
      releasePromo = await lockPromo(appliedPromo.code);
      let usage;
      try { usage = await promoUsageNow(stripe, appliedPromo.code); }
      catch (e) {
        console.error("Promo usage check failed:", e.message);
        return res.status(503).json({ error: "We couldn't check this code right now. Please try again in a minute." });
      }
      if (isFull(usage.total, appliedPromo.maxUses)) return res.status(409).json({ error: LIMIT_REACHED });
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
    const buyerEmail = buyer?.email || metadata?.email || metadata?.contactEmail || undefined;

    // ===== META PIXEL: expected charged total for the success_url =====
    // Stripe applies the coupon first, then HST on the discounted subtotal —
    // mirroring that order here gives the exact charged total in "manual"
    // tax mode (the default). The frontend's trackMetaPurchase() reads ?tier=,
    // ?value= and ?session_id= from the return URL and prefers them over the
    // browser-saved estimate, so no frontend change is needed.
    const discountedCents = Math.round(basePriceCAD * 100 * (1 - appliedDiscount / 100));
    const totalCents =
      TAX_MODE === "manual"
        ? discountedCents + Math.round((discountedCents * HST_PERCENT) / 100)
        : discountedCents; // "automatic"/"none": tax unknown or zero at this point
    const totalCAD = (totalCents / 100).toFixed(2);
    const successParams =
      `success=true&tier=${encodeURIComponent(tier)}&value=${totalCAD}&session_id={CHECKOUT_SESSION_ID}`;

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
      // A capped code holds a place while the buyer pays; expire it soon so
      // an abandoned checkout gives the place back.
      ...(appliedPromo?.maxUses ? { expires_at: Math.floor(Date.now() / 1000) + HOLD_MINUTES * 60 } : {}),
      ...sessionExtras,
      ...(isNativeApp
        ? appReturnUrls(req, { tier })
        : {
            success_url: isBooth
              ? `${process.env.FRONTEND_URL}/exhibit?${successParams}`
              : `${process.env.FRONTEND_URL}/tickets?${successParams}`,
            cancel_url: isBooth
              ? `${process.env.FRONTEND_URL}/exhibit`
              : `${process.env.FRONTEND_URL}/tickets`,
          }),
      metadata: {
        ...attendee,
        ...(buyer ? { userId: String(buyer._id) } : {}),
        client: isNativeApp ? client : "web",
        type: isBooth ? "booth" : "ticket",
        tier,
        basePrice: String(basePriceCAD),
        taxMode: TAX_MODE,
        taxPercent: String(HST_PERCENT),
        promoCode: appliedPromo ? appliedPromo.code : "",
        discount: String(appliedDiscount),
      },
    });

    // Promo uses are counted by the webhook once the payment completes.

    res.json({ url: session.url });
  } catch (err) {
    console.error("Checkout error:", err);
    res.status(500).json({ error: err.message || "Checkout failed" });
  } finally {
    releasePromo();
  }
});

export default router;
