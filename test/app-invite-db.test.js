/* The app invite email through the real routes, against a real (throwaway) MongoDB: the wording (staff read it,
   management save it), the preview, the counts, a test to yourself, a send to one person (the page and a profile in
   People), the send to everyone as a background job (failures recorded, a retry, a re-run skips everyone sent), the
   open pixel and the web app's visit for the button's token, and the stats.
   Starts a local mongod in a temp folder on a free port and stops it after; skipped when the binary isn't there
   (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Nothing leaves the machine: Resend
   and Sanity are answered by a stubbed fetch (nothing is delivered). Fictional people, example.com. */
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
process.env.TRACKING_SECRET ||= "app-invite-db-test";
delete process.env.STRIPE_SECRET_KEY;

// Resend: every email is captured here and never delivered. `failFor`: addresses Resend "refuses".
const sent = [];
const failFor = new Set();
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.startsWith("https://api.resend.com/")) {
    const body = JSON.parse(opts?.body || "{}");
    const to = [].concat(body.to || [])[0];
    if (failFor.has(to)) return new Response(JSON.stringify({ name: "validation_error", message: "Resend refused it (test)", statusCode: 422 }), { status: 422, headers: { "content-type": "application/json" } });
    sent.push(body);
    return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.includes(".sanity.io/")) return new Response(JSON.stringify({ result: [] }), { status: 200, headers: { "content-type": "application/json" } });
  throw new Error(`blocked in the test: ${url}`);
};

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let mongod = null;
let dbDir = "";
let server = null;
let base = "";
let mongoose;
let jwt;
const M = {};
const U = {};

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-app-invite-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_app_invite_test`, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await sleep(250); }
  }
  ({ default: jwt } = await import("jsonwebtoken"));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.Attendee = await imp("../models/Attendee.js");
  M.CampaignSend = await imp("../models/CampaignSend.js");
  M.Subscription = await imp("../models/Subscription.js");
  M.EmailEngagement = await imp("../models/EmailEngagement.js");
  Object.assign(M, await import("../models/Admin.js"));
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/t", (await import("../routes/engagement.js")).default);
  app.use("/api/console/app-invite", (await import("../routes/appInvite.js")).default);
  app.use("/api/console/people", (await import("../routes/people.js")).default);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const t = (ticketId, type) => ({ ticketId, type, promoCode: "", stripeSessionId: `cs_${ticketId}`, purchaseDate: new Date("2026-10-01") });
  const mk = async (k, doc) => { U[k] = await M.User.create(doc); };
  await mk("mia", { name: "Mia Example", email: "mia.example@example.com", role: "admin", staffRole: "management" });
  await mk("sam", { name: "Sam Example", email: "sam.example@example.com", role: "admin", staffRole: "staff" });
  await mk("ana", { name: "Ana Example", email: "ana.example@example.com", tickets: [t("ai0000000001", "power")] });
  await mk("app", { name: "Abe Example", email: "abe.example@example.com", lastActiveAt: new Date("2026-10-18"), tickets: [t("ai0000000002", "connect")] });
  await mk("val", { name: "Val Example", email: "val.example@example.com", role: "volunteer" });
  await mk("pid", { name: "Pip Example", email: "ai0000000003@ticket.thetechfestival.com", tickets: [t("ai0000000003", "connect")] });
  await mk("uns", { name: "Una Example", email: "una.example@example.com", tickets: [t("ai0000000004", "influence")] });
  await mk("fai", { name: "Fay Example", email: "fay.example@example.com", tickets: [t("ai0000000005", "connect")] });
  await mk("nob", { name: "Ned Example", email: "ned.example@example.com" }); // an account with no pass or role
  await M.Attendee.create([
    { name: "Gus Example", email: "gus.example@example.com", ticketId: "ai0000000006", ticketType: "power", promoCode: "ISSUED", purchaseDate: new Date("2026-10-02") },
    { name: "Eve Example", email: "eve.example@example.com", ticketId: "ai0000000007", ticketType: "connect", promoCode: "EXHIBITOR", purchaseDate: new Date("2026-10-02") },
  ]);
  await M.Subscription.create({ email: "una.example@example.com", subscribed: false });
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

async function call(method, url, { as = U.mia, body } = {}) {
  const r = await realFetch(base + url, {
    method, headers: { "content-type": "application/json", authorization: `Bearer ${jwt.sign({ id: String(as._id) }, process.env.JWT_SECRET, { expiresIn: "1h" })}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = text;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json };
}
const audits = (action) => M.AdminAudit.find({ action }).lean();

test("wording: staff read it, management save it (defaults aren't stored), the preview follows a draft", { skip }, async () => {
  const t = await call("GET", "/api/console/app-invite/template", { as: U.sam });
  assert.equal(t.status, 200);
  assert.equal(t.body.canEdit, false);
  assert.equal(t.body.defaults.button, "Open the web app");
  assert.deepEqual(t.body.options, { play: true, appStore: true });
  assert.equal(t.body.appStoreUrl, "https://apps.apple.com/ca/app/the-tech-festival-canada/id6820764803");
  assert.equal((await call("PUT", "/api/console/app-invite/template", { as: U.sam, body: { heading: "Nope" } })).status, 403);
  const saved = await call("PUT", "/api/console/app-invite/template", { body: { heading: "Your festival app is here.", subject: t.body.defaults.subject, options: { play: false } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.copy, { heading: "Your festival app is here." });
  assert.deepEqual(saved.body.options, { play: false, appStore: true });
  assert.match((await audits("app_invite_template"))[0].detail, /heading, play off/);
  const prev = await call("POST", "/api/console/app-invite/preview", { as: U.sam, body: { button: "Get the app" } });
  assert.equal(prev.status, 200);
  assert.match(prev.body.html, /Your festival app is here\./);
  assert.match(prev.body.html, />Get the app</);
  assert.match(prev.body.html, /Hi Jane,/);
  assert.doesNotMatch(prev.body.html, /play\.google\.com/); // switched off
  const as = await call("POST", "/api/console/app-invite/preview", { body: { as: "ana.example@example.com" } });
  assert.match(as.body.html, /Hi Ana,/);
  assert.match(as.body.html, /Sign in with this email: ana\.example@example\.com/);
  // Back to the built-in wording (switch on again) for the sends below.
  await call("PUT", "/api/console/app-invite/template", { body: { options: { play: true } } });
});

test("counts: everyone with a pass or a role, minus who uses the app; the list says why for the rest", { skip }, async () => {
  const r = await call("GET", "/api/console/app-invite/recipients?refresh=1", { as: U.sam });
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.body.rows.map((x) => [x.name, x.reason || "yes"]));
  assert.deepEqual(by, {
    "Mia Example": "yes", "Sam Example": "yes", "Ana Example": "yes", "Abe Example": "usingApp", "Val Example": "yes",
    "Pip Example": "placeholder", "Una Example": "unsubscribed", "Fay Example": "yes", "Gus Example": "yes", "Eve Example": "yes",
  });
  assert.deepEqual([r.body.counts.people, r.body.counts.usingApp, r.body.counts.willGet], [9, 1, 7]);
  assert.equal((await call("GET", "/api/console/app-invite/recipients?skipUsing=0")).body.counts.willGet, 8);
});

test("a test to yourself, a send to one person (staff), its cool-down", { skip }, async () => {
  const before = sent.length;
  const t = await call("POST", "/api/console/app-invite/send-test", { as: U.sam, body: { heading: "Draft heading" } });
  assert.deepEqual([t.status, t.body.to], [200, "sam.example@example.com"]);
  const test1 = sent[before];
  assert.equal(test1.subject, "[Test] Your TTFC 2026 app is ready");
  assert.match(test1.html, /Draft heading/);
  assert.doesNotMatch(test1.html, /#r=|\/api\/t\/o\//);
  assert.equal(await M.CampaignSend.countDocuments({ campaign: "app-invite-2026" }), 0);

  const one = await call("POST", "/api/console/app-invite/send-one", { as: U.sam, body: { email: "ana.example@example.com" } });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  const m = sent.at(-1);
  assert.deepEqual([m.from, m.reply_to, m.to], ["The Tech Festival Canada <enquire@thetechfestival.com>", "enquire@thetechfestival.com", "ana.example@example.com"]);
  assert.match(m.headers["List-Unsubscribe"], /^<https:\/\/[^>]+\/api\/unsubscribe\?t=[^>]+>, <mailto:enquire@thetechfestival\.com\?subject=unsubscribe>$/);
  assert.equal(m.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.match(m.html, /\/app\/#r=/);
  const row = await M.CampaignSend.findOne({ campaign: "app-invite-2026", email: "ana.example@example.com" }).lean();
  assert.deepEqual([row.status, row.sends], ["sent", 1]);
  assert.equal((await audits("app_invite_send_one"))[0].detail, "ana.example@example.com (by staff)");
  const again = await call("POST", "/api/console/app-invite/send-one", { as: U.sam, body: { email: "ana.example@example.com" } });
  assert.deepEqual([again.status, again.body.code], [409, "recent"]);
  assert.equal((await call("POST", "/api/console/app-invite/send-one", { body: { email: "ned.example@example.com" } })).status, 404);
  assert.equal((await call("POST", "/api/console/app-invite/send-one", { body: { email: "una.example@example.com" } })).body.code, "unsubscribed");
});

test("the button's token: the web app's visit and the open pixel count, and show in the stats", { skip }, async () => {
  const html = sent.find((m) => m.to === "ana.example@example.com" && !/^\[Test\]/.test(m.subject)).html;
  const token = /#r=([A-Za-z0-9_.-]+)"/.exec(html)[1];
  const v = await realFetch(`${base}/api/t/v`, { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify({ r: token }) });
  assert.equal(v.status, 204);
  assert.equal((await realFetch(`${base}/api/t/o/${token}.gif`)).status, 200);
  await sleep(300);
  const e = await M.EmailEngagement.findOne({ campaign: "app-invite-2026", email: "ana.example@example.com" }).lean();
  assert.deepEqual([e.visits, e.opens], [1, 1]);
  const r = await call("GET", "/api/console/app-invite/recipients");
  assert.deepEqual(r.body.stats, { sent: 1, opened: 1, clicked: 1, usingAfter: 0, failed: 0, unconfirmed: 0 });
  // Signed in after the email: now using the app.
  await M.User.updateOne({ _id: U.ana._id }, { $set: { lastActiveAt: new Date(Date.now() + 1000) } });
  assert.equal((await call("GET", "/api/console/app-invite/recipients?refresh=1")).body.stats.usingAfter, 1);
});

test("send to everyone: management only, a background job, a failure recorded and retried, a re-run sends nothing", { skip }, async () => {
  assert.equal((await call("POST", "/api/console/app-invite/send-all", { as: U.sam, body: { confirm: "SEND" } })).status, 403);
  assert.equal((await call("POST", "/api/console/app-invite/send-all", { body: {} })).status, 400);
  failFor.add("fay.example@example.com");
  const go = await call("POST", "/api/console/app-invite/send-all", { body: { confirm: "SEND" } });
  assert.equal(go.status, 202, JSON.stringify(go.body));
  assert.equal(go.body.toSend, 6); // everyone left but Ana (sent), Abe (uses the app), Pip (placeholder), Una (unsubscribed)
  let job;
  for (let i = 0; i < 60; i++) { job = (await call("GET", "/api/console/app-invite/recipients")).body.job; if (!job.running) break; await sleep(500); }
  assert.deepEqual([job.running, job.sent, job.failed, job.skipped], [false, 5, 1, 0]);
  const fay = await M.CampaignSend.findOne({ campaign: "app-invite-2026", email: "fay.example@example.com" }).lean();
  assert.deepEqual([fay.status, fay.error], ["failed", "Resend refused it (test)"]);
  assert.ok(!sent.some((m) => m.to === "abe.example@example.com"));
  // Retry the failures only.
  failFor.clear();
  const retry = await call("POST", "/api/console/app-invite/send-all", { body: { confirm: "SEND", only: "failed" } });
  assert.equal(retry.body.toSend, 1);
  for (let i = 0; i < 40; i++) { job = (await call("GET", "/api/console/app-invite/recipients")).body.job; if (!job.running) break; await sleep(300); }
  assert.equal((await M.CampaignSend.findOne({ campaign: "app-invite-2026", email: "fay.example@example.com" }).lean()).status, "sent");
  // Again: nobody is emailed twice.
  const n = sent.length;
  const rerun = await call("POST", "/api/console/app-invite/send-all", { body: { confirm: "SEND" } });
  assert.equal(rerun.body.toSend, 0);
  await sleep(300);
  assert.equal(sent.length, n);
  assert.equal((await audits("app_invite_send_all_done")).length >= 2, true);
});

test("a person's profile in People: the app invite's status, and a send from there", { skip }, async () => {
  // Abe uses the app, so the send to everyone skipped him; from his profile it can still go.
  const list = await call("GET", "/api/console/people?q=abe&refresh=1");
  const id = list.body.rows[0].id;
  const prof = (await call("GET", `/api/console/people/${id}`)).body;
  assert.deepEqual([prof.outreach.appInvite.status, prof.outreach.appInvite.canSend, prof.outreach.appInvite.usingApp], ["pending", true, true]);
  const r = await call("POST", `/api/console/people/${id}/app-invite`, { as: U.sam });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(sent.at(-1).to, "abe.example@example.com");
  const after = (await call("GET", `/api/console/people/${id}`)).body.outreach.appInvite;
  assert.deepEqual([after.status, after.canSend, after.reason], ["sent", false, "recent"]);
  assert.equal((await call("POST", `/api/console/people/${id}/app-invite`)).body.code, "recent");
  // Someone with no pass or role: no app invite on their profile.
  const ned = (await call("GET", "/api/console/people?q=ned")).body.rows[0];
  assert.equal((await call("GET", `/api/console/people/${ned.id}`)).body.outreach.appInvite, null);
});
