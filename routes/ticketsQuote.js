import express from "express";
import mongoose from "mongoose";
import EventConfig from "../models/EventConfig.js";
import TicketType from "../models/TicketType.js";
import { priceOrder } from "../services/pricingEngine.js";
import { resolveOrderPromo } from "../services/orderPromo.js";

const router = express.Router();

/* POST /api/tickets/quote — the price of a ticket order before payment
   (plan §9.4): the full breakdown from services/pricingEngine.js, so the
   buyer sees exactly what each rule saved. Public and read-only.

   Pricing never leaks for an event whose pricing is still "to be
   announced": when the event's EventConfig exists and its
   pricingAnnounced switch is not on, the whole answer is
   { announced: false } — no prices, no inclusions, nothing. (An event
   with no EventConfig row yet has no switch to honour and is quoted
   normally.) Amounts are integer cents before HST — Stripe adds HST on
   top at checkout, as in the single-ticket flow (routes/payments.js). */
router.post("/quote", async (req, res) => {
  try {
    const body = req.body || {};
    const eventKey = typeof body.eventKey === "string" ? body.eventKey.trim() : "";
    const ticketTypeId = typeof body.ticketTypeId === "string" ? body.ticketTypeId.trim() : "";
    const quantity = Math.floor(Number(body.quantity) || 0);

    if (!eventKey || !ticketTypeId) {
      return res.status(400).json({ error: "eventKey and ticketTypeId are required" });
    }
    if (!mongoose.isValidObjectId(ticketTypeId)) {
      return res.status(404).json({ error: "Ticket type not found" });
    }
    if (quantity < 1 || quantity > 100) {
      return res.status(400).json({ error: "quantity must be a whole number between 1 and 100" });
    }

    const event = await EventConfig.findOne({ eventKey }).lean();
    if (event && event.settings?.pricingAnnounced !== true) {
      return res.json({ announced: false });
    }

    const ticketType = await TicketType.findOne({
      _id: ticketTypeId,
      eventKey,
      active: true
    });
    if (!ticketType) return res.status(404).json({ error: "Ticket type not found" });

    const { promo, code, invalid } = await resolveOrderPromo(body.promoCode, ticketType);
    const quote = priceOrder({ ticketType, quantity, promo });

    res.json({
      announced: true,
      eventKey,
      ticketType: {
        id: String(ticketType._id),
        name: ticketType.name,
        slug: ticketType.slug,
        inclusions: ticketType.inclusions,
        exclusions: ticketType.exclusions
      },
      currency: ticketType.currency || "CAD",
      promoCode: promo ? code : undefined,
      promoApplied: Boolean(promo),
      ...(invalid ? { promoInvalid: true } : {}),
      ...quote,
      taxNote: "HST is added on top at checkout."
    });
  } catch (err) {
    console.error("POST tickets quote error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* GET /api/tickets/types?eventKey=... — the event's ticket types for the
   public ticket page (the sibling of POST /quote above, same router, same
   pricingAnnounced gate). Public and read-only.

   While the event's pricing is still "to be announced" (its EventConfig
   exists and the switch is not on), the answer is
   { announced: false, types: [] } — no prices, no tier names, nothing.
   An event with no EventConfig row yet has no switch to honour and is
   listed normally, exactly as /quote treats it. Only ACTIVE types are
   listed, in staff's sortOrder; sales windows are exposed as fields (the
   page greys types out) rather than used to hide types, matching /quote
   and checkout, which only enforce windows at purchase time.

   No per-type soldOut flag: the capacity count (issued passes + live
   orders) exists only as a private helper inside routes/orders.js —
   there is no shared service to reuse, and checkout enforces capacity
   itself (409) regardless of what this list shows. */
router.get("/types", async (req, res) => {
  try {
    const eventKey = typeof req.query.eventKey === "string" ? req.query.eventKey.trim() : "";
    if (!eventKey) {
      return res.status(400).json({ error: "eventKey is required" });
    }

    const event = await EventConfig.findOne({ eventKey }).lean();
    if (event && event.settings?.pricingAnnounced !== true) {
      return res.json({ announced: false, types: [] });
    }

    const types = await TicketType.find({ eventKey, active: true })
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();

    res.json({
      announced: true,
      eventKey,
      types: types.map((t) => ({
        id: String(t._id),
        name: t.name,
        slug: t.slug,
        description: t.description || "",
        inclusions: t.inclusions || [],
        exclusions: t.exclusions || [],
        priceCents: t.priceCents,
        currency: t.currency || "CAD",
        capacity: t.capacity ?? null,
        salesStart: t.salesStart ? new Date(t.salesStart).toISOString() : null,
        salesEnd: t.salesEnd ? new Date(t.salesEnd).toISOString() : null
      }))
    });
  } catch (err) {
    console.error("GET tickets types error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
