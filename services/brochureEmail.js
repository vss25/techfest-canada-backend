/* =========================================================
   Brochure emails — "Your TTFC 2026 brochure" + sales receipt
   ---------------------------------------------------------
   Pure builders (no Resend, no env) so they can be unit-tested
   (test/brochure-downloads.test.js). routes/brochure.js sends them
   through services/emailService.js.

   Same visual language as the ticket, profile and sign-in emails:
   table layout, inline styles, 600px max, bulletproof button, Apple
   Mail dark mode through the progressive <style> block.
========================================================= */

import { C, SANS, DISPLAY } from "./ticketEmail.js";
import { EVENT, escapeHtml as esc } from "./ticketInfo.js";
import { SALES_INBOX } from "./brochureDownloads.js";

export const BROCHURE_SUBJECT = "Your TTFC 2026 brochure";

const torontoTime = (d) =>
  new Date(d || Date.now()).toLocaleString("en-CA", {
    timeZone: "America/Toronto", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });

function button(href, label) {
  return `<table role="presentation" class="em-btn" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
    <tr><td align="center" bgcolor="${C.purple}" style="background:${C.purple};background-image:linear-gradient(135deg,${C.purple},${C.pink});border-radius:12px;">
      <a href="${esc(href)}" target="_blank" style="display:inline-block;padding:17px 38px;font-family:${SANS};font-size:18px;line-height:20px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:12px;">${label}</a>
    </td></tr>
  </table>`;
}

function shell({ preheader, body, footerNote, helpEmail = "" }) {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>
  body { margin:0; padding:0; -webkit-text-size-adjust:100%; }
  a[x-apple-data-detectors] { color:inherit !important; text-decoration:none !important; }
  @media only screen and (max-width:620px) {
    .em-pad { padding-left:20px !important; padding-right:20px !important; }
    .em-h1 { font-size:26px !important; line-height:32px !important; }
    .em-btn a { display:block !important; }
  }
  @media (prefers-color-scheme: dark) {
    .em-bg { background:#0c0618 !important; }
    .em-panel { background:#140a26 !important; }
    .em-soft { background:#1d1035 !important; border-color:#2e1d52 !important; }
    .em-ink { color:#ffffff !important; }
    .em-text { color:#ddd3f5 !important; }
    .em-muted { color:#a99cc9 !important; }
    .em-link { color:#c9b8f2 !important; }
  }
</style>
</head>
<body class="em-bg" style="margin:0;padding:0;background:${C.bg};" bgcolor="${C.bg}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${C.bg};">${esc(preheader)}&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;</div>
<table role="presentation" class="em-bg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.bg}" style="background:${C.bg};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border-radius:18px;overflow:hidden;">

<!-- header -->
<tr><td bgcolor="${C.dark}" class="em-pad" style="background:${C.dark};background-image:radial-gradient(circle at 90% 0%,rgba(122,63,209,0.55),rgba(6,2,15,0) 60%);padding:28px 32px 26px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td valign="middle">
      <div style="font-family:${DISPLAY};font-size:24px;line-height:28px;font-weight:800;letter-spacing:2px;color:#ffffff;">TTFC 2026</div>
      <div style="font-family:${SANS};font-size:10px;line-height:14px;font-weight:600;letter-spacing:2.4px;color:#c9b8f2;margin-top:4px;">THE TECH FESTIVAL CANADA</div>
    </td>
    <td valign="middle" align="right" style="font-family:${SANS};font-size:11px;line-height:15px;font-weight:700;letter-spacing:1.6px;color:${C.gold};text-align:right;">OCT 26–27<br><span style="color:#c9b8f2;font-weight:600;">TORONTO</span></td>
  </tr></table>
</td></tr>
<tr><td height="4" bgcolor="${C.pink}" style="height:4px;line-height:4px;font-size:0;background:${C.pink};background-image:linear-gradient(90deg,${C.purple},${C.pink} 60%,${C.gold});">&nbsp;</td></tr>

${body}

<!-- help footer -->
<tr><td bgcolor="${C.dark}" class="em-pad" style="background:${C.dark};padding:26px 32px;">
  ${helpEmail ? `<div style="font-family:${SANS};font-size:15px;line-height:22px;font-weight:700;color:#ffffff;margin:0 0 6px;">Questions about sponsoring or exhibiting?</div>
  <div style="font-family:${SANS};font-size:13px;line-height:20px;color:#c9bfe3;margin:0 0 16px;">Reply to this email or write to <a href="mailto:${esc(helpEmail)}" style="color:#ffffff;text-decoration:underline;">${esc(helpEmail)}</a>.</div>` : ""}
  <div style="font-family:${SANS};font-size:12px;line-height:18px;color:#9d90c2;">
    <a href="${EVENT.website}" target="_blank" style="color:#ffffff;text-decoration:none;font-weight:600;">${EVENT.websiteLabel}</a>
    &nbsp;·&nbsp; <span style="white-space:nowrap;">${esc(EVENT.dates)}</span> &nbsp;·&nbsp; <span style="white-space:nowrap;">${esc(EVENT.venue)}</span>
  </div>
  <div style="height:1px;line-height:1px;font-size:0;background:#241640;margin:18px 0 14px;">&nbsp;</div>
  <div style="font-family:${SANS};font-size:11px;line-height:16px;color:#7f74a3;">${esc(footerNote)} The Tech Festival Canada · Toronto, Ontario</div>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

/**
 * Sent to the person who downloaded the brochure.
 * @param {object} p
 * @param {string} [p.firstName]
 * @param {object} p.brochure   entry from BROCHURES
 * @param {string} p.link       public URL of the PDF
 * @param {boolean} [p.attached] the PDF is attached to this email
 * @returns {{ subject, preheader, html, text }}
 */
export function buildBrochureEmail({ firstName = "", brochure, link = "", attached = false } = {}) {
  const first = String(firstName || "").trim();
  const hello = first ? `Hi ${esc(first)},` : "Hi there,";
  const title = brochure?.title || "TTFC 2026 brochure";
  const subject = BROCHURE_SUBJECT;
  const preheader = attached
    ? `Your copy of the ${title} is attached, with a download link if you need it again.`
    : `Here's your download link for the ${title}.`;
  const how = attached
    ? "Your copy is attached to this email. You can also download it again any time with the button below."
    : "Download your copy any time with the button below.";

  const body = `
<!-- message -->
<tr><td class="em-panel em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:34px 32px 8px;">
  <p class="em-text" style="margin:0 0 12px;font-family:${SANS};font-size:16px;line-height:25px;color:${C.text};">${hello}</p>
  <h1 class="em-ink em-h1" style="margin:0 0 14px;font-family:${SANS};font-size:28px;line-height:34px;font-weight:800;color:${C.ink};letter-spacing:-0.5px;">Your TTFC 2026 brochure</h1>
  <p class="em-text" style="margin:0 0 14px;font-family:${SANS};font-size:16px;line-height:25px;color:${C.text};">Thanks for your interest in <strong class="em-ink" style="color:${C.ink};">${esc(EVENT.name)}</strong>, ${esc(EVENT.dates)} at ${esc(EVENT.venue)}, Toronto.</p>
  <p class="em-text" style="margin:0;font-family:${SANS};font-size:16px;line-height:25px;color:${C.text};">${how}</p>
</td></tr>

<!-- button -->
<tr><td class="em-panel em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:26px 32px 8px;" align="center">
  ${button(link, "Download the brochure &rarr;")}
</td></tr>

<!-- what's inside + fallback link -->
<tr><td class="em-panel em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:24px 32px 30px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.soft}" class="em-soft" style="background:${C.soft};border:1px solid ${C.hair};border-radius:12px;border-collapse:separate;">
    <tr><td style="padding:16px 18px;">
      <div class="em-ink" style="font-family:${SANS};font-size:14px;line-height:20px;font-weight:700;color:${C.ink};">${esc(title)}</div>
      <div class="em-muted" style="font-family:${SANS};font-size:13px;line-height:19px;color:${C.muted};margin-top:2px;">PDF${brochure?.pages ? ` · ${esc(brochure.pages)} pages` : ""} · Sponsorship, exhibiting and delegate opportunities</div>
    </td></tr>
  </table>
  <p class="em-muted" style="margin:16px 0 0;font-family:${SANS};font-size:12px;line-height:18px;color:${C.muted};">Button not working? Copy this link into your browser:<br><a class="em-link" href="${esc(link)}" target="_blank" style="color:${C.purple};text-decoration:underline;word-break:break-all;">${esc(link)}</a></p>
</td></tr>`;

  const html = shell({
    preheader,
    body,
    helpEmail: SALES_INBOX,
    footerNote: "You're receiving this because this email was entered to download a brochure on thetechfestival.com.",
  });

  const text = [
    first ? `Hi ${first},` : "Hi there,",
    "",
    "Your TTFC 2026 brochure",
    "",
    `Thanks for your interest in ${EVENT.name}, ${EVENT.dates} at ${EVENT.venue}, Toronto.`,
    attached ? "Your copy is attached to this email. You can also download it again here:" : "Download your copy here:",
    link,
    "",
    `Questions about sponsoring or exhibiting? Reply to this email or write to ${SALES_INBOX}.`,
    EVENT.website,
  ].join("\n");

  return { subject, preheader, html, text };
}

const DELIVERY_LABEL = {
  attached: "Sent, with the PDF attached",
  link: "Sent, with a download link",
  failed: "Not delivered (email failed)",
};

/**
 * Receipt for the sales team: who downloaded which brochure, when.
 * @param {object} p
 * @param {object} p.lead      the saved download (firstName, lastName, email, company, jobTitle, industry, phone, page, referrer, createdAt)
 * @param {object} p.brochure  entry from BROCHURES
 * @param {string} [p.delivery] "attached" | "link" | "failed"
 * @returns {{ subject, preheader, html, text }}
 */
export function buildBrochureReceiptEmail({ lead = {}, brochure, delivery = "" } = {}) {
  const name = [lead.firstName, lead.lastName].filter(Boolean).join(" ") || lead.email || "Someone";
  const title = brochure?.title || lead.brochure || "Brochure";
  const when = torontoTime(lead.createdAt);
  const subject = `Brochure download: ${name}${lead.company ? `, ${lead.company}` : ""}`.replace(/[\r\n]+/g, " ").slice(0, 200);
  const preheader = `${name} downloaded the ${title} on ${when} (Toronto).`;

  const delivered = DELIVERY_LABEL[delivery] || "Not sent";
  const mail = (e) => `<a href="mailto:${esc(e)}" style="color:${C.purple};text-decoration:none;">${esc(e)}</a>`;
  // [label, plain text, optional html]
  const rows = [
    ["Name", name],
    ["Email", lead.email, mail(lead.email)],
    ["Company", lead.company],
    ["Job title", lead.jobTitle],
    ["Industry", lead.industry],
    ["Phone", lead.phone],
    ["Brochure", title],
    ["When", `${when} (Toronto)`],
    ["Page", lead.page],
    ["Came from", lead.referrer],
    ["Brochure email", delivered],
  ];

  const body = `
<tr><td class="em-panel em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:30px 32px 8px;">
  <div style="font-family:${SANS};font-size:11px;line-height:14px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:${C.purple};">Brochure download</div>
  <h1 class="em-ink em-h1" style="margin:8px 0 0;font-family:${SANS};font-size:24px;line-height:30px;font-weight:800;color:${C.ink};letter-spacing:-0.3px;">${esc(name)}${lead.company ? ` <span class="em-muted" style="color:${C.muted};font-weight:600;">· ${esc(lead.company)}</span>` : ""}</h1>
</td></tr>
<tr><td class="em-panel em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:16px 32px 30px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
    ${rows.map(([k, plain, rich]) => `<tr>
      <td class="em-muted" style="padding:9px 14px 9px 0;border-bottom:1px solid ${C.hair};font-family:${SANS};font-size:12px;line-height:18px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:${C.muted};white-space:nowrap;vertical-align:top;">${k}</td>
      <td class="em-text" style="padding:9px 0;border-bottom:1px solid ${C.hair};font-family:${SANS};font-size:15px;line-height:22px;color:${C.text};word-break:break-word;">${rich || esc(plain) || "&mdash;"}</td>
    </tr>`).join("")}
  </table>
  <p class="em-muted" style="margin:18px 0 0;font-family:${SANS};font-size:12px;line-height:18px;color:${C.muted};">Reply to this email to reach ${esc(name)} directly. Every download is also listed in Admin → Brochure downloads.</p>
</td></tr>`;

  const html = shell({
    preheader,
    body,
    footerNote: "Automatic receipt from the brochure form on thetechfestival.com.",
  });

  const text = [
    `Brochure download: ${title}`,
    "",
    ...rows.map(([k, plain]) => `${k}: ${plain || "-"}`),
    "",
    `Reply to this email to reach ${name} directly.`,
  ].join("\n");

  return { subject, preheader, html, text };
}
