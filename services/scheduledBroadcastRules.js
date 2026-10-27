/* =========================================================
   Scheduled broadcasts (Oct 27 2026): the rules. Pure (test/scheduled-broadcasts.test.js).
   ---------------------------------------------------------
   The organiser, Day 2: at 7 PM tell everyone on the app "TTFC 2026
   has ended, but keep using the app for networking. See you in 2027"
   with a link to the 2027 page, and earlier in the afternoon ask
   people to rate the app. So management can schedule a message for
   later (Admin, management only; routes/console.js
   /api/console/broadcasts/scheduled, storage and the minute job
   services/scheduledBroadcasts.js, models/ScheduledBroadcast.js).
   Nothing is seeded: management creates each one.

   An item: sendAt (ISO with its offset or Z), title (≤ 80; needed
   when notify), body (≤ 500, always), linkUrl ("" or a link the
   personal notifications accept: ttfc://tab/…, ttfc://session/…,
   https://…), the channels feedPost / banner / notify (at least
   one) and audience ("app" | "checkedIn", for notify).
   sendAt must be at least 2 minutes ahead and outside the quiet
   hours, 22:00–08:00 Toronto time (the organiser's rule: no pushes
   at night), with Toronto's own offset on that date (EDT / EST).
   "Send now" (a person pressing it) skips both checks.
========================================================= */

import { BODY_MAX, TITLE_MAX, cleanLink } from "./notifyHelpers.js";

export const TZ = "America/Toronto";
/** No scheduled send may be set for these Toronto times: from 22:00 (included) to 08:00 (excluded). */
export const QUIET_HOURS = Object.freeze({ from: "22:00", to: "08:00", tz: TZ });
const QUIET_FROM = 22 * 60;
const QUIET_TO = 8 * 60;
/** How far ahead a scheduled time must be. */
export const MIN_LEAD_MS = 2 * 60_000;
/** Found by the job more than this late (the server was down): marked "missed", never sent. */
export const MISSED_AFTER_MS = 2 * 60 * 60_000;
/** A send that has been "sending" this long was cut off (the server restarted): marked "failed", never sent again. */
export const STUCK_AFTER_MS = 15 * 60_000;
/** Inbox rows written (and pushes asked for) at a time. */
export const CHUNK = 500;
export const AUDIENCES = Object.freeze(["app", "checkedIn"]);
export const CHANNELS = Object.freeze(["feedPost", "banner", "notify"]);
/** The fields a create or an edit may send. */
export const FIELDS = Object.freeze(["sendAt", "title", "body", "linkUrl", "feedPost", "banner", "notify", "audience"]);
/** Who the feed post, the inbox rows and the pushes are from (like POST /api/console/broadcast). */
export const ORG_NAME = "The Tech Festival Canada";
export const ORG_TITLE = "Organizers";
export const ORG_COMPANY = "AtlasLink Markets";
/** The Home banner's key and length (like POST /api/console/broadcast). */
export const BANNER_KEY = "home.announcement";
export const BANNER_MAX = 280;

export const ERRORS = Object.freeze({
  sendAtMissing: "Pick when to send it.",
  sendAtBad: "That time can't be read. Send it as an ISO time with its offset, for example 2026-10-27T19:00:00-04:00.",
  sendAtSoon: "Pick a time at least 2 minutes from now.",
  quietHours: "Nothing is sent between 10 PM and 8 AM Toronto time. Pick a time between 8 AM and 10 PM.",
  titleMissing: "Add a title for the notification.",
  titleLong: `Keep the title to ${TITLE_MAX} characters.`,
  bodyMissing: "Add a message.",
  bodyLong: `Keep the message to ${BODY_MAX} characters.`,
  link: "That link can't be used. Pick a screen in the app, a session, or an https:// web page.",
  channels: "Pick at least one: a feed post, the Home banner or a notification.",
  audience: "Pick who gets the notification: \"app\" (everyone on the app) or \"checkedIn\" (people who checked in).",
});

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const tidyBody = (s) => String(s ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const clock = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** { hour, minute } of this moment on Toronto's clock (EDT or EST, whichever applies that day). */
export function torontoClock(d) {
  const parts = Object.fromEntries(clock.formatToParts(new Date(d)).map((p) => [p.type, p.value]));
  return { hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
}

/** Is this moment inside the quiet hours (22:00–08:00 Toronto)? */
export function inQuietHours(d) {
  const { hour, minute } = torontoClock(d);
  const m = hour * 60 + minute;
  return m >= QUIET_FROM || m < QUIET_TO;
}

/** An ISO time with its offset or Z → Date; null for anything else (a time without its zone is refused: the server's
    clock is UTC, so "19:00" would be 3 PM in Toronto). */
export function parseSendAt(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = String(v ?? "").trim();
  if (!s || !/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(s) || !/([zZ]|[+-]\d\d:?\d\d)$/.test(s)) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Checks a create (existing null) or an edit (existing: the saved item; only the fields sent change).
 * sendAt is checked (2 minutes ahead, not in the quiet hours) on a create and whenever an edit sends it.
 * → { value: { sendAt, title, body, linkUrl, feedPost, banner, notify, audience } } or { error, field }
 */
export function validateScheduled(input, { now = new Date(), existing = null } = {}) {
  const b = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const base = existing || {};
  const pick = (k, fallback) => (has(b, k) ? b[k] : has(base, k) ? base[k] : fallback);
  const fail = (field, error) => ({ error, field });

  const feedPost = pick("feedPost", false) === true;
  const banner = pick("banner", false) === true;
  const notify = pick("notify", false) === true;

  const title = oneLine(pick("title", ""));
  if (notify && !title) return fail("title", ERRORS.titleMissing);
  if (title.length > TITLE_MAX) return fail("title", ERRORS.titleLong);
  const body = tidyBody(pick("body", ""));
  if (!body) return fail("body", ERRORS.bodyMissing);
  if (body.length > BODY_MAX) return fail("body", ERRORS.bodyLong);
  const linkUrl = cleanLink(pick("linkUrl", ""));
  if (linkUrl === null) return fail("linkUrl", ERRORS.link);
  if (!feedPost && !banner && !notify) return fail("channels", ERRORS.channels);
  const audience = pick("audience", "app") ?? "app";
  if (!AUDIENCES.includes(audience)) return fail("audience", ERRORS.audience);

  let sendAt;
  if (!existing || has(b, "sendAt")) {
    if (b.sendAt === undefined || b.sendAt === null || b.sendAt === "") return fail("sendAt", ERRORS.sendAtMissing);
    sendAt = parseSendAt(b.sendAt);
    if (!sendAt) return fail("sendAt", ERRORS.sendAtBad);
    if (sendAt.getTime() < new Date(now).getTime() + MIN_LEAD_MS) return fail("sendAt", ERRORS.sendAtSoon);
    if (inQuietHours(sendAt)) return fail("sendAt", ERRORS.quietHours);
  } else {
    sendAt = new Date(base.sendAt);
  }
  return { value: { sendAt, title, body, linkUrl, feedPost, banner, notify, audience } };
}

/** Did the job find it too late to send (more than MISSED_AFTER_MS after sendAt)? */
export const isMissed = (item, now = new Date()) => new Date(now).getTime() - new Date(item?.sendAt).getTime() > MISSED_AFTER_MS;

/** The inbox rows' batch: "sched:<item id>". */
export const batchIdOf = (id) => `sched:${id}`;

/** Splits a list into runs of `size`. */
export function chunks(list, size = CHUNK) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const iso = (d) => (d ? new Date(d).toISOString() : null);

/** What the admin panel gets for an item. `estimate`: how many people it would reach now (scheduled items with
    notify only; null otherwise). */
export function scheduledDTO(d, { estimate = null } = {}) {
  return {
    id: String(d._id ?? d.id ?? ""),
    sendAt: iso(d.sendAt),
    title: d.title || "",
    body: d.body || "",
    linkUrl: d.linkUrl || "",
    feedPost: d.feedPost === true,
    banner: d.banner === true,
    notify: d.notify === true,
    audience: AUDIENCES.includes(d.audience) ? d.audience : "app",
    status: d.status || "scheduled",
    sentAt: iso(d.sentAt),
    recipients: Number(d.recipients) || 0,
    postId: d.postId ? String(d.postId) : null,
    error: d.error || "",
    createdByName: d.createdByName || "",
    updatedByName: d.updatedByName || "",
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
    estimate: d.status === "scheduled" && d.notify === true && Number.isFinite(estimate) ? estimate : null,
  };
}

/** One line for the audit log: "7:00 PM Oct 27 · post + banner + notify (app) · TTFC 2026 has ended". */
export function auditLine(v) {
  const t = new Date(v.sendAt);
  const when = Number.isNaN(t.getTime()) ? "" : t.toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const ch = [v.feedPost && "post", v.banner && "banner", v.notify && `notify (${v.audience || "app"})`].filter(Boolean).join(" + ");
  return `${when} · ${ch} · ${v.title || String(v.body || "").slice(0, 80)}`.slice(0, 300);
}
