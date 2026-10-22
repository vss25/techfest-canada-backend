import { deliveryMedia } from "./cloudinary.js";
import { publicTier, typesTier } from "./teamRoles.js";
import { personAccess } from "./appRights.js";
import { spotsOf } from "./availability.js";
import { speakerPhotoFor, speakerIdOf } from "./speakerPhotos.js";
/* Pure helpers for routes/social.js — kept separate so they're unit-testable. */

/** Stable key for a 1:1 thread regardless of who writes first. */
export function threadKey(a, b) {
  const [x, y] = [String(a), String(b)].sort();
  return `${x}:${y}`;
}

const TIER_RANK = { discover: 1, connect: 2, influence: 3, power: 4, apex: 5, vip: 5, speaker: 6 };

/** Highest ticket tier key a user holds ("" when none). */
export function bestTierKey(user) {
  const tickets = Array.isArray(user?.tickets) ? user.tickets : [];
  let best = "";
  for (const t of tickets) {
    const k = String(t?.type || "").toLowerCase();
    if ((TIER_RANK[k] || 0) > (TIER_RANK[best] || 0)) best = k;
  }
  return best;
}

export function tierName(key) {
  switch (key) {
    case "discover": return "Discover Pass";
    case "connect": return "Connect Pass";
    case "influence": return "Influence Pass";
    case "power": return "Power Pass";
    case "apex": case "vip": return "Apex Pass";
    case "speaker": return "Speaker Pass"; // the internal Speaker Pass (their own card only)
    default: return "";
  }
}

/** Public URL path of a profile photo ("" when none). */
export function avatarPath(userId, version) {
  return version ? `/api/files/avatar/${userId}?v=${version}` : "";
}

/** A person's avatar URL: their uploaded photo, else (a speaker) their website photo (services/speakerPhotos.js), else "".
    Reads name, avatarVersion and whichever of _id, tickets and email the document has. */
export function avatarFor(user) {
  if (!user) return "";
  return avatarPath(user._id || user.id, user.avatarVersion) || speakerPhotoFor(user);
}

/** Public URL path of a post's photo ("" when none). */
export function postImagePath(post) {
  return post?.imageData ? `/api/files/post/${post._id}` : "";
}

/** Splits a data URL into { contentType, buffer } (null when malformed). */
export function decodeDataUrl(s) {
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/s.exec(String(s || ""));
  if (!m) return null;
  return { contentType: m[1], buffer: Buffer.from(m[2], "base64") };
}

/** Has this person actually signed into the iOS app (not just a website account)? */
export function isOnApp(user) {
  return !!(user?.appOnboarded || user?.lastActiveAt);
}

/** Public card for another attendee — never email, never role, never rights.
    `exhibitors`: exhibitorIndex() from services/teamRoles.js, for the exhibitor type + booth.
    `matrix`: the app rights matrix (services/rightsStore.js; defaults when left out).
    `tier` is only "Speaker" or "Exhibitor" (from their types); `self: true` (their own card) keeps the real pass. */
export function userCard(user, { exhibitors = null, matrix = undefined, self = false } = {}) {
  if (!user) return null;
  // Effective types → public `types`, the Network `kind` (+ booth) and the receive rights.
  const acc = personAccess(user, { exhibitors, matrix });
  const tier = tierName(bestTierKey(user));
  return {
    id: String(user._id || user.id),
    name: user.name || "",
    jobTitle: user.jobTitle || "",
    organization: user.organization || "",
    linkedinUrl: user.linkedinUrl || "",
    country: user.country || "",
    topics: Array.isArray(user.topics) ? user.topics : [],
    tier: self ? tier : typesTier(acc.types),
    tagline: user.tagline || "",
    // When/where they're happy to meet — they chose to share this. Place of a block =
    // availabilitySpots[id] || meetingSpot (services/availability.js).
    availabilitySlots: Array.isArray(user.availabilitySlots) ? user.availabilitySlots : [],
    meetingSpot: user.meetingSpot || "",
    availabilitySpots: spotsOf(user),
    avatarUrl: avatarFor(user),
    onApp: isOnApp(user),
    // Their receive rights (types + staff switches, services/appRights.js). False only hides the
    // Message / Connect buttons; routes correct it per viewer and the server still decides.
    acceptsMessages: acc.rights.receiveMessages,
    acceptsRequests: acc.rights.receiveRequests,
    // "staff" | "volunteer" | "speaker" | "exhibitor" | "vendor" | "" (+ booth for exhibitors). Never "vip" (Oct 21 2026).
    kind: acc.kind,
    booth: acc.booth,
    // Public types only (never attendee), in badge order: types[0] === kind.
    types: acc.publicTypes,
  };
}

/** Fields userCard reads. Every query that builds cards must select these. */
export const CARD_SELECT = "name role jobTitle organization linkedinUrl country topics tickets avatarVersion lastActiveAt appOnboarded tagline availabilitySlots meetingSpot availabilitySpots messagesOff requestsOff types typesOff vip";

/**
 * A 1:1 message as the apps see it: thread items, the send answer and the chat list's lastMessage.
 * Read receipts (Oct 21 2026), only meaningful on the viewer's own messages: `deliveredAt` (the other
 * person's app fetched it) and `readAt` (they opened the chat), Date or null; a read message counts as
 * delivered. Held / hidden messages carry what was stored (nothing for a held one: no ticks, a clock).
 * `masked`: the viewer mustn't be able to tell what happens to their messages (they're hidden from the
 * app, or the other person blocked them): their approved ones read as delivered when sent, never read.
 */
export function messageDTO(m, viewerId, { masked = false } = {}) {
  const sentByMe = String(m.fromUserId) === String(viewerId);
  let deliveredAt = m.deliveredAt || m.readAt || null;
  let readAt = m.readAt || null;
  if (sentByMe && masked) {
    deliveredAt = m.status === "approved" ? m.createdAt || null : null;
    readAt = null;
  }
  return { id: String(m._id), body: m.body, sentByMe, status: m.status, createdAt: m.createdAt, deliveredAt, readAt };
}

/** Fields a person's full profile page shows (GET /api/social/users/:id). */
export const PROFILE_SELECT = `${CARD_SELECT} fieldOfWork jobLevel objectives`;

/** Full public profile: the card plus the other profile answers they gave.
    Never email, phone, role, tickets, gender or salutation. */
export function publicProfile(user, opts = {}) {
  const card = userCard(user, opts);
  if (!card) return null;
  return {
    ...card,
    fieldOfWork: user.fieldOfWork || "",
    jobLevel: user.jobLevel || "",
    objectives: Array.isArray(user.objectives) ? user.objectives : [],
  };
}

/** A comment as the apps see it. `author`: the commenter's account (CARD_SELECT), or null when it's gone.
    `kind`: their person kind now, as on cards and the directory ("staff" | "volunteer" | "speaker" |
    "exhibitor" | "vendor" | ""). `authorTier`: the badge signal older app builds read: "Speaker" or "Exhibitor"
    from their types now (a person type, never a pass name), else what was stored when they commented. */
/** Stored @mentions as the apps get them: [{ type: "user" | "speaker", id, name }]. */
export const mentionList = (list) => (Array.isArray(list) ? list : []).map((m) => ({ type: m.type, id: String(m.id), name: m.name || "" }));

export function commentDTO(c, author = null, ctx = {}) {
  const acc = author ? personAccess(author, ctx) : null;
  const stored = publicTier(c.authorTier);
  return {
    id: String(c._id), postId: String(c.postId), authorId: String(c.authorId),
    authorName: c.authorName,
    // Their photo now (an uploaded one, else a speaker's website photo), like a post's authorAvatarUrl.
    authorAvatarUrl: author ? avatarFor(author) : "",
    // Tapping the name (Oct 22 2026): a website speaker's page when they're one (their Sanity id), else their
    // profile by authorId.
    authorSpeakerId: author ? speakerIdOf(author) : "",
    authorTier: acc ? typesTier(acc.types) : stored,
    kind: acc ? acc.kind : stored === "Speaker" ? "speaker" : stored === "Exhibitor" ? "exhibitor" : "",
    body: c.body, mentions: mentionList(c.mentions), status: c.status, createdAt: c.createdAt,
  };
}

/** What the app sees for a post. `avatars` maps authorId → their avatar URL (routes/social.js avatarUrls), or an
    avatarVersion (a number) for the uploaded photo only.
    The photo itself is fetched from imageUrl, so the feed stays small.
    `staff`: the viewer may delete any post (deleteAnyPost), so canRemove is true on every post. */
const avatarOf = (id, v) => (typeof v === "string" ? v : avatarPath(id, v));

export function postDTO(post, viewerId, avatars = new Map(), { staff = false } = {}) {
  const me = String(viewerId || "");
  // Cloudinary media first; a legacy inline photo shows as a one-item list.
  const media = (post.media || []).map(deliveryMedia);
  if (!media.length && post.imageData) media.push({ type: "image", url: postImagePath(post), posterUrl: "", width: 0, height: 0, duration: 0 });
  return {
    id: String(post._id),
    authorId: String(post.authorId),
    authorName: post.authorName,
    authorTitle: post.authorTitle || "",
    authorOrg: post.authorOrg || "",
    // Stored when posted; older posts may hold any pass name, so filter again.
    authorTier: publicTier(post.authorTier),
    kind: post.kind || "member",
    body: post.body,
    topicTags: post.topicTags || [],
    linkUrl: post.linkUrl || "",
    imageData: "",
    imageUrl: postImagePath(post) || (media.find((m) => m.type === "image")?.url ?? ""),
    media,
    authorAvatarUrl: avatarOf(post.authorId, avatars.get(String(post.authorId))),
    likeCount: post.likeCount || 0,
    commentCount: post.commentCount || 0,
    likedByMe: (post.likes || []).some((l) => String(l) === me),
    mentions: mentionList(post.mentions),
    canRemove: !!me && (String(post.authorId) === me || !!staff),
    status: post.status || "approved",
    createdAt: post.createdAt,
  };
}

/** Tally votes → [{ optionIndex, count }] for options 0..n-1. */
export function tally(votes, optionCount) {
  const counts = Array.from({ length: optionCount }, () => 0);
  for (const v of votes) {
    const i = Number(v.optionIndex);
    if (i >= 0 && i < optionCount) counts[i] += 1;
  }
  return counts;
}

/** Sanitised, size-capped data URL for a post image; "" when invalid. */
export function cleanImageData(s, maxBytes = 350_000) {
  if (typeof s !== "string" || !s.startsWith("data:image/")) return "";
  if (s.length > maxBytes * 1.4) return "";   // base64 overhead
  return s;
}

export function trimBody(s, max) {
  return String(s ?? "").trim().slice(0, max);
}
