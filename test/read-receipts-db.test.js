/* Read receipts (deliveredAt / readAt) and availabilitySpots (Oct 21 2026) through the real routes, against a real
   (throwaway) MongoDB. Ann, Ben and Cal are attendees, Hal is hidden from the app by staff, Mia is staff (management).
   Delivered = the recipient's app fetched it (chat list or chat), read = they opened the chat; only approved
   messages, never from someone the recipient can't see (hidden, blocked). A hidden person's own messages read as
   delivered, never read. A held message gets no ticks, isn't in the other person's list or unread count, and pushes
   when a moderator approves it. Places per block are checked against the picked blocks and come back everywhere
   availabilitySlots does. Starts a local mongod in a temp folder on a free port and stops it after; skipped when the
   binary isn't there (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Nothing leaves
   the machine: Sanity is answered by a stubbed fetch, no push service is configured (pushes are watched with
   observePushes, web push goes to a stubbed sender). Fictional people, example.com. */
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
async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await pause(50);
  }
}
const portOpen = (port) => new Promise((ok) => { const c = net.connect(port, "127.0.0.1", () => { c.end(); ok(true); }); c.on("error", () => ok(false)); });

let mongod = null;
let dbDir = "";
let server = null;
let base = "";
let jwt;
let mongoose;
let forgetHidden;
let threadKey;
const M = {};
const U = {};
const pushes = [];

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-receipts-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await pause(250);
  await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_receipts_test`);
  ({ default: jwt } = await import("jsonwebtoken"));
  ({ forgetHidden } = await import("../services/appHide.js"));
  ({ threadKey } = await import("../services/socialHelpers.js"));
  const { observePushes } = await import("../services/push.js");
  observePushes((to, note) => pushes.push({ to, note }));
  (await import("../services/webPush.js")).useSender(async () => ({ statusCode: 201 }));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  Object.assign(M, await import("../models/Social.js"));
  await M.SocialMessage.init();
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/auth", await imp("../routes/auth.js"));
  app.use("/api/profile", await imp("../routes/profile.js"));
  app.use("/api/social", await imp("../routes/social.js"));
  app.use("/api/app", await imp("../routes/appApi.js"));
  app.use("/api/console", await imp("../routes/console.js"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const onApp = { appOnboarded: true, lastActiveAt: new Date("2026-10-20T12:00:00Z") };
  const t = (id) => [{ ticketId: id, type: "connect", purchaseDate: new Date("2026-10-01") }];
  const mk = (key, doc) => M.User.create(doc).then((u) => { U[key] = u; });
  await Promise.all([
    mk("mia", { name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management", ...onApp }),
    mk("ann", { name: "Ann Sender", email: "ann.sender@example.com", jobTitle: "Founder", organization: "Annco", tickets: t("con500000001"), ...onApp }),
    mk("ben", { name: "Ben Reader", email: "ben.reader@example.com", jobTitle: "CTO", organization: "Benco", tickets: t("con500000002"), ...onApp }),
    mk("cal", { name: "Cal Blocked", email: "cal.blocked@example.com", tickets: t("con500000003"), ...onApp }),
    mk("hal", { name: "Hal Hidden", email: "hal.hidden@example.com", tickets: t("con500000004"), ...onApp }),
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
  return { status: r.status, body: json };
}
const ok = async (p, want = 200) => {
  const r = await p;
  assert.equal(r.status, want, JSON.stringify(r.body));
  return r.body;
};
const idOf = (u) => String(u._id);
const send = (from, to, body) => ok(call("POST", `/api/social/messages/${idOf(to)}`, { as: from, body: { body } }), 201);
const thread = (as, other) => ok(call("GET", `/api/social/messages/${idOf(other)}`, { as }));
const chats = (as) => ok(call("GET", "/api/social/messages", { as }));
const chatWith = async (as, other) => (await chats(as)).find((t) => t.user.id === idOf(other));
const stored = (id) => M.SocialMessage.findById(id).lean();

/* ---------- read receipts ---------- */

test("sent → delivered when Ben's app fetches his chats → read when he opens the chat (one tick, two, blue)", { skip }, async () => {
  const { ann, ben } = U;
  const sent = await send(ann, ben, "Coffee at the Expo floor?");
  assert.deepEqual(Object.keys(sent).sort(), ["body", "createdAt", "deliveredAt", "id", "readAt", "sentByMe", "status"]);
  assert.deepEqual([sent.status, sent.sentByMe, sent.deliveredAt, sent.readAt], ["approved", true, null, null]);

  // Ann's own views before Ben's app has fetched anything: one tick.
  let mine = (await thread(ann, ben)).find((m) => m.id === sent.id);
  assert.deepEqual([mine.deliveredAt, mine.readAt], [null, null]);
  let row = await chatWith(ann, ben);
  assert.deepEqual(Object.keys(row.lastMessage).sort(), ["body", "createdAt", "deliveredAt", "readAt", "sentByMe", "status"]);
  assert.deepEqual([row.lastMessage.sentByMe, row.lastMessage.status, row.lastMessage.deliveredAt, row.lastMessage.readAt], [true, "approved", null, null]);

  // Ben's app polls his chat list: delivered (two grey ticks), still unread.
  const benRow = await chatWith(ben, ann);
  assert.equal(benRow.unread, 1);
  assert.equal(benRow.lastMessage.sentByMe, false);
  mine = (await thread(ann, ben)).find((m) => m.id === sent.id);
  assert.ok(mine.deliveredAt);
  assert.equal(mine.readAt, null);
  const deliveredAt = mine.deliveredAt;
  // Polling again doesn't move it (set only while null).
  await chats(ben);
  assert.equal((await stored(sent.id)).deliveredAt.toISOString(), deliveredAt);

  // Ben opens the chat: read (blue ticks), delivered unchanged; his unread count is 0.
  await thread(ben, ann);
  mine = (await thread(ann, ben)).find((m) => m.id === sent.id);
  assert.ok(mine.readAt);
  assert.equal(mine.deliveredAt, deliveredAt);
  row = await chatWith(ann, ben);
  assert.ok(row.lastMessage.readAt);
  assert.equal((await chatWith(ben, ann)).unread, 0);
});

test("opening a chat sets readAt and deliveredAt together when the list was never fetched", { skip }, async () => {
  const { ann, ben } = U;
  const sent = await send(ben, ann, "Yes, 2 PM works");
  await thread(ann, ben);
  const m = await stored(sent.id);
  assert.ok(m.readAt && m.deliveredAt);
  assert.equal(m.readAt.getTime(), m.deliveredAt.getTime());
  const view = (await thread(ben, ann)).find((x) => x.id === sent.id);
  assert.equal(view.readAt, view.deliveredAt);
});

test("?peek=1 (a background refresh) marks delivered, never read; the plain GET (chat on screen) reads", { skip }, async () => {
  const { ann, ben } = U;
  const first = await send(ann, ben, "Are you at the Harbour Ballroom?");
  const peek = (as, other, q = "peek=1") => ok(call("GET", `/api/social/messages/${idOf(other)}?${q}`, { as }));
  // Ben's app refreshes the chat in the background: Ann sees two grey ticks, not blue; his unread count stays.
  const items = await peek(ben, ann);
  assert.ok(items.some((m) => m.id === first.id), "peek returns the chat as usual");
  let s = await stored(first.id);
  assert.ok(s.deliveredAt);
  assert.equal(s.readAt, undefined);
  const deliveredAt = s.deliveredAt.toISOString();
  let mine = (await thread(ann, ben)).find((m) => m.id === first.id);
  assert.deepEqual([mine.deliveredAt, mine.readAt], [deliveredAt, null]);
  assert.equal((await chatWith(ben, ann)).unread, 1);
  // Peeking again moves nothing; an unknown peek value is the plain GET (read).
  await peek(ben, ann);
  assert.equal((await stored(first.id)).deliveredAt.toISOString(), deliveredAt);
  const second = await send(ann, ben, "Second one");
  await peek(ben, ann, "peek=true");
  s = await stored(second.id);
  assert.ok(s.readAt && s.deliveredAt);
  // Ben opens the chat: read, delivered unchanged.
  await thread(ben, ann);
  s = await stored(first.id);
  assert.ok(s.readAt);
  assert.equal(s.deliveredAt.toISOString(), deliveredAt);
  mine = (await thread(ann, ben)).find((m) => m.id === first.id);
  assert.ok(mine.readAt);
  assert.equal((await chatWith(ben, ann)).unread, 0);
});

test("delivered marking walks the { toUserId, deliveredAt } index and only what's undelivered", { skip }, async () => {
  const indexes = await M.SocialMessage.collection.indexes();
  assert.ok(indexes.some((i) => JSON.stringify(i.key) === JSON.stringify({ toUserId: 1, deliveredAt: 1 })));
  const filter = { toUserId: U.ben._id, deliveredAt: null, status: "approved" };
  const plan = await M.SocialMessage.find(filter).explain("executionStats");
  const stage = JSON.stringify(plan.queryPlanner.winningPlan);
  assert.match(stage, /toUserId_1_deliveredAt_1/);
  assert.equal(plan.executionStats.totalDocsExamined, 0);   // everything to Ben is delivered already
});

test("held: no ticks for the sender, not in Ben's list or unread, never marked; approval delivers it with a push", { skip }, async () => {
  const { ann, ben, mia } = U;
  const held = await M.SocialMessage.create({ threadKey: threadKey(ann._id, ben._id), fromUserId: ann._id, toUserId: ben._id, body: "held words", status: "held" });
  const id = String(held._id);
  // Ann sees it as held (a clock), no ticks.
  const mine = (await thread(ann, ben)).find((m) => m.id === id);
  assert.deepEqual([mine.status, mine.deliveredAt, mine.readAt], ["held", null, null]);
  assert.equal((await chatWith(ann, ben)).lastMessage.status, "held");
  // Ben: not in his preview, not counted, not in the chat, never marked.
  const benRow = await chatWith(ben, ann);
  assert.notEqual(benRow.lastMessage.body, "held words");
  assert.equal(benRow.unread, 0);
  assert.ok(!(await thread(ben, ann)).some((m) => m.id === id));
  const s = await stored(id);
  assert.equal(s.deliveredAt, undefined);
  assert.equal(s.readAt, undefined);

  // A moderator approves it: Ben gets the push now, then his app marks it.
  pushes.length = 0;
  await ok(call("POST", `/api/social/admin/message/${id}/status`, { as: mia, body: { status: "approved" } }));
  const push = await waitFor(() => pushes.find((p) => p.note.id === id));
  assert.ok(push, "approval pushes");
  assert.deepEqual(push.to, [idOf(ben)]);
  assert.deepEqual([push.note.kind, push.note.thread, push.note.title, push.note.body], ["dm", `dm.${idOf(ann)}`, "Ann Sender", "held words"]);
  assert.equal((await chatWith(ben, ann)).unread, 1);
  assert.ok((await stored(id)).deliveredAt);
  // Approving again (or hiding and approving) never pushes twice.
  pushes.length = 0;
  await ok(call("POST", `/api/social/admin/message/${id}/status`, { as: mia, body: { status: "approved" } }));
  await pause(300);
  assert.equal(pushes.filter((p) => p.note.id === id).length, 0);
});

test("hidden from the app: nobody who can't see Hal marks his messages; his own view says delivered, never read", { skip }, async () => {
  const { hal, ben, mia } = U;
  await M.User.updateOne({ _id: hal._id }, { $set: { appHidden: { at: new Date(), byName: "Mia Manager" } } }, { timestamps: false });
  forgetHidden();
  pushes.length = 0;
  const toBen = await send(hal, ben, "Hello Ben");
  // His send answer and his chat: two grey ticks straight away (as if delivered), never blue.
  assert.equal(toBen.deliveredAt, toBen.createdAt);
  assert.equal(toBen.readAt, null);
  // Ben can't see Hal: nothing marked (list, background refresh or open chat), no push.
  await chats(ben);
  assert.deepEqual(await ok(call("GET", `/api/social/messages/${idOf(hal)}?peek=1`, { as: ben })), []);
  assert.deepEqual(await thread(ben, hal), []);
  const s = await stored(toBen.id);
  assert.equal(s.deliveredAt, undefined);
  assert.equal(s.readAt, undefined);
  let mine = (await thread(hal, ben)).find((m) => m.id === toBen.id);
  assert.deepEqual([mine.deliveredAt, mine.readAt], [toBen.createdAt, null]);
  assert.equal((await chatWith(hal, ben)).lastMessage.deliveredAt, toBen.createdAt);

  // Staff see hidden people: Mia's app really marks his message, but Hal still never sees it read.
  const toMia = await send(hal, mia, "Hello Mia");
  await ok(call("GET", `/api/social/messages/${idOf(hal)}?peek=1`, { as: mia }));
  assert.ok((await stored(toMia.id)).deliveredAt);
  assert.equal((await stored(toMia.id)).readAt, undefined);
  await thread(mia, hal);
  assert.ok((await stored(toMia.id)).readAt);
  mine = (await thread(hal, mia)).find((m) => m.id === toMia.id);
  assert.deepEqual([mine.deliveredAt, mine.readAt], [toMia.createdAt, null]);
  assert.equal((await chatWith(hal, mia)).lastMessage.readAt, null);
  await pause(300);
  assert.equal(pushes.length, 0, "nothing Hal does pushes");

  // Hal's own inbox works as usual: Mia's reply to him is marked when his app fetches it.
  const reply = await send(mia, hal, "Hi Hal");
  await chats(hal);
  assert.ok((await stored(reply.id)).deliveredAt);
});

test("blocked: Ann's app never marks a message from Cal after she blocks him", { skip }, async () => {
  const { ann, cal } = U;
  const m = await send(cal, ann, "Hi Ann");
  await ok(call("POST", "/api/app/block", { as: ann, body: { userId: idOf(cal) } }));
  await chats(ann);
  assert.deepEqual(await ok(call("GET", `/api/social/messages/${idOf(cal)}?peek=1`, { as: ann })), []);
  assert.deepEqual(await thread(ann, cal), []);
  const s = await stored(m.id);
  assert.equal(s.deliveredAt, undefined);
  assert.equal(s.readAt, undefined);
  // Cal can't tell anything from his side: the chat is gone for both, as before.
  assert.deepEqual(await thread(cal, ann), []);
});

/* ---------- availabilitySpots ---------- */

test("profile: places per block saved with the slots, cleaned, and returned by GET / PATCH / auth me", { skip }, async () => {
  const { ann } = U;
  const res = await ok(call("PATCH", "/api/profile", { as: ann, body: {
    availabilitySlots: ["d1-12", "d1-14", "d1-16", "d2-08"],
    meetingSpot: "Harbour Ballroom foyer",
    availabilitySpots: { "d1-16": "  Expo floor ", "d1-18": "Coffee bar", "d2-08": "", "d9-99": "Nowhere", "d1-12": "x".repeat(90) },
  } }));
  const want = { "d1-12": "x".repeat(60), "d1-16": "Expo floor" };
  assert.deepEqual(res.user.availabilitySpots, want);
  assert.deepEqual((await ok(call("GET", "/api/profile", { as: ann }))).availabilitySpots, want);
  assert.deepEqual((await ok(call("GET", "/api/auth/me", { as: ann }))).availabilitySpots, want);
  assert.deepEqual((await M.User.findById(ann._id).lean()).availabilitySpots, want);

  // An older app sends slots only: the place of a block no longer picked goes.
  await ok(call("PATCH", "/api/profile", { as: ann, body: { availabilitySlots: ["d1-16", "d2-08"] } }));
  assert.deepEqual((await M.User.findById(ann._id).lean()).availabilitySpots, { "d1-16": "Expo floor" });
  // Spots alone are checked against the stored slots; a non-object alone is "nothing to change".
  await ok(call("PATCH", "/api/profile", { as: ann, body: { availabilitySpots: { "d2-08": "Hotel lobby", "d1-12": "Coffee bar" } } }));
  assert.deepEqual((await ok(call("GET", "/api/profile", { as: ann }))).availabilitySpots, { "d2-08": "Hotel lobby" });
  assert.equal((await call("PATCH", "/api/profile", { as: ann, body: { availabilitySpots: "Expo floor" } })).status, 400);
  // Someone who never set any gets {}.
  assert.deepEqual((await ok(call("GET", "/api/profile", { as: U.cal }))).availabilitySpots, {});
  assert.deepEqual((await ok(call("GET", "/api/auth/me", { as: U.cal }))).availabilitySpots, {});
});

test("everyone else sees them where they see availabilitySlots: profile, directory, search, chat list, social me", { skip }, async () => {
  const { ann, ben } = U;
  await ok(call("PATCH", "/api/profile", { as: ann, body: {
    availabilitySlots: ["d1-12", "d1-14"], meetingSpot: "Harbour Ballroom foyer", availabilitySpots: { "d1-14": "Expo floor" },
  } }));
  const want = { "d1-14": "Expo floor" };
  const profile = await ok(call("GET", `/api/social/users/${idOf(ann)}`, { as: ben }));
  assert.deepEqual([profile.availabilitySlots, profile.meetingSpot, profile.availabilitySpots], [["d1-12", "d1-14"], "Harbour Ballroom foyer", want]);
  const entry = (await ok(call("GET", "/api/social/attendees", { as: ben }))).find((p) => p.id === idOf(ann));
  assert.deepEqual(entry.availabilitySpots, want);
  const card = (await ok(call("GET", "/api/social/users?q=Ann", { as: ben }))).find((p) => p.id === idOf(ann));
  assert.deepEqual(card.availabilitySpots, want);
  assert.deepEqual((await chatWith(ben, ann)).user.availabilitySpots, want);
  assert.deepEqual((await ok(call("GET", "/api/social/me", { as: ann }))).availabilitySpots, want);
});

test("console: staff edit places like the app (only picked blocks) and see them on the person", { skip }, async () => {
  const { ann, mia } = U;
  const r = await ok(call("PATCH", `/api/console/users/${idOf(ann)}`, { as: mia, body: {
    availabilitySlots: ["d2-10", "d2-12"], availabilitySpots: { "d2-10": "Registration desk", "d1-14": "Expo floor" },
  } }));
  assert.ok(r.changed.includes("availabilitySlots"));
  assert.ok(r.changed.includes("availabilitySpots"));
  const person = await ok(call("GET", `/api/console/users/${idOf(ann)}`, { as: mia }));
  assert.deepEqual(person.user.availabilitySpots, { "d2-10": "Registration desk" });
  assert.equal("webPushSubs" in person.user, false);
  // Slots only: stale places are dropped from what's stored too.
  const r2 = await ok(call("PATCH", `/api/console/users/${idOf(ann)}`, { as: mia, body: { availabilitySlots: ["d2-12"] } }));
  assert.ok(r2.changed.includes("availabilitySpots"));
  assert.deepEqual((await M.User.findById(ann._id).lean()).availabilitySpots ?? {}, {});
});
