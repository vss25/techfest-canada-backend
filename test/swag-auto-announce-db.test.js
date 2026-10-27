/* "Win the TTFC swag kit": the announcement at swag.announce is automatic (Oct 26 2026, the organiser: "Keep the 5 PM
   announcement automatic within the app."), against a real (throwaway) MongoDB. Not before the time, not while
   swag.autoAnnounce is off; at or after it, once, on one server (three job runs at once → one announcement, one
   notification and push per winner); when the cutoff is the announce time it keeps the leaderboard first (replacing one
   kept at an earlier cutoff); fewer eligible people than kits → whoever is eligible; nobody → not announced; after
   management's click, nothing more. Starts a local mongod in a temp folder on a free port and stops it after; skipped
   when the binary isn't there (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Nothing
   leaves the machine: Sanity is a stubbed fetch, pushes are watched (observePushes). Fictional people, example.com. */
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
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-swag-auto-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await pause(250);
  await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_swag_auto_test`);
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
    mk("sam", { name: "Sam Staff", email: "sam.staff@example.com", role: "admin", staffRole: "staff" }),
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
const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
const announced = () => M.AppContent.findOne({ key: "swag.announced" }).lean();
const notes = () => M.AppNotification.find({ batchId: "swag-winners-2026" }).lean();

test("not before the announce time, and not while it's switched off; the admin page says when", { skip }, async () => {
  await setting("swag.enabled", true);
  await setting("swag.kits", "5");   // more kits than people who can win
  await setting("swag.cutoff", "2099-10-27T17:00:00-04:00");
  await setting("swag.announce", "2099-10-27T17:00:00-04:00");
  const w = await ok(call("GET", "/api/console/swag", { as: U.mia }));
  assert.deepEqual([w.autoAnnounce, w.autoAnnounceAt, w.autoAnnounceLabel], [true, "2099-10-27T21:00:00.000Z", "5:00 PM on Tuesday, October 27"]);
  assert.equal(await S.runSwagAutoAnnounce(), null);
  // Past it, but switched off (management only).
  await setting("swag.cutoff", ago(30));
  await setting("swag.announce", ago(30));
  assert.equal((await call("PUT", "/api/console/app-content/swag.autoAnnounce", { as: U.sam, body: { value: false } })).status, 403);
  await setting("swag.autoAnnounce", false);
  assert.equal((await ok(call("GET", "/api/console/swag", { as: U.mia }))).autoAnnounce, false);
  assert.equal(await S.runSwagAutoAnnounce(), null);
  assert.deepEqual([await announced(), (await notes()).length, pushes.length], [null, 0, 0]);
  // The stale leaderboard is still the one from the old cutoff: nothing kept by these runs.
  assert.equal((await S.loadSnapshot()).takenAt.toISOString(), STALE_AT.toISOString());
});

test("at the announce time: once across three job runs at once; the leaderboard kept first (cutoff = announce); whoever is eligible", { skip }, async () => {
  await setting("swag.autoAnnounce", true);
  const cutoff = new Date(Date.parse((await ok(call("GET", "/api/console/swag", { as: U.mia }))).settings.cutoff));
  const runs = await Promise.all([S.runSwagAutoAnnounce(), S.runSwagAutoAnnounce(), S.runSwagAutoAnnounce()]);
  assert.equal(runs.filter(Boolean).length, 1);
  const rec = await announced();
  assert.match(rec.value.by, /^Automatic \(\d{1,2}(:\d\d)? (AM|PM)\)$/);
  // Kept for the current cutoff first (replacing the one from the old cutoff, kept under previous): not Dee.
  const kept = await S.loadSnapshot();
  assert.ok(kept.takenAt >= cutoff);
  assert.equal((await M.AppContent.findOne({ key: "swag.snapshot.previous" }).lean()).value.snapshots.length, 1);
  // 5 kits, 3 people who can win: those 3.
  assert.deepEqual(names(rec.value.winners), ["Ann Attendee", "Ben Attendee", "Cal Attendee"]);
  const n = await notes();
  assert.deepEqual(n.map((x) => String(x.userId)).sort(), [U.ann, U.ben, U.cal].map((u) => String(u._id)).sort());
  assert.deepEqual([n[0].title, n[0].body], ["You won a TTFC swag kit!", "Collect it at the registration desk."]);
  await pause(50);
  assert.deepEqual(pushes.map((p) => [p.to.length, p.note.title]), [[3, "You won a TTFC swag kit!"]]);
  assert.deepEqual((await M.AdminAudit.find({ action: "swag_announce" }).lean()).map((a) => [a.adminName, /automatic/.test(a.detail)]), [[rec.value.by, true]]);
  // Later runs do nothing; the button says so; the apps have the podium.
  assert.equal(await S.runSwagAutoAnnounce(), null);
  assert.equal((await notes()).length, 3);
  const again = await call("POST", "/api/console/swag/announce", { as: U.mia, body: { confirm: "ANNOUNCE", userIds: rec.value.winners.map((x) => x.userId) } });
  assert.deepEqual([again.status, again.body.code], [409, "already_announced"]);
  const pub = await ok(call("GET", "/api/app/swag"));
  assert.deepEqual([pub.phase, pub.winners.map((x) => x.rank)], ["announced", [1, 2, 3]]);
});

test("management's click before the automatic time wins; the job then does nothing", { skip }, async () => {
  await M.AppContent.deleteOne({ key: "swag.announced" });
  await M.AppNotification.deleteMany({});
  pushes.length = 0;
  await setting("swag.announce", "2099-10-27T17:00:00-04:00");   // the cutoff has passed, the automatic time hasn't
  const w = await ok(call("GET", "/api/console/swag", { as: U.mia }));
  assert.equal(w.canAnnounce, true);
  await ok(call("POST", "/api/console/swag/announce", { as: U.mia, body: { confirm: "ANNOUNCE", userIds: w.winners.map((x) => x.userId) } }));
  await setting("swag.announce", ago(10));
  assert.equal(await S.runSwagAutoAnnounce(), null);
  assert.equal((await announced()).value.by, "Mia Manager");
  assert.equal((await notes()).length, 3);
});

test("nobody who can win: logged, not announced", { skip }, async () => {
  await M.AppContent.deleteOne({ key: "swag.announced" });
  await M.AppNotification.deleteMany({});
  await M.User.updateMany({ _id: { $in: [U.ann._id, U.ben._id, U.cal._id] } }, { $set: { banned: true } });
  assert.equal(await S.runSwagAutoAnnounce(), null);
  assert.deepEqual([await announced(), (await notes()).length], [null, 0]);
  await M.User.updateMany({ _id: { $in: [U.ann._id, U.ben._id, U.cal._id] } }, { $set: { banned: false } });
});

test("even without the job lock (three servers past it at once), the once-only record lets one announce", { skip }, async () => {
  const runs = await Promise.all([1, 2, 3].map(() => S.runSwagAutoAnnounce({ held: true })));
  assert.equal(runs.filter(Boolean).length, 1);
  assert.equal((await notes()).length, 3);
});
