import mongoose from "mongoose";

/* One row per (campaign, email): that this person was emailed for a
   one-off campaign such as the "I'm attending" email (CAMPAIGN_KEY in
   services/attendingCampaign.js). A send first claims the row
   ("sending"), then marks it "sent" (with Resend's id) or "failed"
   (retried by the next run). The unique index is what makes a second
   run, or two runs at once, skip people already emailed. A row left in
   "sending" (the server stopped mid-send) is never retried
   automatically: staff check Resend before sending it again. */
const campaignSendSchema = new mongoose.Schema(
  {
    campaign: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, default: "" },
    status: { type: String, enum: ["sending", "sent", "failed"], required: true },
    resendId: { type: String, default: "" },
    error: { type: String, default: "" },
    attempts: { type: Number, default: 0 },
    sends: { type: Number, default: 0 }, // successful sends (an RSVP reminder can go more than once)
    sentAt: { type: Date },
    lastTriedAt: { type: Date },
    sentBy: { type: String, default: "" },
  },
  { timestamps: true }
);

campaignSendSchema.index({ campaign: 1, email: 1 }, { unique: true });

export default mongoose.model("CampaignSend", campaignSendSchema);
