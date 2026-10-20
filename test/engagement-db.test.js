/* Email engagement (Oct 19 2026) through the real routes, against a real (throwaway) MongoDB:
     - a LinkedIn nudge carries the person's token (link + pixel); the pixel always answers the GIF and
       records an open only for a token of ours; the /attending page's events (visit, share, manual) are
       checked (type, token, campaign) and never fail; a post LinkedIn confirms is theirs, one from a link
       without a token is counted unnamed;
     - People shows it all (row, profile, filters, counts) and the nudge leaves out confirmed posters;
     - an RSVP lookup that verifies a ticket counts as "RSVP form opened" (once per half hour), its answer
       unchanged; the RSVP reminder and an issued pass email (no cc) carry the pixel, with a cc they don't.
   Starts a local mongod in a temp folder on a free port and stops it after; skipped when the binary isn't
   there (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Nothing leaves the
   machine: Resend, Sanity and LinkedIn are stubbed (nothing is delivered or posted). Fictional people. */
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

// The token secret falls back to JWT_SECRET (no TRACKING_SECRET here).
process.env.JWT_SECRET ||= "local-test-only";
delete process.env.TRACKING_SECRET;
process.env.RESEND_API_KEY ||= "re_dummy";
process.env.LINKEDIN_CLIENT_ID = "test-client";
process.env.LINKEDIN_CLIENT_SECRET = "test-secret";
process.env.LINKEDIN_REDIRECT_URI = "https://api.example.test/api/auth/linkedin/callback";
process.env.FRONTEND_URL = "https://www.example.test";
delete process.env.STRIPE_SECRET_KEY;

/** Every email the routes tried to send (Resend is stubbed: nothing is delivered). */
const outbox = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.startsWith("https://api.resend.com/")) {
    const body = JSON.parse(opts?.body || "{}");
    outbox.push({ to: [].concat(body.to || []), cc: [].concat(body.cc || []), subject: body.subject || "", html: body.html || "", tags: body.tags || [] });
    return new Response(JSON.stringify({ id: `stub_${outbox.length}` }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.includes(".sanity.io/")) return new Response(JSON.stringify({ result: [] }), { status: 200, headers: { "content-type": "application/json" } });
  throw new Error(`blocked in the test: ${url}`);
};

// LinkedIn, as far as the "Post to LinkedIn" callback goes (nothing is posted anywhere).
const linkedin = [];
axios.post = async (url) => {
  linkedin.push(url);
  if (url === "https://www.linkedin.com/oauth/v2/accessToken") return { data: { access_token: "li-test-token" } };
  if (url.includes("/rest/images?action=initializeUpload")) return { data: { value: { uploadUrl: "https://upload.example.test/img", image: "urn:li:image:1" } } };
  if (url.endsWith("/rest/posts")) return { headers: { "x-restli-id": `urn:li:share:${7000 + linkedin.length}` }, data: {} };
  throw new Error(`blocked in the test: ${url}`);
};
axios.get = async (url) => {
  if (url === "https://api.linkedin.com/v2/userinfo") return { data: { sub: "member1", given_name: "Ana", family_name: "Able" } };
  throw new Error(`blocked in the test: ${url}`);
};
axios.put = async () => ({ status: 201, data: {} });

const PNG = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 7)]).toString("base64")}`;
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });

let mongod = null;
let dbDir = "";
let server = null;
let base = "";
let M = {};
let jwt;
let mongoose;
let mia, ana, ben;
let signTrack;

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-engagement-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_engagement_test`, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  ({ default: jwt } = await import("jsonwebtoken"));
  ({ signTrack } = await import("../services/trackToken.js"));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.Attendee = await imp("../models/Attendee.js");
  M.Rsvp = await imp("../models/Rsvp.js");
  M.EmailEngagement = await imp("../models/EmailEngagement.js");
  await M.EmailEngagement.init();
  const { default: express } = await import("express");
  const { issuedPassRouter } = await import("../routes/issuedPasses.js");
  const attending = await import("../routes/attending.js");
  const app = express();
  app.set("trust proxy", 1);
  app.post("/api/attending/post", express.json({ limit: "9mb" }), attending.attendingPostDraft);
  app.use(express.json());
  app.use("/api/t", (await import("../routes/engagement.js")).default);
  app.get("/api/auth/linkedin/callback", attending.attendingLinkedinCallback);
  app.use("/api/attending", attending.default);
  app.use("/api/rsvp", (await import("../routes/rsvp.js")).default);
  app.use("/api/console/issued-passes", issuedPassRouter("issued"));
  app.use("/api/console/people", (await import("../routes/people.js")).default);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const d = (n) => new Date(Date.now() - n * 864e5);
  mia = await M.User.create({ name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management" });
  ana = await M.User.create({ name: "Ana Able", email: "ana.able@example.com", tickets: [{ ticketId: "con500000001", type: "connect", purchaseDate: d(10) }] });
  ben = await M.User.create({ name: "Ben Bee", email: "ben.bee@example.com", tickets: [{ ticketId: "inf500000001", type: "influence", purchaseDate: d(9) }] });
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const tokenFor = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function call(method, url, { as = mia, body, headers = {}, raw = false } = {}) {
  const r = await realFetch(base + url, {
    method, redirect: "manual",
    headers: { "content-type": "application/json", ...(as ? { authorization: `Bearer ${tokenFor(as)}` } : {}), ...headers },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString()); } catch { json = buf; }
  return { status: r.status, body: json, headers: r.headers };
}
const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
  return null;
};
const row = (q) => M.EmailEngagement.findOne(q).lean();
const idOf = async (q) => (await call("GET", `/api/console/people?q=${encodeURIComponent(q)}&refresh=1`)).body.rows[0]?.id;
const LINK_TOKEN = /attending#[^"]*?r=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22})/;
const PIXEL_TOKEN = /\/api\/t\/o\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22})\.gif/;

/** "Post to LinkedIn": the draft (with or without the page's token), LinkedIn's approval, the callback. */
async function postToLinkedin(r) {
  const draft = await call("POST", "/api/attending/post", { as: null, body: { image: PNG, text: "I'm attending TTFC 2026!", ...(r ? { r } : {}) } });
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  const start = await call("GET", `/api/attending/linkedin/post?d=${draft.body.id}`, { as: null });
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const cookie = start.headers.get("set-cookie").split(";")[0];
  const back = await call("GET", `/api/auth/linkedin/callback?state=${encodeURIComponent(state)}&code=abc`, { as: null, headers: { cookie } });
  assert.equal(back.status, 302);
  return back.headers.get("location");
}

let anaToken = "";

test("the nudge carries Ana's token; the pixel and her page's events are recorded for her", { skip }, async () => {
  const anaId = await idOf("Ana Able");
  const sent = await call("POST", `/api/console/people/${anaId}/nudge`);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const mail = outbox.at(-1);
  anaToken = LINK_TOKEN.exec(mail.html)?.[1] || "";
  assert.ok(anaToken, "the /attending link has &r=");
  assert.equal(PIXEL_TOKEN.exec(mail.html)?.[1], anaToken);
  const key = { campaign: "attending-2026", email: "ana.able@example.com", ticketId: "" };
  assert.ok(await waitFor(async () => (await row(key))?.trackedAt), "the send is noted as tracked");

  // The pixel: always the GIF; an open only for our token.
  const px = await call("GET", `/api/t/o/${anaToken}.gif`, { as: null });
  assert.equal(px.status, 200);
  assert.equal(px.headers.get("content-type"), "image/gif");
  assert.match(px.headers.get("cache-control"), /no-store/);
  assert.equal(px.body.subarray(0, 6).toString(), "GIF89a");
  assert.ok(await waitFor(async () => (await row(key))?.opens === 1));
  const forged = signTrack({ c: "attending-2026", e: "ben.bee@example.com" }, "not-our-secret");
  for (const bad of [`${forged}.gif`, "nonsense.gif", "x"]) {
    const r = await call("GET", `/api/t/o/${bad}`, { as: null });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/gif");
  }
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(await M.EmailEngagement.countDocuments({ email: "ben.bee@example.com" }), 0);

  // The page's events: JSON or text/plain; anything else about them changes nothing.
  assert.equal((await call("POST", "/api/attending/event", { as: null, body: { r: anaToken, type: "visit" } })).status, 204);
  const plain = await call("POST", "/api/attending/event", { as: null, raw: true, body: JSON.stringify({ r: anaToken, type: "manual" }), headers: { "content-type": "text/plain;charset=UTF-8" } });
  assert.equal(plain.status, 204);
  assert.equal((await call("POST", "/api/attending/event", { as: null, body: { r: anaToken, type: "delete" } })).status, 400);
  assert.equal((await call("POST", "/api/attending/event", { as: null, body: { type: "visit" } })).status, 204);
  assert.equal((await call("POST", "/api/attending/event", { as: null, body: { r: "junk.junk", type: "visit" } })).status, 204);
  // A token of another email (the RSVP reminder's) isn't an "I'm attending" visit.
  const other = signTrack({ c: "rsvp-reminder-2026", e: "ben.bee@example.com" });
  assert.equal((await call("POST", "/api/attending/event", { as: null, body: { r: other, type: "visit" } })).status, 204);
  assert.ok(await waitFor(async () => { const x = await row(key); return x?.visits === 1 && x?.manuals === 1; }));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(await M.EmailEngagement.countDocuments({ email: "ben.bee@example.com" }), 0);
  const x = await row(key);
  assert.equal(x.ip, undefined);
});

test("a post LinkedIn confirms is Ana's (with its link); one from a link without a token is counted unnamed", { skip }, async () => {
  const where = await postToLinkedin(anaToken);
  assert.match(where, /^https:\/\/www\.example\.test\/attending#posted=1&post=/);
  const key = { campaign: "attending-2026", email: "ana.able@example.com", ticketId: "" };
  const posted = await waitFor(async () => { const x = await row(key); return x?.posts === 1 ? x : null; });
  assert.ok(posted, "recorded for Ana");
  assert.match(posted.postUrl, /^https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:share:\d+\/$/);
  assert.ok(posted.postedAt instanceof Date);

  await postToLinkedin("");
  await postToLinkedin("forged.token-that-is-not-ours-at-all");
  assert.ok(await waitFor(async () => (await row({ campaign: "attending-2026", email: "", ticketId: "" }))?.posts === 2));
  assert.equal((await row(key)).posts, 1);
});

test("People: Ana's row, profile, filters and counts; the nudge leaves her out now", { skip }, async () => {
  const list = await call("GET", "/api/console/people?attending=posted&refresh=1");
  assert.deepEqual(list.body.rows.map((r) => r.name), ["Ana Able"]);
  const r = list.body.rows[0];
  assert.equal(r.engagement.attending.stage, "posted");
  assert.equal(r.engagement.attending.stageLabel, "Posted on LinkedIn");
  assert.equal(r.attending.status, "sent");
  assert.deepEqual([list.body.counts.attendingSent, list.body.counts.attendingOpened, list.body.counts.attendingVisited, list.body.counts.attendingPosted,
    list.body.counts.unattributedPosts], [1, 1, 1, 1, 2]);
  assert.deepEqual((await call("GET", "/api/console/people?attending=noPost&refresh=1")).body.rows, []);
  const prof = (await call("GET", `/api/console/people/${r.id}`)).body;
  const a = prof.person.engagement.attending;
  assert.deepEqual([a.opens, a.visits, a.manuals, a.posts, a.tracked, !!a.firstOpenAt, !!a.postedAt], [1, 1, 1, 1, true, true, true]);
  assert.match(a.postUrl, /^https:\/\/www\.linkedin\.com\/feed\/update\//);
  assert.match(prof.person.engagement.note, /^Opens are estimates/);
  assert.deepEqual(prof.outreach.attending.tracking, { opens: true, clicks: true, posts: true });
  assert.equal(prof.outreach.attending.canSend, false);
  assert.equal(prof.outreach.attending.reason, "posted");
  const again = await call("POST", `/api/console/people/${r.id}/nudge`);
  assert.deepEqual([again.status, again.body.code], [409, "posted"]);
  const plan = (await call("GET", "/api/console/people/nudge?q=Able")).body;
  assert.deepEqual(plan.skipped.map((s) => [s.name, s.reason]), [["Ana Able", "posted"]]);
  assert.equal(plan.skipLabels.posted, "Already posted on LinkedIn");
  // Delete person would take these rows too.
  const del = (await call("GET", `/api/console/people/${r.id}/delete-plan`)).body;
  const items = del.items || [];
  assert.equal(items.find((i) => i.key === "emailEngagement")?.count, 1, JSON.stringify(del).slice(0, 300));
});

test("RSVP: a verified lookup counts as the form opened (once per half hour, same answer); the reminder's pixel; People filters", { skip }, async () => {
  const ask = () => call("POST", "/api/rsvp/lookup", { as: null, body: { firstName: "Ben", lastName: "Bee", ticketId: "INF500000001" } });
  const first = await ask();
  assert.equal(first.status, 200);
  assert.deepEqual([first.body.kind, first.body.verified, first.body.tier, first.body.ticketMatched], ["ticket", true, "influence", true]);
  const formKey = { campaign: "rsvp-form", email: "", ticketId: "inf500000001" };
  assert.ok(await waitFor(async () => (await row(formKey))?.visits === 1));
  const second = await ask();
  assert.deepEqual(second.body, first.body);
  // A wrong last name verifies nothing: no form open.
  await call("POST", "/api/rsvp/lookup", { as: null, body: { firstName: "Ben", lastName: "Wrong", ticketId: "INF500000001" } });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal((await row(formKey)).visits, 1);
  assert.deepEqual((await call("GET", "/api/console/people?rsvp=form&refresh=1")).body.rows.map((x) => x.name), ["Ben Bee"]);

  // The RSVP reminder from his profile carries the pixel; nothing opened yet → "Sent, not opened".
  const benId = await idOf("Ben Bee");
  const sent = await call("POST", `/api/console/people/${benId}/reminder`);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const token = PIXEL_TOKEN.exec(outbox.at(-1).html)?.[1];
  assert.ok(token);
  const key = { campaign: "rsvp-reminder-2026", email: "ben.bee@example.com", ticketId: "" };
  assert.ok(await waitFor(async () => (await row(key))?.trackedAt));
  assert.deepEqual((await call("GET", "/api/console/people?rsvpEmail=unopened&refresh=1")).body.rows.map((x) => x.name), ["Ben Bee"]);
  await call("GET", `/api/t/o/${token}.gif`, { as: null });
  assert.ok(await waitFor(async () => (await row(key))?.opens === 1));
  const opened = await call("GET", "/api/console/people?rsvpEmail=opened&refresh=1");
  assert.deepEqual(opened.body.rows.map((x) => x.name), ["Ben Bee"]);
  assert.deepEqual([opened.body.rows[0].engagement.rsvp.emailOpened, opened.body.rows[0].engagement.rsvp.formOpens], [true, 1]);
  assert.deepEqual([opened.body.counts.rsvpEmailOpened, opened.body.counts.rsvpFormOpened, opened.body.counts.rsvpFormNotSent], [1, 1, 1]);
  const prof = (await call("GET", `/api/console/people/${benId}`)).body.person.engagement.rsvp;
  assert.deepEqual(prof.openedVia, ["RSVP reminder"]);
});

test("issued pass email: the pixel (per pass) without a cc, none with one", { skip }, async () => {
  const made = await call("POST", "/api/console/issued-passes", { body: { name: "Gia Guest", email: "gia.guest@example.com", tier: "connect" } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const ticketId = made.body.row.ticketId;
  const noCc = await call("POST", `/api/console/issued-passes/${made.body.row.id}/send`, { body: { cc: "" } });
  assert.equal(noCc.status, 200, JSON.stringify(noCc.body));
  assert.deepEqual(outbox.at(-1).cc, []);
  const token = PIXEL_TOKEN.exec(outbox.at(-1).html)?.[1];
  assert.ok(token, "pixel in the pass email");
  const { verifyTrack } = await import("../services/trackToken.js");
  assert.deepEqual(verifyTrack(token), { c: "issued-pass-2026", e: "gia.guest@example.com", t: ticketId.toLowerCase() });
  const withCc = await call("POST", `/api/console/issued-passes/${made.body.row.id}/send`, { body: { cc: "staff.copy@example.com" } });
  assert.equal(withCc.status, 200);
  assert.deepEqual(outbox.at(-1).cc, ["staff.copy@example.com"]);
  assert.doesNotMatch(outbox.at(-1).html, /\/api\/t\/o\//);
  // The preview never has one.
  const preview = await call("GET", `/api/console/issued-passes/${made.body.row.id}/preview`);
  assert.doesNotMatch(preview.body.html, /\/api\/t\/o\//);
});
