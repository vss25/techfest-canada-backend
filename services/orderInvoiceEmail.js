import { Resend } from "resend";
import { EVENT } from "./ticketInfo.js";

/* The ONE invoice email for a multi-attendee order, sent to the BOOKER
   only (services/orderFulfilment.js) — attendees receive their own
   ticket emails and never the invoice. Itemizes every ticket, every
   discount the pricing engine applied, and the attendees the passes
   were issued to. Amounts are the order's pre-HST cents; when the
   Stripe session is known, the total actually charged (HST included)
   is shown as well. Sent through Resend like every other email here
   (services/emailService.js); never throws — a failed invoice email
   must not fail a fulfilment the buyer already paid for. */

const resend = new Resend(process.env.RESEND_API_KEY);

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const money = (centsValue, currency = "CAD") =>
  `${currency} $${(Math.max(0, Number(centsValue) || 0) / 100).toFixed(2)}`;

export function buildOrderInvoice({ order, chargedTotalCents = null }) {
  const currency = order.amounts?.currency || "CAD";
  const a = order.amounts || {};
  const orderRef = String(order._id).slice(-8).toUpperCase();

  const itemRows = (order.items || [])
    .map(
      (i) =>
        `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;">${escapeHtml(i.name)} × ${i.quantity}</td>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">${money(i.unitPriceCents * i.quantity, currency)}</td></tr>`
    )
    .join("");

  const discountRow = (label, centsValue) =>
    centsValue > 0
      ? `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;">${label}</td>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">−${money(centsValue, currency)}</td></tr>`
      : "";

  const attendeeRows = (order.attendees || [])
    .map(
      (p) =>
        `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;">${escapeHtml(`${p.firstName} ${p.lastName}`)}</td>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #eee;">${escapeHtml(p.email)}</td>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #eee;">${escapeHtml(p.ticketId || "")}</td></tr>`
    )
    .join("");

  const subject = `Your TTFC invoice — order ${orderRef}`;

  const html = `
    <h2>Thank you${order.booker?.name ? `, ${escapeHtml(order.booker.name)}` : ""}!</h2>
    <p>Your payment is confirmed. Each attendee has been sent their own ticket by email;
       this invoice is yours alone, for the whole order.</p>
    <p><strong>Order:</strong> ${orderRef}<br><strong>Event:</strong> ${escapeHtml(order.eventKey)}</p>
    <table style="border-collapse:collapse;min-width:420px;">
      ${itemRows}
      ${discountRow("Buy more, get free (BOGO)", a.bogoDiscountCents)}
      ${discountRow("Group discount", a.groupDiscountCents)}
      ${discountRow(`Promo code${order.promoCode ? ` (${escapeHtml(order.promoCode)})` : ""}`, a.codeDiscountCents)}
      <tr><td style="padding:6px 10px;"><strong>Total (before HST)</strong></td>
      <td style="padding:6px 10px;text-align:right;"><strong>${money(a.totalCents, currency)}</strong></td></tr>
      ${
        chargedTotalCents != null
          ? `<tr><td style="padding:6px 10px;">Total charged, HST included</td>
             <td style="padding:6px 10px;text-align:right;">${money(chargedTotalCents, currency)}</td></tr>`
          : ""
      }
    </table>
    <h3 style="margin-top:24px;">Passes issued</h3>
    <table style="border-collapse:collapse;min-width:420px;">
      <tr><th style="padding:6px 10px;text-align:left;">Attendee</th>
          <th style="padding:6px 10px;text-align:left;">Email</th>
          <th style="padding:6px 10px;text-align:left;">Ticket ID</th></tr>
      ${attendeeRows}
    </table>
    <p style="color:#666;">Questions about this order? Reply to this email or write to ${escapeHtml(EVENT.supportEmail)}.</p>
  `;

  const textLines = [
    `Thank you${order.booker?.name ? `, ${order.booker.name}` : ""}!`,
    `Your payment is confirmed. Each attendee has been sent their own ticket by email; this invoice is yours alone.`,
    ``,
    `Order: ${orderRef}`,
    `Event: ${order.eventKey}`,
    ...(order.items || []).map(
      (i) => `${i.name} x ${i.quantity}: ${money(i.unitPriceCents * i.quantity, currency)}`
    ),
    ...(a.bogoDiscountCents > 0 ? [`BOGO savings: -${money(a.bogoDiscountCents, currency)}`] : []),
    ...(a.groupDiscountCents > 0 ? [`Group discount: -${money(a.groupDiscountCents, currency)}`] : []),
    ...(a.codeDiscountCents > 0 ? [`Promo code${order.promoCode ? ` (${order.promoCode})` : ""}: -${money(a.codeDiscountCents, currency)}`] : []),
    `Total (before HST): ${money(a.totalCents, currency)}`,
    ...(chargedTotalCents != null ? [`Total charged, HST included: ${money(chargedTotalCents, currency)}`] : []),
    ``,
    `Passes issued:`,
    ...(order.attendees || []).map(
      (p) => `- ${p.firstName} ${p.lastName} <${p.email}> — ticket ${p.ticketId || ""}`
    ),
    ``,
    `Questions? ${EVENT.supportEmail}`,
  ];

  return { subject, html, text: textLines.join("\n") };
}

export async function sendOrderInvoiceEmail({ order, chargedTotalCents = null }) {
  try {
    if (!order?.booker?.email) return;
    const { subject, html, text } = buildOrderInvoice({ order, chargedTotalCents });
    await resend.emails.send({
      from: "TechFest Canada <tickets@thetechfestival.com>",
      to: order.booker.email,
      reply_to: EVENT.supportEmail,
      subject,
      html,
      text,
    });
    console.log("📧 Order invoice sent to booker:", order.booker.email);
  } catch (err) {
    console.error("ORDER INVOICE EMAIL ERROR:", err);
  }
}

export default sendOrderInvoiceEmail;
