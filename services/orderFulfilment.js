import crypto from "crypto";
import Attendee from "../models/Attendee.js";
import Order from "../models/Order.js";
import Promo from "../models/Promo.js";
import TicketType from "../models/TicketType.js";
import { sendTicketEmail } from "./emailService.js";
import { effectiveExtras } from "./passExtras.js";
import { sendOrderInvoiceEmail } from "./orderInvoiceEmail.js";

/* =========================================================
   Fulfil a paid multi-attendee order (models/Order.js):
   one Attendee pass per attendee, a ticket email to EACH
   attendee, and ONE invoice email to the booker. Called by
   the Stripe webhook's order branch (routes/webhook.js,
   keyed on the session's `orderId` metadata — a key the
   single-ticket checkout never sets) and directly by the
   checkout route for $0 orders (routes/orders.js).

   Idempotent, because Stripe delivers events more than
   once and may deliver again while a slow first delivery
   is still sending emails:
     - a fulfilled order is final: later calls do nothing;
     - "pending" is claimed atomically (→ "paid") so two
       deliveries can't both start; a delivery that finds
       the order freshly "paid" backs off ({ inProgress })
       and lets Stripe retry it — a retry that finds the
       order STILL "paid" after a stale window resumes the
       fulfilment where it stopped;
     - pass creation is deduped per attendee on the pass
       already carrying this order's id in its details, and
       the promo's paid use is counted once (order.promoCounted).
   Emails go last, after the order is marked fulfilled, so
   a crash mid-emails never re-issues passes (the same
   trade-off the single-ticket webhook makes).
========================================================= */

const STALE_MS = 2 * 60 * 1000; // a "paid" order untouched this long is resumed

export async function fulfilOrder(order, session = null) {
  if (!order) return { alreadyFulfilled: false };
  let doc = order;

  if (doc.status === "fulfilled") return { alreadyFulfilled: true };

  if (doc.status === "pending") {
    doc = await Order.findOneAndUpdate(
      { _id: doc._id, status: "pending" },
      { $set: { status: "paid" } },
      { new: true }
    );
    if (!doc) return { inProgress: true }; // another delivery claimed it
  } else if (doc.status === "paid") {
    const age = Date.now() - new Date(doc.updatedAt || 0).getTime();
    if (age < STALE_MS) return { inProgress: true }; // a delivery is on it
    // stale: the earlier attempt stopped mid-fulfilment — resume below.
  } else {
    return { alreadyFulfilled: false, skipped: doc.status };
  }

  // The passes' ticketType: the ticket type's slug (Attendee.ticketType,
  // the same string the single-ticket flow stores from its tier).
  const typeIds = [...new Set(doc.attendees.map((p) => String(p.ticketTypeId)))];
  const types = await TicketType.find({ _id: { $in: typeIds } }).lean();
  const slugOf = new Map(types.map((t) => [String(t._id), t.slug || ""]));

  const issued = [];
  for (const person of doc.attendees) {
    const slug = slugOf.get(String(person.ticketTypeId)) || "";
    if (!person.attendeeId) {
      // Resume-safe: reuse a pass this order already issued to this person.
      const existing = await Attendee.findOne({
        "details.orderId": String(doc._id),
        email: person.email,
        ticketType: slug
      });
      if (existing) {
        person.attendeeId = existing._id;
        person.ticketId = existing.ticketId;
      } else {
        const ticketId = crypto.randomBytes(6).toString("hex");
        const attendee = new Attendee({
          name: `${person.firstName} ${person.lastName}`.trim(),
          email: person.email,
          ticketId,
          ticketType: slug,
          eventKey: doc.eventKey,
          stripeSessionId: doc.stripeSessionId || session?.id || undefined,
          promoCode: doc.promoCode || "",
          details: {
            firstName: person.firstName,
            lastName: person.lastName,
            ...(person.title ? { jobTitle: person.title } : {}),
            ...(person.company ? { organisation: person.company } : {}),
            orderId: String(doc._id),
            source: "multi-checkout"
          },
          // The booker's own pass is theirs: link it to their account
          // (the claim other passes get when their owner signs up).
          ...(doc.booker?.userId && person.email === doc.booker.email
            ? { claimedBy: doc.booker.userId }
            : {}),
          purchaseDate: new Date()
        });
        await attendee.save();
        person.attendeeId = attendee._id;
        person.ticketId = ticketId;
        console.log("🎟 Order pass issued:", person.email, ticketId);
      }
    }
    issued.push({ person, slug });
  }
  await doc.save();

  // Count the code's paid use exactly once (the single-ticket webhook
  // counts its sessions the same way, in Promo.timesUsed).
  if (doc.promoCode && !doc.promoCounted) {
    await Promo.updateOne({ code: doc.promoCode }, { $inc: { timesUsed: 1 } });
    doc.promoCounted = true;
  }

  doc.status = "fulfilled";
  doc.fulfilledAt = new Date();
  await doc.save();

  // ================= EMAILS =================
  // A ticket to each attendee (their own pass, their own inbox)…
  // One failed email never stops the others (the order is already fulfilled,
  // so a webhook retry would not resend them).
  for (const { person, slug } of issued) {
    const extras = effectiveExtras({ ticketType: slug });
    try {
      await sendTicketEmail({
        email: person.email,
        name: `${person.firstName} ${person.lastName}`.trim(),
        firstName: person.firstName,
        ticketId: person.ticketId,
        tier: slug,
        cxoBreakfast: extras.cxo,
        extras
      });
      console.log("📧 Ticket email sent for order", String(doc._id));
    } catch (e) {
      console.error("❌ Ticket email failed for order", String(doc._id), e.message);
    }
  }

  // …and ONE invoice to the booker, itemizing the whole order.
  try {
    await sendOrderInvoiceEmail({
      order: doc,
      chargedTotalCents:
        typeof session?.amount_total === "number" ? session.amount_total : null
    });
  } catch (e) {
    console.error("❌ Invoice email failed for order", String(doc._id), e.message);
  }

  return { fulfilled: true, tickets: issued.length };
}

export default fulfilOrder;
