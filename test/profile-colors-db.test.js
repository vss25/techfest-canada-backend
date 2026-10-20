/* The app Profile page's colour and the tags behind it (Oct 20 2026), through the real routes, against a real
   (throwaway) MongoDB: GET /auth/me `profileTag` for every colour, the CxO Breakfasts for VIPs and media on any
   pass (/auth/me tickets, the RSVP lookup), Admin › People's Media switch (an account, a pass-only person) and
   the Type filter, and Give a pass's VIP / Media marks (create, preview, edit, audit).
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
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.startsWith("https://api.resend.com/")) return new Response(JSON.stringify({ id: "stub" }), { status: 200, headers: { "content-type": "application/json" } });
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
let clearExhibitorCache;
const U = {};

const ticket = (ticketId, type, extra = {}) => ({ ticketId, type, purchaseDate: new Date("2026-10-01"), ...extra });

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-profile-colors-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_profile_colors_test`, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  ({ default: jwt } = await import("jsonwebtoken"));
  ({ clearExhibitorCache } = await import("../services/exhibitorCache.js"));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.Attendee = await imp("../models/Attendee.js");
  Object.assign(M, await import("../models/Admin.js"));
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/console/people", (await import("../routes/people.js")).default);
  app.use("/api/console/issued-passes", (await import("../routes/issuedPasses.js")).default);
  app.use("/api/auth", (await import("../routes/auth.js")).default);
  app.use("/api/rsvp", (await import("../routes/rsvp.js")).default);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  // The people (fictional), one per colour and the pairs the organiser named.
  const mk = (key, doc) => M.User.create(doc).then((u) => { U[key] = u; });
  await Promise.all([
    mk("mia", { name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management" }),
    mk("sam", { name: "Sam Staff", email: "sam.staff@example.com", role: "admin", staffRole: "staff" }),
    mk("vera", { name: "Vera Vip", email: "vera.vip@example.com", vip: true, types: ["speaker"], tickets: [ticket("pow200000001", "power")] }),
    mk("pip", { name: "Pip Passvip", email: "pip.passvip@example.com", tickets: [ticket("pow200000002", "power")] }),
    mk("max", { name: "Max Media", email: "max.media@example.com", types: ["speaker", "media"], tickets: [ticket("pow200000003", "power")] }),
    mk("sol", { name: "Sol Speaker", email: "sol.speaker@example.com", tickets: [ticket("spk200000004", "speaker")] }),
    mk("val", { name: "Val Volunteer", email: "val.volunteer@example.com", role: "volunteer", tickets: [ticket("con200000005", "connect")] }),
    mk("ola", { name: "Ola Organiser", email: "ola.organiser@example.com", types: ["staff", "volunteer"], tickets: [ticket("con200000006", "connect")] }),
    mk("eve", { name: "Eve Exhibitor", email: "eve.exhibitor@example.com", tickets: [ticket("con200000007", "connect", { promoCode: "EXHIBITOR" })] }),
    mk("ada", { name: "Ada Apex", email: "ada.apex@example.com", tickets: [ticket("inf200000008", "influence"), ticket("apx200000008", "apex")] }),
    mk("nia", { name: "Nia Nopass", email: "nia.nopass@example.com" }),
    mk("ray", { name: "Ray Reporter", email: "ray.reporter@example.com", tickets: [ticket("pow200000009", "power")] }),
  ]);
  await M.Attendee.create([
    // Pip's pass was marked VIP before he had an account; he claimed it.
    { name: "Pip Passvip", email: "pip.passvip@example.com", ticketId: "pow200000002", ticketType: "power", claimedBy: U.pip._id, vip: true },
    { name: "Eve Exhibitor", email: "eve.exhibitor@example.com", ticketId: "con200000007", ticketType: "connect", promoCode: "EXHIBITOR", claimedBy: U.eve._id },
    // A pass-only guest on Power (no app account yet).
    { name: "Gus Guest", email: "gus.guest@example.com", ticketId: "pow200000010", ticketType: "power", stripeSessionId: "cs_gus" },
  ]);
  clearExhibitorCache();
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
const me = async (key) => (await call("GET", "/api/auth/me", { as: U[key], via: "email" })).body;
const idOf = async (q) => (await call("GET", `/api/console/people?q=${encodeURIComponent(q)}&refresh=1`)).body.rows[0]?.id;

test("/auth/me profileTag: every colour, in the organiser's order, with the other fields unchanged", { skip }, async () => {
  const want = {
    vera: { key: "vip", label: "VIP" },            // VIP + speaker → VIP
    pip: { key: "vip", label: "VIP" },             // VIP from his pass (Attendee.vip)
    max: { key: "media", label: "Media" },         // media + speaker → media
    sol: { key: "speaker", label: "Speaker" },     // a Speaker Pass
    sam: { key: "staff", label: "Staff" },         // a staff account
    ola: { key: "staff", label: "Staff" },         // staff + volunteer → staff
    val: { key: "volunteer", label: "Volunteer" }, // a volunteer account on a Connect Pass
    eve: { key: "pass", label: "Exhibitor" },      // an exhibitor pass (Connect)
    ada: { key: "pass", label: "Apex" },           // the best of two passes
    ray: { key: "pass", label: "Power" },
    nia: null,                                     // no pass, no tag
  };
  for (const [k, tag] of Object.entries(want)) {
    const body = await me(k);
    assert.deepEqual(body.profileTag, tag, k);
  }
  // Nothing else changed shape: tickets, types and rights are still there.
  const vera = await me("vera");
  assert.deepEqual(vera.types, ["speaker"]);
  assert.equal(typeof vera.rights.post, "boolean");
  assert.equal(vera.tickets[0].ticketId, "pow200000001");
  assert.equal("media" in vera, false);
});

test("CxO Breakfasts: a VIP's and a media person's Power Pass include them on /auth/me and the RSVP page", { skip }, async () => {
  for (const k of ["vera", "pip", "max"]) assert.equal((await me(k)).tickets[0].cxoBreakfast, true, k);
  assert.ok((await me("pip")).tickets[0].inclusions.includes("2× CxO Breakfasts"));
  assert.equal((await me("ray")).tickets[0].cxoBreakfast, false);
  // The RSVP page offers them on Pip's ticket (VIP from his pass) and Max's (media type).
  for (const [first, last, id] of [["Pip", "Passvip", "POW200000002"], ["Max", "Media", "POW200000003"]]) {
    const look = await pub("POST", "/api/rsvp/lookup", { firstName: first, lastName: last, ticketId: id });
    assert.equal(look.status, 200);
    assert.equal(look.body.cxoBreakfast, true, first);
    assert.ok(look.body.allowedOptions.includes("cxo_d1"), first);
  }
  const ray = await pub("POST", "/api/rsvp/lookup", { firstName: "Ray", lastName: "Reporter", ticketId: "POW200000009" });
  assert.equal(ray.body.allowedOptions.includes("cxo_d1"), false);
});

test("Admin › People: Media on an account (its type) and on a pass-only person (their passes); the Type filter", { skip }, async () => {
  // Ray (an account): staff mark him Media → the media type; his profile goes dark blue, his Power Pass gets the breakfasts.
  const rayId = await idOf("Ray Reporter");
  const r = await call("PATCH", `/api/console/people/${rayId}`, { as: U.sam, body: { media: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await M.User.findById(U.ray._id).lean()).types, ["media"]);
  assert.match((await M.AdminAudit.findOne({ action: "person_edit", targetId: rayId }).sort({ createdAt: -1 }).lean()).detail, /media No → Yes/);
  assert.deepEqual((await me("ray")).profileTag, { key: "media", label: "Media" });
  assert.equal((await me("ray")).tickets[0].cxoBreakfast, true);
  // The same through the types list (the Type chips): back off again.
  const off = await call("PATCH", `/api/console/people/${rayId}`, { as: U.sam, body: { types: [], typesOff: [] } });
  assert.equal(off.status, 200);
  assert.deepEqual((await me("ray")).profileTag, { key: "pass", label: "Power" });
  assert.equal((await call("PATCH", `/api/console/people/${rayId}`, { body: { media: "yes" } })).status, 400);

  // Gus (pass-only): Media is saved on his passes; the account that claims one is Media too.
  const gusId = await idOf("Gus Guest");
  const g = await call("PATCH", `/api/console/people/${gusId}`, { as: U.sam, body: { media: true } });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.equal((await M.Attendee.findOne({ ticketId: "pow200000010" }).lean()).media, true);
  assert.deepEqual(g.body.person.types, ["media"]);
  assert.equal(g.body.person.mediaPass, true);
  assert.equal(g.body.person.pass.extras.cxo.included, true);
  // Other types still need an account.
  assert.equal((await call("PATCH", `/api/console/people/${gusId}`, { body: { types: ["volunteer"] } })).status, 409);
  // The Type filter: Media lists him (and Max).
  const list = (await call("GET", "/api/console/people?type=media&refresh=1")).body.rows.map((p) => p.name).sort();
  assert.deepEqual(list, ["Gus Guest", "Max Media"]);
  // He claims his pass with a new account: Media follows (Attendee.media through the exhibitor index).
  const gus = await M.User.create({ name: "Gus Guest", email: "gus.guest@example.com", tickets: [ticket("pow200000010", "power")] });
  await M.Attendee.updateOne({ ticketId: "pow200000010" }, { $set: { claimedBy: gus._id } });
  U.gus = gus;
  clearExhibitorCache();
  assert.deepEqual((await me("gus")).profileTag, { key: "media", label: "Media" });
  assert.deepEqual((await me("gus")).types, ["media"]);
  // Switched off on the account: typesOff, so the pass's mark no longer counts.
  const gusAcc = await idOf("Gus Guest");
  const g2 = await call("PATCH", `/api/console/people/${gusAcc}`, { body: { media: false } });
  assert.equal(g2.status, 200, JSON.stringify(g2.body));
  assert.deepEqual((await M.User.findById(gus._id).lean()).typesOff, ["media"]);
  clearExhibitorCache();
  assert.deepEqual((await me("gus")).profileTag, { key: "pass", label: "Power" });
});

test("Give a pass: Mark as VIP / Media saved on the pass, CxO Breakfasts on Automatic, edits audited", { skip }, async () => {
  const tiers = (await call("GET", "/api/console/issued-passes/tiers", { as: U.sam })).body;
  assert.deepEqual(tiers.marks, ["vip", "media"]);
  assert.deepEqual(tiers.markTiers, { vip: "power", media: "power", volunteer: "connect" });
  assert.match(tiers.extras.find((x) => x.key === "cxo").auto, /VIPs and media/);
  // Preview: a Power Pass marked Media lists the breakfasts.
  const prev = await call("POST", "/api/console/issued-passes/preview", { as: U.sam, body: { name: "Mona Press", email: "mona.press@example.com", tier: "power", media: true } });
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  assert.ok(prev.body.includes.includes("2× CxO Breakfasts"));
  const plain = await call("POST", "/api/console/issued-passes/preview", { as: U.sam, body: { name: "Mona Press", email: "mona.press@example.com", tier: "power" } });
  assert.equal(plain.body.includes.includes("2× CxO Breakfasts"), false);
  // Create (staff may give one pass): saved on the Attendee row, audited.
  const made = await call("POST", "/api/console/issued-passes", { as: U.sam, body: { name: "Mona Press", email: "mona.press@example.com", tier: "power", media: true, vip: false } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual([made.body.row.media, made.body.row.vip, made.body.row.extras.cxo.included, made.body.row.extras.cxo.override], [true, false, true, null]);
  const doc = await M.Attendee.findOne({ ticketId: made.body.row.ticketId }).lean();
  assert.deepEqual([doc.media, "vip" in doc, doc.ticketType], [true, false, "power"]);
  assert.match((await M.AdminAudit.findOne({ action: "issued_pass_create", targetId: doc.ticketId }).lean()).detail, /, Media Yes/);
  // Edit (management): VIP on, Media off; the same again is no change.
  const ed = await call("PATCH", `/api/console/issued-passes/${made.body.row.id}`, { body: { vip: true, media: false } });
  assert.equal(ed.status, 200, JSON.stringify(ed.body));
  assert.deepEqual([ed.body.row.vip, ed.body.row.media, ed.body.row.extras.cxo.included], [true, false, true]);
  const after = await M.Attendee.findOne({ ticketId: doc.ticketId }).lean();
  assert.deepEqual([after.vip, "media" in after], [true, false]);
  assert.match((await M.AdminAudit.findOne({ action: "issued_pass_edit", targetId: doc.ticketId }).lean()).detail, /VIP No → Yes, Media Yes → No/);
  const same = await call("PATCH", `/api/console/issued-passes/${made.body.row.id}`, { body: { vip: true } });
  assert.equal(same.status, 200);
  assert.equal(await M.AdminAudit.countDocuments({ action: "issued_pass_edit", targetId: doc.ticketId }), 1);
  // The pass itself never changed: Power, as created.
  assert.equal(after.ticketType, "power");
  assert.equal((await call("POST", "/api/console/issued-passes", { as: U.mia, body: { name: "Bad Mark", email: "bad.mark@example.com", tier: "power", vip: "yes" } })).status, 400);
});
