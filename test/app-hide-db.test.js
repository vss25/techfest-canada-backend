/* "Hide from app" (shadow mode, Oct 21 2026) through the real routes, against a real (throwaway) MongoDB.
   Ann is hidden by staff; Ben and Cal are ordinary attendees; Max moderates in the app; Mia and Sam are staff.
   Ann must see the app exactly as before (her own answers unchanged) while nobody else sees her or anything she
   does, past or future: directory, search, profile, badge QR, chats and unread counts, pushes, the feed and its
   counts, comments, likes, mentions, activity dots, connection requests, groups, discussions, typing, Q&A, polls,
   saved-session counts, points and the leaderboard, report alerts. Staff and moderators see everything, labelled
   in the admin panel. Unhiding brings it all back; "also remove" soft-deletes only what she posted while hidden.
   A pass-only person hidden before they ever sign in stays hidden once they do.
   Starts a local mongod in a temp folder on a free port and stops it after; skipped when the binary isn't there
   (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Nothing leaves the machine:
   Sanity is answered by a stubbed fetch, no Stripe key, no push service configured (pushes are watched with
   observePushes), and no route used here sends an email. Fictional people, example.com. */
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
/** Waits (up to 5 s) until fn() is truthy: activity rows and pushes are written in the background. */
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
let M = {};
let jwt;
let mongoose;
let forgetHidden;
const U = {};
const pushes = [];
const ids = {};

const ticket = (ticketId, type) => ({ ticketId, type, purchaseDate: new Date("2026-10-01") });

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-app-hide-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  // Wait for mongod to listen, then connect with the driver's normal timeouts (a busy machine stays fine).
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await pause(250);
  await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_app_hide_test`);
  ({ default: jwt } = await import("jsonwebtoken"));
  ({ forgetHidden } = await import("../services/appHide.js"));
  const { observePushes } = await import("../services/push.js");
  observePushes((to, note) => pushes.push({ to, note }));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.Attendee = await imp("../models/Attendee.js");
  M.ActivityEvent = await imp("../models/ActivityEvent.js");
  M.AppNotification = await imp("../models/AppNotification.js");
  Object.assign(M, await import("../models/Admin.js"), await import("../models/Social.js"), await import("../models/Community.js"));
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/auth", await imp("../routes/auth.js"));
  app.use("/api/auth", await imp("../routes/ticketAuth.js"));
  app.use("/api/profile", await imp("../routes/profile.js"));
  app.use("/api/social", await imp("../routes/social.js"));
  app.use("/api/community", await imp("../routes/community.js"));
  app.use("/api/app", await imp("../routes/appApi.js"));
  app.use("/api/console/people", await imp("../routes/people.js"));
  app.use("/api/console", await imp("../routes/console.js"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const onApp = { appOnboarded: true, lastActiveAt: new Date("2026-10-20T12:00:00Z") };
  const mk = (key, doc) => M.User.create(doc).then((u) => { U[key] = u; });
  await Promise.all([
    mk("mia", { name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management", ...onApp }),
    mk("sam", { name: "Sam Staff", email: "sam.staff@example.com", role: "admin", staffRole: "staff", ...onApp }),
    mk("ann", { name: "Ann Hidden", email: "ann.hidden@example.com", jobTitle: "Founder", organization: "Annco",
      linkedinUrl: "https://www.linkedin.com/in/ann-hidden", topics: ["AI", "Quantum", "Robotics"], tickets: [ticket("con400000001", "connect")], ...onApp }),
    mk("ben", { name: "Ben Normal", email: "ben.normal@example.com", jobTitle: "CTO", organization: "Benco", tickets: [ticket("con400000002", "connect")], ...onApp }),
    mk("cal", { name: "Cal Normal", email: "cal.normal@example.com", jobTitle: "VP", organization: "Calco", tickets: [ticket("con400000003", "connect")], ...onApp }),
    // A moderator in the app (the staff person type gives the moderate right), not a staff account.
    mk("max", { name: "Max Moderator", email: "max.moderator@example.com", types: ["staff"], tickets: [ticket("con400000004", "connect")], ...onApp }),
    mk("dee", { name: "Dee Normal", email: "dee.normal@example.com", tickets: [ticket("con400000005", "connect")], ...onApp }),
  ]);
  const [, annSecond, gus] = await M.Attendee.create([
    { name: "Ann Hidden", email: "ann.hidden@example.com", ticketId: "con400000001", ticketType: "connect", claimedBy: U.ann._id },
    // A second pass under Ann's email that nobody has claimed: it would show as a guest entry.
    { name: "Ann Hidden", email: "ann.hidden@example.com", ticketId: "pow400000009", ticketType: "power", purchaseDate: new Date("2026-10-05") },
    // Gus has a pass and no app account yet.
    { name: "Gus Guest", email: "gus.guest@example.com", ticketId: "pow400000010", ticketType: "power", purchaseDate: new Date("2026-10-02"),
      details: { organisation: "Gusco", jobTitle: "Analyst" } },
  ]);
  ids.annSecond = String(annSecond._id);
  ids.gusPass = String(gus._id);
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const tokenFor = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function call(method, url, { as, token, body } = {}) {
  const r = await realFetch(base + url, {
    method, headers: { "content-type": "application/json", authorization: `Bearer ${token || tokenFor(as)}` },
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
const pushedTo = (u) => pushes.filter((p) => p.to.includes(idOf(u)));
const directoryIds = async (as) => (await ok(call("GET", "/api/social/attendees", { as }))).map((p) => p.id);
const directoryNames = async (as) => (await ok(call("GET", "/api/social/attendees", { as }))).map((p) => p.name);
const feedIds = async (as) => (await ok(call("GET", "/api/social/feed", { as }))).map((p) => p.id);
const feedPost = async (as, id) => (await ok(call("GET", "/api/social/feed", { as }))).find((p) => p.id === id);
const s = {};   // things made along the way
const snap = {};

/* ---------- Before: what everyone did while Ann was an ordinary attendee ---------- */

test("before hiding: Ann, Ben and Cal use the app as usual", { skip }, async () => {
  const { ann, ben, cal, max } = U;
  // Ann and Ben are connected.
  const req = await ok(call("POST", "/api/social/connections/request", { as: ann, body: { toUserId: idOf(ben) } }), 201);
  await ok(call("POST", `/api/social/connections/${req.id}/respond`, { as: ben, body: { accept: true } }));
  // Posts, a like and a comment.
  s.p0 = (await ok(call("POST", "/api/social/feed", { as: ann, body: { body: "Hello from Ann (before)" } }), 201)).id;
  s.pb = (await ok(call("POST", "/api/social/feed", { as: ben, body: { body: "Ben's post" } }), 201)).id;
  s.pc = (await ok(call("POST", "/api/social/feed", { as: cal, body: { body: "Cal's post" } }), 201)).id;
  await ok(call("POST", `/api/social/feed/${s.pb}/like`, { as: ann }));
  await ok(call("POST", `/api/social/feed/${s.pb}/comments`, { as: ann, body: { body: "Nice post Ben (before)" } }), 201);
  // A chat.
  await ok(call("POST", `/api/social/messages/${idOf(ben)}`, { as: ann, body: { body: "Hi Ben (before)" } }), 201);
  await ok(call("POST", `/api/social/messages/${idOf(ann)}`, { as: ben, body: { body: "Hi Ann" } }), 201);
  // Ben's group (Ann and Cal join), Ann's own group (Cal joins), both approved by the moderator.
  s.gb = (await ok(call("POST", "/api/community/groups", { as: ben, body: { name: "Ben's builders", description: "Founders" } }), 201)).id;
  s.ga = (await ok(call("POST", "/api/community/groups", { as: ann, body: { name: "Ann's circle", description: "Ann's group" } }), 201)).id;
  for (const g of [s.gb, s.ga]) await ok(call("POST", `/api/community/admin/group/${g}/status`, { as: max, body: { status: "approved" } }));
  await ok(call("POST", `/api/community/groups/${s.gb}/join`, { as: ann }));
  await ok(call("POST", `/api/community/groups/${s.gb}/join`, { as: cal }));
  await ok(call("POST", `/api/community/groups/${s.ga}/join`, { as: cal }));
  await ok(call("POST", `/api/community/groups/${s.gb}/messages`, { as: ann, body: { body: "Ann in the group (before)" } }), 201);
  // Discussions: Ben's (Ann replies) and Ann's own.
  s.db = (await ok(call("POST", "/api/community/discussions", { as: ben, body: { title: "Ben asks", body: "What's everyone building?" } }), 201)).id;
  s.da = (await ok(call("POST", "/api/community/discussions", { as: ann, body: { title: "Ann asks", body: "Coffee anyone?" } }), 201)).id;
  for (const d of [s.db, s.da]) await ok(call("POST", `/api/community/admin/discussion/${d}/status`, { as: max, body: { status: "approved" } }));
  await ok(call("POST", `/api/community/discussions/${s.db}/replies`, { as: ann, body: { body: "Ann's reply (before)" } }), 201);
  // Live Q&A, a poll and saved sessions.
  s.qb = (await ok(call("POST", "/api/social/sessions/s1/questions", { as: ben, body: { body: "Ben's question" } }), 201)).id;
  s.qa0 = (await ok(call("POST", "/api/social/sessions/s1/questions", { as: ann, body: { body: "Ann's question (before)" } }), 201)).id;
  await ok(call("POST", `/api/social/sessions/questions/${s.qb}/upvote`, { as: ann }));
  await ok(call("POST", "/api/social/sessions/s1/polls/p1/vote", { as: ann, body: { optionIndex: 1, options: 4 } }));
  await ok(call("POST", "/api/social/sessions/s1/polls/p1/vote", { as: ben, body: { optionIndex: 0, options: 4 } }));
  await ok(call("POST", "/api/social/sessions/s1/register", { as: ann }));
  await ok(call("POST", "/api/social/sessions/s1/register", { as: ben }));

  // Everyone sees Ann now.
  assert.ok((await directoryIds(ben)).includes(idOf(ann)));
  assert.ok((await feedIds(ben)).includes(s.p0));
  const pb = await feedPost(ben, s.pb);
  assert.equal(pb.likeCount, 1);
  assert.equal(pb.commentCount, 1);
  assert.equal(await waitFor(async () => (await ok(call("GET", "/api/social/activity/unread", { as: ben }))).feed === 2 && 2), 2, "Ann's like and comment");
  snap.benPoints = await ok(call("GET", "/api/social/points/me", { as: ben }));
});

/* ---------- Hiding ---------- */

test("staff hide Ann: audited, a private reason, and nothing Ann can read changes", { skip }, async () => {
  const { ann, sam } = U;
  snap.authMe = await ok(call("GET", "/api/auth/me", { as: ann }));
  snap.socialMe = await ok(call("GET", "/api/social/me", { as: ann }));
  snap.profile = await ok(call("GET", "/api/profile", { as: ann }));
  pushes.length = 0;

  const r = await ok(call("POST", `/api/console/people/u-${idOf(ann)}/app-hide`, { as: sam, body: { reason: "  Messaging people  who asked him to stop " } }));
  assert.equal(r.appHide.hidden, true);
  assert.equal(r.appHide.byName, "Sam Staff");
  assert.equal(r.appHide.reason, "Messaging people who asked him to stop");
  const audit = await M.AdminAudit.findOne({ action: "app_hide" }).lean();
  assert.equal(audit.adminName, "Sam Staff");
  assert.match(audit.detail, /Ann Hidden: Messaging people/);
  // On the account and on both of Ann's passes.
  const stored = await M.User.findById(ann._id).select("+appHidden").lean();
  assert.equal(stored.appHidden.byName, "Sam Staff");
  assert.equal(await M.Attendee.countDocuments({ "appHidden.at": { $exists: true } }), 2);

  // Ann's own answers are byte for byte the same (no flag, no updatedAt change).
  assert.deepEqual(await ok(call("GET", "/api/auth/me", { as: ann })), snap.authMe);
  assert.deepEqual(await ok(call("GET", "/api/social/me", { as: ann })), snap.socialMe);
  assert.deepEqual(await ok(call("GET", "/api/profile", { as: ann })), snap.profile);
  assert.doesNotMatch(JSON.stringify(snap.authMe) + JSON.stringify(snap.profile), /appHidden/);
  assert.equal(pushes.length, 0, "Ann isn't told");
});

test("the Network: Ann is gone for everyone else (directory, search, her other pass, profile); staff and moderators still see her", { skip }, async () => {
  const { ann, ben, cal, max, mia } = U;
  for (const viewer of [ben, cal]) {
    const names = await directoryNames(viewer);
    assert.ok(!names.includes("Ann Hidden"), "no entry for her account or her unclaimed pass");
    assert.ok(!(await directoryIds(viewer)).includes(idOf(ann)));
    assert.ok(!(await ok(call("GET", "/api/social/users?q=Ann", { as: viewer }))).some((u) => u.id === idOf(ann)));
    const profile = await call("GET", `/api/social/users/${idOf(ann)}`, { as: viewer });
    assert.equal(profile.status, 404);
    assert.deepEqual(profile.body, { error: "Not found" }, "the same answer as a person who isn't there");
  }
  // Ann's own Network is as before.
  const hers = await directoryIds(ann);
  assert.ok(hers.includes(idOf(ben)) && hers.includes(idOf(cal)));
  assert.equal((await ok(call("GET", `/api/social/users/${idOf(ben)}`, { as: ann }))).id, idOf(ben));
  // Moderators (in the app) and staff see her.
  assert.ok((await directoryIds(max)).includes(idOf(ann)));
  assert.equal((await ok(call("GET", `/api/social/users/${idOf(ann)}`, { as: max }))).name, "Ann Hidden");
  assert.ok((await directoryIds(mia)).includes(idOf(ann)));
  // Ben and Ann's connection: gone from Ben's list, still on Ann's.
  const benConn = await ok(call("GET", "/api/social/connections", { as: ben }));
  assert.ok(![...benConn.accepted, ...benConn.incoming, ...benConn.outgoing].some((c) => c.user.id === idOf(ann)));
  const annConn = await ok(call("GET", "/api/social/connections", { as: ann }));
  assert.ok(annConn.accepted.some((c) => c.user.id === idOf(ben)));
});

test("messages: Ann's are sent as far as she can tell; Ben's chats, unread count and phone never get them", { skip }, async () => {
  const { ann, ben, cal } = U;
  pushes.length = 0;
  const sent = await ok(call("POST", `/api/social/messages/${idOf(ben)}`, { as: ann, body: { body: "Are you there?" } }), 201);
  assert.equal(sent.sentByMe, true);
  assert.equal(sent.status, "approved");
  const thread = await ok(call("GET", `/api/social/messages/${idOf(ben)}`, { as: ann }));
  assert.deepEqual(thread.map((m) => m.body), ["Hi Ben (before)", "Hi Ann", "Are you there?"]);
  const annThreads = await ok(call("GET", "/api/social/messages", { as: ann }));
  assert.equal(annThreads.find((t) => t.user.id === idOf(ben)).lastMessage.body, "Are you there?");

  const benThreads = await ok(call("GET", "/api/social/messages", { as: ben }));
  assert.ok(!benThreads.some((t) => t.user.id === idOf(ann)), "not in Ben's chat list (old messages neither)");
  assert.deepEqual(await ok(call("GET", `/api/social/messages/${idOf(ann)}`, { as: ben })), []);
  assert.equal((await M.SocialMessage.findById(sent.id).lean()).readAt, undefined, "never marked read by Ben");
  const toAnn = await call("POST", `/api/social/messages/${idOf(ann)}`, { as: ben, body: { body: "Hello?" } });
  assert.equal(toAnn.status, 404);
  assert.equal(toAnn.body.error, "User not found");

  // Cal's message to Ben does push (the watch works); Ann's never does.
  await ok(call("POST", `/api/social/messages/${idOf(ben)}`, { as: cal, body: { body: "Hi Ben, it's Cal" } }), 201);
  await waitFor(() => pushedTo(ben).length);
  await pause(80);
  assert.equal(pushedTo(ben).length, 1);
  assert.equal(pushedTo(ben)[0].note.title, "Cal Normal");
  assert.equal(pushes.filter((p) => p.note.title === "Ann Hidden").length, 0);
});

test("the feed: Ann's posts, comments, likes and mentions are hers alone, and others' counts don't move", { skip }, async () => {
  const { ann, ben, cal, max } = U;
  pushes.length = 0;
  const t0 = new Date();
  const before = await M.ActivityEvent.countDocuments({});
  s.p1 = (await ok(call("POST", "/api/social/feed", { as: ann, body: { body: "Ann's new post @Ben", mentions: [{ type: "user", id: idOf(ben), name: "Ben Normal" }] } }), 201)).id;
  const mine = await feedIds(ann);
  assert.ok(mine.includes(s.p1) && mine.includes(s.p0));
  for (const viewer of [ben, cal]) {
    const theirs = await feedIds(viewer);
    assert.ok(!theirs.includes(s.p1) && !theirs.includes(s.p0), "past and new posts");
    assert.equal((await call("GET", `/api/social/feed/${s.p1}`, { as: viewer })).status, 404);
    assert.deepEqual(await ok(call("GET", `/api/social/feed/${s.p0}/comments`, { as: viewer })), []);
  }
  assert.equal((await call("POST", `/api/social/feed/${s.p1}/like`, { as: ben })).status, 404);
  assert.equal((await call("POST", `/api/social/feed/${s.p1}/comments`, { as: ben, body: { body: "?" } })).status, 404);

  // Ann comments on Ben's post and likes Cal's: counted for her, not for them.
  const c = await ok(call("POST", `/api/social/feed/${s.pb}/comments`, { as: ann, body: { body: "Ann's new comment" } }), 201);
  assert.equal(c.commentCount, 2);
  const like = await ok(call("POST", `/api/social/feed/${s.pc}/like`, { as: ann }));
  assert.deepEqual(like, { liked: true, likeCount: 1 });
  const annPb = await feedPost(ann, s.pb);
  assert.equal(annPb.likeCount, 1);
  assert.equal(annPb.commentCount, 2);
  assert.equal(annPb.likedByMe, true);
  const benPb = await feedPost(ben, s.pb);
  assert.equal(benPb.likeCount, 0);
  assert.equal(benPb.commentCount, 0);
  assert.ok(!(await ok(call("GET", `/api/social/feed/${s.pb}/comments`, { as: ben }))).some((x) => x.authorId === idOf(ann)));
  assert.equal((await ok(call("GET", `/api/social/feed/${s.pc}`, { as: cal }))).likeCount, 0);
  assert.equal((await feedPost(cal, s.pc)).likeCount, 0);
  // Ben's own comment and like: the answers count without Ann.
  assert.equal((await ok(call("POST", `/api/social/feed/${s.pb}/comments`, { as: ben, body: { body: "Thanks all" } }), 201)).commentCount, 1);
  assert.deepEqual(await ok(call("POST", `/api/social/feed/${s.pc}/like`, { as: ben })), { liked: true, likeCount: 1 });
  await ok(call("POST", `/api/social/feed/${s.pc}/like`, { as: ben }));

  // No activity dots from her (the mention, the comment, the like), and her old ones are gone from Ben's.
  assert.ok(await waitFor(async () => (await M.ActivityEvent.countDocuments({})) > before), "Ben's like of Cal's post did make one");
  await pause(80);
  assert.equal(await M.ActivityEvent.countDocuments({ actorId: ann._id, createdAt: { $gte: t0 } }), 0, "no activity rows from Ann");
  const benActivity = await ok(call("GET", "/api/social/activity?section=feed", { as: ben }));
  assert.ok(!benActivity.some((a) => a.actorId === idOf(ann)));
  assert.equal((await ok(call("GET", "/api/social/activity/unread", { as: ben }))).feed, 0);
  // No pushes from Ann (her mention, comment and like); Ben's like of Cal's post tells Cal (Oct 22 2026 like pushes,
  // sent after a throttle check, so wait for it).
  await waitFor(() => pushes.length >= 1);
  await pause(80);
  assert.deepEqual(pushes.map((p) => [p.to, p.note.kind, p.note.body]), [[[idOf(cal)], "like", "Ben Normal liked your post"]]);

  // The moderator sees all of it, Ann's likes counted.
  const maxFeed = await ok(call("GET", "/api/social/feed", { as: max }));
  assert.ok(maxFeed.some((p) => p.id === s.p1));
  assert.equal(maxFeed.find((p) => p.id === s.pb).commentCount, 3);
});

test("connections and badge QR: Ann's requests look sent to her and reach nobody; nobody can reach her", { skip }, async () => {
  const { ann, ben, cal } = U;
  pushes.length = 0;
  const r = await ok(call("POST", "/api/social/connections/request", { as: ann, body: { toUserId: idOf(cal) } }), 201);
  assert.equal(r.status, "pending");
  assert.equal(r.direction, "outgoing");
  s.annToCal = r.id;
  assert.ok((await ok(call("GET", "/api/social/connections", { as: ann }))).outgoing.some((x) => x.id === r.id));
  const calConn = await ok(call("GET", "/api/social/connections", { as: cal }));
  assert.equal(calConn.incoming.length, 0);
  assert.equal((await call("POST", `/api/social/connections/${r.id}/respond`, { as: cal, body: { accept: true } })).status, 404);

  const ask = await call("POST", "/api/social/connections/request", { as: ben, body: { toUserId: idOf(ann) } });
  assert.deepEqual([ask.status, ask.body.error], [404, "User not found"]);
  // Scanning her connect QR works like an unknown code: no connection.
  const scan = await call("POST", "/api/social/connections/in-person", { as: cal, body: { toUserId: idOf(ann) } });
  assert.deepEqual([scan.status, scan.body.error], [404, "User not found"]);
  assert.equal((await M.SocialConnection.findById(r.id).lean()).status, "pending");
  assert.equal((await call("PUT", `/api/social/users/${idOf(ann)}/share`, { as: ben, body: { share: [] } })).status, 404);
  // Ann scans Dee's connect QR: connected as far as Ann can tell; Dee's list (and points) never show it.
  const met = await ok(call("POST", "/api/social/connections/in-person", { as: ann, body: { toUserId: idOf(U.dee) } }));
  assert.equal(met.status, "accepted");
  assert.equal(met.user.id, idOf(U.dee));
  assert.ok((await ok(call("GET", "/api/social/connections", { as: ann }))).accepted.some((c) => c.user.id === idOf(U.dee)));
  assert.equal((await ok(call("GET", "/api/social/connections", { as: U.dee }))).accepted.length, 0);
  assert.equal((await ok(call("GET", "/api/social/points/me", { as: U.dee }))).activity["network.inPerson"], 0);
  await pause(80);
  assert.equal(pushes.length, 0);
});

test("groups, discussions and typing: nothing of Ann's shows or counts for others, and nothing she writes reaches them", { skip }, async () => {
  const { ann, ben, cal, max } = U;
  pushes.length = 0;
  const t0 = new Date();
  // Groups: Ben's counts two members for Ben and Cal (not Ann); Ann's own group is gone for Cal.
  const benGroups = await ok(call("GET", "/api/community/groups", { as: ben }));
  assert.equal(benGroups.find((g) => g.id === s.gb).memberCount, 2);
  assert.equal((await ok(call("GET", "/api/community/groups", { as: ann }))).find((g) => g.id === s.gb).memberCount, 3);
  const calGroups = await ok(call("GET", "/api/community/groups", { as: cal }));
  assert.ok(!calGroups.some((g) => g.id === s.ga));
  for (const [m, url] of [["GET", `/api/community/groups/${s.ga}/messages`], ["GET", `/api/community/groups/${s.ga}/members`], ["POST", `/api/community/groups/${s.ga}/join`]]) {
    assert.equal((await call(m, url, { as: cal })).status, 404, url);
  }
  assert.ok(!(await ok(call("GET", `/api/community/groups/${s.gb}/members`, { as: ben }))).some((x) => x.id === idOf(ann)));
  assert.ok((await ok(call("GET", `/api/community/groups/${s.gb}/members`, { as: ann }))).some((x) => x.id === idOf(ann)));
  await ok(call("POST", `/api/community/groups/${s.gb}/messages`, { as: ann, body: { body: "Ann's new group message" } }), 201);
  assert.deepEqual((await ok(call("GET", `/api/community/groups/${s.gb}/messages`, { as: ann }))).map((m) => m.body),
    ["Ann in the group (before)", "Ann's new group message"]);
  assert.deepEqual(await ok(call("GET", `/api/community/groups/${s.gb}/messages`, { as: ben })), []);
  assert.equal((await ok(call("GET", `/api/community/groups/${s.gb}/messages`, { as: max }))).length, 2);

  // Typing: Ann's never shows; Cal's does.
  await ok(call("POST", "/api/community/typing", { as: ann, body: { scope: "group", id: s.gb } }));
  assert.deepEqual((await ok(call("GET", `/api/community/typing?scope=group&id=${s.gb}`, { as: ben }))).typing, []);
  await ok(call("POST", "/api/community/typing", { as: cal, body: { scope: "group", id: s.gb } }));
  assert.deepEqual((await ok(call("GET", `/api/community/typing?scope=group&id=${s.gb}`, { as: ben }))).typing, ["Cal Normal"]);

  // Discussions: hers is gone, her replies and follows don't count; Ben (following his own) hears nothing.
  const benDisc = await ok(call("GET", "/api/community/discussions", { as: ben }));
  assert.ok(!benDisc.some((d) => d.id === s.da));
  assert.equal(benDisc.find((d) => d.id === s.db).replyCount, 0);
  assert.equal(benDisc.find((d) => d.id === s.db).followerCount, 1);
  const annDisc = await ok(call("GET", "/api/community/discussions", { as: ann }));
  assert.ok(annDisc.some((d) => d.id === s.da));
  assert.equal(annDisc.find((d) => d.id === s.db).replyCount, 1);
  const reply = await ok(call("POST", `/api/community/discussions/${s.db}/replies`, { as: ann, body: { body: "Ann's new reply" } }), 201);
  assert.equal(reply.replyCount, 2);
  assert.ok(!(await ok(call("GET", `/api/community/discussions/${s.db}/replies`, { as: ben }))).some((r) => r.authorId === idOf(ann)));
  assert.deepEqual(await ok(call("GET", `/api/community/discussions/${s.da}/replies`, { as: cal })), []);
  assert.equal((await call("POST", `/api/community/discussions/${s.da}/replies`, { as: cal, body: { body: "?" } })).status, 404);
  assert.equal((await call("POST", `/api/community/discussions/${s.da}/follow`, { as: cal, body: { follow: true } })).status, 404);
  const benReply = await ok(call("POST", `/api/community/discussions/${s.db}/replies`, { as: ben, body: { body: "Ben again" } }), 201);
  assert.equal(benReply.replyCount, 1, "Ben's answer counts without Ann's replies");
  await pause(80);
  assert.equal(pushedTo(ben).length, 0, "nothing pushed to Ben");
  assert.equal(pushedTo(cal).length, 0, "nothing pushed to Cal");
  assert.equal(await M.ActivityEvent.countDocuments({ actorId: ann._id, createdAt: { $gte: t0 } }), 0, "no activity rows from Ann");
  // Ben's reply still tells Ann, who follows his discussion: her app works as before.
  assert.equal(await waitFor(() => pushedTo(ann).length), 1);
});

test("live Q&A, polls and saved sessions: Ann's questions, upvotes and votes don't show or count for others", { skip }, async () => {
  const { ann, ben } = U;
  await ok(call("POST", "/api/social/sessions/s1/questions", { as: ann, body: { body: "Ann's new question" } }), 201);
  const benQs = await ok(call("GET", "/api/social/sessions/s1/questions", { as: ben }));
  assert.deepEqual(benQs.map((q) => q.body), ["Ben's question"]);
  assert.equal(benQs[0].upvotes, 1, "Ben's own; Ann's upvote doesn't count");
  const annQs = await ok(call("GET", "/api/social/sessions/s1/questions", { as: ann }));
  assert.equal(annQs.length, 3);
  assert.equal(annQs.find((q) => q.id === s.qb).upvotes, 2);
  assert.equal((await call("POST", `/api/social/sessions/questions/${s.qa0}/upvote`, { as: ben })).status, 404);

  assert.deepEqual(await ok(call("GET", "/api/social/sessions/s1/polls/p1/results?options=4", { as: ben })), { counts: [1, 0, 0, 0], total: 1, myVote: 0 });
  assert.deepEqual(await ok(call("GET", "/api/social/sessions/s1/polls/p1/results?options=4", { as: ann })), { counts: [1, 1, 0, 0], total: 2, myVote: 1 });
  assert.equal((await ok(call("GET", "/api/social/sessions/registrations", { as: ben }))).counts.s1, 1);
  assert.equal((await ok(call("GET", "/api/social/sessions/registrations", { as: ann }))).counts.s1, 2);
});

test("points and the leaderboard: Ann earns nobody anything and isn't on anyone else's board; she still sees herself", { skip }, async () => {
  const { ann, ben } = U;
  const now = await ok(call("GET", "/api/social/points/me", { as: ben }));
  const before = snap.benPoints.activity;
  assert.equal(now.activity["feed.likes"], before["feed.likes"] - 1, "Ann's like on Ben's post");
  assert.equal(now.activity["network.connection"], before["network.connection"] - 1, "Ben and Ann's connection");
  const benBoard = await ok(call("GET", "/api/social/points/leaderboard?limit=50", { as: ben }));
  assert.ok(!benBoard.entries.some((e) => e.user.id === idOf(ann)));
  const annBoard = await ok(call("GET", "/api/social/points/leaderboard?limit=50", { as: ann }));
  const me = annBoard.entries.find((e) => e.user.id === idOf(ann));
  assert.ok(me, "Ann is on her own board");
  assert.equal(me.rank, annBoard.me.rank);
  assert.ok(annBoard.me.points > 0);
});

test("reports: Ann's are saved but alert nobody; staff see them labelled", { skip }, async () => {
  const { ann, ben, mia } = U;
  pushes.length = 0;
  const alerts = await M.AppNotification.countDocuments({ kind: "report" });
  await ok(call("POST", "/api/app/report", { as: ann, body: { targetType: "user", targetId: idOf(ben), reason: "Ben ignores me" } }), 201);
  await pause(80);
  assert.equal(await M.AppNotification.countDocuments({ kind: "report" }), alerts);
  assert.equal(pushes.length, 0);
  // Ben's report does alert the moderators (Mia, Sam, Max).
  await ok(call("POST", "/api/app/report", { as: ben, body: { targetType: "post", targetId: s.pc, reason: "Spam" } }), 201);
  assert.ok(await waitFor(async () => (await M.AppNotification.countDocuments({ kind: "report" })) > alerts));
  const reports = await ok(call("GET", "/api/console/reports", { as: mia }));
  assert.equal(reports.find((r) => r.reason === "Ben ignores me").reporterHidden, true);
  assert.equal(reports.find((r) => r.reason === "Spam").reporterHidden, false);
});

test("the admin panel: Hidden people, labels in App moderation, People, App accounts, chats and search", { skip }, async () => {
  const { ann, ben, mia } = U;
  const posts = await ok(call("GET", "/api/console/content/post?hidden=1", { as: mia }));
  assert.deepEqual(posts.map((p) => p.body).sort(), ["Ann's new post @Ben", "Hello from Ann (before)"]);
  assert.ok(posts.every((p) => p.authorHidden === true));
  const comments = await ok(call("GET", "/api/console/content/comment", { as: mia }));
  assert.equal(comments.find((c) => c.body === "Ann's new comment").authorHidden, true);
  assert.equal(comments.find((c) => c.body === "Thanks all").authorHidden, false);
  assert.equal((await ok(call("GET", "/api/console/content/group", { as: mia }))).find((g) => g.id === s.ga).authorHidden, true);

  const list = await ok(call("GET", "/api/console/people/app-hidden", { as: mia }));
  assert.equal(list.total, 1);
  const row = list.rows[0];
  assert.equal(row.id, `u-${idOf(ann)}`);
  assert.equal(row.appHidden.reason, "Messaging people who asked him to stop");
  assert.deepEqual(
    { posts: row.whileHidden.posts, comments: row.whileHidden.comments, messages: row.whileHidden.messages, groupMessages: row.whileHidden.groupMessages,
      replies: row.whileHidden.replies, questions: row.whileHidden.questions, requests: row.whileHidden.requests, discussions: row.whileHidden.discussions },
    { posts: 1, comments: 1, messages: 1, groupMessages: 1, replies: 1, questions: 1, requests: 1, discussions: 0 });

  const people = await ok(call("GET", "/api/console/people?appHidden=yes", { as: mia }));
  assert.deepEqual(people.rows.map((r) => r.name), ["Ann Hidden"]);
  assert.equal(people.counts.appHidden, 1);
  assert.ok((await ok(call("GET", "/api/console/people?appHidden=no", { as: mia }))).rows.every((r) => !r.appHidden));
  const prof = await ok(call("GET", `/api/console/people/u-${idOf(ann)}`, { as: mia }));
  assert.equal(prof.appHide.hidden, true);
  assert.equal(prof.appHide.canChange, true);
  assert.equal(prof.person.appHidden.reason, "Messaging people who asked him to stop");
  assert.equal((await ok(call("GET", `/api/console/people/u-${idOf(ben)}`, { as: mia }))).appHide.hidden, false);

  const acct = await ok(call("GET", `/api/console/users/${idOf(ann)}`, { as: mia }));
  assert.equal(acct.user.appHidden.byName, "Sam Staff");
  assert.equal((await ok(call("GET", "/api/console/users", { as: mia }))).users.find((u) => u.id === idOf(ann)).appHidden, true);
  const key = [idOf(ann), idOf(ben)].sort().join(":");
  const msgs = await ok(call("GET", `/api/console/threads/${key}`, { as: mia }));
  assert.equal(msgs.find((m) => m.body === "Are you there?").fromHidden, true);
  assert.equal(msgs.find((m) => m.body === "Hi Ann").fromHidden, false);

  const search = await ok(call("POST", "/api/console/search", { as: mia, body: { q: "Ann Hidden" } }));
  const hit = search.groups.find((g) => g.key === "people").items.find((i) => i.title === "Ann Hidden");
  assert.equal(hit.badges[0], "Hidden from app");
});

test("who may hide: staff and management, never a staff account; attendees can't reach it", { skip }, async () => {
  const { mia, sam, ben, max } = U;
  const staff = await call("POST", `/api/console/people/u-${idOf(sam)}/app-hide`, { as: mia, body: {} });
  assert.equal(staff.status, 409);
  assert.match(staff.body.error, /Staff accounts can't be hidden/);
  for (const as of [ben, max]) assert.equal((await call("POST", `/api/console/people/u-${idOf(ben)}/app-hide`, { as, body: {} })).status, 403);
  assert.equal((await call("POST", `/api/console/people/u-${idOf(ben)}/app-unhide`, { as: mia, body: {} })).status, 409, "not hidden");
});

test("a pass-only person hidden before they sign in stays hidden once they do", { skip }, async () => {
  const { ben, mia } = U;
  assert.ok((await directoryNames(ben)).includes("Gus Guest"));
  const r = await ok(call("POST", `/api/console/people/a-${ids.gusPass}/app-hide`, { as: mia, body: { reason: "Known trouble" } }));
  assert.equal(r.appHide.hidden, true);
  assert.equal(r.appHide.onApp, false);
  assert.ok(!(await directoryNames(ben)).includes("Gus Guest"));
  // Gus signs in with his pass: a new account, hidden from the start, and he can't tell.
  const login = await realFetch(`${base}/api/auth/ticket-login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lastName: "Guest", ticketId: "pow400000010" }),
  }).then((x) => x.json());
  assert.ok(login.token);
  assert.equal(login.created, true);
  await M.User.updateOne({ email: "gus.guest@example.com" }, { $set: { appOnboarded: true } });
  const gusMe = await ok(call("GET", "/api/social/me", { token: login.token }));
  assert.equal(gusMe.name, "Gus Guest");
  assert.doesNotMatch(JSON.stringify(await ok(call("GET", "/api/auth/me", { token: login.token }))), /appHidden/);
  const post = await ok(call("POST", "/api/social/feed", { token: login.token, body: { body: "Gus was here" } }), 201);
  assert.ok((await feedIds(ben)).every((id) => id !== post.id));
  assert.ok(!(await directoryIds(ben)).includes(gusMe.id));
  const prof = await ok(call("GET", `/api/console/people/u-${gusMe.id}`, { as: mia }));
  assert.equal(prof.appHide.hidden, true);
  assert.equal(prof.appHide.reason, "Known trouble");
  // Shown again: the flag comes off his account and his pass.
  await ok(call("POST", `/api/console/people/u-${gusMe.id}/app-unhide`, { as: mia, body: { removeWhileHidden: false } }));
  assert.equal(await M.Attendee.countDocuments({ _id: ids.gusPass, "appHidden.at": { $exists: true } }), 0);
  assert.ok((await feedIds(ben)).includes(post.id));
});

test("unhide with \"also remove\": everything from before comes back, what she posted while hidden is soft-deleted", { skip }, async () => {
  const { ann, ben, cal, mia } = U;
  const r = await ok(call("POST", `/api/console/people/u-${idOf(ann)}/app-unhide`, { as: mia, body: { removeWhileHidden: true } }));
  assert.equal(r.appHide.hidden, false);
  assert.deepEqual(
    { posts: r.removed.posts, comments: r.removed.comments, messages: r.removed.messages, groupMessages: r.removed.groupMessages,
      replies: r.removed.replies, questions: r.removed.questions, requests: r.removed.requests },
    { posts: 1, comments: 1, messages: 1, groupMessages: 1, replies: 1, questions: 1, requests: 1 });
  const audit = await M.AdminAudit.findOne({ action: "app_unhide", targetId: `u-${idOf(ann)}` }).lean();
  assert.match(audit.detail, /removed what they posted while hidden/);
  assert.equal(await M.User.countDocuments({ _id: ann._id, "appHidden.at": { $exists: true } }), 0);
  assert.equal(await M.Attendee.countDocuments({ ticketId: { $in: ["con400000001", "pow400000009"] }, "appHidden.at": { $exists: true } }), 0);

  // Back for everyone, from before; the while-hidden things are gone (kept for staff as "hidden").
  assert.ok((await directoryIds(ben)).includes(idOf(ann)));
  const benFeed = await feedIds(ben);
  assert.ok(benFeed.includes(s.p0) && !benFeed.includes(s.p1));
  const p1 = await M.SocialPost.findById(s.p1).lean();
  assert.equal(p1.status, "hidden");
  assert.equal(String(p1.removedBy), idOf(mia));
  const pb = await feedPost(ben, s.pb);
  assert.equal(pb.commentCount, 2, "Ann's old comment and Ben's; the while-hidden one came off the count");
  assert.equal(pb.likeCount, 1);
  assert.deepEqual((await ok(call("GET", `/api/social/messages/${idOf(ann)}`, { as: ben }))).map((m) => m.body), ["Hi Ben (before)", "Hi Ann"]);
  assert.ok((await ok(call("GET", "/api/social/messages", { as: ben }))).some((t) => t.user.id === idOf(ann)));
  assert.ok((await ok(call("GET", "/api/social/connections", { as: ben }))).accepted.some((c) => c.user.id === idOf(ann)));
  assert.equal((await ok(call("GET", "/api/social/connections", { as: cal }))).incoming.length, 0, "her while-hidden request was withdrawn (declined)");
  assert.deepEqual((await ok(call("GET", `/api/community/groups/${s.gb}/messages`, { as: ben }))).map((m) => m.body), ["Ann in the group (before)"]);
  assert.ok((await ok(call("GET", "/api/community/groups", { as: cal }))).some((g) => g.id === s.ga));
  assert.equal((await ok(call("GET", "/api/community/discussions", { as: ben }))).find((d) => d.id === s.db).replyCount, 2, "Ann's old reply and Ben's");
  assert.deepEqual((await ok(call("GET", "/api/social/sessions/s1/questions", { as: ben }))).map((q) => q.body).sort(), ["Ann's question (before)", "Ben's question"]);
  assert.deepEqual(await ok(call("GET", "/api/social/sessions/s1/polls/p1/results?options=4", { as: ben })), { counts: [1, 1, 0, 0], total: 2, myVote: 0 });
});

test("hide again, then unhide keeping everything: what she posted while hidden appears to others", { skip }, async () => {
  const { ann, ben, sam } = U;
  await ok(call("POST", `/api/console/people/u-${idOf(ann)}/app-hide`, { as: sam, body: {} }));
  const p2 = (await ok(call("POST", "/api/social/feed", { as: ann, body: { body: "Ann's post while hidden again" } }), 201)).id;
  assert.ok(!(await feedIds(ben)).includes(p2));
  const r = await ok(call("POST", `/api/console/people/u-${idOf(ann)}/app-unhide`, { as: sam, body: { removeWhileHidden: false } }));
  assert.equal(r.removed, null);
  assert.ok((await feedIds(ben)).includes(p2));
  const audit = await M.AdminAudit.find({ action: "app_unhide" }).sort({ at: -1, _id: -1 }).limit(1).lean();
  assert.match(audit[0].detail, /kept what they posted while hidden/);
});

test("the hidden set is cached a few seconds but staff changes apply at once on this server", { skip }, async () => {
  const { ann, ben } = U;
  // Set directly (another server would): this one sees it after forgetHidden (or within seconds).
  await M.User.updateOne({ _id: ann._id }, { $set: { appHidden: { at: new Date(), byName: "Elsewhere" } } });
  forgetHidden();
  assert.ok(!(await directoryIds(ben)).includes(idOf(ann)));
  await M.User.updateOne({ _id: ann._id }, { $unset: { appHidden: 1 } });
  forgetHidden();
  assert.ok((await directoryIds(ben)).includes(idOf(ann)));
});
