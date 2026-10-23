/* Event summary (GET /api/console/summary) through the real routes and models, against a real (throwaway)
   MongoDB: who may read it, the counting rules on records as the database stores them (account tickets and
   their claimed guest record are one pass, a staff switch on a guest pass, a hidden pass, a pending Speaker Pass,
   a possible-duplicate RSVP), a real door scan showing up in the check-in counts, and that reading it never
   writes, audits or emails anything.
   Starts a local mongod in a temp folder on a free port and stops it after; skipped when the binary isn't
   there (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Nothing leaves the
   machine: Sanity answers an empty list, Resend is counted and never reached, no Stripe key (so refunds
   can't be checked: the answer says so). Fictional people, example.com. */
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

let resendCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.startsWith("https://api.resend.com/")) { resendCalls += 1; return new Response(JSON.stringify({ id: "stub" }), { status: 200, headers: { "content-type": "application/json" } }); }
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
let eventDayOf;
let mia, sam, uma;

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-summary-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_event_summary_test`, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  ({ default: jwt } = await import("jsonwebtoken"));
  ({ eventDayOf } = await import("../services/eventSummary.js"));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.Attendee = await imp("../models/Attendee.js");
  M.Rsvp = await imp("../models/Rsvp.js");
  Object.assign(M, await import("../models/Admin.js"));
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/console/people", (await import("../routes/people.js")).default);
  app.use("/api/console/summary", (await import("../routes/eventSummary.js")).default);
  app.use("/api/checkin", (await import("../routes/checkin.js")).default);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  mia = await M.User.create({ name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management" });
  sam = await M.User.create({ name: "Sam Staff", email: "sam.staff@example.com", role: "admin", staffRole: "staff" });
  uma = await M.User.create({ name: "Uma User", email: "uma.user@example.com", role: "user" });
  const pat = await M.User.create({ name: "Pat Power", email: "pat.power@example.com",
    tickets: [{ ticketId: "pow200000001", type: "power", purchaseDate: new Date("2026-10-01"), stripeSessionId: "cs_pat" }] });
  // A speaker whose account holds a Speaker Pass and a Power Pass she bought: one person, under Speaker.
  const rae = await M.User.create({ name: "Rae Speaker", email: "rae.speaker@example.com",
    tickets: [
      { ticketId: "spk200000010", type: "speaker", purchaseDate: new Date("2026-10-02") },
      { ticketId: "pow200000011", type: "power", purchaseDate: new Date("2026-10-03"), stripeSessionId: "cs_rae" },
    ] });
  await M.Attendee.create({ name: "Rae Speaker", email: "rae.speaker@example.com", ticketId: "spk200000010", ticketType: "speaker", promoCode: "SPEAKER", claimedBy: rae._id, passEmailSentAt: new Date("2026-10-04") });
  await M.User.create({ name: "Hal Hidden", email: "hal.hidden@example.com",
    tickets: [{ ticketId: "apx200000009", type: "apex", purchaseDate: new Date("2026-10-01"), hiddenByStaff: true }] });
  await M.Attendee.create([
    // Pat's claimed guest record of the same ticket: one pass, not two.
    { name: "Pat Power", email: "pat.power@example.com", ticketId: "pow200000001", ticketType: "power", claimedBy: pat._id, stripeSessionId: "cs_pat" },
    // A guest Influence Pass whose Gala staff switched on; checked in on Day 1 (Toronto) by the door scanner.
    { name: "Gia Guest", email: "gia.guest@example.com", ticketId: "inf200000002", ticketType: "influence", stripeSessionId: "cs_gia", galaDinner: true,
      checkedIn: true, checkedInAt: new Date("2026-10-26T14:05:00Z") },
    // An exhibitor's Connect Pass, emailed.
    { name: "Eve Exhibitor", email: "eve.exhibitor@example.com", ticketId: "exh200000003", ticketType: "connect", promoCode: "EXHIBITOR", passEmailSentAt: new Date("2026-10-10") },
    // A Speaker Pass not emailed yet: pending.
    { name: "Sol Speaker", email: "", ticketId: "spk200000004", ticketType: "speaker", promoCode: "SPEAKER", speakerId: "spk-sol" },
    // A test pass staff hid (guest, nobody's account): not in the directory at all.
    { name: "Test Ticket", email: "test.ticket@example.com", ticketId: "tst200000005", ticketType: "apex", hiddenByStaff: true },
    // Rae's communications manager: her own Power Pass, bought on Rae's email address. A second person.
    { name: "Max Manager", email: "rae.speaker@example.com", ticketId: "pow200000012", ticketType: "power", stripeSessionId: "cs_max",
      details: { firstName: "Max", lastName: "Manager" } },
    // Connect guest, to be scanned for real below.
    { name: "Cam Connect", email: "cam.connect@example.com", ticketId: "con200000006", ticketType: "connect", stripeSessionId: "cs_cam" },
  ]);
  const at = new Date("2026-10-15T12:00:00Z");
  const r = (key, first, last, extra) => ({ key, firstName: first, lastName: last, name: `${first} ${last}`, nameKey: `${first} ${last}`.toLowerCase(),
    ticketVerified: true, kind: "ticket", tierVerified: true, source: "attendee", attendeeSubmittedAt: at, submissions: 1, ...extra });
  await M.Rsvp.create([
    r("t:pow200000001", "Pat", "Power", { ticketId: "POW200000001", tier: "power", days: ["day1", "day2"], options: ["lunch_d1", "awards", "gala"], dietary: ["vegetarian"] }),
    r("t:inf200000002", "Gia", "Guest", { ticketId: "INF200000002", tier: "influence", days: ["day2"], options: ["lunch_d2", "gala"], dietary: ["halal", "other"], dietaryOther: "No sesame" }),
    r("t:exh200000003", "Eve", "Exhibitor", { ticketId: "EXH200000003", tier: "connect", days: ["day1"], options: [], dietary: ["none"] }),
    // A second RSVP under Eve's name with no proof: a possible duplicate, not counted.
    r("n:eve exhibitor", "Eve", "Exhibitor", { ticketVerified: false, tierVerified: false, kind: "none", tier: "connect", days: ["day2"], options: [], dietary: ["vegan"], duplicateOf: "x" }),
    // Hal's RSVP: his only pass is hidden, so it's reported, not counted.
    r("t:apx200000009", "Hal", "Hidden", { ticketId: "APX200000009", tier: "apex", days: ["day1"], options: ["cxo_d1"], dietary: [] }),
    // A bot's row: never listed.
    r("n:bot bot", "Bot", "Bot", { tier: "connect", days: ["day1"], spam: true }),
  ]);
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const tokenFor = (u, via) => jwt.sign({ id: String(u._id), ...(via ? { via } : {}) }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function call(method, url, { as = mia, via, body, token } = {}) {
  const headers = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token || tokenFor(as, via)}`;
  const r = await realFetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, headers: r.headers };
}
const summary = async (as = sam) => {
  const res = await call("GET", "/api/console/summary?refresh=1", { as });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};
const row = (s, tier) => s.passes.rows.find((x) => x.tier === tier);
const meal = (s, key) => s.meals.rows.find((m) => m.key === key);

/** Every document in every collection, as JSON: to show nothing was written. (Empty collections are left out:
    Mongoose creates a model's collection in the background when it's first imported, which isn't a write.) */
async function snapshot() {
  const out = {};
  for (const c of await mongoose.connection.db.listCollections().toArray()) {
    const docs = await mongoose.connection.db.collection(c.name).find({}).sort({ _id: 1 }).toArray();
    if (docs.length) out[c.name] = JSON.stringify(docs);
  }
  return out;
}

test("staff and management may read it; attendees, signed-out callers and emailed-code sign-ins may not", { skip }, async () => {
  assert.equal((await call("GET", "/api/console/summary", { token: null })).status, 401);
  assert.equal((await call("GET", "/api/console/summary", { as: uma })).status, 403);
  const code = await call("GET", "/api/console/summary", { as: sam, via: "email" });
  assert.equal(code.status, 403);
  assert.equal(code.body.code, "password_required");
  const staff = await call("GET", "/api/console/summary", { as: sam });
  assert.equal(staff.status, 200);
  assert.match(staff.headers.get("cache-control") || "", /no-store/);
  assert.equal((await call("GET", "/api/console/summary", { as: mia })).status, 200);
});

test("the counting rules on stored records: one per person, hidden out, pending apart, exhibitor under Connect, duplicates not RSVPs", { skip }, async () => {
  const s = await summary();
  // Pat, Gia, Eve, Sol, Cam, Rae (Speaker + Power: once, under Speaker) and Max (his own pass on Rae's email: a
  // second person). Hal's pass is hidden; staff accounts and Uma have none; the hidden test ticket isn't listed.
  assert.equal(s.totals.people, 7);
  assert.deepEqual(Object.fromEntries(s.passes.rows.map((x) => [x.tier, x.people])), { power: 2, speaker: 2, connect: 2, influence: 1, apex: 0 });
  assert.equal(s.passes.rows.reduce((n, x) => n + x.people, 0), s.totals.people, "each person in exactly one pass row");
  assert.deepEqual(s.multiPass.map((m) => [m.name, m.countedAs, m.passes.length]), [["Rae Speaker", "Speaker Pass", 2]]);
  assert.equal(row(s, "speaker").pending, 1);
  assert.equal(s.totals.pending, 1);
  assert.equal(s.passes.marks.find((m) => m.key === "exhibitor").people, 1);
  assert.ok(!s.multiPass.some((m) => m.name === "Pat Power"), "an account ticket and its claimed guest record are one pass");
  assert.equal(s.leftOut.hidden, 1);
  assert.equal(s.leftOut.staffNoPass, 2);
  assert.deepEqual(s.leftOut.rsvpNoPassPeople.map((p) => [p.name, p.why]), [["Hal Hidden", "hidden"]]);
  // RSVPs: Pat (both days), Gia (Day 2), Eve (Day 1; her possible duplicate for Day 2 doesn't count).
  assert.deepEqual([s.totals.rsvpd, s.totals.notRsvpd, s.totals.day1, s.totals.day2, s.totals.pct], [3, 4, 2, 2, 43]);
  assert.deepEqual([row(s, "connect").rsvpd, row(s, "connect").day1, row(s, "connect").day2], [1, 1, 0]);
  // Refunds can't be checked without Stripe, and the answer says so.
  assert.equal(s.stripe, "off");
  assert.equal(s.refundsChecked, false);
  assert.ok(s.builtAt);
});

test("entitlement from the pass and staff's switch on a guest pass, RSVP'd per meal, dietary per meal", { skip }, async () => {
  const s = await summary();
  // CxO: the Speaker Passes (Sol, Rae; Hal's Apex is hidden). Luncheons: Pat, Gia, Sol, Rae, Max. Awards: Pat, Sol, Rae,
  // Max. Gala: the same + Gia (staff switch). Rae's two passes both include them: she counts once.
  assert.deepEqual([meal(s, "cxo_d1").entitled, meal(s, "cxo_d1").entitledPending, meal(s, "cxo_d1").rsvpd], [2, 1, 0]);
  assert.deepEqual([meal(s, "lunch_d1").entitled, meal(s, "lunch_d1").rsvpd], [5, 1]);
  assert.deepEqual([meal(s, "lunch_d2").entitled, meal(s, "lunch_d2").rsvpd], [5, 1]);
  assert.deepEqual([meal(s, "awards").entitled, meal(s, "awards").rsvpd], [4, 1]);
  assert.deepEqual([meal(s, "gala").entitled, meal(s, "gala").rsvpd, meal(s, "gala").outsidePass, meal(s, "gala").pct], [5, 2, 0, 40]);
  const g = meal(s, "gala");
  assert.deepEqual([g.dietary.vegetarian, g.dietary.halal, g.dietary.other, g.noNeeds], [1, 1, 1, 0]);
  assert.deepEqual(s.meals.otherNotes.map((n) => [n.name, n.note, n.meals]), [["Gia Guest", "No sesame", ["lunch_d2", "gala"]]]);
  assert.deepEqual([s.meals.allRsvps.rsvpd, s.meals.allRsvps.noNeeds], [3, 1]);
  assert.ok(!JSON.stringify(s).includes("@"), "no email addresses in the answer");
});

test("reading the summary writes nothing, audits nothing and emails nobody", { skip }, async () => {
  const beforeSnap = await snapshot();
  const sentBefore = resendCalls;
  for (const as of [sam, mia]) {
    assert.equal((await call("GET", "/api/console/summary?refresh=1", { as })).status, 200);
    assert.equal((await call("GET", "/api/console/summary", { as })).status, 200);
  }
  assert.deepEqual(await snapshot(), beforeSnap);
  assert.equal(await M.AdminAudit.countDocuments({}), 0);
  assert.equal(resendCalls, sentBefore);
});

test("check-in: a stored Day 1 scan, then a real door scan counted on the day it happened (Toronto); a second scan adds nothing", { skip }, async () => {
  let s = await summary();
  assert.deepEqual([s.checkin.checkedIn, s.checkin.day1, s.checkin.day2], [1, 1, 0]);
  assert.deepEqual(s.checkin.byPass.find((x) => x.tier === "influence").day1, 1);
  const scan = await call("POST", "/api/checkin/scan", { as: sam, body: { ticketId: "TECHFEST:con200000006" } });
  assert.equal(scan.status, 200);
  assert.equal(scan.body.status, "success");
  s = await summary();
  const bucket = { day1: "day1", day2: "day2", other: "otherDay" }[eventDayOf(scan.body.checkedInAt)];
  assert.equal(s.checkin.checkedIn, 2);
  assert.equal(s.checkin[bucket], bucket === "day1" ? 2 : 1);
  assert.equal(s.checkin.notRsvpd, 1, "Cam hasn't RSVP'd");
  assert.equal(s.checkin.byPass.find((x) => x.tier === "connect").checkedIn, 1);
  // Scanned again: "already checked in", nothing new is recorded.
  const again = await call("POST", "/api/checkin/scan", { as: sam, body: { ticketId: "con200000006" } });
  assert.equal(again.body.status, "already_checked_in");
  assert.equal((await summary()).checkin.checkedIn, 2);
  assert.equal(s.checkin.firstScanOnly, true);
  assert.equal(s.checkin.mealScans, false);
});
