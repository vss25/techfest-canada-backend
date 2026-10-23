/* =========================================================
   RSVP reminder: ticket holders who haven't RSVP'd yet
   ---------------------------------------------------------
   Admin → Marketing → RSVP reminders (routes/rsvpReminders.js).
   Who: the same people as the "I'm attending" email (one per email,
   services/attendingCampaign.js planRecipients), minus everyone
   whose tickets all have an RSVP. A ticket counts as RSVP'd when an
   RSVP has its ticket ID, or (RSVPs from before ticket IDs were
   required) the holder's full name.
   The email has a personal RSVP button per ticket still open:
     https://www.thetechfestival.com/rsvp#t=<ticket>&fn=…&ln=…
   (the fragment never reaches a server; the page fills the form).
   It can go more than once: "Send to all" skips anyone reminded in
   the last REMINDER_COOLDOWN_MS, so a double click never doubles up.
   Real sends carry a 1×1 open pixel signed for that address
   (services/trackToken.js, People › RSVP email opened); previews and
   test sends don't. The RSVP form itself is counted when it's opened
   with a ticket (services/rsvpHandler.js), for every email ever sent.
   Under the buttons: the "Get the TTFC app" block (App Store and
   Google Play, services/appStoreBlock.js; Oct 23 2026).
========================================================= */

import { Resend } from "resend";
import { EVENT, escapeHtml as esc } from "./ticketInfo.js";
import { greetingName } from "./attendingCampaign.js";
import { C, CONTACT_EMAIL, LOGO_CID, SANS, SERIF, button, eyebrow, logoPng, stripe } from "./attendingEmail.js";
import { normalizeTicketId } from "./ticketAccess.js";
import { personNameKey } from "./rsvp.js";
import { RSVP_URL, displayTicketId } from "./speakerPassEmail.js";
import { openPixelUrl, withPixel } from "./trackToken.js";
import { noteTrackedSend } from "./engagementStore.js";
import { isUnsubscribed, unsubscribeFor } from "./unsubscribe.js";
import { appStoreBlockCss, appStoreBlockHtml, appStoreBlockLines } from "./appStoreBlock.js";

/** RSVP reminders come from enquire@ (the "I'm attending" email moved to marcom@ on Oct 20 2026). */
export const FROM = `The Tech Festival Canada <${CONTACT_EMAIL}>`;

export const REMINDER_CAMPAIGN = "rsvp-reminder-2026";
export const REMINDER_COOLDOWN_MS = 20 * 60 * 60 * 1000;

/** Tickets that already have an RSVP: by ticket ID, and by full name for RSVPs without one. */
export function rsvpIndex(rsvps = []) {
  const ids = new Set();
  const names = new Set();
  for (const r of rsvps) {
    if (!r || r.spam) continue;
    const id = normalizeTicketId(r.ticketId);
    if (id) ids.add(id);
    const k = personNameKey(r.firstName, r.lastName);
    if (k.includes(" ")) names.add(k);
  }
  return { ids, names };
}

export function hasRsvp(index, t) {
  const id = normalizeTicketId(t?.ticketId);
  if (id && index.ids.has(id)) return true;
  const k = personNameKey(t?.firstName, t?.lastName);
  return k.includes(" ") && index.names.has(k);
}

/**
 * @param {Array} recipients  planRecipients() rows (with `tickets`)
 * @param {Array} rsvps       Rsvp docs (ticketId, firstName, lastName, spam)
 * @returns {{ rows: Array, rsvpd: number }} rows = people with at least one ticket still to RSVP
 *   (`tickets` = only those); rsvpd = people whose tickets are all done.
 */
export function planReminders(recipients = [], rsvps = []) {
  const index = rsvpIndex(rsvps);
  const rows = [];
  let rsvpd = 0;
  for (const r of recipients) {
    const open = (r.tickets || []).filter((t) => t?.ticketId && !hasRsvp(index, t));
    if (!open.length) { rsvpd++; continue; }
    rows.push({ ...r, tickets: open });
  }
  return { rows, rsvpd };
}

/**
 * Each row with its reminder history: status "never" | "reminded" | "failed" | "sending",
 * `reminders` (how many went out), `sentAt` (the last one) and `due` (Send to all includes it).
 */
export function withReminderStatus(rows = [], sends = [], { now = Date.now(), cooldownMs = REMINDER_COOLDOWN_MS } = {}) {
  const byEmail = new Map(sends.map((s) => [String(s.email || "").toLowerCase(), s]));
  return rows.map((r) => {
    const s = byEmail.get(r.email);
    const sentAt = s?.sentAt || null;
    const status = s?.status === "failed" ? "failed" : s?.status === "sending" ? "sending" : sentAt ? "reminded" : "never";
    const due = status === "never" || status === "failed"
      || (status === "reminded" && now - new Date(sentAt).getTime() >= cooldownMs);
    return { ...r, status, sentAt, reminders: Number(s?.sends) || 0, error: status === "failed" ? String(s?.error || "") : "", due };
  });
}

export function reminderCounts(rows = [], rsvpd = 0) {
  return {
    holders: rows.length + rsvpd,
    rsvpd,
    notRsvpd: rows.length,
    due: rows.filter((r) => r.due).length,
    reminded: rows.filter((r) => r.reminders > 0).length,
  };
}

/** Their personal RSVP link (details in the fragment, read and cleared by the page). */
export function rsvpLink({ ticketId, firstName = "", lastName = "" } = {}) {
  const enc = encodeURIComponent;
  const parts = [`t=${enc(displayTicketId(ticketId))}`];
  if (firstName) parts.push(`fn=${enc(firstName)}`);
  if (lastName) parts.push(`ln=${enc(lastName)}`);
  return `${RSVP_URL}#${parts.join("&")}`;
}

/** A made-up recipient for previews and test sends. */
export const SAMPLE_REMINDER = Object.freeze({
  email: "", firstName: "Jane", lastName: "Doe", name: "Jane Doe",
  tickets: [{ ticketId: "A1B2C3D4E5F6", firstName: "Jane", lastName: "Doe", tier: "power" }],
});

/**
 * @param {object} p
 * @param {string} [p.firstName]
 * @param {string} [p.lastName]
 * @param {Array}  p.tickets   [{ ticketId, firstName, lastName }] still to RSVP
 * @param {string} [p.logoSrc] "cid:…" or a data: URI ("" = text wordmark)
 * @param {string} [p.pixelSrc] a real send's open pixel ("" = none)
 * @param {string} [p.unsubscribeUrl] the footer's unsubscribe link (services/unsubscribe.js; "" = none)
 * @returns {{ subject, preheader, html, text, links }}
 */
export function buildRsvpReminderEmail({ firstName = "", lastName = "", tickets = [], logoSrc = "", pixelSrc = "", unsubscribeUrl = "" } = {}) {
  const first = greetingName({ firstName, lastName });
  const subject = first ? `${first}, a quick reminder to RSVP for TTFC 2026` : "A quick reminder to RSVP for TTFC 2026";
  const preheader = "Tell us which breakfasts, luncheons and evening events you're coming to. It takes about a minute.";
  const links = tickets.map((t) => {
    const holder = [t.firstName, t.lastName].filter(Boolean).join(" ");
    return { url: rsvpLink(t), label: tickets.length > 1 && holder ? `RSVP for ${holder}` : "RSVP Now" };
  });
  const many = links.length > 1;
  const intro = `TTFC 2026 is on ${EVENT.dates} at ${EVENT.venue} in Toronto, and we still need your RSVP. `
    + "It lets us save your seat at the breakfasts, luncheons and evening events your pass includes, and plan catering.";
  const how = many
    ? "Each ticket needs its own RSVP. The ticket ID and name are already filled in, so each one takes about a minute."
    : "Your ticket ID and name are already filled in, so it takes about a minute.";

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
        <tr>
          <td class="pad" style="padding:36px 44px 8px;background-image:radial-gradient(ellipse at 85% 0%,rgba(122,63,209,0.38) 0%,rgba(6,2,15,0) 60%);">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td valign="middle">${logoSrc
                  ? `<img src="${esc(logoSrc)}" width="96" height="55" alt="The Tech Festival Canada" style="display:block;width:96px;height:auto;border:0;outline:none;">`
                  : `<span style="font-family:${SANS};font-size:13px;font-weight:800;letter-spacing:2.6px;color:${C.white};">TTFC 2026</span>`}</td>
                <td valign="middle" align="right">${eyebrow(`${EVENT.datesShort} · Toronto`, C.orange)}</td>
              </tr>
            </table>
            <div style="font-family:${SERIF};font-size:20px;line-height:28px;font-style:italic;color:${C.text};margin:30px 0 6px;">${first ? `Hi ${esc(first)},` : "Hello,"}</div>
            <div class="hero" style="font-family:${SANS};font-size:36px;line-height:42px;font-weight:800;letter-spacing:-0.8px;color:${C.white};margin:0 0 16px;">Have you RSVP'd yet?</div>
            <div style="font-family:${SANS};font-size:16px;line-height:26px;color:${C.text};margin:0;">${esc(intro)}</div>
            <div style="font-family:${SANS};font-size:16px;line-height:26px;color:${C.text};margin:14px 0 0;">${esc(how)}</div>
          </td>
        </tr>
        ${links.map((l, i) => `<tr>
          <td class="pad" align="center" style="padding:${i ? 14 : 30}px 44px 0;">
            ${button(l.url, l.label)}
          </td>
        </tr>`).join("")}
        <tr>
          <td class="pad" align="center" style="padding:14px 44px 0;font-family:${SANS};font-size:12px;line-height:18px;color:${C.dim};">
            Already RSVP'd? Thank you, you can ignore this email.${many ? " Forward a button to the person it's for if they'd rather do it themselves." : ""}
          </td>
        </tr>
        <!-- Get the TTFC app (services/appStoreBlock.js) -->
        <tr>
          <td class="pad" style="padding:32px 44px 0;">
            ${appStoreBlockHtml()}
          </td>
        </tr>
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
            ${esc(EVENT.name)} &middot; ${esc(EVENT.dates)}<br>
            ${esc(EVENT.venue)}, ${esc(EVENT.address)}<br>
            <span style="color:#5f527f;">You're getting this because you have a pass for TTFC 2026 and we don't have your RSVP yet.${unsubscribeUrl ? ` <a href="${esc(unsubscribeUrl)}" target="_blank" style="color:#a596c7;text-decoration:underline;">Unsubscribe</a>` : ""}</span>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const text = [
    first ? `Hi ${first},` : "Hello,",
    "",
    "Have you RSVP'd yet?",
    "",
    intro,
    "",
    how,
    "",
    ...links.flatMap((l) => [`${l.label}:`, l.url, ""]),
    `Already RSVP'd? Thank you, you can ignore this email.${many ? " Forward a link to the person it's for if they'd rather do it themselves." : ""}`,
    "",
    ...appStoreBlockLines(),
    "",
    "Questions? Just reply to this email.",
    "",
    "See you in Toronto,",
    "The Tech Festival Canada team",
    "",
    `${EVENT.name} · ${EVENT.dates}`,
    `${EVENT.venue}, ${EVENT.address}`,
    ...(unsubscribeUrl ? [`Unsubscribe from TTFC emails: ${unsubscribeUrl}`] : []),
  ].join("\n");

  return { subject, preheader, html: withPixel(html, pixelSrc), text, links: links.map((l) => l.url) };
}

/** Subject/html/text for a row; `inline: true` puts the logo in as a data: URI (admin preview).
    `track`: the address a real send goes to (its open pixel, `tracked` says whether it could be signed, and its own
    unsubscribe link and one-click headers, `headers`); previews and test sends get the preview link and the mailto. */
export function reminderEmailFor(row, { inline = true, track = "" } = {}) {
  const logoSrc = inline ? `data:image/png;base64,${logoPng().toString("base64")}` : `cid:${LOGO_CID}`;
  const pixelSrc = !inline && track ? openPixelUrl({ c: REMINDER_CAMPAIGN, e: track }) : "";
  const unsub = unsubscribeFor(track, { real: !inline && !!track, mailto: CONTACT_EMAIL });
  return {
    ...buildRsvpReminderEmail({ firstName: row?.firstName || "", lastName: row?.lastName || "", tickets: row?.tickets || [], logoSrc, pixelSrc, unsubscribeUrl: unsub.url }),
    tracked: !!pixelSrc,
    headers: unsub.headers,
  };
}

let resendClient = null;
const resend = () => (resendClient ||= new Resend(process.env.RESEND_API_KEY));

/** Sends one reminder through Resend (logo inline, reply-to enquire@). Throws when Resend refuses it.
    `track`: a real send (the open pixel for this address); test sends leave it off. */
export async function sendRsvpReminder({ to, row, subjectPrefix = "", client = resend(), track = false, noteTracked = noteTrackedSend }) {
  if (!to) throw new Error("Missing email");
  if (!row?.tickets?.length) throw new Error("No ticket to RSVP for");
  const address = track ? String(to).trim().toLowerCase() : "";
  const { subject, html, text, tracked, headers } = reminderEmailFor(row, { inline: false, track: address });
  const { data, error } = await client.emails.send({
    from: FROM,
    to,
    reply_to: CONTACT_EMAIL,
    subject: `${subjectPrefix}${subject}`,
    html,
    text,
    attachments: [{ filename: "ttfc-2026.png", content: logoPng().toString("base64"), content_type: "image/png", content_id: LOGO_CID }],
    headers,
    tags: [{ name: "campaign", value: REMINDER_CAMPAIGN }],
  });
  if (error) throw new Error(error.message || "Resend refused the email");
  if (!data?.id) throw new Error("Resend did not accept the email");
  if (tracked) noteTracked?.({ campaign: REMINDER_CAMPAIGN, email: address, ticketId: "" });
  return data;
}

/* ---------- Sending, shared by Marketing › RSVP reminders and People ----------
   Each person is claimed in CampaignSend (campaign REMINDER_CAMPAIGN, one row per
   email) before the email goes, so two runs at once never email someone twice,
   and "Send" skips anyone reminded in the last REMINDER_COOLDOWN_MS. The store
   and the sender are passed in so tests use fakes (never Resend). */

/** CampaignSend as the reminder store: claim / sent / failed. */
export function campaignSendStore(CampaignSend, { campaign = REMINDER_CAMPAIGN, cooldownMs = REMINDER_COOLDOWN_MS, Subscription = null } = {}) {
  return {
    /** True when `email` unsubscribed (services/unsubscribe.js), checked just before each email; false without a model. */
    async optedOut(email) {
      return Subscription ? isUnsubscribed(Subscription, email) : false;
    },
    /** True when this run may send to `email` now; `force` (a single send) ignores the cool-down. */
    async claim(email, { name = "", by = "", force = false, now = new Date() } = {}) {
      const filter = force
        ? { campaign, email }
        : { campaign, email, $or: [
          { status: "failed" },
          { status: "sent", $or: [{ sentAt: { $lt: new Date(now.getTime() - cooldownMs) } }, { sentAt: null }] },
        ] };
      const upd = await CampaignSend.updateOne(filter, { $set: { status: "sending", name, lastTriedAt: now, sentBy: by }, $inc: { attempts: 1 } });
      if (upd.matchedCount) return true;
      try {
        await CampaignSend.create({ campaign, email, name, status: "sending", attempts: 1, lastTriedAt: now, sentBy: by });
        return true;
      } catch (err) {
        if (err?.code === 11000) return false; // reminded recently, or being sent right now
        throw err;
      }
    },
    async sent(email, { sentAt, resendId = "" }) {
      await CampaignSend.updateOne({ campaign, email }, { $set: { status: "sent", sentAt, resendId, error: "" }, $inc: { sends: 1 } });
    },
    async failed(email, error) {
      await CampaignSend.updateOne({ campaign, email }, { $set: { status: "failed", error } }).catch(() => {});
    },
  };
}

/**
 * sendTo(row, by, { force }) → the Date it went, "unsubscribed" (they're on the unsubscribe list now: the last check,
 * so someone who unsubscribes while a send is running is still left out; even `force` never overrides it) or "skipped"
 * (someone else has it / reminded recently).
 * Throws when the email service refuses it (recorded as failed). `row`: { email, name, firstName, lastName, tickets }.
 */
export function makeReminderSender({ store, send = sendRsvpReminder, now = () => new Date() }) {
  return async function sendTo(r, by = "", { force = false } = {}) {
    if (await store.optedOut?.(r.email)) return "unsubscribed";
    if (!(await store.claim(r.email, { name: r.name || "", by, force, now: now() }))) return "skipped";
    try {
      const data = await send({ to: r.email, row: r, track: true });
      const sentAt = now();
      await store.sent(r.email, { sentAt, resendId: data?.id || "" });
      return sentAt;
    } catch (err) {
      await store.failed(r.email, String(err?.message || err || "Send failed").slice(0, 300));
      throw err;
    }
  };
}

/** The one reminder run at a time, whichever page started it ({ running, by, total, sent, failed, skipped, … }). */
export const reminderJob = {
  state: { running: false, startedAt: null, finishedAt: null, by: "", from: "", total: 0, sent: 0, failed: 0, skipped: 0 },
  view() { return { ...this.state }; },
  start(by, from, total = 0) { this.state = { running: true, startedAt: new Date(), finishedAt: null, by, from, total, sent: 0, failed: 0, skipped: 0 }; },
  finish() { this.state = { ...this.state, running: false, finishedAt: new Date() }; },
};
