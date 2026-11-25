/* Staff activity (Settings › Staff activity) through the real routes and models against a throwaway local
   MongoDB: the panel's sign-in starts a session, page views and heartbeats add time (capped per gap), an idle
   gap over 15 minutes starts a new session, staff-panel writes count as edits (searches and app requests
   don't), sign-out closes the session, and only the super admin can read it (403 for staff and for
   management outside SUPER_ADMIN_EMAILS). Skipped without the local mongod (TTFC_TEST_MONGOD, else
   ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Nothing leaves the machine. Fictional people. */
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
process.env.SUPER_ADMIN_EMAILS = "mia.super@example.com";

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  throw new Error(`blocked in the test: ${url}`);
};

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });

let mongod; let dbDir; let server; let base; let mongoose; let jwt; let bcrypt;
let User; let StaffSession; let StaffActivityHour; let setClock;
let mia; let sam; let stan;
let now = new Date("2026-11-24T14:00:00Z"); // 9:00 AM Toronto
const at = (iso) => { now = new Date(iso); };
const tokenOf = (u) => jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET);
const ORIGIN = "https://www.thetechfestival.com";

async function call(method, p, { user, body, origin = ORIGIN } = {}) {
  const res = await realFetch(`${base}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(user ? { authorization: `Bearer ${tokenOf(user)}` } : {}), ...(origin ? { origin } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
// Pings and edits are written after the answer: wait until they're all in (the edit counter starts on "finish",
// a tick after the client has the answer, hence the short pause first).
let settled = null;
const settle = async () => { await new Promise((r) => setTimeout(r, 20)); await settled(); };

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-staffact-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_staff_activity_test`, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  ({ default: jwt } = await import("jsonwebtoken"));
  ({ default: bcrypt } = await import("bcryptjs"));
  ({ default: User } = await import("../models/User.js"));
  ({ default: StaffSession } = await import("../models/StaffSession.js"));
  ({ default: StaffActivityHour } = await import("../models/StaffActivityHour.js"));
  const svc = await import("../services/staffActivity.js");
  setClock = svc.setStaffActivityClock;
  settled = svc.staffActivitySettled;
  setClock(() => now);
  const { requireAdmin } = await import("../middleware/adminAuth.js");
  const { default: express } = await import("express");
  const app = express();
  app.use(svc.trackPanelEdits);
  app.use(express.json());
  app.use("/api/auth", (await import("../routes/auth.js")).default);
  app.use("/api/admin/staff-activity", (await import("../routes/staffActivity.js")).default);
  // Stand-ins for any staff-panel write, a search, and an app (non-panel) write.
  app.patch("/api/console/things/:id", requireAdmin, (req, res) => res.json({ ok: true }));
  app.patch("/api/console/broken/:id", requireAdmin, (req, res) => res.status(409).json({ error: "no" }));
  app.post("/api/console/search", requireAdmin, (req, res) => res.json({ groups: [] }));
  app.post("/api/social/feed", (req, res) => { req.user = { id: "x", role: "admin" }; res.status(201).json({}); });
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const password = await bcrypt.hash("correct horse battery", 10);
  mia = await User.create({ name: "Mia Super", email: "mia.super@example.com", role: "admin", staffRole: "management", password });
  sam = await User.create({ name: "Sam Manager", email: "sam.manager@example.com", role: "admin", staffRole: "management" });
  stan = await User.create({ name: "Stan Staff", email: "stan.staff@example.com", role: "admin", staffRole: "staff" });
  await User.create({ name: "Ada Attendee", email: "ada@example.com", role: "user" });
});

after(async () => {
  setClock?.();
  server?.close();
  await mongoose?.disconnect();
  mongod?.kill();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

test("the panel's sign-in starts a session; views and heartbeats add capped time; edits count; sign-out closes it", { skip }, async () => {
  at("2026-11-24T14:00:00Z");
  const login = await call("POST", "/api/auth/login", { body: { email: "mia.super@example.com", password: "correct horse battery", panel: "admin" } });
  assert.equal(login.status, 200);
  await settle();
  let s = await StaffSession.findOne({ userId: mia._id }).lean();
  assert.equal(s.via, "sign-in");
  assert.equal(s.activeSeconds, 0);

  at("2026-11-24T14:00:30Z"); assert.equal((await call("POST", "/api/admin/staff-activity/ping", { user: mia, body: { kind: "view" } })).status, 204); await settle();
  at("2026-11-24T14:01:30Z"); await call("POST", "/api/admin/staff-activity/ping", { user: mia, body: { kind: "beat" } }); await settle();
  at("2026-11-24T14:02:00Z"); assert.equal((await call("PATCH", "/api/console/things/1", { user: mia, body: {} })).status, 200); await settle();
  at("2026-11-24T14:02:10Z"); await call("PATCH", "/api/console/broken/1", { user: mia, body: {} }); await settle();          // 409: not an edit
  at("2026-11-24T14:02:20Z"); await call("POST", "/api/console/search", { user: mia, body: { q: "x" } }); await settle();     // search: not an edit
  at("2026-11-24T14:02:30Z"); await call("PATCH", "/api/console/things/2", { user: mia, body: {}, origin: null }); await settle(); // no Origin (native app)
  // A tab left open: the next activity is 10 minutes later, so only 2 minutes count.
  at("2026-11-24T14:12:00Z"); await call("POST", "/api/admin/staff-activity/ping", { user: mia, body: { kind: "view" } }); await settle();

  s = await StaffSession.findOne({ userId: mia._id }).lean();
  assert.equal(s.pageViews, 2);
  assert.equal(s.edits, 1);
  assert.equal(s.activeSeconds, 30 + 60 + 30 + 120);
  assert.equal(s.endedAt, null);

  at("2026-11-24T14:13:00Z");
  assert.equal((await call("POST", "/api/admin/staff-activity/signout", { user: mia })).status, 204);
  s = await StaffSession.findOne({ userId: mia._id }).lean();
  assert.equal(s.endReason, "signout");
  assert.equal(s.activeSeconds, 240 + 60);
  const hour = await StaffActivityHour.findOne({ userId: mia._id }).lean();
  assert.deepEqual([hour.pageViews, hour.edits, hour.activeSeconds], [2, 1, 300]);
});

test("more than 15 idle minutes ends the session at its last activity and starts a new one", { skip }, async () => {
  at("2026-11-24T15:00:00Z"); await call("POST", "/api/admin/staff-activity/ping", { user: stan, body: { kind: "view" } }); await settle();
  at("2026-11-24T15:05:00Z"); await call("POST", "/api/admin/staff-activity/ping", { user: stan, body: { kind: "beat" } }); await settle();
  at("2026-11-24T15:40:00Z"); await call("POST", "/api/admin/staff-activity/ping", { user: stan, body: { kind: "view" } }); await settle();
  const rows = await StaffSession.find({ userId: stan._id }).sort({ startedAt: 1 }).lean();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].via, "resumed");
  assert.equal(rows[0].endReason, "idle");
  assert.equal(rows[0].endedAt.toISOString(), "2026-11-24T15:05:00.000Z");
  assert.equal(rows[0].activeSeconds, 120);
  assert.equal(rows[1].activeSeconds, 0);
  assert.equal((await call("POST", "/api/admin/staff-activity/ping", { user: stan, body: { kind: "nap" } })).status, 400);
});

test("an app request by staff is not a panel edit; non-staff can't ping", { skip }, async () => {
  const before = await StaffActivityHour.countDocuments();
  await call("POST", "/api/social/feed", { user: stan, body: {} }); await settle();
  assert.equal(await StaffActivityHour.countDocuments(), before);
  const ada = await User.findOne({ email: "ada@example.com" });
  assert.equal((await call("POST", "/api/admin/staff-activity/ping", { user: ada, body: { kind: "view" } })).status, 403);
  assert.equal((await call("POST", "/api/admin/staff-activity/ping", { body: { kind: "view" } })).status, 401);
});

test("only the super admin reads it: 403 for staff and for management outside SUPER_ADMIN_EMAILS", { skip }, async () => {
  at("2026-11-24T20:00:00Z");
  for (const u of [stan, sam]) {
    const r = await call("GET", "/api/admin/staff-activity", { user: u });
    assert.equal(r.status, 403, u.name);
    assert.equal(r.data.code, "super_admin_only");
  }
  assert.equal((await call("GET", "/api/admin/staff-activity")).status, 401);
  const r = await call("GET", "/api/admin/staff-activity?tz=America/Toronto", { user: mia });
  assert.equal(r.status, 200);
  assert.equal(r.data.from, "2026-11-18");
  assert.equal(r.data.to, "2026-11-24");
  assert.deepEqual(r.data.staff.map((s) => s.name).sort(), ["Mia Super", "Sam Manager", "Stan Staff"], "staff only, everyone listed");
  const m = r.data.staff.find((s) => s.name === "Mia Super");
  assert.deepEqual(m.totals, { activeSeconds: 300, pageViews: 2, edits: 1, sessions: 1 });
  assert.equal(m.days[0].date, "2026-11-24");
  assert.deepEqual(m.days[0].hours, [{ hour: 9, activeSeconds: 300, pageViews: 2, edits: 1 }]);
  assert.equal(m.days[0].sessions[0].status, "signout");
  const st = r.data.staff.find((s) => s.name === "Stan Staff");
  assert.equal(st.totals.sessions, 2);
  assert.equal(st.days[0].sessions[1].status, "idle", "4 h later the open session reads as idle");
  assert.equal((await call("GET", "/api/admin/staff-activity?from=2026-01-01&to=2026-11-24", { user: mia })).status, 400);
  assert.equal((await call("GET", "/api/admin/staff-activity?userId=nope", { user: mia })).status, 400);
  const one = await call("GET", `/api/admin/staff-activity?userId=${stan._id}`, { user: mia });
  assert.deepEqual(one.data.staff.map((s) => s.name), ["Stan Staff"]);
});
