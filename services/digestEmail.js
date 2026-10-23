import { Resend } from "resend";
import { EVENT, escapeHtml as esc } from "./ticketInfo.js";
import { C, SANS, SERIF, LOGO_CID, button, logoPng, stripe } from "./attendingEmail.js";
import { APP_URL } from "./appInvite.js";
import { ENQUIRE_EMAIL, FROM } from "./appInviteEmail.js";
import { appStoreBlockCss, appStoreBlockHtml, appStoreBlockLines } from "./appStoreBlock.js";

/* =========================================================
   The "What you missed" email (Oct 22 2026): HTML + plain text.
   ---------------------------------------------------------
   A short list of what happened in the app while they were away,
   grouped like the app (Messages, Connection requests, On your posts,
   Mentions, Discussions, Group and session chats), each line with
   who and a snippet, linking to that screen of the web app; one
   "Open TTFC" button; an unsubscribe line (one click turns
   "Email me a summary of what I missed" off). Dark like the other TTFC
   emails, with a light version for mail apps that ask for one.
   Under the button, the "Get the TTFC app" block (App Store and
   Google Play, services/appStoreBlock.js; Oct 23 2026).
   From and reply-to enquire@. Subject: the most important line,
   "+ N more", "on TTFC". Pure builder; services/digest.js sends.
   Items (services/digest.js missedFor):
     { kind: "dm", name, count, text, url }           a person's unread messages
     { kind: "request", name, text, url }             a connection request
     { kind: "comment" | "like", names, count, text, url }   on a post of theirs
     { kind: "mention", names, count, where, text, url }     "post" | "discussion"
     { kind: "reply", names, count, text, url }       replies in a discussion they follow
     { kind: "group", name, count, url }              a group or session chat
========================================================= */

export const SECTION_TITLES = Object.freeze({
  dm: "Messages", request: "Connection requests", comment: "On your posts", like: "On your posts",
  mention: "Mentions", reply: "Discussions", group: "Group and session chats",
});
/** Display order (and subject priority). */
export const KIND_ORDER = Object.freeze(["dm", "mention", "comment", "reply", "request", "like", "group"]);

const str = (v) => String(v ?? "");
const plural = (n, one, many) => (n === 1 ? one : many);
const who = (names = [], count = names.length) => {
  const list = [...new Set(names.map((n) => str(n).trim()).filter(Boolean))];
  const first = list[0] || "Someone";
  const rest = Math.max(0, Math.max(count, list.length) - 1);
  return rest ? `${first} and ${rest} ${plural(rest, "other", "others")}` : first;
};

/** One item's line: "Ann Lee sent you 3 messages", "Nicole and 2 others liked your post". */
export function itemHeadline(it) {
  const n = Number(it?.count) || 1;
  switch (it?.kind) {
    case "dm": return n > 1 ? `${who([it.name])} sent you ${n} messages` : `${who([it.name])} sent you a message`;
    case "request": return `${who([it.name])} wants to connect`;
    case "comment": return `${who(it.names, n)} commented on your post`;
    case "like": return `${who(it.names, n)} liked your post`;
    case "mention": return `${who(it.names, n)} mentioned you${it.where === "discussion" ? " in a discussion" : ""}`;
    case "reply": return `${n} new ${plural(n, "reply", "replies")} in a discussion you follow`;
    case "group": return `${n} new ${plural(n, "message", "messages")} in ${str(it.name).trim() || "a group chat"}`;
    default: return "Something new in the app";
  }
}

/** Items in display order (kind order, then newest first). */
export const sortItems = (items = []) => [...items].sort((a, b) =>
  KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || new Date(b.at || 0) - new Date(a.at || 0));

/** "Gunant commented on your post + 3 more on TTFC". */
export function digestSubject(items = []) {
  const sorted = sortItems(items);
  if (!sorted.length) return "What you missed on TTFC";
  const rest = sorted.length - 1;
  return `${itemHeadline(sorted[0])}${rest ? ` + ${rest} more` : ""} on TTFC`;
}

/** The web app address for an item's route ("/app/post/…" → https://www.thetechfestival.com/app/post/…). */
export const appLink = (route = "/app/") => `${APP_URL.replace(/\/app\/$/, "")}${str(route).startsWith("/app") ? route : "/app/"}`;

/** Made-up items for a test send when the admin has nothing waiting themselves. */
export const SAMPLE_ITEMS = Object.freeze([
  { kind: "dm", name: "Jane Doe", count: 2, text: "Are you coming to the AI keynote?", url: "/app/chats" },
  { kind: "comment", names: ["Sam Lee"], count: 1, text: "FOUR DAYS TO GO!!!!", url: "/app/" },
  { kind: "like", names: ["Ann Chen", "Raj Patel", "Mo Ali"], count: 3, text: "FOUR DAYS TO GO!!!!", url: "/app/" },
  { kind: "group", name: "AI Keynote chat", count: 7, url: "/app/chats" },
].map((x) => Object.freeze(x)));

/**
 * @param {object} p
 * @param {string} [p.firstName]
 * @param {Array}  p.items          (see above)
 * @param {string} [p.unsubscribeUrl]  one-click "turn these off" ("" = only the settings line)
 * @param {string} [p.logoSrc]      "cid:…" or a data: URI ("" = the text wordmark)
 * @returns {{ subject, preheader, html, text, sections: [{ title, items: [{ headline, text, url }] }] }}
 */
export function buildDigestEmail({ firstName = "", items = [], unsubscribeUrl = "", logoSrc = "" } = {}) {
  const sorted = sortItems(items);
  const subject = digestSubject(sorted);
  const sections = [];
  for (const it of sorted) {
    const title = SECTION_TITLES[it.kind] || "In the app";
    let s = sections.find((x) => x.title === title);
    if (!s) sections.push((s = { title, items: [] }));
    s.items.push({ headline: itemHeadline(it), text: str(it.text).trim(), url: appLink(it.url) });
  }
  const greeting = `Hi ${str(firstName).trim() || "there"},`;
  const intro = "Here's what happened in the TTFC app while you were away.";
  const preheader = sections.flatMap((s) => s.items).slice(0, 3).map((x) => x.headline).join(" · ");
  const open = appLink("/app/");

  const line = (x) => `
              <tr><td style="padding:0 0 14px;">
                <a href="${esc(x.url)}" target="_blank" class="lk" style="font-family:${SANS};font-size:15px;line-height:22px;font-weight:700;color:${C.white};text-decoration:none;">${esc(x.headline)}</a>
                ${x.text ? `<div class="mut" style="font-family:${SANS};font-size:14px;line-height:20px;color:${C.muted};margin-top:2px;">“${esc(x.text)}”</div>` : ""}
              </td></tr>`;
  const section = (s) => `
        <tr>
          <td class="pad" style="padding:14px 44px 0;">
            <table role="presentation" class="panel" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.panel}" style="background:${C.panel};border:1px solid ${C.hair};border-radius:16px;border-collapse:separate;">
              <tr><td style="padding:20px 24px 6px;">
                <div class="eb" style="font-family:${SANS};font-size:12px;line-height:16px;font-weight:800;letter-spacing:2.4px;text-transform:uppercase;color:${C.orange};margin:0 0 14px;">${esc(s.title)}</div>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${s.items.map(line).join("")}
                </table>
              </td></tr>
            </table>
          </td>
        </tr>`;
  const off = unsubscribeUrl
    ? `Don't want these? <a href="${esc(unsubscribeUrl)}" target="_blank" class="lk" style="color:#a596c7;text-decoration:underline;">Turn off these emails</a>, or switch off "Email me a summary of what I missed" in the app's Settings › Notifications.`
    : `Don't want these? Switch off "Email me a summary of what I missed" in the app's Settings › Notifications.`;

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
              <td valign="middle" align="right"><div class="eb" style="font-family:${SANS};font-size:10px;line-height:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${C.orange};">What you missed</div></td>
            </tr></table>
            <div class="tx" style="font-family:${SERIF};font-size:20px;line-height:28px;font-style:italic;color:${C.text};margin:26px 0 8px;">${esc(greeting)}</div>
            <p class="tx" style="font-family:${SANS};font-size:16px;line-height:25px;color:${C.text};margin:0 0 6px;">${esc(intro)}</p>
          </td>
        </tr>
        ${sections.map(section).join("")}
        <tr>
          <td class="pad" align="center" style="padding:28px 44px 30px;">
            ${button(open, "Open TTFC")}
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
    greeting, "", intro, "",
    ...sections.flatMap((s) => [s.title.toUpperCase(), ...s.items.flatMap((x) => [`  • ${x.headline}${x.text ? ` — “${x.text}”` : ""}`, `    ${x.url}`]), ""]),
    `Open TTFC: ${open}`, "",
    ...appStoreBlockLines(), "",
    `${EVENT.name} · ${EVENT.dates}`,
    unsubscribeUrl ? `Turn off these emails: ${unsubscribeUrl}` : `Turn these off in the app: Settings › Notifications.`,
  ].join("\n");

  return { subject, preheader, html, text, sections };
}

let resendClient = null;
const resend = () => (resendClient ||= new Resend(process.env.RESEND_API_KEY));

/**
 * Sends one digest through Resend: from and reply-to enquire@, the one-click unsubscribe headers (RFC 8058).
 * Throws when Resend refuses it (`error.status` 429 when it's busy). `subjectPrefix` marks test sends.
 */
export async function sendDigestEmail({ to, firstName = "", items = [], unsubscribeUrl = "", subjectPrefix = "", client = resend() }) {
  if (!to) throw new Error("Missing email");
  const e = buildDigestEmail({ firstName, items, unsubscribeUrl, logoSrc: `cid:${LOGO_CID}` });
  const headers = unsubscribeUrl
    ? { "List-Unsubscribe": `<${unsubscribeUrl}>, <mailto:${ENQUIRE_EMAIL}?subject=unsubscribe>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
    : { "List-Unsubscribe": `<mailto:${ENQUIRE_EMAIL}?subject=unsubscribe>` };
  const { data, error } = await client.emails.send({
    from: FROM, to, reply_to: ENQUIRE_EMAIL, subject: `${subjectPrefix}${e.subject}`, html: e.html, text: e.text, headers,
    attachments: [{ filename: "ttfc-2026.png", content: logoPng().toString("base64"), content_type: "image/png", content_id: LOGO_CID }],
    tags: [{ name: "campaign", value: "digest" }],
  });
  if (error) throw Object.assign(new Error(error.message || "Resend refused the email"), { status: error.statusCode || error.status || 0 });
  if (!data?.id) throw new Error("Resend did not accept the email");
  return { id: data.id, subject: e.subject };
}
