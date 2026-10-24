/* "Stay updated": the TTFC 2027 waitlist through the real routes (routes/stayUpdated.js: POST /api/stay-updated and
   Admin's /api/console/waitlist), the real WaitlistSignup / Subscription / AppContent models, against a real
   (throwaway) MongoDB. Covers: one row per email (a repeat merges and counts), the team's email to WAITLIST_INBOX
   and the person's confirmation (from enquire@, once a day at most, never to an unsubscribed address), the answer
   never waiting for either email, staff's wording from AppContent, the admin list, counts, filters and the
   management-only CSV.
   Starts a local mongod in a temp folder on a free port and stops it after; skipped when the binary isn't
   there (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Nothing leaves the
   machine: Resend is stubbed (nothing is delivered). Fictional people. */
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
process.env.FRONTEND_URL = "https://www.example.test";
process.env.API_URL = "https://api.example.test";
process.env.WAITLIST_INBOX = "waitlist-inbox@example.test";

/** Every email the routes tried to send (Resend is stubbed: nothing is delivered). `gate`: hold them until opened. */
const outbox = [];
let gate = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.startsWith("https://api.resend.com/")) {
    if (gate) await gate;
    const body = JSON.parse(opts?.body || "{}");
    outbox.push({ to: [].concat(body.to || []), from: body.from, replyTo: body.reply_to, subject: body.subject || "", html: body.html || "", text: body.text || "", headers: body.headers || {} });
    return new Response(JSON.stringify({ id: `stub_${outbox.length}` }), { status: 200, headers: { "content-type": "application/json" } });
  }
  throw new Error(`blocked in the test: ${url}`);
};

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });

let mongod = null;
let dbDir = "";
let server = null;
let base = "";
const M = {};
let jwt;
let mongoose;
let mia; // management
let sam; // staff, not management
let pat; // an attendee account (not staff)

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-waitlist-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_waitlist_test`, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  ({ default: jwt } = await import("jsonwebtoken"));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.WaitlistSignup = await imp("../models/WaitlistSignup.js");
  M.Subscription = await imp("../models/Subscription.js");
  ({ AppContent: M.AppContent, AdminAudit: M.AdminAudit } = await import("../models/Admin.js"));
  await M.WaitlistSignup.init();
  await M.Subscription.init();
  // Staff's wording, saved before the first sign-up (the route keeps it 30 seconds).
  await M.AppContent.create({ key: "stay.thanks", value: "Thank you for your interest! Someone from our team will reach out.", updatedBy: "Mia" });
  await M.AppContent.create({ key: "stay.interest_delegation", value: "Bringing a group", updatedBy: "Mia" });
  const { default: express } = await import("express");
  const routes = await import("../routes/stayUpdated.js");
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use("/api/stay-updated", routes.publicRouter);
  app.use("/api/console/waitlist", routes.adminRouter);
  app.use("/api/app", (await import("../routes/appApi.js")).default);
  app.use("/api/console", (await import("../routes/console.js")).default); // app content: the 2027 journey
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  mia = await M.User.create({ name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management" });
  sam = await M.User.create({ name: "Sam Staff", email: "sam.staff@example.com", role: "admin", staffRole: "staff" });
  pat = await M.User.create({ name: "Pat Rowe", email: "pat.rowe@example.com" });
  await M.Subscription.create({ email: "off@acme.example", subscribed: false, unsubscribedAt: new Date(), unsubscribeSource: "link" });
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const tokenFor = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
let ipN = 10;
async function call(method, url, { as = null, body, ip = `10.0.0.${ipN++}` } = {}) {
  const r = await realFetch(base + url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": ip, "user-agent": "Mozilla/5.0 (iPhone) test", ...(as ? { authorization: `Bearer ${tokenFor(as)}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, headers: r.headers };
}
const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  return null;
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const teamMail = () => outbox.filter((m) => m.to.includes("waitlist-inbox@example.test"));
const personMail = (email) => outbox.filter((m) => m.to.includes(email));
const THANKS = "Thank you for your interest! Someone from our team will reach out.";

const JANE = { email: "Jane.Doe@Acme.Example", phone: "+1 (416) 555-0100", interests: ["sponsorship", "exhibitor"], source: "website", consent: true, _hp: "" };

test("a first sign-up: saved, thanked (staff's words), the team and the person emailed from enquire@", { skip }, async () => {
  const r = await call("POST", "/api/stay-updated", { body: JANE });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true, message: THANKS });
  const team = await waitFor(() => teamMail()[0]);
  assert.equal(team.subject, "TTFC 2027 waitlist: Sponsorship + Exhibitor interest – jane.doe@acme.example");
  assert.equal(team.from, "TTFC Website <enquire@thetechfestival.com>");
  assert.equal(team.replyTo, "jane.doe@acme.example");
  assert.match(team.html, /href="tel:\+14165550100"/);
  assert.match(team.text, /Signed up from: Website/);
  assert.doesNotMatch(team.html + team.text, /Get the TTFC app|GET THE TTFC APP/, "a staff alert: no app block");
  const mine = await waitFor(() => personMail("jane.doe@acme.example")[0]);
  assert.equal(mine.subject, "You're on the TTFC 2027 waitlist");
  assert.equal(mine.from, "The Tech Festival Canada <enquire@thetechfestival.com>");
  assert.equal(mine.replyTo, "enquire@thetechfestival.com");
  assert.match(mine.html, />Get the TTFC app</, "attendee-facing: the app block");
  assert.match(mine.html, /href="https:\/\/api\.example\.test\/api\/unsubscribe\?t=[^"]+"/);
  assert.match(mine.headers["List-Unsubscribe"], /^<https:\/\/api\.example\.test\/api\/unsubscribe\?t=/);
  assert.match(mine.text, /• Sponsorship\n  • Exhibiting/);
  await waitFor(async () => (await M.WaitlistSignup.findOne({ email: "jane.doe@acme.example" }).lean())?.confirmStatus === "sent");
  const row = await M.WaitlistSignup.findOne({ email: "jane.doe@acme.example" }).lean();
  assert.deepEqual([row.phone, row.phoneDigits, row.interests, row.source, row.sources, row.count, row.consent], ["+1 (416) 555-0100", "14165550100", ["sponsorship", "exhibitor"], "website", ["website"], 1, true]);
  assert.deepEqual([row.alertStatus, row.confirmStatus], ["sent", "sent"]);
  assert.ok(row.confirmedAt && row.consentAt && row.createdAt);
  assert.match(row.ipHash, /^[0-9a-f]{32}$/);
  assert.equal(row.userAgent, "Mozilla/5.0 (iPhone) test");
});

test("the same email again: one row, merged ticks and sources, counted; the team gets (updated); no second confirmation today", { skip }, async () => {
  const before = outbox.length;
  const r = await call("POST", "/api/stay-updated", { body: { ...JANE, phone: "416-555-0199", interests: ["delegation"], source: "ios" } });
  assert.deepEqual([r.status, r.body], [200, { ok: true, message: THANKS }], "the same answer as a first sign-up");
  const team = await waitFor(() => teamMail().find((m) => m.subject.endsWith("(updated)")));
  assert.equal(team.subject, "TTFC 2027 waitlist: Sponsorship + Exhibitor + Delegation interest – jane.doe@acme.example (updated)");
  assert.match(team.text, /Ticked this time: Delegation/);
  assert.match(team.text, /Sign-ups from this address: 2/);
  await pause(200);
  assert.equal(outbox.length, before + 1, "only the team's email");
  assert.equal(await M.WaitlistSignup.countDocuments({ email: "jane.doe@acme.example" }), 1);
  const row = await M.WaitlistSignup.findOne({ email: "jane.doe@acme.example" }).lean();
  assert.deepEqual([row.phone, row.interests, row.lastInterests, row.source, row.sources, row.count], ["416-555-0199", ["sponsorship", "exhibitor", "delegation"], ["delegation"], "ios", ["website", "ios"], 2]);
});

test("a day after the last confirmation, a sign-up confirms again (with every tick, in the page's words)", { skip }, async () => {
  await M.WaitlistSignup.updateOne({ email: "jane.doe@acme.example" }, { $set: { confirmedAt: new Date(Date.now() - 25 * 3600_000) } });
  const r = await call("POST", "/api/stay-updated", { body: { ...JANE, interests: [] } });
  assert.equal(r.status, 200);
  const mails = await waitFor(() => personMail("jane.doe@acme.example").length === 2 && personMail("jane.doe@acme.example"));
  assert.ok(mails, "a second confirmation");
  assert.match(mails[1].text, /• Sponsorship\n  • Exhibiting\n  • Bringing a group/);
});

test("an address on the unsubscribe list: saved and the team told, but never emailed", { skip }, async () => {
  const r = await call("POST", "/api/stay-updated", { body: { email: "off@acme.example", phone: "4165550123", interests: [], source: "android", consent: true } });
  assert.equal(r.status, 200);
  const team = await waitFor(() => teamMail().find((m) => m.subject === "TTFC 2027 waitlist: Attending – off@acme.example"));
  assert.ok(team);
  await waitFor(async () => (await M.WaitlistSignup.findOne({ email: "off@acme.example" }).lean())?.confirmStatus === "unsubscribed");
  await pause(150);
  assert.equal(personMail("off@acme.example").length, 0);
});

test("the answer never waits for the emails", { skip }, async () => {
  let open;
  gate = new Promise((ok) => { open = ok; });
  const before = outbox.length;
  const r = await call("POST", "/api/stay-updated", { body: { ...JANE, email: "quinn@acme.example", source: "webapp" } });
  assert.equal(r.status, 200, "answered while Resend is still holding both emails");
  assert.equal(outbox.length, before);
  open();
  gate = null;
  assert.ok(await waitFor(() => outbox.length === before + 2));
  assert.ok(personMail("quinn@acme.example").length === 1);
});

test("bad input and the honeypot: nothing saved, nobody emailed", { skip }, async () => {
  const rows = await M.WaitlistSignup.countDocuments();
  const before = outbox.length;
  const bad = [
    [{ ...JANE, email: "" }, "email"],
    [{ ...JANE, email: "nope" }, "email"],
    [{ ...JANE, phone: "" }, "phone"],
    [{ ...JANE, phone: "12345" }, "phone"],
    [{ ...JANE, phone: "+1 416 555 0100 ext 4" }, "phone"],
    [{ ...JANE, consent: false }, "consent"],
  ];
  for (const [body, field] of bad) {
    const r = await call("POST", "/api/stay-updated", { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.deepEqual([r.body.ok, r.body.field], [false, field]);
    assert.ok(r.body.error.length > 10);
  }
  const hp = await call("POST", "/api/stay-updated", { body: { ...JANE, email: "bot@acme.example", _hp: "x" } });
  assert.deepEqual([hp.status, hp.body], [200, { ok: true, message: THANKS }]);
  await pause(150);
  assert.equal(await M.WaitlistSignup.countDocuments(), rows);
  assert.equal(outbox.length, before);
});

test("Admin › 2027 waitlist: staff see the list, counts and filters; non-staff can't", { skip }, async () => {
  assert.equal((await call("GET", "/api/console/waitlist")).status, 401);
  assert.equal((await call("GET", "/api/console/waitlist", { as: pat })).status, 403);
  const all = await call("GET", "/api/console/waitlist", { as: sam });
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.counts, { total: 3, attending: 1, sponsorship: 2, exhibitor: 2, delegation: 1, website: 1, webapp: 1, ios: 1, android: 1, programme: 0 });
  assert.equal(all.body.total, 3);
  assert.equal(all.body.canExport, false);
  assert.deepEqual(all.body.rows.map((r) => r.email), ["quinn@acme.example", "off@acme.example", "jane.doe@acme.example"]);
  const jane = all.body.rows[2];
  assert.deepEqual([jane.interestLabels, jane.tel, jane.count, jane.confirmStatus], [["Sponsorship", "Exhibitor", "Delegation"], "tel:+14165550100", 3, "sent"]);
  const spons = await call("GET", "/api/console/waitlist?interest=delegation", { as: sam });
  assert.deepEqual(spons.body.rows.map((r) => r.email), ["jane.doe@acme.example"]);
  const att = await call("GET", "/api/console/waitlist?interest=attending", { as: sam });
  assert.deepEqual(att.body.rows.map((r) => r.email), ["off@acme.example"]);
  const ios = await call("GET", "/api/console/waitlist?source=ios", { as: sam });
  assert.deepEqual(ios.body.rows.map((r) => r.email), ["jane.doe@acme.example"]);
  const q = await call("GET", "/api/console/waitlist?q=555%200123", { as: sam });
  assert.deepEqual(q.body.rows.map((r) => r.email), ["off@acme.example"]);
});

test("the CSV is for management (it holds phone numbers) and is audited", { skip }, async () => {
  assert.equal((await call("GET", "/api/console/waitlist/export", { as: sam })).status, 403);
  const r = await call("GET", "/api/console/waitlist/export?interest=sponsorship", { as: mia });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/csv/);
  assert.match(r.headers.get("content-disposition"), /ttfc-2027-waitlist-\d{4}-\d{2}-\d{2}\.csv/);
  const lines = r.body.replace(/^﻿/, "").split("\n");
  assert.equal(lines.length, 3, "the header and the two sponsorship sign-ups");
  assert.match(lines[0], /^Signed up \(Toronto\),Last sign-up \(Toronto\),Email,Phone,Sponsorship,Exhibitor,Delegation/);
  assert.ok(lines.some((l) => l.includes("jane.doe@acme.example,'+1 (416) 555-0100,Yes,Yes,Yes,\"Sponsorship, Exhibitor, Delegation\",\"Website, iOS app\",3,sent,sent")));
  assert.ok(await M.AdminAudit.exists({ action: "waitlist_export", adminName: "Mia Manager" }));
});

test("the confirmation's preview for staff, and the wording in GET /api/app/content", { skip }, async () => {
  const p = await call("GET", "/api/console/waitlist/email-preview?interests=delegation", { as: sam });
  assert.equal(p.status, 200);
  assert.equal(p.body.subject, "You're on the TTFC 2027 waitlist");
  assert.match(p.body.html, />Bringing a group</);
  assert.match(p.body.html, /\/api\/unsubscribe\/preview/);
  const c = await call("GET", "/api/app/content");
  assert.equal(c.status, 200);
  assert.equal(c.body["stay.hero_title"], "TTFC 2027 · Toronto · November 2027");
  assert.equal(c.body["stay.thanks"], THANKS);
  assert.equal("stay.stat" in c.body, false, "no attendee line on the 2027 page");
  assert.equal("stay.expect" in c.body, false, "no “What to expect”");
  assert.equal(JSON.parse(c.body["stay.journey"]).length, 6, "the organiser's journey by default");
});

test("the 2027 journey: any staff saves it through app content (checked and tidied), a bad one is refused in plain words", { skip }, async () => {
  const { DEFAULT_JOURNEY_JSON } = await import("../services/stayJourney.js");
  const put = (as, value) => call("PUT", "/api/console/app-content/stay.journey", { as, body: { value } });
  // Not staff: refused before anything is checked.
  assert.equal((await put(pat, "[]")).status, 403);
  // Staff (not management) can save it, like the page's other words.
  const stops = [
    { city: "vancouver", month: "February 2027", kind: "briefing", pillar: "AI & Machine Learning", sector: "Healthcare & Life Sciences", date: "", venue: "", note: "" },
    { city: "Toronto", month: "November 2027", kind: "festival", pillar: "", sector: "", date: "", venue: "", note: "Two days" },
  ];
  const ok = await put(sam, JSON.stringify(stops));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const row = await M.AppContent.findOne({ key: "stay.journey" }).lean();
  assert.equal(JSON.parse(row.value)[0].city, "Vancouver", "stored with the city's own name");
  assert.equal(row.updatedBy, "Sam Staff");
  assert.ok(await M.AdminAudit.exists({ action: "edit_app_text", targetId: "stay.journey" }));
  const c = await call("GET", "/api/app/content");
  assert.deepEqual(JSON.parse(c.body["stay.journey"]).map((s) => [s.city, s.kind, s.pillar]), [
    ["Vancouver", "briefing", "AI & Machine Learning"], ["Toronto", "festival", ""],
  ]);
  // A city that isn't on the list, a made-up pillar, 13 stops: 400 with the reason, nothing changes.
  const bad = await put(sam, JSON.stringify([{ city: "Boston", month: "May 2027" }]));
  assert.deepEqual([bad.status, bad.body], [400, { error: "Stop 1: pick a city from the list.", code: "invalid_value" }]);
  const bad2 = await put(sam, JSON.stringify([{ city: "Ottawa", pillar: "Blockchain" }]));
  assert.equal(bad2.body.error, "Stop 1: pick the technology pillar from the list, or “To be announced”.");
  const bad3 = await put(sam, JSON.stringify(Array.from({ length: 13 }, () => ({ city: "Ottawa" }))));
  assert.equal(bad3.body.error, "The journey can have 12 stops at most.");
  assert.equal((await M.AppContent.findOne({ key: "stay.journey" }).lean()).value, row.value, "unchanged");
  // An unknown key still says so.
  assert.deepEqual((await call("PUT", "/api/console/app-content/stay.nope", { as: sam, body: { value: "x" } })).body, { error: "Unknown key" });
  // "" = back to the organiser's journey (the admin list shows the default).
  assert.equal((await put(sam, "")).status, 200);
  const list = await call("GET", "/api/console/app-content", { as: sam });
  const j = list.body.find((r) => r.key === "stay.journey");
  assert.deepEqual([j.value, j.default, j.managementOnly], ["", DEFAULT_JOURNEY_JSON, false]);
  assert.equal(list.body.some((r) => r.key === "stay.pillars" || r.key === "stay.expect" || r.key === "stay.stat"), false, "the removed keys aren't listed");
});
