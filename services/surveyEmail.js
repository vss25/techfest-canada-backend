import { Resend } from "resend";
import { EVENT, escapeHtml as esc } from "./ticketInfo.js";
import { C, SANS, SERIF, button, logoPng, stripe } from "./attendingEmail.js";
import { ENQUIRE_EMAIL, FROM } from "./appInviteEmail.js";
import { appStoreBlockCss, appStoreBlockHtml, appStoreBlockLines } from "./appStoreBlock.js";
import { apiBaseUrl } from "./walletLink.js";
import { SURVEY_DEFAULTS } from "./surveyRules.js";

/* =========================================================
   The survey email (Oct 26 2026): HTML + plain text, and the batch
   sender.
   ---------------------------------------------------------
   The organiser: "I want to share the survey to all the people who
   were checked in today" (many aren't on the app). Sent only when
   management clicks Send in the admin panel (routes/survey.js POST
   /api/console/survey/email), never automatically.
   Subject "How was TTFC 2026? Two minutes, please"; the survey's own
   title and intro (the admin panel's wording); one big button "Share
   your feedback" to the person's own link (prefilled for them: their
   account's "u" token, or their pass's "p" token,
   services/surveyRules.js); the link written out under it; the "Get
   the TTFC app" block like every other email (services/appStoreBlock.js);
   the footer with their one-click unsubscribe link (services/unsubscribe.js).
   Dark like the other TTFC emails, with a light version for mail apps
   that ask for one. From and reply-to enquire@ (never info@).
   Sent through Resend's batch API, 100 a call, which takes no
   attachments: the logo is the same PNG served by this API
   (GET /api/survey/email-logo.png), not an inline CID. Pure builder
   (buildSurveyEmail), unit-tested.
========================================================= */

export const SURVEY_SUBJECT = "How was TTFC 2026? Two minutes, please";
export const SURVEY_BUTTON = "Share your feedback";
export const BATCH_SIZE = 100;
export const surveyLogoUrl = (base = apiBaseUrl()) => `${base}/api/survey/email-logo.png`;
export { logoPng as surveyLogoPng };

const str = (v) => String(v ?? "");
const paras = (text, style) => str(text).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  .map((p) => `<p class="tx" style="${style}">${esc(p).replace(/\n/g, "<br>")}</p>`).join("\n            ");

/**
 * @param {object} p
 * @param {string} [p.firstName]
 * @param {string} p.url              their personal survey link
 * @param {object} [p.copy]           { title, intro } (the survey's config)
 * @param {string} [p.logoSrc]        an https URL or a data: URI ("" = the text wordmark)
 * @param {string} [p.unsubscribeUrl] their one-click unsubscribe link ("" = reply "unsubscribe")
 * @returns {{ subject, preheader, html, text }}
 */
export function buildSurveyEmail({ firstName = "", url = "", copy = {}, logoSrc = "", unsubscribeUrl = "" } = {}) {
  const subject = SURVEY_SUBJECT;
  const title = str(copy.title).trim() || SURVEY_DEFAULTS.title;
  const intro = str(copy.intro).trim() || SURVEY_DEFAULTS.intro;
  const greeting = `Hi ${str(firstName).trim() || "there"},`;
  const thanks = "Thank you for being at The Tech Festival Canada 2026.";
  const preheader = intro.split(/\n/)[0].slice(0, 140);
  const P = `font-family:${SANS};font-size:16px;line-height:25px;color:${C.text};margin:0 0 14px;`;
  const off = unsubscribeUrl
    ? `Don't want emails like this? <a href="${esc(unsubscribeUrl)}" target="_blank" class="lk" style="color:#a596c7;text-decoration:underline;">Unsubscribe</a>.`
    : `Don't want emails like this? Reply with "unsubscribe".`;

  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<title>${esc(subject)}</title>
<style>
  body { margin:0; padding:0; background:${C.bg}; }
  a { color:${C.white}; }
  @media only screen and (max-width:620px) {
    .wrap { width:100% !important; }
    .pad { padding-left:22px !important; padding-right:22px !important; }
    .btn a { padding:17px 26px !important; font-size:16px !important; }
  }
  @media (prefers-color-scheme: light) {
    body, .bg { background:#f6f2fb !important; }
    .panel { background:#ffffff !important; border-color:#e6def3 !important; }
    .hd, .lk { color:#140a26 !important; }
    .tx { color:#3a2f55 !important; }
    .mut { color:#6b5f88 !important; }
    .eb { color:#9a5200 !important; }
  }
${appStoreBlockCss({ adapt: "light" })}
</style>
</head>
<body class="bg" style="margin:0;padding:0;background:${C.bg};" bgcolor="${C.bg}">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.bg};opacity:0;">${esc(preheader)}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.bg}" style="background:${C.bg};">
  <tr>
    <td align="center" style="padding:0;">
      <table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
        <tr><td>${stripe(4)}</td></tr>
        <tr>
          <td class="pad" style="padding:32px 44px 6px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
              <td valign="middle">${logoSrc
                ? `<img src="${esc(logoSrc)}" width="96" height="55" alt="The Tech Festival Canada" style="display:block;width:96px;height:auto;border:0;outline:none;">`
                : `<span class="hd" style="font-family:${SANS};font-size:13px;font-weight:800;letter-spacing:2.6px;color:${C.white};">TTFC 2026</span>`}</td>
              <td valign="middle" align="right"><div class="eb" style="font-family:${SANS};font-size:10px;line-height:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${C.orange};">Your feedback</div></td>
            </tr></table>
            <div class="tx" style="font-family:${SERIF};font-size:20px;line-height:28px;font-style:italic;color:${C.text};margin:26px 0 8px;">${esc(greeting)}</div>
            <p class="tx" style="${P}">${esc(thanks)}</p>
            <h1 class="hd" style="font-family:${SANS};font-size:28px;line-height:34px;font-weight:800;color:${C.white};margin:18px 0 12px;">${esc(title)}</h1>
            ${paras(intro, P)}
          </td>
        </tr>
        <tr>
          <td class="pad" align="center" style="padding:22px 44px 14px;">
            ${button(url, SURVEY_BUTTON)}
          </td>
        </tr>
        <tr>
          <td class="pad mut" align="center" style="padding:0 44px 30px;font-family:${SANS};font-size:12px;line-height:18px;color:${C.muted};">
            Or open this link: <a href="${esc(url)}" target="_blank" class="lk" style="color:${C.muted};text-decoration:underline;word-break:break-all;">${esc(url)}</a>
          </td>
        </tr>
        <!-- Get the TTFC app (services/appStoreBlock.js) -->
        <tr>
          <td class="pad" style="padding:0 44px 32px;">
            ${appStoreBlockHtml()}
          </td>
        </tr>
        <tr><td>${stripe(2)}</td></tr>
        <tr>
          <td class="pad mut" align="center" style="padding:22px 44px 40px;font-family:${SANS};font-size:12px;line-height:19px;color:${C.dim};">
            ${esc(EVENT.name)} &middot; ${esc(EVENT.dates)}<br>
            ${esc(EVENT.venue)}, ${esc(EVENT.address)}<br>
            Questions? <a href="mailto:${ENQUIRE_EMAIL}" class="lk" style="color:#a596c7;text-decoration:underline;">${ENQUIRE_EMAIL}</a><br>
            <span class="mut" style="color:#6f6290;">${off}</span>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const text = [
    greeting, "", thanks, "", title, "", intro, "",
    `${SURVEY_BUTTON}: ${url}`, "",
    ...appStoreBlockLines(), "",
    `${EVENT.name} · ${EVENT.dates}`,
    `Questions? ${ENQUIRE_EMAIL}`,
    unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : `Don't want emails like this? Reply with "unsubscribe".`,
  ].join("\n");

  return { subject, preheader, html, text };
}

/** One person's message for the batch: { to, subject, html, text, headers } (from and reply-to are added on send). */
export function surveyMessage({ to, firstName = "", url, copy = {}, unsubscribe = { url: "", headers: {} }, logoSrc = surveyLogoUrl() }) {
  const e = buildSurveyEmail({ firstName, url, copy, logoSrc, unsubscribeUrl: unsubscribe.url || "" });
  return { to, subject: e.subject, html: e.html, text: e.text, headers: unsubscribe.headers || {} };
}

let resendClient = null;
const resend = () => (resendClient ||= new Resend(process.env.RESEND_API_KEY));

/**
 * Sends up to BATCH_SIZE messages in one Resend batch call: from and reply-to enquire@. → [{ to, id }] in order.
 * Throws when Resend refuses the batch (a batch goes whole or not at all: none of them went).
 */
export async function sendSurveyBatch(messages = [], { client = resend() } = {}) {
  if (!messages.length) return [];
  if (messages.length > BATCH_SIZE) throw new Error(`At most ${BATCH_SIZE} emails a batch.`);
  const payload = messages.map((m) => ({
    from: FROM, to: [m.to], reply_to: ENQUIRE_EMAIL, subject: m.subject, html: m.html, text: m.text,
    ...(m.headers && Object.keys(m.headers).length ? { headers: m.headers } : {}),
  }));
  const { data, error } = await client.batch.send(payload);
  if (error) throw Object.assign(new Error(error.message || "Resend refused the emails"), { status: error.statusCode || error.status || 0 });
  // Accepted: every email in it is on its way (the ids, when Resend gives them, are kept for looking one up).
  const ids = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  return messages.map((m, i) => ({ to: m.to, id: String(ids[i]?.id || "") }));
}
