import User from "../models/User.js";
import { pushToUsers } from "./push.js";
import { allowed } from "./pushThrottle.js";
import { cleanMentions, keepKnownMentions, mentionedUserIds } from "./socialActivity.js";
import { replyPush } from "./discussionFollow.js";

/* =========================================================
   Activity pushes (Oct 22 2026). The organiser: "nicole just
   posted, and i commented, send her a notif for it", and stay
   within the free tiers (APNs, FCM, Web Push are free; we keep the
   number of pushes low and useful):
     • a comment on your post → you ("<Name> commented on your post")
     • a reply to your comment in a discussion → you ("<Name> replied to your comment")
     • an @mention of you in a post, comment, discussion, reply or group message → you ("<Name> mentioned you")
     • likes on your post: at most one push per post per hour, "Nicole and 3 others liked your post";
       none for posts older than 7 days
     • group and session chats, discussion replies to followers: at most one push per person per chat /
       discussion per 10 minutes ("5 new messages in …"), except to someone the message @mentions
   DMs and connection requests stay immediate (routes/social.js). Never to yourself, never between
   people who blocked each other (the routes pass `blocked`, both ways) or to someone hidden from your view
   (`shadow`); a hidden person's pushes reach nobody (services/push.js `from`); each respects the person's
   switch (services/notifyPrefs.js). Throttles live in MongoDB (services/pushThrottle.js), so several servers
   agree. Note builders are pure and exported for tests; the senders never throw.
========================================================= */

export const SNIPPET = 120;
export const LIKE_GAP_MS = 60 * 60_000;
export const LIKE_MAX_AGE_MS = 7 * 24 * 3_600_000;
export const CHAT_GAP_MS = 10 * 60_000;

const str = (v) => String(v ?? "");
const name = (n) => str(n).replace(/\s+/g, " ").trim() || "Someone";
/** One line, at most `max` characters (an ellipsis when cut). */
export const snippet = (s, max = SNIPPET) => {
  const one = str(s).replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};
const others = (n) => (n === 1 ? "1 other" : `${n} others`);

/* ---------- notes (pure) ---------- */

export const commentNote = ({ actorName, postId, body }) => ({
  title: `${name(actorName)} commented on your post`, body: snippet(body),
  link: `ttfc://post/${postId}`, thread: `post.${postId}`, kind: "comment", id: str(postId),
});

export const replyNote = ({ actorName, discussionId, body }) => ({
  title: `${name(actorName)} replied to your comment`, body: snippet(body),
  link: "ttfc://tab/chats/discussions", thread: `disc.${discussionId}`, kind: "reply", id: str(discussionId),
});

/** `where`: "post" | "comment" (refId = the post), "discussion" | "reply" (the discussion), "group" (the group). */
export function mentionNote({ actorName, where, refId, body, groupName = "" }) {
  const thread = where === "group" ? `group.${refId}` : where === "discussion" || where === "reply" ? `disc.${refId}` : `post.${refId}`;
  const link = where === "group" ? "ttfc://tab/network" : where === "discussion" || where === "reply" ? "ttfc://tab/chats/discussions" : `ttfc://post/${refId}`;
  return {
    title: `${name(actorName)} mentioned you`,
    body: where === "group" && groupName ? snippet(`in ${groupName}: ${str(body)}`) : snippet(body),
    link, thread, kind: "mention", id: str(refId),
  };
}

/** `missed`: likes held back since the last like push about this post. */
export const likeNote = ({ actorName, postId, missed = 0 }) => ({
  title: "Likes on your post",
  body: `${name(actorName)}${missed > 0 ? ` and ${others(missed)}` : ""} liked your post`,
  link: `ttfc://post/${postId}`, thread: `post.${postId}`, kind: "like", id: str(postId),
});

/** `count`: the messages this push covers (the new one and those held back since their last push). */
export function groupNote({ groupId, groupName, actorName, body, count = 1, messageId = "" }) {
  const g = str(groupName).trim() || "Group chat";
  return {
    title: g,
    body: count > 1 ? `${count} new messages in ${g}` : `${name(actorName)}: ${snippet(body, 400)}`,
    link: "ttfc://tab/network", thread: `group.${groupId}`, kind: "gm", id: str(messageId || groupId),
  };
}

/** A followed discussion's push (services/discussionFollow.js replyPush), or "<count> new replies" when it covers several. */
export function discussionNote({ discussionId, title, actorName, body, count = 1 }) {
  const note = replyPush({ discussionId, title, actorName, body });
  return count > 1 ? { ...note, body: `${count} new replies in “${snippet(title, 80) || "the discussion"}”` } : note;
}

/* ---------- who (pure) ---------- */

/** `ids` as strings, without the actor, anyone blocked either way or hidden from the actor, and repeats. */
export function recipientsOf(ids, { actorId, blocked = new Set(), shadow = new Set() } = {}) {
  const me = str(actorId);
  const out = [];
  for (const raw of ids || []) {
    const id = str(raw);
    if (!id || id === me || blocked.has(id) || shadow.has(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/* ---------- mentions ---------- */

/** Request `mentions` → the ones to store: well-formed, ≤10, user ids that are real accounts (names filled in). */
export async function resolveMentions(raw) {
  const mentions = cleanMentions(raw);
  const ids = mentionedUserIds(mentions);
  if (!ids.length) return mentions;
  const known = await User.find({ _id: { $in: ids } }).select("name").lean();
  return keepKnownMentions(mentions, new Map(known.map((u) => [String(u._id), u.name])));
}

/* ---------- senders (never throw) ---------- */

const safely = (label, fn) => Promise.resolve().then(fn).catch((err) => console.error(`${label} PUSH ERROR:`, err?.message || err));
const fromOf = (actor) => ({ from: actor?._id });

/** @mentions: everyone in `mentions` (user ones) who may hear from the actor. → the ids pushed. */
export function notifyMentions({ actor, mentions = [], where, refId, body, groupName = "", blocked, shadow, only = null }) {
  let to = recipientsOf(mentionedUserIds(mentions), { actorId: actor?._id, blocked, shadow });
  if (only) to = to.filter((id) => only.has(id));
  if (to.length) pushToUsers(to, mentionNote({ actorName: actor?.name, where, refId, body, groupName }), { ...fromOf(actor), pref: "mentions" });
  return to;
}

/** A comment on a post: its author (not when it's the commenter, they're blocked, or the comment mentions them). */
export function notifyComment({ post, actor, body, blocked, mentioned = [] }) {
  const [author] = recipientsOf([post?.authorId], { actorId: actor?._id, blocked });
  if (!author || mentioned.includes(author)) return;
  pushToUsers([author], commentNote({ actorName: actor?.name, postId: post._id, body }), { ...fromOf(actor), pref: "comments" });
}

/** Someone's first-ever like on a post (the route tells): the author, at most once an hour per post. */
export function notifyLike({ post, actor, blocked, now = new Date() }) {
  return safely("LIKE", async () => {
    const [author] = recipientsOf([post?.authorId], { actorId: actor?._id, blocked });
    if (!author || !post?.createdAt || now - new Date(post.createdAt) > LIKE_MAX_AGE_MS) return;
    const [slot] = await allowed(`like:${post._id}`, [author], LIKE_GAP_MS, { now });
    if (slot) pushToUsers([author], likeNote({ actorName: actor?.name, postId: post._id, missed: slot.missed }), { ...fromOf(actor), pref: "likes" });
  });
}

/** Group pushes: per person counts, one pushToUsers per distinct count. */
function pushCounted(slots, build, opts) {
  const byCount = new Map();
  for (const s of slots) {
    const n = s.missed + 1;
    if (!byCount.has(n)) byCount.set(n, []);
    byCount.get(n).push(s.userId);
  }
  for (const [count, ids] of byCount) pushToUsers(ids, build(count), opts);
}

/**
 * A group (or session) chat message to `to` (the route's recipients: members minus the author and blocks). People it
 * @mentions get "<Name> mentioned you" now; the rest at most one push per 10 minutes each ("5 new messages in …").
 */
export function notifyGroupMessage({ group, actor, message, to = [], mentions = [], blocked, shadow, now = new Date() }) {
  return safely("GROUP", async () => {
    const members = new Set(to.map(String));
    const mentioned = notifyMentions({ actor, mentions, where: "group", refId: group._id, body: message.body, groupName: group.name, blocked, shadow, only: members });
    const rest = [...members].filter((id) => !mentioned.includes(id));
    if (!rest.length) return;
    const slots = await allowed(`group:${group._id}`, rest, CHAT_GAP_MS, { now });
    pushCounted(slots, (count) => groupNote({ groupId: group._id, groupName: group.name, actorName: actor?.name, body: message.body, count, messageId: message._id }),
      { ...fromOf(actor), pref: "groups" });
  });
}

/**
 * A discussion reply. The person whose reply this answers (`parentAuthorId`) hears "<Name> replied to your comment" now,
 * people it @mentions "<Name> mentioned you" now; the other followers (`followers`, already without the actor and
 * blocks) at most one push per 10 minutes each.
 */
export function notifyDiscussionReply({ discussion, actor, body, followers = [], parentAuthorId = null, mentions = [], blocked, shadow, now = new Date() }) {
  return safely("DISCUSSION", async () => {
    const mentioned = notifyMentions({ actor, mentions, where: "reply", refId: discussion._id, body, blocked, shadow });
    const [parent] = recipientsOf([parentAuthorId], { actorId: actor?._id, blocked, shadow });
    if (parent && !mentioned.includes(parent)) {
      pushToUsers([parent], replyNote({ actorName: actor?.name, discussionId: discussion._id, body }), { ...fromOf(actor), pref: "comments" });
    }
    const rest = followers.map(String).filter((id) => id !== parent && !mentioned.includes(id));
    if (!rest.length) return;
    const slots = await allowed(`disc:${discussion._id}`, rest, CHAT_GAP_MS, { now });
    pushCounted(slots, (count) => discussionNote({ discussionId: discussion._id, title: discussion.title, actorName: actor?.name, body, count }),
      { ...fromOf(actor), pref: "comments" });
  });
}

