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
// middleware to get user from token
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
router.post("/create-checkout", async (req, res) => {
  try {
    const { tier, type = "ticket", price, promoCode } = req.body;
    const normalizedTier = tier.toLowerCase();
    const isBooth = type === "booth";
    
    // For booths, use price from frontend; for tickets, use from DB
    let ticketPrice = price;
    if (!ticketPrice || ticketPrice === 0) {
      const ticket = await TicketInventory.findOne({ tier: normalizedTier });
      if (!ticket) {
        return res.status(400).json({ error: "Invalid ticket tier" });
      }
      ticketPrice = ticket.price;
    }

    const stripe = getStripe();

    // ===== PROMO CODE HANDLING (tickets only) =====
    let appliedDiscount = 0;
    let appliedPromo = null;

    if (promoCode && !isBooth) {
      const code = String(promoCode).trim().toUpperCase();
      const promo = await Promo.findOne({ code, active: true });
      if (promo) {
        appliedDiscount = promo.discount;
        appliedPromo = promo;
      }
    }

    let discountsArg = undefined;
    if (appliedDiscount > 0) {
      const coupon = await stripe.coupons.create({
        percent_off: appliedDiscount,
        duration: "once",
        name: `${appliedPromo.code} (${appliedDiscount}% off)`,
      });
      discountsArg = [{ coupon: coupon.id }];
    }
    // check if user is logged in
    let userId = null;
    const authHeader = req.headers.authorization;
    if (authHeader) {
      try {
        const token = authHeader.split(" ")[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        userId = decoded.id;
      } catch {
        userId = null;
      }
    }
    
    const boothNames = {
      "booth-single": "Single Booth (10ft x 10ft)",
      "booth-double": "Double Booth (20ft x 10ft)",
      "booth-triple": "Triple Booth (30ft x 10ft)",
      "booth-quadruple": "Quadruple Booth (40ft x 10ft)"
    };
    const productName = isBooth 
      ? (boothNames[normalizedTier] || `TechFest ${normalizedTier.replace('booth-', '').replace('-', ' ').toUpperCase()} Booth`)
      : `TechFest ${tier.toUpperCase()} Pass`;
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_creation: "always",
      automatic_tax: { enabled: true },
      billing_address_collection: "required",
      line_items: [
        {
          price_data: {
            currency: "cad",
            product_data: {
              name: productName,
            },
            unit_amount: ticketPrice * 100,
          },
          quantity: 1,
        },
      ],
      discounts: discountsArg,
      success_url: isBooth 
        ? `${process.env.FRONTEND_URL}/exhibit?success=true`
        : `${process.env.FRONTEND_URL}/tickets?success=true`,
      cancel_url: isBooth 
        ? `${process.env.FRONTEND_URL}/exhibit`
        : `${process.env.FRONTEND_URL}/tickets`,
      metadata: {
        tier: normalizedTier,
        userId: userId || "guest",
        type: type,
        promoCode: appliedPromo ? appliedPromo.code : "",
        discount: String(appliedDiscount),
      }
    });

    if (appliedPromo) {
      await Promo.updateOne({ _id: appliedPromo._id }, { $inc: { timesUsed: 1 } });
    }

    res.json({ url: session.url });
  } catch (err) {
    console.error("CHECKOUT ERROR:", err);
    res.status(500).json({ error: "Checkout failed" });
  }
});
export default router;
