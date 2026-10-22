/* One place to send a push: every phone a person has, iOS (APNs) and Android
   (FCM), and every browser they use the web app in (Web Push, which needs no
   setup). APNs and FCM are no-ops until their own env is set, so callers never
   need to know which platforms are configured. Fire-and-forget; never throws.
   `from` (whose action it is): a person hidden from the app (services/appHide.js)
   reaches nobody, so their pushes are dropped here as well as in the routes.
   `pref` (Oct 22 2026, services/notifyPrefs.js): people who switched that kind
   off in Settings › Notifications are left out.
   Every push carries `url`, the web app route it opens (webUrlFor), and its
   `thread` collapses it on each platform (APNs apns-collapse-id, FCM tag, the
   web push tag and Topic), so a newer push about the same post or chat replaces
   the older one. */
import * as apns from "./apns.js";
import * as fcm from "./fcm.js";
import * as webPush from "./webPush.js";
import { isHidden } from "./appHide.js";
import User from "../models/User.js";

let observer = null;
/** Tests: see every push that goes out (null stops). Production never sets it. */
export function observePushes(fn) {
  observer = typeof fn === "function" ? fn : null;
}

const withUrl = (note) => ({ ...note, url: note?.url || webPush.webUrlFor(note || {}) });

function send(userIds, note, from) {
  const n = withUrl(note);
  try { observer?.(userIds.map(String), n); } catch { /* a test hook never breaks a push */ }
  apns.pushToUsers(userIds, n);
  fcm.pushToUsers(userIds, n);
  webPush.pushToUsers(userIds, n, { from: from ? String(from) : "" });
}

/** The people in `userIds` who haven't switched `pref` off. */
async function wanting(userIds, pref) {
  const ids = [...new Set(userIds.map(String))];
  if (!pref) return ids;
  const off = await User.find({ _id: { $in: ids }, [`notifyPrefs.${pref}`]: false }).select("_id").lean();
  if (!off.length) return ids;
  const skip = new Set(off.map((u) => String(u._id)));
  return ids.filter((id) => !skip.has(id));
}

/** note: { title, body, link, thread, kind, id, url? }; `from`: the person whose action it is (optional);
    `pref`: the Settings › Notifications switch this push belongs to (optional). */
export function pushToUsers(userIds, note, { from, pref } = {}) {
  if (!userIds?.length) return;
  if (!from && !pref) return send(userIds, note);
  // When we can't tell, it isn't sent: a missed push is better than one from a hidden person.
  (async () => {
    if (from && (await isHidden(from))) return;
    const to = await wanting(userIds, pref);
    if (to.length) send(to, note, from);
  })().catch((err) => console.error("PUSH CHECK ERROR:", err?.message || err));
}

/** Announcements: everyone with a registered phone on either platform, and everyone with web push on,
    except people who switched "Announcements from TTFC" off. */
export function pushToEveryone(note) {
  const n = withUrl(note);
  apns.pushToEveryone(n, { pref: "announcements" });
  fcm.pushToEveryone(n, { pref: "announcements" });
  webPush.pushToEveryone(n, { pref: "announcements" });
}

/** Whether a platform's push service is configured right now ("ios" | "android" | "web"). */
export const isConfigured = (platform) => (platform === "android" ? fcm.isConfigured()
  : platform === "web" ? webPush.isConfigured() : apns.isConfigured());
