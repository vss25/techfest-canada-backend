/* The editable pass emails through the real admin routes, against a real (throwaway) MongoDB:
   the template and per-pass levels, management-only saves, the audit log, the previews, and
   sendTicketEmail using the purchase email template.
   Starts a local mongod in a temp folder on a free port and stops it after; skipped when the
   binary isn't there (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6).
   Nothing leaves the machine and nothing is sent: Resend and Sanity are answered by a stubbed
   fetch (Resend calls are recorded, never delivered), no Stripe key. Fictional people, example.com. */
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

const resendCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.startsWith("https://api.resend.com/")) {
    // Never sent: the email service is answered here, and what it was given is kept for the checks.
    resendCalls.push(JSON.parse(opts?.body || "{}"));
    return new Response(JSON.stringify({ id: `stub_${resendCalls.length}` }), { status: 200, headers: { "content-type": "application/json" } });
  }
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
const M = {};
let boss;   // management
let staff;  // staff, not management

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-pe-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_pass_emails_test`, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  ({ default: jwt } = await import("jsonwebtoken"));
  M.User = (await import("../models/User.js")).default;
  M.Attendee = (await import("../models/Attendee.js")).default;
  M.EmailTemplate = (await import("../models/EmailTemplate.js")).default;
  Object.assign(M, await import("../models/Admin.js"));
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/console/issued-passes", (await import("../routes/issuedPasses.js")).default);
  app.use("/api/console/exhibitor-passes", (await import("../routes/issuedPasses.js")).issuedPassRouter("exhibitor"));
  app.use("/api/console/purchase-email", (await import("../routes/purchaseEmail.js")).default);
  app.use("/api/console", (await import("../routes/console.js")).default);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  boss = await M.User.create({ name: "Mo Manager", email: "mo.manager@example.com", role: "admin", staffRole: "management" });
  staff = await M.User.create({ name: "Sid Staff", email: "sid.staff@example.com", role: "admin", staffRole: "staff" });
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
  globalThis.fetch = realFetch;
});

const tokenFor = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function call(method, url, { as = boss, body } = {}) {
  const r = await realFetch(base + url, {
    method, headers: { "content-type": "application/json", authorization: `Bearer ${tokenFor(as)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const lastAudit = (action) => M.AdminAudit.findOne({ action }).sort({ _id: -1 }).lean();
/** The audit line names every one of these fields (in any order). */
const names = (detail, ...keys) => { for (const k of keys) assert.ok(String(detail).includes(k), `${k} not in "${detail}"`); };

/* ---------- the purchase email ---------- */

test("purchase email: staff can look and preview, only management saves; every save is audited", { skip }, async () => {
  const got = await call("GET", "/api/console/purchase-email", { as: staff });
  assert.equal(got.status, 200);
  assert.ok(got.body.fields.some((f) => f.key === "walletCaption"));
  assert.deepEqual(got.body.tiers.map((t) => t.key), ["connect", "influence", "power", "apex"]);
  assert.equal(got.body.defaults.apex.passName, "Apex Pass");

  const draft = { subject: "Welcome aboard, {firstName}", tiers: { power: { passName: "Power Pass · Founders", includes: ["Everything", "And more"] } } };
  assert.equal((await call("PUT", "/api/console/purchase-email", { as: staff, body: draft })).status, 403);
  assert.equal(await M.EmailTemplate.countDocuments({ key: "purchase-email" }), 0);

  const preview = await call("POST", "/api/console/purchase-email/preview", { as: staff, body: { ...draft, tier: "power" } });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.subject, "Welcome aboard, Jane");
  assert.match(preview.body.html, /POWER PASS · FOUNDERS|Power Pass · Founders/);
  assert.match(preview.body.text, / {2}- Everything\n {2}- And more/);
  assert.equal(resendCalls.length, 0, "a preview never sends");

  const saved = await call("PUT", "/api/console/purchase-email", { body: { ...draft, preheader: "" } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.copy.subject, "Welcome aboard, {firstName}");
  assert.deepEqual(saved.body.copy.tiers.power.includes, ["Everything", "And more"]);
  const row = await M.EmailTemplate.findOne({ key: "purchase-email" }).lean();
  assert.deepEqual([row.subject, row.fields.tiers.power.passName, row.updatedBy], ["Welcome aboard, {firstName}", "Power Pass · Founders", "Mo Manager"]);
  const audit = await lastAudit("purchase_email_template");
  names(audit.detail, "wording: ", "subject", "passName (power)", "includes (power)");
  assert.equal(audit.adminName, "Mo Manager");
});

test("sendTicketEmail uses the purchase email template (Resend stubbed: nothing is delivered)", { skip }, async () => {
  const { sendTicketEmail } = await import("../services/emailService.js");
  resendCalls.length = 0;
  await sendTicketEmail({ email: "pat.buyer@example.com", name: "Pat Buyer", firstName: "Pat", ticketId: "abc123def456", tier: "power" });
  assert.equal(resendCalls.length, 1);
  const sent = resendCalls[0];
  assert.equal(sent.to, "pat.buyer@example.com");
  assert.equal(sent.subject, "Welcome aboard, Pat");
  assert.match(sent.html, /Power Pass · Founders/);
  assert.match(sent.text, / {2}- Everything\n {2}- And more/);
  assert.match(sent.html, /cid:ttfc-logo/); // the logo + venue header stay
  assert.match(sent.html, /The Westin Harbour Castle/);
  assert.ok(sent.attachments.some((a) => a.content_id === "ttfc-logo") && sent.attachments.some((a) => /\.pdf$/.test(a.filename)));
  // Another pass type: the generic subject, its own built-in name and list.
  resendCalls.length = 0;
  await sendTicketEmail({ email: "ann.buyer@example.com", name: "Ann Buyer", ticketId: "abc123def457", tier: "apex" });
  assert.equal(resendCalls[0].subject, "Welcome aboard, Ann");
  assert.match(resendCalls[0].html, /Apex Pass/);
  assert.match(resendCalls[0].text, /Pre-Matched Business Meetings/);
  // Back to the built-in email: an empty template.
  await call("PUT", "/api/console/purchase-email", { body: {} });
  resendCalls.length = 0;
  await sendTicketEmail({ email: "pat.buyer@example.com", name: "Pat Buyer", firstName: "Pat", ticketId: "abc123def458", tier: "power" });
  assert.equal(resendCalls[0].subject, "You're in — your TTFC 2026 Power Pass is confirmed 🎟");
  names((await lastAudit("purchase_email_template")).detail, "subject reset", "includes reset (power)");
});

/* ---------- the speakers' email ---------- */

test("speakers: template for all, a speaker's own wording beats it; management only; audited; previews never send", { skip }, async () => {
  const pass = await M.Attendee.create({ name: "Kai Example", email: "kai.example@example.com", ticketId: "kai000000001", ticketType: "speaker",
    promoCode: "SPEAKER", speakerId: "manual:kai-example" });
  const other = await M.Attendee.create({ name: "Lee Example", email: "lee.example@example.com", ticketId: "lee000000001", ticketType: "speaker",
    promoCode: "SPEAKER", speakerId: "manual:lee-example" });

  const tpl = await call("GET", "/api/console/speaker-passes/template", { as: staff });
  assert.equal(tpl.status, 200);
  assert.equal(tpl.body.defaults.passName, "Speaker Pass");
  assert.ok(tpl.body.fields.some((f) => f.key === "rosRegTitle"));
  assert.ok(!tpl.body.passFields.some((f) => f.key === "passName"));

  const template = { headline: "Template headline", rsvpButton: "Save my seat", includes: [["Template row", "for every speaker"]], cc: "" };
  assert.equal((await call("PUT", "/api/console/speaker-passes/template", { as: staff, body: template })).status, 403);
  const saved = await call("PUT", "/api/console/speaker-passes/template", { body: template });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.template.rsvpButton, "Save my seat");
  names((await lastAudit("speaker_pass_template")).detail, "wording: ", "headline", "rsvpButton", "includes", "cc: nobody");

  // Edit email's preview: the unsaved draft, a sample speaker with a run of show.
  const sample = await call("POST", "/api/console/speaker-passes/preview-sample", { as: staff, body: { template: true, rosDaysTitle: "Your two days", withRunOfShow: true } });
  assert.match(sample.body.html, /Your two days/);
  assert.doesNotMatch(sample.body.html, /Template headline/); // the draft replaces the saved template

  const own = { label: "Speaker Pass · Keynote", headline: "Kai's own headline", includes: [] };
  assert.equal((await call("PUT", `/api/console/speaker-passes/${pass._id}/copy`, { as: staff, body: own })).status, 403);
  const put = await call("PUT", `/api/console/speaker-passes/${pass._id}/copy`, { body: own });
  assert.equal(put.status, 200);
  assert.deepEqual([put.body.label, put.body.copy.headline], ["Speaker Pass · Keynote", "Kai's own headline"]);
  assert.equal(put.body.defaults.rsvpButton, "Save my seat"); // what an empty field of Kai's shows: the template
  names((await lastAudit("speaker_pass_copy")).detail, "Kai Example: ", "headline", "passName");

  const kai = await call("POST", `/api/console/speaker-passes/${pass._id}/preview`, { as: staff, body: {} });
  assert.equal(kai.status, 200);
  assert.match(kai.body.html, /Kai&#39;s own headline/);
  assert.doesNotMatch(kai.body.html, /Template headline/);
  assert.match(kai.body.html, />Save my seat</);
  assert.match(kai.body.html, /SPEAKER PASS · KEYNOTE/);
  assert.match(kai.body.html, /Template row/);
  assert.equal(kai.body.defaults.headline, "Template headline");

  const lee = await call("GET", `/api/console/speaker-passes/${other._id}/preview`, { as: staff });
  assert.match(lee.body.html, /Template headline/);
  assert.match(lee.body.html, /SPEAKER PASS</);

  // The per-speaker editor's unsaved draft ({ draft: true }) replaces Kai's saved wording in the preview.
  const draft = await call("POST", `/api/console/speaker-passes/${pass._id}/preview`, { as: staff, body: { draft: true, headline: "Unsaved" } });
  assert.match(draft.body.html, /Unsaved/);
  assert.match(draft.body.html, /SPEAKER PASS</); // no label in the draft: the template / built-in name

  // A nudge keeps its own subject, headline and message, the rest of the wording as the pass email.
  const nudge = await call("POST", `/api/console/speaker-passes/${pass._id}/nudge/preview`, { body: {} });
  assert.match(nudge.body.subject, /a quick reminder/);
  assert.doesNotMatch(nudge.body.html, /Kai&#39;s own headline/);
  assert.match(nudge.body.html, />Save my seat</);
  assert.match(nudge.body.html, /SPEAKER PASS · KEYNOTE/);
  assert.equal(resendCalls.filter((c) => /kai\.example/.test(JSON.stringify(c.to))).length, 0, "nothing was sent");
});

/* ---------- issued and exhibitor passes ---------- */

test("issued passes: template per pass type, a pass's own wording and name beat it; exhibitor template preview", { skip }, async () => {
  const tiers = await call("GET", "/api/console/issued-passes/tiers", { as: staff });
  assert.doesNotMatch(tiers.body.tiers.find((t) => t.key === "apex").access, /all access/i);
  assert.ok(tiers.body.fields.some((f) => f.key === "rsvpButton") && !tiers.body.fields.some((f) => f.key === "passName"));

  const template = { footerNote: "Template footer note.", tiers: { power: { passName: "Power Pass · VIP", includes: [["VIP row", "template"]] } } };
  assert.equal((await call("PUT", "/api/console/issued-passes/email", { as: staff, body: template })).status, 403);
  const saved = await call("PUT", "/api/console/issued-passes/email", { body: template });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.copy.tiers.power.passName, "Power Pass · VIP");
  assert.equal(saved.body.defaults.power.passName, "Power Pass");
  names((await lastAudit("issued_pass_email_template")).detail, "footerNote", "passName (power)", "includes (power)");

  const made = await call("POST", "/api/console/issued-passes", { body: {
    name: "Ola Example", email: "ola.example@example.com", tier: "power", label: "Guest of Honour",
    rsvpButton: "Pick my events", includes: [["Ola's row", "just for Ola"], ["2× Luncheons", "Both days"]],
  } });
  assert.equal(made.status, 201);
  assert.deepEqual(made.body.row.copy.includes, [["Ola's row", "just for Ola"], ["2× Luncheons", "Both days"]]);
  const ola = await call("GET", `/api/console/issued-passes/${made.body.row.id}/preview`, { as: staff });
  assert.match(ola.body.html, /GUEST OF HONOUR/);
  assert.match(ola.body.html, /Ola&#39;s row/);
  assert.doesNotMatch(ola.body.html, /VIP row/);
  assert.match(ola.body.html, />Pick my events</);
  assert.match(ola.body.html, /Template footer note\./);
  names((await lastAudit("issued_pass_create")).detail, "wording: ", "rsvpButton", "includes");

  const plain = await call("POST", "/api/console/issued-passes", { body: { name: "Pam Example", email: "pam.example@example.com", tier: "power" } });
  const pam = await call("GET", `/api/console/issued-passes/${plain.body.row.id}/preview`, { as: staff });
  assert.match(pam.body.html, /POWER PASS · VIP/);
  assert.match(pam.body.html, /VIP row/);
  assert.match(pam.body.subject, /your Power Pass · VIP for TTFC 2026/);
  assert.equal(pam.body.defaults.footerNote, "Template footer note.");

  // A per-pass edit back to exactly what the pass shows anyway is no edit (the list keeps following the template and rules).
  const edited = await call("PATCH", `/api/console/issued-passes/${made.body.row.id}`, { body: { includes: [["VIP row", "template"]], rsvpButton: "" } });
  assert.equal(edited.status, 200);
  assert.deepEqual(edited.body.row.copy.includes || [], []);
  assert.match((await lastAudit("issued_pass_edit")).detail, /wording: /);

  const ex = await call("POST", "/api/console/exhibitor-passes/email/preview", { as: staff, body: { tier: "connect", headline: "Booth time, {firstName}!" } });
  assert.equal(ex.status, 200);
  assert.match(ex.body.html, /Booth time, Jane!/);
  assert.match(ex.body.html, /CONNECT PASS/);
  assert.match(ex.body.attachments[0].filename, /\.pdf$/);
  assert.equal(resendCalls.filter((c) => /example\.example\.com|ola\.example|pam\.example/.test(JSON.stringify(c.to))).length, 0, "nothing was sent");
});
