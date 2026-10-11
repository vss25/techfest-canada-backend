import mongoose from "mongoose";

/* One RSVP per person for TTFC 2026 (website /rsvp). Re-submitting
   updates the same row: it is keyed by a verified ticket ID, otherwise
   by the person's folded full name (`key`, see services/rsvp.js rsvpKeys).
   Bots are kept in rows of their own (spam: true) and left out of the
   admin list and headcounts. Option keys: services/rsvp.js RSVP_OPTIONS. */
const str = { type: String, default: "" };

const rsvpSchema = new mongoose.Schema({
  key: { type: String, required: true },

  // Who
  firstName: str, lastName: str, name: str,
  nameKey: str,        // "jose nunez"
  email: str,          // optional, for a confirmation
  ticketId: str,       // as given (normalised); see ticketVerified
  ticketVerified: { type: Boolean, default: false },

  // Pass: worked out by the server (ticket > speaker > what they chose)
  kind: { type: String, enum: ["ticket", "speaker", "none"], default: "none" },
  tier: { type: String, enum: ["connect", "influence", "power", "apex", "speaker", ""], default: "" },
  tierVerified: { type: Boolean, default: false },
  chosenTier: str,     // what the person picked on the form
  detectedTier: str,   // pass of the one ticket holder with their name (unverified match)

  // What they're coming to
  days: { type: [String], default: [] },     // day1, day2
  options: { type: [String], default: [] },  // lunch_d1, cxo_d2, gala, awards, meetings, lounge…
  dietary: { type: [String], default: [] },
  dietaryOther: str,
  accessibility: str,

  // Where from (no IP addresses)
  page: str, userAgent: str,
  fillMs: Number,
  submissions: { type: Number, default: 1 },

  spam: { type: Boolean, default: false },
  spamReason: str,
}, { timestamps: true });

rsvpSchema.index({ key: 1 }, { unique: true, partialFilterExpression: { spam: false } });
rsvpSchema.index({ createdAt: -1 });
rsvpSchema.index({ updatedAt: -1 });

export default mongoose.models.Rsvp || mongoose.model("Rsvp", rsvpSchema);
