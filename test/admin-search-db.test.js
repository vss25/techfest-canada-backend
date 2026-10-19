/* Admin global search against a real (throwaway) MongoDB, through the real console route.
   Starts a local mongod in a temp folder on a free port and stops it after; skipped when the
   binary isn't there (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6).
   Nothing leaves the machine: Sanity is answered here, Stripe has no key, Resend a dummy key and
   nothing here sends email. Fictional people, example.com addresses. */
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

// The public Sanity CDN: the speaker list (People directory) and the search's CMS documents. Never the network.
const SPEAKERS = [{ _id: "spk-kai", name: "Kai Speaker", title: "Chief Scientist", company: "Quantum Example" }];
const CMS = [
  { _id: "sess-q", _type: "session", title: "Quantum Computing in Finance", day: 1, time: "10:00", endTime: "10:30", stage: "Harbour Ballroom", speakers: ["Kai Speaker"] },
  { _id: "spk-kai", _type: "speaker", name: "Kai Speaker", title: "Chief Scientist", company: "Quantum Example" },
  { _id: "par-1", _type: "partner", name: "Example Robotics", category: "corporateEnterprisePartners", matrixGroup: "featured" },
  { _id: "alu-1", _type: "sponsor", name: "Example Logistics" },
];
const realFetch = globalThis.fetch;
const outside = [];
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.includes(".sanity.io/")) {
    const q = decodeURIComponent(url.split("query=")[1] || "");
    const result = /_type in \["session"/.test(q) ? CMS : /_type=="speaker"/.test(q) ? SPEAKERS : [];
    return new Response(JSON.stringify({ result }), { status: 200, headers: { "content-type": "application/json" } });
  }
  outside.push(url);
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
const T = {}; // tokens

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-search-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_admin_search_test`, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  ({ default: jwt } = await import("jsonwebtoken"));
  const imp = async (p) => (await import(p)).default;
  for (const m of ["User", "Attendee", "Rsvp", "Nomination", "FormSubmission", "Brochure", "PavilionApplication"]) M[m] = await imp(`../models/${m}.js`);
  const d = (s) => new Date(`2026-${s}T12:00:00Z`);

  const [mia, sam, val, ann, rae] = await M.User.create([
    { name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management" },
    { name: "Sam Staff", email: "sam.staff@example.com", role: "admin", staffRole: "staff" },
    { name: "Val Volunteer", email: "val.volunteer@example.com", role: "volunteer" },
    { name: "Ann Attendee", email: "ann.attendee@example.com", role: "user", organization: "Example Bank", jobTitle: "Head of Digital",
      tickets: [{ ticketId: "a1b2c3d4e5f6", type: "power", purchaseDate: d("10-01"), manualValue: 849, manualValueNote: "Invoice 12" }] },
    { name: "Rae Rate", email: "rae.rate@example.com", role: "admin", staffRole: "staff" },
  ]);
  await M.Attendee.create([
    { name: "Kai Speaker", ticketId: "5pk000000001", ticketType: "speaker", promoCode: "SPEAKER", speakerId: "spk-kai",
      details: { jobTitle: "Chief Scientist", organisation: "Quantum Example" } },
    { name: "Eve Exhibitor", email: "eve.exhibitor@example.com", ticketId: "e0e000000001", ticketType: "connect", promoCode: "EXHIBITOR",
      issuedPass: { booth: { booth: "B7" } }, details: { firstName: "Eve", lastName: "Exhibitor", organisation: "Robotics Example" } },
    { name: "Hidden Pass", email: "hidden.pass@example.com", ticketId: "dead00000001", ticketType: "connect", hiddenByStaff: true },
  ]);
  await M.Rsvp.create({ key: "n:rita rsvp", firstName: "Rita", lastName: "Rsvp", name: "Rita Rsvp", nameKey: "rita rsvp", email: "rita.rsvp@example.com",
    tier: "connect", days: ["day1"], options: [], source: "attendee", spam: false });
  await M.Nomination.create({ categoryType: "special", specialAward: "rising", nomineeName: "José Núñez", nomineeOrganisation: "Example Health",
    nominatorName: "Ned Nominator", nominatorEmail: "ned.nominator@example.com", status: "pending" });
  await M.FormSubmission.create([
    { form: "sponsor", name: "Fay Former", email: "fay.former@example.com", company: "Example Bank" },
    { form: "inquiry", name: "Fay Bot", email: "fay.bot@example.com", spam: true, spamReason: "honeypot" },
  ]);
  await M.Brochure.create(Array.from({ length: 7 }, (_, i) => ({
    firstName: "Capper", lastName: `Number${i}`, email: `capper${i}@example.com`, company: "Example Retail", jobTitle: "VP", brochure: "sponsorship", spam: false,
  })));
  await M.PavilionApplication.create({ legalName: "Example Pvt Ltd", repName: "Priya Rep", repEmail: "priya.rep@example.com", reference: "IP-7K3QXM", spam: false });

  const tok = (u, via) => jwt.sign({ id: String(u._id), ...(via ? { via } : {}) }, process.env.JWT_SECRET, { expiresIn: "1h" });
  Object.assign(T, { mia: tok(mia), sam: tok(sam), val: tok(val), ann: tok(ann), rae: tok(rae), samEmailCode: tok(sam, "email") });

  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/console", (await import("../routes/console.js")).default);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

async function call(method, url, { token, body } = {}) {
  const r = await realFetch(base + url, {
    method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const search = (token, q) => call("POST", "/api/console/search", { token, body: { q } });
const keys = (b) => b.groups.map((g) => g.key);
const group = (b, k) => b.groups.find((g) => g.key === k);

test("who may search: staff and management only, with their password sign-in", { skip }, async () => {
  assert.equal((await search(null, "kai")).status, 401);
  assert.equal((await search(T.ann, "kai")).status, 403, "an attendee");
  assert.equal((await search(T.val, "kai")).status, 403, "a volunteer: the app's check-in only");
  const viaCode = await search(T.samEmailCode, "kai");
  assert.deepEqual([viaCode.status, viaCode.body.code], [403, "password_required"]);
  for (const t of [T.sam, T.mia]) assert.equal((await search(t, "kai")).status, 200);
});

test("mixed results from the directory, the CMS and the leads; GET works too; nothing cached by the browser", { skip }, async () => {
  const r = await call("GET", `/api/console/search?q=${encodeURIComponent("kai")}`, { token: T.sam });
  assert.equal(r.status, 200);
  assert.deepEqual(keys(r.body), ["people", "passes", "sessions", "speakers"]);
  assert.deepEqual(group(r.body, "people").items.map((x) => [x.title, x.link]), [["Kai Speaker", group(r.body, "people").items[0].link]]);
  assert.match(group(r.body, "people").items[0].link, /^\/admin\/people\/a-[a-f0-9]{24}$/);
  assert.equal(group(r.body, "passes").items[0].link, "/admin/speaker-passes?q=5pk000000001");
  assert.equal(group(r.body, "sessions").items[0].link, "/admin/content/agenda?edit=sess-q");
  assert.deepEqual(r.body.failed, []);

  const example = (await search(T.sam, "example")).body;
  for (const k of ["people", "passes", "partners", "logos", "nominations", "forms", "brochures", "pavilion"]) assert.ok(keys(example).includes(k), k);
  assert.ok(!group(example, "forms").items.some((x) => /Bot/.test(x.title)), "bots never");
  // Accents: "jose" finds "José Núñez" in the database (the prefilter is accent-insensitive).
  assert.deepEqual(group((await search(T.sam, "jose nun")).body, "nominations").items.map((x) => x.title), ["José Núñez"]);
  assert.deepEqual(group((await search(T.sam, "Rita")).body, "rsvps").items.map((x) => x.link.replace(/[a-f0-9]{24}$/, "<id>")), ["/admin/rsvps?id=<id>"]);
});

test("exact: a ticket ID (QR prefix too) → the ticket first; an email → only that email; parts never", { skip }, async () => {
  const t = (await search(T.sam, "TECHFEST:A1B2C3D4E5F6")).body;
  assert.equal(t.query.exact, "ticket");
  assert.equal(t.groups[0].key, "tickets");
  assert.deepEqual(t.groups[0].items.map((x) => [x.title, x.exact]), [["Power Pass · A1B2C3D4E5F6", true]]);
  assert.match(t.groups[0].items[0].link, /^\/admin\/people\/u-/);
  assert.deepEqual(group(t, "people").items.map((x) => x.title), ["Ann Attendee"]);
  assert.equal((await search(T.sam, "a1b2c3d4")).body.groups.length, 0, "part of a ticket ID");
  // A pass staff hid that no account holds: found in Tickets, every tab.
  const hidden = (await search(T.sam, "DEAD00000001")).body;
  assert.deepEqual(hidden.groups.map((g) => [g.key, g.items[0].link]), [["tickets", "/admin/attendees?q=dead00000001&show=hidden"]]);

  const e = (await search(T.sam, "Ned.Nominator@example.com")).body;
  assert.equal(e.query.exact, "email");
  assert.deepEqual(e.groups.map((g) => [g.key, g.items.map((x) => x.title)]), [["nominations", ["José Núñez"]]]);
  assert.deepEqual(keys((await search(T.sam, "rita.rsvp@exam")).body), [], "part of an email");
  assert.deepEqual(keys((await search(T.sam, "rita.rsvp@example.com")).body), ["people", "rsvps"]);
  const pv = (await search(T.sam, "PRIYA.REP@EXAMPLE.COM")).body;
  assert.deepEqual(pv.groups.map((g) => g.key), ["pavilion"]);
});

test("permissions: Staff accounts and amounts paid for management only", { skip }, async () => {
  const staffView = (await search(T.sam, "sam")).body;
  assert.equal(group(staffView, "staff"), undefined);
  const mgmtView = (await search(T.mia, "sam")).body;
  assert.deepEqual(group(mgmtView, "staff").items.map((x) => [x.title, x.subtitle, x.link.replace(/[a-f0-9]{24}$/, "<id>")]),
    [["Sam Staff", "Staff · sam.staff@example.com", "/admin/staff?highlight=<id>"]]);
  assert.deepEqual(group((await search(T.mia, "val")).body, "staff").items.map((x) => x.subtitle), ["Volunteer · val.volunteer@example.com"]);
  // Ann's pass was paid outside Stripe (849 CAD, typed by management).
  const m = (await search(T.mia, "a1b2c3d4e5f6")).body;
  assert.match(group(m, "tickets").items[0].subtitle, /CA\$849\.00/);
  const s = (await search(T.sam, "a1b2c3d4e5f6")).body;
  assert.doesNotMatch(JSON.stringify(s), /CA\$|849/);
  assert.doesNotMatch(JSON.stringify((await search(T.sam, "example")).body), /CA\$|\$\d/);
});

test("injection-safe: operators and regex syntax are plain text, never an error", { skip }, async () => {
  for (const q of [{ $ne: null }, { $gt: "" }, ["$where"], 7]) {
    const r = await call("POST", "/api/console/search", { token: T.sam, body: { q } });
    assert.equal(r.status, 200, JSON.stringify(q));
  }
  assert.equal((await call("POST", "/api/console/search", { token: T.sam, body: { q: { $ne: null } } })).body.tooShort, true);
  for (const q of ["(a+)+$", ".*", "^.*$", "[", "\\", "a|b", "$where", "{\"$gt\":\"\"}", "ex)ample", "(?i)", "*example*"]) {
    const r = await search(T.sam, q);
    assert.equal(r.status, 200, q);
    assert.deepEqual(r.body.failed, [], q);
  }
  // Regex syntax doesn't widen a search: ".*" alone finds nothing, "ex)ample" is the words "ex" and "ample".
  assert.equal((await search(T.sam, ".*")).body.groups.length, 0);
  assert.equal((await search(T.sam, "*example*")).body.groups.length, (await search(T.sam, "example")).body.groups.length);
  const GET = await call("GET", "/api/console/search?q[$ne]=x", { token: T.sam });
  assert.equal(GET.status, 200);
});

test("cap: 5 per group with `more`; See all goes to the page's own search", { skip }, async () => {
  const b = group((await search(T.sam, "capper")).body, "brochures");
  assert.deepEqual([b.items.length, b.total, b.more], [5, 7, true]);
  assert.deepEqual(b.seeAll, { label: "See all in Brochure downloads", link: "/admin/brochure-downloads?q=capper" });
});

test("partial failure: the CMS down → its groups listed as failed, everything else answers; no terms in the logs", { skip }, async () => {
  const { runSearch } = await import("../services/adminSearch.js");
  const { makeSearchSources } = await import("../services/adminSearchSources.js");
  const { directory } = await import("../routes/people.js");
  const lines = [];
  const log = { error: (...a) => lines.push(a.join(" ")), log: (...a) => lines.push(a.join(" ")) };
  const sources = makeSearchSources({ directory: () => directory({ fresh: true }), cms: async () => { throw Object.assign(new Error("Sanity 503 for Kai"), { name: "CmsUnavailable" }); } });
  const out = await runSearch({ q: "kai", viewer: { management: true }, sources, log });
  assert.deepEqual(out.groups.map((g) => g.key), ["people", "passes"]);
  assert.deepEqual(out.failed.map((f) => [f.key, f.reason]), [["sessions", "error"], ["speakers", "error"], ["partners", "error"], ["logos", "error"]]);
  assert.deepEqual(lines, ["ADMIN SEARCH: cms failed (CmsUnavailable)"]);

  // The route itself logs nothing while searching (it never prints the terms).
  const seen = [];
  const keep = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a) => seen.push(a.join(" "));
  try {
    for (const q of ["ann.attendee@example.com", "Ann Attendee", "a1b2c3d4e5f6", "priya"]) await search(T.mia, q);
  } finally { Object.assign(console, keep); }
  assert.ok(!seen.some((l) => /ann|attendee|a1b2|priya/i.test(l)), seen.join("\n"));
  assert.deepEqual(outside, [], "nothing but the stubbed CMS left the machine");
});

test("index: nominations by the nominator's email", { skip }, async () => {
  await M.Nomination.init();
  const idx = await M.Nomination.collection.indexes();
  assert.ok(idx.some((i) => JSON.stringify(i.key) === JSON.stringify({ nominatorEmail: 1 })));
});

test("rate limit: 120 searches a minute per staff member, then 429", { skip }, async () => {
  let last = null;
  for (let i = 0; i < 121; i++) last = await call("GET", "/api/console/search?q=x", { token: T.rae });
  assert.deepEqual([last.status, last.body.code], [429, "rate_limited"]);
  assert.equal((await call("GET", "/api/console/search?q=x", { token: T.sam })).status, 200, "others aren't affected");
});
