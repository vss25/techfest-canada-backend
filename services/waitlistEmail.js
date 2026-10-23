/* =========================================================
   "You're on the TTFC 2027 waitlist": the person's confirmation
   (Oct 23 2026, the organiser: "Send an email to who sign ups as
   well. It should go from enquire@thetechfestival.com too.")
   ---------------------------------------------------------
   The purple TTFC look of the attendee emails (services/
   attendingEmail.js): thank you for your interest in TTFC 2027
   (Toronto, dates to be announced), what they asked about (their
   ticks in the page's own words, or "Attending TTFC 2027"),
   "Someone from our team will reach out.", a button back to
   https://www.thetechfestival.com/stay-updated, then the shared
   "Get the TTFC app" block (services/appStoreBlock.js) before the
   sign-off, like the other attendee emails, and the footer with
   their own unsubscribe link (services/unsubscribe.js) and the
   one-click List-Unsubscribe headers.
   The words are the stay.email_* app content keys (services/
   waitlist.js STAY_DEFAULTS; Admin › Sales & emails › 2027
   waitlist › Wording). From and reply-to enquire@ (the app
   invite's sender, services/appInviteEmail.js FROM).
   When it goes (services/waitlistHandler.js): the first sign-up
   for an address, and again only when the last one is a day old;
   never to an address on the unsubscribe list. Never blocks the
   answer to the form.
   Pure builder (buildWaitlistEmail), unit-tested in
   test/waitlist.test.js and test/app-store-block.test.js.
========================================================= */

import { Resend } from "resend";
import { appStoreUrl, escapeHtml as esc } from "./ticketInfo.js";
import { C, SANS, SERIF, LOGO_CID, button, eyebrow, logoPng, stripe } from "./attendingEmail.js";
import { ENQUIRE_EMAIL, FROM } from "./appInviteEmail.js";
import { appStoreBlockCss, appStoreBlockHtml, appStoreBlockLines } from "./appStoreBlock.js";
import { unsubscribeFor } from "./unsubscribe.js";
import { PAGE_URL, STAY_DEFAULTS, cleanInterests } from "./waitlist.js";

export const WAITLIST_CAMPAIGN = "waitlist-2027";
export { FROM, ENQUIRE_EMAIL };
/** With nothing ticked. */
export const ATTENDING = "Attending TTFC 2027";

/** Their ticks in the page's words (stay.interest_*), or "Attending TTFC 2027". */
export function askedAbout(interests, copy = STAY_DEFAULTS) {
  const list = cleanInterests(interests);
  if (!list.length) return [ATTENDING];
  return list.map((k) => String(copy[`stay.interest_${k}`] || STAY_DEFAULTS[`stay.interest_${k}`]).trim());
}

/**
 * @param {object} p
 * @param {object} [p.copy]           the stay.* wording (services/waitlist.js stayCopy)
 * @param {string[]} [p.interests]    sponsorship | exhibitor | delegation
 * @param {string} [p.logoSrc]        "cid:…" or a data: URI ("" = the text wordmark)
 * @param {string} [p.unsubscribeUrl] the footer's link ("" = "reply with unsubscribe")
 * @param {string} [p.storeUrl]       the iPhone app's App Store link ("" = Google Play alone)
 * @param {string} [p.postal]         the sender's postal address for the footer (MAIL_POSTAL_ADDRESS, like the campaign
 *                                    footer's sender line; CASL / CAN-SPAM). "" = "Toronto"
 * @returns {{ subject, preheader, html, text, link }}
 */
export function buildWaitlistEmail({ copy = STAY_DEFAULTS, interests = [], logoSrc = "", unsubscribeUrl = "", storeUrl = appStoreUrl(), postal = String(process.env.MAIL_POSTAL_ADDRESS || "").trim() } = {}) {
  const c = { ...STAY_DEFAULTS, ...Object.fromEntries(Object.entries(copy || {}).filter(([, v]) => typeof v === "string" && v.trim())) };
  const subject = c["stay.email_subject"];
  const asked = askedAbout(interests, c);
  const preheader = `${c["stay.email_intro"]} ${c["stay.email_next"]}`;
  const url = PAGE_URL;
  const para = (t, style) => String(t).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p style="${style}">${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  const body = `font-family:${SANS};font-size:16px;line-height:26px;color:${C.text};margin:0 0 14px;`;
  const item = (t) => `
                  <tr>
                    <td valign="top" width="26" style="padding:0 0 8px;font-family:${SANS};font-size:15px;line-height:22px;color:${C.magenta};">&#9679;</td>
                    <td valign="top" style="padding:0 0 8px;font-family:${SANS};font-size:16px;line-height:22px;font-weight:700;color:${C.white};">${esc(t)}</td>
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

        <!-- Header, heading and thank you -->
        <tr>
          <td class="pad" style="padding:36px 44px 8px;background-image:radial-gradient(ellipse at 85% 0%,rgba(122,63,209,0.38) 0%,rgba(6,2,15,0) 60%);">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td valign="middle">${logoSrc
                  ? `<img src="${esc(logoSrc)}" width="96" height="55" alt="The Tech Festival Canada" style="display:block;width:96px;height:auto;border:0;outline:none;">`
                  : `<span style="font-family:${SANS};font-size:13px;font-weight:800;letter-spacing:2.6px;color:${C.white};">TTFC</span>`}</td>
                <td valign="middle" align="right">${eyebrow("TTFC 2027 · Toronto", C.orange)}</td>
              </tr>
            </table>
            <div style="font-family:${SERIF};font-size:20px;line-height:28px;font-style:italic;color:${C.text};margin:30px 0 6px;">Hello,</div>
            <div class="hero" style="font-family:${SANS};font-size:36px;line-height:42px;font-weight:800;letter-spacing:-0.8px;color:${C.white};margin:0 0 16px;">${esc(c["stay.email_heading"])}</div>
            ${para(c["stay.email_intro"], body)}
          </td>
        </tr>

        <!-- What they asked about -->
        <tr>
          <td class="pad" style="padding:16px 44px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.panel}" style="background:${C.panel};border:1px solid ${C.hair};border-radius:16px;border-collapse:separate;">
              <tr><td style="padding:22px 24px 14px;">
                <div style="font-family:${SANS};font-size:12px;line-height:16px;font-weight:800;letter-spacing:2.4px;text-transform:uppercase;color:${C.orange};margin:0 0 14px;">What you asked about</div>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${asked.map(item).join("")}
                </table>
              </td></tr>
            </table>
            <div style="font-family:${SANS};font-size:17px;line-height:26px;font-weight:700;color:${C.white};margin:22px 0 0;">${esc(c["stay.email_next"])}</div>
          </td>
        </tr>

        <!-- Back to the page -->
        <tr>
          <td class="pad" align="center" style="padding:28px 44px 8px;">
            ${button(url, c["stay.email_button"])}
            <div style="font-family:${SANS};font-size:12px;line-height:18px;color:${C.dim};margin-top:14px;">thetechfestival.com/stay-updated</div>
          </td>
        </tr>

        <!-- Get the TTFC app (services/appStoreBlock.js) -->
        <tr>
          <td class="pad" style="padding:30px 44px 0;">
            ${appStoreBlockHtml({ storeUrl })}
          </td>
        </tr>

        <!-- Sign-off -->
        <tr>
          <td class="pad" style="padding:32px 44px 36px;">
            <div style="font-family:${SANS};font-size:15px;line-height:24px;color:${C.text};">Questions? Just reply to this email.</div>
            <div style="font-family:${SERIF};font-size:17px;line-height:26px;font-style:italic;color:${C.text};margin-top:18px;">See you in Toronto,</div>
            <div style="font-family:${SANS};font-size:15px;line-height:22px;font-weight:700;color:${C.white};margin-top:4px;">The Tech Festival Canada team</div>
          </td>
        </tr>

        <tr><td>${stripe(2)}</td></tr>
        <tr>
          <td class="pad" align="center" style="padding:22px 44px 40px;font-family:${SANS};font-size:12px;line-height:19px;color:${C.dim};">
            The Tech Festival Canada &middot; ${esc(postal || "Toronto")} &middot; <a href="https://www.thetechfestival.com" target="_blank" style="color:${C.dim};text-decoration:underline;">thetechfestival.com</a><br>
            <span style="color:#5f527f;">You're getting this because you joined the TTFC 2027 waitlist. ${unsubscribeUrl
              ? `Prefer not to get emails from us? <a href="${esc(unsubscribeUrl)}" target="_blank" style="color:#a596c7;text-decoration:underline;">Unsubscribe from TTFC emails</a>.`
              : "Prefer not to get emails from us? Reply with &ldquo;unsubscribe&rdquo;."}</span>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const text = [
    "Hello,",
    "",
    c["stay.email_heading"],
    "",
    c["stay.email_intro"],
    "",
    "WHAT YOU ASKED ABOUT",
    ...asked.map((x) => `  • ${x}`),
    "",
    c["stay.email_next"],
    "",
    `${c["stay.email_button"]}: ${url}`,
    "",
    ...appStoreBlockLines({ storeUrl }),
    "",
    "Questions? Just reply to this email.",
    "",
    "See you in Toronto,",
    "The Tech Festival Canada team",
    "",
    `The Tech Festival Canada · ${postal || "Toronto"} · https://www.thetechfestival.com`,
    unsubscribeUrl
      ? `You're getting this because you joined the TTFC 2027 waitlist. Prefer not to get emails from us? Unsubscribe: ${unsubscribeUrl}`
      : "You're getting this because you joined the TTFC 2027 waitlist. Prefer not to get emails from us? Reply with \"unsubscribe\".",
  ].join("\n");

  return { subject, preheader, html, text, link: url };
}

/**
 * The email for one address. `inline`: the logo as a data: URI (previews); else "cid:" + its attachment.
 * `real`: a real send to `to` (their own unsubscribe link and one-click headers); previews and tests get the
 * preview link and the mailto.
 */
export function waitlistEmailFor({ to = "", interests = [], copy = STAY_DEFAULTS } = {}, { inline = true, real = false, storeUrl = appStoreUrl() } = {}) {
  const unsub = unsubscribeFor(String(to || "").trim().toLowerCase(), { real: real && !inline && !!to, mailto: ENQUIRE_EMAIL });
  const base = { copy, interests, unsubscribeUrl: unsub.url, storeUrl };
  if (inline) return { ...buildWaitlistEmail({ ...base, logoSrc: `data:image/png;base64,${logoPng().toString("base64")}` }), attachments: [], headers: unsub.headers };
  return {
    ...buildWaitlistEmail({ ...base, logoSrc: `cid:${LOGO_CID}` }),
    attachments: [{ filename: "ttfc.png", content: logoPng().toString("base64"), content_type: "image/png", content_id: LOGO_CID }],
    headers: unsub.headers,
  };
}

let resendClient = null;
const resend = () => (resendClient ||= new Resend(process.env.RESEND_API_KEY));

/**
 * Sends one confirmation through Resend, from and reply-to enquire@. Throws when Resend refuses it.
 * @returns {Promise<{ id: string }>}
 */
export async function sendWaitlistEmail({ to, interests = [], copy = STAY_DEFAULTS, subjectPrefix = "", client = resend(), real = true }) {
  if (!to) throw new Error("Missing email");
  const { subject, html, text, attachments, headers } = waitlistEmailFor({ to, interests, copy }, { inline: false, real });
  const { data, error } = await client.emails.send({
    from: FROM,
    to,
    reply_to: ENQUIRE_EMAIL,
    subject: `${subjectPrefix}${subject}`,
    html,
    text,
    attachments,
    headers,
    tags: [{ name: "campaign", value: WAITLIST_CAMPAIGN }],
  });
  if (error) throw new Error(error.message || "Resend refused the email");
  if (!data?.id) throw new Error("Resend did not accept the email");
  return data;
}
