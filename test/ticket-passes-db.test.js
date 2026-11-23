/* Ticket counters, own prices per event and multi-event passes (Nov 22 2026, the owner) through the real
   routes, against a real (throwaway) MongoDB:
     - a Briefing gets its own copy of the default tickets (when staff open it, when it's created), so a
       price change on one event never changes another's;
     - each ticket type's sold count is 0 until a paid order, counted once (issued passes from orders
       aren't counted again for capacity), and an order made on the shared default ticket counts towards
       the event's own copy;
     - a "City + Toronto" pass must include the Main Event, shows on every event it covers (public list
       and checkout), and buying it issues one pass per covered event; it's counted on its own line and
       in each covered event's tickets (the delegate target).
   Starts a local mongod (skipped without the binary, like the other -db tests). Nothing leaves the
   machine: Resend and Sanity are stubbed, no Stripe key ($0 orders only). Fictional people, example.com. */
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
    outbox.push(JSON.parse(opts?.body || "{}"));
    return new Response(JSON.stringify({ id: `stub_${outbox.length}` }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.includes(".sanity.io/")) return new Response(JSON.stringify({ result: [] }), { status: 200, headers: { "content-type": "application/json" } });
  throw new Error(`blocked in the test: ${url}`);
};

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });

const VAN = "ttfc-2027-vancouver-briefing";
const CAL = "ttfc-2027-calgary-briefing";
const MTL = "ttfc-2027-montreal-briefing";
const TOR = "ttfc-2027-toronto-main";

let mongod = null, dbDir = "", server = null, base = "", mongoose, jwt;
const M = {};
let mia, sam, buyer;

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-passes-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_passes_test`, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  ({ default: jwt } = await import("jsonwebtoken"));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.Attendee = await imp("../models/Attendee.js");
  M.Order = await imp("../models/Order.js");
  M.TicketType = await imp("../models/TicketType.js");
  M.EventConfig = await imp("../models/EventConfig.js");
  await M.TicketType.init();
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/admin/ticket-types", await imp("../routes/adminTicketTypes.js"));
  app.use("/api/admin/events", await imp("../routes/adminEvents.js"));
  app.use("/api/tickets", await imp("../routes/ticketsQuote.js"));
  app.use("/api/orders", await imp("../routes/orders.js"));
  app.use("/api/console/sales-event", await imp("../routes/salesEvent.js"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  mia = await M.User.create({ name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management" });
  sam = await M.User.create({ name: "Sam Staff", email: "sam.staff@example.com", role: "admin", staffRole: "staff" });
  buyer = await M.User.create({ name: "Bea Buyer", email: "bea.buyer@example.com" });
  const announced = { settings: { pricingAnnounced: true } };
  await M.EventConfig.create([
    { eventKey: VAN, name: "Vancouver Briefing", ...announced },
    { eventKey: CAL, name: "Calgary Briefing", ...announced },
    { eventKey: TOR, name: "Toronto Main Event", ...announced },
  ]);
  await M.TicketType.create([
    { eventKey: "default-briefing", name: "Delegate", slug: "delegate", priceCents: 14900, capacity: 3, sortOrder: 1 },
    { eventKey: "default-briefing", name: "VIP", slug: "vip", priceCents: 29900, sortOrder: 2 },
    { eventKey: TOR, name: "Power", slug: "power", priceCents: 99900 },
  ]);
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const tokenFor = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function call(method, url, { as = mia, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (as) headers.authorization = `Bearer ${tokenFor(as)}`;
  const r = await realFetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const forEvent = async (k) => (await call("GET", `/api/admin/ticket-types/for-event?eventKey=${k}`)).body;
const person = (first, typeId) => ({ firstName: first, lastName: "Example", email: `${first.toLowerCase()}@example.com`, ticketTypeId: String(typeId) });

test("an order on the shared default ticket, made before copies existed, counts towards the event's own copy", { skip }, async () => {
  const shared = await M.TicketType.findOne({ eventKey: "default-briefing", slug: "delegate" });
  await M.Order.create({
    booker: { name: "Old Order", email: "old.order@example.com" }, eventKey: VAN, status: "fulfilled",
    items: [{ ticketTypeId: shared._id, name: "Delegate", slug: "delegate", unitPriceCents: 14900, quantity: 2 }],
    attendees: [], amounts: { subtotalCents: 29800, totalCents: 29800 },
  });
  // Its passes were issued by the order: they must not be counted a second time.
  await M.Attendee.create([1, 2].map((n) => ({ name: `Old ${n}`, email: `old${n}@example.com`, ticketId: `old00000000${n}`, ticketType: "delegate", eventKey: VAN, details: { orderId: "x" } })));
});

test("every event has its own prices and its own counter, 0 until a sale", { skip }, async () => {
  const van = await forEvent(VAN);
  assert.equal(van.source, "event", "Vancouver got its own copy when staff opened it");
  assert.deepEqual(van.ticketTypes.map((t) => [t.slug, t.sold]), [["delegate", 2], ["vip", 0]]);
  const cal = await forEvent(CAL);
  assert.deepEqual(cal.ticketTypes.map((t) => [t.slug, t.sold]), [["delegate", 0], ["vip", 0]]);
  assert.notEqual(String(van.ticketTypes[0]._id), String(cal.ticketTypes[0]._id));
  // A price change on Calgary leaves Vancouver and the defaults alone.
  const r = await call("PATCH", `/api/admin/ticket-types/${cal.ticketTypes[0]._id}`, { body: { priceCents: 9900 } });
  assert.equal(r.status, 200);
  assert.equal((await forEvent(VAN)).ticketTypes[0].priceCents, 14900);
  assert.equal((await M.TicketType.findOne({ eventKey: "default-briefing", slug: "delegate" })).priceCents, 14900);
  // Toronto Main never used the defaults.
  assert.deepEqual((await forEvent(TOR)).ticketTypes.map((t) => [t.slug, t.sold]), [["power", 0]]);
});

test("a new Briefing starts with its own copy of the defaults", { skip }, async () => {
  const r = await call("POST", "/api/admin/events", { body: { eventKey: MTL, name: "Montreal Briefing" } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(await M.TicketType.countDocuments({ eventKey: MTL }), 2);
  assert.equal(await (await import("../services/ticketTypeDefaults.js")).ensureOwnCopy(MTL), 0, "never copied twice");
});

test("capacity counts each sold ticket once (it used to count order passes twice)", { skip }, async () => {
  const { soldOrReserved } = await import("../services/ticketSales.js");
  const van = await M.TicketType.findOne({ eventKey: VAN, slug: "delegate" });
  assert.equal(await soldOrReserved(VAN, van), 2);
  await M.Attendee.create({ name: "Comp Guest", email: "comp@example.com", ticketId: "comp00000001", ticketType: "delegate", eventKey: VAN });
  assert.equal(await soldOrReserved(VAN, van), 3, "a pass staff issued by hand still counts");
});

let pass;
test("a pass must include the Main Event and at least one city; only management makes one", { skip }, async () => {
  const base = { eventKey: "multi-event", name: "Vancouver + Toronto", priceCents: 0 };
  assert.equal((await call("POST", "/api/admin/ticket-types", { body: { ...base, covers: [VAN] } })).status, 400);
  assert.equal((await call("POST", "/api/admin/ticket-types", { body: { ...base, covers: [VAN, CAL] } })).body.error, "A pass always includes the Main Event.");
  assert.equal((await call("POST", "/api/admin/ticket-types", { body: { ...base, covers: [VAN, "ttfc-2027-nowhere-briefing", TOR] } })).status, 400);
  assert.equal((await call("POST", "/api/admin/ticket-types", { body: { ...base, covers: [VAN, TOR] }, as: sam })).status, 403);
  assert.equal((await call("POST", "/api/admin/ticket-types", { body: { eventKey: VAN, name: "X", priceCents: 1, covers: [TOR] } })).status, 400, "an event's own ticket covers nothing");
  const r = await call("POST", "/api/admin/ticket-types", { body: { ...base, covers: [VAN, TOR, VAN] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  pass = r.body.ticketType;
  assert.deepEqual(pass.covers, [VAN, TOR]);
  assert.equal(pass.slug, "pass-vancouver-toronto");
});

test("the pass shows on every event it covers, and only those", { skip }, async () => {
  for (const k of [VAN, TOR]) {
    const r = await call("GET", `/api/tickets/types?eventKey=${k}`, { as: null });
    const p = r.body.types.find((t) => t.pass);
    assert.ok(p, `listed on ${k}`);
    assert.deepEqual(p.covers, [{ eventKey: VAN, name: "Vancouver Briefing" }, { eventKey: TOR, name: "Toronto Main Event" }]);
  }
  const cal = await call("GET", `/api/tickets/types?eventKey=${CAL}`, { as: null });
  assert.equal(cal.body.types.some((t) => t.pass), false);
  assert.equal((await forEvent(TOR)).passes.length, 1);
  // Not sold where it doesn't apply.
  const r = await call("POST", "/api/orders/multi-checkout", { as: buyer, body: { eventKey: CAL, items: [{ ticketTypeId: pass._id, quantity: 1 }], attendees: [person("Cleo", pass._id)] } });
  assert.equal(r.status, 404);
});

test("buying the pass issues one pass per covered event, counted on its own line and towards each event", { skip }, async () => {
  const r = await call("POST", "/api/orders/multi-checkout", {
    as: buyer, body: { eventKey: TOR, items: [{ ticketTypeId: pass._id, quantity: 2 }], attendees: [person("Ada", pass._id), person("Bo", pass._id)] },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.free, true);
  const ada = await M.Attendee.find({ email: "ada@example.com" }).lean();
  assert.deepEqual(ada.map((a) => a.eventKey).sort(), [TOR, VAN].sort());
  assert.equal(new Set(ada.map((a) => a.ticketId)).size, 2, "a ticket ID per event");
  const order = await M.Order.findById(r.body.orderId).lean();
  assert.equal(order.status, "fulfilled");
  assert.deepEqual(order.items[0].passCovers, [VAN, TOR]);
  assert.equal(order.attendees[0].passes.length, 2);

  // Vancouver: its own tickets unchanged, the pass on its own line.
  const van = await forEvent(VAN);
  assert.deepEqual(van.ticketTypes.map((t) => [t.slug, t.sold]), [["delegate", 2], ["vip", 0]]);
  assert.deepEqual(van.passes.map((p) => [p.name, p.sold]), [["Vancouver + Toronto", 2]]);
  assert.deepEqual(van.soldTotals, { own: 2, passes: 2 });
  // Toronto (where it was bought): Power still 0.
  assert.deepEqual((await forEvent(TOR)).ticketTypes.map((t) => t.sold), [0]);
  // Delegate target: both events count the pass holders.
  for (const [k, own] of [[VAN, 2], [TOR, 0]]) {
    const s = (await call("GET", `/api/console/sales-event/summary?event=${k}`)).body;
    assert.equal(s.tickets, own + 2, k);
    assert.equal(s.passTickets, 2);
  }
  const all = (await call("GET", "/api/admin/ticket-types/passes")).body.passes;
  assert.deepEqual(all.map((p) => p.sold), [2]);
  // A pass with sales can't be deleted (switch it off instead).
  assert.equal((await call("DELETE", `/api/admin/ticket-types/${pass._id}`)).status, 409);
});

test("a pass's capacity counts across all its events", { skip }, async () => {
  await call("PATCH", `/api/admin/ticket-types/${pass._id}`, { body: { capacity: 2 } });
  const r = await call("POST", "/api/orders/multi-checkout", { as: buyer, body: { eventKey: VAN, items: [{ ticketTypeId: pass._id, quantity: 1 }], attendees: [person("Cy", pass._id)] } });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /sold out/);
});
