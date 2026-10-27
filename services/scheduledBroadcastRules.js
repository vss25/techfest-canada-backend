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
   one) and audience (for notify): "app" (everyone signed into the
   app), "checkedIn" (those with a door check-in on Day 1 or 2) or
   "outdated" (those whose app is older than the newest version for
   their platform, the "App updates" keys app.ios_latest /
   app.android_latest: outdatedUserIds below).
   sendAt must be at least 2 minutes ahead and outside the quiet
   hours, 22:00–08:00 Toronto time (the organiser's rule: no pushes
   at night), with Toronto's own offset on that date (EDT / EST).
   "Send now" (a person pressing it) skips both checks.
========================================================= */

import { BODY_MAX, TITLE_MAX, cleanLink } from "./notifyHelpers.js";
import { compareVersions } from "./appVersion.js";

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
export const AUDIENCES = Object.freeze(["app", "checkedIn", "outdated"]);
/** The platforms with a store version to be behind ("web" never is). */
export const STORE_PLATFORMS = Object.freeze(["ios", "android"]);
export const CHANNELS = Object.freeze(["feedPost", "banner", "notify"]);
/** The fields a create or an edit may send. */
export const FIELDS = Object.freeze(["sendAt", "title", "body", "linkUrl", "feedPost", "banner", "notify", "audience"]);
/** Who the feed post, the inbox rows and the pushes are from (like POST /api/console/broadcast). */
export const ORG_NAME = "The Tech Festival Canada";
export const ORG_TITLE = "Organizers";
export const ORG_COMPANY = "AtlasLink Markets";
/** The Home banner's key and length (like POST /api/console/broadcast). */
export const BANNER_KEY = "home.announcement";
/** The banner's link: the item's linkUrl, or "" (cleared, so an older link doesn't stay on the new text). */
export const BANNER_LINK_KEY = "home.announcement_link";
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
  audience: "Pick who gets the notification: \"app\" (everyone on the app), \"checkedIn\" (people who checked in) or \"outdated\" (people on an older app version).",
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

/* ---------- the "outdated" audience ---------- */

/** The version an app sent with its events: "1.0.3 (20)" (iOS) or "1.0.6 (9) android" (Android) → "1.0.3"; "" when
    there's none ("", "?", "web"). */
export function appVersionNumber(raw) {
  const m = /^\s*v?(\d{1,4}(?:\.\d{1,4}){0,3})(?![\d.])/i.exec(String(raw ?? ""));
  return m ? m[1] : "";
}

/**
 * Who is on an older app than the newest one for their platform.
 *   platforms: [{ userId, platform, lastAt }]   each person's newest event per platform (AppEvent)
 *   versions:  [{ userId, platform, appVersion }] each person's newest event with a version, per store platform
 *   latest:    { ios, android }                   the "App updates" keys (app.ios_latest / app.android_latest)
 * A person's platform is the one of their newest event; their version is the newest one recorded on it. Left out:
 * nobody with a version recorded on that platform, a newest event from the web app, a platform whose newest version
 * is empty or not a version. Versions compare numerically ("1.0.10" is newer than "1.0.9"). → Set of userId strings
 */
export function outdatedUserIds({ platforms = [], versions = [], latest = {} } = {}) {
  const newest = new Map();
  for (const r of platforms) {
    const id = String(r?.userId ?? "");
    const at = new Date(r?.lastAt).getTime();
    if (!id || Number.isNaN(at)) continue;
    const was = newest.get(id);
    if (!was || at > was.at) newest.set(id, { platform: String(r.platform || ""), at });
  }
  const versionOf = new Map(versions.map((r) => [`${r?.userId}|${r?.platform}`, appVersionNumber(r?.appVersion)]));
  const out = new Set();
  for (const [id, { platform }] of newest) {
    if (!STORE_PLATFORMS.includes(platform)) continue;
    const v = versionOf.get(`${id}|${platform}`);
    if (v && compareVersions(v, String(latest?.[platform] ?? "").trim()) === -1) out.add(id);
  }
  return out;
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
