/* =========================================================
   Per-session live polls and audience Q&A
   ---------------------------------------------------------
   Each agenda session (Sanity `session` doc) has two switches,
   `polls` and `qa`: "auto" | "on" | "off" (missing = "auto").
     "on"   → on
     "off"  → off
     "auto" → on when the session has a moderator (moderator.name
              not blank) and is not a keynote (format "keynote") or a
              break (isBreak true or format "break")
   The global switches (flag.polls, flag.qa in services/liveSwitches.js)
   still apply on top: global off = off everywhere.

   The rule is pure and exported (unit-tested). The website admin
   previews it with a copy (src/admin/cms/sessionLive.js, keep the
   two in step) and the apps read the same Sanity fields.

   The routes in routes/social.js look the session up by `sessionId`
   or `_id` (Sanity CDN, cached 60 s, last good copy kept). If the
   agenda can't be read, or the session isn't on it, they allow
   (fail open) and log once per outage.
========================================================= */

import { SANITY_PROJECT } from "./rsvp.js";
import { makeAgendaCache } from "./points.js";
import { LIVE_MODES } from "./cmsSchema.js";

export { LIVE_MODES };   // "auto" | "on" | "off", one copy in services/cmsSchema.js
export const LIVE_FEATURES = ["polls", "qa"];

export const OFF_ERRORS = {
  polls: "Polls are off for this session.",
  qa: "Q&A is off for this session.",
};

/** Anything that isn't "on" or "off" counts as "auto". Pure. */
export const liveMode = (v) => (v === "on" || v === "off" ? v : "auto");

/** What "auto" resolves to and why: "break" | "keynote" | "noModerator" (all off) or "moderator" (on). Pure. */
export function autoReason(s) {
  if (s?.isBreak === true || s?.format === "break") return "break";
  if (s?.format === "keynote") return "keynote";
  if (!String(s?.moderator?.name ?? "").trim()) return "noModerator";
  return "moderator";
}

/** Is `feature` ("polls" | "qa") on for this session, before the global switch? Pure. */
export function featureOn(s, feature) {
  const mode = liveMode(s?.[feature]);
  if (mode === "on") return true;
  if (mode === "off") return false;
  return autoReason(s) === "moderator";
}

/** { pollsOn, qaOn } for a session doc. `global` = the flag.polls / flag.qa switches (default on). Pure. */
export function sessionLive(s, global = {}) {
  return {
    pollsOn: global.polls !== false && featureOn(s, "polls"),
    qaOn: global.qa !== false && featureOn(s, "qa"),
  };
}

/* ---------- lookup (Sanity, public CDN) ---------- */

const LIVE_QUERY = '*[_type=="session" && !(_id in path("drafts.**"))]{_id, sessionId, format, isBreak, moderator, polls, qa}';
export const LIVE_URL =
  `https://${SANITY_PROJECT}.apicdn.sanity.io/v2021-10-21/data/query/production?query=${encodeURIComponent(LIVE_QUERY)}`;

/** Sanity result → Map<id, { pollsOn, qaOn }> keyed by each session's `sessionId`
    and `_id` (both are kept). Null when there are none. Pure. */
export function parseSessionLive(json) {
  const map = new Map();
  const rows = Array.isArray(json?.result) ? json.result : [];
  for (const s of rows) {
    if (!s || typeof s !== "object") continue;
    const live = sessionLive(s);
    for (const v of [s.sessionId, s._id]) {
      const id = typeof v === "string" ? v.trim() : "";
      if (id && !map.has(id)) map.set(id, live);
    }
  }
  return map.size ? map : null;
}

/** A 60-second cache of parseSessionLive (last good copy on failure, null until loaded). */
export const makeSessionLiveCache = (opts = {}) =>
  makeAgendaCache({ url: LIVE_URL, parse: parseSessionLive, label: "SESSION LIVE", ttlMs: 60 * 1000, retryMs: 60 * 1000, ...opts });

/** Is `feature` allowed for `sessionId` (per-session switch only)? Unknown
    session or unreadable agenda → true (fail open). Never throws. */
export async function allowedIn(cache, sessionId, feature) {
  const map = await cache.get();
  const live = map?.get(String(sessionId ?? "").trim());
  if (!live) return true;
  return feature === "polls" ? live.pollsOn : live.qaOn;
}

const shared = makeSessionLiveCache();

/** Per-session switch for the live routes (the global one is checked separately). */
export const sessionAllows = (sessionId, feature) => allowedIn(shared, sessionId, feature);
