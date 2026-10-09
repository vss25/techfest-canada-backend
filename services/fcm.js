/* Firebase Cloud Messaging (HTTP v1) — push to the Android app.

   Owner setup (one time):
     1. https://console.firebase.google.com → Add project (e.g. "TTFC").
        Google Analytics is optional; it isn't needed for push.
     2. In the project: Add app → Android. Package name must be exactly
        com.atlaslinkmarkets.ttfc. Download google-services.json for the app
        build (that file is for the app, not the server).
     3. Project settings (gear icon) → Service accounts → Firebase Admin SDK →
        "Generate new private key" → Generate key. A .json file downloads.
     4. Render → the backend service → Environment → add
          FCM_SERVICE_ACCOUNT = the whole contents of that .json file
        (paste the raw JSON, or base64 of it — both work). Save; Render
        redeploys. Never commit this file or paste it anywhere else.

   Until it's set (and parses with project_id, client_email, private_key),
   isConfigured() is false and every send is a no-op: the app keeps polling and
   shows local notifications instead. Sends never throw and never delay the
   request that triggered them. */
import { JWT } from "google-auth-library";
import User from "../models/User.js";

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const MAX_TOKENS_PER_USER = 5;
const CHANNEL_ID = "ttfc_updates";

/** Service-account JSON from env: raw JSON or base64 of it. Null when unusable. */
export function parseServiceAccount(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  let obj = null;
  try {
    obj = JSON.parse(s.startsWith("{") ? s : Buffer.from(s, "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const projectId = String(obj.project_id || "").trim();
  const clientEmail = String(obj.client_email || "").trim();
  const privateKey = String(obj.private_key || "").replace(/\\n/g, "\n").trim();
  if (!projectId || !clientEmail || !privateKey) return null;
  return { projectId, clientEmail, privateKey };
}

let parsed = { raw: null, value: null };
function account() {
  const raw = process.env.FCM_SERVICE_ACCOUNT || "";
  if (parsed.raw !== raw) parsed = { raw, value: parseServiceAccount(raw) };
  return parsed.value;
}

export function isConfigured() {
  return !!account();
}

/** Valid FCM registration token: 20–4096 chars of [A-Za-z0-9:_-]. */
export const cleanFcmToken = (t) => (typeof t === "string" && /^[A-Za-z0-9:_-]{20,4096}$/.test(t.trim()) ? t.trim() : "");

/** The v1 messages:send body for one device. Pure, unit-tested. */
export function buildFcmMessage(token, { title = "", body = "", link = "", thread = "", kind = "", id = "" } = {}) {
  const notification = {};
  if (title) notification.title = String(title).slice(0, 120);
  notification.body = String(body || "").slice(0, 400);
  const androidNote = { channel_id: CHANNEL_ID };
  if (thread) androidNote.tag = String(thread).slice(0, 64);
  return {
    message: {
      token,
      notification,
      android: { priority: "HIGH", notification: androidNote },
      data: { link: String(link || ""), kind: String(kind || ""), id: String(id || "") },
    },
  };
}

/** A user's FCM token list after adding/refreshing one (newest last, capped). Pure. */
export function upsertFcmToken(list = [], token, now = new Date()) {
  const rest = list.filter((t) => t.token !== token);
  return [...rest, { token, updatedAt: now }].slice(-MAX_TOKENS_PER_USER);
}

/** True when FCM says this token will never work again (remove it). Pure. */
export function isDeadToken(status, error = {}) {
  if (status === 404) return true;
  const details = Array.isArray(error?.details) ? error.details : [];
  const codes = details.map((d) => d?.errorCode).filter(Boolean);
  if (codes.includes("UNREGISTERED")) return true;
  if (status === 403 && codes.includes("SENDER_ID_MISMATCH")) return true;
  if (status === 400 && (error?.status === "INVALID_ARGUMENT" || codes.includes("INVALID_ARGUMENT"))) {
    // Only when the token itself is the bad argument, not some other field.
    const aboutToken = details.some((d) => (d?.fieldViolations || []).some((v) => v?.field === "message.token"));
    return aboutToken || /registration token/i.test(String(error?.message || ""));
  }
  return false;
}

let client = null;
let cachedAccess = { value: "", expiresAt: 0 };
async function accessToken() {
  // Google access tokens last an hour; refresh five minutes before expiry.
  if (cachedAccess.value && Date.now() < cachedAccess.expiresAt - 5 * 60 * 1000) return cachedAccess.value;
  const a = account();
  if (!client || client.email !== a.clientEmail || client.key !== a.privateKey) {
    client = new JWT({ email: a.clientEmail, key: a.privateKey, scopes: [SCOPE] });
  }
  const creds = await client.authorize();
  cachedAccess = { value: creds.access_token || "", expiresAt: creds.expiry_date || Date.now() + 30 * 60 * 1000 };
  return cachedAccess.value;
}

async function sendOne(token, note) {
  try {
    const a = account();
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(a.projectId)}/messages:send`, {
      method: "POST",
      headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
      body: JSON.stringify(buildFcmMessage(token, note)),
      signal: AbortSignal.timeout(10000),
    });
    let error = {};
    if (!res.ok) { try { error = (await res.json()).error || {}; } catch { /* non-JSON body */ } }
    return { status: res.status, error };
  } catch (err) {
    return { status: 0, error: { message: err?.name === "TimeoutError" ? "timeout" : "network" } };
  }
}

/** Push one notification to these people (all their Android phones). Fire-and-forget. */
export function pushToUsers(userIds, note) {
  if (!isConfigured() || !userIds?.length) return;
  (async () => {
    const users = await User.find({ _id: { $in: userIds }, banned: { $ne: true } }).select("+fcmTokens").lean();
    for (const u of users) {
      for (const t of u.fcmTokens || []) {
        const r = await sendOne(t.token, note);
        if (isDeadToken(r.status, r.error)) {
          await User.updateOne({ _id: u._id }, { $pull: { fcmTokens: { token: t.token } } });
        } else if (r.status !== 200) {
          console.error("FCM send failed:", r.status, r.error?.status || "", r.error?.message || "");
        }
      }
    }
  })().catch((err) => console.error("FCM error:", err.message));
}

/** Everyone on the Android app with a registered phone (announcements). */
export function pushToEveryone(note) {
  if (!isConfigured()) return;
  (async () => {
    const ids = (await User.find({ "fcmTokens.0": { $exists: true }, banned: { $ne: true } }).select("_id").lean()).map((u) => u._id);
    for (let i = 0; i < ids.length; i += 200) pushToUsers(ids.slice(i, i + 200), note);
  })().catch((err) => console.error("FCM broadcast error:", err.message));
}
