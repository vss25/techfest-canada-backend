import test from "node:test";
import assert from "node:assert/strict";
import { rankFeed, jitter, engagementScore } from "../services/feedRank.js";

const now = Date.parse("2026-10-26T15:00:00Z");
const ago = (h) => new Date(now - h * 3_600_000);
const post = (id, h, likes = 0, comments = 0, extra = {}) => ({ _id: id, authorId: "x", createdAt: ago(h), likeCount: likes, commentCount: comments, ...extra });

test("jitter is stable per viewer and day, and stays within 0.8–1.2", () => {
  assert.equal(jitter("p1", "u1", now), jitter("p1", "u1", now + 3_600_000));
  for (const id of ["a", "b", "c", "d"]) { const j = jitter(id, "u1", now); assert.ok(j >= 0.8 && j <= 1.2); }
  assert.notEqual(jitter("p1", "u1", now), jitter("p1", "u2", now));
});

test("engagement lifts a post over a slightly newer quiet one", () => {
  const busy = post("busy", 6, 40, 10);
  const quiet = post("quiet", 4);
  assert.ok(engagementScore(busy, now) > engagementScore(quiet, now) * 1.5);
  assert.equal(rankFeed([quiet, busy], "u1", now)[0]._id, "busy");
});

test("fresh announcements are pinned, then my post from the last hour", () => {
  const ann = post("ann", 30, 0, 0, { kind: "announcement" });
  const mine = post("mine", 0.2, 0, 0, { authorId: "me" });
  const viral = post("viral", 2, 200, 50);
  assert.deepEqual(rankFeed([viral, mine, ann], "me", now).map((p) => p._id), ["ann", "mine", "viral"]);
  const oldAnn = post("old", 72, 0, 0, { kind: "announcement" });
  assert.equal(rankFeed([oldAnn, viral], "me", now)[0]._id, "viral");
});
