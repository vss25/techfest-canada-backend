/* Scheduled broadcasts (Oct 27 2026) through the real console routes and the real minute job, against a real
   (throwaway) MongoDB: management only; create / edit / cancel / send now with their state rules (409 once it isn't
   scheduled) and the audit log; the list with each scheduled notification's estimate; who gets it ("app": everyone
   signed into the app who isn't suspended; "checkedIn": those with a door check-in on Day 1 or Day 2, matched by
   their pass or their email, practice scans not counted); the send (the feed post like /broadcast, the Home banner,
   the inbox rows and the pushes, Announcements off = no push); each item sent exactly once with two servers at
   once; over 2 hours late = missed; a send cut off by a restart = failed, never sent twice.
   Starts a local mongod in a temp folder on a free port and stops it after; skipped when the binary isn't there
   (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Nothing leaves the machine: Sanity
   is a stubbed fetch, pushes are watched (observePushes), no push service is configured. Fictional people,
   example.com. Scheduled times are in 2099 (always ahead of the real clock); the job is run with its own clock. */
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
let SB;   // services/scheduledBroadcasts.js
let norm;
let forgetPeople;
const M = {};
const U = {};
const pushes = [];

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-sched-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await pause(250);
  await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_sched_test`);
  ({ default: jwt } = await import("jsonwebtoken"));
  const { observePushes } = await import("../services/push.js");
  observePushes((to, note) => pushes.push({ to, note }));
  ({ normalizeTicketId: norm } = await import("../services/ticketAccess.js"));
  ({ forgetPeople } = await import("../routes/people.js"));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.Attendee = await imp("../models/Attendee.js");
  M.AppNotification = await imp("../models/AppNotification.js");
  M.CheckinMark = await imp("../models/CheckinMark.js");
  M.JobLock = await imp("../models/JobLock.js");
  M.ScheduledBroadcast = await imp("../models/ScheduledBroadcast.js");
  Object.assign(M, await import("../models/Admin.js"), await import("../models/Social.js"));
  await Promise.all([M.AppContent.init(), M.ScheduledBroadcast.init()]);
  SB = await import("../services/scheduledBroadcasts.js");
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/console", (await import("../routes/console.js")).default);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const onApp = { appOnboarded: true, lastActiveAt: new Date("2026-10-26T12:00:00Z") };
  const pass = (id) => [{ ticketId: id, type: "connect", purchaseDate: new Date("2026-10-01") }];
  const mk = (key, doc) => M.User.create(doc).then((u) => { U[key] = u; });
  await Promise.all([
    mk("mia", { name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management" }),
    mk("sam", { name: "Sam Staff", email: "sam.staff@example.com", role: "admin", staffRole: "staff", ...onApp }),
    mk("ann", { name: "Ann Arrived", email: "ann@example.com", tickets: pass("CON260000001"), ...onApp }),           // Day 1
    mk("dan", { name: "Dan Daytwo", email: "dan@example.com", tickets: pass("CON260000002"), ...onApp }),           // Day 2
    mk("cal", { name: "Cal Quiet", email: "cal@example.com", tickets: pass("CON260000003"), ...onApp, notifyPrefs: { announcements: false } }),
    mk("ola", { name: "Ola Offsite", email: "ola@example.com", tickets: pass("CON260000004"), ...onApp }),          // never came
    mk("pat", { name: "Pat Practice", email: "pat@example.com", tickets: pass("CON260000005"), ...onApp }),         // rehearsal only
    mk("eve", { name: "Eve Email", email: "eve@example.com", ...onApp }),                                            // her pass is on her email
    mk("ban", { name: "Bea Banned", email: "bea@example.com", tickets: pass("CON260000006"), ...onApp, banned: true }),
    mk("web", { name: "Wes Website", email: "wes@example.com", tickets: pass("CON260000007") }),                    // never on the app
  ]);
  await M.Attendee.create({ name: "Eve Email", email: "eve@example.com", ticketId: "CON260000010", ticketType: "connect" });
  await M.CheckinMark.insertMany([
    mark("CON260000001", "2026-10-26", "arrived"), mark("CON260000001", "2026-10-26", "lunch"),
    mark("CON260000002", "2026-10-27", "checked_in"), mark("CON260000003", "2026-10-26", "arrived"),
    mark("CON260000004", "2026-10-26", "lunch"),                       // not the door
    mark("CON260000005", "2026-10-25", "checked_in", { practice: true }),
    mark("CON260000010", "2026-10-26", "checked_in"), mark("CON260000006", "2026-10-26", "arrived"), mark("CON260000007", "2026-10-26", "arrived"),
  ]);
  forgetPeople();
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

function mark(ticketId, day, point, extra = {}) {
  return { subject: norm(ticketId), day, point, at: new Date(`${day}T13:30:00Z`), ...extra };
}
const tokenFor = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function call(method, url, { as = U.mia, body } = {}) {
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
const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await pause(20); }
  return null;
};
const quiet = { log() {}, error() {} };
const BASE = "/api/console/broadcasts/scheduled";
/** 2 PM Toronto (EDT) on a June day in 2099: always ahead of the real clock, never in the quiet hours. */
const at = (day = 15, hh = "14:00") => `2099-06-${String(day).padStart(2, "0")}T${hh}:00-04:00`;
const plus = (iso, ms) => new Date(new Date(iso).getTime() + ms);
const ITEM = { title: "Thank you for coming", body: "TTFC 2026 has ended, but keep using the app for networking. See you in 2027",
  linkUrl: "https://www.thetechfestival.com/stay-updated", feedPost: true, banner: true, notify: true, audience: "app" };
const create = (patch = {}) => ok(call("POST", BASE, { body: { ...ITEM, sendAt: at(), ...patch } }), 201);
/** One run at `now` (the minute's claim cleared first: the claim is tested on its own). */
const run = async (now, owner = "test-a", extra = {}) => {
  await M.JobLock.deleteMany({});
  return SB.runScheduledBroadcasts({ now, owner, log: quiet, ...extra });
};
const ids = (list) => list.map(String).sort();
const name = (id) => Object.keys(U).find((k) => String(U[k]._id) === String(id));
const names = (list) => list.map(name).sort();

test("management only: staff get 403 on every route", { skip }, async () => {
  const item = await create();
  for (const [m, p] of [["GET", BASE], ["POST", BASE], ["PATCH", `${BASE}/${item.id}`], ["POST", `${BASE}/${item.id}/cancel`], ["POST", `${BASE}/${item.id}/send-now`]]) {
    const r = await call(m, p, { as: U.sam, body: m === "GET" ? undefined : { ...ITEM, sendAt: at() } });
    assert.deepEqual([r.status, r.body], [403, { error: "Management only" }], `${m} ${p}`);
  }
  assert.equal((await M.ScheduledBroadcast.findById(item.id).lean()).status, "scheduled", "nothing changed");
  await ok(call("POST", `${BASE}/${item.id}/cancel`));
});

test("create: 201 with the item; checks give 400 { error, field }; nothing is sent", { skip }, async () => {
  const before = await M.AppNotification.countDocuments();
  const item = await create({ audience: "checkedIn" });
  assert.match(item.id, /^[a-f0-9]{24}$/);
  assert.deepEqual({ ...item, id: "", createdAt: "", updatedAt: "" }, {
    id: "", sendAt: "2099-06-15T18:00:00.000Z", title: ITEM.title, body: ITEM.body, linkUrl: ITEM.linkUrl, feedPost: true, banner: true, notify: true,
    audience: "checkedIn", status: "scheduled", sentAt: null, recipients: 0, postId: null, error: "", createdByName: "Mia Manager", updatedByName: "",
    createdAt: "", updatedAt: "", estimate: 4,
  });
  const doc = await M.ScheduledBroadcast.findById(item.id).lean();
  assert.equal(String(doc.createdBy), String(U.mia._id));
  assert.equal(doc.batchId, `sched:${item.id}`);
  assert.equal(await M.AppNotification.countDocuments(), before);
  assert.ok(await M.AdminAudit.exists({ action: "scheduled_broadcast_create", targetId: item.id, adminName: "Mia Manager" }));

  const bad = async (patch, field) => {
    const r = await call("POST", BASE, { body: { ...ITEM, sendAt: at(), ...patch } });
    assert.equal(r.status, 400, JSON.stringify(patch));
    assert.equal(r.body.field, field, JSON.stringify(r.body));
    assert.ok(r.body.error);
  };
  await bad({ sendAt: "2099-06-15T22:30:00-04:00" }, "sendAt");                    // quiet hours
  await bad({ sendAt: "2099-06-16T06:00:00-04:00" }, "sendAt");
  await bad({ sendAt: "2020-10-27T19:00:00-04:00" }, "sendAt");                    // past
  await bad({ sendAt: new Date(Date.now() + 30_000).toISOString() }, "sendAt");    // too soon
  await bad({ sendAt: "2099-06-15T14:00" }, "sendAt");                             // no zone
  await bad({ title: "" }, "title");
  await bad({ body: "" }, "body");
  await bad({ linkUrl: "http://www.thetechfestival.com/" }, "linkUrl");
  await bad({ feedPost: false, banner: false, notify: false }, "channels");
  await bad({ audience: "everyone" }, "audience");
  await ok(call("POST", `${BASE}/${item.id}/cancel`));
});

test("edit only while scheduled; cancel; send now refused once cancelled; every change audited", { skip }, async () => {
  const item = await create({ notify: false, title: "" });
  const edited = await ok(call("PATCH", `${BASE}/${item.id}`, { body: { body: "Please rate the TTFC app", sendAt: at(15, "15:30"), notify: true, title: "Rate the app" } }));
  assert.deepEqual([edited.body, edited.sendAt, edited.notify, edited.title, edited.updatedByName, edited.estimate],
    ["Please rate the TTFC app", "2099-06-15T19:30:00.000Z", true, "Rate the app", "Mia Manager", 7]);
  assert.equal(edited.linkUrl, ITEM.linkUrl, "what wasn't sent is kept");
  const bad = await call("PATCH", `${BASE}/${item.id}`, { body: { sendAt: at(15, "23:00") } });
  assert.deepEqual([bad.status, bad.body.field], [400, "sendAt"]);
  assert.equal((await call("PATCH", `${BASE}/64b000000000000000000001`, { body: { body: "x" } })).status, 404);
  assert.equal((await call("PATCH", `${BASE}/nope`, { body: { body: "x" } })).status, 404);

  const cancelled = await ok(call("POST", `${BASE}/${item.id}/cancel`));
  assert.deepEqual([cancelled.status, cancelled.estimate], ["cancelled", null]);
  for (const [m, p] of [["PATCH", `${BASE}/${item.id}`], ["POST", `${BASE}/${item.id}/cancel`], ["POST", `${BASE}/${item.id}/send-now`]]) {
    const r = await call(m, p, { body: { body: "Again" } });
    assert.equal(r.status, 409, `${m} ${p}`);
    assert.deepEqual([r.body.code, r.body.status], ["not_scheduled", "cancelled"]);
  }
  assert.equal((await M.ScheduledBroadcast.findById(item.id).lean()).body, "Please rate the TTFC app");
  // The job never sends a cancelled one.
  assert.equal((await run(plus(at(15, "15:30"), 60_000))).sent, 0);
  assert.equal(await M.AppNotification.countDocuments({ batchId: `sched:${item.id}` }), 0);
  const actions = (await M.AdminAudit.find({ targetId: item.id }).lean()).map((a) => a.action).sort();
  assert.deepEqual(actions, ["scheduled_broadcast_cancel", "scheduled_broadcast_create", "scheduled_broadcast_edit"]);
});

test("who gets it: app = everyone signed in and not suspended; checkedIn = those with a door check-in on Day 1 or 2", { skip }, async () => {
  assert.deepEqual(names(await SB.audienceIds("app")), ["ann", "cal", "dan", "eve", "ola", "pat", "sam"]);
  // Ann (arrived Day 1), Dan (Day 2), Cal (Day 1), Eve (her pass, on her email, checked in). Not Ola (only lunch), Pat
  // (a rehearsal scan), Bea (suspended) or Wes (never on the app).
  assert.deepEqual(names(await SB.audienceIds("checkedIn")), ["ann", "cal", "dan", "eve"]);
  assert.deepEqual(await SB.estimates(["app", "checkedIn", "app"]), { app: 7, checkedIn: 4 });
});

test("the send: the feed post like /broadcast, the Home banner, inbox rows and pushes to the audience, once", { skip }, async () => {
  pushes.length = 0;
  const item = await create({ audience: "checkedIn", sendAt: at(16, "19:00") });
  const sendAt = new Date("2099-06-16T23:00:00Z");
  // Not due yet: nothing.
  assert.deepEqual(await run(plus(sendAt, -60_000)), { claimed: true, sent: 0, failed: 0, missed: 0, stuck: 0 });
  const out = await run(plus(sendAt, 30_000));
  assert.deepEqual(out, { claimed: true, sent: 1, failed: 0, missed: 0, stuck: 0 });
  const doc = await M.ScheduledBroadcast.findById(item.id).lean();
  assert.deepEqual([doc.status, doc.recipients, doc.error, +doc.sentAt], ["sent", 4, "", +plus(sendAt, 30_000)]);
  // The post: exactly like /broadcast, with the link.
  const post = await M.SocialPost.findById(doc.postId).lean();
  assert.deepEqual(
    [post.authorName, post.authorTitle, post.authorOrg, post.kind, post.status, post.body, post.linkUrl, String(post.authorId)],
    ["The Tech Festival Canada", "Organizers", "AtlasLink Markets", "announcement", "approved", ITEM.body, ITEM.linkUrl, String(U.mia._id)],
  );
  // The banner.
  const banner = await M.AppContent.findOne({ key: "home.announcement" }).lean();
  assert.deepEqual([banner.value, banner.updatedBy], [ITEM.body.slice(0, 280), "Mia Manager"]);
  // The inbox: one row each for the people who checked in.
  const rows = await M.AppNotification.find({ batchId: `sched:${item.id}` }).lean();
  assert.deepEqual(names(rows.map((r) => r.userId)), ["ann", "cal", "dan", "eve"]);
  for (const r of rows) {
    assert.deepEqual([r.title, r.body, r.link, r.kind, r.sentByName, String(r.sentBy), r.readAt],
      [ITEM.title, ITEM.body, ITEM.linkUrl, "personal", "The Tech Festival Canada", String(U.mia._id), null]);
  }
  // Pushes: not to Cal (Announcements off).
  await waitFor(() => pushes.length);
  await pause(50);
  assert.equal(pushes.length, 1);
  assert.deepEqual(names(pushes[0].to), ["ann", "dan", "eve"]);
  assert.deepEqual([pushes[0].note.title, pushes[0].note.body, pushes[0].note.link, pushes[0].note.kind, pushes[0].note.id],
    [ITEM.title, ITEM.body, ITEM.linkUrl, "personal", `sched:${item.id}`]);
  // The list: sent, with its numbers; no estimate.
  const list = await ok(call("GET", BASE));
  const row = list.items.find((i) => i.id === item.id);
  assert.deepEqual([row.status, row.recipients, row.postId, row.estimate, row.sentAt], ["sent", 4, String(doc.postId), null, plus(sendAt, 30_000).toISOString()]);
  assert.ok(await M.AdminAudit.exists({ action: "scheduled_broadcast_sent", targetId: item.id }));
  // Never again: a later run, an edit, a cancel.
  assert.equal((await run(plus(sendAt, 120_000))).sent, 0);
  assert.equal((await call("PATCH", `${BASE}/${item.id}`, { body: { body: "x" } })).status, 409);
  assert.equal((await call("POST", `${BASE}/${item.id}/cancel`)).status, 409);
  assert.equal(await M.AppNotification.countDocuments({ batchId: `sched:${item.id}` }), 4);
  assert.equal(await M.SocialPost.countDocuments({ body: ITEM.body }), 1);
});

test("only the channels that are on: a notification alone writes no post and leaves the banner", { skip }, async () => {
  await M.AppContent.updateOne({ key: "home.announcement" }, { $set: { value: "Doors open at 8" } }, { upsert: true });
  const posts = await M.SocialPost.countDocuments();
  const item = await create({ feedPost: false, banner: false, linkUrl: "ttfc://tab/home", body: "Enjoying TTFC? Rate the app.", sendAt: at(17) });
  await run(plus(at(17), 1000));
  const doc = await M.ScheduledBroadcast.findById(item.id).lean();
  assert.deepEqual([doc.status, doc.recipients, doc.postId], ["sent", 7, null]);
  assert.equal(await M.SocialPost.countDocuments(), posts);
  assert.equal((await M.AppContent.findOne({ key: "home.announcement" }).lean()).value, "Doors open at 8");
  assert.equal((await M.AppNotification.findOne({ batchId: `sched:${item.id}` }).lean()).link, "ttfc://tab/home");
  // A banner alone: no inbox rows, recipients 0.
  const b = await create({ feedPost: false, notify: false, title: "", body: "See you in 2027", sendAt: at(18) });
  await run(plus(at(18), 1000));
  const bdoc = await M.ScheduledBroadcast.findById(b.id).lean();
  assert.deepEqual([bdoc.status, bdoc.recipients], ["sent", 0]);
  assert.equal(await M.AppNotification.countDocuments({ batchId: `sched:${b.id}` }), 0);
  assert.equal((await M.AppContent.findOne({ key: "home.announcement" }).lean()).value, "See you in 2027");
});

test("exactly once: two servers running at the same moment send each item once; the minute's lock is one server's", { skip }, async () => {
  const a = await create({ sendAt: at(19), feedPost: true, banner: false, body: "Two servers, one message A" });
  const b = await create({ sendAt: at(19, "14:01"), feedPost: true, banner: false, body: "Two servers, one message B" });
  const now = plus(at(19, "14:01"), 1000);
  await M.JobLock.deleteMany({});
  const [x, y, z] = await Promise.all([
    SB.runScheduledBroadcasts({ now, owner: "server-x", log: quiet, held: true }),
    SB.runScheduledBroadcasts({ now, owner: "server-y", log: quiet, held: true }),
    SB.runScheduledBroadcasts({ now, owner: "server-z", log: quiet, held: true }),
  ]);
  assert.equal(x.sent + y.sent + z.sent, 2);
  for (const item of [a, b]) {
    assert.equal(await M.AppNotification.countDocuments({ batchId: `sched:${item.id}` }), 7, "everyone once");
    assert.equal(await M.SocialPost.countDocuments({ body: item.body }), 1);
    assert.equal((await M.ScheduledBroadcast.findById(item.id).lean()).status, "sent");
  }
  // The minute's lock: of two servers starting the same minute, one runs.
  await M.JobLock.deleteMany({});
  const runs = await Promise.all([SB.claimRun({ owner: "server-x", now }), SB.claimRun({ owner: "server-y", now })]);
  assert.deepEqual(runs.filter(Boolean).length, 1);
  for (const owner of ["server-x", "server-y"]) assert.equal(await SB.claimRun({ owner, now: plus(now, 10_000) }), false, `${owner}: held this minute`);
  assert.equal(await SB.claimRun({ owner: "server-y", now: plus(now, 61_000) }), true, "the next minute");
});

test("send now: at once, whatever the time; while the job can't send it again", { skip }, async () => {
  const item = await create({ sendAt: at(20), audience: "app", banner: false, body: "Sent by hand" });
  const done = await ok(call("POST", `${BASE}/${item.id}/send-now`));
  assert.deepEqual([done.status, done.recipients, done.estimate, done.error], ["sent", 7, null, ""]);
  assert.ok(done.postId);
  assert.ok(Math.abs(new Date(done.sentAt).getTime() - Date.now()) < 60_000, "sent now, not at sendAt");
  assert.equal((await run(plus(at(20), 1000))).sent, 0, "the job finds nothing at its time");
  assert.equal(await M.AppNotification.countDocuments({ batchId: `sched:${item.id}` }), 7);
  assert.equal((await call("POST", `${BASE}/${item.id}/send-now`)).status, 409);
  assert.equal((await call("POST", `${BASE}/64b000000000000000000001/send-now`)).status, 404);
  const audit = await M.AdminAudit.find({ targetId: item.id }).lean();
  assert.deepEqual(audit.map((a) => a.action).sort(), ["scheduled_broadcast_create", "scheduled_broadcast_send_now", "scheduled_broadcast_sent"]);
  assert.equal(audit.find((a) => a.action === "scheduled_broadcast_sent").adminName, "Mia Manager");
});

test("the server was down: over 2 hours late = missed, never sent; up to 2 hours late is still sent", { skip }, async () => {
  const late = await create({ sendAt: at(21), body: "Two hours late" });
  const later = await create({ sendAt: at(21, "14:30"), body: "Too late" });
  const now = plus(at(21, "14:30"), 2 * 3600e3 - 60_000);   // 1:59 after `later`, 2:29 after `late`
  const out = await run(now);
  assert.deepEqual([out.sent, out.missed], [1, 1]);
  const [l, m] = await Promise.all([M.ScheduledBroadcast.findById(later.id).lean(), M.ScheduledBroadcast.findById(late.id).lean()]);
  assert.deepEqual([l.status, m.status], ["sent", "missed"]);
  assert.equal(m.error, SB.MISSED_ERROR);
  assert.equal(await M.AppNotification.countDocuments({ batchId: `sched:${late.id}` }), 0);
  assert.equal(await M.SocialPost.countDocuments({ body: "Two hours late" }), 0);
  assert.ok(await M.AdminAudit.exists({ action: "scheduled_broadcast_missed", targetId: late.id }));
  assert.equal((await call("PATCH", `${BASE}/${late.id}`, { body: { body: "x" } })).body.status, "missed");
});

test("a send cut off by a restart: failed after 15 minutes, never sent again; an error during the send: failed with it", { skip }, async () => {
  const item = await create({ sendAt: at(22), body: "Cut off" });
  await M.ScheduledBroadcast.updateOne({ _id: item.id }, { $set: { status: "sending", claimedAt: plus(at(22), 0), claimedBy: "gone" } });
  assert.equal((await run(plus(at(22), 10 * 60_000))).stuck, 0, "10 minutes: maybe still sending");
  assert.equal((await run(plus(at(22), 16 * 60_000))).stuck, 1);
  const doc = await M.ScheduledBroadcast.findById(item.id).lean();
  assert.deepEqual([doc.status, doc.error], ["failed", SB.STUCK_ERROR]);
  assert.equal(await M.AppNotification.countDocuments({ batchId: `sched:${item.id}` }), 0);

  // The checked-in audience needs the People directory: when it can't be read, the item fails with the error and the
  // post already made is recorded.
  const broken = await create({ sendAt: at(23), audience: "checkedIn", body: "Directory down" });
  const out = await SB.runScheduledBroadcasts({ now: plus(at(23), 1000), owner: "t", log: quiet, held: true, directory: async () => { throw new Error("directory down (test)"); } });
  assert.deepEqual([out.sent, out.failed], [0, 1]);
  const bdoc = await M.ScheduledBroadcast.findById(broken.id).lean();
  assert.deepEqual([bdoc.status, bdoc.error, bdoc.recipients], ["failed", "directory down (test)", 0]);
  assert.ok(bdoc.postId, "the post was made before the failure");
  assert.ok(await M.AdminAudit.exists({ action: "scheduled_broadcast_failed", targetId: broken.id }));
});

test("the list: newest sendAt first, every status, estimates for scheduled notifications, the quiet hours", { skip }, async () => {
  const s1 = await create({ sendAt: at(28), audience: "app" });
  const s2 = await create({ sendAt: at(29), audience: "checkedIn" });
  const s3 = await create({ sendAt: at(30), notify: false, title: "" });
  const list = await ok(call("GET", BASE));
  assert.deepEqual(list.quietHours, { from: "22:00", to: "08:00", tz: "America/Toronto" });
  const sendAts = list.items.map((i) => i.sendAt);
  assert.deepEqual(sendAts, [...sendAts].sort().reverse(), "newest sendAt first");
  assert.deepEqual(list.items.slice(0, 3).map((i) => [i.id, i.estimate]), [[s3.id, null], [s2.id, 4], [s1.id, 7]]);
  for (const st of ["sent", "cancelled", "missed", "failed"]) assert.ok(list.items.some((i) => i.status === st), st);
  for (const i of list.items) {
    assert.deepEqual(Object.keys(i), ["id", "sendAt", "title", "body", "linkUrl", "feedPost", "banner", "notify", "audience", "status", "sentAt",
      "recipients", "postId", "error", "createdByName", "updatedByName", "createdAt", "updatedAt", "estimate"]);
  }
  for (const s of [s1, s2, s3]) await ok(call("POST", `${BASE}/${s.id}/cancel`));
  assert.equal(await M.ScheduledBroadcast.countDocuments({ status: "scheduled" }), 0);
});
