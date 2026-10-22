/* "What you missed" emails (Oct 22 2026) against a real (throwaway) MongoDB: the minute job's scan and sends with a
   fixed clock (Toronto, October 2026). Off until staff switch it on; 3 hours after the first missed item, and 5 PM;
   a 3-hour one due 4–5 PM waits for 5 PM; quiet hours; what's seen in between isn't sent (and nothing is when it's
   all seen); each item once; never from someone hidden; two runners send once; the unsubscribe link; the daily cap;
   the admin page (switch for management, preview, counts). Emails go to a stub sender (nothing is sent). Starts a
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
delete process.env.DIGEST_DAILY_CAP;

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
let D;       // services/digest.js
let R;       // services/digestRules.js
let E;       // services/digestEmail.js
const M = {};
const U = {};
const s = {};
const sent = [];
const send = async (args) => { sent.push(args); return { id: `re_${sent.length}` }; };
const quiet = { log() {}, warn() {}, error() {} };

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-digest-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await pause(250);
  await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_digest_test`);
  ({ default: jwt } = await import("jsonwebtoken"));
  D = await import("../services/digest.js");
  R = await import("../services/digestRules.js");
  E = await import("../services/digestEmail.js");
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.ActivityEvent = await imp("../models/ActivityEvent.js");
  M.CampaignSend = await imp("../models/CampaignSend.js");
  M.DigestState = await imp("../models/DigestState.js");
  M.GroupSeen = await imp("../models/GroupSeen.js");
  Object.assign(M, await import("../models/Social.js"), await import("../models/Community.js"));
  await Promise.all([M.CampaignSend.init(), M.DigestState.init()]);
  const { default: express } = await import("express");
  const digest = await import("../routes/digest.js");
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use("/api/app/digest", digest.publicRouter);
  app.use("/api/console/digest", digest.default);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const onApp = { appOnboarded: true, lastActiveAt: new Date("2026-10-21T12:00:00Z") };
  const t = (id) => [{ ticketId: id, type: "connect" }];
  const mk = (key, doc) => M.User.create(doc).then((u) => { U[key] = u; });
  await Promise.all([
    mk("mia", { name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management", ...onApp }),
    mk("sam", { name: "Sam Staff", email: "sam.staff@example.com", role: "admin", staffRole: "staff", ...onApp }),
    mk("nicole", { name: "Nicole Louis", email: "nicole.louis@example.com", tickets: t("spk700000001"), ...onApp }),
    mk("gunant", { name: "Gunant Singh", email: "gunant.singh@example.com", tickets: t("con700000001"), ...onApp }),
    mk("ben", { name: "Ben Normal", email: "ben.normal@example.com", tickets: t("con700000002"), ...onApp }),
    mk("cal", { name: "Cal Normal", email: "cal.normal@example.com", tickets: t("con700000003"), ...onApp }),
    mk("dee", { name: "Dee Normal", email: "dee.normal@example.com", tickets: t("con700000004"), ...onApp }),
    mk("hal", { name: "Hal Hidden", email: "hal.hidden@example.com", tickets: t("con700000005"),
      appHidden: { at: new Date("2026-10-20T10:00:00Z"), byName: "Mia", reason: "test" }, ...onApp }),
  ]);
  s.post = await M.SocialPost.create({ authorId: U.nicole._id, authorName: "Nicole Louis", body: "FOUR DAYS TO GO!!!!", status: "approved" });
  s.group = await M.CommunityGroup.create({ name: "AI Keynote chat", ownerId: U.ben._id, ownerName: "Ben Normal", members: [U.nicole._id, U.ben._id, U.cal._id], status: "approved" });
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const T = (d, h, m = 0) => R.torontoAt(2026, 10, d, h, m);
const tokenFor = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function call(method, url, { as, body, form } = {}) {
  const headers = { ...(as ? { authorization: `Bearer ${tokenFor(as)}` } : {}), ...(form ? { "content-type": "application/x-www-form-urlencoded" } : { "content-type": "application/json" }) };
  const r = await realFetch(base + url, { method, headers, body: form || (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
/** A record made at a given moment (the routes would stamp "now"). */
async function at(Model, doc, when) {
  const row = await Model.create(doc);
  await Model.collection.updateOne({ _id: row._id }, { $set: { createdAt: when } });
  return row;
}
const dm = (from, to, body, when) => at(M.SocialMessage, { threadKey: [String(from._id), String(to._id)].sort().join(":"), fromUserId: from._id, toUserId: to._id, body, status: "approved" }, when);
const run = (now, extra = {}) => D.runDigests({ now, send, held: true, gapMs: 0, wait: async () => {}, log: quiet, ...extra });
const sentTo = (u) => sent.filter((x) => x.to === u.email);
const stateOf = (u) => M.DigestState.findById(u._id).lean();

test("off until staff switch it on: nothing is scanned or sent", { skip }, async () => {
  await dm(U.gunant, U.nicole, "Hi Nicole", T(22, 6, 0));
  const r = await run(T(22, 13, 0));
  assert.deepEqual([r.claimed, r.enabled, r.sent], [true, false, 0]);
  assert.equal(await M.DigestState.countDocuments({}), 0);
  assert.equal(sent.length, 0);
  // Admin page: off, nothing today; staff can't switch it on, management can.
  const st = await call("GET", "/api/console/digest", { as: U.sam });
  assert.equal(st.status, 200);
  assert.deepEqual([st.body.enabled, st.body.sentToday, st.body.dailyCap, st.body.canEdit], [false, 0, 4000, false]);
  assert.equal(st.body.rules.maxPerDay, 3);
  assert.equal((await call("PUT", "/api/console/digest", { as: U.sam, body: { enabled: true } })).status, 403);
  assert.equal((await call("PUT", "/api/console/digest", { as: U.mia, body: { enabled: "yes" } })).status, 400);
  const on = await call("PUT", "/api/console/digest", { as: U.mia, body: { enabled: true } });
  assert.deepEqual([on.status, on.body.enabled, on.body.canEdit], [200, true, true]);
  // Switching on doesn't reach back further than 3 hours to start the clock: that 6:00 message alone doesn't make a
  // digest due (it's still unread, so it goes in her next one).
});

test("3 hours after the first missed item: what they still haven't seen, grouped, never from someone hidden", { skip }, async () => {
  await dm(U.gunant, U.nicole, "Are you at the keynote?", T(22, 10, 0));
  await at(M.ActivityEvent, { userId: U.nicole._id, actorId: U.gunant._id, actorName: "Gunant Singh", kind: "comment", section: "feed", refId: s.post._id }, T(22, 10, 5));
  await at(M.ActivityEvent, { userId: U.nicole._id, actorId: U.ben._id, actorName: "Ben Normal", kind: "like", section: "feed", refId: s.post._id }, T(22, 10, 6));
  await at(M.GroupMessage, { groupId: s.group._id, authorId: U.ben._id, authorName: "Ben Normal", body: "Front row?", status: "approved" }, T(22, 10, 10));
  await dm(U.hal, U.nicole, "psst", T(22, 10, 20));   // hidden from the app: never in anyone's email
  let r = await run(T(22, 10, 30));
  assert.equal(r.enabled, true);
  assert.equal(r.sent, 0);
  assert.equal(String((await stateOf(U.nicole)).pendingSince.toISOString()), T(22, 10, 0).toISOString());
  assert.equal((await run(T(22, 12, 59))).sent, 0);
  r = await run(T(22, 13, 0));
  assert.equal(r.sent, 1);
  const [mail] = sentTo(U.nicole);
  assert.equal(mail.firstName, "Nicole");
  assert.deepEqual(mail.items.map((x) => x.kind), ["dm", "comment", "like", "group"]);
  assert.deepEqual([mail.items[0].count, mail.items[0].text], [2, "Are you at the keynote?"]);   // the 6:00 one, still unread, too
  assert.deepEqual(mail.items.map((x) => x.url), [`/app/chat/${U.gunant._id}`, `/app/post/${s.post._id}`, `/app/post/${s.post._id}`, `/app/group/${s.group._id}`]);
  assert.ok(!JSON.stringify(mail.items).includes("psst") && !JSON.stringify(mail.items).includes("Hal"));
  assert.equal(E.digestSubject(mail.items), "Gunant Singh sent you 2 messages + 3 more on TTFC");
  assert.match(mail.unsubscribeUrl, /\/api\/app\/digest\/unsubscribe\?t=[a-f0-9]{24}\.[A-Za-z0-9_-]{22}$/);
  const st = await stateOf(U.nicole);
  assert.equal(st.pendingSince, undefined);
  assert.deepEqual([st.sentDay, st.sentToday, st.lastSentAt.toISOString()], ["2026-10-22", 1, T(22, 13, 0).toISOString()]);
  assert.equal(await M.CampaignSend.countDocuments({ campaign: "digest:2026-10-22T13:00", email: "nicole.louis@example.com", status: "sent" }), 1);
  // Each item once: nothing new → nothing more for her (Cal, in the group chat, gets his own: due 1:10 PM).
  await run(T(22, 13, 20));
  assert.equal(sentTo(U.nicole).length, 1);
  assert.deepEqual(sentTo(U.cal).map((x) => x.items.map((i) => i.kind)), [["group"]]);
});

test("a 3-hour digest due 4–5 PM waits for the 5 PM one; quiet hours wait for 8 AM", { skip }, async () => {
  const n = () => sentTo(U.nicole).length;
  await dm(U.ben, U.nicole, "Lunch?", T(22, 13, 30));
  await run(T(22, 13, 31));
  await run(T(22, 16, 30));                         // would have been 4:30 PM
  assert.equal(n(), 1);
  await run(T(22, 17, 0));
  assert.equal(n(), 2);
  assert.deepEqual(sentTo(U.nicole).at(-1).items.map((x) => x.text), ["Lunch?"]);
  // 7 PM item: 3 h later is 10 PM, in quiet hours → 8 AM.
  await at(M.ActivityEvent, { userId: U.nicole._id, actorId: U.cal._id, actorName: "Cal Normal", kind: "like", section: "feed", refId: s.post._id }, T(22, 19, 0));
  await run(T(22, 19, 1));
  await run(T(22, 22, 0));
  await run(T(23, 7, 59));
  assert.equal(n(), 2);
  await run(T(23, 8, 0));
  assert.equal(n(), 3);
  assert.equal((await stateOf(U.nicole)).sentDay, "2026-10-23");
});

test("seen in between: read, opened, or used the app since → not emailed (and no email when that's everything)", { skip }, async () => {
  const before = sentTo(U.nicole).length;
  const m = await dm(U.gunant, U.nicole, "Did you see the agenda?", T(23, 9, 0));
  await at(M.GroupMessage, { groupId: s.group._id, authorId: U.cal._id, authorName: "Cal Normal", body: "Seats by the door", status: "approved" }, T(23, 9, 5));
  await run(T(23, 9, 10));
  // She reads the chat and opens the group before it's due.
  await M.SocialMessage.updateOne({ _id: m._id }, { $set: { readAt: T(23, 10, 0) } });
  await M.GroupSeen.create({ userId: U.nicole._id, groupId: s.group._id, at: T(23, 10, 0) });
  await run(T(23, 12, 0));
  assert.equal(sentTo(U.nicole).length, before);
  assert.equal((await stateOf(U.nicole)).pendingSince, undefined);
  // Activity she opened the Feed tab for, and anything before she last used the app, count as seen too.
  await at(M.ActivityEvent, { userId: U.nicole._id, actorId: U.ben._id, actorName: "Ben Normal", kind: "comment", section: "feed", refId: s.post._id }, T(23, 12, 30));
  await dm(U.ben, U.nicole, "Ping", T(23, 12, 31));
  await run(T(23, 12, 40));
  await M.User.updateOne({ _id: U.nicole._id }, { $set: { lastActiveAt: T(23, 13, 0) } });
  await run(T(23, 15, 31));
  assert.equal(sentTo(U.nicole).length, before);
});

test("two runners at once send one email per person per slot", { skip }, async () => {
  const before = sentTo(U.cal).length;
  await dm(U.gunant, U.cal, "Hello Cal", T(24, 9, 0));
  await run(T(24, 9, 1));
  const [a, b] = await Promise.all([run(T(24, 12, 0)), run(T(24, 12, 0))]);
  assert.equal(a.sent + b.sent, 1);
  assert.equal(sentTo(U.cal).length, before + 1);
  assert.equal(await M.CampaignSend.countDocuments({ campaign: "digest:2026-10-24T12:00", email: "cal.normal@example.com" }), 1);
});

test("the unsubscribe link: a page with one button (a GET changes nothing), one click switches it off; then nothing is sent", { skip }, async () => {
  const url = new URL(sentTo(U.nicole)[0].unsubscribeUrl);
  const q = url.search;
  const page = await call("GET", `/api/app/digest/unsubscribe${q}`);
  assert.equal(page.status, 200);
  assert.match(page.body, /<form method="post"/);
  assert.notEqual((await M.User.findById(U.nicole._id).lean()).notifyPrefs?.digestEmail, false);
  assert.equal((await call("POST", "/api/app/digest/unsubscribe?t=bad.token")).status, 400);
  const one = await call("POST", `/api/app/digest/unsubscribe${q}`, { form: "List-Unsubscribe=One-Click" });
  assert.deepEqual([one.status, one.body], [200, { ok: true }]);
  assert.equal((await M.User.findById(U.nicole._id).lean()).notifyPrefs.digestEmail, false);
  const before = sentTo(U.nicole).length;
  await dm(U.ben, U.nicole, "Still there?", T(24, 9, 30));
  await run(T(24, 9, 31));
  await run(T(24, 12, 30));
  assert.equal(sentTo(U.nicole).length, before);
});

test("someone on the unsubscribed list (Admin › Unsubscribed emails) gets no digest either", { skip }, async () => {
  const Subscription = (await import("../models/Subscription.js")).default;
  const { recordUnsubscribe } = await import("../services/unsubscribe.js");
  await recordUnsubscribe(Subscription, U.cal.email, { source: "staff", by: "mia.manager@example.com" });
  const before = sentTo(U.cal).length;
  await dm(U.ben, U.cal, "Coffee before the keynote?", T(24, 13, 0));
  assert.ok((await run(T(24, 13, 1))).noted >= 1);
  const r = await run(T(24, 17, 1));
  assert.equal(sentTo(U.cal).length, before);
  assert.ok(r.skipped >= 1, JSON.stringify(r));
  assert.equal((await stateOf(U.cal))?.pendingSince ?? null, null);
});

test("the daily cap stops sending (and says so); the admin page counts today's sends; preview with sample items", { skip }, async () => {
  await dm(U.gunant, U.ben, "Hi Ben", T(25, 9, 0));
  await dm(U.gunant, U.dee, "Hi Dee", T(25, 9, 0));
  await run(T(25, 9, 1));
  process.env.DIGEST_DAILY_CAP = "1";
  try {
    const r = await run(T(25, 12, 0));
    assert.deepEqual([r.sent, r.capped], [1, true]);
  } finally {
    delete process.env.DIGEST_DAILY_CAP;
  }
  const r2 = await run(T(25, 12, 1));
  assert.equal(r2.sent, 1);   // the cap back at 4,000: the other one goes
  const st = await call("GET", "/api/console/digest", { as: U.mia });
  assert.equal(st.body.enabled, true);
  assert.equal(typeof st.body.waiting, "number");
  const pv = await call("POST", "/api/console/digest/preview", { as: U.sam });
  assert.equal(pv.status, 200);
  assert.equal(pv.body.sample, true);
  assert.match(pv.body.subject, / on TTFC$/);
  assert.match(pv.body.html, /What you missed/);
  assert.ok(pv.body.sections.length >= 2);
});
