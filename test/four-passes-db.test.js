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
const RETIRED = /All[- ]Access Pass|Exhibitor Pass/i;

/* ---------- 1. Pass names: the migration ---------- */

test("migration: exhibitor passes named Connect Pass, All Access gone, issued Speaker Passes named so; tiers untouched; once", { skip }, async () => {
  const { User, Attendee, Rsvp, EmailTemplate, AppContent, AdminAudit } = M;
  const { migratePassNamesOnce, MIGRATION_KEY } = await import("../services/passNames.js");
  const { effectiveTypes, passKind } = await import("../services/teamRoles.js");
  const { autoCxo, ticketsWithCxo } = await import("../services/cxoBreakfast.js");

  const lee = await User.create({ name: "Lee Speaker", email: "lee.speaker@example.com", tickets: [{ ticketId: "lee000000001", type: "speaker", purchaseDate: d("10-10") }] });
  await Attendee.create([
    { name: "Lee Speaker", email: "", ticketId: "lee000000001", ticketType: "speaker", promoCode: "SPEAKER", speakerId: "spk-lee", claimedBy: lee._id },
    { name: "Kai Speaker", email: "", ticketId: "kai000000001", ticketType: "speaker", promoCode: "SPEAKER", speakerId: "spk-kai" },
    { name: "Ida Issued", email: "ida.issued@example.com", ticketId: "ida000000001", ticketType: "speaker", promoCode: "ISSUED",
      issuedPass: { label: "All Access Pass", rsvp: true, copy: { subject: "{firstName}, your Speaker Pass", message: "Your All Access Pass is below." } } },
    { name: "Eve Exhibitor", email: "eve.exhibitor@example.com", ticketId: "eve000000001", ticketType: "connect", promoCode: "EXHIBITOR",
      issuedPass: { label: "Exhibitor Pass", rsvp: true, booth: { booth: "B7" }, copy: { message: "Your Exhibitor Pass and manual." } } },
    { name: "Gus Guest", email: "gus.guest@example.com", ticketId: "gus000000001", ticketType: "power", stripeSessionId: "cs_gus" },
    { name: "Vin Vip", email: "vin.vip@example.com", ticketId: "vin000000001", ticketType: "apex", promoCode: "ISSUED", issuedPass: { label: "VIP Guest Pass", rsvp: true } },
  ]);
  await EmailTemplate.create([
    { key: "speaker-pass", subject: "{firstName}, your Speaker Pass and run of show", message: "All Access Passes go out today." },
    { key: "exhibitor-pass", subject: "Your Exhibitor Pass", headline: "Welcome" },
  ]);
  await Rsvp.create({ key: "t:kai000000001", firstName: "Kai", lastName: "Speaker", name: "Kai Speaker", nameKey: "kai speaker", ticketId: "KAI000000001",
    ticketVerified: true, kind: "speaker", tier: "speaker", tierVerified: true, chosenTier: "speaker", detectedTier: "speaker",
    days: ["day1"], options: ["cxo_d1", "awards"] });

  const out = await migratePassNamesOnce({ Attendee, EmailTemplate, AppContent, AdminAudit, log: { log() {}, error() {} } });
  assert.deepEqual([out.exhibitorLabels, out.speakerLabels, out.otherLabels, out.passCopiesRenamed, out.templatesRenamed], [1, 1, 0, 2, 2]);
  // No tier changes: Speaker Passes stay "speaker" (on passes, accounts and RSVPs).
  assert.equal(await Attendee.countDocuments({ ticketType: "speaker" }), 3);
  assert.equal(await User.countDocuments({ "tickets.type": "speaker" }), 1);
  const ida = await Attendee.findOne({ ticketId: "ida000000001" }).lean();
  assert.deepEqual([ida.ticketType, ida.issuedPass.label, ida.issuedPass.copy.subject, ida.issuedPass.copy.message],
    ["speaker", "", "{firstName}, your Speaker Pass", "Your Power Pass is below."]);
  const eve = await Attendee.findOne({ ticketId: "eve000000001" }).lean();
  assert.deepEqual([eve.ticketType, eve.issuedPass.label, eve.issuedPass.copy.message], ["connect", "", "Your Connect Pass and manual."]);
  assert.equal((await Attendee.findOne({ ticketId: "vin000000001" }).lean()).issuedPass.label, "VIP Guest Pass"); // staff's own name stays
  const t = await EmailTemplate.find({}).sort({ key: 1 }).lean();
  assert.deepEqual(t.map((x) => [x.key, x.subject]), [["exhibitor-pass", "Your Connect Pass"], ["speaker-pass", "{firstName}, your Speaker Pass and run of show"]]);
  assert.equal(t[1].message, "Power Passes go out today.");
  const r = await Rsvp.findOne({ key: "t:kai000000001" }).lean();
  assert.deepEqual([r.tier, r.kind, r.options], ["speaker", "speaker", ["cxo_d1", "awards"]]);
  // The speaker type and the CxO Breakfasts come with the Speaker Pass, as before.
  const leeAfter = await User.findById(lee._id).lean();
  assert.ok(effectiveTypes(leeAfter).includes("speaker"));
  assert.equal(passKind(await Attendee.findOne({ ticketId: "kai000000001" }).lean()), "speaker");
  assert.equal(autoCxo("speaker"), true);
  assert.equal(ticketsWithCxo(leeAfter.tickets, { types: effectiveTypes(leeAfter) })[0].cxoBreakfast, true);
  // Counts only in the audit row and the AppContent record.
  const audit = await AdminAudit.findOne({ action: "pass_names_migration" }).lean();
  assert.match(audit.detail, /^Pass names: 1 exhibitor passes now "Connect Pass", 1 issued Speaker Passes now "Speaker Pass"/);
  assert.doesNotMatch(audit.detail, /Kai|Lee|Ida|Eve|example\.com/);
  assert.ok(await AppContent.exists({ key: MIGRATION_KEY }));
  // Runs once.
  assert.equal(await migratePassNamesOnce({ Attendee, EmailTemplate, AppContent, AdminAudit, log: { log() {}, error() {} } }), null);
});

test("Speaker Pass everywhere: RSVP lookup and options, /auth/me, check-in and Wallet; never All Access or Exhibitor Pass", { skip }, async () => {
  const { User } = M;
  // RSVP page: Kai (on the speaker list) with his ticket ID: Power's options and both CxO Breakfasts, no Apex extras.
  const look = await call("POST", "/api/rsvp/lookup", { body: { firstName: "Kai", lastName: "Speaker", ticketId: "KAI000000001" } });
  assert.equal(look.status, 200);
  assert.deepEqual([look.body.kind, look.body.tier, look.body.tierLabel, look.body.verified, look.body.cxoBreakfast], ["speaker", "speaker", "Speaker Pass", true, true]);
  assert.ok(look.body.allowedOptions.includes("cxo_d1") && look.body.allowedOptions.includes("cxo_d2") && look.body.allowedOptions.includes("gala"));
  assert.ok(!look.body.allowedOptions.includes("meetings") && !look.body.allowedOptions.includes("lounge"));
  assert.doesNotMatch(JSON.stringify(look.body), RETIRED);
  const opts = await call("GET", "/api/rsvp/options");
  assert.deepEqual(opts.body.tiers.map((x) => [x.key, x.label, x.sold]),
    [["connect", "Connect Pass", true], ["influence", "Influence Pass", true], ["power", "Power Pass", true], ["apex", "Apex Pass", true], ["speaker", "Speaker Pass", false]]);
  assert.doesNotMatch(JSON.stringify(opts.body), RETIRED);

  // The app's /auth/me: tickets[].type "speaker", the breakfasts; no speakerPass field; the person is a speaker.
  const lee = await User.findOne({ email: "lee.speaker@example.com" });
  const me = await call("GET", "/api/auth/me", { token: tokenFor(lee) });
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.tickets.map((x) => [x.type, x.cxoBreakfast, "speakerPass" in x]), [["speaker", true, false]]);
  assert.ok(me.body.types.includes("speaker"));
  assert.doesNotMatch(JSON.stringify(me.body.tickets), RETIRED);

  // Door check-in (staff): "Speaker Pass".
  const staff = await User.create({ name: "Sid Scanner", email: "sid.scanner@example.com", role: "admin", staffRole: "staff" });
  const scan = await call("POST", "/api/checkin/scan", { token: tokenFor(staff), body: { ticketId: "TECHFEST:kai000000001" } });
  assert.deepEqual([scan.status, scan.body.status, scan.body.ticketType, scan.body.passName, scan.body.speaker], [200, "success", "speaker", "Speaker Pass", true]);
  const { passContent } = await import("../services/walletPass.js");
  const pass = passContent({ ticketId: "kai000000001", tier: "speaker", name: "Kai Speaker" });
  assert.equal(pass.secondary.find((f) => f.key === "pass").value, "Speaker Pass");
  assert.doesNotMatch(JSON.stringify(pass), RETIRED);
});

/* Pass upgrades (Oct 19 2026, the organiser: "Don't offer upgrades to Apex for anyone who is marked as speakers.
   In fact, don't offer upgrades at all."): off unless staff turn on flag.upgrades; speakers never. */
async function setUpgrades(on) {
  await M.AppContent.updateOne({ key: "flag.upgrades" }, { $set: { value: on, updatedBy: "test" } }, { upsert: true });
  (await import("../services/liveSwitches.js")).forgetSwitches();
}
const soldCounts = async () => Object.fromEntries((await M.TicketInventory.find({}).lean()).map((x) => [x.tier, x.sold]));
async function paidWebhook(id, user, ticketId, email) {
  // Stripe says it's paid (a signed test event, built here; nothing reaches Stripe).
  const { default: Stripe } = await import("stripe");
  const payload = JSON.stringify({ id: `evt_${id}`, type: "checkout.session.completed", data: { object: {
    id, customer_details: { email, name: user.name },
    metadata: { type: "upgrade", tier: "apex", userId: String(user._id), upgradeFrom: ticketId, fromTier: "power" },
  } } });
  const header = new Stripe("sk_test_dummy").webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  return realFetch(`${base}/api/webhook/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload });
}
const OFF = { code: "upgrades_off", error: "Pass upgrades aren't available." };
const SPEAKER = { code: "speaker_pass", error: "Speakers' passes can't be upgraded." };

test("pass upgrades are off by default: the quote and the upgrade checkout refuse with upgrades_off", { skip }, async () => {
  const { User, TicketInventory } = M;
  await TicketInventory.create([{ tier: "power", total: 10, sold: 2, price: 1099 }, { tier: "apex", total: 10, sold: 1, price: 1599 }]);
  const pat = await User.create({ name: "Pat Power", email: "pat.power@example.com", tickets: [{ ticketId: "pat000000001", type: "power", stripeSessionId: "cs_pat" }] });
  // No switch saved at all = off, signed in or not.
  for (const token of [tokenFor(pat), undefined]) {
    const q = await call("GET", "/api/payments/upgrade-quote?ticketId=pat000000001&tier=apex", { token });
    assert.deepEqual([q.status, q.body], [403, OFF]);
  }
  const c = await call("POST", "/api/payments/create-checkout", { token: tokenFor(pat), body: { tier: "apex", upgradeFrom: "pat000000001", client: "ios" } });
  assert.deepEqual([c.status, c.body], [403, OFF]);
  // Saved as off: the same.
  await setUpgrades(false);
  const q = await call("GET", "/api/payments/upgrade-quote?ticketId=pat000000001&tier=apex", { token: tokenFor(pat) });
  assert.deepEqual([q.status, q.body], [403, OFF]);
  // The public app content says so (the website and the apps hide every offer).
  const { CONTENT_KEYS } = await import("../services/adminHelpers.js");
  assert.equal(CONTENT_KEYS["flag.upgrades"], false);
  assert.deepEqual(await soldCounts(), { power: 2, apex: 1 });
});

test("switch on: a Power Pass upgrades to Apex at the price difference (quote, checkout past the gate, paid webhook)", { skip }, async () => {
  const { User } = M;
  await setUpgrades(true);
  const pat = await User.findOne({ email: "pat.power@example.com" });
  const q = await call("GET", "/api/payments/upgrade-quote?ticketId=pat000000001&tier=apex", { token: tokenFor(pat) });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.deepEqual([q.body.fromTier, q.body.toTier, q.body.difference], ["power", "apex", 500]);
  // The checkout gets past every check and reaches Stripe (no key in tests, so it stops there; never a 403).
  const c = await call("POST", "/api/payments/create-checkout", { token: tokenFor(pat), body: { tier: "apex", upgradeFrom: "pat000000001", client: "ios" } });
  assert.equal(c.status, 500, JSON.stringify(c.body));
  assert.match(c.body.error, /STRIPE_SECRET_KEY/);
  const r = await paidWebhook("cs_up_pat", pat, "pat000000001", "pat.power@example.com");
  assert.equal(r.status, 200);
  const t = (await User.findById(pat._id).lean()).tickets[0];
  assert.deepEqual([t.type, t.upgradedFrom], ["apex", "power"]);
  assert.deepEqual(await soldCounts(), { power: 1, apex: 2 });
  await setUpgrades(false);
});

test("Speaker Passes and speakers (tier speaker, promo SPEAKER or speaker type) are never upgraded, even with the switch on; an upgrade already paid still goes through", { skip }, async () => {
  const { User } = M;
  const lee = await User.findOne({ email: "lee.speaker@example.com" });   // a Speaker Pass on his account
  // A bought Power Pass whose holder staff made a speaker (person type).
  const sky = await User.create({ name: "Sky Speaker", email: "sky.speaker@example.com", types: ["speaker"],
    tickets: [{ ticketId: "sky000000001", type: "power", stripeSessionId: "cs_sky" }] });
  // A Speaker Pass whose holder's automatic speaker type staff switched off: the tier alone says so.
  const ula = await User.create({ name: "Ula Tier", email: "ula.tier@example.com", typesOff: ["speaker"],
    tickets: [{ ticketId: "ula000000001", type: "speaker" }] });
  const { isSpeakersPass } = await import("../routes/payments.js");
  assert.equal(isSpeakersPass(ula, ula.tickets[0]), true);
  assert.equal(isSpeakersPass({ types: [] }, { type: "power", promoCode: "SPEAKER" }), true);   // Admin › Speaker passes
  assert.equal(isSpeakersPass({ types: ["speaker"] }, { type: "connect" }), true);
  assert.equal(isSpeakersPass({ types: [] }, { type: "power" }), false);
  await setUpgrades(true);
  for (const [u, id] of [[lee, "lee000000001"], [sky, "sky000000001"], [ula, "ula000000001"]]) {
    const q = await call("GET", `/api/payments/upgrade-quote?ticketId=${id}&tier=apex`, { token: tokenFor(u) });
    assert.deepEqual([q.status, q.body], [403, SPEAKER]);
    const c = await call("POST", "/api/payments/create-checkout", { token: tokenFor(u), body: { tier: "apex", upgradeFrom: id, client: "android" } });
    assert.deepEqual([c.status, c.body], [403, SPEAKER]);
  }
  // Off: the switch answers first.
  await setUpgrades(false);
  const off = await call("GET", "/api/payments/upgrade-quote?ticketId=lee000000001&tier=apex", { token: tokenFor(lee) });
  assert.deepEqual([off.status, off.body], [403, OFF]);

  // An upgrade paid before the change: the webhook finishes it as before. The ticket becomes Apex; nothing is
  // given back to the inventory (the Speaker Pass never took a seat).
  const before = await soldCounts();
  const r = await paidWebhook("cs_up_lee", lee, "lee000000001", "lee.speaker@example.com");
  assert.equal(r.status, 200);
  const t = (await User.findById(lee._id).lean()).tickets[0];
  assert.deepEqual([t.type, t.upgradedFrom], ["apex", "speaker"]);
  const after = await soldCounts();
  assert.deepEqual([after.power, after.apex], [before.power, before.apex + 1]);
  // The purchase email went to the stub only, says Apex Pass and offers no upgrade.
  const mail = sent.find((m) => (m.to || []).includes?.("lee.speaker@example.com") || m.to === "lee.speaker@example.com");
  assert.ok(mail, "upgrade email built");
  assert.match(mail.subject, /Apex Pass/);
  assert.doesNotMatch(`${mail.subject}${mail.html}${mail.text}`, RETIRED);
  assert.doesNotMatch(`${mail.subject}${mail.html}${mail.text}`, /upgrade/i);
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

test("edit: person types (account: App › People rules); a pass-only person's types need an account", { skip }, async () => {
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
  // A pass-only person: their types need an account (Speaker comes with a Speaker Pass, Exhibitor is its switch).
  const kaiId = await idOf("kai000000001");
  const kai = await call("PATCH", `/api/console/people/${kaiId}`, { token: staffTok, body: { types: ["vendor"] } });
  assert.deepEqual([kai.status, kai.body.field], [409, "types"]);
  assert.ok((await call("GET", `/api/console/people/${kaiId}`, { token: staffTok })).body.person.types.includes("speaker"));
  assert.equal((await Attendee.findOne({ ticketId: "kai000000001" }).lean()).exhibitor, undefined);
  const ex = await call("PATCH", `/api/console/people/${kaiId}`, { token: staffTok, body: { exhibitor: true } });
  assert.equal(ex.status, 200, JSON.stringify(ex.body));
  assert.equal((await Attendee.findOne({ ticketId: "kai000000001" }).lean()).exhibitor, true);
  await call("PATCH", `/api/console/people/${kaiId}`, { token: staffTok, body: { exhibitor: false } });
});

test("pass changes: the four or the Speaker Pass (management, inventory like an upgrade, RSVP follows), manual value outside Stripe", { skip }, async () => {
  await staffAccounts();
  const { User, Attendee, Rsvp, TicketInventory, AdminAudit } = M;
  await TicketInventory.create([{ tier: "connect", total: 10, sold: 5, price: 849 }, { tier: "influence", total: 10, sold: 3, price: 949 }]);
  const cy = await User.create({ name: "Cy Change", email: "cy.change@example.com",
    tickets: [{ ticketId: "cyy000000001", type: "connect", promoCode: "COMP" }, { ticketId: "cyy000000002", type: "power", stripeSessionId: "cs_cy" }] });
  await Rsvp.create({ key: "t:cyy000000001", firstName: "Cy", lastName: "Change", name: "Cy Change", nameKey: "cy change", ticketId: "CYY000000001",
    ticketVerified: true, kind: "ticket", tier: "connect", tierVerified: true, days: ["day1"], options: ["sessions_d1"] });
  const id = await idOf("cy.change");
  // Staff can't; only the four and the Speaker Pass.
  assert.equal((await call("PATCH", `/api/console/people/${id}/passes/cyy000000001`, { token: staffTok, body: { tier: "influence" } })).status, 403);
  assert.equal((await call("PATCH", `/api/console/people/${id}/passes/cyy000000001`, { token: mgmtTok, body: { tier: "gold" } })).status, 400);
  const up = await call("PATCH", `/api/console/people/${id}/passes/cyy000000001`, { token: mgmtTok, body: { tier: "influence" } });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal((await User.findById(cy._id).lean()).tickets[0].type, "influence");
  assert.equal((await Rsvp.findOne({ key: "t:cyy000000001" }).lean()).tier, "influence");
  const inv = Object.fromEntries((await TicketInventory.find({}).lean()).map((x) => [x.tier, x.sold]));
  assert.deepEqual([inv.connect, inv.influence], [4, 4]);
  assert.match((await AdminAudit.findOne({ action: "pass_tier" }).lean()).detail, /Connect Pass → Influence Pass \(no charge; inventory connect −1, influence \+1\)/);
  // To the internal Speaker Pass: no inventory row, so only Influence gives its seat back; Cy is a speaker now,
  // with the breakfasts. And back again.
  const sp = await call("PATCH", `/api/console/people/${id}/passes/cyy000000001`, { token: mgmtTok, body: { tier: "speaker" } });
  assert.equal(sp.status, 200, JSON.stringify(sp.body));
  const spPass = sp.body.person.passes.find((x) => x.ticketId === "cyy000000001");
  assert.deepEqual([spPass.label, spPass.tier, spPass.cxoBreakfast, sp.body.person.types.includes("speaker")], ["Speaker Pass", "speaker", true, true]);
  assert.equal((await User.findById(cy._id).lean()).tickets[0].type, "speaker");
  assert.equal((await Rsvp.findOne({ key: "t:cyy000000001" }).lean()).tier, "speaker");
  let inv2 = Object.fromEntries((await TicketInventory.find({}).lean()).map((x) => [x.tier, x.sold]));
  assert.deepEqual([inv2.connect, inv2.influence], [4, 3]);
  assert.match((await AdminAudit.findOne({ action: "pass_tier" }).sort({ at: -1 }).lean()).detail, /Influence Pass → Speaker Pass \(no charge; inventory influence −1\)/);
  await call("PATCH", `/api/console/people/${id}/passes/cyy000000001`, { token: mgmtTok, body: { tier: "influence" } });
  inv2 = Object.fromEntries((await TicketInventory.find({}).lean()).map((x) => [x.tier, x.sold]));
  assert.deepEqual([inv2.connect, inv2.influence], [4, 4]);

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
