import { Resend } from "resend";
import { generateTicketPDF } from "./pdfTicket.js";
import { buildTicketEmail } from "./ticketEmail.js";
import { buildProfileRequestEmail } from "./profileEmail.js";
import { buildSignInEmail, buildNoTicketEmail } from "./signInEmail.js";
import { buildBrochureEmail, buildBrochureReceiptEmail } from "./brochureEmail.js";
import { SALES_INBOX } from "./brochureDownloads.js";
import { walletPassUrl, ticketQrUrl } from "./walletLink.js";
import { isConfigured as walletConfigured } from "./walletPass.js";
import { isBoothId, EVENT } from "./ticketInfo.js";

const resend = new Resend(process.env.RESEND_API_KEY);

/* =========================================================
   SANITIZE EMAIL HTML - Remove <title> tags
========================================================= */

export function sanitizeEmailHtml(html) {
  if (!html) return html;
  // Remove <title> tags and their content
  return html.replace(/<title[^>]*>[\s\S]*?<\/title>/gi, "");
}

/* =========================================================
   WELCOME EMAIL
========================================================= */

export async function sendWelcomeEmail(email, name) {

  try {

    await resend.emails.send({

      from: "TechFest Canada <noreply@thetechfestival.com>",

      to: email,

      subject: "Welcome to TechFest Canada 🚀",

      html: `
      <h2>Welcome ${name}!</h2>

      <p>Thank you for joining TechFest Canada.</p>

      <p>You can now purchase your delegate pass below.</p>

      <a href="${process.env.FRONTEND_URL}/tickets"
      style="padding:12px 20px;background:#8b5cf6;color:white;border-radius:6px;text-decoration:none;">
      Purchase Tickets
      </a>
      `
    });

    console.log("Welcome email sent");

  } catch (err) {

    console.error("WELCOME EMAIL ERROR:", err);

  }
}

/* =========================================================
   PASSWORD RESET EMAIL
========================================================= */

export async function sendResetPasswordEmail(email, resetLink) {

  try {

    await resend.emails.send({

      from: "TechFest Canada <noreply@thetechfestival.com>",

      to: email,

      subject: "Reset your password",

      html: `
      <h2>Password Reset Request</h2>

      <p>Click below to reset your password.</p>

      <a href="${resetLink}"
      style="padding:12px 20px;background:#f97316;color:white;border-radius:6px;text-decoration:none;">
      Reset Password
      </a>
      `
    });

    console.log("Reset email sent");

  } catch (err) {

    console.error("RESET EMAIL ERROR:", err);

  }
}

/* =========================================================
   TICKET EMAIL WITH PDF
   Layout lives in services/ticketEmail.js (pure, tested) and the
   PDF in services/pdfTicket.js. Here we add the signed public links:
   - QR image   → GET /api/wallet/qr/:ticketId?sig=…   (needs WALLET_LINK_SECRET or JWT_SECRET)
   - Wallet pass → GET /api/wallet/pass/:ticketId?sig=… (also needs the Apple
     Pass Type ID certificate — the button is left out until it's configured,
     so buyers never get a link that can't work)
========================================================= */

/* =========================================================
   "COMPLETE YOUR PROFILE" EMAIL
   Layout in services/profileEmail.js (pure, tested). Staff send it
   from Admin → Tickets (POST /api/console/tickets/profile-request).
   Throws when Resend refuses it, so the caller can count failures.
========================================================= */

export async function sendProfileRequestEmail({ email, firstName, tier, link }) {
  if (!email || !link) throw new Error("Missing email or link");
  const { subject, html, text } = buildProfileRequestEmail({ firstName, tier, link });
  const { data, error } = await resend.emails.send({
    from: "TechFest Canada <tickets@thetechfestival.com>",
    to: email,
    reply_to: EVENT.supportEmail,
    subject,
    html,
    text,
  });
  if (error) throw new Error(error.message || "Resend refused the email");
  return data;
}

/* =========================================================
   "EMAIL ME A SIGN-IN LINK" EMAILS
   Layout in services/signInEmail.js (pure, tested). Sent from
   routes/emailLink.js. Throw when Resend refuses them.
========================================================= */

export async function sendSignInLinkEmail({ email, link, code, minutes = 15 }) {
  if (!email || !link || !code) throw new Error("Missing email, link or code");
  const { subject, html, text } = buildSignInEmail({ link, code, minutes });
  const { data, error } = await resend.emails.send({
    from: "TechFest Canada <noreply@thetechfestival.com>",
    to: email,
    reply_to: EVENT.supportEmail,
    subject,
    html,
    text,
  });
  if (error) throw new Error(error.message || "Resend refused the email");
  return data;
}

export async function sendNoTicketEmail({ email, ticketsUrl }) {
  if (!email) throw new Error("Missing email");
  const { subject, html, text } = buildNoTicketEmail({ email, ticketsUrl });
  const { data, error } = await resend.emails.send({
    from: "TechFest Canada <noreply@thetechfestival.com>",
    to: email,
    reply_to: EVENT.supportEmail,
    subject,
    html,
    text,
  });
  if (error) throw new Error(error.message || "Resend refused the email");
  return data;
}

/* =========================================================
   BROCHURE EMAILS (website /brochures form)
   Layout in services/brochureEmail.js (pure, tested). Sent from
   routes/brochure.js after the visitor already has the PDF, so they
   never hold up the download. Throw when Resend refuses them.
   `attachment` is { filename, content } or null (link only).
========================================================= */

export async function sendBrochureEmail({ email, firstName, brochure, link, attachment = null }) {
  if (!email || !brochure || !link) throw new Error("Missing email, brochure or link");
  const { subject, html, text } = buildBrochureEmail({ firstName, brochure, link, attached: !!attachment });
  const { data, error } = await resend.emails.send({
    from: "TechFest Canada <noreply@thetechfestival.com>",
    to: email,
    reply_to: SALES_INBOX,
    subject,
    html,
    text,
    ...(attachment ? { attachments: [attachment] } : {}),
  });
  if (error) throw new Error(error.message || "Resend refused the email");
  return data;
}

export async function sendBrochureReceiptEmail({ to = [SALES_INBOX], lead, brochure, delivery }) {
  if (!lead?.email) throw new Error("Missing lead");
  const { subject, html, text } = buildBrochureReceiptEmail({ lead, brochure, delivery });
  const { data, error } = await resend.emails.send({
    from: "TechFest Canada <noreply@thetechfestival.com>",
    to,
    reply_to: lead.email,
    subject,
    html,
    text,
  });
  if (error) throw new Error(error.message || "Resend refused the email");
  return data;
}

export function ticketEmailLinks(ticketId) {
  if (!ticketId || isBoothId(ticketId)) return { walletUrl: "", qrUrl: "" };
  return {
    walletUrl: walletConfigured() ? walletPassUrl(ticketId) : "",
    qrUrl: ticketQrUrl(ticketId),
  };
}

export async function sendTicketEmail({ email, name, firstName, ticketId, tier, purchaseDate }) {

  try {

    const { walletUrl, qrUrl } = ticketEmailLinks(ticketId);

    const pdfBuffer = await generateTicketPDF({
      name,
      email,
      ticketId,
      tier,
      purchaseDate: purchaseDate || new Date(),
      walletUrl,
    });

    const { subject, html, text } = buildTicketEmail({ name, firstName, ticketId, tier, walletUrl, qrUrl });

    await resend.emails.send({
      from: "TechFest Canada <tickets@thetechfestival.com>",
      to: email,
      reply_to: EVENT.supportEmail,
      subject,
      html,
      text,
      attachments: [
        {
          filename: `ttfc-pass-${ticketId}.pdf`,
          content: pdfBuffer
        }
      ]
    });

    console.log("Ticket email sent");

  } catch (err) {

    console.error("TICKET EMAIL ERROR:", err);

  }
}

/* =========================================================
   CAMPAIGN EMAIL
========================================================= */

export async function sendCampaignEmail({ to, subject, html, campaignId, recipientEmail, recipientTrackingId, baseUrl }) {
  try {
    console.log(`[EMAIL SERVICE] ===== START SEND =====`);
    console.log(`[EMAIL SERVICE] To: ${to}`);
    console.log(`[EMAIL SERVICE] Subject: ${subject}`);
    console.log(`[EMAIL SERVICE] HTML length: ${html ? html.length : 0}`);
    console.log(`[EMAIL SERVICE] HTML type: ${typeof html}`);
    console.log(`[EMAIL SERVICE] HTML is string: ${typeof html === 'string'}`);
    console.log(`[EMAIL SERVICE] HTML length: ${html.length}`);
    console.log(`[EMAIL SERVICE] HTML first 200 chars:\n${html.substring(0, 200)}`);
    console.log(`[EMAIL SERVICE] HTML middle 200 chars:\n${html.substring(Math.floor(html.length/2 - 100), Math.floor(html.length/2 + 100))}`);
    console.log(`[EMAIL SERVICE] HTML last 200 chars:\n${html.substring(html.length - 200)}`);
    console.log(`[EMAIL SERVICE] HTML contains </body>: ${html.includes('</body>')}`);
    console.log(`[EMAIL SERVICE] HTML contains </html>: ${html.includes('</html>')}`);
    console.log(`[EMAIL SERVICE] HTML contains <title>: ${html.includes('<title>')}`);
    console.log(`[EMAIL SERVICE] HTML contains </title>: ${html.includes('</title>')}`);
    console.log(`[EMAIL SERVICE] HTML contains <table: ${html.includes('<table')}`);
    console.log(`[EMAIL SERVICE] HTML contains </table>: ${html.includes('</table>')}`);

    // Validate HTML before sending
    if (!html || typeof html !== 'string') {
      console.error(`[EMAIL SERVICE] ERROR: HTML is invalid - type: ${typeof html}, value: ${html}`);
      return { success: false, error: 'Invalid HTML' };
    }

    // Check for basic HTML structure
    if (!html.includes('<html') || !html.includes('</html>')) {
      console.error(`[EMAIL SERVICE] WARNING: HTML may be malformed - missing html tags`);
    }
    if (!html.includes('<body') || !html.includes('</body>')) {
      console.error(`[EMAIL SERVICE] WARNING: HTML may be malformed - missing body tags`);
    }

    // Log the complete payload as JSON for inspection
    const emailPayload = {
      from: "TechFest Canada <campaigns@thetechfestival.com>",
      to: [to],
      subject: subject,
      html: html,
    };

    console.log(`[EMAIL SERVICE] Full payload JSON (truncated):`);
    console.log(`  from: ${emailPayload.from}`);
    console.log(`  to: ${emailPayload.to}`);
    console.log(`  subject: ${emailPayload.subject}`);
    console.log(`  html length: ${emailPayload.html.length}`);
    console.log(`  html starts with: ${emailPayload.html.substring(0, 50)}`);
    console.log(`  html ends with: ${emailPayload.html.substring(emailPayload.html.length - 50)}`);

    const result = await resend.emails.send(emailPayload);

    console.log(`[EMAIL SERVICE] Resend result:`, result);
    console.log(`[EMAIL SERVICE] ===== END SEND =====`);

    if (result.error) {
      console.error(`[EMAIL SERVICE] Resend error:`, result.error);
      return { success: false, error: result.error };
    }

    return { success: true, result };
  } catch (err) {
    console.error("[EMAIL SERVICE] ===== ERROR =====");
    console.error("[EMAIL SERVICE] Error message:", err.message);
    console.error("[EMAIL SERVICE] Error stack:", err.stack);
    console.error("[EMAIL SERVICE] Error response:", err.response?.data);
    return { success: false, error: err.message, details: err.response?.data };
  }
}

/* =========================================================
   BATCH CAMPAIGN EMAIL - Using Resend Batch API
   Sends up to 100 emails per API call - no rate limits!
========================================================= */

export async function sendBatchCampaignEmails(emails, subject, htmlTemplate, campaignId, baseUrl) {
  const BATCH_SIZE = 100;
  const results = [];

  console.log(`[BATCH SEND] Starting batch send: ${emails.length} emails using Resend batch API`);

  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    const chunk = emails.slice(i, i + BATCH_SIZE);

    const batchEmails = chunk.map(({ contact }) => {
      const email = contact.email;
      const firstName = contact.firstName || contact.name || email.split('@')[0];
      const lastName = contact.lastName || "";
      const company = contact.company || "";
      const title = contact.title || "";
      const location = contact.location || "";
      const fullName = contact.name || firstName;

      let personalizedHtml = htmlTemplate
        .replace(/\{\{name}}/g, fullName)
        .replace(/\{\{firstname}}/g, firstName)
        .replace(/\{\{lastname}}/g, lastName)
        .replace(/\{\{company}}/g, company)
        .replace(/\{\{title}}/g, title)
        .replace(/\{\{location}}/g, location)
        .replace(/\{\{email}}/g, email)
        .replace(/\/firstname/gi, firstName)
        .replace(/\/lastname/gi, lastName)
        .replace(/\/company/gi, company)
        .replace(/\/title/gi, title)
        .replace(/\/location/gi, location)
        .replace(/\/name/gi, fullName);

      const trackingPixel = `<img src="${baseUrl}/api/track/open/${campaignId}/${encodeURIComponent(email)}" width="1" height="1" style="display:none" alt="" />`;
      if (personalizedHtml.includes('</body>')) {
        personalizedHtml = personalizedHtml.replace('</body>', trackingPixel + '</body>');
      } else if (personalizedHtml.includes('</html>')) {
        personalizedHtml = personalizedHtml.replace('</html>', trackingPixel + '</html>');
      }

      const footer = generateCampaignFooter(baseUrl, campaignId, email);
      if (personalizedHtml.includes('</body>')) {
        personalizedHtml = personalizedHtml.replace('</body>', footer + '</body>');
      } else {
        personalizedHtml += footer;
      }

      return {
        from: "TechFest Canada <campaigns@thetechfestival.com>",
        to: [email],
        subject: subject,
        html: personalizedHtml,
      };
    });

    try {
      const result = await resend.batch.send(batchEmails);

      if (result.error) {
        console.error(`[BATCH SEND] Batch error:`, result.error);
        chunk.forEach(({ email }) => {
          results.push({ email, success: false, error: result.error.message });
        });
      } else {
        const sentCount = result.data?.length || 0;
        console.log(`[BATCH SEND] Batch ${Math.floor(i/BATCH_SIZE) + 1}: ${sentCount} emails sent`);
        result.data?.forEach((item) => {
          results.push({ email: item.email, success: true, id: item.id });
        });
      }
    } catch (err) {
      console.error(`[BATCH SEND] Exception:`, err.message);
      chunk.forEach(({ email }) => {
        results.push({ email, success: false, error: err.message });
      });
    }

    const progress = Math.min(i + BATCH_SIZE, emails.length);
    console.log(`[BATCH SEND] Progress: ${progress}/${emails.length}`);
  }

  const successCount = results.filter(r => r.success).length;
  console.log(`[BATCH SEND] Complete: ${successCount} success, ${results.length - successCount} failed`);

  return { results, successCount, failCount: results.length - successCount };
}

/* =========================================================
   TRACKED LINK WRAPPER
   Wraps URLs in HTML with click tracking
========================================================= */

export function wrapLinksWithTracking(html, campaignId, recipientEmail, baseUrl) {
  if (!html) return html;

  try {
    const trackedHtml = html.replace(
      /href=["'](https?:\/\/[^"']+)["']/gi,
      (match, url) => {
        const encodedUrl = encodeURIComponent(url);
        const trackingUrl = `${baseUrl}/api/track/click?url=${encodedUrl}&campaignId=${campaignId}&email=${encodeURIComponent(recipientEmail)}`;
        return `href="${trackingUrl}"`;
      }
    );
    return trackedHtml;
  } catch (err) {
    console.error("Error in wrapLinksWithTracking:", err);
    return html;
  }
}

/* =========================================================
   UNSUBSCRIBE CONFIRMATION EMAIL
======================================================== */

export async function sendUnsubscribeConfirmationEmail(email) {
  try {
    const baseUrl = process.env.FRONTEND_URL || "https://www.thetechfestival.com";

    await resend.emails.send({
      from: "TechFest Canada <campaigns@thetechfestival.com>",
      to: email,
      subject: "You've been unsubscribed from TechFest Canada",
      html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f4f0ff;font-family:Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:20px;">
    <div style="background:white;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.1);">
      <div style="background:linear-gradient(135deg,#7a3fd1,#f5a623);padding:40px 30px;text-align:center;">
        <h1 style="color:white;margin:0;font-size:24px;">The Tech Festival Canada</h1>
        <p style="color:rgba(255,255,255,0.9);margin:10px 0 0;font-size:14px;">Unsubscribe Confirmation</p>
      </div>

      <div style="padding:40px 30px;text-align:center;">
        <div style="font-size:48px;margin-bottom:20px;">✓</div>
        <h2 style="color:#333;margin:0 0 20px;">You've been unsubscribed</h2>
        <p style="color:#666;font-size:16px;line-height:1.6;">
          You've been successfully unsubscribed from The Tech Festival Canada emails.
        </p>
        <p style="color:#666;font-size:16px;line-height:1.6;">
          We're sorry to see you go! If you unsubscribed by mistake, you can always re-subscribe on our website.
        </p>

        <div style="margin-top:30px;">
          <a href="${baseUrl}" style="display:inline-block;background:linear-gradient(135deg,#7a3fd1,#f5a623);color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold;">
            Return to TechFest Canada
          </a>
        </div>
      </div>

      <div style="background:#1a1035;padding:30px;text-align:center;">
        <p style="color:rgba(255,255,255,0.6);font-size:12px;margin:0;">
          The Tech Festival Canada • Toronto, Ontario
        </p>
      </div>
    </div>
  </div>
</body>
</html>
      `
    });

    console.log("Unsubscribe confirmation email sent");
  } catch (err) {
    console.error("UNSUBSCRIBE CONFIRMATION EMAIL ERROR:", err);
  }
}

/* =========================================================
   SHARED CAMPAIGN EMAIL FOOTER
   Used by both campaigns.js and campaignAutomation.js
======================================================== */

/**
 * The sender line under marketing emails. Canada's anti-spam law (CASL) and CAN-SPAM need
 * the sender's postal address there: set MAIL_POSTAL_ADDRESS on Render, e.g.
 * "AtlasLink Markets Inc., 123 Example St, Suite 100, Toronto, ON M5V 1A1, Canada".
 */
export function campaignSenderLine(env = process.env) {
  const address = String(env.MAIL_POSTAL_ADDRESS || "").trim();
  if (!address) return "The Tech Festival Canada • Toronto, Ontario";
  const esc = address.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `The Tech Festival Canada • ${esc}`;
}

let warnedNoAddress = false;

export function generateCampaignFooter(baseUrl, campaignId, email) {
  if (!process.env.MAIL_POSTAL_ADDRESS && !warnedNoAddress) {
    warnedNoAddress = true;
    console.warn("MAIL_POSTAL_ADDRESS is not set: campaign emails need the sender's postal address (CASL / CAN-SPAM).");
  }
  const unsubscribeUrl = `${baseUrl}/api/track/unsubscribe/${campaignId}/${encodeURIComponent(email)}`;
  const viewBrowserUrl = `${baseUrl}/api/track/view/${campaignId}/${encodeURIComponent(email)}`;

  return `
    <div style="background:#1a1035;padding:20px;text-align:center;margin-top:20px;border-radius:0 0 12px 12px;">
      <p style="color:rgba(255,255,255,0.6);font-size:12px;margin:0;">
        ${campaignSenderLine()}
      </p>
      <p style="color:rgba(255,255,255,0.4);font-size:11px;margin:10px 0 0;">
        <a href="${unsubscribeUrl}" style="color:rgba(255,255,255,0.5);text-decoration:none;">Unsubscribe</a> | 
        <a href="${viewBrowserUrl}" style="color:rgba(255,255,255,0.5);text-decoration:none;">View in browser</a>
      </p>
    </div>
  `;
}
