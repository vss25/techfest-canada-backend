import { AppContent } from "../models/Admin.js";

/* =========================================================
   Kill switch — takes the website and the app offline.
   Stored in AppContent under "site.kill"; cached for 10 s so
   every request doesn't hit the database. While it's on, only
   staff routes, sign-in, payments webhooks and /api/status
   keep working, so staff can always switch it back off.
========================================================= */

const KEY = "site.kill";
const TTL = 10_000;
let cache = { enabled: false, message: "", at: 0 };

export const DEFAULT_MESSAGE = "We're making some updates. Please check back soon.";

export async function getKillState() {
  if (Date.now() - cache.at < TTL) return cache;
  try {
    const doc = await AppContent.findOne({ key: KEY }).lean();
    const v = doc?.value && typeof doc.value === "object" ? doc.value : {};
    cache = { enabled: v.enabled === true, message: String(v.message || ""), by: v.by || "", since: v.since || null, at: Date.now() };
  } catch {
    cache = { ...cache, at: Date.now() };   // keep last known state if Mongo hiccups
  }
  return cache;
}

export async function setKillState({ enabled, message, by }) {
  const value = { enabled: !!enabled, message: String(message || "").slice(0, 500), by, since: new Date() };
  await AppContent.findOneAndUpdate({ key: KEY }, { $set: { value, updatedBy: by } }, { upsert: true });
  cache = { ...value, at: Date.now() };
  return cache;
}

/** Paths that must keep working while the site is off. Pure, exported for tests. */
export function allowedWhileOff(path) {
  return /^\/api\/(status|console|cms|admin|webhook|checkin)(\/|$)/.test(path)
    || /^\/api\/auth\/(login|me|refresh)(\/|$)/.test(path);
}

export async function killSwitchMiddleware(req, res, next) {
  if (!req.path.startsWith("/api/") || allowedWhileOff(req.path)) return next();
  const state = await getKillState();
  if (!state.enabled) return next();
  res.status(503).json({ error: "maintenance", message: state.message || DEFAULT_MESSAGE });
}

/** GET /api/status — the website and app ask this on launch. */
export async function statusHandler(req, res) {
  const state = await getKillState();
  res.set("Cache-Control", "no-store");
  res.json({ live: !state.enabled, message: state.enabled ? (state.message || DEFAULT_MESSAGE) : "" });
}
