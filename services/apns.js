/* Apple Push Notification service (token-based auth, HTTP/2).

   Configure on the server (all four, from the Apple Developer portal →
   Keys → "Apple Push Notifications service"):
     APNS_KEY        contents of the AuthKey_XXXX.p8 file (newlines may be "\n")
     APNS_KEY_ID     the key's 10-character ID
     APNS_TEAM_ID    the team ID (Membership page)
     APNS_BUNDLE_ID  com.atlaslinkmarkets.ttfc (default)

   Until they're set, isConfigured() is false and every send is a no-op: the
   apps keep polling and show local notifications instead. Sends never throw
   and never delay the request that triggered them. */
import http2 from "node:http2";
import jwt from "jsonwebtoken";
import User from "../models/User.js";

const HOSTS = { production: "https://api.push.apple.com", sandbox: "https://api.sandbox.push.apple.com" };
const MAX_TOKENS_PER_USER = 5;

const env = () => ({
  key: String(process.env.APNS_KEY || "").replace(/\\n/g, "\n").trim(),
  keyId: String(process.env.APNS_KEY_ID || "").trim(),
  teamId: String(process.env.APNS_TEAM_ID || "").trim(),
  bundleId: String(process.env.APNS_BUNDLE_ID || "com.atlaslinkmarkets.ttfc").trim(),
});

export function isConfigured() {
  const e = env();
  return !!(e.key && e.keyId && e.teamId && e.bundleId);
}

/** Valid device token: 64+ hex chars. */
export const cleanToken = (t) => (typeof t === "string" && /^[a-f0-9]{64,200}$/i.test(t.trim()) ? t.trim().toLowerCase() : "");
export const cleanEnv = (v) => (v === "sandbox" ? "sandbox" : "production");

/** The aps payload for one notification. Pure, unit-tested. */
export function buildPayload({ title = "", body = "", link = "", thread = "", kind = "", id = "" } = {}) {
  const alert = {};
  if (title) alert.title = String(title).slice(0, 120);
  alert.body = String(body || "").slice(0, 400);
  const aps = { alert, sound: "default" };
  if (thread) aps["thread-id"] = String(thread).slice(0, 64);
  return { aps, link: String(link || ""), kind: String(kind || ""), id: String(id || "") };
}

/** A user's token list after adding/refreshing one (newest last, capped). Pure. */
export function upsertToken(list = [], token, envName, now = new Date()) {
  const rest = list.filter((t) => t.token !== token);
  return [...rest, { token, env: cleanEnv(envName), updatedAt: now }].slice(-MAX_TOKENS_PER_USER);
}

let cachedJwt = { value: "", at: 0 };
function providerToken() {
  // Apple accepts a provider token for up to an hour; refresh well before.
  if (cachedJwt.value && Date.now() - cachedJwt.at < 40 * 60 * 1000) return cachedJwt.value;
  const e = env();
  const value = jwt.sign({ iss: e.teamId, iat: Math.floor(Date.now() / 1000) }, e.key,
    { algorithm: "ES256", header: { alg: "ES256", kid: e.keyId }, noTimestamp: true });
  cachedJwt = { value, at: Date.now() };
  return value;
}

const sessions = {};
function session(envName) {
  const s = sessions[envName];
  if (s && !s.closed && !s.destroyed) return s;
  const fresh = http2.connect(HOSTS[envName]);
  fresh.on("error", () => { delete sessions[envName]; });
  fresh.setTimeout(5 * 60 * 1000, () => { fresh.close(); delete sessions[envName]; });
  sessions[envName] = fresh;
  return fresh;
}

function sendOne({ token, env: envName }, payload) {
  return new Promise((resolve) => {
    try {
      const req = session(cleanEnv(envName)).request({
        ":method": "POST", ":path": `/3/device/${token}`,
        authorization: `bearer ${providerToken()}`,
        "apns-topic": env().bundleId, "apns-push-type": "alert", "apns-priority": "10",
      });
      let status = 0, data = "";
      req.setEncoding("utf8");
      req.on("response", (h) => { status = h[":status"]; });
      req.on("data", (c) => { data += c; });
      req.on("end", () => resolve({ status, reason: (() => { try { return JSON.parse(data).reason || ""; } catch { return ""; } })() }));
      req.on("error", () => resolve({ status: 0, reason: "network" }));
      req.setTimeout(10000, () => { req.close(); resolve({ status: 0, reason: "timeout" }); });
      req.end(JSON.stringify(payload));
    } catch {
      resolve({ status: 0, reason: "error" });
    }
  });
}

const DEAD = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);

/** Push one notification to these people (all their phones). Fire-and-forget. */
export function pushToUsers(userIds, note) {
  if (!isConfigured() || !userIds?.length) return;
  (async () => {
    const users = await User.find({ _id: { $in: userIds }, banned: { $ne: true } }).select("+apnsTokens").lean();
    const payload = buildPayload(note);
    for (const u of users) {
      for (const t of u.apnsTokens || []) {
        const r = await sendOne(t, payload);
        if (r.status === 410 || (r.status === 400 && DEAD.has(r.reason))) {
          await User.updateOne({ _id: u._id }, { $pull: { apnsTokens: { token: t.token } } });
        } else if (r.status !== 200) {
          console.error("APNS send failed:", r.status, r.reason);
        }
      }
    }
  })().catch((err) => console.error("APNS error:", err.message));
}

/** Everyone on the app with a registered phone (announcements). */
export function pushToEveryone(note) {
  if (!isConfigured()) return;
  (async () => {
    const ids = (await User.find({ "apnsTokens.0": { $exists: true }, banned: { $ne: true } }).select("_id").lean()).map((u) => u._id);
    for (let i = 0; i < ids.length; i += 200) pushToUsers(ids.slice(i, i + 200), note);
  })().catch((err) => console.error("APNS broadcast error:", err.message));
}
