/* =========================================================
   "I'm attending" in Admin › People: the status per person and
   the LinkedIn nudge (Oct 19 2026, the organiser: "The I am
   attending post email should be in the people summary with
   ability to send the nudge to post on LinkedIn").

   The nudge IS the "I'm attending" email (services/attendingEmail.js,
   unchanged): their personal /attending link, where they make the
   image and post it on LinkedIn. Sends are recorded in the same
   CampaignSend rows as the campaign (campaign "attending-2026", one
   row per email: status, sentAt, and `sends` counts the nudges), so
   the campaign's "send to everyone" skips anyone nudged, and a nudge
   skips anyone emailed in the last NUDGE_COOLDOWN_DAYS.

   What can be known, per person (by their email addresses):
     Not sent · Sent (last send, and how many nudges) · Failed ·
     Unconfirmed (a send started but never confirmed: check Resend).
   What can't: whether they opened the email, clicked the button or
   posted. The email has no tracking pixel and its link goes straight
   to the website; /attending draws the image in the browser and the
   LinkedIn post (routes/attending.js) never says who posted. So
   "already posted" can't be a reason to skip anyone (ATTENDING_TRACKING).

   Who a nudge goes to (planAttendingNudges, like the People page's
   RSVP reminder): people with a pass (not hidden, not a booth), a
   usable email, an account that isn't suspended, who haven't
   unsubscribed, with no unconfirmed send, not emailed in the last
   NUDGE_COOLDOWN_DAYS. One email per address.

   Pure apart from attendingJob (one run at a time on this server,
   shared with Marketing › I'm attending campaign's send to everyone).
========================================================= */

import { CAMPAIGN_KEY, usableEmail } from "./attendingCampaign.js";
import { splitName } from "./rsvpStaff.js";

export { CAMPAIGN_KEY as ATTENDING_CAMPAIGN };
export const NUDGE_COOLDOWN_DAYS = 3;
export const NUDGE_COOLDOWN_MS = NUDGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
/** Emails per bulk nudge run (send again for the rest: anyone nudged is then skipped). */
export const NUDGE_MAX = 500;

export const ATTENDING_STATUSES = ["none", "sent", "failed", "sending"];
export const ATTENDING_LABELS = Object.freeze({ none: "Not sent", sent: "Sent", failed: "Failed", sending: "Unconfirmed" });
/** None of these are recorded anywhere (see above). */
export const ATTENDING_TRACKING = Object.freeze({ opens: false, clicks: false, posts: false });

export const NUDGE_SKIP_LABELS = Object.freeze({
  noPass: "No pass",
  noEmail: "No email address",
  banned: "Account suspended",
  unsubscribed: "Unsubscribed from our emails",
  sending: "A send to them wasn't confirmed (check Resend first)",
  recent: `Emailed in the last ${NUDGE_COOLDOWN_DAYS} days`,
});

const ms = (d) => {
  const n = d ? new Date(d).getTime() : 0;
  return Number.isFinite(n) ? n : 0;
};
const isBooth = (id) => /^BOOTH-/i.test(String(id || ""));

/** CampaignSend rows of the attending campaign → Map(email → { status, sentAt, sends }). */
export function attendingIndex(sends = []) {
  const out = new Map();
  for (const s of sends || []) {
    const e = String(s?.email || "").trim().toLowerCase();
    if (!e || !ATTENDING_STATUSES.includes(s.status)) continue;
    out.set(e, { status: s.status, sentAt: s.sentAt || null, sends: Number(s.sends) || 0 });
  }
  return out;
}

const RANK = { sent: 3, sending: 2, failed: 1, none: 0 };

/**
 * One person's "I'm attending" email, over all their addresses: sent (newest send) beats unconfirmed beats failed.
 * `sentAt` is the last send that went (a failed retry keeps it); `nudges`: sends from People (CampaignSend.sends).
 * → { status: "none" | "sent" | "failed" | "sending", label, sentAt, nudges, email }
 */
export function attendingStatusOf(emails = [], index = new Map()) {
  let best = null;
  for (const raw of emails || []) {
    const e = String(raw || "").trim().toLowerCase();
    const s = e ? index.get(e) : null;
    if (!s) continue;
    const better = !best || RANK[s.status] > RANK[best.status] || (s.status === best.status && ms(s.sentAt) > ms(best.sentAt));
    if (better) best = { ...s, email: e };
  }
  if (!best) return { status: "none", label: ATTENDING_LABELS.none, sentAt: null, nudges: 0, email: "" };
  return { status: best.status, label: ATTENDING_LABELS[best.status], sentAt: best.sentAt || null, nudges: best.sends || 0, email: best.email };
}

/** Who the email is about: their name, title and company as People shows them (the /attending link is filled in). */
export function nudgeRecipient(p) {
  const fallback = splitName(p?.name === "No name" ? "" : p?.name || "");
  return {
    firstName: String(p?.firstName || fallback.firstName || ""),
    lastName: String(p?.lastName || fallback.lastName || ""),
    title: String(p?.jobTitle || ""),
    company: String(p?.company || ""),
  };
}

/**
 * Who a LinkedIn nudge would go to, and who's left out and why.
 * @param {Array} people   the filtered people (internal records from services/people.js buildPeople)
 * @param {object} o
 * @param {Iterable<string>} o.optedOut  emails with Subscription.subscribed false
 * @param {Array}  o.sends      CampaignSend rows of the attending campaign ({ email, status, sentAt })
 * @param {number} o.cooldownMs anyone emailed within this is skipped
 * @returns {{ targets: Array<{ email, name, firstName, lastName, title, company, people }>, skipped: Array<{ id, name, reason, label }>, counts: object }}
 */
export function planAttendingNudges(people = [], { optedOut = [], sends = [], cooldownMs = NUDGE_COOLDOWN_MS, now = Date.now() } = {}) {
  const out = new Set([...optedOut].map((e) => String(e || "").trim().toLowerCase()));
  const sendBy = attendingIndex(sends);
  const byEmail = new Map();
  const skipped = [];
  const skip = (p, reason) => skipped.push({ id: p.id, name: p.name, reason, label: NUDGE_SKIP_LABELS[reason] });
  for (const p of people) {
    const passes = (p.passList || []).filter((t) => !t.hidden && !isBooth(t.ticketId));
    if (!passes.length) { skip(p, "noPass"); continue; }
    const email = usableEmail(p.email);
    if (!email) { skip(p, "noEmail"); continue; }
    if (p.user?.banned) { skip(p, "banned"); continue; }
    if (out.has(email)) { skip(p, "unsubscribed"); continue; }
    const s = sendBy.get(email);
    if (s?.status === "sending") { skip(p, "sending"); continue; }
    if (s?.status === "sent" && s.sentAt && now - ms(s.sentAt) < cooldownMs) { skip(p, "recent"); continue; }
    const have = byEmail.get(email);
    if (have) { have.people.push({ id: p.id, name: p.name }); continue; }
    byEmail.set(email, { email, name: p.name, ...nudgeRecipient(p), people: [{ id: p.id, name: p.name }] });
  }
  const targets = [...byEmail.values()];
  const skippedBy = {};
  for (const x of skipped) skippedBy[x.reason] = (skippedBy[x.reason] || 0) + 1;
  return {
    targets, skipped,
    counts: { matching: people.length, emails: targets.length, people: targets.reduce((n, t) => n + t.people.length, 0), skipped: skipped.length, skippedBy },
  };
}

/** The one "I'm attending" run at a time (a People nudge to a filter, or the campaign's send to everyone). */
export const attendingJob = {
  state: { running: false, startedAt: null, finishedAt: null, by: "", from: "", total: 0, sent: 0, failed: 0, skipped: 0 },
  view() { return { ...this.state }; },
  start(by, from, total = 0) { this.state = { running: true, startedAt: new Date(), finishedAt: null, by, from, total, sent: 0, failed: 0, skipped: 0 }; },
  finish() { this.state = { ...this.state, running: false, finishedAt: new Date() }; },
};
