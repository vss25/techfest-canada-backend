/* =========================================================
   "Your TTFC sign-in link" + "No ticket for this email" emails
   ---------------------------------------------------------
   Pure builders (no Resend, no env) so they can be unit-tested.
   routes/emailLink.js sends them through services/emailService.js.
   Same visual language as the ticket and profile emails: table
   layout, inline styles, 600px max, bulletproof button, Apple Mail
   dark mode through the progressive <style> block.
========================================================= */

import { C, SANS, DISPLAY, MONO } from "./ticketEmail.js";
import { EVENT, escapeHtml as esc } from "./ticketInfo.js";

export const SIGN_IN_SUBJECT = "Your TTFC sign-in link";
export const NO_TICKET_SUBJECT = "We couldn't find a TTFC ticket for this email";

function shell({ preheader, body, footerNote }) {
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
    .em-code { font-size:34px !important; letter-spacing:8px !important; }
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
  <div style="font-family:${SANS};font-size:15px;line-height:22px;font-weight:700;color:#ffffff;margin:0 0 6px;">Need a hand?</div>
  <div style="font-family:${SANS};font-size:13px;line-height:20px;color:#c9bfe3;margin:0 0 16px;">Write to <a href="mailto:${EVENT.supportEmail}" style="color:#ffffff;text-decoration:underline;">${EVENT.supportEmail}</a>.</div>
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

function button(href, label) {
  return `<table role="presentation" class="em-btn" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
    <tr><td align="center" bgcolor="${C.purple}" style="background:${C.purple};background-image:linear-gradient(135deg,${C.purple},${C.pink});border-radius:12px;">
      <a href="${esc(href)}" target="_blank" style="display:inline-block;padding:17px 38px;font-family:${SANS};font-size:18px;line-height:20px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:12px;">${label}</a>
    </td></tr>
  </table>`;
}

/**
 * @param {object} p
 * @param {string} p.link     ${FRONTEND_URL}/app-login?token=…
 * @param {string} p.code     the 6-digit code
 * @param {number} [p.minutes] how long it works (15)
 * @returns {{ subject, preheader, html, text }}
 */
export function buildSignInEmail({ link = "", code = "", minutes = 15 } = {}) {
  const subject = SIGN_IN_SUBJECT;
  const preheader = `Tap the button to sign in, or enter ${code} in the app. It works for ${minutes} minutes.`;
  const spaced = `${String(code).slice(0, 3)} ${String(code).slice(3)}`.trim();

  const body = `
<!-- message -->
<tr><td class="em-panel em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:34px 32px 8px;">
  <h1 class="em-ink em-h1" style="margin:0 0 14px;font-family:${SANS};font-size:28px;line-height:34px;font-weight:800;color:${C.ink};letter-spacing:-0.5px;">Sign in to TTFC 2026</h1>
  <p class="em-text" style="margin:0;font-family:${SANS};font-size:16px;line-height:25px;color:${C.text};">Tap the button below on your phone and you'll go straight into the TTFC app. No password needed.</p>
</td></tr>

<!-- button -->
<tr><td class="em-panel em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:26px 32px 8px;" align="center">
  ${button(link, "Sign in to TTFC &rarr;")}
</td></tr>

<!-- code -->
<tr><td class="em-panel em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:24px 32px 6px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.soft}" class="em-soft" style="background:${C.soft};border:1px solid ${C.hair};border-radius:12px;border-collapse:separate;">
    <tr><td align="center" style="padding:18px 18px 20px;">
      <div class="em-muted" style="font-family:${SANS};font-size:13px;line-height:18px;color:${C.muted};margin:0 0 8px;">Or enter this code in the app</div>
      <div class="em-ink em-code" style="font-family:${MONO};font-size:40px;line-height:46px;font-weight:700;letter-spacing:10px;color:${C.ink};">${esc(spaced)}</div>
    </td></tr>
  </table>
</td></tr>

<!-- expiry + fallback link -->
<tr><td class="em-panel em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:16px 32px 30px;">
  <p class="em-text" style="margin:0 0 10px;font-family:${SANS};font-size:14px;line-height:21px;color:${C.text};">The link and code work once, for the next <strong class="em-ink" style="color:${C.ink};">${esc(minutes)} minutes</strong>.</p>
  <p class="em-muted" style="margin:0 0 10px;font-family:${SANS};font-size:13px;line-height:20px;color:${C.muted};">Didn't ask to sign in? You can ignore this email. Nobody can get in without it.</p>
  <p class="em-muted" style="margin:0;font-family:${SANS};font-size:12px;line-height:18px;color:${C.muted};">Button not working? Copy this link into your browser:<br><a class="em-link" href="${esc(link)}" target="_blank" style="color:${C.purple};text-decoration:underline;word-break:break-all;">${esc(link)}</a></p>
</td></tr>`;

  const html = shell({
    preheader,
    body,
    footerNote: "You're receiving this because someone asked to sign in to TTFC 2026 with this email.",
  });

  const text = [
    "Sign in to TTFC 2026",
    "",
    "Open this link on your phone and you'll go straight into the TTFC app. No password needed.",
    "",
    `Sign in: ${link}`,
    "",
    `Or enter this code in the app: ${code}`,
    "",
    `The link and code work once, for the next ${minutes} minutes.`,
    "Didn't ask to sign in? You can ignore this email. Nobody can get in without it.",
    "",
    `Need a hand? Write to ${EVENT.supportEmail}.`,
    EVENT.website,
  ].join("\n");

  return { subject, preheader, html, text };
}

/**
 * Sent when nobody with this email has an account or a ticket.
 * @param {object} p
 * @param {string} p.email       the address that was entered
 * @param {string} p.ticketsUrl  ${FRONTEND_URL}/tickets
 */
export function buildNoTicketEmail({ email = "", ticketsUrl = `${EVENT.website}/tickets` } = {}) {
  const subject = NO_TICKET_SUBJECT;
  const preheader = "Try the email you used at checkout, or get your pass for Oct 26–27.";

  const body = `
<tr><td class="em-panel em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:34px 32px 8px;">
  <h1 class="em-ink em-h1" style="margin:0 0 14px;font-family:${SANS};font-size:26px;line-height:32px;font-weight:800;color:${C.ink};letter-spacing:-0.5px;">We couldn't find a ticket for this email</h1>
  <p class="em-text" style="margin:0 0 14px;font-family:${SANS};font-size:16px;line-height:25px;color:${C.text};">Someone asked for a TTFC sign-in link for <strong class="em-ink" style="color:${C.ink};">${esc(email)}</strong>, but there's no ticket under this address.</p>
  <p class="em-text" style="margin:0;font-family:${SANS};font-size:16px;line-height:25px;color:${C.text};">If you already have a pass, try the email you used at checkout. It's the one your ticket confirmation was sent to. You can also sign in with your ticket ID and last name.</p>
</td></tr>
<tr><td class="em-panel em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:26px 32px 8px;" align="center">
  ${button(ticketsUrl, "Get your pass &rarr;")}
</td></tr>
<tr><td class="em-panel em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:16px 32px 30px;">
  <p class="em-muted" style="margin:0;font-family:${SANS};font-size:13px;line-height:20px;color:${C.muted};">Didn't ask for this? You can ignore this email.</p>
</td></tr>`;

  const html = shell({
    preheader,
    body,
    footerNote: "You're receiving this because someone asked to sign in to TTFC 2026 with this email.",
  });

  const text = [
    "We couldn't find a ticket for this email",
    "",
    `Someone asked for a TTFC sign-in link for ${email}, but there's no ticket under this address.`,
    "",
    "If you already have a pass, try the email you used at checkout. It's the one your ticket confirmation was sent to. You can also sign in with your ticket ID and last name.",
    "",
    `Get your pass: ${ticketsUrl}`,
    "",
    "Didn't ask for this? You can ignore this email.",
    "",
    `Need a hand? Write to ${EVENT.supportEmail}.`,
  ].join("\n");

  return { subject, preheader, html, text };
}
