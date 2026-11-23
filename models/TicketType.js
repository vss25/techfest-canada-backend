import mongoose from "mongoose";

/* One kind of ticket staff sell for one event (Admin › Ticket types): the
   data-driven ticket type for events on the event spine, replacing the
   code-defined pass tiers for new events. Inclusions and exclusions are
   DATA here (typed in Admin), not services/passExtras.js code, so a new
   event's passes need no deploy. Prices are integer cents (CAD unless
   `currency` says otherwise) and are only ever computed server-side
   (services/pricingEngine.js). Whether any of this is publicly visible is
   the event's own switch: EventConfig.settings.pricingAnnounced — the
   quote endpoint (routes/ticketsQuote.js) honours it and shows nothing
   while pricing is still "to be announced". */
const ticketTypeSchema = new mongoose.Schema(
  {
    // Which event this ticket belongs to (models/EventConfig.js).
    eventKey: {
      type: String,
      required: true,
      index: true
    },
    name: {
      type: String,
      required: true,
      trim: true
    },
    // Checkout/display slug, unique per event. Filled from the name when
    // staff don't provide one (pre-validate below). Passes issued for this
    // type carry it as Attendee.ticketType.
    slug: {
      type: String,
      trim: true,
      lowercase: true
    },
    description: { type: String, default: "" },
    // What the pass includes / does not include, one line each — shown on
    // the ticket page and in the quote exactly as staff typed them.
    inclusions: { type: [String], default: [] },
    exclusions: { type: [String], default: [] },
    priceCents: {
      type: Number,
      required: true,
      min: 0
    },
    currency: {
      type: String,
      default: "CAD",
      uppercase: true,
      trim: true
    },
    // How many may be sold in total; unset = no cap. Enforced at checkout
    // (routes/orders.js) against issued passes + live orders.
    capacity: {
      type: Number,
      min: 0
    },
    active: {
      type: Boolean,
      default: true
    },
    // Optional sales window; unset on either side = open on that side.
    salesStart: { type: Date },
    salesEnd: { type: Date },
    sortOrder: {
      type: Number,
      default: 0
    },
    // A multi-event pass (Nov 22 2026; eventKey "multi-event", services/ticketSales.js): the
    // events it gets you into, always including the Main Event. Empty on an event's own tickets.
    covers: { type: [String], default: undefined, index: true }
  },
  {
    timestamps: true
  }
);

ticketTypeSchema.index({ eventKey: 1, slug: 1 }, { unique: true });

ticketTypeSchema.pre("validate", function () {
  if (!this.slug && this.name) {
    this.slug = this.name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }
  // A pass's slug never matches an event's own ticket slug (counts are matched on slugs).
  if (this.eventKey === "multi-event" && this.slug && !this.slug.startsWith("pass-")) this.slug = `pass-${this.slug}`;
});

export default mongoose.models.TicketType || mongoose.model("TicketType", ticketTypeSchema);
