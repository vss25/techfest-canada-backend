/* The team's "New RSVP" alert (RSVP_INBOX, enquire@) through the real /api/rsvp route and the real Rsvp model,
   against a real (throwaway) MongoDB. Oct 22 2026: every FIRST RSVP reached the team as
     "[RSVP] Someone · Power Pass" / Name Someone, Ticket ID empty, Days None, Special events None, …
   while the row itself was saved complete. Rsvp.create() hands back a Mongoose document, whose fields are
   getters over `_doc`: spreading it (`{ _id, editTokenHash, ...row } = saved`) kept none of them, so only
   the pass the RSVP was checked against reached the email. Updates (findByIdAndUpdate().lean()) were fine.
   Also covered: an incomplete or empty submission is refused and emails nobody; opening the RSVP link
   (GETs, the open pixel, the page's own lookup, as a mail scanner would) saves and emails nothing; the
   RSVP reminder's preview, test send and real send never make an RSVP or an alert.
   Starts a local mongod in a temp folder on a free port and stops it after; skipped when the binary isn't
   there (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Nothing leaves the
   machine: Resend and Sanity are stubbed (nothing is delivered). Fictional people. */
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
delete process.env.TRACKING_SECRET;
process.env.RESEND_API_KEY ||= "re_dummy";
process.env.FRONTEND_URL = "https://www.example.test";
process.env.RSVP_INBOX = "rsvp-inbox@example.test";
delete process.env.STRIPE_SECRET_KEY;

/** Every email the routes tried to send (Resend is stubbed: nothing is delivered). */
const outbox = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.startsWith("https://api.resend.com/")) {
    const body = JSON.parse(opts?.body || "{}");
    outbox.push({ to: [].concat(body.to || []), subject: body.subject || "", html: body.html || "", text: body.text || "" });
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
let mia;

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-rsvp-alert-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_rsvp_alert_test`, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  ({ default: jwt } = await import("jsonwebtoken"));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.Rsvp = await imp("../models/Rsvp.js");
  await M.Rsvp.init();
  const { default: express } = await import("express");
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use("/api/t", (await import("../routes/engagement.js")).default);
  app.use("/api/rsvp", (await import("../routes/rsvp.js")).default);
  app.use("/api/console/rsvp-reminders", (await import("../routes/rsvpReminders.js")).default);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const d = (n) => new Date(Date.now() - n * 864e5);
  mia = await M.User.create({ name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management" });
  await M.User.create({ name: "Pat Rowe", email: "pat.rowe@example.com", tickets: [{ ticketId: "pow700000001", type: "power", purchaseDate: d(10) }] });
  await M.User.create({ name: "Quinn Ash", email: "quinn.ash@example.com", tickets: [{ ticketId: "con700000002", type: "connect", purchaseDate: d(9) }] });
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const tokenFor = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
let ipN = 10;
/** Each call from its own address unless told otherwise, so the per-address limits never get in the way. */
async function call(method, url, { as = null, body, ip = `10.0.0.${ipN++}`, headers = {} } = {}) {
  const r = await realFetch(base + url, {
    method, redirect: "manual",
    headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(as ? { authorization: `Bearer ${tokenFor(as)}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString()); } catch { json = buf; }
  return { status: r.status, body: json, headers: r.headers };
}
const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  return null;
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const alerts = () => outbox.filter((m) => m.to.includes("rsvp-inbox@example.test"));
const rsvpRows = () => M.Rsvp.countDocuments({});

// What the page sends after "Send My RSVP" (src/pages/Rsvp.jsx submit), for Pat's Power Pass.
const PAT = {
  firstName: "Pat", lastName: "Rowe", ticketId: "POW700000001", tier: "power",
  days: ["day1", "day2"], options: ["gala", "lunch_d1"], dietary: ["vegan"], dietaryOther: "",
  accessibility: "Step-free route please", page: "/rsvp", _hp: "", elapsedMs: 90000,
};

test("a first RSVP reaches the team with the person's name, ticket, days and choices (not \"Someone\")", { skip }, async () => {
  const before = alerts().length;
  const r = await call("POST", "/api/rsvp", { body: PAT });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.updated, r.body.tier, r.body.tierVerified], [false, "power", true]);
  const mail = await waitFor(() => alerts().length > before && alerts().at(-1));
  assert.ok(mail, "the team alert was sent");
  assert.equal(mail.subject, "[RSVP] Pat Rowe · Power Pass");
  assert.match(mail.html, /New RSVP: Pat Rowe/);
  assert.doesNotMatch(mail.subject + mail.text, /Someone/);
  assert.match(mail.text, /Ticket ID: POW700000001/i);
  assert.match(mail.text, /Days: Day 1[^\n]*, Day 2/);
  assert.match(mail.text, /Networking Luncheon \(Day 1\)/);
  assert.match(mail.text, /Gala Dinner/);
  assert.match(mail.text, /Dietary: Vegan/);
  assert.match(mail.text, /Accessibility: Step-free route please/);
  assert.doesNotMatch(mail.text, /Days: None|Special events: None/);
  // The row was always complete; it's the email that lost it.
  const row = await M.Rsvp.findOne({ key: "t:pow700000001" }).lean();
  assert.deepEqual([row.name, row.ticketId.toUpperCase(), row.ticketVerified, row.days], ["Pat Rowe", "POW700000001", true, ["day1", "day2"]]);
  assert.equal(alerts().length, before + 1);
});

test("changing it (same ticket) sends \"RSVP updated\" with the new answers", { skip }, async () => {
  const before = alerts().length;
  const r = await call("POST", "/api/rsvp", { body: { ...PAT, days: ["day2"], options: ["gala"], dietary: ["none"], accessibility: "" } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.updated, true);
  const mail = await waitFor(() => alerts().length > before && alerts().at(-1));
  assert.equal(mail.subject, "[RSVP updated] Pat Rowe · Power Pass");
  assert.match(mail.text, /Ticket ID: POW700000001/i);
  assert.match(mail.text, /Days: Day 2/);
  assert.equal(await rsvpRows(), 1);
});

test("an empty or incomplete RSVP is refused (400): nothing saved, nobody emailed", { skip }, async () => {
  const rows = await rsvpRows();
  const before = alerts().length;
  const bad = [
    [{}, "firstName"],
    [{ tier: "power" }, "firstName"], // a pass alone: the "Someone · Power Pass" shape
    [{ ...PAT, firstName: "", lastName: "" }, "firstName"],
    [{ ...PAT, firstName: "  " }, "firstName"],
    [{ ...PAT, lastName: "" }, "lastName"],
    [{ ...PAT, days: [] }, "days"],
    [{ ...PAT, days: undefined }, "days"],
    [{ ...PAT, ticketId: "" }, "ticketId"],
    [{ ...PAT, ticketId: "POW799999999" }, "ticketId"], // not a ticket
    [{ ...PAT, lastName: "Wrong" }, "ticketId"], // not the holder's last name
  ];
  for (const [body, field] of bad) {
    const r = await call("POST", "/api/rsvp", { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.success, false);
    assert.equal(r.body.field, field, JSON.stringify(body));
  }
  await pause(150);
  assert.equal(await rsvpRows(), rows);
  assert.equal(alerts().length, before);
});

test("opening the RSVP link (as a mail scanner would) saves and emails nothing", { skip }, async () => {
  const rows = await rsvpRows();
  const before = outbox.length;
  const scanner = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0 Safari/537.36" };
  // No GET on the RSVP API saves anything: only /options answers, and it only reads.
  for (const url of ["/api/rsvp", "/api/rsvp?t=CON700000002&fn=Quinn&ln=Ash", "/api/rsvp/lookup?t=CON700000002&fn=Quinn&ln=Ash", "/api/rsvp/options"]) {
    for (const method of ["GET", "HEAD"]) {
      const g = await call(method, url, { headers: scanner });
      assert.equal(g.status, url.endsWith("/options") ? 200 : 404, `${method} ${url}`);
    }
  }
  // The email's open pixel (any token) records at most an open.
  assert.equal((await call("GET", "/api/t/o/not-a-token.gif", { headers: scanner })).status, 200);
  // The page with a personal link (#t=…&fn=…&ln=…) fills the name question and looks the ticket up at once;
  // sending needs three more screens and "Send My RSVP" (src/pages/Rsvp.jsx). The lookup saves no RSVP.
  const look = await call("POST", "/api/rsvp/lookup", { headers: scanner, body: { firstName: "Quinn", lastName: "Ash", ticketId: "CON700000002", _hp: "" } });
  assert.equal(look.status, 200);
  assert.deepEqual([look.body.kind, look.body.verified, look.body.tier], ["ticket", true, "connect"]);
  await pause(150);
  assert.equal(await rsvpRows(), rows);
  assert.equal(outbox.length, before);
});

test("the RSVP reminder's preview, test send and real send never make an RSVP or a team alert", { skip }, async () => {
  const rows = await rsvpRows();
  const before = alerts().length;
  const sent = outbox.length;
  const preview = await call("GET", "/api/console/rsvp-reminders/preview-sample", { as: mia });
  assert.equal(preview.status, 200);
  const testSend = await call("POST", "/api/console/rsvp-reminders/send-test", { as: mia, body: { to: "mia.manager@example.com" } });
  assert.equal(testSend.status, 200, JSON.stringify(testSend.body));
  const one = await call("POST", "/api/console/rsvp-reminders/send-one", { as: mia, body: { email: "quinn.ash@example.com" } });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.ok(await waitFor(() => outbox.length >= sent + 2));
  assert.match(outbox[sent].subject, /^\[Test\] /);
  assert.deepEqual(outbox.at(-1).to, ["quinn.ash@example.com"]);
  await pause(150);
  assert.equal(await rsvpRows(), rows);
  assert.equal(alerts().length, before);
});
