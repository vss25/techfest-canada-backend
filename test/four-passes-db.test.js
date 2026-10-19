/* Four passes, person edits and Delete person against a real (throwaway) MongoDB.
   Starts a local mongod in a temp folder on a free port and stops it after; skipped when the
   binary isn't there (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6).
   Nothing leaves the machine: Sanity, Stripe and Resend are never reached (fetch is stubbed,
   no Stripe key, a dummy Resend key and nothing here sends email). Fictional people, example.com. */
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

// The public Sanity CDN (speaker list, agenda, logos): canned answers, never the network.
const SPEAKERS = [{ _id: "spk-kai", name: "Kai Speaker" }];
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.startsWith("https://api.resend.com/")) {
    // Never sent: the email service is answered here.
    sent.push(JSON.parse(opts?.body || "{}"));
    return new Response(JSON.stringify({ id: `stub_${sent.length}` }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.includes(".sanity.io/")) {
    const q = decodeURIComponent(url.split("query=")[1] || "");
    const result = /_type=="speaker"/.test(q) ? SPEAKERS : [];
    return new Response(JSON.stringify({ result }), { status: 200, headers: { "content-type": "application/json" } });
  }
  throw new Error(`blocked in the test: ${url}`);
};

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });

let mongod = null;
let dbDir = "";
let server = null;
let base = "";
let M = {};          // models
let jwt;
let mongoose;

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-fp-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_four_passes_test`, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  ({ default: jwt } = await import("jsonwebtoken"));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.Attendee = await imp("../models/Attendee.js");
  M.Rsvp = await imp("../models/Rsvp.js");
  M.EmailTemplate = await imp("../models/EmailTemplate.js");
  M.TicketInventory = await imp("../models/TicketInventory.js");
  M.Brochure = await imp("../models/Brochure.js");
  M.Agenda = await imp("../models/Agenda.js");
  M.FormSubmission = await imp("../models/FormSubmission.js");
  M.Subscription = await imp("../models/Subscription.js");
  M.CampaignSend = await imp("../models/CampaignSend.js");
  M.EmailTracking = await imp("../models/EmailTracking.js");
  M.Lead = await imp("../models/Lead.js");
  M.Nomination = await imp("../models/Nomination.js");
  M.Audience = await imp("../models/Audience.js");
  M.SignInRequest = await imp("../models/SignInRequest.js");
  M.PavilionApplication = await imp("../models/PavilionApplication.js");
  M.AppNotification = await imp("../models/AppNotification.js");
  M.ActivityEvent = await imp("../models/ActivityEvent.js");
  Object.assign(M, await import("../models/Social.js"), await import("../models/Community.js"), await import("../models/Admin.js"));
  const { default: express } = await import("express");
  const app = express();
  // The Stripe webhook needs the raw body (as in server.js, before express.json()); it builds its client on
  // import, so a dummy key only for that (nothing here calls Stripe).
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_local_test";
  app.use("/api/webhook", express.raw({ type: "application/json" }), (await import("../routes/webhook.js")).default);
  delete process.env.STRIPE_SECRET_KEY;
  app.use(express.json());
  app.use("/api/console/people", (await import("../routes/people.js")).default);
  app.use("/api/auth", (await import("../routes/auth.js")).default);
  app.use("/api/rsvp", (await import("../routes/rsvp.js")).default);
  app.use("/api/checkin", (await import("../routes/checkin.js")).default);
  app.use("/api/payments", (await import("../routes/payments.js")).default);
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

const tokenFor = (u, via) => jwt.sign({ id: String(u._id), ...(via ? { via } : {}) }, process.env.JWT_SECRET, { expiresIn: "1h" });
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
const d = (s) => new Date(`2026-${s}T12:00:00Z`);
const RETIRED = /Speaker Pass|All Access Pass|Exhibitor Pass/i;

/* ---------- 1. The migration ---------- */

test("migration: speakers' passes become Power Passes, the speaker type and breakfasts stay; idempotent", { skip }, async () => {
  const { User, Attendee, Rsvp, EmailTemplate, AppContent, AdminAudit } = M;
  const { migrateFourPassesOnce, MIGRATION_KEY } = await import("../services/fourPasses.js");
  const { effectiveTypes, passKind } = await import("../services/teamRoles.js");
  const { autoCxo, ticketsWithCxo } = await import("../services/cxoBreakfast.js");

  const lee = await User.create({ name: "Lee Speaker", email: "lee.speaker@example.com", tickets: [{ ticketId: "lee000000001", type: "speaker", purchaseDate: d("10-10") }] });
  const ann = await User.create({ name: "Ann Apex", email: "ann.apex@example.com", tickets: [{ ticketId: "ann000000001", type: "apex", stripeSessionId: "cs_ann" }] });
  await Attendee.create([
    { name: "Lee Speaker", email: "", ticketId: "lee000000001", ticketType: "speaker", promoCode: "SPEAKER", speakerId: "spk-lee", claimedBy: lee._id },
    { name: "Kai Speaker", email: "", ticketId: "kai000000001", ticketType: "speaker", promoCode: "SPEAKER", speakerId: "spk-kai" },
    { name: "Ida Issued", email: "ida.issued@example.com", ticketId: "ida000000001", ticketType: "speaker", promoCode: "ISSUED",
      issuedPass: { label: "All Access Pass", rsvp: true, copy: { subject: "{firstName}, your Speaker Pass", message: "Your All Access Pass is below." } } },
    { name: "Eve Exhibitor", email: "eve.exhibitor@example.com", ticketId: "eve000000001", ticketType: "connect", promoCode: "EXHIBITOR",
      issuedPass: { label: "Exhibitor Pass", rsvp: true, booth: { booth: "B7" }, copy: { message: "Your Exhibitor Pass and manual." } } },
    { name: "Gus Guest", email: "gus.guest@example.com", ticketId: "gus000000001", ticketType: "power", stripeSessionId: "cs_gus" },
  ]);
  await EmailTemplate.create([
    { key: "speaker-pass", subject: "{firstName}, your Speaker Pass and run of show", message: "Speaker Passes go out today." },
    { key: "exhibitor-pass", subject: "Your Exhibitor Pass", headline: "Welcome" },
  ]);
  await Rsvp.create({ key: "t:kai000000001", firstName: "Kai", lastName: "Speaker", name: "Kai Speaker", nameKey: "kai speaker", ticketId: "KAI000000001",
    ticketVerified: true, kind: "speaker", tier: "speaker", tierVerified: true, chosenTier: "speaker", detectedTier: "speaker",
    days: ["day1"], options: ["cxo_d1", "awards"] });

  const out = await migrateFourPassesOnce({ User, Attendee, Rsvp, EmailTemplate, AppContent, AdminAudit, log: { log() {}, error() {} } });
  assert.deepEqual(
    [out.passesToPower, out.accountTickets, out.accountsToPower, out.labelsCleared, out.passCopiesRenamed, out.templatesRenamed, out.rsvpsToPower],
    [3, 1, 1, 2, 2, 2, 1]);
  // Nothing is "speaker" any more, and every speaker's pass carries the marker.
  assert.equal(await Attendee.countDocuments({ ticketType: /speaker/i }), 0);
  assert.equal(await User.countDocuments({ "tickets.type": /speaker/i }), 0);
  const kai = await Attendee.findOne({ ticketId: "kai000000001" }).lean();
  assert.deepEqual([kai.ticketType, kai.speakerPass, kai.promoCode, kai.email], ["power", true, "SPEAKER", ""]);
  const ida = await Attendee.findOne({ ticketId: "ida000000001" }).lean();
  assert.deepEqual([ida.ticketType, ida.speakerPass, ida.issuedPass.label, ida.issuedPass.copy.subject, ida.issuedPass.copy.message],
    ["power", true, "", "{firstName}, your Power Pass", "Your Power Pass is below."]);
  const eve = await Attendee.findOne({ ticketId: "eve000000001" }).lean();
  assert.deepEqual([eve.ticketType, eve.speakerPass, eve.issuedPass.label, eve.issuedPass.copy.message], ["connect", undefined, "", "Your Connect Pass and manual."]);
  assert.equal((await Attendee.findOne({ ticketId: "gus000000001" }).lean()).speakerPass, undefined); // a bought pass is untouched
  const t = await EmailTemplate.find({}).sort({ key: 1 }).lean();
  assert.deepEqual(t.map((x) => [x.key, x.subject]), [["exhibitor-pass", "Your Connect Pass"], ["speaker-pass", "{firstName}, your Power Pass and run of show"]]);
  assert.equal(t[1].message, "Power Passes go out today.");
  const r = await Rsvp.findOne({ key: "t:kai000000001" }).lean();
  assert.deepEqual([r.tier, r.chosenTier, r.detectedTier, r.kind, r.options], ["power", "power", "power", "speaker", ["cxo_d1", "awards"]]);

  // The speaker type is kept (from the pass), and so are the CxO Breakfasts.
  const leeAfter = await User.findById(lee._id).lean();
  assert.deepEqual([leeAfter.tickets[0].type, leeAfter.tickets[0].speakerPass], ["power", true]);
  assert.ok(effectiveTypes(leeAfter).includes("speaker"));
  assert.equal(passKind(kai), "speaker");
  assert.equal(autoCxo(kai.ticketType, [], { speakerPass: true }), true);
  assert.equal(ticketsWithCxo(leeAfter.tickets, { types: effectiveTypes(leeAfter) })[0].cxoBreakfast, true);
  assert.equal(ticketsWithCxo((await User.findById(ann._id).lean()).tickets, { types: [] })[0].type, "apex");

  // Counts only in the audit row and the AppContent record.
  const audit = await AdminAudit.findOne({ action: "four_passes_migration" }).lean();
  assert.match(audit.detail, /^Four passes only: 3 passes and 1 account tickets/);
  assert.doesNotMatch(audit.detail, /Kai|Lee|Ida|Eve|example\.com/);
  assert.ok(await AppContent.exists({ key: MIGRATION_KEY }));
  // Runs once.
  assert.equal(await migrateFourPassesOnce({ User, Attendee, Rsvp, EmailTemplate, AppContent, AdminAudit, log: { log() {}, error() {} } }), null);
});

test("after the migration: RSVP lookup, /auth/me and check-in say Power Pass, keep the speaker and their breakfasts", { skip }, async () => {
  const { User } = M;
  // RSVP page: Kai (on the speaker list) with his ticket ID.
  const look = await call("POST", "/api/rsvp/lookup", { body: { firstName: "Kai", lastName: "Speaker", ticketId: "KAI000000001" } });
  assert.equal(look.status, 200);
  assert.deepEqual([look.body.kind, look.body.tier, look.body.tierLabel, look.body.verified, look.body.cxoBreakfast], ["speaker", "power", "Power Pass", true, true]);
  assert.ok(look.body.allowedOptions.includes("cxo_d1") && look.body.allowedOptions.includes("gala"));
  assert.ok(!look.body.allowedOptions.includes("meetings") && !look.body.allowedOptions.includes("lounge"));
  assert.doesNotMatch(JSON.stringify(look.body), RETIRED);
  const opts = await call("GET", "/api/rsvp/options");
  assert.deepEqual(opts.body.tiers.map((x) => x.key), ["connect", "influence", "power", "apex"]);
  assert.doesNotMatch(JSON.stringify(opts.body), RETIRED);

  // The app's /auth/me: the ticket is a Power Pass, a speaker's, with the breakfasts; the person is a speaker.
  const lee = await User.findOne({ email: "lee.speaker@example.com" });
  const me = await call("GET", "/api/auth/me", { token: tokenFor(lee) });
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.tickets.map((x) => [x.type, x.speakerPass, x.cxoBreakfast]), [["power", true, true]]);
  assert.ok(me.body.types.includes("speaker"));
  assert.doesNotMatch(JSON.stringify(me.body.tickets), RETIRED);

  // Door check-in (staff): Power Pass, and the scanner can show "Speaker".
  const staff = await User.create({ name: "Sid Scanner", email: "sid.scanner@example.com", role: "admin", staffRole: "staff" });
  const scan = await call("POST", "/api/checkin/scan", { token: tokenFor(staff), body: { ticketId: "TECHFEST:kai000000001" } });
  assert.deepEqual([scan.status, scan.body.status, scan.body.ticketType, scan.body.passName, scan.body.speaker], [200, "success", "power", "Power Pass", true]);
  // Apple Wallet: the same pass name.
  const { passContent } = await import("../services/walletPass.js");
  const pass = passContent({ ticketId: "kai000000001", tier: "power", name: "Kai Speaker" });
  assert.equal(pass.secondary.find((f) => f.key === "pass").value, "Power Pass");
  assert.equal(passContent({ ticketId: "x", tier: "speaker", name: "Old" }).secondary[0].value, "Power Pass");
  assert.doesNotMatch(JSON.stringify(pass), RETIRED);
});

test("a speaker's Power Pass upgrades to Apex at the price difference; Power's sold count is left alone", { skip }, async () => {
  const { User, TicketInventory } = M;
  await TicketInventory.create([{ tier: "power", total: 10, sold: 2, price: 1099 }, { tier: "apex", total: 10, sold: 1, price: 1599 }]);
  const lee = await User.findOne({ email: "lee.speaker@example.com" });
  const q = await call("GET", "/api/payments/upgrade-quote?ticketId=lee000000001&tier=apex", { token: tokenFor(lee) });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.deepEqual([q.body.fromTier, q.body.toTier, q.body.difference], ["power", "apex", 500]);
  assert.doesNotMatch(JSON.stringify(q.body), RETIRED);
  // Stripe says it's paid (a signed test event, built here): the ticket becomes Apex, still a speaker's.
  const { default: Stripe } = await import("stripe");
  const payload = JSON.stringify({ id: "evt_up", type: "checkout.session.completed", data: { object: {
    id: "cs_up_lee", customer_details: { email: "lee.speaker@example.com", name: "Lee Speaker" },
    metadata: { type: "upgrade", tier: "apex", userId: String(lee._id), upgradeFrom: "lee000000001", fromTier: "power" },
  } } });
  const header = new Stripe("sk_test_dummy").webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  const r = await realFetch(`${base}/api/webhook/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload });
  assert.equal(r.status, 200);
  const t = (await User.findById(lee._id).lean()).tickets[0];
  assert.deepEqual([t.type, t.upgradedFrom, t.speakerPass], ["apex", "power", true]);
  const inv = Object.fromEntries((await TicketInventory.find({}).lean()).map((x) => [x.tier, x.sold]));
  assert.deepEqual([inv.power, inv.apex], [2, 2]);
  // The purchase email went to the stub only, and says Apex Pass.
  const mail = sent.find((m) => (m.to || []).includes?.("lee.speaker@example.com") || m.to === "lee.speaker@example.com");
  assert.ok(mail, "upgrade email built");
  assert.match(mail.subject, /Apex Pass/);
  assert.doesNotMatch(`${mail.subject}${mail.html}${mail.text}`, RETIRED);
  // From now on it counts like any sold Apex Pass (the recount agrees with the webhook).
  const { isIssuedSpeakerPass } = await import("../services/teamRoles.js");
  assert.equal(isIssuedSpeakerPass(t), false);
});

/* ---------- 2. Edits ---------- */

let mia, sam, staffTok, mgmtTok;
async function staffAccounts() {
  if (mia) return;
  mia = await M.User.create({ name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management" });
  sam = await M.User.create({ name: "Sam Staff", email: "sam.staff@example.com", role: "admin", staffRole: "staff" });
  mgmtTok = tokenFor(mia);
  staffTok = tokenFor(sam);
}
const idOf = async (q) => (await call("GET", `/api/console/people?q=${encodeURIComponent(q)}&refresh=1`, { token: mgmtTok })).body.rows[0]?.id;

test("edit: names, email, phone, company follow to every record; sign-in email needs management, unique, audited", { skip }, async () => {
  await staffAccounts();
  const { User, Attendee, Rsvp, AdminAudit } = M;
  const tia = await User.create({ name: "Tia Typo", email: "tia.old@example.com", organization: "Old Co",
    tickets: [{ ticketId: "tia000000001", type: "connect", promoCode: "COMP", details: { firstName: "Tia", lastName: "Typo", phone: "+1 416 555 0100", organisation: "Old Co" } }] });
  await Attendee.create({ name: "Tia Typo", email: "tia.old@example.com", ticketId: "tia000000001", ticketType: "connect", promoCode: "COMP", claimedBy: tia._id,
    details: { firstName: "Tia", lastName: "Typo" } });
  await Rsvp.create({ key: "t:tia000000001", firstName: "Tia", lastName: "Typo", name: "Tia Typo", nameKey: "tia typo", email: "tia.old@example.com",
    ticketId: "TIA000000001", ticketVerified: true, kind: "ticket", tier: "connect", tierVerified: true, days: ["day1"], options: ["sessions_d1"] });
  await User.create({ name: "Taken Already", email: "taken@example.com" });
  const id = await idOf("tia.old");
  assert.match(id, /^u-/);

  // Staff can't change emails; management can, but not to another account's.
  assert.equal((await call("PATCH", `/api/console/people/${id}`, { token: staffTok, body: { email: "tia@example.com" } })).status, 403);
  const clash = await call("PATCH", `/api/console/people/${id}`, { token: mgmtTok, body: { email: "TAKEN@example.com" } });
  assert.deepEqual([clash.status, clash.body.field], [409, "email"]);
  const bad = await call("PATCH", `/api/console/people/${id}`, { token: mgmtTok, body: { phone: "call me" } });
  assert.deepEqual([bad.status, bad.body.field], [400, "phone"]);

  const ok = await call("PATCH", `/api/console/people/${id}`, { token: mgmtTok, body: {
    firstName: "Tia", lastName: "Tipo", email: "tia.new@example.com", phone: "+1 647 555 0199", company: "New Co", jobTitle: "CTO",
  } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const u = await User.findById(tia._id).lean();
  assert.deepEqual([u.name, u.email, u.organization, u.jobTitle], ["Tia Tipo", "tia.new@example.com", "New Co", "CTO"]);
  assert.deepEqual([u.tickets[0].details.lastName, u.tickets[0].details.phone, u.tickets[0].details.organisation], ["Tipo", "+1 647 555 0199", "New Co"]);
  const a = await Attendee.findOne({ ticketId: "tia000000001" }).lean();
  assert.deepEqual([a.name, a.email, a.details.lastName, a.details.phone], ["Tia Tipo", "tia.new@example.com", "Tipo", "+1 647 555 0199"]);
  const r = await Rsvp.findOne({ key: "t:tia000000001" }).lean();
  assert.deepEqual([r.name, r.lastName, r.nameKey, r.email, r.options], ["Tia Tipo", "Tipo", "tia tipo", "tia.new@example.com", ["sessions_d1"]]);
  // Signs in with the new email: the account is the same.
  assert.equal(await User.countDocuments({ email: "tia.old@example.com" }), 0);
  const edit = await AdminAudit.findOne({ action: "person_edit", targetId: id }).sort({ at: -1 }).lean();
  assert.match(edit.detail, /name, email, company, jobTitle/);
  const mail = await AdminAudit.findOne({ action: "person_email", targetId: id }).lean();
  assert.match(mail.detail, /sign-in email changed/);
  assert.doesNotMatch(mail.detail, /tia\.(old|new)@/); // hashes, not addresses
  assert.equal(mail.adminName, "Mia Manager");

  // RSVP Email Sent: a manual Yes, then back to automatic.
  const yes = await call("PATCH", `/api/console/people/${id}`, { token: staffTok, body: { rsvpEmailSent: true } });
  assert.equal(yes.status, 200);
  const prof = (await call("GET", `/api/console/people/${id}`, { token: staffTok })).body.person;
  assert.deepEqual([prof.rsvpEmail.sent, prof.rsvpEmail.mark, prof.rsvpEmail.markedBy, prof.rsvpEmail.via[0]], [true, true, "Sam Staff", "Marked by staff"]);
  assert.equal(prof.phone, "+1 647 555 0199");
  await call("PATCH", `/api/console/people/${id}`, { token: staffTok, body: { rsvpEmailSent: null } });
  const back = (await call("GET", `/api/console/people/${id}`, { token: staffTok })).body.person;
  assert.deepEqual([back.rsvpEmail.sent, back.rsvpEmail.mark], [false, null]);
  // The mark never reaches the person's own app.
  const me = await call("GET", "/api/auth/me", { token: tokenFor(tia) });
  assert.equal("rsvpEmailMark" in me.body, false);
});

test("edit: person types (account: App › People rules), pass-only Speaker switch, VIP and Exhibitor", { skip }, async () => {
  await staffAccounts();
  const { User, Attendee } = M;
  const val = await User.create({ name: "Val Vendor", email: "val.vendor@example.com", tickets: [{ ticketId: "val000000001", type: "influence", promoCode: "COMP" }] });
  const id = await idOf("val.vendor");
  // Staff can't give the staff type; management adds vendor + speaker.
  assert.equal((await call("PATCH", `/api/console/people/${id}`, { token: staffTok, body: { types: ["staff"] } })).status, 403);
  const t = await call("PATCH", `/api/console/people/${id}`, { token: staffTok, body: { types: ["vendor", "speaker"] } });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.deepEqual((await User.findById(val._id).lean()).types, ["speaker", "vendor"]);
  const p = (await call("GET", `/api/console/people/${id}`, { token: staffTok })).body.person;
  assert.deepEqual([p.types, p.pass.tierLabel, p.pass.cxoBreakfast], [["speaker", "vendor"], "Influence Pass", true]); // a speaker: the breakfasts
  // A pass-only speaker switched off and on (saved on the passes).
  const kaiId = await idOf("kai000000001");
  const off = await call("PATCH", `/api/console/people/${kaiId}`, { token: staffTok, body: { speaker: false } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal((await Attendee.findOne({ ticketId: "kai000000001" }).lean()).speakerPass, false);
  assert.ok(!(await call("GET", `/api/console/people/${kaiId}`, { token: staffTok })).body.person.types.includes("speaker"));
  await call("PATCH", `/api/console/people/${kaiId}`, { token: staffTok, body: { speaker: true } });
  assert.ok((await call("GET", `/api/console/people/${kaiId}`, { token: staffTok })).body.person.types.includes("speaker"));
  // Types for a pass-only person need an account.
  assert.equal((await call("PATCH", `/api/console/people/${kaiId}`, { token: staffTok, body: { types: ["vendor"] } })).status, 409);
});

test("pass changes: between the four (management, inventory like an upgrade, RSVP follows), manual value for passes paid outside Stripe", { skip }, async () => {
  await staffAccounts();
  const { User, Attendee, Rsvp, TicketInventory, AdminAudit } = M;
  await TicketInventory.create([{ tier: "connect", total: 10, sold: 5, price: 849 }, { tier: "influence", total: 10, sold: 3, price: 949 }]);
  const cy = await User.create({ name: "Cy Change", email: "cy.change@example.com",
    tickets: [{ ticketId: "cyy000000001", type: "connect", promoCode: "COMP" }, { ticketId: "cyy000000002", type: "power", stripeSessionId: "cs_cy" }] });
  await Rsvp.create({ key: "t:cyy000000001", firstName: "Cy", lastName: "Change", name: "Cy Change", nameKey: "cy change", ticketId: "CYY000000001",
    ticketVerified: true, kind: "ticket", tier: "connect", tierVerified: true, days: ["day1"], options: ["sessions_d1"] });
  const id = await idOf("cy.change");
  // Staff can't; only the four.
  assert.equal((await call("PATCH", `/api/console/people/${id}/passes/cyy000000001`, { token: staffTok, body: { tier: "influence" } })).status, 403);
  assert.equal((await call("PATCH", `/api/console/people/${id}/passes/cyy000000001`, { token: mgmtTok, body: { tier: "speaker" } })).status, 400);
  const up = await call("PATCH", `/api/console/people/${id}/passes/cyy000000001`, { token: mgmtTok, body: { tier: "influence" } });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal((await User.findById(cy._id).lean()).tickets[0].type, "influence");
  assert.equal((await Rsvp.findOne({ key: "t:cyy000000001" }).lean()).tier, "influence");
  const inv = Object.fromEntries((await TicketInventory.find({}).lean()).map((x) => [x.tier, x.sold]));
  assert.deepEqual([inv.connect, inv.influence], [4, 4]);
  assert.match((await AdminAudit.findOne({ action: "pass_tier" }).lean()).detail, /Connect Pass → Influence Pass \(no charge; inventory connect −1, influence \+1\)/);
  // A speaker's pass never took a seat: changing it moves no inventory.
  const kaiId = await idOf("kai000000001");
  await call("PATCH", `/api/console/people/${kaiId}/passes/kai000000001`, { token: mgmtTok, body: { tier: "apex" } });
  const inv2 = Object.fromEntries((await TicketInventory.find({}).lean()).map((x) => [x.tier, x.sold]));
  assert.deepEqual([inv2.power, inv2.apex], [inv.power, inv.apex]);
  assert.equal((await Attendee.findOne({ ticketId: "kai000000001" }).lean()).ticketType, "apex");
  await call("PATCH", `/api/console/people/${kaiId}/passes/kai000000001`, { token: mgmtTok, body: { tier: "power" } });

  // Manual value: management only, never for a Stripe-paid pass.
  assert.equal((await call("PATCH", `/api/console/people/${id}/passes/cyy000000002`, { token: mgmtTok, body: { manualValue: 500 } })).status, 409);
  assert.equal((await call("PATCH", `/api/console/people/${id}/passes/cyy000000001`, { token: staffTok, body: { manualValue: 500 } })).status, 403);
  const v = await call("PATCH", `/api/console/people/${id}/passes/cyy000000001`, { token: mgmtTok, body: { manualValue: 849.5, manualValueNote: "Invoice 1042" } });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  const pass = v.body.person.passes.find((x) => x.ticketId === "cyy000000001");
  assert.deepEqual([pass.value, pass.valueSource, pass.valueBand, pass.manualValueNote, pass.manualValueBy], [849.5, "manual", "above", "Invoice 1042", "Mia Manager"]);
  assert.equal((await User.findById(cy._id).lean()).tickets[0].manualValue, 849.5);
  // Never in the person's own app.
  const me = await call("GET", "/api/auth/me", { token: tokenFor(cy) });
  assert.equal("manualValue" in me.body.tickets[0], false);
});

/* ---------- 3. Delete person ---------- */

test("delete: shows what goes, needs management and their full name, empties every collection for them and leaves others alone", { skip }, async () => {
  await staffAccounts();
  const x = M;
  const mk = async (name, email, tid) => {
    const u = await x.User.create({ name, email, tickets: [{ ticketId: tid, type: "connect", promoCode: "COMP", checkedIn: true }],
      apnsTokens: [{ token: `apns-${tid}` }], contactItems: [{ id: "p1", kind: "phone", value: "+1 416 555 0101" }] });
    await x.Attendee.create({ name, email, ticketId: tid, ticketType: "connect", promoCode: "COMP", claimedBy: u._id, checkedIn: true });
    await x.Rsvp.create({ key: `t:${tid}`, firstName: name.split(" ")[0], lastName: name.split(" ")[1], name, nameKey: name.toLowerCase(), ticketId: tid.toUpperCase(),
      ticketVerified: true, kind: "ticket", tier: "connect", days: ["day1"], options: [] });
    return u;
  };
  const dee = await mk("Dee Delete", "dee.delete@example.com", "dee000000001");
  const otto = await mk("Otto Other", "otto.other@example.com", "ott000000001");
  // Cara's pass was bought by Otto, under his email: deleting Cara never touches Otto's email records.
  await x.Attendee.create({ name: "Cara Colleague", email: "otto.other@example.com", ticketId: "car000000001", ticketType: "influence", promoCode: "COMP",
    details: { firstName: "Cara", lastName: "Colleague" } });
  const both = [dee, otto];
  for (const u of both) {
    const e = u.email;
    const post = await x.SocialPost.create({ authorId: u._id, authorName: u.name, body: "Hello" });
    await x.SocialComment.create({ postId: post._id, authorId: u._id, authorName: u.name, body: "Hi" });
    await x.SessionRegistration.create({ userId: u._id, sessionId: `s-${u._id}` });
    await x.SessionQuestion.create({ sessionId: "s1", authorId: u._id, authorName: u.name, body: "Q?" });
    await x.SessionVote.create({ sessionId: "s1", pollId: "p1", userId: u._id, optionIndex: 0 });
    const disc = await x.Discussion.create({ authorId: u._id, authorName: u.name, title: "T", body: "B", status: "approved" });
    await x.DiscussionReply.create({ discussionId: disc._id, authorId: u._id, authorName: u.name, body: "R" });
    const g = await x.CommunityGroup.create({ name: `G ${u.name}`, ownerId: u._id, ownerName: u.name, members: [u._id] });
    await x.GroupMessage.create({ groupId: g._id, authorId: u._id, authorName: u.name, body: "M" });
    await x.AppEvent.create([{ userId: u._id, deviceId: `dev-${u._id}`, name: "pwa_launch", platform: "web" }, { deviceId: `dev-${u._id}`, name: "pwa_installed", platform: "web" }]);
    await x.AppNotification.create({ userId: u._id, title: "Hi", body: "There" });
    await x.Brochure.create({ firstName: "A", lastName: "B", email: e, brochure: "sponsorship" }).catch(async () => x.Brochure.collection.insertOne({ email: e }));
    await x.Agenda.create({ firstName: "A", lastName: "B", email: e, industry: "AI", jobTitle: "CTO" });
    await x.FormSubmission.create({ form: "volunteer", email: e, name: u.name });
    await x.Subscription.create({ email: e });
    await x.CampaignSend.create({ campaign: "rsvp-reminder-2026", email: e, status: "sent" });
    await x.EmailTracking.create({ campaignId: "c1", email: e });
    await x.Lead.create({ leadName: u.name, email: e });
    await x.Nomination.create({ categoryType: "matrix", nomineeName: u.name, nominatorEmail: e });
    await x.SignInRequest.create({ email: e, tokenHash: `t-${e}`, codeHash: "c", expiresAt: new Date(Date.now() + 6e5) });
  }
  // Between the two: a connection, a chat, a block, a like, a report and an activity row.
  await x.SocialConnection.create({ fromUserId: dee._id, toUserId: otto._id, status: "accepted" });
  await x.SocialMessage.create({ threadKey: [dee._id, otto._id].map(String).sort().join(":"), fromUserId: otto._id, toUserId: dee._id, body: "Hey" });
  await x.Block.create({ userId: otto._id, blockedId: dee._id });
  const ottoPost = await x.SocialPost.findOne({ authorId: otto._id });
  await x.SocialPost.updateOne({ _id: ottoPost._id }, { $push: { likes: dee._id, mentions: { type: "user", id: String(dee._id), name: "Dee" } } });
  await x.CommunityGroup.updateOne({ ownerId: otto._id }, { $push: { members: dee._id } });
  await x.Report.create({ reporterId: otto._id, targetType: "user", targetId: String(dee._id) });
  await x.ActivityEvent.create({ userId: otto._id, actorId: dee._id, kind: "like", section: "feed", refId: ottoPost._id });
  await x.Audience.create({ name: "List", contacts: [{ email: "dee.delete@example.com" }, { email: "otto.other@example.com" }] });
  await x.PavilionApplication.create({ legalName: "Dee Co", repName: "Dee Delete", repEmail: "dee.delete@example.com" });

  const count = async (u) => {
    const id = u._id; const e = u.email;
    const n = async (m, f) => m.countDocuments(f);
    return {
      user: await n(x.User, { _id: id }), passes: await n(x.Attendee, { claimedBy: id }), rsvps: await n(x.Rsvp, { name: u.name }),
      posts: await n(x.SocialPost, { authorId: id }), comments: await n(x.SocialComment, { authorId: id }), regs: await n(x.SessionRegistration, { userId: id }),
      questions: await n(x.SessionQuestion, { authorId: id }), votes: await n(x.SessionVote, { userId: id }), discussions: await n(x.Discussion, { authorId: id }),
      replies: await n(x.DiscussionReply, { authorId: id }), groupMsgs: await n(x.GroupMessage, { authorId: id }), memberOf: await n(x.CommunityGroup, { members: id }),
      events: await n(x.AppEvent, { $or: [{ userId: id }, { deviceId: `dev-${id}` }] }), notes: await n(x.AppNotification, { userId: id }),
      brochure: await n(x.Brochure, { email: e }), agenda: await n(x.Agenda, { email: e }), forms: await n(x.FormSubmission, { email: e }),
      subs: await n(x.Subscription, { email: e }), sends: await n(x.CampaignSend, { email: e }), tracking: await n(x.EmailTracking, { email: e }),
      leads: await n(x.Lead, { email: e }), noms: await n(x.Nomination, { nominatorEmail: e }), signIn: await n(x.SignInRequest, { email: e }),
      lists: await n(x.Audience, { "contacts.email": e }),
      links: await n(x.SocialConnection, { $or: [{ fromUserId: id }, { toUserId: id }] }) + await n(x.SocialMessage, { $or: [{ fromUserId: id }, { toUserId: id }] })
        + await n(x.Block, { $or: [{ userId: id }, { blockedId: id }] }) + await n(x.Report, { targetId: String(id) }) + await n(x.ActivityEvent, { $or: [{ userId: id }, { actorId: id }] })
        + await n(x.SocialPost, { likes: id }) + await n(x.SocialPost, { "mentions.id": String(id) }),
    };
  };
  const ottoBefore = await count(otto);
  const deeBefore = await count(dee);
  assert.ok(Object.values(deeBefore).every((v) => v > 0), JSON.stringify(deeBefore));

  const id = await idOf("dee.delete");
  // Staff can't; management sees the plan first.
  assert.equal((await call("GET", `/api/console/people/${id}/delete-plan`, { token: staffTok })).status, 403);
  assert.equal((await call("DELETE", `/api/console/people/${id}`, { token: staffTok, body: { confirmName: "Dee Delete" } })).status, 403);
  const plan = await call("GET", `/api/console/people/${id}/delete-plan`, { token: mgmtTok });
  assert.equal(plan.status, 200);
  const item = (k) => plan.body.items.find((i) => i.key === k)?.count;
  assert.equal(item("accountTickets"), 1);
  assert.deepEqual([item("account"), item("passes"), item("rsvps"), item("posts"), item("messages"), item("connections"), item("brochureDownloads"),
    item("nominations"), item("appEvents"), item("groupMemberships"), item("marketingLists")], [1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 1]);
  assert.ok(plan.body.kept.some((k) => k.key === "stripe"));
  assert.ok(plan.body.kept.some((k) => k.key === "speakerList"));
  assert.equal(plan.body.kept.find((k) => k.key === "pavilion").count, 1);
  assert.deepEqual(plan.body.blockers, []);

  // Their full name, exactly (case and spaces aside).
  const wrong = await call("DELETE", `/api/console/people/${id}`, { token: mgmtTok, body: { confirmName: "Dee" } });
  assert.deepEqual([wrong.status, wrong.body.code], [400, "confirm"]);
  assert.equal(await x.User.countDocuments({ _id: dee._id }), 1);
  const gone = await call("DELETE", `/api/console/people/${id}`, { token: mgmtTok, body: { confirmName: "  dee   DELETE " } });
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  const deeAfter = await count(dee);
  assert.deepEqual(Object.entries(deeAfter).filter(([, v]) => v !== 0), [], JSON.stringify(deeAfter));
  // Otto: everything of his is still there (minus Dee's connection, chat, block, report, like and mention).
  const ottoAfter = await count(otto);
  assert.deepEqual({ ...ottoAfter, links: 0 }, { ...ottoBefore, links: 0 });
  assert.equal(await x.SocialPost.countDocuments({ authorId: otto._id }), 1);
  assert.equal(await x.CommunityGroup.countDocuments({ ownerId: otto._id, members: otto._id }), 1);
  assert.equal(await x.PavilionApplication.countDocuments({ repEmail: "dee.delete@example.com" }), 1); // the company's record stays
  // Audited without the name or the email.
  const audit = await x.AdminAudit.findOne({ action: "person_delete" }).lean();
  assert.match(audit.detail, /: account 1, accountTickets 1, passes 1, rsvps 1, /);
  assert.match(audit.detail, /email sha256 [0-9a-f]{16}/);
  assert.doesNotMatch(audit.detail, /Dee|dee\.delete/);
  assert.equal(audit.adminName, "Mia Manager");

  // Cara (pass only, bought under Otto's email): her pass goes, Otto's email records stay.
  const caraId = await idOf("Cara Colleague");
  const caraPlan = await call("GET", `/api/console/people/${caraId}/delete-plan`, { token: mgmtTok });
  assert.equal(caraPlan.body.items.find((i) => i.key === "brochureDownloads"), undefined);
  assert.equal(caraPlan.body.kept.find((k) => k.key === "sharedEmail").count, 1);
  assert.equal((await call("DELETE", `/api/console/people/${caraId}`, { token: mgmtTok, body: { confirmName: "Cara Colleague" } })).status, 200);
  assert.equal(await x.Attendee.countDocuments({ ticketId: "car000000001" }), 0);
  assert.deepEqual(await count(otto), ottoAfter);

  // Never your own account.
  const self = await call("GET", `/api/console/people/u-${mia._id}/delete-plan`, { token: mgmtTok });
  assert.match(self.body.blockers.join(" "), /your own account/);
  assert.equal((await call("DELETE", `/api/console/people/u-${mia._id}`, { token: mgmtTok, body: { confirmName: "Mia Manager" } })).status, 409);
});
