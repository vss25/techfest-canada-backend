/* "Win the TTFC swag kit": the cutoff moved after the leaderboard was kept (Oct 26 2026), through the real routes
   against a real (throwaway) MongoDB. Production kept the leaderboard at the old cutoff (Day 1, 4 PM; takenAt
   2026-10-26T20:00:48Z), then the organiser moved swag.cutoff and swag.announce to Day 2, 5 PM. That kept leaderboard
   is stale: the winners are live until the new cutoff; at the new cutoff one fresh one is kept in its place (two
   servers, or the job and an "Announce" click, racing each other replace it once), and the stale one is kept under
   swag.snapshot.previous, never deleted. Once announced, the public GET /api/app/swag carries the winners for the
   apps' podium (place, name, organisation, photo, points, user id; never an email), cached 60 s.
   Starts a local mongod in a temp folder on a free port and stops it after; skipped when the binary isn't there
   (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Nothing leaves the machine: Sanity is
   a stubbed fetch, pushes are watched (observePushes). Fictional people, example.com. */
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
let S;   // services/swag.js
const M = {};
const U = {};
const pushes = [];
const STALE_AT = new Date("2026-10-26T20:00:48Z");

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-swag-recut-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await pause(250);
  await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_swag_recut_test`);
  ({ default: jwt } = await import("jsonwebtoken"));
  const { observePushes } = await import("../services/push.js");
  observePushes((to, note) => pushes.push({ to, note }));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.AppNotification = await imp("../models/AppNotification.js");
  Object.assign(M, await import("../models/Admin.js"), await import("../models/Social.js"));
  await M.AppContent.init();
  S = await import("../services/swag.js");
  const swag = await import("../routes/swag.js");
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/app/swag", swag.publicRouter);
  app.use("/api/console/swag", swag.adminRouter);
  app.use("/api/console", await imp("../routes/console.js"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const onApp = { appOnboarded: true, lastActiveAt: new Date("2026-10-26T12:00:00Z") };
  const pass = (id) => [{ ticketId: id, type: "connect", purchaseDate: new Date("2026-10-01") }];
  const mk = (key, doc) => M.User.create(doc).then((u) => { U[key] = u; });
  await Promise.all([
    mk("mia", { name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management", ...onApp }),
    mk("ann", { name: "Ann Attendee", email: "ann@example.com", organization: "Acme", avatarVersion: 3, tickets: pass("con130000001"), ...onApp }),
    mk("ben", { name: "Ben Attendee", email: "ben@example.com", organization: "Beta", tickets: pass("con130000002"), ...onApp }),
    mk("cal", { name: "Cal Attendee", email: "cal@example.com", tickets: pass("con130000003"), ...onApp }),
    mk("dee", { name: "Dee Early", email: "dee@example.com", tickets: pass("con130000004"), ...onApp }),
  ]);
  // Points now: 10 a post (one a day here). Ann 30, Ben 20, Cal 10; Dee nothing.
  const posts = async (u, n) => {
    for (let i = 0; i < n; i++) {
      const p = await M.SocialPost.create({ authorId: u._id, authorName: u.name, body: `Post ${i}`, status: "approved" });
      await M.SocialPost.collection.updateOne({ _id: p._id }, { $set: { createdAt: new Date(Date.UTC(2026, 9, 10 + i)) } });
    }
  };
  await posts(U.ann, 3);
  await posts(U.ben, 2);
  await posts(U.cal, 1);
  // What production kept at the old cutoff: Dee alone, on top.
  await M.AppContent.create({ key: "swag.snapshot", updatedBy: "swag job", value: {
    takenAt: STALE_AT, rows: [{ userId: String(U.dee._id), name: "Dee Early", organization: "", points: 99, rank: 1 }],
  } });
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
    method, headers: { "content-type": "application/json", ...(as ? { authorization: `Bearer ${tokenFor(as)}` } : {}) },
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
const setting = (key, value) => ok(call("PUT", `/api/console/app-content/${key}`, { as: U.mia, body: { value } }));
const names = (list) => list.map((w) => w.name);

test("a leaderboard kept at the old cutoff is ignored: winners are live until the new cutoff", { skip }, async () => {
  await setting("swag.enabled", true);
  await setting("swag.cutoff", "2099-10-27T17:00:00-04:00");
  await setting("swag.announce", "2099-10-27T17:00:00-04:00");
  const w = await ok(call("GET", "/api/console/swag", { as: U.mia }));
  assert.deepEqual([w.live, w.takenAt, w.staleTakenAt, w.cutoffPassed, w.canAnnounce], [true, null, STALE_AT.toISOString(), false, false]);
  assert.deepEqual(names(w.winners), ["Ann Attendee", "Ben Attendee", "Cal Attendee"]);   // not Dee, from the stale one
  // Before the new cutoff the job keeps nothing, and the stale row is untouched.
  assert.equal(await S.runSwagSnapshot({ held: true }), null);
  assert.equal((await S.loadSnapshot()).takenAt.toISOString(), STALE_AT.toISOString());
  assert.equal(await S.validSnapshot(), null);
});

test("at the new cutoff one fresh leaderboard replaces it (racing servers replace it once); the stale one is kept", { skip }, async () => {
  const cutoff = new Date(Date.now() - 30_000);
  await setting("swag.cutoff", cutoff.toISOString());
  // The minute job on two servers and an "Announce" click, all at once.
  const [a, b, c] = await Promise.all([S.runSwagSnapshot({ held: true }), S.runSwagSnapshot({ held: true }), S.takeSnapshot()]);
  const kept = await S.loadSnapshot();
  assert.ok(kept.takenAt >= cutoff);
  for (const r of [a, b, c].filter(Boolean)) assert.equal(new Date(r.takenAt).toISOString(), kept.takenAt.toISOString());
  assert.deepEqual(kept.rows.slice(0, 3).map((r) => [r.name, r.points]), [["Ann Attendee", 30], ["Ben Attendee", 20], ["Cal Attendee", 10]]);
  const prev = await M.AppContent.findOne({ key: "swag.snapshot.previous" }).lean();
  assert.equal(prev.value.snapshots.length, 1);
  assert.equal(new Date(prev.value.snapshots[0].takenAt).toISOString(), STALE_AT.toISOString());
  assert.deepEqual(prev.value.snapshots[0].rows.map((r) => r.name), ["Dee Early"]);
  // It counts now: later runs do nothing, later points don't change who won.
  assert.equal(await S.runSwagSnapshot({ held: true }), null);
  for (let i = 0; i < 5; i++) {
    const p = await M.SocialPost.create({ authorId: U.dee._id, authorName: "Dee", body: `Late ${i}`, status: "approved" });
    await M.SocialPost.collection.updateOne({ _id: p._id }, { $set: { createdAt: new Date(Date.UTC(2026, 9, 1 + i)) } });
  }
  const w = await ok(call("GET", "/api/console/swag", { as: U.mia }));
  assert.deepEqual([w.live, w.staleTakenAt, w.canAnnounce, new Date(w.takenAt).toISOString()], [false, null, true, kept.takenAt.toISOString()]);
  assert.deepEqual(names(w.winners), ["Ann Attendee", "Ben Attendee", "Cal Attendee"]);
});

test("announced: GET /api/app/swag carries the winners for the podium (photo, no email), cached 60 s", { skip }, async () => {
  const before = await call("GET", "/api/app/swag");
  assert.equal("winners" in before.body, false);
  const w = await ok(call("GET", "/api/console/swag", { as: U.mia }));
  await ok(call("POST", "/api/console/swag/announce", { as: U.mia, body: { confirm: "ANNOUNCE", userIds: w.winners.map((x) => x.userId) } }));
  const r = await call("GET", "/api/app/swag");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "public, max-age=60");
  assert.deepEqual([r.body.phase, r.body.announced], ["announced", true]);
  assert.deepEqual(r.body.winners, [
    { rank: 1, boardRank: 1, name: "Ann Attendee", organization: "Acme", avatarUrl: `/api/files/avatar/${U.ann._id}?v=3`, points: 30, userId: String(U.ann._id) },
    { rank: 2, boardRank: 2, name: "Ben Attendee", organization: "Beta", avatarUrl: "", points: 20, userId: String(U.ben._id) },
    { rank: 3, boardRank: 3, name: "Cal Attendee", organization: "", avatarUrl: "", points: 10, userId: String(U.cal._id) },
  ]);
  assert.equal(JSON.stringify(r.body).includes("@example.com"), false);
  // A new photo shows on the podium (the photo is read now, the rest is the announced record).
  await M.User.updateOne({ _id: U.ben._id }, { $set: { avatarVersion: 7 } });
  assert.equal((await ok(call("GET", "/api/app/swag"))).winners[1].avatarUrl, `/api/files/avatar/${U.ben._id}?v=7`);
  await pause(50);
  assert.equal(pushes.length, 1);   // the announcement's push, once
});
