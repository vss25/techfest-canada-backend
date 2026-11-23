/* Marketing › Post templates (Nov 23 2026), through the real routes against a real (throwaway) MongoDB: staff
   read, management creates, edits a channel's layout, marks it ready (only when complete) and deletes; the kind
   never changes; images only from the library. Starts a local mongod in a temp folder on a free port; skipped
   when the binary isn't there (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). */
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

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port) => new Promise((ok) => { const c = net.connect(port, "127.0.0.1", () => { c.end(); ok(true); }); c.on("error", () => ok(false)); });

let mongod = null, dbDir = "", server = null, base = "", jwt, mongoose, Audit;
const U = {};

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-posttpl-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await pause(250);
  await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_posttpl_test`);
  ({ default: jwt } = await import("jsonwebtoken"));
  const User = (await import("../models/User.js")).default;
  ({ AdminAudit: Audit } = await import("../models/Admin.js"));
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/console/post-templates", (await import("../routes/postTemplates.js")).default);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  U.mgr = await User.create({ name: "Mo Manager", email: "mo.manager@example.com", role: "admin", staffRole: "management" });
  U.staff = await User.create({ name: "Sky Staff", email: "sky.staff@example.com", role: "admin", staffRole: "staff" });
  U.joe = await User.create({ name: "Joe Attendee", email: "joe.attendee@example.com", role: "user" });
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const tokenFor = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function call(method, url, { as, body } = {}) {
  const r = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(as ? { authorization: `Bearer ${tokenFor(as)}` } : {}) },
                                      body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const ok = async (p, want = 200) => { const r = await p; assert.equal(r.status, want, JSON.stringify(r.body)); return r.body; };
const API = "/api/console/post-templates";
const IMG = "https://cdn.sanity.io/images/abc/production/blank-1200x995.png";
const s = {};

test("who can do what: attendees no, staff read, management write", { skip }, async () => {
  assert.equal((await call("GET", API, { as: U.joe })).status, 403);
  const list = await ok(call("GET", API, { as: U.staff }));
  assert.equal(list.canEdit, false);
  assert.deepEqual(list.sizes.session.linkedin, [1200, 995]);
  assert.equal((await call("POST", API, { as: U.staff, body: { name: "Mine", kind: "session" } })).status, 403);
  assert.equal((await ok(call("GET", API, { as: U.mgr }))).canEdit, true);
});

test("create, lay out a channel, mark ready only when complete, never change kind, delete", { skip }, async () => {
  assert.equal((await call("POST", API, { as: U.mgr, body: { name: "", kind: "session" } })).status, 400);
  const created = await ok(call("POST", API, { as: U.mgr, body: { name: "Panel, white", kind: "session" } }), 201);
  s.id = created.template.id;
  assert.equal(created.template.status, "draft");
  assert.deepEqual(created.template.problems, ["Upload the blank LinkedIn design first."]);

  const notReady = await call("PATCH", `${API}/${s.id}`, { as: U.mgr, body: { status: "ready" } });
  assert.equal(notReady.status, 400);
  assert.match(notReady.body.error, /LinkedIn design/);

  const laid = await ok(call("PATCH", `${API}/${s.id}`, { as: U.mgr, body: { kind: "partner", channels: { linkedin: {
    background: { url: IMG, w: 1200, h: 995 },
    boxes: { title: { x: 0.05, y: 0.2, w: 0.9, h: 0.15, maxChars: 70 }, people: { x: 0.05, y: 0.45, w: 0.9, h: 0.5, gap: 0.04, card: "cutout" } },
  } } } }));
  assert.equal(laid.template.kind, "session");
  assert.equal(laid.template.channels.linkedin.boxes.people.card, "cutout");
  assert.equal(laid.template.channels.linkedin.boxes.title.maxChars, 70);
  assert.deepEqual(laid.template.problems, []);

  assert.equal((await call("PATCH", `${API}/${s.id}`, { as: U.mgr, body: { channels: { x: { background: { url: "https://evil.example.com/x.png" } } } } })).status, 400);
  const ready = await ok(call("PATCH", `${API}/${s.id}`, { as: U.mgr, body: { status: "ready" } }));
  assert.equal(ready.template.status, "ready");
  assert.ok(await Audit.findOne({ action: "post_template_ready", targetId: s.id }).lean());

  assert.equal((await call("DELETE", `${API}/${s.id}`, { as: U.staff })).status, 403);
  await ok(call("DELETE", `${API}/${s.id}`, { as: U.mgr }));
  assert.equal((await call("PATCH", `${API}/${s.id}`, { as: U.mgr, body: { name: "x" } })).status, 404);
  assert.equal((await call("PATCH", `${API}/nope`, { as: U.mgr, body: { name: "x" } })).status, 404);
});
