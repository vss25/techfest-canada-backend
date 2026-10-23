/* "I am marking something read, but sometimes it shows up again" (Oct 23 2026), through the real routes against a
   real (throwaway) MongoDB. Read state only moves forward:
   - Activity dots (POST /social/activity/seen): the mark is stored with $max, so a slower or older request landing
     last never undoes a newer one; apps send `upTo` (the newest event GET /activity/unread counted), so exactly
     what they counted is seen and what came after stays unread; an older app's plain "seen" covers every event
     there is, even one saved by an instance whose clock runs ahead (it used to come back unread).
   - Staff messages (POST /social/notifications/read): readAt is set once and never cleared; "all" with `upTo`
     covers what was on screen, not one that arrived meanwhile. Answers are never cached.
   - No twin rows that look like the same item: the same staff message sent twice in a row, or the same person
     reporting the same thing twice, lands once.
   Starts a local mongod in a temp folder on a free port and stops it after; skipped when the binary isn't there
   (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Nothing leaves the machine: no push
   service is configured (pushes are watched with observePushes), Sanity is a stubbed fetch. Fictional people,
   example.com. */
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
const M = {};
const U = {};
const pushes = [];

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-notif-read-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await pause(250);
  await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_notif_read_test`);
  ({ default: jwt } = await import("jsonwebtoken"));
  const { observePushes } = await import("../services/push.js");
  observePushes((to, note) => pushes.push({ to, note }));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.ActivityEvent = await imp("../models/ActivityEvent.js");
  M.AppNotification = await imp("../models/AppNotification.js");
  Object.assign(M, await import("../models/Admin.js"));
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/social", await imp("../routes/social.js"));
  app.use("/api/app", await imp("../routes/appApi.js"));
  app.use("/api/console", await imp("../routes/console.js"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const onApp = { appOnboarded: true, lastActiveAt: new Date("2026-10-21T12:00:00Z") };
  const t = (id) => [{ ticketId: id, type: "connect" }];
  const mk = (key, doc) => M.User.create(doc).then((u) => { U[key] = u; });
  await Promise.all([
    mk("ann", { name: "Ann Author", email: "ann.author@example.com", tickets: t("con700000001"), ...onApp }),
    mk("ben", { name: "Ben Liker", email: "ben.liker@example.com", tickets: t("con700000002"), ...onApp }),
    mk("mia", { name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management", ...onApp }),
  ]);
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
  return { status: r.status, body: json, headers: r.headers };
}
const ok = async (p, want = 200) => {
  const r = await p;
  assert.equal(r.status, want, JSON.stringify(r.body));
  return r.body;
};
const unread = (as) => ok(call("GET", "/api/social/activity/unread", { as }));
const seen = (as, body) => ok(call("POST", "/api/social/activity/seen", { as, body }));
const iso = (d) => new Date(d).toISOString();

/** An activity row exactly as an instance saved it: createdAt is that instance's clock (written raw, no Mongoose timestamps). */
async function event(to, from, createdAt, section = "feed") {
  await M.ActivityEvent.collection.insertOne({
    userId: to._id, actorId: from._id, actorName: from.name, kind: section === "feed" ? "like" : "reply", section,
    refId: new mongoose.Types.ObjectId(), createdAt: new Date(createdAt),
  });
  return iso(createdAt);
}
async function fresh(u) {
  await M.ActivityEvent.deleteMany({ userId: u._id });
  await M.User.updateOne({ _id: u._id }, { $unset: { activitySeen: 1 } });
}
const storedMark = async (u, section) => iso((await M.User.findById(u._id).select("activitySeen").lean()).activitySeen[section]);

/* ---------- activity dots ---------- */

test("an event saved by an instance whose clock runs ahead is seen by an older app's plain 'seen' (it used to come back)", { skip }, async () => {
  const { ann, ben } = U;
  await fresh(ann);
  // Another instance, 20 s ahead of this one, saved Ben's like.
  const ahead = await event(ann, ben, Date.now() + 20_000);
  let r = await unread(ann);
  assert.equal(r.feed, 1);
  // An app from before Oct 23 sends no upTo. The mark used to be this server's clock, 20 s behind the like, so the
  // dot came straight back on the next poll.
  const s = await seen(ann, { section: "feed" });
  r = await unread(ann);
  assert.equal(r.feed, 0, "seen stays seen");
  assert.ok(new Date(s.seenAt) >= new Date(ahead), "the mark covers the newest event there is");
  // The answer carries the newest unread event per section (what newer apps send back as upTo).
  assert.deepEqual(r.latest, { feed: null, discussions: null });
  const next = await event(ann, ben, Date.now() + 30_000);
  assert.deepEqual((await unread(ann)).latest, { feed: next, discussions: null });
});

test("upTo: what the app counted is seen; a like that arrived after its poll stays unread", { skip }, async () => {
  const { ann, ben } = U;
  await fresh(ann);
  const now = Date.now();
  const first = await event(ann, ben, now - 3000);
  const counted = await unread(ann);
  assert.deepEqual([counted.feed, counted.latest.feed], [1, first]);
  // Saved after that poll (its createdAt is still before the moment the person opens the tab).
  const second = await event(ann, ben, now - 1000);
  await seen(ann, { section: "feed", upTo: counted.latest.feed });
  const r = await unread(ann);
  assert.deepEqual([r.feed, r.latest.feed], [1, second], "only what was counted was marked; the newer like is still news");
  await seen(ann, { section: "feed", upTo: r.latest.feed });
  assert.equal((await unread(ann)).feed, 0);
});

test("the mark never moves back: a stale 'seen' landing last (the race) changes nothing", { skip }, async () => {
  const { ann, ben } = U;
  await fresh(ann);
  const now = Date.now();
  const older = await event(ann, ben, now - 5000);
  const newer = await event(ann, ben, now - 2000);
  // A poll that started before the newer like was saved, and one after: their marks reach the server out of order.
  await seen(ann, { section: "feed", upTo: newer });
  await seen(ann, { section: "feed", upTo: older });
  assert.equal(await storedMark(ann, "feed"), newer);
  assert.equal((await unread(ann)).feed, 0, "the older mark didn't bring the newer like back");
  // At the same time, in every order: the newest wins.
  for (let i = 0; i < 5; i++) {
    const order = i % 2 ? [older, newer, older] : [newer, older, newer];
    await Promise.all(order.map((upTo) => seen(ann, { section: "feed", upTo })));
    assert.equal(await storedMark(ann, "feed"), newer);
  }
  // An older app's plain "seen" afterwards only moves it forward.
  await seen(ann, { section: "feed" });
  assert.ok(new Date(await storedMark(ann, "feed")) >= new Date(newer));
  assert.equal((await unread(ann)).feed, 0);
});

test("a far-future upTo is capped at a few minutes ahead; sections are separate; answers are never cached", { skip }, async () => {
  const { ann, ben } = U;
  await fresh(ann);
  const reply = await event(ann, ben, Date.now() - 1000, "discussions");
  const s = await seen(ann, { section: "feed", upTo: "2099-01-01T00:00:00Z" });
  assert.ok(new Date(s.seenAt).getTime() <= Date.now() + 5 * 60_000 + 1000, "capped");
  const r = await call("GET", "/api/social/activity/unread", { as: ann });
  assert.deepEqual([r.body.feed, r.body.discussions, r.body.latest.discussions], [0, 1, reply], "seeing the feed leaves the discussions dot");
  assert.match(r.headers.get("cache-control") || "", /no-store/);
  assert.equal((await call("POST", "/api/social/activity/seen", { as: ann, body: { section: "nope" } })).status, 400);
});

/* ---------- staff messages (AppNotification) ---------- */

async function note(to, createdAt, title) {
  const { insertedId } = await M.AppNotification.collection.insertOne({
    userId: to._id, title, body: `${title} body`, link: "", kind: "personal", batchId: "", sentByName: "TTFC team",
    readAt: null, createdAt: new Date(createdAt), updatedAt: new Date(createdAt),
  });
  return String(insertedId);
}

test("mark all with upTo covers what was on screen; read is for good; the answer is never cached", { skip }, async () => {
  const { ann } = U;
  await M.AppNotification.deleteMany({ userId: ann._id });
  const now = Date.now();
  const shown = await note(ann, now - 60_000, "Doors open at 9");
  const list = await call("GET", "/api/social/notifications", { as: ann });
  assert.match(list.headers.get("cache-control") || "", /no-store/);
  assert.deepEqual(list.body.notifications.map((n) => [n.id, n.readAt]), [[shown, null]]);
  // A second one arrives while the person is looking at the first.
  const meanwhile = await note(ann, now - 1000, "Lunch moved to 12:30");
  let r = await ok(call("POST", "/api/social/notifications/read", { as: ann, body: { all: true, upTo: list.body.notifications[0].createdAt } }));
  assert.deepEqual([r.updated, r.unread], [1, 1], "only what was on screen");
  const after = (await ok(call("GET", "/api/social/notifications", { as: ann }))).notifications;
  const byId = new Map(after.map((n) => [n.id, n]));
  assert.ok(byId.get(shown).readAt);
  assert.equal(byId.get(meanwhile).readAt, null);
  // Marking it again (another device, a retry, a stale queue) never moves or clears readAt.
  const firstRead = byId.get(shown).readAt;
  r = await ok(call("POST", "/api/social/notifications/read", { as: ann, body: { ids: [shown] } }));
  assert.equal(r.updated, 0);
  assert.equal((await M.AppNotification.findById(shown).lean()).readAt.toISOString(), firstRead);
  // Plain "all" (older apps) still reads everything.
  r = await ok(call("POST", "/api/social/notifications/read", { as: ann, body: { all: true } }));
  assert.deepEqual([r.updated, r.unread], [1, 0]);
  assert.equal((await ok(call("GET", "/api/social/notifications", { as: ann }))).unread, 0);
});

/* ---------- no twin rows ---------- */

test("the same staff message sent twice in a row lands once (a twin used to stay unread after reading the first)", { skip }, async () => {
  const { ann, ben, mia } = U;
  await M.AppNotification.deleteMany({ userId: { $in: [ann._id, ben._id] } });
  pushes.length = 0;
  const msg = { userIds: [String(ann._id)], title: "Your badge is ready", body: "Pick it up at desk 3." };
  const first = await ok(call("POST", "/api/console/notify", { as: mia, body: msg }), 201);
  const again = await ok(call("POST", "/api/console/notify", { as: mia, body: msg }), 201);
  assert.deepEqual([first.sent, first.alreadySent, again.sent, again.alreadySent], [1, 0, 1, 1]);
  assert.equal(again.batchId, first.batchId);
  assert.equal(await M.AppNotification.countDocuments({ userId: ann._id }), 1);
  assert.equal(pushes.filter((p) => p.note?.kind === "personal").length, 1, "one push");
  // Adding Ben: only he gets it now. A different message is a new one.
  const both = await ok(call("POST", "/api/console/notify", { as: mia, body: { ...msg, userIds: [String(ann._id), String(ben._id)] } }), 201);
  assert.deepEqual([both.sent, both.alreadySent], [2, 1]);
  assert.equal(await M.AppNotification.countDocuments({ userId: ann._id }), 1);
  assert.equal(await M.AppNotification.countDocuments({ userId: ben._id }), 1);
  await ok(call("POST", "/api/console/notify", { as: mia, body: { ...msg, body: "Pick it up at desk 4." } }), 201);
  assert.equal(await M.AppNotification.countDocuments({ userId: ann._id }), 2);
});

test("the same person reporting the same thing twice: one staff alert, both reports saved", { skip }, async () => {
  const { ben, mia } = U;
  const target = String(new mongoose.Types.ObjectId());
  const report = { targetType: "post", targetId: target, reason: "spam" };
  await ok(call("POST", "/api/app/report", { as: ben, body: report }), 201);
  await ok(call("POST", "/api/app/report", { as: ben, body: report }), 201);
  assert.equal(await M.Report.countDocuments({ targetId: target }), 2);
  assert.equal(await M.AppNotification.countDocuments({ userId: mia._id, kind: "report", link: `ttfc://post/${target}` }), 1);
  // Someone else reporting it is news.
  await ok(call("POST", "/api/app/report", { as: U.ann, body: report }), 201);
  assert.equal(await M.AppNotification.countDocuments({ userId: mia._id, kind: "report", link: `ttfc://post/${target}` }), 2);
});
