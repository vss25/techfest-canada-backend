import express from "express";
import Stripe from "stripe";
import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import TicketInventory from "../models/TicketInventory.js";
import Promo from "../models/Promo.js";
import crypto from "crypto";

import { sendTicketEmail } from "../services/emailService.js";
import { detailsFromMetadata, displayName } from "../services/attendeeDetails.js";
import { sendResetPasswordEmail } from "../services/emailService.js";
import { depositFromSession } from "../services/pavilionApplications.js";
import { recordDeposit, linkDeposits } from "../services/pavilionDeposits.js";
import { effectiveExtras, extrasOverride, EXTRA_SELECT } from "../services/passExtras.js";
import { isSpeakerPass, typeInfo } from "../services/teamRoles.js";
import { loadExhibitors } from "../services/exhibitorCache.js";
import CampaignSend from "../models/CampaignSend.js";
import { makePurchaseAlerter, alertStore, lazyResend } from "../services/purchaseAlert.js";

/** The buyer's person types and VIP flag as the apps see them (a pass marked VIP or Media counts), for the
    CxO Breakfasts on a new or upgraded pass (services/passExtras.js: speakers, VIPs and media on any pass). */
async function holderOf(user) {
  const { types, vip } = typeInfo(user, await loadExhibitors().catch(() => null));
  return { types, vip };
}

const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// The organisers' "New ticket" email (services/purchaseAlert.js): once per paid ticket or booth checkout,
// in the background after the buyer's own email. It never throws, so it can't hold up or fail anything here.
const alertPurchase = makePurchaseAlerter({
  store: alertStore(CampaignSend),
  resend: lazyResend(),
  accountFor: async ({ userId, email }) => {
    if (/^[a-f0-9]{24}$/i.test(userId) && await User.exists({ _id: userId })) return "signed-in";
    if (email && await User.exists({ email })) return "exists";
    return "none";
  },
});

/* A booth leaves no ticket to look up, so each booth checkout claims one CampaignSend row first
   (campaign BOOTH_CLAIM, the session id in `email`; the unique index in models/CampaignSend.js).
   Stripe delivering the same event again, or twice at once, finds the row and stops before the code,
   the booth count and the buyer's email are counted a second time. */
export const BOOTH_CLAIM = "booth-purchase-2026";
const boothKey = (session) => String(session.id).toLowerCase();

/** True when this delivery is the first for the booth checkout (it made the claim row). */
export async function claimBoothSession(session, model = CampaignSend) {
  try {
    await model.create({
      campaign: BOOTH_CLAIM, email: boothKey(session), name: String(session.metadata?.tier || ""),
      status: "sending", attempts: 1, lastTriedAt: new Date(),
    });
    return true;
  } catch (err) {
    if (err?.code === 11000) return false;
    throw err;
  }
}

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

      // India Pavilion $500 deposit: no ticket or booth. Record it and mark the
      // matching application as paid (services/pavilionDeposits.js). If this
      // fails, Admin → India Pavilion reads it back from Stripe anyway.
      if (session.metadata?.type === "pavilion-deposit") {
        const dep = depositFromSession(session);
        if (dep) {
          await recordDeposit(dep, "webhook");
          await linkDeposits();
          console.log("✅ Pavilion deposit recorded:", session.id);
        }
        return res.json({ received: true });
      }

      const tier = session.metadata.tier;
      const userId = session.metadata.userId;
      const purchaseType = session.metadata.type || "ticket";

      const email = session.customer_details?.email;
      // The checkout form's answers (job, company, topics…) ride along as metadata
      const details = detailsFromMetadata(session.metadata);
      const name = displayName(details, session.customer_details?.name) || "Guest";

      const isBooth = purchaseType === "booth";
      const paidAt = event.created ? new Date(event.created * 1000) : new Date();

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
      if (isBooth && !(await claimBoothSession(session))) {
        console.log("↩️  Booth already confirmed for session", session.id);
        return res.json({ received: true });
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
        const user = userId ? await User.findById(userId) : null;
        const ticket = user?.tickets?.find((t) => t.ticketId === ticketId);
        // A Speaker Pass (internal, never sold) never took a seat from the inventory: none to give back.
        if (fromTier && !(ticket && isSpeakerPass(ticket))) {
          await TicketInventory.updateOne({ tier: fromTier, sold: { $gt: 0 } }, { $inc: { sold: -1 } });
        }
        if (ticket) {
          ticket.upgradedFrom = ticket.type;
          ticket.type = tier;
          await user.save();
          await Attendee.updateMany({ ticketId }, { $set: { ticketType: tier } });
          console.log("⬆️ Ticket upgraded:", ticketId, fromTier, "→", tier);
          if (email || user.email) {
            // The upgraded pass's extras (CxO Breakfasts, luncheons, Gala, Awards): staff's switches on this ticket
            // where set, else the new pass's rules (services/passExtras.js).
            const holder = await holderOf(user);
            const extras = await Attendee.findOne({ ticketId }).select(EXTRA_SELECT).lean()
              .then((a) => effectiveExtras({ ticketType: tier, ...holder, override: extrasOverride(ticket, a) }))
              .catch(() => undefined);
            await sendTicketEmail({
              email: email || user.email,
              name: displayName(ticket.details, user.name) || name,
              firstName: ticket.details?.firstName || details?.firstName,
              ticketId,
              tier,
              purchaseDate: ticket.purchaseDate,
              cxoBreakfast: extras?.cxo,
              extras,
            });
          }
        } else {
          console.error("❌ Upgrade paid but ticket not found:", ticketId, userId);
        }
      } else if (!isBooth) {
        const ticketId = crypto.randomBytes(6).toString("hex");
        // A speaker, VIP or media buyer gets the CxO Breakfasts with it (services/passExtras.js); else the pass's rules.
        let buyerTypes = [];
        let buyerVip = false;
        let onAccount = false;

        // If user purchased while logged in → attach ticket to account
        if (userId && userId !== "guest") {

          const user = await User.findById(userId);

          if (user) {
            ({ types: buyerTypes, vip: buyerVip } = await holderOf(user));

            user.tickets.push({
              ticketId,
              type: tier,
              stripeSessionId: session.id,
              promoCode: session.metadata.promoCode || "",
              ...(details ? { details } : {}),
              purchaseDate: new Date()
            });

            await user.save();
            onAccount = true;

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
            firstName: details?.firstName,
            ticketId,
            tier,
            cxoBreakfast: effectiveExtras({ ticketType: tier, types: buyerTypes, vip: buyerVip }).cxo,
            extras: effectiveExtras({ ticketType: tier, types: buyerTypes, vip: buyerVip }),
          });

          console.log("📧 Ticket email sent to:", email);

        } else {

          console.error("❌ Email missing from Stripe session");

        }

        console.log("✅ Ticket created:", ticketId);
        alertPurchase({ session, ticketIds: [ticketId], signedIn: onAccount, paidAt });
      } else {
        // ================= SEND BOOTH PURCHASE EMAIL =================
        
        if (email) {

          await sendTicketEmail({
            email,
            name,
            firstName: details?.firstName,
            ticketId: "BOOTH-" + tier.toUpperCase(),
            tier: tier
          });

          console.log("📧 Booth confirmation email sent to:", email);

        } else {

          console.error("❌ Email missing from Stripe session");

        }

        console.log("✅ Booth purchase confirmed:", tier);
        await CampaignSend.updateOne({ campaign: BOOTH_CLAIM, email: boothKey(session) },
          { $set: { status: "sent", sentAt: new Date(), sends: 1 } }).catch(() => {});
        alertPurchase({ session, paidAt });
      }

    } catch (err) {

      console.error("❌ Webhook processing failed:", err);

    }

  }

  res.json({ received: true });

});

export default router;
