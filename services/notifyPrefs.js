/* =========================================================
   Notification preferences (Oct 22 2026): which pushes and emails
   someone wants. Stored as User.notifyPrefs { key: Boolean }; a key
   that isn't stored is on, so everyone starts with everything on and
   only switching one off writes anything. Every push (services/push.js
   `pref`) and the "What you missed" email (services/digest.js) check
   them. GET / PATCH /api/social/notify/prefs. Pure.
========================================================= */

/** The switches, in the order the apps' Settings › Notifications shows them, with the apps' wording. */
export const NOTIFY_PREFS = Object.freeze([
  { key: "messages", label: "Messages" },
  { key: "comments", label: "Comments and replies" },
  { key: "mentions", label: "Mentions" },
  { key: "likes", label: "Likes" },
  { key: "groups", label: "Group and session chats" },
  { key: "connections", label: "Connection requests" },
  { key: "announcements", label: "Announcements from TTFC" },
  { key: "digestEmail", label: "Email me a summary of what I missed" },
].map((p) => Object.freeze(p)));

export const PREF_KEYS = Object.freeze(NOTIFY_PREFS.map((p) => p.key));

/** Every switch for this person: true unless they turned it off. */
export function prefsOf(user) {
  const stored = user?.notifyPrefs && typeof user.notifyPrefs === "object" ? user.notifyPrefs : {};
  return Object.fromEntries(PREF_KEYS.map((k) => [k, stored[k] !== false]));
}

/** Does this person want `key`? (an unknown key is on). */
export const wants = (user, key) => !PREF_KEYS.includes(key) || prefsOf(user)[key];

/** A PATCH body → the $set for the keys it changes (booleans only), or null when it changes nothing. */
export function prefsUpdate(body) {
  const b = body && typeof body === "object" ? body : {};
  const set = {};
  for (const k of PREF_KEYS) if (typeof b[k] === "boolean") set[`notifyPrefs.${k}`] = b[k];
  return Object.keys(set).length ? set : null;
}

/** What GET / PATCH /notify/prefs answer. */
export const prefsDTO = (user) => ({ prefs: prefsOf(user), options: NOTIFY_PREFS });
