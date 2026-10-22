import Attendee from "../models/Attendee.js";
import User from "../models/User.js";
import { SANITY_PROJECT } from "./rsvp.js";
import { SPEAKER_PHOTO_QUERY, buildSpeakerPhotos, currentSpeakerPhotos, setSpeakerPhotos } from "./speakerPhotos.js";

/* =========================================================
   Loads the speaker photo snapshot (services/speakerPhotos.js):
   the website's speakers (Sanity CDN), their Speaker Passes and
   the accounts linked to them. Started from server.js: once on
   start, then every 10 minutes; a failed load keeps the last copy
   and tries again after a minute. Routes only read the snapshot,
   so no request ever waits on Sanity.
========================================================= */

export const SPEAKER_PHOTOS_URL =
  `https://${SANITY_PROJECT}.apicdn.sanity.io/v2021-10-21/data/query/production?query=${encodeURIComponent(SPEAKER_PHOTO_QUERY)}`;
export const REFRESH_MS = 10 * 60 * 1000;
const RETRY_MS = 60 * 1000;

const lower = (v) => String(v ?? "").trim().toLowerCase();
const PLACEHOLDER = /@ticket\.thetechfestival\.com$/i;

/** Reads everything and builds a snapshot (doesn't set it). Throws when the speaker list can't be read. */
export async function loadSpeakerPhotos({ fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl(SPEAKER_PHOTOS_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Speaker list unavailable (HTTP ${res.status})`);
  const json = await res.json();
  const speakers = Array.isArray(json?.result) ? json.result : [];
  // Every published speaker (their speaker page from the app), with or without a photo.
  const ids = speakers.filter((s) => s?._id && !String(s._id).startsWith("drafts.")).map((s) => String(s._id));
  const passes = ids.length
    ? await Attendee.find({ speakerId: { $in: ids } }).select("name email alsoTo ticketId claimedBy speakerId").lean()
    : [];
  const claimers = passes.map((p) => p.claimedBy).filter(Boolean);
  const ticketIds = passes.map((p) => p.ticketId).filter(Boolean);
  const emails = [...new Set(passes.flatMap((p) => [p.email, ...(Array.isArray(p.alsoTo) ? p.alsoTo : [])]).map(lower))]
    .filter((e) => e && !PLACEHOLDER.test(e));
  const users = passes.length
    ? await User.find({ $or: [{ _id: { $in: claimers } }, { "tickets.ticketId": { $in: ticketIds } }, { email: { $in: emails } }] })
      .select("name email tickets.ticketId").lean()
    : [];
  return buildSpeakerPhotos({ speakers, passes, users });
}

/** Loads and sets a new snapshot; on failure keeps the current one. → the snapshot in use. */
export async function refreshSpeakerPhotos(opts = {}) {
  try {
    setSpeakerPhotos(await loadSpeakerPhotos(opts));
  } catch (err) {
    console.error("SPEAKER PHOTOS (kept the last copy):", err?.message || err);
    throw err;
  }
  return currentSpeakerPhotos();
}

let timer = null;
/** server.js, once connected: load now, then every 10 minutes (a minute after a failure). */
export function startSpeakerPhotos(opts = {}) {
  if (timer) return;
  const run = async () => {
    let next = REFRESH_MS;
    try { await refreshSpeakerPhotos(opts); } catch { next = RETRY_MS; }
    timer = setTimeout(run, next);
    timer.unref?.();
  };
  timer = setTimeout(run, 0);
  timer.unref?.();
}
