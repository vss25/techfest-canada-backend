import mongoose from "mongoose";

/* The TTFC 2027 waitlist ("Stay updated", Oct 23 2026): one row per email address, from the website's /stay-updated,
   the web app's /app/stay-updated and the iOS / Android apps (routes/stayUpdated.js, services/waitlist.js).
   Signing up again with the same address updates the row (phone, this time's ticks, where from) and counts it in
   `count`; `interests` keeps everything ever ticked so staff filters find them. Never deleted from the admin panel.
   Name and company (Oct 24 2026): the latest ones given; a repeat that gives a new one keeps the one before in
   `earlierNames` / `earlierCompanies` (at most 5 each). Only the email is required: a repeat that leaves the name,
   company or phone empty keeps the saved one. */
const waitlistSignupSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, default: "" },           // as typed, tidied ("" = not given: optional)
    company: { type: String, default: "" },        // their company or organisation
    earlierNames: { type: [String], default: [] }, // names this address gave before, when a repeat changed it (≤ 5)
    earlierCompanies: { type: [String], default: [] },
    phone: { type: String, default: "" },          // as typed, tidied ("" = not given: optional since Oct 24 2026)
    phoneDigits: { type: String, default: "" },    // digits only (7–20), "" without a phone
    interests: { type: [String], default: [] },    // sponsorship | exhibitor | delegation: everything ticked so far
    lastInterests: { type: [String], default: [] },// what they ticked the last time
    source: { type: String, default: "website" },  // the last time: website | webapp | ios | android | programme (the website's /programme page)
    sources: { type: [String], default: [] },      // every place they signed up from
    consent: { type: Boolean, default: false },
    consentAt: { type: Date, default: null },
    ipHash: { type: String, default: "" },         // HMAC of the address (services/waitlist.js ipHash), never the address
    userAgent: { type: String, default: "" },      // first 160 characters
    count: { type: Number, default: 1 },           // sign-ups from this address
    lastSubmittedAt: { type: Date, default: null },
    // The team's email (WAITLIST_INBOX, enquire@): sending | sent | failed.
    alertStatus: { type: String, default: "" },
    alertedAt: { type: Date, default: null },
    alertId: { type: String, default: "" },
    alertError: { type: String, default: "" },
    // The person's "You're on the TTFC 2027 waitlist" email: sending | sent | failed | unsubscribed.
    // confirmedAt: the last one sent (at most one a day per address).
    confirmStatus: { type: String, default: "" },
    confirmedAt: { type: Date, default: null },
    confirmId: { type: String, default: "" },
    confirmError: { type: String, default: "" },
  },
  { timestamps: true },
);

waitlistSignupSchema.index({ createdAt: -1 });
waitlistSignupSchema.index({ interests: 1, createdAt: -1 });

export default mongoose.models.WaitlistSignup || mongoose.model("WaitlistSignup", waitlistSignupSchema);
