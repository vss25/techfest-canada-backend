import test from "node:test";
import assert from "node:assert/strict";
import {
  RULES, LEVELS, scoreFromCounts, levelFor, nextLevelFor, emptyCounts, profileCounts, mergeCounts,
  onLeaderboard, leaderboardCard, rankRows, rankAmong, clampLimit, countPipelines,
} from "../services/points.js";

const pts = (score, key) => score.breakdown.find((b) => b.key === key);
const only = (key, counts) => {
  const s = scoreFromCounts(counts);
  const b = pts(s, key);
  // Nothing else scores when only this rule's input is set.
  assert.equal(s.total, b.points, `${key}: total should equal its own points`);
  return b;
};

/* ================= RULES table ================= */

test("RULES lists every rule once with its points and caps", () => {
  const table = Object.fromEntries(RULES.map((r) => [r.key, [r.points, r.max, r.per]]));
  assert.deepEqual(table, {
    "profile.linkedin": [20, 1, "total"],
    "profile.topics": [10, 1, "total"],
    "session.saved": [5, 10, "total"],
    "session.attended": [20, null, null],
    "live.vote": [5, null, null],
    "live.question": [10, null, null],
    "live.upvoted": [2, 10, "question"],
    "network.request": [5, 20, "total"],
    "network.connection": [15, null, null],
    "network.inPerson": [10, null, null],
    "feed.post": [10, 3, "day"],
    "feed.comment": [3, 10, "day"],
    "feed.likes": [1, 25, "post"],
  });
  assert.equal(new Set(RULES.map((r) => r.key)).size, RULES.length);
  for (const r of RULES) assert.ok(r.label && r.description, `${r.key} has a label and description`);
  assert.ok(Object.isFrozen(RULES) && Object.isFrozen(RULES[0]));
  // The apps get it as JSON as is.
  assert.deepEqual(JSON.parse(JSON.stringify(RULES)), RULES.map((r) => ({ ...r })));
});

test("breakdown has every rule in RULES order, zeros included", () => {
  const s = scoreFromCounts(emptyCounts());
  assert.deepEqual(s.breakdown.map((b) => b.key), RULES.map((r) => r.key));
  assert.deepEqual(Object.keys(s.breakdown[0]), ["key", "label", "points", "count"]);
  assert.ok(s.breakdown.every((b) => b.points === 0 && b.count === 0));
  assert.equal(s.total, 0);
});

/* ================= each rule ================= */

test("profile.linkedin: +20 once", () => {
  assert.deepEqual(only("profile.linkedin", { hasLinkedin: true }), { key: "profile.linkedin", label: "Add your LinkedIn", points: 20, count: 1 });
  assert.equal(only("profile.linkedin", { hasLinkedin: false }).points, 0);
});

test("profile.topics: +10 once at 3 or more topics", () => {
  assert.equal(only("profile.topics", { topics: 2 }).points, 0);
  assert.equal(only("profile.topics", { topics: 3 }).points, 10);
  assert.equal(only("profile.topics", { topics: 12 }).points, 10);
  // An array works too; repeats and blanks don't count.
  assert.equal(only("profile.topics", { topics: ["AI", "ai ", "", "Quantum"] }).points, 0);
  assert.equal(only("profile.topics", { topics: ["AI", "Quantum", "Robotics"] }).points, 10);
});

test("session.saved: +5 each, 10 sessions counted at most", () => {
  assert.deepEqual(only("session.saved", { sessionsSaved: 4 }), { key: "session.saved", label: "Save a session", points: 20, count: 4 });
  assert.equal(only("session.saved", { sessionsSaved: 10 }).points, 50);
  assert.deepEqual(only("session.saved", { sessionsSaved: 14 }), { key: "session.saved", label: "Save a session", points: 50, count: 10 });
});

test("session.attended: +20 per distinct session, no cap", () => {
  assert.equal(only("session.attended", { sessionsAttended: 1 }).points, 20);
  assert.equal(only("session.attended", { sessionsAttended: 30 }).points, 600);
});

test("live.vote: +5 per poll vote", () => {
  assert.equal(only("live.vote", { pollVotes: 7 }).points, 35);
});

test("live.question: +10 per approved question", () => {
  assert.equal(only("live.question", { questionsApproved: 3 }).points, 30);
});

test("live.upvoted: +2 per upvote, 10 counted per question", () => {
  assert.deepEqual(only("live.upvoted", { upvotesPerQuestion: [3, 0, 4] }), { key: "live.upvoted", label: "Get upvoted", points: 14, count: 7 });
  // 15 → 10 and 3 → 3
  assert.deepEqual(only("live.upvoted", { upvotesPerQuestion: [15, 3] }), { key: "live.upvoted", label: "Get upvoted", points: 26, count: 13 });
  assert.equal(only("live.upvoted", { upvotesPerQuestion: [10, 10] }).points, 40);
});

test("network.request: +5 each, 20 counted at most", () => {
  assert.equal(only("network.request", { requestsSent: 6 }).points, 30);
  assert.equal(only("network.request", { requestsSent: 20 }).points, 100);
  assert.deepEqual(only("network.request", { requestsSent: 45 }), { key: "network.request", label: "Reach out", points: 100, count: 20 });
});

test("network.connection: +15 per accepted connection", () => {
  assert.equal(only("network.connection", { connections: 8 }).points, 120);
});

test("network.inPerson: +10 extra per badge-scan connection", () => {
  assert.equal(only("network.inPerson", { inPersonConnections: 2 }).points, 20);
  const s = scoreFromCounts({ connections: 2, inPersonConnections: 2 });
  assert.equal(s.total, 2 * 15 + 2 * 10);
});

test("feed.post: +10 each, 3 counted per UTC day", () => {
  assert.equal(only("feed.post", { postsPerDay: [1] }).points, 10);
  // 5 → 3, 2 → 2, 3 → 3
  assert.deepEqual(only("feed.post", { postsPerDay: [5, 2, 3] }), { key: "feed.post", label: "Post on the feed", points: 80, count: 8 });
  // A { day: n } map works too.
  assert.equal(only("feed.post", { postsPerDay: { "2026-10-26": 9, "2026-10-27": 1 } }).points, 40);
});

test("feed.comment: +3 each, 10 counted per UTC day", () => {
  assert.equal(only("feed.comment", { commentsPerDay: [4] }).points, 12);
  // 12 → 10, 4 → 4
  assert.deepEqual(only("feed.comment", { commentsPerDay: [12, 4] }), { key: "feed.comment", label: "Comment", points: 42, count: 14 });
});

test("feed.likes: +1 per like from others, 25 counted per post", () => {
  assert.equal(only("feed.likes", { likesPerPost: [3, 4] }).points, 7);
  // 30 → 25, 5 → 5
  assert.deepEqual(only("feed.likes", { likesPerPost: [30, 5] }), { key: "feed.likes", label: "Get likes", points: 30, count: 30 });
});

test("bad or missing counts score nothing instead of throwing", () => {
  for (const c of [undefined, null, {}, { sessionsSaved: -4, pollVotes: NaN, connections: "x", postsPerDay: "abc", likesPerPost: [null, -3, "2"] }]) {
    const s = scoreFromCounts(c);
    assert.ok(Number.isInteger(s.total) && s.total >= 0);
  }
  assert.equal(scoreFromCounts({ sessionsSaved: -4, pollVotes: NaN, connections: "x" }).total, 0);
  assert.equal(scoreFromCounts({ likesPerPost: [null, -3, "2"] }).total, 2);
  assert.equal(scoreFromCounts({ pollVotes: 2.9 }).total, 10);   // whole numbers only
});

test("a full day at the festival adds up", () => {
  const s = scoreFromCounts({
    hasLinkedin: true, topics: 5,                       // 20 + 10
    sessionsSaved: 12, sessionsAttended: 4,             // 50 + 80
    pollVotes: 6, questionsApproved: 2,                 // 30 + 20
    upvotesPerQuestion: [12, 3],                        // (10 + 3) × 2 = 26
    requestsSent: 25, connections: 10, inPersonConnections: 4, // 100 + 150 + 40
    postsPerDay: [4, 1], commentsPerDay: [11], likesPerPost: [40, 2, 0], // 40 + 30 + 27
  });
  assert.equal(s.total, 20 + 10 + 50 + 80 + 30 + 20 + 26 + 100 + 150 + 40 + 40 + 30 + 27);
  assert.equal(s.total, 623);
  assert.equal(s.breakdown.reduce((sum, b) => sum + b.points, 0), s.total);
  assert.equal(s.level.name, "Trailblazer");
  assert.equal(s.nextLevel.name, "Catalyst");
  assert.equal(s.toNext, 377);
});

/* ================= levels ================= */

test("LEVELS are Explorer 0, Connector 100, Insider 300, Trailblazer 600, Catalyst 1000", () => {
  assert.deepEqual(LEVELS.map((l) => [l.name, l.min]),
    [["Explorer", 0], ["Connector", 100], ["Insider", 300], ["Trailblazer", 600], ["Catalyst", 1000]]);
});

test("levelFor at and around each boundary", () => {
  const cases = [[0, "Explorer"], [99, "Explorer"], [100, "Connector"], [299, "Connector"], [300, "Insider"],
    [599, "Insider"], [600, "Trailblazer"], [999, "Trailblazer"], [1000, "Catalyst"], [25_000, "Catalyst"]];
  for (const [total, name] of cases) assert.equal(levelFor(total).name, name, `${total} → ${name}`);
  assert.equal(levelFor(-5).name, "Explorer");
  assert.equal(levelFor(undefined).name, "Explorer");
  assert.deepEqual(levelFor(300), { key: "insider", name: "Insider", min: 300 });
});

test("nextLevel and toNext", () => {
  assert.equal(nextLevelFor(0).name, "Connector");
  assert.equal(nextLevelFor(100).name, "Insider");
  assert.equal(nextLevelFor(999).name, "Catalyst");
  assert.equal(nextLevelFor(1000), null);

  const s0 = scoreFromCounts({});
  assert.deepEqual([s0.level.name, s0.nextLevel.name, s0.toNext], ["Explorer", "Connector", 100]);
  const s95 = scoreFromCounts({ pollVotes: 19 });            // 95
  assert.deepEqual([s95.total, s95.level.name, s95.nextLevel.name, s95.toNext], [95, "Explorer", "Connector", 5]);
  const s100 = scoreFromCounts({ pollVotes: 20 });           // exactly 100
  assert.deepEqual([s100.level.name, s100.nextLevel.name, s100.toNext], ["Connector", "Insider", 200]);
  const s1000 = scoreFromCounts({ sessionsAttended: 50 });   // exactly 1000
  assert.deepEqual([s1000.level.name, s1000.nextLevel, s1000.toNext], ["Catalyst", null, 0]);
});

/* ================= profile, merging ================= */

test("profileCounts wants a real LinkedIn link and counts distinct topics", () => {
  assert.equal(profileCounts({ linkedinUrl: "https://www.linkedin.com/in/someone" }).hasLinkedin, true);
  assert.equal(profileCounts({ linkedinUrl: "https://ca.linkedin.com/in/someone/" }).hasLinkedin, true);
  assert.equal(profileCounts({ linkedinUrl: "https://lnkd.in/abc123" }).hasLinkedin, true);
  assert.equal(profileCounts({ linkedinUrl: "https://x" }).hasLinkedin, false);
  assert.equal(profileCounts({ linkedinUrl: "" }).hasLinkedin, false);
  assert.equal(profileCounts({ topics: ["AI", "AI", "Quantum", " "] }).topics, 2);
  assert.deepEqual(profileCounts(null), { hasLinkedin: false, topics: 0 });
});

test("mergeCounts joins the aggregation rows per person", () => {
  const map = mergeCounts({
    saved: [{ _id: "u1", n: 3 }],
    votes: [{ _id: "u1", n: 4, sessions: ["s1", "s2"] }, { _id: "u2", n: 1, sessions: ["s9"] }],
    questions: [{ _id: "u1", n: 2, sessions: ["s2", "s3"], upvotes: [5, 0] }],
    connections: [{ _id: "u1", sent: 7, accepted: 3, inPerson: 1 }, { _id: "u2", sent: 0, accepted: 1, inPerson: 0 }],
    posts: [{ _id: "u2", perDay: [4, 1], likes: [[2, 30], [1]] }],
    comments: [{ _id: "u2", perDay: [11] }, { _id: null, perDay: [3] }],
  });
  assert.deepEqual([...map.keys()].sort(), ["u1", "u2"]);
  const u1 = map.get("u1");
  assert.equal(u1.sessionsSaved, 3);
  assert.equal(u1.pollVotes, 4);
  assert.equal(u1.sessionsAttended, 3);            // s1, s2 (vote + question), s3
  assert.equal(u1.questionsApproved, 2);
  assert.deepEqual(u1.upvotesPerQuestion, [5, 0]);
  assert.deepEqual([u1.requestsSent, u1.connections, u1.inPersonConnections], [7, 3, 1]);
  const u2 = map.get("u2");
  assert.equal(u2.sessionsAttended, 1);
  assert.deepEqual(u2.postsPerDay, [4, 1]);
  assert.deepEqual(u2.likesPerPost, [2, 30, 1]);   // flattened across days
  assert.deepEqual(u2.commentsPerDay, [11]);
  // u2: 20 attended + 5 vote + 15 connection + 40 posts (3 + 1) + 30 comments + 28 likes (2 + 25 + 1)
  assert.equal(scoreFromCounts(u2).total, 20 + 5 + 15 + 40 + 30 + 28);
  assert.equal(mergeCounts().size, 0);
});

test("countPipelines read only that person's records when given an id", () => {
  const oid = { fake: "oid" };
  const one = countPipelines(oid);
  assert.deepEqual(one.saved[0], { $match: { userId: oid } });
  assert.deepEqual(one.votes[0], { $match: { userId: oid } });
  assert.deepEqual(one.questions[0], { $match: { authorId: oid, status: "approved" } });
  assert.deepEqual(one.posts[0], { $match: { authorId: oid, status: "approved" } });
  assert.deepEqual(one.comments[0], { $match: { authorId: oid, status: "approved" } });
  assert.deepEqual(one.connections[0], { $match: { $or: [{ fromUserId: oid }, { toUserId: oid }] } });
  assert.ok(one.connections.some((s) => s.$match?.["side.u"] === oid));
  const all = countPipelines();
  assert.deepEqual(all.saved[0], { $match: {} });
  assert.deepEqual(all.questions[0], { $match: { status: "approved" } });
  assert.ok(!all.connections.some((s) => s.$match?.["side.u"]));
});

/* ================= leaderboard ================= */

test("onLeaderboard leaves out staff, banned and opted-out people", () => {
  assert.equal(onLeaderboard({ role: "user" }), true);
  assert.equal(onLeaderboard({}), true);
  assert.equal(onLeaderboard({ role: "admin" }), false);
  assert.equal(onLeaderboard({ role: "Admin", staffRole: "staff" }), false);
  assert.equal(onLeaderboard({ banned: true }), false);
  assert.equal(onLeaderboard({ hideFromLeaderboard: true }), false);
  assert.equal(onLeaderboard({ directoryHidden: true }), false);
  assert.equal(onLeaderboard(null), false);
});

test("leaderboardCard never leaks email or role", () => {
  const c = leaderboardCard({ _id: "abc", name: "A", email: "a@x.com", role: "user", organization: "Org", jobTitle: "CTO", avatarVersion: 3, linkedinUrl: "x" });
  assert.deepEqual(c, { id: "abc", name: "A", organization: "Org", jobTitle: "CTO", avatarUrl: "/api/files/avatar/abc?v=3" });
  assert.equal(leaderboardCard({ _id: "abc", name: "B" }).avatarUrl, "");
});

test("rankRows sorts by points and ties share a rank", () => {
  const row = (id, name, points) => ({ user: { id, name }, points, level: levelFor(points) });
  const ranked = rankRows([row("1", "Cara", 50), row("2", "Ann", 120), row("3", "Bob", 50), row("4", "Dev", 10)]);
  assert.deepEqual(ranked.map((r) => [r.rank, r.user.name, r.points]), [[1, "Ann", 120], [2, "Bob", 50], [2, "Cara", 50], [4, "Dev", 10]]);
  assert.deepEqual(Object.keys(ranked[0]), ["rank", "user", "points", "level"]);
  // Re-ranking after someone leaves closes the gap.
  assert.deepEqual(rankRows(ranked.filter((r) => r.user.id !== "2")).map((r) => r.rank), [1, 1, 3]);
});

test("rankAmong places fresh points against the cached board", () => {
  const board = rankRows([{ user: { id: "a" }, points: 300 }, { user: { id: "b" }, points: 200 }, { user: { id: "me" }, points: 90 }]);
  assert.equal(rankAmong(board, "me", 90), 3);
  assert.equal(rankAmong(board, "me", 250), 2);   // points went up since the cache
  assert.equal(rankAmong(board, "me", 200), 2);   // tie with b
  assert.equal(rankAmong(board, "x", 999), 1);
  assert.equal(rankAmong(board, "me", 0), null);  // no points, not on the board
});

test("clampLimit: default 10, 1 to 50", () => {
  assert.equal(clampLimit(undefined), 10);
  assert.equal(clampLimit("abc"), 10);
  assert.equal(clampLimit("0"), 10);
  assert.equal(clampLimit("-3"), 10);
  assert.equal(clampLimit("1"), 1);
  assert.equal(clampLimit("25"), 25);
  assert.equal(clampLimit("500"), 50);
  assert.equal(clampLimit("7.9"), 7);
});
