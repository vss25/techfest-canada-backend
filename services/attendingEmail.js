/* =========================================================
   "Show the world you're attending" email: HTML + plain text
   ---------------------------------------------------------
   Sent to every ticket holder (routes/attendingCampaign.js). A short,
   warm note, a preview of the "I'm attending" image and a big button
   to their personal page:
     https://www.thetechfestival.com/attending#fn=…&ln=…&title=…&co=…

   Pure builder (buildAttendingEmail) so it can be tested and previewed.
   Real sends (sendAttendingEmail with `track`) also carry a signed token
   for that address (services/trackToken.js): in the link (#…&r=) and in a
   1×1 open pixel at the end. Previews and test sends carry neither.
   Images come in as `src` strings, like the Speaker Pass email:
     - sending: "cid:…" inline attachments (Gmail blocks data: URIs);
     - admin preview / local demo: data: URIs.
   The preview image is a static sample card (assets/email/
   attending-preview.jpg, drawn by the website's own card renderer).
   Every value is HTML-escaped. Email-safe: tables, inline styles,
   600px max; the <style> block only adds mobile tweaks.
   After "How it works": the "Get the TTFC app" block (App Store and
   Google Play, services/appStoreBlock.js; Oct 23 2026).
========================================================= */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Resend } from "resend";
import { EVENT, escapeHtml as esc } from "./ticketInfo.js";
import { CAMPAIGN_KEY, attendingLink, greetingName } from "./attendingCampaign.js";
import { pixelUrlFor, signTrack, withPixel } from "./trackToken.js";
import { noteTrackedSend } from "./engagementStore.js";
import { unsubscribeFor } from "./unsubscribe.js";
import { appStoreBlockCss, appStoreBlockHtml, appStoreBlockLines } from "./appStoreBlock.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_FILE = path.join(__dirname, "..", "assets", "email", "ttfc-logo.png");
const PREVIEW_FILE = path.join(__dirname, "..", "assets", "email", "attending-preview.jpg");

export const LOGO_CID = "ttfc-logo";
export const PREVIEW_CID = "ttfc-attending-preview";
export const CONTACT_EMAIL = "enquire@thetechfestival.com";
/* "I'm attending" (the campaign, single sends and the LinkedIn nudges) comes from marcom@ (Oct 20 2026, the
   organiser: "I am attending campaign will be sent through Marcomm, everything else through enquire"); replies
   and unsubscribe requests go there too. Questions in the email itself still point to enquire@. */
export const MARCOM_EMAIL = "marcom@thetechfestival.com";
export const FROM = `The Tech Festival Canada <${MARCOM_EMAIL}>`;

export const C = {
  bg: "#06020f", card: "#120827", cardEdge: "#2b1a4f", panel: "#0d0620",
  purple: "#7a3fd1", magenta: "#e8458b", orange: "#f5a623",
  white: "#ffffff", text: "#ddd5ef", muted: "#a596c7", dim: "#7d6fa0", hair: "#251845",
};
export const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
export const SERIF = "Georgia,'Times New Roman',Times,serif";

/* ---------- images ---------- */

const cache = new Map();
const readOnce = (file) => {
  if (!cache.has(file)) cache.set(file, fs.readFileSync(file));
  return cache.get(file);
};
export const logoPng = () => readOnce(LOGO_FILE);
export const previewJpg = () => readOnce(PREVIEW_FILE);

/** data: URIs, for the admin preview and local demos. */
export function inlineImageSrcs() {
  return {
    logoSrc: `data:image/png;base64,${logoPng().toString("base64")}`,
    previewSrc: `data:image/jpeg;base64,${previewJpg().toString("base64")}`,
  };
}

/** cid: sources + Resend attachments, for a real send. */
export function attendingAttachments() {
  return {
    srcs: { logoSrc: `cid:${LOGO_CID}`, previewSrc: `cid:${PREVIEW_CID}` },
    attachments: [
      { filename: "ttfc-2026.png", content: logoPng().toString("base64"), content_type: "image/png", content_id: LOGO_CID },
      { filename: "im-attending-ttfc-2026.jpg", content: previewJpg().toString("base64"), content_type: "image/jpeg", content_id: PREVIEW_CID },
    ],
  };
}

/* ---------- pieces ---------- */

export const stripe = (height = 4) => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
  <tr>
    <td width="40%" height="${height}" bgcolor="${C.purple}" style="background:${C.purple};font-size:0;line-height:0;height:${height}px;">&nbsp;</td>
    <td width="35%" height="${height}" bgcolor="${C.magenta}" style="background:${C.magenta};font-size:0;line-height:0;height:${height}px;">&nbsp;</td>
    <td width="25%" height="${height}" bgcolor="${C.orange}" style="background:${C.orange};font-size:0;line-height:0;height:${height}px;">&nbsp;</td>
  </tr>
</table>`;

export const eyebrow = (text, color = C.muted) =>
  `<div style="font-family:${SANS};font-size:10px;line-height:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${color};">${esc(text)}</div>`;

export function button(href, label) {
  return `
<table role="presentation" class="btn" cellpadding="0" cellspacing="0" border="0" align="center" style="border-collapse:separate;margin:0 auto;">
  <tr>
    <td align="center" bgcolor="${C.magenta}" style="border-radius:999px;background:${C.magenta};background-image:linear-gradient(90deg,${C.purple} 0%,${C.magenta} 55%,${C.orange} 100%);box-shadow:0 12px 30px rgba(232,69,139,0.35);">
      <a href="${esc(href)}" target="_blank" style="display:inline-block;padding:18px 38px;font-family:${SANS};font-size:17px;line-height:20px;font-weight:800;letter-spacing:0.3px;color:#ffffff;text-decoration:none;border-radius:999px;">${esc(label)}</a>
    </td>
  </tr>
</table>`;
}

/**
 * @param {object} p
 * @param {string} [p.firstName]
 * @param {string} [p.lastName]
 * @param {string} [p.title]
 * @param {string} [p.company]
 * @param {string} [p.link]        defaults to their personal /attending link
 * @param {string} [p.logoSrc]     "cid:…" or a data: URI ("" = text wordmark)
 * @param {string} [p.previewSrc]  same ("" = no preview image)
 * @param {string} [p.pixelSrc]    a real send's open pixel ("" = none)
 * @param {string} [p.unsubscribeUrl] the footer's unsubscribe link (services/unsubscribe.js; "" = "Reply with unsubscribe")
 * @returns {{ subject, preheader, html, text, link }}
 */
export function buildAttendingEmail({ firstName = "", lastName = "", title = "", company = "", link = "", logoSrc = "", previewSrc = "", pixelSrc = "", unsubscribeUrl = "" } = {}) {
  const first = greetingName({ firstName, lastName });
  const url = link || attendingLink({ firstName, lastName, title, company });
  const subject = first ? `${first}, show the world you're attending TTFC 2026` : "Show the world you're attending TTFC 2026";
  const preheader = "Your personal \"I'm attending\" image for LinkedIn is ready to make. It takes about a minute.";
  const filled = [title && "title", company && "company"].filter(Boolean);
  const detailsLine = filled.length
    ? `Your name, ${filled.join(" and ")} are already filled in. Change anything you like.`
    : "Your name is already filled in. Add your title and company if you like.";

  const step = (n, color, head, body) => `
              <tr>
                <td valign="top" width="44" style="padding:0 0 18px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr>
                    <td align="center" valign="middle" width="30" height="30" style="width:30px;height:30px;border-radius:15px;border:1px solid ${color};font-family:${SANS};font-size:13px;font-weight:800;color:${color};">${n}</td>
                  </tr></table>
                </td>
                <td valign="top" style="padding:3px 0 18px;font-family:${SANS};">
                  <div style="font-size:15px;line-height:21px;font-weight:700;color:${C.white};">${esc(head)}</div>
                  <div style="font-size:14px;line-height:21px;color:${C.text};margin-top:3px;">${esc(body)}</div>
                </td>
              </tr>`;

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
    .hero { font-size:30px !important; line-height:36px !important; }
    .preview { width:280px !important; }
    .btn a { padding:17px 26px !important; font-size:16px !important; }
  }
${appStoreBlockCss()}
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
          <td class="pad" style="padding:36px 44px 8px;background-image:radial-gradient(ellipse at 85% 0%,rgba(122,63,209,0.38) 0%,rgba(6,2,15,0) 60%);">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td valign="middle">${logoSrc
                  ? `<img src="${esc(logoSrc)}" width="96" height="55" alt="The Tech Festival Canada" style="display:block;width:96px;height:auto;border:0;outline:none;">`
                  : `<span style="font-family:${SANS};font-size:13px;font-weight:800;letter-spacing:2.6px;color:${C.white};">TTFC 2026</span>`}</td>
                <td valign="middle" align="right">${eyebrow(`${EVENT.datesShort} · Toronto`, C.orange)}</td>
              </tr>
            </table>
            <div style="font-family:${SERIF};font-size:20px;line-height:28px;font-style:italic;color:${C.text};margin:30px 0 6px;">${first ? `Hi ${esc(first)},` : "Hello,"}</div>
            <div class="hero" style="font-family:${SANS};font-size:36px;line-height:42px;font-weight:800;letter-spacing:-0.8px;color:${C.white};margin:0 0 16px;">Show the world you're attending.</div>
            <div style="font-family:${SANS};font-size:16px;line-height:26px;color:${C.text};margin:0;">
              TTFC 2026 is almost here, and we'd love your network to know you'll be in Toronto on ${esc(EVENT.dates)}.
              We've set up a personal &ldquo;I'm attending&rdquo; image for you: add your photo, check your details and share it on LinkedIn with a post we've already written. It takes about a minute.
            </div>
          </td>
        </tr>

        <!-- Preview -->
        ${previewSrc ? `<tr>
          <td class="pad" align="center" style="padding:30px 44px 6px;">
            <a href="${esc(url)}" target="_blank" style="text-decoration:none;border:0;">
              <img class="preview" src="${esc(previewSrc)}" width="320" height="320" alt="Example of an &ldquo;I'm attending TTFC 2026&rdquo; image: a photo in a glowing ring, the attendee's name, title and company, and the event dates." style="display:block;width:320px;max-width:100%;height:auto;border:0;outline:none;border-radius:18px;box-shadow:0 24px 60px rgba(122,63,209,0.35);">
            </a>
            <div style="font-family:${SANS};font-size:12px;line-height:18px;color:${C.dim};margin-top:12px;">Example. Yours shows your photo, name and title.</div>
          </td>
        </tr>` : ""}

        <!-- Button -->
        <tr>
          <td class="pad" align="center" style="padding:26px 44px 8px;">
            ${button(url, "Create my LinkedIn post")}
            <div style="font-family:${SANS};font-size:12px;line-height:18px;color:${C.dim};margin-top:14px;">Works on your phone or computer.</div>
          </td>
        </tr>

        <!-- Steps -->
        <tr>
          <td class="pad" style="padding:30px 44px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.panel}" style="background:${C.panel};border:1px solid ${C.hair};border-radius:16px;border-collapse:separate;">
              <tr><td style="padding:24px 24px 8px;">
                <div style="font-family:${SANS};font-size:12px;line-height:16px;font-weight:800;letter-spacing:2.4px;text-transform:uppercase;color:${C.orange};margin:0 0 18px;">How it works</div>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  ${step(1, C.purple, "Add your photo", "Use your LinkedIn photo, pick one from your phone, or keep your initials.")}
                  ${step(2, C.magenta, "Check your details", detailsLine)}
                  ${step(3, C.orange, "Post it", "On your phone it goes straight to the LinkedIn app. On a computer, LinkedIn asks you to allow it once, then your post goes up with the image attached.")}
                </table>
              </td></tr>
            </table>
            <div style="font-family:${SANS};font-size:13px;line-height:20px;color:${C.muted};margin:14px 2px 0;">Your photo stays on your device. Only the finished image is shared, when you post it.</div>
          </td>
        </tr>

        <!-- Get the TTFC app (services/appStoreBlock.js) -->
        <tr>
          <td class="pad" style="padding:30px 44px 0;">
            ${appStoreBlockHtml()}
          </td>
        </tr>

        <!-- Sign-off -->
        <tr>
          <td class="pad" style="padding:32px 44px 36px;">
            <div style="font-family:${SANS};font-size:15px;line-height:24px;color:${C.text};">Thank you for helping us spread the word. Questions? Just reply to this email.</div>
            <div style="font-family:${SERIF};font-size:17px;line-height:26px;font-style:italic;color:${C.text};margin-top:18px;">See you in Toronto,</div>
            <div style="font-family:${SANS};font-size:15px;line-height:22px;font-weight:700;color:${C.white};margin-top:4px;">The Tech Festival Canada team</div>
          </td>
        </tr>

        <tr><td>${stripe(2)}</td></tr>
        <tr>
          <td class="pad" align="center" style="padding:22px 44px 40px;font-family:${SANS};font-size:12px;line-height:19px;color:${C.dim};">
            ${esc(EVENT.name)} &middot; ${esc(EVENT.dates)}<br>
            ${esc(EVENT.venue)}, ${esc(EVENT.address)}<br>
            <span style="color:#5f527f;">You're getting this because you have a pass for TTFC 2026. ${unsubscribeUrl
              ? `Prefer not to get emails like this? <a href="${esc(unsubscribeUrl)}" target="_blank" style="color:#a596c7;text-decoration:underline;">Unsubscribe</a>.`
              : "Prefer not to get emails like this? Reply with &ldquo;unsubscribe&rdquo;."}</span>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const text = [
    first ? `Hi ${first},` : "Hello,",
    "",
    "Show the world you're attending.",
    "",
    `TTFC 2026 is almost here, and we'd love your network to know you'll be in Toronto on ${EVENT.dates}. We've set up a personal "I'm attending" image for you: add your photo, check your details and share it on LinkedIn with a post we've already written. It takes about a minute.`,
    "",
    "Create my LinkedIn post:",
    url,
    "",
    "HOW IT WORKS",
    "  1. Add your photo: use your LinkedIn photo, pick one from your phone, or keep your initials.",
    `  2. Check your details: ${detailsLine}`,
    "  3. Post it: on your phone it goes straight to the LinkedIn app. On a computer, LinkedIn asks you to allow it once, then your post goes up with the image attached.",
    "",
    "Your photo stays on your device. Only the finished image is shared, when you post it.",
    "",
    ...appStoreBlockLines(),
    "",
    "Thank you for helping us spread the word. Questions? Just reply to this email.",
    "",
    "See you in Toronto,",
    "The Tech Festival Canada team",
    "",
    `${EVENT.name} · ${EVENT.dates}`,
    `${EVENT.venue}, ${EVENT.address}`,
    unsubscribeUrl
      ? `You're getting this because you have a pass for TTFC 2026. Prefer not to get emails like this? Unsubscribe: ${unsubscribeUrl}`
      : "You're getting this because you have a pass for TTFC 2026. Prefer not to get emails like this? Reply with \"unsubscribe\".",
  ].join("\n");

  return { subject, preheader, html: withPixel(html, pixelSrc), text, link: url };
}

/**
 * Subject/html/text for one recipient. `inline: true` uses data: URIs (admin preview, local demo).
 * `track`: the address a real send goes to; its token goes in the link and the open pixel
 * (`tracked` says whether it could be signed) and their own unsubscribe link and one-click headers (`headers`).
 * Never for previews or test sends (those get the preview link and the mailto).
 */
export function attendingEmailFor(recipient, { inline = true, track = "" } = {}) {
  const unsub = unsubscribeFor(track, { real: !inline && !!track, mailto: MARCOM_EMAIL });
  const base = {
    firstName: recipient?.firstName || "", lastName: recipient?.lastName || "",
    title: recipient?.title || "", company: recipient?.company || "", unsubscribeUrl: unsub.url,
  };
  if (inline) return { ...buildAttendingEmail({ ...base, ...inlineImageSrcs() }), attachments: [], tracked: false, headers: unsub.headers };
  const { srcs, attachments } = attendingAttachments();
  const token = track ? signTrack({ c: CAMPAIGN_KEY, e: track }) : "";
  const extra = token ? { link: attendingLink({ ...base, r: token }), pixelSrc: pixelUrlFor(token) } : {};
  return { ...buildAttendingEmail({ ...base, ...srcs, ...extra }), attachments, tracked: !!token, headers: unsub.headers };
}

/* ---------- sending ---------- */

let resendClient = null;
const resend = () => (resendClient ||= new Resend(process.env.RESEND_API_KEY));

/**
 * Sends one email through Resend (logo + preview as inline CID images, reply-to enquire@).
 * Throws when Resend refuses it. `subjectPrefix` marks staff test sends ("[Test] ").
 * `track`: a real send to this person (the campaign, a nudge): their token in the link and the open pixel.
 * @returns {Promise<{ id: string }>}
 */
export async function sendAttendingEmail({ to, recipient, subjectPrefix = "", client = resend(), track = false, noteTracked = noteTrackedSend }) {
  if (!to) throw new Error("Missing email");
  const address = track ? String(to).trim().toLowerCase() : "";
  const { subject, html, text, attachments, tracked, headers } = attendingEmailFor(recipient, { inline: false, track: address });
  const { data, error } = await client.emails.send({
    from: FROM,
    to,
    reply_to: MARCOM_EMAIL,
    subject: `${subjectPrefix}${subject}`,
    html,
    text,
    attachments,
    headers,
    tags: [{ name: "campaign", value: CAMPAIGN_KEY }],
  });
  if (error) throw new Error(error.message || "Resend refused the email");
  if (!data?.id) throw new Error("Resend did not accept the email");
  if (tracked) noteTracked?.({ campaign: CAMPAIGN_KEY, email: address, ticketId: "" });
  return data;
}
