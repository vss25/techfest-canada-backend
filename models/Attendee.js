import mongoose from "mongoose";

const attendeeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true
    },
    email: {
      type: String,
      required: true,
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
    }
  },
  {
    timestamps: true
  }
);

const Attendee = mongoose.model("Attendee", attendeeSchema);

export default Attendee;