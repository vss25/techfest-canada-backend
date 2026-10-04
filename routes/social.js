import express from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import { buildDirectory } from "../services/ticketAccess.js";
import { Block } from "../models/Admin.js";
import {
  SocialPost, SocialComment, SocialConnection, SocialMessage,
  SessionRegistration, SessionQuestion, SessionVote,
} from "../models/Social.js";
import { moderateText, isConfigured as moderationConfigured } from "../services/deepcleer.js";
import {
  threadKey, userCard, postDTO, tally, cleanImageData, trimBody, tierName, bestTierKey, isOnApp,
} from "../services/socialHelpers.js";

/* =========================================================
   /api/social — the iOS app's shared layer
   =========================================================
   All routes need a user JWT. Text goes through DeepCleer when configured;
   flagged items are stored as `held` (author sees them, nobody else).
   Polling, not sockets: the app refreshes on appear / pull / every few
   seconds in chat. Good enough for a two-day event; swap for Socket.IO
   later without changing the data model.
========================================================= */

const router = express.Router();

async function requireUser(req, res, next) {
  try {
    const h = req.headers.authorization;
    if (!h) return res.status(401).json({ error: "Unauthorized" });
    const decoded = jwt.verify(h.split(" ")[1], process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select("-password -resetPasswordToken -resetPasswordExpires");
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (user.banned) return res.status(403).json({ error: "This account is suspended. Contact info@thetechfestival.com." });
    req.user = user;
    // Blocks work both ways: neither side sees the other's posts, comments or messages.
    const rows = await Block.find({ $or: [{ userId: user._id }, { blockedId: user._id }] }).lean();
    req.blocked = new Set(rows.map((r) => String(String(r.userId) === String(user._id) ? r.blockedId : r.userId)));
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}
router.use(requireUser);

/** "approved" or "held" after moderation; never throws. */
async function statusFor(text, userId, context) {
  if (!moderationConfigured()) return "approved";
  try {
    const v = await moderateText({ text, userId, context });
    return v.flagged ? "held" : "approved";
  } catch {
    return "approved";
  }
}

const isAdmin = (u) => u.role === "admin";
const authorTier = (u) => tierName(bestTierKey(u));

/** authorId → avatarVersion for the people who have a profile photo. */
async function avatarVersions(ids) {
  const uniq = [...new Set(ids.map(String))];
  if (!uniq.length) return new Map();
  const rows = await User.find({ _id: { $in: uniq }, avatarVersion: { $gt: 0 } }).select("avatarVersion").lean();
  return new Map(rows.map((u) => [String(u._id), u.avatarVersion]));
}

/* ================= ME / DIRECTORY ================= */

router.get("/me", (req, res) => {
  res.json({ ...userCard(req.user), email: req.user.email, isAdmin: isAdmin(req.user) });
});

// Attendees who have filled anything in (so the directory isn't every newsletter signup).
router.get("/users", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const filter = {
    _id: { $ne: req.user._id },
    $or: [{ jobTitle: { $ne: "" } }, { organization: { $ne: "" } }, { "tickets.0": { $exists: true } }],
  };
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$and = [{ $or: [{ name: rx }, { organization: rx }, { jobTitle: rx }] }];
  }
  const users = await User.find(filter).select("name jobTitle organization linkedinUrl country topics tickets avatarVersion lastActiveAt appOnboarded tagline availabilitySlots meetingSpot").limit(60).lean();
  res.json(users.filter((u) => !req.blocked.has(String(u._id))).map(userCard));
});

/* Every ticket holder (app users + guest purchases), one entry per person,
   their most recent ticket as the pass. Guests not on the app yet can be
   seen but not messaged. Never returns email. */
router.get("/attendees", async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const [users, guests] = await Promise.all([
    User.find({ "tickets.0": { $exists: true } })
      .select("name email jobTitle organization linkedinUrl country topics tickets directoryHidden avatarVersion lastActiveAt appOnboarded tagline availabilitySlots meetingSpot").lean(),
    Attendee.find({ claimedBy: { $exists: false } }).select("name email ticketId ticketType purchaseDate").lean(),
  ]);
  let people = buildDirectory(users, guests, { excludeUserId: req.user._id, excludeEmail: req.user.email });
  if (q) people = people.filter((p) => [p.name, p.organization, p.jobTitle].some((s) => String(s || "").toLowerCase().includes(q)));
  res.json(people.filter((p) => !req.blocked.has(p.id)));
});

router.get("/users/:id", async (req, res) => {
  const u = await User.findById(req.params.id).select("name jobTitle organization linkedinUrl country topics tickets avatarVersion lastActiveAt appOnboarded tagline availabilitySlots meetingSpot").lean();
  if (!u) return res.status(404).json({ error: "Not found" });
  res.json(userCard(u));
});

/* ================= FEED ================= */

router.get("/feed", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const since = req.query.since ? new Date(String(req.query.since)) : null;
  const filter = { $or: [{ status: "approved" }, { authorId: req.user._id, status: "held" }] };
  if (since && !isNaN(since)) filter.createdAt = { $gt: since };
  const posts = (await SocialPost.find(filter).sort({ createdAt: -1 }).limit(limit).lean())
    .filter((p) => !req.blocked.has(String(p.authorId)));
  const avatars = await avatarVersions(posts.map((p) => p.authorId));
  res.json(posts.map((p) => postDTO(p, req.user._id, avatars)));
});

router.post("/feed", async (req, res) => {
  const body = trimBody(req.body?.body, 4000);
  const imageData = cleanImageData(req.body?.imageData, 450_000);
  if (!body && !imageData) return res.status(400).json({ error: "Write something or add a photo" });
  const linkUrl = trimBody(req.body?.linkUrl, 500);
  const status = await statusFor([body, linkUrl].join(" "), req.user._id, "feed");
  const post = await SocialPost.create({
    authorId: req.user._id,
    authorName: req.user.name,
    authorTitle: req.user.jobTitle || "",
    authorOrg: req.user.organization || "",
    authorTier: authorTier(req.user),
    kind: isAdmin(req.user) && req.body?.kind === "announcement" ? "announcement" : "member",
    body,
    topicTags: Array.isArray(req.body?.topicTags) ? req.body.topicTags.filter((t) => typeof t === "string").slice(0, 8) : [],
    linkUrl,
    imageData,
    status,
  });
  res.status(201).json(postDTO(post, req.user._id, new Map([[String(req.user._id), req.user.avatarVersion]])));
});

router.post("/feed/:id/like", async (req, res) => {
  const post = await SocialPost.findById(req.params.id);
  if (!post || post.status === "hidden") return res.status(404).json({ error: "Not found" });
  const me = String(req.user._id);
  const i = post.likes.findIndex((l) => String(l) === me);
  if (i >= 0) post.likes.splice(i, 1); else post.likes.push(req.user._id);
  post.likeCount = post.likes.length;
  await post.save();
  res.json({ liked: i < 0, likeCount: post.likeCount });
});

router.get("/feed/:id/comments", async (req, res) => {
  const comments = await SocialComment.find({
    postId: req.params.id,
    $or: [{ status: "approved" }, { authorId: req.user._id, status: "held" }],
  }).sort({ createdAt: 1 }).lean();
  res.json(comments.filter((c) => !req.blocked.has(String(c.authorId))).map((c) => ({
    id: String(c._id), postId: String(c.postId), authorId: String(c.authorId),
    authorName: c.authorName, authorTier: c.authorTier || "", body: c.body,
    status: c.status, createdAt: c.createdAt,
  })));
});

router.post("/feed/:id/comments", async (req, res) => {
  const body = trimBody(req.body?.body, 2000);
  if (!body) return res.status(400).json({ error: "body required" });
  const post = await SocialPost.findById(req.params.id);
  if (!post || post.status === "hidden") return res.status(404).json({ error: "Not found" });
  const status = await statusFor(body, req.user._id, "comment");
  const c = await SocialComment.create({
    postId: post._id, authorId: req.user._id, authorName: req.user.name,
    authorTier: authorTier(req.user), body, status,
  });
  if (status === "approved") { post.commentCount += 1; await post.save(); }
  res.status(201).json({
    id: String(c._id), postId: String(post._id), authorId: String(req.user._id),
    authorName: c.authorName, authorTier: c.authorTier, body: c.body, status: c.status, createdAt: c.createdAt,
    commentCount: post.commentCount,
  });
});

/* ================= CONNECTIONS ================= */

async function connectionDTO(c, meId) {
  const otherId = String(c.fromUserId) === String(meId) ? c.toUserId : c.fromUserId;
  const other = await User.findById(otherId).select("name jobTitle organization linkedinUrl country topics tickets avatarVersion lastActiveAt appOnboarded tagline availabilitySlots meetingSpot").lean();
  return {
    id: String(c._id),
    user: userCard(other) || { id: String(otherId), name: "Attendee" },
    direction: String(c.fromUserId) === String(meId) ? "outgoing" : "incoming",
    status: c.status, kind: c.kind, note: c.note || "",
    createdAt: c.createdAt, respondedAt: c.respondedAt,
    // email is shared only once connected in person (Discovery X model)
    email: c.status === "accepted" && c.kind === "inPerson" ? (other?.email || "") : undefined,
  };
}

router.get("/connections", async (req, res) => {
  const me = req.user._id;
  const all = await SocialConnection.find({ $or: [{ fromUserId: me }, { toUserId: me }], status: { $ne: "declined" } })
    .sort({ updatedAt: -1 }).lean();
  const items = await Promise.all(all.map((c) => connectionDTO(c, me)));
  res.json({
    accepted: items.filter((c) => c.status === "accepted"),
    incoming: items.filter((c) => c.status === "pending" && c.direction === "incoming"),
    outgoing: items.filter((c) => c.status === "pending" && c.direction === "outgoing"),
  });
});

router.post("/connections/request", async (req, res) => {
  const toUserId = String(req.body?.toUserId || "");
  if (!toUserId || toUserId === String(req.user._id)) return res.status(400).json({ error: "toUserId required" });
  const target = await User.findById(toUserId).select("_id lastActiveAt appOnboarded");
  if (!target) return res.status(404).json({ error: "User not found" });
  if (!isOnApp(target)) return res.status(409).json({ error: "They haven't joined the app yet. You can connect once they sign in." });
  const existing = await SocialConnection.findOne({
    $or: [{ fromUserId: req.user._id, toUserId }, { fromUserId: toUserId, toUserId: req.user._id }],
  });
  if (existing) {
    // Mutual interest → accept instead of duplicating
    if (existing.status === "pending" && String(existing.toUserId) === String(req.user._id)) {
      existing.status = "accepted"; existing.respondedAt = new Date(); await existing.save();
    }
    return res.json(await connectionDTO(existing, req.user._id));
  }
  const c = await SocialConnection.create({ fromUserId: req.user._id, toUserId, note: trimBody(req.body?.note, 300) });
  res.status(201).json(await connectionDTO(c, req.user._id));
});

router.post("/connections/:id/respond", async (req, res) => {
  const c = await SocialConnection.findById(req.params.id);
  if (!c || String(c.toUserId) !== String(req.user._id)) return res.status(404).json({ error: "Not found" });
  c.status = req.body?.accept ? "accepted" : "declined";
  c.respondedAt = new Date();
  await c.save();
  res.json(await connectionDTO(c, req.user._id));
});

// Badge scan: both parties connected immediately, details exchanged.
/* Withdraw a request you sent that hasn't been accepted yet. */
router.post("/connections/:id/withdraw", async (req, res) => {
  const c = await SocialConnection.findById(req.params.id).catch(() => null);
  if (!c || String(c.fromUserId) !== String(req.user._id)) return res.status(404).json({ error: "Request not found" });
  if (c.status !== "pending") return res.status(409).json({ error: "This request was already answered" });
  await c.deleteOne();
  res.json({ withdrawn: true, id: String(c._id) });
});

router.post("/connections/in-person", async (req, res) => {
  const toUserId = String(req.body?.toUserId || "");
  if (!toUserId || toUserId === String(req.user._id)) return res.status(400).json({ error: "toUserId required" });
  const target = await User.findById(toUserId).select("_id");
  if (!target) return res.status(404).json({ error: "User not found" });
  let c = await SocialConnection.findOne({
    $or: [{ fromUserId: req.user._id, toUserId }, { fromUserId: toUserId, toUserId: req.user._id }],
  });
  if (!c && !isOnApp(await User.findById(toUserId).select("lastActiveAt appOnboarded").lean())) {
    return res.status(409).json({ error: "They haven't joined the app yet. You can connect once they sign in." });
  }
  if (!c) c = new SocialConnection({ fromUserId: req.user._id, toUserId });
  c.status = "accepted"; c.kind = "inPerson"; c.respondedAt = new Date();
  await c.save();
  res.json(await connectionDTO(c, req.user._id));
});

/* ================= MESSAGES ================= */

router.get("/messages", async (req, res) => {
  const me = req.user._id;
  const recent = await SocialMessage.aggregate([
    { $match: { $or: [{ fromUserId: me }, { toUserId: me }], status: { $ne: "hidden" } } },
    { $sort: { createdAt: -1 } },
    { $group: {
      _id: "$threadKey",
      last: { $first: "$$ROOT" },
      unread: { $sum: { $cond: [{ $and: [{ $eq: ["$toUserId", me] }, { $eq: ["$readAt", null] }] }, 1, 0] } },
    } },
    { $sort: { "last.createdAt": -1 } },
    { $limit: 100 },
  ]);
  const visible = recent.filter((t) => !req.blocked.has(String(String(t.last.fromUserId) === String(me) ? t.last.toUserId : t.last.fromUserId)));
  const threads = await Promise.all(visible.map(async (t) => {
    const otherId = String(t.last.fromUserId) === String(me) ? t.last.toUserId : t.last.fromUserId;
    const other = await User.findById(otherId).select("name jobTitle organization linkedinUrl country topics tickets avatarVersion lastActiveAt appOnboarded tagline availabilitySlots meetingSpot").lean();
    return {
      user: userCard(other) || { id: String(otherId), name: "Attendee" },
      lastMessage: { body: t.last.body, sentByMe: String(t.last.fromUserId) === String(me), createdAt: t.last.createdAt },
      unread: t.unread,
    };
  }));
  res.json(threads);
});

router.get("/messages/:userId", async (req, res) => {
  if (req.blocked.has(String(req.params.userId))) return res.json([]);
  const key = threadKey(req.user._id, req.params.userId);
  const since = req.query.since ? new Date(String(req.query.since)) : null;
  const filter = { threadKey: key, $or: [{ status: "approved" }, { fromUserId: req.user._id }] };
  if (since && !isNaN(since)) filter.createdAt = { $gt: since };
  const msgs = await SocialMessage.find(filter).sort({ createdAt: 1 }).limit(500).lean();
  await SocialMessage.updateMany({ threadKey: key, toUserId: req.user._id, readAt: null }, { $set: { readAt: new Date() } });
  res.json(msgs.map((m) => ({
    id: String(m._id), body: m.body, sentByMe: String(m.fromUserId) === String(req.user._id),
    status: m.status, createdAt: m.createdAt, readAt: m.readAt,
  })));
});

router.post("/messages/:userId", async (req, res) => {
  const body = trimBody(req.body?.body, 2000);
  if (!body) return res.status(400).json({ error: "body required" });
  const to = await User.findById(req.params.userId).select("_id");
  if (!to) return res.status(404).json({ error: "User not found" });
  if (req.blocked.has(String(to._id))) return res.status(403).json({ error: "You can't message this person." });
  const status = await statusFor(body, req.user._id, "message");
  const m = await SocialMessage.create({
    threadKey: threadKey(req.user._id, to._id), fromUserId: req.user._id, toUserId: to._id, body, status,
  });
  res.status(201).json({ id: String(m._id), body: m.body, sentByMe: true, status: m.status, createdAt: m.createdAt });
});

/* ================= SESSIONS: REGISTRATIONS ================= */

router.get("/sessions/registrations", async (req, res) => {
  const [mine, counts] = await Promise.all([
    SessionRegistration.find({ userId: req.user._id }).select("sessionId").lean(),
    SessionRegistration.aggregate([{ $group: { _id: "$sessionId", n: { $sum: 1 } } }]),
  ]);
  const countMap = {};
  for (const c of counts) countMap[c._id] = c.n;
  res.json({ mine: mine.map((r) => r.sessionId), counts: countMap });
});

router.post("/sessions/:id/register", async (req, res) => {
  const sessionId = String(req.params.id);
  const existing = await SessionRegistration.findOne({ userId: req.user._id, sessionId });
  if (existing) await existing.deleteOne();
  else await SessionRegistration.create({ userId: req.user._id, sessionId });
  const count = await SessionRegistration.countDocuments({ sessionId });
  res.json({ registered: !existing, count });
});

/* ================= SESSIONS: Q&A ================= */

const questionDTO = (q, me) => ({
  id: String(q._id), sessionId: q.sessionId, authorId: String(q.authorId), authorName: q.authorName,
  body: q.body, upvotes: (q.upvotes || []).length,
  upvotedByMe: (q.upvotes || []).some((u) => String(u) === String(me)),
  sentByMe: String(q.authorId) === String(me), status: q.status, createdAt: q.createdAt,
});

router.get("/sessions/:id/questions", async (req, res) => {
  const qs = await SessionQuestion.find({
    sessionId: req.params.id,
    $or: [{ status: "approved" }, { authorId: req.user._id }],
  }).sort({ createdAt: -1 }).limit(200).lean();
  res.json(qs.map((q) => questionDTO(q, req.user._id)));
});

router.post("/sessions/:id/questions", async (req, res) => {
  const body = trimBody(req.body?.body, 600);
  if (!body) return res.status(400).json({ error: "body required" });
  const status = await statusFor(body, req.user._id, "question");
  const q = await SessionQuestion.create({
    sessionId: req.params.id, authorId: req.user._id, authorName: req.user.name, body, status, upvotes: [req.user._id],
  });
  res.status(201).json(questionDTO(q, req.user._id));
});

router.post("/sessions/questions/:qid/upvote", async (req, res) => {
  const q = await SessionQuestion.findById(req.params.qid);
  if (!q) return res.status(404).json({ error: "Not found" });
  const me = String(req.user._id);
  const i = q.upvotes.findIndex((u) => String(u) === me);
  if (i >= 0) q.upvotes.splice(i, 1); else q.upvotes.push(req.user._id);
  await q.save();
  res.json(questionDTO(q, req.user._id));
});

/* ================= SESSIONS: POLLS ================= */

router.get("/sessions/:id/polls/:pollId/results", async (req, res) => {
  const optionCount = Math.min(Math.max(Number(req.query.options) || 4, 1), 16);
  const votes = await SessionVote.find({ sessionId: req.params.id, pollId: req.params.pollId }).select("optionIndex userId").lean();
  const mine = votes.find((v) => String(v.userId) === String(req.user._id));
  res.json({ counts: tally(votes, optionCount), total: votes.length, myVote: mine ? mine.optionIndex : null });
});

router.post("/sessions/:id/polls/:pollId/vote", async (req, res) => {
  const optionIndex = Number(req.body?.optionIndex);
  if (!Number.isInteger(optionIndex) || optionIndex < 0) return res.status(400).json({ error: "optionIndex required" });
  const optionCount = Math.min(Math.max(Number(req.body?.options) || 4, 1), 16);
  try {
    await SessionVote.create({ sessionId: req.params.id, pollId: req.params.pollId, userId: req.user._id, optionIndex });
  } catch (err) {
    if (err?.code !== 11000) throw err;   // already voted → return results as-is
  }
  const votes = await SessionVote.find({ sessionId: req.params.id, pollId: req.params.pollId }).select("optionIndex userId").lean();
  const mine = votes.find((v) => String(v.userId) === String(req.user._id));
  res.json({ counts: tally(votes, optionCount), total: votes.length, myVote: mine ? mine.optionIndex : null });
});

/* ================= STAFF MODERATION ================= */

router.get("/admin/held", async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Admin only" });
  const [posts, comments, questions, messages] = await Promise.all([
    SocialPost.find({ status: "held" }).sort({ createdAt: -1 }).limit(100).lean(),
    SocialComment.find({ status: "held" }).sort({ createdAt: -1 }).limit(100).lean(),
    SessionQuestion.find({ status: "held" }).sort({ createdAt: -1 }).limit(100).lean(),
    SocialMessage.find({ status: "held" }).sort({ createdAt: -1 }).limit(100).lean(),
  ]);
  res.json({
    posts: posts.map((p) => postDTO(p, req.user._id)),
    comments: comments.map((c) => ({ id: String(c._id), postId: String(c.postId), authorName: c.authorName, body: c.body, createdAt: c.createdAt })),
    questions: questions.map((q) => questionDTO(q, req.user._id)),
    messages: messages.map((m) => ({ id: String(m._id), body: m.body, createdAt: m.createdAt })),
  });
});

router.post("/admin/:type/:id/status", async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Admin only" });
  const status = String(req.body?.status || "");
  if (!["approved", "held", "hidden"].includes(status)) return res.status(400).json({ error: "bad status" });
  const Model = { post: SocialPost, comment: SocialComment, question: SessionQuestion, message: SocialMessage }[req.params.type];
  if (!Model) return res.status(400).json({ error: "bad type" });
  const doc = await Model.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: "Not found" });
  const was = doc.status;
  doc.status = status;
  await doc.save();
  if (Model === SocialComment && was !== "approved" && status === "approved") {
    await SocialPost.updateOne({ _id: doc.postId }, { $inc: { commentCount: 1 } });
  }
  res.json({ ok: true, id: String(doc._id), status });
});

export default router;
