/* The post-event survey (Oct 26 2026) through the real routes, against a real (throwaway) MongoDB: closed until it
   opens (staff can preview), management edits the questions (add, edit, delete: answers to deleted questions are
   kept and in the CSV), answers checked against the current questions (skip, N/A, show-only-if), one response per
   person (answering again updates it), who's answering (the app's sign-in, a personal link for an account or a pass),
   the app's card, the averages without N/A, the app prompt (nothing with the defaults; once autoNotify is on, the job
   sends it once; management's Send never twice to anyone), and the email to the people checked in (the audience from
   the check-in desk's marks, each address once, a preview sends nothing, a second Send emails nobody twice, the
   unsubscribed and people who've answered left out).
   By invitation and for people who attended (later that night): no questions and no answers without a personal link
   or the app's sign-in; a valid link for someone without a door check-in (a rehearsal scan doesn't count) is turned
   away, and let in as soon as they check in; the app's card and the prompt only for people who checked in; staff's
   personal links for one-on-one sharing (an account's or a pass's, with a warning for people not checked in).
   Starts a local mongod in a temp folder on a free port and stops it after; skipped when the binary isn't there
   (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Nothing leaves the machine: Resend
   and Sanity are stubbed fetches, pushes are watched (observePushes), no push service is configured. Fictional people,
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
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-survey-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await pause(250);
  await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_survey_test`);
  ({ default: jwt } = await import("jsonwebtoken"));
  const { observePushes } = await import("../services/push.js");
  observePushes((to, note) => pushes.push({ to, note }));
  ({ normalizeTicketId: norm } = await import("../services/ticketAccess.js"));
  ({ forgetPeople } = await import("../routes/people.js"));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.Attendee = await imp("../models/Attendee.js");
  M.CampaignSend = await imp("../models/CampaignSend.js");
  M.Subscription = await imp("../models/Subscription.js");
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
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use("/api/survey", survey.publicRouter);
  app.use("/api/app/survey", survey.appRouter);
  app.use("/api/console/survey", survey.adminRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const onApp = { appOnboarded: true, lastActiveAt: new Date("2026-10-26T12:00:00Z") };
  const pass = (id, type = "connect") => [{ ticketId: id, type, purchaseDate: new Date("2026-10-01") }];
  const mk = (key, doc) => M.User.create(doc).then((u) => { U[key] = u; });
  await Promise.all([
    mk("mia", { name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management" }),
    mk("sam", { name: "Sam Staff", email: "sam.staff@example.com", role: "admin", staffRole: "staff" }),
    mk("ann", { name: "Ann Attendee", email: "ann@example.com", jobTitle: "CTO", organization: "Acme", tickets: pass("CON260000001"), ...onApp }),
    mk("ben", { name: "Ben Speaker", email: "ben@example.com", tickets: [...pass("SPK260000001", "speaker"), ...pass("POW260000001", "power")], ...onApp }),
    mk("cal", { name: "Cal Quiet", email: "cal@example.com", tickets: pass("CON260000002"), ...onApp, notifyPrefs: { announcements: false } }),
    mk("nat", { name: "Nat Later", email: "nat@example.com", tickets: pass("CON260000006"), ...onApp }),   // checks in during the tests
    mk("ola", { name: "Ola Offsite", email: "ola@example.com", tickets: pass("CON260000007"), ...onApp }),  // on the app, never came
    mk("hid", { name: "Hal Hidden", email: "hal@example.com", tickets: pass("CON260000003"), ...onApp, appHidden: { at: new Date("2026-10-25T12:00:00Z") } }),
    mk("ban", { name: "Bea Banned", email: "bea@example.com", tickets: pass("CON260000004"), ...onApp, banned: true }),
    mk("web", { name: "Wes Website", email: "wes@example.com", tickets: pass("CON260000005") }),   // an account, never on the app
  ]);
  const att = (key, doc) => M.Attendee.create(doc).then((a) => { A[key] = a; });
  await Promise.all([
    att("zoe", { name: "Zoe Passonly", email: "zoe@example.com", ticketId: "CON260000010", ticketType: "connect", details: { jobTitle: "Founder", organization: "Zed Labs" } }),
    att("uma", { name: "Uma Unsub", email: "uma@example.com", ticketId: "CON260000011", ticketType: "connect" }),
    att("rae", { name: "Rae Responded", email: "rae@example.com", ticketId: "CON260000012", ticketType: "connect" }),
    att("day2", { name: "Dan Daytwo", email: "dan@example.com", ticketId: "CON260000013", ticketType: "connect" }),
    att("prac", { name: "Pat Practice", email: "pat@example.com", ticketId: "CON260000014", ticketType: "connect" }),
  ]);
  await M.Subscription.create({ email: "uma@example.com", subscribed: false, unsubscribedAt: new Date() });
  // The check-in desk's marks: Day 1 arrivals and check-ins (Ben with both his passes), Dan on Day 2, Pat only at the
  // Sunday rehearsal, Ann's lunch (not the door).
  await M.CheckinMark.insertMany([
    mark("CON260000001", "2026-10-26", "arrived"), mark("CON260000001", "2026-10-26", "checked_in"), mark("CON260000001", "2026-10-26", "lunch"),
    mark("SPK260000001", "2026-10-26", "checked_in"), mark("POW260000001", "2026-10-26", "arrived"),
    mark("CON260000010", "2026-10-26", "checked_in"), mark("CON260000011", "2026-10-26", "arrived"), mark("CON260000012", "2026-10-26", "arrived"),
    mark("CON260000005", "2026-10-26", "arrived"),
    mark("CON260000013", "2026-10-27", "arrived"), mark("CON260000002", "2026-10-27", "arrived"),
    mark("CON260000014", "2026-10-25", "checked_in", { practice: true }),
  ]);
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const mark = (ticketId, day, point, extra = {}) => ({ subject: norm(ticketId), day, point, at: new Date(`${day}T13:30:00Z`), ...extra });
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
const answer = (body, { as, t } = {}) => call("POST", `/api/survey/responses${t ? `?t=${t}` : ""}`, { as, body });
const PAST = "2026-01-01T09:00:00-05:00";
const FUTURE = "2099-01-01T09:00:00-05:00";
const LATER = "2099-12-31T23:59:00-05:00";

test("with the defaults: closed until Tue 4 PM (staff can preview), nothing sent on deploy or by the job", { skip }, async () => {
  const g = await call("GET", "/api/survey");
  assert.equal(g.status, 200);
  assert.equal(g.headers.get("cache-control"), "private, no-store");
  // (Run before Tue Oct 27 4 PM ET, it's closed; any later, open: the window is the defaults'.)
  const openNow = new Date() >= new Date("2026-10-27T16:00:00-04:00");
  // Without a personal link or a sign-in: the title and the window only (by invitation).
  assert.deepEqual(Object.keys(g.body).sort(), ["closesAt", "invitationOnly", "open", "opensAt", "questions", "title"]);
  assert.deepEqual([g.body.open, g.body.opensAt, g.body.title, g.body.invitationOnly, g.body.questions], [openNow, "2026-10-27T16:00:00-04:00", "How was TTFC 2026?", true, []]);
  if (!openNow) {
    const shut = await answer({ answers: { name: "X", email: "x@example.com" } }, { as: U.ann });
    assert.deepEqual([shut.status, shut.body.code], [403, "closed"]);
    const card = await ok(call("GET", "/api/app/survey", { as: U.ann }));
    assert.deepEqual([card.show, card.cta], [false, "Share feedback"]);
    assert.match(card.url, /^https:\/\/www\.thetechfestival\.com\/survey\?t=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
  }
  // Staff preview it before it opens; an attendee's ?preview=1 does nothing.
  assert.equal((await ok(call("GET", "/api/survey?preview=1", { as: U.sam }))).questions.length, 32);
  assert.equal((await ok(call("GET", "/api/survey?preview=1", { as: U.ann }))).preview, undefined);
  assert.equal((await call("GET", "/api/app/survey")).status, 401);
  // The job, now and at opensAt and later, with nothing saved: nothing.
  for (const at of ["2026-10-27T20:00:30Z", "2026-10-28T12:00:00Z"]) assert.equal(await S.runSurveyNotify({ now: new Date(at), held: true }), null);
  // Saved but autoNotify still off (the default), open: still nothing.
  await ok(put(U.mia, { opensAt: PAST }));
  assert.equal(await S.runSurveyNotify({ now: new Date(), held: true }), null);
  await pause(50);
  assert.deepEqual([await M.AppNotification.countDocuments({}), pushes.length, batches.length], [0, 0, 0]);
  await ok(put(U.mia, { opensAt: FUTURE, closesAt: LATER }));
});

test("management edits the survey: add, edit and delete questions; staff can only read; bad saves refused", { skip }, async () => {
  const sam = await ok(call("GET", "/api/console/survey", { as: U.sam }));
  assert.deepEqual([sam.canEdit, sam.invitationOnly, sam.url, sam.config.autoNotify, sam.counts], [false, true, undefined, false, { responses: 0, app: 0, link: 0 }]);
  assert.equal((await put(U.sam, { title: "Nope" })).status, 403);
  const before = sam.config.questions;
  // Delete "food", edit "meals", add one without an id and one with.
  const list = before.filter((q) => q.id !== "food").map((q) => (q.id === "meals" ? { ...q, label: "Meals and catering", required: false, help: "All three days" } : q));
  list.splice(3, 0, { section: "Your TTFC 2026", type: "choice", label: "Coffee", options: ["Great", "Fine", "Bad"] });
  list.push({ id: "parking", section: "About you", type: "text", label: "Where did you park?" });
  const r = await ok(put(U.mia, { questions: list, title: "How was TTFC 2026, really?" }));
  const ids = r.config.questions.map((q) => q.id);
  assert.ok(ids.includes("coffee") && ids.includes("parking") && !ids.includes("food"));
  assert.equal(r.config.questions.find((q) => q.id === "meals").help, "All three days");
  assert.equal(r.config.questions.find((q) => q.id === "coffee").allowNA, true);
  assert.deepEqual(r.config.retired.map((q) => q.id), ["food"]);
  assert.deepEqual(r.changed.sort(), ["questions", "title"]);
  // Refused: a duplicate id, an unknown type, showIf on something that isn't above it.
  const dup = await put(U.mia, { questions: [...list, { id: "meals", type: "rating", label: "Again" }] });
  assert.deepEqual([dup.status, dup.body.field], [400, "questions"]);
  assert.equal((await put(U.mia, { questions: [{ id: "x", type: "slider", label: "X" }] })).status, 400);
  assert.equal((await put(U.mia, { questions: [{ id: "x", type: "rating", label: "X", showIf: { question: "role", includes: "Speaker" } }] })).status, 400);
  assert.equal((await put(U.mia, { opensAt: "tomorrow at 4" })).status, 400);
  assert.equal(await M.AdminAudit.countDocuments({ action: "survey_edit" }), 3);
  // Put "food" back for the rest of the tests (its id brings it out of retired).
  await ok(put(U.mia, { questions: before }));
  const now = await ok(call("GET", "/api/console/survey", { as: U.sam }));
  assert.deepEqual(now.config.retired.map((q) => q.id).sort(), ["coffee", "parking"]);
  assert.equal(now.config.title, "How was TTFC 2026, really?");
});

test("by invitation, for people who checked in: no link, no survey; not checked in, turned away; one response per person", { skip }, async () => {
  await ok(put(U.mia, { opensAt: PAST, closesAt: LATER }));
  const TITLE = "How was TTFC 2026, really?";
  const NOT_ATTENDED = "This survey is for people who attended TTFC 2026.";
  // No link: the title and the window only, even while it's open; answering is refused, whatever email is typed.
  assert.deepEqual(await ok(call("GET", "/api/survey")), { open: true, opensAt: PAST, closesAt: LATER, title: TITLE, invitationOnly: true, questions: [] });
  const anon = await answer({ answers: { checkin: 4, name: "Nora Link", email: "nora@example.com" }, name: "Nora Link", email: "nora@example.com" });
  assert.deepEqual([anon.status, anon.body], [403, { ok: false, code: "link_required", error: "This survey is by invitation. Please use the link we sent you." }]);
  // A changed token is nobody.
  const tZoe = R.signSurveyToken("p", String(A.zoe._id));
  const forged = `${tZoe.slice(0, -2)}${tZoe.endsWith("AA") ? "AB" : "AA"}`;
  const fv = await ok(call("GET", `/api/survey?t=${forged}`));
  assert.deepEqual([fv.questions, fv.respondent, fv.invitationOnly], [[], undefined, true]);
  assert.equal((await answer({ answers: { checkin: 4 }, t: forged })).body.code, "link_required");
  assert.equal(await M.SurveyResponse.countDocuments({}), 0);

  // A valid link for someone who never checked in (Pat: only scanned at the Sunday rehearsal): turned away.
  const tPat = R.signSurveyToken("p", String(A.prac._id));
  assert.deepEqual(await ok(call("GET", `/api/survey?t=${tPat}`)), {
    open: true, opensAt: PAST, closesAt: LATER, title: TITLE, invitationOnly: true, eligible: false, message: NOT_ATTENDED, questions: [],
  });
  const patPost = await answer({ answers: { checkin: 4 } }, { t: tPat });
  assert.deepEqual([patPost.status, patPost.body.code, patPost.body.error], [403, "not_checked_in", NOT_ATTENDED]);
  // Nat is on the app and hasn't checked in: no card, refused. Checked in on Day 2 a moment ago: in at once.
  let nat = await ok(call("GET", "/api/app/survey", { as: U.nat }));
  assert.deepEqual([nat.show, nat.eligible, nat.open], [false, false, true]);
  assert.equal((await answer({ answers: { checkin: 4 } }, { as: U.nat })).body.code, "not_checked_in");
  await M.CheckinMark.create(mark("CON260000006", "2026-10-27", "checked_in"));
  nat = await ok(call("GET", "/api/app/survey", { as: U.nat }));
  assert.deepEqual([nat.show, nat.eligible], [true, true]);
  assert.equal((await ok(call("GET", "/api/survey", { as: U.nat }))).eligible, true);
  await ok(answer({ answers: { checkin: 4 } }, { as: U.nat }), 201);

  // A pass's link (no account), checked in: the survey, prefilled from the pass; checked; one row per its email.
  const zv = await ok(call("GET", `/api/survey?t=${tZoe}`));
  assert.deepEqual([zv.eligible, zv.questions.length, zv.respondent, zv.responded], [true, 32, { name: "Zoe Passonly", email: "zoe@example.com", title: "Founder", company: "Zed Labs" }, false]);
  const badRate = await answer({ answers: { checkin: 7 }, t: tZoe });
  assert.deepEqual([badRate.status, badRate.body.field], [400, "checkin"]);
  const first = await ok(answer({ answers: { checkin: 4, meals: "na", recommend: 9, again: "Probably", role: ["Delegate"], sp_av: 5, consent: true, to_sponsors: "Do it." }, t: tZoe }), 201);
  assert.equal(first.first, true);
  let zoe = await M.SurveyResponse.findOne({ key: "e:zoe@example.com" }).lean();
  assert.deepEqual([zoe.source, zoe.via, String(zoe.attendeeId), zoe.name, zoe.title, zoe.count, zoe.answers.meals, zoe.answers.sp_av, zoe.answers.consent],
    ["link", "pass", String(A.zoe._id), "Zoe Passonly", "Founder", 1, "na", undefined, true]);
  // Answering again: the same row, updated; a question sent blank is cleared.
  const again = await ok(answer({ answers: { checkin: 5, meals: "na", recommend: "", consent: true }, t: tZoe }), 201);
  assert.equal(again.first, false);
  zoe = await M.SurveyResponse.findOne({ key: "e:zoe@example.com" }).lean();
  assert.deepEqual([zoe.count, zoe.answers.checkin, zoe.answers.recommend, zoe.answers.meals], [2, 5, undefined, "na"]);
  assert.equal((await ok(call("GET", `/api/survey?t=${tZoe}`))).responded, true);

  // The app's sign-in: prefilled from the account, source "app"; the email can be left out.
  const ann = await ok(call("GET", "/api/survey", { as: U.ann }));
  assert.deepEqual([ann.eligible, ann.respondent, ann.responded], [true, { name: "Ann Attendee", email: "ann@example.com", title: "CTO", company: "Acme" }, false]);
  assert.equal((await ok(call("GET", "/api/app/survey", { as: U.ann }))).show, true);
  await ok(answer({ answers: { checkin: 3, interactions: 5, food: 2 } }, { as: U.ann }), 201);
  const annRow = await M.SurveyResponse.findOne({ key: `u:${U.ann._id}` }).lean();
  assert.deepEqual([annRow.source, annRow.via, String(annRow.userId), annRow.email, annRow.company, annRow.answers.name], ["app", "auth", String(U.ann._id), "ann@example.com", "Acme", "Ann Attendee"]);
  assert.equal((await ok(call("GET", "/api/app/survey", { as: U.ann }))).show, false);
  assert.equal((await ok(call("GET", "/api/survey", { as: U.ann }))).responded, true);

  // A personal link for an account (the app prompt's / the email's / staff's): the same person as their sign-in.
  // Ben checked in with his Speaker Pass and his Power Pass: one person.
  const tBen = R.signSurveyToken("u", String(U.ben._id));
  assert.equal((await ok(call("GET", `/api/survey?t=${tBen}`))).respondent.name, "Ben Speaker");
  await ok(answer({ answers: { role: ["Speaker"], sp_av: 2, sp_again: "na", checkin: "na" }, t: tBen }), 201);
  const benRow = await M.SurveyResponse.findOne({ key: `u:${U.ben._id}` }).lean();
  assert.deepEqual([benRow.source, benRow.via, benRow.answers.sp_av, benRow.answers.sp_again, benRow.answers.checkin], ["app", "token", 2, "na", "na"]);
  // Rae, a pass, checked in on Day 1.
  await ok(answer({ answers: { checkin: 4 }, t: R.signSurveyToken("p", String(A.rae._id)) }), 201);

  // The admin panel: counts, averages without N/A, N/A on its own, the list.
  const adm = await ok(call("GET", "/api/console/survey", { as: U.sam }));
  assert.deepEqual(adm.counts, { responses: 5, app: 3, link: 2 });
  assert.equal(adm.averages.checkin, 4);   // Nat 4, Zoe 5, Ann 3, Rae 4 (Ben's N/A left out)
  assert.deepEqual([adm.na.checkin, adm.na.sp_again, adm.na.meals], [1, 1, 1]);
  assert.equal(adm.averages.sp_av, 2);
  const list = await ok(call("GET", "/api/console/survey/responses?page=0", { as: U.sam }));
  assert.deepEqual([list.total, list.size, list.rows.length, list.questions.length], [5, 50, 5, 32]);
  assert.deepEqual(Object.keys(list.rows[0]).sort(), ["answers", "at", "company", "count", "email", "firstAt", "id", "name", "source", "title", "userId"].sort());
});

test("deleted questions keep their answers: in the stored responses and the CSV, marked (removed)", { skip }, async () => {
  const cfg = await ok(call("GET", "/api/console/survey", { as: U.mia }));
  // Ann answered "food"; delete it.
  await ok(put(U.mia, { questions: cfg.config.questions.filter((q) => q.id !== "food") }));
  // Ann answers again: her "food" answer stays (it isn't a question any more).
  await ok(answer({ answers: { checkin: 4 } }, { as: U.ann }), 201);
  const annRow = await M.SurveyResponse.findOne({ key: `u:${U.ann._id}` }).lean();
  assert.deepEqual([annRow.answers.food, annRow.answers.checkin, annRow.count], [2, 4, 2]);
  const csv = await call("GET", "/api/console/survey/export", { as: U.sam, raw: true });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  const head = csv.body.replace(/^﻿/, "").split("\n")[0];
  assert.match(head, /,Food quality \(removed\)$/);
  assert.ok(head.includes(",Check-in and registration,"));
  assert.match(csv.body, /N\/A/);
  assert.equal(await M.AdminAudit.countDocuments({ action: "survey_export" }), 1);
  await ok(put(U.mia, { questions: cfg.config.questions }));   // and back
});

test("the app prompt: nothing until autoNotify is on; then the job sends it once; management's Send never twice", { skip }, async () => {
  pushes.length = 0;
  await M.AppNotification.deleteMany({});
  // Open, autoNotify off: the job sends nothing.
  assert.equal(await S.runSurveyNotify({ now: new Date(), held: true }), null);
  assert.equal(await M.AppNotification.countDocuments({}), 0);
  // Staff can't send; management must confirm.
  assert.equal((await call("POST", "/api/console/survey/notify", { as: U.sam, body: { confirm: "SEND" } })).status, 403);
  assert.equal((await call("POST", "/api/console/survey/notify", { as: U.mia, body: {} })).status, 400);
  // Management turns autoNotify on: the next run sends it (to Cal, who checked in, is on the app and hasn't answered;
  // not Ann, Ben or Nat, who answered, Hal, hidden, Ola, who never checked in, Bea, suspended, or Wes, never on the app).
  await ok(put(U.mia, { autoNotify: true }));
  const out = await S.runSurveyNotify({ now: new Date(), held: true });
  assert.deepEqual([out.sent, out.answered, out.hidden, out.notCheckedIn], [1, 3, 1, 1]);
  const notes = await M.AppNotification.find({ batchId: "survey-2026" }).lean();
  assert.deepEqual(notes.map((n) => String(n.userId)), [String(U.cal._id)]);
  assert.deepEqual([notes[0].kind, notes[0].title, notes[0].body], ["personal", "How was TTFC 2026?", "Two minutes: check-in, meals, the people you met, and what we can do better."]);
  assert.deepEqual(R.verifySurveyToken(new URL(notes[0].link).searchParams.get("t")), { kind: "u", id: String(U.cal._id) });
  await pause(100);
  // Cal switched Announcements off: in the inbox, no push.
  assert.deepEqual(pushes, []);
  const cfg = await ok(call("GET", "/api/console/survey", { as: U.sam }));
  assert.ok(cfg.config.notifiedAt);
  assert.equal(cfg.config.notifiedCount, 1);
  // Once: later runs send nothing.
  assert.equal(await S.runSurveyNotify({ now: new Date(Date.now() + 60_000), held: true }), null);
  // A new person on the app who checked in: management's Send reaches them (with a push), and never Cal again; Ola
  // still hasn't checked in.
  const dee = await M.User.create({ name: "Dee Late", email: "dee@example.com", tickets: [{ ticketId: "CON260000020", type: "connect" }], appOnboarded: true, lastActiveAt: new Date() });
  await M.CheckinMark.create(mark("CON260000020", "2026-10-27", "arrived"));
  forgetPeople();
  const sent = await ok(call("POST", "/api/console/survey/notify", { as: U.mia, body: { confirm: "SEND" } }));
  assert.deepEqual([sent.sent, sent.already, sent.notCheckedIn], [1, 1, 1]);
  await pause(100);
  assert.deepEqual(pushes.map((p) => [p.to, p.note.title, p.note.kind, p.note.url]), [[[String(dee._id)], "How was TTFC 2026?", "personal", "/app/notifications"]]);
  assert.equal((await ok(call("POST", "/api/console/survey/notify", { as: U.mia, body: { confirm: "SEND" } }))).sent, 0);
  assert.equal(await M.AppNotification.countDocuments({ batchId: "survey-2026" }), 2);
  assert.equal(await M.AdminAudit.countDocuments({ action: "survey_notify" }), 2);
  await ok(put(U.mia, { autoNotify: false }));
  await M.User.deleteOne({ _id: dee._id });
  forgetPeople();
});

test("the email to people checked in: the audience from the desk's marks, a preview sends nothing, each address once", { skip }, async () => {
  batches.length = 0;
  const pv = await ok(call("GET", "/api/console/survey/email?audience=day1", { as: U.sam }));
  // Day 1 door check-ins: Ann (answered), Ben (two passes, answered), Zoe (answered), Uma (unsubscribed), Rae
  // (answered), Wes (an account never on the app). Not Cal, Nat or Dan (Day 2) or Pat (a rehearsal).
  assert.deepEqual(pv.counts, { checkedIn: 6, toSend: 1, unsubscribed: 1, alreadySent: 0, responded: 4, noEmail: 0, noLink: 0 });
  assert.deepEqual([pv.count, pv.sample], [1, ["Wes Website"]]);
  assert.equal(pv.subject, "How was TTFC 2026? Two minutes, please");
  assert.match(pv.html, />Share your feedback</);
  assert.equal(batches.length, 0);   // a preview sends nothing
  assert.equal((await call("GET", "/api/console/survey/email?audience=tuesday", { as: U.sam })).status, 400);
  const both = await ok(call("GET", "/api/console/survey/email?audience=both", { as: U.sam }));
  assert.deepEqual([both.count, both.sample.sort()], [3, ["Cal Quiet", "Dan Daytwo", "Wes Website"]]);   // Nat answered
  // Staff can't send; management must confirm.
  assert.equal((await call("POST", "/api/console/survey/email", { as: U.sam, body: { audience: "day1", confirm: "SEND" } })).status, 403);
  assert.equal((await call("POST", "/api/console/survey/email", { as: U.mia, body: { audience: "day1" } })).status, 400);
  const out = await ok(call("POST", "/api/console/survey/email", { as: U.mia, body: { audience: "both", confirm: "SEND" } }));
  assert.deepEqual([out.sent, out.failed], [3, 0]);
  assert.equal(batches.length, 1);
  const byTo = Object.fromEntries(batches[0].map((m) => [m.to[0], m]));
  assert.deepEqual(Object.keys(byTo).sort(), ["cal@example.com", "dan@example.com", "wes@example.com"]);
  const wes = byTo["wes@example.com"];
  assert.deepEqual([wes.from, wes.reply_to, wes.subject], ["The Tech Festival Canada <enquire@thetechfestival.com>", "enquire@thetechfestival.com", "How was TTFC 2026? Two minutes, please"]);
  assert.match(wes.html, /Hi Wes,/);
  assert.match(wes.headers["List-Unsubscribe"], /\/api\/unsubscribe\?t=/);
  // Each link names its person: Wes's account, Dan's pass.
  const tOf = (m) => new URL(/href="(https:\/\/www\.thetechfestival\.com\/survey\?t=[^"]+)"/.exec(m.html)[1].replace(/&amp;/g, "&")).searchParams.get("t");
  assert.deepEqual(R.verifySurveyToken(tOf(wes)), { kind: "u", id: String(U.web._id) });
  assert.deepEqual(R.verifySurveyToken(tOf(byTo["dan@example.com"])), { kind: "p", id: String(A.day2._id) });
  assert.equal(await M.CampaignSend.countDocuments({ campaign: "survey-2026", status: "sent" }), 3);
  // A second click emails nobody twice.
  const again = await ok(call("POST", "/api/console/survey/email", { as: U.mia, body: { audience: "day1", confirm: "SEND" } }));
  assert.deepEqual([again.sent, again.counts.alreadySent], [0, 1]);
  assert.equal(batches.length, 1);
  assert.equal(await M.AdminAudit.countDocuments({ action: "survey_email" }), 2);
  // Dan's link prefills his pass.
  assert.equal((await ok(call("GET", `/api/survey?t=${tOf(byTo["dan@example.com"])}`))).respondent.name, "Dan Daytwo");
});

test("personal links for one-on-one sharing: management only, an account's or a pass's, a warning for people not checked in", { skip }, async () => {
  const tOfUrl = (u) => new URL(u).searchParams.get("t");
  assert.equal((await call("GET", "/api/console/survey/link?email=ann@example.com", { as: U.sam })).status, 403);
  const ann = await ok(call("GET", "/api/console/survey/link?email=Ann@Example.com", { as: U.mia }));
  assert.deepEqual([ann.email, ann.name, ann.kind, ann.checkedIn, ann.warning], ["ann@example.com", "Ann Attendee", "account", true, undefined]);
  assert.deepEqual(R.verifySurveyToken(tOfUrl(ann.url)), { kind: "u", id: String(U.ann._id) });
  assert.match(ann.url, /^https:\/\/www\.thetechfestival\.com\/survey\?t=/);
  // The link works: Ann's survey, prefilled.
  assert.equal((await ok(call("GET", `/api/survey?t=${tOfUrl(ann.url)}`))).respondent.name, "Ann Attendee");
  // A pass with no account, never checked in (Pat): the link, and a warning.
  const pat = await ok(call("GET", "/api/console/survey/link?email=pat@example.com", { as: U.mia }));
  assert.deepEqual([pat.name, pat.kind, pat.checkedIn, pat.warning], ["Pat Practice", "pass", false, "Hasn't checked in — the survey will refuse them."]);
  assert.deepEqual(R.verifySurveyToken(tOfUrl(pat.url)), { kind: "p", id: String(A.prac._id) });
  // By People id.
  const zoe = await ok(call("GET", `/api/console/survey/link?person=a-${A.zoe._id}`, { as: U.mia }));
  assert.deepEqual([zoe.email, zoe.name, zoe.kind, zoe.checkedIn], ["zoe@example.com", "Zoe Passonly", "pass", true]);
  // Nobody: 404.
  assert.equal((await call("GET", "/api/console/survey/link?email=nobody@example.com", { as: U.mia })).status, 404);
  assert.equal((await call("GET", "/api/console/survey/link?person=a-000000000000000000000000", { as: U.mia })).status, 404);
  // A list, in the order asked.
  const many = await ok(call("POST", "/api/console/survey/links", { as: U.mia, body: { emails: ["ola@example.com", "nobody@example.com", "dan@example.com", "not an email"] } }));
  assert.deepEqual(many.map((r) => [r.email, r.name || "", r.kind || "", r.checkedIn ?? null, !!r.warning, !!r.error]), [
    ["ola@example.com", "Ola Offsite", "account", false, true, false],
    ["nobody@example.com", "", "", null, false, true],
    ["dan@example.com", "Dan Daytwo", "pass", true, false, false],
    ["not an email", "", "", null, false, true],
  ]);
  assert.equal((await call("POST", "/api/console/survey/links", { as: U.mia, body: { emails: Array.from({ length: 501 }, (_, i) => `p${i}@example.com`) } })).status, 400);
  assert.equal((await call("POST", "/api/console/survey/links", { as: U.sam, body: { emails: ["ann@example.com"] } })).status, 403);
  assert.deepEqual([await M.AdminAudit.countDocuments({ action: "survey_link" }), await M.AdminAudit.countDocuments({ action: "survey_links" })], [5, 1]);
});

test("closed again: no answers, no prompt, no email", { skip }, async () => {
  await ok(put(U.mia, { opensAt: FUTURE, closesAt: LATER }));
  const a = await answer({ answers: { checkin: 4 } }, { as: U.ann });
  assert.deepEqual([a.status, a.body.code], [403, "closed"]);
  for (const [url, body] of [["/api/console/survey/notify", { confirm: "SEND" }], ["/api/console/survey/email", { audience: "both", confirm: "SEND" }]]) {
    const r = await call("POST", url, { as: U.mia, body });
    assert.deepEqual([r.status, r.body.code], [403, "closed"], url);
  }
  await ok(put(U.mia, { enabled: false, opensAt: PAST }));
  assert.equal((await ok(call("GET", "/api/survey"))).open, false);
});
