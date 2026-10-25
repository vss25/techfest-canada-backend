/* Unsaving a session takes its points away (Oct 25 2026, "someone can just click on all sessions, get the points,
   then unsave them"), through the real routes against a real (throwaway) MongoDB.
   POST /api/social/sessions/:id/register { saved } sets exactly that state, so a tap can never do the opposite when
   the app and the server disagree; without `saved` (app builds before 1.0.3 / 1.0.6) it still toggles. Points are
   counted from the sessions saved now, only agenda sessions count, and the leaderboard follows at once.
   Starts a local mongod in a temp folder on a free port and stops it after; skipped when the binary isn't there
   (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Nothing leaves the machine: Sanity
   is answered by a stubbed fetch (twelve agenda sessions), no push service, no emails. Fictional people, example.com. */
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
delete process.env.FCM_SERVICE_ACCOUNT;
delete process.env.DEEPCLEER_ACCESS_KEY;

const AGENDA = Array.from({ length: 12 }, (_, i) => `d1-${String(i + 1).padStart(2, "0")}`);
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.includes(".sanity.io/")) {
    // The points agenda query gets the twelve sessions; anything else, nothing.
    const q = decodeURIComponent(url);
    const result = q.includes("{_id, sessionId}") ? AGENDA.map((id) => ({ _id: `doc-${id}`, sessionId: id })) : [];
    return new Response(JSON.stringify({ result }), { status: 200, headers: { "content-type": "application/json" } });
  }
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
let jwt;
let mongoose;
let SessionRegistration;
const U = {};

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-points-unsave-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await pause(250);
  await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_points_unsave_test`);
  ({ default: jwt } = await import("jsonwebtoken"));
  ({ SessionRegistration } = await import("../models/Social.js"));
  const User = (await import("../models/User.js")).default;
  await SessionRegistration.init();   // the unique { userId, sessionId } index, before the concurrent saves
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/social", (await import("../routes/social.js")).default);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const onApp = { appOnboarded: true, lastActiveAt: new Date("2026-10-24T12:00:00Z") };
  const ticket = (ticketId) => ({ ticketId, type: "connect", purchaseDate: new Date("2026-10-01") });
  U.ann = await User.create({ name: "Ann Saver", email: "ann.saver@example.com", tickets: [ticket("con500000001")], ...onApp });
  U.ben = await User.create({ name: "Ben Viewer", email: "ben.viewer@example.com", tickets: [ticket("con500000002")], ...onApp });
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

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
const ok = async (p) => {
  const r = await p;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const save = (as, id, saved) => ok(call("POST", `/api/social/sessions/${id}/register`, { as, body: saved === undefined ? {} : { saved } }));
const savedPoints = async (as) => (await ok(call("GET", "/api/social/points/me", { as }))).breakdown.find((b) => b.key === "session.saved");
const annOnBoard = async () => (await ok(call("GET", "/api/social/points/leaderboard?limit=50", { as: U.ben }))).entries.find((e) => e.user.id === String(U.ann._id));

test("saving every session, then unsaving them, leaves no points", { skip }, async () => {
  for (const id of AGENDA) assert.equal((await save(U.ann, id, true)).registered, true);
  await save(U.ann, "made-up-session", true);              // not on the agenda: saved, but worth nothing
  const before = await savedPoints(U.ann);
  assert.deepEqual([before.count, before.points], [10, 50]);   // capped at 10 sessions
  assert.equal((await annOnBoard())?.points, 50);

  for (const id of AGENDA.slice(0, 9)) assert.equal((await save(U.ann, id, false)).registered, false);
  const mid = await savedPoints(U.ann);
  assert.deepEqual([mid.count, mid.points], [3, 15]);
  // Ben sees Ann's row follow at once, not after the board's 60 s cache.
  assert.equal((await waitFor(async () => ((await annOnBoard())?.points === 15 ? 15 : null))), 15);

  for (const id of [...AGENDA.slice(9), "made-up-session"]) await save(U.ann, id, false);
  assert.deepEqual(Object.values(await savedPoints(U.ann)).slice(-2), [0, 0]);
  assert.equal(await waitFor(async () => !(await annOnBoard())), true);   // no points left: off the board
  assert.equal(await SessionRegistration.countDocuments({ userId: U.ann._id }), 0);
});

test("{ saved } sets that state: a stale tap never does the opposite", { skip }, async () => {
  // The phone still shows d1-05 as saved (a save that never reached the server); "unsave" must not save it here.
  const r = await save(U.ann, "d1-05", false);
  assert.deepEqual([r.registered, r.count], [false, 0]);
  assert.equal((await savedPoints(U.ann)).points, 0);
  // The same state twice changes nothing.
  assert.equal((await save(U.ann, "d1-05", true)).count, 1);
  assert.equal((await save(U.ann, "d1-05", true)).count, 1);
  assert.equal((await savedPoints(U.ann)).points, 5);
  // Two taps at once: one registration, no error.
  const both = await Promise.all([save(U.ann, "d1-06", true), save(U.ann, "d1-06", true)]);
  assert.deepEqual(both.map((b) => b.registered), [true, true]);
  assert.equal(await SessionRegistration.countDocuments({ userId: U.ann._id, sessionId: "d1-06" }), 1);
  // Ben saving the same session counts for him, not for Ann.
  assert.equal((await save(U.ben, "d1-06", true)).count, 2);
  assert.equal((await savedPoints(U.ann)).points, 10);
});

test("app builds without { saved } still toggle", { skip }, async () => {
  assert.equal((await save(U.ann, "d1-07")).registered, true);
  assert.equal((await save(U.ann, "d1-07")).registered, false);
  // A non-boolean `saved` is ignored (a toggle), never coerced.
  assert.equal((await ok(call("POST", "/api/social/sessions/d1-07/register", { as: U.ann, body: { saved: "false" } }))).registered, true);
  const mine = await ok(call("GET", "/api/social/sessions/registrations", { as: U.ann }));
  assert.deepEqual(mine.mine.sort(), ["d1-05", "d1-06", "d1-07"]);
});
