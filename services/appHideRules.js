/* Pure parts of "Hide from app" (shadow mode): who a viewer doesn't see and
   how counts look without hidden people. No Mongoose here so it's all
   unit-testable; services/appHide.js keeps the cache and the database calls
   (and re-exports these). See there for what hiding does. */

export const EMPTY = Object.freeze(new Set());
const str = (v) => String(v ?? "");
const lower = (v) => str(v).trim().toLowerCase();
export const PLACEHOLDER = /@ticket\.thetechfestival\.com$/i;

export const REASON_MAX = 500;
/** Selects the flag (it's select: false on User and Attendee). */
export const HIDE_SELECT = "+appHidden";

/** Staff accounts and moderators see hidden people and everything they do. */
export const seesHidden = (user, rights) => user?.role === "admin" || !!rights?.moderate;

/** A private note for staff: one line, trimmed, at most REASON_MAX. */
export const cleanReason = (s) => str(s).replace(/\s+/g, " ").trim().slice(0, REASON_MAX);

/** The flag on a record ({ at, by, byName, reason }), or null when it isn't hidden. */
export function hideFlag(doc) {
  const h = doc?.appHidden;
  if (!h?.at) return null;
  const at = new Date(h.at);
  if (Number.isNaN(at.getTime())) return null;
  return { at, by: h.by ? str(h.by) : "", byName: str(h.byName), reason: str(h.reason) };
}

/** One person's hide from their account and passes: the earliest flag (when it started), or null. */
export function personHide({ user = null, attendees = [] } = {}) {
  const flags = [hideFlag(user), ...(attendees || []).map(hideFlag)].filter(Boolean);
  if (!flags.length) return null;
  return flags.sort((a, b) => a.at - b.at)[0];
}

/**
 * Who this viewer doesn't see. `state`: hiddenState(). Staff and moderators see everyone (empty sets);
 * anyone else misses every hidden person except themself. → { self, ids, emails, passes }:
 * self = the viewer is hidden; ids = hidden account ids; emails / passes = hidden people's addresses and
 * pass rows (for the directory's guest entries, which would have been merged into them).
 */
export function shadowFor(state, { viewerId = "", viewerEmail = "", staff = false } = {}) {
  const me = str(viewerId);
  const self = !!me && !!state?.ids?.has(me);
  if (staff || (!state?.ids?.size && !state?.passes?.size)) return { self, ids: EMPTY, emails: EMPTY, passes: EMPTY };
  const ids = new Set(state.ids);
  ids.delete(me);
  const emails = new Set(state.emails || []);
  emails.delete(lower(viewerEmail));
  return { self, ids, emails, passes: state.passes || EMPTY };
}

/** Blocks (either way) plus the hidden people this viewer doesn't see: for every read of other people's things. */
export const unseenOf = (blocked = EMPTY, shadow = EMPTY) => (shadow.size ? new Set([...blocked, ...shadow]) : blocked);

/** `ids` without anyone in `shadow` (ids or ObjectIds in, strings compared). */
export const visible = (ids, shadow = EMPTY) => (shadow.size ? (ids || []).filter((x) => !shadow.has(str(x))) : (ids || []));

/** How many of `ids` are in `shadow`. */
export const hiddenAmong = (ids, shadow = EMPTY) => (shadow.size ? (ids || []).filter((x) => shadow.has(str(x))).length : 0);

/** A guest pass (Attendee, not on the app) of a hidden person: flagged itself, or under a hidden person's email. */
export const isHiddenGuest = (g, shadow) => !!g && (shadow.passes.has(str(g._id)) || (!!g.email && shadow.emails.has(lower(g.email))));

/**
 * A post as this viewer should count it: likes, the like count and the comment count without the hidden
 * people's (`hiddenComments`: postId → their approved comments on it), and no mention chips for them.
 * Returns the same object when nothing changes.
 */
export function postForViewer(post, shadow = EMPTY, hiddenComments = new Map()) {
  if (!post || !shadow.size) return post;
  const likesOut = hiddenAmong(post.likes, shadow);
  const commentsOut = hiddenComments.get(str(post._id)) || 0;
  const mentions = post.mentions || [];
  const mentionsKept = mentions.filter((m) => !(m?.type === "user" && shadow.has(str(m.id))));
  if (!likesOut && !commentsOut && mentionsKept.length === mentions.length) return post;
  return {
    ...post,
    likes: visible(post.likes, shadow),
    likeCount: Math.max(0, (post.likeCount || 0) - likesOut),
    commentCount: Math.max(0, (post.commentCount || 0) - commentsOut),
    mentions: mentionsKept,
  };
}

/** Rows like [{ _id, n }] → Map(id string → n). */
export const countMap = (rows) => new Map((rows || []).map((r) => [str(r._id), Number(r.n) || 0]));
