/* =========================================================
   Speaker Pass email — HTML + plain text
   ---------------------------------------------------------
   A personal welcome with the speaker's pass: name, title,
   company, dates, venue, ticket ID and the check-in QR code
   (TECHFEST:<ticketId>), what the pass includes and a personal
   RSVP link that opens the RSVP page already filled in.

   Pure builder (buildSpeakerPassEmail) so it can be tested and
   previewed. Images are passed in as `src` strings:
     - sending: "cid:…" inline attachments (Gmail blocks data: URIs),
       see speakerPassAttachments();
     - admin preview / local demo: data: URIs.
   Every value is HTML-escaped. Email-safe: tables, inline styles,
   600px max; the <style> block only adds mobile stacking.
========================================================= */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import QRCode from "qrcode";
import { EVENT, escapeHtml as esc } from "./ticketInfo.js";
import { speakerFirstName, rsvpNameParts, SPEAKER_PASS_LABEL } from "./speakerPasses.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_FILE = path.join(__dirname, "..", "assets", "email", "ttfc-logo.png");

export const QR_CID = "ttfc-speaker-qr";
export const LOGO_CID = "ttfc-logo";
export const RSVP_URL = "https://www.thetechfestival.com/rsvp";
export const CONTACT_EMAIL = "enquire@thetechfestival.com";
export const FROM = "The Tech Festival Canada <noreply@thetechfestival.com>";

export const C = {
  bg: "#06020f", card: "#120827", cardEdge: "#2b1a4f", panel: "#0d0620",
  purple: "#7a3fd1", magenta: "#e8458b", orange: "#f5a623",
  white: "#ffffff", text: "#ddd5ef", muted: "#a596c7", dim: "#7d6fa0", hair: "#251845",
};
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',Times,serif";
const MONO = "'SFMono-Regular',Menlo,Consolas,'Courier New',monospace";

/** What a Speaker Pass includes (email + plain text). */
export const SPEAKER_INCLUDES = [
  ["All-access, both days", "Every keynote, stage and the expo floor"],
  ["CxO breakfasts & luncheons", "Every one, on both days"],
  ["The Gala Dinner", "Dinner and networking reception"],
  ["Catalyst Awards Night", "Celebrating Canada's frontier tech"],
  ["The VIP Lounge", "A quiet space to prepare and connect"],
];

/** Why speakers should RSVP (shown above the button and in the plain text). */
export const RSVP_REASON = "RSVP for the CxO breakfasts, luncheons, the Gala Dinner and the Catalyst Awards Night, so we can save your seat and plan catering.";

export const qrPayload = (ticketId) => `TECHFEST:${String(ticketId || "").trim()}`;
/** Shown to people: upper case reads better and sign-in ignores case. */
export const displayTicketId = (ticketId) => String(ticketId || "").trim().toUpperCase();

/**
 * The speaker's personal RSVP link. The details go in the URL fragment (#…), which
 * browsers never send to the server, so the ticket ID stays out of server logs,
 * analytics and Referer headers. The RSVP page reads it, then clears it.
 */
export function personalRsvpUrl(name, ticketId) {
  const { first, last } = rsvpNameParts(name);
  const enc = encodeURIComponent;
  return `${RSVP_URL}#t=${enc(displayTicketId(ticketId))}&fn=${enc(first)}&ln=${enc(last)}`;
}

/** PNG of the check-in QR (TECHFEST:<ticketId>), dark on white. */
export function speakerQrPng(ticketId) {
  return QRCode.toBuffer(qrPayload(ticketId), {
    type: "png", errorCorrectionLevel: "M", margin: 1, width: 360,
    color: { dark: C.bg, light: "#ffffff" },
  });
}

let logoCache = null;
export function logoPng() {
  if (!logoCache) logoCache = fs.readFileSync(LOGO_FILE);
  return logoCache;
}

const dataUri = (buf) => `data:image/png;base64,${Buffer.from(buf).toString("base64")}`;

/** Image sources for a preview or local file (data: URIs). */
export async function inlineImageSrcs(ticketId) {
  return { qrSrc: dataUri(await speakerQrPng(ticketId)), logoSrc: dataUri(logoPng()) };
}

/** Image sources + Resend attachments for a real send (inline CID images). */
export async function speakerPassAttachments(ticketId) {
  const qr = await speakerQrPng(ticketId);
  return {
    srcs: { qrSrc: `cid:${QR_CID}`, logoSrc: `cid:${LOGO_CID}` },
    attachments: [
      { filename: "ttfc-speaker-pass-qr.png", content: qr.toString("base64"), content_type: "image/png", content_id: QR_CID },
      { filename: "ttfc-2026.png", content: logoPng().toString("base64"), content_type: "image/png", content_id: LOGO_CID },
    ],
  };
}

/* ---------- pieces ---------- */

const stripe = (height = 4) => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
  <tr>
    <td width="40%" height="${height}" bgcolor="${C.purple}" style="background:${C.purple};font-size:0;line-height:0;height:${height}px;">&nbsp;</td>
    <td width="35%" height="${height}" bgcolor="${C.magenta}" style="background:${C.magenta};font-size:0;line-height:0;height:${height}px;">&nbsp;</td>
    <td width="25%" height="${height}" bgcolor="${C.orange}" style="background:${C.orange};font-size:0;line-height:0;height:${height}px;">&nbsp;</td>
  </tr>
</table>`;

const eyebrow = (text, color = C.muted) =>
  `<div style="font-family:${SANS};font-size:10px;line-height:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${color};">${esc(text)}</div>`;

const sectionTitle = (text) =>
  `<div style="font-family:${SANS};font-size:12px;line-height:16px;font-weight:800;letter-spacing:2.4px;text-transform:uppercase;color:${C.orange};margin:0 0 18px;">${esc(text)}</div>`;

function button(href, label) {
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">
  <tr>
    <td align="center" bgcolor="${C.magenta}" style="border-radius:999px;background:${C.magenta};background-image:linear-gradient(90deg,${C.purple} 0%,${C.magenta} 55%,${C.orange} 100%);">
      <a href="${esc(href)}" target="_blank" style="display:inline-block;padding:14px 30px;font-family:${SANS};font-size:15px;line-height:18px;font-weight:700;letter-spacing:0.3px;color:#ffffff;text-decoration:none;border-radius:999px;">${esc(label)}</a>
    </td>
  </tr>
</table>`;
}

/** The pass card: a badge-style ticket that reads well in every client. */
function passCard({ name, title, company, id, qrSrc, logoSrc }) {
  const role = [title, company].filter(Boolean);
  const detail = (label, value, extra = "") => `
            <tr><td style="padding:0 0 14px;">
              ${eyebrow(label, C.dim)}
              <div style="font-family:${SANS};font-size:14px;line-height:20px;font-weight:600;color:${C.white};${extra}">${value}</div>
            </td></tr>`;
  return `
<table role="presentation" class="pass" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.card}" style="border-collapse:separate;background:${C.card};background-image:linear-gradient(160deg,#1f0d43 0%,${C.card} 45%,#0b0518 100%);border:1px solid ${C.cardEdge};border-radius:18px;overflow:hidden;box-shadow:0 24px 60px rgba(122,63,209,0.28);">
  <tr><td style="border-radius:18px 18px 0 0;overflow:hidden;font-size:0;line-height:0;">${stripe(6)}</td></tr>
  <tr>
    <td style="padding:22px 28px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td valign="middle" style="font-family:${SANS};font-size:13px;line-height:16px;font-weight:800;letter-spacing:2.6px;color:${C.white};">
            ${logoSrc ? `<img src="${esc(logoSrc)}" width="104" height="59" alt="The Tech Festival Canada" style="display:block;width:104px;height:auto;border:0;outline:none;">` : "TTFC 2026"}
          </td>
          <td valign="middle" align="right">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">
              <tr><td bgcolor="${C.magenta}" style="background:${C.magenta};background-image:linear-gradient(90deg,${C.magenta} 0%,${C.orange} 100%);border-radius:999px;padding:7px 14px;font-family:${SANS};font-size:11px;line-height:13px;font-weight:800;letter-spacing:2.4px;color:#ffffff;white-space:nowrap;">SPEAKER PASS</td></tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td style="padding:26px 28px 6px;">
      ${eyebrow("Presented to", C.orange)}
      <div class="pass-name" style="font-family:${SANS};font-size:32px;line-height:38px;font-weight:800;letter-spacing:-0.4px;color:${C.white};margin:6px 0 0;">${esc(name)}</div>
      ${role.length ? `<div style="font-family:${SANS};font-size:15px;line-height:22px;color:${C.text};margin:6px 0 0;">${role.map((r, i) => (i ? `<span style="color:${C.muted};">${esc(r)}</span>` : esc(r))).join(`<br>`)}</div>` : ""}
    </td>
  </tr>
  <tr>
    <td style="padding:18px 28px 0;">
      <div style="border-top:1px dashed #3a2766;font-size:0;line-height:0;height:1px;">&nbsp;</div>
    </td>
  </tr>
  <tr>
    <td style="padding:20px 28px 24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td class="stack" valign="top" style="padding:0 16px 0 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              ${detail("Dates", esc(EVENT.dates))}
              ${detail("Venue", `${esc(EVENT.venue)}<br><span style="font-weight:400;color:${C.muted};">${esc(EVENT.city.replace(", Ontario", ""))}</span>`)}
              ${detail("Ticket ID", esc(id), `font-family:${MONO};font-size:17px;letter-spacing:2px;color:${C.white};`)}
              ${detail("Access", "All access")}
            </table>
          </td>
          <td class="stack qr" valign="top" align="right" width="170" style="width:170px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="right" style="border-collapse:separate;">
              <tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:14px;padding:10px;">
                <img src="${esc(qrSrc)}" width="150" height="150" alt="Check-in QR code for ticket ${esc(id)}" style="display:block;width:150px;height:150px;border:0;outline:none;">
              </td></tr>
              <tr><td align="center" style="padding:10px 0 0;font-family:${SANS};font-size:11px;line-height:14px;letter-spacing:1px;color:${C.muted};">Scan at registration</td></tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td bgcolor="${C.panel}" style="background:${C.panel};border-top:1px solid ${C.hair};padding:13px 28px;font-family:${SANS};font-size:10px;line-height:14px;font-weight:700;letter-spacing:2px;color:${C.dim};text-transform:uppercase;">
      The Tech Festival Canada &middot; Toronto &middot; ${esc(EVENT.datesShort)}
    </td>
  </tr>
</table>`;
}

/**
 * @param {object} p
 * @param {string} p.name       the speaker's public name ("Dr. Rulan S. Parekh")
 * @param {string} [p.title]
 * @param {string} [p.company]
 * @param {string} p.ticketId
 * @param {string} p.qrSrc      "cid:…" for sending, a data: URI for previews
 * @param {string} [p.logoSrc]  same; "" shows a text wordmark
 * @returns {{ subject: string, preheader: string, html: string, text: string }}
 */
export function buildSpeakerPassEmail({ name, title = "", company = "", ticketId, qrSrc = "", logoSrc = "" } = {}) {
  const fullName = String(name || "").replace(/\s+/g, " ").trim();
  const first = speakerFirstName(fullName) || "there";
  const id = displayTicketId(ticketId);
  const rsvpLink = personalRsvpUrl(fullName, id);
  const t = String(title || "").replace(/\s+/g, " ").trim();
  const co = String(company || "").replace(/\s+/g, " ").trim();

  const subject = `${first}, your Speaker Pass for TTFC 2026`;
  const preheader = `We're delighted to have you speaking at TTFC 2026. Your all-access pass, ticket ID and personal RSVP link are inside.`;

  const includes = SPEAKER_INCLUDES.map(([head, sub]) => `
              <tr>
                <td valign="top" width="22" style="padding:3px 0 14px;"><div style="width:8px;height:8px;border-radius:2px;background:${C.magenta};background-image:linear-gradient(135deg,${C.purple},${C.magenta} 60%,${C.orange});font-size:0;line-height:0;margin-top:5px;">&nbsp;</div></td>
                <td valign="top" style="padding:0 0 14px;font-family:${SANS};">
                  <div style="font-size:15px;line-height:21px;font-weight:700;color:${C.white};">${esc(head)}</div>
                  <div style="font-size:13px;line-height:19px;color:${C.muted};">${esc(sub)}</div>
                </td>
              </tr>`).join("");

  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${esc(subject)}</title>
<style>
  body { margin:0; padding:0; background:${C.bg}; }
  a { color:${C.white}; }
  @media only screen and (max-width:620px) {
    .wrap { width:100% !important; }
    .pad { padding-left:22px !important; padding-right:22px !important; }
    .stack { display:block !important; width:100% !important; padding:0 !important; }
    .qr { padding-top:6px !important; }
    .qr table { float:none !important; margin:0 auto !important; }
    .hero { font-size:30px !important; line-height:36px !important; }
    .pass-name { font-size:26px !important; line-height:32px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${C.bg};" bgcolor="${C.bg}">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.bg};opacity:0;">${esc(preheader)}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.bg}" style="background:${C.bg};">
  <tr>
    <td align="center" style="padding:0;">
      <table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
        <tr><td>${stripe(4)}</td></tr>

        <!-- Greeting -->
        <tr>
          <td class="pad" style="padding:44px 44px 8px;background-image:radial-gradient(ellipse at 85% 0%,rgba(122,63,209,0.35) 0%,rgba(6,2,15,0) 60%);">
            ${eyebrow("The Tech Festival Canada 2026", C.muted)}
            <div style="font-family:${SERIF};font-size:20px;line-height:28px;font-style:italic;color:${C.text};margin:26px 0 6px;">Dear ${esc(first)},</div>
            <div class="hero" style="font-family:${SANS};font-size:36px;line-height:42px;font-weight:800;letter-spacing:-0.8px;color:${C.white};margin:0 0 18px;">We're delighted to have you speaking at TTFC&nbsp;2026.</div>
            <div style="font-family:${SANS};font-size:16px;line-height:26px;color:${C.text};margin:0;">
              The conversations that shape Canada's frontier tech happen because people like you take the stage.
              We look forward to welcoming you to Toronto on ${esc(EVENT.dates)}, and the whole festival is open to you.
              Your personal Speaker Pass is below.
            </div>
          </td>
        </tr>

        <!-- Pass -->
        <tr>
          <td class="pad" style="padding:30px 44px 8px;">
            ${passCard({ name: fullName, title: t, company: co, id, qrSrc, logoSrc })}
          </td>
        </tr>

        <!-- Included -->
        <tr>
          <td class="pad" style="padding:40px 44px 6px;">
            ${sectionTitle("Your pass includes")}
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${includes}
            </table>
          </td>
        </tr>

        <tr><td class="pad" style="padding:6px 44px 0;"><div style="border-top:1px solid ${C.hair};font-size:0;line-height:0;height:1px;">&nbsp;</div></td></tr>

        <!-- RSVP -->
        <tr>
          <td class="pad" style="padding:36px 44px 4px;">
            ${sectionTitle("Save your seat")}
            <div style="font-family:${SANS};font-size:15px;line-height:24px;color:${C.text};margin:0 0 20px;">${esc(RSVP_REASON)}</div>
            ${button(rsvpLink, "RSVP now")}
            <div style="font-family:${SANS};font-size:12px;line-height:18px;color:${C.dim};margin:12px 0 0;">Your link opens the RSVP page with your details already filled in.</div>
          </td>
        </tr>

        <!-- Contact -->
        <tr>
          <td class="pad" style="padding:40px 44px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.panel}" style="background:${C.panel};border:1px solid ${C.hair};border-radius:14px;border-collapse:separate;">
              <tr><td style="padding:20px 24px;font-family:${SANS};font-size:14px;line-height:22px;color:${C.text};">
                <span style="color:${C.white};font-weight:700;">Questions, travel or session details?</span><br>
                Reply to this email or write to <a href="mailto:${CONTACT_EMAIL}" style="color:${C.white};font-weight:600;">${CONTACT_EMAIL}</a>. We're glad to help.
              </td></tr>
            </table>
          </td>
        </tr>

        <!-- Sign-off -->
        <tr>
          <td class="pad" style="padding:34px 44px 40px;">
            <div style="font-family:${SERIF};font-size:17px;line-height:26px;font-style:italic;color:${C.text};">With thanks, and see you in Toronto,</div>
            <div style="font-family:${SANS};font-size:15px;line-height:22px;font-weight:700;color:${C.white};margin-top:6px;">The Tech Festival Canada team</div>
          </td>
        </tr>

        <tr><td>${stripe(2)}</td></tr>
        <tr>
          <td class="pad" align="center" style="padding:22px 44px 40px;font-family:${SANS};font-size:12px;line-height:19px;color:${C.dim};">
            ${esc(EVENT.name)} &middot; ${esc(EVENT.dates)}<br>
            ${esc(EVENT.venue)}, ${esc(EVENT.address)}<br>
            <span style="color:#5f527f;">This pass and your RSVP link are personal to you. Please keep your ticket ID to yourself.</span>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const role = [t, co].filter(Boolean).join(", ");
  const text = [
    `Dear ${first},`,
    "",
    "We're delighted to have you speaking at TTFC 2026.",
    "",
    `The conversations that shape Canada's frontier tech happen because people like you take the stage. We look forward to welcoming you to Toronto on ${EVENT.dates}, and the whole festival is open to you. Your personal Speaker Pass is below.`,
    "",
    `YOUR ${SPEAKER_PASS_LABEL.toUpperCase()}`,
    `  ${fullName}${role ? `\n  ${role}` : ""}`,
    `  Dates:     ${EVENT.dates}`,
    `  Venue:     ${EVENT.venue}, ${EVENT.address}`,
    `  Ticket ID: ${id}`,
    "  Access:    All access",
    "  Your check-in QR code is in the HTML version of this email.",
    "",
    "YOUR PASS INCLUDES",
    ...SPEAKER_INCLUDES.map(([head, sub]) => `  - ${head}: ${sub}`),
    "",
    "SAVE YOUR SEAT",
    `  ${RSVP_REASON}`,
    `  Your personal RSVP link (your details are already filled in):`,
    `  ${rsvpLink}`,
    "",
    `Questions, travel or session details? Reply to this email or write to ${CONTACT_EMAIL}.`,
    "",
    "With thanks, and see you in Toronto,",
    "The Tech Festival Canada team",
    "",
    `${EVENT.name} · ${EVENT.dates}`,
    `${EVENT.venue}, ${EVENT.address}`,
    "This pass and your RSVP link are personal to you. Please keep your ticket ID to yourself.",
  ].join("\n");

  return { subject, preheader, html, text };
}

/** Subject/html/text for one pass. `inline: true` uses data: URIs (admin preview, local demo). */
export async function speakerPassEmailFor(pass, { inline = true } = {}) {
  const base = { name: pass.name, title: pass.title, company: pass.company, ticketId: pass.ticketId };
  if (inline) return { ...buildSpeakerPassEmail({ ...base, ...(await inlineImageSrcs(pass.ticketId)) }), attachments: [] };
  const { srcs, attachments } = await speakerPassAttachments(pass.ticketId);
  return { ...buildSpeakerPassEmail({ ...base, ...srcs }), attachments };
}
