/* Marketing › LinkedIn posts for my profile (Nov 22 2026), through the real routes against a real (throwaway)
   MongoDB: management only, each person's own settings and drafts, a writing round in the background (Claude with
   web search, then the fact-check with web fetch: both stubbed), invented sources and unconfirmed drafts dropped,
   near copies of a colleague's draft dropped, no em-dashes, the monthly limit and the daily rounds, editing, copy,
   posted by hand, dismiss, and Post to LinkedIn as the person (the one-time hop, the state cookie, the Posts API
   post; LinkedIn stubbed, nothing is posted anywhere). Starts a local mongod in a temp folder on a free port and
   stops it after; skipped when the binary isn't there (TTFC_TEST_MONGOD, else
   ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Fictional people, example.com. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import axios from "axios";

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

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  throw new Error(`blocked in the test: ${url}`);
};

// LinkedIn, stubbed.
const linkedin = [];
axios.post = async (url, body) => {
  linkedin.push({ url, body });
  if (url === "https://www.linkedin.com/oauth/v2/accessToken") return { data: { access_token: "li-test-token" } };
  if (url.endsWith("/rest/posts")) return { headers: { "x-restli-id": "urn:li:share:9001" }, data: {} };
  throw new Error(`blocked in the test: ${url}`);
};
axios.get = async (url) => {
  if (url === "https://api.linkedin.com/v2/userinfo") return { data: { sub: "member7" } };
  throw new Error(`blocked in the test: ${url}`);
};

/* ---------- Claude, stubbed: the writer (web search) and the checker (web fetch) ---------- */
const COLLEAGUE_BODY = "Canada's new sovereign AI compute fund puts two billion dollars into data centres across the country this year, and it changes who can train models here.";
const searchResults = {
  type: "web_search_tool_result", tool_use_id: "s1",
  content: [
    { type: "web_search_result", url: "https://www.canada.ca/en/innovation/news/2026/11/quantum.html", title: "Canada backs quantum", page_age: "November 18, 2026" },
    { type: "web_search_result", url: "https://www.reuters.com/world/americas/canada-eu-digital-trade-2026-11-15/", title: "Canada and EU sign digital trade pact" },
    { type: "web_search_result", url: "https://ised-isde.canada.ca/site/ai-compute/en", title: "AI Compute Access Fund" },
  ],
};
const writerPosts = (n = 0) => ({
  posts: [
    { headline: `Quantum funding ${n}`, topic: "pillars", eventKey: "van-2027", hashtags: ["Quantum", "#Canada"],
      body: "Ottawa just put new money behind quantum — and the timing matters.\n\nCanadian labs have led on research for years; this funding is about keeping the companies here. If you're building in quantum, the Vancouver Briefing is where we're carrying this conversation forward, and we'd welcome you as a speaker or exhibitor.",
      sources: [{ url: "https://canada.ca/en/innovation/news/2026/11/quantum.html", title: "Canada backs quantum", supports: "the funding" }] },
    { headline: "Invented", topic: "impact", eventKey: "", hashtags: [],
      body: "A made-up report says everything changed.", sources: [{ url: "https://totally-invented.example.com/report", title: "Fake", supports: "?" }] },
    { headline: "Copy of a colleague", topic: "pillars", eventKey: "", hashtags: [],
      body: `${COLLEAGUE_BODY} More soon.`, sources: [{ url: "https://ised-isde.canada.ca/site/ai-compute/en", title: "AI Compute Access Fund", supports: "the fund" }] },
    { headline: "EU trade", topic: "geopolitics", eventKey: "tor-2027", hashtags: ["Trade"],
      body: "The Canada and EU digital trade pact is a quiet but real shift for Canadian software companies selling into Europe.\n\nThat is the kind of change we unpack at our main event in Toronto, and sponsors who care about cross-border growth will find the right room there.",
      sources: [{ url: "https://reuters.com/world/americas/canada-eu-digital-trade-2026-11-15", title: "Reuters", supports: "the pact" }] },
  ],
});
const claude = { calls: [], script: [] };
function fakeClient() {
  return {
    beta: { messages: { stream: (params) => {
      claude.calls.push(params);
      const next = claude.script.shift();
      return { finalMessage: async () => (typeof next === "function" ? next(params) : next) };
    } } },
  };
}
const usage = { input_tokens: 20000, output_tokens: 3000, server_tool_use: { web_search_requests: 3 } };
const writerTurns = (n) => [
  // a paused turn first: the route sends it back and the server carries on
  { stop_reason: "pause_turn", usage, content: [{ type: "text", text: "Searching." }, { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "Canada quantum" } }, searchResults] },
  { stop_reason: "end_turn", usage, content: [{ type: "text", text: JSON.stringify(writerPosts(n)) }] },
];
const checkerTurn = (reviews) => ({ stop_reason: "end_turn", usage: { input_tokens: 15000, output_tokens: 1500 }, content: [
  { type: "server_tool_use", id: "f1", name: "web_fetch", input: { url: "https://www.canada.ca/en/innovation/news/2026/11/quantum.html" } },
  { type: "web_fetch_tool_result", tool_use_id: "f1", content: { type: "web_fetch_result", url: "https://www.canada.ca/en/innovation/news/2026/11/quantum.html", content: { title: "Canada backs quantum" } } },
  { type: "text", text: JSON.stringify({ reviews }) },
] });
// After keepSourced: [0] quantum, [1] colleague copy, [2] EU trade (the invented one is gone before the check).
const goodReviews = [
  { index: 0, verdict: "fix", body: "Ottawa just put new money behind quantum — and the timing matters.\n\nCanadian labs have led on research for years. This funding is about keeping the companies here. If you're building in quantum, the Vancouver Briefing is where we carry this forward, and we'd welcome you as a speaker or exhibitor.", confirmed: ["https://www.canada.ca/en/innovation/news/2026/11/quantum.html"], notes: "Tightened one sentence — fine." },
  { index: 1, verdict: "keep", body: "", confirmed: ["https://ised-isde.canada.ca/site/ai-compute/en"], notes: "ok" },
  { index: 2, verdict: "keep", body: "", confirmed: [], notes: "Reuters page wouldn't load" },
];

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port) => new Promise((ok) => { const c = net.connect(port, "127.0.0.1", () => { c.end(); ok(true); }); c.on("error", () => ok(false)); });

let mongod = null, dbDir = "", server = null, base = "", jwt, mongoose, lip;
const M = {};
const U = {};
let pending = null;

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-lip-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await pause(250);
  await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_lip_test`);
  ({ default: jwt } = await import("jsonwebtoken"));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.EventConfig = await imp("../models/EventConfig.js");
  M.AdminSetting = await imp("../models/AdminSetting.js");
  M.Draft = await imp("../models/LinkedinProfileDraft.js");
  M.Profile = await imp("../models/LinkedinProfile.js");
  lip = await import("../routes/linkedinProfilePosts.js");
  lip.lipDeps.claude = () => fakeClient();
  lip.lipDeps.now = () => new Date("2026-11-22T15:00:00Z");
  lip.lipDeps.background = (fn) => { pending = fn(); };
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.get("/api/auth/linkedin/callback", lip.linkedinProfilePostCallback);
  app.get("/api/auth/linkedin/callback", (req, res) => res.status(418).json({ fellThrough: true }));
  app.use("/api/linkedin-posts", lip.publicRouter);
  app.use("/api/console/linkedin-posts", lip.consoleRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const mk = (key, doc) => M.User.create(doc).then((u) => { U[key] = u; });
  await Promise.all([
    mk("sam", { name: "Sam Rivera", email: "sam.rivera@example.com", role: "admin", staffRole: "management", jobTitle: "Managing Director" }),
    mk("kim", { name: "Kim Osei", email: "kim.osei@example.com", role: "admin", staffRole: "management" }),
    mk("pat", { name: "Pat Staff", email: "pat.staff@example.com", role: "admin", staffRole: "staff" }),
    mk("joe", { name: "Joe Attendee", email: "joe.attendee@example.com", role: "user" }),
  ]);
  await M.EventConfig.create([
    { eventKey: "tor-2026", name: "TTFC 2026", city: "Toronto", type: "main-event", startDate: new Date("2026-10-26"), endDate: new Date("2026-10-27") },
    { eventKey: "van-2027", name: "Vancouver Briefing", city: "Vancouver", type: "briefing", startDate: new Date("2027-02-03") },
    { eventKey: "tor-2027", name: "TTFC 2027", city: "Toronto", type: "main-event", startDate: new Date("2027-10-20") },
  ]);
  // Kim (a colleague) already has this draft: Sam's near copy of it must be dropped.
  await M.Draft.create({ userId: U.kim._id, headline: "AI compute fund", body: COLLEAGUE_BODY, text: COLLEAGUE_BODY, generatedText: COLLEAGUE_BODY,
                         sources: [{ url: "https://ised-isde.canada.ca/site/ai-compute/en", title: "AI Compute Access Fund", supports: "x" }], createdAt: new Date("2026-11-20T12:00:00Z") });
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
  return { status: r.status, body: json, headers: r.headers, location: r.headers.get("location") || "" };
}
const ok = async (p, want = 200) => { const r = await p; assert.equal(r.status, want, JSON.stringify(r.body)); return r.body; };
const API = "/api/console/linkedin-posts";
const s = {};

test("management only: staff, attendees and signed-out people are refused", { skip }, async () => {
  assert.equal((await call("GET", `${API}/me`)).status, 401);
  assert.equal((await call("GET", `${API}/me`, { as: U.joe })).status, 403);
  const r = await call("GET", `${API}/me`, { as: U.pat });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "management_only");
});

test("first visit: good defaults from their account, the events, the options, no drafts", { skip }, async () => {
  const me = await ok(call("GET", `${API}/me`, { as: U.sam }));
  assert.equal(me.saved, false);
  assert.equal(me.settings.displayName, "Sam Rivera");
  assert.equal(me.settings.role, "Managing Director");
  assert.equal(me.settings.voice, "warm");
  assert.equal(me.settings.topics.length, 5);
  assert.deepEqual([me.events.recent?.key, me.events.next?.key, me.events.main?.key], ["tor-2026", "van-2027", "tor-2027"]);
  assert.equal(me.options.pillars.length, 5);
  assert.equal(me.options.sectors.length, 5);
  assert.equal(me.drafts.length, 0);
  assert.equal(me.writing, true);
  assert.equal(me.linkedin, true);
  assert.deepEqual(me.rounds, { used: 0, max: 6, left: 6 });
});

test("settings are saved per person and checked", { skip }, async () => {
  assert.equal((await call("PUT", `${API}/settings`, { as: U.sam, body: { topics: [] } })).status, 400);
  const saved = await ok(call("PUT", `${API}/settings`, { as: U.sam, body: {
    displayName: "Sam Rivera", role: "Managing Director, TTFC", voice: "expert", length: "short", topics: ["pillars", "geopolitics", "impact"],
    pillars: ["Quantum Computing"], inviteWho: ["speakers", "exhibitors", "sponsors"], hashtags: 2, count: 4, about: "I run TTFC.", notes: "Keep it human",
  } }));
  assert.equal(saved.settings.voice, "expert");
  const me = await ok(call("GET", `${API}/me`, { as: U.sam }));
  assert.equal(me.saved, true);
  assert.equal(me.settings.role, "Managing Director, TTFC");
  assert.deepEqual(me.settings.pillars, ["Quantum Computing"]);
  const kim = await ok(call("GET", `${API}/me`, { as: U.kim }));
  assert.equal(kim.saved, false);
  assert.equal(kim.settings.voice, "warm");
});

test("no Anthropic key: the panel says so", { skip }, async () => {
  const real = lip.lipDeps.claude;
  lip.lipDeps.claude = () => null;
  try {
    const r = await call("POST", `${API}/write`, { as: U.sam });
    assert.equal(r.status, 503);
    assert.equal(r.body.code, "no_key");
  } finally { lip.lipDeps.claude = real; }
});

test("a writing round: researched, sourced, fact-checked, different from colleagues, no em-dashes", { skip }, async () => {
  claude.calls.length = 0;
  claude.script = [...writerTurns(1), checkerTurn(goodReviews)];
  // Hold this round until the second click has been tried.
  let release;
  const gate = new Promise((r) => { release = r; });
  lip.lipDeps.background = (fn) => { pending = gate.then(fn); };
  const started = await ok(call("POST", `${API}/write`, { as: U.sam }), 202);
  assert.equal(started.run.state, "working");
  assert.equal(started.rounds.used, 1);
  const busy = await call("POST", `${API}/write`, { as: U.sam });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.code, "working");
  lip.lipDeps.background = (fn) => { pending = fn(); };
  release();
  await pending;

  // The writer: web search, structured output, the refusal fallback, the person's prompt; the paused turn resumed.
  const [w1, w2, chk] = claude.calls;
  assert.equal(w1.model, "claude-opus-5-5");
  assert.equal(w1.tools[0].type, "web_search_20260209");
  assert.equal(w1.output_config.format.type, "json_schema");
  assert.equal(w1.fallbacks, "default");
  assert.match(w1.messages[0].content, /Write 4 different LinkedIn posts for Sam Rivera, Managing Director, TTFC/);
  assert.match(w1.messages[0].content, /Colleagues already have posts about these[\s\S]*AI compute fund/);
  assert.match(w1.messages[0].content, /Quantum Computing/);
  assert.equal(w2.messages.length, 2);
  assert.equal(w2.messages[1].role, "assistant");
  // The checker: web fetch, only the sourced drafts (the invented one never got there).
  assert.equal(chk.tools[0].type, "web_fetch_20260209");
  assert.doesNotMatch(chk.messages[0].content, /totally-invented/);
  assert.match(chk.messages[0].content, /Check these 3 drafts/);

  const me = await ok(call("GET", `${API}/me`, { as: U.sam }));
  assert.equal(me.run.state, "done");
  assert.equal(me.run.made, 1);
  assert.deepEqual(me.run.dropped.map((d) => d.why).sort(), ["no real source", "no source confirmed it", "too close to another post"]);
  assert.equal(me.drafts.length, 1);
  const d = me.drafts[0];
  s.id = d.id;
  assert.equal(d.headline, "Quantum funding 1");
  assert.equal(d.check.verdict, "fixed");
  assert.equal(d.check.notes, "Tightened one sentence, fine.");
  assert.equal(d.hasDash, false);
  assert.doesNotMatch(d.text, /[—–]/);
  assert.match(d.text, /^Ottawa just put new money behind quantum, and the timing matters\./);
  assert.match(d.text, /Sources:\nCanada backs quantum: https:\/\/www\.canada\.ca\/en\/innovation\/news\/2026\/11\/quantum\.html/);
  assert.match(d.text, /#Quantum #Canada$/);
  assert.deepEqual(d.event, { key: "van-2027", name: "Vancouver Briefing", city: "Vancouver", when: "February 3, 2027" });
  assert.match(d.shareUrl, /^https:\/\/www\.linkedin\.com\/feed\/\?shareActive=true&text=/);
  // Spend counts toward the Social posts limit (2 writer turns + the check: $0.34 + $0.09, 6 searches included).
  const spent = await M.AdminSetting.findOne({ key: "social.usage.2026-11" }).lean();
  assert.ok(Math.abs(spent.value.costUsd - 0.43) < 0.001, String(spent.value.costUsd));
  // Kim can't see or touch Sam's draft.
  assert.equal((await ok(call("GET", `${API}/me`, { as: U.kim }))).drafts.length, 1);   // only her own
  assert.equal((await call("PATCH", `${API}/drafts/${s.id}`, { as: U.kim, body: { text: "mine now" } })).status, 404);
});

test("a round where nothing passes says so; a refusal or an unreadable answer fails the round, readable", { skip }, async () => {
  claude.script = [...writerTurns(2), checkerTurn([{ index: 0, verdict: "drop", body: "", confirmed: [], notes: "stale" }, { index: 1, verdict: "drop", body: "", confirmed: [], notes: "x" }, { index: 2, verdict: "drop", body: "", confirmed: [], notes: "x" }])];
  await ok(call("POST", `${API}/write`, { as: U.sam }), 202);
  await pending;
  let me = await ok(call("GET", `${API}/me`, { as: U.sam }));
  assert.equal(me.run.state, "done");
  assert.equal(me.run.made, 0);
  assert.match(me.run.error, /Nothing passed the checks/);

  claude.script = [{ stop_reason: "refusal", usage, content: [] }];
  await ok(call("POST", `${API}/write`, { as: U.sam }), 202);
  await pending;
  me = await ok(call("GET", `${API}/me`, { as: U.sam }));
  assert.equal(me.run.state, "failed");
  assert.match(me.run.error, /declined/);

  claude.script = [{ stop_reason: "end_turn", usage, content: [{ type: "text", text: "not json" }] }];
  await ok(call("POST", `${API}/write`, { as: U.sam }), 202);
  await pending;
  me = await ok(call("GET", `${API}/me`, { as: U.sam }));
  assert.equal(me.run.state, "failed");
  assert.match(me.run.error, /couldn't be read/);
  assert.equal(me.drafts.length, 1);
});

test("limits: rounds per day and the monthly writing limit", { skip }, async () => {
  claude.script = [{ stop_reason: "end_turn", usage: {}, content: [{ type: "text", text: "{\"posts\":[]}" }] }];
  await ok(call("POST", `${API}/write`, { as: U.sam }), 202);        // round 5
  await pending;
  claude.script = [{ stop_reason: "end_turn", usage: {}, content: [{ type: "text", text: "{\"posts\":[]}" }] }];
  await ok(call("POST", `${API}/write`, { as: U.sam }), 202);        // round 6
  await pending;
  const r = await call("POST", `${API}/write`, { as: U.sam });
  assert.equal(r.status, 429);
  assert.equal(r.body.code, "daily");
  await M.AdminSetting.create({ key: "social.settings", module: "social", valueType: "json", value: { monthlyBudgetUsd: 0.5 } });
  const b = await call("POST", `${API}/write`, { as: U.kim });
  assert.equal(b.status, 429);
  assert.equal(b.body.code, "budget");
  await M.AdminSetting.deleteOne({ key: "social.settings" });
});

test("edit, put back, copy, posted by hand and back, dismiss", { skip }, async () => {
  const edited = await ok(call("PATCH", `${API}/drafts/${s.id}`, { as: U.sam, body: { text: "My own words — edited." } }));
  assert.equal(edited.draft.text, "My own words — edited.");   // the person's own edits are theirs
  assert.equal(edited.draft.edited, true);
  assert.equal((await call("PATCH", `${API}/drafts/${s.id}`, { as: U.sam, body: { text: "  " } })).status, 400);
  assert.equal((await call("PATCH", `${API}/drafts/${s.id}`, { as: U.sam, body: { text: "x".repeat(3001) } })).status, 400);
  const back = await ok(call("POST", `${API}/drafts/${s.id}/reset`, { as: U.sam }));
  assert.equal(back.draft.edited, false);
  assert.equal((await ok(call("POST", `${API}/drafts/${s.id}/copied`, { as: U.sam }))).draft.status, "copied");
  assert.equal((await call("POST", `${API}/drafts/${s.id}/posted`, { as: U.sam, body: { url: "https://evil.example.com/x" } })).status, 400);
  const posted = await ok(call("POST", `${API}/drafts/${s.id}/posted`, { as: U.sam, body: { url: "https://www.linkedin.com/feed/update/urn:li:share:1/" } }));
  assert.equal(posted.draft.status, "posted");
  assert.equal(posted.draft.postedVia, "by hand");
  assert.equal((await call("POST", `${API}/drafts/${s.id}/dismiss`, { as: U.sam })).status, 409);
  assert.equal((await ok(call("POST", `${API}/drafts/${s.id}/posted`, { as: U.sam, body: { posted: false } }))).draft.status, "copied");
  const extra = await M.Draft.create({ userId: U.sam._id, headline: "Spare", body: "b", text: "b", generatedText: "b" });
  await ok(call("POST", `${API}/drafts/${extra._id}/dismiss`, { as: U.sam }));
  const me = await ok(call("GET", `${API}/me`, { as: U.sam }));
  assert.ok(!me.drafts.some((d) => d.id === String(extra._id)));
  assert.equal((await M.Draft.findById(extra._id).lean()).status, "dismissed");    // kept, so later rounds stay different
});

test("Post to LinkedIn as the person: one-time hop, state cookie, text post, back to the panel", { skip }, async () => {
  const origin = "https://techfest-canada-frontend-abc123-ttfc-projects.vercel.app";
  assert.equal((await call("POST", `${API}/drafts/${s.id}/linkedin`, { as: U.sam, body: { returnTo: "https://evil.example.com" } })).status, 400);
  const start = await ok(call("POST", `${API}/drafts/${s.id}/linkedin`, { as: U.sam, body: { returnTo: `${origin}/admin/linkedin-posts`, text: "Final words for my feed. #AI" } }));
  const go = new URL(start.url);
  assert.equal(go.pathname, "/api/linkedin-posts/go");
  assert.equal((await call("POST", `${API}/drafts/${s.id}/linkedin`, { as: U.kim, body: { returnTo: origin } })).status, 404);

  const hop = await call("GET", `${go.pathname}${go.search}`);
  assert.equal(hop.status, 302);
  const li = new URL(hop.location);
  assert.equal(li.origin + li.pathname, "https://www.linkedin.com/oauth/v2/authorization");
  assert.equal(li.searchParams.get("scope"), "openid profile w_member_social");
  assert.equal(li.searchParams.get("redirect_uri"), process.env.LINKEDIN_REDIRECT_URI);
  const state = li.searchParams.get("state");
  assert.match(state, /^ttfc-lip\.[0-9a-f]{32}$/);
  const cookie = hop.headers.get("set-cookie").split(";")[0];
  assert.equal(cookie, `ttfc_lip_li=${encodeURIComponent(state)}`);
  // The key works once.
  const again = await call("GET", `${go.pathname}${go.search}`);
  assert.match(again.location, /#post_error=expired/);

  // Without the cookie (a link someone else sent them): refused, nothing posted.
  const before = linkedin.length;
  const noCookie = await call("GET", `/api/auth/linkedin/callback?state=${state}&code=abc`);
  assert.match(noCookie.location, new RegExp(`^${origin}/admin/linkedin-posts#post_error=expired`));
  assert.equal(linkedin.length, before);

  // Other states fall through to the next handler.
  assert.equal((await call("GET", "/api/auth/linkedin/callback?state=ttfc-shr.abc&code=x")).status, 418);

  // The real flow.
  const start2 = await ok(call("POST", `${API}/drafts/${s.id}/linkedin`, { as: U.sam, body: { returnTo: origin } }));
  const hop2 = await call("GET", new URL(start2.url).pathname + new URL(start2.url).search);
  const state2 = new URL(hop2.location).searchParams.get("state");
  const cookie2 = hop2.headers.get("set-cookie").split(";")[0];
  const done = await call("GET", `/api/auth/linkedin/callback?state=${state2}&code=abc`, { headers: { cookie: cookie2 } });
  assert.equal(done.status, 302);
  assert.equal(done.location, `${origin}/admin/linkedin-posts#posted=${s.id}&post=${encodeURIComponent("https://www.linkedin.com/feed/update/urn:li:share:9001/")}`);
  const post = linkedin.filter((x) => x.url.endsWith("/rest/posts")).pop();
  assert.equal(post.body.author, "urn:li:person:member7");
  assert.equal(post.body.commentary, "Final words for my feed. {hashtag|\\#|AI}");
  assert.equal(post.body.content, undefined);
  const d = (await ok(call("GET", `${API}/me`, { as: U.sam }))).drafts.find((x) => x.id === s.id);
  assert.equal(d.status, "posted");
  assert.equal(d.postedVia, "linkedin");
  assert.equal(d.postUrl, "https://www.linkedin.com/feed/update/urn:li:share:9001/");
  assert.equal((await call("POST", `${API}/drafts/${s.id}/posted`, { as: U.sam, body: { posted: false } })).status, 409);
  assert.equal((await call("POST", `${API}/drafts/${s.id}/linkedin`, { as: U.sam, body: { returnTo: origin } })).status, 409);
  // The state is single use.
  const replay = await call("GET", `/api/auth/linkedin/callback?state=${state2}&code=abc`, { headers: { cookie: cookie2 } });
  assert.match(replay.location, /post_error=expired/);
});

test("cancelling on LinkedIn comes back with the reason and keeps the draft", { skip }, async () => {
  const draft = await M.Draft.create({ userId: U.kim._id, headline: "K", body: "k", text: "Kim's post", generatedText: "Kim's post" });
  const origin = "http://localhost:5173";
  const start = await ok(call("POST", `${API}/drafts/${draft._id}/linkedin`, { as: U.kim, body: { returnTo: origin } }));
  const u = new URL(start.url);
  const hop = await call("GET", u.pathname + u.search);
  const state = new URL(hop.location).searchParams.get("state");
  const back = await call("GET", `/api/auth/linkedin/callback?state=${state}&error=user_cancelled_authorize`, { headers: { cookie: hop.headers.get("set-cookie").split(";")[0] } });
  assert.equal(back.location, `${origin}/admin/linkedin-posts#post_error=cancelled&d=${draft._id}`);
  assert.equal((await M.Draft.findById(draft._id).lean()).status, "draft");
});
