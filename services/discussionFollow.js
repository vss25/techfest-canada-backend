/* Following a community discussion: who follows, who gets told about a new
   reply (a personal activity row → the dot on Discussions, plus a push),
   and the in-memory push throttle. No Mongoose here so it's unit-testable;
   routes/community.js keeps the DB calls.

   Rules
   - The author follows their own discussion from the start.
   - Posting a reply makes the replier a follower, unless they unfollowed
     that discussion before (`unfollowed`): auto-follow never re-adds people
     who opted out. Following again by hand takes them off `unfollowed`.
   - Discussions from before following existed have no `followers` list:
     their author counts as the one follower (unless they unfollowed), and
     the list is written out the first time anyone follows or replies. */
import { contactFirstName } from "./contactSwitches.js";

export const MAX_FANOUT = 500;                    // activity rows / pushes per reply
export const PUSH_GAP_MS = 10 * 60 * 1000;        // ≤1 push per follower per discussion per 10 min
export const SNIPPET_MAX = 140;
export const DISCUSSIONS_LINK = "ttfc://tab/chats/discussions";

const str = (v) => String(v ?? "");
const hasId = (list, id) => Array.isArray(list) && list.some((x) => str(x) === str(id));

/** Followers of a discussion as id strings (see the legacy rule above). */
export function followerIds(d) {
  if (!d) return [];
  if (Array.isArray(d.followers)) return [...new Set(d.followers.map(str).filter(Boolean))];
  const author = str(d.authorId);
  return author && !hasId(d.unfollowed, author) ? [author] : [];
}

/** What a legacy discussion's `followers` list should be written out as. */
export const legacyFollowers = (d) => followerIds({ authorId: d?.authorId, unfollowed: d?.unfollowed });

export const isFollowing = (d, viewerId) => !!viewerId && followerIds(d).includes(str(viewerId));
/** How many follow it; `shadow` (people hidden from the app, services/appHide.js) aren't counted for this viewer. */
export const followerCount = (d, shadow = null) => followerIds(d).filter((id) => !shadow?.has(id)).length;

/** Should posting a reply make this person a follower? (No if already following or opted out.) */
export function shouldAutoFollow(d, userId) {
  if (!d || !userId) return false;
  return !isFollowing(d, userId) && !hasId(d.unfollowed, userId);
}

/** Mongo update for POST /follow: follow clears the opt-out, unfollow records it. Idempotent. */
export function followUpdate(userId, follow) {
  return follow
    ? { $addToSet: { followers: userId }, $pull: { unfollowed: userId } }
    : { $pull: { followers: userId }, $addToSet: { unfollowed: userId } };
}

/** `{ follow }` from the request body → true / false, or null when it's neither. */
export function parseFollow(v) {
  if (v === true || v === 1 || v === "true" || v === "1") return true;
  if (v === false || v === 0 || v === "false" || v === "0") return false;
  return null;
}

/** `?following=1` (also true / yes). */
export const wantsFollowing = (v) => ["1", "true", "yes"].includes(str(v).trim().toLowerCase());

/** Mongo filter for "discussions this person follows" (legacy rule included). */
export function followingFilter(userId) {
  return {
    $or: [
      { followers: userId },
      { followers: { $exists: false }, authorId: userId, unfollowed: { $ne: userId } },
    ],
  };
}

/** Same visibility as GET /discussions: approved, or your own; never from someone blocked either way. */
export function canSeeDiscussion(d, viewerId, blocked = new Set()) {
  if (!d || !viewerId) return false;
  const author = str(d.authorId);
  if (blocked.has(author)) return false;
  return d.status === "approved" || author === str(viewerId);
}

/**
 * Who hears about a new reply: every follower except the replier, minus
 * anyone blocked either way, each once, at most `max` (earliest followers
 * first, so the author stays in). → { to, total, capped }
 */
export function fanOutRecipients({ followers = [], actorId, blocked = new Set(), max = MAX_FANOUT }) {
  const actor = str(actorId);
  const seen = new Set();
  const all = [];
  for (const f of followers) {
    const id = str(f);
    if (!id || id === actor || blocked.has(id) || seen.has(id)) continue;
    seen.add(id);
    all.push(id);
  }
  return { to: all.slice(0, max), total: all.length, capped: all.length > max };
}

/** One line of the reply for the push body. */
export function replySnippet(body, max = SNIPPET_MAX) {
  const s = str(body).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** The push followers get for a new reply. */
export function replyPush({ discussionId, title, actorName, body }) {
  const who = contactFirstName({ name: actorName }) || "Someone";
  return {
    title: str(title).trim() || "Discussion",
    body: `${who}: ${replySnippet(body)}`,
    link: DISCUSSIONS_LINK,
    kind: "disc",
    thread: `disc.${str(discussionId)}`,
    id: str(discussionId),
  };
}

/**
 * In-memory throttle: take(discussionId, userIds) returns the ids that may
 * get a push now and remembers them, so one busy thread pushes each follower
 * at most once per `gapMs`. Entries are kept in time order and dropped once
 * expired; `maxEntries` bounds memory if a lot happens at once.
 */
export function createPushThrottle({ gapMs = PUSH_GAP_MS, maxEntries = 100000 } = {}) {
  const last = new Map();   // "discussionId:userId" → ms, oldest first
  const prune = (now) => {
    for (const [k, at] of last) {
      if (now - at < gapMs && last.size <= maxEntries) break;
      last.delete(k);
    }
  };
  return {
    take(discussionId, userIds = [], now = Date.now()) {
      prune(now);
      const out = [];
      for (const u of userIds) {
        const id = str(u);
        if (!id) continue;
        const key = `${str(discussionId)}:${id}`;
        const at = last.get(key);
        if (at !== undefined && now - at < gapMs) continue;
        last.delete(key);
        last.set(key, now);
        out.push(id);
      }
      return out;
    },
    get size() { return last.size; },
  };
}

/** What the app gets for one discussion (list, create, staff queue). Never the follower list itself.
    `shadow` / `hiddenReplies`: people hidden from the app and their approved replies here, left out of this viewer's counts. */
export function discussionDTO(d, viewer, { shadow = null, hiddenReplies = 0 } = {}) {
  return {
    id: str(d._id), title: d.title, body: d.body, tags: d.tags || [],
    authorId: str(d.authorId), authorName: d.authorName, replyCount: Math.max(0, (d.replyCount || 0) - hiddenReplies),
    status: d.status, mine: str(d.authorId) === str(viewer), createdAt: d.createdAt,
    following: isFollowing(d, viewer), followerCount: followerCount(d, shadow),
  };
}
