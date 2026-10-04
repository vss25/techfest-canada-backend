/* Pure helpers for routes/social.js — kept separate so they're unit-testable. */

/** Stable key for a 1:1 thread regardless of who writes first. */
export function threadKey(a, b) {
  const [x, y] = [String(a), String(b)].sort();
  return `${x}:${y}`;
}

const TIER_RANK = { discover: 1, connect: 2, influence: 3, power: 4, apex: 5, vip: 5 };

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

/** Public card for another attendee — never email, never role. */
export function userCard(user) {
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
    avatarUrl: avatarPath(user._id || user.id, user.avatarVersion),
    onApp: isOnApp(user),
  };
}

/** What the app sees for a post. `avatars` maps authorId → avatarVersion.
    The photo itself is fetched from imageUrl, so the feed stays small. */
export function postDTO(post, viewerId, avatars = new Map()) {
  const me = String(viewerId || "");
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
    imageUrl: postImagePath(post),
    authorAvatarUrl: avatarPath(post.authorId, avatars.get(String(post.authorId))),
    likeCount: post.likeCount || 0,
    commentCount: post.commentCount || 0,
    likedByMe: (post.likes || []).some((l) => String(l) === me),
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
