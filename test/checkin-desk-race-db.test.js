/* TTFC Check-in desk app, contract C2 under concurrency: an undo and the tap it undoes, sent in either order and
   interleaved at every step (services/checkinDeskActions.js test hooks), through the real routes against a real
   (throwaway) MongoDB. Whenever an undo of a tap is accepted, the tap ends NOT marked: no mark set, the pass not
   collected (Attendee.checkedIn), no tap left "pending", and the devices' events (by rev) end in the same state.
   Covers the round-2 verifier's two races: (a) the tombstone committed after the tap's last check, and (b) the app's
   own retry pattern (a stalled request, then [tap, undo] re-sent), plus a request that dies and is taken over, a
   staff reset while the pass is being marked collected, and many random interleavings. Starts a local mongod in a
   temp folder (skipped when the binary isn't there, like test/checkin-desk-db.test.js). Fictional people. */
import { test, before, after, afterEach } from "node:test";
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
delete process.env.STRIPE_SECRET_KEY;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
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
let A; // services/checkinDeskActions.js
let guestKey;
const M = {};
const U = {};
const fakeNow = new Date("2026-10-26T14:00:00Z"); // Day 1, 10:00 AM: the lobby and the pass desk are open
let n = 0;
const cid = (p) => `${p}${Date.now().toString(36)}${(n++).toString(36).padStart(5, "0")}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TICKET = "con200000001";
const DAY = "2026-10-26";

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-desk-race-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_desk_race`, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await sleep(250); }
  }
  ({ default: jwt } = await import("jsonwebtoken"));
  (await import("../services/checkinDeskLog.js")).setDeskClock(() => new Date(fakeNow));
  A = await import("../services/checkinDeskActions.js");
  ({ guestKey } = await import("../services/checkinDesk.js"));
  M.User = (await import("../models/User.js")).default;
  M.Attendee = (await import("../models/Attendee.js")).default;
  M.CheckinMark = (await import("../models/CheckinMark.js")).default;
  M.CheckinEvent = (await import("../models/CheckinEvent.js")).default;
  M.CheckinTap = (await import("../models/CheckinTap.js")).default;
  await Promise.all([M.CheckinMark.init(), M.CheckinEvent.init(), M.CheckinTap.init(), M.User.init()]);
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/checkin/desk", (await import("../routes/checkinDesk.js")).default);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  U.val = await M.User.create({ name: "Val Volunteer", email: "val.race@example.com", role: "volunteer" });
  U.sam = await M.User.create({ name: "Sam Staff", email: "sam.race@example.com", role: "admin", staffRole: "staff" });
  await M.Attendee.create({ name: "Rae Race", email: "rae.race@example.com", ticketId: TICKET, ticketType: "connect", stripeSessionId: "cs_r" });
  assert.equal((await call("GET", "/api/checkin/desk/snapshot", U.val)).status, 200); // the guest index is built
});

after(async () => {
  A?.setDeskActionHooks(null);
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});
afterEach(() => { A?.setDeskActionHooks(null); A?.setTapTiming(); });

const tokenFor = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function call(method, p, as, body) {
  const r = await realFetch(`${base}${p}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${tokenFor(as)}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const at = () => fakeNow.toISOString();
const tap = (clientId, point = "checked_in", as = U.val) => call("POST", "/api/checkin/desk/actions", as,
  { clientId, kind: "mark", point, key: guestKey(TICKET), station: point === "arrived" ? "lobby" : "desk", clientAt: at() });
const undo = (target, as = U.val) => call("POST", "/api/checkin/desk/actions", as, { clientId: cid("und"), kind: "undo", target, station: "desk", clientAt: at() });

/** A gate a hook waits on: open() lets it through. `hit` resolves when something reached it. */
function gate() {
  let open;
  let reached;
  const g = { opened: new Promise((r) => { open = r; }), hit: new Promise((r) => { reached = r; }) };
  g.open = open;
  g.reach = reached;
  return g;
}

let sinceSeq = 0;
async function fresh() {
  // (Rows are never deleted in real use, so revs only go up; here each case starts its rows again, and its events.)
  sinceSeq = (await M.CheckinEvent.findOne({}).sort({ seq: -1 }).lean())?.seq || 0;
  await M.CheckinMark.deleteMany({ subject: TICKET });
  await M.Attendee.updateOne({ ticketId: TICKET }, { $set: { checkedIn: false }, $unset: { checkedInAt: 1 } });
}

/** The end state when an undo of tap `X` was accepted: nothing marked, the pass not collected, no tap left pending, and
    the newest version of every mark row the events carried (what the devices hold) is the cleared one. */
async function assertNotMarked(X, label = "") {
  const rows = await M.CheckinMark.find({ subject: TICKET, day: DAY }).lean();
  for (const r of rows) assert.equal(r.at, null, `${label} ${r.point} still marked`);
  const att = await M.Attendee.findOne({ ticketId: TICKET }).lean();
  assert.equal(!!att.checkedIn, false, `${label} the pass is still collected`);
  const claim = await M.CheckinTap.findById(X).lean();
  if (claim) assert.notEqual(claim.state, "pending", `${label} the tap is left pending`);
  const evs = await M.CheckinEvent.find({ subject: TICKET, marks: { $exists: true }, seq: { $gt: sinceSeq } }).sort({ seq: 1 }).lean();
  const newest = new Map();
  for (const e of evs) for (const m of e.marks || []) {
    const k = `${m.day}|${m.point}`;
    if (m.day === DAY && (!newest.has(k) || (m.rev || 0) > (newest.get(k).rev || 0))) newest.set(k, m);
  }
  for (const [k, m] of newest) {
    const row = rows.find((r) => `${r.day}|${r.point}` === k);
    assert.equal(m.at ?? null, null, `${label} the devices' newest ${k} is still marked`);
    assert.equal(m.rev, row.rev, `${label} the devices' ${k} is behind the database (rev ${m.rev} vs ${row.rev})`);
  }
}

test("race (a): the undo's tombstone commits after the tap is recorded and finished: the tap is still taken back", { skip }, async () => {
  await fresh();
  const X = cid("tap");
  const g = gate();
  A.setDeskActionHooks(async (name, info) => {
    if (name === "undo:before-tombstone" && info.ref === X) { g.reach(); await g.opened; }
  });
  const u = undo(X); // reads "X isn't stored", then its tombstone write is slow…
  await g.hit;
  const t = await tap(X); // …meanwhile X is recorded, all the way
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.ok(t.body.mark?.at, "recorded");
  g.open();
  const ur = await u;
  assert.equal(ur.status, 200, JSON.stringify(ur.body));
  assert.ok(!ur.body.noop, "the undo did something");
  await assertNotMarked(X, "(a)");
  assert.equal((await M.CheckinTap.findById(X).lean()).state, "undone");
});

test("race (a'): a tombstone stored while the tap is half-written: that request takes back what it wrote", { skip }, async () => {
  await fresh();
  const X = cid("tap");
  const g = gate();
  A.setDeskActionHooks(async (name, info) => {
    if (name === "tap:between-marks" && info.clientId === X) { g.reach(); await g.opened; }
  });
  const t = tap(X);
  await g.hit; // checked_in and arrived written, the pass not yet collected
  const ur = await undo(X);
  assert.equal(ur.status, 200, JSON.stringify(ur.body));
  assert.equal(ur.body.tombstone, true);
  assert.match(ur.body.message, /still being recorded/);
  g.open();
  const tr = await t;
  assert.equal(tr.status, 200, JSON.stringify(tr.body));
  assert.equal(tr.body.undone, true);
  assert.deepEqual(tr.body.events.map((e) => e.kind), ["mark", "undo"], "the answer carries the take-back");
  await assertNotMarked(X, "(a')");
});

test("race (b): a stalled request, then the app re-sends [tap, undo]: one request records it, and it ends undone", { skip }, async () => {
  await fresh();
  A.setTapTiming({ waitMs: 300 });
  const X = cid("tap");
  const g = gate();
  let first = true;
  A.setDeskActionHooks(async (name, info) => {
    if (name === "tap:between-marks" && info.clientId === X && first) { first = false; g.reach(); await g.opened; }
  });
  const req1 = tap(X); // stalls between its two mark writes
  await g.hit;
  // The app's 15 s timeout: the same tap again, and the volunteer's Undo after it, in one batch.
  const req2 = await call("POST", "/api/checkin/desk/actions", U.val, {
    actions: [
      { clientId: X, kind: "mark", point: "checked_in", key: guestKey(TICKET), station: "desk", clientAt: at() },
      { clientId: cid("und"), kind: "undo", target: X, station: "desk", clientAt: at() },
    ],
  });
  assert.equal(req2.status, 200, JSON.stringify(req2.body));
  const [r2tap, r2undo] = req2.body.results;
  assert.equal(r2tap.status, 503, "the same tap while the first request records it: sent again later");
  assert.equal(r2tap.code, "in_flight");
  assert.equal(r2undo.ok, true, JSON.stringify(r2undo));
  g.open();
  const r1 = await req1;
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  await assertNotMarked(X, "(b)");
  // The device sends the tap again (its 503): answered from what happened, the undo included.
  const again = await tap(X);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.duplicate, true);
  assert.deepEqual(again.body.events.map((e) => e.kind), ["mark", "undo"]);
  await assertNotMarked(X, "(b) after the re-send");
  assert.equal(await M.CheckinEvent.countDocuments({ clientId: X }), 1, "recorded once");
});

test("a request that died mid-tap is taken over after the lease; a late write from it is still taken back by the undo", { skip }, async () => {
  await fresh();
  A.setTapTiming({ leaseMs: 150, waitMs: 0 });
  const X = cid("tap");
  const g = gate();
  let first = true;
  A.setDeskActionHooks(async (name, info) => {
    if (name === "tap:first-mark" && info.clientId === X && first) { first = false; g.reach(); await g.opened; }
  });
  const req1 = tap(X); // "dies" after its first write
  await g.hit;
  const busy = await tap(X);
  assert.equal(busy.status, 503, "within the lease: still being recorded");
  await sleep(200);
  const req2 = await tap(X); // after the lease: taken over and recorded
  assert.equal(req2.status, 200, JSON.stringify(req2.body));
  assert.ok(req2.body.mark?.at);
  const ur = await undo(X);
  assert.equal(ur.status, 200, JSON.stringify(ur.body));
  g.open(); // the first request wakes up and writes the rest (arrived again, the pass collected again)
  const r1 = await req1;
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  await assertNotMarked(X, "(takeover)");
});

test("a staff reset while the pass is being marked collected: the collection isn't left behind without a check-in", { skip }, async () => {
  await fresh();
  const X = cid("tap");
  const g = gate();
  A.setDeskActionHooks(async (name, info) => {
    if (name === "tap:pass-collected" && info.clientId === X) { g.reach(); await g.opened; }
  });
  const t = tap(X);
  await g.hit; // the ticket is collected; its check-in isn't tagged with it yet
  const rs = await call("POST", "/api/checkin/desk/actions", U.sam, { clientId: cid("rst"), kind: "reset", point: "arrived", key: guestKey(TICKET), station: "desk", clientAt: at() });
  assert.equal(rs.status, 200, JSON.stringify(rs.body));
  g.open();
  assert.equal((await t).status, 200);
  const rows = await M.CheckinMark.find({ subject: TICKET, day: DAY, at: { $ne: null } }).lean();
  assert.equal(rows.length, 0, "reset");
  assert.equal(!!(await M.Attendee.findOne({ ticketId: TICKET }).lean()).checkedIn, false, "the pass collection was given back");
});

test("many interleavings, both orders: an accepted undo always ends with the tap not marked", { skip }, async () => {
  const POINTS = ["tap:claimed", "tap:first-mark", "tap:between-marks", "tap:pass-collected", "tap:before-event", "tap:before-finish",
    "undo:start", "undo:before-tombstone", "undo:after-tombstone", "undo:before-clear"];
  let seed = 20261026;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  A.setTapTiming({ waitMs: 200 });
  const outcomes = { tombstoneFirst: 0, undoneAfter: 0, takenBackMidway: 0, resent: 0 };
  for (let i = 0; i < 70; i++) {
    await fresh();
    const X = cid("tap");
    const delays = Object.fromEntries(POINTS.map((p) => [p, rnd() < 0.5 ? Math.floor(rnd() * 12) : 0]));
    A.setDeskActionHooks(async (name) => { if (delays[name]) await sleep(delays[name]); });
    const point = rnd() < 0.7 ? "checked_in" : "arrived";
    const tapFirst = rnd() < 0.5;
    const gap = Math.floor(rnd() * 10);
    const resend = rnd() < 0.3; // the same tap sent twice (a retry) as well
    const go = [];
    if (tapFirst) { go.push(tap(X, point)); await sleep(gap); go.push(undo(X)); } else { go.push(undo(X)); await sleep(gap); go.push(tap(X, point)); }
    if (resend) go.push(tap(X, point));
    const res = await Promise.all(go);
    const u = tapFirst ? res[1] : res[0];
    const t = tapFirst ? res[0] : res[1];
    assert.ok([200, 503].includes(t.status), `#${i} tap ${t.status} ${JSON.stringify(t.body)}`);
    assert.equal(u.status, 200, `#${i} undo ${JSON.stringify(u.body)}`);
    // Anything the device would still send (a 503) goes again, and changes nothing.
    for (const r of res.filter((x) => x.status === 503)) { void r; await sleep(50); assert.equal((await tap(X, point)).status, 200); }
    if (u.body.tombstone && t.body.undone && !t.body.events?.length) outcomes.tombstoneFirst += 1;
    else if (t.body.undone) outcomes.takenBackMidway += 1;
    else outcomes.undoneAfter += 1;
    if (resend) outcomes.resent += 1;
    await assertNotMarked(X, `#${i} (${point}, ${tapFirst ? "tap" : "undo"} first, gap ${gap}, ${JSON.stringify(delays)})`);
  }
  // Every kind of interleaving happened.
  assert.ok(outcomes.tombstoneFirst > 0 && outcomes.undoneAfter > 0 && outcomes.takenBackMidway > 0, JSON.stringify(outcomes));
});

/* ---------- Round 4 (Oct 24 2026): a request that dies or throws after writing (the round-3 verifier's V1–V4) ---------- */

/** What the devices show for the pass: the newest event (by seq) that carries its state. */
async function devicesPassCollected() {
  const e = await M.CheckinEvent.findOne({ "pass.ticketId": TICKET, seq: { $gt: sinceSeq } }).sort({ seq: -1 }).lean();
  return e ? !!e.pass.collected : null;
}
const tapBody = (clientId, point = "checked_in") => ({ clientId, kind: "mark", point, key: guestKey(TICKET), station: point === "arrived" ? "lobby" : "desk", clientAt: at() });

test("a request that dies after writing everything (a restart mid-tap), then the app's [tap, undo]: the undo takes it all back at once", { skip }, async () => {
  await fresh();
  A.setTapTiming({ leaseMs: 300, waitMs: 100 });
  const X = cid("tap");
  const g = gate();
  A.setDeskActionHooks(async (name, info) => {
    if (name === "tap:before-event" && info.clientId === X) { g.reach(); await g.opened; } // the process "dies" here
  });
  const req1 = tap(X);
  await g.hit; // both marks set, the pass collected, no event, the tap "pending" for ever
  assert.equal(!!(await M.Attendee.findOne({ ticketId: TICKET }).lean()).checkedIn, true);
  const b = await call("POST", "/api/checkin/desk/actions", U.val, { actions: [tapBody(X), { clientId: cid("und"), kind: "undo", target: X, station: "desk", clientAt: at() }] });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const [rTap, rUndo] = b.body.results;
  assert.equal(rTap.code, "in_flight");
  assert.equal(rUndo.ok, true, JSON.stringify(rUndo));
  assert.equal(rUndo.tombstone, true);
  assert.match(rUndo.message, /still being recorded: it's taken back/);
  assert.deepEqual(rUndo.events[0].marks.map((m) => [m.point, m.at]).sort(), [["arrived", null], ["checked_in", null]], "the answer carries the rows it took back");
  assert.equal(rUndo.events[0].pass.collected, false, "and the pass given back");
  // Taken back already, though the request that wrote it never finishes.
  await assertNotMarked(X, "(dead, after the undo)");
  assert.equal(await devicesPassCollected(), false);
  await sleep(350);
  const again = await tap(X); // after the lease: never recorded
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.undone, true);
  await assertNotMarked(X, "(dead, re-sent after the lease)");
  // If it wasn't dead after all (only very slow) and finishes now: still nothing stays, and the devices' newest pass
  // state is "not collected" (its own event said "collected": the state after it follows it).
  g.open();
  const r1 = await req1;
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.undone, true);
  await assertNotMarked(X, "(the slow request finished)");
  assert.equal(await devicesPassCollected(), false, "the devices show the pass not collected");
});

test("a request that throws after collecting the pass (a database error): what it wrote is taken back before it's released; undo, then the tap again: never recorded", { skip }, async () => {
  await fresh();
  const X = cid("tap");
  let first = true;
  A.setDeskActionHooks(async (name, info) => {
    if (name === "tap:pass-collected" && info.clientId === X && first) { first = false; throw new Error("simulated MongoNetworkError"); }
  });
  const t = await tap(X);
  assert.equal(t.status, 500);
  // Nothing of it stays (no mark, the pass given back), and the devices are told (a void event with the rows).
  await assertNotMarked(X, "(after the error)");
  assert.equal((await M.CheckinTap.findById(X).lean()).state, "waiting", "released: it can be sent again");
  const v = await M.CheckinEvent.findOne({ kind: "void", seq: { $gt: sinceSeq }, "marks.0": { $exists: true } }).lean();
  assert.ok(v, "the rows it took back went out");
  assert.equal(v.pass.collected, false);
  A.setDeskActionHooks(null);
  const u = await undo(X);
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.equal(u.body.tombstone, true);
  const again = await tap(X);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.undone, true);
  await assertNotMarked(X, "(undone, re-sent)");
});

test("a request that throws between collecting the pass and its event, sent again (recorded): a staff reset gives the pass back", { skip }, async () => {
  await fresh();
  const X = cid("tap");
  let first = true;
  A.setDeskActionHooks(async (name, info) => {
    if (name === "tap:pass-collected" && info.clientId === X && first) { first = false; throw new Error("simulated MongoNetworkError"); }
  });
  assert.equal((await tap(X)).status, 500);
  A.setDeskActionHooks(null);
  const again = await tap(X);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.events[0].pass.collected, true);
  const row = await M.CheckinMark.findOne({ subject: TICKET, day: DAY, point: "checked_in" }).lean();
  assert.equal(new Date(row.passSetAt).toISOString(), at(), "the check-in owns the collection");
  const rs = await call("POST", "/api/checkin/desk/actions", U.sam, { clientId: cid("rst"), kind: "reset", point: "arrived", key: guestKey(TICKET), station: "desk", clientAt: at() });
  assert.equal(rs.status, 200, JSON.stringify(rs.body));
  assert.equal(await M.CheckinMark.countDocuments({ subject: TICKET, day: DAY, at: { $ne: null } }), 0);
  assert.equal(!!(await M.Attendee.findOne({ ticketId: TICKET }).lean()).checkedIn, false, "the pass was given back");
});

test("a request that died after collecting the pass is taken over: the new request owns that collection, so an undo gives it back", { skip }, async () => {
  await fresh();
  A.setTapTiming({ leaseMs: 150, waitMs: 0 });
  const X = cid("tap");
  const g = gate();
  let first = true;
  A.setDeskActionHooks(async (name, info) => {
    if (name === "tap:pass-collected" && info.clientId === X && first) { first = false; g.reach(); await g.opened; }
  });
  const req1 = tap(X); // collects the pass, then "dies"
  await g.hit;
  await sleep(200);
  const req2 = await tap(X); // after the lease: taken over and recorded
  assert.equal(req2.status, 200, JSON.stringify(req2.body));
  const row = await M.CheckinMark.findOne({ subject: TICKET, day: DAY, point: "checked_in" }).lean();
  assert.equal(new Date(row.passSetAt).toISOString(), at(), "the collection the dead request made is this check-in's");
  const ur = await undo(X);
  assert.equal(ur.status, 200, JSON.stringify(ur.body));
  assert.equal(ur.body.events[0].pass.collected, false);
  g.open(); // the first request wakes up: nothing it does brings the check-in or the collection back
  await req1;
  await assertNotMarked(X, "(takeover after a collection)");
});

test("someone else's undo of a tap still being recorded is refused (403 undo_refused); the tap is recorded; staff's takes it back", { skip }, async () => {
  await fresh();
  const vic = await M.User.create({ name: "Vic Volunteer", email: `vic.${cid("x")}@example.com`, role: "volunteer" });
  const X = cid("tap");
  const g = gate();
  A.setDeskActionHooks(async (name, info) => { if (name === "tap:between-marks" && info.clientId === X) { g.reach(); await g.opened; } });
  const t = tap(X);
  await g.hit;
  const u = await undo(X, vic);
  assert.equal(u.status, 403, JSON.stringify(u.body));
  assert.equal(u.body.code, "undo_refused");
  assert.equal((await M.CheckinTap.findById(X).lean()).tombs.length, 0, "no tombstone of hers is left on it");
  g.open();
  const tr = await t;
  assert.equal(tr.status, 200, JSON.stringify(tr.body));
  assert.ok(!tr.body.undone, "recorded");
  assert.ok((await M.CheckinMark.findOne({ subject: TICKET, day: DAY, point: "checked_in" }).lean()).at);
  // Staff may undo anyone's tap, also while it's being recorded (and it's audited).
  await fresh();
  const Y = cid("tap");
  const g2 = gate();
  A.setDeskActionHooks(async (name, info) => { if (name === "tap:between-marks" && info.clientId === Y) { g2.reach(); await g2.opened; } });
  const t2 = tap(Y);
  await g2.hit;
  const su = await undo(Y, U.sam);
  assert.equal(su.status, 200, JSON.stringify(su.body));
  assert.match(su.body.message, /still being recorded/);
  g2.open();
  assert.equal((await t2).status, 200);
  await assertNotMarked(Y, "(staff's undo of an in-flight tap)");
  const { AdminAudit } = await import("../models/Admin.js");
  assert.ok(await AdminAudit.findOne({ action: "checkin_desk_undo", detail: /still being recorded/ }).lean(), "audited");
});

test("what a failed try of a tap left behind is taken back when an undo or the tap again finds it undone", { skip }, async () => {
  // Rows as a try that failed AND couldn't clean up after itself leaves them: marks with its clientId, the pass
  // collected at its time, the tap released ("waiting", its author known).
  const leftovers = async (X) => {
    await fresh();
    const t = new Date(at());
    await M.CheckinMark.create([
      { subject: TICKET, day: DAY, point: "checked_in", at: t, byId: U.val._id, byName: "Val Volunteer", byRole: "volunteer", station: "desk", ref: X, passSetAt: t, rev: 1 },
      { subject: TICKET, day: DAY, point: "arrived", at: t, byId: U.val._id, byName: "Val Volunteer", byRole: "volunteer", station: "desk", ref: X, rev: 1 },
    ]);
    await M.Attendee.updateOne({ ticketId: TICKET }, { $set: { checkedIn: true, checkedInAt: t } });
    return { _id: X, state: "waiting", kind: "mark", byId: U.val._id, byRole: "volunteer", sentFromId: U.val._id, owner: null, claimedAt: null };
  };
  // (1) The volunteer's undo: the tap is undone and the leftovers go at once.
  const X = cid("tap");
  await M.CheckinTap.create(await leftovers(X));
  const u = await undo(X);
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.equal(u.body.tombstone, true);
  assert.equal(u.body.events[0].marks.length, 2);
  await assertNotMarked(X, "(leftovers, undo)");
  // (2) An undo stored earlier (a tombstone), and the tap sent again: answered "undone", the leftovers taken back.
  const Y = cid("tap");
  await M.CheckinTap.create({ ...(await leftovers(Y)), tombs: [{ byId: U.val._id, byName: "Val Volunteer", byRole: "volunteer", clientId: cid("und"), at: new Date(at()) }] });
  const again = await tap(Y);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.undone, true);
  assert.deepEqual(again.body.events.map((e) => e.kind), ["undo"]);
  await assertNotMarked(Y, "(leftovers, the tap again)");
});
