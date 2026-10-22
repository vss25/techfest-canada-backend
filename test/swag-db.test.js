/* "Win the TTFC swag kit" (Oct 22 2026) through the real routes, against a real (throwaway) MongoDB: the public
   settings; management-only switches; the winners from the leaderboard kept at the cutoff (staff, volunteers,
   moderators, people without a pass and anyone suspended since are passed over); "Announce winners" only on
   management's confirmed click (in-app notification + push, once); and the offer inside the app invite email while the
   contest is on (its subject, the photo inline as CID swag-kit, its own send key so people who got the earlier invite
   and still aren't on the app get this version once, re-checked per person before it goes; the plain invite while it's
   off). Resend is a stubbed fetch, pushes are watched: nothing leaves the machine. Starts a
   local mongod in a temp folder on a free port and stops it after; skipped when the binary isn't there
   (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Fictional people, example.com. */
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

const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.startsWith("https://api.resend.com/")) {
    sent.push(JSON.parse(opts?.body || "{}"));
    return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200, headers: { "content-type": "application/json" } });
  }
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
let SEND;   // services/appInviteSend.js
const M = {};
const U = {};
const pushes = [];

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-swag-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await pause(250);
  await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_swag_test`);
  ({ default: jwt } = await import("jsonwebtoken"));
  const { observePushes } = await import("../services/push.js");
  observePushes((to, note) => pushes.push({ to, note }));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.Attendee = await imp("../models/Attendee.js");
  M.CampaignSend = await imp("../models/CampaignSend.js");
  M.AppNotification = await imp("../models/AppNotification.js");
  Object.assign(M, await import("../models/Admin.js"), await import("../models/Social.js"));
  await Promise.all([M.CampaignSend.init(), M.AppContent.init()]);
  S = await import("../services/swag.js");
  SEND = await import("../services/appInviteSend.js");
  const swag = await import("../routes/swag.js");
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/app/swag", swag.publicRouter);
  app.use("/api/console/swag", swag.adminRouter);
  app.use("/api/console/app-invite", (await import("../routes/appInvite.js")).default);
  app.use("/api/console", await imp("../routes/console.js"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const onApp = { appOnboarded: true, lastActiveAt: new Date("2026-10-21T12:00:00Z") };
  const pass = (id, type = "connect") => [{ ticketId: id, type, purchaseDate: new Date("2026-10-01") }];
  const L = { linkedinUrl: "https://www.linkedin.com/in/example" };
  const T3 = { topics: ["AI", "Quantum", "Robotics"] };
  const mk = (key, doc) => M.User.create(doc).then((u) => { U[key] = u; });
  await Promise.all([
    mk("mia", { name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management", ...onApp }),
    mk("sam", { name: "Sam Staff", email: "sam.staff@example.com", role: "admin", staffRole: "staff", ...onApp }),
    mk("vic", { name: "Vic Volunteer", email: "vic@example.com", role: "volunteer", tickets: pass("con120000001"), ...L, ...T3, ...onApp }),
    mk("max", { name: "Max Moderator", email: "max@example.com", types: ["staff"], tickets: pass("con120000002"), ...L, ...onApp }),
    mk("dee", { name: "Dee No-Pass", email: "dee@example.com", ...L, ...T3, ...onApp }),
    mk("ann", { name: "Ann Attendee", email: "ann@example.com", tickets: pass("con120000003"), ...L, ...onApp }),
    mk("ben", { name: "Ben Attendee", email: "ben@example.com", tickets: pass("pow120000001", "power"), ...T3, ...onApp }),
    mk("cal", { name: "Cal Attendee", email: "cal@example.com", tickets: pass("con120000004"), ...onApp }),
    mk("eve", { name: "Eve Attendee", email: "eve@example.com", tickets: pass("con120000005"), ...onApp }),
    // Not on the app yet: an account that never signed in, and a pass with no account.
    mk("gus", { name: "Gus Newcomer", email: "gus@example.com", tickets: pass("con120000006") }),
  ]);
  await M.Attendee.create({ name: "Zoe Passonly", email: "zoe@example.com", ticketId: "con120000007", ticketType: "connect", purchaseDate: new Date("2026-10-02") });
  // Gus got the earlier app invite (still not on the app); Zoe never got one.
  await M.CampaignSend.create({ campaign: "app-invite-2026", email: "gus@example.com", status: "sent", sentAt: new Date(Date.now() - 2 * 3_600_000), sends: 1 });
  // Points: 10 a post (3 a day), +20 LinkedIn, +10 three topics, 3 a comment.
  const posts = async (u, n) => {
    for (let i = 0; i < n; i++) {
      const p = await M.SocialPost.create({ authorId: u._id, authorName: u.name, body: `Post ${i}`, status: "approved" });
      await M.SocialPost.collection.updateOne({ _id: p._id }, { $set: { createdAt: new Date(Date.UTC(2026, 9, 10 + i)) } });
    }
  };
  await posts(U.vic, 3);   // 60, a volunteer
  await posts(U.max, 3);   // 50 + 3, a moderator
  await M.SocialComment.create({ postId: (await M.SocialPost.findOne({ authorId: U.vic._id }))._id, authorId: U.max._id, authorName: "Max", body: "Nice", status: "approved" });
  await posts(U.dee, 2);   // 50, no pass
  await posts(U.ann, 2);   // 40
  await posts(U.ben, 2);   // 30
  await posts(U.cal, 2);   // 20
  await posts(U.eve, 1);   // 10
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
  return { status: r.status, body: json };
}
const ok = async (p, want = 200) => {
  const r = await p;
  assert.equal(r.status, want, JSON.stringify(r.body));
  return r.body;
};
const idOf = (u) => String(u._id);
const setting = (as, key, value) => call("PUT", `/api/console/app-content/${key}`, { as, body: { value } });
async function waitJob() {
  for (let i = 0; i < 60; i++) {
    const job = (await ok(call("GET", "/api/console/app-invite/recipients", { as: U.mia }))).job;
    if (!job.running) return job;
    await pause(250);
  }
  throw new Error("the send didn't finish");
}

test("public settings: off by default, the rules filled in, the pitch; the app invite is the plain one while it's off", { skip }, async () => {
  const p = await ok(call("GET", "/api/app/swag"));
  assert.deepEqual([p.enabled, p.kits, p.title, p.phase, p.announced, p.appOnly, p.pitch], [false, 3, "Win the TTFC swag kit", "open", false, true, "Only people using the TTFC app can win"]);
  assert.match(p.rules, /^Only people using the TTFC app can win\./);
  assert.match(p.rules, /The top 3 people on the leaderboard at 4:00 PM on Monday, October 26 each win a TTFC swag kit\./);
  const t = await ok(call("GET", "/api/console/app-invite/template", { as: U.sam }));
  assert.deepEqual([t.swagOn, t.version, t.swag.pitch], [false, "standard", "Only people using the TTFC app can win"]);
  const pv = await ok(call("POST", "/api/console/app-invite/preview", { as: U.sam, body: {} }));
  assert.deepEqual([pv.subject, pv.html.includes("swag")], ["Your TTFC 2026 app is ready", false]);
  const list = await ok(call("GET", "/api/console/app-invite/recipients?refresh=1", { as: U.sam }));
  assert.deepEqual([list.version, list.sendKey], ["standard", "app-invite-2026"]);
  assert.deepEqual([list.rows.find((r) => r.name.startsWith("Gus")).reason, list.rows.find((r) => r.name.startsWith("Gus")).label], ["alreadySent", "Already sent"]);
  const ann = await call("POST", "/api/console/swag/announce", { as: U.mia, body: { confirm: "ANNOUNCE", userIds: [] } });
  assert.deepEqual([ann.status, ann.body.code], [409, "swag_off"]);
});

test("settings are management only and checked; the contest goes on", { skip }, async () => {
  assert.deepEqual([(await setting(U.sam, "swag.enabled", true)).status, (await setting(U.sam, "swag.enabled", true)).body.code], [403, "management_only"]);
  assert.equal((await setting(U.mia, "swag.kits", "lots")).status, 400);
  assert.equal((await setting(U.mia, "swag.cutoff", "2026-10-27 15:00")).status, 400);
  await ok(setting(U.mia, "swag.enabled", true));
  const p = await ok(call("GET", "/api/app/swag"));
  assert.equal(p.enabled, true);
  // Not past the cutoff yet: no announcing.
  const early = await call("POST", "/api/console/swag/announce", { as: U.mia, body: { confirm: "ANNOUNCE", userIds: [] } });
  assert.deepEqual([early.status, early.body.code], [409, "not_yet"]);
});

test("the winners: the top 3 who can win, from the leaderboard kept at the cutoff; announced only on management's click, once", { skip }, async () => {
  const live = await ok(call("GET", "/api/console/swag", { as: U.sam }));
  assert.equal(live.live, true);
  assert.deepEqual(live.winners.map((w) => w.name), ["Ann Attendee", "Ben Attendee", "Cal Attendee"]);   // not Vic, Max or Dee
  assert.equal(live.canAnnounce, false);   // staff, and before the cutoff
  // The cutoff passes: the minute job keeps the leaderboard as it is then.
  await ok(setting(U.mia, "swag.cutoff", "2026-01-15T15:00:00-05:00"));
  const snap = await S.runSwagSnapshot({ held: true });
  assert.ok(snap.takenAt && snap.rows.length >= 6);
  // Later points don't count; someone suspended since is passed over.
  for (let i = 0; i < 3; i++) await M.SocialPost.create({ authorId: U.eve._id, authorName: "Eve", body: `Late ${i}`, status: "approved", createdAt: new Date(Date.UTC(2026, 9, 20 + i)) });
  await M.User.updateOne({ _id: U.ben._id }, { $set: { banned: true } });
  const after = await ok(call("GET", "/api/console/swag", { as: U.mia }));
  assert.deepEqual([after.live, after.canAnnounce], [false, true]);
  assert.deepEqual(after.winners.map((w) => [w.name, w.rank]), [["Ann Attendee", 4], ["Cal Attendee", 6], ["Eve Attendee", 7]]);
  // Staff can't announce; the list must be the one shown.
  const ids = after.winners.map((w) => w.userId);
  assert.equal((await call("POST", "/api/console/swag/announce", { as: U.sam, body: { confirm: "ANNOUNCE", userIds: ids } })).status, 403);
  assert.equal((await call("POST", "/api/console/swag/announce", { as: U.mia, body: { userIds: ids } })).status, 400);
  const wrong = await call("POST", "/api/console/swag/announce", { as: U.mia, body: { confirm: "ANNOUNCE", userIds: [idOf(U.ann)] } });
  assert.deepEqual([wrong.status, wrong.body.code, wrong.body.winners.length], [409, "changed", 3]);
  pushes.length = 0;
  const done = await ok(call("POST", "/api/console/swag/announce", { as: U.mia, body: { confirm: "ANNOUNCE", userIds: ids } }));
  assert.deepEqual(done.announced.winners.map((w) => w.userId), ids);
  const notes = await M.AppNotification.find({ batchId: "swag-winners-2026" }).lean();
  assert.deepEqual(notes.map((n) => String(n.userId)).sort(), [...ids].sort());
  assert.deepEqual([notes[0].title, notes[0].body, notes[0].link], ["You won a TTFC swag kit!", "Collect it at the registration desk.", "https://www.thetechfestival.com/swag"]);
  await pause(50);
  assert.deepEqual(pushes.map((p) => [p.to.sort(), p.note.title]), [[[...ids].sort(), "You won a TTFC swag kit!"]]);
  const again = await call("POST", "/api/console/swag/announce", { as: U.mia, body: { confirm: "ANNOUNCE", userIds: ids } });
  assert.deepEqual([again.status, again.body.code], [409, "already_announced"]);
  assert.equal((await ok(call("GET", "/api/app/swag"))).phase, "announced");
  assert.equal((await M.AdminAudit.countDocuments({ action: "swag_announce" })), 1);
  await M.User.updateOne({ _id: U.ben._id }, { $set: { banned: false } });
});

test("the app invite while the contest is on: the swag version, its own claims, the photo inline, re-checked per person", { skip }, async () => {
  // (The contest was switched on above.)
  const t = await ok(call("GET", "/api/console/app-invite/template", { as: U.sam }));
  assert.deepEqual([t.swagOn, t.version, t.defaults.swagSubject], [true, "swag", "Get the TTFC app — only app users can win the swag kit"]);
  assert.ok(["swagSubject", "swagHeadline", "swagOnly", "swagText"].every((k) => t.fields.some((f) => f.key === k)));
  const pv = await ok(call("POST", "/api/console/app-invite/preview", { as: U.sam, body: {} }));
  assert.equal(pv.subject, "Get the TTFC app — only app users can win the swag kit");
  assert.match(pv.html, /Only people using the TTFC app can win — download it, sign in and earn points\./);
  assert.match(pv.html, /src="data:image\/jpeg;base64,/);
  // The list: this version's own claims. Gus got the earlier invite but isn't on the app: he can get this one.
  const list = await ok(call("GET", "/api/console/app-invite/recipients?refresh=1", { as: U.sam }));
  assert.deepEqual([list.version, list.sendKey], ["swag", "app-invite-2026-swag"]);
  const row = (name) => list.rows.find((r) => r.name.startsWith(name));
  assert.deepEqual([row("Gus").willGet, row("Gus").version, !!row("Gus").earlierSentAt], [true, "swag", true]);
  assert.deepEqual([row("Zoe").willGet, row("Zoe").earlierSentAt], [true, null]);
  assert.deepEqual([row("Ann").canSelect, row("Ann").reason], [false, "usingApp"]);
  // Management sends to Gus, Zoe and Ann (Ann is on the app: dropped).
  sent.length = 0;
  const b = await ok(call("POST", "/api/console/app-invite/send-batch", { as: U.mia, body: { kind: "selected", emails: ["gus@example.com", "zoe@example.com", "ann@example.com"], confirm: "CONFIRM" } }), 202);
  assert.deepEqual([b.toSend, b.dropped.map((d) => [d.email, d.reason])], [2, [["ann@example.com", "usingApp"]]]);
  const job = await waitJob();
  assert.deepEqual([job.sent, job.failed], [2, 0]);
  const m = sent.find((x) => x.to === "gus@example.com");
  assert.deepEqual([m.from, m.subject], ["The Tech Festival Canada <enquire@thetechfestival.com>", "Get the TTFC app — only app users can win the swag kit"]);
  assert.ok(m.attachments.some((a) => a.content_id === "swag-kit" && a.content_type === "image/jpeg"));
  assert.match(m.html, /src="cid:swag-kit"/);
  assert.match(m.html, /Winners are announced at the end of Day 1/);
  assert.match(m.html, /href="https:\/\/www\.thetechfestival\.com\/app\/#r=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"/);   // the app invite's own link and tracking
  assert.equal(await M.CampaignSend.countDocuments({ campaign: "app-invite-2026-swag", status: "sent" }), 2);
  assert.equal(await M.CampaignSend.countDocuments({ campaign: "app-invite-2026" }), 1);   // the earlier send stays recorded
  // Each person gets this version once.
  const after = await ok(call("GET", "/api/console/app-invite/recipients?refresh=1", { as: U.sam }));
  assert.deepEqual([after.rows.find((r) => r.name.startsWith("Gus")).reason, after.rows.find((r) => r.name.startsWith("Gus")).label], ["alreadySent", "Already got this version"]);
  const again = await call("POST", "/api/console/app-invite/send-batch", { as: U.mia, body: { kind: "next", size: 10, emails: ["gus@example.com"], confirm: "CONFIRM" } });
  assert.deepEqual([again.status, again.body.code], [409, "none"]);
});

test("checked again just before it goes: someone who signed in to the app since is skipped", { skip }, async () => {
  const mails = [];
  const sendTo = SEND.makeInviteSender({ CampaignSend: M.CampaignSend, template: { copy: {} }, swag: await S.loadSwag(), recheck: true, send: async (x) => { mails.push([x.to, !!x.swag]); return { id: "re_x" }; } });
  await M.User.create({ name: "Liv Late", email: "liv@example.com", tickets: [{ ticketId: "con120000009", type: "connect" }] });
  const row = { id: "a-x", name: "Liv Late", email: "liv@example.com", firstName: "Liv" };
  await M.User.updateOne({ email: "liv@example.com" }, { $set: { lastActiveAt: new Date() } });   // signed in meanwhile
  assert.equal(await sendTo(row, "mia"), "usingApp");
  assert.deepEqual(mails, []);
  assert.equal(await M.CampaignSend.countDocuments({ email: "liv@example.com" }), 0);
  await M.User.updateOne({ email: "liv@example.com" }, { $unset: { lastActiveAt: 1 } });
  assert.ok((await sendTo(row, "mia")) instanceof Date);
  assert.deepEqual(mails, [["liv@example.com", true]]);
  assert.equal(await M.CampaignSend.countDocuments({ campaign: "app-invite-2026-swag", email: "liv@example.com" }), 1);
});
