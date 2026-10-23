/* Media = Yes (Oct 23 2026, the organiser: "Media has privilege of power pass with breakfast. Media yes is dark
   blue pass." and "update the admin panel to include media yes/no too") through the real routes, against a real
   (throwaway) MongoDB: PATCH /api/console/people/:id { media } on a pass-only person and on an account, then
   everything that follows from services/passExtras.js: the profile's pass extras and colour band, the People
   filter and counts, /auth/me `inclusions`, the RSVP page's lookup, the door card, the event summary's
   entitlement, staff's per-pass No, Give a pass (preview, create, edit, the list's Media marks) and the Speaker
   passes list.
   Starts a local mongod in a temp folder on a free port and stops it after; skipped when the binary isn't
   there (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Nothing leaves the
   machine: Sanity and Resend are answered by a stubbed fetch, no Stripe key, and no route used here sends an
   email. Fictional people, example.com. */
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
const sent = [];
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.startsWith("https://api.resend.com/")) { sent.push(url); return new Response(JSON.stringify({ id: "stub" }), { status: 200, headers: { "content-type": "application/json" } }); }
  if (url.includes(".sanity.io/")) return new Response(JSON.stringify({ result: [] }), { status: 200, headers: { "content-type": "application/json" } });
  throw new Error(`blocked in the test: ${url}`);
};

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });

let mongod = null;
let dbDir = "";
let server = null;
let base = "";
const M = {};
const U = {};
let jwt;
let mongoose;

const ALL = { cxo: true, lunch: true, gala: true, awards: true };
const NONE = { cxo: false, lunch: false, gala: false, awards: false };
const FOUR_LINES = ["2× CxO Breakfasts", "2× Luncheons", "1× Gala Dinner & Networking Reception", "1× Awards Night"];
const FOUR_OPTIONS = ["cxo_d1", "cxo_d2", "lunch_d1", "lunch_d2", "gala", "awards"];

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-media-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_media_test`, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  ({ default: jwt } = await import("jsonwebtoken"));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.Attendee = await imp("../models/Attendee.js");
  Object.assign(M, await import("../models/Admin.js"));
  const { default: express } = await import("express");
  const { issuedPassRouter } = await import("../routes/issuedPasses.js");
  const app = express();
  app.use(express.json());
  app.use("/api/console/people", (await import("../routes/people.js")).default);
  app.use("/api/console/issued-passes", issuedPassRouter("issued"));
  app.use("/api/console/exhibitor-passes", issuedPassRouter("exhibitor"));
  app.use("/api/console/summary", (await import("../routes/eventSummary.js")).default);
  app.use("/api/console", (await import("../routes/console.js")).default);
  app.use("/api/auth", (await import("../routes/auth.js")).default);
  app.use("/api/rsvp", (await import("../routes/rsvp.js")).default);
  app.use("/api/checkin", (await import("../routes/checkin.js")).default);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  U.mia = await M.User.create({ name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management" });
  U.sam = await M.User.create({ name: "Sam Staff", email: "sam.staff@example.com", role: "admin", staffRole: "staff" });
  U.abe = await M.User.create({ name: "Abe Account", email: "abe.account@example.com", tickets: [{ ticketId: "con400000001", type: "connect", purchaseDate: new Date("2026-10-01") }] });
  U.kai = await M.User.create({ name: "Kai Claimer", email: "kai.claimer@example.com", types: ["media"] });
  await M.Attendee.create([
    // A guest pass bought without an account.
    { name: "Pia Passonly", email: "pia.passonly@example.com", ticketId: "con400000002", ticketType: "connect", stripeSessionId: "cs_pia",
      details: { firstName: "Pia", lastName: "Passonly" } },
    // Speaker Passes: one pass-only (staff will mark them Media), one claimed by an account of the media type, one neither.
    { name: "Sol Speaker", email: "sol.speaker@example.com", ticketId: "spk400000001", ticketType: "speaker", promoCode: "SPEAKER", speakerId: "sanity-sol" },
    { name: "Kai Claimer", email: "kai.claimer@example.com", ticketId: "spk400000002", ticketType: "speaker", promoCode: "SPEAKER", speakerId: "sanity-kai", claimedBy: U.kai._id },
    { name: "Tia Talker", email: "tia.talker@example.com", ticketId: "spk400000003", ticketType: "speaker", promoCode: "SPEAKER", speakerId: "sanity-tia" },
  ]);
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const tokenFor = (u, via) => jwt.sign({ id: String(u._id), ...(via ? { via } : {}) }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function call(method, url, { as = U.mia, via, body } = {}) {
  const r = await realFetch(base + url, {
    method, headers: { "content-type": "application/json", authorization: `Bearer ${tokenFor(as, via)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const pub = async (method, url, body) => {
  const r = await realFetch(base + url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const idOf = async (q) => (await call("GET", `/api/console/people?q=${encodeURIComponent(q)}&refresh=1`)).body.rows[0]?.id;
const profile = async (id) => (await call("GET", `/api/console/people/${id}`)).body.person;
const included = (pass) => Object.fromEntries(Object.entries(pass.extras).map(([k, v]) => [k, v.included]));
const lookup = (firstName, lastName, ticketId) => pub("POST", "/api/rsvp/lookup", { firstName, lastName, ticketId, _hp: "" });
const galaEntitled = async () => (await call("GET", "/api/console/summary?refresh=1")).body.meals.rows.find((r) => r.key === "gala").entitled;

test("PATCH { media } on a pass-only person: all four extras on their Connect Pass everywhere, staff's No still wins, off again", { skip }, async () => {
  const id = await idOf("Pia Passonly");
  assert.ok(id?.startsWith("a-"), id);
  const was = await profile(id);
  assert.deepEqual([was.media, included(was.passes[0])], [false, NONE]);
  assert.equal(was.band.key, "pass");
  const galaBefore = await galaEntitled();

  // Staff (not only management) switch it, as the check-in desk will: the same contract as before.
  const r = await call("PATCH", `/api/console/people/${id}`, { as: U.sam, body: { media: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await M.Attendee.findOne({ ticketId: "con400000002" }).lean()).media, true);
  const p = await profile(id);
  assert.equal(p.media, true);
  assert.ok(p.types.includes("media"));
  assert.deepEqual(included(p.passes[0]), ALL);
  assert.ok(Object.values(p.passes[0].extras).every((x) => x.auto === true && x.override === null));
  assert.deepEqual(p.rsvpRules.extras, ALL);
  assert.deepEqual(p.band, { key: "media", label: "Media", bg: "#0B3D91", text: "#FFFFFF", passName: "Connect Pass" });
  assert.match((await M.AdminAudit.findOne({ action: "person_edit" }).sort({ createdAt: -1 }).lean()).detail, /media No → Yes/);

  // People: the filter, the row's mark and band, the count.
  const yes = (await call("GET", "/api/console/people?media=yes")).body;
  assert.ok(yes.rows.some((row) => row.id === id && row.media === true && row.band.key === "media"));
  assert.ok(yes.rows.every((row) => row.media === true));
  assert.equal(yes.counts.media, yes.total);
  assert.ok(!(await call("GET", "/api/console/people?media=no")).body.rows.some((row) => row.id === id));

  // The RSVP page offers them the four; the door card says Media with all four; the event summary counts them.
  const look = await lookup("Pia", "Passonly", "CON400000002");
  assert.equal(look.status, 200, JSON.stringify(look.body));
  assert.deepEqual([look.body.tier, look.body.verified, look.body.cxoBreakfast], ["connect", true, true]);
  for (const k of FOUR_OPTIONS) assert.ok(look.body.allowedOptions.includes(k), k);
  const scan = await call("POST", "/api/checkin/scan", { as: U.sam, body: { ticketId: "TECHFEST:con400000002" } });
  assert.equal(scan.status, 200, JSON.stringify(scan.body));
  assert.deepEqual([scan.body.badge.key, scan.body.badge.label, scan.body.badge.bg, scan.body.passName], ["media", "Media", "#0B3D91", "Connect Pass"]);
  assert.deepEqual(scan.body.extras, ALL);
  assert.equal(await galaEntitled(), galaBefore + 1);

  // Staff's No on one extra of the pass: only that one comes off, everywhere.
  const no = await call("PATCH", `/api/console/people/${id}/passes/con400000002`, { as: U.sam, body: { extras: { gala: false } } });
  assert.equal(no.status, 200, JSON.stringify(no.body));
  assert.deepEqual(included(no.body.person.passes[0]), { ...ALL, gala: false });
  const look2 = await lookup("Pia", "Passonly", "CON400000002");
  assert.ok(!look2.body.allowedOptions.includes("gala") && look2.body.allowedOptions.includes("awards"));
  const scan2 = await call("POST", "/api/checkin/scan", { as: U.sam, body: { ticketId: "con400000002" } });
  assert.deepEqual([scan2.body.status, scan2.body.extras], ["already_checked_in", { ...ALL, gala: false }]);
  await call("PATCH", `/api/console/people/${id}/passes/con400000002`, { body: { extras: { gala: null } } });

  // Media off: back to the Connect Pass's own rule.
  const off = await call("PATCH", `/api/console/people/${id}`, { body: { media: false } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal("media" in (await M.Attendee.findOne({ ticketId: "con400000002" }).lean()), false);
  const after = await profile(id);
  assert.deepEqual([after.media, included(after.passes[0]), after.band.key], [false, NONE, "pass"]);
  assert.equal((await lookup("Pia", "Passonly", "CON400000002")).body.allowedOptions.includes("gala"), false);
  assert.equal(await galaEntitled(), galaBefore);
  assert.equal((await call("PATCH", `/api/console/people/${id}`, { body: { media: "yes" } })).status, 400);
});

test("PATCH { media } on an account: its type, /auth/me inclusions for the apps, the RSVP page, the profile and People", { skip }, async () => {
  const id = await idOf("Abe Account");
  assert.ok(id?.startsWith("u-"), id);
  const meBefore = (await call("GET", "/api/auth/me", { as: U.abe, via: "email" })).body;
  assert.equal(meBefore.tickets[0].cxoBreakfast, false);
  assert.ok(!FOUR_LINES.some((l) => meBefore.tickets[0].inclusions.includes(l)));

  const r = await call("PATCH", `/api/console/people/${id}`, { as: U.sam, body: { media: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await M.User.findById(U.abe._id).lean()).types, ["media"]);
  const me = (await call("GET", "/api/auth/me", { as: U.abe, via: "email" })).body;
  assert.equal(me.tickets[0].cxoBreakfast, true);
  for (const l of FOUR_LINES) assert.ok(me.tickets[0].inclusions.includes(l), l);
  assert.deepEqual(me.profileTag, { key: "media", label: "Media" });
  const p = await profile(id);
  assert.deepEqual([p.media, included(p.passes[0]), p.band.key, p.band.passName], [true, ALL, "media", "Connect Pass"]);
  const look = await lookup("Abe", "Account", "CON400000001");
  for (const k of FOUR_OPTIONS) assert.ok(look.body.allowedOptions.includes(k), k);
  // VIP gold stays above Media.
  await call("PATCH", `/api/console/people/${id}`, { body: { vip: true } });
  const vip = await profile(id);
  assert.deepEqual([vip.band.key, vip.band.bg, vip.media, included(vip.passes[0])], ["vip", "#F5C400", true, ALL]);
  await call("PATCH", `/api/console/people/${id}`, { body: { vip: false } });

  // Off: the type goes, and with it the extras.
  const off = await call("PATCH", `/api/console/people/${id}`, { body: { media: false } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.deepEqual((await M.User.findById(U.abe._id).lean()).types, []);
  assert.deepEqual(included((await profile(id)).passes[0]), NONE);
  assert.equal((await call("GET", "/api/auth/me", { as: U.abe, via: "email" })).body.tickets[0].cxoBreakfast, false);
});

test("Give a pass: the preview's Automatic follows the Media mark, the list shows who is Media, an edit switches it", { skip }, async () => {
  const prev = await call("POST", "/api/console/issued-passes/preview", { as: U.sam, body: { name: "Mo Press", email: "mo.press@example.com", tier: "connect", media: true } });
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  assert.ok(Object.values(prev.body.extras).every((x) => x.auto && x.included));
  for (const word of [/CxO Breakfast/i, /Luncheon/i, /Gala Dinner/i, /Awards Night/i]) assert.ok(prev.body.includes.some((h) => word.test(h)), String(word));
  const plain = await call("POST", "/api/console/issued-passes/preview", { as: U.sam, body: { name: "Mo Press", email: "mo.press@example.com", tier: "connect", vip: true } });
  assert.deepEqual(Object.fromEntries(Object.entries(plain.body.extras).map(([k, v]) => [k, v.auto])), { ...NONE, cxo: true });

  const made = await call("POST", "/api/console/issued-passes", { as: U.sam, body: { name: "Mo Press", email: "mo.press@example.com", tier: "connect", media: true } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual([made.body.row.media, Object.values(made.body.row.extras).every((x) => x.included)], [true, true]);
  const list = (await call("GET", "/api/console/issued-passes")).body.rows;
  assert.deepEqual([list[0].media, list[0].personMedia], [true, true]);

  const ed = await call("PATCH", `/api/console/issued-passes/${made.body.row.id}`, { body: { media: false } });
  assert.equal(ed.status, 200, JSON.stringify(ed.body));
  assert.deepEqual([ed.body.row.media, Object.values(ed.body.row.extras).some((x) => x.included)], [false, false]);
  const list2 = (await call("GET", "/api/console/issued-passes")).body.rows;
  assert.deepEqual([list2[0].media, list2[0].personMedia], [false, false]);
  // People sees the change at once (the directory is rebuilt after an edit on Give a pass).
  const id = (await call("GET", "/api/console/people?q=Mo%20Press")).body.rows[0];
  assert.deepEqual([id.media, id.band.key], [false, "pass"]);
  assert.equal(sent.length, 0); // nothing was emailed
});

test("Speaker passes list: Media as People has it, from a pass-only speaker's mark or a claiming account's type", { skip }, async () => {
  const sol = await idOf("Sol Speaker");
  assert.equal((await call("PATCH", `/api/console/people/${sol}`, { as: U.sam, body: { media: true } })).status, 200);
  const rows = (await call("GET", "/api/console/speaker-passes")).body.rows;
  const media = Object.fromEntries(rows.map((r) => [r.name, r.media]));
  assert.deepEqual(media, { "Kai Claimer": true, "Sol Speaker": true, "Tia Talker": false });
  // A media speaker's Speaker Pass already has all four; the band is Media's dark blue, above Speaker red.
  const p = await profile(sol);
  assert.deepEqual([p.band.key, p.band.passName, included(p.passes[0])], ["media", "Speaker Pass", ALL]);
  assert.equal((await profile(await idOf("Tia Talker"))).band.key, "speaker");
});
