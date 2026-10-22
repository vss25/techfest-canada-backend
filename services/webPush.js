/* Web Push (VAPID) — push to the web app (/app on the website): an installed Home Screen app on
   iPhone / iPad (iOS 16.4+), Android and desktop browsers. Oct 21 2026.

   Zero setup for the organiser: the key pair is env VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY when both
   are set (and are a valid pair), else one made with webpush.generateVAPIDKeys() the first time it's
   needed and kept in MongoDB (models/WebPushKey.js), the same on every server, forever. Subject
   mailto:enquire@thetechfestival.com. The private key never leaves this file: no answer carries it
   and nothing logs it (nor a whole endpoint, which works like a password for that browser).

   Subscriptions live on the account (User.webPushSubs, select: false): newest last, at most five,
   and an endpoint belongs to one account only. Sends never throw and never delay the request that
   triggered them; a subscription the push service says is gone (404 / 410) is removed. Callers go
   through services/push.js, so a person hidden from the app pushes nobody here either. */
import webpush from "web-push";
import User from "../models/User.js";
import WebPushKey from "../models/WebPushKey.js";

export const SUBJECT = "mailto:enquire@thetechfestival.com";
export const TTL_SECONDS = 12 * 60 * 60;
const KEY_ID = "vapid";
const MAX_SUBS_PER_USER = 5;
const MAX_ENDPOINT = 1000;
const TIMEOUT_MS = 10_000;
const HIGH = new Set(["dm", "gm"]);   // chats: deliver now, even to a phone that's saving battery

const str = (v) => String(v ?? "");
/** base64url without padding (browsers send that; plain base64 is turned into it). */
const b64u = (v) => (typeof v === "string" ? v.trim().replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : "");
const isB64u = (s) => /^[A-Za-z0-9_-]+$/.test(s);
const decoded = (s) => (isB64u(s) ? Buffer.from(s, "base64url") : Buffer.alloc(0));

/** A VAPID pair that can sign: public = 65-byte uncompressed P-256 point, private = 32 bytes. Pure. */
export function validKeyPair(publicKey, privateKey) {
  const pub = decoded(b64u(publicKey));
  return pub.length === 65 && pub[0] === 4 && decoded(b64u(privateKey)).length === 32;
}

/* ================= KEYS ================= */

let stored = null;     // the database pair, once read on this server
let pending = null;
let warnedEnv = false;

function envKeys() {
  const publicKey = b64u(process.env.VAPID_PUBLIC_KEY), privateKey = b64u(process.env.VAPID_PRIVATE_KEY);
  if (!publicKey || !privateKey) return null;
  if (validKeyPair(publicKey, privateKey)) return { publicKey, privateKey };
  if (!warnedEnv) {
    warnedEnv = true;
    console.error("WEB PUSH: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY aren't a valid key pair; using the stored keys.");
  }
  return null;
}

/** The stored pair, made first when there's none. Race-safe: every server that starts at once upserts
    the same _id with $setOnInsert, so one insert wins and everyone reads that one back. */
export async function bootstrapVapidKeys() {
  const read = () => WebPushKey.findById(KEY_ID).select("+privateKey").lean();
  let doc = await read();
  if (!doc) {
    const fresh = webpush.generateVAPIDKeys();
    try {
      await WebPushKey.updateOne({ _id: KEY_ID },
        { $setOnInsert: { publicKey: fresh.publicKey, privateKey: fresh.privateKey } }, { upsert: true });
    } catch (err) {
      if (err?.code !== 11000) throw err;   // another server inserted it a moment ago: use theirs
    }
    doc = await read();
  }
  if (!doc || !validKeyPair(doc.publicKey, doc.privateKey)) throw new Error("web push keys unavailable");
  return { publicKey: doc.publicKey, privateKey: doc.privateKey };
}

/** { publicKey, privateKey } to sign with: env when set, else the stored pair (read once per server). */
export async function vapidKeys() {
  const env = envKeys();
  if (env) return env;
  if (stored) return stored;
  pending ||= bootstrapVapidKeys().then((k) => { stored = k; return k; }).finally(() => { pending = null; });
  return pending;
}

/** The key the web app subscribes with (GET /api/app/webpush-key). */
export const publicKey = async () => (await vapidKeys()).publicKey;

/** Web push needs no setup, so the server can always push to the web app. */
export const isConfigured = () => true;

/** Tests: forget the pair this server read (as a second server would start). */
export function forgetKeys() {
  stored = null;
  pending = null;
  warnedEnv = false;
}

/* ================= SUBSCRIPTIONS ================= */

/** A push endpoint: an https URL of at most 1000 characters ("" when not). Pure. */
export function cleanEndpoint(v) {
  if (typeof v !== "string") return "";
  const s = v.trim();
  if (!s || s.length > MAX_ENDPOINT) return "";
  try {
    const u = new URL(s);
    return u.protocol === "https:" && u.hostname ? s : "";
  } catch {
    return "";
  }
}

/** PushSubscription.toJSON() → { endpoint, p256dh, auth }, or null when it can't be pushed to. Pure. */
export function cleanSubscription(sub) {
  if (!sub || typeof sub !== "object") return null;
  const endpoint = cleanEndpoint(sub.endpoint);
  const p256dh = b64u(sub.keys?.p256dh), auth = b64u(sub.keys?.auth);
  if (!endpoint) return null;
  const pub = decoded(p256dh);
  if (pub.length !== 65 || pub[0] !== 4 || decoded(auth).length !== 16) return null;
  return { endpoint, p256dh, auth };
}

/** A person's subscriptions after adding / refreshing one (newest last, at most five). Pure. */
export function upsertSub(list = [], sub, { ua = "", now = new Date() } = {}) {
  const rest = (list || []).filter((s) => s?.endpoint !== sub.endpoint);
  return [...rest, { ...sub, ua: str(ua).slice(0, 200), updatedAt: now }].slice(-MAX_SUBS_PER_USER);
}

/** Saves this browser for `userId` (taking the endpoint off any other account first). */
export async function subscribe(userId, sub, { ua = "" } = {}) {
  await User.updateMany({ _id: { $ne: userId }, "webPushSubs.endpoint": sub.endpoint }, { $pull: { webPushSubs: { endpoint: sub.endpoint } } });
  const u = await User.findById(userId).select("+webPushSubs").lean();
  if (!u) return false;
  await User.updateOne({ _id: userId }, { $set: { webPushSubs: upsertSub(u.webPushSubs, sub, { ua }) } });
  return true;
}

/** Stops pushing to this browser for `userId` (sign out, notifications turned off). */
export async function unsubscribe(userId, endpoint) {
  await User.updateOne({ _id: userId }, { $pull: { webPushSubs: { endpoint } } });
}

/* ================= WHAT A PUSH CARRIES ================= */

const TAB_ROUTES = {
  home: "/app/", feed: "/app/", network: "/app/network", schedule: "/app/schedule", venue: "/app/schedule",
  profile: "/app/profile", ticket: "/app/profile/pass", chats: "/app/chats", notifications: "/app/notifications",
};
const seg = (v) => (/^[A-Za-z0-9_-]{1,64}$/.test(str(v)) ? str(v) : "");

/** The web app page a push opens (its router lives under /app/). The service worker may build its own
    from `thread`, `kind` and `from`; this is the default. Pure. */
export function webUrlFor({ link = "", thread = "", kind = "" } = {}) {
  const [, threadKind = "", threadId = ""] = /^(dm|group|disc)\.(.+)$/.exec(str(thread)) || [];
  const id = seg(threadId);
  if (id && threadKind === "dm") return `/app/chat/${id}`;
  if (id && threadKind === "group") return `/app/group/${id}`;
  if (id && threadKind === "disc") return `/app/discussion/${id}`;
  const l = str(link).trim();
  if (/^https:\/\//i.test(l)) return l;
  const m = /^ttfc:\/\/([^/?#]+)\/?([^?#]*)/i.exec(l);
  if (m) {
    const [, host, rest] = m;
    const parts = rest.split("/").filter(Boolean);
    if (host === "post" && seg(parts[0])) return `/app/post/${parts[0]}`;
    if (host === "session" && seg(parts[0])) return `/app/session/${parts[0]}${parts[1] === "live" ? "/live" : ""}`;
    if (host === "tab" && parts[0] === "chats" && seg(parts[1])) return `/app/chats/${parts[1]}`;
    if (host === "tab") return TAB_ROUTES[parts[0] || "home"] || "/app/";
    if (host === "moderation") return "/app/notifications";
  }
  return kind === "personal" || kind === "report" ? "/app/notifications" : "/app/";
}

/** The JSON a push carries: { title, body, link, thread, kind, id, url, from? }. `from` = whose action it
    is (the sender of a chat message). Pure. */
export function buildWebPayload({ title = "", body = "", link = "", thread = "", kind = "", id = "" } = {}, { from = "" } = {}) {
  const out = {
    title: str(title).slice(0, 120),
    body: str(body).slice(0, 400),
    link: str(link), thread: str(thread).slice(0, 64), kind: str(kind), id: str(id),
    url: webUrlFor({ link, thread, kind }),
  };
  const sender = str(from) || (/^dm\.(.+)$/.exec(str(thread)) || [])[1] || "";
  if (sender) out.from = sender;
  return out;
}

/** web-push options for one notification: 12 h to live, chats "high" urgency. Pure. */
export const sendOptions = (note, keys) => ({
  TTL: TTL_SECONDS,
  urgency: HIGH.has(str(note?.kind)) ? "high" : "normal",
  timeout: TIMEOUT_MS,
  vapidDetails: { subject: SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey },
});

/** The push service says this subscription will never work again (remove it). Pure. */
export const isGone = (status) => status === 404 || status === 410;

/* ================= SENDING ================= */

const realSender = (subscription, payload, options) => webpush.sendNotification(subscription, payload, options);
let sender = realSender;
/** Tests: replace the network call; fn(subscription, payload, options) resolves { statusCode } or
    rejects with { statusCode } like web-push. null restores the real one. */
export function useSender(fn) {
  sender = typeof fn === "function" ? fn : realSender;
}

const hostOf = (endpoint) => { try { return new URL(endpoint).host; } catch { return "?"; } };

async function sendOne(sub, payload, options) {
  try {
    const r = await sender({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, options);
    return { status: Number(r?.statusCode) || 201 };
  } catch (err) {
    const status = Number(err?.statusCode) || 0;
    return { status, error: status ? "" : (err?.code || "network") };
  }
}

/** Push one notification to these people (every browser they turned notifications on in). Fire-and-forget:
    never throws; the promise is only there for tests. */
export function pushToUsers(userIds, note, { from = "" } = {}) {
  if (!userIds?.length) return Promise.resolve();
  return (async () => {
    const users = await User.find({ _id: { $in: userIds }, banned: { $ne: true }, "webPushSubs.endpoint": { $exists: true } })
      .select("+webPushSubs").lean();
    if (!users.length) return;
    const keys = await vapidKeys();
    const payload = JSON.stringify(buildWebPayload(note, { from }));
    const options = sendOptions(note, keys);
    for (const u of users) {
      await Promise.all((u.webPushSubs || []).map(async (s) => {
        const r = await sendOne(s, payload, options);
        if (isGone(r.status)) {
          await User.updateOne({ _id: u._id }, { $pull: { webPushSubs: { endpoint: s.endpoint } } });
        } else if (r.status < 200 || r.status > 299) {
          console.error("WEB PUSH send failed:", r.status, hostOf(s.endpoint), r.error || "");
        }
      }));
    }
  })().catch((err) => console.error("WEB PUSH error:", err?.message || err));
}

/** Everyone with web push on (announcements), 200 people at a time. */
export function pushToEveryone(note) {
  return (async () => {
    const ids = (await User.find({ "webPushSubs.endpoint": { $exists: true }, banned: { $ne: true } }).select("_id").lean()).map((u) => u._id);
    for (let i = 0; i < ids.length; i += 200) await pushToUsers(ids.slice(i, i + 200), note);
  })().catch((err) => console.error("WEB PUSH broadcast error:", err?.message || err));
}
