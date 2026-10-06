/* =========================================================
   "Complete your profile" email — HTML + plain text
   ---------------------------------------------------------
   Pure builder (no Resend, no env) so it can be unit-tested and
   previewed in the admin panel. sendProfileRequestEmail() in
   services/emailService.js sends it.

   Same visual language as the ticket email (services/ticketEmail.js):
   table layout, inline styles, 600px max, bulletproof button, Apple
   Mail dark mode through the progressive <style> block.
========================================================= */

import { C, SANS, DISPLAY } from "./ticketEmail.js";
import { EVENT, displayPassName, escapeHtml as esc } from "./ticketInfo.js";

export const PROFILE_EMAIL_SUBJECT = "One minute to get the most out of TTFC 2026";

/**
 * @param {object} p
 * @param {string} [p.firstName] greeting ("" → "Hi there")
 * @param {string} [p.tier]      pass tier key (apex, power…)
 * @param {string} p.link        the attendee's signed /complete-profile link
 * @returns {{ subject: string, preheader: string, html: string, text: string }}
 */
export function buildProfileRequestEmail({ firstName = "", tier = "", link = "" } = {}) {
  const first = String(firstName || "").trim();
  const firstOk = first && first.toLowerCase() !== "guest" ? first : "";
  const pass = displayPassName(tier, "");
  const subject = PROFILE_EMAIL_SUBJECT;
  const preheader = "Tell us a little about you so we can match you with the right people, sessions and meetings on Oct 26–27.";
  const hello = firstOk ? `Hi ${esc(firstOk)},` : "Hi there,";

  const html = `<!DOCTYPE html>
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

<!-- message -->
<tr><td class="em-panel em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:34px 32px 8px;">
  <h1 class="em-ink em-h1" style="margin:0 0 14px;font-family:${SANS};font-size:28px;line-height:34px;font-weight:800;color:${C.ink};letter-spacing:-0.5px;">${hello}</h1>
  <p class="em-text" style="margin:0 0 14px;font-family:${SANS};font-size:16px;line-height:25px;color:${C.text};">Thanks for joining us at The Tech Festival Canada 2026. We'd love to know a little more about you, so we can match you with the right people, sessions and meetings at the event.</p>
  <p class="em-text" style="margin:0;font-family:${SANS};font-size:16px;line-height:25px;color:${C.text};">Your role, your organisation and what you're hoping to get out of the two days. <strong class="em-ink" style="color:${C.ink};">It takes about a minute.</strong></p>
</td></tr>

<!-- button -->
<tr><td class="em-panel em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:26px 32px 8px;" align="center">
  <table role="presentation" class="em-btn" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
    <tr><td align="center" bgcolor="${C.purple}" style="background:${C.purple};background-image:linear-gradient(135deg,${C.purple},${C.pink});border-radius:12px;">
      <a href="${esc(link)}" target="_blank" style="display:inline-block;padding:16px 34px;font-family:${SANS};font-size:17px;line-height:20px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:12px;">Complete my profile &rarr;</a>
    </td></tr>
  </table>
</td></tr>

<!-- pass -->
<tr><td class="em-panel em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:22px 32px 6px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.soft}" class="em-soft" style="background:${C.soft};border:1px solid ${C.hair};border-radius:12px;border-collapse:separate;">
    <tr>
      <td style="padding:14px 18px;font-family:${SANS};font-size:14px;line-height:21px;color:${C.text};" class="em-text">
        <span style="font-size:11px;line-height:14px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:${C.purple};">Your pass</span><br>
        <strong class="em-ink" style="color:${C.ink};">${esc(pass)}</strong> · ${esc(EVENT.dates)} · ${esc(EVENT.venue)}, Toronto
      </td>
    </tr>
  </table>
</td></tr>

<!-- privacy + fallback link -->
<tr><td class="em-panel em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:16px 32px 30px;">
  <p class="em-muted" style="margin:0 0 10px;font-family:${SANS};font-size:13px;line-height:20px;color:${C.muted};">Your answers are only shared with the TTFC organisers. You can update them any time with the same link.</p>
  <p class="em-muted" style="margin:0;font-family:${SANS};font-size:12px;line-height:18px;color:${C.muted};">Button not working? Copy this link into your browser:<br><a class="em-link" href="${esc(link)}" target="_blank" style="color:${C.purple};text-decoration:underline;word-break:break-all;">${esc(link)}</a></p>
</td></tr>

<!-- help footer -->
<tr><td bgcolor="${C.dark}" class="em-pad" style="background:${C.dark};padding:26px 32px;">
  <div style="font-family:${SANS};font-size:15px;line-height:22px;font-weight:700;color:#ffffff;margin:0 0 6px;">Need a hand?</div>
  <div style="font-family:${SANS};font-size:13px;line-height:20px;color:#c9bfe3;margin:0 0 16px;">Reply to this email or write to <a href="mailto:${EVENT.supportEmail}" style="color:#ffffff;text-decoration:underline;">${EVENT.supportEmail}</a>.</div>
  <div style="font-family:${SANS};font-size:12px;line-height:18px;color:#9d90c2;">
    <a href="${EVENT.website}" target="_blank" style="color:#ffffff;text-decoration:none;font-weight:600;">${EVENT.websiteLabel}</a>
    &nbsp;·&nbsp; <span style="white-space:nowrap;">${esc(EVENT.dates)}</span> &nbsp;·&nbsp; <span style="white-space:nowrap;">${esc(EVENT.venue)}</span>
  </div>
  <div style="height:1px;line-height:1px;font-size:0;background:#241640;margin:18px 0 14px;">&nbsp;</div>
  <div style="font-family:${SANS};font-size:11px;line-height:16px;color:#7f74a3;">You're receiving this because you hold a ticket for The Tech Festival Canada 2026. The Tech Festival Canada · Toronto, Ontario</div>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    firstOk ? `Hi ${firstOk},` : "Hi there,",
    "",
    "Thanks for joining us at The Tech Festival Canada 2026. We'd love to know a little more about you, so we can match you with the right people, sessions and meetings at the event.",
    "",
    "Your role, your organisation and what you're hoping to get out of the two days. It takes about a minute.",
    "",
    `Complete my profile: ${link}`,
    "",
    `Your pass: ${pass} · ${EVENT.dates} · ${EVENT.venue}, Toronto`,
    "",
    "Your answers are only shared with the TTFC organisers. You can update them any time with the same link.",
    "",
    `Need a hand? Reply to this email or write to ${EVENT.supportEmail}.`,
    EVENT.website,
    "",
    "You're receiving this because you hold a ticket for The Tech Festival Canada 2026.",
    "The Tech Festival Canada · Toronto, Ontario",
  ].join("\n");

  return { subject, preheader, html, text };
}
