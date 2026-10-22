import express from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { Discussion, DiscussionReply, CommunityGroup, GroupMessage } from "../models/Community.js";
import { moderateText, isConfigured as moderationConfigured } from "../services/deepcleer.js";
import { trimBody, CARD_SELECT } from "../services/socialHelpers.js";
import { cardsFor } from "../services/cards.js";
import { Block } from "../models/Admin.js";
import { recordActivity } from "../models/ActivityEvent.js";
import { buildActivity, isObjectId } from "../services/socialActivity.js";
import {
  discussionDTO, followerIds, legacyFollowers, shouldAutoFollow, followUpdate, parseFollow, wantsFollowing,
  followingFilter, canSeeDiscussion, isFollowing, followerCount, fanOutRecipients, MAX_FANOUT,
} from "../services/discussionFollow.js";
import { isScope, markTyping, stopTyping, whoIsTyping } from "../services/typing.js";
import { personAccess, rightError } from "../services/appRights.js";
import { rightsContext, RIGHTS_SELECT } from "../services/rightsStore.js";
import { viewerHide, isHidden, hiddenReplyCounts, visible, unseenOf } from "../services/appHide.js";
import { SessionRegistration } from "../models/Social.js";
import { membershipUpdate } from "../services/sessionGroups.js";
import { avatarUrls, authorAvatar } from "../services/avatars.js";
import { avatarFor, mentionList } from "../services/socialHelpers.js";
import { notifyDiscussionReply, notifyGroupMessage, notifyMentions, resolveMentions } from "../services/notify.js";
import { mentionedUserIds } from "../services/socialActivity.js";
import GroupSeen from "../models/GroupSeen.js";

/* =========================================================
   /api/community — discussions (threaded replies) and groups
   (membership + group chat) for the iOS app. User JWT required.
   New discussions and groups are `pending` until a moderator approves
   them (POST /admin/:type/:id/status); replies and group messages
   are moderated like the rest of the social layer. Starting a
   discussion, replying and creating a group need the startDiscussions,
   comment and createGroups rights (services/appRights.js).
========================================================= */

const router = express.Router();

async function requireUser(req, res, next) {
  try {
    const h = req.headers.authorization;
    if (!h) return res.status(401).json({ error: "Unauthorized" });
    const decoded = jwt.verify(h.split(" ")[1], process.env.JWT_SECRET);
    // + avatarVersion and email: their own avatar on what they post (avatarFor), as routes/social.js has them.
    const user = await User.findById(decoded.id).select(`${RIGHTS_SELECT} avatarVersion email`);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (user.banned) return res.status(403).json({ error: "This account is suspended. Contact enquire@thetechfestival.com." });
    req.user = user;
    const rows = await Block.find({ $or: [{ userId: user._id }, { blockedId: user._id }] }).lean();
    req.blocked = new Set(rows.map((r) => String(String(r.userId) === String(user._id) ? r.blockedId : r.userId)));
    req.ctx = await rightsContext();
    req.rights = personAccess(user, req.ctx).rights;
    // Hide from app (services/appHide.js), as in routes/social.js: req.appHidden = they're hidden (what they do reaches
    // nobody); req.shadow = hidden people they don't see (none for moderators); req.unseen = blocks + shadow.
    let hide;
    try { hide = await viewerHide(user, req.rights); } catch (err) {
      console.error("APP HIDE ERROR:", err?.message || err);
      return res.status(503).json({ error: "Something went wrong. Try again." });
    }
    req.appHidden = hide.self;
    req.shadow = hide.ids;
    req.unseen = unseenOf(req.blocked, hide.ids);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}
router.use(requireUser);

const me = (req) => String(req.user._id);
/** A hidden person's things answer like things that aren't there. */
const isShadowed = (req, userId) => !!userId && req.shadow.has(String(userId));
/** Someone else hidden from the app (the author of a discussion or the owner of a group a moderator writes in)? */
const isHiddenAuthor = async (userId, viewerId) => String(userId) !== String(viewerId) && isHidden(userId);
/** Discussion cards for this viewer: replies and followers from hidden people don't count. */
async function discussionsFor(req, list) {
  const [replies, avatars] = await Promise.all([hiddenReplyCounts(list, req.shadow), avatarUrls(list.map((d) => d.authorId))]);
  return list.map((d) => discussionDTO(d, me(req), {
    shadow: req.shadow, hiddenReplies: replies.get(String(d._id)) || 0, authorAvatarUrl: authorAvatar(avatars, d.authorId),
  }));
}
/** Moderators (the moderate right; staff accounts always) approve, see pending items and any group's chat. */
const isModerator = (req) => !!req.rights.moderate;
/** 403 with a readable line unless the signed-in person has `right`. */
const needRight = (right) => (req, res, next) => (req.rights[right] ? next() : res.status(403).json({ error: rightError(right, req.ctx.flags) }));

async function statusFor(text, userId, context, fallback = "approved") {
  if (!moderationConfigured()) return fallback;
  try {
    const v = await moderateText({ text, userId, context });
    return v.flagged ? "held" : fallback;
  } catch {
    return fallback;
  }
}

/** Activity rows (the dot on Discussions) and pushes for the people a discussion or reply @mentions. → ids pushed. */
function mentionActivity(req, mentions, discussionId, body, where) {
  const ids = mentionedUserIds(mentions).filter((id) => !req.shadow.has(id));
  recordActivity(buildActivity({ kind: "mention", section: "discussions", actorId: req.user._id, actorName: req.user.name,
    refId: discussionId, recipients: ids, blocked: req.blocked }));
  return notifyMentions({ actor: req.user, mentions, where, refId: discussionId, body, blocked: req.blocked, shadow: req.shadow });
}

/* ================= DISCUSSIONS ================= */

/* Following (rules in services/discussionFollow.js): the author follows on
   create, a replier on their first reply unless they unfollowed before.
   Each approved reply gives every other follower an activity row (the dot on
   Discussions) and a push, at most one push per follower per thread per 10 min
   (kept in MongoDB since Oct 22 2026, services/notify.js, so every server agrees);
   the person it answers and the people it @mentions hear at once. */

/* Threads from before following existed have no list yet: write it out
   (their author, unless they opted out) before the first $addToSet/$pull. */
async function ensureFollowerList(d) {
  if (Array.isArray(d.followers)) return;
  await Discussion.updateOne({ _id: d._id, followers: { $exists: false } }, { $set: { followers: legacyFollowers(d) } });
}

router.get("/discussions", async (req, res) => {
  const filter = { $or: [{ status: "approved" }, { authorId: req.user._id }] };
  if (wantsFollowing(req.query.following)) filter.$and = [followingFilter(req.user._id)];
  const list = await Discussion.find(filter).sort({ createdAt: -1 }).limit(100).lean();
  res.json(await discussionsFor(req, list.filter((d) => !req.unseen.has(String(d.authorId)))));
});

router.post("/discussions", needRight("startDiscussions"), async (req, res) => {
  const title = trimBody(req.body?.title, 200);
  const body = trimBody(req.body?.body, 4000);
  if (title.length < 4 || !body) return res.status(400).json({ error: "title and body required" });
  const flagged = (await statusFor(`${title}\n${body}`, req.user._id, "discussion", "pending")) === "held";
  const mentions = await resolveMentions(req.body?.mentions);
  const d = await Discussion.create({
    authorId: req.user._id, authorName: req.user.name, title, body,
    tags: Array.isArray(req.body?.tags) ? req.body.tags.filter((t) => typeof t === "string").slice(0, 6) : [],
    status: flagged ? "held" : (isModerator(req) ? "approved" : "pending"),
    followers: [req.user._id],
    ...(mentions.length ? { mentions } : {}),
  });
  // @mentions are heard about once it's visible (a moderator's thread is approved at once; others wait for review).
  if (d.status === "approved" && !req.appHidden) mentionActivity(req, mentions, d._id, `${title}: ${body}`, "discussion");
  res.status(201).json(discussionDTO(d, me(req), { authorAvatarUrl: avatarFor(req.user) }));
});

/* Follow / unfollow: { follow: true|false } → { ok, following, followerCount }.
   Idempotent. Same visibility as the list (404 otherwise). Unfollowing is
   remembered so replying again doesn't re-follow; following clears that. */
router.post("/discussions/:id/follow", async (req, res) => {
  const follow = parseFollow(req.body?.follow);
  if (follow === null) return res.status(400).json({ error: "follow must be true or false" });
  if (!isObjectId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const d = await Discussion.findById(req.params.id).select("authorId status followers unfollowed").lean();
  if (!canSeeDiscussion(d, me(req), req.unseen)) return res.status(404).json({ error: "Not found" });
  await ensureFollowerList(d);
  const after = await Discussion.findByIdAndUpdate(d._id, followUpdate(req.user._id, follow),
    { returnDocument: "after", projection: { authorId: 1, followers: 1, unfollowed: 1 } }).lean();
  if (!after) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true, following: isFollowing(after, me(req)), followerCount: followerCount(after, req.shadow) });
});

router.get("/discussions/:id/replies", async (req, res) => {
  // A hidden person's discussion has no replies for anyone else (it isn't in their list either).
  if (req.shadow.size && isObjectId(req.params.id)) {
    const d = await Discussion.findById(req.params.id).select("authorId").lean();
    if (d && isShadowed(req, d.authorId)) return res.json([]);
  }
  const replies = await DiscussionReply.find({
    discussionId: req.params.id,
    $or: [{ status: "approved" }, { authorId: req.user._id }],
  }).sort({ createdAt: 1 }).lean();
  const shown = replies.filter((r) => !req.unseen.has(String(r.authorId)));
  const avatars = await avatarUrls(shown.map((r) => r.authorId));
  res.json(shown.map((r) => ({
    id: String(r._id), discussionId: String(r.discussionId), parentId: r.parentId ? String(r.parentId) : null,
    authorId: String(r.authorId), authorName: r.authorName, authorAvatarUrl: authorAvatar(avatars, r.authorId), mentions: mentionList(r.mentions), body: r.body, status: r.status,
    mine: String(r.authorId) === me(req), createdAt: r.createdAt,
  })));
});

router.post("/discussions/:id/replies", needRight("comment"), async (req, res) => {
  const body = trimBody(req.body?.body, 2000);
  if (!body) return res.status(400).json({ error: "body required" });
  const d = await Discussion.findById(req.params.id);
  if (!d || d.status !== "approved" || isShadowed(req, d.authorId)) return res.status(404).json({ error: "Not found" });
  let parentId = null;
  let parentAuthorId = null;
  if (req.body?.parentId) {
    const parent = isObjectId(req.body.parentId) ? await DiscussionReply.findOne({ _id: req.body.parentId, discussionId: d._id }) : null;
    if (!parent) return res.status(400).json({ error: "parent reply not found" });
    parentId = parent._id;
    parentAuthorId = parent.status === "approved" ? parent.authorId : null;
  }
  const status = await statusFor(body, req.user._id, "discussion-reply");
  const mentions = await resolveMentions(req.body?.mentions);
  const r = await DiscussionReply.create({
    discussionId: d._id, parentId, authorId: req.user._id, authorName: req.user.name, body, status,
    ...(mentions.length ? { mentions } : {}),
  });
  // Replying follows the thread (held replies too: it's still their conversation), unless they opted out.
  if (shouldAutoFollow(d, me(req))) {
    await ensureFollowerList(d);
    await Discussion.updateOne({ _id: d._id, unfollowed: { $ne: req.user._id } }, { $addToSet: { followers: req.user._id } });
  }
  let replyCount = d.replyCount || 0;
  if (status === "approved") {
    const fresh = await Discussion.findByIdAndUpdate(d._id, { $inc: { replyCount: 1 } },
      { returnDocument: "after", projection: { title: 1, authorId: 1, replyCount: 1, followers: 1, unfollowed: 1 } }).lean();
    replyCount = fresh?.replyCount ?? replyCount + 1;
    // Every other follower sees a dot on Discussions and gets a (throttled) push. A hidden person's reply tells
    // nobody; in a hidden person's discussion (a moderator replying) only its author can see it, so only they hear.
    if (!req.appHidden) {
      const authorHidden = await isHiddenAuthor(d.authorId, me(req));
      const followers = followerIds(fresh || d).filter((id) => !authorHidden || id === String(d.authorId));
      const { to, total, capped } = fanOutRecipients({ followers, actorId: me(req), blocked: req.blocked });
      if (capped) console.warn(`DISCUSSION FAN-OUT CAPPED: ${d._id} has ${total} followers to tell, told the first ${MAX_FANOUT}`);
      recordActivity(buildActivity({ kind: "reply", section: "discussions", actorId: req.user._id, actorName: req.user.name,
        refId: d._id, recipients: to, blocked: req.blocked }));
      // In a hidden person's discussion only its author hears, so no mention pushes there.
      const said = authorHidden ? [] : mentions;
      if (said.length) {
        recordActivity(buildActivity({ kind: "mention", section: "discussions", actorId: req.user._id, actorName: req.user.name,
          refId: d._id, recipients: mentionedUserIds(said).filter((id) => !req.shadow.has(id) && !to.includes(id)), blocked: req.blocked }));
      }
      notifyDiscussionReply({
        discussion: { _id: d._id, title: fresh?.title || d.title }, actor: req.user, body, followers: to, mentions: said,
        parentAuthorId: !authorHidden || String(parentAuthorId) === String(d.authorId) ? parentAuthorId : null,
        blocked: req.blocked, shadow: req.shadow,
      });
    }
    replyCount -= (await hiddenReplyCounts([d], req.shadow)).get(String(d._id)) || 0;
  }
  res.status(201).json({
    id: String(r._id), discussionId: String(d._id), parentId: parentId ? String(parentId) : null,
    authorId: me(req), authorName: r.authorName, authorAvatarUrl: avatarFor(req.user), mentions: mentionList(r.mentions), body: r.body, status: r.status, mine: true,
    createdAt: r.createdAt, replyCount: Math.max(0, replyCount),
  });
});

/* ================= GROUPS ================= */

/** `shadow`: hidden people, who don't count as members for this viewer. `sessionId`: the agenda session a session
    chat belongs to (services/sessionGroups.js), null for people's groups; `system`: made by the server. */
const groupDTO = (g, viewer, shadow) => ({
  id: String(g._id), name: g.name, description: g.description, tags: g.tags || [],
  ownerId: String(g.ownerId), ownerName: g.ownerName, memberCount: visible(g.members, shadow).length,
  joined: (g.members || []).some((m) => String(m) === viewer),
  status: g.status, createdAt: g.createdAt,
  sessionId: g.sessionId || null, system: g.system === true,
});

const isSessionGroup = (g) => typeof g?.sessionId === "string" && !!g.sessionId;
/** The session ids (either kind) this person registered for. */
const myRegistrations = async (req) => (await SessionRegistration.find({ userId: req.user._id }).select("sessionId").lean()).map((r) => r.sessionId);

/* People's groups as before (approved ones, and my own), plus the session chats I can see: the ones I'm in or
   registered for (moderators: all). A session chat isn't listed for everyone, so the list isn't fifty sessions. */
router.get("/groups", async (req, res) => {
  const regs = await myRegistrations(req);
  const sessionFilter = isModerator(req) ? { sessionId: { $type: "string" } }
    : { sessionId: { $type: "string" }, $or: [{ members: req.user._id }, { sessionId: { $in: regs } }, { sessionDocId: { $in: regs } }] };
  const [list, sessions] = await Promise.all([
    CommunityGroup.find({ sessionId: { $not: { $type: "string" } }, $or: [{ status: "approved" }, { ownerId: req.user._id }] })
      .sort({ createdAt: -1 }).limit(100).lean(),
    CommunityGroup.find({ ...sessionFilter, status: "approved" }).sort({ sessionStartsAt: 1 }).limit(200).lean(),
  ]);
  // A group a hidden person started isn't there for anyone else.
  res.json([...list, ...sessions].filter((g) => !isShadowed(req, g.ownerId)).map((g) => groupDTO(g, me(req), req.shadow)).sort((a, b) => b.memberCount - a.memberCount));
});

/* The chat of one agenda session (either of its ids) → the group, or 404 when it has none yet (it opens 30 min
   before the session) or this person can't see it (not in it, not registered, not a moderator). */
router.get("/groups/session/:sessionId", async (req, res) => {
  const id = String(req.params.sessionId || "").slice(0, 80);
  const g = id ? await CommunityGroup.findOne({ $or: [{ sessionId: id }, { sessionDocId: id }], system: true, status: "approved" }).lean() : null;
  if (!g) return res.status(404).json({ error: "Not found" });
  const member = (g.members || []).some((m) => String(m) === me(req));
  if (!member && !isModerator(req)) {
    const regs = await myRegistrations(req);
    if (!regs.includes(g.sessionId) && !(g.sessionDocId && regs.includes(g.sessionDocId))) return res.status(404).json({ error: "Not found" });
  }
  res.json(groupDTO(g, me(req), req.shadow));
});

router.post("/groups", needRight("createGroups"), async (req, res) => {
  const name = trimBody(req.body?.name, 80);
  const description = trimBody(req.body?.description, 500);
  if (name.length < 3) return res.status(400).json({ error: "name required" });
  const flagged = (await statusFor(`${name}\n${description}`, req.user._id, "group", "pending")) === "held";
  const g = await CommunityGroup.create({
    name, description, ownerId: req.user._id, ownerName: req.user.name, members: [req.user._id],
    tags: Array.isArray(req.body?.tags) ? req.body.tags.filter((t) => typeof t === "string").slice(0, 6) : [],
    status: flagged ? "held" : (isModerator(req) ? "approved" : "pending"),
  });
  res.status(201).json(groupDTO(g, me(req)));
});

router.post("/groups/:id/join", async (req, res) => {
  const g = await CommunityGroup.findById(req.params.id);
  if (!g || g.status !== "approved" || isShadowed(req, g.ownerId)) return res.status(404).json({ error: "Not found" });
  if (isSessionGroup(g)) {
    // A session chat: leaving is remembered (the job doesn't add them back); joining needs a registration for the
    // session (or the moderate right). One atomic update, so the job topping it up at the same moment can't undo it.
    const member = g.members.some((m) => String(m) === me(req));
    if (!member && !isModerator(req)) {
      const regs = await myRegistrations(req);
      if (!regs.includes(g.sessionId) && !(g.sessionDocId && regs.includes(g.sessionDocId))) {
        return res.status(403).json({ error: "Save this session to your agenda to join its chat." });
      }
    }
    const after = await CommunityGroup.findByIdAndUpdate(g._id, membershipUpdate(req.user._id, !member), { returnDocument: "after" }).lean();
    return res.json(groupDTO(after || g, me(req), req.shadow));
  }
  const i = g.members.findIndex((m) => String(m) === me(req));
  if (i >= 0) g.members.splice(i, 1); else g.members.push(req.user._id);
  await g.save();
  res.json(groupDTO(g, me(req), req.shadow));
});

/* Members of a group (public cards: no email). Anyone signed in can see
   who's in an approved group; the owner also sees a pending one. */
router.get("/groups/:id/members", async (req, res) => {
  const g = await CommunityGroup.findById(req.params.id).lean();
  if (!g || (g.status !== "approved" && String(g.ownerId) !== me(req) && !isModerator(req)) || isShadowed(req, g.ownerId)) {
    return res.status(404).json({ error: "Not found" });
  }
  // Hidden people aren't in anyone else's member list.
  const users = await User.find({ _id: { $in: visible(g.members || [], req.shadow) } }).select(CARD_SELECT).lean();
  const owner = String(g.ownerId);
  // acceptsMessages/acceptsRequests are about 1:1 contact; the group chat itself is unaffected.
  const cards = await cardsFor(req.user, users);
  res.json(cards
    .map((c) => ({ ...c, isOwner: c.id === owner, isMe: c.id === me(req) }))
    .sort((a, b) => (b.isOwner - a.isOwner) || a.name.localeCompare(b.name)));
});

/* ================= TYPING ================= */

router.post("/typing", (req, res) => {
  const { scope, id, typing } = req.body || {};
  if (!isScope(scope) || !id) return res.status(400).json({ error: "scope and id required" });
  if (typing === false) stopTyping(scope, String(id), me(req));
  else markTyping(scope, String(id), me(req), req.user.name);
  res.json({ ok: true });
});

router.get("/typing", (req, res) => {
  const { scope, id } = req.query;
  if (!isScope(scope) || !id) return res.status(400).json({ error: "scope and id required" });
  res.json({ typing: whoIsTyping(scope, String(id), me(req), Date.now(), req.unseen) });
});

async function requireMember(req, res) {
  const g = await CommunityGroup.findById(req.params.id);
  if (!g || isShadowed(req, g.ownerId)) { res.status(404).json({ error: "Not found" }); return null; }
  if (!g.members.some((m) => String(m) === me(req)) && !isModerator(req)) {
    res.status(403).json({ error: "Join the group to see its chat" }); return null;
  }
  return g;
}

router.get("/groups/:id/messages", async (req, res) => {
  const g = await requireMember(req, res); if (!g) return;
  const since = req.query.since ? new Date(String(req.query.since)) : null;
  const filter = { groupId: g._id, $or: [{ status: "approved" }, { authorId: req.user._id }] };
  if (since && !isNaN(since)) filter.createdAt = { $gt: since };
  const msgs = (await GroupMessage.find(filter).sort({ createdAt: 1 }).limit(500).lean()).filter((m) => !req.unseen.has(String(m.authorId)));
  const avatars = await avatarUrls(msgs.map((m) => m.authorId));
  // They've seen this chat up to now (the "What you missed" email counts only later messages); not for ?peek=1 refreshes.
  if (req.query.peek !== "1") {
    GroupSeen.updateOne({ userId: req.user._id, groupId: g._id }, { $max: { at: new Date() } }, { upsert: true })
      .catch((err) => { if (err?.code !== 11000) console.error("GROUP SEEN ERROR:", err?.message || err); });
  }
  res.json(msgs.map((m) => ({
    id: String(m._id), groupId: String(m.groupId), authorId: String(m.authorId), authorName: m.authorName,
    authorAvatarUrl: authorAvatar(avatars, m.authorId), mentions: mentionList(m.mentions),
    body: m.body, status: m.status, mine: String(m.authorId) === me(req), createdAt: m.createdAt,
  })));
});

router.post("/groups/:id/messages", async (req, res) => {
  const g = await requireMember(req, res); if (!g) return;
  const body = trimBody(req.body?.body, 2000);
  if (!body) return res.status(400).json({ error: "body required" });
  const status = await statusFor(body, req.user._id, "group-message");
  const mentions = await resolveMentions(req.body?.mentions);
  const m = await GroupMessage.create({ groupId: g._id, authorId: req.user._id, authorName: req.user.name, body, status, ...(mentions.length ? { mentions } : {}) });
  // A hidden person's group messages reach nobody (left out of everyone else's chat, no push).
  if (status === "approved" && !req.appHidden) {
    // Everyone else in the group, minus anyone who blocked (or was blocked by) the author. In a hidden
    // person's group (a moderator writing) only its owner can see the chat, so only they hear.
    const blocks = await Block.find({ $or: [{ userId: req.user._id }, { blockedId: req.user._id }] }).lean();
    const skip = new Set([me(req), ...blocks.map((b) => String(String(b.userId) === me(req) ? b.blockedId : b.userId))]);
    const ownerHidden = await isHiddenAuthor(g.ownerId, me(req));
    const to = (g.members || []).filter((id) => !skip.has(String(id)) && (!ownerHidden || String(id) === String(g.ownerId)));
    // People it @mentions hear at once; everyone else at most once per 10 minutes per chat (services/notify.js).
    notifyGroupMessage({ group: g, actor: req.user, message: m, to, mentions, blocked: skip, shadow: req.shadow });
  }
  res.status(201).json({
    id: String(m._id), groupId: String(g._id), authorId: me(req), authorName: m.authorName,
    authorAvatarUrl: avatarFor(req.user), mentions: mentionList(m.mentions), body: m.body, status: m.status, mine: true, createdAt: m.createdAt,
  });
});

/* ================= MODERATORS ================= */

router.get("/admin/pending", needRight("moderate"), async (req, res) => {
  const [discussions, groups] = await Promise.all([
    Discussion.find({ status: { $in: ["pending", "held"] } }).sort({ createdAt: -1 }).lean(),
    CommunityGroup.find({ status: { $in: ["pending", "held"] } }).sort({ createdAt: -1 }).lean(),
  ]);
  res.json({ discussions: discussions.map((d) => discussionDTO(d, me(req))), groups: groups.map((g) => groupDTO(g, me(req), req.shadow)) });
});

router.post("/admin/:type/:id/status", needRight("moderate"), async (req, res) => {
  const status = String(req.body?.status || "");
  if (!["approved", "held", "hidden", "pending"].includes(status)) return res.status(400).json({ error: "bad status" });
  const Model = { discussion: Discussion, group: CommunityGroup, reply: DiscussionReply, groupMessage: GroupMessage }[req.params.type];
  if (!Model) return res.status(400).json({ error: "bad type" });
  const doc = await Model.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: "Not found" });
  doc.status = status;
  await doc.save();
  res.json({ ok: true, id: String(doc._id), status });
});

export default router;
