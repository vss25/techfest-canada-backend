/* One place to send a push: every phone a person has, iOS (APNs) and Android
   (FCM). Each service is a no-op until its own env is set, so callers never
   need to know which platforms are configured. Fire-and-forget; never throws. */
import * as apns from "./apns.js";
import * as fcm from "./fcm.js";

/** note: { title, body, link, thread, kind, id } */
export function pushToUsers(userIds, note) {
  apns.pushToUsers(userIds, note);
  fcm.pushToUsers(userIds, note);
}

/** Announcements: everyone with a registered phone on either platform. */
export function pushToEveryone(note) {
  apns.pushToEveryone(note);
  fcm.pushToEveryone(note);
}

/** Whether a platform's push service is configured right now. */
export const isConfigured = (platform) => (platform === "android" ? fcm.isConfigured() : apns.isConfigured());
