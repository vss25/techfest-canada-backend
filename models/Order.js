import mongoose from "mongoose";

/* A multi-attendee ticket order (POST /api/orders/multi-checkout,
   routes/orders.js): one booker buys N tickets for N named attendees in a
   single Stripe Checkout session. The order is written BEFORE payment
   (status "pending") with the server-computed price breakdown
   (services/pricingEngine.js — the client never sets prices); the Stripe
   webhook fulfils it (services/orderFulfilment.js): one Attendee pass per
   attendee, a ticket email to each attendee, and ONE invoice email to the
   booker. Amounts are integer cents, before HST — like the single-ticket
   checkout (routes/payments.js), HST is added on top by Stripe.

   The legacy single-ticket flow never creates Orders and never sets the
   `orderId` Checkout metadata the webhook branch keys on, so the two
   flows cannot see each other's sessions. */

const orderItemSchema = new mongoose.Schema(
  {
    ticketTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TicketType",
      required: true
    },
    // Snapshots: the ticket type may be renamed or repriced after the sale;
    // the order keeps what was actually sold, at the price it was sold at.
    name: { type: String, required: true },
    slug: { type: String },
    unitPriceCents: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    // A multi-event pass (Nov 22 2026): the events it covered when sold. Unset = this event's own ticket.
    passCovers: { type: [String], default: undefined }
  },
  { _id: false }
);

const orderAttendeeSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    title: { type: String, trim: true },
    company: { type: String, trim: true },
    ticketTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TicketType",
      required: true
    },
    // Filled at fulfilment: the pass this person was issued.
    attendeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Attendee" },
    ticketId: { type: String },
    // A multi-event pass: the pass issued for each covered event (attendeeId / ticketId = the first).
    passes: { type: [{ eventKey: String, attendeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Attendee" }, ticketId: String, _id: false }], default: undefined }
  },
  { _id: false }
);

const orderAmountsSchema = new mongoose.Schema(
  {
    subtotalCents: { type: Number, default: 0 },
    bogoDiscountCents: { type: Number, default: 0 },
    eventDiscountCents: { type: Number, default: 0 }, // the event's automatic quantity discount
    groupDiscountCents: { type: Number, default: 0 },
    codeDiscountCents: { type: Number, default: 0 },
    totalCents: { type: Number, default: 0 },
    currency: { type: String, default: "CAD" }
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    // The person who booked (and paid). The invoice goes to this email
    // only — attendees receive their tickets, never the invoice.
    booker: {
      name: { type: String, trim: true },
      email: { type: String, required: true, trim: true, lowercase: true },
      // Set when the booker was signed in at checkout.
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
    },
    // Which event the tickets are for (models/EventConfig.js).
    eventKey: {
      type: String,
      required: true,
      index: true
    },
    items: { type: [orderItemSchema], default: [] },
    attendees: { type: [orderAttendeeSchema], default: [] },
    amounts: { type: orderAmountsSchema, default: () => ({}) },
    // The promo code applied, if any ("" / unset = none).
    promoCode: { type: String, uppercase: true, trim: true },
    // Set once on fulfilment: the code's paid use has been counted
    // (Promo.timesUsed), so a webhook retry never counts it twice.
    promoCounted: { type: Boolean, default: false },
    stripeSessionId: {
      type: String,
      index: true,
      sparse: true
    },
    status: {
      type: String,
      enum: ["pending", "paid", "fulfilled", "failed"],
      default: "pending",
      index: true
    },
    fulfilledAt: { type: Date }
  },
  {
    timestamps: true
  }
);

export default mongoose.models.Order || mongoose.model("Order", orderSchema);
