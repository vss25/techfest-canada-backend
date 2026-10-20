import mongoose from "mongoose";

/* What one person did with one of our emails (Oct 19 2026): one row per
   (campaign, email, ticketId), counters plus the first and last time.
   Written only by services/engagementStore.js, never in the request's way.

   campaign  the email's key ("attending-2026", "rsvp-reminder-2026",
             "speaker-pass-2026", "speaker-nudge-2026", "issued-pass-2026",
             "exhibitor-pass-2026"), or "rsvp-form" for the RSVP page
   email     who it was sent to (lower case); "" for "rsvp-form" rows
   ticketId  the pass a pass email was about, or the ticket the RSVP form
             was opened with (normalizeTicketId); "" for emails about a person
   opens     the open pixel loaded (estimates: some mail apps load every
             image on arrival, others block them)
   visits    the "I'm attending" page opened from their link; for "rsvp-form"
             the RSVP form opened with their ticket ID and last name
   posts     "I'm attending" posted to LinkedIn through our "Post to LinkedIn"
             (confirmed by LinkedIn; postUrl = the newest post). The row with
             no email and no ticket counts posts from links without a token
   shares    the phone's share sheet finished (it can't say the app was LinkedIn)
   manuals   "Download and open LinkedIn" (we can't see whether they posted)
   trackedAt the last send that carried the pixel, so "not opened" means
             something (emails sent before Oct 19 2026 had none)
   No IP addresses or browser details are kept. Dates have no default: a
   missing one is what $min / $max fill in (null would sort before every date). */
const at = { type: Date };
const emailEngagementSchema = new mongoose.Schema(
  {
    campaign: { type: String, required: true },
    email: { type: String, default: "", lowercase: true, trim: true },
    ticketId: { type: String, default: "" },
    opens: { type: Number, default: 0 }, firstOpenAt: at, lastOpenAt: at,
    visits: { type: Number, default: 0 }, firstVisitAt: at, lastVisitAt: at,
    posts: { type: Number, default: 0 }, postedAt: at, lastPostedAt: at, postUrl: { type: String, default: "" },
    shares: { type: Number, default: 0 }, sharedAt: at, lastSharedAt: at,
    manuals: { type: Number, default: 0 }, manualAt: at, lastManualAt: at,
    trackedSends: { type: Number, default: 0 }, trackedAt: at,
  },
  { timestamps: true }
);

emailEngagementSchema.index({ campaign: 1, email: 1, ticketId: 1 }, { unique: true });
emailEngagementSchema.index({ ticketId: 1 });

export default mongoose.model("EmailEngagement", emailEngagementSchema);
