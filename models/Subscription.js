import mongoose from "mongoose";

/* Newsletter sign-ups, and (Oct 22 2026) the one list of people who unsubscribed from TTFC's bulk emails:
   `subscribed: false` is left out of every campaign (services/unsubscribe.js). A row is made for anyone who
   unsubscribes, not only newsletter sign-ups (source "unsubscribe"). */
const subscriptionSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    subscribed: {
      type: Boolean,
      default: true,
    },
    source: {
      type: String,
      default: "website",
    },
    // When and how they unsubscribed (services/unsubscribe.js SOURCES); kept after a resubscribe as history.
    unsubscribedAt: { type: Date, default: null },
    unsubscribeSource: { type: String, default: "" },
    unsubscribedBy: { type: String, default: "" }, // the staff member who added them ("" when they did it themselves)
    resubscribedAt: { type: Date, default: null },
    resubscribedBy: { type: String, default: "" },
  },
  {
    timestamps: true,
  }
);

subscriptionSchema.index({ subscribed: 1, unsubscribedAt: -1 });

const Subscription = mongoose.model("Subscription", subscriptionSchema);

export default Subscription;
