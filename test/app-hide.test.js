/* "Hide from app" (shadow mode, Oct 21 2026): the pure rules in services/appHideRules.js, and the helpers
   that take hidden people out of discussion counts and typing (services/discussionFollow.js, services/typing.js).
   The routes are tested against a real database in test/app-hide-db.test.js. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  seesHidden, cleanReason, hideFlag, personHide, shadowFor, unseenOf, visible, hiddenAmong, isHiddenGuest, postForViewer, countMap,
  REASON_MAX,
} from "../services/appHideRules.js";
import { discussionDTO, followerCount } from "../services/discussionFollow.js";
import { markTyping, whoIsTyping } from "../services/typing.js";

const A = "a".repeat(24);
const B = "b".repeat(24);
const C = "c".repeat(24);
const state = { ids: new Set([A, C]), emails: new Set(["ann@example.com", "cal@example.com"]), passes: new Set(["p1"]) };

test("staff accounts and moderators see hidden people; nobody else does", () => {
  assert.equal(seesHidden({ role: "admin" }, {}), true);
  assert.equal(seesHidden({ role: "user" }, { moderate: true }), true);
  assert.equal(seesHidden({ role: "user" }, { moderate: false }), false);
  assert.equal(seesHidden({ role: "volunteer" }, {}), false);
  assert.equal(seesHidden(null, null), false);
});

test("shadowFor: everyone else misses every hidden person; a hidden person misses the others but not themself", () => {
  const b = shadowFor(state, { viewerId: B, viewerEmail: "ben@example.com" });
  assert.equal(b.self, false);
  assert.deepEqual([...b.ids].sort(), [A, C]);
  assert.deepEqual([...b.emails].sort(), ["ann@example.com", "cal@example.com"]);
  assert.deepEqual([...b.passes], ["p1"]);

  const a = shadowFor(state, { viewerId: A, viewerEmail: "Ann@Example.com" });
  assert.equal(a.self, true);
  assert.deepEqual([...a.ids], [C]);
  assert.deepEqual([...a.emails], ["cal@example.com"]);

  const staff = shadowFor(state, { viewerId: B, staff: true });
  assert.equal(staff.ids.size + staff.emails.size + staff.passes.size, 0);
  const hiddenStaff = shadowFor(state, { viewerId: A, staff: true });
  assert.equal(hiddenStaff.self, true);
  assert.equal(hiddenStaff.ids.size, 0);

  const none = shadowFor({ ids: new Set(), emails: new Set(), passes: new Set() }, { viewerId: B });
  assert.equal(none.ids.size, 0);
  assert.equal(none.self, false);
  // The cached state itself is never changed.
  assert.deepEqual([...state.ids].sort(), [A, C]);
});

test("unseenOf adds the shadow to blocks without changing either; visible / hiddenAmong compare as strings", () => {
  const blocked = new Set([B]);
  const shadow = new Set([A]);
  const u = unseenOf(blocked, shadow);
  assert.deepEqual([...u].sort(), [A, B]);
  assert.deepEqual([...blocked], [B]);
  assert.equal(unseenOf(blocked, new Set()), blocked);
  const ids = [{ toString: () => A }, B, C];
  assert.deepEqual(visible(ids, shadow).map(String), [B, C]);
  assert.equal(hiddenAmong(ids, shadow), 1);
  assert.equal(hiddenAmong(ids, new Set()), 0);
  assert.equal(visible(undefined, shadow).length, 0);
});

test("a hidden person's guest passes: flagged, or under a hidden person's email", () => {
  const s = shadowFor(state, { viewerId: B });
  assert.equal(isHiddenGuest({ _id: "p1", email: "someone@example.com" }, s), true);
  assert.equal(isHiddenGuest({ _id: "p2", email: " ANN@example.com " }, s), true);
  assert.equal(isHiddenGuest({ _id: "p3", email: "ben@example.com" }, s), false);
  assert.equal(isHiddenGuest({ _id: "p4" }, s), false);
});

test("postForViewer takes hidden people's likes, comments and mention chips out of this viewer's counts", () => {
  const post = {
    _id: "post1", authorId: B, likes: [A, B, C], likeCount: 3, commentCount: 5,
    mentions: [{ type: "user", id: A, name: "Ann" }, { type: "speaker", id: A, name: "A speaker" }, { type: "user", id: B, name: "Ben" }],
  };
  const out = postForViewer(post, new Set([A, C]), new Map([["post1", 2]]));
  assert.deepEqual(out.likes, [B]);
  assert.equal(out.likeCount, 1);
  assert.equal(out.commentCount, 3);
  assert.deepEqual(out.mentions.map((m) => m.name), ["A speaker", "Ben"]);
  assert.equal(post.likeCount, 3, "the stored post isn't changed");
  assert.equal(postForViewer(post, new Set()), post, "nothing to take out → the same object");
  assert.equal(postForViewer({ ...post, likes: [B], mentions: [] }, new Set([A])).likeCount, 3, "unchanged when none of it is theirs");
  assert.equal(postForViewer({ _id: "x", likes: [A], likeCount: 0, commentCount: 0 }, new Set([A]), new Map([["x", 4]])).commentCount, 0, "never below 0");
});

test("hideFlag / personHide: the earliest flag on the account or a pass; bad dates don't count", () => {
  assert.equal(hideFlag(null), null);
  assert.equal(hideFlag({}), null);
  assert.equal(hideFlag({ appHidden: { at: "not a date" } }), null);
  const user = { appHidden: { at: "2026-10-21T10:00:00Z", by: B, byName: "Sam Staff", reason: "Spam" } };
  const pass = { appHidden: { at: "2026-10-20T09:00:00Z", byName: "Mia Manager" } };
  assert.deepEqual(hideFlag(user), { at: new Date("2026-10-21T10:00:00Z"), by: B, byName: "Sam Staff", reason: "Spam" });
  const p = personHide({ user, attendees: [pass, { appHidden: null }] });
  assert.equal(p.byName, "Mia Manager");
  assert.equal(p.at.toISOString(), "2026-10-20T09:00:00.000Z");
  assert.equal(personHide({ user: { name: "x" }, attendees: [] }), null);
});

test("cleanReason keeps a private note to one line of at most REASON_MAX", () => {
  assert.equal(cleanReason("  Sent  unwanted\nmessages  "), "Sent unwanted messages");
  assert.equal(cleanReason(null), "");
  assert.equal(cleanReason("x".repeat(900)).length, REASON_MAX);
});

test("countMap reads aggregation rows", () => {
  const m = countMap([{ _id: { toString: () => "d1" }, n: 2 }, { _id: "d2", n: "3" }]);
  assert.equal(m.get("d1"), 2);
  assert.equal(m.get("d2"), 3);
  assert.equal(countMap(null).size, 0);
});

test("discussions: hidden people's replies and follows don't count for the viewer", () => {
  const d = { _id: "d1", authorId: B, title: "T", body: "B", replyCount: 4, status: "approved", followers: [B, A, C] };
  assert.equal(followerCount(d), 3);
  assert.equal(followerCount(d, new Set([A])), 2);
  const dto = discussionDTO(d, B, { shadow: new Set([A, C]), hiddenReplies: 3 });
  assert.equal(dto.replyCount, 1);
  assert.equal(dto.followerCount, 1);
  assert.equal(discussionDTO(d, B).replyCount, 4, "no options → as stored");
  assert.equal(discussionDTO(d, B, { hiddenReplies: 9 }).replyCount, 0);
});

test("typing: hidden (and blocked) people's typing isn't shown", () => {
  const now = Date.now();
  markTyping("group", "g-hide", A, "Ann", now);
  markTyping("group", "g-hide", C, "Cal", now);
  assert.deepEqual(whoIsTyping("group", "g-hide", B, now).sort(), ["Ann", "Cal"]);
  assert.deepEqual(whoIsTyping("group", "g-hide", B, now, new Set([A])), ["Cal"]);
  assert.deepEqual(whoIsTyping("group", "g-hide", A, now, new Set([C])), [], "Ann doesn't see herself, nor Cal (hidden too)");
});
