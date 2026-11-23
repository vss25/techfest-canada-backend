/* MOU drafts (Nov 23 2026) through the real routes against a real (throwaway) MongoDB: the catalogue
   (super admin only, the starter list, retire instead of delete), building an MOU (lines snapshot the
   catalogue and keep it, codes, schedules, ticket-sales milestones, terms, who signs), draft → review →
   exported, the PDF and Word files, and who may delete. Starts a local mongod in a temp folder on a
   free port and stops it after; skipped when the binary isn't there (TTFC_TEST_MONGOD, else
   ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Fictional people, example.com. */
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
delete process.env.SUPER_ADMIN_EMAILS;

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port) => new Promise((ok) => { const c = net.connect(port, "127.0.0.1", () => { c.end(); ok(true); }); c.on("error", () => ok(false)); });

let mongod = null, dbDir = "", server = null, base = "", jwt, mongoose;
const M = {};
const U = {};

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-mou-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await pause(250);
  await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_mou_test`);
  ({ default: jwt } = await import("jsonwebtoken"));
  M.User = (await import("../models/User.js")).default;
  M.AdminSetting = (await import("../models/AdminSetting.js")).default;
  ({ Mou: M.Mou, MouItem: M.MouItem } = await import("../models/Mou.js"));
  const { mouItemsRouter, mousRouter } = await import("../routes/mous.js");
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/console/mou-items", mouItemsRouter);
  app.use("/api/console/mous", mousRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const mk = (key, doc) => M.User.create(doc).then((u) => { U[key] = u; });
  await Promise.all([
    mk("boss", { name: "Sam Rivera", email: "sam.rivera@example.com", role: "admin", staffRole: "management" }),
    mk("pat", { name: "Pat Staff", email: "pat.staff@example.com", role: "admin", staffRole: "staff" }),
    mk("lee", { name: "Lee Staff", email: "lee.staff@example.com", role: "admin", staffRole: "staff" }),
    mk("joe", { name: "Joe Attendee", email: "joe.attendee@example.com", role: "user" }),
  ]);
  await M.AdminSetting.create({ key: "contracts.settings", module: "contracts", valueType: "json", value: {
    company: { legalName: "The Tech Festival Canada", address: "1 Example St, Toronto", email: "sales@thetechfestival.com" },
    signatories: [{ id: "s1", name: "Dana Director", title: "Director", signature: "" }, { id: "s2", name: "Robin Founder", title: "Founder", signature: "" }],
  } });
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const tokenFor = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function call(method, url, { as, body } = {}) {
  const r = await fetch(base + url, {
    method, headers: { "content-type": "application/json", ...(as ? { authorization: `Bearer ${tokenFor(as)}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString()); } catch { json = null; }
  return { status: r.status, body: json, buf, headers: r.headers };
}
const ok = async (p, want = 200) => { const r = await p; assert.equal(r.status, want, JSON.stringify(r.body)); return r.body; };
const ITEMS = "/api/console/mou-items", MOUS = "/api/console/mous";
const s = {};

test("staff only; the catalogue is read by staff and changed only by the super admin", { skip }, async () => {
  assert.equal((await call("GET", MOUS)).status, 401);
  assert.equal((await call("GET", MOUS, { as: U.joe })).status, 403);
  const cat = await ok(call("GET", ITEMS, { as: U.pat }));
  assert.equal(cat.items.length, 0);
  assert.equal(cat.canEdit, false);
  assert.deepEqual(cat.signatories.map((x) => x.id), ["s1", "s2"]);
  assert.equal(cat.signatories[0].signature, undefined, "signature images never go to the list");
  const r = await call("POST", `${ITEMS}/starter`, { as: U.pat });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "super_admin_only");
  assert.equal((await call("POST", ITEMS, { as: U.pat, body: { side: "ttfc", name: "X" } })).status, 403);
});

test("the starter list goes in once; the super admin adds and edits items", { skip }, async () => {
  const first = await ok(call("POST", `${ITEMS}/starter`, { as: U.boss }), 201);
  assert.ok(first.added >= 10);
  assert.equal((await ok(call("POST", `${ITEMS}/starter`, { as: U.boss }), 201)).added, 0);
  const cat = await ok(call("GET", ITEMS, { as: U.boss }));
  assert.equal(cat.canEdit, true);
  const find = (side, name) => cat.items.find((i) => i.side === side && i.name === name);
  s.li = find("ttfc", "LinkedIn shoutout");
  s.passes = find("ttfc", "Free passes");
  s.target = find("partner", "Ticket sales target");
  s.news = find("partner", "Email newsletter shoutout");
  assert.ok(s.li && s.passes && s.target && s.news);
  assert.equal((await call("POST", ITEMS, { as: U.boss, body: { side: "both", name: "X" } })).status, 400);
  const pod = await ok(call("POST", ITEMS, { as: U.boss, body: { side: "partner", name: "Podcast mention", category: "social", fields: ["qty", "schedule"], qty: 1, wording: "{partner} will mention {event} on {qty} podcast episode{s}{when}." } }), 201);
  s.pod = pod.item;
  const edited = await ok(call("PATCH", `${ITEMS}/${s.pod.id}`, { as: U.boss, body: { qty: 2, side: "ttfc" } }));
  assert.equal(edited.item.qty, 2);
  assert.equal(edited.item.side, "partner", "the side never changes");
});

test("a new MOU: needs the event and the partner's name, gets a number, lines take the catalogue's defaults", { skip }, async () => {
  assert.equal((await call("POST", MOUS, { as: U.pat, body: { partner: { name: "Acme" } } })).status, 400);
  assert.equal((await call("POST", MOUS, { as: U.pat, body: { eventKey: "van-2027", partner: { name: "" } } })).status, 400);
  const body = {
    eventKey: "van-2027", eventName: "Vancouver Briefing 2027", eventYear: "2027",
    partner: { name: "Acme Tech Network", website: "acme.example.com" }, contact: { name: "Alex Lee", email: "alex@example.com" },
    lines: [
      { itemId: s.li.id, qty: 3, schedule: { mode: "repeat", every: "2weeks", from: "2027-01-05", to: "2027-02-02" } },
      { itemId: s.passes.id, unlockAt: 25, code: "acmevip" },
      { itemId: s.target.id, qty: 40, code: "ACME15" },
    ],
    terms: { binding: false, financial: false },
    ttfcSignatoryIds: ["s1", "nope"],
    partnerSigners: [{ name: "Alex Lee", title: "President" }],
  };
  const { mou } = await ok(call("POST", MOUS, { as: U.pat, body }), 201);
  s.mou = mou;
  assert.equal(mou.number, "MOU-2027-0001");
  assert.equal(mou.status, "draft");
  assert.deepEqual(mou.ttfcSignatoryIds, ["s1"]);
  assert.equal(mou.lines.length, 3);
  assert.equal(mou.lines[0].text, "TTFC will feature Acme Tech Network in 3 LinkedIn posts on the TTFC company page every 2 weeks from January 5, 2027 to February 2, 2027.");
  assert.equal(mou.lines[1].qty, 2, "the catalogue's default");
  assert.equal(mou.lines[1].code, "ACMEVIP");
  assert.match(mou.lines[1].text, /^Once ticket sales with Acme Tech Network's code reach 25: TTFC will give Acme Tech Network 2 free passes/);
  assert.match(mou.lines[2].text, /aim to sell 40 tickets to Vancouver Briefing 2027 with the code ACME15/);
  assert.equal(mou.terms.clauses.length >= 5, true);
  assert.equal(mou.can.edit, true);
  assert.equal(mou.can.review, true);
  assert.equal(mou.can.export, false);
  assert.equal(mou.checks.filter((c) => c.level === "block").length, 0);
  assert.ok(mou.checks.some((c) => c.level === "warn" && /no code yet/.test(c.text)) === false, "every code is filled in");

  const list = await ok(call("GET", `${MOUS}?eventKey=van-2027`, { as: U.lee }));
  assert.equal(list.mous.length, 1);
  assert.equal(list.mous[0].offers, 2);
  assert.equal(list.mous[0].delivers, 1);
  assert.equal(list.counts.draft, 1);
  assert.equal((await ok(call("GET", `${MOUS}?eventKey=tor-2027`, { as: U.lee }))).mous.length, 0);
});

test("editing: own wording, money in cents, lines keep their snapshot when the catalogue changes", { skip }, async () => {
  await ok(call("PATCH", `${ITEMS}/${s.li.id}`, { as: U.boss, body: { wording: "Changed catalogue wording for {partner}." } }));
  const lines = s.mou.lines.map((l) => ({ itemId: l.itemId, qty: l.qty, schedule: l.schedule, code: l.code, value: l.value, unlockAt: l.unlockAt, wording: l.wording }));
  lines.push({ itemId: s.news.id, schedule: { mode: "note", note: "in its January issue" } });
  lines[2].wording = "Acme will push the code ACME15 to its 5,000 members — and aim for 40 sales.";
  const { mou } = await ok(call("PATCH", `${MOUS}/${s.mou.id}`, { as: U.pat, body: {
    partner: s.mou.partner, contact: s.mou.contact, lines, ttfcSignatoryIds: ["s1", "s2"], partnerSigners: s.mou.partnerSigners,
    terms: { financial: true, amount: "1,500", payer: "partner", paymentNote: "Due on signing.", clauses: [{ key: "exclusivity", on: false }] },
  } }));
  assert.match(mou.lines[0].text, /^TTFC will feature Acme Tech Network in 3 LinkedIn posts/, "kept its snapshot");
  assert.equal(mou.lines[2].text, "Acme will push the code ACME15 to its 5,000 members, and aim for 40 sales.", "no em-dash");
  assert.equal(mou.lines[3].text, "Acme Tech Network will feature Vancouver Briefing 2027 in 1 email newsletter to its members in its January issue.");
  assert.equal(mou.terms.amount, 150000);
  assert.equal(mou.terms.clauses.find((c) => c.key === "exclusivity").on, false);
  assert.deepEqual(mou.ttfcSignatoryIds, ["s1", "s2"]);
  s.mou = mou;
  // a new MOU gets the catalogue's new wording
  const other = await ok(call("POST", MOUS, { as: U.lee, body: { eventKey: "van-2027", eventYear: "2027", partner: { name: "Beta Hub" }, lines: [{ itemId: s.li.id, qty: 1 }] } }), 201);
  assert.equal(other.mou.number, "MOU-2027-0002");
  assert.equal(other.mou.lines[0].text, "Changed catalogue wording for Beta Hub.");
  s.other = other.mou;
});

test("a used item can't be deleted (retire it); a retired item stays on old MOUs and can't be ticked on new ones", { skip }, async () => {
  const r = await call("DELETE", `${ITEMS}/${s.li.id}`, { as: U.boss });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "in_use");
  await ok(call("PATCH", `${ITEMS}/${s.pod.id}`, { as: U.boss, body: { active: false } }));
  const add = await call("PATCH", `${MOUS}/${s.other.id}`, { as: U.lee, body: { partner: { name: "Beta Hub" }, lines: [{ itemId: s.pod.id }] } });
  assert.equal(add.status, 400);
  assert.match(add.body.error, /retired/);
  await ok(call("DELETE", `${ITEMS}/${s.pod.id}`, { as: U.boss }));
});

test("review: blocked until it's complete, read only while in review, back to draft", { skip }, async () => {
  const blocked = await call("POST", `${MOUS}/${s.other.id}/status`, { as: U.lee, body: { status: "review" } });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /signs for TTFC/);
  assert.equal((await call("POST", `${MOUS}/${s.mou.id}/export`, { as: U.pat })).status, 409, "a draft can't be exported");
  const { mou } = await ok(call("POST", `${MOUS}/${s.mou.id}/status`, { as: U.pat, body: { status: "review" } }));
  assert.equal(mou.status, "review");
  assert.equal(mou.can.edit, false);
  assert.equal(mou.can.export, true);
  const edit = await call("PATCH", `${MOUS}/${s.mou.id}`, { as: U.pat, body: { partner: { name: "Changed" } } });
  assert.equal(edit.status, 409);
  assert.equal(edit.body.code, "not_draft");
  assert.equal((await call("DELETE", `${MOUS}/${s.mou.id}`, { as: U.pat })).status, 409);
});

test("files at any stage: a draft PDF and Word file, then export freezes TTFC's side", { skip }, async () => {
  const pdf = await call("GET", `${MOUS}/${s.mou.id}/file`, { as: U.lee });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.equal(pdf.buf.subarray(0, 5).toString(), "%PDF-");
  assert.match(pdf.headers.get("content-disposition"), /MOU-2027-0001-Acme-Tech-Network\.pdf/);
  const docx = await call("GET", `${MOUS}/${s.mou.id}/file?format=docx`, { as: U.lee });
  assert.equal(docx.status, 200);
  assert.match(docx.headers.get("content-type"), /wordprocessingml/);
  assert.equal(docx.buf.readUInt32LE(0), 0x04034b50);
  assert.ok(docx.buf.includes(Buffer.from("DRAFT FOR REVIEW")));
  assert.ok(docx.buf.includes(Buffer.from("Robin Founder")));

  const { mou } = await ok(call("POST", `${MOUS}/${s.mou.id}/export`, { as: U.pat }));
  assert.equal(mou.status, "exported");
  assert.equal(mou.exports, 1);
  assert.equal(mou.frozen.signatories.length, 2);
  assert.equal(mou.frozen.company.legalName, "The Tech Festival Canada");
  assert.equal(mou.frozen.signatories[0].signature, undefined, "no signature images in the answer");
  assert.deepEqual(mou.document.sections.map((x) => x.title).slice(0, 2), ["PURPOSE", "WHAT TTFC WILL DO"]);
  assert.equal(mou.document.banner, "");
  // Contract settings change later: the exported MOU keeps what it was exported with
  await M.AdminSetting.updateOne({ key: "contracts.settings" }, { $set: { "value.signatories.0.name": "Someone Else" } });
  const after = await call("GET", `${MOUS}/${s.mou.id}/file?format=docx`, { as: U.lee });
  assert.ok(after.buf.includes(Buffer.from("Dana Director")));
  assert.ok(!after.buf.includes(Buffer.from("DRAFT")));
  const again = await ok(call("POST", `${MOUS}/${s.mou.id}/export`, { as: U.lee }));
  assert.equal(again.mou.exports, 2);
  assert.equal(again.mou.exportedBy, "Pat Staff", "the first export is kept");
  const back = await ok(call("POST", `${MOUS}/${s.mou.id}/status`, { as: U.pat, body: { status: "draft" } }));
  assert.equal(back.mou.status, "draft");
  assert.equal(back.mou.frozen, null);
});

test("delete: a draft, by whoever made it or management", { skip }, async () => {
  const r = await call("DELETE", `${MOUS}/${s.other.id}`, { as: U.pat });
  assert.equal(r.status, 409);
  await ok(call("DELETE", `${MOUS}/${s.other.id}`, { as: U.lee }));
  assert.equal((await call("GET", `${MOUS}/${s.other.id}`, { as: U.lee })).status, 404);
  assert.equal((await call("GET", `${MOUS}/not-an-id`, { as: U.lee })).status, 404);
  assert.equal(await M.Mou.countDocuments({}), 1);
});
