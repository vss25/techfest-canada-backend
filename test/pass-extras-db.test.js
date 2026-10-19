/* Pass extras (CxO Breakfasts, luncheons, Gala Dinner, Awards Night) through the real routes, against a
   real (throwaway) MongoDB: Admin › People pass switches and their audit rows, Issue passes (create, edit,
   preview, audit), /auth/me `inclusions`, the RSVP page's lookup and save, an attendee's RSVP kept when an
   extra is switched off, staff "Add to their RSVP", the eligible counts and the CSV.
   Starts a local mongod in a temp folder on a free port and stops it after; skipped when the binary isn't
   there (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Nothing leaves the
   machine: Sanity and Resend are answered by a stubbed fetch (nothing is delivered), no Stripe key, and no
   route used here sends a pass email. Fictional people, example.com. */
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

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-extras-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_pass_extras_test`, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  ({ default: jwt } = await import("jsonwebtoken"));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.Attendee = await imp("../models/Attendee.js");
  M.Rsvp = await imp("../models/Rsvp.js");
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

  // The people (fictional).
  mia = await M.User.create({ name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management" });
  sam = await M.User.create({ name: "Sam Staff", email: "sam.staff@example.com", role: "admin", staffRole: "staff" });
  cara = await M.User.create({ name: "Cara Connect", email: "cara.connect@example.com", tickets: [{ ticketId: "con100000001", type: "connect", purchaseDate: new Date("2026-10-01") }] });
  ian = await M.User.create({ name: "Ian Influence", email: "ian.influence@example.com", tickets: [{ ticketId: "inf100000001", type: "influence", purchaseDate: new Date("2026-10-02") }] });
  await M.Attendee.create([
    // Ian's guest record of the same ticket (claimed): both are written.
    { name: "Ian Influence", email: "ian.influence@example.com", ticketId: "inf100000001", ticketType: "influence", claimedBy: ian._id },
    { name: "Pat Power", email: "pat.power@example.com", ticketId: "pow100000001", ticketType: "power", stripeSessionId: "cs_pat" },
  ]);
  // Pat RSVP'd herself, with the Gala and the Awards Night, before staff changed her pass.
  await M.Rsvp.create({
    key: "t:pow100000001", firstName: "Pat", lastName: "Power", name: "Pat Power", nameKey: "pat power", ticketId: "POW100000001",
    ticketVerified: true, kind: "ticket", tier: "power", tierVerified: true, source: "attendee", attendeeSubmittedAt: new Date("2026-10-15"),
    days: ["day1", "day2"], options: ["lunch_d1", "awards", "gala"], dietary: ["none"], submissions: 1,
  });
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

let mia, sam, cara, ian;
const tokenFor = (u, via) => jwt.sign({ id: String(u._id), ...(via ? { via } : {}) }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function call(method, url, { as = mia, via, body } = {}) {
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
const passOf = async (id, ticketId) => (await call("GET", `/api/console/people/${id}`)).body.person.passes.find((t) => t.ticketId.toLowerCase() === ticketId);
const audits = async (action) => M.AdminAudit.find({ action }).sort({ createdAt: 1 }).lean();
const rsvp = (first, last, ticketId, options, extra = {}) => pub("POST", "/api/rsvp", {
  firstName: first, lastName: last, ticketId, tier: "", days: ["day1", "day2"], options, dietary: ["none"], _hp: "", elapsedMs: 60000, page: "/rsvp", ...extra,
});

test("Admin › People: each extra Automatic / Yes / No on one pass, on both its records, audited like the CxO switch", { skip }, async () => {
  const id = await idOf("Cara Connect");
  // Staff (not just management) switch them; the Gala and the CxO Breakfasts on for Cara's Connect Pass.
  const r = await call("PATCH", `/api/console/people/${id}/passes/con100000001`, { as: sam, body: { extras: { gala: true }, cxoBreakfast: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const t = r.body.person.passes[0];
  assert.deepEqual([t.extras.gala, t.extras.cxo, t.extras.lunch], [
    { override: true, auto: false, included: true }, { override: true, auto: false, included: true }, { override: null, auto: false, included: false }]);
  assert.equal(t.cxoBreakfast, true);
  const stored = (await M.User.findById(cara._id).lean()).tickets[0];
  assert.deepEqual([stored.galaDinner, stored.cxoBreakfast, "luncheons" in stored], [true, true, false]);
  const gala = await audits("pass_gala_dinner");
  assert.equal(gala.length, 1);
  assert.equal(gala[0].detail, "Cara Connect · Connect Pass CON100000001: Gala Dinner & Networking Reception automatic (No) → Yes");
  assert.equal(gala[0].adminName, "Sam Staff");
  assert.match((await audits("pass_cxo_breakfast"))[0].detail, /: CxO Breakfast automatic \(No\) → Yes$/);
  // The same value again: nothing written, nothing logged.
  await call("PATCH", `/api/console/people/${id}/passes/con100000001`, { body: { extras: { gala: true } } });
  assert.equal((await audits("pass_gala_dinner")).length, 1);
  // Back to automatic: staff's value comes off the ticket.
  await call("PATCH", `/api/console/people/${id}/passes/con100000001`, { body: { extras: { cxo: null } } });
  assert.equal("cxoBreakfast" in (await M.User.findById(cara._id).lean()).tickets[0], false);
  assert.match((await audits("pass_cxo_breakfast"))[1].detail, /: CxO Breakfast Yes → automatic \(No\)$/);
  // Refused: not Yes / No / automatic, or not an extra.
  assert.equal((await call("PATCH", `/api/console/people/${id}/passes/con100000001`, { body: { extras: { gala: "maybe" } } })).status, 400);
  assert.equal((await call("PATCH", `/api/console/people/${id}/passes/con100000001`, { body: { extras: { brunch: true } } })).status, 400);

  // Ian: the Awards Night on, the luncheons off. His account ticket and its guest record both carry them.
  const ianId = await idOf("Ian Influence");
  const r2 = await call("PATCH", `/api/console/people/${ianId}/passes/inf100000001`, { body: { extras: { awards: true, lunch: false } } });
  assert.equal(r2.status, 200);
  const u = (await M.User.findById(ian._id).lean()).tickets[0];
  const a = await M.Attendee.findOne({ ticketId: "inf100000001" }).lean();
  assert.deepEqual([u.awardsNight, u.luncheons, a.awardsNight, a.luncheons], [true, false, true, false]);
  assert.equal((await audits("pass_awards_night"))[0].detail, "Ian Influence · Influence Pass INF100000001: Catalyst Awards Night automatic (No) → Yes");
  assert.equal((await audits("pass_luncheons"))[0].detail, "Ian Influence · Influence Pass INF100000001: Networking Luncheons automatic (Yes) → No");
});

test("/auth/me: tickets[].cxoBreakfast kept, tickets[].inclusions the full list with this pass's extras", { skip }, async () => {
  const me = await call("GET", "/api/auth/me", { as: cara, via: "email" });
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.tickets.map((t) => [t.ticketId, t.cxoBreakfast]), [["con100000001", false]]);
  assert.deepEqual(me.body.tickets[0].inclusions, ["2× Day Conference Access", "1× Gala Dinner & Networking Reception", "Expo Floor Access", "Networking Breaks"]);
  assert.equal("galaDinner" in me.body.tickets[0], false);
  const ianMe = await call("GET", "/api/auth/me", { as: ian, via: "email" });
  assert.deepEqual(ianMe.body.tickets[0].inclusions, ["2× Day Conference Access", "1× Awards Night", "Expo Floor Access", "Networking Breaks"]);
  assert.equal(ianMe.body.tickets[0].cxoBreakfast, false);
});

test("RSVP page: Cara's Connect Pass with the Gala is offered it and can save it", { skip }, async () => {
  const look = await pub("POST", "/api/rsvp/lookup", { firstName: "Cara", lastName: "Connect", ticketId: "CON100000001" });
  assert.equal(look.status, 200);
  assert.deepEqual([look.body.tier, look.body.verified], ["connect", true]);
  assert.ok(look.body.allowedOptions.includes("gala"));
  assert.ok(!look.body.allowedOptions.includes("awards") && !look.body.allowedOptions.includes("cxo_d1") && !look.body.allowedOptions.includes("lunch_d1"));
  const saved = await rsvp("Cara", "Connect", "CON100000001", ["sessions_d1", "gala"]);
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual((await M.Rsvp.findOne({ key: "t:con100000001" }).lean()).options, ["sessions_d1", "gala"]);
  // Ian (Influence, luncheons off): refused on save.
  const no = await rsvp("Ian", "Influence", "INF100000001", ["lunch_d1"]);
  assert.deepEqual([no.status, no.body.invalid], [400, ["lunch_d1"]]);
});

test("an extra switched off is no longer offered, but Pat's own RSVP with it stays exactly as she made it", { skip }, async () => {
  const before = await M.Rsvp.findOne({ key: "t:pow100000001" }).lean();
  const id = await idOf("Pat Power");
  const r = await call("PATCH", `/api/console/people/${id}/passes/pow100000001`, { body: { extras: { gala: false, awards: false } } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.person.passes[0].extras.gala.included, r.body.person.passes[0].extras.awards.included], [false, false]);
  // Her RSVP is untouched by the switch.
  const afterSwitch = await M.Rsvp.findOne({ key: "t:pow100000001" }).lean();
  assert.deepEqual([afterSwitch.options, String(afterSwitch.updatedAt)], [before.options, String(before.updatedAt)]);
  // The page still offers her the two she chose (kept), but the switch holds for anything new.
  const look = await pub("POST", "/api/rsvp/lookup", { firstName: "Pat", lastName: "Power", ticketId: "POW100000001" });
  assert.ok(look.body.allowedOptions.includes("gala") && look.body.allowedOptions.includes("awards"));
  assert.deepEqual(look.body.keepOptions, ["awards", "gala"]);
  // Sending it again keeps them.
  const again = await rsvp("Pat", "Power", "POW100000001", ["lunch_d1", "awards", "gala"]);
  assert.equal(again.status, 201);
  assert.deepEqual((await M.Rsvp.findOne({ key: "t:pow100000001" }).lean()).options, ["lunch_d1", "awards", "gala"]);
  // The profile shows her RSVP as hers (Confirmed by Individual), the rules the RSVP editor uses carry the switches.
  const prof = (await call("GET", `/api/console/people/${id}`)).body;
  assert.equal(prof.person.rsvp.status, "attendee");
  assert.deepEqual(prof.person.rsvpRules.extras, { cxo: false, lunch: true, gala: false, awards: false });
  assert.deepEqual(prof.person.rsvpRules.keep, ["lunch_d1", "awards", "gala"]);
});

test("staff can still \"Add to their RSVP\": a Yes extra inside the pass, a No one only as a staff override", { skip }, async () => {
  const caraId = await idOf("Cara Connect");
  const caraRsvp = (await call("GET", `/api/console/people/${caraId}`)).body.rsvp;
  // Awards Night isn't on Cara's pass: refused, then allowed on purpose (saved with a warning).
  const refused = await call("PUT", `/api/console/people/${caraId}/rsvp`, { as: sam, body: { options: ["sessions_d1", "gala", "awards"], basedOn: caraRsvp.updatedAt, rsvpId: caraRsvp.id } });
  assert.deepEqual([refused.status, refused.body.code], [400, "outside_pass"]);
  const added = await call("PUT", `/api/console/people/${caraId}/rsvp`, { as: sam, body: { options: ["sessions_d1", "gala", "awards"], allowOutsidePass: true, basedOn: caraRsvp.updatedAt, rsvpId: caraRsvp.id } });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.deepEqual([added.body.rsvp.options, added.body.rsvp.staffAdded], [["sessions_d1", "awards", "gala"], ["awards"]]);
  assert.match(added.body.warning, /Catalyst Awards Night/);
  // Pat's luncheon on Day 2 (luncheons are on her pass): added inside the pass, no warning; her own choices stay.
  const patId = await idOf("Pat Power");
  const patRsvp = (await call("GET", `/api/console/people/${patId}`)).body.rsvp;
  const lunch = await call("PUT", `/api/console/people/${patId}/rsvp`, { as: sam, body: { options: ["lunch_d1", "awards", "gala", "lunch_d2"], basedOn: patRsvp.updatedAt, rsvpId: patRsvp.id } });
  assert.equal(lunch.status, 200, JSON.stringify(lunch.body));
  assert.deepEqual([lunch.body.rsvp.options, lunch.body.rsvp.staffAdded, lunch.body.warning], [["lunch_d1", "awards", "lunch_d2", "gala"], ["lunch_d2"], ""]);
  // Staff can't take off what she chose, even with the Gala switched off.
  const take = await call("PUT", `/api/console/people/${patId}/rsvp`, { as: sam, body: { options: ["lunch_d1", "lunch_d2"], rsvpId: patRsvp.id } });
  assert.deepEqual([take.status, take.body.code], [409, "attendee_rsvp"]);
});

test("Issue passes: extras on the form, the email's list, the audit log; claimed passes keep the account in step", { skip }, async () => {
  const tiers = await call("GET", "/api/console/issued-passes/tiers", { as: sam });
  assert.deepEqual(tiers.body.extras.map((x) => x.key), ["cxo", "lunch", "gala", "awards"]);
  assert.deepEqual(tiers.body.tiers.find((t) => t.key === "power").autoExtras, { cxo: false, lunch: true, gala: true, awards: true });
  // The unsaved form's preview lists what the pass will include.
  const prev = await call("POST", "/api/console/issued-passes/preview", { as: sam, body: { name: "Gia Guest", email: "gia@example.com", tier: "connect", extras: { gala: true, lunch: true } } });
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  assert.deepEqual(prev.body.includes, ["1× Gala Dinner & Networking Reception", "2× Luncheons", "2× Day Conference Access", "Expo Floor Access", "Networking Breaks"]);
  assert.match(prev.body.text, /RSVP for the luncheons and the Gala Dinner, so we can save your seat and plan catering\./);
  // Creating stores them and logs them. (Staff may create a single pass since Oct 19 2026, test/admin-simplify-db.test.js;
  // changing one stays management only.)
  const made = await call("POST", "/api/console/issued-passes", { body: { name: "Gia Guest", email: "gia@example.com", tier: "connect", extras: { gala: true, lunch: true } } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal((await call("PATCH", `/api/console/issued-passes/${made.body.row.id}`, { as: sam, body: { tier: "power" } })).status, 403);
  assert.deepEqual([made.body.row.extras.gala.included, made.body.row.extras.lunch.included, made.body.row.extras.awards.included], [true, true, false]);
  const doc = await M.Attendee.findOne({ ticketId: made.body.row.ticketId }).lean();
  assert.deepEqual([doc.galaDinner, doc.luncheons, "awardsNight" in doc], [true, true, false]);
  assert.match((await audits("issued_pass_create"))[0].detail, /connect pass for Gia Guest <gia@example\.com>, Networking Luncheons Yes, Gala Dinner & Networking Reception Yes$/);
  const sent = await call("GET", `/api/console/issued-passes/${made.body.row.id}/preview`, { as: sam });
  assert.ok(sent.body.includes.includes("1× Gala Dinner & Networking Reception"));
  assert.match(sent.body.html, /1× Gala Dinner &amp; Networking Reception/);
  // Editing: Gala back to automatic (off for Connect), the Awards Night on.
  const ed = await call("PATCH", `/api/console/issued-passes/${made.body.row.id}`, { body: { extras: { gala: null, awards: true } } });
  assert.equal(ed.status, 200);
  const after2 = await M.Attendee.findOne({ ticketId: made.body.row.ticketId }).lean();
  assert.deepEqual(["galaDinner" in after2, after2.awardsNight], [false, true]);
  const edit = (await audits("issued_pass_edit")).at(-1);
  assert.equal(edit.detail, "Gia Guest: Gala Dinner & Networking Reception Yes → automatic (No), Catalyst Awards Night automatic (No) → Yes");
  // The RSVP page follows the issued pass too.
  const look = await pub("POST", "/api/rsvp/lookup", { firstName: "Gia", lastName: "Guest", ticketId: made.body.row.ticketId });
  assert.ok(look.body.allowedOptions.includes("awards") && look.body.allowedOptions.includes("lunch_d2") && !look.body.allowedOptions.includes("gala"));
  // A claimed issued pass: the account's copy of the ticket follows the edit.
  const gia = await M.User.create({ name: "Gia Guest", email: "gia@example.com", tickets: [{ ticketId: made.body.row.ticketId, type: "connect" }] });
  await M.Attendee.updateOne({ ticketId: made.body.row.ticketId }, { $set: { claimedBy: gia._id } });
  await call("PATCH", `/api/console/issued-passes/${made.body.row.id}`, { body: { extras: { cxo: true } } });
  assert.equal((await M.User.findById(gia._id).lean()).tickets[0].cxoBreakfast, true);
  const giaMe = await call("GET", "/api/auth/me", { as: gia, via: "email" });
  assert.deepEqual(giaMe.body.tickets[0].inclusions, ["2× Day Conference Access", "2× CxO Breakfasts", "2× Luncheons", "1× Awards Night", "Expo Floor Access", "Networking Breaks"]);
});

test("eligible counts for the headcounts, the directory's badge data and counts, and the CSV columns", { skip }, async () => {
  const el = await call("GET", "/api/console/people/eligible?refresh=1", { as: sam });
  assert.equal(el.status, 200);
  // Cara (Gala), Ian (Awards, no lunch), Pat (lunch only), Gia (lunch, Awards, CxO).
  assert.deepEqual(el.body.byExtra, { cxo: 1, lunch: 2, gala: 1, awards: 2 });
  assert.deepEqual([el.body.byOption.gala, el.body.byOption.lunch_d1, el.body.byOption.lunch_d2, el.body.byOption.cxo_d2], [1, 2, 2, 1]);
  assert.deepEqual(el.body.extras.map((x) => x.label), ["CxO Breakfasts", "Networking Luncheons", "Gala Dinner & Networking Reception", "Catalyst Awards Night"]);
  const list = await call("GET", "/api/console/people?refresh=1", { as: sam });
  const pat = list.body.rows.find((r) => r.name === "Pat Power");
  assert.deepEqual([pat.pass.extras.gala, pat.pass.extras.lunch.included], [{ override: false, auto: true, included: false }, true]);
  assert.deepEqual(list.body.counts.extras, { cxo: 1, lunch: 2, gala: 1, awards: 2 });
  // The CSV (management).
  assert.equal((await call("GET", "/api/console/people/export", { as: sam })).status, 403);
  const csv = await realFetch(`${base}/api/console/people/export`, { headers: { authorization: `Bearer ${tokenFor(mia)}` } }).then((r) => r.text());
  const [head, ...lines] = csv.replace(/^﻿/, "").split("\n");
  const cols = head.split(",");
  const at = (name) => cols.indexOf(name);
  assert.ok(["Networking Luncheons", "Gala Dinner & Networking Reception", "Catalyst Awards Night", "Extras set by staff"].every((c) => at(c) > at("CxO Breakfast")));
  const patLine = lines.find((l) => l.startsWith("Pat Power")).split(",");
  assert.deepEqual([patLine[at("Networking Luncheons")], patLine[at("Gala Dinner & Networking Reception")], patLine[at("Catalyst Awards Night")], patLine[at("Extras set by staff")]],
    ["Yes", "No", "No", "Gala Dinner & Networking Reception: No; Catalyst Awards Night: No"]);
});
