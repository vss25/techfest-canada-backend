/* "Rate the app" (Oct 27 2026) through the real routes, against a real (throwaway) MongoDB: GET /api/app/content
   serves the rating window (defaults, then management's saved values), PUT /api/console/app-content/:key is
   management only for these keys and refuses a value that isn't true / false or an ISO time with its offset, and
   GET /api/console/app-content labels them.
   Starts a local mongod in a temp folder on a free port and stops it after; skipped when the binary isn't there
   (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Fictional people. */
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

let mongod = null;
let dbDir = "";
let server = null;
let base = "";
let jwt;
let mongoose;
const M = {};
let mia;
let sam;

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-review-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await pause(250);
  await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_review_test`);
  ({ default: jwt } = await import("jsonwebtoken"));
  M.User = (await import("../models/User.js")).default;
  Object.assign(M, await import("../models/Admin.js"));
  await M.AppContent.init();
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/app", (await import("../routes/appApi.js")).default);
  app.use("/api/console", (await import("../routes/console.js")).default);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  mia = await M.User.create({ name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management" });
  sam = await M.User.create({ name: "Sam Staff", email: "sam.staff@example.com", role: "admin", staffRole: "staff" });
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const tokenFor = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function call(method, url, { as = null, body } = {}) {
  const r = await fetch(base + url, {
    method, headers: { "content-type": "application/json", ...(as ? { authorization: `Bearer ${tokenFor(as)}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const put = (as, key, value) => call("PUT", `/api/console/app-content/${key}`, { as, body: { value } });

test("the apps get the rating window from GET /api/app/content: the defaults, then management's values", { skip }, async () => {
  const c = await call("GET", "/api/app/content");
  assert.equal(c.status, 200);
  assert.deepEqual([c.body["review.enabled"], c.body["review.ask_from"], c.body["review.ask_until"]],
    ["true", "2026-10-27T12:00:00-04:00", "2026-10-27T23:59:00-04:00"]);
  assert.equal((await put(mia, "review.ask_from", "2026-10-27T14:00:00-04:00")).status, 200);
  assert.equal((await put(mia, "review.enabled", false)).status, 200);
  const after = (await call("GET", "/api/app/content")).body;
  assert.deepEqual([after["review.enabled"], after["review.ask_from"], after["review.ask_until"]], ["false", "2026-10-27T14:00:00-04:00", "2026-10-27T23:59:00-04:00"]);
  assert.ok(await M.AdminAudit.exists({ action: "edit_app_text", targetId: "review.ask_from", adminName: "Mia Manager" }));
  assert.equal((await put(mia, "review.enabled", "true")).status, 200);
});

test("management only; bad values refused with the reason; the admin list labels them", { skip }, async () => {
  for (const [k, v] of [["review.enabled", "false"], ["review.ask_from", "2026-10-27T13:00:00-04:00"], ["review.ask_until", "2026-10-27T20:00:00-04:00"]]) {
    const r = await put(sam, k, v);
    assert.deepEqual([r.status, r.body.code], [403, "management_only"], k);
  }
  const badTime = await put(mia, "review.ask_until", "tonight");
  assert.deepEqual([badTime.status, badTime.body], [400, { error: "Use an ISO time with its offset, for example 2026-10-27T12:00:00-04:00.", code: "invalid_value" }]);
  const noZone = await put(mia, "review.ask_until", "2026-10-27T20:00:00");
  assert.equal(noZone.status, 400);
  const badFlag = await put(mia, "review.enabled", "maybe");
  assert.deepEqual([badFlag.status, badFlag.body], [400, { error: 'Use "true" or "false".', code: "invalid_value" }]);
  assert.deepEqual((await put(mia, "review.whenever", "x")).body, { error: "Unknown key" });
  assert.equal((await call("GET", "/api/app/content")).body["review.ask_until"], "2026-10-27T23:59:00-04:00", "unchanged");
  const list = (await call("GET", "/api/console/app-content", { as: sam })).body;
  const row = list.find((r) => r.key === "review.ask_until");
  assert.deepEqual([row.default, row.managementOnly, row.label], ["2026-10-27T23:59:00-04:00", true, "Ask for an app rating: until"]);
  assert.match(row.description, /Apple's \/ Google's own rating prompt once, after a good moment, inside this window/);
  assert.equal(list.find((r) => r.key === "review.enabled").label, "Ask for an app rating");
  assert.equal("label" in list.find((r) => r.key === "home.announcement"), false, "other keys as before");
});
