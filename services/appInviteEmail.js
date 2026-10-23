/* =========================================================
   The app invite email: HTML + plain text (Oct 20 2026)
   ---------------------------------------------------------
   "Your TTFC 2026 app is ready": the TTFC header like the other
   emails, a short why (their pass and check-in QR, the agenda, the
   venue map, networking and chat, live polls and Q&A), then the
   main call to action (Oct 22 2026, the organiser: "Prompt the users
   to download Android/iOS. Stop prompting people to install the web
   app"; Oct 23: "Make the CTA better"): a purple-edged panel with
   "Get the TTFC app", why, and two official-style badges, Download
   on the App Store and Get it on Google Play (black, grey edge, the
   store's logo as a PNG on the website and live text, both 200 × 58,
   side by side or stacked on a phone), each with its own switch (the
   App Store one only while the iPhone app's link is set:
   services/appInvite.js appStoreUrl), and "Free on iPhone and
   Android."; under the panel a small line to the web app (the
   tracked link, "Open the web app"), which becomes the big button if
   no badge shows.
   No "Add it to your home screen" steps any more. Then the address
   to sign in with.
   Every word but the badges' (the stores' own) comes from the
   editable wording (services/appInviteCopy.js). Dark like the other TTFC emails, with a light
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
import { unsubscribeFor } from "./unsubscribe.js";

export const ENQUIRE_EMAIL = "enquire@thetechfestival.com";
/** The store badges' words (the stores' own) and logos: small lossless PNGs on the website (public/email/, 56 px for
    28 px), white Apple logo and the four-colour Play triangle. */
export const STORE_BADGES = Object.freeze({
  appStore: Object.freeze({ id: "appStore", top: "Download on the", name: "App Store", text: "iPhone (App Store)", alt: "Apple", glyph: `${EVENT.website}/email/store-apple@2x.png` }),
  play: Object.freeze({ id: "play", top: "GET IT ON", name: "Google Play", text: "Android (Google Play)", alt: "Play", glyph: `${EVENT.website}/email/store-play@2x.png` }),
});
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
 * @param {string} [p.link]       the web app link (default: the web app, no token)
 * @param {string} [p.logoSrc]    "cid:…" or a data: URI ("" = the text wordmark)
 * @param {string} [p.logoLightSrc] the same for the light version (dark words; "" = the light logo everywhere)
 * @param {string} [p.pixelSrc]   a real send's open pixel ("" = none)
 * @param {string} [p.storeUrl]   the iPhone app's App Store link ("" = no App Store button)
 * @param {object} [p.swag]       the swag kit contest while it's on (services/swagRules.js swagSettings), else null:
 *                                the swag block after the intro and the swag subject
 * @param {string} [p.swagSrc]    the swag photo: "cid:swag-kit" or a data: URI
 * @param {string} [p.unsubscribeUrl] the footer's "Unsubscribe from TTFC emails" link (services/unsubscribe.js; "" = none)
 * @returns {{ subject, preheader, html, text, link }}
 */
export function buildAppInviteEmail({ copy = {}, options = DEFAULT_OPTIONS, firstName = "", email = "", link = "", logoSrc = "", logoLightSrc = "", pixelSrc = "", storeUrl = appStoreUrl(), swag = null, swagSrc = "", unsubscribeUrl = "" } = {}) {
  const c = effectiveCopy(copy);
  const vars = {
    firstName: String(firstName || "").trim(), email: String(email || "").trim(),
    ...(swag ? { kits: swag.kits, cutoff: longTime(swag.cutoff), announce: longTime(swag.announce) } : {}),
  };
  const url = link || appInviteLink();
  const opts = { ...DEFAULT_OPTIONS, ...(options || {}) };
  const showStore = opts.appStore !== false && !!storeUrl;
  const showPlay = opts.play !== false;
  const stores = [...(showStore ? [{ ...STORE_BADGES.appStore, href: storeUrl }] : []), ...(showPlay ? [{ ...STORE_BADGES.play, href: PLAY_STORE_URL }] : [])];
  const subject = fillInvite(swag && c.swagSubject ? c.swagSubject : c.subject, vars);
  const preheader = fillInvite(c.preheader, vars);
  const body = `font-family:${SANS};font-size:16px;line-height:26px;color:${C.text};margin:0 0 14px;`;

  const bullet = (t) => `
              <tr>
                <td valign="top" width="26" style="padding:0 0 10px;font-family:${SANS};font-size:15px;line-height:22px;color:${C.magenta};">&#9679;</td>
                <td valign="top" class="tx" style="padding:0 0 10px;font-family:${SANS};font-size:15px;line-height:22px;color:${C.text};">${line(t, vars)}</td>
              </tr>`;
  // The badges: black, a 1px #a6a6a6 edge, the store's logo and its two lines of live text, both exactly 200 × 58,
  // side by side (stacked on a phone). Tables and inline styles only; the logo is a PNG with alt text, so with images
  // off the badge still reads "Download on the App Store". Every part is a link.
  const badge = ({ href, top, name, glyph, alt }) => `
                <td class="sb" align="center" valign="top" style="padding:0 6px 10px;">
                  <table role="presentation" class="sbt" width="200" height="58" cellpadding="0" cellspacing="0" border="0" bgcolor="#000000" style="width:200px;height:58px;margin:0 auto;background:#000000;border:1px solid #a6a6a6;border-radius:12px;border-collapse:separate;"><tr>
                    <td width="62" height="56" align="right" valign="middle" style="width:62px;height:56px;padding:0;"><a href="${esc(href)}" target="_blank" style="display:block;padding:14px 10px 14px 24px;text-decoration:none;"><img src="${esc(glyph)}" width="28" height="28" alt="${esc(alt)}" style="display:block;width:28px;height:28px;border:0;outline:none;font-family:${SANS};font-size:9px;line-height:28px;color:#ffffff;"></a></td>
                    <td align="left" valign="middle" style="padding:0;"><a href="${esc(href)}" target="_blank" style="display:block;padding:9px 10px 9px 0;font-family:${SANS};color:#ffffff;text-decoration:none;white-space:nowrap;"><span style="display:block;font-size:11px;line-height:14px;font-weight:500;letter-spacing:${top === top.toUpperCase() ? "0.6px" : "0.1px"};color:#ffffff;">${esc(top)}</span><span style="display:block;font-size:21px;line-height:25px;font-weight:600;letter-spacing:-0.3px;color:#ffffff;">${esc(name)}</span></a></td>
                  </tr></table>
                </td>`;

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
    .sb { display:block !important; width:100% !important; padding:0 0 10px !important; }
  }
  @media (prefers-color-scheme: light) {
    body, .bg { background:#f6f2fb !important; }
    .panel { background:#ffffff !important; border-color:#e6def3 !important; }
    .cta { background:#ffffff !important; }
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

        <!-- The main call to action: "Get the TTFC app" and the App Store / Google Play badges (or, with neither, the web app's big button) -->
        <tr>
          <td class="pad" align="center" style="padding:28px 44px 6px;">
            ${stores.length ? `<table role="presentation" class="cta" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.panel}" style="background:${C.panel};border:2px solid ${C.purple};border-radius:18px;border-collapse:separate;">
              <tr><td align="center" style="padding:24px 16px 16px;">
                ${c.storesTitle ? `<div class="hd" style="font-family:${SANS};font-size:22px;line-height:28px;font-weight:800;color:${C.white};margin:0 0 6px;">${line(c.storesTitle, vars)}</div>` : ""}
                ${c.storesIntro ? `<div class="tx" style="font-family:${SANS};font-size:15px;line-height:22px;color:${C.text};margin:0 0 18px;">${line(c.storesIntro, vars)}</div>` : ""}
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="border-collapse:separate;margin:0 auto;"><tr>${stores.map(badge).join("")}
                </tr></table>
                ${c.buttonNote ? `<div class="mut" style="font-family:${SANS};font-size:13px;line-height:18px;color:${C.muted};margin:4px 0 0;">${line(c.buttonNote, vars)}</div>` : ""}
              </td></tr>
            </table>
            <div class="mut" style="font-family:${SANS};font-size:12px;line-height:18px;color:${C.dim};margin:14px 0 0;">${c.webAppText ? `${line(c.webAppText, vars)} ` : ""}<a href="${esc(url)}" target="_blank" class="lk" style="color:${C.muted};font-weight:600;text-decoration:underline;">${line(c.button, vars)}</a></div>`
              : button(url, fillInvite(c.button, vars))}
          </td>
        </tr>

        <!-- Signing in -->
        ${c.signIn ? `<tr>
          <td class="pad" style="padding:24px 44px 0;">
            ${para(c.signIn, vars, `font-family:${SANS};font-size:15px;line-height:24px;color:${C.text};margin:0 0 14px;`)}
          </td>
        </tr>` : ""}

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
            ${unsubscribeUrl ? `<br><a href="${esc(unsubscribeUrl)}" target="_blank" class="lk" style="color:#a596c7;text-decoration:underline;">Unsubscribe from TTFC emails</a>` : ""}
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
    ...(stores.length
      ? [
        ...(c.storesTitle ? [t(c.storesTitle).toUpperCase()] : []),
        ...(c.storesIntro ? [t(c.storesIntro)] : []),
        "",
        ...stores.map((x) => `  ${x.text}: ${x.href}`),
        "",
        ...(c.buttonNote ? [t(c.buttonNote)] : []),
        "",
        ...(c.webAppText ? [t(c.webAppText)] : []),
        `${t(c.button)}: ${url}`,
      ]
      : [`${t(c.button)}:`, url]),
    "",
    ...(c.signIn ? [t(c.signIn), ""] : []),
    t(c.signOff),
    ...(c.signature ? ["", t(c.signature)] : []),
    "",
    `${EVENT.name} · ${EVENT.dates}`,
    `${EVENT.venue}, ${EVENT.address}`,
    ...(c.footer ? [t(c.footer)] : []),
    ...(unsubscribeUrl ? [`Unsubscribe from TTFC emails: ${unsubscribeUrl}`] : []),
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
 * contest's settings while it's on (else null): the swag block, its subject and the photo. `headers`: the
 * List-Unsubscribe headers (one-click for a real send, the mailto alone for a preview or test).
 */
export function appInviteEmailFor(person, { inline = true, track = "", copy = {}, options = DEFAULT_OPTIONS, storeUrl = appStoreUrl(), swag = null } = {}) {
  const on = !!swag?.enabled;
  const unsub = unsubscribeFor(track, { real: !inline && !!track, mailto: ENQUIRE_EMAIL });
  const base = { copy, options, storeUrl, firstName: person?.firstName || "", email: person?.email || "", swag: on ? swag : null, unsubscribeUrl: unsub.url };
  if (inline) return { ...buildAppInviteEmail({ ...base, ...inlineLogos(on) }), attachments: [], tracked: false, headers: unsub.headers };
  const token = track ? signTrack({ c: APP_INVITE_CAMPAIGN, e: track }) : "";
  const extra = token ? { link: appInviteLink(token), pixelSrc: pixelUrlFor(token) } : {};
  return {
    ...buildAppInviteEmail({ ...base, logoSrc: `cid:${LOGO_CID}`, logoLightSrc: `cid:${LOGO_DARK_CID}`, ...(on ? { swagSrc: `cid:${SWAG_CID}` } : {}), ...extra }),
    attachments: logoAttachments(on), tracked: !!token, headers: unsub.headers,
  };
}

let resendClient = null;
const resend = () => (resendClient ||= new Resend(process.env.RESEND_API_KEY));

/**
 * Sends one app invite through Resend (from and reply-to enquire@). A real send (`track`) carries the person's own
 * unsubscribe link and the one-click List-Unsubscribe headers (services/unsubscribe.js); a test send ("[Test] ") the
 * preview link and the mailto. Throws when Resend refuses it.
 * @returns {Promise<{ id: string }>}
 */
export async function sendAppInviteEmail({ to, person, copy = {}, options = DEFAULT_OPTIONS, swag = null, subjectPrefix = "", client = resend(), track = false, noteTracked = noteTrackedSend }) {
  if (!to) throw new Error("Missing email");
  const address = track ? String(to).trim().toLowerCase() : "";
  const { subject, html, text, attachments, tracked, headers } = appInviteEmailFor({ ...person, email: to }, { inline: false, track: address, copy, options, swag });
  const { data, error } = await client.emails.send({
    from: FROM,
    to,
    reply_to: ENQUIRE_EMAIL,
    subject: `${subjectPrefix}${subject}`,
    html,
    text,
    attachments,
    headers,
    tags: [{ name: "campaign", value: APP_INVITE_CAMPAIGN }],
  });
  if (error) throw new Error(error.message || "Resend refused the email");
  if (!data?.id) throw new Error("Resend did not accept the email");
  if (tracked) noteTracked?.({ campaign: APP_INVITE_CAMPAIGN, email: address, ticketId: "" });
  return data;
}
