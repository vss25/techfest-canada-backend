/* Activity pushes and Settings › Notifications (Oct 22 2026) through the real routes, against a real (throwaway)
   MongoDB. "nicole just posted, and i commented, send her a notif for it": comments, replies to your comment,
   @mentions, likes (one push an hour per post, "Nicole and 3 others"), group / session chats and followed
   discussions (one push per 10 minutes per person, "5 new messages in …", unless it @mentions them). Never to
   yourself, never across a block, never from someone hidden from the app, and each person's switches. The throttles
   live in MongoDB, so two servers taking the same slot at once give one push. Starts a local mongod in a temp folder
   on a free port and stops it after; skipped when the binary isn't there (TTFC_TEST_MONGOD, else
   ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Nothing leaves the machine: no push service is configured
   (pushes are watched with observePushes), Sanity is a stubbed fetch. Fictional people, example.com. */
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

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.includes(".sanity.io/")) return new Response(JSON.stringify({ result: [] }), { status: 200, headers: { "content-type": "application/json" } });
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
let takeSlots;
const M = {};
const U = {};
const pushes = [];
const s = {};

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-notify-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await pause(250);
  await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_notify_test`);
  ({ default: jwt } = await import("jsonwebtoken"));
  ({ takeSlots } = await import("../services/pushThrottle.js"));
  const { observePushes } = await import("../services/push.js");
  observePushes((to, note) => pushes.push({ to, note }));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.PushThrottle = await imp("../models/PushThrottle.js");
  Object.assign(M, await import("../models/Admin.js"), await import("../models/Social.js"), await import("../models/Community.js"));
  await M.PushThrottle.init();
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/social", await imp("../routes/social.js"));
  app.use("/api/community", await imp("../routes/community.js"));
  app.use("/api/app", await imp("../routes/appApi.js"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const onApp = { appOnboarded: true, lastActiveAt: new Date("2026-10-21T12:00:00Z") };
  const t = (id) => [{ ticketId: id, type: "connect" }];
  const mk = (key, doc) => M.User.create(doc).then((u) => { U[key] = u; });
  await Promise.all([
    mk("nicole", { name: "Nicole Louis", email: "nicole.louis@example.com", tickets: [{ ticketId: "spk600000001", type: "speaker" }], ...onApp }),
    mk("gunant", { name: "Gunant Singh", email: "gunant.singh@example.com", tickets: t("con600000001"), ...onApp }),
    mk("ben", { name: "Ben Normal", email: "ben.normal@example.com", tickets: t("con600000002"), ...onApp }),
    mk("cal", { name: "Cal Normal", email: "cal.normal@example.com", tickets: t("con600000003"), ...onApp }),
    mk("bob", { name: "Bob Blocked", email: "bob.blocked@example.com", tickets: t("con600000004"), ...onApp }),
    mk("max", { name: "Max Moderator", email: "max.moderator@example.com", types: ["staff"], tickets: t("con600000005"), ...onApp }),
    mk("hal", { name: "Hal Hidden", email: "hal.hidden@example.com", tickets: t("con600000006"),
      appHidden: { at: new Date("2026-10-21T10:00:00Z"), byName: "Mia", reason: "test" }, ...onApp }),
  ]);
  await M.Block.create({ userId: U.nicole._id, blockedId: U.bob._id });
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const tokenFor = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function call(method, url, { as, body } = {}) {
  const r = await realFetch(base + url, {
    method, headers: { "content-type": "application/json", authorization: `Bearer ${tokenFor(as)}` },
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
const mention = (u) => ({ type: "user", id: idOf(u), name: u.name });
/** Pushes go out after a database check: wait for them to settle. */
async function settle(ms = 200) {
  let n = -1;
  for (let i = 0; i < 40 && n !== pushes.length; i++) { n = pushes.length; await pause(ms / 4); }
  await pause(ms);
}
const to = (u, kind) => pushes.filter((p) => p.to.includes(idOf(u)) && (!kind || p.note.kind === kind));
const reset = () => { pushes.length = 0; };

test("a comment on your post tells you; your own, a blocked person's and a hidden person's don't", { skip }, async () => {
  s.post = (await ok(call("POST", "/api/social/feed", { as: U.nicole, body: { body: "FOUR DAYS TO GO!!!!" } }), 201)).id;
  await settle();
  reset();
  await ok(call("POST", `/api/social/feed/${s.post}/comments`, { as: U.gunant, body: { body: "Can't wait! See you at the keynote." } }), 201);
  await settle();
  const [p] = to(U.nicole, "comment");
  assert.ok(p, "Nicole got a push");
  assert.deepEqual(p.to, [idOf(U.nicole)]);
  assert.deepEqual([p.note.title, p.note.body, p.note.thread, p.note.id, p.note.url],
    ["Gunant Singh commented on your post", "Can't wait! See you at the keynote.", `post.${s.post}`, s.post, `/app/post/${s.post}`]);
  reset();
  await ok(call("POST", `/api/social/feed/${s.post}/comments`, { as: U.nicole, body: { body: "Thanks!" } }), 201);
  assert.equal((await call("POST", `/api/social/feed/${s.post}/comments`, { as: U.bob, body: { body: "hi" } })).status, 404);   // blocked: not there
  await ok(call("POST", `/api/social/feed/${s.post}/comments`, { as: U.hal, body: { body: "hello" } }), 201);
  await settle();
  assert.deepEqual(pushes, []);
});

test("@mentions in posts, comments, discussions and replies tell the person; the author gets one push, not two", { skip }, async () => {
  reset();
  const p = await ok(call("POST", "/api/social/feed", { as: U.gunant, body: { body: "Meet @Ben Normal at the booth", mentions: [mention(U.ben)] } }), 201);
  await settle();
  assert.deepEqual(to(U.ben).map((x) => [x.note.kind, x.note.title, x.note.thread]), [["mention", "Gunant Singh mentioned you", `post.${p.id}`]]);
  reset();
  // A comment that @mentions Ben and Nicole (the post's author): each gets "mentioned you", Nicole no "commented" as well.
  const c = await ok(call("POST", `/api/social/feed/${s.post}/comments`, { as: U.gunant, body: { body: "@Ben Normal @Nicole Louis let's meet", mentions: [mention(U.ben), mention(U.nicole)] } }), 201);
  assert.deepEqual(c.mentions.map((m) => m.id).sort(), [idOf(U.ben), idOf(U.nicole)].sort());
  await settle();
  assert.deepEqual(to(U.ben).map((x) => x.note.kind), ["mention"]);
  assert.deepEqual(to(U.nicole).map((x) => x.note.kind), ["mention"]);
  // The comment list shows the mentions.
  const list = await ok(call("GET", `/api/social/feed/${s.post}/comments`, { as: U.ben }));
  assert.ok(list.some((x) => x.mentions.length === 2));
  // A mention of someone you blocked (or who blocked you) or who's hidden from you: nothing.
  reset();
  await ok(call("POST", "/api/social/feed", { as: U.nicole, body: { body: "@Bob @Hal", mentions: [mention(U.bob), mention(U.hal)] } }), 201);
  await settle();
  assert.deepEqual(pushes, []);
  // A moderator's discussion that @mentions Cal, and a reply that @mentions Ben.
  reset();
  s.disc = (await ok(call("POST", "/api/community/discussions", { as: U.max, body: { title: "Best sessions on day 1?", body: "@Cal Normal what's yours?", mentions: [mention(U.cal)] } }), 201)).id;
  await settle();
  assert.deepEqual(to(U.cal).map((x) => [x.note.kind, x.note.thread, x.note.url]), [["mention", `disc.${s.disc}`, `/app/discussion/${s.disc}`]]);
  reset();
  const r = await ok(call("POST", `/api/community/discussions/${s.disc}/replies`, { as: U.cal, body: { body: "The keynote. @Ben Normal?", mentions: [mention(U.ben)] } }), 201);
  assert.equal(r.mentions[0].id, idOf(U.ben));
  await settle();
  assert.deepEqual(to(U.ben).map((x) => x.note.kind), ["mention"]);
});

test("a reply to your comment tells you at once; other followers at most once per 10 minutes", { skip }, async () => {
  const nicolesReply = await ok(call("POST", `/api/community/discussions/${s.disc}/replies`, { as: U.nicole, body: { body: "Quantum panel" } }), 201);
  await settle();
  reset();
  await ok(call("POST", `/api/community/discussions/${s.disc}/replies`, { as: U.ben, body: { body: "Agreed, great panel", parentId: nicolesReply.id } }), 201);
  await settle();
  assert.deepEqual(to(U.nicole).map((x) => [x.note.kind, x.note.title]), [["reply", "Ben Normal replied to your comment"]]);
  // Max (the author, a follower) was pushed by the earlier replies in this window: nothing more yet.
  const maxPushes = to(U.max, "disc").length;
  await ok(call("POST", `/api/community/discussions/${s.disc}/replies`, { as: U.ben, body: { body: "And the AI keynote" } }), 201);
  await settle();
  assert.equal(to(U.max, "disc").length, maxPushes);
  // The window ends: the next reply says how many it covers.
  await M.PushThrottle.updateMany({ _id: new RegExp(`^disc:${s.disc}:`) }, { $set: { until: new Date(Date.now() - 1000) } });
  reset();
  await ok(call("POST", `/api/community/discussions/${s.disc}/replies`, { as: U.cal, body: { body: "Robotics demo too" } }), 201);
  await settle();
  const [m] = to(U.max, "disc");
  assert.ok(m, "Max hears again after 10 minutes");
  assert.match(m.note.body, /^\d+ new replies in “Best sessions on day 1\?”$/);
});

test("likes: one push an hour per post, 'Nicole and 3 others'; none for an unlike + relike or a week-old post", { skip }, async () => {
  reset();
  await ok(call("POST", `/api/social/feed/${s.post}/like`, { as: U.ben }));
  await settle();
  assert.deepEqual(to(U.nicole, "like").map((x) => [x.note.title, x.note.body, x.note.thread]), [["Likes on your post", "Ben Normal liked your post", `post.${s.post}`]]);
  reset();
  await ok(call("POST", `/api/social/feed/${s.post}/like`, { as: U.cal }));
  await ok(call("POST", `/api/social/feed/${s.post}/like`, { as: U.max }));
  await ok(call("POST", `/api/social/feed/${s.post}/like`, { as: U.ben }));   // unlike
  await ok(call("POST", `/api/social/feed/${s.post}/like`, { as: U.ben }));   // relike: not a first like
  await settle();
  assert.deepEqual(to(U.nicole, "like"), []);
  // An hour later, the next first like covers the two held back.
  await M.PushThrottle.updateOne({ _id: `like:${s.post}:${idOf(U.nicole)}` }, { $set: { until: new Date(Date.now() - 1000) } });
  await ok(call("POST", `/api/social/feed/${s.post}/like`, { as: U.gunant }));
  await settle();
  assert.deepEqual(to(U.nicole, "like").map((x) => x.note.body), ["Gunant Singh and 2 others liked your post"]);
  // Likes on a post older than a week: no push.
  reset();
  const old = await M.SocialPost.create({ authorId: U.cal._id, authorName: "Cal Normal", body: "Last week", status: "approved" });
  await M.SocialPost.collection.updateOne({ _id: old._id }, { $set: { createdAt: new Date(Date.now() - 8 * 24 * 3_600_000) } });
  await ok(call("POST", `/api/social/feed/${old._id}/like`, { as: U.ben }));
  await settle();
  assert.deepEqual(to(U.cal, "like"), []);
});

test("throttles: two servers taking the same slot at once give one push", { skip }, async () => {
  const people = [idOf(U.ben), idOf(U.cal)];
  const now = new Date();
  const [a, b] = await Promise.all([takeSlots("group:test", people, 600_000, { now }), takeSlots("group:test", people, 600_000, { now })]);
  for (const id of people) assert.equal([a.get(id).ok, b.get(id).ok].filter(Boolean).length, 1, id);
  const again = await takeSlots("group:test", people, 600_000, { now: new Date(now.getTime() + 60_000) });
  assert.ok(people.every((id) => !again.get(id).ok));
  const later = await takeSlots("group:test", people, 600_000, { now: new Date(now.getTime() + 601_000) });
  assert.deepEqual(people.map((id) => later.get(id)), people.map(() => ({ ok: true, missed: 2 })));   // both held-back tries
});

test("group and session chats: one push per person per 10 minutes, '5 new messages in …', a mention right away", { skip }, async () => {
  const g = await ok(call("POST", "/api/community/groups", { as: U.max, body: { name: "Speakers' lounge", description: "Say hi" } }), 201);
  for (const u of [U.nicole, U.ben, U.cal]) await ok(call("POST", `/api/community/groups/${g.id}/join`, { as: u }));
  reset();
  for (const body of ["Hi all", "Coffee?", "At the Westin bar"]) {
    await ok(call("POST", `/api/community/groups/${g.id}/messages`, { as: U.nicole, body: { body } }), 201);
  }
  await settle();
  assert.deepEqual(to(U.ben, "gm").map((x) => [x.note.title, x.note.body, x.note.thread, x.note.url]),
    [["Speakers' lounge", "Nicole Louis: Hi all", `group.${g.id}`, `/app/group/${g.id}`]]);
  assert.equal(to(U.cal, "gm").length, 1);
  assert.equal(to(U.nicole).length, 0);
  // A message that @mentions Ben reaches him now.
  reset();
  await ok(call("POST", `/api/community/groups/${g.id}/messages`, { as: U.nicole, body: { body: "@Ben Normal you in?", mentions: [mention(U.ben)] } }), 201);
  await settle();
  assert.deepEqual(to(U.ben).map((x) => [x.note.kind, x.note.body]), [["mention", "in Speakers' lounge: @Ben Normal you in?"]]);
  assert.equal(to(U.cal).length, 0);
  // Ten minutes on: Cal hears again, with how many it covers (2 held back + this one).
  await M.PushThrottle.updateMany({ _id: new RegExp(`^group:${g.id}:`) }, { $set: { until: new Date(Date.now() - 1000) } });
  reset();
  await ok(call("POST", `/api/community/groups/${g.id}/messages`, { as: U.nicole, body: { body: "Starting now" } }), 201);
  await settle();
  assert.deepEqual(to(U.cal, "gm").map((x) => x.note.body), ["4 new messages in Speakers' lounge"]);
  // Opening the chat (not ?peek=1) marks it seen for the "What you missed" email.
  await ok(call("GET", `/api/community/groups/${g.id}/messages`, { as: U.cal }));
  const { default: GroupSeen } = await import("../models/GroupSeen.js");
  for (let i = 0; i < 20 && !(await GroupSeen.countDocuments({ userId: U.cal._id })); i++) await pause(25);
  assert.equal(await GroupSeen.countDocuments({ userId: U.cal._id, groupId: g.id }), 1);
  await ok(call("GET", `/api/community/groups/${g.id}/messages?peek=1`, { as: U.ben }));
  await pause(100);
  assert.equal(await GroupSeen.countDocuments({ userId: U.ben._id }), 0);
});

test("Settings › Notifications: every switch on by default; switched off, that kind stops", { skip }, async () => {
  const prefs = await ok(call("GET", "/api/social/notify/prefs", { as: U.nicole }));
  assert.deepEqual(prefs.prefs, { messages: true, comments: true, mentions: true, likes: true, groups: true, connections: true, announcements: true, digestEmail: true });
  assert.deepEqual(prefs.options.map((o) => o.key), Object.keys(prefs.prefs));
  assert.equal((await call("PATCH", "/api/social/notify/prefs", { as: U.nicole, body: { comments: "off" } })).status, 400);
  const after = await ok(call("PATCH", "/api/social/notify/prefs", { as: U.nicole, body: { comments: false, messages: false } }));
  assert.deepEqual([after.prefs.comments, after.prefs.messages, after.prefs.likes], [false, false, true]);
  reset();
  await ok(call("POST", `/api/social/feed/${s.post}/comments`, { as: U.cal, body: { body: "One more" } }), 201);
  await ok(call("POST", `/api/social/messages/${idOf(U.nicole)}`, { as: U.ben, body: { body: "Hi Nicole" } }), 201);
  await settle();
  assert.deepEqual(to(U.nicole), []);
  // Ben's messages still reach Cal (his own switch is on), immediately.
  await ok(call("POST", `/api/social/messages/${idOf(U.cal)}`, { as: U.ben, body: { body: "Hi Cal" } }), 201);
  await settle();
  assert.deepEqual(to(U.cal, "dm").map((x) => [x.note.thread, x.note.url]), [[`dm.${idOf(U.ben)}`, `/app/chat/${idOf(U.ben)}`]]);
  await ok(call("PATCH", "/api/social/notify/prefs", { as: U.nicole, body: { comments: true, messages: true } }));
});
