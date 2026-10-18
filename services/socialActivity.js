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

/** Staff inbox rows (AppNotification docs) for one new report, minus the reporter. */
export function buildReportNotifications({ reporterId, reporterName, targetType, reason, reportId, staffIds = [] }) {
  const title = "Content reported";
  const what = TARGET_LABEL[targetType] || String(targetType || "item");
  const why = String(reason ?? "").replace(/\s+/g, " ").trim() || "no reason given";
  const body = `${String(reporterName || "Someone").trim() || "Someone"} reported a ${what}: ${why}`.slice(0, 500);
  const me = String(reporterId ?? "");
  const ids = [...new Set(staffIds.map(String))].filter((id) => id && id !== me);
  return ids.map((userId) => ({
    userId, title, body, link: "ttfc://moderation", kind: "report",
    batchId: reportId ? `report:${reportId}` : "",
    sentBy: me || undefined, sentByName: String(reporterName || ""),
  }));
}

/* ================= POSTS: REMOVE / VIEW ================= */

const isStaff = (u) => u?.role === "admin";

/**
 * Who may take a post down: "author" (deletes it) or "staff" (hides it as
 * removed); null = not allowed. The author path wins for staff's own posts.
 */
export function removeMode(post, user) {
  if (!post || !user) return null;
  if (String(post.authorId) === String(user._id || user.id)) return "author";
  return isStaff(user) ? "staff" : null;
}

/** Can this viewer open one post (GET /social/feed/:id)? */
export function canViewPost(post, user, blocked = new Set()) {
  if (!post || !user) return false;
  const author = String(post.authorId) === String(user._id || user.id);
  if (!author && blocked.has(String(post.authorId))) return false;
  if (author || isStaff(user)) return true;
  return (post.status || "approved") === "approved";
}
