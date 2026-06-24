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

// ================= CREATE CHECKOUT =================
// NOTE: server.js mounts this at /api/payments, so the path here is just /create-checkout
// Frontend calls: POST /api/payments/create-checkout
router.post("/create-checkout", async (req, res) => {
  try {
    const { tier, promoCode } = req.body;

    if (!tier) return res.status(400).json({ error: "Tier required" });

    const inventoryItem = await TicketInventory.findOne({ tier });
    if (!inventoryItem) return res.status(404).json({ error: "Tier not found" });

    const basePriceCAD = inventoryItem.price;

    const stripe = getStripe();

    // ===== PROMO CODE HANDLING (with tier check) =====
    let appliedDiscount = 0;
    let appliedPromo = null;

    if (promoCode) {
      const code = String(promoCode).trim().toUpperCase();
      const promo = await Promo.findOne({ code, active: true });

      if (promo) {
        // Per-tier scoping: empty tiers array = valid for all passes
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

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "cad",
          product_data: { name: `TTFC ${tier} Pass` },
          unit_amount: Math.round(basePriceCAD * 100),
        },
        quantity: 1,
      }],
      discounts: discountsArg,
      success_url: `${process.env.FRONTEND_URL}/tickets?success=true`,
      cancel_url: `${process.env.FRONTEND_URL}/tickets`,
      metadata: {
        tier,
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
