import mongoose from "mongoose";

/* One TTFC event (a city briefing or the main event): the operational half of
   the event spine. The Sanity `event` document is the public face (name,
   dates, venue, hero media); this record is what the server works from —
   feature switches and the attendee-visibility policy below. Keyed by
   `eventKey`, the same string the Sanity event carries and that Attendee,
   Rsvp and the passes inside User store.

   attendeeVisibility — what this event exposes about its own attendees, and
   to whom (enforced server-side by the directory endpoints, Phase 2):
     mode       hidden (nothing) | count (numbers only) | names | profiles
     audience   public | own-event (its own attendees) | all-events (any
                event's attendees) | staff-only
     sharedWith eventKeys this event is additionally shared with, on top of
                the audience rule (Admin's cross-event matrix writes here).
   The defaults are closed (hidden + staff-only): a new event exposes nothing
   until staff open it. The one exception is in the data, not the code: the
   2026 record the backfill creates (scripts/backfill-eventkey.js) carries
   profiles + own-event, because 2026 attendees already see each other in
   the app today. */
const attendeeVisibilitySchema = new mongoose.Schema(
  {
    mode: {
      type: String,
      enum: ["hidden", "count", "names", "profiles"],
      default: "hidden"
    },
    audience: {
      type: String,
      enum: ["public", "own-event", "all-events", "staff-only"],
      default: "staff-only"
    },
    sharedWith: { type: [String], default: [] }
  },
  { _id: false }
);

const eventConfigSchema = new mongoose.Schema(
  {
    eventKey: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    name: { type: String },
    city: { type: String },
    type: {
      type: String,
      enum: ["briefing", "main-event"]
    },
    year: { type: Number },
    startDate: { type: Date },
    endDate: { type: Date },
    status: {
      type: String,
      enum: ["draft", "announced", "live", "past"],
      default: "draft"
    },
    attendeeVisibility: {
      type: attendeeVisibilitySchema,
      default: () => ({})
    },
    settings: {
      // Days after endDate the event still counts as "just ended" (full
      // programme stays up, tickets off) before it becomes a past event.
      lifecycleGraceDays: { type: Number, default: 7 },
      // Pricing stays "to be announced" until staff announce it: while this
      // is false, no prices for the event are shown anywhere.
      pricingAnnounced: { type: Boolean, default: false },
      // The event's automatic quantity discount (Nov 2026; management only,
      // Admin › Events): an order of at least minQuantity tickets gets
      // percent off, no code needed (services/pricingEngine.js priceBasket).
      quantityDiscount: {
        enabled: { type: Boolean, default: false },
        minQuantity: { type: Number, min: 2, max: 100, default: 5 },
        percent: { type: Number, min: 0, max: 100, default: 0 }
      }
    }
  },
  {
    timestamps: true
  }
);

export default mongoose.models.EventConfig || mongoose.model("EventConfig", eventConfigSchema);
