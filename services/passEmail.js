/* =========================================================
   Pass email: every word editable (speakers', issued and
   exhibitor passes) — HTML + plain text
   ---------------------------------------------------------
   The email Admin › Speaker passes, Issue passes and Exhibitor
   passes send. Same look as before (services/speakerPassEmail.js
   has the images, links and palette), but every piece of visible
   text comes from a field staff can change (services/passEmailCopy.js:
   the fields, the template / per-pass levels, cleaning, escaping).
   With nothing edited the email is the built-in one, byte for byte
   (test/pass-email-copy.test.js compares it with buildSpeakerPassEmail's).
   The built-in text comes from the same places as before: the Speaker
   Pass's name, access line, list and RSVP reason from
   services/speakerPassEmail.js (SPEAKER_VARIANT, SPEAKER_INCLUDES),
   an issued or exhibitor pass's from services/issuedPasses.js
   (ISSUE_TIERS, issuedVariant).

   Pure builder (buildPassEmail). Images are `src` strings: "cid:…"
   for sending (passEmailFor({ inline: false })), data: URIs for the
   admin preview. A real send may add a 1×1 open pixel (`pixelSrc`, from
   the pass's `openPixel`: services/engagementStore.js passEmailPixel);
   previews never have one. Every value is HTML-escaped; staff text never
   becomes HTML (line breaks are kept, email addresses in the contact
   box become links). Email-safe: tables, inline styles, 600px max.
   After the RSVP section, before the contact box: the fixed "Get the
   TTFC app" block with the App Store and Google Play badges
   (services/appStoreBlock.js; Oct 23 2026), in the HTML and the text.
========================================================= */

import { EVENT, escapeHtml as esc, tierKey } from "./ticketInfo.js";
import {
  C, CONTACT_EMAIL, DEFAULT_COPY, RSVP_REASON, SPEAKER_INCLUDES, SPEAKER_VARIANT, displayTicketId, inlineImageSrcs, personalRsvpUrl,
  speakerPassAttachments,
} from "./speakerPassEmail.js";
import { speakerFirstName } from "./speakerPasses.js";
import { ANCHORS, ARRIVE_EARLY_MIN, DAYS, LOUNGE, STAGE, arriveAt, dayPlans, fmtTime, minutesBetween, needsMicUp } from "./runOfShow.js";
import { ISSUE_TIERS, defaultIssuedCopy, includesWithExtras, issuedVariant, rsvpReasonFor } from "./issuedPasses.js";
import { EXTRA_KEYS, autoExtras, effectiveExtras } from "./passExtras.js";
import { carryPassRules, fillText, mergeCopy, textHtml, tierFor } from "./passEmailCopy.js";
import { withPixel } from "./trackToken.js";
import { appStoreBlockCss, appStoreBlockHtml, appStoreBlockLines } from "./appStoreBlock.js";

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',Times,serif";
const MONO = "'SFMono-Regular',Menlo,Consolas,'Courier New',monospace";

/**
 * The Speaker Pass email (Admin › Speaker passes): its name, access line, list and RSVP reason.
 * `override`: staff's pass extras on this speaker's pass (services/passExtras.js extrasOverride); the Speaker
 * Pass includes all four, so a "No" takes that one out of the list and the RSVP reason.
 */
export function speakerVariant(override = {}) {
  const extras = effectiveExtras({ ticketType: "speaker", override });
  const auto = autoExtras("speaker");
  const changed = EXTRA_KEYS.some((x) => extras[x] !== auto[x]);
  return {
    ...SPEAKER_VARIANT,
    includes: changed ? includesWithExtras(SPEAKER_INCLUDES, extras).map((r) => [...r]) : SPEAKER_INCLUDES.map((r) => [...r]),
    rsvpReason: changed ? rsvpReasonFor("speaker", extras) : SPEAKER_VARIANT.rsvpReason || RSVP_REASON,
    extras,
  };
}

/**
 * The pass-type settings of an issued or exhibitor pass for the email: issuedVariant
 * (services/issuedPasses.js) with the template's wording for its pass type (`template.tiers.<type>`:
 * passName, access, includes, rsvpText). The pass's own name ("Name on the pass") still beats the template's.
 */
export function passVariant(a, { copyFor = defaultIssuedCopy, template = {} } = {}) {
  const v = issuedVariant(a, { copyFor });
  const t = tierKey(a?.ticketType);
  const key = ISSUE_TIERS[t] ? t : "influence";
  const tierCopy = template?.tiers?.[tierFor(key)] || {};
  const own = v.label !== ISSUE_TIERS[key].label ? v.label : "";
  const label = own || tierCopy.passName || v.label;
  return {
    ...v,
    tier: tierFor(key),
    label,
    access: tierCopy.access || v.access,
    includes: tierCopy.includes?.length ? carryPassRules(tierCopy.includes, ISSUE_TIERS[key].includes, v.includes) : v.includes,
    rsvpReason: tierCopy.rsvpText || v.rsvpReason,
    ...(label !== v.label ? copyFor(label) : {}),
  };
}

/** "Name on the pass" for a speaker's pass: one line, never a retired name ("All Access Pass", "Exhibitor Pass"). */
export function cleanPassLabel(raw) {
  const l = String(raw ?? "").replace(/[^\P{Cc}]/gu, "").replace(/\s+/g, " ").trim().slice(0, 40);
  return /^(all access|exhibitor)\s+pass(es)?$/i.test(l) ? "" : l;
}

/** A made-up run of show for the speakers' sample email (Edit email's preview), so the day plan shows. */
export const SAMPLE_RUN_OF_SHOW = Object.freeze({
  sessions: [{
    day: 1, start: "10:30", end: "11:10", title: "Frontier AI in Practice", format: "Panel", role: "Panellist",
    lineup: [{ name: "Alex Sample", role: "Moderator", org: "Example Media" }, { name: "Jane Doe", role: "Panellist", org: "Example Corp" }],
  }],
});

/* ---------- the built-in text ---------- */

const DAY_ANCHORS = ["Reg", "Breakfast", "Lunch"];
const anchorId = (day, item) => {
  const i = (ANCHORS[day] || []).findIndex((a) => a.start === item.start && a.title === item.title);
  return i < 0 ? "" : i < DAY_ANCHORS.length ? DAY_ANCHORS[i] : `Evening${day}`;
};
const anchorOf = (day, id) => (ANCHORS[day] || []).find((a, i) => (i < DAY_ANCHORS.length ? DAY_ANCHORS[i] : `Evening${day}`) === id) || {};

/**
 * Every field's built-in text for one pass, placeholders not filled in (what the admin editor shows in grey).
 * `variant`: an issued / exhibitor pass's (passVariant); none = the speakers' email, with `extras` (staff's
 * switches on that speaker's pass, services/passExtras.js) taking a meal or event off its list.
 */
export function passEmailDefaults({ variant = null, runOfShow = null, extras = {} } = {}) {
  const isSpeaker = !variant;
  const v = isSpeaker ? speakerVariant(extras) : variant;
  const hasRos = !!runOfShow?.sessions?.length;
  const reg = anchorOf(1, "Reg");
  const breakfast = anchorOf(1, "Breakfast");
  const lunch = anchorOf(1, "Lunch");
  const ev1 = anchorOf(1, "Evening1");
  const ev2 = anchorOf(2, "Evening2");
  return {
    subject: isSpeaker ? `{firstName}, your {passName}${hasRos ? " and run of show" : ""} for TTFC 2026` : v.subject,
    preheader: isSpeaker
      ? "We're delighted to have you speaking at TTFC 2026. Your {passName}, ticket ID and personal RSVP link are inside."
      : `Your {passName} for TTFC 2026: ticket ID, check-in QR code${v.rsvp ? " and personal RSVP link" : ""} inside.`,
    eyebrow: "The Tech Festival Canada 2026",
    contactNotice: "We're sending this to you as the contact for {fullName}. Please share it with them, or forward this email.",
    greeting: "Dear {firstName},",
    headline: isSpeaker ? DEFAULT_COPY.headline : v.headline,
    message: isSpeaker
      ? `The conversations that shape Canada's frontier tech happen because people like you take the stage. We look forward to welcoming you to Toronto on ${EVENT.dates}. Your personal {passName} is below${hasRos ? ", followed by your run of show" : ""}.`
      : v.message,
    passName: v.label,
    presentedTo: "Presented to",
    labelDates: "Dates",
    datesText: EVENT.dates,
    labelVenue: "Venue",
    venueName: EVENT.venue,
    venueCity: EVENT.city.replace(", Ontario", ""),
    labelTicketId: "Ticket ID",
    labelAccess: "Access",
    access: v.access,
    qrCaption: "Scan at registration",
    cardFooter: `The Tech Festival Canada · Toronto · ${EVENT.datesShort}`,
    qrTextNote: "Your check-in QR code is in the HTML version of this email.",
    includesTitle: "Your pass includes",
    includes: (v.includes || []).map((r) => [...r]),
    rosTitle: "Your {sessions}",
    rosStage: STAGE,
    rosMicUp: `Please be in the ${LOUNGE} at least ${ARRIVE_EARLY_MIN} minutes before your session for mic fitting`,
    rosDaysTitle: "Your days, hour by hour",
    rosDaysIntro: "Your pass covers both days. Here's how they fit around your {sessions}.",
    rosRegTitle: reg.title, rosRegWhere: reg.where, rosRegNote: reg.note,
    rosBreakfastTitle: breakfast.title, rosBreakfastWhere: breakfast.where, rosBreakfastNote: breakfast.note,
    rosLunchTitle: lunch.title, rosLunchWhere: lunch.where, rosLunchNote: lunch.note,
    rosEvening1Title: ev1.title, rosEvening1Where: ev1.where, rosEvening1Note: ev1.note,
    rosEvening2Title: ev2.title, rosEvening2Where: ev2.where, rosEvening2Note: ev2.note,
    rosMicFittingTitle: `Mic fitting in the ${LOUNGE}`,
    rosMicFittingWhere: LOUNGE,
    rosMicFittingNote: `Please be here at least ${ARRIVE_EARLY_MIN} minutes before your session.`,
    rosMedia: "Sessions are recorded and media partners may be present, so assume everything is on the record. A closed media room is available if your team has interviews to run.",
    rsvpTitle: "Save your seat",
    rsvpText: v.rsvpReason || RSVP_REASON,
    rsvpButton: "RSVP Now",
    rsvpNote: "Your link opens the RSVP page with your details already filled in.",
    contactTitle: "Questions, travel or session details?",
    contactText: hasRos
      ? `Speaker enquiries: ${SPEAKER_CONTACT.name}, ${SPEAKER_CONTACT.role}, ${SPEAKER_CONTACT.email}, ${SPEAKER_CONTACT.phone}.\nGeneral and on the day: ${CONTACT_EMAIL}. We're glad to help.`
      : `Reply to this email or write to ${CONTACT_EMAIL}. We're glad to help.`,
    signoff: "With thanks, and see you in Toronto,",
    signature: "The Tech Festival Canada team",
    footer: `${EVENT.name} · ${EVENT.dates}\n${EVENT.venue}, ${EVENT.address}`,
    footerNote: `This pass${v.rsvp ? " and your RSVP link are" : " is"} personal to you. Please keep your ticket ID to yourself.`,
  };
}

const SPEAKER_CONTACT = { name: "Lubna Soni", role: "Founder", email: "lubna@thetechfestival.com", phone: "+1 416 717 3020" };

/* ---------- pieces (as in services/speakerPassEmail.js) ---------- */

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

/** The pass card: a badge-style ticket that reads well in every client. `t`: the filled-in text, `h`: HTML of edited multi-line fields. */
function passCard({ name, title, company, id, qrSrc, logoSrc, t, h }) {
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
              <tr><td bgcolor="${C.magenta}" style="background:${C.magenta};background-image:linear-gradient(90deg,${C.magenta} 0%,${C.orange} 100%);border-radius:999px;padding:7px 14px;font-family:${SANS};font-size:11px;line-height:13px;font-weight:800;letter-spacing:2.4px;color:#ffffff;white-space:nowrap;">${esc(String(t.passName).toUpperCase())}</td></tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td style="padding:26px 28px 6px;">
      ${eyebrow(t.presentedTo, C.orange)}
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
              ${detail(t.labelDates, esc(t.datesText))}
              ${detail(t.labelVenue, `${esc(t.venueName)}<br><span style="font-weight:400;color:${C.muted};">${esc(t.venueCity)}</span>`)}
              ${detail(t.labelTicketId, esc(id), `font-family:${MONO};font-size:17px;letter-spacing:2px;color:${C.white};`)}
              ${detail(t.labelAccess, esc(t.access))}
            </table>
          </td>
          <td class="stack qr" valign="top" align="right" width="170" style="width:170px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="right" style="border-collapse:separate;">
              <tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:14px;padding:10px;">
                <img src="${esc(qrSrc)}" width="150" height="150" alt="Check-in QR code for ticket ${esc(id)}" style="display:block;width:150px;height:150px;border:0;outline:none;">
              </td></tr>
              <tr><td align="center" style="padding:10px 0 0;font-family:${SANS};font-size:11px;line-height:14px;letter-spacing:1px;color:${C.muted};">${esc(t.qrCaption)}</td></tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td bgcolor="${C.panel}" style="background:${C.panel};border-top:1px solid ${C.hair};padding:13px 28px;font-family:${SANS};font-size:10px;line-height:14px;font-weight:700;letter-spacing:2px;color:${C.dim};text-transform:uppercase;">
      ${h.cardFooter}
    </td>
  </tr>
</table>`;
}

/* ---------- run of show (services/runOfShow.js) ---------- */

function sessionCard(s, you, stage) {
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
                <div style="font-family:${SANS};font-size:13px;line-height:19px;color:${C.muted};">${esc([s.format, s.role && `you're the ${s.role.toLowerCase()}`, stage].filter(Boolean).join(" · "))}</div>${lineup}
              </td></tr>
            </table>`;
}

const micUpTimes = (sessions) => sessions.filter((s) => needsMicUp(sessions, s)).map((s) => `${fmtTime(arriveAt(s.start))} on ${DAYS[s.day].short}`);

function micUpCallout(sessions, h) {
  const times = micUpTimes(sessions);
  return `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:4px 0 0;">
              <tr><td style="padding:16px 18px;border-radius:14px;border:1px solid ${C.orange};background:rgba(245,166,35,0.10);font-family:${SANS};font-size:15px;line-height:23px;color:${C.white};">
                <b>${h.rosMicUp}</b>${times.length ? `: by ${esc(times.join(" and "))}` : ""}.
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

/** The day plans with staff's wording: the fixed events, mic fitting and the stage. */
function wordedPlans(runOfShow, t, edited) {
  return dayPlans(runOfShow).map((plan) => ({
    ...plan,
    items: plan.items.map((it) => {
      if (it.kind === "micup") return { ...it, title: t.rosMicFittingTitle, where: t.rosMicFittingWhere, note: t.rosMicFittingNote };
      if (it.kind === "session") return edited.rosStage ? { ...it, where: t.rosStage } : it;
      const id = anchorId(plan.day, it);
      if (!id) return it;
      const pick = (part) => (edited[`ros${id}${part}`] ? t[`ros${id}${part}`] : it[part.toLowerCase()]);
      return { ...it, title: pick("Title"), where: pick("Where"), note: pick("Note") };
    }),
  }));
}

/** The "Your run of show" block, or "" when the pass has no sessions. */
function runOfShowHtml({ name, runOfShow }, t, h, edited) {
  const sessions = runOfShow?.sessions || [];
  if (!sessions.length) return "";
  return `
        <!-- Run of show -->
        <tr>
          <td class="pad" style="padding:40px 44px 6px;">
            ${sectionTitle(t.rosTitle)}
            ${sessions.map((s) => sessionCard(s, name, t.rosStage)).join("")}
            ${micUpCallout(sessions, h)}
          </td>
        </tr>
        <tr>
          <td class="pad" style="padding:30px 44px 6px;">
            ${sectionTitle(t.rosDaysTitle)}
            <div style="font-family:${SANS};font-size:14px;line-height:22px;color:${C.text};">${h.rosDaysIntro}</div>
            ${wordedPlans(runOfShow, t, edited).map(dayTable).join("")}
            <div style="font-family:${SANS};font-size:13px;line-height:21px;color:${C.muted};margin:16px 0 0;">
              ${h.rosMedia}
            </div>
          </td>
        </tr>
        <tr><td class="pad" style="padding:30px 44px 0;"><div style="border-top:1px solid ${C.hair};font-size:0;line-height:0;height:1px;">&nbsp;</div></td></tr>`;
}

/** Plain-text version of the run of show (lines, no trailing blank). */
function runOfShowText({ name, runOfShow }, t, edited) {
  const sessions = runOfShow?.sessions || [];
  if (!sessions.length) return [];
  const out = [t.rosTitle.toUpperCase()];
  for (const s of sessions) {
    out.push(`  ${DAYS[s.day].short}, ${fmtTime(s.start)} to ${fmtTime(s.end)} ET (${minutesBetween(s.start, s.end)} min), ${t.rosStage}`);
    out.push(`  ${s.format ? `${s.format}: ` : ""}${s.title}${s.role ? ` (you're the ${s.role.toLowerCase()})` : ""}`);
    for (const p of s.lineup || []) out.push(`    ${p.role ? `${p.role}: ` : ""}${p.name}${p.name === name ? " (you)" : ""}${p.org ? `, ${p.org}` : ""}`);
    out.push("");
  }
  out.push(`  ${t.rosMicUp}: by ${micUpTimes(sessions).join(" and ")}.`, "");
  out.push(t.rosDaysTitle.toUpperCase());
  for (const plan of wordedPlans(runOfShow, t, edited)) {
    out.push(`  ${plan.long}`);
    for (const it of plan.items) out.push(`    ${fmtTime(it.start)}${it.end ? ` to ${fmtTime(it.end)}` : it.from ? " onwards" : ""}  ${it.title} (${it.where})`);
    out.push("");
  }
  out.push(`  ${t.rosMedia}`);
  return out;
}

/* ---------- the email ---------- */

const isSet = (v) => (Array.isArray(v) ? v.length > 0 : typeof v === "string" && v.length > 0);

/**
 * @param {object} p
 * @param {string} p.name       the person's name on the pass ("Dr. Rulan S. Parekh")
 * @param {string} [p.title]
 * @param {string} [p.company]
 * @param {string} p.ticketId
 * @param {string} p.qrSrc      "cid:…" for sending, a data: URI for previews
 * @param {string} [p.logoSrc]  same; "" shows a text wordmark
 * @param {object} [p.runOfShow] the speaker's sessions (services/runOfShow.js)
 * @param {string} [p.contact]  "handler": the address belongs to their assistant or office
 * @param {object} [p.copy]     staff's wording, every level already merged (services/passEmailCopy.js mergeCopy):
 *                              any field set here replaces the built-in text
 * @param {object} [p.variant]  an issued / exhibitor pass (passVariant); none = the speakers' Speaker Pass email
 * @param {object} [p.extras]   the speakers' email: staff's pass extras on their pass (services/passExtras.js extrasOverride)
 * @param {string} [p.pixelSrc] a real send's open pixel ("" = none)
 * @returns {{ subject, preheader, html, text, defaults }} `defaults`: the built-in text of every field for this pass
 */
export function buildPassEmail({ name, title = "", company = "", ticketId, qrSrc = "", logoSrc = "", runOfShow = null, contact = "", copy = {}, variant = null, extras = {}, pixelSrc = "" } = {}) {
  const D = passEmailDefaults({ variant, runOfShow, extras });
  const fullName = String(name || "").replace(/\s+/g, " ").trim();
  const first = speakerFirstName(fullName) || "there";
  const id = displayTicketId(ticketId);
  const rsvpLink = personalRsvpUrl(fullName, id);
  const jobTitle = String(title || "").replace(/\s+/g, " ").trim();
  const co = String(company || "").replace(/\s+/g, " ").trim();
  const sessions = runOfShow?.sessions || [];
  const hasRos = sessions.length > 0;
  const viaContact = contact === "handler";
  const rsvp = variant ? variant.rsvp !== false : true;

  // Which fields staff changed (at any level), the raw text of each, and the filled-in text.
  const edited = Object.fromEntries(Object.keys(D).map((k) => [k, isSet(copy?.[k])]));
  const raw = (k) => (edited[k] ? copy[k] : D[k]);
  const base = { firstName: first, fullName, ticketId: id, sessions: sessions.length > 1 ? "sessions" : "session" };
  const passName = fillText(raw("passName"), base);
  const vars = { ...base, passName };
  const t = Object.fromEntries(Object.keys(D).map((k) => [k, Array.isArray(D[k]) ? null : fillText(raw(k), vars)]));
  const includeList = (raw("includes") || []).map(([head, sub]) => [fillText(head, vars), fillText(sub || "", vars)]);
  // Multi-line or marked-up fields: the built-in markup when nobody changed them, else staff's text, escaped.
  const link = `color:${C.white};font-weight:600;`;
  const html = (k, builtIn, opts) => (edited[k] ? textHtml(copy[k], vars, opts) : builtIn);
  const h = {
    contactNotice: html("contactNotice", `We're sending this to you as the contact for <b style="color:${C.white};">${esc(fullName)}</b>. Please share it with them, or forward this email.`,
      { wrap: { fullName: (e) => `<b style="color:${C.white};">${e}</b>` } }),
    cardFooter: html("cardFooter", `The Tech Festival Canada &middot; Toronto &middot; ${esc(EVENT.datesShort)}`),
    rosMicUp: edited.rosMicUp ? textHtml(String(copy.rosMicUp).replace(/[.\s]+$/, ""), vars) : `Please be in the ${LOUNGE} at least ${ARRIVE_EARLY_MIN} minutes before your session for mic fitting`,
    rosDaysIntro: html("rosDaysIntro", `Your pass covers both days. Here's how they fit around your ${sessions.length > 1 ? "sessions" : "session"}.`),
    rosMedia: html("rosMedia", "Sessions are recorded and media partners may be present, so assume everything is on the record. A closed media room is available if your team has interviews to run."),
    rsvpText: html("rsvpText", esc(t.rsvpText)),
    contactText: html("contactText", hasRos
      ? `Speaker enquiries: ${esc(SPEAKER_CONTACT.name)}, ${esc(SPEAKER_CONTACT.role)}, <a href="mailto:${SPEAKER_CONTACT.email}" style="${link}">${SPEAKER_CONTACT.email}</a>, ${esc(SPEAKER_CONTACT.phone)}.<br>General and on the day: <a href="mailto:${CONTACT_EMAIL}" style="${link}">${CONTACT_EMAIL}</a>. We're glad to help.`
      : `Reply to this email or write to <a href="mailto:${CONTACT_EMAIL}" style="${link}">${CONTACT_EMAIL}</a>. We're glad to help.`, { links: link }),
    footer: html("footer", `${esc(EVENT.name)} &middot; ${esc(EVENT.dates)}<br>
            ${esc(EVENT.venue)}, ${esc(EVENT.address)}`),
    footerNote: html("footerNote", esc(t.footerNote)),
  };
  if (edited.rosMicUp) t.rosMicUp = t.rosMicUp.replace(/[.\s]+$/, "");

  const subject = t.subject;
  const headline = t.headline;
  const message = t.message;
  const messageHtml = message.split(/\n\s*\n/).map((p, i) => `<div style="font-family:${SANS};font-size:16px;line-height:26px;color:${C.text};margin:${i ? "14px" : "0"} 0 0;">${esc(p).replace(/\n/g, "<br>")}</div>`).join("");
  const preheader = t.preheader;

  const includes = includeList.map(([head, sub]) => `
              <tr>
                <td valign="top" width="22" style="padding:3px 0 14px;"><div style="width:8px;height:8px;border-radius:2px;background:${C.magenta};background-image:linear-gradient(135deg,${C.purple},${C.magenta} 60%,${C.orange});font-size:0;line-height:0;margin-top:5px;">&nbsp;</div></td>
                <td valign="top" style="padding:0 0 14px;font-family:${SANS};">
                  <div style="font-size:15px;line-height:21px;font-weight:700;color:${C.white};">${esc(head)}</div>${sub ? `
                  <div style="font-size:13px;line-height:19px;color:${C.muted};">${esc(sub)}</div>` : ""}
                </td>
              </tr>`).join("");

  const out = `<!DOCTYPE html>
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
          <td class="pad" style="padding:44px 44px 8px;background-image:radial-gradient(ellipse at 85% 0%,rgba(122,63,209,0.35) 0%,rgba(6,2,15,0) 60%);">
            ${eyebrow(t.eyebrow, C.muted)}
            ${viaContact ? `<div style="font-family:${SANS};font-size:13px;line-height:20px;color:${C.text};margin:20px 0 0;padding:12px 14px;border:1px solid ${C.hair};border-radius:12px;background:${C.panel};">${h.contactNotice}</div>` : ""}
            <div style="font-family:${SERIF};font-size:20px;line-height:28px;font-style:italic;color:${C.text};margin:26px 0 6px;">${esc(t.greeting)}</div>
            <div class="hero" style="font-family:${SANS};font-size:36px;line-height:42px;font-weight:800;letter-spacing:-0.8px;color:${C.white};margin:0 0 18px;">${esc(headline).replace("TTFC 2026", "TTFC&nbsp;2026")}</div>
            ${messageHtml}
          </td>
        </tr>

        <!-- Pass -->
        <tr>
          <td class="pad" style="padding:30px 44px 8px;">
            ${passCard({ name: fullName, title: jobTitle, company: co, id, qrSrc, logoSrc, t, h })}
          </td>
        </tr>

${runOfShowHtml({ name: fullName, runOfShow }, t, h, edited)}
        ${includeList.length ? `<!-- Included -->
        <tr>
          <td class="pad" style="padding:40px 44px 6px;">
            ${sectionTitle(t.includesTitle)}
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${includes}
            </table>
          </td>
        </tr>` : ""}

        <tr><td class="pad" style="padding:6px 44px 0;"><div style="border-top:1px solid ${C.hair};font-size:0;line-height:0;height:1px;">&nbsp;</div></td></tr>

        ${rsvp ? `<!-- RSVP -->
        <tr>
          <td class="pad" style="padding:36px 44px 4px;">
            ${sectionTitle(t.rsvpTitle)}
            <div style="font-family:${SANS};font-size:15px;line-height:24px;color:${C.text};margin:0 0 20px;">${h.rsvpText}</div>
            ${button(rsvpLink, t.rsvpButton)}
            <div style="font-family:${SANS};font-size:12px;line-height:18px;color:${C.dim};margin:12px 0 0;">${esc(t.rsvpNote)}</div>
          </td>
        </tr>` : ""}

        <!-- Get the TTFC app (fixed, not a field: services/appStoreBlock.js) -->
        <tr>
          <td class="pad" style="padding:36px 44px 0;">
            ${appStoreBlockHtml()}
          </td>
        </tr>

        <!-- Contact -->
        <tr>
          <td class="pad" style="padding:40px 44px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.panel}" style="background:${C.panel};border:1px solid ${C.hair};border-radius:14px;border-collapse:separate;">
              <tr><td style="padding:20px 24px;font-family:${SANS};font-size:14px;line-height:22px;color:${C.text};">
                <span style="color:${C.white};font-weight:700;">${esc(t.contactTitle)}</span><br>
                ${h.contactText}
              </td></tr>
            </table>
          </td>
        </tr>

        <!-- Sign-off -->
        <tr>
          <td class="pad" style="padding:34px 44px 40px;">
            <div style="font-family:${SERIF};font-size:17px;line-height:26px;font-style:italic;color:${C.text};">${esc(t.signoff)}</div>
            <div style="font-family:${SANS};font-size:15px;line-height:22px;font-weight:700;color:${C.white};margin-top:6px;">${esc(t.signature)}</div>
          </td>
        </tr>

        <tr><td>${stripe(2)}</td></tr>
        <tr>
          <td class="pad" align="center" style="padding:22px 44px 40px;font-family:${SANS};font-size:12px;line-height:19px;color:${C.dim};">
            ${h.footer}<br>
            <span style="color:#5f527f;">${h.footerNote}</span>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const role = [jobTitle, co].filter(Boolean).join(", ");
  const pad = (label) => `${label}:`.padEnd(11);
  const contactLine = edited.contactTitle || edited.contactText
    ? `${t.contactTitle} ${t.contactText}`
    : hasRos
      ? `Questions, travel or session details? Speaker enquiries: ${SPEAKER_CONTACT.name}, ${SPEAKER_CONTACT.email}, ${SPEAKER_CONTACT.phone}. General and on the day: ${CONTACT_EMAIL}.`
      : `Questions, travel or session details? Reply to this email or write to ${CONTACT_EMAIL}.`;
  const text = [
    ...(viaContact ? [t.contactNotice, ""] : []),
    t.greeting,
    "",
    headline,
    "",
    message,
    "",
    `YOUR ${passName.toUpperCase()}`,
    `  ${fullName}${role ? `\n  ${role}` : ""}`,
    `  ${pad(t.labelDates)}${t.datesText}`,
    `  ${pad(t.labelVenue)}${t.venueName}, ${EVENT.address}`,
    `  ${pad(t.labelTicketId)}${id}`,
    `  ${pad(t.labelAccess)}${t.access}`,
    `  ${t.qrTextNote}`,
    "",
    ...(hasRos ? [...runOfShowText({ name: fullName, runOfShow }, t, edited), ""] : []),
    ...(includeList.length ? [t.includesTitle.toUpperCase(), ...includeList.map(([head, sub]) => `  - ${head}${sub ? `: ${sub}` : ""}`), ""] : []),
    ...(rsvp ? [t.rsvpTitle.toUpperCase(), `  ${t.rsvpText}`, edited.rsvpNote ? `  ${t.rsvpNote}` : "  Your personal RSVP link (your details are already filled in):", `  ${rsvpLink}`, ""] : []),
    ...appStoreBlockLines(),
    "",
    contactLine,
    "",
    t.signoff,
    t.signature,
    "",
    t.footer,
    t.footerNote,
  ].join("\n");

  return { subject, preheader, html: withPixel(out, pixelSrc), text, defaults: D };
}

/**
 * Subject / html / text for one pass. `inline: true` uses data: URIs (admin preview); false gives the
 * inline-CID images and their Resend attachments (a real send), with `pass.openPixel` when the sender set one.
 */
export async function passEmailFor(pass, { inline = true, copy = {}, variant = null } = {}) {
  const base = {
    name: pass.name, title: pass.title, company: pass.company, ticketId: pass.ticketId, runOfShow: pass.runOfShow || null, contact: pass.contact || "", copy, variant,
    extras: pass.extras || {},
  };
  if (inline) return { ...buildPassEmail({ ...base, ...(await inlineImageSrcs(pass.ticketId)) }), attachments: [] };
  const { srcs, attachments } = await speakerPassAttachments(pass.ticketId);
  return { ...buildPassEmail({ ...base, ...srcs, pixelSrc: pass.openPixel || "" }), attachments };
}

/** One pass's saved wording (Attendee.issuedPass): its copy, with its "Name on the pass" as the pass name. */
export function ownCopy(a) {
  const label = String(a?.issuedPass?.label || "").trim();
  return { ...(a?.issuedPass?.copy || {}), ...(label ? { passName: label } : {}) };
}

/** Wording layers, highest first (this send, the pass, the template) → what the builder takes. */
export const passCopy = (...layers) => mergeCopy(...layers);

