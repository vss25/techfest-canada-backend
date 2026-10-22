/* =========================================================
   The app invite email: HTML + plain text (Oct 20 2026)
   ---------------------------------------------------------
   "Open the TTFC app": the TTFC header like the other emails, a
   short why (their pass and check-in QR, the agenda, the venue
   map, networking and chat, live polls and Q&A), one big button to
   the web app (https://www.thetechfestival.com/app/), how to add it
   to the home screen on an iPhone and on Android, the address to
   sign in with, and, each with its own switch, a Google Play line
   and an App Store line (the App Store one only once the iPhone
   app's link is set: services/appInvite.js appStoreUrl).
   Every word comes from the editable wording (services/
   appInviteCopy.js). Dark like the other TTFC emails, with a light
   version for mail apps that ask for one (prefers-color-scheme).
   Real sends (sendAppInviteEmail with `track`) carry the person's
   signed token in the button's link (#r=…) and a 1×1 open pixel;
   previews and test sends carry neither. From and reply-to
   enquire@ (the organiser: "email will be sent from enquire").
   Pure builder (buildAppInviteEmail), unit-tested.
========================================================= */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Resend } from "resend";
import { EVENT, escapeHtml as esc } from "./ticketInfo.js";
import { C, SANS, SERIF, LOGO_CID, button, logoPng, stripe } from "./attendingEmail.js";
import { DEFAULT_OPTIONS, effectiveCopy, fillInvite } from "./appInviteCopy.js";
import { APP_INVITE_CAMPAIGN, PLAY_STORE_URL, appInviteLink, appStoreUrl } from "./appInvite.js";
import { pixelUrlFor, signTrack, withPixel } from "./trackToken.js";
import { SWAG_PAGE, longTime } from "./swagRules.js";
import { noteTrackedSend } from "./engagementStore.js";

export const ENQUIRE_EMAIL = "enquire@thetechfestival.com";
/** The logo with its words in dark ink, for mail apps showing the light version. */
export const LOGO_DARK_CID = "ttfc-logo-dark";
const LOGO_DARK_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "email", "ttfc-logo-dark.png");
let darkLogo = null;
export const logoDarkPng = () => (darkLogo ||= fs.readFileSync(LOGO_DARK_FILE));
export const FROM = `The Tech Festival Canada <${ENQUIRE_EMAIL}>`;

/** The swag kit photo (Oct 22 2026): the 600 × 508 JPEG as supplied, inline as CID "swag-kit" while the contest is on. */
export const SWAG_CID = "swag-kit";
const SWAG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "email", "swag-kit.jpg");
let swagPhoto = null;
export const swagJpg = () => (swagPhoto ||= fs.readFileSync(SWAG_FILE));

/** The swag kit's photo description (alt text). */
export const SWAG_ALT = "TTFC swag kit: backpack, bottle, mug, notebook, umbrella and more";

/** Plain text → HTML: escaped, placeholders filled, line breaks kept, a blank line = a new paragraph. */
const para = (text, vars, style) => fillInvite(text, vars).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  .map((p) => `<p class="tx" style="${style}">${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
const line = (text, vars) => esc(fillInvite(text, vars));

/**
 * @param {object} p
 * @param {object} [p.copy]       staff's wording (merged over the built-in text here)
 * @param {object} [p.options]    { play, appStore } on / off
 * @param {string} [p.firstName]
 * @param {string} [p.email]      the address it goes to (the sign-in line)
 * @param {string} [p.link]       the button's link (default: the web app, no token)
 * @param {string} [p.logoSrc]    "cid:…" or a data: URI ("" = the text wordmark)
 * @param {string} [p.logoLightSrc] the same for the light version (dark words; "" = the light logo everywhere)
 * @param {string} [p.pixelSrc]   a real send's open pixel ("" = none)
 * @param {string} [p.storeUrl]   the iPhone app's App Store link ("" = no App Store line)
 * @param {object} [p.swag]       the swag kit contest while it's on (services/swagRules.js swagSettings), else null:
 *                                the swag block after the intro and the swag subject
 * @param {string} [p.swagSrc]    the swag photo: "cid:swag-kit" or a data: URI
 * @returns {{ subject, preheader, html, text, link }}
 */
export function buildAppInviteEmail({ copy = {}, options = DEFAULT_OPTIONS, firstName = "", email = "", link = "", logoSrc = "", logoLightSrc = "", pixelSrc = "", storeUrl = appStoreUrl(), swag = null, swagSrc = "" } = {}) {
  const c = effectiveCopy(copy);
  const vars = {
    firstName: String(firstName || "").trim(), email: String(email || "").trim(),
    ...(swag ? { kits: swag.kits, cutoff: longTime(swag.cutoff), announce: longTime(swag.announce) } : {}),
  };
  const url = link || appInviteLink();
  const opts = { ...DEFAULT_OPTIONS, ...(options || {}) };
  const showPlay = opts.play !== false && !!c.playText;
  const showStore = opts.appStore !== false && !!storeUrl && !!c.appStoreText;
  const subject = fillInvite(swag && c.swagSubject ? c.swagSubject : c.subject, vars);
  const preheader = fillInvite(c.preheader, vars);
  const body = `font-family:${SANS};font-size:16px;line-height:26px;color:${C.text};margin:0 0 14px;`;

  const bullet = (t) => `
              <tr>
                <td valign="top" width="26" style="padding:0 0 10px;font-family:${SANS};font-size:15px;line-height:22px;color:${C.magenta};">&#9679;</td>
                <td valign="top" class="tx" style="padding:0 0 10px;font-family:${SANS};font-size:15px;line-height:22px;color:${C.text};">${line(t, vars)}</td>
              </tr>`;
  const steps = (title, list, color) => `
                <td class="col" valign="top" width="50%" style="padding:0 8px 0 0;">
                  <div class="hd" style="font-family:${SANS};font-size:14px;line-height:20px;font-weight:800;color:${C.white};margin:0 0 10px;">${line(title, vars)}</div>
                  ${(list || []).map((s, i) => `
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:0 0 9px;"><tr>
                    <td valign="top" width="30" style="padding:0;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr>
                        <td align="center" valign="middle" width="22" height="22" style="width:22px;height:22px;border-radius:11px;border:1px solid ${color};font-family:${SANS};font-size:11px;font-weight:800;color:${color};">${i + 1}</td>
                      </tr></table>
                    </td>
                    <td valign="top" class="tx" style="padding:1px 0 0;font-family:${SANS};font-size:14px;line-height:20px;color:${C.text};">${line(s, vars)}</td>
                  </tr></table>`).join("")}
                </td>`;
  const storeLine = (text, label, href) => `
            <div class="tx" style="font-family:${SANS};font-size:14px;line-height:22px;color:${C.text};margin:0 0 6px;">${line(text, vars)} <a href="${esc(href)}" target="_blank" style="color:${C.white};font-weight:700;text-decoration:underline;" class="lk">${line(label, vars)}</a></div>`;

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
    .hero { font-size:30px !important; line-height:36px !important; }
    .col { display:block !important; width:100% !important; padding:0 0 16px 0 !important; }
    .btn a { padding:17px 26px !important; font-size:16px !important; }
  }
  @media (prefers-color-scheme: light) {
    body, .bg { background:#f6f2fb !important; }
    .panel { background:#ffffff !important; border-color:#e6def3 !important; }
    .hd, .hero, .sig { color:#140a26 !important; }
    .tx { color:#3a2f55 !important; }
    .mut { color:#6b5f88 !important; }
    .lk { color:#7a3fd1 !important; }
    .eb { color:#9a5200 !important; }
    .glow { background-image:none !important; }
    .logo-d { display:none !important; }
    .logo-l { display:block !important; }
  }
</style>
</head>
<body class="bg" style="margin:0;padding:0;background:${C.bg};" bgcolor="${C.bg}">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.bg};opacity:0;">${esc(preheader)}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.bg}" style="background:${C.bg};">
  <tr>
    <td align="center" style="padding:0;">
      <table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
        <tr><td>${stripe(4)}</td></tr>

        <!-- Header, greeting and intro -->
        <tr>
          <td class="pad glow" style="padding:36px 44px 6px;background-image:radial-gradient(ellipse at 85% 0%,rgba(122,63,209,0.38) 0%,rgba(6,2,15,0) 60%);">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td valign="middle">${logoSrc
                  ? `<img class="logo-d" src="${esc(logoSrc)}" width="96" height="55" alt="The Tech Festival Canada" style="display:block;width:96px;height:auto;border:0;outline:none;">${logoLightSrc
                    ? `<img class="logo-l" src="${esc(logoLightSrc)}" width="96" height="55" alt="The Tech Festival Canada" style="display:none;mso-hide:all;width:96px;height:auto;border:0;outline:none;">` : ""}`
                  : `<span class="hd" style="font-family:${SANS};font-size:13px;font-weight:800;letter-spacing:2.6px;color:${C.white};">TTFC 2026</span>`}</td>
                <td valign="middle" align="right"><div class="eb" style="font-family:${SANS};font-size:10px;line-height:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${C.orange};">${esc(`${EVENT.datesShort} · Toronto`)}</div></td>
              </tr>
            </table>
            ${c.eyebrow ? `<div class="mut" style="font-family:${SANS};font-size:10px;line-height:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${C.muted};margin:28px 0 0;">${line(c.eyebrow, vars)}</div>` : ""}
            <div class="hero" style="font-family:${SANS};font-size:36px;line-height:42px;font-weight:800;letter-spacing:-0.8px;color:${C.white};margin:8px 0 18px;">${line(c.heading, vars)}</div>
            <div class="tx" style="font-family:${SERIF};font-size:20px;line-height:28px;font-style:italic;color:${C.text};margin:0 0 10px;">${line(c.greeting, vars)}</div>
            ${para(c.intro, vars, body)}
          </td>
        </tr>

        ${swag ? `<!-- The swag kit: only app users can win -->
        <tr>
          <td class="pad" style="padding:18px 44px 0;">
            <table role="presentation" class="panel" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.panel}" style="background:${C.panel};border:2px solid ${C.orange};border-radius:16px;border-collapse:separate;">
              ${swagSrc ? `<tr><td style="padding:0;"><a href="${esc(SWAG_PAGE)}" target="_blank" style="display:block;text-decoration:none;"><img src="${esc(swagSrc)}" width="560" alt="${esc(SWAG_ALT)}" style="display:block;width:100%;max-width:560px;height:auto;border:0;outline:none;border-radius:14px 14px 0 0;"></a></td></tr>` : ""}
              <tr><td style="padding:20px 24px 18px;">
                <div class="hd" style="font-family:${SANS};font-size:22px;line-height:28px;font-weight:800;color:${C.white};margin:0 0 10px;">${line(c.swagHeadline, vars)}</div>
                <div class="hd" style="font-family:${SANS};font-size:16px;line-height:24px;font-weight:800;color:${C.orange};margin:0 0 10px;">${line(c.swagOnly, vars)}</div>
                ${c.swagText ? para(c.swagText, vars, `font-family:${SANS};font-size:15px;line-height:23px;color:${C.text};margin:0 0 10px;`) : ""}
                <div class="mut" style="font-family:${SANS};font-size:13px;line-height:20px;color:${C.muted};">No purchase necessary · <a href="${esc(SWAG_PAGE)}" target="_blank" class="lk" style="color:${C.white};font-weight:700;text-decoration:underline;">Rules</a></div>
              </td></tr>
            </table>
          </td>
        </tr>` : ""}

        <!-- What's in it -->
        ${(c.features || []).length ? `<tr>
          <td class="pad" style="padding:14px 44px 0;">
            <table role="presentation" class="panel" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.panel}" style="background:${C.panel};border:1px solid ${C.hair};border-radius:16px;border-collapse:separate;">
              <tr><td style="padding:22px 24px 12px;">
                ${c.featuresTitle ? `<div class="eb" style="font-family:${SANS};font-size:12px;line-height:16px;font-weight:800;letter-spacing:2.4px;text-transform:uppercase;color:${C.orange};margin:0 0 14px;">${line(c.featuresTitle, vars)}</div>` : ""}
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${c.features.map(bullet).join("")}
                </table>
              </td></tr>
            </table>
          </td>
        </tr>` : ""}

        <!-- The button -->
        <tr>
          <td class="pad" align="center" style="padding:30px 44px 6px;">
            ${button(url, fillInvite(c.button, vars))}
            ${c.buttonNote ? `<div class="mut" style="font-family:${SANS};font-size:12px;line-height:18px;color:${C.dim};margin-top:14px;">${line(c.buttonNote, vars)}</div>` : ""}
          </td>
        </tr>

        <!-- Add it to your home screen -->
        <tr>
          <td class="pad" style="padding:28px 44px 0;">
            <table role="presentation" class="panel" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.panel}" style="background:${C.panel};border:1px solid ${C.hair};border-radius:16px;border-collapse:separate;">
              <tr><td style="padding:22px 24px 10px;">
                <div class="hd" style="font-family:${SANS};font-size:17px;line-height:24px;font-weight:800;color:${C.white};margin:0 0 4px;">${line(c.homeTitle, vars)}</div>
                ${c.homeIntro ? `<div class="mut" style="font-family:${SANS};font-size:14px;line-height:21px;color:${C.muted};margin:0 0 16px;">${line(c.homeIntro, vars)}</div>` : ""}
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
                  ${steps(c.iphoneTitle, c.iphoneSteps, C.purple)}
                  ${steps(c.androidTitle, c.androidSteps, C.magenta)}
                </tr></table>
              </td></tr>
            </table>
          </td>
        </tr>

        <!-- Signing in, app store lines -->
        <tr>
          <td class="pad" style="padding:24px 44px 0;">
            ${c.signIn ? para(c.signIn, vars, `font-family:${SANS};font-size:15px;line-height:24px;color:${C.text};margin:0 0 14px;`) : ""}
            ${showPlay ? storeLine(c.playText, c.playLink || "Google Play", PLAY_STORE_URL) : ""}
            ${showStore ? storeLine(c.appStoreText, c.appStoreLink || "App Store", storeUrl) : ""}
          </td>
        </tr>

        <!-- Sign-off -->
        <tr>
          <td class="pad" style="padding:22px 44px 36px;">
            ${para(c.signOff, vars, `font-family:${SANS};font-size:15px;line-height:24px;color:${C.text};margin:0 0 12px;`)}
            ${c.signature ? `<div class="sig" style="font-family:${SANS};font-size:15px;line-height:22px;font-weight:700;color:${C.white};margin-top:6px;">${line(c.signature, vars)}</div>` : ""}
          </td>
        </tr>

        <tr><td>${stripe(2)}</td></tr>
        <tr>
          <td class="pad mut" align="center" style="padding:22px 44px 40px;font-family:${SANS};font-size:12px;line-height:19px;color:${C.dim};">
            ${esc(EVENT.name)} &middot; ${esc(EVENT.dates)}<br>
            ${esc(EVENT.venue)}, ${esc(EVENT.address)}<br>
            ${c.footer ? `<span class="mut" style="color:#6f6290;">${line(c.footer, vars).replace(/\n/g, "<br>")}</span>` : ""}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const t = (s) => fillInvite(s, vars);
  const text = [
    t(c.heading),
    "",
    t(c.greeting),
    "",
    t(c.intro),
    "",
    ...(swag ? [t(c.swagHeadline).toUpperCase(), t(c.swagOnly), ...(c.swagText ? [t(c.swagText)] : []), `No purchase necessary. Rules: ${SWAG_PAGE}`, ""] : []),
    ...((c.features || []).length ? [c.featuresTitle ? t(c.featuresTitle).toUpperCase() : "", ...c.features.map((x) => `  • ${t(x)}`), ""] : []),
    `${t(c.button)}:`,
    url,
    ...(c.buttonNote ? [t(c.buttonNote)] : []),
    "",
    t(c.homeTitle).toUpperCase(),
    ...(c.homeIntro ? [t(c.homeIntro)] : []),
    "",
    `${t(c.iphoneTitle)}:`,
    ...(c.iphoneSteps || []).map((s, i) => `  ${i + 1}. ${t(s)}`),
    "",
    `${t(c.androidTitle)}:`,
    ...(c.androidSteps || []).map((s, i) => `  ${i + 1}. ${t(s)}`),
    "",
    ...(c.signIn ? [t(c.signIn), ""] : []),
    ...(showPlay ? [`${t(c.playText)} ${t(c.playLink || "Google Play")}: ${PLAY_STORE_URL}`] : []),
    ...(showStore ? [`${t(c.appStoreText)} ${t(c.appStoreLink || "App Store")}: ${storeUrl}`] : []),
    ...(showPlay || showStore ? [""] : []),
    t(c.signOff),
    ...(c.signature ? ["", t(c.signature)] : []),
    "",
    `${EVENT.name} · ${EVENT.dates}`,
    `${EVENT.venue}, ${EVENT.address}`,
    ...(c.footer ? [t(c.footer)] : []),
  ].join("\n").replace(/\n{3,}/g, "\n\n");

  return { subject, preheader, html: withPixel(html, pixelSrc), text, link: url };
}

/** data: logo (and swag photo) for previews; cid: + the attachments for a real send. */
const inlineLogos = (swagOn) => ({
  logoSrc: `data:image/png;base64,${logoPng().toString("base64")}`,
  logoLightSrc: `data:image/png;base64,${logoDarkPng().toString("base64")}`,
  ...(swagOn ? { swagSrc: `data:image/jpeg;base64,${swagJpg().toString("base64")}` } : {}),
});
const logoAttachments = (swagOn) => [
  { filename: "ttfc-2026.png", content: logoPng().toString("base64"), content_type: "image/png", content_id: LOGO_CID },
  { filename: "ttfc-2026-light.png", content: logoDarkPng().toString("base64"), content_type: "image/png", content_id: LOGO_DARK_CID },
  ...(swagOn ? [{ filename: "ttfc-swag-kit.jpg", content: swagJpg().toString("base64"), content_type: "image/jpeg", content_id: SWAG_CID }] : []),
];

/**
 * The email for one person. `inline`: data: URIs (admin preview). `track`: the address a real send goes to;
 * its token goes in the button's link and the open pixel (`tracked` says whether it could be signed).
 * Never for previews or test sends. `copy` / `options`: the saved (or a draft's) wording and switches. `swag`: the
 * contest's settings while it's on (else null): the swag block, its subject and the photo.
 */
export function appInviteEmailFor(person, { inline = true, track = "", copy = {}, options = DEFAULT_OPTIONS, storeUrl = appStoreUrl(), swag = null } = {}) {
  const on = !!swag?.enabled;
  const base = { copy, options, storeUrl, firstName: person?.firstName || "", email: person?.email || "", swag: on ? swag : null };
  if (inline) return { ...buildAppInviteEmail({ ...base, ...inlineLogos(on) }), attachments: [], tracked: false };
  const token = track ? signTrack({ c: APP_INVITE_CAMPAIGN, e: track }) : "";
  const extra = token ? { link: appInviteLink(token), pixelSrc: pixelUrlFor(token) } : {};
  return {
    ...buildAppInviteEmail({ ...base, logoSrc: `cid:${LOGO_CID}`, logoLightSrc: `cid:${LOGO_DARK_CID}`, ...(on ? { swagSrc: `cid:${SWAG_CID}` } : {}), ...extra }),
    attachments: logoAttachments(on), tracked: !!token,
  };
}

let resendClient = null;
const resend = () => (resendClient ||= new Resend(process.env.RESEND_API_KEY));

/**
 * Sends one app invite through Resend (from and reply-to enquire@, List-Unsubscribe to enquire@).
 * Throws when Resend refuses it. `subjectPrefix` marks test sends ("[Test] "). `track`: a real send.
 * @returns {Promise<{ id: string }>}
 */
export async function sendAppInviteEmail({ to, person, copy = {}, options = DEFAULT_OPTIONS, swag = null, subjectPrefix = "", client = resend(), track = false, noteTracked = noteTrackedSend }) {
  if (!to) throw new Error("Missing email");
  const address = track ? String(to).trim().toLowerCase() : "";
  const { subject, html, text, attachments, tracked } = appInviteEmailFor({ ...person, email: to }, { inline: false, track: address, copy, options, swag });
  const { data, error } = await client.emails.send({
    from: FROM,
    to,
    reply_to: ENQUIRE_EMAIL,
    subject: `${subjectPrefix}${subject}`,
    html,
    text,
    attachments,
    headers: { "List-Unsubscribe": `<mailto:${ENQUIRE_EMAIL}?subject=unsubscribe>` },
    tags: [{ name: "campaign", value: APP_INVITE_CAMPAIGN }],
  });
  if (error) throw new Error(error.message || "Resend refused the email");
  if (!data?.id) throw new Error("Resend did not accept the email");
  if (tracked) noteTracked?.({ campaign: APP_INVITE_CAMPAIGN, email: address, ticketId: "" });
  return data;
}
