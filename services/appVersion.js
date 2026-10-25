/* =========================================================
   "Update the app" (Oct 24 2026, the organiser: "in the app, ask people to
   update the app when they are not the most recent version"; then "don't
   show this notification otherwise").
   ---------------------------------------------------------
   Five app content keys (GET /api/app/content, Admin › App text & switches ›
   App updates, management only: services/staffPowers.js):
     app.ios_latest       the newest iOS version in the App Store ("1.0.3")
     app.android_latest   the newest Android version on Google Play ("1.0.6")
     app.ios_minimum      below this the iOS app asks to update before going on
     app.android_minimum  the same for Android
     app.update_message   optional words for the "new version" banner ("" = the app's own)
   The apps (iOS Services/AppUpdate.swift, Android data/AppUpdate.kt) show a
   dismissible "A new version of TTFC is available · Update" ONLY when the
   installed version is older than `latest`, and only after a successful
   fetch (never offline, never as a push or inbox item); a dismissal lasts a
   day per version. The minimums default to empty: nobody is ever blocked
   unless management sets one. Set `latest` only once that version is live
   in the store, or people are sent to a store page without it.
   Versions are numbers and dots ("1.0.10" is newer than "1.0.9"). Pure;
   test/app-version.test.js.
========================================================= */

/** The defaults: the versions this release ships (iOS 1.0.3 (20), Android 1.0.6 (9)); no minimum. */
export const APP_VERSION_DEFAULTS = Object.freeze({
  "app.ios_latest": "1.0.3",
  "app.ios_minimum": "",
  "app.android_latest": "1.0.6",
  "app.android_minimum": "",
  "app.update_message": "",
});
export const APP_VERSION_KEYS = Object.freeze(Object.keys(APP_VERSION_DEFAULTS));
const VERSION_KEYS = new Set(["app.ios_latest", "app.ios_minimum", "app.android_latest", "app.android_minimum"]);

const VERSION_RE = /^\d{1,4}(\.\d{1,4}){0,3}$/;
export const VERSION_ERROR = "Use a version number like 1.0.3 (numbers and dots), or leave it empty.";

/** "1.0.10" → [1, 0, 10]; null for anything that isn't a version. */
export function parseVersion(v) {
  const s = String(v ?? "").trim();
  return VERSION_RE.test(s) ? s.split(".").map(Number) : null;
}

/** -1 / 0 / 1, numerically part by part ("1.0" = "1.0.0", "1.0.10" > "1.0.9"); null when either isn't a version. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * One of these keys from the admin panel → [key, value] to store, null when it can't be saved (VERSION_ERROR says
 * why), or undefined when the key isn't one of these.
 */
export function cleanAppVersionContent(key, value) {
  if (!APP_VERSION_KEYS.includes(key)) return undefined;
  const s = String(value ?? "").trim();
  if (key === "app.update_message") return [key, s.slice(0, 280)];
  if (s === "") return [key, ""];
  return VERSION_RE.test(s) ? [key, s] : null;
}

/** Why a value of one of these keys can't be saved ("" when it can, or the key isn't one of these). */
export function appVersionContentError(key, value) {
  return VERSION_KEYS.has(key) && cleanAppVersionContent(key, value) === null ? VERSION_ERROR : "";
}
