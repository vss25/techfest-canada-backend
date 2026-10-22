/* Help & SOS (Oct 22 2026) through the real routes, against a real (throwaway) MongoDB: an attendee's urgent message
   reaches every staff account and moderator at once (a push that ignores their switches and isn't suppressed for a
   sender hidden from the app) and the SOS_ALERT_TO email from enquire@; three new requests an hour; the thread with
   staff replies (Sent → Seen by staff → Resolved) and the push back; who may open the staff inbox (staff, moderators,
   volunteers with the staff type; not other volunteers or attendees); audits without the text. Emails go to a stub,
   pushes are watched with observePushes: nothing leaves the machine. Starts a local mongod in a temp folder on a free
   port and stops it after; skipped when the binary isn't there (TTFC_TEST_MONGOD, else
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
process.env.FRONTEND_URL = "https://www.thetechfestival.com";
delete process.env.SOS_ALERT_TO;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.FCM_SERVICE_ACCOUNT;
delete process.env.APNS_KEY;

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.includes(".sanity.io/")) return new Response(JSON.stringify({ result: [] }), { status: 200, headers: { "content-type": "application/json" } });
  throw new Error(`blocked in the test: ${url}`);
};

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port) => new Promise((ok) => { const c = net.connect(port, "127.0.0.1", () => { c.end(); ok(true); }); c.on("error", () => ok(false)); });

let mongod = null;
let dbDir = "";
let server = null;
let base = "";
let jwt;
let mongoose;
const M = {};
const U = {};
const s = {};
const pushes = [];
const emails = [];

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-sos-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await pause(250);
  await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_sos_test`);
  ({ default: jwt } = await import("jsonwebtoken"));
  const { observePushes } = await import("../services/push.js");
  observePushes((to, note) => pushes.push({ to, note }));
  const { useSosSender } = await import("../services/sos.js");
  useSosSender(async (payload) => { emails.push(payload); return { id: `re_${emails.length}` }; });
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.SosRequest = await imp("../models/SosRequest.js");
  Object.assign(M, await import("../models/Admin.js"));
  const { default: express } = await import("express");
  const sos = await import("../routes/sos.js");
  const app = express();
  app.use(express.json());
  app.use("/api/app/sos", sos.attendeeRouter);
  app.use("/api/console/sos", sos.staffRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const onApp = { appOnboarded: true, lastActiveAt: new Date("2026-10-21T12:00:00Z") };
  const t = (id) => [{ ticketId: id, type: "connect" }];
  const allOff = { messages: false, comments: false, mentions: false, likes: false, groups: false, connections: false, announcements: false, digestEmail: false };
  const mk = (key, doc) => M.User.create(doc).then((u) => { U[key] = u; });
  await Promise.all([
    mk("mia", { name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management", notifyPrefs: allOff, ...onApp }),
    mk("sam", { name: "Sam Staff", email: "sam.staff@example.com", role: "admin", staffRole: "staff", ...onApp }),
    mk("vic", { name: "Vic Volunteer", email: "vic.volunteer@example.com", role: "volunteer", types: ["staff"], ...onApp }),
    mk("val", { name: "Val Volunteer", email: "val.volunteer@example.com", role: "volunteer", ...onApp }),
    mk("max", { name: "Max Moderator", email: "max.moderator@example.com", types: ["staff"], tickets: t("con900000001"), ...onApp }),
    mk("ann", { name: "Ann Attendee", email: "ann.attendee@example.com", tickets: t("con900000002"), ...onApp,
      contactItems: [{ id: "p1", kind: "phone", value: "+1 416 555 0101", shareByDefault: false }] }),
    mk("hal", { name: "Hal Hidden", email: "hal.hidden@example.com", tickets: t("con900000003"),
      appHidden: { at: new Date("2026-10-21T10:00:00Z"), byName: "Mia", reason: "test" }, ...onApp }),
    mk("gone", { name: "Former Staff", email: "former.staff@example.com", role: "admin", banned: true, ...onApp }),
  ]);
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const tokenFor = (u, extra = {}) => jwt.sign({ id: String(u._id), ...extra }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function call(method, url, { as, token, body } = {}) {
  const auth = token || (as ? tokenFor(as) : "");
  const r = await realFetch(base + url, {
    method, headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const ok = async (p, want = 200) => {
  const r = await p;
  assert.equal(r.status, want, JSON.stringify(r.body));
  return r.body;
};
const idOf = (u) => String(u._id);
async function settle() {
  let n = -1;
  for (let i = 0; i < 40 && n !== pushes.length + emails.length; i++) { n = pushes.length + emails.length; await pause(40); }
  await pause(60);
}
const responders = () => [idOf(U.mia), idOf(U.sam), idOf(U.vic), idOf(U.max)].sort();

test("the form's options need no sign-in; sending one does", { skip }, async () => {
  const o = await ok(call("GET", "/api/app/sos/options"));
  assert.deepEqual(o.categories.map((c) => c.label), ["Medical", "Safety or security", "Lost or separated", "Accessibility help", "Other urgent"]);
  assert.deepEqual(o.locations, ["Harbour Ballroom", "Harbour Ballroom foyer", "Pier 4 & 5", "Registration desk", "Expo floor", "Hotel lobby"]);
  assert.match(o.note, /emergencies only/);
  const r = await call("POST", "/api/app/sos", { body: { category: "medical", message: "Help" } });
  assert.equal(r.status, 401);
  assert.match(r.body.error, /call 911/);
  assert.equal((await call("POST", "/api/app/sos", { as: U.ann, body: { category: "lunch", message: "Help" } })).status, 400);
  assert.equal((await call("POST", "/api/app/sos", { as: U.ann, body: { category: "medical", message: "   " } })).status, 400);
});

test("a new request alerts every responder at once (whatever their switches) and emails enquire@", { skip }, async () => {
  pushes.length = 0;
  emails.length = 0;
  const r = await ok(call("POST", "/api/app/sos", { as: U.ann, body: {
    category: "Safety or security", location: "Expo floor", message: "Someone is following me near booth 12 <b>",
  } }), 201);
  s.id = r.request.id;
  assert.deepEqual([r.request.status, r.request.statusLabel, r.request.category, r.request.categoryLabel, r.request.phone],
    ["open", "Sent", "safety", "Safety or security", "+1 416 555 0101"]);   // the phone from her contact card
  await settle();
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0].to.sort(), responders());                     // not Val (no staff type), not banned staff, not Ann
  assert.deepEqual([pushes[0].note.kind, pushes[0].note.thread, pushes[0].note.url, pushes[0].note.title],
    ["sos", `sos.${s.id}`, `/app/staff/sos/${s.id}`, "SOS: Safety or security"]);
  assert.match(pushes[0].note.body, /^Ann Attendee · Expo floor: Someone is following me/);
  assert.equal(emails.length, 1);
  const e = emails[0];
  assert.deepEqual([e.from, e.to, e.reply_to, e.subject],
    ["The Tech Festival Canada <enquire@thetechfestival.com>", ["enquire@thetechfestival.com"], "ann.attendee@example.com", "SOS (Safety or security) from Ann Attendee"]);
  assert.match(e.html, /Someone is following me near booth 12 &lt;b&gt;/);
  assert.match(e.html, /\+1 416 555 0101/);
  assert.match(e.html, new RegExp(`https://www\\.thetechfestival\\.com/app/staff/sos/${s.id}`));
  assert.match(e.text, /Where: Expo floor/);
  // SOS_ALERT_TO: a comma list.
  process.env.SOS_ALERT_TO = "security@example.com, ops@example.com";
  try {
    emails.length = 0;
    await ok(call("POST", "/api/app/sos", { as: U.hal, body: { category: "medical", message: "Feeling faint" } }), 201);
    await settle();
    assert.deepEqual(emails[0].to, ["security@example.com", "ops@example.com"]);
  } finally {
    delete process.env.SOS_ALERT_TO;
  }
  // Hidden from the app: still alerts everyone (safety first).
  assert.ok(pushes.some((p) => p.note.title === "SOS: Medical" && p.to.length === 4));
});

test("three new requests an hour per person; their list, newest first; a follow-up pushes staff", { skip }, async () => {
  await ok(call("POST", "/api/app/sos", { as: U.ann, body: { category: "other", message: "Second" } }), 201);
  await ok(call("POST", "/api/app/sos", { as: U.ann, body: { category: "lost", message: "Third", phone: "416 555 0199 ext" } }), 201);
  const fourth = await call("POST", "/api/app/sos", { as: U.ann, body: { category: "other", message: "Fourth" } });
  assert.deepEqual([fourth.status, fourth.body.code], [429, "rate_limited"]);
  assert.match(fourth.body.error, /call 911 or find a staff member/);
  const mine = await ok(call("GET", "/api/app/sos", { as: U.ann }));
  assert.deepEqual(mine.requests.map((x) => x.message), ["Third", "Second", "Someone is following me near booth 12 <b>"]);
  assert.equal(mine.requests[0].phone, "416 555 0199");
  assert.equal(mine.phone, "+1 416 555 0101");
  pushes.length = 0;
  const f = await ok(call("POST", `/api/app/sos/${s.id}/messages`, { as: U.ann, body: { body: "He's by the coffee stand now" } }));
  assert.deepEqual(f.request.messages.map((m) => [m.from, m.body]), [["attendee", "He's by the coffee stand now"]]);
  await settle();
  assert.deepEqual([pushes[0].note.title, pushes[0].note.body], ["SOS: new message from Ann Attendee", "He's by the coffee stand now"]);
  // Someone else's request isn't theirs.
  assert.equal((await call("POST", `/api/app/sos/${s.id}/messages`, { as: U.hal, body: { body: "?" } })).status, 404);
});

test("the staff inbox: staff, moderators and volunteers with the staff type; open first; reply, acknowledge, resolve", { skip }, async () => {
  assert.equal((await call("GET", "/api/console/sos", { as: U.val })).status, 403);
  assert.equal((await call("GET", "/api/console/sos", { as: U.ann })).status, 403);
  assert.equal((await call("GET", "/api/console/sos", { as: U.gone })).status, 403);
  assert.equal((await call("GET", "/api/console/sos")).status, 401);
  // A moderator signed in to the web app with an emailed code; staff with the admin panel's password token.
  const list = await ok(call("GET", "/api/console/sos", { token: tokenFor(U.max, { via: "email" }) }));
  assert.equal(list.status, "active");
  assert.deepEqual(list.counts, { open: 4, acknowledged: 0, resolved: 0 });
  assert.ok(list.requests.every((x) => x.status === "open"));
  const one = (await ok(call("GET", `/api/console/sos/${s.id}`, { as: U.mia }))).request;
  assert.deepEqual([one.name, one.email, one.phone, one.location, one.links.tel, one.links.mailto, one.links.app],
    ["Ann Attendee", "ann.attendee@example.com", "+1 416 555 0101", "Expo floor", "tel:+14165550101", "mailto:ann.attendee@example.com", `/app/staff/sos/${s.id}`]);
  // Vic replies: it's seen, and Ann hears (her own switches don't matter for this).
  pushes.length = 0;
  const r = (await ok(call("POST", `/api/console/sos/${s.id}/reply`, { token: tokenFor(U.vic, { via: "email" }), body: { body: "Security is on the way. Stay by the coffee stand." } }))).request;
  assert.deepEqual([r.status, r.acknowledgedBy.name, r.messages.at(-1).staffName], ["acknowledged", "Vic Volunteer", "Vic Volunteer"]);
  await settle();
  assert.deepEqual(pushes.map((p) => [p.to, p.note.kind, p.note.url, p.note.title]), [[[idOf(U.ann)], "sos", "/app/help", "Vic (TTFC staff) replied"]]);
  const seen = (await ok(call("GET", "/api/app/sos", { as: U.ann }))).requests.find((x) => x.id === s.id);
  assert.deepEqual([seen.statusLabel, seen.messages.at(-1).from, seen.messages.at(-1).staffName], ["Seen by staff", "staff", "Vic"]);
  // Sam resolves it: Ann can't add to it any more.
  assert.equal((await call("POST", `/api/console/sos/${s.id}/status`, { as: U.sam, body: { status: "closed" } })).status, 400);
  const done = (await ok(call("POST", `/api/console/sos/${s.id}/status`, { as: U.sam, body: { status: "resolved" } }))).request;
  assert.deepEqual([done.status, done.resolvedBy.name], ["resolved", "Sam Staff"]);
  const again = await call("POST", `/api/app/sos/${s.id}/messages`, { as: U.ann, body: { body: "Thanks" } });
  assert.deepEqual([again.status, again.body.code], [409, "resolved"]);
  const counts = (await ok(call("GET", "/api/console/sos?status=all", { as: U.mia }))).counts;
  assert.deepEqual(counts, { open: 3, acknowledged: 0, resolved: 1 });
  assert.deepEqual((await ok(call("GET", "/api/console/sos?status=resolved", { as: U.mia }))).requests.map((x) => x.id), [s.id]);
  // Audited, never with what was written.
  const rows = await M.AdminAudit.find({ targetType: "sos" }).lean();
  assert.deepEqual(rows.map((x) => x.action).sort(), ["sos_reply", "sos_status"]);
  assert.ok(rows.every((x) => !/coffee|Security is on the way/.test(x.detail)));
  assert.equal(rows.find((x) => x.action === "sos_status").detail, "acknowledged → resolved");
});
