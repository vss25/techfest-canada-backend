/* The post-event survey's paced app prompt and its "who answered" list (Oct 26 2026, late), through the real routes
   against a real (throwaway) MongoDB. The organiser: "They should see this in feed and prompted/notified some time
   after 4 pm. All of them don't need to be notified immediately." and "If they fill the survey, that should update the
   admin panel and I should see that so that I don't end up resending the survey request to them."
   Waves of notifyBatchSize, the most recently active first, from opensAt + the delay, one per interval, until 10 PM
   that day; once per person; people who answered, never checked in, are hidden or suspended left out; two servers at
   once send one wave; someone who checks in later gets theirs in a later wave; management's Send still works, once per
   person. The list: everyone checked in, each address once, emailed / prompted / answered, not answered first; the
   email never goes again to someone who answered after the first one. A stored autoNotify false from before (the old
   default) counts as unset. Starts a local mongod in a temp folder on a free port and stops it after; skipped when the
   binary isn't there (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Nothing leaves the
   machine: Resend and Sanity are stubbed fetches, pushes are watched. Fictional people, example.com. */
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

const batches = [];   // every Resend batch call's emails
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url === "https://api.resend.com/emails/batch") {
    const list = JSON.parse(opts?.body || "[]");
    batches.push(list);
    return new Response(JSON.stringify({ data: list.map((_, i) => ({ id: `re_${batches.length}_${i}` })) }), { status: 200, headers: { "content-type": "application/json" } });
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
let S;   // services/survey.js
let R;   // services/surveyRules.js
let norm;
let forgetPeople;
const M = {};
const U = {};
const A = {};
const pushes = [];

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-survey-track-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await pause(250);
  await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_survey_track_test`);
  ({ default: jwt } = await import("jsonwebtoken"));
  const { observePushes } = await import("../services/push.js");
  observePushes((to, note) => pushes.push({ to, note }));
  ({ normalizeTicketId: norm } = await import("../services/ticketAccess.js"));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.Attendee = await imp("../models/Attendee.js");
  M.CampaignSend = await imp("../models/CampaignSend.js");
  M.AppNotification = await imp("../models/AppNotification.js");
  M.SurveyResponse = await imp("../models/SurveyResponse.js");
  M.CheckinMark = await imp("../models/CheckinMark.js");
  Object.assign(M, await import("../models/Admin.js"));
  await Promise.all([M.CampaignSend.init(), M.AppContent.init(), M.SurveyResponse.init()]);
  S = await import("../services/survey.js");
  R = await import("../services/surveyRules.js");
  const survey = await import("../routes/survey.js");
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/survey", survey.publicRouter);
  app.use("/api/console/survey", survey.adminRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const active = (h) => ({ appOnboarded: true, lastActiveAt: new Date(Date.UTC(2026, 9, 20, h)) });   // later hour = more recent
  const pass = (id) => [{ ticketId: id, type: "connect", purchaseDate: new Date("2026-10-01") }];
  const mk = (key, doc) => M.User.create(doc).then((u) => { U[key] = u; });
  await Promise.all([
    mk("mia", { name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management" }),
    mk("sam", { name: "Sam Staff", email: "sam.staff@example.com", role: "admin", staffRole: "staff" }),
    mk("u1", { name: "Abe One", email: "abe@example.com", tickets: pass("CON270000001"), ...active(20) }),
    mk("u2", { name: "Bea Two", email: "bea2@example.com", tickets: pass("CON270000002"), ...active(19) }),
    mk("u3", { name: "Cy Three", email: "cy@example.com", tickets: pass("CON270000003"), ...active(18) }),
    mk("u4", { name: "Di Four", email: "di@example.com", tickets: pass("CON270000004"), ...active(17) }),
    mk("u5", { name: "Ed Five", email: "ed@example.com", tickets: pass("CON270000005"), ...active(16) }),
    mk("ans", { name: "Ava Answered", email: "ava@example.com", tickets: pass("CON270000006"), ...active(21) }),
    mk("nci", { name: "Ned Notyet", email: "ned@example.com", tickets: pass("CON270000007"), ...active(22) }),
    mk("hid", { name: "Hal Hidden", email: "hal@example.com", tickets: pass("CON270000008"), ...active(23), appHidden: { at: new Date("2026-10-19T12:00:00Z") } }),
    mk("ban", { name: "Bo Banned", email: "bo@example.com", tickets: pass("CON270000009"), ...active(15), banned: true }),
    mk("late", { name: "Lu Late", email: "lu@example.com", tickets: pass("CON270000010"), ...active(14) }),
  ]);
  A.pp = await M.Attendee.create({ name: "Pat Passonly", email: "pat@example.com", ticketId: "CON270000020", ticketType: "connect" });
  const mark = (ticketId, day, point = "arrived") => ({ subject: norm(ticketId), day, point, at: new Date(`${day}T13:30:00Z`) });
  await M.CheckinMark.insertMany([
    mark("CON270000001", "2026-10-26"), mark("CON270000001", "2026-10-27", "checked_in"),
    mark("CON270000002", "2026-10-26"), mark("CON270000003", "2026-10-26"), mark("CON270000004", "2026-10-27"), mark("CON270000005", "2026-10-27"),
    mark("CON270000006", "2026-10-26"), mark("CON270000008", "2026-10-26"), mark("CON270000009", "2026-10-26"), mark("CON270000020", "2026-10-26"),
  ]);
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const tokenFor = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function call(method, url, { as, body, raw = false } = {}) {
  const r = await realFetch(base + url, {
    method, headers: { "content-type": "application/json", ...(as ? { authorization: `Bearer ${tokenFor(as)}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = raw ? text : JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, headers: r.headers };
}
const ok = async (p, want = 200) => {
  const r = await p;
  assert.equal(r.status, want, JSON.stringify(r.body));
  return r.body;
};
const put = (as, body) => call("PUT", "/api/console/survey", { as, body });
const T0 = Date.parse("2026-10-20T16:00:00-04:00");   // opensAt: in the past, so the survey is open now too
const at = (min) => new Date(T0 + min * 60_000);
const wave = (min, held = true) => S.runSurveyNotify({ now: at(min), held });
const prompted = async () => (await M.AppNotification.find({ batchId: "survey-2026" }).sort({ createdAt: 1, _id: 1 }).lean()).map((n) => String(n.userId));
const ids = (...keys) => keys.map((k) => String(U[k]._id));

test("defaults: the prompt is automatic and paced; an old stored false counts as unset; the numbers are checked", { skip }, async () => {
  // What a whole-form save stored before the default changed: autoNotify false, not management's own choice.
  await M.AppContent.create({ key: "survey.config", value: { autoNotify: false }, updatedBy: "Mia Manager" });
  const g = await ok(call("GET", "/api/console/survey", { as: U.sam }));
  assert.deepEqual([g.config.autoNotify, g.config.notifyStartDelayMin, g.config.notifyBatchSize, g.config.notifyIntervalMin], [true, 15, 30, 5]);
  assert.deepEqual(Object.keys(g.notifyProgress).sort(), ["auto", "batchSize", "done", "endsAt", "intervalMin", "lastWaveAt", "nextAt", "remaining", "sent", "startsAt"]);
  for (const body of [{ notifyBatchSize: 0 }, { notifyBatchSize: 201 }, { notifyIntervalMin: 61 }, { notifyStartDelayMin: 241 }, { notifyIntervalMin: "soon" }]) {
    assert.equal((await put(U.mia, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await put(U.sam, { notifyBatchSize: 2 })).status, 403);
  const r = await ok(put(U.mia, { opensAt: new Date(T0).toISOString().replace("Z", "+00:00"), notifyBatchSize: 2, autoNotify: true }));
  assert.deepEqual([r.config.notifyBatchSize, r.config.autoNotify], [2, true]);
  assert.deepEqual(r.changed.sort(), ["notifyBatchSize", "opensAt"]);   // autoNotify was already on: nothing stored
});

test("waves: 2 at a time from 4:15 PM, every 5 minutes, the most recently active first; once each; two servers send one wave", { skip }, async () => {
  // Ava answers first (she checked in): never prompted.
  await ok(call("POST", "/api/survey/responses", { as: U.ans, body: { answers: { checkin: 5 } } }), 201);
  assert.equal(await wave(14), null);
  let cfg = await S.loadSurvey({ fresh: true });
  let pr = await S.notifyProgress(cfg, { now: at(14) });
  assert.deepEqual([pr.sent, pr.remaining, pr.nextAt, pr.done, pr.auto], [0, 5, at(15).toISOString(), false, true]);
  // 4:15: the first two (Abe, Bea); not Ned (never checked in), Hal (hidden), Bo (suspended), Ava (answered).
  const w1 = await wave(15);
  assert.deepEqual([w1.sent, w1.remaining, w1.answered, w1.notCheckedIn, w1.hidden], [2, 3, 1, 2, 1]);
  assert.deepEqual(await prompted(), ids("u1", "u2"));
  assert.equal(await wave(17), null);   // not before the interval
  cfg = await S.loadSurvey({ fresh: true });
  pr = await S.notifyProgress(cfg, { now: at(16) });
  assert.deepEqual([pr.sent, pr.remaining, pr.nextAt, pr.done], [2, 3, at(20).toISOString(), false]);
  assert.equal((await wave(20)).sent, 2);
  assert.deepEqual(await prompted(), ids("u1", "u2", "u3", "u4"));
  // Two servers at 4:25 (the job lock): one wave.
  const both = await Promise.all([wave(25, false), wave(25, false)]);
  assert.deepEqual(both.map((x) => x?.sent ?? null).sort(), [1, null].sort());
  // Two more at 4:30 holding the lock between them: the wave's own claim still lets one through (nobody left to send).
  const again = await Promise.all([wave(30), wave(30)]);
  assert.ok(again.filter(Boolean).length <= 1);
  assert.deepEqual(await prompted(), ids("u1", "u2", "u3", "u4", "u5"));
  cfg = await S.loadSurvey({ fresh: true });
  pr = await S.notifyProgress(cfg, { now: at(31) });
  assert.deepEqual([pr.sent, pr.remaining, pr.done], [5, 0, true]);
  // Ned checks in on Day 2: the next wave has him.
  await M.CheckinMark.create({ subject: norm("CON270000007"), day: "2026-10-27", point: "arrived", at: new Date() });
  assert.deepEqual([(await wave(35)).sent, (await prompted()).at(-1)], [1, String(U.nci._id)]);
  // In the inbox with their own link; one push per wave (to whoever has Announcements on).
  const n = await M.AppNotification.findOne({ userId: U.u3._id, batchId: "survey-2026" }).lean();
  assert.deepEqual(R.verifySurveyToken(new URL(n.link).searchParams.get("t")), { kind: "u", id: String(U.u3._id) });
  await pause(100);
  assert.deepEqual(pushes.map((p) => p.to.length), [2, 2, 1, 1]);
  // 10 PM: no more waves; Lu checks in late; management's Send reaches her (once).
  await M.CheckinMark.create({ subject: norm("CON270000010"), day: "2026-10-27", point: "arrived", at: new Date() });
  assert.equal(await S.runSurveyNotify({ now: new Date("2026-10-20T22:00:00-04:00"), held: true }), null);
  const sent = await ok(call("POST", "/api/console/survey/notify", { as: U.mia, body: { confirm: "SEND" } }));
  assert.deepEqual([sent.sent, sent.already], [1, 6]);
  assert.equal((await ok(call("POST", "/api/console/survey/notify", { as: U.mia, body: { confirm: "SEND" } }))).sent, 0);
  assert.equal((await prompted()).length, 7);
  assert.equal(new Set(await prompted()).size, 7);   // once per person
});

test("who answered: everyone checked in with when they were emailed, prompted and answered; no email again after an answer", { skip }, async () => {
  // The email to everyone checked in who hasn't answered (Ava has).
  const out = await ok(call("POST", "/api/console/survey/email", { as: U.mia, body: { audience: "both", confirm: "SEND" } }));
  // Checked in: Abe, Bea, Cy, Di, Ed, Ava, Ned, Hal, Bo, Lu, Pat = 11; Ava answered.
  assert.deepEqual([out.sent, out.counts.checkedIn, out.counts.responded], [10, 11, 1]);
  // Pat answers after the email (her pass's link); her send is then marked failed (as if it could be retried).
  await ok(call("POST", "/api/survey/responses", { body: { answers: { checkin: 4 }, t: R.signSurveyToken("p", String(A.pp._id)) } }), 201);
  await M.CampaignSend.updateOne({ campaign: "survey-2026", email: "pat@example.com" }, { $set: { status: "failed" } });
  const before = batches.length;
  const pv = await ok(call("GET", "/api/console/survey/email?audience=both", { as: U.sam }));
  assert.deepEqual([pv.count, pv.counts.responded, pv.counts.alreadySent], [0, 2, 9]);
  const second = await ok(call("POST", "/api/console/survey/email", { as: U.mia, body: { audience: "both", confirm: "SEND" } }));
  assert.deepEqual([second.sent, batches.length], [0, before]);   // Pat isn't emailed again

  // The list.
  const all = await ok(call("GET", "/api/console/survey/people", { as: U.sam }));
  assert.deepEqual(all.counts, { checkedIn: 11, answered: 2, notAnswered: 9, emailed: 9, appNotified: 7, onApp: 10 });
  assert.deepEqual([all.total, all.page, all.size, all.rows.length], [11, 0, 50, 11]);
  // Not answered first, then by name.
  assert.deepEqual(all.rows.map((r) => r.name), ["Abe One", "Bea Two", "Bo Banned", "Cy Three", "Di Four", "Ed Five", "Hal Hidden", "Lu Late", "Ned Notyet", "Ava Answered", "Pat Passonly"]);
  const pat = all.rows.find((r) => r.email === "pat@example.com");
  // (Her send's record says failed now, so the list doesn't count her as emailed.)
  assert.deepEqual([pat.onApp, pat.checkedInDays, !!pat.emailedAt, pat.appNotifiedAt, !!pat.answeredAt, pat.source], [false, ["day1"], false, null, true, "link"]);
  const abe = all.rows.find((r) => r.email === "abe@example.com");
  assert.deepEqual([abe.onApp, abe.checkedInDays, !!abe.emailedAt, !!abe.appNotifiedAt, abe.answeredAt], [true, ["day1", "day2"], true, true, null]);
  assert.deepEqual(Object.keys(abe).sort(), ["answeredAt", "appNotifiedAt", "checkedInDays", "company", "email", "emailedAt", "name", "onApp", "personId", "source", "updatedAt"]);
  const names = async (q) => (await ok(call("GET", `/api/console/survey/people?${q}`, { as: U.sam }))).rows.map((r) => r.name);
  assert.deepEqual(await names("status=answered"), ["Ava Answered", "Pat Passonly"]);
  assert.equal((await names("status=not_answered")).length, 9);
  assert.deepEqual(await names("status=not_emailed"), ["Ava Answered", "Pat Passonly"]);   // Ava never got one; Pat's record is the failed one
  assert.deepEqual(await names("q=passonly"), ["Pat Passonly"]);
  // The CSV, audited.
  const csv = await call("GET", "/api/console/survey/people/export?status=answered", { as: U.sam, raw: true });
  assert.equal(csv.status, 200);
  assert.equal(csv.body.replace(/^\uFEFF/, "").split("\n").length, 3);
  assert.equal(await M.AdminAudit.countDocuments({ action: "survey_people_export" }), 1);
  // Staff's links say who answered, was emailed and was prompted.
  const links = await ok(call("POST", "/api/console/survey/links", { as: U.mia, body: { emails: ["pat@example.com", "abe@example.com"] } }));
  assert.deepEqual(links.map((l) => [l.email, !!l.answeredAt, !!l.emailedAt, !!l.appNotifiedAt]), [["pat@example.com", true, false, false], ["abe@example.com", false, true, true]]);
  const one = await ok(call("GET", "/api/console/survey/link?email=ava@example.com", { as: U.mia }));
  assert.ok(one.answeredAt);
});
