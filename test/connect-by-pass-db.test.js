/* Connect by pass (C-PASS, Oct 24 2026) through POST /api/social/connections/by-pass, against a real (throwaway)
   MongoDB. Scanning someone's ENTRY QR connects you with the pass holder exactly like their connect QR: accepted at
   once (kind inPerson, via "pass"), the scanner's share applied, the holder's connect-QR share (else their defaults)
   applied, and the holder told by push and in their in-app Notifications (kind "conn", unread; left out while the
   scanner is blocked or hidden). Who the holder is: the account holding the ticket, the account that claimed
   the pass, or the account with its email AND an agreeing name; a buyer's email on a colleague's pass is never the
   colleague, and the buyer never stands in for the colleague. Passes hidden by staff, sync duplicates and refunded
   ones, hidden people, banned people and blocks answer like an unknown pass; no account / not on the app 409; your
   own pass 400; no shareContact right 403. No cap on scans (the organiser, Oct 24 2026: "Don't keep a cap on scan").
   Starts a local mongod in a temp folder on a free port and stops it after; skipped when the binary isn't there
   (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Nothing leaves the machine:
   Sanity is answered by a stubbed fetch, no Stripe key (the refund case fills the Stripe cache from a fake client),
   no push service configured (pushes are watched with observePushes). Fictional people, example.com. */
import { test, before, after, beforeEach } from "node:test";
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
delete process.env.FCM_SERVICE_ACCOUNT;
delete process.env.DEEPCLEER_ACCESS_KEY;

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.includes(".sanity.io/")) return new Response(JSON.stringify({ result: [] }), { status: 200, headers: { "content-type": "application/json" } });
  throw new Error(`blocked in the test: ${url}`);
};

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await pause(50);
  }
}
const portOpen = (port) => new Promise((ok) => { const c = net.connect(port, "127.0.0.1", () => { c.end(); ok(true); }); c.on("error", () => ok(false)); });

let mongod = null;
let dbDir = "";
let server = null;
let base = "";
let M = {};
let jwt;
let mongoose;
let forgetHidden;
const U = {};
const pushes = [];

const onApp = { appOnboarded: true, lastActiveAt: new Date("2026-10-20T12:00:00Z") };
const ticket = (ticketId, type = "connect", extra = {}) => ({ ticketId, type, purchaseDate: new Date("2026-10-01"), ...extra });
const items = (prefix, email, phone) => [
  { id: `${prefix}-email`, kind: "email", label: "", value: email, shareByDefault: true },
  { id: `${prefix}-phone`, kind: "phone", label: "", value: phone, shareByDefault: false },
];

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-by-pass-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await pause(250);
  await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_by_pass_test`);
  ({ default: jwt } = await import("jsonwebtoken"));
  ({ forgetHidden } = await import("../services/appHide.js"));
  const { observePushes } = await import("../services/push.js");
  observePushes((to, note) => pushes.push({ to, note }));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.Attendee = await imp("../models/Attendee.js");
  M.AppNotification = await imp("../models/AppNotification.js");
  Object.assign(M, await import("../models/Admin.js"), await import("../models/Social.js"));
  // The unique (from, to) index, as in production, before two scans race to make the same connection.
  await M.SocialConnection.init();
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/social", await imp("../routes/social.js"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const mk = (key, doc) => M.User.create(doc).then((u) => { U[key] = u; });
  await Promise.all([
    mk("sid", { name: "Sid Scanner", email: "sid.scanner@example.com", jobTitle: "CTO", organization: "Sidco", tickets: [ticket("con500000001")],
      contactItems: items("sid", "sid.work@example.com", "+1 416 555 0101"), contactCardSavedAt: new Date(), ...onApp }),
    mk("tia", { name: "Tia Tester", email: "tia.tester@example.com", tickets: [ticket("con500000020")], ...onApp }),
    // Ada holds her pass on her account; her connect QR sheet shares her phone only.
    mk("ada", { name: "Ada Account", email: "ada.account@example.com", tickets: [ticket("acc500000002", "power")],
      contactItems: items("ada", "ada.work@example.com", "+1 416 555 0102"), contactCardSavedAt: new Date(), contactQrShare: ["ada-phone"], ...onApp }),
    // Cleo claimed a guest pass bought under her work email.
    mk("cleo", { name: "Cleo Claimed", email: "cleo.claimed@example.com", ...onApp }),
    // Pia's pass is under her email with her name; she never claimed it.
    mk("pia", { name: "Pia Passonly", email: "pia.passonly@example.com", ...onApp }),
    // Bob bought passes for colleagues: one guest pass under his email, one on his own account with Cara's name.
    mk("bob", { name: "Bob Buyer", email: "bob.buyer@example.com", tickets: [ticket("bob500000021"), ticket("col500000006", "influence", { details: { firstName: "Cara", lastName: "Colleague" } })], ...onApp }),
    // Dora has her own account and claimed the pass Bob bought for her under his email.
    mk("dora", { name: "Dora Delegate", email: "dora.delegate@example.com", ...onApp }),
    mk("hal", { name: "Hal Hiddenpass", email: "hal.hiddenpass@example.com", tickets: [ticket("hid500000009", "connect", { hiddenByStaff: true })], ...onApp }),
    mk("ray", { name: "Ray Refund", email: "ray.refund@example.com", tickets: [ticket("ref500000016", "connect", { stripeSessionId: "cs_test_refunded" })], ...onApp }),
    mk("hana", { name: "Hana Hidden", email: "hana.hidden@example.com", tickets: [ticket("ahd500000011")], appHidden: { at: new Date("2026-10-22T12:00:00Z"), reason: "test" }, ...onApp }),
    mk("nora", { name: "Nora Notyet", email: "nora.notyet@example.com", tickets: [ticket("noa500000013")] }),
    mk("bea", { name: "Bea Blocker", email: "bea.blocker@example.com", tickets: [ticket("blk500000015")], ...onApp }),
    mk("ben", { name: "Ben Banned", email: "ben.banned@example.com", tickets: [ticket("ban500000017")], banned: true, ...onApp }),
    mk("vic", { name: "Vic Vendor", email: "vic.vendor@example.com", types: ["vendor"], ...onApp }),
    mk("sam", { name: "Sam Staff", email: "sam.staff@example.com", role: "admin", staffRole: "staff", ...onApp }),
    mk("ian", { name: "Ian Incoming", email: "ian.incoming@example.com", tickets: [ticket("inc500000018")], ...onApp }),
    mk("mo", { name: "Mo Upper", email: "mo.upper@example.com", tickets: [ticket("UPP500000019")], ...onApp }),
    mk("rl1", { name: "Rae Limit", email: "rae.limit@example.com", ...onApp }),
    mk("rl4", { name: "Ros Limit", email: "ros.limit@example.com", ...onApp }),
  ]);
  await M.Attendee.create([
    { name: "Cleo Claimed", email: "cleo.work@example.com", ticketId: "clm500000003", ticketType: "connect", claimedBy: U.cleo._id },
    { name: "Pia Passonly", email: "pia.passonly@example.com", ticketId: "pas500000004", ticketType: "influence" },
    // A pass Bob bought for Cara under his own email: Cara has no account. Never Bob.
    { name: "Cara Colleague", email: "bob.buyer@example.com", ticketId: "col500000005", ticketType: "connect" },
    { name: "Dora Delegate", email: "bob.buyer@example.com", ticketId: "col500000007", ticketType: "connect", claimedBy: U.dora._id },
    { name: "Hal Hiddenpass", email: "hal.hiddenpass@example.com", ticketId: "hid500000008", ticketType: "connect", hiddenByStaff: true },
    { name: "Pia Passonly", email: "pia.passonly@example.com", ticketId: "dup500000010", ticketType: "connect", syncDuplicate: true, hiddenByStaff: true },
    // A pass-only person staff hid before they ever signed in.
    { name: "Hugo Hidden", email: "hugo.hidden@example.com", ticketId: "ahd500000012", ticketType: "connect", appHidden: { at: new Date("2026-10-22T12:00:00Z") } },
    { name: "Gus Guest", email: "gus.guest@example.com", ticketId: "gst500000014", ticketType: "power" },
  ]);
  forgetHidden();
  // Bea blocked Sid.
  await M.Block.create({ userId: U.bea._id, blockedId: U.sid._id });
  // Vendors can't share contact details here (Admin › App rights).
  const { saveMatrix } = await import("../services/rightsStore.js");
  await saveMatrix({ vendor: { shareContact: false } }, "test");
  // The Stripe sessions this instance has read (Admin › People did): Ray's payment fully refunded.
  const { stripeSessions } = await import("../services/stripeSales.js");
  async function* gen(list) { for (const x of list) yield x; }
  await stripeSessions({
    refunds: { list: () => gen([{ status: "succeeded", payment_intent: "pi_ray", amount: 11300 }]) },
    checkout: { sessions: { list: () => gen([{ id: "cs_test_refunded", payment_status: "paid", amount_total: 11300, amount_subtotal: 10000,
      total_details: { amount_tax: 1300, amount_discount: 0 }, payment_intent: "pi_ray", metadata: { type: "ticket", tier: "connect" }, created: 1790000000 }]) } },
  }, { force: true });
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(() => { pushes.length = 0; });

const tokenFor = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function call(method, url, { as, body } = {}) {
  const r = await realFetch(base + url, {
    method, headers: { "content-type": "application/json", authorization: `Bearer ${tokenFor(as)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const scan = (as, ticketId, extra = {}) => call("POST", "/api/social/connections/by-pass", { as, body: { ticketId, ...extra } });
const idOf = (u) => String(u._id);
const between = (a, b) => M.SocialConnection.findOne({ $or: [{ fromUserId: a._id, toUserId: b._id }, { fromUserId: b._id, toUserId: a._id }] }).lean();
/** A refusal: exactly { code, error }, nothing about the holder. */
function refused(r, status, code) {
  assert.equal(r.status, status, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(r.body).sort(), ["code", "error"]);
  assert.equal(r.body.code, code);
  return r.body;
}

test("an account's own pass: connected in person at once, both sides' sharing applied, the holder told", { skip }, async () => {
  const { sid, ada } = U;
  const r = await scan(sid, "TECHFEST:acc500000002", { share: ["sid-phone"] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "accepted");
  assert.equal(r.body.kind, "inPerson");
  assert.equal(r.body.via, "pass");
  assert.equal(r.body.alreadyConnected, false);
  assert.equal(r.body.direction, "outgoing");
  assert.equal(r.body.user.id, idOf(ada));
  assert.equal(r.body.user.name, "Ada Account");
  // Ada shares what her connect QR sheet says (her phone), as with a connect QR scan.
  assert.deepEqual(r.body.sharedContact.map((x) => x.value), ["+1 416 555 0102"]);
  assert.deepEqual(r.body.myShare, ["sid-phone"]);
  const row = await between(sid, ada);
  assert.equal(row.via, "pass");
  assert.deepEqual(row.fromShare, ["sid-phone"]);
  assert.deepEqual(row.toShare, ["ada-phone"]);
  // Ada sees Sid's phone (what he ticked), and the connection.
  const mine = await call("GET", "/api/social/connections", { as: ada });
  const c = mine.body.accepted.find((x) => x.user.id === idOf(sid));
  assert.ok(c, "Ada has the connection");
  assert.equal(c.via, "pass");
  assert.deepEqual(c.sharedContact.map((x) => x.value), ["+1 416 555 0101"]);
  // The push: "<Sid> connected with you · Scanned your TTFC pass", to her Network tab.
  await waitFor(() => pushes.length);
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0].to, [idOf(ada)]);
  assert.equal(pushes[0].note.title, "Sid Scanner connected with you");
  assert.equal(pushes[0].note.body, "Scanned your TTFC pass");
  assert.equal(pushes[0].note.kind, "conn");
  assert.equal(pushes[0].note.link, "ttfc://tab/network");
  assert.equal(pushes[0].note.url, "/app/network");
  assert.equal(pushes[0].note.id, String(row._id));
  // And in her in-app Notifications: the same words, unread and counted, with who it was.
  const inbox = await call("GET", "/api/social/notifications", { as: ada });
  assert.equal(inbox.status, 200);
  assert.equal(inbox.body.unread, 1);
  assert.equal(inbox.body.notifications.length, 1);
  const n = inbox.body.notifications[0];
  assert.equal(n.kind, "conn");
  assert.equal(n.title, "Sid Scanner connected with you");
  assert.equal(n.body, "Scanned your TTFC pass");
  assert.equal(n.link, "ttfc://tab/network");
  assert.equal(n.fromUserId, idOf(sid));
  assert.equal(n.connectionId, String(row._id));
  assert.equal(n.sentByName, "Sid Scanner");
  assert.equal(n.readAt, null);
  assert.equal(typeof n.avatarUrl, "string");
  // Nobody else gets one: not the scanner, not anyone else.
  for (const u of [sid, U.tia, U.bob]) {
    const other = await call("GET", "/api/social/notifications", { as: u });
    assert.deepEqual([other.body.notifications.length, other.body.unread], [0, 0], u.name);
  }
  // Read is read.
  const read = await call("POST", "/api/social/notifications/read", { as: ada, body: { ids: [n.id] } });
  assert.equal(read.body.unread, 0);
});

test("scanning again: already connected, nothing pushed twice; every QR form finds the same pass", { skip }, async () => {
  const { sid, ada, mo, tia } = U;
  for (const form of ["TECHFEST:acc500000002", "techfest:ACC500000002", "ACC500000002", " acc5 0000 0002 ", "TECHFEST: acc500000002\n"]) {
    // The sheet offers the defaults (it can't know whose pass it is): what Sid picked for Ada stays.
    const r = await scan(sid, form, { share: ["sid-email"] });
    assert.equal(r.status, 200, `${JSON.stringify(form)} → ${JSON.stringify(r.body)}`);
    assert.equal(r.body.user.id, idOf(ada));
    assert.equal(r.body.alreadyConnected, true);
    assert.equal(r.body.via, "pass");
    assert.deepEqual(r.body.myShare, ["sid-phone"]);
  }
  await pause(200);
  assert.equal(pushes.length, 0, "no push for a connection that already existed");
  assert.equal(await M.AppNotification.countDocuments({ userId: ada._id }), 1, "nor a second notification");
  // A ticket stored in capitals (older data) is found from the lower-case QR too.
  const up = await scan(tia, "TECHFEST:upp500000019");
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.user.id, idOf(mo));
});

test("a claimed guest pass and a pass-only pass with the account's name connect to that account", { skip }, async () => {
  const { tia, cleo, pia } = U;
  const c = await scan(tia, "clm500000003");
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.user.id, idOf(cleo));
  // Cleo never picked for her connect QR: her share-by-default items (none saved: her account email).
  assert.deepEqual(c.body.sharedContact.map((x) => x.value), ["cleo.claimed@example.com"]);
  const p = await scan(tia, "TECHFEST:pas500000004");
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.user.id, idOf(pia));
});

test("a colleague's pass is never the buyer: guest pass under the buyer's email and a ticket on the buyer's account", { skip }, async () => {
  const { tia, bob, dora } = U;
  refused(await scan(tia, "col500000005"), 409, "not_on_app");
  refused(await scan(tia, "TECHFEST:col500000006"), 409, "not_on_app");
  assert.equal(await between(tia, bob), null, "nothing with Bob");
  // Dora claimed the pass Bob bought for her under his email: hers.
  const d = await scan(tia, "col500000007");
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body.user.id, idOf(dora));
  // Bob's own pass is his.
  const b = await scan(tia, "bob500000021");
  assert.equal(b.status, 200);
  assert.equal(b.body.user.id, idOf(bob));
});

test("passes that don't count answer like unknown ones: hidden by staff, sync duplicate, refunded, made up", { skip }, async () => {
  const { tia, hal, ray } = U;
  refused(await scan(tia, "hid500000008"), 404, "not_found");   // pass record hidden by staff
  refused(await scan(tia, "hid500000009"), 404, "not_found");   // account ticket hidden by staff
  refused(await scan(tia, "dup500000010"), 404, "not_found");
  refused(await scan(tia, "ref500000016"), 404, "not_found");
  const unknown = refused(await scan(tia, "TECHFEST:ffffffffffff"), 404, "not_found");
  assert.equal(unknown.error, "That isn't a TTFC pass we know.");
  refused(await scan(tia, ""), 404, "not_found");
  refused(await scan(tia, "TTFC2026|C|Ada|x|y|z|w|abc|123456"), 404, "not_found");
  assert.equal(await between(tia, hal), null);
  assert.equal(await between(tia, ray), null);
});

test("hidden from the app, banned and blocked people answer like an unknown pass; staff see hidden people", { skip }, async () => {
  const { sid, tia, hana, bea, sam } = U;
  refused(await scan(tia, "ahd500000011"), 404, "not_found");   // Hana, hidden
  refused(await scan(tia, "ahd500000012"), 404, "not_found");   // Hugo, pass-only and hidden: not "not on the app"
  refused(await scan(tia, "ban500000017"), 404, "not_found");
  refused(await scan(sid, "blk500000015"), 404, "not_found");   // Bea blocked Sid
  assert.equal(await between(sid, bea), null);
  // Bea scanning Sid's pass: the block works both ways.
  refused(await scan(bea, "con500000001"), 404, "not_found");
  // Staff see hidden people (as everywhere in the app): connected.
  const s = await scan(sam, "ahd500000011");
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.user.id, idOf(hana));
});

test("no app account, or not on the app yet → 409 with nothing about them; your own pass → 400", { skip }, async () => {
  const { sid, tia } = U;
  const g = refused(await scan(tia, "gst500000014"), 409, "not_on_app");
  assert.equal(g.error, "They haven't joined the TTFC app yet. You can connect once they sign in.");
  refused(await scan(tia, "noa500000013"), 409, "not_on_app");
  const self = refused(await scan(sid, "TECHFEST:con500000001"), 400, "self");
  assert.equal(self.error, "That's your own pass.");
});

test("without the shareContact right → 403 before anything is looked up", { skip }, async () => {
  const r = await scan(U.vic, "acc500000002");
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "share_off");
  assert.equal(r.body.error, "Contact sharing is off for your pass type.");
  assert.equal(await between(U.vic, U.ada), null);
});

test("a pending request either way becomes an accepted in-person connection, and the holder is told", { skip }, async () => {
  const { tia, ian } = U;
  await M.SocialConnection.create({ fromUserId: ian._id, toUserId: tia._id, status: "pending", kind: "online", note: "Hi" });
  const r = await scan(tia, "inc500000018", { share: [] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "accepted");
  assert.equal(r.body.kind, "inPerson");
  assert.equal(r.body.alreadyConnected, false);
  assert.equal(r.body.direction, "incoming");
  const row = await between(tia, ian);
  assert.equal(row.via, "pass");
  assert.deepEqual(row.toShare, []);   // Tia (the row's "to" side) shares nothing
  await waitFor(() => pushes.length);
  assert.deepEqual(pushes.map((p) => [p.to, p.note.title]), [[[idOf(ian)], "Tia Tester connected with you"]]);
  const inbox = await call("GET", "/api/social/notifications", { as: ian });
  assert.deepEqual(inbox.body.notifications.map((x) => [x.kind, x.title, x.fromUserId]), [["conn", "Tia Tester connected with you", idOf(tia)]]);
  assert.equal(inbox.body.unread, 1);
  // Ian blocks Tia later: her row leaves his Notifications and his unread count.
  await M.Block.create({ userId: ian._id, blockedId: tia._id });
  const after = await call("GET", "/api/social/notifications", { as: ian });
  assert.deepEqual([after.body.notifications.length, after.body.unread], [0, 0]);
  await M.Block.deleteOne({ userId: ian._id, blockedId: tia._id });
});

test("a hidden scanner's connection is saved but nobody is told", { skip }, async () => {
  const { rl4, pia } = U;
  await M.User.updateOne({ _id: rl4._id }, { $set: { appHidden: { at: new Date() } } });
  forgetHidden();
  const r = await scan(rl4, "pas500000004");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.id, idOf(pia));
  await pause(300);
  assert.equal(pushes.length, 0);
  assert.equal(await M.AppNotification.countDocuments({ userId: pia._id, sentBy: rl4._id }), 0, "no notification either");
  await M.User.updateOne({ _id: rl4._id }, { $unset: { appHidden: 1 } });
  forgetHidden();
});

test("the same scan twice at once (a double tap): one connection, one push, both answered", { skip }, async () => {
  const { rl4, ian } = U;
  const [a, b] = await Promise.all([scan(rl4, "inc500000018"), scan(rl4, "TECHFEST:INC500000018")]);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(await M.SocialConnection.countDocuments({ $or: [{ fromUserId: rl4._id, toUserId: ian._id }, { fromUserId: ian._id, toUserId: rl4._id }] }), 1);
  await waitFor(() => pushes.length);
  await pause(200);
  assert.equal(pushes.filter((p) => p.to.includes(idOf(ian))).length, 1);
  assert.equal(await M.AppNotification.countDocuments({ userId: ian._id, sentBy: rl4._id }), 1);
});

test("no cap on scans: many in a row, unknown ones included, never refused for it", { skip }, async () => {
  const { rl1, ada, pia } = U;
  for (let i = 0; i < 40; i++) refused(await scan(rl1, `TECHFEST:0000000000${String(i).padStart(2, "0")}`), 404, "not_found");
  for (let i = 0; i < 30; i++) assert.equal((await scan(rl1, i % 2 ? "acc500000002" : "pas500000004")).status, 200, `scan ${i + 1}`);
  assert.ok(await between(rl1, ada));
  assert.ok(await between(rl1, pia));
});
