import mongoose from "mongoose";
import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import { SocialPost, SocialComment, SocialConnection, SocialMessage, SessionQuestion } from "../models/Social.js";
import { Discussion, DiscussionReply, CommunityGroup, GroupMessage } from "../models/Community.js";
import ActivityEvent from "../models/ActivityEvent.js";
import { PLACEHOLDER, cleanReason, countMap, postForViewer, seesHidden, shadowFor } from "./appHideRules.js";

export * from "./appHideRules.js";

/* =========================================================
   "Hide from app" (shadow mode), Oct 21 2026
   ---------------------------------------------------------
   The organiser: "Once hidden, they should not show up on the network
   tab. They should be able to send messages, but the receiving person
   shouldn't receive any messages ... they shouldn't be able to post on
   the feed page." Done on the server only, so the iOS app, the Android
   app and the web app all follow without a new release.

   Staff hide a person (Admin › People › their profile). The person is
   never told and nothing looks different to them: their pass, check-in,
   agenda and Wallet work, they can post, comment, react, message,
   connect and vote, and see all of it as usual. Nobody else sees any of
   it, past or future, and none of it counts or notifies:

     • they're gone from every list of people (directory, search, group
       members, connections, the leaderboard); their profile, chats and
       badge QR answer like someone who isn't there;
     • their posts, comments, replies, discussions, groups, messages,
       questions, likes, votes, upvotes, follows and joins are left out
       of everything others read, and of every count others see;
     • nothing they do pushes, makes an activity row or alerts anyone.

   Filtered when read, never deleted, so unhiding brings it all back
   from that moment (the unhide dialog can soft-delete what they posted
   while hidden: status "hidden", the same state staff "Hide" uses).
   Staff accounts (role admin) and anyone with the moderate right see
   everything, labelled in the admin panel.

   Stored as `appHidden: { at, by, byName, reason }` (select: false, so
   no response the person gets can carry it) on their account, and on
   their passes too so a pass-only person stays hidden when they sign
   in later: accounts that claimed or hold a hidden pass are hidden.
   Every change is audited by the route (app_hide / app_unhide).
========================================================= */

const str = (v) => String(v ?? "");
const lower = (v) => str(v).trim().toLowerCase();

/* ================= THE HIDDEN SET (cached) =================
   Every app request reads it, so it's kept for a few seconds per process and
   dropped at once on this server when staff change someone (forgetHidden). A
   failed read keeps the last good copy; with none yet it throws (the routes
   answer 503 rather than show hidden people). */

const TTL_MS = 10_000;
const RETRY_MS = 2_000;
let cache = { at: 0, value: null, pending: null, gen: 0, retryAt: 0 };
const listeners = new Set();

async function loadHidden() {
  const [users, passes] = await Promise.all([
    User.find({ "appHidden.at": { $exists: true } }).select("_id email").lean(),
    Attendee.find({ "appHidden.at": { $exists: true } }).select("_id email ticketId claimedBy").lean(),
  ]);
  const ids = new Set(users.map((u) => str(u._id)));
  const emails = new Set();
  const addEmail = (e) => { const s = lower(e); if (s && !PLACEHOLDER.test(s)) emails.add(s); };
  for (const u of users) addEmail(u.email);
  // A hidden pass hides whoever claimed it or holds it now (a pass-only person who signs in later).
  const claimers = passes.map((p) => p.claimedBy).filter(Boolean).map(str);
  const ticketIds = passes.map((p) => p.ticketId).filter(Boolean);
  const holders = ticketIds.length || claimers.length
    ? await User.find({ $or: [{ _id: { $in: claimers } }, { "tickets.ticketId": { $in: ticketIds } }] }).select("_id email").lean()
    : [];
  for (const h of holders) { ids.add(str(h._id)); addEmail(h.email); }
  for (const p of passes) addEmail(p.email);
  return { ids, emails, passes: new Set(passes.map((p) => str(p._id))), tickets: new Set(ticketIds.map(str)), loadedAt: new Date() };
}

/** { ids: Set<userId>, emails: Set<email>, passes: Set<attendeeId>, tickets: Set<ticketId> } of everyone hidden now. */
export async function hiddenState({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && cache.value && (now - cache.at < TTL_MS || now < cache.retryAt)) return cache.value;
  if (cache.pending) return cache.pending;
  const gen = cache.gen;
  const pending = loadHidden().then((value) => {
    if (cache.gen === gen) cache = { ...cache, at: Date.now(), value, pending: null, retryAt: 0 };
    return value;
  }, (err) => {
    if (cache.pending === pending) cache.pending = null;
    if (cache.value) {
      console.error("APP HIDE READ ERROR (kept the last copy):", err?.message || err);
      cache.retryAt = Date.now() + RETRY_MS;
      return cache.value;
    }
    throw err;
  });
  cache.pending = pending;
  return pending;
}

/** Staff changed someone: read again on the next request (this server), and tell anyone caching what depends on it. */
export function forgetHidden() {
  cache = { at: 0, value: null, pending: null, gen: cache.gen + 1, retryAt: 0 };
  for (const fn of listeners) { try { fn(); } catch { /* a listener never breaks a change */ } }
}

/** Run `fn` whenever the hidden set changes here (e.g. the leaderboard's cache). */
export function onHiddenChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Is this account hidden right now? */
export async function isHidden(userId) {
  if (!userId) return false;
  return (await hiddenState()).ids.has(str(userId));
}

/** What the signed-in person (a User doc and their app rights) doesn't see: shadowFor() for them. */
export async function viewerHide(user, rights) {
  let state = await hiddenState();
  // Someone who just signed in with a hidden pass (a new account the cached set can't know yet): hidden from their
  // very first request, and the set is read again at once so everyone else stops seeing them too.
  if (!state.ids.has(str(user?._id)) && state.tickets?.size && (user?.tickets || []).some((t) => state.tickets.has(str(t?.ticketId)))) {
    forgetHidden();
    state = await hiddenState();
  }
  return shadowFor(state, { viewerId: user?._id, viewerEmail: user?.email, staff: seesHidden(user, rights) });
}

/** ObjectIds for $in / $nin. */
export const oids = (ids) => [...(ids || [])].filter((x) => mongoose.isValidObjectId(str(x))).map((x) => new mongoose.Types.ObjectId(str(x)));

/** postId → approved comments by hidden people this viewer doesn't see (only for `posts`). */
export async function hiddenCommentCounts(posts, shadow) {
  if (!shadow?.size || !posts?.length) return new Map();
  const ids = posts.map((p) => p._id).filter(Boolean);
  return countMap(await SocialComment.aggregate([
    { $match: { postId: { $in: oids(ids) }, authorId: { $in: oids(shadow) }, status: "approved" } },
    { $group: { _id: "$postId", n: { $sum: 1 } } },
  ]));
}

/** discussionId → approved replies by hidden people this viewer doesn't see. */
export async function hiddenReplyCounts(discussions, shadow) {
  if (!shadow?.size || !discussions?.length) return new Map();
  return countMap(await DiscussionReply.aggregate([
    { $match: { discussionId: { $in: oids(discussions.map((d) => d._id)) }, authorId: { $in: oids(shadow) }, status: "approved" } },
    { $group: { _id: "$discussionId", n: { $sum: 1 } } },
  ]));
}

/** Posts as this viewer counts them (postForViewer for each). */
export async function postsForViewer(posts, shadow) {
  if (!shadow?.size || !posts?.length) return posts;
  const comments = await hiddenCommentCounts(posts, shadow);
  return posts.map((p) => postForViewer(p, shadow, comments));
}

/* ================= HIDE / UNHIDE ================= */

/** What they did while hidden and could be removed when they're shown again (createdAt ≥ since). */
export const WHILE_HIDDEN = Object.freeze([
  { key: "posts", label: "Feed posts", model: SocialPost, author: "authorId" },
  { key: "comments", label: "Comments", model: SocialComment, author: "authorId" },
  { key: "messages", label: "Chat messages", model: SocialMessage, author: "fromUserId" },
  { key: "groupMessages", label: "Group chat messages", model: GroupMessage, author: "authorId" },
  { key: "discussions", label: "Discussions", model: Discussion, author: "authorId" },
  { key: "replies", label: "Discussion replies", model: DiscussionReply, author: "authorId" },
  { key: "groups", label: "Groups they started", model: CommunityGroup, author: "ownerId" },
  { key: "questions", label: "Session questions", model: SessionQuestion, author: "authorId" },
  { key: "requests", label: "Connection requests (not answered)", model: SocialConnection, author: "fromUserId", requests: true },
].map((x) => Object.freeze(x)));

const whileFilter = (k, ids, since) => ({
  [k.author]: { $in: oids(ids) }, createdAt: { $gte: since },
  ...(k.requests ? { status: "pending" } : { status: { $ne: "hidden" } }),
});

/** { posts, comments, … , total } of what `userIds` did since `since` (what "remove what they posted" would take away). */
export async function whileHiddenCounts(userIds, since) {
  const out = Object.fromEntries(WHILE_HIDDEN.map((k) => [k.key, 0]));
  out.total = 0;
  if (!userIds?.length || !since) return out;
  const counts = await Promise.all(WHILE_HIDDEN.map((k) => k.model.countDocuments(whileFilter(k, userIds, since))));
  WHILE_HIDDEN.forEach((k, i) => { out[k.key] = counts[i]; out.total += counts[i]; });
  return out;
}

/**
 * Soft-deletes what `userIds` posted since `since`: status "hidden" (the App moderation "Hide" state, so staff can
 * still read it and bring one back), posts with removedBy / removedAt as a staff removal; the comment and reply
 * counts they added come off; their unanswered connection requests are set to declined. Likes, poll votes, joins
 * and follows stay. → counts as whileHiddenCounts.
 */
export async function removeWhileHidden(userIds, since, { by = null } = {}) {
  const out = Object.fromEntries(WHILE_HIDDEN.map((k) => [k.key, 0]));
  out.total = 0;
  if (!userIds?.length || !since) return out;
  const now = new Date();
  for (const k of WHILE_HIDDEN) {
    const filter = whileFilter(k, userIds, since);
    let r;
    if (k.key === "comments" || k.key === "replies") {
      // Approved ones were counted on their post / discussion: take them off again.
      const parent = k.key === "comments" ? "postId" : "discussionId";
      const Parent = k.key === "comments" ? SocialPost : Discussion;
      const field = k.key === "comments" ? "commentCount" : "replyCount";
      const counted = await k.model.aggregate([{ $match: { ...filter, status: "approved" } }, { $group: { _id: `$${parent}`, n: { $sum: 1 } } }]);
      r = await k.model.updateMany(filter, { $set: { status: "hidden" } });
      for (const c of counted) {
        await Parent.updateOne({ _id: c._id }, { $inc: { [field]: -c.n } });
        await Parent.updateOne({ _id: c._id, [field]: { $lt: 0 } }, { $set: { [field]: 0 } });
      }
    } else if (k.key === "posts") {
      const ids = (await k.model.find(filter).select("_id").lean()).map((p) => p._id);
      r = await k.model.updateMany({ _id: { $in: ids } }, { $set: { status: "hidden", removedAt: now, ...(by ? { removedBy: by } : {}) } });
      if (ids.length) await ActivityEvent.deleteMany({ refId: { $in: ids } });
    } else if (k.requests) {
      r = await k.model.updateMany(filter, { $set: { status: "declined", respondedAt: now } });
    } else {
      r = await k.model.updateMany(filter, { $set: { status: "hidden" } });
    }
    out[k.key] = r?.modifiedCount ?? 0;
    out.total += out[k.key];
  }
  return out;
}

/** Sets or clears the flag on an account and pass rows. `hide`: { by, byName, reason } to hide, null to show again. */
export async function setHidden({ userIds = [], attendeeIds = [], hide = null } = {}) {
  const users = oids(userIds);
  const passes = oids(attendeeIds);
  const update = hide
    ? { $set: { appHidden: { at: hide.at || new Date(), by: hide.by || undefined, byName: str(hide.byName), reason: cleanReason(hide.reason) } } }
    : { $unset: { appHidden: 1 } };
  // Hiding never moves an earlier start: a record already hidden keeps its own `at`.
  const userFilter = hide ? { _id: { $in: users }, "appHidden.at": { $exists: false } } : { _id: { $in: users } };
  const passFilter = hide ? { _id: { $in: passes }, "appHidden.at": { $exists: false } } : { _id: { $in: passes } };
  // timestamps: false so nothing they can read (updatedAt on /auth/me) moves when staff hide or show them.
  const [u, a] = await Promise.all([
    users.length ? User.updateMany(userFilter, update, { timestamps: false }) : { modifiedCount: 0 },
    passes.length ? Attendee.updateMany(passFilter, update, { timestamps: false }) : { modifiedCount: 0 },
  ]);
  forgetHidden();
  return { users: u.modifiedCount ?? 0, passes: a.modifiedCount ?? 0 };
}

/** A new private reason on records that are already hidden (the start time stays). */
export async function setHideReason({ userIds = [], attendeeIds = [], reason = "" } = {}) {
  const set = { $set: { "appHidden.reason": cleanReason(reason) } };
  await Promise.all([
    userIds.length ? User.updateMany({ _id: { $in: oids(userIds) }, "appHidden.at": { $exists: true } }, set, { timestamps: false }) : null,
    attendeeIds.length ? Attendee.updateMany({ _id: { $in: oids(attendeeIds) }, "appHidden.at": { $exists: true } }, set, { timestamps: false }) : null,
  ]);
}
