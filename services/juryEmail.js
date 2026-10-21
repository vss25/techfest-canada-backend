/* =========================================================
   The jury emails: HTML + plain text (Oct 2026)
   ---------------------------------------------------------
   - Invite and reminder (Admin › Catalyst Awards › Jury, sent only
     when management clicks): the TTFC header like the other emails,
     the editable wording (services/juryEmailCopy.js), one button to
     the jury portal (thetechfestival.com/awards/jury-admin), how to
     sign in and the deadline.
   - The sign-in code (the portal's "Email me a code"): fixed
     wording, the 6-digit code, 15 minutes.
   Dark like the other TTFC emails, with a light version for mail
   apps that ask for one. No tracking pixel, no tracked links. From
   and reply-to enquire@ ("everything else through enquire").
   Pure builders (buildJuryEmail, buildJuryCodeEmail), unit-tested.
========================================================= */

import { Resend } from "resend";
import { EVENT, escapeHtml as esc } from "./ticketInfo.js";
import { C, SANS, SERIF, LOGO_CID, button, logoPng, stripe } from "./attendingEmail.js";
import { ENQUIRE_EMAIL, FROM, LOGO_DARK_CID, logoDarkPng } from "./appInviteEmail.js";
import { frontendBase } from "./emailLink.js";
import { effectiveCopy, fill } from "./juryEmailCopy.js";

export { ENQUIRE_EMAIL, FROM };
export const JURY_PATH = "/awards/jury-admin";
export const portalUrl = (base = frontendBase()) => `${base}${JURY_PATH}`;
export const CAMPAIGNS = Object.freeze({ invite: "jury-invite-2026", reminder: "jury-reminder-2026", code: "jury-code-2026" });

const para = (text, vars, style) => fill(text, vars).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  .map((p) => `<p class="tx" style="${style}">${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
const line = (text, vars) => esc(fill(text, vars));

function shell({ title, preheader, logoSrc = "", logoLightSrc = "", body }) {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<title>${esc(title)}</title>
<style>
  body { margin:0; padding:0; background:${C.bg}; }
  a { color:${C.white}; }
  @media only screen and (max-width:620px) {
    .wrap { width:100% !important; }
    .pad { padding-left:22px !important; padding-right:22px !important; }
    .hero { font-size:30px !important; line-height:36px !important; }
    .btn a { padding:17px 26px !important; font-size:16px !important; }
    .code { font-size:36px !important; letter-spacing:8px !important; }
  }
  @media (prefers-color-scheme: light) {
    body, .bg { background:#f6f2fb !important; }
    .panel { background:#ffffff !important; border-color:#e6def3 !important; }
    .hd, .hero, .sig, .code { color:#140a26 !important; }
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
          <td class="pad glow" style="padding:36px 44px 0;background-image:radial-gradient(ellipse at 85% 0%,rgba(122,63,209,0.38) 0%,rgba(6,2,15,0) 60%);">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td valign="middle">${logoSrc
                  ? `<img class="logo-d" src="${esc(logoSrc)}" width="96" height="55" alt="The Tech Festival Canada" style="display:block;width:96px;height:auto;border:0;outline:none;">${logoLightSrc
                    ? `<img class="logo-l" src="${esc(logoLightSrc)}" width="96" height="55" alt="The Tech Festival Canada" style="display:none;mso-hide:all;width:96px;height:auto;border:0;outline:none;">` : ""}`
                  : `<span class="hd" style="font-family:${SANS};font-size:13px;font-weight:800;letter-spacing:2.6px;color:${C.white};">TTFC 2026</span>`}</td>
                <td valign="middle" align="right"><div class="eb" style="font-family:${SANS};font-size:10px;line-height:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${C.orange};">${esc(`${EVENT.datesShort} · Toronto`)}</div></td>
              </tr>
            </table>
          </td>
        </tr>
${body}
        <tr><td>${stripe(2)}</td></tr>
        <tr>
          <td class="pad mut" align="center" style="padding:22px 44px 40px;font-family:${SANS};font-size:12px;line-height:19px;color:${C.dim};">
            ${esc(EVENT.name)} &middot; ${esc(EVENT.dates)}<br>
            ${esc(EVENT.venue)}, ${esc(EVENT.address)}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/**
 * The invite or the reminder.
 * @param {object} p
 * @param {"invite"|"reminder"} p.kind
 * @param {object} [p.copy]   staff's wording (over the built-in text)
 * @param {object} p.vars     services/juryEmailCopy.js varsFor
 * @param {string} [p.link]   the button's link (default: the jury portal)
 * @param {string} [p.logoSrc] / [p.logoLightSrc] "cid:…" or a data: URI ("" = the text wordmark)
 * @returns {{ subject, preheader, html, text, link }}
 */
export function buildJuryEmail({ kind = "invite", copy = {}, vars = {}, link = "", logoSrc = "", logoLightSrc = "" } = {}) {
  const c = effectiveCopy(kind, copy);
  const url = link || portalUrl();
  const subject = fill(c.subject, vars);
  const preheader = fill(c.preheader, vars);
  const bodyStyle = `font-family:${SANS};font-size:16px;line-height:26px;color:${C.text};margin:0 0 14px;`;
  const small = `font-family:${SANS};font-size:15px;line-height:24px;color:${C.text};margin:0 0 12px;`;
  const steps = kind === "invite" ? (c.steps || []) : [];
  const showDeadline = !!vars.hasDeadline && !!c.deadlineLine;

  const body = `
        <tr>
          <td class="pad" style="padding:6px 44px 6px;">
            ${c.eyebrow ? `<div class="mut" style="font-family:${SANS};font-size:10px;line-height:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${C.muted};margin:28px 0 0;">${line(c.eyebrow, vars)}</div>` : ""}
            <div class="hero" style="font-family:${SANS};font-size:36px;line-height:42px;font-weight:800;letter-spacing:-0.8px;color:${C.white};margin:8px 0 18px;">${line(c.heading, vars)}</div>
            <div class="tx" style="font-family:${SERIF};font-size:20px;line-height:28px;font-style:italic;color:${C.text};margin:0 0 10px;">${line(c.greeting, vars)}</div>
            ${para(c.intro, vars, bodyStyle)}
          </td>
        </tr>
        ${steps.length ? `<tr>
          <td class="pad" style="padding:10px 44px 0;">
            <table role="presentation" class="panel" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.panel}" style="background:${C.panel};border:1px solid ${C.hair};border-radius:16px;border-collapse:separate;">
              <tr><td style="padding:22px 24px 12px;">
                ${c.stepsTitle ? `<div class="eb" style="font-family:${SANS};font-size:12px;line-height:16px;font-weight:800;letter-spacing:2.4px;text-transform:uppercase;color:${C.orange};margin:0 0 14px;">${line(c.stepsTitle, vars)}</div>` : ""}
                ${steps.map((s, i) => `
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:0 0 10px;"><tr>
                  <td valign="top" width="32" style="padding:0;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr>
                      <td align="center" valign="middle" width="22" height="22" style="width:22px;height:22px;border-radius:11px;border:1px solid ${C.magenta};font-family:${SANS};font-size:11px;font-weight:800;color:${C.magenta};">${i + 1}</td>
                    </tr></table>
                  </td>
                  <td valign="top" class="tx" style="padding:1px 0 0;font-family:${SANS};font-size:15px;line-height:22px;color:${C.text};">${line(s, vars)}</td>
                </tr></table>`).join("")}
              </td></tr>
            </table>
          </td>
        </tr>` : ""}
        <tr>
          <td class="pad" align="center" style="padding:30px 44px 6px;">
            ${button(url, fill(c.button, vars))}
          </td>
        </tr>
        <tr>
          <td class="pad" style="padding:24px 44px 0;">
            ${c.signIn ? para(c.signIn, vars, small) : ""}
            ${showDeadline ? `<p class="tx" style="${small}"><strong class="hd" style="color:${C.white};">${line(c.deadlineLine, vars)}</strong></p>` : ""}
          </td>
        </tr>
        <tr>
          <td class="pad" style="padding:12px 44px 30px;">
            ${para(c.signOff, vars, small)}
            ${c.signature ? `<div class="sig" style="font-family:${SANS};font-size:15px;line-height:22px;font-weight:700;color:${C.white};margin-top:6px;">${line(c.signature, vars)}</div>` : ""}
            ${c.footer ? `<div class="mut" style="font-family:${SANS};font-size:12px;line-height:18px;color:${C.dim};margin-top:22px;">${line(c.footer, vars).replace(/\n/g, "<br>")}</div>` : ""}
          </td>
        </tr>`;

  const html = shell({ title: subject, preheader, logoSrc, logoLightSrc, body });
  const t = (s) => fill(s, vars);
  const text = [
    t(c.heading), "",
    t(c.greeting), "",
    t(c.intro), "",
    ...(steps.length ? [c.stepsTitle ? t(c.stepsTitle).toUpperCase() : "", ...steps.map((s, i) => `  ${i + 1}. ${t(s)}`), ""] : []),
    `${t(c.button)}:`, url, "",
    ...(c.signIn ? [t(c.signIn), ""] : []),
    ...(showDeadline ? [t(c.deadlineLine), ""] : []),
    t(c.signOff),
    ...(c.signature ? ["", t(c.signature)] : []),
    ...(c.footer ? ["", t(c.footer)] : []),
    "", `${EVENT.name} · ${EVENT.dates}`, `${EVENT.venue}, ${EVENT.address}`,
  ].join("\n").replace(/\n{3,}/g, "\n\n");
  return { subject, preheader, html, text, link: url };
}

export const CODE_SUBJECT = "Your Catalyst Awards jury sign-in code";

/** The sign-in code email (fixed wording). */
export function buildJuryCodeEmail({ code = "", minutes = 15, name = "", link = "", logoSrc = "", logoLightSrc = "" } = {}) {
  const url = link || portalUrl();
  const spaced = `${String(code).slice(0, 3)} ${String(code).slice(3)}`.trim();
  const first = String(name || "").trim().split(/\s+/)[0] || "";
  const preheader = `${spaced} is your code. It works once, for ${minutes} minutes.`;
  const small = `font-family:${SANS};font-size:15px;line-height:24px;color:${C.text};margin:0 0 12px;`;
  const body = `
        <tr>
          <td class="pad" style="padding:6px 44px 6px;">
            <div class="mut" style="font-family:${SANS};font-size:10px;line-height:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${C.muted};margin:28px 0 0;">The Catalyst Awards · Jury</div>
            <div class="hero" style="font-family:${SANS};font-size:32px;line-height:38px;font-weight:800;letter-spacing:-0.6px;color:${C.white};margin:8px 0 18px;">Your sign-in code</div>
            <p class="tx" style="${small}">${first ? `Hi ${esc(first)}, here` : "Here"} is your code for the Catalyst Awards jury portal. Enter it on the sign-in page.</p>
          </td>
        </tr>
        <tr>
          <td class="pad" style="padding:8px 44px 0;">
            <table role="presentation" class="panel" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.panel}" style="background:${C.panel};border:1px solid ${C.hair};border-radius:16px;border-collapse:separate;">
              <tr><td align="center" style="padding:22px 18px;">
                <div class="code" style="font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:42px;line-height:48px;font-weight:700;letter-spacing:10px;color:${C.white};">${esc(spaced)}</div>
              </td></tr>
            </table>
          </td>
        </tr>
        <tr>
          <td class="pad" style="padding:22px 44px 30px;">
            <p class="tx" style="${small}">It works once, for the next <strong class="hd" style="color:${C.white};">${esc(minutes)} minutes</strong>.</p>
            <p class="mut" style="font-family:${SANS};font-size:13px;line-height:20px;color:${C.muted};margin:0 0 10px;">Didn't ask for it? You can ignore this email. Nobody can sign in without the code.</p>
            <p class="mut" style="font-family:${SANS};font-size:13px;line-height:20px;color:${C.muted};margin:0;">Jury portal: <a class="lk" href="${esc(url)}" target="_blank" style="color:${C.white};text-decoration:underline;">${esc(url.replace(/^https?:\/\//, ""))}</a></p>
          </td>
        </tr>`;
  const html = shell({ title: CODE_SUBJECT, preheader, logoSrc, logoLightSrc, body });
  const text = [
    "Your sign-in code", "",
    `${first ? `Hi ${first}, here` : "Here"} is your code for the Catalyst Awards jury portal. Enter it on the sign-in page.`, "",
    `    ${spaced}`, "",
    `It works once, for the next ${minutes} minutes.`,
    "Didn't ask for it? You can ignore this email. Nobody can sign in without the code.", "",
    `Jury portal: ${url}`, "",
    `${EVENT.name} · ${EVENT.dates}`,
  ].join("\n");
  return { subject: CODE_SUBJECT, preheader, html, text };
}

const inlineLogos = () => ({
  logoSrc: `data:image/png;base64,${logoPng().toString("base64")}`,
  logoLightSrc: `data:image/png;base64,${logoDarkPng().toString("base64")}`,
});
const cidLogos = () => ({ logoSrc: `cid:${LOGO_CID}`, logoLightSrc: `cid:${LOGO_DARK_CID}` });
const logoAttachments = () => [
  { filename: "ttfc-2026.png", content: logoPng().toString("base64"), content_type: "image/png", content_id: LOGO_CID },
  { filename: "ttfc-2026-light.png", content: logoDarkPng().toString("base64"), content_type: "image/png", content_id: LOGO_DARK_CID },
];

/** The invite / reminder for the admin preview (data: logos). */
export const previewJuryEmail = (p) => buildJuryEmail({ ...p, ...inlineLogos() });

let resendClient = null;
const resend = () => (resendClient ||= new Resend(process.env.RESEND_API_KEY));

async function send(client, { to, subject, html, text, campaign }) {
  if (!to) throw new Error("Missing email");
  const { data, error } = await client.emails.send({
    from: FROM, to, reply_to: ENQUIRE_EMAIL, subject, html, text, attachments: logoAttachments(),
    tags: [{ name: "campaign", value: campaign }],
  });
  if (error) throw new Error(error.message || "Resend refused the email");
  if (!data?.id) throw new Error("Resend did not accept the email");
  return data;
}

/** Sends the invite or the reminder. `subjectPrefix`: "[Test] " for a test to yourself. Throws when Resend refuses it. */
export async function sendJuryEmail({ to, kind, copy = {}, vars = {}, subjectPrefix = "", client = resend() }) {
  const e = buildJuryEmail({ kind, copy, vars, ...cidLogos() });
  return send(client, { to, subject: `${subjectPrefix}${e.subject}`, html: e.html, text: e.text, campaign: CAMPAIGNS[kind] || CAMPAIGNS.invite });
}

/** Sends a sign-in code. */
export async function sendJuryCodeEmail({ to, code, name = "", minutes = 15, client = resend() }) {
  const e = buildJuryCodeEmail({ code, name, minutes, ...cidLogos() });
  return send(client, { to, subject: e.subject, html: e.html, text: e.text, campaign: CAMPAIGNS.code });
}
