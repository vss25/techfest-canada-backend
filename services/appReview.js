/* =========================================================
   "Rate the app" (Oct 27 2026, the organiser, Day 2: ask people to
   rate the app in the afternoon).
   ---------------------------------------------------------
   Three app content keys (GET /api/app/content, Admin › App text &
   switches, management only: services/staffPowers.js):
     review.enabled    "true" | "false": whether the apps may ask at all
     review.ask_from   the window's start, an ISO time with its offset
     review.ask_until  the window's end, the same
   Inside the window the apps show Apple's / Google's own rating prompt
   once, after a good moment; the stores decide whether it really
   appears. Outside it, or with review.enabled "false", they never ask.
   The values are strings (the apps read "true" / "false" like the
   flag.* keys). Pure; test/app-review.test.js.
========================================================= */

export const REVIEW_DEFAULTS = Object.freeze({
  "review.enabled": "true",
  "review.ask_from": "2026-10-27T12:00:00-04:00",    // Day 2, noon Toronto (EDT)
  "review.ask_until": "2026-10-27T23:59:00-04:00",   // Day 2, 11:59 PM
});
export const REVIEW_KEYS = Object.freeze(Object.keys(REVIEW_DEFAULTS));
const TIME_KEYS = new Set(["review.ask_from", "review.ask_until"]);

const WINDOW_NOTE = "The apps show Apple's / Google's own rating prompt once, after a good moment, inside this window.";
/** The admin panel's words for each key (GET /api/console/app-content rows carry them as label and description). */
export const REVIEW_LABELS = Object.freeze({
  "review.enabled": Object.freeze({
    label: "Ask for an app rating",
    description: `"true": the apps may ask for a rating between the two times below; "false": they never ask. ${WINDOW_NOTE}`,
  }),
  "review.ask_from": Object.freeze({
    label: "Ask for an app rating: from",
    description: `${WINDOW_NOTE} An ISO time with its offset (Toronto), e.g. 2026-10-27T12:00:00-04:00.`,
  }),
  "review.ask_until": Object.freeze({
    label: "Ask for an app rating: until",
    description: `${WINDOW_NOTE} An ISO time with its offset (Toronto), e.g. 2026-10-27T23:59:00-04:00.`,
  }),
});

export const ENABLED_ERROR = 'Use "true" or "false".';
export const TIME_ERROR = "Use an ISO time with its offset, for example 2026-10-27T12:00:00-04:00.";

const ISO_WITH_OFFSET = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,3})?)?([zZ]|[+-]\d\d:?\d\d)$/;

/**
 * One of these keys from the admin panel → [key, value] to store, null when it can't be saved (reviewContentError
 * says why), or undefined when the key isn't one of these.
 */
export function cleanReviewContent(key, value) {
  if (!REVIEW_KEYS.includes(key)) return undefined;
  if (key === "review.enabled") {
    if (value === true || value === false) return [key, String(value)];
    const s = String(value ?? "").trim().toLowerCase();
    return s === "true" || s === "false" ? [key, s] : null;
  }
  const s = String(value ?? "").trim();
  return ISO_WITH_OFFSET.test(s) && !Number.isNaN(new Date(s).getTime()) ? [key, s] : null;
}

/** Why a value of one of these keys can't be saved ("" when it can, or the key isn't one of these). */
export function reviewContentError(key, value) {
  if (!REVIEW_KEYS.includes(key) || cleanReviewContent(key, value) !== null) return "";
  return TIME_KEYS.has(key) ? TIME_ERROR : ENABLED_ERROR;
}
