import mongoose from "mongoose";

const attendeeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true
    },
    // Required for every pass except a Speaker Pass (Admin → Speaker passes), which is created before
    // staff have the speaker's email (they add it in the admin panel, then send the pass).
    email: {
      type: String,
      required: function () {
        return !(this.ticketType === "speaker" || this.promoCode === "SPEAKER");
      },
      lowercase: true
    },
    ticketId: {
      type: String,
      required: true,
      unique: true
    },
    ticketType: {
      type: String,
      required: true
    },
    purchaseDate: {
      type: Date,
      default: Date.now
    },
    checkedIn: {
      type: Boolean,
      default: false
    },
    checkedInAt: {
      type: Date
    },
    // The Stripe Checkout Session this ticket came from (one session = one ticket).
    stripeSessionId: {
      type: String,
      index: true,
      sparse: true
    },
    // Everything the buyer filled in on the checkout form (job, company, topics…)
    details: {
      type: mongoose.Schema.Types.Mixed
    },
    // Promo code used at checkout ("" = none).
    promoCode: {
      type: String
    },
    // Set when the Stripe-sync repair found this to be a copy of another ticket.
    syncDuplicate: {
      type: Boolean,
      default: false
    },
    // Hidden from staff lists/analytics only (test or duplicate tickets). Still valid for the owner.
    hiddenByStaff: {
      type: Boolean,
      default: false
    },
    // Kept out of the app's attendee directory (e.g. the owner deleted their app account).
    directoryHidden: {
      type: Boolean,
      default: false
    },
    // Set when this guest ticket is linked to an app/website account.
    claimedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    },
    // Exhibitor switch set by staff in Admin → People. Unset = automatic (an exhibitor pass,
    // promo EXHIBITOR, makes them an exhibitor; anything else doesn't). true = an exhibitor
    // whatever the pass; false = not one, even with an exhibitor pass (no badge or booth in
    // the apps). passKind and loadExhibitors read it, so the account that claims the pass follows.
    exhibitor: { type: Boolean },
    // VIP switch set by staff in Admin → People (services/teamRoles.js isVip). true = a VIP; unset / false = not.
    // An account that claims this pass is a VIP too, unless staff set User.vip on the account.
    vip: { type: Boolean },
    // "CxO Breakfast included" for this pass (services/cxoBreakfast.js): true / false = staff's choice,
    // unset = automatic (Apex and Speaker Passes, and speakers on any pass).
    cxoBreakfast: { type: Boolean },
    // Ticket value after payment typed by management for a pass paid outside Stripe (invoice, bank
    // transfer), CAD before HST. Unset = worked out (Stripe, or 0 for staff-made passes). Admin → People.
    manualValue: { type: Number },
    manualValueNote: { type: String },
    manualValueBy: { type: String },
    manualValueAt: { type: Date },
    // "RSVP Email Sent" marked by staff for an email sent outside the admin panel: true / false,
    // unset = from our send records (services/people.js rsvpEmailOf). Pass-only people; accounts use User.rsvpEmailMark.
    rsvpEmailMark: { type: Boolean },
    rsvpEmailMarkBy: { type: String },
    rsvpEmailMarkAt: { type: Date },
    // Staff-set logo for this person only; "" = their company's default (models/Company.js).
    companyLogoUrl: { type: String, default: "" },
    // Speaker Pass (ticketType "speaker", promo SPEAKER): the Sanity speaker document it was made for.
    // One pass per speaker; the sync keys on this.
    speakerId: {
      type: String,
      index: { unique: true, sparse: true }
    },
    // The Speaker Pass email: last sent, to which address, and how many times.
    passEmailSentAt: { type: Date },
    passEmailSentTo: { type: String },
    passEmailSentCount: { type: Number },
    // Whether the last pass email had the RSVP button (recorded from Oct 19 2026; older sends: unset).
    passEmailRsvp: { type: Boolean },
    // Speaker run of show (services/runOfShow.js) and who the email address belongs to:
    // "own" (the speaker), "handler" (assistant / office), "team" (TTFC).
    runOfShow: { type: mongoose.Schema.Types.Mixed },
    // More addresses that get the same Speaker Pass email (e.g. the speaker and their assistant).
    alsoTo: { type: [String], default: undefined },
    // A staff-issued pass (services/issuedPasses.js): { label, rsvp, copy: { subject, headline, message, …every field of the
    // pass email }, issuedBy, issuedAt }. A speaker's pass (promo SPEAKER) keeps its own email wording here too: label (the
    // name on the pass) and copy (services/passEmailCopy.js); one pass's wording beats the email template.
    issuedPass: { type: mongoose.Schema.Types.Mixed },
    speakerContact: { type: String },
    // Calendar invites for their sessions (sent with the pass email).
    invitesSentAt: { type: Date },
    invitesSentCount: { type: Number },
    // Speaker pass nudges (a reminder to RSVP): last sent and how many times.
    speakerNudgedAt: { type: Date },
    speakerNudgeCount: { type: Number }
  },
  {
    timestamps: true
  }
);

const Attendee = mongoose.model("Attendee", attendeeSchema);

export default Attendee;