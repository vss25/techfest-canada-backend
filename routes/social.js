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
import { rankFeed, PINNED_MS } from "../services/feedRank.js";
import { avatarUrls } from "../services/avatars.js";
import { requireSwitch, POLLS_KEY, QA_KEY } from "../services/liveSwitches.js";
import { sessionAllows, OFF_ERRORS } from "../services/sessionLive.js";
import { notificationDTO, parseSince, parseReadBody } from "../services/notifyHelpers.js";
import {
  threadKey, userCard, postDTO, tally, cleanImageData, trimBody, isOnApp,
  publicProfile, PROFILE_SELECT, CARD_SELECT, commentDTO, messageDTO, avatarFor,
} from "../services/socialHelpers.js";
import { RULES, LEVELS, standingFor, leaderboard, clampLimit, dropFromBoard } from "../services/points.js";
import { onRegistration } from "../services/sessionGroups.js";
import { orgKeyResolver } from "../services/organisations.js";
import { canMessage, canRequest, messagesOffError, requestsOffError } from "../services/contactSwitches.js";
import { contactAccess, applyAccess } from "../services/contactAccess.js";
import { cardsFor } from "../services/cards.js";
import { publicTier, typesTier } from "../services/teamRoles.js";
import { personAccess, rightsFor, overridesContact, rightError, RIGHT_ERRORS } from "../services/appRights.js";
import { rightsContext, RIGHTS_SELECT } from "../services/rightsStore.js";
import {
  CONTACT_SELECT, SHARE_OFF_ERROR, contactItemsFor, contactCardDTO, cleanItems, cleanShareIds, accountEmailOf,
  setShare, shareFields, legacyEmail, firstLinkedIn, applyQrShare,
} from "../services/contactCard.js";
import { makeLimiter } from "../services/ticketAccess.js";
import {
  viewerHide, isHiddenGuest, postForViewer, postsForViewer, hiddenCommentCounts, hiddenAmong, visible, unseenOf, oids,
} from "../services/appHide.js";
import {
  cleanMentions, mentionedUserIds, keepKnownMentions, buildActivity, toggleLike, unreadFilter,
  parseSection, activityDTO, removeMode, canViewPost, canInteractPost, POST_GONE, isRepeatPost, REPEAT_POST_MS, isObjectId, ACTIVITY_SECTIONS,
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
    if (user.banned) return res.status(403).json({ error: "This account is suspended. Contact enquire@thetechfestival.com." });
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
    // Hide from app (services/appHide.js): req.appHidden = they're hidden, so what they do reaches nobody (they
    // can't tell); req.shadow = the hidden people they don't see (none for staff and moderators); req.unseen =
    // blocks + shadow, for every read of other people and their things.
    let hide;
    try { hide = await viewerHide(user, req.rights); } catch (err) {
      console.error("APP HIDE ERROR:", err?.message || err);
      return res.status(503).json({ error: "Something went wrong. Try again." });
    }
    req.hide = hide;
    req.appHidden = hide.self;
    req.shadow = hide.ids;
    req.unseen = unseenOf(req.blocked, hide.ids);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}
router.use(requireUser);

/** 404 for a hidden person's things, the same answer as for something that isn't there. */
const isShadowed = (req, userId) => !!userId && req.shadow.has(String(userId));
/** A post's likes, like count, comment count and mentions as this viewer counts them (services/appHide.js). */
async function postView(req, post) {
  if (!req.shadow.size || !post) return post;
  return postForViewer(post, req.shadow, await hiddenCommentCounts([post], req.shadow));
}

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
/** The tier stored on the signed-in person's new post or comment: only "Speaker" or "Exhibitor" (their type). */
const authorTier = (req) => typesTier(req.types);

/* ================= ME / DIRECTORY ================= */

// isAdmin is staff only; role tells the apps a volunteer ("volunteer") from an attendee ("user").
// `types` = all their effective types (attendee included), `rights` = what they may do (services/appRights.js).
router.get("/me", async (req, res) => {
  const { exhibitors, matrix } = req.ctx;
  res.json({
    ...userCard(req.user, { exhibitors, matrix, self: true }), email: req.user.email, isAdmin: isAdmin(req.user), role: req.user.role || "user",
    types: req.types, rights: req.rights,
    contactCard: contactCardDTO(req.user, req.rights),
  });
});

/* ================= MY CONTACT CARD =================
   The ways people can reach me (services/contactCard.js). Only I see the
   whole list; others get just what I share with them (sharedContact on
   connection and person payloads). Values are never logged. */

const cardSaves = makeLimiter({ max: 30, windowMs: 10 * 60 * 1000 });
const shareSaves = makeLimiter({ max: 120, windowMs: 10 * 60 * 1000 });
const TOO_FAST = "Too many changes in a row. Try again in a few minutes.";

router.get("/contact-card", (req, res) => {
  res.json(contactCardDTO(req.user, req.rights));
});

router.put("/contact-card", async (req, res) => {
  if (!cardSaves.hit(String(req.user._id))) return res.status(429).json({ error: TOO_FAST });
  const out = cleanItems(req.body?.items, { accountEmail: accountEmailOf(req.user) });
  if (out.error) return res.status(400).json({ error: out.error, index: out.index });
  const before = contactItemsFor(req.user);
  const set = { contactItems: out.items, contactCardSavedAt: new Date() };
  // The first LinkedIn item is the profile LinkedIn (shown on the card, counted for points).
  const linkedIn = firstLinkedIn(out.items);
  if (linkedIn && linkedIn !== req.user.linkedinUrl) set.linkedinUrl = linkedIn;
  else if (!linkedIn && before.some((it) => it.kind === "linkedin") && req.user.linkedinUrl) set.linkedinUrl = "";
  await User.updateOne({ _id: req.user._id }, { $set: set });
  Object.assign(req.user, set);
  res.json({ ...contactCardDTO(req.user, req.rights), linkedinUrl: req.user.linkedinUrl || "" });
});

/* What people who scan my connect QR get (the QR sheet's checklist). Copied onto each
   in-person connection made by a scan of my QR, unless I'd already picked for that person. */
router.put("/contact-card/qr-share", async (req, res) => {
  if (!req.rights.shareContact) return res.status(403).json({ error: SHARE_OFF_ERROR });
  if (!shareSaves.hit(String(req.user._id))) return res.status(429).json({ error: TOO_FAST });
  const ids = cleanShareIds(req.body?.share, contactItemsFor(req.user));
  if (!ids) return res.status(400).json({ error: "share must be a list of contact detail ids" });
  await User.updateOne({ _id: req.user._id }, { $set: { contactQrShare: ids } });
  req.user.contactQrShare = ids;
  res.json(contactCardDTO(req.user, req.rights));
});

/** My share list from a request body (`share: [ids]`), or null when there's none or I can't share. */
function shareFromBody(req) {
  if (!req.rights.shareContact) return null;
  return cleanShareIds(req.body?.share, contactItemsFor(req.user));
}

// Attendees who have filled anything in (so the directory isn't every newsletter signup).
router.get("/users", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const filter = {
    _id: { $nin: [req.user._id, ...oids(req.shadow)] },
    directoryHidden: { $ne: true }, banned: { $ne: true },
    $or: [{ jobTitle: { $ne: "" } }, { organization: { $ne: "" } }, { "tickets.0": { $exists: true } },
      // Staff and volunteers on the app are listed (Network → Staff) even with an empty profile.
      { role: { $in: ["admin", "volunteer"] }, $or: [{ appOnboarded: true }, { lastActiveAt: { $exists: true } }] }],
  };
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$and = [{ $or: [{ name: rx }, { organization: rx }, { jobTitle: rx }] }];
  }
  const users = (await User.find(filter).select(CARD_SELECT).limit(60).lean()).filter((u) => !req.unseen.has(String(u._id)));
  res.json(await cardsFor(req.user, users));
});

/* Every ticket holder (app users + guest purchases), one entry per person,
   their most recent ticket as the pass. Guests not on the app yet can be
   seen but not messaged. Never returns email. */
router.get("/attendees", async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const [users, guests] = await Promise.all([
    User.find({ $or: [{ "tickets.0": { $exists: true } }, { appOnboarded: true }, { lastActiveAt: { $exists: true } }] })
      .select("name email role jobTitle organization linkedinUrl country topics tickets directoryHidden avatarVersion lastActiveAt appOnboarded tagline availabilitySlots meetingSpot availabilitySpots messagesOff requestsOff types typesOff vip").lean(),
    Attendee.find({ claimedBy: { $exists: false }, directoryHidden: { $ne: true } }).select(`name email ticketId ticketType purchaseDate promoCode exhibitor vip issuedPass.booth ${GUEST_DETAILS_SELECT}`).lean(),
  ]);
  const { exhibitors, matrix } = req.ctx;
  // Hidden people (and their passes not on the app yet) aren't in anyone else's directory.
  const listed = req.shadow.size ? users.filter((u) => !req.shadow.has(String(u._id))) : users;
  const passes = req.hide.passes.size || req.hide.emails.size ? guests.filter((g) => !isHiddenGuest(g, req.hide)) : guests;
  let people = buildDirectory(listed, passes, { excludeUserId: req.user._id, excludeEmail: req.user.email, exhibitors, matrix, avatarOf: avatarFor });
  if (q) people = people.filter((p) => [p.name, p.organization, p.jobTitle].some((s) => String(s || "").toLowerCase().includes(q)));
  people = people.filter((p) => !req.unseen.has(p.id));
  const shown = new Set(people.map((p) => p.id));
  const [access, orgKeyOf] = await Promise.all([
    contactAccess(req.user, users.filter((u) => shown.has(String(u._id))), req.ctx),
    orgKeyResolver(),
  ]);
  // `orgKey`: their organisation's key in GET /api/app/organisations ("" for none), for "who's coming" on its page.
  res.json(people.map((p) => ({ ...applyAccess(p, access), orgKey: orgKeyOf(p.organization, p.name) })));
});

/* One person's profile page: everything they filled in for others to see
   (publicProfile in services/socialHelpers.js), never email, phone, role or tickets.
   Plus, when we're connected: sharedContact (only the contact details they share
   with me), myShare / mySharePicked (what I share with them), connectionId / -Status. */
router.get("/users/:id", async (req, res) => {
  const id = String(req.params.id);
  if (!isObjectId(id) || req.unseen.has(id)) return res.status(404).json({ error: "Not found" });
  const u = await User.findById(id).select(`${PROFILE_SELECT} ${CONTACT_SELECT} directoryHidden banned`).lean();
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
  const [access, conn] = await Promise.all([
    contactAccess(req.user, [u], req.ctx),
    self ? null : SocialConnection.findOne({ $or: [{ fromUserId: req.user._id, toUserId: u._id }, { fromUserId: u._id, toUserId: req.user._id }] }).lean(),
  ]);
  const profile = applyAccess(publicProfile(u, { exhibitors: req.ctx.exhibitors, matrix: req.ctx.matrix, self }), access);
  // What they share with me and what I share with them (accepted connections show details).
  const share = shareFields(conn, { viewer: req.user, viewerRights: req.rights, other: u, otherRights: rightsFor(u, req.ctx) });
  res.json({ ...profile, connectionId: conn ? String(conn._id) : "", connectionStatus: conn?.status || "", ...share });
});

/* What I share with someone I'm connected to (or asked to connect): `share` = my contact
   card item ids. Any time, from their profile or the chat header. */
router.put("/users/:id/share", async (req, res) => {
  const id = String(req.params.id);
  if (!isObjectId(id) || id === String(req.user._id) || isShadowed(req, id)) return res.status(404).json({ error: "Not found" });
  if (!req.rights.shareContact) return res.status(403).json({ error: SHARE_OFF_ERROR });
  if (!shareSaves.hit(String(req.user._id))) return res.status(429).json({ error: TOO_FAST });
  const ids = cleanShareIds(req.body?.share, contactItemsFor(req.user));
  if (!ids) return res.status(400).json({ error: "share must be a list of contact detail ids" });
  const c = await SocialConnection.findOne({ status: { $ne: "declined" }, $or: [{ fromUserId: req.user._id, toUserId: id }, { fromUserId: id, toUserId: req.user._id }] });
  if (!c) return res.status(404).json({ error: "Connect first, then you can share your contact details." });
  setShare(c, req.user._id, ids);
  await c.save();
  res.json(await connectionDTO(c, req));
});

/* ================= FEED ================= */

/* Which posts: the newest `limit` this viewer may see, plus official announcements from the last 48 h (pinned on
   top). The ranking (engagement, a small daily shuffle) only orders them. Until Oct 22 2026 the newest 300 were
   ranked and the top `limit` kept, so a post could drop out of a feed it had just been in when others gained likes
   or the day's shuffle changed (and a brand-new one with no likes could miss a busy feed). Now a post leaves the
   page only once `limit` newer posts are there, or when it's deleted, taken down or its author can't be seen. */
router.get("/feed", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const since = req.query.since ? new Date(String(req.query.since)) : null;
  const after = since && !isNaN(since) ? since : null;
  const filter = { $or: [{ status: "approved" }, { authorId: req.user._id, status: "held" }] };
  if (req.unseen.size) filter.authorId = { $nin: oids(req.unseen) };
  const pinCutoff = new Date(Date.now() - PINNED_MS);
  const [newest, pinned] = await Promise.all([
    SocialPost.find(after ? { ...filter, createdAt: { $gt: after } } : filter).sort({ createdAt: -1 }).limit(limit).lean(),
    SocialPost.find({ ...filter, kind: "announcement", createdAt: { $gt: after && after > pinCutoff ? after : pinCutoff } })
      .sort({ createdAt: -1 }).limit(10).lean(),
  ]);
  const seen = new Set(newest.map((p) => String(p._id)));
  let page = [...newest, ...pinned.filter((p) => !seen.has(String(p._id)))];
  // More than `limit` with the extra announcements: the oldest other posts make room.
  if (page.length > limit) {
    const extra = page.length - limit;
    const drop = new Set(newest.filter((p) => p.kind !== "announcement").slice(-extra).map((p) => String(p._id)));
    page = page.filter((p) => !drop.has(String(p._id)));
  }
  // Likes and comments from hidden people don't count for this viewer (nor in the ranking).
  const posts = rankFeed(await postsForViewer(page, req.shadow), req.user._id);
  const avatars = await avatarUrls(posts.map((p) => p.authorId));
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
  const mine = new Map([[String(req.user._id), avatarFor(req.user)]]);
  // The same post sent again within two minutes (a retry after a lost answer): that post back, not a second copy.
  const recent = await SocialPost.find({ authorId: req.user._id, body, linkUrl, status: { $ne: "hidden" },
    createdAt: { $gt: new Date(Date.now() - REPEAT_POST_MS) } }).sort({ createdAt: -1 }).limit(3).lean();
  const repeat = recent.find((p) => isRepeatPost(p, { body, linkUrl, imageData, media }));
  if (repeat) return res.status(201).json(postDTO(repeat, req.user._id, mine, { staff: req.rights.deleteAnyPost }));
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
  // Held posts aren't visible to anyone else yet, so nobody hears about them; nor about a hidden person's.
  if (status === "approved" && !req.appHidden) {
    recordActivity(buildActivity({ kind: "mention", section: "feed", actorId: req.user._id, actorName: req.user.name,
      refId: post._id, recipients: mentionedUserIds(mentions), blocked: req.blocked }));
  }
  res.status(201).json(postDTO(post, req.user._id, mine, { staff: req.rights.deleteAnyPost }));
});

/** One post (opened from an activity row, a mention or a shared link). */
router.get("/feed/:id", async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const post = await SocialPost.findById(req.params.id).lean();
  if (!canViewPost(post, req.user, req.unseen, req.rights)) return res.status(404).json({ error: "Not found" });
  const avatars = await avatarUrls([post.authorId]);
  res.json(postDTO(await postView(req, post), req.user._id, avatars, { staff: req.rights.deleteAnyPost }));
});

/* The author deletes their own post (gone, with its comments); people with
   deleteAnyPost (staff) remove anyone else's (kept as status "hidden" with removedBy/removedAt). */
router.delete("/feed/:id", async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const post = await SocialPost.findById(req.params.id);
  if (!post || isShadowed(req, post.authorId)) return res.status(404).json({ error: "Not found" });
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

/* Likes and comments: anyone who can see the post (canInteractPost, the same rule as the feed and GET /feed/:id).
   Written atomically: until Oct 22 2026 both saved the whole post, so two likes at once failed one with a 500
   (a version clash) and two comments at once lost one from commentCount. */
router.post("/feed/:id/like", async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(404).json({ error: POST_GONE });
  const me = req.user._id;
  for (let attempt = 0; attempt < 3; attempt++) {
    const post = await SocialPost.findById(req.params.id).select("authorId status likes").lean();
    if (!canInteractPost(post, req.user, req.unseen, req.rights)) return res.status(404).json({ error: POST_GONE });
    const wasLiked = (post.likes || []).some((l) => String(l) === String(me));
    // Only if it's still as read (else another tap of theirs won the race: read again).
    const before = await SocialPost.findOneAndUpdate(
      { _id: post._id, likes: wasLiked ? me : { $ne: me } },
      wasLiked
        ? { $pull: { likes: me }, $addToSet: { everLiked: me }, $inc: { likeCount: -1 } }
        : { $addToSet: { likes: me, everLiked: me }, $inc: { likeCount: 1 } },
      { returnDocument: "before", projection: { likes: 1, everLiked: 1 } },
    ).lean();
    if (!before) continue;
    const t = toggleLike({ likes: before.likes || [], everLiked: before.everLiked || [], actorId: me });
    // Only someone's first-ever like tells the author (not an unlike + relike); a hidden person's never does.
    if (t.firstLike && !req.appHidden) {
      recordActivity(buildActivity({ kind: "like", section: "feed", actorId: me, actorName: req.user.name,
        refId: post._id, recipients: [post.authorId], blocked: req.blocked }));
    }
    return res.json({ liked: t.liked, likeCount: Math.max(0, t.likes.length - hiddenAmong(t.likes, req.shadow)) });
  }
  res.status(409).json({ error: "That didn't go through. Try again." });
});

router.get("/feed/:id/comments", async (req, res) => {
  if (!isObjectId(req.params.id)) return res.json([]);
  // A hidden person's post has no comments for anyone else (the post itself is "not found").
  if (req.shadow.size) {
    const post = await SocialPost.findById(req.params.id).select("authorId").lean();
    if (post && isShadowed(req, post.authorId)) return res.json([]);
  }
  const comments = await SocialComment.find({
    postId: req.params.id,
    $or: [{ status: "approved" }, { authorId: req.user._id, status: "held" }],
  }).sort({ createdAt: 1 }).lean();
  const shown = comments.filter((c) => !req.unseen.has(String(c.authorId)));
  // Each author's kind now (the directory's), so a speaker keeps their badge whatever their pass says.
  const authors = new Map((await User.find({ _id: { $in: [...new Set(shown.map((c) => String(c.authorId)))] } }).select(CARD_SELECT).lean())
    .map((u) => [String(u._id), u]));
  res.json(shown.map((c) => commentDTO(c, authors.get(String(c.authorId)) || null, req.ctx)));
});

router.post("/feed/:id/comments", needRight("comment"), async (req, res) => {
  const body = trimBody(req.body?.body, 2000);
  if (!body) return res.status(400).json({ error: "body required" });
  if (!isObjectId(req.params.id)) return res.status(404).json({ error: POST_GONE });
  let post = await SocialPost.findById(req.params.id).select("authorId status commentCount").lean();
  if (!canInteractPost(post, req.user, req.unseen, req.rights)) return res.status(404).json({ error: POST_GONE });
  const status = await statusFor(body, req.user._id, "comment");
  const c = await SocialComment.create({
    postId: post._id, authorId: req.user._id, authorName: req.user.name,
    authorTier: authorTier(req), body, status,
  });
  if (status === "approved") {
    // Counted as usual (so the person who wrote it sees the count go up); other viewers' counts leave hidden people out.
    post = await SocialPost.findOneAndUpdate({ _id: post._id }, { $inc: { commentCount: 1 } },
      { returnDocument: "after", projection: { authorId: 1, commentCount: 1 } }).lean();
    // Deleted while the comment was being checked: take the comment back.
    if (!post) {
      await SocialComment.deleteOne({ _id: c._id });
      return res.status(404).json({ error: POST_GONE });
    }
    if (!req.appHidden) {
      recordActivity(buildActivity({ kind: "comment", section: "feed", actorId: req.user._id, actorName: req.user.name,
        refId: post._id, recipients: [post.authorId], blocked: req.blocked }));
    }
  }
  const counted = req.shadow.size ? (await hiddenCommentCounts([post], req.shadow)).get(String(post._id)) || 0 : 0;
  res.status(201).json({ ...commentDTO(c.toObject(), req.user, req.ctx), commentCount: Math.max(0, post.commentCount - counted) });
});

/* ================= CONNECTIONS ================= */

/** For the signed-in person (`req.user`, `req.ctx`, `req.rights`, `req.blocked`). */
async function connectionDTO(c, req) {
  const viewer = req.user;
  const meId = viewer._id;
  const otherId = String(c.fromUserId) === String(meId) ? c.toUserId : c.fromUserId;
  const other = await User.findById(otherId).select(`${CARD_SELECT} ${CONTACT_SELECT}`).lean();
  // Contact details: only what each side chose to share (services/contactCard.js), only once
  // accepted, only from people whose types share them (shareContact), never across a block.
  const share = shareFields(c, {
    viewer, viewerRights: req.rights, other, otherRights: other ? rightsFor(other, req.ctx) : null,
    blocked: (req.unseen || req.blocked)?.has(String(otherId)),
  });
  const inPerson = c.status === "accepted" && c.kind === "inPerson";
  const email = legacyEmail(share.sharedContact);
  return {
    id: String(c._id),
    user: (await cardsFor(viewer, [other]))[0] || { id: String(otherId), name: "Attendee" },
    direction: String(c.fromUserId) === String(meId) ? "outgoing" : "incoming",
    status: c.status, kind: c.kind, note: c.note || "",
    createdAt: c.createdAt, respondedAt: c.respondedAt,
    ...share,
    // Older app builds read these two on in-person rows only.
    email: inPerson ? email : undefined,
    contactShared: inPerson ? share.sharedContact.length > 0 : undefined,
  };
}

router.get("/connections", async (req, res) => {
  const me = req.user._id;
  const all = (await SocialConnection.find({ $or: [{ fromUserId: me }, { toUserId: me }], status: { $ne: "declined" } })
    .sort({ updatedAt: -1 }).lean())
    // Hidden people aren't in anyone else's connections, requests either way included.
    .filter((c) => !isShadowed(req, String(c.fromUserId) === String(me) ? c.toUserId : c.fromUserId));
  const items = await Promise.all(all.map((c) => connectionDTO(c, req)));
  res.json({
    accepted: items.filter((c) => c.status === "accepted"),
    incoming: items.filter((c) => c.status === "pending" && c.direction === "incoming"),
    outgoing: items.filter((c) => c.status === "pending" && c.direction === "outgoing"),
  });
});

router.post("/connections/request", async (req, res) => {
  const toUserId = String(req.body?.toUserId || "");
  if (!toUserId || toUserId === String(req.user._id)) return res.status(400).json({ error: "toUserId required" });
  // A hidden person can't be asked: the same answer as someone who isn't there.
  if (isShadowed(req, toUserId)) return res.status(404).json({ error: "User not found" });
  const target = await User.findById(toUserId).select(`_id lastActiveAt appOnboarded ${RIGHTS_SELECT}`);
  if (!target) return res.status(404).json({ error: "User not found" });
  if (!isOnApp(target)) return res.status(409).json({ error: "They haven't joined the app yet. You can connect once they sign in." });
  const existing = await SocialConnection.findOne({
    $or: [{ fromUserId: req.user._id, toUserId }, { fromUserId: toUserId, toUserId: req.user._id }],
  });
  const share = shareFromBody(req);
  if (existing) {
    // Mutual interest → accept instead of duplicating
    const accepting = existing.status === "pending" && String(existing.toUserId) === String(req.user._id);
    if (accepting) { existing.status = "accepted"; existing.respondedAt = new Date(); }
    if (share) setShare(existing, req.user._id, share);
    if (accepting || share) await existing.save();
    if (accepting && !req.appHidden) {
      pushToUsers([existing.fromUserId], { title: `${req.user.name} accepted your request`, body: "You're connected — say hello.", link: "ttfc://tab/network", kind: "conn", id: String(existing._id) }, { from: req.user._id });
    }
    return res.json(await connectionDTO(existing, req));
  }
  // New requests need the sender's sendRequests and the target's receiveRequests (types + staff switch,
  // e.g. VIPs; staff and moderators may still ask). Rows above (theirs included) still work.
  if (!req.rights.sendRequests) return res.status(403).json({ error: RIGHT_ERRORS.sendRequests });
  if (!canRequest({ sender: req.user, target, senderRights: req.rights, targetRights: rightsFor(target, req.ctx) })) {
    return res.status(403).json({ error: requestsOffError(target) });
  }
  const c = new SocialConnection({ fromUserId: req.user._id, toUserId, note: trimBody(req.body?.note, 300) });
  if (share) setShare(c, req.user._id, share);
  await c.save();
  // A hidden person's request is saved (they see it as sent) but never reaches anyone.
  if (!req.blocked.has(toUserId) && !req.appHidden) {
    pushToUsers([toUserId], { title: `${req.user.name} wants to connect`, body: [req.user.jobTitle, req.user.organization].filter(Boolean).join(" · ") || "Open TTFC to respond.", link: "ttfc://tab/network", kind: "conn", id: String(c._id) }, { from: req.user._id });
  }
  res.status(201).json(await connectionDTO(c, req));
});

router.post("/connections/:id/respond", async (req, res) => {
  const c = await SocialConnection.findById(req.params.id);
  if (!c || String(c.toUserId) !== String(req.user._id) || isShadowed(req, c.fromUserId)) return res.status(404).json({ error: "Not found" });
  c.status = req.body?.accept ? "accepted" : "declined";
  c.respondedAt = new Date();
  const share = c.status === "accepted" ? shareFromBody(req) : null;
  if (share) setShare(c, req.user._id, share);
  await c.save();
  if (c.status === "accepted" && !req.appHidden) {
    pushToUsers([c.fromUserId], { title: `${req.user.name} accepted your request`, body: "You're connected — say hello.", link: "ttfc://tab/network", kind: "conn", id: String(c._id) }, { from: req.user._id });
  }
  res.json(await connectionDTO(c, req));
});

/* Withdraw a request you sent that hasn't been accepted yet. */
router.post("/connections/:id/withdraw", async (req, res) => {
  const c = await SocialConnection.findById(req.params.id).catch(() => null);
  if (!c || String(c.fromUserId) !== String(req.user._id)) return res.status(404).json({ error: "Request not found" });
  if (c.status !== "pending") return res.status(409).json({ error: "This request was already answered" });
  await c.deleteOne();
  res.json({ withdrawn: true, id: String(c._id) });
});

/* Badge scan: both parties connected at once, whatever their request rights. The scanner
   picks what they share (`share`); the person scanned shares what their connect QR sheet
   says (contactQrShare), else their "share by default" items, until they pick
   (services/contactCard.js). Only with the shareContact right. */
router.post("/connections/in-person", async (req, res) => {
  const toUserId = String(req.body?.toUserId || "");
  if (!toUserId || toUserId === String(req.user._id)) return res.status(400).json({ error: "toUserId required" });
  // A hidden person's connect QR works like an unknown code: no connection, nothing shown.
  if (isShadowed(req, toUserId)) return res.status(404).json({ error: "User not found" });
  if (req.blocked.has(toUserId)) return res.status(403).json({ error: "You can't connect with this person." });
  const target = await User.findById(toUserId).select(`_id ${RIGHTS_SELECT} ${CONTACT_SELECT}`).lean();
  if (!target) return res.status(404).json({ error: "User not found" });
  let c = await SocialConnection.findOne({
    $or: [{ fromUserId: req.user._id, toUserId }, { fromUserId: toUserId, toUserId: req.user._id }],
  });
  if (!c && !isOnApp(await User.findById(toUserId).select("lastActiveAt appOnboarded").lean())) {
    return res.status(409).json({ error: "They haven't joined the app yet. You can connect once they sign in." });
  }
  if (!c) c = new SocialConnection({ fromUserId: req.user._id, toUserId });
  c.status = "accepted"; c.kind = "inPerson"; c.respondedAt = new Date();
  const share = shareFromBody(req);
  if (share) setShare(c, req.user._id, share);
  // The person scanned shares what their connect QR sheet says, if they hadn't picked for this person.
  applyQrShare(c, target, rightsFor(target, req.ctx));
  await c.save();
  res.json(await connectionDTO(c, req));
});

/* ================= MESSAGES =================
   Read receipts (Oct 21 2026): a message to me is delivered once my app fetches it (the chat list, or the
   chat with or without ?peek=1) and read once the chat is on screen (GET /messages/:userId without peek; the
   apps' background refreshes send peek=1). Only approved ones, only from people I can see (never from someone
   hidden from the app or anyone blocked either way). The sender sees ✓ / ✓✓ / blue ✓✓ from deliveredAt /
   readAt on their own messages (messageDTO). Someone hidden from the app, or blocked by the other person,
   can't tell: their messages read as delivered, never read. */

/** Their messages to me can't reveal anything to me: I'm hidden from the app, or one of us blocked the other. */
const receiptsMasked = (req, otherId) => !!req.appHidden || req.blocked.has(String(otherId));

/** Everything addressed to me that I may see has reached my app: one update on the { toUserId, deliveredAt }
    index, which only walks what's still undelivered (nothing, on most polls). A read message keeps its readAt. */
async function markDelivered(req) {
  const filter = { toUserId: req.user._id, deliveredAt: null, status: "approved" };
  if (req.unseen.size) filter.fromUserId = { $nin: oids(req.unseen) };
  try {
    await SocialMessage.updateMany(filter, [{ $set: { deliveredAt: { $ifNull: ["$readAt", new Date()] } } }], { updatePipeline: true });
  } catch (err) {
    console.error("MESSAGE DELIVERED ERROR:", err?.message || err);
  }
}

router.get("/messages", async (req, res) => {
  const me = req.user._id;
  await markDelivered(req);
  const recent = await SocialMessage.aggregate([
    // Mine (not ones staff took down) and approved ones to me: someone's held message isn't shown or counted
    // as unread until a moderator approves it, the same as in the chat itself.
    { $match: { $or: [{ fromUserId: me, status: { $ne: "hidden" } }, { toUserId: me, status: "approved" }] } },
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
  // A chat with a hidden person isn't in anyone else's list (nor its unread count).
  const shown = recent.filter((t) => !req.unseen.has(String(String(t.last.fromUserId) === String(me) ? t.last.toUserId : t.last.fromUserId)));
  const threads = await Promise.all(shown.map(async (t) => {
    const otherId = String(t.last.fromUserId) === String(me) ? t.last.toUserId : t.last.fromUserId;
    const other = await User.findById(otherId).select(CARD_SELECT).lean();
    const { id, ...lastMessage } = messageDTO(t.last, me, { masked: receiptsMasked(req, otherId) });
    return {
      user: (await cardsFor(req.user, [other]))[0] || { id: String(otherId), name: "Attendee" },
      // { body, sentByMe, status, createdAt, deliveredAt, readAt }: the apps put the ticks before the preview.
      lastMessage,
      unread: t.unread,
    };
  }));
  res.json(threads);
});

router.get("/messages/:userId", async (req, res) => {
  if (req.unseen.has(String(req.params.userId))) return res.json([]);
  const key = threadKey(req.user._id, req.params.userId);
  const since = req.query.since ? new Date(String(req.query.since)) : null;
  const filter = { threadKey: key, $or: [{ status: "approved" }, { fromUserId: req.user._id }] };
  if (since && !isNaN(since)) filter.createdAt = { $gt: since };
  const msgs = await SocialMessage.find(filter).sort({ createdAt: 1 }).limit(500).lean();
  const now = new Date();
  if (req.query.peek === "1") {
    // ?peek=1: the apps refreshing a chat in the background (launch, foreground, a timer). Delivered, not read.
    await SocialMessage.updateMany({ threadKey: key, toUserId: req.user._id, status: "approved", deliveredAt: null },
      [{ $set: { deliveredAt: { $ifNull: ["$readAt", now] } } }], { updatePipeline: true });
  } else {
    // The chat on screen: their approved messages to me are read now, and delivered if they weren't yet.
    await SocialMessage.updateMany({ threadKey: key, toUserId: req.user._id, status: "approved", readAt: null },
      [{ $set: { readAt: now, deliveredAt: { $ifNull: ["$deliveredAt", now] } } }], { updatePipeline: true });
  }
  const masked = receiptsMasked(req, req.params.userId);
  res.json(msgs.map((m) => messageDTO(m, req.user._id, { masked })));
});

router.post("/messages/:userId", async (req, res) => {
  const body = trimBody(req.body?.body, 2000);
  if (!body) return res.status(400).json({ error: "body required" });
  if (!req.rights.sendMessages) return res.status(403).json({ error: RIGHT_ERRORS.sendMessages });
  const to = await User.findById(req.params.userId).select(`_id ${RIGHTS_SELECT}`);
  if (!to || isShadowed(req, to._id)) return res.status(404).json({ error: "User not found" });
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
  // Held messages wait for a moderator; only approved ones reach the phone. A hidden person's are saved and shown
  // to them as sent, but the other person never gets them (left out of their chats, unread counts and pushes).
  if (status === "approved" && !req.appHidden) {
    pushToUsers([to._id], { title: req.user.name, body, link: "ttfc://tab/network", thread: `dm.${req.user._id}`, kind: "dm", id: String(m._id) }, { from: req.user._id });
  }
  res.status(201).json(messageDTO(m.toObject(), req.user._id, { masked: req.appHidden }));
});

/* A held message a moderator approves reaches the phone then (the push it would have had when sent), unless one of
   them has blocked the other since; services/push.js drops it when the sender is hidden from the app. */
async function pushApprovedMessage(m) {
  try {
    const [from, blocked] = await Promise.all([
      User.findById(m.fromUserId).select("name").lean(),
      Block.exists({ $or: [{ userId: m.fromUserId, blockedId: m.toUserId }, { userId: m.toUserId, blockedId: m.fromUserId }] }),
    ]);
    if (!from || blocked) return;
    pushToUsers([m.toUserId], { title: from.name, body: m.body, link: "ttfc://tab/network", thread: `dm.${m.fromUserId}`, kind: "dm", id: String(m._id) }, { from: m.fromUserId });
  } catch (err) {
    console.error("APPROVED MESSAGE PUSH ERROR:", err?.message || err);
  }
}

/* ================= SESSIONS: REGISTRATIONS ================= */

router.get("/sessions/registrations", async (req, res) => {
  const [mine, counts] = await Promise.all([
    SessionRegistration.find({ userId: req.user._id }).select("sessionId").lean(),
    SessionRegistration.aggregate([
      ...(req.shadow.size ? [{ $match: { userId: { $nin: oids(req.shadow) } } }] : []),
      { $group: { _id: "$sessionId", n: { $sum: 1 } } },
    ]),
  ]);
  const countMap = {};
  for (const c of counts) countMap[c._id] = c.n;
  res.json({ mine: mine.map((r) => r.sessionId), counts: countMap });
});

/* Toggle. The session's chat follows (services/sessionGroups.js): once it exists, registering before the session
   ends adds them to it; un-registering before it starts takes them out. */
router.post("/sessions/:id/register", async (req, res) => {
  const sessionId = String(req.params.id);
  const existing = await SessionRegistration.findOne({ userId: req.user._id, sessionId });
  if (existing) await existing.deleteOne();
  else await SessionRegistration.create({ userId: req.user._id, sessionId });
  await onRegistration(req.user._id, sessionId, !existing);
  const count = await SessionRegistration.countDocuments({ sessionId, ...(req.shadow.size ? { userId: { $nin: oids(req.shadow) } } : {}) });
  res.json({ registered: !existing, count });
});

/* ================= SESSIONS: LIVE (Q&A + POLLS) =================
   Two layers of switches. Global: flag.polls / flag.qa (requireSwitch, 403
   {error: "closed", message}). Per session: the Sanity session's `polls` / `qa`
   ("auto" | "on" | "off", rule in services/sessionLive.js). A session with its
   switch off refuses writes for everyone with 403 {error: OFF_ERRORS[feature]}.
   Reads there: staff (role admin or the moderate right) see everything as
   before; everyone else gets an empty state (no questions, zero poll counts)
   so older app builds that don't read the switch just show nothing. */

const seesAllLive = (req) => isAdmin(req.user) || !!req.rights?.moderate;

/** Express guard: 403 when this session's switch for `feature` is off. */
const requireSessionFeature = (feature) => async (req, res, next) => {
  if (await sessionAllows(req.params.id, feature)) return next();
  res.status(403).json({ error: OFF_ERRORS[feature] });
};

/** `shadow`: hidden people whose upvotes don't count for this viewer. */
const questionDTO = (q, me, shadow) => ({
  id: String(q._id), sessionId: q.sessionId, authorId: String(q.authorId), authorName: q.authorName,
  body: q.body, upvotes: visible(q.upvotes, shadow).length,
  upvotedByMe: (q.upvotes || []).some((u) => String(u) === String(me)),
  sentByMe: String(q.authorId) === String(me), status: q.status, createdAt: q.createdAt,
});

router.get("/sessions/:id/questions", async (req, res) => {
  if (!seesAllLive(req) && !(await sessionAllows(req.params.id, "qa"))) return res.json([]);
  const qs = await SessionQuestion.find({
    sessionId: req.params.id,
    $or: [{ status: "approved" }, { authorId: req.user._id }],
  }).sort({ createdAt: -1 }).limit(200).lean();
  res.json(qs.filter((q) => !isShadowed(req, q.authorId)).map((q) => questionDTO(q, req.user._id, req.shadow)));
});

router.post("/sessions/:id/questions", requireSwitch(QA_KEY, "Q&A is closed right now."), requireSessionFeature("qa"), async (req, res) => {
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
  if (!q || isShadowed(req, q.authorId)) return res.status(404).json({ error: "Not found" });
  if (!(await sessionAllows(q.sessionId, "qa"))) return res.status(403).json({ error: OFF_ERRORS.qa });
  const me = String(req.user._id);
  const i = q.upvotes.findIndex((u) => String(u) === me);
  if (i >= 0) q.upvotes.splice(i, 1); else q.upvotes.push(req.user._id);
  await q.save();
  res.json(questionDTO(q, req.user._id, req.shadow));
});

/* ================= SESSIONS: POLLS ================= */

router.get("/sessions/:id/polls/:pollId/results", async (req, res) => {
  const optionCount = Math.min(Math.max(Number(req.query.options) || 4, 1), 16);
  if (!seesAllLive(req) && !(await sessionAllows(req.params.id, "polls"))) {
    return res.json({ counts: tally([], optionCount), total: 0, myVote: null });
  }
  const votes = (await SessionVote.find({ sessionId: req.params.id, pollId: req.params.pollId }).select("optionIndex userId").lean())
    .filter((v) => !isShadowed(req, v.userId));   // hidden people's votes don't count for anyone else
  const mine = votes.find((v) => String(v.userId) === String(req.user._id));
  res.json({ counts: tally(votes, optionCount), total: votes.length, myVote: mine ? mine.optionIndex : null });
});

router.post("/sessions/:id/polls/:pollId/vote", requireSwitch(POLLS_KEY, "Polls are closed right now."), requireSessionFeature("polls"), async (req, res) => {
  const optionIndex = Number(req.body?.optionIndex);
  if (!Number.isInteger(optionIndex) || optionIndex < 0) return res.status(400).json({ error: "optionIndex required" });
  const optionCount = Math.min(Math.max(Number(req.body?.options) || 4, 1), 16);
  try {
    await SessionVote.create({ sessionId: req.params.id, pollId: req.params.pollId, userId: req.user._id, optionIndex });
  } catch (err) {
    if (err?.code !== 11000) throw err;   // already voted → return results as-is
  }
  const votes = (await SessionVote.find({ sessionId: req.params.id, pollId: req.params.pollId }).select("optionIndex userId").lean())
    .filter((v) => !isShadowed(req, v.userId));
  const mine = votes.find((v) => String(v.userId) === String(req.user._id));
  res.json({ counts: tally(votes, optionCount), total: votes.length, myVote: mine ? mine.optionIndex : null });
});

/* ================= POINTS =================
   Gamification. Points are worked out from what's already stored
   (services/points.js), never reported by the app. Staff, banned people and
   anyone who opted out (here, or from the directory) stay off the leaderboard
   but still see their own points. Never returns email or role. */

router.get("/points/me", async (req, res) => {
  const { score, rank } = await standingFor(req.user);
  res.json({
    total: score.total, level: score.level, nextLevel: score.nextLevel, toNext: score.toNext,
    breakdown: score.breakdown, activity: score.activity, rank, rules: RULES, levels: LEVELS,
    hideFromLeaderboard: !!req.user.hideFromLeaderboard,
  });
});

router.get("/points/leaderboard", async (req, res) => {
  const limit = clampLimit(req.query.limit);
  // Hidden people aren't on anyone else's board; a hidden person still sees themself on theirs. Someone who just
  // switched "Show me on the leaderboard" back on sees themself at once too (others on the next rebuild, ≤ 60 s).
  // standingFor loads the cached board first, so leaderboard() reuses it.
  const st = await standingFor(req.user);
  const entries = await leaderboard(limit, { exclude: req.unseen, self: { user: req.user, points: st.score.total, level: st.score.level } });
  res.json({ entries, me: { rank: st.rank, points: st.score.total } });
});

/* "Show me on the leaderboard" (Oct 21 2026: the apps flip it on the first tap and trust this answer).
   { hideFromLeaderboard: true|false } → { hideFromLeaderboard } as saved in the database (read back from the
   write, never echoed). Idempotent: the same value again changes nothing and answers the same. One write, no
   recount: opting out takes them off the cached board now, opting in shows on the next rebuild. */
router.patch("/points/prefs", async (req, res) => {
  const hide = req.body?.hideFromLeaderboard;
  if (typeof hide !== "boolean") return res.status(400).json({ error: "hideFromLeaderboard must be true or false" });
  const saved = await User.findOneAndUpdate({ _id: req.user._id }, { $set: { hideFromLeaderboard: hide } },
    { returnDocument: "after", projection: { hideFromLeaderboard: 1 } }).lean();
  if (!saved) return res.status(401).json({ error: "Unauthorized" });
  if (saved.hideFromLeaderboard === true) dropFromBoard(req.user._id);
  res.json({ hideFromLeaderboard: saved.hideFromLeaderboard === true });
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
    ActivityEvent.countDocuments(unreadFilter(req.user._id, s, seen, req.unseen))));
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
  if (req.unseen.size) filter.actorId = { $nin: [...req.unseen] };
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
  if (Model === SocialMessage && was === "held" && status === "approved") pushApprovedMessage(doc);
  res.json({ ok: true, id: String(doc._id), status });
});

export default router;
