import EmailEngagement from "../models/EmailEngagement.js";
import { engagementKey, engagementUpdate, trackedUpdate } from "./engagement.js";
import { openPixelUrl } from "./trackToken.js";

/* =========================================================
   Writing email engagement (models/EmailEngagement.js). Every
   write is fire and forget: the open pixel, the /attending page's
   events, a LinkedIn post and the RSVP lookup answer exactly as
   they would without it, however slow or broken the database is.
   What is recorded and why: services/engagement.js.
========================================================= */

async function upsert(model, key, update) {
  try {
    await model.updateOne(key, update, { upsert: true });
  } catch (err) {
    // Two at once for a new row: the other one made it, so add to it.
    if (err?.code !== 11000) throw err;
    await model.updateOne(key, update);
  }
}

/**
 * Adds one event ("open", "visit", "post", "share", "manual") to its row, made on first use.
 * `key`: engagementKey() or UNATTRIBUTED_POSTS. Resolves true when written; never throws.
 */
export async function recordEngagement(key, kind, opts = {}, { model = EmailEngagement, log = console } = {}) {
  const update = engagementUpdate(kind, opts);
  if (!key?.campaign || !update) return false;
  try {
    await upsert(model, { campaign: key.campaign, email: key.email || "", ticketId: key.ticketId || "" }, update);
    return true;
  } catch (err) {
    log.error?.("ENGAGEMENT RECORD ERROR:", kind, key.campaign, err?.message || err);
    return false;
  }
}

/** recordEngagement, started after the caller's own work and never waited for. */
export function trackLater(key, kind, opts = {}, deps = {}) {
  if (!key) return;
  Promise.resolve().then(() => recordEngagement(key, kind, opts, deps)).catch(() => {});
}

/** A send that carried the pixel (so "not opened" means something). Fire and forget. */
export function noteTrackedSend(key, { at = new Date(), model = EmailEngagement, log = console } = {}) {
  if (!key?.campaign || (!key.email && !key.ticketId)) return;
  Promise.resolve()
    .then(() => upsert(model, { campaign: key.campaign, email: key.email || "", ticketId: key.ticketId || "" }, trackedUpdate(at)))
    .catch((err) => log.error?.("ENGAGEMENT SEND NOTE ERROR:", key.campaign, err?.message || err));
}

/**
 * The open pixel for a pass email (speakers', issued, exhibitor): only with the RSVP button and no cc
 * (a cc'd copy loading the pixel would count as their open). → { pixel: URL | "", key }
 */
export function passEmailPixel({ campaign, email = "", ticketId = "", cc = [], rsvp = true } = {}) {
  if (!rsvp || cc?.length) return { pixel: "", key: null };
  const key = engagementKey({ c: campaign, e: email, t: ticketId });
  if (!key?.ticketId) return { pixel: "", key: null };
  const pixel = openPixelUrl({ c: key.campaign, e: key.email, t: key.ticketId });
  return pixel ? { pixel, key } : { pixel: "", key: null };
}
