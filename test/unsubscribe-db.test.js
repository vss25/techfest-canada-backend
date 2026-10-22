/* Unsubscribing (Oct 22 2026) against a real (throwaway) MongoDB: the email link's page and button, a mail app's
   one-click POST, Admin › Unsubscribed emails (list, paste, resubscribe for management only, audited), and that
   everyone on the list is left out of the app invite (its list, a single send and the last check before a send),
   the website's unsubscribe form and an older Audience campaign. Emails go to a stub (nothing is sent). Starts a
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
process.env.TRACKING_SECRET ||= "unsubscribe-db-test";
delete process.env.STRIPE_SECRET_KEY;

// Resend: single sends and batches are captured here, never delivered.
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.startsWith("https://api.resend.com/")) {
    const body = JSON.parse(opts?.body || "{}");
    const list = Array.isArray(body) ? body : [body];
    sent.push(...list);
    const ids = list.map((_, i) => ({ id: `re_${sent.length - list.length + i + 1}` }));
    return new Response(JSON.stringify(Array.isArray(body) ? { data: ids } : ids[0]), { status: 200, headers: { "content-type": "application/json" } });
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
let UN; // services/unsubscribe.js
const M = {};
const U = {};

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-unsubscribe-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_unsubscribe_test`, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await sleep(250); }
  }
  ({ default: jwt } = await import("jsonwebtoken"));
  UN = await import("../services/unsubscribe.js");
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.CampaignSend = await imp("../models/CampaignSend.js");
  M.Subscription = await imp("../models/Subscription.js");
  M.Audience = await imp("../models/Audience.js");
  M.Campaign = await imp("../models/Campaign.js");
  Object.assign(M, await import("../models/Admin.js"));
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/unsubscribe", await imp("../routes/unsubscribe.js"));
  app.use("/api/console/unsubscribes", await imp("../routes/unsubscribes.js"));
  app.use("/api/console/app-invite", await imp("../routes/appInvite.js"));
  app.use("/api/console/people", await imp("../routes/people.js"));
  app.use("/api/subscriptions", await imp("../routes/subscriptions.js"));
  app.use("/api/campaigns", await imp("../routes/campaigns.js"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const t = (ticketId) => ({ ticketId, type: "connect", promoCode: "", stripeSessionId: `cs_${ticketId}`, purchaseDate: new Date("2026-10-01") });
  const mk = async (k, doc) => { U[k] = await M.User.create(doc); };
  await mk("mia", { name: "Mia Example", email: "mia.example@example.com", role: "admin", staffRole: "management" });
  await mk("sam", { name: "Sam Example", email: "sam.example@example.com", role: "admin", staffRole: "staff" });
  await mk("ana", { name: "Ana Example", email: "ana.example@example.com", tickets: [t("un0000000001")] });
  await mk("bo", { name: "Bo Example", email: "bo.example@example.com", tickets: [t("un0000000002")] });
  await mk("cy", { name: "Cy Example", email: "cy.example@example.com", tickets: [t("un0000000003")] });
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

async function call(method, url, { as = U.mia, body, raw, type = "application/json" } = {}) {
  const headers = { "content-type": type };
  if (as) headers.authorization = `Bearer ${jwt.sign({ id: String(as._id) }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
  const r = await realFetch(base + url, { method, headers, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = text;
  try { json = JSON.parse(text); } catch { /* HTML or text */ }
  return { status: r.status, body: json };
}
const row = (email) => M.Subscription.findOne({ email }).lean();
const audits = (action) => M.AdminAudit.find({ action }).lean();
const tokenFor = (email) => UN.signUnsubscribe(email);

test("the email's link: GET shows a button and changes nothing; the button unsubscribes; again is harmless", { skip }, async () => {
  const t = tokenFor("ana.example@example.com");
  const page = await call("GET", `/api/unsubscribe?t=${t}`, { as: null });
  assert.equal(page.status, 200);
  assert.match(page.body, /Unsubscribe from The Tech Festival Canada emails\?/);
  assert.match(page.body, /<strong>a••••••@example\.com<\/strong>/, "their address, masked");
  assert.match(page.body, /<form method="post" action="\?t=/);
  assert.equal(await row("ana.example@example.com"), null, "a GET (a mail scanner) never unsubscribes");

  const done = await call("POST", `/api/unsubscribe?t=${t}`, { as: null, raw: "from=page", type: "application/x-www-form-urlencoded" });
  assert.equal(done.status, 200);
  assert.match(done.body, /You're unsubscribed/);
  const r = await row("ana.example@example.com");
  assert.deepEqual([r.subscribed, r.unsubscribeSource, r.source, r.unsubscribedBy], [false, "link", "unsubscribe", ""]);
  const firstAt = r.unsubscribedAt.getTime();

  await sleep(5);
  const again = await call("POST", `/api/unsubscribe?t=${t}`, { as: null, raw: "from=page", type: "application/x-www-form-urlencoded" });
  assert.equal(again.status, 200);
  assert.equal((await row("ana.example@example.com")).unsubscribedAt.getTime(), firstAt, "the first date is kept");
  assert.equal(await M.Subscription.countDocuments({ email: "ana.example@example.com" }), 1);
});

test("a mail app's own Unsubscribe button (RFC 8058 one-click POST) records it; bad tokens don't", { skip }, async () => {
  const t = tokenFor("bo.example@example.com");
  const r = await call("POST", `/api/unsubscribe?t=${t}`, { as: null, raw: "List-Unsubscribe=One-Click", type: "application/x-www-form-urlencoded" });
  assert.deepEqual([r.status, r.body], [200, { ok: true }]);
  assert.deepEqual([(await row("bo.example@example.com")).subscribed, (await row("bo.example@example.com")).unsubscribeSource], [false, "one-click"]);

  const forged = `${Buffer.from("cy.example@example.com").toString("base64url")}.${t.split(".")[1]}`;
  assert.equal((await call("POST", `/api/unsubscribe?t=${forged}`, { as: null, raw: "List-Unsubscribe=One-Click", type: "application/x-www-form-urlencoded" })).status, 400);
  assert.equal((await call("GET", `/api/unsubscribe?t=${forged}`, { as: null })).status, 400);
  assert.equal(await row("cy.example@example.com"), null);
  const prev = await call("GET", "/api/unsubscribe/preview", { as: null });
  assert.equal(prev.status, 200);
  assert.match(prev.body, /Nothing has changed/);
});

test("Admin › Unsubscribed emails: staff see and paste; management resubscribe; every change audited", { skip }, async () => {
  const list = await call("GET", "/api/console/unsubscribes", { as: U.sam });
  assert.equal(list.status, 200);
  assert.equal(list.body.canEdit, false);
  assert.deepEqual(list.body.rows.map((x) => [x.email, x.source, x.sourceLabel]), [
    ["bo.example@example.com", "one-click", "Used their mail app's Unsubscribe button"],
    ["ana.example@example.com", "link", "Clicked Unsubscribe in an email"],
  ]);
  assert.equal((await call("GET", "/api/console/unsubscribes", { as: null })).status, 401);

  const pasted = `From: Cy Example <Cy.Example@example.com>\nunsubscribe\n\nana.example@example.com, dee@example.org; oops@`;
  const add = await call("POST", "/api/console/unsubscribes", { as: U.sam, body: { emails: pasted } });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  assert.deepEqual([add.body.added, add.body.already, add.body.emails, add.body.invalid], [2, 1, ["cy.example@example.com", "ana.example@example.com", "dee@example.org"], ["oops@"]]);
  const cy = await row("cy.example@example.com");
  assert.deepEqual([cy.subscribed, cy.unsubscribeSource, cy.unsubscribedBy], [false, "staff", "sam.example@example.com"]);
  assert.equal((await row("ana.example@example.com")).unsubscribeSource, "link", "already on the list: unchanged");
  assert.match((await audits("unsubscribe_add"))[0].detail, /^2 added, 1 already on the list: cy\.example@example\.com, ana\.example@example\.com, dee@example\.org$/);
  assert.equal((await call("POST", "/api/console/unsubscribes", { as: U.sam, body: { emails: "nothing here" } })).status, 400);

  assert.equal((await call("POST", "/api/console/unsubscribes/remove", { as: U.sam, body: { email: "dee@example.org" } })).status, 403);
  const rm = await call("POST", "/api/console/unsubscribes/remove", { body: { email: "Dee@Example.org" } });
  assert.deepEqual([rm.status, rm.body.removed], [200, true]);
  assert.equal((await row("dee@example.org")).subscribed, true);
  assert.equal((await audits("unsubscribe_remove"))[0].detail, "dee@example.org");
  assert.equal((await call("POST", "/api/console/unsubscribes/remove", { body: { email: "dee@example.org" } })).status, 404);
  const after = await call("GET", "/api/console/unsubscribes?q=example.com");
  assert.deepEqual([after.body.count, after.body.canEdit, after.body.rows.length], [3, true, 3]);
});

test("the app invite leaves them out: the list, a single send and the last check before a send", { skip }, async () => {
  const rec = await call("GET", "/api/console/app-invite/recipients?skipUsing=0");
  assert.equal(rec.status, 200, JSON.stringify(rec.body).slice(0, 300));
  const reason = (e) => rec.body.rows.find((x) => x.email === e)?.reason;
  assert.deepEqual(["ana.example@example.com", "bo.example@example.com", "cy.example@example.com"].map(reason), ["unsubscribed", "unsubscribed", "unsubscribed"]);
  const one = await call("POST", "/api/console/app-invite/send-one", { as: U.sam, body: { email: "ana.example@example.com" } });
  assert.deepEqual([one.status, one.body.code], [409, "unsubscribed"]);

  // Someone who unsubscribes after the list was read: the sender's own last check leaves them out.
  const { makeInviteSender } = await import("../services/appInviteSend.js");
  const mails = [];
  const sendTo = makeInviteSender({ CampaignSend: M.CampaignSend, template: { copy: {} }, send: async ({ to }) => { mails.push(to); return { id: "re_x" }; } });
  await UN.recordUnsubscribe(M.Subscription, "eve@example.com", { source: "one-click" });
  assert.equal(await sendTo({ email: "eve@example.com", name: "Eve" }, "staff"), "unsubscribed");
  assert.ok((await sendTo({ email: "fay@example.com", name: "Fay" }, "staff")) instanceof Date);
  assert.deepEqual(mails, ["fay@example.com"]);
  assert.equal(await M.CampaignSend.countDocuments({ email: "eve@example.com" }), 0, "nothing claimed for them");
  assert.equal(sent.length, 0, "nothing reached Resend");
});

test("the website's unsubscribe form and an older Audience campaign use the same list", { skip }, async () => {
  const w = await call("POST", "/api/subscriptions/unsubscribe", { as: null, body: { email: "Gus@Example.com" } });
  assert.equal(w.status, 200);
  assert.deepEqual([(await row("gus@example.com")).subscribed, (await row("gus@example.com")).unsubscribeSource], [false, "website"]);

  const audience = await M.Audience.create({ name: "Test list", contacts: [{ email: "gus@example.com" }, { email: "hal@example.com" }, { email: "ana.example@example.com" }] });
  const campaign = await M.Campaign.create({ name: "Older campaign", subject: "Hello", template: "<p>Hello {{firstname}}</p>", audienceId: audience._id });
  const go = await call("POST", `/api/campaigns/${campaign._id}/launch`);
  assert.equal(go.status, 200, JSON.stringify(go.body));
  assert.equal(go.body.recipientCount, 1);
  assert.match(go.body.message, /\(2 unsubscribed, left out\)/);
  // The launch sends in the background: wait until it has saved the campaign as sent.
  for (let i = 0; i < 80 && (await M.Campaign.findById(campaign._id).lean()).status === "sending"; i++) await sleep(50);
  assert.equal((await M.Campaign.findById(campaign._id).lean()).status, "sent");
  assert.deepEqual(sent.map((m) => [].concat(m.to)[0]), ["hal@example.com"]);
});
