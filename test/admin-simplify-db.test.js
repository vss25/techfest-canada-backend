/* Admin simplification (Oct 19 2026) through the real routes, against a real (throwaway) MongoDB:
     - staff may give a single pass (create one issued pass, then send it), audited with their name;
       exhibitor passes, editing and every send to many people stay management only;
     - staff may send ONE RSVP reminder and ONE "I'm attending" LinkedIn nudge from a profile, with the
       cool-downs; management may nudge a filtered view (confirm, count, skip list);
     - the selling switches (ticket sales, upgrades, the guest offer) and Broadcast are management only,
       and nobody can switch the guest offer on;
     - People shows the I'm attending status (column, filter) and Ticket records open a profile by ticket ID.
   Starts a local mongod in a temp folder on a free port and stops it after; skipped when the binary isn't
   there (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Nothing leaves the
   machine: Resend and Sanity are answered by a stubbed fetch (nothing is delivered), no Stripe key, no push
   service. Fictional people, example.com. */
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

/** Every email the routes tried to send (Resend is stubbed: nothing is delivered). */
const outbox = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.startsWith("https://api.resend.com/")) {
    const body = JSON.parse(opts?.body || "{}");
    outbox.push({ to: [].concat(body.to || []), subject: body.subject || "", tags: body.tags || [] });
    return new Response(JSON.stringify({ id: `stub_${outbox.length}` }), { status: 200, headers: { "content-type": "application/json" } });
  }
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
let mia, sam, ana, ben, ed;
const d = (n) => new Date(Date.now() - n * 864e5);

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-simplify-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_admin_simplify_test`, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  ({ default: jwt } = await import("jsonwebtoken"));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.Attendee = await imp("../models/Attendee.js");
  M.Rsvp = await imp("../models/Rsvp.js");
  M.CampaignSend = await imp("../models/CampaignSend.js");
  M.Subscription = await imp("../models/Subscription.js");
  Object.assign(M, await import("../models/Admin.js"));
  const { default: express } = await import("express");
  const { issuedPassRouter } = await import("../routes/issuedPasses.js");
  const app = express();
  app.use(express.json());
  app.use("/api/console/attending-campaign", (await import("../routes/attendingCampaign.js")).default);
  app.use("/api/console/rsvp-reminders", (await import("../routes/rsvpReminders.js")).default);
  app.use("/api/console/issued-passes", issuedPassRouter("issued"));
  app.use("/api/console/exhibitor-passes", issuedPassRouter("exhibitor"));
  app.use("/api/console/people", (await import("../routes/people.js")).default);
  app.use("/api/console", (await import("../routes/console.js")).default);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  mia = await M.User.create({ name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management" });
  sam = await M.User.create({ name: "Sam Staff", email: "sam.staff@example.com", role: "admin", staffRole: "staff" });
  ana = await M.User.create({ name: "Ana Able", email: "ana.able@example.com", organization: "Example Bank", jobTitle: "Head of Digital",
    tickets: [{ ticketId: "con400000001", type: "connect", purchaseDate: d(20) }] });
  ben = await M.User.create({ name: "Ben Bee", email: "ben.bee@example.com", tickets: [{ ticketId: "inf400000001", type: "influence", purchaseDate: d(19) }] });
  ed = await M.User.create({ name: "Ed Suspended", email: "ed.suspended@example.com", banned: true, tickets: [{ ticketId: "pow400000001", type: "power", purchaseDate: d(18) }] });
  await M.User.create({ name: "Nora Nopass", email: "nora.nopass@example.com" });
  await M.Attendee.create([
    { name: "Flo Unsub", email: "flo.unsub@example.com", ticketId: "pow400000002", ticketType: "power", purchaseDate: d(17), details: { firstName: "Flo", lastName: "Unsub" } },
    { name: "Gus Recent", email: "gus.recent@example.com", ticketId: "apx400000001", ticketType: "apex", purchaseDate: d(16), details: { firstName: "Gus", lastName: "Recent" } },
    { name: "Hal Old", email: "hal.old@example.com", ticketId: "con400000002", ticketType: "connect", purchaseDate: d(15), details: { firstName: "Hal", lastName: "Old" } },
  ]);
  await M.Subscription.create({ email: "flo.unsub@example.com", subscribed: false });
  await M.CampaignSend.create([
    { campaign: "attending-2026", email: "gus.recent@example.com", status: "sent", sentAt: d(1), attempts: 1 },
    { campaign: "attending-2026", email: "hal.old@example.com", status: "sent", sentAt: d(5), attempts: 1 },
  ]);
  // Ben RSVP'd: no reminder for him.
  await M.Rsvp.create({
    key: "t:inf400000001", firstName: "Ben", lastName: "Bee", name: "Ben Bee", nameKey: "ben bee", ticketId: "INF400000001",
    ticketVerified: true, kind: "ticket", tier: "influence", tierVerified: true, source: "attendee", attendeeSubmittedAt: d(3),
    days: ["day1"], options: [], dietary: ["none"], submissions: 1,
  });
  // The app content as it is live: the guest offer switched off on Oct 18, its settings as they were.
  await M.AppContent.create([
    { key: "flag.guestOffer", value: false, updatedBy: "Mia Manager" },
    { key: "offer.guest_code", value: "APP50", updatedBy: "Mia Manager" },
    { key: "site.ticket_sales_open", value: true, updatedBy: "Mia Manager" },
  ]);
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const tokenFor = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function call(method, url, { as = mia, body } = {}) {
  const r = await realFetch(base + url, {
    method, headers: { "content-type": "application/json", authorization: `Bearer ${tokenFor(as)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const audits = async (action) => M.AdminAudit.find({ action }).sort({ at: 1, _id: 1 }).lean();
const idOf = async (q) => (await call("GET", `/api/console/people?q=${encodeURIComponent(q)}&refresh=1`)).body.rows[0]?.id;
const stored = async (key) => (await M.AppContent.findOne({ key }).lean())?.value;
const waitFor = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); }
  return false;
};

test("staff give a single pass: create one, then send it; audited with their name; editing and exhibitor passes stay management", { skip }, async () => {
  const list = await call("GET", "/api/console/issued-passes", { as: sam });
  assert.equal(list.body.canIssue, true);
  assert.equal((await call("GET", "/api/console/exhibitor-passes", { as: sam })).body.canIssue, false);
  const made = await call("POST", "/api/console/issued-passes", { as: sam, body: { name: "Gia Guest", email: "gia.guest@example.com", tier: "connect" } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.row.id;
  const before = outbox.length;
  const sent = await call("POST", `/api/console/issued-passes/${id}/send`, { as: sam, body: {} });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(outbox.length, before + 1);
  assert.deepEqual(outbox.at(-1).to, ["gia.guest@example.com"]);
  const [create] = await audits("issued_pass_create");
  const [send] = await audits("issued_pass_send");
  assert.equal(create.adminName, "Sam Staff");
  assert.match(create.detail, /^connect pass for Gia Guest <gia\.guest@example\.com> \(by staff\)$/);
  assert.equal(send.adminName, "Sam Staff");
  assert.match(send.detail, /^Gia Guest → gia\.guest@example\.com.* \(by staff\)$/);
  // Still management only: editing, deleting, the template, exhibitor passes.
  assert.equal((await call("PATCH", `/api/console/issued-passes/${id}`, { as: sam, body: { tier: "apex" } })).status, 403);
  assert.equal((await call("DELETE", `/api/console/issued-passes/${id}`, { as: sam })).status, 403);
  assert.equal((await call("PUT", "/api/console/issued-passes/email", { as: sam, body: {} })).status, 403);
  assert.equal((await call("POST", "/api/console/exhibitor-passes", { as: sam, body: { name: "Exa Hibitor", email: "exa@example.com", tier: "connect" } })).status, 403);
  // Management's own sends aren't marked.
  const mgmt = await call("POST", "/api/console/issued-passes", { body: { name: "Max Manager Guest", email: "max.guest@example.com", tier: "power" } });
  assert.equal(mgmt.status, 201);
  assert.doesNotMatch((await audits("issued_pass_create")).at(-1).detail, /by staff/);
});

test("staff can't send to many people: reminders, nudges, the campaign and speaker passes refuse them", { skip }, async () => {
  const n = outbox.length;
  for (const [url, body] of [
    ["/api/console/people/reminder", { query: {}, confirm: "SEND", expected: 1 }],
    ["/api/console/people/nudge", { query: {}, confirm: "SEND", expected: 1 }],
    ["/api/console/rsvp-reminders/send-all", { confirm: "SEND" }],
    ["/api/console/rsvp-reminders/send-one", { email: "ana.able@example.com" }],
    ["/api/console/attending-campaign/send-all", { confirm: "SEND" }],
    ["/api/console/attending-campaign/send-one", { email: "ana.able@example.com" }],
    ["/api/console/speaker-passes/send-all", { confirm: "SEND" }],
    ["/api/console/broadcast", { body: "Doors open at 8", banner: true }],
  ]) {
    const r = await call("POST", url, { as: sam, body });
    assert.deepEqual([r.status, r.body.error], [403, "Management only"], url);
  }
  assert.equal(outbox.length, n);
  const { SocialPost } = await import("../models/Social.js");
  assert.equal(await SocialPost.countDocuments({ kind: "announcement" }), 0);
  // Management can still broadcast.
  assert.equal((await call("POST", "/api/console/broadcast", { body: { body: "Doors open at 8" } })).status, 201);
});

test("selling switches and the guest offer: management only; nobody switches the guest offer on; staff keep the app switches", { skip }, async () => {
  const rows = (await call("GET", "/api/console/app-content", { as: sam })).body;
  const row = (k) => rows.find((r) => r.key === k);
  assert.deepEqual([row("flag.guestOffer").value, row("flag.guestOffer").managementOnly, row("flag.guestOffer").locked], [false, true, true]);
  assert.deepEqual([row("offer.guest_code").value, row("offer.guest_discount").value], ["APP50", "50"]);
  assert.deepEqual([row("site.ticket_sales_open").managementOnly, row("flag.upgrades").managementOnly, row("flag.polls").managementOnly], [true, true, false]);

  for (const [key, value] of [["site.ticket_sales_open", false], ["site.ticket_sales_message", "Paused"], ["flag.upgrades", true], ["offer.guest_code", "FREE"], ["flag.guestOffer", false]]) {
    const r = await call("PUT", `/api/console/app-content/${key}`, { as: sam, body: { value } });
    assert.deepEqual([r.status, r.body.code], [403, "management_only"], key);
  }
  assert.equal(await stored("site.ticket_sales_open"), true);
  assert.equal(await stored("offer.guest_code"), "APP50");
  assert.equal(await stored("flag.upgrades"), undefined);
  // The guest offer can't be switched on, by management either.
  for (const as of [mia, sam]) {
    const r = await call("PUT", "/api/console/app-content/flag.guestOffer", { as, body: { value: true } });
    assert.deepEqual([r.status, r.body.code], [403, "promotions_off"]);
  }
  assert.equal(await stored("flag.guestOffer"), false);
  assert.ok((await audits("edit_app_text_refused")).some((a) => a.adminName === "Mia Manager" && /^promotions_off/.test(a.detail)));
  // Management may still change the selling switches (and leave the offer off).
  assert.equal((await call("PUT", "/api/console/app-content/site.ticket_sales_open", { body: { value: true } })).status, 200);
  assert.equal((await call("PUT", "/api/console/app-content/flag.guestOffer", { body: { value: false } })).status, 200);
  // Staff keep the app switches (polls, Q&A, posts) and the texts.
  for (const [key, value] of [["flag.polls", false], ["flag.qa", true], ["flag.allow_posts", true], ["home.announcement", "Doors open at 8"]]) {
    assert.equal((await call("PUT", `/api/console/app-content/${key}`, { as: sam, body: { value } })).status, 200, key);
  }
  assert.equal(await stored("flag.polls"), false);
});

test("staff send one RSVP reminder from a profile; the 20-hour cool-down and the skip rules apply", { skip }, async () => {
  const anaId = await idOf("Ana Able");
  const prof = await call("GET", `/api/console/people/${anaId}`, { as: sam });
  assert.deepEqual([prof.body.outreach.rsvpReminder.canSend, prof.body.outreach.rsvpReminder.cooldownHours], [true, 20]);
  const n = outbox.length;
  const r = await call("POST", `/api/console/people/${anaId}/reminder`, { as: sam });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.email, "ana.able@example.com");
  assert.equal(outbox.length, n + 1);
  assert.deepEqual(outbox.at(-1).tags, [{ name: "campaign", value: "rsvp-reminder-2026" }]);
  const again = await call("POST", `/api/console/people/${anaId}/reminder`, { as: sam });
  assert.deepEqual([again.status, again.body.code, again.body.error], [409, "reminded", "Reminded in the last 20 hours"]);
  assert.equal(outbox.length, n + 1);
  const [a] = await audits("people_rsvp_reminder_one");
  assert.deepEqual([a.adminName, a.detail], ["Sam Staff", "Ana Able <ana.able@example.com> (by staff)"]);
  // Ben has RSVP'd; Ed is suspended; Nora has no pass.
  const benR = await call("POST", `/api/console/people/${await idOf("Ben Bee")}/reminder`, { as: sam });
  assert.deepEqual([benR.status, benR.body.code], [409, "confirmed"]);
  assert.equal((await call("POST", `/api/console/people/${await idOf("Ed Suspended")}/reminder`, { as: sam })).body.code, "banned");
  assert.equal((await call("POST", `/api/console/people/${await idOf("Nora Nopass")}/reminder`, { as: sam })).body.code, "noPass");
  const after = await call("GET", `/api/console/people/${anaId}`, { as: sam });
  assert.deepEqual([after.body.outreach.rsvpReminder.canSend, after.body.outreach.rsvpReminder.reason], [false, "reminded"]);
  assert.equal(after.body.person.rsvpEmail.sent, true);
});

test("LinkedIn nudge: one person (staff), the status in People, the cool-down; a filtered view (management) with the skip list", { skip }, async () => {
  const anaId = await idOf("Ana Able");
  let row = (await call("GET", "/api/console/people?q=Ana%20Able&refresh=1", { as: sam })).body.rows[0];
  assert.deepEqual(row.attending, { status: "none", label: "Not sent", sentAt: null, nudges: 0 });
  const prof = await call("GET", `/api/console/people/${anaId}`, { as: sam });
  assert.deepEqual([prof.body.outreach.attending.canSend, prof.body.outreach.attending.cooldownDays, prof.body.outreach.attending.tracking],
    [true, 3, { opens: true, clicks: true, posts: true }]);

  const n = outbox.length;
  const r = await call("POST", `/api/console/people/${anaId}/nudge`, { as: sam });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(outbox.length, n + 1);
  assert.deepEqual(outbox.at(-1).to, ["ana.able@example.com"]);
  assert.match(outbox.at(-1).subject, /^Ana, show the world you're attending TTFC 2026$/);
  assert.deepEqual(outbox.at(-1).tags, [{ name: "campaign", value: "attending-2026" }]);
  const again = await call("POST", `/api/console/people/${anaId}/nudge`, { as: sam });
  assert.deepEqual([again.status, again.body.code], [409, "recent"]);
  const [a] = await audits("people_attending_nudge_one");
  assert.deepEqual([a.adminName, a.detail], ["Sam Staff", "Ana Able <ana.able@example.com> (by staff)"]);
  const sendRow = await M.CampaignSend.findOne({ campaign: "attending-2026", email: "ana.able@example.com" }).lean();
  assert.deepEqual([sendRow.status, sendRow.sends], ["sent", 1]);
  // People: the column and the filter.
  row = (await call("GET", "/api/console/people?q=Ana%20Able&refresh=1", { as: sam })).body.rows[0];
  assert.deepEqual([row.attending.status, row.attending.nudges], ["sent", 1]);
  const yes = (await call("GET", "/api/console/people?attending=yes&refresh=1", { as: sam })).body;
  assert.deepEqual(yes.rows.map((x) => x.name).sort(), ["Ana Able", "Gus Recent", "Hal Old"]);
  assert.equal(yes.counts.attendingSent, 3);
  // The campaign page now counts her as sent, so its "send to everyone" skips her.
  const rec = (await call("GET", "/api/console/attending-campaign/recipients")).body.recipients.find((x) => x.email === "ana.able@example.com");
  assert.equal(rec.status, "sent");
  // Flo unsubscribed: never nudged, by staff or management.
  assert.equal((await call("POST", `/api/console/people/${await idOf("Flo Unsub")}/nudge`, { as: sam })).body.code, "unsubscribed");

  // Management: the whole directory. Ben (no nudge yet) and Hal (emailed 5 days ago) are due; everyone else is listed with why.
  const plan = (await call("GET", "/api/console/people/nudge?refresh=1")).body;
  assert.deepEqual(plan.targets.map((t) => t.email).sort(), ["ben.bee@example.com", "gia.guest@example.com", "hal.old@example.com", "max.guest@example.com"]);
  const why = Object.fromEntries(plan.skipped.map((s) => [s.name, s.reason]));
  assert.deepEqual([why["Ana Able"], why["Gus Recent"], why["Flo Unsub"], why["Ed Suspended"], why["Nora Nopass"]], ["recent", "recent", "unsubscribed", "banned", "noPass"]);
  assert.equal(plan.skipLabels.recent, "Emailed in the last 3 days");
  assert.equal(plan.cooldownDays, 3);
  // A filter: Connect passes only (Ana, Hal, Gia).
  const connect = (await call("GET", "/api/console/people/nudge?pass=connect")).body;
  assert.deepEqual(connect.targets.map((t) => t.email).sort(), ["gia.guest@example.com", "hal.old@example.com"]);
  const stale = await call("POST", "/api/console/people/nudge", { body: { query: { pass: "connect" }, confirm: "SEND", expected: 5 } });
  assert.deepEqual([stale.status, stale.body.code], [409, "changed"]);
  const before = outbox.length;
  const go = await call("POST", "/api/console/people/nudge", { body: { query: { pass: "connect" }, confirm: "SEND", expected: 2 } });
  assert.equal(go.status, 202, JSON.stringify(go.body));
  // The run finishes, then writes its "done" row to the audit log.
  assert.ok(await waitFor(async () => !(await call("GET", "/api/console/people/nudge/job")).body.job.running && (await audits("people_attending_nudge_done")).length > 0));
  const job = (await call("GET", "/api/console/people/nudge/job")).body.job;
  assert.deepEqual([job.sent, job.failed, job.skipped], [2, 0, 0]);
  assert.deepEqual(outbox.slice(before).map((m) => m.to[0]).sort(), ["gia.guest@example.com", "hal.old@example.com"]);
  const hal = await M.CampaignSend.findOne({ campaign: "attending-2026", email: "hal.old@example.com" }).lean();
  assert.equal(hal.sends, 1);
  assert.ok(hal.sentAt > d(0.01));
  assert.match((await audits("people_attending_nudge_start"))[0].detail, /^2 emails \(2 people\) for pass=connect; left out 1$/);
  assert.equal((await audits("people_attending_nudge_done"))[0].detail, "sent 2, failed 0, skipped 0");
});

test("Ticket records open the holder's profile by ticket ID", { skip }, async () => {
  const r = await call("GET", "/api/console/people/t-POW400000002", { as: sam });
  assert.equal(r.status, 200);
  assert.equal(r.body.person.name, "Flo Unsub");
  assert.equal(r.body.canonicalId, await idOf("Flo Unsub"));
  const acc = await call("GET", "/api/console/people/t-con400000001", { as: sam });
  assert.deepEqual([acc.body.person.name, acc.body.canonicalId], ["Ana Able", `u-${ana._id}`]);
  assert.equal((await call("GET", "/api/console/people/t-nope00000000", { as: sam })).status, 404);
});
