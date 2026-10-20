/* The coupon code on Admin › People, Headcounts & RSVPs and Ticket records, through the real routes against a real
   (throwaway) MongoDB: the code each ticket was bought with ("SPRING20 · 20% off"), "No code", staff-made passes
   ("Given by staff", "Complimentary", "Speaker Pass", never a marker as a coupon), "—" with nothing on record;
   searching by code; the CSV exports. Starts a local mongod in a temp folder on a free port and stops it after;
   skipped when the binary isn't there (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6).
   Nothing leaves the machine (fetch is stubbed; no Stripe key). Fictional people, example.com. */
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

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.includes(".sanity.io/")) return new Response(JSON.stringify({ result: [] }), { status: 200, headers: { "content-type": "application/json" } });
  throw new Error(`blocked in the test: ${url}`);
};

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });

let mongod = null;
let dbDir = "";
let server = null;
let base = "";
let mongoose;
let jwt;
let mia;

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-promo-code-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_promo_code_test`, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  ({ default: jwt } = await import("jsonwebtoken"));
  const imp = async (p) => (await import(p)).default;
  const User = await imp("../models/User.js");
  const Attendee = await imp("../models/Attendee.js");
  const Rsvp = await imp("../models/Rsvp.js");
  const Promo = await imp("../models/Promo.js");
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/console/people", (await import("../routes/people.js")).default);
  app.use("/api/console", (await import("../routes/console.js")).default);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const d = (s) => new Date(`2026-${s}T12:00:00Z`);
  mia = await User.create({ name: "Mia Example", email: "mia.example@example.com", role: "admin", staffRole: "management" });
  await Promo.create([{ code: "SPRING20", discount: 20 }, { code: "HALF", discount: 50 }]);
  await User.create([
    { name: "Pat Example", email: "pat.example@example.com", tickets: [{ ticketId: "pc0000000001", type: "power", promoCode: "SPRING20", stripeSessionId: "cs_pat", purchaseDate: d("10-01") }] },
    { name: "Nia Example", email: "nia.example@example.com", tickets: [{ ticketId: "pc0000000002", type: "influence", promoCode: "", stripeSessionId: "cs_nia", purchaseDate: d("10-02") }] },
  ]);
  const vera = await User.create({ name: "Vera Example", email: "vera.example@example.com", tickets: [{ ticketId: "pc0000000003", type: "power", purchaseDate: d("10-03") }] });
  await Attendee.create([
    // Vera's pass was given by staff, then she claimed it in the app (the account's copy has no code).
    { name: "Vera Example", email: "vera.example@example.com", ticketId: "pc0000000003", ticketType: "power", promoCode: "ISSUED", claimedBy: vera._id, purchaseDate: d("10-03") },
    { name: "Hal Example", email: "hal.example@example.com", ticketId: "pc0000000004", ticketType: "connect", promoCode: "HALF", stripeSessionId: "cs_hal", purchaseDate: d("10-04") },
    { name: "Cara Example", email: "cara.example@example.com", ticketId: "pc0000000005", ticketType: "connect", promoCode: "COMP", purchaseDate: d("10-05") },
    { name: "Sol Example", ticketId: "pc0000000006", ticketType: "speaker", promoCode: "SPEAKER", speakerId: "spk-sol", purchaseDate: d("10-05") },
    { name: "Old Example", email: "old.example@example.com", ticketId: "pc0000000007", ticketType: "connect", purchaseDate: d("08-01") },
  ]);
  const rsvp = (first, last, ticketId, tier) => ({
    key: ticketId ? `t:${ticketId}` : `n:${first.toLowerCase()} ${last.toLowerCase()}`, firstName: first, lastName: last, name: `${first} ${last}`,
    nameKey: `${first.toLowerCase()} ${last.toLowerCase()}`, ticketId: ticketId || "", ticketVerified: !!ticketId, kind: ticketId ? "ticket" : "speaker",
    tier, tierVerified: !!ticketId, source: "attendee", days: ["day1"], options: [], dietary: ["none"], submissions: 1,
  });
  await Rsvp.create([
    rsvp("Pat", "Example", "pc0000000001", "power"), rsvp("Nia", "Example", "pc0000000002", "influence"),
    rsvp("Vera", "Example", "pc0000000003", "power"), rsvp("Sol", "Example", "", "speaker"),
  ]);
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

async function call(url) {
  const r = await realFetch(base + url, { headers: { authorization: `Bearer ${jwt.sign({ id: String(mia._id) }, process.env.JWT_SECRET, { expiresIn: "1h" })}` } });
  const text = await r.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* CSV */ }
  return { status: r.status, body };
}

const WANT = {
  "Pat Example": "SPRING20 · 20% off", "Nia Example": "No code", "Vera Example": "Given by staff", "Hal Example": "HALF · 50% off",
  "Cara Example": "Complimentary", "Sol Example": "Speaker Pass", "Old Example": "—",
};

test("Ticket records: a code on every row, search and ?promo= by code, the CSV's Code column", { skip }, async () => {
  const r = await call("/api/console/tickets");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(Object.fromEntries(r.body.rows.map((x) => [x.name, x.code.label])), WANT);
  assert.deepEqual((await call("/api/console/tickets?q=spring20")).body.rows.map((x) => x.name), ["Pat Example"]);
  assert.deepEqual((await call("/api/console/tickets?promo=ANY")).body.rows.map((x) => x.name).sort(), ["Hal Example", "Pat Example"]);
  assert.deepEqual((await call("/api/console/tickets?promo=COMP")).body.rows, []);
  const csv = (await call("/api/console/tickets/export")).body;
  const [head, ...lines] = csv.slice(1).split("\n");
  const i = head.split(",").indexOf("Code");
  assert.ok(i > 0);
  assert.ok(lines.some((l) => l.startsWith("pc0000000001,") && l.split(",")[i] === "SPRING20 · 20% off"));
  assert.ok(lines.some((l) => l.startsWith("pc0000000005,") && l.split(",")[i] === "Complimentary"));
});

test("People: each person's code on the row and each pass; search finds who used a code; the CSV", { skip }, async () => {
  const r = await call("/api/console/people?refresh=1&size=100");
  assert.equal(r.status, 200);
  const got = Object.fromEntries(r.body.rows.filter((x) => WANT[x.name]).map((x) => [x.name, x.pass?.code?.label]));
  assert.deepEqual(got, WANT);
  assert.deepEqual((await call("/api/console/people?q=SPRING20")).body.rows.map((x) => x.name), ["Pat Example"]);
  const pat = r.body.rows.find((x) => x.name === "Pat Example");
  const prof = (await call(`/api/console/people/${pat.id}`)).body.person;
  assert.deepEqual(prof.passes.map((p) => p.code), [{ kind: "code", code: "SPRING20", discount: 20, label: "SPRING20 · 20% off" }]);
  assert.deepEqual((await call("/api/console/people?sort=code")).body.rows.slice(0, 2).map((x) => x.name), ["Hal Example", "Pat Example"]);
  const csv = (await call("/api/console/people/export?q=hal")).body;
  const [head, line] = csv.slice(1).split("\n");
  assert.equal(line.split(",")[head.split(",").indexOf("Code")], "HALF · 50% off");
});

test("Headcounts & RSVPs: the code of each RSVP's ticket, in the list, the drawer and the CSV", { skip }, async () => {
  const r = await call("/api/console/rsvps");
  assert.equal(r.status, 200);
  assert.deepEqual(Object.fromEntries(r.body.rows.map((x) => [x.name, x.code.label])),
    { "Pat Example": "SPRING20 · 20% off", "Nia Example": "No code", "Vera Example": "Given by staff", "Sol Example": "—" });
  const one = (await call(`/api/console/rsvps/${r.body.rows.find((x) => x.name === "Pat Example").id}`)).body.rsvp;
  assert.equal(one.code.label, "SPRING20 · 20% off");
  const csv = (await call("/api/console/rsvps/export")).body;
  const [head, ...lines] = csv.slice(1).split("\n");
  const i = head.split(",").indexOf("Code");
  assert.ok(lines.some((l) => l.split(",")[i] === "SPRING20 · 20% off"));
  assert.ok(lines.some((l) => l.split(",")[i] === "Given by staff"));
});
