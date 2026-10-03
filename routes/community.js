import express from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { Discussion, DiscussionReply, CommunityGroup, GroupMessage } from "../models/Community.js";
import { moderateText, isConfigured as moderationConfigured } from "../services/deepcleer.js";
import { trimBody } from "../services/socialHelpers.js";

/* =========================================================
   /api/community — discussions (threaded replies) and groups
   (membership + group chat) for the iOS app. User JWT required.
   New discussions and groups are `pending` until staff approve
   them (POST /admin/:type/:id/status); replies and group messages
   are moderated like the rest of the social layer.
========================================================= */

const router = express.Router();

async function requireUser(req, res, next) {
  try {
    const h = req.headers.authorization;
    if (!h) return res.status(401).json({ error: "Unauthorized" });
    const decoded = jwt.verify(h.split(" ")[1], process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select("name role");
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}
router.use(requireUser);

const isAdmin = (u) => u.role === "admin";
const me = (req) => String(req.user._id);

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

const discussionDTO = (d, viewer) => ({
  id: String(d._id), title: d.title, body: d.body, tags: d.tags || [],
  authorId: String(d.authorId), authorName: d.authorName, replyCount: d.replyCount || 0,
  status: d.status, mine: String(d.authorId) === viewer, createdAt: d.createdAt,
});

router.get("/discussions", async (req, res) => {
  const list = await Discussion.find({
    $or: [{ status: "approved" }, { authorId: req.user._id }],
  }).sort({ createdAt: -1 }).limit(100).lean();
  res.json(list.map((d) => discussionDTO(d, me(req))));
});

router.post("/discussions", async (req, res) => {
  const title = trimBody(req.body?.title, 200);
  const body = trimBody(req.body?.body, 4000);
  if (title.length < 4 || !body) return res.status(400).json({ error: "title and body required" });
  const flagged = (await statusFor(`${title}\n${body}`, req.user._id, "discussion", "pending")) === "held";
  const d = await Discussion.create({
    authorId: req.user._id, authorName: req.user.name, title, body,
    tags: Array.isArray(req.body?.tags) ? req.body.tags.filter((t) => typeof t === "string").slice(0, 6) : [],
    status: flagged ? "held" : (isAdmin(req.user) ? "approved" : "pending"),
  });
  res.status(201).json(discussionDTO(d, me(req)));
});

router.get("/discussions/:id/replies", async (req, res) => {
  const replies = await DiscussionReply.find({
    discussionId: req.params.id,
    $or: [{ status: "approved" }, { authorId: req.user._id }],
  }).sort({ createdAt: 1 }).lean();
  res.json(replies.map((r) => ({
    id: String(r._id), discussionId: String(r.discussionId), parentId: r.parentId ? String(r.parentId) : null,
    authorId: String(r.authorId), authorName: r.authorName, body: r.body, status: r.status,
    mine: String(r.authorId) === me(req), createdAt: r.createdAt,
  })));
});

router.post("/discussions/:id/replies", async (req, res) => {
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
  if (status === "approved") { d.replyCount += 1; await d.save(); }
  res.status(201).json({
    id: String(r._id), discussionId: String(d._id), parentId: parentId ? String(parentId) : null,
    authorId: me(req), authorName: r.authorName, body: r.body, status: r.status, mine: true,
    createdAt: r.createdAt, replyCount: d.replyCount,
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

router.post("/groups", async (req, res) => {
  const name = trimBody(req.body?.name, 80);
  const description = trimBody(req.body?.description, 500);
  if (name.length < 3) return res.status(400).json({ error: "name required" });
  const flagged = (await statusFor(`${name}\n${description}`, req.user._id, "group", "pending")) === "held";
  const g = await CommunityGroup.create({
    name, description, ownerId: req.user._id, ownerName: req.user.name, members: [req.user._id],
    tags: Array.isArray(req.body?.tags) ? req.body.tags.filter((t) => typeof t === "string").slice(0, 6) : [],
    status: flagged ? "held" : (isAdmin(req.user) ? "approved" : "pending"),
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

async function requireMember(req, res) {
  const g = await CommunityGroup.findById(req.params.id);
  if (!g) { res.status(404).json({ error: "Not found" }); return null; }
  if (!g.members.some((m) => String(m) === me(req)) && !isAdmin(req.user)) {
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
  res.json(msgs.map((m) => ({
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
  res.status(201).json({
    id: String(m._id), groupId: String(g._id), authorId: me(req), authorName: m.authorName,
    body: m.body, status: m.status, mine: true, createdAt: m.createdAt,
  });
});

/* ================= STAFF ================= */

router.get("/admin/pending", async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Admin only" });
  const [discussions, groups] = await Promise.all([
    Discussion.find({ status: { $in: ["pending", "held"] } }).sort({ createdAt: -1 }).lean(),
    CommunityGroup.find({ status: { $in: ["pending", "held"] } }).sort({ createdAt: -1 }).lean(),
  ]);
  res.json({ discussions: discussions.map((d) => discussionDTO(d, me(req))), groups: groups.map((g) => groupDTO(g, me(req))) });
});

router.post("/admin/:type/:id/status", async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Admin only" });
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
