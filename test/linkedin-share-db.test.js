/* LinkedIn from the apps and its points (Oct 22 2026), through the real routes against a real (throwaway) MongoDB:
   the app's "I'm attending" link (signed for this person), the "Post to LinkedIn" there counting for their account;
   sharing a session poll or discussion (the draft on the website's /share/linkedin page, editing it, LinkedIn sign-in
   with the state cookie, the Posts API post with the session as a link card and the TTFC page tagged); points only for
   posts LinkedIn confirmed, once per item, up to 5. LinkedIn is stubbed (axios): nothing is posted anywhere. Starts a
   local mongod in a temp folder on a free port and stops it after; skipped when the binary isn't there
   (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Fictional people, example.com. */
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
delete process.env.STRIPE_SECRET_KEY;

const SESSIONS = [{ _id: "sess-ai", sessionId: "d1-5", title: "The AI Agenda" }, { _id: "sess-cyber", sessionId: "d1-7", title: "Cyber Risk 2027" }];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.includes(".sanity.io/")) return new Response(JSON.stringify({ result: url.includes("session") ? SESSIONS : [] }), { status: 200, headers: { "content-type": "application/json" } });
  throw new Error(`blocked in the test: ${url}`);
};

// LinkedIn, stubbed: what we'd send it is kept here.
const linkedin = [];
axios.post = async (url, body) => {
  linkedin.push({ url, body });
  if (url === "https://www.linkedin.com/oauth/v2/accessToken") return { data: { access_token: "li-test-token" } };
  if (url.includes("/rest/images?action=initializeUpload")) return { data: { value: { uploadUrl: "https://upload.example.test/img", image: "urn:li:image:1" } } };
  if (url.endsWith("/rest/posts")) return { headers: { "x-restli-id": `urn:li:share:${8000 + linkedin.length}` }, data: {} };
  throw new Error(`blocked in the test: ${url}`);
};
axios.get = async (url) => {
  if (url === "https://api.linkedin.com/v2/userinfo") return { data: { sub: "member1", given_name: "Nicole", family_name: "Louis" } };
  throw new Error(`blocked in the test: ${url}`);
};
axios.put = async () => ({ status: 201, data: {} });

const PNG = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 7)]).toString("base64")}`;
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port) => new Promise((ok) => { const c = net.connect(port, "127.0.0.1", () => { c.end(); ok(true); }); c.on("error", () => ok(false)); });

let mongod = null;
let dbDir = "";
let server = null;
let base = "";
let jwt;
let mongoose;
let verifyTrack;
const M = {};
const U = {};
const s = {};

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-linkedin-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await pause(250);
  await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_linkedin_test`);
  ({ default: jwt } = await import("jsonwebtoken"));
  ({ verifyTrack } = await import("../services/trackToken.js"));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.LinkedinShare = await imp("../models/LinkedinShare.js");
  M.LinkedinShareDraft = await imp("../models/LinkedinShareDraft.js");
  Object.assign(M, await import("../models/Social.js"), await import("../models/Community.js"));
  const { default: express } = await import("express");
  const attending = await import("../routes/attending.js");
  const share = await import("../routes/linkedinShare.js");
  const app = express();
  app.post("/api/attending/post", express.json({ limit: "9mb" }), attending.attendingPostDraft);
  app.use(express.json());
  app.get("/api/auth/linkedin/callback", attending.attendingLinkedinCallback);
  app.get("/api/auth/linkedin/callback", share.linkedinShareCallback);
  app.use("/api/attending", attending.default);
  app.use("/api/app", share.appRouter);
  app.use("/api/linkedin-share", share.publicRouter);
  app.use("/api/social", await imp("../routes/social.js"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const onApp = { appOnboarded: true, lastActiveAt: new Date("2026-10-21T12:00:00Z") };
  const mk = (key, doc) => M.User.create(doc).then((u) => { U[key] = u; });
  await Promise.all([
    mk("nicole", { name: "Nicole Louis", email: "nicole.louis@example.com", jobTitle: "CMO", organization: "Louis & Co", tickets: [{ ticketId: "spk800000001", type: "speaker" }], ...onApp }),
    mk("ben", { name: "Ben Normal", email: "ben.normal@example.com", tickets: [{ ticketId: "con800000001", type: "connect" }], ...onApp }),
  ]);
  await M.SessionVote.create([
    { sessionId: "d1-5", pollId: "d1-5-p1", userId: U.ben._id, optionIndex: 0 },
    { sessionId: "d1-5", pollId: "d1-5-p1", userId: U.nicole._id, optionIndex: 1 },
    { sessionId: "d1-5", pollId: "d1-5-p1", userId: new mongoose.Types.ObjectId(), optionIndex: 0 },
  ]);
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
const ok = async (p, want = 200) => {
  const r = await p;
  assert.equal(r.status, want, JSON.stringify(r.body));
  return r.body;
};
const points = async (u) => (await ok(call("GET", "/api/social/points/me", { as: u }))).breakdown;
const rule = (b, key) => b.find((x) => x.key === key);
const stateOf = (location) => new URL(location).searchParams.get("state");

test("the app's 'I'm attending' link is this person's; the post LinkedIn confirms there earns their +50, once", { skip }, async () => {
  const link = await ok(call("GET", "/api/app/attending-link", { as: U.nicole }));
  assert.equal(link.posted, false);
  assert.equal(link.points, 50);
  const u = new URL(link.url);
  assert.equal(`${u.origin}${u.pathname}`, "https://www.thetechfestival.com/attending");
  const frag = new URLSearchParams(u.hash.slice(1));
  assert.deepEqual([frag.get("fn"), frag.get("ln"), frag.get("title"), frag.get("co")], ["Nicole", "Louis", "CMO", "Louis & Co"]);
  assert.deepEqual(verifyTrack(frag.get("r")), { c: "attending-2026", e: "nicole.louis@example.com", t: "" });
  assert.equal((await call("GET", "/api/app/attending-link")).status, 401);
  assert.equal(rule(await points(U.nicole), "linkedin.attending").points, 0);

  // On the page: "Post to LinkedIn" with her token, LinkedIn confirms the post.
  const draft = await ok(call("POST", "/api/attending/post", { body: { image: PNG, text: "I'm attending The Tech Festival Canada!", r: frag.get("r") } }));
  const start = await call("GET", `/api/attending/linkedin/post?d=${draft.id}`);
  assert.equal(start.status, 302);
  const cookie = start.headers.get("set-cookie").split(";")[0];
  const back = await call("GET", `/api/auth/linkedin/callback?state=${encodeURIComponent(stateOf(start.location))}&code=abc`, { headers: { cookie } });
  assert.match(back.location, /\/attending#posted=1/);
  for (let i = 0; i < 40 && !(await M.LinkedinShare.countDocuments({ userId: U.nicole._id })); i++) await pause(25);
  assert.equal(rule(await points(U.nicole), "linkedin.attending").points, 50);
  assert.equal((await ok(call("GET", "/api/app/attending-link", { as: U.nicole }))).posted, true);
  // Another one doesn't add more.
  await M.LinkedinShare.create({ userId: U.nicole._id, kind: "attending", itemKey: "attending" });
  assert.equal(rule(await points(U.nicole), "linkedin.attending").points, 50);
});

test("sharing a poll: the draft on the website, editing it, LinkedIn sign-in, the post with the session as a link card", { skip }, async () => {
  const r = await ok(call("POST", "/api/app/linkedin/share", { as: U.ben, body: {
    kind: "poll", id: "d1-5-p1", sessionId: "d1-5", question: "Where is your organisation on the AI journey?", options: ["Exploring", "Piloting", "In production", "Scaled"],
  } }), 201);
  assert.equal(r.points, 15);
  const u = new URL(r.url);
  assert.equal(`${u.origin}${u.pathname}`, "https://www.thetechfestival.com/share/linkedin");
  s.t = u.searchParams.get("t");
  const d = await ok(call("GET", `/api/linkedin-share/draft?t=${s.t}`));
  assert.deepEqual([d.kind, d.sessionTitle, d.title, d.link, d.maxLength, d.hashtag, d.page, d.available],
    ["poll", "The AI Agenda", "The AI Agenda", "https://www.thetechfestival.com/agenda?session=d1-5", 3000, "#TTFC2026", "The Tech Festival Canada", true]);
  assert.match(d.text, /Results so far: Exploring 67% · Piloting 33% · In production 0% · Scaled 0%/);
  assert.equal((await call("GET", "/api/linkedin-share/draft?t=nope")).status, 404);
  // A session that isn't on the agenda, a malformed request.
  assert.equal((await call("POST", "/api/app/linkedin/share", { as: U.ben, body: { kind: "poll", id: "x-p1", sessionId: "not-on-agenda" } })).status, 404);
  assert.equal((await call("POST", "/api/app/linkedin/share", { as: U.ben, body: { kind: "story", id: "x" } })).status, 400);
  // Edit, then post.
  assert.equal((await call("POST", "/api/linkedin-share/text", { body: { t: s.t, text: "   " } })).status, 400);
  await ok(call("POST", "/api/linkedin-share/text", { body: { t: s.t, text: "Voted in the AI poll at The Tech Festival Canada #TTFC2026" } }));
  let start = await call("GET", `/api/linkedin-share/post?t=${s.t}`);
  assert.equal(start.status, 302);
  assert.match(start.location, /^https:\/\/www\.linkedin\.com\/oauth\/v2\/authorization\?/);
  assert.match(start.location, /scope=openid\+profile\+w_member_social/);
  assert.match(start.location, /redirect_uri=https%3A%2F%2Fapi\.example\.test%2Fapi%2Fauth%2Flinkedin%2Fcallback/);
  let cookie = start.headers.get("set-cookie").split(";")[0];
  assert.match(cookie, /^ttfc_shr_li=ttfc-shr\./);
  // No cookie (another browser) or cancelled on LinkedIn: back to the page, the draft kept for another try.
  let back = await call("GET", `/api/auth/linkedin/callback?state=${stateOf(start.location)}&code=abc`);
  assert.equal(back.location, `https://www.thetechfestival.com/share/linkedin#post_error=expired&t=${s.t}`);
  start = await call("GET", `/api/linkedin-share/post?t=${s.t}`);
  cookie = start.headers.get("set-cookie").split(";")[0];
  back = await call("GET", `/api/auth/linkedin/callback?state=${stateOf(start.location)}&error=user_cancelled_login`, { headers: { cookie } });
  assert.equal(back.location, `https://www.thetechfestival.com/share/linkedin#post_error=cancelled&t=${s.t}`);
  assert.equal(rule(await points(U.ben), "linkedin.share").points, 0);
  // Approved: posted with the edited text, the link card and the TTFC page tagged.
  linkedin.length = 0;
  start = await call("GET", `/api/linkedin-share/post?t=${s.t}`);
  cookie = start.headers.get("set-cookie").split(";")[0];
  back = await call("GET", `/api/auth/linkedin/callback?state=${stateOf(start.location)}&code=abc`, { headers: { cookie } });
  assert.match(back.location, /^https:\/\/www\.thetechfestival\.com\/share\/linkedin#posted=1&post=https%3A%2F%2Fwww\.linkedin\.com%2Ffeed%2Fupdate%2Furn%3Ali%3Ashare%3A\d+%2F$/);
  const post = linkedin.find((x) => x.url.endsWith("/rest/posts")).body;
  assert.equal(post.author, "urn:li:person:member1");
  assert.deepEqual(post.content.article, { source: "https://www.thetechfestival.com/agenda?session=d1-5", title: "The AI Agenda", description: "The Tech Festival Canada · October 26–27, 2026 · Toronto" });
  assert.match(post.commentary, /@\[The Tech Festival Canada\]\(urn:li:organization:105812464\)/);
  assert.match(post.commentary, /\{hashtag\|\\#\|TTFC2026\}/);
  const row = await M.LinkedinShare.findOne({ userId: U.ben._id, kind: "poll" }).lean();
  assert.equal(row.itemKey, "poll:d1-5:d1-5-p1");
  assert.match(row.postUrl, /^https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:share:\d+\/$/);
  assert.equal((await call("GET", `/api/linkedin-share/draft?t=${s.t}`)).status, 404);   // used up
  assert.equal(rule(await points(U.ben), "linkedin.share").points, 15);
});

test("sharing a discussion: an approved one (or your own), a session's; points once per item, up to 5", { skip }, async () => {
  const open = await M.Discussion.create({ authorId: U.nicole._id, authorName: "Nicole Louis", title: "Quantum in banking", body: "Who is piloting?", status: "approved" });
  const pending = await M.Discussion.create({ authorId: U.nicole._id, authorName: "Nicole Louis", title: "Draft topic", body: "…", status: "pending" });
  const r = await ok(call("POST", "/api/app/linkedin/share", { as: U.ben, body: { kind: "discussion", id: String(open._id) } }), 201);
  const d = await ok(call("GET", `/api/linkedin-share/draft?t=${new URL(r.url).searchParams.get("t")}`));
  assert.match(d.text, /^Joining the conversation on "Quantum in banking" at The Tech Festival Canada\./);
  assert.equal((await call("POST", "/api/app/linkedin/share", { as: U.ben, body: { kind: "discussion", id: String(pending._id) } })).status, 404);
  assert.equal((await call("POST", "/api/app/linkedin/share", { as: U.nicole, body: { kind: "discussion", id: String(pending._id) } })).status, 201);
  const sess = await ok(call("POST", "/api/app/linkedin/share", { as: U.ben, body: { kind: "discussion", sessionId: "d1-7" } }), 201);
  const sd = await ok(call("GET", `/api/linkedin-share/draft?t=${new URL(sess.url).searchParams.get("t")}`));
  assert.deepEqual([sd.title, sd.link], ["Cyber Risk 2027", "https://www.thetechfestival.com/agenda?session=d1-7"]);
  // Confirmed shares count once per item, up to 5 (+15 each); the same item again adds nothing.
  await M.LinkedinShare.create([
    { userId: U.ben._id, kind: "poll", itemKey: "poll:d1-5:d1-5-p1" },
    ...["a", "b", "c", "d", "e", "f"].map((k) => ({ userId: U.ben._id, kind: "discussion", itemKey: `session:${k}` })),
  ]);
  const b = rule(await points(U.ben), "linkedin.share");
  assert.deepEqual([b.count, b.points], [5, 75]);
  // LinkedIn not set up: the app hears why.
  const id = process.env.LINKEDIN_CLIENT_ID;
  delete process.env.LINKEDIN_CLIENT_ID;
  try {
    const off = await call("POST", "/api/app/linkedin/share", { as: U.ben, body: { kind: "discussion", sessionId: "d1-7" } });
    assert.deepEqual([off.status, off.body.code], [503, "unavailable"]);
  } finally {
    process.env.LINKEDIN_CLIENT_ID = id;
  }
});
