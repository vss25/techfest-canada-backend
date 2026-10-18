import mongoose from "mongoose";

/* One RSVP per person for TTFC 2026 (website /rsvp), keyed by a verified
   ticket ID ("t:…"), otherwise by the person's folded full name ("n:…"; see
   services/rsvp.js rsvpKeys). Re-submitting updates the row only with proof:
   the same verified ticket, or the row's edit token (services/rsvpHandler.js).
   Without proof a second RSVP for the name gets its own row ("dup:…") marked
   `duplicateOf`, out of the headcounts until staff merge it (`mergedInto`)
   or keep it as a separate person (`separatedAt`: never flagged again).
   Bots are kept in rows of their own
   (spam: true) and left out of the admin list and headcounts.
   Option keys: services/rsvp.js RSVP_OPTIONS. */
const str = { type: String, default: "" };

const rsvpSchema = new mongoose.Schema({
  key: { type: String, required: true },

  // Who
  firstName: str, lastName: str, name: str,
  nameKey: str,        // "jose nunez" ("" when another name was typed over a verified ticket; kept on later saves)
  email: str,          // optional, for a confirmation
  ticketId: str,       // as given (normalised); see ticketVerified
  ticketVerified: { type: Boolean, default: false },

  // Pass: worked out by the server (ticket > speaker > what they chose)
  kind: { type: String, enum: ["ticket", "speaker", "none"], default: "none" },
  tier: { type: String, enum: ["connect", "influence", "power", "apex", "speaker", ""], default: "" },
  tierVerified: { type: Boolean, default: false },
  chosenTier: str,     // what the person picked on the form
  detectedTier: str,   // pass of the one ticket holder with their name, or a speaker's verified ticket
  matchedSpeaker: str, // the speaker-list name matched (speakers are matched by name only: unverified)

  // What they're coming to
  days: { type: [String], default: [] },     // day1, day2
  options: { type: [String], default: [] },  // sessions_d1, expo_d2, breaks_d1, lunch_d1, cxo_d2, gala, awards, meetings, lounge…
  dietary: { type: [String], default: [] },
  dietaryOther: str,
  accessibility: str,

  // Where from (no IP addresses)
  page: str, userAgent: str,
  fillMs: Number,
  submissions: { type: Number, default: 1 },

  spam: { type: Boolean, default: false },
  spamReason: str,

  // Ownership and duplicates
  editTokenHash: { type: String, default: "", select: false }, // sha256 of the browser's edit token
  duplicateOf: str,    // _id of the RSVP this may duplicate (not counted until staff decide)
  mergedInto: str,     // staff merged this row into that _id (kept, never listed)
  separatedFrom: str,  // staff kept this row as a person of their own, apart from that _id…
  separatedAt: Date,   // …then: a later save by the namesake never flags it as a duplicate again
  separatedBy: str,    // staff name

  // Who set the answers (services/rsvpStaff.js). "attendee": sent from /rsvp (rows from before
  // this field have none: they're the attendee's too). "staff": entered or changed in Admin → People.
  // The attendee's own RSVP always wins: their next one replaces staff's answers and sets "attendee".
  source: { type: String, enum: ["attendee", "staff"], default: "attendee" },
  attendeeSubmittedAt: Date, // when the attendee last sent it themselves
  staffUpdatedBy: str,       // staff name, last staff change (kept as history after the attendee changes it)
  staffUpdatedById: str,
  staffUpdatedAt: Date,
  staffOverride: { type: Boolean, default: false },     // staff replaced answers the attendee had sent
  passLimitOverride: { type: Boolean, default: false }, // staff let it include options their pass doesn't cover
}, { timestamps: true });

rsvpSchema.index({ key: 1 }, { unique: true, partialFilterExpression: { spam: false } });
rsvpSchema.index({ nameKey: 1 });
rsvpSchema.index({ editTokenHash: 1 });
rsvpSchema.index({ createdAt: -1 });
rsvpSchema.index({ updatedAt: -1 });

export default mongoose.models.Rsvp || mongoose.model("Rsvp", rsvpSchema);
