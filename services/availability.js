/* "Available to meet" (Oct 21 2026): where someone will be for each block they picked.
   Pure, unit-tested in test/availability-spots.test.js.

   availabilitySlots (existing): block ids "d{day}-{HH}", day 1 = Mon Oct 26, day 2 = Tue Oct 27,
   HH 08 10 12 14 16 18 (two hours each, 8 AM–8 PM). meetingSpot (existing): one place for all of them.
   availabilitySpots (new): { [blockId]: place } for the blocks that have their own place. A block
   without an entry uses meetingSpot, so older app versions (which only set meetingSpot) keep working.
   Effective place of a block = availabilitySpots[id] || meetingSpot || "". The apps do the merging
   ("12–8 PM", "All day"); the server only stores and checks. */

export const SPOT_KEY = /^d[12]-(08|10|12|14|16|18)$/;
export const SPOT_MAX = 60;
export const SPOTS_MAX = 12;

const BLOCK_ORDER = ["1", "2"].flatMap((d) => ["08", "10", "12", "14", "16", "18"].map((h) => `d${d}-${h}`));
const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** A place as stored: one line, trimmed, at most 60 characters ("" = none). */
export const cleanPlace = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, SPOT_MAX).trim() : "");

/**
 * The availabilitySpots to store: only block ids (d1-08 … d2-18) that are also in `slots`, places
 * cleaned, empty ones dropped, at most 12, in block order. Anything that isn't an object → {}.
 */
export function cleanSpots(raw, slots = []) {
  const src = raw instanceof Map ? Object.fromEntries(raw) : raw;
  if (!isPlainObject(src)) return {};
  const picked = new Set((Array.isArray(slots) ? slots : []).map(String));
  const out = {};
  for (const id of BLOCK_ORDER) {
    if (Object.keys(out).length >= SPOTS_MAX) break;
    if (!picked.has(id) || !Object.prototype.hasOwnProperty.call(src, id)) continue;
    const place = cleanPlace(src[id]);
    if (place) out[id] = place;
  }
  return out;
}

/** A person's availabilitySpots for any answer (cards, directory, profile, console): always an object. */
export const spotsOf = (user) => cleanSpots(user?.availabilitySpots, user?.availabilitySlots);

/**
 * The availabilitySpots part of a profile save: { availabilitySpots } or {} when nothing to change.
 * `body`: what was sent; `user`: the account before the save; `slots`: the new availabilitySlots when the
 * same save changes them (else undefined). Spots for blocks that are no longer picked are dropped, also
 * when only availabilitySlots was sent (an older app unpicking a block). A non-object availabilitySpots
 * is ignored; null clears them.
 */
export function spotsPatch(body = {}, user = {}, slots = undefined) {
  const sent = body?.availabilitySpots;
  const usable = sent === null || isPlainObject(sent) || sent instanceof Map;
  if (!usable && slots === undefined) return {};
  const source = usable ? sent : user?.availabilitySpots;
  return { availabilitySpots: cleanSpots(source, slots !== undefined ? slots : user?.availabilitySlots) };
}
