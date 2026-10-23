/* =========================================================
   Ticket confirmation email — HTML + plain text
   ---------------------------------------------------------
   Pure builder (no Resend, no env) so it can be unit-tested and
   previewed. sendTicketEmail() in services/emailService.js adds
   the signed links, the inline logo and the PDF attachment.

   Built for email clients, not browsers: table layout, inline
   styles, 600px max width, bulletproof buttons.

   ── WHY THIS EMAIL IS DARK ──────────────────────────────────
   It used to be a light email with a @media (prefers-color-scheme:
   dark) block. Gmail does NOT honour that media query in its apps;
   it runs its own colour inversion instead, which flipped the white
   panels to dark while leaving several near-black text colours
   alone — dark text on a dark panel. That is the contrast bug.

   The fix is to design dark in the first place. Gmail's dark mode
   leaves an already-dark email essentially untouched, so there is
   one appearance in every client instead of two, and nothing can be
   half-inverted. Every cell carries an explicit bgcolor AND a
   background style, and every piece of text an explicit light
   colour, so no client has to guess. Matches the Speaker Pass email
   (services/speakerPassEmail.js), which already works this way.

   ── EVERY WORD EDITABLE (Oct 19 2026) ───────────────────────
   Admin › Tickets & attendees › Purchase email (management) keeps
   staff's wording in the "purchase-email" EmailTemplate: one value
   per field, and per pass type for the pass name, tagline, paragraph,
   what's included and the tips (services/passEmailCopy.js). Anything
   not changed is the built-in text and markup below, byte for byte.
   Booth confirmations take only the header, event details, app and
   footer fields; their subject and wording stay the built-in ones.
========================================================= */

import {
  EVENT, APP_PROMO, PLAY_STORE_URL, appStoreUrl, PASS_INCLUSIONS, inclusionsFor, emailTips, displayPassName, isBoothId,
  firstNameFor, googleCalendarUrl, taglineFor, blurbFor, tierKey, escapeHtml as esc,
} from "./ticketInfo.js";
import { carryPassRules, fieldsFor, fillText, templateFor, textHtml } from "./passEmailCopy.js";

/* Dark palette. `panel` is the body surface, `card` the pass card.
   Text colours are all light — see the note above. */
export const C = {
  bg: "#06020f", panel: "#0d0620", card: "#150a2b", cardEdge: "#2b1a4f",
  soft: "#170d2e", hair: "#251845",
  purple: "#7a3fd1", pink: "#e8458b", gold: "#f5a623",
  white: "#ffffff", text: "#ddd5ef", muted: "#a596c7", dim: "#7d6fa0",
  // kept so older imports/tests that referenced these keys still resolve
  dark: "#06020f", ink: "#ffffff",
};
export const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
export const DISPLAY = "Orbitron,'Arial Black',Arial,Helvetica,sans-serif";
export const MONO = "'SFMono-Regular',Menlo,Consolas,'Courier New',monospace";

/** Inline logo CID — emailService attaches assets/email/ttfc-logo.png under this id. */
export const LOGO_CID = "ttfc-logo";

const label = (text, color = "#c2a9f5") =>
  `<div style="font-family:${SANS};font-size:11px;line-height:14px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:${color};">${esc(text)}</div>`;

const sectionTitle = (text) =>
  `<div style="font-family:${DISPLAY};font-size:13px;line-height:18px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase;color:${C.white};margin:0 0 14px;">${esc(text)}</div>`;

/** Black "Add to Apple Wallet" button in Apple's badge style (text version of the badge). */
export function walletButtonHtml(url) {
  if (!url) return "";
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
  <tr>
    <td align="center" bgcolor="#000000" style="background:#000000;border:1px solid #a6a6a6;border-radius:10px;">
      <a href="${esc(url)}" target="_blank" style="display:block;padding:10px 26px 11px;font-family:${SANS};color:#ffffff;text-decoration:none;text-align:center;">
        <span style="display:block;font-size:11px;line-height:13px;color:#ffffff;">Add to</span>
        <span style="display:block;font-size:19px;line-height:23px;font-weight:600;color:#ffffff;letter-spacing:-0.2px;">Apple Wallet</span>
      </a>
    </td>
  </tr>
</table>`;
}

/** The fields a booth confirmation takes from the template (the rest of the email is about a pass). */
const BOOTH_FIELDS = new Set(fieldsFor("purchase").filter((f) => f.booth).map((f) => f.key));

const isSet = (v) => (Array.isArray(v) ? v.length > 0 : typeof v === "string" && v.length > 0);
/** A pass type's list as sold (before this ticket's pass extras: CxO Breakfasts, luncheons, Gala, Awards). Names and lists come from
    services/ticketInfo.js, so the email agrees with the PDF and the Wallet pass it comes with. */
const baseInclusions = (tier) => [...(PASS_INCLUSIONS[tierKey(tier)] || inclusionsFor(tier))];

/**
 * Every field's built-in text for one purchase, placeholders not filled in (the admin editor shows it in grey).
 * `wallet`: the email has the Apple Wallet button; `named`: the buyer has a first name.
 */
export function purchaseEmailDefaults({ tier = "power", ticketId = "", cxoBreakfast, extras, wallet = true, named = true } = {}) {
  const booth = isBoothId(ticketId) || /^booth-/i.test(String(tier || ""));
  return {
    subject: booth ? "Your TTFC 2026 {passName} is confirmed" : "You're in — your TTFC 2026 {passName} is confirmed 🎟",
    preheader: booth
      ? `{passName} confirmed for ${EVENT.dates} at ${EVENT.venue}, Toronto.`
      : `{passName} · ${EVENT.dates} · ${EVENT.venue}, Toronto. Your ticket PDF is attached${wallet ? " and it's ready for Apple Wallet" : ""}.`,
    headerLabel: "Venue",
    headerVenue: EVENT.venue,
    headerAddress: EVENT.address,
    headline: named ? "You're in, {firstName}." : "You're in.",
    message: booth
      ? "Your {passName} at The Tech Festival Canada 2026 is confirmed. Your booking reference is below — our team will be in touch about exhibitor logistics."
      : `Your {passName} for The Tech Festival Canada 2026 is confirmed. Two days of frontier tech, deals and conversations at ${EVENT.venue}, Toronto — we can't wait to see you there.`,
    passName: displayPassName(tier, ticketId),
    labelAttendee: booth ? "Booked by" : "Attendee",
    labelTicketId: booth ? "Booking reference" : "Ticket ID",
    cardLine: `${EVENT.dates} · ${EVENT.venue}, Toronto`,
    qrCaption: "Scan at registration",
    walletCaption: "On iPhone, tap to add your pass — it pops up on your lock screen at the venue.",
    attachTitle: "Your ticket PDF is attached",
    attachCaption: booth ? "Keep it for your records." : "Show the QR code on your phone or print it — either works at registration.",
    includesTitle: "Your {passName} includes",
    tagline: booth ? "" : taglineFor(tier),
    blurb: booth ? "" : blurbFor(tier),
    includes: booth ? [] : inclusionsFor(tier, { cxoBreakfast, extras }),
    detailsTitle: "Event details",
    labelWhen: "When",
    whenText: `Monday–Tuesday, ${EVENT.dates}`,
    labelWhere: "Where",
    whereVenue: EVENT.venue,
    whereAddress: EVENT.address,
    mapsLink: "Open in Maps",
    labelDoors: "Doors",
    doorsText: EVENT.doors,
    calendarButton: "Add to Google Calendar",
    tipsTitle: "Know before you go",
    tips: booth ? [] : emailTips(tier),
    appEyebrow: "On the App Store and Google Play",
    appTitle: "Get the TTFC app",
    appBody: APP_PROMO.body,
    appStoreButton: "App Store",
    playButton: "Google Play",
    helpTitle: "Need a hand?",
    helpText: `Reply to this email or write to ${EVENT.supportEmail}. Quote your ticket ID {ticketId} so we can find your booking fast.`,
    contactLine: `${EVENT.websiteLabel} · Office ${EVENT.phone} · Toll free ${EVENT.tollFree}`,
    footerNote: "You're receiving this because a ticket for The Tech Festival Canada 2026 was purchased with this email address. The Tech Festival Canada · Toronto, Ontario",
  };
}

/**
 * @param {object} p
 * @param {string} p.name       attendee full name
 * @param {string} [p.firstName] for the greeting (falls back to the first word of name)
 * @param {string} p.ticketId
 * @param {string} p.tier
 * @param {string} [p.walletUrl] signed /api/wallet/pass link ("" hides the button)
 * @param {string} [p.qrUrl]     signed /api/wallet/qr image link ("" hides the QR)
 * @param {string} [p.logoSrc]   "cid:ttfc-logo" on a real send, a data: URI for a preview.
 *                               Empty renders the wordmark as text, so a caller that
 *                               doesn't attach the logo still gets a valid header.
 * @param {boolean} [p.cxoBreakfast] this ticket's "CxO Breakfast included" (services/cxoBreakfast.js); unset = the pass's own list
 * @param {object} [p.extras]   this ticket's effective pass extras ({ cxo, lunch, gala, awards }: true / false,
 *                              services/passExtras.js); a missing one = the pass's own list
 * @param {object} [p.template]  staff's wording ("purchase-email" EmailTemplate, services/passEmailCopy.js templateCopy); none = built-in
 * @returns {{ subject: string, preheader: string, html: string, text: string, defaults: object }}
 */
export function buildTicketEmail({ name, firstName, ticketId, tier, walletUrl = "", qrUrl = "", logoSrc = "", cxoBreakfast, extras, template = null } = {}) {
  const id = String(ticketId || "");
  const booth = isBoothId(id);
  const first = firstNameFor({ firstName, name });
  const fullName = String(name || "").trim() && String(name).trim().toLowerCase() !== "guest"
    ? String(name).trim() : (first || "Delegate");
  const wallet = booth ? "" : walletUrl;
  const qr = booth ? "" : qrUrl;
  const D = purchaseEmailDefaults({ tier, ticketId: id, cxoBreakfast, extras, wallet: !!wallet, named: !!first });

  // Staff's wording for this pass type (booths: only the shared sections), filled in for this buyer.
  const copy = template ? templateFor(template, tier) : {};
  const edited = Object.fromEntries(Object.keys(D).map((k) => [k, isSet(copy[k]) && (!booth || BOOTH_FIELDS.has(k))]));
  const raw = (k) => (edited[k] ? copy[k] : D[k]);
  const base = { firstName: first || "there", fullName, ticketId: id };
  const pass = fillText(raw("passName"), base);
  const vars = { ...base, passName: pass };
  const t = Object.fromEntries(Object.keys(D).map((k) => [k, Array.isArray(D[k]) ? null : fillText(raw(k), vars)]));
  const listOf = (k) => (edited[k] && k === "includes"
    ? carryPassRules(copy.includes, baseInclusions(tier), D.includes)
    : raw(k)).map((x) => fillText(x, vars));
  const includes = booth ? [] : listOf("includes");
  const tips = booth ? [] : listOf("tips");
  const html = (k, builtIn, opts) => (edited[k] ? textHtml(copy[k], vars, opts) : builtIn);
  const cal = googleCalendarUrl();
  const pdfName = `ttfc-pass-${id}.pdf`;

  const subject = t.subject;
  const preheader = t.preheader;

  const greeting = edited.headline ? esc(t.headline) : first ? `You're in, ${esc(first)}.` : "You're in.";
  const intro = html("message", booth
    ? `Your <strong style="color:${C.white};">${esc(pass)}</strong> at The Tech Festival Canada 2026 is confirmed. Your booking reference is below — our team will be in touch about exhibitor logistics.`
    : `Your <strong style="color:${C.white};">${esc(pass)}</strong> for The Tech Festival Canada 2026 is confirmed. Two days of frontier tech, deals and conversations at ${esc(EVENT.venue)}, Toronto — we can't wait to see you there.`,
  { wrap: { passName: (e) => `<strong style="color:${C.white};">${e}</strong>` } });

  /* ---------- header: brand logo on the brand's own dark ground ----------
     The logo is the white-wordmark PNG, so the band behind it must stay
     dark in every client — hence the explicit bgcolor + background. */
  const logoBlock = logoSrc
    ? `<img src="${esc(logoSrc)}" width="210" height="120" alt="The Tech Festival Canada — 26–27 Oct 2026" style="display:block;width:210px;max-width:210px;height:auto;border:0;outline:none;text-decoration:none;">`
    : `<div style="font-family:${DISPLAY};font-size:24px;line-height:28px;font-weight:800;letter-spacing:2px;color:#ffffff;">TTFC 2026</div>
      <div style="font-family:${SANS};font-size:10px;line-height:14px;font-weight:600;letter-spacing:2.4px;color:#c9b8f2;margin-top:4px;">THE TECH FESTIVAL CANADA</div>`;

  /* ---------- pass card ---------- */
  const qrCell = qr ? `
            <td class="em-stack em-qr" width="170" align="center" valign="middle" style="padding:22px 22px 22px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
                <tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:12px;padding:10px;">
                  <img src="${esc(qr)}" width="128" height="128" alt="Ticket QR code ${esc(id)}" style="display:block;width:128px;height:128px;border:0;outline:none;">
                </td></tr>
              </table>
              <div style="font-family:${SANS};font-size:11px;line-height:15px;color:${C.muted};margin-top:8px;text-align:center;">${esc(t.qrCaption)}</div>
            </td>` : "";

  const card = `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.card}" style="background:${C.card};border:1px solid ${C.cardEdge};border-radius:16px;border-collapse:separate;">
  <tr>
    <td height="5" bgcolor="${C.pink}" style="height:5px;line-height:5px;font-size:0;border-radius:16px 16px 0 0;background:${C.pink};background-image:linear-gradient(90deg,${C.purple},${C.pink} 60%,${C.gold});">&nbsp;</td>
  </tr>
  <tr>
    <td style="padding:0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td class="em-stack" valign="top" style="padding:22px 24px;">
            ${label(t.labelAttendee)}
            <div style="font-family:${SANS};font-size:22px;line-height:28px;font-weight:700;color:#ffffff;margin:4px 0 14px;">${esc(fullName)}</div>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td bgcolor="${C.purple}" style="background:${C.purple};background-image:linear-gradient(90deg,${C.purple},${C.pink});border-radius:999px;padding:7px 16px;font-family:${DISPLAY};font-size:12px;line-height:14px;font-weight:800;letter-spacing:1.3px;color:#ffffff;text-transform:uppercase;white-space:nowrap;">${esc(pass)}</td>
            </tr></table>
            <div style="height:16px;line-height:16px;font-size:0;">&nbsp;</div>
            ${label(t.labelTicketId)}
            <div style="font-family:${MONO};font-size:18px;line-height:24px;font-weight:700;letter-spacing:1.5px;color:${C.gold};margin-top:3px;">${esc(id)}</div>
            <div style="font-family:${SANS};font-size:13px;line-height:19px;color:${C.text};margin-top:12px;">${esc(t.cardLine)}</div>
          </td>${qrCell}
        </tr>
      </table>
    </td>
  </tr>
</table>`;

  /* ---------- wallet + attachment ---------- */
  const walletBlock = wallet ? `
<tr><td class="em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:22px 32px 4px;" align="center">
  ${walletButtonHtml(wallet)}
  <div style="font-family:${SANS};font-size:12px;line-height:17px;color:${C.muted};margin-top:8px;text-align:center;">${html("walletCaption", esc(t.walletCaption))}</div>
</td></tr>` : "";

  const attachBlock = `
<tr><td class="em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:20px 32px 6px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.soft}" style="background:${C.soft};border:1px solid ${C.hair};border-radius:12px;border-collapse:separate;">
    <tr>
      <td width="34" valign="top" style="padding:16px 0 16px 14px;font-size:22px;line-height:24px;">📎</td>
      <td style="padding:16px 18px 16px 10px;font-family:${SANS};font-size:14px;line-height:21px;color:${C.text};">
        <strong style="color:${C.white};">${esc(t.attachTitle)}</strong> (${esc(pdfName)}).
        ${html("attachCaption", esc(t.attachCaption))}
      </td>
    </tr>
  </table>
</td></tr>`;

  /* ---------- includes ---------- */
  /* Same tagline and paragraph the pass card carries on the website, so the
     email restates the promise the buyer actually bought on. Both are blank
     for tiers without published copy, and the block simply omits them. */
  const tagline = booth ? "" : t.tagline;
  const blurb = booth ? "" : t.blurb;
  const passCopy = `${tagline ? `
  <div style="font-family:${SANS};font-size:16px;line-height:23px;font-weight:700;color:#ffffff;margin:0 0 8px;">${esc(tagline)}</div>` : ""}${blurb ? `
  <div style="font-family:${SANS};font-size:14px;line-height:22px;color:${C.text};margin:0 0 20px;">${html("blurb", esc(blurb))}</div>` : ""}`;

  const includesBlock = includes.length ? `
<tr><td class="em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:26px 32px 4px;">
  ${sectionTitle(t.includesTitle)}
  ${passCopy}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    ${includes.map((f) => `<tr>
      <td width="26" valign="top" style="padding:0 0 9px;font-family:${SANS};font-size:15px;line-height:20px;font-weight:700;color:${C.gold};">&#10003;</td>
      <td style="padding:0 0 9px;font-family:${SANS};font-size:15px;line-height:20px;color:${C.text};${/lounge|pre-matched|preferential/i.test(f) ? `font-weight:600;color:${C.white};` : ""}">${esc(f)}</td>
    </tr>`).join("")}
  </table>
</td></tr>` : "";

  /* ---------- event details ---------- */
  const row = (k, v) => `<tr>
      <td width="92" valign="top" style="padding:0 0 12px;">${label(k)}</td>
      <td valign="top" style="padding:0 0 12px;font-family:${SANS};font-size:15px;line-height:21px;color:${C.text};">${v}</td>
    </tr>`;
  const detailsBlock = `
<tr><td class="em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:22px 32px 4px;">
  <div style="height:1px;line-height:1px;font-size:0;background:${C.hair};margin:0 0 22px;">&nbsp;</div>
  ${sectionTitle(t.detailsTitle)}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    ${row(t.labelWhen, `<strong style="color:${C.white};">${esc(t.whenText)}</strong>`)}
    ${row(t.labelWhere, `<strong style="color:${C.white};">${esc(t.whereVenue)}</strong><br>${esc(t.whereAddress)}<br><a href="${esc(EVENT.mapsUrl)}" target="_blank" style="color:${C.gold};text-decoration:underline;">${esc(t.mapsLink)}</a>`)}
    ${row(t.labelDoors, html("doorsText", esc(t.doorsText)))}
  </table>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 4px;">
    <tr><td bgcolor="${C.soft}" style="background:${C.soft};border:2px solid ${C.purple};border-radius:10px;">
      <a href="${esc(cal)}" target="_blank" style="display:inline-block;padding:10px 20px;font-family:${SANS};font-size:14px;line-height:18px;font-weight:700;color:#ffffff;text-decoration:none;">&#128197;&nbsp; ${esc(t.calendarButton)}</a>
    </td></tr>
  </table>
</td></tr>`;

  const tipsBlock = tips.length ? `
<tr><td class="em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:22px 32px 4px;">
  ${sectionTitle(t.tipsTitle)}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    ${tips.map((x) => `<tr>
      <td width="20" valign="top" style="padding:0 0 9px;font-family:${SANS};font-size:15px;line-height:21px;color:${C.pink};">&#9679;</td>
      <td style="padding:0 0 9px;font-family:${SANS};font-size:14px;line-height:21px;color:${C.text};">${esc(x)}</td>
    </tr>`).join("")}
  </table>
</td></tr>` : "";

  /* ---------- the TTFC app: App Store and Google Play buttons (Oct 22 2026; "coming soon" until then) ----------
     The App Store button only while its link is set (services/ticketInfo.js appStoreUrl). */
  const stores = [
    ...(appStoreUrl() ? [{ label: t.appStoreButton, href: appStoreUrl() }] : []),
    { label: t.playButton, href: PLAY_STORE_URL },
  ];
  // Both the same size (124 × 34).
  const storePill = ({ label: text, href }) => `<td style="padding:10px 8px 0 0;">
          <table role="presentation" width="124" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;width:124px;"><tr>
            <td align="center" valign="middle" width="124" height="34" bgcolor="${C.purple}" style="width:124px;height:34px;border-radius:999px;background:${C.purple};background-image:linear-gradient(90deg,${C.purple},${C.pink});">
              <a href="${esc(href)}" target="_blank" style="display:block;width:124px;padding:9px 0;font-family:${SANS};font-size:13px;line-height:16px;font-weight:800;text-align:center;color:#ffffff;text-decoration:none;border-radius:999px;white-space:nowrap;">${esc(text)}</a>
            </td>
          </tr></table>
        </td>`;
  const appBlock = `
<tr><td class="em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:22px 32px 30px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.card}" style="background:${C.card};background-image:linear-gradient(90deg,${C.card},#2b0f5c);border:1px solid ${C.cardEdge};border-radius:14px;border-collapse:separate;">
    <tr>
      <td width="64" valign="middle" style="padding:18px 0 18px 18px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td width="46" height="46" align="center" valign="middle" bgcolor="${C.purple}" style="width:46px;height:46px;background:${C.purple};background-image:linear-gradient(135deg,${C.purple},${C.pink});border-radius:12px;font-size:22px;line-height:46px;">&#128241;</td>
        </tr></table>
      </td>
      <td valign="middle" style="padding:18px 20px 18px 14px;">
        ${label(t.appEyebrow, C.gold)}
        <div style="font-family:${DISPLAY};font-size:15px;line-height:21px;font-weight:800;color:#ffffff;margin:3px 0 4px;letter-spacing:0.5px;">${esc(t.appTitle)}</div>
        <div style="font-family:${SANS};font-size:13px;line-height:19px;color:${C.text};">${html("appBody", esc(t.appBody))}</div>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr>
        ${stores.map(storePill).join("")}
        </tr></table>
      </td>
    </tr>
  </table>
</td></tr>`;

  const helpLink = "color:#ffffff;text-decoration:underline;";
  const helpText = html("helpText",
    `Reply to this email or write to <a href="mailto:${EVENT.supportEmail}" style="${helpLink}">${EVENT.supportEmail}</a>. Quote your ticket ID <span style="font-family:${MONO};color:${C.gold};">${esc(id)}</span> so we can find your booking fast.`,
    { links: helpLink, wrap: { ticketId: (e) => `<span style="font-family:${MONO};color:${C.gold};">${e}</span>` } });
  const contactLine = html("contactLine", `<a href="${EVENT.website}" target="_blank" style="color:#ffffff;text-decoration:none;font-weight:600;">${EVENT.websiteLabel}</a>
      &nbsp;·&nbsp; <span style="white-space:nowrap;">Office ${EVENT.phone}</span> &nbsp;·&nbsp; <span style="white-space:nowrap;">Toll free ${EVENT.tollFree}</span>`,
  { links: helpLink });

  const out = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<!-- One fixed appearance. Declaring dark-only stops Apple Mail and Outlook
     from running a second inversion over an email that is already dark. -->
<meta name="color-scheme" content="dark only">
<meta name="supported-color-schemes" content="dark only">
<style>
  :root { color-scheme: dark only; supported-color-schemes: dark only; }
  body { margin:0; padding:0; -webkit-text-size-adjust:100%; background:${C.bg}; }
  a[x-apple-data-detectors] { color:inherit !important; text-decoration:none !important; }
  @media only screen and (max-width:620px) {
    .em-pad { padding-left:20px !important; padding-right:20px !important; }
    .em-stack { display:block !important; width:100% !important; box-sizing:border-box; }
    .em-qr { padding:0 24px 22px !important; text-align:left !important; }
    .em-h1 { font-size:26px !important; line-height:32px !important; }
    .em-logo { width:170px !important; max-width:170px !important; }
    .em-logo img { width:170px !important; max-width:170px !important; height:auto !important; }
    .em-head-addr { text-align:left !important; padding-top:16px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${C.bg};" bgcolor="${C.bg}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${C.bg};">${esc(preheader)}&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.bg}" style="background:${C.bg};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.panel}" style="width:100%;max-width:600px;background:${C.panel};border-radius:18px;overflow:hidden;">

<!-- header -->
<tr><td bgcolor="${C.bg}" class="em-pad" style="background:${C.bg};background-image:radial-gradient(circle at 90% 0%,rgba(122,63,209,0.55),rgba(6,2,15,0) 60%);padding:26px 32px 24px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td valign="middle" class="em-logo em-stack">${logoBlock}</td>
    <td valign="middle" align="right" width="230" class="em-stack em-head-addr" style="font-family:${SANS};text-align:right;">
      <!-- The logo already carries the dates; the header adds where. -->
      <div style="font-size:11px;line-height:15px;font-weight:700;letter-spacing:1.4px;color:${C.gold};text-transform:uppercase;">${esc(t.headerLabel)}</div>
      <a href="${esc(EVENT.mapsUrl)}" target="_blank" style="color:#ffffff;text-decoration:none;">
        <span style="display:block;font-size:14px;line-height:19px;font-weight:700;color:#ffffff;margin-top:6px;">${esc(t.headerVenue)}</span>
        <span style="display:block;font-size:12px;line-height:17px;color:#c9b8f2;margin-top:2px;">${esc(t.headerAddress)}</span>
      </a>
    </td>
  </tr></table>
</td></tr>
<tr><td height="4" bgcolor="${C.pink}" style="height:4px;line-height:4px;font-size:0;background:${C.pink};background-image:linear-gradient(90deg,${C.purple},${C.pink} 60%,${C.gold});">&nbsp;</td></tr>

<!-- greeting -->
<tr><td class="em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:34px 32px 22px;">
  <h1 class="em-h1" style="margin:0 0 12px;font-family:${SANS};font-size:30px;line-height:36px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">${greeting}</h1>
  <p style="margin:0;font-family:${SANS};font-size:16px;line-height:25px;color:${C.text};">${intro}</p>
</td></tr>

<!-- pass card -->
<tr><td class="em-pad" bgcolor="${C.panel}" style="background:${C.panel};padding:0 32px;">${card}</td></tr>
${walletBlock}
${attachBlock}
${includesBlock}
${detailsBlock}
${tipsBlock}
${appBlock}

<!-- help footer -->
<tr><td bgcolor="${C.bg}" class="em-pad" style="background:${C.bg};padding:28px 32px;">
  <div style="font-family:${SANS};font-size:15px;line-height:22px;font-weight:700;color:#ffffff;margin:0 0 6px;">${esc(t.helpTitle)}</div>
  <div style="font-family:${SANS};font-size:13px;line-height:20px;color:${C.text};margin:0 0 16px;">${helpText}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="font-family:${SANS};font-size:12px;line-height:18px;color:${C.muted};">
      ${contactLine}
    </td>
  </tr></table>
  <div style="height:1px;line-height:1px;font-size:0;background:${C.hair};margin:18px 0 14px;">&nbsp;</div>
  <div style="font-family:${SANS};font-size:11px;line-height:16px;color:${C.dim};">${html("footerNote", "You're receiving this because a ticket for The Tech Festival Canada 2026 was purchased with this email address. The Tech Festival Canada · Toronto, Ontario")}</div>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

  /* ---------- plain text ---------- */
  const pad = (k, n) => `${k}:`.padEnd(n);
  const lines = [
    edited.headline ? t.headline : first ? `You're in, ${first}.` : "You're in.",
    "",
    edited.message ? t.message : booth
      ? `Your ${pass} at The Tech Festival Canada 2026 is confirmed.`
      : `Your ${pass} for The Tech Festival Canada 2026 is confirmed.`,
    "",
    `${t.labelAttendee}: ${fullName}`,
    `Pass: ${pass}`,
    `${t.labelTicketId}: ${id}`,
    "",
    edited.attachTitle || edited.attachCaption
      ? `${t.attachTitle} (${pdfName}).${booth ? "" : ` ${t.attachCaption}`}`
      : `Your ticket PDF is attached (${pdfName}).${booth ? "" : " Show its QR code on your phone or printed at registration."}`,
    ...(wallet ? ["", `Add to Apple Wallet: ${wallet}`] : []),
    ...(includes.length
      ? ["", t.includesTitle.toUpperCase(),
         ...(tagline ? [`  ${tagline}`] : []),
         ...(blurb ? [`  ${blurb}`, ""] : []),
         ...includes.map((f) => `  - ${f}`)]
      : []),
    "",
    t.detailsTitle.toUpperCase(),
    `  ${pad(t.labelWhen, 7)}${t.whenText}`,
    `  ${pad(t.labelWhere, 7)}${t.whereVenue}, ${t.whereAddress}`,
    `  ${pad(t.labelDoors, 7)}${t.doorsText}`,
    `  ${t.calendarButton}: ${cal}`,
    ...(tips.length ? ["", t.tipsTitle.toUpperCase(), ...tips.map((x) => `  - ${x}`)] : []),
    "",
    edited.appTitle || edited.appEyebrow ? `${t.appTitle} — ${t.appEyebrow}`.toUpperCase() : APP_PROMO.title.toUpperCase(),
    `  ${t.appBody}`,
    ...stores.map((x) => `  ${x.label}: ${x.href}`),
    "",
    edited.helpTitle || edited.helpText ? `${t.helpTitle} ${t.helpText}` : `Questions? Reply to this email or write to ${EVENT.supportEmail}.`,
    edited.contactLine ? t.contactLine : `${EVENT.website} · ${EVENT.phone} · Toll free ${EVENT.tollFree}`,
    "",
    edited.footerNote ? t.footerNote : "The Tech Festival Canada · Toronto, Ontario",
  ];

  return { subject, preheader, html: out, text: lines.join("\n"), defaults: D };
}
