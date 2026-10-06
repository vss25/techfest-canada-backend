import express from "express";
import Stripe from "stripe";
import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import TicketInventory from "../models/TicketInventory.js";
import Promo from "../models/Promo.js";
import crypto from "crypto";

import { generateTicketPDF } from "../services/pdfTicket.js";
import { sendTicketEmail } from "../services/emailService.js";
import { detailsFromMetadata, displayName } from "../services/attendeeDetails.js";
import { sendResetPasswordEmail } from "../services/emailService.js";

const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ⚠️ raw body required for Stripe - handle both Buffer and string
router.post("/stripe", async (req, res) => {

  // Handle both Buffer (from express.raw) and string
  const rawBody = req.body;
  const bodyString = Buffer.isBuffer(rawBody) ? rawBody.toString('utf-8') : rawBody;
  
  const sig = req.headers["stripe-signature"];

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      bodyString,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ Webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ====================================================
  // PAYMENT SUCCESS
  // ====================================================
  if (event.type === "checkout.session.completed") {

    try {

      const session = event.data.object;

      const tier = session.metadata.tier;
      const userId = session.metadata.userId;
      const purchaseType = session.metadata.type || "ticket";

      const email = session.customer_details?.email;
      // The checkout form's answers (job, company, topics…) ride along as metadata
      const details = detailsFromMetadata(session.metadata);
      const name = displayName(details, session.customer_details?.name) || "Guest";

      const isBooth = purchaseType === "booth";

      if (!tier) {
        console.error("❌ Missing tier metadata");
        return res.json({ received: true });
      }

      // ================= ONCE PER SESSION =================
      // Stripe can deliver the same event more than once. One paid session
      // = one ticket (or one upgrade), and it's counted in inventory once.
      if (!isBooth && purchaseType !== "upgrade") {
        const alreadyIssued = await Attendee.exists({ stripeSessionId: session.id })
          || await User.exists({ "tickets.stripeSessionId": session.id });
        if (alreadyIssued) {
          console.log("↩️  Ticket already issued for session", session.id);
          return res.json({ received: true });
        }
      }
      if (purchaseType === "upgrade") {
        const owner = userId ? await User.findById(userId).select("tickets").lean() : null;
        const t = owner?.tickets?.find((x) => x.ticketId === session.metadata.upgradeFrom);
        if (t && t.type === tier) {
          console.log("↩️  Upgrade already applied for session", session.id);
          return res.json({ received: true });
        }
      }

      // ================= PROMO CODE: count a use only once it's paid =================
      if (session.metadata.promoCode) {
        await Promo.updateOne({ code: String(session.metadata.promoCode).toUpperCase() }, { $inc: { timesUsed: 1 } });
      }

      // ================= INVENTORY UPDATE =================

      const inventory = await TicketInventory.findOne({ tier });

      if (!inventory) {

        console.error("❌ Inventory not found for tier:", tier);

      } else {

        if (inventory.sold >= inventory.total) {

          console.error("❌ Attempted oversell for tier:", tier);

        } else {

          inventory.sold += 1;
          await inventory.save();

          console.log("📦 Inventory updated:", tier);

        }

      }

      // ================= CREATE TICKET (only for tickets, not booths) =================

      if (purchaseType === "upgrade") {
        // ================= PASS UPGRADE: same ticketId, new type =================
        const fromTier = session.metadata.fromTier;
        const ticketId = session.metadata.upgradeFrom;
        if (fromTier) {
          await TicketInventory.updateOne({ tier: fromTier, sold: { $gt: 0 } }, { $inc: { sold: -1 } });
        }
        const user = userId ? await User.findById(userId) : null;
        const ticket = user?.tickets?.find((t) => t.ticketId === ticketId);
        if (ticket) {
          ticket.upgradedFrom = ticket.type;
          ticket.type = tier;
          await user.save();
          await Attendee.updateMany({ ticketId }, { $set: { ticketType: tier } });
          console.log("⬆️ Ticket upgraded:", ticketId, fromTier, "→", tier);
          if (email || user.email) {
            await sendTicketEmail({ email: email || user.email, name: user.name || name, ticketId, tier });
          }
        } else {
          console.error("❌ Upgrade paid but ticket not found:", ticketId, userId);
        }
      } else if (!isBooth) {
        const ticketId = crypto.randomBytes(6).toString("hex");

        // If user purchased while logged in → attach ticket to account
        if (userId && userId !== "guest") {

          const user = await User.findById(userId);

          if (user) {

            user.tickets.push({
              ticketId,
              type: tier,
              stripeSessionId: session.id,
              promoCode: session.metadata.promoCode || "",
              ...(details ? { details } : {}),
              purchaseDate: new Date()
            });

            await user.save();

            console.log("🎟 Ticket attached to user:", userId);

          }

        } else {
          // Guest purchase - create Attendee record
          const attendee = new Attendee({
            name: name || "Guest",
            email: email,
            ticketId,
            ticketType: tier,
            stripeSessionId: session.id,
            promoCode: session.metadata.promoCode || "",
            ...(details ? { details } : {}),
            purchaseDate: new Date()
          });

          await attendee.save();

          console.log("🎟 Guest attendee created:", email);
        }

        // ================= SEND TICKET EMAIL =================

        if (email) {

          await sendTicketEmail({
            email,
            name,
            ticketId,
            tier
          });

          console.log("📧 Ticket email sent to:", email);

        } else {

          console.error("❌ Email missing from Stripe session");

        }

        console.log("✅ Ticket created:", ticketId);
      } else {
        // ================= SEND BOOTH PURCHASE EMAIL =================
        
        if (email) {

          await sendTicketEmail({
            email,
            name,
            ticketId: "BOOTH-" + tier.toUpperCase(),
            tier: tier
          });

          console.log("📧 Booth confirmation email sent to:", email);

        } else {

          console.error("❌ Email missing from Stripe session");

        }

        console.log("✅ Booth purchase confirmed:", tier);
      }

    } catch (err) {

      console.error("❌ Webhook processing failed:", err);

    }

  }

  res.json({ received: true });

});

export default router;
