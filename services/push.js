/* One place to send a push: every phone a person has, iOS (APNs) and Android
   (FCM). Each service is a no-op until its own env is set, so callers never
   need to know which platforms are configured. Fire-and-forget; never throws.
   `from` (whose action it is): a person hidden from the app (services/appHide.js)
   reaches nobody, so their pushes are dropped here as well as in the routes. */
import * as apns from "./apns.js";
import * as fcm from "./fcm.js";
import { isHidden } from "./appHide.js";

let observer = null;
/** Tests: see every push that goes out (null stops). Production never sets it. */
export function observePushes(fn) {
  observer = typeof fn === "function" ? fn : null;
}

function send(userIds, note) {
  try { observer?.(userIds.map(String), note); } catch { /* a test hook never breaks a push */ }
  apns.pushToUsers(userIds, note);
  fcm.pushToUsers(userIds, note);
}

/** note: { title, body, link, thread, kind, id }; `from`: the person whose action it is (optional). */
export function pushToUsers(userIds, note, { from } = {}) {
  if (!userIds?.length) return;
  if (!from) return send(userIds, note);
  // When we can't tell, it isn't sent: a missed push is better than one from a hidden person.
  isHidden(from)
    .then((hidden) => { if (!hidden) send(userIds, note); })
    .catch((err) => console.error("PUSH HIDE CHECK ERROR:", err?.message || err));
}

/** Announcements: everyone with a registered phone on either platform. */
export function pushToEveryone(note) {
  apns.pushToEveryone(note);
  fcm.pushToEveryone(note);
}

/** Whether a platform's push service is configured right now. */
export const isConfigured = (platform) => (platform === "android" ? fcm.isConfigured() : apns.isConfigured());
