/* =========================================================
   Ticket confirmation email — HTML + plain text
   ---------------------------------------------------------
   Pure builder (no Resend, no env) so it can be unit-tested and
   previewed. sendTicketEmail() in services/emailService.js adds
   the signed links and the PDF attachment and sends it.

   Built for email clients, not browsers: table layout, inline
   styles, 600px max width, bulletproof buttons. The <style> block
   only adds progressive extras (mobile stacking, Apple Mail dark
   mode); everything still reads correctly where it is stripped.
========================================================= */

import {
  EVENT, APP_COMING_SOON, inclusionsFor, emailTips, displayPassName, isBoothId,
  firstNameFor, googleCalendarUrl, escapeHtml as esc,
} from "./ticketInfo.js";

const C = {
  bg: "#f3effa", panel: "#ffffff", dark: "#06020f", card: "#150a2b",
  purple: "#7a3fd1", pink: "#E8458B", gold: "#f5b942",
  ink: "#140a26", text: "#3a3350", muted: "#6b6480", hair: "#ece5f8", soft: "#f7f3ff",
};
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const DISPLAY = "Orbitron,'Arial Black',Arial,Helvetica,sans-serif";
const MONO = "'SFMono-Regular',Menlo,Consolas,'Courier New',monospace";

const label = (text, color = C.purple) =>
  `<div style="font-family:${SANS};font-size:11px;line-height:14px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:${color};">${esc(text)}</div>`;

const sectionTitle = (text) =>
  `<div class="em-ink" style="font-family:${DISPLAY};font-size:13px;line-height:18px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase;color:${C.ink};margin:0 0 14px;">${esc(text)}</div>`;

/** Black "Add to Apple Wallet" button in Apple's badge style (text version of the badge). */
export function walletButtonHtml(url) {
  if (!url) return "";
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
  <tr>
    <td align="center" bgcolor="#000000" style="background:#000000;border:1px solid #a6a6a6;border-radius:10px;">
      <a href="${esc(url)}" target="_blank" style="display:block;padding:10px 26px 11px;font-family:${SANS};color:#ffffff;text-decoration:none;text-align:center;">
        <span style="display:block;font-size:11px;line-height:13px;color:#ffffff;">Add to</span>
        <span style="display:block;font-size:19px;line-height:23px;font-weight:600;color:#ffffff;letter-spacing:-0.2px;">Apple Wallet</span>
      </a>
    </td>
  </tr>
</table>`;
}

/**
 * @param {object} p
 * @param {string} p.name       attendee full name
 * @param {string} [p.firstName] for the greeting (falls back to the first word of name)
 * @param {string} p.ticketId
 * @param {string} p.tier
 * @param {string} [p.walletUrl] signed /api/wallet/pass link ("" hides the button)
 * @param {string} [p.qrUrl]     signed /api/wallet/qr image link ("" hides the QR)
 * @returns {{ subject: string, preheader: string, html: string, text: string }}
 */
export function buildTicketEmail({ name, firstName, ticketId, tier, walletUrl = "", qrUrl = "" } = {}) {
  const id = String(ticketId || "");
  const booth = isBoothId(id);
  const pass = displayPassName(tier, id);
  const first = firstNameFor({ firstName, name });
  const fullName = String(name || "").trim() && String(name).trim().toLowerCase() !== "guest"
    ? String(name).trim() : (first || "Delegate");
  const wallet = booth ? "" : walletUrl;
  const qr = booth ? "" : qrUrl;
  const includes = booth ? [] : inclusionsFor(tier);
  const tips = booth ? [] : emailTips(tier);
  const cal = googleCalendarUrl();
  const pdfName = `ttfc-pass-${id}.pdf`;

  const subject = booth
    ? `Your TTFC 2026 ${pass} is confirmed`
    : `You're in — your TTFC 2026 ${pass} is confirmed 🎟`;
  const preheader = booth
    ? `${pass} confirmed for ${EVENT.dates} at ${EVENT.venue}, Toronto.`
    : `${pass} · ${EVENT.dates} · ${EVENT.venue}, Toronto. Your ticket PDF is attached${wallet ? " and it's ready for Apple Wallet" : ""}.`;

  const greeting = first ? `You're in, ${esc(first)}.` : "You're in.";
  const intro = booth
    ? `Your <strong class="em-ink" style="color:${C.ink};">${esc(pass)}</strong> at The Tech Festival Canada 2026 is confirmed. Your booking reference is below — our team will be in touch about exhibitor logistics.`
    : `Your <strong class="em-ink" style="color:${C.ink};">${esc(pass)}</strong> for The Tech Festival Canada 2026 is confirmed. Two days of frontier tech, deals and conversations at ${esc(EVENT.venue)}, Toronto — we can't wait to see you there.`;

  /* ---------- pass card ---------- */
  const qrCell = qr ? `
            <td class="em-stack em-qr" width="170" align="center" valign="middle" style="padding:22px 22px 22px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
                <tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:12px;padding:10px;">
                  <img src="${esc(qr)}" width="128" height="128" alt="Ticket QR code ${esc(id)}" style="display:block;width:128px;height:128px;border:0;outline:none;">
                </td></tr>
              </table>
              <div style="font-family:${SANS};font-size:11px;line-height:15px;color:#bfb2e6;margin-top:8px;text-align:center;">Scan at registration</div>
            </td>` : "";

  const card = `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.card}" style="background:${C.card};border:1px solid #2c1b4f;border-radius:16px;border-collapse:separate;">
  <tr>
    <td height="5" bgcolor="${C.pink}" style="height:5px;line-height:5px;font-size:0;border-radius:16px 16px 0 0;background:${C.pink};background-image:linear-gradient(90deg,${C.purple},${C.pink} 60%,${C.gold});">&nbsp;</td>
  </tr>
  <tr>
    <td style="padding:0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td class="em-stack" valign="top" style="padding:22px 24px;">
            ${label(booth ? "Booked by" : "Attendee", "#bfa6f2")}
            <div style="font-family:${SANS};font-size:22px;line-height:28px;font-weight:700;color:#ffffff;margin:4px 0 14px;">${esc(fullName)}</div>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td bgcolor="${C.purple}" style="background:${C.purple};background-image:linear-gradient(90deg,${C.purple},${C.pink});border-radius:999px;padding:7px 16px;font-family:${DISPLAY};font-size:12px;line-height:14px;font-weight:800;letter-spacing:1.3px;color:#ffffff;text-transform:uppercase;white-space:nowrap;">${esc(pass)}</td>
            </tr></table>
            <div style="height:16px;line-height:16px;font-size:0;">&nbsp;</div>
            ${label(booth ? "Booking reference" : "Ticket ID", "#bfa6f2")}
            <div style="font-family:${MONO};font-size:18px;line-height:24px;font-weight:700;letter-spacing:1.5px;color:${C.gold};margin-top:3px;">${esc(id)}</div>
            <div style="font-family:${SANS};font-size:13px;line-height:19px;color:#d6cbf3;margin-top:12px;">${esc(EVENT.dates)} · ${esc(EVENT.venue)}, Toronto</div>
          </td>${qrCell}
        </tr>
      </table>
    </td>
  </tr>
</table>`;

  /* ---------- wallet + attachment ---------- */
  const walletBlock = wallet ? `
<tr><td class="em-panel em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:22px 32px 4px;" align="center">
  ${walletButtonHtml(wallet)}
  <div class="em-muted" style="font-family:${SANS};font-size:12px;line-height:17px;color:${C.muted};margin-top:8px;text-align:center;">On iPhone, tap to add your pass — it pops up on your lock screen at the venue.</div>
</td></tr>` : "";

  const attachBlock = `
<tr><td class="em-panel em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:20px 32px 6px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.soft}" class="em-soft" style="background:${C.soft};border:1px solid ${C.hair};border-radius:12px;border-collapse:separate;">
    <tr>
      <td width="34" valign="top" style="padding:16px 0 16px 14px;font-size:22px;line-height:24px;">📎</td>
      <td style="padding:16px 18px 16px 10px;font-family:${SANS};font-size:14px;line-height:21px;color:${C.text};" class="em-text">
        <strong class="em-ink" style="color:${C.ink};">Your ticket PDF is attached</strong> (${esc(pdfName)}).
        ${booth ? "Keep it for your records." : "Show the QR code on your phone or print it — either works at registration."}
      </td>
    </tr>
  </table>
</td></tr>`;

  /* ---------- includes ---------- */
  const includesBlock = includes.length ? `
<tr><td class="em-panel em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:26px 32px 4px;">
  ${sectionTitle(`Your ${pass} includes`)}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    ${includes.map((f) => `<tr>
      <td width="26" valign="top" style="padding:0 0 9px;font-family:${SANS};font-size:15px;line-height:20px;font-weight:700;color:${C.purple};">&#10003;</td>
      <td class="em-text" style="padding:0 0 9px;font-family:${SANS};font-size:15px;line-height:20px;color:${C.text};${/lounge|pre-matched|preferential/i.test(f) ? "font-weight:600;" : ""}">${esc(f)}</td>
    </tr>`).join("")}
  </table>
</td></tr>` : "";

  /* ---------- event details ---------- */
  const row = (k, v) => `<tr>
      <td width="92" valign="top" style="padding:0 0 12px;">${label(k)}</td>
      <td class="em-text" valign="top" style="padding:0 0 12px;font-family:${SANS};font-size:15px;line-height:21px;color:${C.text};">${v}</td>
    </tr>`;
  const detailsBlock = `
<tr><td class="em-panel em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:22px 32px 4px;">
  <div class="em-rule" style="height:1px;line-height:1px;font-size:0;background:${C.hair};margin:0 0 22px;">&nbsp;</div>
  ${sectionTitle("Event details")}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    ${row("When", `<strong class="em-ink" style="color:${C.ink};">Monday–Tuesday, ${esc(EVENT.dates)}</strong>`)}
    ${row("Where", `<strong class="em-ink" style="color:${C.ink};">${esc(EVENT.venue)}</strong><br>${esc(EVENT.address)}<br><a href="${esc(EVENT.mapsUrl)}" target="_blank" style="color:${C.purple};text-decoration:underline;">Open in Maps</a>`)}
    ${row("Doors", esc(EVENT.doors))}
  </table>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 4px;">
    <tr><td style="border:2px solid ${C.purple};border-radius:10px;">
      <a href="${esc(cal)}" target="_blank" style="display:inline-block;padding:10px 20px;font-family:${SANS};font-size:14px;line-height:18px;font-weight:700;color:${C.purple};text-decoration:none;">&#128197;&nbsp; Add to Google Calendar</a>
    </td></tr>
  </table>
</td></tr>`;

  const tipsBlock = tips.length ? `
<tr><td class="em-panel em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:22px 32px 4px;">
  ${sectionTitle("Know before you go")}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    ${tips.map((t) => `<tr>
      <td width="20" valign="top" style="padding:0 0 9px;font-family:${SANS};font-size:15px;line-height:21px;color:${C.pink};">&#9679;</td>
      <td class="em-text" style="padding:0 0 9px;font-family:${SANS};font-size:14px;line-height:21px;color:${C.text};">${esc(t)}</td>
    </tr>`).join("")}
  </table>
</td></tr>` : "";

  /* ---------- app coming soon ---------- */
  const appBlock = `
<tr><td class="em-panel em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:22px 32px 30px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.dark}" style="background:${C.dark};background-image:linear-gradient(90deg,${C.dark},#2b0f5c);border-radius:14px;border-collapse:separate;">
    <tr>
      <td width="64" valign="middle" style="padding:18px 0 18px 18px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td width="46" height="46" align="center" valign="middle" bgcolor="${C.purple}" style="width:46px;height:46px;background:${C.purple};background-image:linear-gradient(135deg,${C.purple},${C.pink});border-radius:12px;font-size:22px;line-height:46px;">&#128241;</td>
        </tr></table>
      </td>
      <td valign="middle" style="padding:18px 20px 18px 14px;">
        ${label("Coming soon to the App Store", C.gold)}
        <div style="font-family:${DISPLAY};font-size:15px;line-height:21px;font-weight:800;color:#ffffff;margin:3px 0 4px;letter-spacing:0.5px;">The TTFC mobile app</div>
        <div style="font-family:${SANS};font-size:13px;line-height:19px;color:#d6cbf3;">${esc(APP_COMING_SOON.body)}</div>
      </td>
    </tr>
  </table>
</td></tr>`;

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
    .em-stack { display:block !important; width:100% !important; box-sizing:border-box; }
    .em-qr { padding:0 24px 22px !important; text-align:left !important; }
    .em-h1 { font-size:26px !important; line-height:32px !important; }
  }
  @media (prefers-color-scheme: dark) {
    .em-bg { background:#0c0618 !important; }
    .em-panel { background:#140a26 !important; }
    .em-soft { background:#1d1035 !important; border-color:#2e1d52 !important; }
    .em-ink { color:#ffffff !important; }
    .em-text { color:#ddd3f5 !important; }
    .em-muted { color:#a99cc9 !important; }
    .em-rule { background:#2c1b4f !important; }
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

<!-- greeting -->
<tr><td class="em-panel em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:34px 32px 22px;">
  <h1 class="em-ink em-h1" style="margin:0 0 12px;font-family:${SANS};font-size:30px;line-height:36px;font-weight:800;color:${C.ink};letter-spacing:-0.5px;">${greeting}</h1>
  <p class="em-text" style="margin:0;font-family:${SANS};font-size:16px;line-height:25px;color:${C.text};">${intro}</p>
</td></tr>

<!-- pass card -->
<tr><td class="em-panel em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:0 32px;">${card}</td></tr>
${walletBlock}
${attachBlock}
${includesBlock}
${detailsBlock}
${tipsBlock}
${appBlock}

<!-- help footer -->
<tr><td bgcolor="${C.dark}" class="em-pad" style="background:${C.dark};padding:28px 32px;">
  <div style="font-family:${SANS};font-size:15px;line-height:22px;font-weight:700;color:#ffffff;margin:0 0 6px;">Need a hand?</div>
  <div style="font-family:${SANS};font-size:13px;line-height:20px;color:#c9bfe3;margin:0 0 16px;">Reply to this email or write to <a href="mailto:${EVENT.supportEmail}" style="color:#ffffff;text-decoration:underline;">${EVENT.supportEmail}</a>. Quote your ticket ID <span style="font-family:${MONO};color:${C.gold};">${esc(id)}</span> so we can find your booking fast.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="font-family:${SANS};font-size:12px;line-height:18px;color:#9d90c2;">
      <a href="${EVENT.website}" target="_blank" style="color:#ffffff;text-decoration:none;font-weight:600;">${EVENT.websiteLabel}</a>
      &nbsp;·&nbsp; <span style="white-space:nowrap;">Office ${EVENT.phone}</span> &nbsp;·&nbsp; <span style="white-space:nowrap;">Toll free ${EVENT.tollFree}</span>
    </td>
  </tr></table>
  <div style="height:1px;line-height:1px;font-size:0;background:#241640;margin:18px 0 14px;">&nbsp;</div>
  <div style="font-family:${SANS};font-size:11px;line-height:16px;color:#7f74a3;">You're receiving this because a ticket for The Tech Festival Canada 2026 was purchased with this email address. The Tech Festival Canada · Toronto, Ontario</div>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

  /* ---------- plain text ---------- */
  const lines = [
    first ? `You're in, ${first}.` : "You're in.",
    "",
    booth
      ? `Your ${pass} at The Tech Festival Canada 2026 is confirmed.`
      : `Your ${pass} for The Tech Festival Canada 2026 is confirmed.`,
    "",
    `${booth ? "Booked by" : "Attendee"}: ${fullName}`,
    `Pass: ${pass}`,
    `${booth ? "Booking reference" : "Ticket ID"}: ${id}`,
    "",
    `Your ticket PDF is attached (${pdfName}).${booth ? "" : " Show its QR code on your phone or printed at registration."}`,
    ...(wallet ? ["", `Add to Apple Wallet: ${wallet}`] : []),
    ...(includes.length ? ["", `YOUR ${pass.toUpperCase()} INCLUDES`, ...includes.map((f) => `  - ${f}`)] : []),
    "",
    "EVENT DETAILS",
    `  When:  Monday–Tuesday, ${EVENT.dates}`,
    `  Where: ${EVENT.venue}, ${EVENT.address}`,
    `  Doors: ${EVENT.doors}`,
    `  Add to Google Calendar: ${cal}`,
    ...(tips.length ? ["", "KNOW BEFORE YOU GO", ...tips.map((t) => `  - ${t}`)] : []),
    "",
    APP_COMING_SOON.title.toUpperCase(),
    `  ${APP_COMING_SOON.body}`,
    "",
    `Questions? Reply to this email or write to ${EVENT.supportEmail}.`,
    `${EVENT.website} · ${EVENT.phone} · Toll free ${EVENT.tollFree}`,
    "",
    "The Tech Festival Canada · Toronto, Ontario",
  ];

  return { subject, preheader, html, text: lines.join("\n") };
}
