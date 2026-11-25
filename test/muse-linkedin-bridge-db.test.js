/* The free Muse bridge for LinkedIn profile posts, through the real routes against a real (throwaway)
   MongoDB: the panel queues a round instead of calling Claude (no Anthropic key, the bridge on), Muse
   reads who is waiting, delivers drafts, and the server re-checks everything (sources opened through a
   stubbed safe fetcher, same story as a colleague dropped, the owner's own removed drafts honoured),
   finishing the round at $0 with the Social posts monthly limit untouched. The stale window is a day for
   Muse rounds and stays 15 minutes for Anthropic ones. The bridge gate (off → 404, wrong key → 401) and
   its rate limit (429) are exercised too. Starts a local mongod in a temp folder on a free port and stops
   it after; skipped when the binary isn't there (TTFC_TEST_MONGOD, else
   ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Fictional people, example.com addresses. */
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
process.env.LINKEDIN_CLIENT_ID = "test-client";
process.env.LINKEDIN_CLIENT_SECRET = "test-secret";
process.env.LINKEDIN_REDIRECT_URI = "https://api.example.test/api/auth/linkedin/callback";
process.env.FRONTEND_URL = "https://www.thetechfestival.com";
delete process.env.ANTHROPIC_API_KEY;
process.env.MUSE_BRIDGE_ENABLED = "true";
process.env.MUSE_BRIDGE_KEY = "test-bridge-key";

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  throw new Error(`blocked in the test: ${url}`);
};

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port) => new Promise((ok) => { const c = net.connect(port, "127.0.0.1", () => { c.end(); ok(true); }); c.on("error", () => ok(false)); });

let mongod = null, dbDir = "", server = null, base = "", jwt, mongoose, lip, bridge;
const M = {};
const U = {};
let clock = new Date("2026-11-23T15:00:00Z");
const backgroundCalls = [];

/* The safe fetcher, stubbed: only these pages "load". */
const LOADABLE = new Set([
  "https://www.canada.ca/en/innovation/news/2026/11/quantum.html",
  "https://ised-isde.canada.ca/site/ai-compute/en",
  "https://www.canada.ca/en/news/old.html",
  "https://www.reuters.com/world/americas/canada-eu-digital-trade-2026-11-15/",
]);
const COLLEAGUE_BODY = "Canada's new sovereign AI compute fund puts two billion dollars into data centres across the country this year, and it changes who can train models here.";
const REMOVED_BODY = "British Columbia's ports are moving record volumes of Canadian energy this quarter, and the terminals are hiring across the coast.";

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-muse-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await pause(250);
  await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_muse_bridge_test`);
  ({ default: jwt } = await import("jsonwebtoken"));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.EventConfig = await imp("../models/EventConfig.js");
  M.AdminSetting = await imp("../models/AdminSetting.js");
  M.AdminAudit = (await import("../models/Admin.js")).AdminAudit;
  M.Draft = await imp("../models/LinkedinProfileDraft.js");
  M.Profile = await imp("../models/LinkedinProfile.js");
  await M.Profile.init();   // the unique userId index the one-round-at-a-time claim relies on
  lip = await import("../routes/linkedinProfilePosts.js");
  lip.lipDeps.claude = () => null;                       // no Anthropic key anywhere in this file
  lip.lipDeps.now = () => clock;
  lip.lipDeps.background = (fn) => { backgroundCalls.push(fn); };
  bridge = await import("../routes/museLinkedinBridge.js");
  bridge.museDeps.now = () => clock;
  bridge.museDeps.fetchPage = async (url) => {
    if (LOADABLE.has(url)) return { status: 200, contentType: "text/html", body: Buffer.from("<html>ok</html>") };
    throw new Error("didn't load");
  };
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/console/linkedin-posts", lip.consoleRouter);
  app.use("/api/muse/linkedin-posts", bridge.default);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const mk = (key, doc) => M.User.create(doc).then((u) => { U[key] = u; });
  await Promise.all([
    mk("sam", { name: "Sam Rivera", email: "sam.rivera@example.com", role: "admin", staffRole: "management", jobTitle: "Managing Director" }),
    mk("kim", { name: "Kim Osei", email: "kim.osei@example.com", role: "admin", staffRole: "management" }),
  ]);
  await M.EventConfig.create([
    { eventKey: "tor-2026", name: "TTFC 2026", city: "Toronto", type: "main-event", startDate: new Date("2026-10-26"), endDate: new Date("2026-10-27") },
    { eventKey: "van-2027", name: "Vancouver Briefing", city: "Vancouver", type: "briefing", startDate: new Date("2027-02-03") },
    { eventKey: "tor-2027", name: "TTFC 2027", city: "Toronto", type: "main-event", startDate: new Date("2027-10-20") },
  ]);
  // Kim already wrote about the AI compute fund; Sam removed a ports post of his own.
  await M.Draft.create({ userId: U.kim._id, headline: "AI compute fund", body: COLLEAGUE_BODY, text: COLLEAGUE_BODY, generatedText: COLLEAGUE_BODY,
                         sources: [{ url: "https://ised-isde.canada.ca/site/ai-compute/en", title: "AI Compute Access Fund", supports: "x" }], createdAt: new Date("2026-11-20T12:00:00Z") });
  await M.Draft.create({ userId: U.sam._id, headline: "Ports record", body: REMOVED_BODY, text: REMOVED_BODY, generatedText: REMOVED_BODY, status: "dismissed",
                         sources: [{ url: "https://www.canada.ca/en/news/old.html", title: "Ports", supports: "x" }], createdAt: new Date("2026-11-21T12:00:00Z") });
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const tokenFor = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function call(method, url, { as, body, headers = {} } = {}) {
  const r = await realFetch(base + url, {
    method, redirect: "manual",
    headers: { "content-type": "application/json", ...(as ? { authorization: `Bearer ${tokenFor(as)}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const ok = async (p, want = 200) => { const r = await p; assert.equal(r.status, want, JSON.stringify(r.body)); return r.body; };
const API = "/api/console/linkedin-posts";
const BRIDGE = "/api/muse/linkedin-posts";
const KEY = { "x-muse-bridge-key": "test-bridge-key" };

test("the gate: off answers 404, no key or a wrong key answers 401, the right key answers", { skip }, async () => {
  process.env.MUSE_BRIDGE_ENABLED = "false";
  assert.equal((await call("GET", `${BRIDGE}/pending`, { headers: KEY })).status, 404);
  process.env.MUSE_BRIDGE_ENABLED = "true";
  assert.equal((await call("GET", `${BRIDGE}/pending`)).status, 401);
  assert.equal((await call("GET", `${BRIDGE}/pending`, { headers: { "x-muse-bridge-key": "wrong-key-wrong" } })).status, 401);
  const r = await ok(call("GET", `${BRIDGE}/pending`, { headers: KEY }));
  assert.deepEqual(r.pending, []);
});

test("the panel: with no Anthropic key the bridge makes writing available, via Muse", { skip }, async () => {
  const me = await ok(call("GET", `${API}/me`, { as: U.sam }));
  assert.equal(me.writing, true);
  assert.equal(me.writingVia, "muse");
  assert.deepEqual(me.rounds, { used: 0, max: 6, left: 6 });
});

test("Write queues a Muse round (202, via muse) and never calls Claude; a second Write is refused while it waits", { skip }, async () => {
  const started = await ok(call("POST", `${API}/write`, { as: U.sam }), 202);
  assert.equal(started.run.state, "working");
  assert.equal(started.run.via, "muse");
  assert.equal(started.rounds.used, 1);
  assert.equal(backgroundCalls.length, 0);   // runRound (the Anthropic path) was never started
  const busy = await call("POST", `${API}/write`, { as: U.sam });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.code, "working");
});

test("who is waiting: Sam, with his settings, the events, his removed draft and Kim's recent drafts", { skip }, async () => {
  const r = await ok(call("GET", `${BRIDGE}/pending`, { headers: KEY }));
  assert.equal(r.pending.length, 1);
  const p = r.pending[0];
  assert.equal(p.userId, String(U.sam._id));
  assert.equal(p.settings.displayName, "Sam Rivera");
  assert.equal(p.settings.voice, "warm");
  assert.equal(p.events.next.key, "van-2027");
  assert.deepEqual(p.dismissed, [{ headline: "Ports record", primarySource: "https://www.canada.ca/en/news/old.html" }]);
  assert.deepEqual(p.others, [{ headline: "AI compute fund", topic: "", primarySource: "https://ised-isde.canada.ca/site/ai-compute/en" }]);
});

test("a delivery: the good draft lands composed and dash-free; every rule drops what it should; the round ends free", { skip }, async () => {
  const goodBody = "Ottawa just put new money behind quantum — and the timing matters. Canadian labs have led on research for years; this funding is about keeping the companies here.";
  const r = await ok(call("POST", `${BRIDGE}/pending/${U.sam._id}/drafts`, { headers: KEY, body: {
    drafts: [
      { headline: "Quantum funding", topic: "pillars", eventKey: "van-2027", body: goodBody, hashtags: ["Quantum", "#Canada"],
        sources: [{ url: "https://www.canada.ca/en/innovation/news/2026/11/quantum.html", title: "Canada backs quantum", supports: "the funding" }],
        check: { verdict: "passed", notes: "Checked against the source." } },
      { headline: "Http source", topic: "pillars", eventKey: "", body: "A short post about a story whose only link is not https at all.",
        sources: [{ url: "http://www.canada.ca/en/innovation/news/2026/11/quantum.html", title: "Canada backs quantum", supports: "x" }], check: { verdict: "passed", notes: "" } },
      { headline: "Kim's story", topic: "impact", eventKey: "", body: "A completely different take on funding for machines that learn, written in other words entirely for another audience.",
        sources: [{ url: "https://ised-isde.canada.ca/site/ai-compute/en", title: "AI Compute Access Fund", supports: "x" }], check: { verdict: "passed", notes: "" } },
      { headline: "Near Kim's post", topic: "pillars", eventKey: "", body: `${COLLEAGUE_BODY} More soon.`,
        sources: [{ url: "https://www.reuters.com/world/americas/canada-eu-digital-trade-2026-11-15/", title: "Reuters", supports: "x" }], check: { verdict: "passed", notes: "" } },
      { headline: "Near my removed post", topic: "sectors", eventKey: "", body: `${REMOVED_BODY} Again.`,
        sources: [{ url: "https://www.reuters.com/world/americas/canada-eu-digital-trade-2026-11-15/", title: "Reuters", supports: "x" }], check: { verdict: "passed", notes: "" } },
      { headline: "My removed story", topic: "sectors", eventKey: "", body: "Something new about trade winds and harbour cranes and the people who run them through the winter months ahead.",
        sources: [{ url: "https://www.canada.ca/en/news/old.html", title: "Ports", supports: "x" }], check: { verdict: "passed", notes: "" } },
    ],
    dropped: [{ headline: "A draft Muse left out", why: "couldn't be sourced" }],
  } }));
  assert.equal(r.made, 1);
  assert.deepEqual(r.dropped.map((d) => d.why), [
    "couldn't be sourced",
    "no source could be opened",
    "same story as a colleague's recent post",
    "too close to a post you removed",
    "same story as a post you removed",
    "too close to another post",
  ]);

  const me = await ok(call("GET", `${API}/me`, { as: U.sam }));
  assert.equal(me.run.state, "done");
  assert.equal(me.run.made, 1);
  assert.equal(me.drafts.length, 1);
  const d = me.drafts[0];
  assert.equal(d.headline, "Quantum funding");
  assert.equal(d.hasDash, false);
  assert.match(d.text, /^Ottawa just put new money behind quantum, and the timing matters\./);
  assert.match(d.text, /Sources:\nCanada backs quantum: https:\/\/www\.canada\.ca\/en\/innovation\/news\/2026\/11\/quantum\.html/);
  assert.match(d.text, /#Quantum #Canada$/);
  assert.deepEqual(d.event, { key: "van-2027", name: "Vancouver Briefing", city: "Vancouver", when: "February 3, 2027" });

  const profile = await M.Profile.findOne({ userId: U.sam._id }).lean();
  assert.equal(profile.run.costUsd, 0);   // free: no spend recorded
  assert.equal(await M.AdminSetting.findOne({ key: "social.usage.2026-11" }).lean(), null);   // the monthly writing limit was never touched
  const audit = await M.AdminAudit.findOne({ action: "linkedin_profile_muse_import" }).lean();
  assert.equal(audit.adminName, "Muse (Orion)");

  // Nothing is waiting any more: a second delivery is refused.
  assert.equal((await call("POST", `${BRIDGE}/pending/${U.sam._id}/drafts`, { headers: KEY, body: { drafts: [] } })).status, 409);
});

test("the stale window: a Muse round is still working after 1 and 12 hours, stale after about a day; an Anthropic round is stale after 15 minutes", { skip }, async () => {
  const t0 = clock;
  await ok(call("POST", `${API}/write`, { as: U.sam }), 202);
  clock = new Date(t0.getTime() + 60 * 60 * 1000);
  assert.equal((await ok(call("GET", `${API}/me`, { as: U.sam }))).run.state, "working");
  assert.equal((await call("POST", `${API}/write`, { as: U.sam })).status, 409);   // no second round over it
  clock = new Date(t0.getTime() + 12 * 60 * 60 * 1000);
  assert.equal((await ok(call("GET", `${API}/me`, { as: U.sam }))).run.state, "working");
  clock = new Date(t0.getTime() + 25 * 60 * 60 * 1000);
  const stale = await ok(call("GET", `${API}/me`, { as: U.sam }));
  assert.equal(stale.run.state, "failed");
  assert.match(stale.run.error, /took too long/);
  // An Anthropic round keeps the old 15-minute window.
  await M.Profile.updateOne({ userId: U.sam._id }, { $set: { run: { state: "working", startedAt: new Date(clock.getTime() - 16 * 60 * 1000), made: 0, dropped: [], error: "", costUsd: 0, via: "anthropic" } } });
  assert.equal((await ok(call("GET", `${API}/me`, { as: U.sam }))).run.state, "failed");
  await M.Profile.updateOne({ userId: U.sam._id }, { $set: { "run.state": "done" } });
  clock = t0;
});

test("fail: a queued round can be failed with a message the panel shows; failing twice is refused", { skip }, async () => {
  await ok(call("POST", `${API}/write`, { as: U.sam }), 202);
  const r = await ok(call("POST", `${BRIDGE}/pending/${U.sam._id}/fail`, { headers: KEY, body: { error: "No usable sources today." } }));
  assert.equal(r.ok, true);
  const me = await ok(call("GET", `${API}/me`, { as: U.sam }));
  assert.equal(me.run.state, "failed");
  assert.equal(me.run.error, "No usable sources today.");
  assert.equal((await call("POST", `${BRIDGE}/pending/${U.sam._id}/fail`, { headers: KEY, body: { error: "again" } })).status, 409);
});

test("the rate limit: after enough calls the bridge answers 429", { skip }, async () => {
  let saw = 0;
  for (let i = 0; i < 90 && !saw; i++) {
    const r = await call("GET", `${BRIDGE}/pending`, { headers: KEY });
    if (r.status === 429) saw = 429;
  }
  assert.equal(saw, 429);
});
