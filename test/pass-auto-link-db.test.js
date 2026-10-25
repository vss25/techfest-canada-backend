/* Passes sent to an account's email reach its app (Oct 24 2026, the organiser: "Auto update their passes in the app. I
   can't ask them to enter pass ID manually."), through the real routes and models against a real (throwaway) MongoDB:
   the backfill's preview (POST /api/console/people/link-passes, management) lists what would link and what's left out
   and why, changing nothing; GET /api/auth/me links the passes that are theirs (same email, their name) and returns
   them, keeping the pass's ID, extras and marks, once (idempotent, one audit per link); a staff password sign-in links
   theirs; a buyer's email on colleagues' passes never links them; a pass claimed by another account is never taken; a
   pass given to an email that has an account links at once; the backfill links the rest, then has nothing left.
   Starts a local mongod in a temp folder on a free port and stops it after; skipped when the binary isn't there.
   Nothing leaves the machine (Sanity stubbed, no Stripe key, no email). Fictional people, example.com. */
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
const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.includes(".sanity.io/")) return json({ result: [] });
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
let autoLinkEmail;
const M = {};
const U = {};
const PASSWORD = "local-test-password-1";

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-autolink-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_autolink`, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await sleep(250); }
  }
  ({ default: jwt } = await import("jsonwebtoken"));
  const { default: bcrypt } = await import("bcryptjs");
  M.User = (await import("../models/User.js")).default;
  M.Attendee = (await import("../models/Attendee.js")).default;
  M.CheckinEvent = (await import("../models/CheckinEvent.js")).default;
  Object.assign(M, await import("../models/Admin.js"));
  ({ autoLinkEmail } = await import("../services/passAutoLink.js"));
  await Promise.all([M.User.init(), M.Attendee.init()]);
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/auth", (await import("../routes/auth.js")).default);
  app.use("/api/console/people", (await import("../routes/people.js")).default);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const hash = await bcrypt.hash(PASSWORD, 4);
  const mk = async (k, doc) => { U[k] = await M.User.create(doc); };
  await mk("mia", { name: "Mia Manager", email: "mia.l@example.com", role: "admin", staffRole: "management", password: hash });
  await mk("dee", { name: "Dee Staff", email: "dee.l@example.com", role: "admin", staffRole: "staff", password: hash });
  // A staff member who signs in with a password: her Speaker Pass was issued to her email.
  await mk("nic", { name: "Nicole Louis", email: "nicole.l@example.com", role: "admin", staffRole: "staff", password: hash });
  // An attendee account with an Apex pass staff gave to its email (VIP, CxO switched off by staff).
  await mk("gus", { name: "Gunant Singh Pahwa", email: "gunant.l@example.com" });
  // A buyer: his own pass and two colleagues' passes under his email.
  await mk("kil", { name: "Killian Sullivan", email: "killian.l@example.com" });
  // Someone whose pass another account (a ticket-ID sign-in) already holds.
  await mk("ava", { name: "Ava Account", email: "ava.l@example.com" });
  await mk("avt", { name: "Ava Account", email: "x9@ticket.thetechfestival.com", provider: "ticket" });
  // Left for the backfill.
  await mk("bea", { name: "Bea Backfill", email: "bea.l@example.com" });
  await M.Attendee.create([
    { name: "Nicole Louis", email: "nicole.l@example.com", ticketId: "8150394c9d29", ticketType: "speaker", promoCode: "SPEAKER" },
    { name: "Gunant Singh Pahwa", email: "gunant.l@example.com", ticketId: "ab9ade3fed48", ticketType: "apex", promoCode: "TTFC-ISSUED", vip: true, cxoBreakfast: false },
    { name: "Killian Sullivan", email: "killian.l@example.com", ticketId: "kil000000001", ticketType: "power" },
    { name: "Milorad Stefanovic", email: "killian.l@example.com", ticketId: "mil000000001", ticketType: "power" },
    { name: "Glen Webster", email: "killian.l@example.com", ticketId: "gln000000001", ticketType: "power", details: { firstName: "Glen", lastName: "Webster" } },
    { name: "Ava Account", email: "ava.l@example.com", ticketId: "ava000000001", ticketType: "connect", claimedBy: U.avt._id },
    { name: "Gunant Singh Pahwa", email: "gunant.l@example.com", ticketId: "hid000000001", ticketType: "connect", hiddenByStaff: true },
    { name: "Gunant Singh Pahwa", email: "gunant.l@example.com", ticketId: "dup000000001", ticketType: "connect", syncDuplicate: true },
    { name: "Bea Backfill", email: "bea.l@example.com", ticketId: "bea000000001", ticketType: "influence" },
  ]);
  await M.User.updateOne({ _id: U.avt._id }, { $push: { tickets: { ticketId: "ava000000001", type: "connect", purchaseDate: new Date() } } });
  // Stored before emails were lower-cased: still the same email.
  await M.Attendee.collection.updateOne({ ticketId: "bea000000001" }, { $set: { email: "Bea.L@Example.com" } });
});

after(async () => {
  await sleep(200); // the link hook's directory rebuilds
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const tokenFor = (u) => jwt.sign({ id: String(u._id), role: u.role }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function call(method, p, { as = U.mia, body, token } = {}) {
  const headers = { "content-type": "application/json" };
  const tok = token === undefined ? (as ? tokenFor(as) : "") : token;
  if (tok) headers.authorization = `Bearer ${tok}`;
  const r = await realFetch(`${base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j };
}
const ticketsOf = async (u) => ((await M.User.findById(u._id).lean()).tickets || []).map((t) => t.ticketId);
const claimer = async (ticketId) => String((await M.Attendee.findOne({ ticketId }).lean()).claimedBy || "");
const audits = (ticketId) => M.AdminAudit.countDocuments({ action: "pass_auto_link", targetId: ticketId });

let previewBody = null;
test("backfill preview: what would link and what's left out and why; nothing changes; management only", { skip }, async () => {
  const staff = await call("POST", "/api/console/people/link-passes", { as: U.dee, body: { preview: true } });
  assert.equal(staff.status, 403);
  const r = await call("POST", "/api/console/people/link-passes", { body: { preview: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  previewBody = r.body;
  const link = r.body.link.map((x) => `${x.ticketId}→${x.accountName}`).sort();
  assert.deepEqual(link, ["8150394c9d29→Nicole Louis", "ab9ade3fed48→Gunant Singh Pahwa", "bea000000001→Bea Backfill", "kil000000001→Killian Sullivan"]);
  assert.deepEqual([r.body.preview, r.body.toLink, r.body.accounts, r.body.linked.length], [true, 4, 4, 0]);
  const skipped = Object.fromEntries(r.body.skipped.map((x) => [x.ticketId, x.why]));
  assert.deepEqual(skipped, { mil000000001: "name_differs", gln000000001: "name_differs", ava000000001: "claimed_by_other", hid000000001: "hidden", dup000000001: "duplicate" });
  for (const x of r.body.skipped) assert.ok(x.reason);
  assert.equal(await claimer("ab9ade3fed48"), "");
  assert.deepEqual(await ticketsOf(U.gus), []);
  assert.equal(await M.AdminAudit.countDocuments({ action: "pass_auto_link" }), 0);
});

test("/auth/me links their pass (same email, their name) and returns it: the ID, extras and marks kept; once", { skip }, async () => {
  const r = await call("GET", "/api/auth/me", { as: U.gus });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const t = r.body.tickets.find((x) => x.ticketId === "ab9ade3fed48");
  assert.ok(t, JSON.stringify(r.body.tickets));
  assert.deepEqual([t.type, t.cxoBreakfast], ["apex", false]); // staff's CxO switch on the pass record still counts
  assert.equal(r.body.tickets.length, 1); // never the hidden or duplicate one
  assert.equal(await claimer("ab9ade3fed48"), String(U.gus._id));
  const a = await M.Attendee.findOne({ ticketId: "ab9ade3fed48" }).lean();
  assert.deepEqual([a.vip, a.cxoBreakfast, a.promoCode, a.email], [true, false, "TTFC-ISSUED", "gunant.l@example.com"]);
  assert.equal(await audits("ab9ade3fed48"), 1);
  assert.equal(await claimer("hid000000001"), "");
  // Again: nothing new.
  const again = await call("GET", "/api/auth/me", { as: U.gus });
  assert.equal(again.body.tickets.length, 1);
  assert.deepEqual(await ticketsOf(U.gus), ["ab9ade3fed48"]);
  assert.equal(await audits("ab9ade3fed48"), 1);
  // People: one person with that pass.
  await sleep(50);
  const p = await call("GET", `/api/console/people/u-${U.gus._id}`);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual(p.body.person.passes.filter((x) => x.ticketId === "ab9ade3fed48").length, 1);
  // The check-in desks: told (a guest event with the person's row).
  let ev = null;
  for (let i = 0; i < 80 && !ev; i++) { ev = await M.CheckinEvent.findOne({ kind: "guest", subject: "ab9ade3fed48" }).lean(); if (!ev) await sleep(50); }
  assert.ok(ev?.guest, "desk guest event");
  assert.equal(ev.guest.name, "Gunant Singh Pahwa");
  const byTicket = await call("GET", "/api/console/people/t-ab9ade3fed48");
  assert.equal(byTicket.body.canonicalId || byTicket.body.person.id, p.body.canonicalId || p.body.person.id);
});

test("a staff password sign-in links their Speaker Pass (they never use the emailed code)", { skip }, async () => {
  const login = await call("POST", "/api/auth/login", { as: null, body: { email: "nicole.l@example.com", password: PASSWORD, staffOnly: true } });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.deepEqual(await ticketsOf(U.nic), ["8150394c9d29"]);
  assert.equal(await claimer("8150394c9d29"), String(U.nic._id));
  const me = await call("GET", "/api/auth/me", { token: login.body.token });
  assert.deepEqual(me.body.tickets.map((t) => [t.ticketId, t.type]), [["8150394c9d29", "speaker"]]);
  assert.equal(await audits("8150394c9d29"), 1);
});

test("a buyer's email on colleagues' passes: only his own links; a pass another account holds is never taken", { skip }, async () => {
  const r = await call("GET", "/api/auth/me", { as: U.kil });
  assert.deepEqual(r.body.tickets.map((t) => t.ticketId), ["kil000000001"]);
  assert.equal(await claimer("mil000000001"), "");
  assert.equal(await claimer("gln000000001"), "");
  const ava = await call("GET", "/api/auth/me", { as: U.ava });
  assert.deepEqual(ava.body.tickets, []);
  assert.equal(await claimer("ava000000001"), String(U.avt._id));
  assert.deepEqual(await ticketsOf(U.avt), ["ava000000001"]);
});

test("a pass given to an email that has an account links at once (the issue / complimentary / Speaker Pass hooks)", { skip }, async () => {
  await M.Attendee.create({ name: "Nicole Louis", email: "nicole.l@example.com", ticketId: "nic000000002", ticketType: "power", promoCode: "TTFC-ISSUED" });
  const linked = await autoLinkEmail("Nicole.L@example.com", { by: U.mia, trigger: "pass given" });
  assert.deepEqual(linked.map((l) => l.ticketId), ["nic000000002"]);
  assert.deepEqual((await ticketsOf(U.nic)).sort(), ["8150394c9d29", "nic000000002"]);
  const a = await M.AdminAudit.findOne({ action: "pass_auto_link", targetId: "nic000000002" }).lean();
  assert.deepEqual([String(a.adminId), a.adminName], [String(U.mia._id), "Mia Manager"]);
  assert.match(a.detail, /pass given/);
  // A colleague's pass under a staff member's email stays the colleague's.
  await M.Attendee.create({ name: "Lubna Soni", email: "nicole.l@example.com", ticketId: "lub000000001", ticketType: "speaker", promoCode: "SPEAKER" });
  assert.deepEqual(await autoLinkEmail("nicole.l@example.com"), []);
  assert.equal(await claimer("lub000000001"), "");
  assert.deepEqual(await autoLinkEmail("nobody.l@example.com"), []);
});

test("backfill: links the rest once, then there's nothing left", { skip }, async () => {
  const r = await call("POST", "/api/console/people/link-passes", { body: { preview: false } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.linked.map((x) => x.ticketId), ["bea000000001"]);
  assert.deepEqual(await ticketsOf(U.bea), ["bea000000001"]);
  assert.equal(await audits("bea000000001"), 1);
  assert.ok(await M.AdminAudit.findOne({ action: "pass_auto_link_backfill" }).lean());
  const after = await call("POST", "/api/console/people/link-passes", { body: { preview: true } });
  assert.deepEqual([after.body.toLink, after.body.link], [0, []]);
  assert.ok(after.body.skipped.some((x) => x.ticketId === "lub000000001" && x.why === "name_differs"));
  assert.ok(previewBody);
});
