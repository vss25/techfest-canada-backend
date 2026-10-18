import express from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import { buildDirectory, GUEST_DETAILS_SELECT } from "../services/ticketAccess.js";
import { Block } from "../models/Admin.js";
import {
  SocialPost, SocialComment, SocialConnection, SocialMessage,
  SessionRegistration, SessionQuestion, SessionVote,
} from "../models/Social.js";
import { moderateText, isConfigured as moderationConfigured } from "../services/deepcleer.js";
import AppNotification from "../models/AppNotification.js";
import ActivityEvent, { recordActivity } from "../models/ActivityEvent.js";
import { pushToUsers } from "../services/push.js";
import { config as cloudinaryConfig, signUpload, cleanMedia, MAX_ITEMS, MAX_VIDEO_SECONDS } from "../services/cloudinary.js";
import { rankFeed } from "../services/feedRank.js";
import { requireSwitch, POLLS_KEY, QA_KEY } from "../services/liveSwitches.js";
import { notificationDTO, parseSince, parseReadBody } from "../services/notifyHelpers.js";
import {
  threadKey, userCard, postDTO, tally, cleanImageData, trimBody, isOnApp,
  publicProfile, PROFILE_SELECT, CARD_SELECT,
} from "../services/socialHelpers.js";
import { canMessage, canRequest, messagesOffError, requestsOffError } from "../services/contactSwitches.js";
import { contactAccess, applyAccess } from "../services/contactAccess.js";
import { cardsFor } from "../services/cards.js";
import { publicTier, typesTier } from "../services/teamRoles.js";
import { personAccess, rightsFor, overridesContact, rightError, sharedEmail, RIGHT_ERRORS } from "../services/appRights.js";
import { rightsContext, RIGHTS_SELECT } from "../services/rightsStore.js";
import {
  cleanMentions, mentionedUserIds, keepKnownMentions, buildActivity, toggleLike, unreadFilter,
  parseSection, activityDTO, removeMode, canViewPost, isObjectId, ACTIVITY_SECTIONS,
} from "../services/socialActivity.js";

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
    // What they may do (services/appRights.js): their effective types and rights, plus the
    // context (matrix, global switches, exhibitor passes) for checking other people.
    req.ctx = await rightsContext();
    const acc = personAccess(user, req.ctx);
    req.types = acc.types;
    req.rights = acc.rights;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}
router.use(requireUser);

/** 403 with a readable line unless the signed-in person has `right`. */
const needRight = (right) => (req, res, next) => (req.rights[right] ? next() : res.status(403).json({ error: rightError(right, req.ctx.flags) }));

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
/** The pass stored on the signed-in person's new post or comment: only a Speaker Pass or "Exhibitor". */
const authorTier = (req) => typesTier(req.types);

/** authorId → avatarVersion for the people who have a profile photo. */
async function avatarVersions(ids) {
  const uniq = [...new Set(ids.map(String))];
  if (!uniq.length) return new Map();
  const rows = await User.find({ _id: { $in: uniq }, avatarVersion: { $gt: 0 } }).select("avatarVersion").lean();
  return new Map(rows.map((u) => [String(u._id), u.avatarVersion]));
}

/* ================= ME / DIRECTORY ================= */

// isAdmin is staff only; role tells the apps a volunteer ("volunteer") from an attendee ("user").
// `types` = all their effective types (attendee included), `rights` = what they may do (services/appRights.js).
router.get("/me", async (req, res) => {
  const { exhibitors, matrix } = req.ctx;
  res.json({
    ...userCard(req.user, { exhibitors, matrix, self: true }), email: req.user.email, isAdmin: isAdmin(req.user), role: req.user.role || "user",
    types: req.types, rights: req.rights,
  });
});

// Attendees who have filled anything in (so the directory isn't every newsletter signup).
router.get("/users", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const filter = {
    _id: { $ne: req.user._id },
    directoryHidden: { $ne: true }, banned: { $ne: true },
    $or: [{ jobTitle: { $ne: "" } }, { organization: { $ne: "" } }, { "tickets.0": { $exists: true } },
      // Staff and volunteers on the app are listed (Network → Staff) even with an empty profile.
      { role: { $in: ["admin", "volunteer"] }, $or: [{ appOnboarded: true }, { lastActiveAt: { $exists: true } }] }],
  };
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$and = [{ $or: [{ name: rx }, { organization: rx }, { jobTitle: rx }] }];
  }
  const users = (await User.find(filter).select(CARD_SELECT).limit(60).lean()).filter((u) => !req.blocked.has(String(u._id)));
  res.json(await cardsFor(req.user, users));
});

/* Every ticket holder (app users + guest purchases), one entry per person,
   their most recent ticket as the pass. Guests not on the app yet can be
   seen but not messaged. Never returns email. */
router.get("/attendees", async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const [users, guests] = await Promise.all([
    User.find({ $or: [{ "tickets.0": { $exists: true } }, { appOnboarded: true }, { lastActiveAt: { $exists: true } }] })
      .select("name email role jobTitle organization linkedinUrl country topics tickets directoryHidden avatarVersion lastActiveAt appOnboarded tagline availabilitySlots meetingSpot messagesOff requestsOff types typesOff").lean(),
    Attendee.find({ claimedBy: { $exists: false }, directoryHidden: { $ne: true } }).select(`name email ticketId ticketType purchaseDate promoCode issuedPass.booth ${GUEST_DETAILS_SELECT}`).lean(),
  ]);
  const { exhibitors, matrix } = req.ctx;
  let people = buildDirectory(users, guests, { excludeUserId: req.user._id, excludeEmail: req.user.email, exhibitors, matrix });
  if (q) people = people.filter((p) => [p.name, p.organization, p.jobTitle].some((s) => String(s || "").toLowerCase().includes(q)));
  people = people.filter((p) => !req.blocked.has(p.id));
  const shown = new Set(people.map((p) => p.id));
  const access = await contactAccess(req.user, users.filter((u) => shown.has(String(u._id))), req.ctx);
  res.json(people.map((p) => applyAccess(p, access)));
});

/* One person's profile page: everything they filled in for others to see
   (publicProfile in services/socialHelpers.js), never email, phone, role or tickets. */
router.get("/users/:id", async (req, res) => {
  const id = String(req.params.id);
  if (!isObjectId(id) || req.blocked.has(id)) return res.status(404).json({ error: "Not found" });
  const u = await User.findById(id).select(`${PROFILE_SELECT} directoryHidden banned`).lean();
  if (!u || u.banned) return res.status(404).json({ error: "Not found" });
  // Hidden people stay reachable from an existing chat or connection, but can't be looked up cold.
  const self = String(u._id) === String(req.user._id);
  if (u.directoryHidden && !self) {
    const [connected, chatted] = await Promise.all([
      SocialConnection.exists({ $or: [{ fromUserId: req.user._id, toUserId: u._id }, { fromUserId: u._id, toUserId: req.user._id }] }),
      SocialMessage.exists({ threadKey: threadKey(req.user._id, u._id) }),
    ]);
    if (!connected && !chatted) return res.status(404).json({ error: "Not found" });
  }
  const access = await contactAccess(req.user, [u], req.ctx);
  res.json(applyAccess(publicProfile(u, { exhibitors: req.ctx.exhibitors, matrix: req.ctx.matrix, self }), access));
});

/* ================= FEED ================= */

router.get("/feed", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const since = req.query.since ? new Date(String(req.query.since)) : null;
  const filter = { $or: [{ status: "approved" }, { authorId: req.user._id, status: "held" }] };
  if (since && !isNaN(since)) filter.createdAt = { $gt: since };
  // Rank the recent window by engagement (with a small daily shuffle), then trim.
  const recent = (await SocialPost.find(filter).sort({ createdAt: -1 }).limit(300).lean())
    .filter((p) => !req.blocked.has(String(p.authorId)));
  const posts = rankFeed(recent, req.user._id).slice(0, limit);
  const avatars = await avatarVersions(posts.map((p) => p.authorId));
  const staff = req.rights.deleteAnyPost;
  res.json(posts.map((p) => postDTO(p, req.user._id, avatars, { staff })));
});

/* ================= FEED MEDIA (Cloudinary) ================= */

/** Whether photo/video uploads are on, and their limits. */
router.get("/media/config", (req, res) => {
  res.json({ enabled: cloudinaryConfig().enabled, maxItems: MAX_ITEMS, maxVideoSeconds: MAX_VIDEO_SECONDS });
});

/** Signed parameters for one direct upload to Cloudinary. */
router.post("/media/sign", (req, res) => {
  const signed = signUpload({ type: req.body?.type, userId: req.user._id });
  if (!signed) return res.status(503).json({ error: "media_unavailable", message: "Photo and video uploads aren't switched on yet." });
  res.json(signed);
});

router.post("/feed", needRight("post"), async (req, res) => {
  const body = trimBody(req.body?.body, 4000);
  const imageData = cleanImageData(req.body?.imageData, 450_000);
  const media = cleanMedia(req.body?.media, cloudinaryConfig().cloudName);
  if (!body && !imageData && !media.length) return res.status(400).json({ error: "Write something or add a photo" });
  const linkUrl = trimBody(req.body?.linkUrl, 500);
  // @mentions: user ids must be real accounts; speaker ids are Sanity ids.
  let mentions = cleanMentions(req.body?.mentions);
  const mentionIds = mentionedUserIds(mentions);
  const known = mentionIds.length ? await User.find({ _id: { $in: mentionIds } }).select("name").lean() : [];
  mentions = keepKnownMentions(mentions, new Map(known.map((u) => [String(u._id), u.name])));
  const status = await statusFor([body, linkUrl].join(" "), req.user._id, "feed");
  const post = await SocialPost.create({
    authorId: req.user._id,
    authorName: req.user.name,
    authorTitle: req.user.jobTitle || "",
    authorOrg: req.user.organization || "",
    authorTier: authorTier(req),
    kind: isAdmin(req.user) && req.body?.kind === "announcement" ? "announcement" : "member",
    body,
    topicTags: Array.isArray(req.body?.topicTags) ? req.body.topicTags.filter((t) => typeof t === "string").slice(0, 8) : [],
    linkUrl,
    imageData,
    media,
    mentions,
    status,
  });
  // Held posts aren't visible to anyone else yet, so nobody hears about them.
  if (status === "approved") {
    recordActivity(buildActivity({ kind: "mention", section: "feed", actorId: req.user._id, actorName: req.user.name,
      refId: post._id, recipients: mentionedUserIds(mentions), blocked: req.blocked }));
  }
  res.status(201).json(postDTO(post, req.user._id, new Map([[String(req.user._id), req.user.avatarVersion]]), { staff: req.rights.deleteAnyPost }));
});

/** One post (opened from an activity row, a mention or a shared link). */
router.get("/feed/:id", async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const post = await SocialPost.findById(req.params.id).lean();
  if (!canViewPost(post, req.user, req.blocked, req.rights)) return res.status(404).json({ error: "Not found" });
  const avatars = await avatarVersions([post.authorId]);
  res.json(postDTO(post, req.user._id, avatars, { staff: req.rights.deleteAnyPost }));
});

/* The author deletes their own post (gone, with its comments); people with
   deleteAnyPost (staff) remove anyone else's (kept as status "hidden" with removedBy/removedAt). */
router.delete("/feed/:id", async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const post = await SocialPost.findById(req.params.id);
  if (!post) return res.status(404).json({ error: "Not found" });
  const mode = removeMode(post, req.user, req.rights);
  if (!mode) return res.status(403).json({ error: "You can only delete your own posts." });
  if (mode === "author") {
    await Promise.all([
      SocialComment.deleteMany({ postId: post._id }),
      ActivityEvent.deleteMany({ refId: post._id }),
      post.deleteOne(),
    ]);
    return res.json({ ok: true, id: String(post._id), removed: "deleted" });
  }
  post.status = "hidden";
  post.removedBy = req.user._id;
  post.removedAt = new Date();
  await post.save();
  await ActivityEvent.deleteMany({ refId: post._id });
  res.json({ ok: true, id: String(post._id), removed: "hidden" });
});

router.post("/feed/:id/like", async (req, res) => {
  const post = await SocialPost.findById(req.params.id);
  if (!post || post.status === "hidden") return res.status(404).json({ error: "Not found" });
  const t = toggleLike({ likes: post.likes, everLiked: post.everLiked, actorId: req.user._id });
  post.likes = t.likes;
  post.everLiked = t.everLiked;
  post.likeCount = t.likes.length;
  await post.save();
  // Only someone's first-ever like tells the author (not an unlike + relike).
  if (t.firstLike) {
    recordActivity(buildActivity({ kind: "like", section: "feed", actorId: req.user._id, actorName: req.user.name,
      refId: post._id, recipients: [post.authorId], blocked: req.blocked }));
  }
  res.json({ liked: t.liked, likeCount: post.likeCount });
});

router.get("/feed/:id/comments", async (req, res) => {
  const comments = await SocialComment.find({
    postId: req.params.id,
    $or: [{ status: "approved" }, { authorId: req.user._id, status: "held" }],
  }).sort({ createdAt: 1 }).lean();
  res.json(comments.filter((c) => !req.blocked.has(String(c.authorId))).map((c) => ({
    id: String(c._id), postId: String(c.postId), authorId: String(c.authorId),
    authorName: c.authorName, authorTier: publicTier(c.authorTier), body: c.body,
    status: c.status, createdAt: c.createdAt,
  })));
});

router.post("/feed/:id/comments", needRight("comment"), async (req, res) => {
  const body = trimBody(req.body?.body, 2000);
  if (!body) return res.status(400).json({ error: "body required" });
  const post = await SocialPost.findById(req.params.id);
  if (!post || post.status === "hidden") return res.status(404).json({ error: "Not found" });
  const status = await statusFor(body, req.user._id, "comment");
  const c = await SocialComment.create({
    postId: post._id, authorId: req.user._id, authorName: req.user.name,
    authorTier: authorTier(req), body, status,
  });
  if (status === "approved") {
    post.commentCount += 1;
    await post.save();
    recordActivity(buildActivity({ kind: "comment", section: "feed", actorId: req.user._id, actorName: req.user.name,
      refId: post._id, recipients: [post.authorId], blocked: req.blocked }));
  }
  res.status(201).json({
    id: String(c._id), postId: String(post._id), authorId: String(req.user._id),
    authorName: c.authorName, authorTier: publicTier(c.authorTier), body: c.body, status: c.status, createdAt: c.createdAt,
    commentCount: post.commentCount,
  });
});

/* ================= CONNECTIONS ================= */

/** `viewer` is the signed-in user (req.user), `ctx` their req.ctx (services/rightsStore.js). */
async function connectionDTO(c, viewer, ctx) {
  const meId = viewer._id;
  const otherId = String(c.fromUserId) === String(meId) ? c.toUserId : c.fromUserId;
  const other = await User.findById(otherId).select(`${CARD_SELECT} email`).lean();
  const inPerson = c.status === "accepted" && c.kind === "inPerson";
  const email = inPerson && other ? sharedEmail(other, rightsFor(other, ctx)) : "";
  return {
    id: String(c._id),
    user: (await cardsFor(viewer, [other]))[0] || { id: String(otherId), name: "Attendee" },
    direction: String(c.fromUserId) === String(meId) ? "outgoing" : "incoming",
    status: c.status, kind: c.kind, note: c.note || "",
    createdAt: c.createdAt, respondedAt: c.respondedAt,
    // Contact details are exchanged only once connected in person (badge scan), and only
    // from people whose types share them (shareContact). Not sent at all for other rows.
    email: inPerson ? email : undefined,
    contactShared: inPerson ? !!email : undefined,
  };
}

router.get("/connections", async (req, res) => {
  const me = req.user._id;
  const all = await SocialConnection.find({ $or: [{ fromUserId: me }, { toUserId: me }], status: { $ne: "declined" } })
    .sort({ updatedAt: -1 }).lean();
  const items = await Promise.all(all.map((c) => connectionDTO(c, req.user, req.ctx)));
  res.json({
    accepted: items.filter((c) => c.status === "accepted"),
    incoming: items.filter((c) => c.status === "pending" && c.direction === "incoming"),
    outgoing: items.filter((c) => c.status === "pending" && c.direction === "outgoing"),
  });
});

router.post("/connections/request", async (req, res) => {
  const toUserId = String(req.body?.toUserId || "");
  if (!toUserId || toUserId === String(req.user._id)) return res.status(400).json({ error: "toUserId required" });
  const target = await User.findById(toUserId).select(`_id lastActiveAt appOnboarded ${RIGHTS_SELECT}`);
  if (!target) return res.status(404).json({ error: "User not found" });
  if (!isOnApp(target)) return res.status(409).json({ error: "They haven't joined the app yet. You can connect once they sign in." });
  const existing = await SocialConnection.findOne({
    $or: [{ fromUserId: req.user._id, toUserId }, { fromUserId: toUserId, toUserId: req.user._id }],
  });
  if (existing) {
    // Mutual interest → accept instead of duplicating
    if (existing.status === "pending" && String(existing.toUserId) === String(req.user._id)) {
      existing.status = "accepted"; existing.respondedAt = new Date(); await existing.save();
      pushToUsers([existing.fromUserId], { title: `${req.user.name} accepted your request`, body: "You're connected — say hello.", link: "ttfc://tab/network", kind: "conn", id: String(existing._id) });
    }
    return res.json(await connectionDTO(existing, req.user, req.ctx));
  }
  // New requests need the sender's sendRequests and the target's receiveRequests (types + staff switch,
  // e.g. VIPs; staff and moderators may still ask). Rows above (theirs included) still work.
  if (!req.rights.sendRequests) return res.status(403).json({ error: RIGHT_ERRORS.sendRequests });
  if (!canRequest({ sender: req.user, target, senderRights: req.rights, targetRights: rightsFor(target, req.ctx) })) {
    return res.status(403).json({ error: requestsOffError(target) });
  }
  const c = await SocialConnection.create({ fromUserId: req.user._id, toUserId, note: trimBody(req.body?.note, 300) });
  if (!req.blocked.has(toUserId)) {
    pushToUsers([toUserId], { title: `${req.user.name} wants to connect`, body: [req.user.jobTitle, req.user.organization].filter(Boolean).join(" · ") || "Open TTFC to respond.", link: "ttfc://tab/network", kind: "conn", id: String(c._id) });
  }
  res.status(201).json(await connectionDTO(c, req.user, req.ctx));
});

router.post("/connections/:id/respond", async (req, res) => {
  const c = await SocialConnection.findById(req.params.id);
  if (!c || String(c.toUserId) !== String(req.user._id)) return res.status(404).json({ error: "Not found" });
  c.status = req.body?.accept ? "accepted" : "declined";
  c.respondedAt = new Date();
  await c.save();
  if (c.status === "accepted") {
    pushToUsers([c.fromUserId], { title: `${req.user.name} accepted your request`, body: "You're connected — say hello.", link: "ttfc://tab/network", kind: "conn", id: String(c._id) });
  }
  res.json(await connectionDTO(c, req.user, req.ctx));
});

/* Withdraw a request you sent that hasn't been accepted yet. */
router.post("/connections/:id/withdraw", async (req, res) => {
  const c = await SocialConnection.findById(req.params.id).catch(() => null);
  if (!c || String(c.fromUserId) !== String(req.user._id)) return res.status(404).json({ error: "Request not found" });
  if (c.status !== "pending") return res.status(409).json({ error: "This request was already answered" });
  await c.deleteOne();
  res.json({ withdrawn: true, id: String(c._id) });
});

/* Badge scan: both parties connected at once, whatever their request rights. Each
   side sees the other's email only if that person shares contact details (shareContact). */
router.post("/connections/in-person", async (req, res) => {
  const toUserId = String(req.body?.toUserId || "");
  if (!toUserId || toUserId === String(req.user._id)) return res.status(400).json({ error: "toUserId required" });
  if (req.blocked.has(toUserId)) return res.status(403).json({ error: "You can't connect with this person." });
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
  res.json(await connectionDTO(c, req.user, req.ctx));
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
      // New messages have no readAt field at all; in an aggregation a missing
      // field isn't equal to null, so test with $ifNull (else unread is always 0).
      unread: { $sum: { $cond: [{ $and: [{ $eq: ["$toUserId", me] }, { $eq: [{ $ifNull: ["$readAt", null] }, null] }] }, 1, 0] } },
    } },
    { $sort: { "last.createdAt": -1 } },
    { $limit: 100 },
  ]);
  const visible = recent.filter((t) => !req.blocked.has(String(String(t.last.fromUserId) === String(me) ? t.last.toUserId : t.last.fromUserId)));
  const threads = await Promise.all(visible.map(async (t) => {
    const otherId = String(t.last.fromUserId) === String(me) ? t.last.toUserId : t.last.fromUserId;
    const other = await User.findById(otherId).select(CARD_SELECT).lean();
    return {
      user: (await cardsFor(req.user, [other]))[0] || { id: String(otherId), name: "Attendee" },
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
  if (!req.rights.sendMessages) return res.status(403).json({ error: RIGHT_ERRORS.sendMessages });
  const to = await User.findById(req.params.userId).select(`_id ${RIGHTS_SELECT}`);
  if (!to) return res.status(404).json({ error: "User not found" });
  if (req.blocked.has(String(to._id))) return res.status(403).json({ error: "You can't message this person." });
  // Without receiveMessages (types such as VIP, or the staff switch): only staff / moderators,
  // accepted connections, or a reply to someone who wrote first.
  const toRights = rightsFor(to, req.ctx);
  if (!toRights.receiveMessages && !overridesContact(req.user, req.rights)) {
    const [connected, theyWroteFirst] = await Promise.all([
      SocialConnection.exists({ status: "accepted", $or: [{ fromUserId: req.user._id, toUserId: to._id }, { fromUserId: to._id, toUserId: req.user._id }] }),
      SocialMessage.exists({ fromUserId: to._id, toUserId: req.user._id }),
    ]);
    if (!canMessage({ sender: req.user, recipient: to, senderRights: req.rights, recipientRights: toRights, connected: !!connected, theyWroteFirst: !!theyWroteFirst })) {
      return res.status(403).json({ error: messagesOffError(to) });
    }
  }
  const status = await statusFor(body, req.user._id, "message");
  const m = await SocialMessage.create({
    threadKey: threadKey(req.user._id, to._id), fromUserId: req.user._id, toUserId: to._id, body, status,
  });
  // Held messages wait for a moderator; only approved ones reach the phone.
  if (status === "approved") {
    pushToUsers([to._id], { title: req.user.name, body, link: "ttfc://tab/network", thread: `dm.${req.user._id}`, kind: "dm", id: String(m._id) });
  }
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

router.post("/sessions/:id/questions", requireSwitch(QA_KEY, "Q&A is closed right now."), async (req, res) => {
  const body = trimBody(req.body?.body, 600);
  if (!body) return res.status(400).json({ error: "body required" });
  const status = await statusFor(body, req.user._id, "question");
  const q = await SessionQuestion.create({
    sessionId: req.params.id, authorId: req.user._id, authorName: req.user.name, body, status, upvotes: [req.user._id],
  });
  res.status(201).json(questionDTO(q, req.user._id));
});

router.post("/sessions/questions/:qid/upvote", requireSwitch(QA_KEY, "Q&A is closed right now."), async (req, res) => {
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

router.post("/sessions/:id/polls/:pollId/vote", requireSwitch(POLLS_KEY, "Polls are closed right now."), async (req, res) => {
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

/* ================= MY ACTIVITY =================
   Likes, comments and mentions on the feed, replies in discussions you
   follow (those also push, see routes/community.js). The apps poll
   /activity/unread and show a dot on the tab until the person opens it
   (POST /activity/seen { section }). */

const seenTimes = (u) => ({ feed: u.activitySeen?.feed, discussions: u.activitySeen?.discussions });

router.get("/activity/unread", async (req, res) => {
  const seen = seenTimes(req.user);
  const [feed, discussions] = await Promise.all(ACTIVITY_SECTIONS.map((s) =>
    ActivityEvent.countDocuments(unreadFilter(req.user._id, s, seen, req.blocked))));
  res.json({ feed, discussions });
});

router.post("/activity/seen", async (req, res) => {
  const section = parseSection(req.body?.section);
  if (!section) return res.status(400).json({ error: "section must be feed or discussions" });
  const seenAt = new Date();
  await User.updateOne({ _id: req.user._id }, { $set: { [`activitySeen.${section}`]: seenAt } });
  res.json({ ok: true, section, seenAt });
});

router.get("/activity", async (req, res) => {
  const section = parseSection(req.query.section ?? "feed");
  if (!section) return res.status(400).json({ error: "section must be feed or discussions" });
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  const filter = { userId: req.user._id, section };
  if (req.blocked.size) filter.actorId = { $nin: [...req.blocked] };
  const rows = await ActivityEvent.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
  res.json(rows.map(activityDTO));
});

/* ================= MY NOTIFICATIONS =================
   Personal notifications staff sent from the admin panel, and (for staff)
   "Content reported" ones from POST /api/app/report. The apps poll this
   (on open and in the background) and show new ones as local notifications. */

router.get("/notifications", async (req, res) => {
  const filter = { userId: req.user._id };
  const since = parseSince(req.query.since);
  if (since) filter.createdAt = { $gt: since };
  const [rows, unread] = await Promise.all([
    AppNotification.find(filter).sort({ createdAt: -1 }).limit(100).lean(),
    AppNotification.countDocuments({ userId: req.user._id, readAt: null }),
  ]);
  res.json({ notifications: rows.map(notificationDTO), unread });
});

router.post("/notifications/read", async (req, res) => {
  const which = parseReadBody(req.body);
  if (!which) return res.status(400).json({ error: "ids or all required" });
  const filter = { userId: req.user._id, readAt: null };
  if (which.ids) filter._id = { $in: which.ids };
  const r = await AppNotification.updateMany(filter, { $set: { readAt: new Date() } });
  res.json({ ok: true, updated: r.modifiedCount ?? 0 });
});

/* ================= STAFF MODERATION =================
   Anyone with the moderate right (staff accounts always). */

router.get("/admin/held", needRight("moderate"), async (req, res) => {
  const [posts, comments, questions, messages] = await Promise.all([
    SocialPost.find({ status: "held" }).sort({ createdAt: -1 }).limit(100).lean(),
    SocialComment.find({ status: "held" }).sort({ createdAt: -1 }).limit(100).lean(),
    SessionQuestion.find({ status: "held" }).sort({ createdAt: -1 }).limit(100).lean(),
    SocialMessage.find({ status: "held" }).sort({ createdAt: -1 }).limit(100).lean(),
  ]);
  res.json({
    posts: posts.map((p) => postDTO(p, req.user._id, new Map(), { staff: true })),
    comments: comments.map((c) => ({ id: String(c._id), postId: String(c.postId), authorName: c.authorName, body: c.body, createdAt: c.createdAt })),
    questions: questions.map((q) => questionDTO(q, req.user._id)),
    messages: messages.map((m) => ({ id: String(m._id), body: m.body, createdAt: m.createdAt })),
  });
});

router.post("/admin/:type/:id/status", needRight("moderate"), async (req, res) => {
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
