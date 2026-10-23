/* =========================================================
   Calendar invites for a speaker's sessions
   ---------------------------------------------------------
   One email per session with a METHOD:REQUEST .ics, so Gmail,
   Outlook and Apple Mail show Accept / Decline and it lands in
   their calendar. The event runs from the VIP Lounge mic fitting
   (30 min early) to the end of the session. Organizer = the speaker
   contact (SPEAKER_ORGANIZER_*; replies go there). Sent with the
   Speaker Pass email (routes/console.js sendSpeakerPass), with the
   same cc. The UID is per pass + session, so a resend updates the
   same calendar event (SEQUENCE = how many times it went before).
   The email ends with the compact "Get the TTFC app" block (App Store
   and Google Play, services/appStoreBlock.js; Oct 23 2026).
========================================================= */

import { Resend } from "resend";
import { EVENT, escapeHtml as esc } from "./ticketInfo.js";
import { C, CONTACT_EMAIL, FROM } from "./speakerPassEmail.js";
import { ARRIVE_EARLY_MIN, DAYS, LOUNGE, STAGE, arriveAt, fmtTime, needsMicUp, sessionInviteIcs } from "./runOfShow.js";
import { appStoreBlockHtml, appStoreBlockLines } from "./appStoreBlock.js";

export const organizer = (env = process.env) => ({
  name: env.SPEAKER_ORGANIZER_NAME || "Lubna Soni",
  email: env.SPEAKER_ORGANIZER_EMAIL || "lubna@thetechfestival.com",
});

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Subject, html, text and the .ics for one session. */
export function buildSessionInvite({ name, ticketId, session: s, to, sequence = 0, now = new Date(), org = organizer(), micUp = true }) {
  const arrive = micUp ? arriveAt(s.start) : s.start;
  const when = `${DAYS[s.day].short}, ${fmtTime(arrive)}`;
  const subject = `Invitation: ${s.title} · ${when}${micUp ? " (mic fitting)" : ""} · TTFC 2026`;
  const lines = [
    ...(micUp ? [[`${fmtTime(arrive)}`, `Mic fitting in the ${LOUNGE}. Please be there at least ${ARRIVE_EARLY_MIN} minutes before your session.`]] : []),
    [`${fmtTime(s.start)}`, `${s.format ? `${s.format}: ` : ""}${s.title}, ${STAGE} (until ${fmtTime(s.end)})`],
  ];
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:24px 16px;background:#ffffff;font-family:${SANS};color:#1d1630;">
  <div style="max-width:560px;margin:0 auto;">
    <div style="font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:${C.magenta};">TTFC 2026 · Speaker calendar invite</div>
    <h1 style="font-size:22px;line-height:28px;margin:10px 0 6px;">${esc(s.title)}</h1>
    <p style="font-size:15px;line-height:22px;margin:0 0 16px;color:#4a4060;">${esc(DAYS[s.day].long)} · ${esc(EVENT.venue)}, Toronto</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;">
      ${lines.map(([t, w]) => `<tr><td valign="top" style="padding:8px 12px 8px 0;font-weight:800;white-space:nowrap;">${esc(t)}</td><td style="padding:8px 0;border-left:3px solid ${C.magenta};padding-left:12px;">${esc(w)}</td></tr>`).join("")}
    </table>
    <p style="font-size:14px;line-height:21px;margin:18px 0 0;color:#4a4060;">Accept the invite to add it to your calendar. Questions: ${esc(org.name)}, <a href="mailto:${esc(org.email)}" style="color:${C.purple};">${esc(org.email)}</a>, or <a href="mailto:${CONTACT_EMAIL}" style="color:${C.purple};">${CONTACT_EMAIL}</a>.</p>
    <div style="margin:24px 0 0;">
${appStoreBlockHtml({ compact: true, theme: "light" })}
    </div>
  </div>
</body></html>`;
  const text = [
    `TTFC 2026 speaker calendar invite`,
    "",
    s.title,
    `${DAYS[s.day].long} · ${EVENT.venue}, Toronto`,
    "",
    ...lines.map(([t, w]) => `${t}  ${w}`),
    "",
    `Accept the invite to add it to your calendar. Questions: ${org.name}, ${org.email}, or ${CONTACT_EMAIL}.`,
    "",
    ...appStoreBlockLines(),
  ].join("\n");
  const ics = sessionInviteIcs({ ticketId, name, session: s, to, organizer: org, sequence, now, micUp });
  return { subject, html, text, ics };
}

let resendClient = null;
const resend = () => (resendClient ||= new Resend(process.env.RESEND_API_KEY));

/**
 * Sends an invite for every session on the pass. Stops at the first failure (throws, with
 * how many went out). → { sent: number }
 */
export const INVITE_GAP_MS = 700; // Resend allows ~2 requests a second; the pass email went just before

export async function sendSessionInvites({ pass, to, cc = [], sequence = 0, client = resend(), wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const sessions = pass?.runOfShow?.sessions || [];
  let sent = 0;
  for (const s of sessions) {
    await wait(INVITE_GAP_MS);
    const { subject, html, text, ics } = buildSessionInvite({ name: pass.name, ticketId: pass.ticketId, session: s, to, sequence, micUp: needsMicUp(sessions, s) });
    const { data, error } = await client.emails.send({
      from: FROM,
      to,
      ...(cc.length ? { cc } : {}),
      reply_to: organizer().email,
      subject,
      html,
      text,
      attachments: [{ filename: "invite.ics", content: Buffer.from(ics).toString("base64"), content_type: "text/calendar; method=REQUEST; charset=UTF-8" }],
      tags: [{ name: "campaign", value: "speaker-invite-2026" }],
    });
    if (error || !data?.id) {
      const err = new Error(`${error?.message || "Resend refused the invite"} (${sent} of ${sessions.length} invites sent)`);
      err.sent = sent;
      throw err;
    }
    sent++;
  }
  return { sent };
}
