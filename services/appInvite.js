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

   Groups and a selection (Oct 20 2026, the organiser: "allow me to
   send in groups of 10, 20, 50, 100, and select who i want to send to
   and to see whether they purchased ticket or alloted ticket"): each
   row says how they got their ticket (ticketOf: bought, with the
   coupon code, or given by staff, from services/promoCodes.js howGot),
   whether it can go to them again (sendAgain: sent over COOLDOWN_DAYS
   ago, the single-send rule) and whether it can be picked (canSelect).
   A group or a selection comes back from the page as a list of
   emails; pickBatch keeps only the ones on the list that can get it
   now, in that order, and says why the rest were dropped
   (test/app-invite-batches.test.js).
========================================================= */

import { EVENT } from "./ticketInfo.js";
import { isPlaceholderEmail, usableEmail } from "./attendingCampaign.js";
import { TYPE_LABELS } from "./teamRoles.js";
import { TIER_LABELS } from "./rsvp.js";
import { codeOf, codeView, howGot } from "./promoCodes.js";

export const APP_INVITE_CAMPAIGN = "app-invite-2026";
/** While the swag kit contest is on (services/swagRules.js swag.enabled), the email carries the swag offer and its
    sends are claimed under this key (Oct 22 2026): someone who got the earlier invite but still isn't on the app can
    get this version once; the earlier sends stay recorded under APP_INVITE_CAMPAIGN. Tracking (opens, the web app
    visit) stays under APP_INVITE_CAMPAIGN for both. */
export const APP_INVITE_SWAG_KEY = "app-invite-2026-swag";
/** The CampaignSend key sends are claimed under now. */
export const inviteSendKey = (swagOn) => (swagOn ? APP_INVITE_SWAG_KEY : APP_INVITE_CAMPAIGN);
export const SWAG_SENT_LABEL = "Already got this version";
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
  notListed: "Not on the list (no pass or role at TTFC 2026)",
});

/** Group sends: the sizes on offer, and from how many people the confirm asks to type SEND. */
export const GROUP_SIZES = Object.freeze([10, 20, 50, 100]);
export const TYPE_SEND_FROM = 50;
/** The most emails one selection can carry. */
export const MAX_BATCH = 2000;

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

const TIER_RANK = { speaker: 5, apex: 4, power: 3, influence: 2, connect: 1 };
const GROUP_RANK = { bought: 0, given: 1, unknown: 2 };
/** A pass's code: People's (services/people.js) or worked out from its records. */
const passCode = (t) => t?.code || (t?.codeSources ? codeView(codeOf(t.codeSources)) : null);

/** Their passes, most relevant first: usable before refunded, bought before given, the biggest pass, the newest. → [{ t, h }] */
export function relevantPasses(p) {
  return livePasses(p).map((t) => ({ t, h: howGot(passCode(t)) })).sort((x, y) =>
    ((x.t.status === "refunded") - (y.t.status === "refunded"))
    || (GROUP_RANK[x.h.group] - GROUP_RANK[y.h.group])
    || ((TIER_RANK[y.t.tier] || 0) - (TIER_RANK[x.t.tier] || 0))
    || (ms(y.t.purchaseDate) - ms(x.t.purchaseDate)));
}

/**
 * How they got their ticket, for the list's Ticket column: the most relevant pass, and how many more they hold.
 * → { how: bought | issued | comp | exhibitor | speaker | unknown | none, group: bought | given | unknown | none,
 *     label: "Bought · SPRING20" | "Given by staff" | … | "No ticket", code, detail, pass: "Power Pass", more,
 *     groups: every pass's group (the Bought / Given filters match any of them), all: ["Power Pass · Bought · SPRING20", …] }
 */
export function ticketOf(p) {
  const list = relevantPasses(p);
  if (!list.length) {
    return { how: "none", group: "none", label: "No ticket", code: "", detail: "No pass on record (a role only, e.g. a speaker without a pass yet)", pass: "", more: 0, groups: ["none"], all: [] };
  }
  const line = ({ t, h }) => `${TIER_LABELS[t.tier] || t.label || "Pass"} · ${h.label}${t.status === "refunded" ? " · refunded" : ""}`;
  const { t, h } = list[0];
  return {
    how: h.how, group: h.group, label: `${h.label}${t.status === "refunded" ? " · refunded" : ""}`, code: h.code, detail: h.detail,
    pass: TIER_LABELS[t.tier] || t.label || "Pass", more: list.length - 1,
    groups: [...new Set(list.map((x) => x.h.group))], all: list.map(line),
  };
}

/** What ties them to TTFC 2026, for the list: ["Power Pass", "Speaker", "VIP"]. [] = nothing (not a recipient). */
export function rolesOf(p) {
  const out = [];
  const passes = relevantPasses(p).map((x) => x.t);
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
 * @param {Array} o.sends     the CampaignSend rows of the key sends are claimed under now (inviteSendKey)
 * @param {Array} o.earlierSends  with `swag`: the earlier invite's rows (APP_INVITE_CAMPAIGN), shown as earlierSentAt
 * @param {Array} o.engagement this campaign's EmailEngagement rows
 * @param {boolean} o.skipUsing  leave out anyone already using the app (default true)
 * @param {"all"|"one"|"failed"} o.mode  all: skip anyone already sent; one: wait COOLDOWN_MS; failed: only failed sends
 * @param {boolean} o.swag   the swag version is on: "already sent" means this version ("Already got this version")
 * @returns {{ rows, targets, counts }}
 *   rows: one per person who is part of TTFC 2026 (with or without a usable email):
 *         { id, name, email, roles, usingApp, status, sentAt, sends, opened, clicked, willGet, reason, label, firstName }
 *   targets: rows that would get it now (one per email); counts: see below
 */
export function planAppInvites(people = [], { optedOut = [], sends = [], earlierSends = [], engagement = [], skipUsing = true, mode = "all", now = Date.now(), cooldownMs = COOLDOWN_MS, swag = false } = {}) {
  const out = new Set([...optedOut].map((e) => String(e || "").trim().toLowerCase()));
  const sendBy = sendIndex(sends);
  const earlierBy = swag ? sendIndex(earlierSends) : new Map();
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
    // Already sent, nothing else in the way, and the single-send cool-down has passed: it can go again if picked.
    const sendAgain = mode === "all" && reason === "alreadySent" && !!s?.sentAt && now - ms(s.sentAt) >= cooldownMs;
    rows.push({
      id: p.id, name: p.name, email, firstName: String(p.firstName || "").split(" ")[0] || "", roles, usingApp, ticket: ticketOf(p),
      sendAgain, canSelect: !reason || sendAgain,
      status: s?.status || "pending", sentAt: s?.sentAt || null, sends: s?.sends || 0, error: s?.error || "",
      opened: !!e?.opens, clicked: !!e?.visits,
      // The swag version (Oct 22 2026): which version this row's status is about, and when they got the earlier one.
      version: swag ? "swag" : "standard",
      earlierSentAt: (email && earlierBy.get(email)?.status === "sent" && earlierBy.get(email).sentAt) || null,
      // Signed in after the email went (lastActiveAt is when they last used the app).
      usingAfter: !!(s?.status === "sent" && s.sentAt && p.user?.lastActiveAt && ms(p.user.lastActiveAt) > ms(s.sentAt)),
      willGet: !reason, reason,
      label: reason === "notFailed" ? "No failed send to retry" : swag && reason === "alreadySent" ? SWAG_SENT_LABEL : SKIP_LABELS[reason] || "",
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

/**
 * A group or a selection: the emails the page sent back, kept in that order, intersected with who can get it now
 * (`plan`: planAppInvites in mode "all", read fresh). Never trusts the page: an email that isn't on the list, or
 * can't get it now, is dropped and said why.
 *   kind "next":     only people who'll get it (not sent yet), like the send to everyone
 *   kind "selected": also people it can go to again (sendAgain: sent over COOLDOWN_DAYS ago)
 * → { todo: plan rows to send, dropped: [{ email, name, reason, label }] }
 */
export function pickBatch(plan, emails = [], { kind = "selected" } = {}) {
  const byEmail = new Map();
  for (const r of plan?.rows || []) if (r.email && r.reason !== "duplicate" && !byEmail.has(r.email)) byEmail.set(r.email, r);
  const todo = [];
  const dropped = [];
  const seen = new Set();
  for (const raw of emails || []) {
    const email = usableEmail(raw);
    const key = email || String(raw ?? "").trim().toLowerCase().slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    const r = email ? byEmail.get(email) : null;
    if (r && (r.willGet || (kind === "selected" && r.sendAgain))) { todo.push(r); continue; }
    const reason = !r ? "notListed" : r.reason === "alreadySent" && kind === "selected" ? "recent" : r.reason || "notListed";
    dropped.push({ email: key, name: r?.name || "", reason, label: (r?.reason === reason && r?.label) || SKIP_LABELS[reason] || "" });
  }
  return { todo, dropped };
}

/** pickBatch's dropped → "2 already sent, 1 not on the list" (for the page's message). */
export function droppedSummary(dropped = []) {
  const by = new Map();
  for (const d of dropped || []) {
    const label = (SKIP_LABELS[d.reason] || d.label || "can't get it now").replace(/ \(.*\)$/, "");
    by.set(label, (by.get(label) || 0) + 1);
  }
  return [...by].map(([label, n]) => `${n} ${label.charAt(0).toLowerCase()}${label.slice(1)}`).join(", ");
}

/** The one multi-person send at a time on this server (everyone, the failures, a group or a selection):
    { running, kind: all | retry | next | selected, size, by, total, sent, failed, skipped, dropped, … }. */
export const appInviteJob = {
  state: { running: false, startedAt: null, finishedAt: null, by: "", from: "", kind: "", size: 0, total: 0, sent: 0, failed: 0, skipped: 0, dropped: 0 },
  view() { return { ...this.state }; },
  start(by, from, total = 0, extra = {}) {
    const before = this.state;
    this.state = { running: true, startedAt: new Date(), finishedAt: null, by, from, kind: "all", size: 0, total, sent: 0, failed: 0, skipped: 0, dropped: 0, ...extra };
    return before;
  },
  /** Undo a start that sent nothing (the last run's result stays on the page). */
  restore(before) { if (before) this.state = before; },
  finish() { this.state = { ...this.state, running: false, finishedAt: new Date() }; },
};
