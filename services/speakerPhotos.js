import { fullNameMatches, personNameKey } from "./rsvp.js";
import { splitName } from "./rsvpStaff.js";

/* =========================================================
   Speaker photos as avatars (Oct 22 2026)
   ---------------------------------------------------------
   The organiser: a speaker who signed up and posted showed as
   initials on her post although her photo is on the Speakers page
   (she hadn't uploaded one in the app). Now everywhere the server
   sends a person's avatar (post and comment authors, people cards,
   chat lists, group members, the attendee list, the leaderboard,
   /social/me, /auth/me, /api/profile), someone with no uploaded
   photo who is a speaker gets their website (Sanity) photo, sized
   for avatars. An uploaded photo always wins. Same fields as before
   (avatarUrl, authorAvatarUrl), so apps already installed show it.

   Who is which speaker, the way Speaker Passes link people
   (services/speakerPasses.js, services/people.js): a Speaker Pass
   (Attendee with the Sanity `speakerId`) the account claimed
   (claimedBy) or holds (tickets[].ticketId), or one under the
   account's email (the pass email or an alsoTo address). The names
   must agree too (services/people.js namesMatch rules): staff and
   assistants' emails can be on a speaker's pass, and an account can
   hold several speakers' passes that way, so a link alone never
   gives someone else's face.

   Pure. services/speakerPhotoStore.js loads the speakers, passes and
   accounts every 10 minutes and sets the snapshot read here;
   unit-tested in test/speaker-photos.test.js.
========================================================= */

const str = (v) => String(v ?? "");
const lower = (v) => str(v).trim().toLowerCase();
const PLACEHOLDER = /@ticket\.thetechfestival\.com$/i;

/** The Sanity query: published speakers with their photo, its framing and size. */
export const SPEAKER_PHOTO_QUERY =
  '*[_type=="speaker" && !(_id in path("drafts.**"))]{_id,name,"imageUrl":image.asset->url,"crop":image.crop,"hotspot":image.hotspot,"dims":image.asset->metadata.dimensions}';

export const AVATAR_PX = 256;
const SANITY_IMAGE = /^https:\/\/cdn\.sanity\.io\/images\/[^?#\s]+$/;
const frac = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const fp = (v) => String(Math.round(Number(v) * 1000) / 1000);

/**
 * A speaker document ({ imageUrl, crop, hotspot, dims }) → a square avatar URL on the Sanity CDN
 * ("" without a photo): the framing staff set (crop rect, focal point), WebP by name (as the apps'
 * speaker list asks for it: iOS doesn't send WebP in Accept, so auto=format sent PNGs), 256 px.
 */
export function speakerAvatarUrl(s) {
  const base = str(s?.imageUrl);
  if (!SANITY_IMAGE.test(base)) return "";
  const params = [];
  const W = Number(s?.dims?.width);
  const H = Number(s?.dims?.height);
  const c = s?.crop;
  if (c && W > 0 && H > 0) {
    const w = W * (1 - frac(c.left) - frac(c.right));
    const h = H * (1 - frac(c.top) - frac(c.bottom));
    if (w > 1 && h > 1) params.push(`rect=${Math.floor(frac(c.left) * W)},${Math.floor(frac(c.top) * H)},${Math.floor(w)},${Math.floor(h)}`);
  }
  params.push(`w=${AVATAR_PX}`, `h=${AVATAR_PX}`, "fit=crop", "fm=webp", "q=80");
  const hs = s?.hotspot;
  if (hs && Number.isFinite(Number(hs.x)) && Number.isFinite(Number(hs.y)) && hs.x !== null && hs.y !== null) {
    params.push("crop=focalpoint", `fp-x=${fp(hs.x)}`, `fp-y=${fp(hs.y)}`);
  } else {
    params.push("crop=entropy");   // no focal point set: the CDN picks the busiest region (Sanity has no "faces")
  }
  return `${base}?${params.join("&")}`;
}

/** Do two full names name the same person? (services/people.js namesMatch: accents, honorifics, middle names, nicknames.) */
export function namesAgree(a, b) {
  const ka = personNameKey(a, "");
  const kb = personNameKey(b, "");
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const pa = splitName(a);
  const pb = splitName(b);
  return fullNameMatches(a, pb.firstName, pb.lastName) || fullNameMatches(b, pa.firstName, pa.lastName);
}

const add = (map, key, value) => {
  if (!key) return;
  const list = map.get(key);
  if (list) list.push(value); else map.set(key, [value]);
};

function candidates(user, snap) {
  const out = [...(snap.byClaimer.get(str(user?._id || user?.id)) || [])];
  for (const t of Array.isArray(user?.tickets) ? user.tickets : []) out.push(...(snap.byTicket.get(str(t?.ticketId)) || []));
  const email = lower(user?.email);
  if (email) out.push(...(snap.byEmail.get(email) || []));
  return out;
}

const pick = (user, list) => list.find((c) => c.names.some((n) => namesAgree(user?.name, n)))?.url || "";

const EMPTY = Object.freeze({ at: 0, speakers: 0, byUser: new Map(), byClaimer: new Map(), byTicket: new Map(), byEmail: new Map() });

/**
 * speakers: Sanity docs (SPEAKER_PHOTO_QUERY); passes: Speaker Passes { name, email, alsoTo, ticketId, claimedBy, speakerId };
 * users: the accounts linked to those passes { _id, name, email, tickets } → the snapshot photoFor reads:
 * byUser (account id → photo, worked out now), and byClaimer / byTicket / byEmail (→ [{ url, names }]) for accounts
 * that link later or whose document a route loaded without some of those fields.
 */
export function buildSpeakerPhotos({ speakers = [], passes = [], users = [], now = Date.now() } = {}) {
  const bySpeaker = new Map();
  for (const s of speakers || []) {
    const id = str(s?._id);
    const url = speakerAvatarUrl(s);
    if (!id || id.startsWith("drafts.") || !url || !str(s?.name).trim()) continue;
    bySpeaker.set(id, { url, name: str(s.name) });
  }
  const snap = { at: now, speakers: bySpeaker.size, byUser: new Map(), byClaimer: new Map(), byTicket: new Map(), byEmail: new Map() };
  for (const p of passes || []) {
    const sp = bySpeaker.get(str(p?.speakerId));
    if (!sp) continue;
    const entry = { url: sp.url, names: [sp.name, str(p.name)].filter((n) => n.trim()) };
    add(snap.byClaimer, str(p.claimedBy || ""), entry);
    add(snap.byTicket, str(p.ticketId || ""), entry);
    for (const e of [p.email, ...(Array.isArray(p.alsoTo) ? p.alsoTo : [])]) {
      const email = lower(e);
      if (email && !PLACEHOLDER.test(email)) add(snap.byEmail, email, entry);
    }
  }
  for (const u of users || []) {
    const url = pick(u, candidates(u, snap));
    if (url) snap.byUser.set(str(u._id), url);
  }
  return snap;
}

/** The speaker photo for an account (a User doc with name and whichever of _id, tickets, email the route loaded), or "". */
export function photoFor(user, snap) {
  if (!user || !snap) return "";
  return pick(user, candidates(user, snap)) || snap.byUser.get(str(user._id || user.id)) || "";
}

/* The current snapshot (empty until services/speakerPhotoStore.js has loaded one). */
let current = EMPTY;
export const setSpeakerPhotos = (snap) => { current = snap || EMPTY; };
export const currentSpeakerPhotos = () => current;
/** photoFor with the current snapshot. */
export const speakerPhotoFor = (user, snap = current) => photoFor(user, snap);
