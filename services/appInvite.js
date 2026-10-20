/* =========================================================
   App invite email (Oct 20 2026): who gets it, the link, the stats
   ---------------------------------------------------------
   The organiser: "send emails to all people associated with the
   event to download the web app". Admin › Website & app › App
   invite email (routes/appInvite.js), and one person at a time from
   their profile in People (routes/people.js).

   Who: everyone in the People directory (services/people.js, which
   joins accounts, passes, the speaker list and RSVPs) who is part of
   TTFC 2026 and has an address we can write to:
     - a pass (bought, issued, complimentary, exhibitor or Speaker
       Pass; not hidden by staff, not a booth order), or
     - one of the roles: speaker (type or the speaker list), exhibitor,
       staff, volunteer, media, or the VIP flag.
   One email per address. Left out, and counted: no usable email (a
   ticket sign-in placeholder or none), a suspended account, anyone
   who unsubscribed (Subscription.subscribed false), and, with "Skip
   people already using the app" (on by default), anyone who has
   signed in to the app or the web app (the app's `onApp` rule:
   User.appOnboarded or User.lastActiveAt). A send to everyone also
   skips anyone it already went to (one CampaignSend row per email,
   campaign APP_INVITE_CAMPAIGN), retries failures and leaves
   unconfirmed sends alone (check Resend first). A send to one person
   waits COOLDOWN_DAYS after the last one.

   The link: https://www.thetechfestival.com/app/ with a real send's
   signed token in the fragment (#r=…, services/trackToken.js), so the
   web app can say it was opened from this email (POST /api/t/v →
   a "visit"); the open pixel does the same for opens. Previews and
   test sends carry neither. Pure, unit-tested (test/app-invite.test.js).
========================================================= */

import { EVENT } from "./ticketInfo.js";
import { isPlaceholderEmail, usableEmail } from "./attendingCampaign.js";
import { TYPE_LABELS } from "./teamRoles.js";
import { TIER_LABELS } from "./rsvp.js";

export const APP_INVITE_CAMPAIGN = "app-invite-2026";
export const APP_URL = `${EVENT.website}/app/`;
/** Same values as the website's src/lib/appStores.js (keep in step). */
export const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=com.atlaslinkmarkets.ttfc";
/** The iPhone app on the App Store: empty until the listing is live (it answered 404 on Oct 19 2026). Set
    APP_STORE_URL on the server (e.g. https://apps.apple.com/ca/app/id6820764803) when it is. */
export const IOS_APP_STORE_URL = "";
export const appStoreUrl = (env = process.env) => {
  const u = String(env.APP_STORE_URL || IOS_APP_STORE_URL || "").trim();
  return /^https:\/\/apps\.apple\.com\/[^\s"'<>]+$/.test(u) ? u : "";
};

export const COOLDOWN_DAYS = 3;
export const COOLDOWN_MS = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

export const SKIP_LABELS = Object.freeze({
  noEmail: "No email address",
  placeholder: "No real email (signed in with a pass ID)",
  banned: "Account suspended",
  unsubscribed: "Unsubscribed from our emails",
  usingApp: "Already using the app",
  sending: "A send to them wasn't confirmed (check Resend first)",
  alreadySent: "Already sent",
  recent: `Emailed in the last ${COOLDOWN_DAYS} days`,
  duplicate: "Same email as someone above",
});

const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/** The button's link: the web app, with a real send's token in the fragment (never sent to a server by the browser). */
export function appInviteLink(r = "", base = APP_URL) {
  return typeof r === "string" && TOKEN.test(r) && r.length <= 400 ? `${base}#r=${r}` : base;
}

const ms = (d) => {
  const n = d ? new Date(d).getTime() : 0;
  return Number.isFinite(n) ? n : 0;
};
const isBooth = (id) => /^BOOTH-/i.test(String(id || ""));
const ROLE_TYPES = ["speaker", "exhibitor", "staff", "volunteer", "media"];

/** Has signed in to the app or the web app (the app's onApp rule). */
export const usesApp = (user) => !!(user && (user.appOnboarded === true || user.lastActiveAt));

/** Passes that count (not hidden, not a booth). */
const livePasses = (p) => (p?.passList || []).filter((t) => !t.hidden && !isBooth(t.ticketId));

/** What ties them to TTFC 2026, for the list: ["Power Pass", "Speaker", "VIP"]. [] = nothing (not a recipient). */
export function rolesOf(p) {
  const out = [];
  const passes = livePasses(p);
  if (passes.length) out.push(TIER_LABELS[passes[0].tier] || passes[0].label || "Pass");
  const types = new Set(p?.types || []);
  if (p?.speaker) types.add("speaker");
  if (["admin"].includes(p?.user?.role)) types.add("staff");
  if (p?.user?.role === "volunteer") types.add("volunteer");
  for (const t of ROLE_TYPES) if (types.has(t)) out.push(TYPE_LABELS[t] || t);
  if (p?.vip) out.push("VIP");
  return out;
}

/** CampaignSend rows → Map(email → { status, sentAt, sends }). */
export function sendIndex(sends = []) {
  const out = new Map();
  for (const s of sends || []) {
    const e = String(s?.email || "").trim().toLowerCase();
    if (e) out.set(e, { status: s.status, sentAt: s.sentAt || null, sends: Number(s.sends) || 0, error: s.status === "failed" ? String(s.error || "") : "" });
  }
  return out;
}

/** EmailEngagement rows of this campaign → Map(email → { opens, visits }). */
export function engagementByEmail(rows = []) {
  const out = new Map();
  for (const r of rows || []) {
    const e = String(r?.email || "").trim().toLowerCase();
    if (!e || r.campaign !== APP_INVITE_CAMPAIGN) continue;
    out.set(e, { opens: Number(r.opens) || 0, visits: Number(r.visits) || 0, lastOpenAt: r.lastOpenAt || null, lastVisitAt: r.lastVisitAt || null });
  }
  return out;
}

/**
 * Everyone it could go to, and who it will go to.
 * @param {Array} people  internal People records (services/people.js buildPeople)
 * @param {object} o
 * @param {Iterable<string>} o.optedOut  emails with Subscription.subscribed false
 * @param {Array} o.sends     this campaign's CampaignSend rows
 * @param {Array} o.engagement this campaign's EmailEngagement rows
 * @param {boolean} o.skipUsing  leave out anyone already using the app (default true)
 * @param {"all"|"one"|"failed"} o.mode  all: skip anyone already sent; one: wait COOLDOWN_MS; failed: only failed sends
 * @returns {{ rows, targets, counts }}
 *   rows: one per person who is part of TTFC 2026 (with or without a usable email):
 *         { id, name, email, roles, usingApp, status, sentAt, sends, opened, clicked, willGet, reason, label, firstName }
 *   targets: rows that would get it now (one per email); counts: see below
 */
export function planAppInvites(people = [], { optedOut = [], sends = [], engagement = [], skipUsing = true, mode = "all", now = Date.now(), cooldownMs = COOLDOWN_MS } = {}) {
  const out = new Set([...optedOut].map((e) => String(e || "").trim().toLowerCase()));
  const sendBy = sendIndex(sends);
  const eng = engagementByEmail(engagement);
  const seen = new Set();
  const rows = [];
  for (const p of people || []) {
    const roles = rolesOf(p);
    if (!roles.length) continue; // not part of TTFC 2026 (an account with no pass or role, an RSVP only)
    const raw = String(p.email || p.user?.email || "").trim().toLowerCase();
    const email = usableEmail(raw);
    const s = email ? sendBy.get(email) : null;
    const e = email ? eng.get(email) : null;
    const usingApp = usesApp(p.user);
    let reason = "";
    if (!email) reason = raw && isPlaceholderEmail(raw) ? "placeholder" : "noEmail";
    else if (p.user?.banned) reason = "banned";
    else if (out.has(email)) reason = "unsubscribed";
    else if (seen.has(email)) reason = "duplicate";
    else if (skipUsing && usingApp && mode !== "one") reason = "usingApp";
    else if (s?.status === "sending") reason = "sending";
    else if (mode === "failed" && s?.status !== "failed") reason = s?.status === "sent" ? "alreadySent" : "notFailed";
    else if (mode === "all" && s?.status === "sent") reason = "alreadySent";
    else if (mode === "one" && s?.status === "sent" && s.sentAt && now - ms(s.sentAt) < cooldownMs) reason = "recent";
    if (email) seen.add(email);
    rows.push({
      id: p.id, name: p.name, email, firstName: String(p.firstName || "").split(" ")[0] || "", roles, usingApp,
      status: s?.status || "pending", sentAt: s?.sentAt || null, sends: s?.sends || 0, error: s?.error || "",
      opened: !!e?.opens, clicked: !!e?.visits,
      // Signed in after the email went (lastActiveAt is when they last used the app).
      usingAfter: !!(s?.status === "sent" && s.sentAt && p.user?.lastActiveAt && ms(p.user.lastActiveAt) > ms(s.sentAt)),
      willGet: !reason, reason, label: reason === "notFailed" ? "No failed send to retry" : SKIP_LABELS[reason] || "",
    });
  }
  const targets = rows.filter((r) => r.willGet);
  const emails = rows.filter((r) => r.email && r.reason !== "duplicate");
  const skippedBy = {};
  for (const r of rows) if (r.reason) skippedBy[r.reason] = (skippedBy[r.reason] || 0) + 1;
  return {
    rows, targets,
    counts: {
      people: emails.length,                                   // part of TTFC 2026, one per usable address
      usingApp: emails.filter((r) => r.usingApp).length,       // of those, already signed in to the app
      willGet: targets.length,
      alreadySent: emails.filter((r) => r.status === "sent").length,
      failed: emails.filter((r) => r.status === "failed").length,
      noEmail: rows.filter((r) => !r.email).length,
      skippedBy,
    },
  };
}

/** The page's stats strip: sent · opened · clicked the button · now using the app (signed in after the email). */
export function inviteStats(rows = []) {
  const sent = rows.filter((r) => r.email && r.reason !== "duplicate" && r.status === "sent");
  return {
    sent: sent.length,
    opened: sent.filter((r) => r.opened).length,
    clicked: sent.filter((r) => r.clicked).length,
    usingAfter: sent.filter((r) => r.usingAfter).length,
    failed: rows.filter((r) => r.email && r.status === "failed").length,
    unconfirmed: rows.filter((r) => r.email && r.status === "sending").length,
  };
}

/** A made-up person for previews and test sends (never a real person). */
export const SAMPLE_PERSON = Object.freeze({ email: "jane.doe@example.com", firstName: "Jane", name: "Jane Doe" });

/** The one "send to everyone" at a time on this server ({ running, by, total, sent, failed, skipped, … }). */
export const appInviteJob = {
  state: { running: false, startedAt: null, finishedAt: null, by: "", from: "", total: 0, sent: 0, failed: 0, skipped: 0 },
  view() { return { ...this.state }; },
  start(by, from, total = 0) { this.state = { running: true, startedAt: new Date(), finishedAt: null, by, from, total, sent: 0, failed: 0, skipped: 0 }; },
  finish() { this.state = { ...this.state, running: false, finishedAt: new Date() }; },
};
