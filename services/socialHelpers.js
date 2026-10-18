import { deliveryMedia } from "./cloudinary.js";
import { kindFields } from "./teamRoles.js";
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
    case "speaker": return "Speaker Pass";
    default: return "";
  }
}

/** Public URL path of a profile photo ("" when none). */
export function avatarPath(userId, version) {
  return version ? `/api/files/avatar/${userId}?v=${version}` : "";
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

/** Public card for another attendee — never email, never role.
    `exhibitors`: exhibitorIndex() from services/teamRoles.js, for kind "exhibitor" + booth. */
export function userCard(user, { exhibitors = null } = {}) {
  if (!user) return null;
  return {
    id: String(user._id || user.id),
    name: user.name || "",
    jobTitle: user.jobTitle || "",
    organization: user.organization || "",
    linkedinUrl: user.linkedinUrl || "",
    country: user.country || "",
    topics: Array.isArray(user.topics) ? user.topics : [],
    tier: tierName(bestTierKey(user)),
    tagline: user.tagline || "",
    // When/where they're happy to meet — they chose to share this.
    availabilitySlots: Array.isArray(user.availabilitySlots) ? user.availabilitySlots : [],
    meetingSpot: user.meetingSpot || "",
    avatarUrl: avatarPath(user._id || user.id, user.avatarVersion),
    onApp: isOnApp(user),
    // Staff contact switches (services/contactSwitches.js). False only hides the
    // Message / Connect buttons; the server still decides (e.g. replies are allowed).
    acceptsMessages: !user.messagesOff,
    acceptsRequests: !user.requestsOff,
    // Network sections: "staff" | "volunteer" | "speaker" | "exhibitor" | "" (+ booth for exhibitors).
    ...kindFields(user, exhibitors),
  };
}

/** Fields userCard reads. Every query that builds cards must select these. */
export const CARD_SELECT = "name role jobTitle organization linkedinUrl country topics tickets avatarVersion lastActiveAt appOnboarded tagline availabilitySlots meetingSpot messagesOff requestsOff";

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

/** What the app sees for a post. `avatars` maps authorId → avatarVersion.
    The photo itself is fetched from imageUrl, so the feed stays small.
    `staff`: the viewer is staff, so canRemove is true on every post. */
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
    authorTier: post.authorTier || "",
    kind: post.kind || "member",
    body: post.body,
    topicTags: post.topicTags || [],
    linkUrl: post.linkUrl || "",
    imageData: "",
    imageUrl: postImagePath(post) || (media.find((m) => m.type === "image")?.url ?? ""),
    media,
    authorAvatarUrl: avatarPath(post.authorId, avatars.get(String(post.authorId))),
    likeCount: post.likeCount || 0,
    commentCount: post.commentCount || 0,
    likedByMe: (post.likes || []).some((l) => String(l) === me),
    mentions: (post.mentions || []).map((m) => ({ type: m.type, id: String(m.id), name: m.name || "" })),
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
