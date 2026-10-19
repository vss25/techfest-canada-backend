/* =========================================================
   Speakers' pass email — HTML + plain text
   ---------------------------------------------------------
   Since Oct 19 2026 a speaker's pass is a Power Pass (the passes are
   strictly four; "speaker" is their person type), so the email says
   "Power Pass" and still lists what speakers get: the CxO Breakfasts
   and the VIP Lounge on top of the Power Pass.
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
import { ARRIVE_EARLY_MIN, DAYS, LOUNGE, STAGE, arriveAt, dayPlans, fmtTime, minutesBetween, needsMicUp } from "./runOfShow.js";

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

/** What a speaker's Power Pass includes, being a speaker (email + plain text). */
export const SPEAKER_INCLUDES = [
  ["All-Access, Both Days", "Every keynote, stage and the expo floor"],
  ["CxO Breakfasts & Luncheons", "Every one, on both days"],
  ["The Gala Dinner", "Dinner and networking reception on Day 2"],
  ["Catalyst Awards Night", "Celebrating Canada's frontier tech on Day 1"],
  ["The VIP Lounge", "A quiet space to prepare and connect"],
];

/** Why speakers should RSVP (shown above the button and in the plain text). */
export const RSVP_REASON = "RSVP for the CxO breakfasts, luncheons, the Gala Dinner and the Catalyst Awards Night, so we can save your seat and plan catering.";

/**
 * What changes between pass emails. A speaker's Power Pass is the default; staff-issued passes
 * (services/issuedPasses.js) pass their own: label, access line, what's included, whether
 * there's an RSVP button, and the built-in wording ({firstName}/{fullName} filled in).
 */
export const SPEAKER_VARIANT = Object.freeze({
  label: SPEAKER_PASS_LABEL, access: "All Access · Speaker", includes: null, rsvp: true, rsvpReason: null,
});

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
      { filename: "ttfc-pass-qr.png", content: qr.toString("base64"), content_type: "image/png", content_id: QR_CID },
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
function passCard({ name, title, company, id, qrSrc, logoSrc, label = SPEAKER_PASS_LABEL, access = "All Access" }) {
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
              <tr><td bgcolor="${C.magenta}" style="background:${C.magenta};background-image:linear-gradient(90deg,${C.magenta} 0%,${C.orange} 100%);border-radius:999px;padding:7px 14px;font-family:${SANS};font-size:11px;line-height:13px;font-weight:800;letter-spacing:2.4px;color:#ffffff;white-space:nowrap;">${esc(String(label).toUpperCase())}</td></tr>
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
              ${detail("Access", esc(access))}
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
/* ---------- run of show (services/runOfShow.js) ---------- */

const SPEAKER_CONTACT = { name: "Lubna Soni", role: "Founder", email: "lubna@thetechfestival.com", phone: "+1 416 717 3020" };

function sessionCard(s, you) {
  const others = s.lineup || [];
  const lineup = others.length ? `
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;border-top:1px solid ${C.hair};">
                  ${others.map((p) => {
                    const me = p.name === you;
                    return `<tr>
                    <td valign="top" width="96" style="padding:9px 8px 0 0;font-family:${SANS};font-size:11px;line-height:16px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${C.dim};">${esc(p.role || "")}</td>
                    <td valign="top" style="padding:8px 0 0;font-family:${SANS};font-size:14px;line-height:20px;color:${me ? C.white : C.text};${me ? "font-weight:700;" : ""}">${esc(p.name)}${me ? " (you)" : ""}${p.org ? `<span style="color:${C.muted};font-weight:400;">, ${esc(p.org)}</span>` : ""}</td>
                  </tr>`;
                  }).join("")}
                </table>` : "";
  return `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.card}" style="background:${C.card};border:1px solid ${C.cardEdge};border-radius:16px;border-collapse:separate;margin:0 0 14px;">
              <tr><td style="padding:20px 22px;">
                ${eyebrow(`${DAYS[s.day].short} · ${fmtTime(s.start)} to ${fmtTime(s.end)} ET · ${minutesBetween(s.start, s.end)} min`, C.orange)}
                <div style="font-family:${SANS};font-size:18px;line-height:24px;font-weight:800;color:${C.white};margin:8px 0 4px;">${esc(s.title)}</div>
                <div style="font-family:${SANS};font-size:13px;line-height:19px;color:${C.muted};">${esc([s.format, s.role && `you're the ${s.role.toLowerCase()}`, STAGE].filter(Boolean).join(" · "))}</div>${lineup}
              </td></tr>
            </table>`;
}

function micUpCallout(sessions) {
  const times = sessions.filter((s) => needsMicUp(sessions, s)).map((s) => `${fmtTime(arriveAt(s.start))} on ${DAYS[s.day].short}`);
  return `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:4px 0 0;">
              <tr><td style="padding:16px 18px;border-radius:14px;border:1px solid ${C.orange};background:rgba(245,166,35,0.10);font-family:${SANS};font-size:15px;line-height:23px;color:${C.white};">
                <b>Please be in the ${LOUNGE} at least ${ARRIVE_EARLY_MIN} minutes before your session for mic fitting</b>${times.length ? `: by ${esc(times.join(" and "))}` : ""}.
              </td></tr>
            </table>`;
}

function dayTable(plan) {
  const rows = plan.items.map((it) => {
    const hl = it.kind !== "anchor";
    const time = `${fmtTime(it.start)}${it.end ? `<br><span style="font-size:10px;letter-spacing:1px;color:${C.dim};">TO ${esc(fmtTime(it.end))}</span>` : it.from ? `<br><span style="font-size:10px;letter-spacing:1px;color:${C.dim};">FROM</span>` : ""}`;
    return `<tr>
                  <td valign="top" width="78" style="padding:11px 8px 11px 12px;border-top:1px solid ${C.hair};${hl ? `border-left:3px solid ${it.kind === "micup" ? C.orange : C.magenta};` : "border-left:3px solid transparent;"}font-family:${SANS};font-size:13px;line-height:18px;font-weight:800;color:${C.white};">${time}</td>
                  <td valign="top" style="padding:11px 12px 11px 4px;border-top:1px solid ${C.hair};font-family:${SANS};">
                    <div style="font-size:14px;line-height:20px;font-weight:${hl ? 800 : 600};color:${C.white};">${esc(it.title)}</div>
                    <div style="font-size:12px;line-height:18px;color:${C.muted};">${esc(it.where)}${it.note ? ` · ${esc(it.note)}` : ""}</div>
                  </td>
                </tr>`;
  }).join("");
  return `
            <div style="font-family:${SANS};font-size:15px;line-height:22px;font-weight:800;color:${C.white};margin:22px 0 8px;">${esc(plan.long)}</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.panel}" style="background:${C.panel};border:1px solid ${C.hair};border-radius:14px;border-collapse:separate;overflow:hidden;">
              ${rows}
            </table>`;
}

/** The "Your run of show" block, or "" when the pass has no sessions. */
export function runOfShowHtml({ name, runOfShow }) {
  const sessions = runOfShow?.sessions || [];
  if (!sessions.length) return "";
  return `
        <!-- Run of show -->
        <tr>
          <td class="pad" style="padding:40px 44px 6px;">
            ${sectionTitle(sessions.length > 1 ? "Your sessions" : "Your session")}
            ${sessions.map((s) => sessionCard(s, name)).join("")}
            ${micUpCallout(sessions)}
          </td>
        </tr>
        <tr>
          <td class="pad" style="padding:30px 44px 6px;">
            ${sectionTitle("Your days, hour by hour")}
            <div style="font-family:${SANS};font-size:14px;line-height:22px;color:${C.text};">Your pass covers both days. Here's how they fit around your ${sessions.length > 1 ? "sessions" : "session"}.</div>
            ${dayPlans(runOfShow).map(dayTable).join("")}
            <div style="font-family:${SANS};font-size:13px;line-height:21px;color:${C.muted};margin:16px 0 0;">
              Sessions are recorded and media partners may be present, so assume everything is on the record. A closed media room is available if your team has interviews to run.
            </div>
          </td>
        </tr>
        <tr><td class="pad" style="padding:30px 44px 0;"><div style="border-top:1px solid ${C.hair};font-size:0;line-height:0;height:1px;">&nbsp;</div></td></tr>`;
}

/** Plain-text version of the run of show (lines, no trailing blank). */
export function runOfShowText({ name, runOfShow }) {
  const sessions = runOfShow?.sessions || [];
  if (!sessions.length) return [];
  const out = [sessions.length > 1 ? "YOUR SESSIONS" : "YOUR SESSION"];
  for (const s of sessions) {
    out.push(`  ${DAYS[s.day].short}, ${fmtTime(s.start)} to ${fmtTime(s.end)} ET (${minutesBetween(s.start, s.end)} min), ${STAGE}`);
    out.push(`  ${s.format ? `${s.format}: ` : ""}${s.title}${s.role ? ` (you're the ${s.role.toLowerCase()})` : ""}`);
    for (const p of s.lineup || []) out.push(`    ${p.role ? `${p.role}: ` : ""}${p.name}${p.name === name ? " (you)" : ""}${p.org ? `, ${p.org}` : ""}`);
    out.push("");
  }
  out.push(`  Please be in the ${LOUNGE} at least ${ARRIVE_EARLY_MIN} minutes before your session for mic fitting: by ${sessions.filter((s) => needsMicUp(sessions, s)).map((s) => `${fmtTime(arriveAt(s.start))} on ${DAYS[s.day].short}`).join(" and ")}.`, "");
  out.push("YOUR DAYS, HOUR BY HOUR");
  for (const plan of dayPlans(runOfShow)) {
    out.push(`  ${plan.long}`);
    for (const it of plan.items) out.push(`    ${fmtTime(it.start)}${it.end ? ` to ${fmtTime(it.end)}` : it.from ? " onwards" : ""}  ${it.title} (${it.where})`);
    out.push("");
  }
  out.push("  Sessions are recorded and media partners may be present, so assume everything is on the record. A closed media room is available if your team has interviews to run.");
  return out;
}

/**
 * The words staff can change (Admin → Speaker passes → Edit email). {firstName} and {fullName}
 * are filled in per speaker. An empty field means the built-in text below.
 */
export const DEFAULT_COPY = Object.freeze({
  subject: "{firstName}, your Power Pass and run of show for TTFC 2026",
  headline: "We're delighted to have you speaking at TTFC 2026.",
  message: `The conversations that shape Canada's frontier tech happen because people like you take the stage. We look forward to welcoming you to Toronto on ${EVENT.dates}. Your personal Power Pass is below, followed by your run of show.`,
});
export const COPY_LIMITS = Object.freeze({ subject: 200, headline: 200, message: 3000 });

/** Tidies edited wording: plain text, no control characters (new lines kept in the message). */
export function cleanCopy(raw = {}) {
  const out = {};
  for (const k of ["subject", "headline", "message"]) {
    if (raw[k] === undefined || raw[k] === null) continue;
    let v = String(raw[k]).replace(/\r\n?/g, "\n").replace(/[^\P{Cc}\n]/gu, "");
    v = k === "message" ? v.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : v.replace(/\s+/g, " ").trim();
    out[k] = v.slice(0, COPY_LIMITS[k]);
  }
  return out;
}

const fillCopy = (s, { firstName, fullName }) => String(s || "")
  .replace(/\{firstName\}/g, firstName).replace(/\{fullName\}/g, fullName).replace(/\{name\}/g, fullName);

export function buildSpeakerPassEmail({ name, title = "", company = "", ticketId, qrSrc = "", logoSrc = "", runOfShow = null, contact = "", copy = {}, variant = null } = {}) {
  const v = { ...SPEAKER_VARIANT, ...(variant || {}) };
  const isSpeaker = !variant;
  const includeList = v.includes || SPEAKER_INCLUDES;
  const rsvpReason = v.rsvpReason || RSVP_REASON;
  const fullName = String(name || "").replace(/\s+/g, " ").trim();
  const first = speakerFirstName(fullName) || "there";
  const id = displayTicketId(ticketId);
  const rsvpLink = personalRsvpUrl(fullName, id);
  const t = String(title || "").replace(/\s+/g, " ").trim();
  const co = String(company || "").replace(/\s+/g, " ").trim();

  const hasRos = !!runOfShow?.sessions?.length;
  const viaContact = contact === "handler";
  const fill = (s) => fillCopy(s, { firstName: first, fullName });
  const subject = copy.subject ? fill(copy.subject)
    : !isSpeaker ? fill(v.subject)
    : hasRos ? `${first}, your Power Pass and run of show for TTFC 2026` : `${first}, your Power Pass for TTFC 2026`;
  const headline = copy.headline ? fill(copy.headline) : isSpeaker ? DEFAULT_COPY.headline : fill(v.headline);
  const message = copy.message ? fill(copy.message)
    : !isSpeaker ? fill(v.message)
    : `The conversations that shape Canada's frontier tech happen because people like you take the stage. We look forward to welcoming you to Toronto on ${EVENT.dates}. Your personal Power Pass is below${hasRos ? ", followed by your run of show" : ""}.`;
  const messageHtml = message.split(/\n\s*\n/).map((p, i) => `<div style="font-family:${SANS};font-size:16px;line-height:26px;color:${C.text};margin:${i ? "14px" : "0"} 0 0;">${esc(p).replace(/\n/g, "<br>")}</div>`).join("");
  const preheader = isSpeaker
    ? `We're delighted to have you speaking at TTFC 2026. Your Power Pass, ticket ID and personal RSVP link are inside.`
    : `Your ${v.label} for TTFC 2026: ticket ID, check-in QR code${v.rsvp ? " and personal RSVP link" : ""} inside.`;

  const includes = includeList.map(([head, sub]) => `
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
            ${viaContact ? `<div style="font-family:${SANS};font-size:13px;line-height:20px;color:${C.text};margin:20px 0 0;padding:12px 14px;border:1px solid ${C.hair};border-radius:12px;background:${C.panel};">We're sending this to you as the contact for <b style="color:${C.white};">${esc(fullName)}</b>. Please share it with them, or forward this email.</div>` : ""}
            <div style="font-family:${SERIF};font-size:20px;line-height:28px;font-style:italic;color:${C.text};margin:26px 0 6px;">Dear ${esc(first)},</div>
            <div class="hero" style="font-family:${SANS};font-size:36px;line-height:42px;font-weight:800;letter-spacing:-0.8px;color:${C.white};margin:0 0 18px;">${esc(headline).replace("TTFC 2026", "TTFC&nbsp;2026")}</div>
            ${messageHtml}
          </td>
        </tr>

        <!-- Pass -->
        <tr>
          <td class="pad" style="padding:30px 44px 8px;">
            ${passCard({ name: fullName, title: t, company: co, id, qrSrc, logoSrc, label: v.label, access: v.access })}
          </td>
        </tr>

${runOfShowHtml({ name: fullName, runOfShow })}
        ${includeList.length ? `<!-- Included -->
        <tr>
          <td class="pad" style="padding:40px 44px 6px;">
            ${sectionTitle("Your pass includes")}
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${includes}
            </table>
          </td>
        </tr>` : ""}

        <tr><td class="pad" style="padding:6px 44px 0;"><div style="border-top:1px solid ${C.hair};font-size:0;line-height:0;height:1px;">&nbsp;</div></td></tr>

        ${v.rsvp ? `<!-- RSVP -->
        <tr>
          <td class="pad" style="padding:36px 44px 4px;">
            ${sectionTitle("Save your seat")}
            <div style="font-family:${SANS};font-size:15px;line-height:24px;color:${C.text};margin:0 0 20px;">${esc(rsvpReason)}</div>
            ${button(rsvpLink, "RSVP Now")}
            <div style="font-family:${SANS};font-size:12px;line-height:18px;color:${C.dim};margin:12px 0 0;">Your link opens the RSVP page with your details already filled in.</div>
          </td>
        </tr>` : ""}

        <!-- Contact -->
        <tr>
          <td class="pad" style="padding:40px 44px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.panel}" style="background:${C.panel};border:1px solid ${C.hair};border-radius:14px;border-collapse:separate;">
              <tr><td style="padding:20px 24px;font-family:${SANS};font-size:14px;line-height:22px;color:${C.text};">
                <span style="color:${C.white};font-weight:700;">Questions, travel or session details?</span><br>
                ${hasRos ? `Speaker enquiries: ${esc(SPEAKER_CONTACT.name)}, ${esc(SPEAKER_CONTACT.role)}, <a href="mailto:${SPEAKER_CONTACT.email}" style="color:${C.white};font-weight:600;">${SPEAKER_CONTACT.email}</a>, ${esc(SPEAKER_CONTACT.phone)}.<br>General and on the day: ` : "Reply to this email or write to "}<a href="mailto:${CONTACT_EMAIL}" style="color:${C.white};font-weight:600;">${CONTACT_EMAIL}</a>. We're glad to help.
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
            <span style="color:#5f527f;">This pass${v.rsvp ? " and your RSVP link are" : " is"} personal to you. Please keep your ticket ID to yourself.</span>
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
    ...(viaContact ? [`We're sending this to you as the contact for ${fullName}. Please share it with them, or forward this email.`, ""] : []),
    `Dear ${first},`,
    "",
    headline,
    "",
    message,
    "",
    `YOUR ${(isSpeaker ? SPEAKER_PASS_LABEL : v.label).toUpperCase()}`,
    `  ${fullName}${role ? `\n  ${role}` : ""}`,
    `  Dates:     ${EVENT.dates}`,
    `  Venue:     ${EVENT.venue}, ${EVENT.address}`,
    `  Ticket ID: ${id}`,
    `  Access:    ${v.access}`,
    "  Your check-in QR code is in the HTML version of this email.",
    "",
    ...(hasRos ? [...runOfShowText({ name: fullName, runOfShow }), ""] : []),
    ...(includeList.length ? ["YOUR PASS INCLUDES", ...includeList.map(([head, sub]) => `  - ${head}: ${sub}`), ""] : []),
    ...(v.rsvp ? ["SAVE YOUR SEAT", `  ${rsvpReason}`, "  Your personal RSVP link (your details are already filled in):", `  ${rsvpLink}`, ""] : []),
    hasRos
      ? `Questions, travel or session details? Speaker enquiries: ${SPEAKER_CONTACT.name}, ${SPEAKER_CONTACT.email}, ${SPEAKER_CONTACT.phone}. General and on the day: ${CONTACT_EMAIL}.`
      : `Questions, travel or session details? Reply to this email or write to ${CONTACT_EMAIL}.`,
    "",
    "With thanks, and see you in Toronto,",
    "The Tech Festival Canada team",
    "",
    `${EVENT.name} · ${EVENT.dates}`,
    `${EVENT.venue}, ${EVENT.address}`,
    `This pass${v.rsvp ? " and your RSVP link are" : " is"} personal to you. Please keep your ticket ID to yourself.`,
  ].join("\n");

  return { subject, preheader, html, text };
}

/** Subject/html/text for one pass. `inline: true` uses data: URIs (admin preview, local demo). */
export async function speakerPassEmailFor(pass, { inline = true, copy = {}, variant = null } = {}) {
  const base = { name: pass.name, title: pass.title, company: pass.company, ticketId: pass.ticketId, runOfShow: pass.runOfShow || null, contact: pass.contact || "", copy, variant };
  if (inline) return { ...buildSpeakerPassEmail({ ...base, ...(await inlineImageSrcs(pass.ticketId)) }), attachments: [] };
  const { srcs, attachments } = await speakerPassAttachments(pass.ticketId);
  return { ...buildSpeakerPassEmail({ ...base, ...srcs }), attachments };
}
