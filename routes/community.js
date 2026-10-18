import express from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { Discussion, DiscussionReply, CommunityGroup, GroupMessage } from "../models/Community.js";
import { moderateText, isConfigured as moderationConfigured } from "../services/deepcleer.js";
import { trimBody, CARD_SELECT } from "../services/socialHelpers.js";
import { cardsFor } from "../services/cards.js";
import { Block } from "../models/Admin.js";
import { pushToUsers } from "../services/push.js";
import { recordActivity } from "../models/ActivityEvent.js";
import { buildActivity, isObjectId } from "../services/socialActivity.js";
import {
  discussionDTO, followerIds, legacyFollowers, shouldAutoFollow, followUpdate, parseFollow, wantsFollowing,
  followingFilter, canSeeDiscussion, isFollowing, followerCount, fanOutRecipients, replyPush, createPushThrottle, MAX_FANOUT,
} from "../services/discussionFollow.js";
import { isScope, markTyping, stopTyping, whoIsTyping } from "../services/typing.js";
import { personAccess, rightError } from "../services/appRights.js";
import { rightsContext, RIGHTS_SELECT } from "../services/rightsStore.js";

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
    const user = await User.findById(decoded.id).select(RIGHTS_SELECT);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (user.banned) return res.status(403).json({ error: "This account is suspended. Contact info@thetechfestival.com." });
    req.user = user;
    const rows = await Block.find({ $or: [{ userId: user._id }, { blockedId: user._id }] }).lean();
    req.blocked = new Set(rows.map((r) => String(String(r.userId) === String(user._id) ? r.blockedId : r.userId)));
    req.ctx = await rightsContext();
    req.rights = personAccess(user, req.ctx).rights;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}
router.use(requireUser);

const me = (req) => String(req.user._id);
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

/* ================= DISCUSSIONS ================= */

/* Following (rules in services/discussionFollow.js): the author follows on
   create, a replier on their first reply unless they unfollowed before.
   Each approved reply gives every other follower an activity row (the dot on
   Discussions) and a push, at most one push per follower per thread per 10 min. */
const discussionPushes = createPushThrottle();

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
  res.json(list.filter((d) => !req.blocked.has(String(d.authorId))).map((d) => discussionDTO(d, me(req))));
});

router.post("/discussions", needRight("startDiscussions"), async (req, res) => {
  const title = trimBody(req.body?.title, 200);
  const body = trimBody(req.body?.body, 4000);
  if (title.length < 4 || !body) return res.status(400).json({ error: "title and body required" });
  const flagged = (await statusFor(`${title}\n${body}`, req.user._id, "discussion", "pending")) === "held";
  const d = await Discussion.create({
    authorId: req.user._id, authorName: req.user.name, title, body,
    tags: Array.isArray(req.body?.tags) ? req.body.tags.filter((t) => typeof t === "string").slice(0, 6) : [],
    status: flagged ? "held" : (isModerator(req) ? "approved" : "pending"),
    followers: [req.user._id],
  });
  res.status(201).json(discussionDTO(d, me(req)));
});

/* Follow / unfollow: { follow: true|false } → { ok, following, followerCount }.
   Idempotent. Same visibility as the list (404 otherwise). Unfollowing is
   remembered so replying again doesn't re-follow; following clears that. */
router.post("/discussions/:id/follow", async (req, res) => {
  const follow = parseFollow(req.body?.follow);
  if (follow === null) return res.status(400).json({ error: "follow must be true or false" });
  if (!isObjectId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const d = await Discussion.findById(req.params.id).select("authorId status followers unfollowed").lean();
  if (!canSeeDiscussion(d, me(req), req.blocked)) return res.status(404).json({ error: "Not found" });
  await ensureFollowerList(d);
  const after = await Discussion.findByIdAndUpdate(d._id, followUpdate(req.user._id, follow),
    { returnDocument: "after", projection: { authorId: 1, followers: 1, unfollowed: 1 } }).lean();
  if (!after) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true, following: isFollowing(after, me(req)), followerCount: followerCount(after) });
});

router.get("/discussions/:id/replies", async (req, res) => {
  const replies = await DiscussionReply.find({
    discussionId: req.params.id,
    $or: [{ status: "approved" }, { authorId: req.user._id }],
  }).sort({ createdAt: 1 }).lean();
  res.json(replies.filter((r) => !req.blocked.has(String(r.authorId))).map((r) => ({
    id: String(r._id), discussionId: String(r.discussionId), parentId: r.parentId ? String(r.parentId) : null,
    authorId: String(r.authorId), authorName: r.authorName, body: r.body, status: r.status,
    mine: String(r.authorId) === me(req), createdAt: r.createdAt,
  })));
});

router.post("/discussions/:id/replies", needRight("comment"), async (req, res) => {
  const body = trimBody(req.body?.body, 2000);
  if (!body) return res.status(400).json({ error: "body required" });
  const d = await Discussion.findById(req.params.id);
  if (!d || d.status !== "approved") return res.status(404).json({ error: "Not found" });
  let parentId = null;
  if (req.body?.parentId) {
    const parent = await DiscussionReply.findOne({ _id: req.body.parentId, discussionId: d._id });
    if (!parent) return res.status(400).json({ error: "parent reply not found" });
    parentId = parent._id;
  }
  const status = await statusFor(body, req.user._id, "discussion-reply");
  const r = await DiscussionReply.create({
    discussionId: d._id, parentId, authorId: req.user._id, authorName: req.user.name, body, status,
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
    // Every other follower sees a dot on Discussions and gets a (throttled) push.
    const { to, total, capped } = fanOutRecipients({ followers: followerIds(fresh || d), actorId: me(req), blocked: req.blocked });
    if (capped) console.warn(`DISCUSSION FAN-OUT CAPPED: ${d._id} has ${total} followers to tell, told the first ${MAX_FANOUT}`);
    recordActivity(buildActivity({ kind: "reply", section: "discussions", actorId: req.user._id, actorName: req.user.name,
      refId: d._id, recipients: to, blocked: req.blocked }));
    const pushTo = discussionPushes.take(String(d._id), to);
    if (pushTo.length) {
      pushToUsers(pushTo, replyPush({ discussionId: d._id, title: fresh?.title || d.title, actorName: req.user.name, body }));
    }
  }
  res.status(201).json({
    id: String(r._id), discussionId: String(d._id), parentId: parentId ? String(parentId) : null,
    authorId: me(req), authorName: r.authorName, body: r.body, status: r.status, mine: true,
    createdAt: r.createdAt, replyCount,
  });
});

/* ================= GROUPS ================= */

const groupDTO = (g, viewer) => ({
  id: String(g._id), name: g.name, description: g.description, tags: g.tags || [],
  ownerId: String(g.ownerId), ownerName: g.ownerName, memberCount: (g.members || []).length,
  joined: (g.members || []).some((m) => String(m) === viewer),
  status: g.status, createdAt: g.createdAt,
});

router.get("/groups", async (req, res) => {
  const list = await CommunityGroup.find({
    $or: [{ status: "approved" }, { ownerId: req.user._id }],
  }).sort({ createdAt: -1 }).limit(100).lean();
  res.json(list.map((g) => groupDTO(g, me(req))).sort((a, b) => b.memberCount - a.memberCount));
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
  if (!g || g.status !== "approved") return res.status(404).json({ error: "Not found" });
  const i = g.members.findIndex((m) => String(m) === me(req));
  if (i >= 0) g.members.splice(i, 1); else g.members.push(req.user._id);
  await g.save();
  res.json(groupDTO(g, me(req)));
});

/* Members of a group (public cards: no email). Anyone signed in can see
   who's in an approved group; the owner also sees a pending one. */
router.get("/groups/:id/members", async (req, res) => {
  const g = await CommunityGroup.findById(req.params.id).lean();
  if (!g || (g.status !== "approved" && String(g.ownerId) !== me(req) && !isModerator(req))) {
    return res.status(404).json({ error: "Not found" });
  }
  const users = await User.find({ _id: { $in: g.members || [] } }).select(CARD_SELECT).lean();
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
  res.json({ typing: whoIsTyping(scope, String(id), me(req)) });
});

async function requireMember(req, res) {
  const g = await CommunityGroup.findById(req.params.id);
  if (!g) { res.status(404).json({ error: "Not found" }); return null; }
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
  const msgs = await GroupMessage.find(filter).sort({ createdAt: 1 }).limit(500).lean();
  res.json(msgs.filter((m) => !req.blocked.has(String(m.authorId))).map((m) => ({
    id: String(m._id), groupId: String(m.groupId), authorId: String(m.authorId), authorName: m.authorName,
    body: m.body, status: m.status, mine: String(m.authorId) === me(req), createdAt: m.createdAt,
  })));
});

router.post("/groups/:id/messages", async (req, res) => {
  const g = await requireMember(req, res); if (!g) return;
  const body = trimBody(req.body?.body, 2000);
  if (!body) return res.status(400).json({ error: "body required" });
  const status = await statusFor(body, req.user._id, "group-message");
  const m = await GroupMessage.create({ groupId: g._id, authorId: req.user._id, authorName: req.user.name, body, status });
  if (status === "approved") {
    // Everyone else in the group, minus anyone who blocked (or was blocked by) the author.
    const blocks = await Block.find({ $or: [{ userId: req.user._id }, { blockedId: req.user._id }] }).lean();
    const skip = new Set([me(req), ...blocks.map((b) => String(String(b.userId) === me(req) ? b.blockedId : b.userId))]);
    const to = (g.members || []).filter((id) => !skip.has(String(id)));
    pushToUsers(to, { title: g.name, body: `${req.user.name}: ${body}`, link: "ttfc://tab/network", thread: `group.${g._id}`, kind: "gm", id: String(m._id) });
  }
  res.status(201).json({
    id: String(m._id), groupId: String(g._id), authorId: me(req), authorName: m.authorName,
    body: m.body, status: m.status, mine: true, createdAt: m.createdAt,
  });
});

/* ================= MODERATORS ================= */

router.get("/admin/pending", needRight("moderate"), async (req, res) => {
  const [discussions, groups] = await Promise.all([
    Discussion.find({ status: { $in: ["pending", "held"] } }).sort({ createdAt: -1 }).lean(),
    CommunityGroup.find({ status: { $in: ["pending", "held"] } }).sort({ createdAt: -1 }).lean(),
  ]);
  res.json({ discussions: discussions.map((d) => discussionDTO(d, me(req))), groups: groups.map((g) => groupDTO(g, me(req))) });
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
