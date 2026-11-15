import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import Attendee from "../models/Attendee.js";
import EventConfig from "../models/EventConfig.js";
import Order from "../models/Order.js";
import TicketType from "../models/TicketType.js";
import User from "../models/User.js";
import { priceOrder } from "../services/pricingEngine.js";
import { resolveOrderPromo } from "../services/orderPromo.js";
import { fulfilOrder } from "../services/orderFulfilment.js";
import { getStripe, buildTaxConfig } from "../services/stripeCheckout.js";
import {
  HOLD_MINUTES,
  LIMIT_REACHED,
  isFull,
  lockPromo,
  promoUsageNow
} from "../services/promoLimits.js";
import { appReturnUrls } from "./payments.js";

const router = express.Router();

/* =========================================================
   POST /api/orders/multi-checkout — one booker buys N
   tickets for N named attendees in one session (plan §9.2).

   The additive sibling of POST /api/payments/create-checkout
   (which is untouched): the buyer sends ticket types,
   quantities and EVERY attendee's details; the server
   recomputes the price with services/pricingEngine.js
   (client totals are never trusted), writes an Order
   (models/Order.js, status "pending"), and opens a Stripe
   Checkout session carrying the order's id in its metadata.
   The webhook fulfils the order from that metadata
   (routes/webhook.js → services/orderFulfilment.js): one
   pass + ticket email per attendee, one invoice email to
   the booker. An order that prices to $0 (a $0 ticket type
   or a 100%-off code) skips Stripe and is fulfilled at once.
========================================================= */

// The buyer, when signed in (same pattern as routes/payments.js).
async function getUserFromReq(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) throw new Error("No token");
  const token = authHeader.split(" ")[1];
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  const user = await User.findById(decoded.id);
  if (!user) throw new Error("User not found");
  return user;
}

const EMAIL_RE = /\S+@\S+\.\S+/;
const MAX_TICKETS = 100;

/** The order's lines from the request: `items` (a list), or the
    single-type shorthand `ticketTypeId` + `quantity`. */
function normalizeItems(body) {
  if (Array.isArray(body.items) && body.items.length > 0) {
    return body.items.map((i) => ({
      ticketTypeId: String(i?.ticketTypeId || ""),
      quantity: Math.floor(Number(i?.quantity) || 0)
    }));
  }
  if (body.ticketTypeId) {
    return [
      {
        ticketTypeId: String(body.ticketTypeId),
        quantity: Math.floor(Number(body.quantity) || 0)
      }
    ];
  }
  return [];
}

/** Passes already issued for this type + tickets held by live orders
    (paid/fulfilled, plus pending orders from the last 24 h — a Stripe
    session lives at most that long, so older pendings are abandoned). */
async function soldOrReserved(eventKey, ticketType) {
  const issued = await Attendee.countDocuments({
    eventKey,
    ticketType: ticketType.slug
  });
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await Order.aggregate([
    {
      $match: {
        eventKey,
        $or: [
          { status: { $in: ["paid", "fulfilled"] } },
          { status: "pending", createdAt: { $gte: dayAgo } }
        ]
      }
    },
    { $unwind: "$items" },
    { $match: { "items.ticketTypeId": ticketType._id } },
    { $group: { _id: null, n: { $sum: "$items.quantity" } } }
  ]);
  return issued + (rows[0]?.n || 0);
}

router.post("/multi-checkout", async (req, res) => {
  let releasePromo = () => {}; // see the usage-limit check below
  try {
    const body = req.body || {};
    const eventKey = typeof body.eventKey === "string" ? body.eventKey.trim() : "";
    if (!eventKey) return res.status(400).json({ error: "eventKey is required" });

    // ---- Booker (the invoice goes to this person, and only them) ----
    let buyer = null;
    if (req.headers.authorization) {
      try { buyer = await getUserFromReq(req); } catch { buyer = null; }
    }
    const bookerEmail = String(body.booker?.email || buyer?.email || "")
      .trim()
      .toLowerCase();
    const bookerName = String(body.booker?.name || buyer?.name || "").trim();
    if (!EMAIL_RE.test(bookerEmail)) {
      return res.status(400).json({ error: "A valid booker email is required" });
    }

    // ---- Pricing gate: nothing sells while pricing is "to be announced" ----
    const event = await EventConfig.findOne({ eventKey }).lean();
    if (event && event.settings?.pricingAnnounced !== true) {
      return res.status(409).json({
        error: "Pricing for this event hasn't been announced yet.",
        announced: false
      });
    }

    // ---- Items ----
    const items = normalizeItems(body);
    if (!items.length) return res.status(400).json({ error: "No tickets in this order" });
    const totalQuantity = items.reduce((sum, i) => sum + i.quantity, 0);
    if (items.some((i) => i.quantity < 1) || totalQuantity > MAX_TICKETS) {
      return res.status(400).json({ error: `Each line needs at least 1 ticket, and an order is at most ${MAX_TICKETS} tickets` });
    }
    if (items.some((i) => !mongoose.isValidObjectId(i.ticketTypeId))) {
      return res.status(404).json({ error: "Ticket type not found" });
    }

    const typeIds = [...new Set(items.map((i) => i.ticketTypeId))];
    const types = await TicketType.find({
      _id: { $in: typeIds },
      eventKey,
      active: true
    });
    if (types.length !== typeIds.length) {
      return res.status(404).json({ error: "Ticket type not found" });
    }
    const typeOf = new Map(types.map((t) => [String(t._id), t]));

    const currencies = new Set(types.map((t) => (t.currency || "CAD").toUpperCase()));
    if (currencies.size > 1) {
      return res.status(400).json({ error: "All tickets in one order must be the same currency" });
    }

    // ---- Sales window + capacity ----
    const now = new Date();
    for (const item of items) {
      const type = typeOf.get(item.ticketTypeId);
      if (type.salesStart && now < type.salesStart) {
        return res.status(409).json({ error: `${type.name} isn't on sale yet.` });
      }
      if (type.salesEnd && now > type.salesEnd) {
        return res.status(409).json({ error: `${type.name} is no longer on sale.` });
      }
      if (type.capacity !== undefined && type.capacity !== null) {
        const taken = await soldOrReserved(eventKey, type);
        if (taken + item.quantity > type.capacity) {
          return res.status(409).json({ error: `${type.name} is sold out.` });
        }
      }
    }

    // ---- Attendees: one named person per ticket, no exceptions ----
    const attendeesIn = Array.isArray(body.attendees) ? body.attendees : [];
    if (attendeesIn.length !== totalQuantity) {
      return res.status(400).json({
        error: `Details are needed for every attendee: ${totalQuantity} ticket(s), ${attendeesIn.length} attendee(s) given`
      });
    }
    const perType = new Map();
    const attendees = [];
    for (const a of attendeesIn) {
      const firstName = String(a?.firstName || "").trim();
      const lastName = String(a?.lastName || "").trim();
      const email = String(a?.email || "").trim().toLowerCase();
      const ticketTypeId = String(a?.ticketTypeId || "");
      if (!firstName || !lastName || !EMAIL_RE.test(email)) {
        return res.status(400).json({ error: "Every attendee needs a first name, last name and valid email" });
      }
      if (!typeOf.has(ticketTypeId)) {
        return res.status(400).json({ error: "An attendee's ticket type isn't part of this order" });
      }
      perType.set(ticketTypeId, (perType.get(ticketTypeId) || 0) + 1);
      attendees.push({
        firstName,
        lastName,
        email,
        ...(a?.title ? { title: String(a.title).trim() } : {}),
        ...(a?.company ? { company: String(a.company).trim() } : {}),
        ticketTypeId
      });
    }
    for (const item of items) {
      if ((perType.get(item.ticketTypeId) || 0) !== item.quantity) {
        return res.status(400).json({
          error: "Attendee details don't match the ticket quantities"
        });
      }
    }

    // ---- Price: recomputed here, never taken from the client ----
    const { promo, code, invalid } = await resolveOrderPromo(body.promoCode, types);
    if (body.promoCode && invalid) {
      return res.status(400).json({ error: "That promo code isn't valid for these tickets" });
    }

    let amounts = {
      subtotalCents: 0,
      bogoDiscountCents: 0,
      groupDiscountCents: 0,
      codeDiscountCents: 0,
      totalCents: 0,
      currency: [...currencies][0] || "CAD"
    };
    const orderItems = [];
    for (const item of items) {
      const type = typeOf.get(item.ticketTypeId);
      const priced = priceOrder({ ticketType: type, quantity: item.quantity, promo });
      amounts.subtotalCents += priced.subtotalCents;
      amounts.bogoDiscountCents += priced.bogoDiscountCents;
      amounts.groupDiscountCents += priced.groupDiscountCents;
      amounts.codeDiscountCents += priced.codeDiscountCents;
      amounts.totalCents += priced.totalCents;
      orderItems.push({
        ticketTypeId: type._id,
        name: type.name,
        slug: type.slug,
        unitPriceCents: type.priceCents,
        quantity: item.quantity,
        totalCents: priced.totalCents // per-line total after this line's discounts (not stored; used below)
      });
    }

    // ---- Promo usage limit (mirrors routes/payments.js) ----
    // Paid uses + checkouts in progress must stay under maxUses; checkouts
    // for the same capped code are created one at a time.
    const stripe = amounts.totalCents > 0 || promo?.maxUses ? getStripe() : null;
    if (promo?.maxUses) {
      releasePromo = await lockPromo(promo.code);
      let usage;
      try {
        usage = await promoUsageNow(stripe, promo.code);
      } catch (e) {
        console.error("Promo usage check failed:", e.message);
        return res.status(503).json({ error: "We couldn't check this code right now. Please try again in a minute." });
      }
      if (isFull(usage.total, promo.maxUses)) {
        return res.status(409).json({ error: LIMIT_REACHED });
      }
    }

    // ---- The order, written before payment ----
    const order = await Order.create({
      booker: {
        name: bookerName,
        email: bookerEmail,
        ...(buyer ? { userId: buyer._id } : {})
      },
      eventKey,
      items: orderItems.map(({ totalCents, ...rest }) => rest),
      attendees,
      amounts,
      promoCode: promo ? code : "",
      status: "pending"
    });

    // ---- $0 orders: no payment to take, fulfil now ----
    if (amounts.totalCents === 0) {
      await fulfilOrder(order, null);
      return res.json({ url: null, orderId: String(order._id), free: true });
    }

    // ---- Stripe Checkout (the payments.js shape) ----
    const { lineItemExtras, sessionExtras } = await buildTaxConfig(stripe);
    const isNativeApp = body.client === "ios" || body.client === "android";
    const firstType = typeOf.get(items[0].ticketTypeId);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: bookerEmail,
      line_items: orderItems.map((item) => ({
        price_data: {
          currency: (amounts.currency || "CAD").toLowerCase(),
          product_data: {
            name: `${item.name} × ${item.quantity}`,
            description: `TTFC · ${eventKey} · multi-attendee order`,
            // General tax code; used when TAX_MODE="automatic".
            tax_code: "txcd_10000000"
          },
          // The line's total after its discounts, as a single unit —
          // BOGO/group/code savings are already in this number.
          unit_amount: item.totalCents,
          tax_behavior: "exclusive" // HST is added on top of this amount
        },
        quantity: 1,
        ...lineItemExtras
      })),
      // A capped code holds a place while the buyer pays (payments.js).
      ...(promo?.maxUses
        ? { expires_at: Math.floor(Date.now() / 1000) + HOLD_MINUTES * 60 }
        : {}),
      ...sessionExtras,
      ...(isNativeApp
        ? appReturnUrls(req, { tier: firstType.slug })
        : {
            success_url: `${process.env.FRONTEND_URL}/tickets?success=true&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.FRONTEND_URL}/tickets`
          }),
      metadata: {
        // The webhook fulfils from orderId — a key the single-ticket
        // checkout never sets, so the two flows can't see each other.
        orderId: String(order._id),
        type: "multi-ticket",
        eventKey,
        promoCode: promo ? code : ""
      }
    });

    order.stripeSessionId = session.id;
    await order.save();

    res.json({ url: session.url, orderId: String(order._id) });
  } catch (err) {
    console.error("Multi-checkout error:", err);
    res.status(500).json({ error: err.message || "Checkout failed" });
  } finally {
    releasePromo();
  }
});

export default router;
