import { normalizeTicketId } from "./ticketAccess.js";

/* =========================================================
   Email engagement (Oct 19 2026, the organiser: "Can you track who
   all opened, clicked, posted on linkedin or rsvp forms?"): pure
   parts, unit-tested (test/engagement.test.js). The writes are in
   services/engagementStore.js, the rows in models/EmailEngagement.js.

   What is recorded, from sends made after this went live (emails
   sent before carry no token, so for them only the RSVP form shows):
     - email opens: the 1×1 pixel (GET /api/t/o/<token>.gif) in the
       "I'm attending" email, the RSVP reminder and the pass emails
       with the RSVP button (speakers', issued, exhibitor) when sent
       without a cc (a cc'd copy would count as their open). Opens are
       estimates: Apple Mail loads every image on arrival, other apps
       block images until asked.
     - "I'm attending" page: opened from their link (visit), the phone's
       share sheet finished (share: it can't say the app was LinkedIn),
       "Download and open LinkedIn" (manual: we can't see the post), and
       a post made through our "Post to LinkedIn", confirmed by LinkedIn
       (post, with its link). Posts from links without a token are
       counted on one row with no email ("unattributed").
     - RSVP form: opened with a ticket ID and last name that match
       (POST /api/rsvp/lookup), per ticket. This works for every email
       already sent, because the RSVP link has always carried the ticket.
   Nothing about the visitor is kept (no IP address, no browser).
========================================================= */

/** The email (or page) each row is about. The first two are one email per address; the pass emails are per pass. */
export const CAMPAIGNS = Object.freeze({
  attending: "attending-2026", // services/attendingCampaign.js CAMPAIGN_KEY
  rsvpReminder: "rsvp-reminder-2026", // services/rsvpReminder.js REMINDER_CAMPAIGN
  speakerPass: "speaker-pass-2026",
  speakerNudge: "speaker-nudge-2026",
  issuedPass: "issued-pass-2026", // routes/issuedPasses.js KINDS.issued.campaign
  exhibitorPass: "exhibitor-pass-2026", // routes/issuedPasses.js KINDS.exhibitor.campaign
  rsvpForm: "rsvp-form",
});
const PER_ADDRESS = new Set([CAMPAIGNS.attending, CAMPAIGNS.rsvpReminder]);

/** The emails with the RSVP button, as People names them (services/people.js rsvpEmailOf uses the same words). */
export const RSVP_EMAIL_LABELS = Object.freeze({
  [CAMPAIGNS.rsvpReminder]: "RSVP reminder",
  [CAMPAIGNS.speakerPass]: "Speaker Pass email",
  [CAMPAIGNS.speakerNudge]: "Speaker reminder",
  [CAMPAIGNS.issuedPass]: "Pass email",
  [CAMPAIGNS.exhibitorPass]: "Exhibitor's pass email",
});

/** What happened → the row's counter and its first / last time. */
const KINDS = Object.freeze({
  open: { count: "opens", first: "firstOpenAt", last: "lastOpenAt" },
  visit: { count: "visits", first: "firstVisitAt", last: "lastVisitAt" },
  post: { count: "posts", first: "postedAt", last: "lastPostedAt" },
  share: { count: "shares", first: "sharedAt", last: "lastSharedAt" },
  manual: { count: "manuals", first: "manualAt", last: "lastManualAt" },
});
export const ENGAGEMENT_KINDS = Object.keys(KINDS);

const CAMPAIGN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const lower = (e) => String(e || "").trim().toLowerCase();

/**
 * The row a token's payload ({ c, e, t }) belongs to → { campaign, email, ticketId }, or null.
 * The "I'm attending" email and the RSVP reminder are one row per address (the ticket is dropped);
 * the RSVP form is one row per ticket (no email).
 */
export function engagementKey({ c, e = "", t = "" } = {}) {
  const campaign = String(c || "");
  if (!CAMPAIGN.test(campaign)) return null;
  let email = lower(e).slice(0, 254);
  let ticketId = normalizeTicketId(t);
  if (PER_ADDRESS.has(campaign)) ticketId = "";
  if (campaign === CAMPAIGNS.rsvpForm) email = "";
  if (!email && !ticketId) return null;
  return { campaign, email, ticketId };
}

/** Posts made from a link without a token: counted, not named. */
export const UNATTRIBUTED_POSTS = Object.freeze({ campaign: CAMPAIGNS.attending, email: "", ticketId: "" });

const POST_URL = /^https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:(share|ugcPost):\d+\/$/;

/** The MongoDB update for one event (null for an unknown kind). `postUrl`: a post's LinkedIn link. */
export function engagementUpdate(kind, { at = new Date(), postUrl = "" } = {}) {
  const k = KINDS[kind];
  if (!k) return null;
  const when = at instanceof Date && Number.isFinite(at.getTime()) ? at : new Date();
  const upd = { $inc: { [k.count]: 1 }, $min: { [k.first]: when }, $max: { [k.last]: when } };
  if (kind === "post" && POST_URL.test(String(postUrl || ""))) upd.$set = { postUrl };
  return upd;
}

/** A send that carried the pixel: from now on "not opened" means no open was seen. */
export const trackedUpdate = (at = new Date()) => ({ $inc: { trackedSends: 1 }, $max: { trackedAt: at } });

/* ---------- People (services/people.js): per person, from every row of theirs ---------- */

/** Every row → { byEmail: Map(email → rows), byTicket: Map(ticket → rows), unattributedPosts }. */
export function engagementIndex(rows = []) {
  const byEmail = new Map();
  const byTicket = new Map();
  let unattributedPosts = 0;
  const push = (m, k, r) => { if (!m.has(k)) m.set(k, []); m.get(k).push(r); };
  for (const r of rows || []) {
    if (!r?.campaign) continue;
    const e = lower(r.email);
    const t = normalizeTicketId(r.ticketId);
    if (!e && !t) { if (r.campaign === CAMPAIGNS.attending) unattributedPosts += Number(r.posts) || 0; continue; }
    if (e) push(byEmail, e, r);
    if (t) push(byTicket, t, r);
  }
  return { byEmail, byTicket, unattributedPosts };
}

const ms = (d) => {
  const n = d ? new Date(d).getTime() : NaN;
  return Number.isFinite(n) ? n : null;
};
const earliest = (a, b) => (ms(b) === null ? a : ms(a) === null || ms(b) < ms(a) ? new Date(b) : a);
const latest = (a, b) => (ms(b) === null ? a : ms(a) === null || ms(b) > ms(a) ? new Date(b) : a);

/** Rows added up: counts summed, the earliest first time, the latest last time, the newest post's link. */
function total(rows) {
  const out = { trackedAt: null };
  for (const k of Object.values(KINDS)) Object.assign(out, { [k.count]: 0, [k.first]: null, [k.last]: null });
  let postUrlAt = null;
  out.postUrl = "";
  for (const r of rows) {
    for (const k of Object.values(KINDS)) {
      out[k.count] += Math.max(0, Number(r[k.count]) || 0);
      out[k.first] = earliest(out[k.first], r[k.first]);
      out[k.last] = latest(out[k.last], r[k.last] || r[k.first]);
    }
    out.trackedAt = latest(out.trackedAt, r.trackedAt);
    if (r.postUrl && (postUrlAt === null || (ms(r.lastPostedAt || r.postedAt) ?? 0) > postUrlAt)) {
      out.postUrl = r.postUrl;
      postUrlAt = ms(r.lastPostedAt || r.postedAt) ?? 0;
    }
  }
  return out;
}

const uniq = (rows) => [...new Set(rows)];
const emailsOf = (list) => [...new Set((list || []).map(lower).filter(Boolean))];
const ticketsOf = (list) => [...new Set((list || []).map(normalizeTicketId).filter(Boolean))];

/** Furthest step on the "I'm attending" page, best first. */
export const ATTENDING_STAGES = ["posted", "shared", "manual", "visited", "opened"];
export const ATTENDING_STAGE_LABELS = Object.freeze({
  posted: "Posted on LinkedIn",
  shared: "Shared from phone",
  manual: "Opened LinkedIn",
  visited: "Opened the page",
  opened: "Opened the email",
});

/**
 * One person's "I'm attending" email and page, over all their addresses.
 * → { stage: "posted" | "shared" | "manual" | "visited" | "opened" | "", stageLabel, tracked (an email with
 *     the pixel and token went), opens, firstOpenAt, lastOpenAt, visits, firstVisitAt, lastVisitAt, posts,
 *     postedAt, lastPostedAt, postUrl, shares, sharedAt, lastSharedAt, manuals, manualAt, lastManualAt, trackedAt }
 */
export function attendingEngagementOf(emails = [], idx = engagementIndex()) {
  const rows = uniq(emailsOf(emails).flatMap((e) => idx.byEmail.get(e) || []).filter((r) => r.campaign === CAMPAIGNS.attending));
  const t = total(rows);
  const stage = t.posts > 0 ? "posted" : t.shares > 0 ? "shared" : t.manuals > 0 ? "manual" : t.visits > 0 ? "visited" : t.opens > 0 ? "opened" : "";
  return { stage, stageLabel: ATTENDING_STAGE_LABELS[stage] || "", tracked: !!t.trackedAt, ...t };
}

/**
 * One person's RSVP emails (opens) and RSVP form (opened with one of their tickets).
 * Pass emails are matched by their ticket, the RSVP reminder by address.
 * → { emailOpened, opens, firstOpenAt, lastOpenAt, openedVia: ["RSVP reminder", …], tracked, trackedAt,
 *     formOpened, formOpens, firstFormAt, lastFormAt }
 */
export function rsvpEngagementOf({ emails = [], tickets = [] } = {}, idx = engagementIndex()) {
  const mine = new Set(ticketsOf(tickets));
  const byTicket = [...mine].flatMap((t) => idx.byTicket.get(t) || []);
  const byAddress = emailsOf(emails).flatMap((e) => idx.byEmail.get(e) || []).filter((r) => !normalizeTicketId(r.ticketId));
  const mail = uniq([...byTicket, ...byAddress]).filter((r) => RSVP_EMAIL_LABELS[r.campaign]);
  const form = uniq(byTicket.filter((r) => r.campaign === CAMPAIGNS.rsvpForm));
  const m = total(mail);
  const f = total(form);
  const openedVia = Object.keys(RSVP_EMAIL_LABELS).filter((c) => mail.some((r) => r.campaign === c && Number(r.opens) > 0)).map((c) => RSVP_EMAIL_LABELS[c]);
  return {
    emailOpened: m.opens > 0, opens: m.opens, firstOpenAt: m.firstOpenAt, lastOpenAt: m.lastOpenAt, openedVia,
    tracked: !!m.trackedAt, trackedAt: m.trackedAt,
    formOpened: f.visits > 0, formOpens: f.visits, firstFormAt: f.firstVisitAt, lastFormAt: f.lastVisitAt,
  };
}

/** Shown wherever opens are. */
export const OPENS_NOTE = "Opens are estimates: some mail apps (e.g. Apple Mail) load images automatically, others block them.";
