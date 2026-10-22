/* Session chats (Oct 21 2026) and the leaderboard switch, through the real job and routes, against a real
   (throwaway) MongoDB. Ann and Cal are attendees, Ben is suspended, Hal is hidden from the app, Dee never
   registers, Mia is staff (moderator). The agenda is passed to the job (no Sanity); the job's clock is the
   festival's (26 Oct 2026, Toronto = UTC-4), the routes' clock is the real one, so their checks set the group's
   times around now. Starts a local mongod in a temp folder on a free port and stops it after; skipped when the
   binary isn't there (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Nothing leaves
   the machine: Sanity is answered by a stubbed fetch, pushes are only watched (observePushes). Fictional people. */
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
let SG;
const M = {};
const U = {};
const pushes = [];

// The agenda: a panel at 10:00 on day 1 (14:00 UTC), lunch at 12:35, a fireside at 15:00.
const PANEL = { _id: "session-d1-06", sessionId: "d1-06", day: 1, time: "10:00", endTime: "10:45", title: "Quantum in the Enterprise", type: "Panel", format: "panel", stage: "Harbour Ballroom" };
const LUNCH = { _id: "session-d1-09", sessionId: "d1-09", day: 1, time: "12:35", endTime: "13:20", title: "Networking Lunch", type: "Lunch", format: "networking", stage: "Harbour Foyer" };
const FIRESIDE = { _id: "session-d1-12", sessionId: "", day: 1, time: "15:00", endTime: "15:30", title: "Fireside: Robots at Work", type: "Fireside Chat", format: "fireside", stage: "" };
const AGENDA = [PANEL, LUNCH, FIRESIDE];
const T = (iso) => new Date(iso);

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-session-groups-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await pause(250);
  await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_session_groups_test`);
  ({ default: jwt } = await import("jsonwebtoken"));
  const { observePushes } = await import("../services/push.js");
  observePushes((to, note) => pushes.push({ to, note }));
  SG = await import("../services/sessionGroups.js");
  M.User = (await import("../models/User.js")).default;
  M.JobLock = (await import("../models/JobLock.js")).default;
  Object.assign(M, await import("../models/Social.js"), await import("../models/Community.js"));
  await M.CommunityGroup.init();
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/social", (await import("../routes/social.js")).default);
  app.use("/api/community", (await import("../routes/community.js")).default);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const onApp = { appOnboarded: true, lastActiveAt: new Date("2026-10-20T12:00:00Z") };
  const t = (id) => [{ ticketId: id, type: "connect", purchaseDate: new Date("2026-10-01") }];
  const mk = (key, doc) => M.User.create(doc).then((u) => { U[key] = u; });
  await Promise.all([
    mk("mia", { name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management", ...onApp }),
    mk("ann", { name: "Ann Attendee", email: "ann.attendee@example.com", organization: "Annco", linkedinUrl: "https://www.linkedin.com/in/ann-example", tickets: t("con600000001"), ...onApp }),
    mk("ben", { name: "Ben Banned", email: "ben.banned@example.com", banned: true, tickets: t("con600000002"), ...onApp }),
    mk("cal", { name: "Cal Late", email: "cal.late@example.com", tickets: t("con600000003"), ...onApp }),
    mk("hal", { name: "Hal Hidden", email: "hal.hidden@example.com", tickets: t("con600000004"), appHidden: { at: new Date("2026-10-20T10:00:00Z"), byName: "Mia Manager" }, ...onApp }),
    mk("dee", { name: "Dee Elsewhere", email: "dee.elsewhere@example.com", tickets: t("con600000005"), ...onApp }),
  ]);
  (await import("../services/appHide.js")).forgetHidden();
  // Ann, Ben and Hal saved the panel (the apps' only "interested" marker); Ann the lunch too; Ann the fireside by its _id.
  await M.SessionRegistration.create([
    { userId: U.ann._id, sessionId: "d1-06" }, { userId: U.ben._id, sessionId: "d1-06" }, { userId: U.hal._id, sessionId: "session-d1-06" },
    { userId: U.ann._id, sessionId: "d1-09" }, { userId: U.ann._id, sessionId: "session-d1-12" },
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
const quiet = { log() {}, error() {} };
/** One run at `now`. The test clock jumps around, so the minute's claim is cleared first (the claim is tested on its own). */
const run = async (now, owner = "test-a") => {
  await M.JobLock.deleteMany({});
  return SG.runSessionGroups({ now: T(now), owner, sessions: AGENDA, log: quiet });
};
const group = (sessionId) => M.CommunityGroup.findOne({ sessionId }).lean();
const memberIds = (g) => (g?.members || []).map(String).sort();
const ids = (...keys) => keys.map((k) => String(U[k]._id)).sort();

/* ---------- the job ---------- */

test("job: nothing before 30 min; at 30 min the panel's chat, with the people who saved it (no suspended accounts)", { skip }, async () => {
  assert.deepEqual(await run("2026-10-26T13:29:00Z"), { claimed: true, due: 0, created: 0, added: 0 });
  assert.equal(await M.CommunityGroup.countDocuments({}), 0);
  const r = await run("2026-10-26T13:30:00Z");
  assert.deepEqual([r.claimed, r.due, r.created], [true, 1, 1]);
  const g = await group("d1-06");
  assert.deepEqual([g.name, g.description, g.status, g.system, String(g.ownerId), g.ownerName, g.sessionDocId],
    ["Quantum in the Enterprise", "Session chat · Mon 26 Oct 10:00 AM · Harbour Ballroom", "approved", true, String(SG.SYSTEM_ID), "TTFC", "session-d1-06"]);
  assert.equal(g.sessionStartsAt.toISOString(), "2026-10-26T14:00:00.000Z");
  // Ann (by sessionId) and Hal (hidden, registered by _id) are in; Ben (suspended) isn't; nobody else.
  assert.deepEqual(memberIds(g), ids("ann", "hal"));
  const msgs = await M.GroupMessage.find({ groupId: g._id }).lean();
  assert.deepEqual(msgs.map((m) => [m.body, m.authorName, String(m.authorId), m.status]),
    [["Welcome to the Quantum in the Enterprise chat. It starts at 10:00 AM in Harbour Ballroom.", "TTFC", String(SG.SYSTEM_ID), "approved"]]);
  // No push for the welcome (only messages people send push).
  assert.equal(pushes.length, 0);
});

test("job: idempotent — the same minute is held, later runs make nothing twice; the lunch never gets one", { skip }, async () => {
  // Another server holds this minute: the claim made at 13:30:00 lasts 50 s.
  assert.equal((await SG.runSessionGroups({ now: T("2026-10-26T13:30:10Z"), owner: "test-b", sessions: AGENDA, log: quiet })).claimed, false);
  for (const now of ["2026-10-26T13:31:00Z", "2026-10-26T13:32:00Z", "2026-10-26T14:10:00Z"]) {
    const r = await run(now);
    assert.deepEqual([r.claimed, r.created], [true, 0], now);
  }
  assert.equal(await M.CommunityGroup.countDocuments({ sessionId: "d1-06" }), 1);
  assert.equal(await M.GroupMessage.countDocuments({ groupId: (await group("d1-06"))._id }), 1);
  // Lunch: due by time, a meal by title and type: no chat, even with Ann registered.
  assert.equal((await run("2026-10-26T12:20:00Z")).due, 0);
  await run("2026-10-26T16:20:00Z");
  assert.equal(await M.CommunityGroup.countDocuments({ sessionId: { $in: ["d1-09", "session-d1-09"] } }), 0);
  assert.equal(pushes.length, 0);
});

test("job: two servers racing for the same session make one chat and one welcome", { skip }, async () => {
  // Same minute: one claims, the other doesn't.
  await M.JobLock.deleteMany({});
  const [a, b] = await Promise.all(["server-1", "server-2"].map((owner) => SG.runSessionGroups({ now: T("2026-10-26T14:30:00Z"), owner, sessions: AGENDA, log: quiet })));
  assert.equal([a.claimed, b.claimed].filter(Boolean).length, 1);
  // Two servers both holding a claim (a slow run, clocks apart) work at the same moment: the unique session id
  // still allows one chat and one welcome.
  await M.JobLock.deleteMany({});
  assert.equal(await SG.claimRun({ owner: "server-1", now: T("2026-10-26T18:31:00Z") }), true);
  assert.equal(await SG.claimRun({ owner: "server-2", now: T("2026-10-26T18:33:00Z") }), true);
  assert.equal(await SG.claimRun({ owner: "server-3", now: T("2026-10-26T18:33:30Z") }), false);   // held until 18:33:50
  const both = await Promise.all([
    SG.runSessionGroups({ now: T("2026-10-26T18:31:00Z"), owner: "server-1", sessions: AGENDA, log: quiet, held: true }),   // the fireside: 3 PM Toronto
    SG.runSessionGroups({ now: T("2026-10-26T18:33:00Z"), owner: "server-2", sessions: AGENDA, log: quiet, held: true }),
  ]);
  assert.ok(both.every((r) => r.claimed && r.due === 1));
  const fireside = await M.CommunityGroup.find({ sessionId: "session-d1-12" }).lean();   // no sessionId on the agenda: its _id
  assert.equal(fireside.length, 1);
  assert.equal(fireside[0].description, "Session chat · Mon 26 Oct 3:00 PM · Centre Stage · Harbour Ballroom");
  assert.deepEqual(memberIds(fireside[0]), ids("ann"));
  assert.equal(await M.GroupMessage.countDocuments({ groupId: fireside[0]._id }), 1);
  assert.equal(both.reduce((n, r) => n + r.created, 0), 1);
});

test("job: late registrants are added on the next run, until the session ends; never after", { skip }, async () => {
  await M.SessionRegistration.create({ userId: U.dee._id, sessionId: "d1-06" });   // straight into the database (no route)
  const r = await run("2026-10-26T14:40:00Z");
  assert.equal(r.added, 1);
  assert.deepEqual(memberIds(await group("d1-06")), ids("ann", "dee", "hal"));
  await M.SessionRegistration.deleteOne({ userId: U.dee._id, sessionId: "d1-06" });
  await M.CommunityGroup.updateOne({ sessionId: "d1-06" }, { $pull: { members: U.dee._id } });
  await M.SessionRegistration.create({ userId: U.dee._id, sessionId: "d1-06" });
  assert.equal((await run("2026-10-26T14:46:00Z")).due, 0);                           // the panel has ended
  assert.deepEqual(memberIds(await group("d1-06")), ids("ann", "hal"));               // ended: not added any more
  await M.SessionRegistration.deleteOne({ userId: U.dee._id, sessionId: "d1-06" });
});

/* ---------- the routes (real clock: the group's times are set around now) ---------- */

const around = async (sessionId, { startsInMin, endsInMin }) => M.CommunityGroup.updateOne({ sessionId }, {
  $set: { sessionStartsAt: new Date(Date.now() + startsInMin * 60_000), sessionEndsAt: new Date(Date.now() + endsInMin * 60_000) },
});
const register = (as, id) => ok(call("POST", `/api/social/sessions/${id}/register`, { as }));

test("routes: registering adds at once, un-registering before the start takes them out, after the start they stay", { skip }, async () => {
  await around("d1-06", { startsInMin: 20, endsInMin: 65 });
  assert.deepEqual(await register(U.cal, "d1-06"), { registered: true, count: 3 });     // Ann, Ben, Cal under this id (Hal saved it by _id)
  assert.ok(memberIds(await group("d1-06")).includes(String(U.cal._id)));
  assert.deepEqual((await register(U.cal, "d1-06")).registered, false);
  assert.ok(!memberIds(await group("d1-06")).includes(String(U.cal._id)));
  await register(U.cal, "session-d1-06");                                                 // either id works
  assert.ok(memberIds(await group("d1-06")).includes(String(U.cal._id)));
  await around("d1-06", { startsInMin: -5, endsInMin: 40 });                              // started
  await register(U.cal, "session-d1-06");                                                 // un-registers
  assert.ok(memberIds(await group("d1-06")).includes(String(U.cal._id)));                // stays
  await register(U.cal, "session-d1-06");                                                 // registered again (still in)
  await around("d1-06", { startsInMin: -60, endsInMin: -15 });                            // ended
  await register(U.dee, "d1-06");
  assert.ok(!memberIds(await group("d1-06")).includes(String(U.dee._id)));               // too late
  await register(U.dee, "d1-06");                                                         // back off
  await around("d1-06", { startsInMin: 20, endsInMin: 65 });
});

test("routes: the group exposes sessionId; members and registrants see it, others don't, moderators see all", { skip }, async () => {
  const g = await group("d1-06");
  const listed = (await ok(call("GET", "/api/community/groups", { as: U.ann }))).find((x) => x.sessionId === "d1-06");
  assert.deepEqual([listed.id, listed.name, listed.joined, listed.system, listed.ownerName, listed.status],
    [String(g._id), "Quantum in the Enterprise", true, true, "TTFC", "approved"]);
  // Hal is hidden: in the group, but nobody else counts or sees him.
  assert.equal(listed.memberCount, 2);                                                     // Ann + Cal
  const members = await ok(call("GET", `/api/community/groups/${g._id}/members`, { as: U.ann }));
  assert.deepEqual(members.map((m) => m.name).sort(), ["Ann Attendee", "Cal Late"]);
  assert.equal((await ok(call("GET", "/api/community/groups/session/d1-06", { as: U.hal }))).joined, true);
  // Dee neither saved it nor is in it: not listed, 404 by session, can't join.
  assert.equal((await ok(call("GET", "/api/community/groups", { as: U.dee }))).some((x) => x.sessionId), false);
  assert.equal((await call("GET", "/api/community/groups/session/d1-06", { as: U.dee })).status, 404);
  assert.equal((await call("POST", `/api/community/groups/${g._id}/join`, { as: U.dee })).status, 403);
  assert.equal((await call("GET", `/api/community/groups/${g._id}/messages`, { as: U.dee })).status, 403);
  // Mia moderates: every session chat is listed and readable.
  const mia = await ok(call("GET", "/api/community/groups", { as: U.mia }));
  assert.deepEqual(mia.filter((x) => x.sessionId).map((x) => x.sessionId).sort(), ["d1-06", "session-d1-12"]);
  const msgs = await ok(call("GET", `/api/community/groups/${g._id}/messages`, { as: U.mia }));
  assert.equal(msgs[0].authorName, "TTFC");
  // By session id: the fireside under its _id; nothing for the lunch.
  assert.equal((await ok(call("GET", "/api/community/groups/session/session-d1-12", { as: U.ann }))).sessionId, "session-d1-12");
  assert.equal((await call("GET", "/api/community/groups/session/d1-09", { as: U.ann })).status, 404);
  // People's own groups carry sessionId null.
  const own = await ok(call("POST", "/api/community/groups", { as: U.mia, body: { name: "Quantum founders" } }), 201);
  assert.deepEqual([own.sessionId, own.system], [null, false]);
});

test("routes: leaving is remembered (the job doesn't add them back); a registrant can join again", { skip }, async () => {
  const g = await group("d1-06");
  const left = await ok(call("POST", `/api/community/groups/${g._id}/join`, { as: U.ann }));
  assert.equal(left.joined, false);
  await run("2026-10-26T13:50:00Z");                                                       // the job tops up
  assert.ok(!memberIds(await group("d1-06")).includes(String(U.ann._id)));
  // Still listed for her (she's registered), so she can come back.
  assert.equal((await ok(call("GET", "/api/community/groups", { as: U.ann }))).find((x) => x.sessionId === "d1-06").joined, false);
  assert.equal((await ok(call("POST", `/api/community/groups/${g._id}/join`, { as: U.ann }))).joined, true);
  assert.deepEqual((await group("d1-06")).leftBy.map(String), []);
  // Messages in it push under the usual rules (the others in it, never the hidden member's).
  pushes.length = 0;
  await ok(call("POST", `/api/community/groups/${g._id}/messages`, { as: U.ann, body: { body: "See you at the front" } }), 201);
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0].to.sort(), [String(U.cal._id), String(U.hal._id)].sort());
  pushes.length = 0;
  await ok(call("POST", `/api/community/groups/${g._id}/messages`, { as: U.hal, body: { body: "Hello?" } }), 201);
  assert.equal(pushes.length, 0);                                                          // a hidden person's messages reach nobody
});

/* ---------- "Show me on the leaderboard" ---------- */

test("leaderboard switch: PATCH answers what was saved, is idempotent, refuses non-booleans", { skip }, async () => {
  for (const v of [true, true, false, false, true]) {
    const r = await ok(call("PATCH", "/api/social/points/prefs", { as: U.cal, body: { hideFromLeaderboard: v } }));
    assert.deepEqual(r, { hideFromLeaderboard: v });
    assert.equal((await M.User.findById(U.cal._id).select("hideFromLeaderboard").lean()).hideFromLeaderboard, v);
    assert.equal((await ok(call("GET", "/api/social/points/me", { as: U.cal }))).hideFromLeaderboard, v);
  }
  for (const bad of ["yes", 1, null, undefined]) {
    assert.equal((await call("PATCH", "/api/social/points/prefs", { as: U.cal, body: { hideFromLeaderboard: bad } })).status, 400);
  }
  assert.equal((await M.User.findById(U.cal._id).select("hideFromLeaderboard").lean()).hideFromLeaderboard, true);
  await ok(call("PATCH", "/api/social/points/prefs", { as: U.cal, body: { hideFromLeaderboard: false } }));
});

test("leaderboard switch: their own board follows at once, both ways, even with a stale board from another server", { skip }, async () => {
  const onBoard = async (u) => (await ok(call("GET", "/api/social/points/leaderboard?limit=50", { as: u }))).entries.some((e) => e.user.id === String(u._id));
  assert.equal(await onBoard(U.ann), true);                    // saved sessions + profile: she has points
  await ok(call("PATCH", "/api/social/points/prefs", { as: U.ann, body: { hideFromLeaderboard: true } }));
  assert.equal(await onBoard(U.ann), false);
  const me = await ok(call("GET", "/api/social/points/leaderboard", { as: U.ann }));
  assert.equal(me.me.rank, null);
  await ok(call("PATCH", "/api/social/points/prefs", { as: U.ann, body: { hideFromLeaderboard: false } }));
  assert.equal(await onBoard(U.ann), true);                    // at once, not after the board's next rebuild
  assert.ok((await ok(call("GET", "/api/social/points/leaderboard", { as: U.ann }))).me.rank >= 1);
  // Another server took her off (the database says so) while this one's cached board still has her.
  await M.User.updateOne({ _id: U.ann._id }, { $set: { hideFromLeaderboard: true } });
  assert.equal(await onBoard(U.ann), false);
  await M.User.updateOne({ _id: U.ann._id }, { $set: { hideFromLeaderboard: false } });
});
