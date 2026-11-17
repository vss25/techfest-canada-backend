/* Phase 0 sales safety (Nov 2026) through the real routes, against a real (throwaway) MongoDB:
     - an event with no EventConfig row, or with pricing not announced, sells and quotes nothing;
     - only management changes what is sold (event details, pricing announced, quantity discount,
       ticket types); staff may still set attendee visibility and read the lists;
     - the event's automatic quantity discount is validated and used by the quote;
     - a $0 order needs a signed-in buyer, then issues one pass per attendee.
   Starts a local mongod in a temp folder (skipped without the binary: TTFC_TEST_MONGOD, else
   ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Resend and Sanity are stubbed; no Stripe
   key, so paid checkouts are not exercised here. Fictional people, example.com. */
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

const outbox = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.startsWith("https://api.resend.com/")) {
    const body = JSON.parse(opts?.body || "{}");
    outbox.push({ to: [].concat(body.to || []), subject: body.subject || "" });
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
let mia, sam, buyer;
const EV = "vancouver-2027-briefing";

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-sales-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_sales_safety_test`, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  ({ default: jwt } = await import("jsonwebtoken"));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.Attendee = await imp("../models/Attendee.js");
  M.EventConfig = await imp("../models/EventConfig.js");
  M.TicketType = await imp("../models/TicketType.js");
  M.Order = await imp("../models/Order.js");
  M.Promo = await imp("../models/Promo.js");
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/admin/events", await imp("../routes/adminEvents.js"));
  app.use("/api/admin/ticket-types", await imp("../routes/adminTicketTypes.js"));
  app.use("/api/tickets", await imp("../routes/ticketsQuote.js"));
  app.use("/api/orders", await imp("../routes/orders.js"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  mia = await M.User.create({ name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management" });
  sam = await M.User.create({ name: "Sam Staff", email: "sam.staff@example.com", role: "admin", staffRole: "staff" });
  buyer = await M.User.create({ name: "Bea Buyer", email: "bea.buyer@example.com", role: "user" });
});

after(async () => {
  if (!HAVE) return;
  server?.close();
  await mongoose?.disconnect().catch(() => {});
  if (mongod && mongod.exitCode === null) {
    const exited = new Promise((r) => mongod.once("exit", r));
    mongod.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  }
  fs.rmSync(dbDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const tok = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET);
async function call(method, url, body, user) {
  const r = await fetch(base + url, {
    method,
    headers: { "content-type": "application/json", ...(user ? { authorization: `Bearer ${tok(user)}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await r.json(); } catch { /* empty */ }
  return { status: r.status, body: json };
}

test("events: only management creates; staff can't change what is sold but can set visibility", { skip }, async () => {
  const staffCreate = await call("POST", "/api/admin/events", { eventKey: EV, name: "Vancouver Briefing" }, sam);
  assert.equal(staffCreate.status, 403);
  assert.equal(staffCreate.body.code, "management_only");

  const created = await call("POST", "/api/admin/events", { eventKey: EV, name: "Vancouver Briefing", city: "vancouver", type: "briefing", year: 2027 }, mia);
  assert.equal(created.status, 201);

  for (const body of [
    { settings: { pricingAnnounced: true } },
    { settings: { quantityDiscount: { enabled: true, minQuantity: 5, percent: 10 } } },
    { startDate: "2027-02-10" },
    { status: "announced" }
  ]) {
    const r = await call("PATCH", `/api/admin/events/${EV}`, body, sam);
    assert.equal(r.status, 403, JSON.stringify(body));
  }
  const vis = await call("PATCH", `/api/admin/events/${EV}`, { attendeeVisibility: { mode: "names" } }, sam);
  assert.equal(vis.status, 200);
  assert.equal(vis.body.attendeeVisibility.mode, "names");
});

test("quantity discount: validated, then saved by management", { skip }, async () => {
  for (const q of [{ minQuantity: 1 }, { percent: 0 }, { percent: 120 }, { enabled: "yes" }, "ten"]) {
    const r = await call("PATCH", `/api/admin/events/${EV}`, { settings: { quantityDiscount: q } }, mia);
    assert.equal(r.status, 400, JSON.stringify(q));
  }
  const ok = await call("PATCH", `/api/admin/events/${EV}`, { settings: { quantityDiscount: { enabled: true, minQuantity: 5, percent: 10 } } }, mia);
  assert.equal(ok.status, 200);
  assert.deepEqual(
    { ...ok.body.settings.quantityDiscount },
    { enabled: true, minQuantity: 5, percent: 10 }
  );
});

test("ticket types: staff read the list, only management creates, edits and removes", { skip }, async () => {
  const denied = await call("POST", "/api/admin/ticket-types", { eventKey: EV, name: "General", priceCents: 20000 }, sam);
  assert.equal(denied.status, 403);
  const made = await call("POST", "/api/admin/ticket-types", { eventKey: EV, name: "General", priceCents: 20000 }, mia);
  assert.equal(made.status, 201);
  const free = await call("POST", "/api/admin/ticket-types", { eventKey: EV, name: "Community", priceCents: 0 }, mia);
  assert.equal(free.status, 201);
  const list = await call("GET", `/api/admin/ticket-types?eventKey=${EV}`, undefined, sam);
  assert.equal(list.status, 200);
  const edit = await call("PATCH", `/api/admin/ticket-types/${made.body._id}`, { priceCents: 1 }, sam);
  assert.equal(edit.status, 403);
  const del = await call("DELETE", `/api/admin/ticket-types/${made.body._id}`, undefined, sam);
  assert.equal(del.status, 403);
});

test("pricing gate fails closed: no event row, or not announced → nothing quoted or sold", { skip }, async () => {
  const general = await M.TicketType.findOne({ eventKey: EV, name: "General" });
  const ghost = await M.TicketType.create({ eventKey: "no-such-event", name: "Ghost", priceCents: 100 });

  const noRow = await call("POST", "/api/tickets/quote", { eventKey: "no-such-event", ticketTypeId: String(ghost._id), quantity: 1 });
  assert.deepEqual(noRow.body, { announced: false });
  const noRowTypes = await call("GET", "/api/tickets/types?eventKey=no-such-event");
  assert.deepEqual(noRowTypes.body, { announced: false, types: [] });
  const noRowBuy = await call("POST", "/api/orders/multi-checkout", {
    eventKey: "no-such-event", booker: { email: "x@example.com" },
    items: [{ ticketTypeId: String(ghost._id), quantity: 1 }],
    attendees: [{ firstName: "X", lastName: "Y", email: "x@example.com", ticketTypeId: String(ghost._id) }]
  });
  assert.equal(noRowBuy.status, 409);

  const unannounced = await call("POST", "/api/tickets/quote", { eventKey: EV, ticketTypeId: String(general._id), quantity: 1 });
  assert.deepEqual(unannounced.body, { announced: false });
});

test("once announced, the quote applies the event's quantity discount", { skip }, async () => {
  const r = await call("PATCH", `/api/admin/events/${EV}`, { settings: { pricingAnnounced: true } }, mia);
  assert.equal(r.status, 200);
  const general = await M.TicketType.findOne({ eventKey: EV, name: "General" });
  const four = await call("POST", "/api/tickets/quote", { eventKey: EV, ticketTypeId: String(general._id), quantity: 4 });
  assert.equal(four.body.totalCents, 80000);
  const five = await call("POST", "/api/tickets/quote", { eventKey: EV, ticketTypeId: String(general._id), quantity: 5 });
  assert.equal(five.body.eventDiscountCents, 10000);
  assert.equal(five.body.totalCents, 90000);
  assert.deepEqual(five.body.quantityDiscount, { minQuantity: 5, percent: 10 });
});

test("a $0 order needs a signed-in buyer, then issues one pass per attendee", { skip }, async () => {
  const community = await M.TicketType.findOne({ eventKey: EV, name: "Community" });
  const order = {
    eventKey: EV,
    booker: { name: "Bea Buyer", email: "bea.buyer@example.com" },
    items: [{ ticketTypeId: String(community._id), quantity: 2 }],
    attendees: [
      { firstName: "Bea", lastName: "Buyer", email: "bea.buyer@example.com", ticketTypeId: String(community._id) },
      { firstName: "Cal", lastName: "Colleague", email: "cal.colleague@example.com", ticketTypeId: String(community._id) }
    ]
  };
  const anon = await call("POST", "/api/orders/multi-checkout", order);
  assert.equal(anon.status, 401);
  assert.equal(anon.body.code, "sign_in_required");
  assert.equal(await M.Attendee.countDocuments({ eventKey: EV }), 0);

  const signed = await call("POST", "/api/orders/multi-checkout", order, buyer);
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  assert.equal(signed.body.free, true);
  assert.equal(await M.Attendee.countDocuments({ eventKey: EV }), 2);
  const saved = await M.Order.findById(signed.body.orderId).lean();
  assert.equal(saved.status, "fulfilled");
});

test("a server error never leaks its message to the buyer", { skip }, async () => {
  const general = await M.TicketType.findOne({ eventKey: EV, name: "General" });
  // No Stripe key in the test: creating the paid session throws inside the route.
  const r = await call("POST", "/api/orders/multi-checkout", {
    eventKey: EV, booker: { email: "bea.buyer@example.com" },
    items: [{ ticketTypeId: String(general._id), quantity: 1 }],
    attendees: [{ firstName: "Bea", lastName: "Buyer", email: "bea.buyer@example.com", ticketTypeId: String(general._id) }]
  }, buyer);
  assert.equal(r.status, 500);
  assert.equal(r.body.error, "Checkout failed. Please try again.");
});
