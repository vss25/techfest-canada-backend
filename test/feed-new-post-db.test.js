/* The feed, a brand-new account's first post, and speaker photos as avatars (Oct 22 2026), through the real routes
   against a real (throwaway) MongoDB. The organiser's report: a speaker (here Nicole Louis, a fictional stand-in)
   signed up, posted "FOUR DAYS TO GO!!!!" with a photo; commenting on it said "Not found", after a relaunch it was
   gone for a moment, and her photo showed as initials although the Speakers page has it.
   Checked here: the post is in everyone's feed at once and stays there on every reload, and whoever's feed shows a
   post can like it and comment on it (one rule for the feed, the post page, likes and comments); simultaneous likes
   and comments all go through and are all counted; a busy feed never drops a post because others gained likes; a
   post that's really gone answers "This post isn't available any more."; a speaker without an uploaded photo shows
   their website photo on posts, comments, cards, the attendee list, /social/me, /auth/me and /api/profile, and an
   upload always wins. Starts a local mongod in a temp folder on a free port and stops it after; skipped when the
   binary isn't there (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Nothing leaves
   the machine: Sanity is answered by a stubbed fetch, sign-in codes go to a stub sender, no push service is
   configured. Fictional people, example.com. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

const BIN = process.env.TTFC_TEST_MONGOD || path.join(os.homedir(), ".cache/mongodb-binaries/mongod-arm64-darwin-8.2.6");
const HAVE = fs.existsSync(BIN);
const skip = HAVE ? false : `no local mongod at ${BIN}`;

process.env.JWT_SECRET ||= "local-test-only";
process.env.RESEND_API_KEY ||= "re_dummy";
delete process.env.STRIPE_SECRET_KEY;
delete process.env.FCM_SERVICE_ACCOUNT;
delete process.env.APNS_KEY;
delete process.env.DEEPCLEER_ACCESS_KEY;

const PHOTO = "https://cdn.sanity.io/images/021qtoci/production/nicole0001-1200x1600.jpg";
const SPEAKERS = [
  { _id: "spk-nicole", name: "Nicole Louis", imageUrl: PHOTO, hotspot: { x: 0.5, y: 0.35 }, dims: { width: 1200, height: 1600 } },
  { _id: "spk-raj", name: "Raj Patel", imageUrl: "https://cdn.sanity.io/images/021qtoci/production/raj0001-800x800.jpg" },
];
const NICOLE_AVATAR = `${PHOTO}?w=256&h=256&fit=crop&fm=webp&q=80&crop=focalpoint&fp-x=0.5&fp-y=0.35`;

const realFetch = globalThis.fetch;
const sanity = async (url) => new Response(JSON.stringify({ result: String(url).includes("image.asset") ? SPEAKERS : [] }),
  { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.includes(".sanity.io/")) return sanity(url);
  throw new Error(`blocked in the test: ${url}`);
};

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port) => new Promise((ok) => { const c = net.connect(port, "127.0.0.1", () => { c.end(); ok(true); }); c.on("error", () => ok(false)); });

let mongod = null;
let dbDir = "";
let server = null;
let base = "";
let jwt;
let mongoose;
let refreshSpeakerPhotos;
let setSpeakerPhotos;
const M = {};
const U = {};
const codes = [];
const s = {};

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-feed-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await pause(250);
  await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_feed_test`, { readPreference: "primary" });
  ({ default: jwt } = await import("jsonwebtoken"));
  ({ refreshSpeakerPhotos } = await import("../services/speakerPhotoStore.js"));
  ({ setSpeakerPhotos } = await import("../services/speakerPhotos.js"));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.Attendee = await imp("../models/Attendee.js");
  Object.assign(M, await import("../models/Admin.js"), await import("../models/Social.js"));
  const { default: express } = await import("express");
  const { createEmailLinkRouter } = await import("../routes/emailLink.js");
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/auth", await imp("../routes/auth.js"));
  app.use("/api/auth", await imp("../routes/ticketAuth.js"));
  app.use("/api/auth", createEmailLinkRouter({ send: async (kind, p) => { if (kind === "signin") codes.push(p.code); } }));
  app.use("/api/profile", await imp("../routes/profile.js"));
  app.use("/api/social", await imp("../routes/social.js"));
  app.use("/api/community", await imp("../routes/community.js"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const onApp = { appOnboarded: true, lastActiveAt: new Date("2026-10-21T12:00:00Z") };
  const mk = (key, doc) => M.User.create(doc).then((u) => { U[key] = u; });
  await Promise.all([
    mk("mia", { name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management", ...onApp }),
    // A staff member whose email staff put on Raj's Speaker Pass (he had none on file).
    mk("sam", { name: "Sam Staff", email: "sam.staff@example.com", role: "admin", staffRole: "staff", ...onApp }),
    mk("ben", { name: "Ben Normal", email: "ben.normal@example.com", tickets: [{ ticketId: "con500000001", type: "connect" }], ...onApp }),
    mk("cal", { name: "Cal Normal", email: "cal.normal@example.com", tickets: [{ ticketId: "con500000002", type: "connect" }], ...onApp }),
    mk("max", { name: "Max Moderator", email: "max.moderator@example.com", types: ["staff"], tickets: [{ ticketId: "con500000003", type: "connect" }], ...onApp }),
    // Hidden from the app by staff, so everyone else's shadow set isn't empty.
    mk("hal", { name: "Hal Hidden", email: "hal.hidden@example.com", tickets: [{ ticketId: "con500000004", type: "connect" }],
      appHidden: { at: new Date("2026-10-21T10:00:00Z"), byName: "Mia Manager", reason: "test" }, ...onApp }),
    mk("bob", { name: "Bob Blocker", email: "bob.blocker@example.com", tickets: [{ ticketId: "con500000005", type: "connect" }], ...onApp }),
  ]);
  await M.Attendee.create([
    { name: "Nicole Louis", email: "nicole.louis@example.com", ticketId: "spk500000001", ticketType: "speaker", promoCode: "SPEAKER", speakerId: "spk-nicole" },
    { name: "Raj Patel", email: "sam.staff@example.com", ticketId: "spk500000002", ticketType: "speaker", promoCode: "SPEAKER", speakerId: "spk-raj" },
  ]);
});

after(async () => {
  server?.close();
  setSpeakerPhotos?.(null);
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const tokenFor = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function call(method, url, { as, token, body } = {}) {
  const auth = token || (as ? tokenFor(as) : "");
  const r = await realFetch(base + url, {
    method, headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const ok = async (p, want = 200) => {
  const r = await p;
  assert.equal(r.status, want, JSON.stringify(r.body));
  return r.body;
};
const idOf = (u) => String(u._id);
const feed = async (who, q = "?limit=60") => ok(call("GET", `/api/social/feed${q}`, who));
const viewers = () => [["Nicole", { token: s.nicole }], ["staff", { as: U.mia }], ["attendee", { as: U.ben }],
  ["moderator", { as: U.max }], ["hidden person", { as: U.hal }]];
const JPEG = `data:image/jpeg;base64,${Buffer.alloc(120_000, 7).toString("base64")}`;

test("a brand-new speaker signs up with the emailed code and posts text and a photo", { skip }, async () => {
  await ok(call("POST", "/api/auth/email-link", { body: { email: "nicole.louis@example.com" } }));
  const r = await ok(call("POST", "/api/auth/email-link/verify", { body: { email: "nicole.louis@example.com", code: codes.at(-1) } }));
  assert.equal(r.created, true);
  s.nicole = r.token;
  const me = await ok(call("GET", "/api/social/me", { token: s.nicole }));
  s.nicoleId = me.id;
  assert.deepEqual([me.kind, me.rights.post, me.rights.comment], ["speaker", true, true]);
  const post = await ok(call("POST", "/api/social/feed", { token: s.nicole, body: { body: "FOUR DAYS TO GO!!!!", imageData: JPEG, topicTags: [], linkUrl: "" } }), 201);
  assert.equal(post.status, "approved");
  assert.equal(post.imageUrl, `/api/files/post/${post.id}`);
  s.post = post.id;
});

test("everyone sees it at once, on every reload, and everyone who sees it can like it and comment on it", { skip }, async () => {
  for (const [who, opt] of viewers()) {
    for (let reload = 0; reload < 3; reload++) {
      assert.ok((await feed(opt)).some((p) => p.id === s.post), `${who}, load ${reload + 1}`);
    }
    assert.equal((await ok(call("GET", `/api/social/feed/${s.post}`, opt))).id, s.post, who);
    const c = await ok(call("POST", `/api/social/feed/${s.post}/comments`, { ...opt, body: { body: `Welcome! (${who})` } }), 201);
    assert.equal(c.status, "approved", who);
    assert.equal((await ok(call("POST", `/api/social/feed/${s.post}/like`, opt))).liked, true, who);
  }
  // The invariant for every post in every viewer's feed (theirs, held ones of their own, staff's): like + comment work.
  await ok(call("POST", "/api/social/feed", { as: U.ben, body: { body: "Ben's own post" } }), 201);
  const held = await M.SocialPost.create({ authorId: U.cal._id, authorName: "Cal Normal", body: "held for review", status: "held" });
  for (const [who, opt] of [...viewers(), ["Cal (held post)", { as: U.cal }]]) {
    const list = await feed(opt);
    if (who.startsWith("Cal")) assert.ok(list.some((p) => p.id === String(held._id)), "Cal sees his held post");
    for (const p of list) {
      assert.equal((await call("POST", `/api/social/feed/${p.id}/comments`, { ...opt, body: { body: "+1" } })).status, 201, `${who} → ${p.body}`);
      const l1 = await call("POST", `/api/social/feed/${p.id}/like`, opt);
      const l2 = await call("POST", `/api/social/feed/${p.id}/like`, opt);
      assert.deepEqual([l1.status, l2.status, l1.body.liked !== l2.body.liked], [200, 200, true], `${who} → ${p.body}`);
    }
  }
  // Counts: one comment from each of the five viewers + the "+1"s from those who see it, all approved.
  const stored = await M.SocialPost.findById(s.post).lean();
  assert.equal(stored.commentCount, await M.SocialComment.countDocuments({ postId: s.post, status: "approved" }));
});

test("likes and comments at the same moment all go through and are all counted", { skip }, async () => {
  const people = await M.User.create(Array.from({ length: 12 }, (_, i) => ({
    name: `Fan ${i}`, email: `fan${i}@example.com`, tickets: [{ ticketId: `con5100000${String(i).padStart(2, "0")}`, type: "connect" }], appOnboarded: true,
  })));
  const p = await ok(call("POST", "/api/social/feed", { token: s.nicole, body: { body: "Who's coming to the Gala?" } }), 201);
  const answers = await Promise.all(people.flatMap((u) => [
    call("POST", `/api/social/feed/${p.id}/like`, { as: u }),
    call("POST", `/api/social/feed/${p.id}/comments`, { as: u, body: { body: "Me!" } }),
  ]));
  assert.deepEqual(answers.map((a) => a.status), people.flatMap(() => [200, 201]));   // was: some likes 500 (version clash)
  const stored = await M.SocialPost.findById(p.id).lean();
  assert.equal(stored.likeCount, 12);
  assert.equal(stored.likes.length, 12);
  assert.equal(stored.commentCount, 12);                                              // was: comments lost from the count
  // A double tap from two devices: the second is answered from what's stored, never an error.
  const [a, b] = await Promise.all([call("POST", `/api/social/feed/${p.id}/like`, { as: U.cal }), call("POST", `/api/social/feed/${p.id}/like`, { as: U.cal })]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  const after1 = await M.SocialPost.findById(p.id).lean();
  assert.equal(after1.likeCount, after1.likes.length);
  // The author hears about each first like once (and never about an unlike + relike).
  const { default: ActivityEvent } = await import("../models/ActivityEvent.js");
  for (let i = 0; i < 50 && (await ActivityEvent.countDocuments({ refId: p.id, kind: "like" })) < 12; i++) await pause(50);
  assert.ok((await ActivityEvent.countDocuments({ refId: p.id, kind: "like" })) >= 12);
  await ok(call("POST", `/api/social/feed/${p.id}/like`, { as: people[0] }));
  await ok(call("POST", `/api/social/feed/${p.id}/like`, { as: people[0] }));
  await pause(150);
  assert.equal(await ActivityEvent.countDocuments({ refId: p.id, kind: "like", actorId: idOf(people[0]) }), 1);
});

test("the same post sent again (the answer lost on a bad connection) comes back as that post, not a second copy", { skip }, async () => {
  const send = (body) => call("POST", "/api/social/feed", { token: s.nicole, body });
  const a = await ok(send({ body: "Rehearsal done ✅", imageData: JPEG }), 201);
  const b = await ok(send({ body: "Rehearsal done ✅", imageData: JPEG }), 201);
  assert.equal(b.id, a.id);
  assert.equal(await M.SocialPost.countDocuments({ authorId: s.nicoleId, body: "Rehearsal done ✅" }), 1);
  // Different text, or different photos on a photo-only post, or someone else: new posts as usual.
  assert.notEqual((await ok(send({ body: "Rehearsal done ✅✅", imageData: JPEG }), 201)).id, a.id);
  const p1 = await ok(send({ body: "", imageData: `data:image/jpeg;base64,${Buffer.alloc(900, 1).toString("base64")}` }), 201);
  const p2 = await ok(send({ body: "", imageData: `data:image/jpeg;base64,${Buffer.alloc(900, 2).toString("base64")}` }), 201);
  assert.notEqual(p1.id, p2.id);
  assert.notEqual((await ok(call("POST", "/api/social/feed", { as: U.ben, body: { body: "Rehearsal done ✅", imageData: JPEG } }), 201)).id, a.id);
  // Deleted, then posted again: a new post.
  await ok(call("DELETE", `/api/social/feed/${a.id}`, { token: s.nicole }));
  assert.notEqual((await ok(send({ body: "Rehearsal done ✅", imageData: JPEG }), 201)).id, a.id);
});

test("a busy feed: a new post is in it straight away and a post never drops out because others gained likes", { skip }, async () => {
  // 90 older posts from Ben, many with lots of likes and comments (the old ranking kept the top 60 of 300 by score).
  const now = Date.now();
  const likers = Array.from({ length: 40 }, () => new mongoose.Types.ObjectId());
  await M.SocialPost.collection.insertMany(Array.from({ length: 90 }, (_, i) => {
    const likes = i % 3 === 0 ? likers.slice(0, 40) : [];
    return {
      authorId: U.ben._id, authorName: "Ben Normal", authorTitle: "", authorOrg: "", authorTier: "", kind: "member",
      body: `older ${i}`, topicTags: [], linkUrl: "", imageData: "", media: [], mentions: [], likes, everLiked: likes,
      likeCount: likes.length, commentCount: i % 3 === 0 ? 30 : 0, status: "approved",
      createdAt: new Date(now - (i + 1) * 20 * 60_000), updatedAt: new Date(now - (i + 1) * 20 * 60_000),
    };
  }));
  const fresh = await ok(call("POST", "/api/social/feed", { as: U.cal, body: { body: "Just landed in Toronto" } }), 201);
  const first = await feed({ as: U.ben });
  assert.equal(first.length, 60);
  assert.ok(first.some((p) => p.id === fresh.id), "a brand-new post with no likes is in a busy feed");
  // Others like the posts near the end of the page and beyond it: the page keeps the same posts (only the order moves).
  const ids = new Set(first.map((p) => p.id));
  const outside = await M.SocialPost.find({ _id: { $nin: [...ids].map((x) => new mongoose.Types.ObjectId(x)) }, authorId: U.ben._id }).limit(10).lean();
  await M.SocialPost.updateMany({ _id: { $in: outside.map((p) => p._id) } }, { $set: { likes: likers, likeCount: likers.length, commentCount: 99 } });
  for (const who of [{ as: U.ben }, { as: U.mia }, { token: s.nicole }]) {
    const again = await feed(who);
    assert.deepEqual(new Set(again.map((p) => p.id)), new Set((await feed(who)).map((p) => p.id)));
    for (const id of ids) assert.ok(again.some((p) => p.id === id), `still there for ${who.as?.name || "Nicole"}`);
  }
  // An official announcement older than the newest 60 is still pinned on top (48 h), and the page stays at the limit.
  const ann = await M.SocialPost.create({ authorId: U.mia._id, authorName: "TTFC", kind: "announcement", body: "Doors open at 8 AM", status: "approved" });
  await M.SocialPost.collection.updateOne({ _id: ann._id }, { $set: { createdAt: new Date(now - 30 * 3_600_000) } });
  const withAnn = await feed({ as: U.ben });
  assert.equal(withAnn[0].id, String(ann._id));
  assert.equal(withAnn.length, 60);
  // ?since= still answers only newer posts.
  const since = await feed({ as: U.ben }, `?limit=60&since=${encodeURIComponent(new Date(now - 60_000).toISOString())}`);
  assert.ok(since.length >= 1 && since.every((p) => new Date(p.createdAt) > new Date(now - 60_000)));
});

test("a post that's really gone (deleted, taken down, blocked) answers that it isn't available any more", { skip }, async () => {
  const gone = "This post isn't available any more.";
  // Deleted by its author while someone still had it on screen.
  const p1 = await ok(call("POST", "/api/social/feed", { token: s.nicole, body: { body: "Typo, posting again" } }), 201);
  await ok(call("DELETE", `/api/social/feed/${p1.id}`, { token: s.nicole }));
  for (const route of ["comments", "like"]) {
    assert.deepEqual(await call("POST", `/api/social/feed/${p1.id}/${route}`, { as: U.ben, body: { body: "Nice" } }), { status: 404, body: { error: gone } });
  }
  assert.equal((await call("GET", `/api/social/feed/${p1.id}`, { as: U.ben })).status, 404);
  assert.equal(await M.SocialComment.countDocuments({ postId: p1.id }), 0);
  // Taken down by staff: nobody reacts to it any more, the author included.
  const p2 = await ok(call("POST", "/api/social/feed", { as: U.cal, body: { body: "Off-topic" } }), 201);
  await ok(call("DELETE", `/api/social/feed/${p2.id}`, { as: U.mia }));
  for (const who of [U.ben, U.cal, U.mia]) {
    assert.equal((await call("POST", `/api/social/feed/${p2.id}/comments`, { as: who, body: { body: "?" } })).status, 404);
    assert.equal((await call("POST", `/api/social/feed/${p2.id}/like`, { as: who })).status, 404);
  }
  // Blocked: out of the feed, and no reacting from an old screen either (both ways).
  const p3 = await ok(call("POST", "/api/social/feed", { as: U.bob, body: { body: "Bob's post" } }), 201);
  await M.Block.create({ userId: U.ben._id, blockedId: U.bob._id });
  assert.ok(!(await feed({ as: U.ben })).some((p) => p.id === p3.id));
  assert.deepEqual((await call("POST", `/api/social/feed/${p3.id}/comments`, { as: U.ben, body: { body: "?" } })).body, { error: gone });
  assert.equal((await call("POST", `/api/social/feed/${p3.id}/like`, { as: U.ben })).status, 404);
  assert.equal((await call("POST", `/api/social/feed/${p3.id}/like`, { as: U.cal })).status, 200);   // others still can
  // Someone else's held post isn't there for an attendee; their own is.
  const held = await M.SocialPost.create({ authorId: U.bob._id, authorName: "Bob Blocker", body: "held", status: "held" });
  assert.equal((await call("POST", `/api/social/feed/${held._id}/comments`, { as: U.cal, body: { body: "?" } })).status, 404);
  assert.equal((await call("POST", `/api/social/feed/${held._id}/comments`, { as: U.bob, body: { body: "edit: fixed" } })).status, 201);
  // Not an id at all: the same answer, never a server error.
  for (const route of ["comments", "like"]) {
    assert.deepEqual(await call("POST", `/api/social/feed/not-a-post/${route}`, { as: U.ben, body: { body: "x" } }), { status: 404, body: { error: gone } });
  }
  assert.deepEqual(await ok(call("GET", "/api/social/feed/not-a-post/comments", { as: U.ben })), []);
});

test("a speaker without an uploaded photo shows their website photo everywhere; an upload always wins", { skip }, async () => {
  const snap = await refreshSpeakerPhotos({ fetchImpl: globalThis.fetch });
  assert.equal(snap.speakers, 2);
  const nicoleId = s.nicoleId;
  const hers = (list) => list.filter((p) => p.authorId === nicoleId);
  // A discussion and a group (a moderator's, so approved) that Nicole and Ben are in; and a discussion of her own.
  const disc = await ok(call("POST", "/api/community/discussions", { as: U.max, body: { title: "Best sessions on day 1?", body: "Share your picks" } }), 201);
  const group = await ok(call("POST", "/api/community/groups", { as: U.max, body: { name: "Speakers' lounge", description: "Say hi" } }), 201);
  await ok(call("POST", `/api/community/groups/${group.id}/join`, { token: s.nicole }));
  await ok(call("POST", `/api/community/groups/${group.id}/join`, { as: U.ben }));
  const own = await ok(call("POST", "/api/community/discussions", { token: s.nicole, body: { title: "Slides from my talk", body: "Ask me anything" } }), 201);
  let round = 0;
  const check = async (want) => {
    for (const p of hers(await feed({ as: U.ben }))) assert.equal(p.authorAvatarUrl, want, "feed");
    assert.equal((await ok(call("GET", `/api/social/feed/${s.post}`, { as: U.ben }))).authorAvatarUrl, want, "post page");
    const comments = await ok(call("GET", `/api/social/feed/${s.post}/comments`, { as: U.ben }));
    assert.ok(comments.some((c) => c.authorId === nicoleId));
    for (const c of comments.filter((x) => x.authorId === nicoleId)) assert.equal(c.authorAvatarUrl, want, "comment");
    assert.equal((await ok(call("GET", `/api/social/users/${nicoleId}`, { as: U.ben }))).avatarUrl, want, "profile card");
    assert.equal((await ok(call("GET", "/api/social/attendees", { as: U.ben }))).find((p) => p.id === nicoleId)?.avatarUrl, want, "attendee list");
    assert.equal((await ok(call("GET", "/api/social/me", { token: s.nicole }))).avatarUrl, want, "/social/me");
    assert.equal((await ok(call("GET", "/api/auth/me", { token: s.nicole }))).avatarUrl, want, "/auth/me");
    assert.equal((await ok(call("GET", "/api/profile", { token: s.nicole }))).avatarUrl, want, "/api/profile");
    const c = await ok(call("POST", `/api/social/feed/${s.post}/comments`, { token: s.nicole, body: { body: "Thank you all!" } }), 201);
    assert.equal(c.authorAvatarUrl, want, "the comment answer");
    const p = await ok(call("POST", "/api/social/feed", { token: s.nicole, body: { body: `See you at the Westin (${++round})` } }), 201);
    assert.equal(p.authorAvatarUrl, want, "the post answer");
    // Discussions, their replies and group chats carry authorAvatarUrl too.
    const r = await ok(call("POST", `/api/community/discussions/${disc.id}/replies`, { token: s.nicole, body: { body: "Day 1 keynote!" } }), 201);
    assert.equal(r.authorAvatarUrl, want, "the reply answer");
    for (const x of (await ok(call("GET", `/api/community/discussions/${disc.id}/replies`, { as: U.ben }))).filter((y) => y.authorId === nicoleId)) {
      assert.equal(x.authorAvatarUrl, want, "discussion replies");
    }
    const m = await ok(call("POST", `/api/community/groups/${group.id}/messages`, { token: s.nicole, body: { body: "Hello lounge" } }), 201);
    assert.equal(m.authorAvatarUrl, want, "the group message answer");
    const msgs = (await ok(call("GET", `/api/community/groups/${group.id}/messages`, { as: U.ben }))).filter((y) => y.authorId === nicoleId);
    assert.ok(msgs.length > 0);
    for (const x of msgs) assert.equal(x.authorAvatarUrl, want, "group messages");
    assert.equal((await ok(call("GET", "/api/community/discussions", { token: s.nicole }))).find((d) => d.id === own.id)?.authorAvatarUrl, want, "discussions");
    assert.equal((await ok(call("GET", `/api/community/groups/${group.id}/members`, { as: U.ben }))).find((x) => x.id === nicoleId)?.avatarUrl, want, "group members");
  };
  // Someone without a photo: no avatar on their replies or messages.
  const plain = await ok(call("POST", `/api/community/groups/${group.id}/messages`, { as: U.ben, body: { body: "Hi all" } }), 201);
  assert.equal(plain.authorAvatarUrl, "");
  await check(NICOLE_AVATAR);
  // Raj's pass carries Sam's (staff) email: Sam keeps his initials.
  assert.equal((await ok(call("GET", "/api/social/me", { as: U.sam }))).avatarUrl, "");
  assert.ok((await feed({ as: U.ben })).filter((p) => p.authorId === idOf(U.ben)).every((p) => p.authorAvatarUrl === ""));
  // She uploads her own photo: that one, everywhere. Removing it: the website photo again.
  const tiny = `data:image/jpeg;base64,${Buffer.alloc(2000, 9).toString("base64")}`;
  const up = await ok(call("PUT", "/api/profile/avatar", { token: s.nicole, body: { avatarData: tiny } }));
  assert.match(up.avatarUrl, new RegExp(`^/api/files/avatar/${nicoleId}\\?v=\\d+$`));
  await check(up.avatarUrl);
  assert.deepEqual(await ok(call("PUT", "/api/profile/avatar", { token: s.nicole, body: { avatarData: "" } })), { avatarUrl: NICOLE_AVATAR });
  await check(NICOLE_AVATAR);
  // Sanity can't be read: the last snapshot stays.
  await assert.rejects(refreshSpeakerPhotos({ fetchImpl: async () => new Response("down", { status: 503 }) }));
  assert.equal((await ok(call("GET", "/api/social/me", { token: s.nicole }))).avatarUrl, NICOLE_AVATAR);
});
