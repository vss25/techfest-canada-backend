/* Pure helpers for the social layer's newer parts: @mentions on posts,
   personal activity (the dot on the Feed / Discussions tabs), staff
   notifications for reports, and who may remove or see a post.
   No Mongoose here so it's all unit-testable; routes keep the DB calls. */

export const MAX_MENTIONS = 10;
export const MENTION_NAME_MAX = 80;
export const ACTIVITY_SECTIONS = ["feed", "discussions"];
export const ACTIVITY_KINDS = ["like", "comment", "mention", "reply"];

const OBJECT_ID = /^[a-f0-9]{24}$/i;
// Sanity document ids: letters, digits, dot, dash, underscore.
const CMS_ID = /^[A-Za-z0-9._-]{1,128}$/;

export const isObjectId = (s) => OBJECT_ID.test(String(s ?? ""));

/**
 * POST /social/feed `mentions` → [{ type, id, name }].
 * type "user" needs a 24-hex id (the route then drops ids that aren't real
 * users), "speaker" a CMS id. Names are one line, trimmed, ≤80. Duplicates
 * (same type + id) and anything malformed are dropped; at most ten kept.
 */
export function cleanMentions(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    const type = m.type === "user" || m.type === "speaker" ? m.type : null;
    const id = typeof m.id === "string" ? m.id.trim() : "";
    if (!type || !(type === "user" ? OBJECT_ID.test(id) : CMS_ID.test(id))) continue;
    const name = typeof m.name === "string" ? m.name.replace(/\s+/g, " ").trim().slice(0, MENTION_NAME_MAX).trim() : "";
    const key = `${type}:${type === "user" ? id.toLowerCase() : id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type, id: type === "user" ? id.toLowerCase() : id, name });
    if (out.length === MAX_MENTIONS) break;
  }
  return out;
}

/** The 24-hex user ids among cleaned mentions (to look up in one query). */
export const mentionedUserIds = (mentions) => mentions.filter((m) => m.type === "user").map((m) => m.id);

/**
 * Keeps user mentions whose id is in `users` (Map id → name of real accounts),
 * filling a blank name from the account. Speaker mentions need a name.
 */
export function keepKnownMentions(mentions, users = new Map()) {
  const out = [];
  for (const m of mentions) {
    if (m.type === "user") {
      if (!users.has(m.id)) continue;
      out.push({ ...m, name: m.name || String(users.get(m.id) || "").slice(0, MENTION_NAME_MAX) });
    } else if (m.name) {
      out.push(m);
    }
  }
  return out;
}

/**
 * Activity rows for one action: one per recipient, never the actor themself,
 * never someone the actor blocked or who blocked the actor (`blocked` is the
 * actor's two-way set, as routes get it in req.blocked), never twice.
 */
export function buildActivity({ kind, section, actorId, actorName, refId, recipients = [], blocked = new Set() }) {
  if (!ACTIVITY_KINDS.includes(kind) || !ACTIVITY_SECTIONS.includes(section) || !actorId || !refId) return [];
  const actor = String(actorId);
  const out = [];
  const seen = new Set();
  for (const r of recipients) {
    const to = String(r ?? "");
    if (!to || to === actor || blocked.has(to) || seen.has(to)) continue;
    seen.add(to);
    out.push({ userId: to, actorId: actor, actorName: String(actorName || ""), kind, section, refId: String(refId) });
  }
  return out;
}

/**
 * Like / unlike toggle on a post. A like only counts as "first" (and earns
 * the author an activity row) the first time this person ever likes the
 * post: unlikes are remembered in `everLiked` so an unlike + relike is quiet.
 * → { liked, firstLike, likes, everLiked } (new arrays, inputs untouched)
 */
export function toggleLike({ likes = [], everLiked = [], actorId }) {
  const me = String(actorId);
  const has = (list) => list.some((x) => String(x) === me);
  const wasLiked = has(likes);
  const before = has(everLiked);
  const nextLikes = wasLiked ? likes.filter((x) => String(x) !== me) : [...likes, actorId];
  // Remembered on unlike too, so likes from before everLiked existed stay quiet on a relike.
  const nextEver = before ? [...everLiked] : [...everLiked, actorId];
  return { liked: !wasLiked, firstLike: !wasLiked && !before, likes: nextLikes, everLiked: nextEver };
}

/** When this person last opened a section's activity (epoch when never). */
export function seenAt(activitySeen, section) {
  const d = activitySeen?.[section] ? new Date(activitySeen[section]) : null;
  return d && !Number.isNaN(d.getTime()) ? d : new Date(0);
}

/**
 * Mongo filter for a person's unread activity in one section: newer than
 * their seen time, from nobody they now block or are blocked by.
 */
export function unreadFilter(userId, section, activitySeen, blocked = new Set()) {
  const f = { userId: String(userId), section, createdAt: { $gt: seenAt(activitySeen, section) } };
  if (blocked.size) f.actorId = { $nin: [...blocked] };
  return f;
}

/** Same rule in memory: { feed, discussions } counts from activity rows. */
export function countUnread(events, activitySeen, blocked = new Set()) {
  const out = { feed: 0, discussions: 0 };
  for (const e of events || []) {
    if (!ACTIVITY_SECTIONS.includes(e.section) || blocked.has(String(e.actorId))) continue;
    if (new Date(e.createdAt) > seenAt(activitySeen, e.section)) out[e.section] += 1;
  }
  return out;
}

/** `?section=` for activity endpoints; null when it isn't one we know. */
export function parseSection(s) {
  const v = String(s ?? "").trim().toLowerCase();
  return ACTIVITY_SECTIONS.includes(v) ? v : null;
}

/** What the app gets for one activity row. */
export function activityDTO(e) {
  return {
    id: String(e._id || e.id || ""),
    kind: e.kind,
    actorId: String(e.actorId),
    actorName: e.actorName || "",
    refId: String(e.refId),
    createdAt: e.createdAt,
  };
}

/* ================= REPORTS → STAFF ================= */

const TARGET_LABEL = { groupMessage: "group message" };

/** Where the alert opens: a reported post opens that post (staff can remove it there); anything else the moderation queue. */
export function reportLink(targetType, targetId) {
  const id = String(targetId ?? "").trim();
  return targetType === "post" && /^[a-f0-9]{24}$/i.test(id) ? `ttfc://post/${id}` : "ttfc://moderation";
}

/** Moderator inbox rows (AppNotification docs) for one new report, minus the reporter.
    `staffIds`: everyone with the moderate right (routes/appApi.js). */
export function buildReportNotifications({ reporterId, reporterName, targetType, targetId, reason, reportId, staffIds = [] }) {
  const title = "Content reported";
  const what = TARGET_LABEL[targetType] || String(targetType || "item");
  const why = String(reason ?? "").replace(/\s+/g, " ").trim() || "no reason given";
  const body = `${String(reporterName || "Someone").trim() || "Someone"} reported a ${what}: ${why}`.slice(0, 500);
  const me = String(reporterId ?? "");
  const ids = [...new Set(staffIds.map(String))].filter((id) => id && id !== me);
  return ids.map((userId) => ({
    userId, title, body, link: reportLink(targetType, targetId), kind: "report",
    batchId: reportId ? `report:${reportId}` : "",
    sentBy: me || undefined, sentByName: String(reporterName || ""),
  }));
}

/* ================= POSTS: REMOVE / VIEW =================
   `rights` is the viewer's effectiveRights() (services/appRights.js); left
   out, only staff accounts (role admin) count, as before rights existed. */

const isStaff = (u) => u?.role === "admin";
const hasRight = (user, rights, right) => (rights ? !!rights[right] : isStaff(user));

/**
 * Who may take a post down: "author" (deletes it) or "staff" (hides it as
 * removed; needs deleteAnyPost); null = not allowed. The author path wins for
 * a staff member's own posts.
 */
export function removeMode(post, user, rights = null) {
  if (!post || !user) return null;
  if (String(post.authorId) === String(user._id || user.id)) return "author";
  return hasRight(user, rights, "deleteAnyPost") ? "staff" : null;
}

/** Can this viewer open one post (GET /social/feed/:id)? Held / hidden ones: the author and moderators. */
export function canViewPost(post, user, blocked = new Set(), rights = null) {
  if (!post || !user) return false;
  const author = String(post.authorId) === String(user._id || user.id);
  if (!author && blocked.has(String(post.authorId))) return false;
  if (author || hasRight(user, rights, "moderate")) return true;
  return (post.status || "approved") === "approved";
}

/**
 * Can this viewer like or comment on a post? Exactly when they can see it (canViewPost: every post their feed
 * shows, their own held ones, and anything a moderator opens), unless staff took it down (status "hidden").
 * One rule for the feed, the post page, likes and comments (Oct 22 2026), so a post someone can see never
 * answers "not found" when they react to it. `unseen`: blocks + the hidden people they don't see.
 */
export function canInteractPost(post, user, unseen = new Set(), rights = null) {
  return !!post && post.status !== "hidden" && canViewPost(post, user, unseen, rights);
}

/** What like / comment answer (404) for a post that's gone, taken down, or not visible to them. */
export const POST_GONE = "This post isn't available any more.";

/** How long a repeat of the same post counts as a retry (POST /social/feed). */
export const REPEAT_POST_MS = 2 * 60_000;

/**
 * Is `next` ({ body, linkUrl, imageData, media }) the same post as `prev` sent again? A retry after the answer was
 * lost (venue Wi-Fi, a slow photo upload) used to post a second copy; deleting one of the two then left "not found"
 * on screens that still showed it. Same text and link, and the same number of photos and videos (a retry uploads
 * them again under new names); a photo-only post must carry the very same photos.
 */
export function isRepeatPost(prev, next) {
  if (!prev || !next) return false;
  const body = String(next.body || "");
  if (String(prev.body || "") !== body || String(prev.linkUrl || "") !== String(next.linkUrl || "")) return false;
  const items = (p) => (p.media || []).length + (p.imageData ? 1 : 0);
  if (items(prev) !== items(next)) return false;
  if (body.trim()) return true;
  const keys = (p) => [(p.imageData || ""), ...(p.media || []).map((m) => m.publicId || m.url || "")].join("|");
  return keys(prev) === keys(next);
}
