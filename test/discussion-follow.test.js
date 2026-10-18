import test from "node:test";
import assert from "node:assert/strict";
import {
  followerIds, legacyFollowers, isFollowing, followerCount, shouldAutoFollow, followUpdate, parseFollow,
  wantsFollowing, followingFilter, canSeeDiscussion, fanOutRecipients, replySnippet, replyPush,
  createPushThrottle, discussionDTO, MAX_FANOUT, PUSH_GAP_MS, DISCUSSIONS_LINK,
} from "../services/discussionFollow.js";
import { buildActivity } from "../services/socialActivity.js";

const A = "a".repeat(24);   // author
const B = "b".repeat(24);
const C = "c".repeat(24);
const D = "d".repeat(24);
const DISC = "1".repeat(24);
// ObjectId-like values (what Mongoose hands back): stringify to the hex id.
const oid = (hex) => ({ toString: () => hex });

/* ---------- followers / legacy rule ---------- */

test("followerIds: the stored list as strings, deduped", () => {
  assert.deepEqual(followerIds({ authorId: A, followers: [oid(A), B, oid(B), "", null] }), [A, B]);
  assert.deepEqual(followerIds({ authorId: A, followers: [] }), []);   // author unfollowed a new-style thread
  assert.deepEqual(followerIds(null), []);
});

test("followerIds: a thread from before following has its author as the one follower, unless they opted out", () => {
  assert.deepEqual(followerIds({ authorId: oid(A) }), [A]);
  assert.deepEqual(followerIds({ authorId: A, unfollowed: [oid(A)] }), []);
  assert.deepEqual(legacyFollowers({ authorId: A, followers: [B], unfollowed: [C] }), [A]);
  assert.deepEqual(legacyFollowers({ authorId: A, unfollowed: [A] }), []);
});

test("isFollowing / followerCount", () => {
  const d = { authorId: A, followers: [A, B] };
  assert.equal(isFollowing(d, A), true);
  assert.equal(isFollowing(d, oid(B)), true);
  assert.equal(isFollowing(d, C), false);
  assert.equal(isFollowing(d, ""), false);
  assert.equal(followerCount(d), 2);
  assert.equal(isFollowing({ authorId: A }, A), true);   // legacy
  assert.equal(followerCount({ authorId: A }), 1);
  assert.equal(followerCount({ authorId: A, unfollowed: [A] }), 0);
});

/* ---------- auto-follow ---------- */

test("shouldAutoFollow: a new replier yes; already following or opted out no", () => {
  const d = { authorId: A, followers: [A, B], unfollowed: [C] };
  assert.equal(shouldAutoFollow(d, D), true);           // first reply
  assert.equal(shouldAutoFollow(d, B), false);          // already follows
  assert.equal(shouldAutoFollow(d, A), false);          // author follows from create
  assert.equal(shouldAutoFollow(d, C), false);          // unfollowed before: never re-added
  assert.equal(shouldAutoFollow({ authorId: A, followers: [], unfollowed: [A] }, A), false);   // author who opted out
  assert.equal(shouldAutoFollow({ authorId: A }, A), false);   // legacy author already counts
  assert.equal(shouldAutoFollow({ authorId: A }, B), true);
  assert.equal(shouldAutoFollow(null, B), false);
  assert.equal(shouldAutoFollow(d, ""), false);
});

test("followUpdate: follow clears the opt-out, unfollow records it", () => {
  assert.deepEqual(followUpdate(B, true), { $addToSet: { followers: B }, $pull: { unfollowed: B } });
  assert.deepEqual(followUpdate(B, false), { $pull: { followers: B }, $addToSet: { unfollowed: B } });
});

test("follow then auto-follow: simulated on plain arrays", () => {
  // Apply the update the way Mongo would ($addToSet / $pull), then ask the rules again.
  const apply = (d, u) => {
    const out = { ...d, followers: [...(d.followers || [])], unfollowed: [...(d.unfollowed || [])] };
    for (const [k, v] of Object.entries(u.$addToSet || {})) if (!out[k].includes(v)) out[k].push(v);
    for (const [k, v] of Object.entries(u.$pull || {})) out[k] = out[k].filter((x) => x !== v);
    return out;
  };
  let d = { authorId: A, followers: [A, B] };
  d = apply(d, followUpdate(B, false));
  assert.equal(isFollowing(d, B), false);
  assert.equal(shouldAutoFollow(d, B), false);          // replying later keeps them out
  d = apply(d, followUpdate(B, false));                 // idempotent
  assert.deepEqual(d.unfollowed, [B]);
  d = apply(d, followUpdate(B, true));
  assert.equal(isFollowing(d, B), true);
  assert.deepEqual(d.unfollowed, []);
  d = apply(d, followUpdate(B, true));                  // idempotent
  assert.deepEqual(d.followers, [A, B]);
});

test("parseFollow / wantsFollowing", () => {
  for (const v of [true, 1, "true", "1"]) assert.equal(parseFollow(v), true);
  for (const v of [false, 0, "false", "0"]) assert.equal(parseFollow(v), false);
  for (const v of [undefined, null, "", "yes", 2, {}]) assert.equal(parseFollow(v), null);
  for (const v of ["1", "true", "YES", " yes "]) assert.equal(wantsFollowing(v), true);
  for (const v of [undefined, "", "0", "false", "no"]) assert.equal(wantsFollowing(v), false);
});

test("followingFilter matches the stored list or a legacy author who didn't opt out", () => {
  assert.deepEqual(followingFilter(B), {
    $or: [{ followers: B }, { followers: { $exists: false }, authorId: B, unfollowed: { $ne: B } }],
  });
});

test("canSeeDiscussion: same rules as the list", () => {
  assert.equal(canSeeDiscussion({ authorId: A, status: "approved" }, B), true);
  assert.equal(canSeeDiscussion({ authorId: A, status: "pending" }, B), false);
  assert.equal(canSeeDiscussion({ authorId: A, status: "pending" }, A), true);     // your own
  assert.equal(canSeeDiscussion({ authorId: A, status: "hidden" }, B), false);
  assert.equal(canSeeDiscussion({ authorId: A, status: "approved" }, B, new Set([A])), false);   // blocked
  assert.equal(canSeeDiscussion(null, B), false);
});

/* ---------- fan-out ---------- */

test("fanOutRecipients: every follower but the replier, once, minus blocks", () => {
  const out = fanOutRecipients({ followers: [A, B, oid(B), C, D, ""], actorId: oid(C), blocked: new Set([D]) });
  assert.deepEqual(out, { to: [A, B], total: 2, capped: false });
  // Author only if still following.
  assert.deepEqual(fanOutRecipients({ followers: [B], actorId: C }).to, [B]);
  assert.deepEqual(fanOutRecipients({ followers: [], actorId: C }).to, []);
});

test("fanOutRecipients caps at 500, keeping the earliest followers (author first)", () => {
  const many = [A, ...Array.from({ length: 700 }, (_, i) => `f${i.toString(16).padStart(23, "0")}`)];
  const out = fanOutRecipients({ followers: many, actorId: B });
  assert.equal(MAX_FANOUT, 500);
  assert.equal(out.to.length, 500);
  assert.equal(out.to[0], A);
  assert.equal(out.total, 701);
  assert.equal(out.capped, true);
  assert.equal(fanOutRecipients({ followers: many.slice(0, 500), actorId: B }).capped, false);
});

test("fan-out feeds buildActivity: one reply row per follower in Discussions", () => {
  const { to } = fanOutRecipients({ followers: [A, B, C], actorId: B });
  const rows = buildActivity({ kind: "reply", section: "discussions", actorId: B, actorName: "Bo", refId: DISC, recipients: to });
  assert.deepEqual(rows.map((r) => r.userId), [A, C]);
  assert.ok(rows.every((r) => r.section === "discussions" && r.kind === "reply" && r.refId === DISC && r.actorId === B));
});

/* ---------- push ---------- */

test("replyPush: discussion title, replier's first name and a one-line snippet", () => {
  const p = replyPush({ discussionId: oid(DISC), title: "  AI in healthcare ", actorName: "Dr. Jane  Doe", body: "Great\n\npoint   here" });
  assert.deepEqual(p, {
    title: "AI in healthcare", body: "Jane: Great point here", link: DISCUSSIONS_LINK,
    kind: "disc", thread: `disc.${DISC}`, id: DISC,
  });
  assert.equal(DISCUSSIONS_LINK, "ttfc://tab/chats/discussions");
  assert.equal(replyPush({ discussionId: DISC, title: "", actorName: "Guest", body: "hi" }).body, "Someone: hi");
  assert.equal(replyPush({ discussionId: DISC, title: "", actorName: "", body: "hi" }).title, "Discussion");
});

test("replySnippet trims long replies with an ellipsis", () => {
  assert.equal(replySnippet("short"), "short");
  const s = replySnippet("x".repeat(300));
  assert.equal(s.length, 140);
  assert.ok(s.endsWith("…"));
  assert.equal(replySnippet(undefined), "");
});

test("push throttle: one push per follower per discussion per 10 minutes", () => {
  const t = createPushThrottle();
  const t0 = 1_000_000;
  assert.equal(PUSH_GAP_MS, 10 * 60 * 1000);
  assert.deepEqual(t.take(DISC, [A, B], t0), [A, B]);
  assert.deepEqual(t.take(DISC, [A, B, C], t0 + 60_000), [C]);           // A, B pushed a minute ago
  assert.deepEqual(t.take("2".repeat(24), [A], t0 + 60_000), [A]);      // another discussion is separate
  assert.deepEqual(t.take(DISC, [A, B], t0 + PUSH_GAP_MS - 1), []);
  assert.deepEqual(t.take(DISC, [A, B, C], t0 + PUSH_GAP_MS), [A, B]);  // C was pushed at +1 min
  assert.deepEqual(t.take(DISC, [C], t0 + PUSH_GAP_MS + 60_000), [C]);
  assert.deepEqual(t.take(DISC, [oid(A), "", null], t0 + 3 * PUSH_GAP_MS), [A]);
});

test("push throttle forgets expired entries and stays bounded", () => {
  const t = createPushThrottle({ gapMs: 1000, maxEntries: 3 });
  t.take(DISC, [A, B], 0);
  assert.equal(t.size, 2);
  t.take(DISC, [C], 2000);         // A and B expired → dropped
  assert.equal(t.size, 1);
  t.take(DISC, [A, B, D], 2000);
  t.take("2".repeat(24), [A], 2001);   // over the cap: the oldest entry goes first
  assert.ok(t.size <= 4);
  assert.deepEqual(t.take(DISC, [D], 2002), []);   // newer entries kept
});

/* ---------- DTO ---------- */

test("discussionDTO adds following + followerCount for the viewer, never the list", () => {
  const d = {
    _id: oid(DISC), title: "T", body: "B", tags: ["ai"], authorId: oid(A), authorName: "Ann",
    replyCount: 3, status: "approved", createdAt: new Date(0), followers: [oid(A), oid(B)], unfollowed: [oid(C)],
  };
  const forB = discussionDTO(d, B);
  assert.equal(forB.following, true);
  assert.equal(forB.followerCount, 2);
  assert.equal(forB.mine, false);
  assert.equal(forB.id, DISC);
  assert.equal("followers" in forB, false);
  assert.equal("unfollowed" in forB, false);
  const forC = discussionDTO(d, C);
  assert.equal(forC.following, false);
  const forA = discussionDTO(d, A);
  assert.equal(forA.mine, true);
  assert.equal(forA.following, true);
  // Legacy thread: the author follows.
  const legacy = discussionDTO({ ...d, followers: undefined, unfollowed: undefined }, A);
  assert.equal(legacy.following, true);
  assert.equal(legacy.followerCount, 1);
  assert.equal(discussionDTO({ ...d, replyCount: undefined, tags: undefined }, B).replyCount, 0);
});
