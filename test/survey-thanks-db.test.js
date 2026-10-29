/* The thank-you email and the reminders (Oct 29 2026), through the real routes against a real (throwaway) MongoDB.
   The organiser: "Create a thank you email for those who were checked in and then start sending them TTFC survey email
   in the batch of 20 per hour … Use marcom@thetechfestival.com … Personalize the email verbiage to speakers,
   exhibitors, delegate … Everyone should get their own survey URL … send a notification … and a second reminder to
   those who haven't filled out the survey." Off until management switches it on; perHour per clock hour inside the
   windows only; people not on the app first; worded by role; staff and volunteers, people who answered and people who
   never checked in left out; each address once; reminders once each, to checked-in app users who haven't answered,
   never 2 h late or at night. Same local mongod as the other survey tests (skipped without it); Resend is a stubbed
   fetch, pushes are watched. Fictional people, example.com. */
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
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-survey-thanks-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await pause(250);
  await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_survey_thanks_test`);
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

  const onApp = (h) => ({ appOnboarded: true, lastActiveAt: new Date(Date.UTC(2026, 9, 27, h)) });
  const pass = (id) => [{ ticketId: id, type: "connect", purchaseDate: new Date("2026-10-01") }];
  const mk = (key, doc) => M.User.create(doc).then((u) => { U[key] = u; });
  await Promise.all([
    mk("mia", { name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management" }),
    mk("sam", { name: "Sam Staff", email: "sam.staff@example.com", role: "admin", staffRole: "staff" }),
    mk("sp", { name: "Sia Speaker", email: "sia@example.com", tickets: pass("CON290000001"), types: ["speaker"] }),
    mk("ex", { name: "Eli Exhibitor", email: "eli@example.com", tickets: pass("CON290000002"), types: ["exhibitor"] }),
    mk("d1", { name: "Ada Delegate", email: "ada@example.com", tickets: pass("CON290000003"), ...onApp(10) }),
    mk("d2", { name: "Ben Delegate", email: "ben@example.com", tickets: pass("CON290000004"), ...onApp(11) }),
    mk("d3", { name: "Cal Delegate", email: "cal@example.com", tickets: pass("CON290000005") }),
    mk("vol", { name: "Val Volunteer", email: "val@example.com", role: "volunteer", tickets: pass("CON290000006"), ...onApp(12) }),
    mk("ans", { name: "Ann Answered", email: "ann@example.com", tickets: pass("CON290000007"), ...onApp(13) }),
    mk("nci", { name: "Nat Notcheckedin", email: "nat@example.com", tickets: pass("CON290000008"), ...onApp(14) }),
  ]);
  const mark = (ticketId, day) => ({ subject: norm(ticketId), day, point: "arrived", at: new Date(`${day}T13:30:00Z`) });
  await M.CheckinMark.insertMany(["CON290000001", "CON290000002", "CON290000003", "CON290000004", "CON290000005", "CON290000006", "CON290000007"]
    .map((t, i) => mark(t, i % 2 ? "2026-10-27" : "2026-10-26")));
  await M.SurveyResponse.create({ key: `u:${U.ans._id}`, userId: U.ans._id, email: "ann@example.com", source: "app", answers: { checkin: 5 } });
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
const T = Date.parse("2026-10-29T15:00:00-04:00");   // a Thursday, 3 PM Toronto
const at = (min) => new Date(T + min * 60_000);
const PAST = "2026-10-20T16:00:00-04:00";
const THANKS = {
  enabled: true, perHour: 3,
  windows: [{ start: "2026-10-29T08:00:00-04:00", end: "2026-10-29T18:00:00-04:00" }, { start: "2026-10-30T08:00:00-04:00", end: "2026-10-30T14:00:00-04:00" }],
  reminders: [
    { id: "r1", at: "2026-10-29T15:30:00-04:00", title: "How was TTFC 2026?", body: "Two minutes: tell us how the festival went for you." },
    { id: "r2", at: "2026-10-30T10:00:00-04:00", title: "Two minutes for TTFC?", body: "A quick reminder." },
  ],
};
const sentTo = () => batches.flat().map((m) => m.to[0]);

test("off by default: nothing goes; staff can look, only management switches it on", { skip }, async () => {
  await ok(call("PUT", "/api/console/survey", { as: U.mia, body: { opensAt: PAST } }));
  const g = await ok(call("GET", "/api/console/survey/thanks", { as: U.sam }));
  assert.equal(g.config.enabled, false);
  assert.equal(g.config.perHour, 20);
  assert.equal(g.config.from, "The Tech Festival Canada <marcom@thetechfestival.com>");
  // Checked in, not answered, not team: Sia, Eli, Ada, Ben, Cal (Val volunteers, Ann answered, Nat never checked in).
  assert.deepEqual([g.progress.left, g.progress.leftOnApp, g.progress.byRole], [5, 2, { speaker: 1, exhibitor: 1, delegate: 3 }]);
  assert.deepEqual(Object.keys(g.previews), ["speaker", "exhibitor", "delegate"]);
  assert.equal(g.previews.speaker.subject, "Thank you for speaking at TTFC 2026");
  assert.equal(g.previews.exhibitor.subject, "Thank you for exhibiting at TTFC 2026");
  assert.equal(g.previews.delegate.subject, "Thank you for joining us at TTFC 2026");
  assert.match(g.previews.delegate.text, /Hi Alex,\n\nThank you for joining us at The Tech Festival Canada 2026\./);
  assert.match(g.previews.speaker.html, /See you in 2027\.<br>The TTFC team/);
  assert.equal(await S.runThanksEmails({ now: at(0), held: true }), null);
  assert.equal(await S.runSurveyReminders({ now: at(30) }), null);
  assert.equal((await call("PUT", "/api/console/survey/thanks", { as: U.sam, body: { enabled: true } })).status, 403);
  assert.equal((await call("PUT", "/api/console/survey/thanks", { as: U.mia, body: { perHour: 0 } })).status, 400);
  assert.equal((await call("PUT", "/api/console/survey/thanks", { as: U.mia, body: { windows: [{ start: "tomorrow", end: "later" }] } })).status, 400);
  assert.equal(batches.length, 0);
});

test("on: perHour each clock hour inside the windows, people not on the app first, worded by role, from marcom@, each once", { skip }, async () => {
  const g = await ok(call("PUT", "/api/console/survey/thanks", { as: U.mia, body: THANKS }));
  assert.equal(g.config.enabled, true);
  // 3 PM: three (not on the app first, by name: Cal, Eli, Sia).
  const one = await S.runThanksEmails({ now: at(0), held: true });
  assert.deepEqual([one.sent, one.left], [3, 2]);
  assert.deepEqual(sentTo(), ["cal@example.com", "eli@example.com", "sia@example.com"]);
  const b = batches[0];
  for (const m of b) {
    assert.equal(m.from, "The Tech Festival Canada <marcom@thetechfestival.com>");
    assert.equal(m.reply_to, "marcom@thetechfestival.com");
    assert.match(m.html, /https:\/\/www\.thetechfestival\.com\/survey\?t=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}/);
  }
  assert.deepEqual(b.map((m) => m.subject), ["Thank you for joining us at TTFC 2026", "Thank you for exhibiting at TTFC 2026", "Thank you for speaking at TTFC 2026"]);
  assert.match(b[2].text, /^Hi Sia,\n\nThank you for speaking at The Tech Festival Canada 2026\./);
  // The same hour: nothing more. 4 PM: the last two. 5 PM: nobody left.
  assert.equal(await S.runThanksEmails({ now: at(40), held: true }), null);
  const two = await S.runThanksEmails({ now: at(60), held: true });
  assert.deepEqual([two.sent, two.left], [2, 0]);
  assert.equal(await S.runThanksEmails({ now: at(120), held: true }), null);
  assert.deepEqual(sentTo().sort(), ["ada@example.com", "ben@example.com", "cal@example.com", "eli@example.com", "sia@example.com"]);
  // Tracked like the survey email: the admin list shows them emailed.
  const sends = await M.CampaignSend.find({ campaign: "survey-2026", status: "sent" }).lean();
  assert.equal(sends.length, 5);
  const st = await ok(call("GET", "/api/console/survey/thanks", { as: U.mia }));
  assert.deepEqual([st.progress.sent, st.progress.left], [5, 0]);
});

test("outside the windows nothing goes: before 8 AM, after 6 PM Thursday, after 2 PM Friday", { skip }, async () => {
  await M.CampaignSend.deleteMany({});
  batches.length = 0;
  for (const when of ["2026-10-29T07:59:00-04:00", "2026-10-29T18:00:00-04:00", "2026-10-30T14:00:00-04:00", "2026-10-31T09:00:00-04:00"]) {
    assert.equal(await S.runThanksEmails({ now: new Date(when), held: true }), null, when);
  }
  // Friday 8 AM: inside.
  assert.equal((await S.runThanksEmails({ now: new Date("2026-10-30T08:00:00-04:00"), held: true })).sent, 3);
  assert.equal(batches.length, 1);
});

test("reminders: once each, to checked-in app users who haven't answered; never 2 h late or at night", { skip }, async () => {
  pushes.length = 0;
  assert.equal(await S.runSurveyReminders({ now: at(29) }), null);   // not yet
  const r1 = await S.runSurveyReminders({ now: at(31) });
  assert.deepEqual(r1, [{ id: "r1", sent: 2 }]);   // Ada and Ben: not Val (a volunteer), Ann (answered), Nat (not checked in)
  const ids = (await M.AppNotification.find({ batchId: "survey-2026-r1" }).lean()).map((n) => String(n.userId)).sort();
  assert.deepEqual(ids, [String(U.d1._id), String(U.d2._id)].sort());
  const note = await M.AppNotification.findOne({ batchId: "survey-2026-r1" }).lean();
  assert.deepEqual([note.title, note.body], ["How was TTFC 2026?", "Two minutes: tell us how the festival went for you."]);
  assert.match(note.link, /\/survey\?t=/);
  assert.equal(await S.runSurveyReminders({ now: at(40) }), null);   // once
  const cfg = await ok(call("GET", "/api/console/survey/thanks", { as: U.mia }));
  assert.equal(cfg.config.reminders[0].sent, 2);
  assert.ok(cfg.config.reminders[0].sentAt);
  // A later save keeps it sent.
  await ok(call("PUT", "/api/console/survey/thanks", { as: U.mia, body: { reminders: THANKS.reminders } }));
  assert.equal(await S.runSurveyReminders({ now: at(45) }), null);
  // r2 three hours late: never.
  assert.equal(await S.runSurveyReminders({ now: new Date("2026-10-30T13:01:00-04:00") }), null);
  // Moved to the night: never.
  await ok(call("PUT", "/api/console/survey/thanks", { as: U.mia, body: { reminders: [THANKS.reminders[0], { ...THANKS.reminders[1], at: "2026-10-30T23:00:00-04:00" }] } }));
  assert.equal(await S.runSurveyReminders({ now: new Date("2026-10-30T23:05:00-04:00") }), null);
  // Ben answers; r2 at 10 AM: only Ada.
  await M.SurveyResponse.create({ key: `u:${U.d2._id}`, userId: U.d2._id, email: "ben@example.com", source: "app", answers: { checkin: 4 } });
  await ok(call("PUT", "/api/console/survey/thanks", { as: U.mia, body: { reminders: THANKS.reminders } }));
  assert.deepEqual(await S.runSurveyReminders({ now: new Date("2026-10-30T10:01:00-04:00") }), [{ id: "r2", sent: 1 }]);
  assert.equal(pushes.length, 2);
});
