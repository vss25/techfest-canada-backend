import mongoose from "mongoose";

const attendeeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true
    },
    // Required for every pass except a Speaker Pass, which is created before staff
    // have the speaker's email (they add it in the admin panel, then send the pass).
    email: {
      type: String,
      required: function () { return this.ticketType !== "speaker"; },
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
    // Speaker Pass (ticketType "speaker"): the Sanity speaker document it was made for.
    // One pass per speaker; the sync keys on this.
    speakerId: {
      type: String,
      index: { unique: true, sparse: true }
    },
    // The Speaker Pass email: last sent, to which address, and how many times.
    passEmailSentAt: { type: Date },
    passEmailSentTo: { type: String },
    passEmailSentCount: { type: Number },
    // Speaker run of show (services/runOfShow.js) and who the email address belongs to:
    // "own" (the speaker), "handler" (assistant / office), "team" (TTFC).
    runOfShow: { type: mongoose.Schema.Types.Mixed },
    // More addresses that get the same Speaker Pass email (e.g. the speaker and their assistant).
    alsoTo: { type: [String], default: undefined },
    speakerContact: { type: String },
    // Calendar invites for their sessions (sent with the pass email).
    invitesSentAt: { type: Date },
    invitesSentCount: { type: Number }
  },
  {
    timestamps: true
  }
);

const Attendee = mongoose.model("Attendee", attendeeSchema);

export default Attendee;