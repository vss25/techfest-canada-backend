/* The app invite email in groups and to a selection (Oct 20 2026), through the real routes against a real (throwaway)
   MongoDB: the Ticket column (bought, with the coupon code, or given by staff), who can be picked, a send to the people
   picked and to "the next N" in the page's filtered order (intersected with who can get it now, the rest reported),
   management only, and the one job at a time.
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
process.env.TRACKING_SECRET ||= "app-invite-batches-db-test";
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
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-app-batches-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_app_batches_test`, { serverSelectionTimeoutMS: 500 }); break; }
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

  const day = 24 * 60 * 60 * 1000;
  const t = (ticketId, type, promoCode = "") => ({ ticketId, type, promoCode, stripeSessionId: `cs_${ticketId}`, purchaseDate: new Date("2026-10-01") });
  const mk = async (k, doc) => { U[k] = await M.User.create(doc); };
  await mk("mia", { name: "Mia Example", email: "mia.example@example.com", role: "admin", staffRole: "management" });
  await mk("sam", { name: "Sam Example", email: "sam.example@example.com", role: "admin", staffRole: "staff" });
  await mk("ana", { name: "Ana Example", email: "ana.example@example.com", tickets: [t("ab0000000001", "power", "SPRING20")] });
  await mk("bob", { name: "Bob Example", email: "bob.example@example.com", tickets: [t("ab0000000002", "connect")] });
  await mk("cal", { name: "Cal Example", email: "cal.example@example.com", tickets: [t("ab0000000003", "influence", "SPRING20")] });
  await mk("dan", { name: "Dan Example", email: "dan.example@example.com", tickets: [t("ab0000000004", "connect")] });
  await mk("abe", { name: "Abe Example", email: "abe.example@example.com", lastActiveAt: new Date("2026-10-18"), tickets: [t("ab0000000005", "connect")] });
  await mk("una", { name: "Una Example", email: "una.example@example.com", tickets: [t("ab0000000006", "power")] });
  await mk("ola", { name: "Ola Example", email: "ola.example@example.com", tickets: [t("ab0000000007", "power")] });
  await mk("nia", { name: "Nia Example", email: "nia.example@example.com", tickets: [t("ab0000000008", "power")] });
  // Two passes: bought one, given another.
  await mk("max", { name: "Max Example", email: "max.example@example.com", tickets: [t("ab0000000009", "connect")] });
  await M.Attendee.create([
    { name: "Gus Example", email: "gus.example@example.com", ticketId: "ab0000000010", ticketType: "power", promoCode: "ISSUED", purchaseDate: new Date("2026-10-02") },
    { name: "Eve Example", email: "eve.example@example.com", ticketId: "ab0000000011", ticketType: "connect", promoCode: "EXHIBITOR", purchaseDate: new Date("2026-10-02") },
    { name: "Cora Example", email: "cora.example@example.com", ticketId: "ab0000000012", ticketType: "connect", promoCode: "COMP", purchaseDate: new Date("2026-10-02") },
    { name: "Sid Example", email: "sid.example@example.com", ticketId: "ab0000000013", ticketType: "speaker", promoCode: "SPEAKER", purchaseDate: new Date("2026-10-02") },
    { name: "Max Example", email: "max.example@example.com", ticketId: "ab0000000014", ticketType: "apex", promoCode: "ISSUED", purchaseDate: new Date("2026-10-03") },
  ]);
  await M.Subscription.create({ email: "una.example@example.com", subscribed: false });
  // Ola got it five days ago (it can go again if picked), Nia this morning (it can't).
  await M.CampaignSend.create([
    { campaign: "app-invite-2026", email: "ola.example@example.com", status: "sent", sentAt: new Date(Date.now() - 5 * day), sends: 1 },
    { campaign: "app-invite-2026", email: "nia.example@example.com", status: "sent", sentAt: new Date(Date.now() - 2 * 60 * 60 * 1000), sends: 1 },
  ]);
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

const B = "/api/console/app-invite";
const rowsBy = async (q = "") => Object.fromEntries((await call("GET", `${B}/recipients?refresh=1${q}`)).body.rows.map((r) => [r.name.split(" ")[0], r]));
async function waitJob() {
  let job;
  for (let i = 0; i < 60; i++) { job = (await call("GET", `${B}/recipients`)).body.job; if (!job.running) return job; await sleep(300); }
  return job;
}
const real = () => sent.filter((m) => !/^\[Test\]/.test(m.subject));

test("the Ticket column: bought (with the coupon code) or given by staff, and who can be picked", { skip }, async () => {
  const r = await rowsBy();
  const label = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.ticket.label + (v.ticket.more ? ` +${v.ticket.more}` : "")]));
  assert.deepEqual(label, {
    Mia: "No ticket", Sam: "No ticket", Ana: "Bought · SPRING20", Bob: "Bought", Cal: "Bought · SPRING20", Dan: "Bought", Abe: "Bought",
    Una: "Bought", Ola: "Bought", Nia: "Bought", Max: "Bought +1", Gus: "Given by staff", Eve: "Exhibitor", Cora: "Complimentary", Sid: "Speaker Pass",
  });
  assert.deepEqual(r.Max.ticket.groups, ["bought", "given"]);
  assert.deepEqual(r.Max.ticket.all, ["Connect Pass · Bought", "Apex Pass · Given by staff"]);
  // Picked: anyone who'll get it, and Ola (sent five days ago); not Nia (this morning), Abe (uses the app), Una.
  assert.deepEqual(Object.entries(r).filter(([, v]) => v.canSelect).map(([k]) => k), ["Mia", "Sam", "Ana", "Bob", "Cal", "Dan", "Ola", "Max", "Gus", "Eve", "Cora", "Sid"]);
  assert.deepEqual([r.Ola.sendAgain, r.Ola.willGet, r.Nia.sendAgain], [true, false, false]);
  const page = (await call("GET", `${B}/recipients`, { as: U.sam })).body;
  assert.deepEqual([page.groupSizes, page.typeSendFrom], [[10, 20, 50, 100], 50]);
});

test("group and selection sends: management only, a real choice, the confirm the count needs", { skip }, async () => {
  const go = (body, as) => call("POST", `${B}/send-batch`, { as, body });
  const ok = { kind: "selected", emails: ["gus.example@example.com"], confirm: "CONFIRM" };
  assert.equal((await go(ok, U.sam)).status, 403);
  assert.equal((await go({ ...ok, kind: "everyone" })).status, 400);
  assert.equal((await go({ ...ok, emails: [] })).status, 400);
  assert.equal((await go({ ...ok, confirm: undefined })).status, 400);
  assert.equal((await go({ kind: "next", size: 15, emails: ["gus.example@example.com"], confirm: "CONFIRM" })).status, 400);
  const eleven = Array.from({ length: 11 }, (_, i) => `p${i}@example.com`);
  assert.equal((await go({ kind: "next", size: 10, emails: eleven, confirm: "CONFIRM" })).status, 400);
  // 50 or more: type SEND. Fifty addresses nobody has: all dropped, nothing sent, the last run stays on the page.
  const fifty = Array.from({ length: 50 }, (_, i) => `stranger${i}@example.com`);
  assert.equal((await go({ kind: "selected", emails: fifty, confirm: "CONFIRM" })).status, 400);
  const n = sent.length;
  const none = await go({ kind: "selected", emails: fifty, confirm: "SEND" });
  assert.deepEqual([none.status, none.body.toSend, none.body.dropped.length, none.body.dropped[0].reason], [409, 0, 50, "notListed"]);
  assert.equal(none.body.error, "None of them can get it now: 50 not on the list.");
  assert.equal(sent.length, n);
  assert.equal((await call("GET", `${B}/recipients`)).body.job.running, false);
  assert.equal(await M.CampaignSend.countDocuments({ campaign: "app-invite-2026" }), 2);
});

test("send to the people picked: only who can get it now, in the page's order; the rest reported; one job at a time", { skip }, async () => {
  const picked = ["gus.example@example.com", "stranger@example.com", "nia.example@example.com", "OLA.example@example.com", "ana.example@example.com", "una.example@example.com"];
  const n = real().length;
  const go = await call("POST", `${B}/send-batch`, { body: { kind: "selected", emails: picked, confirm: "CONFIRM" } });
  assert.equal(go.status, 202, JSON.stringify(go.body));
  assert.equal(go.body.toSend, 3);
  assert.deepEqual(go.body.dropped.map((d) => [d.email, d.reason]), [["stranger@example.com", "notListed"], ["nia.example@example.com", "recent"], ["una.example@example.com", "unsubscribed"]]);
  assert.deepEqual([go.body.job.kind, go.body.job.total, go.body.job.dropped], ["selected", 3, 3]);
  assert.equal(go.body.droppedText, "1 not on the list, 1 emailed in the last 3 days, 1 unsubscribed from our emails");
  // While it runs: no other multi-person send, and no single send.
  assert.equal((await call("POST", `${B}/send-all`, { body: { confirm: "SEND" } })).status, 409);
  assert.equal((await call("POST", `${B}/send-batch`, { body: { kind: "selected", emails: ["bob.example@example.com"], confirm: "CONFIRM" } })).status, 409);
  assert.equal((await call("POST", `${B}/send-one`, { as: U.sam, body: { email: "bob.example@example.com" } })).body.code, "running");
  const job = await waitJob();
  assert.deepEqual([job.running, job.sent, job.failed, job.skipped], [false, 3, 0, 0]);
  assert.deepEqual(real().slice(n).map((m) => m.to), ["gus.example@example.com", "ola.example@example.com", "ana.example@example.com"]);
  assert.match(real().at(-1).html, /\/app\/#r=/);
  assert.equal((await M.CampaignSend.findOne({ campaign: "app-invite-2026", email: "ola.example@example.com" }).lean()).sends, 2);
  assert.match((await audits("app_invite_send_selected_start"))[0].detail, /^6 picked: 3 to send, 3 dropped \(notListed, recent, unsubscribed\)/);
  // The "done" line is written just after the job finishes.
  let done = [];
  for (let i = 0; i < 30 && !done.length; i++) { done = await audits("app_invite_send_selected_done"); if (!done.length) await sleep(100); }
  assert.equal(done[0]?.detail, "sent 3, failed 0, skipped 0 of 3");
  // Picked again straight away: all three were just emailed.
  const again = await call("POST", `${B}/send-batch`, { body: { kind: "selected", emails: ["gus.example@example.com", "ola.example@example.com"], confirm: "CONFIRM" } });
  assert.deepEqual([again.status, again.body.dropped.map((d) => d.reason)], [409, ["recent", "recent"]]);
});

test("send the next N in the page's filtered order (Bought), then the next ones; nobody twice", { skip }, async () => {
  const list = (await call("GET", `${B}/recipients?refresh=1`)).body.rows;
  const next = (n) => list.filter((r) => r.ticket.groups.includes("bought") && r.willGet).slice(0, n).map((r) => r.email);
  assert.deepEqual(next(10), ["bob.example@example.com", "cal.example@example.com", "dan.example@example.com", "max.example@example.com"]);
  const n = real().length;
  const go = await call("POST", `${B}/send-batch`, { body: { kind: "next", size: 10, emails: next(2), confirm: "CONFIRM" } });
  assert.deepEqual([go.status, go.body.toSend, go.body.dropped, go.body.job.kind, go.body.job.size], [202, 2, [], "next", 10]);
  await waitJob();
  assert.deepEqual(real().slice(n).map((m) => m.to), ["bob.example@example.com", "cal.example@example.com"]);
  // The page from a minute ago asks again: both dropped as already sent, nothing goes.
  const stale = await call("POST", `${B}/send-batch`, { body: { kind: "next", size: 10, emails: next(2), confirm: "CONFIRM" } });
  assert.deepEqual([stale.status, stale.body.dropped.map((d) => d.reason)], [409, ["alreadySent", "alreadySent"]]);
  // The next group, read fresh: Dan and Max (Max's bought pass counts under Bought).
  const fresh = (await call("GET", `${B}/recipients?refresh=1`)).body.rows.filter((r) => r.ticket.groups.includes("bought") && r.willGet).map((r) => r.email);
  assert.deepEqual(fresh, ["dan.example@example.com", "max.example@example.com"]);
  // Filtered by Given instead: Max (his Apex Pass was given), Eve, Cora and Sid; Gus got it in the selection above.
  const given = (await call("GET", `${B}/recipients`)).body.rows.filter((r) => r.ticket.groups.includes("given") && r.willGet).map((r) => r.name.split(" ")[0]);
  assert.deepEqual(given, ["Max", "Eve", "Cora", "Sid"]);
  assert.equal(real().length, n + 2);
  assert.match((await audits("app_invite_send_next_start"))[0].detail, /^next 10: 2 to send/);
});
