import mongoose from "mongoose";

/* Every paid India Pavilion $500 deposit (Stripe Checkout, metadata.type
   "pavilion-deposit"), from the webhook or read back from Stripe. Linked to
   its application when one matches; unmatched ones still show in
   Admin → India Pavilion. See services/pavilionDeposits.js. */
const pavilionDepositSchema = new mongoose.Schema({
  stripeSessionId: { type: String, required: true, unique: true },
  paymentIntent: { type: String, default: "" },
  email: { type: String, default: "" },        // Stripe receipt email
  name: { type: String, default: "" },         // card holder
  contactEmail: { type: String, default: "" }, // typed on the deposit page
  companyName: { type: String, default: "" },
  applicationRef: { type: String, default: "" },
  amount: Number,  // before HST
  tax: Number,
  total: Number,
  refunded: { type: Number, default: 0 },
  currency: { type: String, default: "CAD" },
  paidAt: Date,
  source: { type: String, default: "" },       // webhook | stripe
  applicationId: { type: mongoose.Schema.Types.ObjectId, ref: "PavilionApplication", default: null },
  matchedBy: { type: String, default: "" },
}, { timestamps: true });

pavilionDepositSchema.index({ applicationId: 1 });

export default mongoose.models.PavilionDeposit || mongoose.model("PavilionDeposit", pavilionDepositSchema);
