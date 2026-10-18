import crypto from "node:crypto";

/* =========================================================
   Feed order: posts with more engagement rise, newer beats
   older, and a small per-person shuffle (stable for the day)
   keeps the feed from looking the same for everyone. Pure.
   - score = (1 + likes + 2·comments + media bonus) / (ageHours + 2)^1.3 × jitter(0.8–1.2)
   - official announcements from the last 48 h are pinned first
   - your own post from the last hour sits right under them
========================================================= */

const HOUR = 3_600_000;

/** Stable 0.8–1.2 multiplier per (post, viewer, UTC day). */
export function jitter(postId, viewerId, now) {
  const day = new Date(now).toISOString().slice(0, 10);
  const h = crypto.createHash("sha1").update(`${postId}|${viewerId}|${day}`).digest();
  return 0.8 + (h.readUInt32BE(0) / 0xffffffff) * 0.4;
}

export function engagementScore(post, now) {
  const ageHours = Math.max(0, (now - new Date(post.createdAt).getTime()) / HOUR);
  const media = (post.media?.length || 0) > 0 || !!post.imageData ? 1 : 0;
  const engagement = 1 + (post.likeCount || 0) + 2 * (post.commentCount || 0) + media;
  return engagement / Math.pow(ageHours + 2, 1.3);
}

export function rankFeed(posts, viewerId, now = Date.now()) {
  const me = String(viewerId || "");
  const tier = (p) => {
    const age = now - new Date(p.createdAt).getTime();
    if (p.kind === "announcement" && age < 48 * HOUR) return 0;
    if (String(p.authorId) === me && age < HOUR) return 1;
    return 2;
  };
  return posts
    .map((p) => ({ p, t: tier(p), s: engagementScore(p, now) * jitter(String(p._id), me, now) }))
    .sort((a, b) => a.t - b.t || (a.t < 2 ? new Date(b.p.createdAt) - new Date(a.p.createdAt) : b.s - a.s))
    .map((x) => x.p);
}
