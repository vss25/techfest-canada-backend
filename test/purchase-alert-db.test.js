/* The organisers' "New ticket" email through the real Stripe webhook, against a real (throwaway) MongoDB:
     - a paid ticket checkout: the ticket, the buyer's email, then one alert (reply-to the buyer);
     - Stripe delivering the same event again, or twice at once: still one alert;
     - booths are alerted (labelled Booth); India Pavilion deposits and pass upgrades are not;
     - passes staff issue (Issue passes, exhibitor passes) never send one;
     - an alert Resend refuses changes nothing for the ticket, the buyer's email or Stripe's answer.
   Starts a local mongod in a temp folder on a free port and stops it after; skipped when the binary isn't
   there (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Nothing leaves the
   machine: Resend and Sanity are answered by a stubbed fetch, Stripe is never called (the events are signed
   here with a local secret), the alert goes to example.com addresses. Fictional people, example.com. */
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
process.env.RESEND_API_KEY = "re_dummy";
process.env.PURCHASE_ALERT_TO = "alerts.one@example.com, alerts.two@example.com";
delete process.env.STRIPE_SECRET_KEY;

const ALERT_TO = ["alerts.one@example.com", "alerts.two@example.com"];
/** Every email the server tried to send (Resend is stubbed: nothing is delivered). */
const outbox = [];
let refuseAlerts = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.startsWith("https://api.resend.com/")) {
    const body = JSON.parse(opts?.body || "{}");
    const to = [].concat(body.to || []);
    const isAlert = to.includes(ALERT_TO[0]);
    if (isAlert && refuseAlerts) {
      return new Response(JSON.stringify({ name: "application_error", message: "Resend is down (test)" }), { status: 500, headers: { "content-type": "application/json" } });
    }
    outbox.push({ to, subject: body.subject || "", text: body.text || "", html: body.html || "", reply_to: body.reply_to, isAlert });
    return new Response(JSON.stringify({ id: `stub_${outbox.length}` }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.includes(".sanity.io/")) return new Response(JSON.stringify({ result: [] }), { status: 200, headers: { "content-type": "application/json" } });
  throw new Error(`blocked in the test: ${url}`);
};

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });

let mongod = null;
let dbDir = "";
let server = null;
let base = "";
let M = {};
let jwt;
let mongoose;
let Stripe;
let mia;

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-alert-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_purchase_alert_test`, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  ({ default: jwt } = await import("jsonwebtoken"));
  ({ default: Stripe } = await import("stripe"));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.Attendee = await imp("../models/Attendee.js");
  M.TicketInventory = await imp("../models/TicketInventory.js");
  M.CampaignSend = await imp("../models/CampaignSend.js");
  M.PavilionApplication = await imp("../models/PavilionApplication.js");
  Object.assign(M, await import("../models/Admin.js"));
  await M.CampaignSend.init();   // the unique index, before anything races for it
  const { default: express } = await import("express");
  const app = express();
  // The webhook builds its Stripe client on import: a dummy key only for that (nothing here calls Stripe).
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_local_test";
  app.use("/api/webhook", express.raw({ type: "application/json" }), (await import("../routes/webhook.js")).default);
  delete process.env.STRIPE_SECRET_KEY;
  app.use(express.json());
  const { issuedPassRouter } = await import("../routes/issuedPasses.js");
  app.use("/api/console/issued-passes", issuedPassRouter("issued"));
  app.use("/api/console/exhibitor-passes", issuedPassRouter("exhibitor"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  mia = await M.User.create({ name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management" });
  await M.TicketInventory.create([
    { tier: "power", total: 100, sold: 10, price: 999 },
    { tier: "apex", total: 50, sold: 5, price: 1499 },
    { tier: "booth-single", total: 20, sold: 2, price: 5000 },
  ]);
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const tokenFor = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function call(method, url, { body } = {}) {
  const r = await realFetch(base + url, {
    method, headers: { "content-type": "application/json", authorization: `Bearer ${tokenFor(mia)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(50); }
  return false;
};
const alerts = () => outbox.filter((m) => m.isAlert);

/** Stripe says this checkout completed (a signed test event, built here; nothing reaches Stripe). */
function deliver(session, { eventId = `evt_${session.id}` } = {}) {
  const payload = JSON.stringify({ id: eventId, type: "checkout.session.completed", created: 1792432440, data: { object: session } });
  const header = new Stripe("sk_test_dummy").webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  return realFetch(`${base}/api/webhook/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload });
}
const ticketSession = (id, over = {}) => ({
  id, object: "checkout.session", mode: "payment", status: "complete", livemode: false, payment_status: "paid",
  payment_intent: `pi_${id.replace(/[^A-Za-z0-9]/g, "")}`, currency: "cad",
  amount_subtotal: 99900, amount_total: 90310, total_details: { amount_discount: 19980, amount_tax: 10390 },
  customer_details: { email: "jane.doe@example.com", name: "Jane Doe" },
  ...over,
  metadata: {
    firstName: "Jane", lastName: "Doe", email: "jane.doe@example.com", organisation: "Example Robotics", jobTitle: "Head of Innovation",
    client: "web", type: "ticket", tier: "power", basePrice: "999", taxMode: "manual", taxPercent: "13", promoCode: "SPRING20", discount: "20",
    src_visit: "utm: linkedin / social / oct-launch · landed /tickets · referrer linkedin.com · Oct 19, 2:14 p.m. Toronto time",
    src_first: "same as this visit",
    ...(over.metadata || {}),
  },
});

test("a paid ticket: the ticket, the buyer's email, then one alert to PURCHASE_ALERT_TO, reply-to the buyer; a second delivery sends nothing", { skip }, async () => {
  const before = outbox.length;
  const r = await deliver(ticketSession("cs_test_jane1"));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { received: true });
  const att = await M.Attendee.findOne({ stripeSessionId: "cs_test_jane1" }).lean();
  assert.ok(att, "ticket saved");
  // Nothing from the source fields in the saved details.
  assert.equal(JSON.stringify(att.details).includes("linkedin / social"), false);
  assert.ok(!("src_visit" in att.details) && !("src_first" in att.details));

  assert.ok(await waitFor(() => alerts().length === 1), "alert sent");
  const buyerMail = outbox.slice(before).find((m) => m.to.includes("jane.doe@example.com"));
  assert.ok(buyerMail, "buyer's ticket email sent");
  assert.ok(outbox.indexOf(buyerMail) < outbox.indexOf(alerts()[0]), "the buyer's email goes first");
  const a = alerts()[0];
  assert.deepEqual(a.to, ALERT_TO);
  assert.equal(a.reply_to, "jane.doe@example.com");
  assert.equal(a.subject, "New ticket: Power Pass · Jane Doe · CA$903.10");
  for (const want of [
    `Ticket ID: ${att.ticketId}`, "Code: SPRING20 (20% off)", "Total paid: CA$903.10", "Bought on: Website",
    "This visit: utm: linkedin / social / oct-launch · landed /tickets · referrer linkedin.com", "First visit: same as this visit",
    "App account: No account yet", "Stripe payment: pi_cstestjane1 (https://dashboard.stripe.com/test/payments/pi_cstestjane1)",
    `/admin/people/t-${att.ticketId}`,
  ]) assert.ok(a.text.includes(want), `missing ${want}`);
  const row = await M.CampaignSend.findOne({ campaign: "purchase-alert-2026", email: "cs_test_jane1" }).lean();
  assert.equal(row.status, "sent");
  assert.ok(row.resendId);

  // Stripe retries the same event: no second ticket, no second alert.
  const again = await deliver(ticketSession("cs_test_jane1"), { eventId: "evt_retry" });
  assert.equal(again.status, 200);
  await sleep(400);
  assert.equal(alerts().length, 1);
  assert.equal(await M.Attendee.countDocuments({ stripeSessionId: "cs_test_jane1" }), 1);
});

test("a signed-in buyer and a $0 checkout with a 100% code: alerted, $0.00, the code, the account", { skip }, async () => {
  const sam = await M.User.create({ name: "Sam Signedin", email: "sam.signedin@example.com" });
  const n = alerts().length;
  const r = await deliver(ticketSession("cs_test_sam0", {
    payment_status: "no_payment_required", payment_intent: null,
    amount_subtotal: 149900, amount_total: 0, total_details: { amount_discount: 149900, amount_tax: 0 },
    customer_details: { email: "sam.signedin@example.com", name: "Sam Signedin" },
    metadata: { tier: "apex", userId: String(sam._id), firstName: "Sam", lastName: "Signedin", email: "sam.signedin@example.com",
      promoCode: "FULL100", discount: "100", client: "ios", src_visit: "", src_first: "" },
  }));
  assert.equal(r.status, 200);
  assert.ok(await waitFor(() => alerts().length === n + 1));
  const a = alerts().at(-1);
  assert.equal(a.subject, "New ticket: Apex Pass · Sam Signedin · CA$0.00");
  for (const want of ["Code: FULL100 (100% off)", "Status: Nothing to pay: the code covered the full price", "Bought on: iOS app",
    "This visit: Not known (bought in the iOS app)", "App account: Yes, bought while signed in"]) assert.ok(a.text.includes(want), `missing ${want}`);
  assert.equal((await M.User.findById(sam._id).lean()).tickets.length, 1);
});

test("a booth: alerted and labelled Booth; two deliveries at the same moment still send one alert", { skip }, async () => {
  const n = alerts().length;
  const s = ticketSession("cs_test_booth1", {
    amount_subtotal: 500000, amount_total: 565000, total_details: { amount_discount: 0, amount_tax: 65000 },
    customer_details: { email: "sales@acme.example.com", name: "Acme Robotics Inc." },
    metadata: { type: "booth", tier: "booth-single", promoCode: "", discount: "0", firstName: "", lastName: "", email: "", organisation: "", jobTitle: "" },
  });
  const [r1, r2] = await Promise.all([deliver(s, { eventId: "evt_b1" }), deliver(s, { eventId: "evt_b2" })]);
  assert.deepEqual([r1.status, r2.status], [200, 200]);
  assert.ok(await waitFor(() => alerts().length === n + 1));
  await sleep(400);
  assert.equal(alerts().length, n + 1);
  const a = alerts().at(-1);
  assert.equal(a.subject, "New booth: Exhibition Booth — Single · Acme Robotics Inc. · CA$5,650.00");
  assert.match(a.text, /^Booth: Exhibition Booth — Single$/m);
  assert.match(a.text, /^Code: No code$/m);
  assert.equal(a.reply_to, "sales@acme.example.com");
});

test("no alert for India Pavilion deposits or pass upgrades", { skip }, async () => {
  const n = alerts().length;
  const dep = await deliver({
    id: "cs_test_dep1", object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid", currency: "cad",
    amount_subtotal: 50000, amount_total: 56500, total_details: { amount_discount: 0, amount_tax: 6500 },
    customer_details: { email: "founder@startup.example.com", name: "Ravi Founder" },
    metadata: { type: "pavilion-deposit", companyName: "Startup Example", contactEmail: "founder@startup.example.com", applicationRef: "IP-7K3QXM" },
  });
  assert.equal(dep.status, 200);
  const una = await M.User.create({ name: "Una Upgrade", email: "una.upgrade@example.com", tickets: [{ ticketId: "una000000001", type: "power", stripeSessionId: "cs_una" }] });
  const up = await deliver({
    id: "cs_test_up1", object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid", currency: "cad",
    amount_subtotal: 50000, amount_total: 56500, total_details: { amount_discount: 0, amount_tax: 6500 },
    customer_details: { email: "una.upgrade@example.com", name: "Una Upgrade" },
    metadata: { type: "upgrade", tier: "apex", userId: String(una._id), upgradeFrom: "una000000001", fromTier: "power", client: "web" },
  });
  assert.equal(up.status, 200);
  await sleep(500);
  assert.equal(alerts().length, n);
  assert.equal(await M.CampaignSend.countDocuments({ campaign: "purchase-alert-2026", email: { $in: ["cs_test_dep1", "cs_test_up1"] } }), 0);
});

test("passes staff issue never send an alert: Issue passes and exhibitor passes, made and sent", { skip }, async () => {
  const n = alerts().length;
  const before = outbox.length;
  for (const kind of ["issued-passes", "exhibitor-passes"]) {
    const made = await call("POST", `/api/console/${kind}`, { body: { name: `Gia ${kind}`, email: `gia.${kind}@example.com`, tier: "connect" } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const sent = await call("POST", `/api/console/${kind}/${made.body.row.id}/send`, { body: {} });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
  }
  await sleep(400);
  assert.equal(outbox.length, before + 2, "the two pass emails only");
  assert.equal(alerts().length, n);
});

test("an alert Resend refuses changes nothing else: ticket saved, buyer emailed, Stripe answered 200; marked failed", { skip }, async () => {
  refuseAlerts = true;
  try {
    const n = alerts().length;
    const r = await deliver(ticketSession("cs_test_down1", { customer_details: { email: "dee.down@example.com", name: "Dee Down" },
      metadata: { firstName: "Dee", lastName: "Down", email: "dee.down@example.com" } }));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { received: true });
    assert.ok(await M.Attendee.exists({ stripeSessionId: "cs_test_down1" }));
    assert.ok(outbox.some((m) => m.to.includes("dee.down@example.com")), "buyer's email sent");
    assert.ok(await waitFor(async () => (await M.CampaignSend.findOne({ campaign: "purchase-alert-2026", email: "cs_test_down1" }).lean())?.status === "failed"));
    assert.equal(alerts().length, n);
  } finally {
    refuseAlerts = false;
  }
});
