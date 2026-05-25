import { Resend } from "resend";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";

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
   HELPER: Capitalize first letter for display
========================================================= */

function formatTier(tier) {
  if (!tier || typeof tier !== "string") return "Standard";
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

/* =========================================================
   HELPER: GENERATE TICKET PDF
   Branded delegate pass with header, body, QR code, footer
========================================================= */

async function generateTicketPDF({ name, ticketId, tier }) {
  return new Promise(async (resolve, reject) => {
    try {
      if (!ticketId) {
        throw new Error("Ticket ID missing when generating QR code");
      }

      const tierDisplay = formatTier(tier);

      // Letter size, no auto margins — we control everything manually
      const doc = new PDFDocument({
        size: "LETTER",
        margin: 0,
        info: {
          Title: `TTFC ${tierDisplay} Pass - ${ticketId}`,
          Author: "The Tech Festival Canada",
          Subject: "Official Delegate Pass",
        },
      });

      const buffers = [];
      doc.on("data", buffers.push.bind(buffers));
      doc.on("end", () => resolve(Buffer.concat(buffers)));
      doc.on("error", reject);

      // Page dimensions for Letter: 612 x 792 points
      const PAGE_W = 612;
      const PAGE_H = 792;

      // Brand palette
      const PURPLE = "#7a3fd1";
      const ORANGE = "#f5a623";
      const PINK = "#ec4899";
      const DARK = "#1a1035";
      const SOFT_BG = "#f8f5ff";
      const BORDER = "#ece4ff";
      const TEXT = "#333333";
      const MUTED = "#6b6580";

      /* ----------- HEADER: Gradient banner ----------- */
      const headerHeight = 150;
      const headerGrad = doc.linearGradient(0, 0, PAGE_W, headerHeight);
      headerGrad
        .stop(0, PURPLE)
        .stop(0.55, PINK)
        .stop(1, ORANGE);
      doc.rect(0, 0, PAGE_W, headerHeight).fill(headerGrad);

      // Stylized "TTFC" wordmark — replace with doc.image() if a logo file is available
      doc
        .fillColor("#ffffff")
        .font("Helvetica-Bold")
        .fontSize(42)
        .text("TTFC", 50, 45, { characterSpacing: 4 });

      doc
        .fillColor("rgba(255,255,255,0.92)")
        .font("Helvetica")
        .fontSize(11)
        .text("THE TECH FESTIVAL CANADA", 50, 95, { characterSpacing: 2 });

      // Right-aligned "OFFICIAL PASS" tag
      doc
        .fillColor("rgba(255,255,255,0.85)")
        .font("Helvetica-Bold")
        .fontSize(10)
        .text("OFFICIAL DELEGATE PASS", 0, 60, {
          align: "right",
          width: PAGE_W - 50,
          characterSpacing: 1.5,
        });

      doc
        .fillColor("rgba(255,255,255,0.7)")
        .font("Helvetica")
        .fontSize(9)
        .text("26 & 27 OCTOBER 2026", 0, 80, {
          align: "right",
          width: PAGE_W - 50,
          characterSpacing: 1,
        });

      /* ----------- BODY: Delegate info ----------- */
      let y = headerHeight + 50;

      doc
        .fillColor(MUTED)
        .font("Helvetica")
        .fontSize(10)
        .text("ATTENDEE", 50, y, { characterSpacing: 1.5 });

      y += 18;
      doc
        .fillColor(DARK)
        .font("Helvetica-Bold")
        .fontSize(28)
        .text(name || "Guest", 50, y);

      y += 50;

      // Info card with two columns: Pass Type | Ticket ID
      const cardX = 50;
      const cardW = PAGE_W - 100;
      const cardH = 110;

      doc
        .roundedRect(cardX, y, cardW, cardH, 10)
        .fillAndStroke(SOFT_BG, BORDER);

      // Left column: Pass Type
      doc
        .fillColor(PURPLE)
        .font("Helvetica-Bold")
        .fontSize(9)
        .text("PASS TYPE", cardX + 24, y + 22, { characterSpacing: 1.5 });

      doc
        .fillColor(DARK)
        .font("Helvetica-Bold")
        .fontSize(18)
        .text(tierDisplay, cardX + 24, y + 40);

      // Right column: Ticket ID
      const rightColX = cardX + cardW / 2 + 10;
      doc
        .fillColor(PURPLE)
        .font("Helvetica-Bold")
        .fontSize(9)
        .text("TICKET ID", rightColX, y + 22, { characterSpacing: 1.5 });

      doc
        .fillColor(DARK)
        .font("Courier-Bold")
        .fontSize(16)
        .text(String(ticketId), rightColX, y + 40);

      // Divider line inside card
      doc
        .moveTo(cardX + 24, y + 75)
        .lineTo(cardX + cardW - 24, y + 75)
        .strokeColor(BORDER)
        .lineWidth(1)
        .stroke();

      // Venue line at the bottom of card
      doc
        .fillColor(MUTED)
        .font("Helvetica")
        .fontSize(9)
        .text("VENUE", cardX + 24, y + 86, { characterSpacing: 1.5 });

      doc
        .fillColor(TEXT)
        .font("Helvetica-Bold")
        .fontSize(11)
        .text("The Westin Harbour Castle, Toronto", cardX + 80, y + 86);

      y += cardH + 40;

      /* ----------- QR CODE BLOCK ----------- */
      const qrData = await QRCode.toDataURL(String(ticketId), {
        errorCorrectionLevel: "H",
        margin: 1,
        width: 400,
      });
      const base64 = qrData.replace(/^data:image\/png;base64,/, "");
      const qrBuffer = Buffer.from(base64, "base64");

      const qrSize = 160;
      const qrX = (PAGE_W - qrSize) / 2;

      // Subtle background plate behind QR
      doc
        .roundedRect(qrX - 16, y - 16, qrSize + 32, qrSize + 32, 8)
        .fillAndStroke("#ffffff", BORDER);

      doc.image(qrBuffer, qrX, y, { width: qrSize, height: qrSize });

      y += qrSize + 24;

      doc
        .fillColor(DARK)
        .font("Helvetica-Bold")
        .fontSize(12)
        .text("Present this QR code at event check-in", 0, y, {
          align: "center",
          width: PAGE_W,
        });

      y += 18;
      doc
        .fillColor(MUTED)
        .font("Helvetica")
        .fontSize(10)
        .text("Please have this pass ready on your phone or printed.", 0, y, {
          align: "center",
          width: PAGE_W,
        });

      /* ----------- FOOTER: Contact strip pinned to bottom ----------- */
      const footerHeight = 90;
      const footerY = PAGE_H - footerHeight;

      doc.rect(0, footerY, PAGE_W, footerHeight).fill(DARK);

      // Top accent line on footer (mini gradient)
      const accentGrad = doc.linearGradient(0, footerY, PAGE_W, footerY);
      accentGrad.stop(0, PURPLE).stop(0.5, PINK).stop(1, ORANGE);
      doc.rect(0, footerY, PAGE_W, 3).fill(accentGrad);

      // Left side: brand
      doc
        .fillColor("#ffffff")
        .font("Helvetica-Bold")
        .fontSize(11)
        .text("The Tech Festival Canada", 50, footerY + 22);

      doc
        .fillColor("rgba(255,255,255,0.55)")
        .font("Helvetica")
        .fontSize(9)
        .text("Toronto, Ontario", 50, footerY + 40);

      doc
        .fillColor("rgba(255,255,255,0.7)")
        .font("Helvetica")
        .fontSize(9)
        .text("enquire@thetechfestival.com", 50, footerY + 58);

      // Right side: phone numbers
      const phoneX = PAGE_W / 2 + 20;
      doc
        .fillColor("rgba(255,255,255,0.55)")
        .font("Helvetica")
        .fontSize(8)
        .text("OFFICE", phoneX, footerY + 18, { characterSpacing: 1.2 });

      doc
        .fillColor("#ffffff")
        .font("Helvetica-Bold")
        .fontSize(10)
        .text("+1 647 946 4643", phoneX, footerY + 30);

      doc
        .fillColor("rgba(255,255,255,0.55)")
        .font("Helvetica")
        .fontSize(8)
        .text("TOLL FREE", phoneX, footerY + 50, { characterSpacing: 1.2 });

      doc
        .fillColor("#ffffff")
        .font("Helvetica-Bold")
        .fontSize(10)
        .text("+1 844 TTFC 001  /  +1 844 8832 001", phoneX, footerY + 62);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
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
   Web Summit-inspired clean layout with TTFC branding
========================================================= */

export async function sendTicketEmail({ email, name, ticketId, tier }) {

  try {

    const tierDisplay = formatTier(tier);

    const pdfBuffer = await generateTicketPDF({
      name,
      ticketId,
      tier
    });

    await resend.emails.send({

      from: "TechFest Canada <tickets@thetechfestival.com>",

      to: email,

      subject: `Your TTFC ${tierDisplay} Pass is confirmed 🎟`,

      html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f4f0ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1035;">
  <div style="max-width:620px;margin:0 auto;padding:24px 16px;">
    <div style="background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 6px 30px rgba(26,16,53,0.08);">

      <!-- HEADER BANNER -->
      <div style="background:linear-gradient(135deg,#7a3fd1 0%,#ec4899 55%,#f5a623 100%);padding:56px 36px;">
        <div style="color:#ffffff;font-size:34px;font-weight:800;letter-spacing:4px;line-height:1;margin:0 0 10px;">TTFC</div>
        <div style="color:rgba(255,255,255,0.92);font-size:12px;letter-spacing:2px;text-transform:uppercase;">The Tech Festival Canada</div>
      </div>

      <!-- BODY -->
      <div style="padding:44px 36px 36px;">

        <p style="color:#1a1035;font-size:17px;margin:0 0 18px;">Hi ${name},</p>

        <p style="color:#444;font-size:15px;line-height:1.65;margin:0 0 14px;">
          Thanks for grabbing your <strong>TTFC ${tierDisplay} Pass</strong> for The Tech Festival Canada 2026. We're really glad you're coming — it's going to be two big days in Toronto.
        </p>

        <p style="color:#444;font-size:15px;line-height:1.65;margin:0 0 28px;">
          Your order reference is <strong style="font-family:'Courier New',Courier,monospace;color:#7a3fd1;">${ticketId}</strong>. Your official delegate pass is attached to this email as a PDF — keep it handy, you'll need the QR code on it at check-in.
        </p>

        <!-- EVENT DETAILS CARD -->
        <div style="background:#f8f5ff;border:1px solid #ece4ff;border-radius:12px;padding:24px 26px;margin:0 0 32px;">

          <div style="margin:0 0 18px;">
            <div style="color:#7a3fd1;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;margin:0 0 6px;">When</div>
            <div style="color:#1a1035;font-size:18px;font-weight:700;">26 & 27 October 2026</div>
          </div>

          <div style="margin:0 0 18px;">
            <div style="color:#7a3fd1;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;margin:0 0 6px;">Where</div>
            <div style="color:#1a1035;font-size:16px;font-weight:600;line-height:1.4;">The Westin Harbour Castle<br><span style="color:#555;font-weight:500;font-size:14px;">Toronto, Ontario</span></div>
          </div>

          <div style="border-top:1px solid #ece4ff;padding-top:18px;">
            <div style="color:#7a3fd1;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;margin:0 0 6px;">Your Pass</div>
            <div style="color:#333;font-size:14px;line-height:1.6;">
              <strong>Type:</strong> ${tierDisplay}<br>
              <strong>Ticket ID:</strong> <span style="font-family:'Courier New',Courier,monospace;">${ticketId}</span>
            </div>
          </div>

        </div>

        <!-- CTA -->
        <div style="text-align:center;margin:0 0 36px;">
          <a href="https://www.thetechfestival.com"
             style="display:inline-block;background:linear-gradient(135deg,#7a3fd1 0%,#ec4899 55%,#f5a623 100%);color:#ffffff;padding:15px 36px;border-radius:30px;text-decoration:none;font-weight:700;font-size:14px;letter-spacing:0.5px;">
            Visit thetechfestival.com
          </a>
        </div>

        <p style="color:#666;font-size:14px;line-height:1.6;margin:0 0 8px;">
          If you have any questions, just hit reply — we read every message.
        </p>

        <p style="color:#666;font-size:14px;line-height:1.6;margin:0;">
          – The TTFC team
        </p>

      </div>

      <!-- CONTACT FOOTER -->
      <div style="background:#1a1035;padding:30px 36px;">

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
          <tr>
            <td style="vertical-align:top;padding-right:12px;">
              <div style="color:rgba(255,255,255,0.55);font-size:10px;letter-spacing:1.2px;text-transform:uppercase;margin:0 0 6px;">Office</div>
              <div style="color:#ffffff;font-size:13px;font-weight:600;margin:0 0 14px;">+1 647 946 4643</div>

              <div style="color:rgba(255,255,255,0.55);font-size:10px;letter-spacing:1.2px;text-transform:uppercase;margin:0 0 6px;">Toll Free</div>
              <div style="color:#ffffff;font-size:13px;font-weight:600;line-height:1.5;">
                +1 844 TTFC 001<br>
                +1 844 8832 001
              </div>
            </td>
            <td style="vertical-align:top;text-align:right;">
              <div style="color:rgba(255,255,255,0.55);font-size:10px;letter-spacing:1.2px;text-transform:uppercase;margin:0 0 6px;">Email</div>
              <a href="mailto:enquire@thetechfestival.com" style="color:#ffffff;font-size:13px;font-weight:600;text-decoration:none;">enquire@thetechfestival.com</a>
            </td>
          </tr>
        </table>

        <div style="border-top:1px solid rgba(255,255,255,0.12);margin:24px 0 0;padding-top:18px;text-align:center;">
          <p style="color:rgba(255,255,255,0.5);font-size:11px;margin:0;">
            The Tech Festival Canada • Toronto, Ontario
          </p>
        </div>

      </div>

    </div>
  </div>
</body>
</html>
      `,

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

export function generateCampaignFooter(baseUrl, campaignId, email) {
  const unsubscribeUrl = `${baseUrl}/api/track/unsubscribe/${campaignId}/${encodeURIComponent(email)}`;
  const viewBrowserUrl = `${baseUrl}/api/track/view/${campaignId}/${encodeURIComponent(email)}`;

  return `
    <div style="background:#1a1035;padding:20px;text-align:center;margin-top:20px;border-radius:0 0 12px 12px;">
      <p style="color:rgba(255,255,255,0.6);font-size:12px;margin:0;">
        The Tech Festival Canada • Toronto, Ontario
      </p>
      <p style="color:rgba(255,255,255,0.4);font-size:11px;margin:10px 0 0;">
        <a href="${unsubscribeUrl}" style="color:rgba(255,255,255,0.5);text-decoration:none;">Unsubscribe</a> | 
        <a href="${viewBrowserUrl}" style="color:rgba(255,255,255,0.5);text-decoration:none;">View in browser</a>
      </p>
    </div>
  `;
}
