import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Resend } from "resend";
import { EVENT, escapeHtml as esc } from "./ticketInfo.js";
import { C, SANS, SERIF, LOGO_CID, button, logoPng, stripe } from "./attendingEmail.js";
import { ENQUIRE_EMAIL, FROM, LOGO_DARK_CID, logoDarkPng } from "./appInviteEmail.js";
import { effectiveCopy, fillSwagInvite } from "./swagInviteCopy.js";
import { INSTALL_URL, SWAG_PAGE, longTime } from "./swagRules.js";
import { pixelUrlFor, signTrack, withPixel } from "./trackToken.js";
import { noteTrackedSend } from "./engagementStore.js";

/* =========================================================
   The "Win the swag kit" email: HTML + plain text (Oct 22 2026)
   ---------------------------------------------------------
   For people who haven't signed in to the app yet: the TTFC header,
   the swag kit photo (inline, CID "swag-kit", linked to the rules
   page), what the app does, how to win (the top {kits} at {cutoff}),
   the big "Get the app" button (the install page, with
   utm_source=email&utm_campaign=app-swag, and a real send's signed
   token in the fragment, #r=…, like the app invite), the home-screen
   steps (the same wording as the install page), the sign-in address,
   "No purchase necessary" with the rules link, the footer. Every word
   is editable (services/swagInviteCopy.js). Dark like the other TTFC
   emails, with a light version for mail apps that ask for one. Real
   sends also carry the open pixel; previews and test sends neither.
   From and reply-to enquire@. Pure builder (buildSwagInviteEmail).
========================================================= */

export const APP_SWAG_CAMPAIGN = "app-swag-2026";
export const SWAG_CID = "swag-kit";
const SWAG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "email", "swag-kit.jpg");
let photo = null;
/** The 600 × 508 JPEG, as supplied (never re-encoded). */
export const swagJpg = () => (photo ||= fs.readFileSync(SWAG_FILE));

const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/** The button: the install page with the campaign's utm, and a real send's token in the fragment (never sent to a server). */
export function swagInviteLink(r = "") {
  const base = `${INSTALL_URL}?utm_source=email&utm_campaign=app-swag`;
  return typeof r === "string" && TOKEN.test(r) && r.length <= 400 ? `${base}#r=${r}` : base;
}

const para = (text, vars, style) => fillSwagInvite(text, vars).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  .map((p) => `<p class="tx" style="${style}">${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
const line = (text, vars) => esc(fillSwagInvite(text, vars));

/**
 * @param {object} p
 * @param {object} [p.copy]       staff's wording (merged over the built-in text here)
 * @param {object} p.swag         the contest (services/swagRules.js swagSettings): kits, cutoff
 * @param {string} [p.firstName]
 * @param {string} [p.email]      the address it goes to (the sign-in line)
 * @param {string} [p.link]       the button's link (default: the install page, no token)
 * @param {string} [p.photoSrc]   "cid:swag-kit" or a data: URI
 * @param {string} [p.logoSrc] / [p.logoLightSrc] / [p.pixelSrc]  as in the app invite
 * @returns {{ subject, preheader, html, text, link }}
 */
export function buildSwagInviteEmail({ copy = {}, swag, firstName = "", email = "", link = "", photoSrc = "", logoSrc = "", logoLightSrc = "", pixelSrc = "" } = {}) {
  const c = effectiveCopy(copy);
  const vars = { firstName: String(firstName || "").trim(), email: String(email || "").trim(), kits: swag?.kits ?? 3, cutoff: swag?.cutoff ? longTime(swag.cutoff) : "" };
  const url = link || swagInviteLink();
  const subject = fillSwagInvite(c.subject, vars);
  const preheader = fillSwagInvite(c.preheader, vars);
  const body = `font-family:${SANS};font-size:16px;line-height:26px;color:${C.text};margin:0 0 14px;`;
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
        <tr>
          <td class="pad glow" style="padding:36px 20px 6px;background-image:radial-gradient(ellipse at 85% 0%,rgba(122,63,209,0.38) 0%,rgba(6,2,15,0) 60%);">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="padding:0 24px;">
              <tr>
                <td valign="middle">${logoSrc
                  ? `<img class="logo-d" src="${esc(logoSrc)}" width="96" height="55" alt="The Tech Festival Canada" style="display:block;width:96px;height:auto;border:0;outline:none;">${logoLightSrc
                    ? `<img class="logo-l" src="${esc(logoLightSrc)}" width="96" height="55" alt="The Tech Festival Canada" style="display:none;mso-hide:all;width:96px;height:auto;border:0;outline:none;">` : ""}`
                  : `<span class="hd" style="font-family:${SANS};font-size:13px;font-weight:800;letter-spacing:2.6px;color:${C.white};">TTFC 2026</span>`}</td>
                <td valign="middle" align="right"><div class="eb" style="font-family:${SANS};font-size:10px;line-height:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${C.orange};">${esc(`${EVENT.datesShort} · Toronto`)}</div></td>
              </tr>
            </table>
            <div style="padding:0 24px;">
              ${c.eyebrow ? `<div class="mut" style="font-family:${SANS};font-size:10px;line-height:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${C.muted};margin:28px 0 0;">${line(c.eyebrow, vars)}</div>` : ""}
              <div class="hero" style="font-family:${SANS};font-size:36px;line-height:42px;font-weight:800;letter-spacing:-0.8px;color:${C.white};margin:8px 0 18px;">${line(c.heading, vars)}</div>
            </div>
            ${photoSrc ? `<a href="${esc(SWAG_PAGE)}" target="_blank" style="display:block;text-decoration:none;"><img src="${esc(photoSrc)}" width="560" alt="${line(c.imageAlt, vars)}" style="display:block;width:100%;max-width:560px;height:auto;border:0;outline:none;border-radius:14px;margin:0 auto;"></a>` : ""}
          </td>
        </tr>
        <tr>
          <td class="pad" style="padding:22px 44px 0;">
            <div class="tx" style="font-family:${SERIF};font-size:20px;line-height:28px;font-style:italic;color:${C.text};margin:0 0 10px;">${line(c.greeting, vars)}</div>
            ${para(c.intro, vars, body)}
            <table role="presentation" class="panel" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.panel}" style="background:${C.panel};border:1px solid ${C.hair};border-radius:16px;border-collapse:separate;margin:6px 0 0;">
              <tr><td style="padding:18px 22px 6px;">
                ${c.winTitle ? `<div class="eb" style="font-family:${SANS};font-size:12px;line-height:16px;font-weight:800;letter-spacing:2.4px;text-transform:uppercase;color:${C.orange};margin:0 0 10px;">${line(c.winTitle, vars)}</div>` : ""}
                ${para(c.winLine, vars, `font-family:${SANS};font-size:16px;line-height:24px;color:${C.text};margin:0 0 12px;`)}
              </td></tr>
            </table>
          </td>
        </tr>
        <tr>
          <td class="pad" align="center" style="padding:28px 44px 6px;">
            ${button(url, fillSwagInvite(c.button, vars))}
            ${c.buttonNote ? `<div class="mut" style="font-family:${SANS};font-size:12px;line-height:18px;color:${C.dim};margin-top:14px;">${line(c.buttonNote, vars)}</div>` : ""}
          </td>
        </tr>
        <tr>
          <td class="pad" style="padding:26px 44px 0;">
            <table role="presentation" class="panel" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.panel}" style="background:${C.panel};border:1px solid ${C.hair};border-radius:16px;border-collapse:separate;">
              <tr><td style="padding:22px 24px 10px;">
                <div class="hd" style="font-family:${SANS};font-size:17px;line-height:24px;font-weight:800;color:${C.white};margin:0 0 14px;">${line(c.homeTitle, vars)}</div>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
                  ${steps(c.iphoneTitle, c.iphoneSteps, C.purple)}
                  ${steps(c.androidTitle, c.androidSteps, C.magenta)}
                </tr></table>
              </td></tr>
            </table>
          </td>
        </tr>
        <tr>
          <td class="pad" style="padding:22px 44px 0;">
            ${c.signIn ? para(c.signIn, vars, `font-family:${SANS};font-size:15px;line-height:24px;color:${C.text};margin:0 0 12px;`) : ""}
            <div class="tx" style="font-family:${SANS};font-size:14px;line-height:22px;color:${C.text};margin:0 0 6px;">${line(c.rulesText, vars)} <a href="${esc(SWAG_PAGE)}" target="_blank" class="lk" style="color:${C.white};font-weight:700;text-decoration:underline;">${line(c.rulesLink || "Read the rules", vars)}</a></div>
          </td>
        </tr>
        <tr>
          <td class="pad" style="padding:20px 44px 36px;">
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

  const t = (s) => fillSwagInvite(s, vars);
  const text = [
    t(c.heading), "",
    t(c.greeting), "",
    t(c.intro), "",
    ...(c.winTitle ? [t(c.winTitle).toUpperCase()] : []), t(c.winLine), "",
    `${t(c.button)}:`, url, ...(c.buttonNote ? [t(c.buttonNote)] : []), "",
    t(c.homeTitle).toUpperCase(), "",
    `${t(c.iphoneTitle)}:`, ...(c.iphoneSteps || []).map((s, i) => `  ${i + 1}. ${t(s)}`), "",
    `${t(c.androidTitle)}:`, ...(c.androidSteps || []).map((s, i) => `  ${i + 1}. ${t(s)}`), "",
    ...(c.signIn ? [t(c.signIn), ""] : []),
    `${t(c.rulesText)} ${t(c.rulesLink || "Read the rules")}: ${SWAG_PAGE}`, "",
    t(c.signOff), ...(c.signature ? ["", t(c.signature)] : []), "",
    `${EVENT.name} · ${EVENT.dates}`, `${EVENT.venue}, ${EVENT.address}`, ...(c.footer ? [t(c.footer)] : []),
  ].join("\n").replace(/\n{3,}/g, "\n\n");

  return { subject, preheader, html: withPixel(html, pixelSrc), text, link: url };
}

const inline = () => ({
  photoSrc: `data:image/jpeg;base64,${swagJpg().toString("base64")}`,
  logoSrc: `data:image/png;base64,${logoPng().toString("base64")}`,
  logoLightSrc: `data:image/png;base64,${logoDarkPng().toString("base64")}`,
});
const attachments = () => [
  { filename: "ttfc-2026.png", content: logoPng().toString("base64"), content_type: "image/png", content_id: LOGO_CID },
  { filename: "ttfc-2026-light.png", content: logoDarkPng().toString("base64"), content_type: "image/png", content_id: LOGO_DARK_CID },
  { filename: "ttfc-swag-kit.jpg", content: swagJpg().toString("base64"), content_type: "image/jpeg", content_id: SWAG_CID },
];

/**
 * The email for one person. `inline`: data: URIs (the admin preview). `track`: the address a real send goes to (its
 * token in the button's link and the open pixel); never for previews or test sends.
 */
export function swagInviteEmailFor(person, { inline: asInline = true, track = "", copy = {}, swag } = {}) {
  const base = { copy, swag, firstName: person?.firstName || "", email: person?.email || "" };
  if (asInline) return { ...buildSwagInviteEmail({ ...base, ...inline() }), attachments: [], tracked: false };
  const token = track ? signTrack({ c: APP_SWAG_CAMPAIGN, e: track }) : "";
  const extra = token ? { link: swagInviteLink(token), pixelSrc: pixelUrlFor(token) } : {};
  return {
    ...buildSwagInviteEmail({ ...base, photoSrc: `cid:${SWAG_CID}`, logoSrc: `cid:${LOGO_CID}`, logoLightSrc: `cid:${LOGO_DARK_CID}`, ...extra }),
    attachments: attachments(), tracked: !!token,
  };
}

let resendClient = null;
const resend = () => (resendClient ||= new Resend(process.env.RESEND_API_KEY));

/** Sends one through Resend (from and reply-to enquire@, List-Unsubscribe to enquire@). Throws when Resend refuses it. */
export async function sendSwagInviteEmail({ to, person, copy = {}, swag, subjectPrefix = "", client = resend(), track = false, noteTracked = noteTrackedSend }) {
  if (!to) throw new Error("Missing email");
  const address = track ? String(to).trim().toLowerCase() : "";
  const e = swagInviteEmailFor({ ...person, email: to }, { inline: false, track: address, copy, swag });
  const { data, error } = await client.emails.send({
    from: FROM, to, reply_to: ENQUIRE_EMAIL, subject: `${subjectPrefix}${e.subject}`, html: e.html, text: e.text, attachments: e.attachments,
    headers: { "List-Unsubscribe": `<mailto:${ENQUIRE_EMAIL}?subject=unsubscribe>` },
    tags: [{ name: "campaign", value: APP_SWAG_CAMPAIGN }],
  });
  if (error) throw new Error(error.message || "Resend refused the email");
  if (!data?.id) throw new Error("Resend did not accept the email");
  if (e.tracked) noteTracked?.({ campaign: APP_SWAG_CAMPAIGN, email: address, ticketId: "" });
  return data;
}
