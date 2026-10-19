import { AppContent } from "../models/Admin.js";
import { CONTENT_KEYS } from "./adminHelpers.js";

/* =========================================================
   Polls, Q&A and pass-upgrade switches (admin → App content →
   switches). The apps hide what's off; these routes refuse it
   too, so switching off takes effect at once. Cached for 10 s
   like the kill switch so votes don't each hit the database
   (a change from the admin clears the cache on this server).
   The default is CONTENT_KEYS': polls and Q&A on, upgrades off.
========================================================= */

export const POLLS_KEY = "flag.polls";
export const QA_KEY = "flag.qa";
export const UPGRADES_KEY = "flag.upgrades";

const TTL = 10_000;
const cache = new Map();

/** "true"/"false" strings count too (older rows were saved as text). Pure, exported for tests. */
export function switchValue(raw, def = true) {
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return def;
}

export async function switchOn(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.on;
  let on = switchValue(undefined, CONTENT_KEYS[key] !== false);
  try {
    const doc = await AppContent.findOne({ key }).lean();
    on = switchValue(doc?.value, on);
  } catch {
    if (hit) on = hit.on;   // keep the last known state if Mongo hiccups
  }
  cache.set(key, { on, at: Date.now() });
  return on;
}

/** Drops the cached values (after an admin change, and in tests). */
export function forgetSwitches() { cache.clear(); }

/** Express guard: 403 while the switch is off. */
export const requireSwitch = (key, message) => async (req, res, next) => {
  if (await switchOn(key)) return next();
  res.status(403).json({ error: "closed", message });
};
