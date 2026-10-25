/* Two check-in fixes (Oct 24 2026), through the real routes and models against a real (throwaway) MongoDB:
     NETWORKING QR  staff scanned people's networking QR (the apps' Connect code, "TTFC2026|C|…|<userId>|<check>") at
                    the door, POST /api/checkin/scan: the check digit is verified, the account's pass to check in found
                    (their one counting pass; of several the Speaker Pass, else the biggest), and the scan goes on as a
                    scan of that pass (the same card, practice off the event days, already checked in); older codes
                    without a userId by their email; refusals never echo an email. The desk's look-up takes one too.
                    Door QRs (TECHFEST:…) answer exactly as before.
     UNDO CHECK-IN  POST /api/console/people/:id/passes/:ticketId/checkin-reset (management): the pass isn't collected
                    any more (account ticket and pass record), audited pass_checkin_reset with the old time, the desks
                    told (a guest event with the pass given back), the next door scan checks them in for real; staff and
                    volunteers 403; a pass that isn't checked in 409.
   Starts a local mongod in a temp folder on a free port and stops it after; skipped when the binary isn't there
   (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Nothing leaves the machine: Sanity is
   answered by a stubbed fetch, no Stripe key, no email. Fictional people, example.com. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { connectCheck } from "../services/connectQr.js";

const BIN = process.env.TTFC_TEST_MONGOD || path.join(os.homedir(), ".cache/mongodb-binaries/mongod-arm64-darwin-8.2.6");
const HAVE = fs.existsSync(BIN);
const skip = HAVE ? false : `no local mongod at ${BIN}`;

process.env.JWT_SECRET ||= "local-test-only";
process.env.RESEND_API_KEY ||= "re_dummy";
delete process.env.STRIPE_SECRET_KEY;

const realFetch = globalThis.fetch;
const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.includes(".sanity.io/")) return json({ result: [] });
  throw new Error(`blocked in the test: ${url}`);
};
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let mongod = null;
let dbDir = "";
let server = null;
let base = "";
let mongoose;
let jwt;
let guestKey;
let setDeskClock;
const DAY1_AT = new Date("2026-10-26T14:00:00Z"); // Mon Oct 26, 10:00 AM Toronto
const SUNDAY = new Date("2026-10-25T15:00:00Z"); // the dry run
const EARLIER = new Date("2026-10-23T19:02:00Z"); // a test scan on Friday
let fakeNow = DAY1_AT;
const M = {};
const U = {};

const ticket = (ticketId, type, extra = {}) => ({ ticketId, type, purchaseDate: new Date("2026-10-01"), ...extra });

/** The apps' Connect code (QRPayload.swift): plain test fields (letters, spaces, @ . need no escaping). */
function connectQr({ name = "", title = "", org = "", linkedIn = "", email = "", userId = "" }) {
  const fields = ["TTFC2026", "C", name, title, org, linkedIn, email];
  if (userId) fields.push(String(userId));
  return [...fields, connectCheck(fields)].join("|");
}
const qrOf = (u, extra = {}) => connectQr({ name: u.name, title: "Founder", org: "Acme", userId: u._id, ...extra });

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-connect-qr-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_connect_qr`, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await sleep(250); }
  }
  ({ default: jwt } = await import("jsonwebtoken"));
  ({ setDeskClock } = await import("../services/checkinDeskLog.js"));
  setDeskClock(() => new Date(fakeNow));
  ({ guestKey } = await import("../services/checkinDesk.js"));
  M.User = (await import("../models/User.js")).default;
  M.Attendee = (await import("../models/Attendee.js")).default;
  M.CheckinMark = (await import("../models/CheckinMark.js")).default;
  M.CheckinEvent = (await import("../models/CheckinEvent.js")).default;
  Object.assign(M, await import("../models/Admin.js"));
  await Promise.all([M.CheckinMark.init(), M.CheckinEvent.init(), M.User.init()]);
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/checkin/desk", (await import("../routes/checkinDesk.js")).default);
  app.use("/api/checkin", (await import("../routes/checkin.js")).default);
  app.use("/api/console/people", (await import("../routes/people.js")).default);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const mk = async (k, doc) => { U[k] = await M.User.create(doc); };
  await mk("mia", { name: "Mia Manager", email: "mia.q@example.com", role: "admin", staffRole: "management" });
  await mk("dee", { name: "Dee Door", email: "dee.q@example.com", role: "admin", staffRole: "staff" });
  await mk("val", { name: "Val Volunteer", email: "val.q@example.com", role: "volunteer" });
  // One pass on the account.
  await mk("cara", { name: "Cara Connect", email: "cara.q@example.com", jobTitle: "CTO", organization: "Acme", tickets: [ticket("cqr400000001", "power")] });
  // Several passes: a Connect and a Power on the account, and a Speaker Pass she claimed: the Speaker Pass is used.
  await mk("nia", { name: "Nia Speaker", email: "nia.q@example.com", tickets: [ticket("cqr400000002", "connect"), ticket("cqr400000004", "power")] });
  // Several, no speaker: the biggest (Apex) is used; a hidden Apex never counts.
  await mk("ola", { name: "Ola Owner", email: "ola.q@example.com", tickets: [ticket("cqr400000005", "connect"), ticket("cqr400000006", "apex"), ticket("cqr400000007", "apex", { hiddenByStaff: true })] });
  // No pass that counts: none at all, or only one hidden by staff.
  await mk("noa", { name: "Noa Nopass", email: "noa.q@example.com" });
  await mk("hal", { name: "Hal Hidden", email: "hal.q@example.com", tickets: [ticket("cqr400000008", "connect", { hiddenByStaff: true })] });
  // An older app's code (no userId): found by exactly the account's email.
  await mk("lee", { name: "Lee Legacy", email: "lee.q@example.com", tickets: [ticket("cqr400000009", "influence")] });
  // The practice account (Sunday's dry run).
  await mk("pia", { name: "Pia Practice", email: "pia.q@example.com", tickets: [ticket("cqr400000010", "connect")] });
  // A door QR, as before.
  await mk("dor", { name: "Dora Door", email: "dora.q@example.com", tickets: [ticket("cqr400000011", "influence")] });
  // Collected by test scans before the event (undo check-in).
  await mk("ron", { name: "Ron Reset", email: "ron.q@example.com", tickets: [ticket("rst400000001", "power", { checkedIn: true, checkedInAt: EARLIER })] });
  await mk("tim", { name: "Tim Notin", email: "tim.q@example.com", tickets: [ticket("rst400000002", "connect")] });
  await M.Attendee.create([
    { name: "Nia Speaker", email: "nia.q@example.com", ticketId: "cqr400000003", ticketType: "speaker", promoCode: "SPEAKER", claimedBy: U.nia._id },
    // Ron's ticket's claimed pass record, collected too.
    { name: "Ron Reset", email: "ron.q@example.com", ticketId: "rst400000001", ticketType: "power", claimedBy: U.ron._id, checkedIn: true, checkedInAt: EARLIER },
    // A pass-only guest collected by a test scan.
    { name: "Gia Guest", email: "gia.q@example.com", ticketId: "rst400000003", ticketType: "influence", checkedIn: true, checkedInAt: EARLIER },
  ]);
});

after(async () => {
  // The desk's records are written after each scan's answer: let the last ones land before the database goes.
  if (M.CheckinEvent) {
    let last = -1;
    for (let i = 0; i < 40; i++) {
      const n = (await M.CheckinMark.countDocuments({})) + (await M.CheckinEvent.countDocuments({}));
      if (n === last) break;
      last = n;
      await sleep(100);
    }
  }
  setDeskClock?.(null);
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const tokenFor = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function call(method, p, { as = U.dee, body } = {}) {
  const headers = { "content-type": "application/json", authorization: `Bearer ${tokenFor(as)}` };
  const r = await realFetch(`${base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j };
}
const scan = (ticketId, as = U.dee) => call("POST", "/api/checkin/scan", { as, body: { ticketId } });
const ticketOf = async (u, ticketId) => {
  const doc = await M.User.findById(u._id).lean();
  const t = doc.tickets.find((x) => x.ticketId === ticketId);
  return { checkedIn: !!t.checkedIn, checkedInAt: t.checkedInAt || null };
};
const guestOf = async (ticketId) => {
  const a = await M.Attendee.findOne({ ticketId }).lean();
  return { checkedIn: !!a.checkedIn, checkedInAt: a.checkedInAt || null };
};
const NOT_COLLECTED = { checkedIn: false, checkedInAt: null };
/** The door's desk event for a scan (written after the answer). */
async function scanEvent(ticketId) {
  for (let i = 0; i < 80; i++) {
    const ev = await M.CheckinEvent.findOne({ subject: ticketId, kind: "mark", station: "scanner" }).sort({ seq: -1 }).lean();
    if (ev) return ev;
    await sleep(25);
  }
  return null;
}

/* ---------- The networking QR at the door ---------- */

test("networking QR: the account's one pass is checked in, the same card as its door QR, then already checked in", { skip }, async () => {
  fakeNow = DAY1_AT;
  const r = await scan(qrOf(U.cara));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.status, r.body.ticketId, r.body.scanned, r.body.passCount, "note" in r.body], ["success", "cqr400000001", "networking_qr", 1, false]);
  assert.deepEqual([r.body.name, r.body.title, r.body.company, r.body.passName, r.body.badge?.key], ["Cara Connect", "CTO", "Acme", "Power Pass", "pass"]);
  assert.equal((await ticketOf(U.cara, "cqr400000001")).checkedIn, true);
  const ev = await scanEvent("cqr400000001");
  assert.deepEqual([ev?.practice, ev?.pass?.collected], [undefined, true]);
  // Again (the networking QR or the door QR): amber, the same card.
  const again = await scan(qrOf(U.cara));
  assert.deepEqual([again.status, again.body.status, again.body.ticketId, again.body.name, again.body.scanned], [200, "already_checked_in", "cqr400000001", "Cara Connect", "networking_qr"]);
  const door = await scan("TECHFEST:cqr400000001");
  assert.deepEqual([door.body.status, door.body.name, "scanned" in door.body], ["already_checked_in", "Cara Connect", false]);
});

test("networking QR: several passes → the Speaker Pass (else the biggest), and the answer says so", { skip }, async () => {
  fakeNow = DAY1_AT;
  const nia = await scan(qrOf(U.nia));
  assert.equal(nia.status, 200, JSON.stringify(nia.body));
  assert.deepEqual([nia.body.status, nia.body.ticketId, nia.body.passName, nia.body.passCount], ["success", "cqr400000003", "Speaker Pass", 3]);
  assert.match(nia.body.note, /3 passes, so their Speaker Pass/);
  assert.equal((await guestOf("cqr400000003")).checkedIn, true);
  assert.deepEqual(await ticketOf(U.nia, "cqr400000002"), NOT_COLLECTED);
  assert.deepEqual(await ticketOf(U.nia, "cqr400000004"), NOT_COLLECTED);

  const ola = await scan(qrOf(U.ola));
  assert.deepEqual([ola.status, ola.body.status, ola.body.ticketId, ola.body.passName, ola.body.passCount], [200, "success", "cqr400000006", "Apex Pass", 2]);
  assert.match(ola.body.note, /2 passes, so their Apex Pass/);
  assert.deepEqual(await ticketOf(U.ola, "cqr400000007"), NOT_COLLECTED);
});

test("networking QR: an edited code is invalid; no pass that counts is not found; nothing written, no email echoed", { skip }, async () => {
  fakeNow = DAY1_AT;
  const good = qrOf(U.dor);
  const edited = good.replace("Dora Door", "Dora Doors");
  const bad = await scan(edited);
  assert.deepEqual([bad.status, bad.body.status, bad.body.code], [404, "invalid", "bad_qr"]);
  for (const k of ["badge", "name", "ticketId"]) assert.equal(k in bad.body, false, k);
  const wrongDigit = await scan(good.replace(/\|[0-9a-f]{6}$/, "|000000"));
  assert.deepEqual([wrongDigit.status, wrongDigit.body.code], [404, "bad_qr"]);
  assert.deepEqual(await ticketOf(U.dor, "cqr400000011"), NOT_COLLECTED);

  for (const u of [U.noa, U.hal]) {
    const r = await scan(qrOf(u, { email: u.email }));
    assert.deepEqual([r.status, r.body.status, r.body.code], [404, "invalid", "no_pass"], u.name);
    assert.doesNotMatch(JSON.stringify(r.body), /@/);
  }
  assert.deepEqual(await ticketOf(U.hal, "cqr400000008"), NOT_COLLECTED);
  // A userId no account has.
  const gone = await scan(connectQr({ name: "Gone", userId: "0123456789abcdef01234567", email: "gone.q@example.com" }));
  assert.deepEqual([gone.status, gone.body.code], [404, "networking_qr"]);
  assert.doesNotMatch(JSON.stringify(gone.body), /@/);
});

test("networking QR: an older code (no userId) by its email; without one it asks for the entry pass QR", { skip }, async () => {
  fakeNow = DAY1_AT;
  const r = await scan(connectQr({ name: "Lee Legacy", email: "Lee.Q@example.com" }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.status, r.body.ticketId, r.body.name, r.body.scanned], ["success", "cqr400000009", "Lee Legacy", "networking_qr"]);
  assert.equal((await ticketOf(U.lee, "cqr400000009")).checkedIn, true);

  const none = await scan(connectQr({ name: "Lee Legacy", org: "Acme" }));
  assert.deepEqual([none.status, none.body.status, none.body.code, none.body.message],
    [404, "invalid", "networking_qr", "That's their networking QR. Ask for the entry pass QR (app › Pass, or the email/PDF)."]);
  const unknown = await scan(connectQr({ name: "Who", email: "nobody.q@example.com" }));
  assert.deepEqual([unknown.status, unknown.body.code], [404, "networking_qr"]);
  assert.doesNotMatch(JSON.stringify(unknown.body), /@/);
});

test("networking QR: on a day that isn't Day 1 / Day 2 it's a practice scan (the card, nothing written)", { skip }, async () => {
  fakeNow = SUNDAY;
  try {
    const r = await scan(qrOf(U.pia), U.val);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.status, r.body.practice, r.body.ticketId, r.body.alreadyCheckedIn, r.body.name, r.body.scanned],
      ["practice", true, "cqr400000010", false, "Pia Practice", "networking_qr"]);
    assert.deepEqual(await ticketOf(U.pia, "cqr400000010"), NOT_COLLECTED);
    const ev = await scanEvent("cqr400000010");
    assert.deepEqual([ev?.practice, ev?.pass?.collected], [true, false]);
  } finally {
    fakeNow = DAY1_AT;
  }
});

test("door QR: unchanged (TECHFEST:, any case) — no networking fields", { skip }, async () => {
  fakeNow = DAY1_AT;
  const r = await scan("techfest:CQR400000011 ");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.status, r.body.ticketId, r.body.name, "scanned" in r.body, "passCount" in r.body], ["success", "cqr400000011", "Dora Door", false, false]);
  const unknown = await scan("TECHFEST:ffffffffffff");
  assert.deepEqual([unknown.status, unknown.body.status, "code" in unknown.body], [404, "invalid", false]);
});

test("desk look-up: a networking QR finds the guest's pass; an edited one is refused", { skip }, async () => {
  fakeNow = DAY1_AT;
  const r = await call("POST", "/api/checkin/desk/lookup", { as: U.val, body: { ticketId: qrOf(U.ola) } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.key, guestKey("cqr400000006"));
  const bad = await call("POST", "/api/checkin/desk/lookup", { as: U.val, body: { ticketId: qrOf(U.ola).replace("Ola", "Olaf") } });
  assert.deepEqual([bad.status, bad.body.code], [404, "bad_qr"]);
  const none = await call("POST", "/api/checkin/desk/lookup", { as: U.val, body: { ticketId: connectQr({ name: "Lee" }) } });
  assert.deepEqual([none.status, none.body.code], [404, "networking_qr"]);
  // A typed ticket ID, as before.
  const typed = await call("POST", "/api/checkin/desk/lookup", { as: U.val, body: { ticketId: "CQR400000011" } });
  assert.deepEqual([typed.status, typed.body.key], [200, guestKey("cqr400000011")]);
});

/* ---------- Undo check-in (Admin › People) ---------- */

const reset = (personId, ticketId, as = U.mia) =>
  call("POST", `/api/console/people/${encodeURIComponent(personId)}/passes/${encodeURIComponent(ticketId)}/checkin-reset`, { as });

test("undo check-in: staff and volunteers can't; a pass that isn't checked in is 409", { skip }, async () => {
  const staff = await reset(`u-${U.ron._id}`, "rst400000001", U.dee);
  assert.equal(staff.status, 403, JSON.stringify(staff.body));
  const vol = await reset(`u-${U.ron._id}`, "rst400000001", U.val);
  assert.equal(vol.status, 403, JSON.stringify(vol.body));
  assert.equal((await ticketOf(U.ron, "rst400000001")).checkedIn, true);
  const notIn = await reset(`u-${U.tim._id}`, "rst400000002");
  assert.deepEqual([notIn.status, notIn.body.code], [409, "not_checked_in"]);
  const noPass = await reset(`u-${U.tim._id}`, "zzz999999999");
  assert.equal(noPass.status, 404);
  assert.equal(await M.AdminAudit.countDocuments({ action: "pass_checkin_reset" }), 0);
});

test("undo check-in: management takes the collection back everywhere, audited, the desks told; the next scan checks in for real", { skip }, async () => {
  fakeNow = DAY1_AT;
  // On the day, before the fix, the scan is amber and the desk says "Has pass".
  const amber = await scan("TECHFEST:rst400000001");
  assert.equal(amber.body.status, "already_checked_in");
  await scanEvent("rst400000001");
  const before = await call("GET", "/api/checkin/desk/snapshot", { as: U.dee });
  assert.equal(before.status, 200, JSON.stringify(before.body));
  const rowBefore = before.body.guests.find((g) => g.name === "Ron Reset");
  assert.equal(rowBefore.passCollected, true);
  const cursor = before.body.cursor;

  const r = await reset(`u-${U.ron._id}`, "RST400000001");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.ok, r.body.ticketId, r.body.checkedIn, new Date(r.body.wasCheckedInAt).getTime()], [true, "rst400000001", false, EARLIER.getTime()]);
  const passNow = r.body.person.passes.find((t) => t.ticketId === "rst400000001");
  assert.deepEqual([passNow.checkedIn, passNow.checkedInAt], [false, null]);
  assert.equal(r.body.deskGuest?.passCollected, false);
  assert.deepEqual(await ticketOf(U.ron, "rst400000001"), NOT_COLLECTED);
  assert.deepEqual(await guestOf("rst400000001"), NOT_COLLECTED);
  const a = await M.AdminAudit.findOne({ action: "pass_checkin_reset" }).lean();
  assert.ok(a, "audited");
  assert.deepEqual([a.targetType, a.targetId, String(a.adminId)], ["ticket", "rst400000001", String(U.mia._id)]);
  assert.ok(a.detail.includes(EARLIER.toISOString()), a.detail);
  assert.match(a.detail, /Ron Reset/);

  // The desks: a guest event with the row and the pass given back, newer than the scan's "collected".
  const evs = await call("GET", `/api/checkin/desk/events?since=${cursor}`, { as: U.val });
  assert.equal(evs.status, 200);
  const ev = evs.body.events.find((e) => e.kind === "guest" && e.key === guestKey("rst400000001"));
  assert.ok(ev, JSON.stringify(evs.body.events));
  assert.deepEqual([ev.pass?.key, ev.pass?.collected, ev.guest?.passCollected], [guestKey("rst400000001"), false, false]);
  const after = await call("GET", "/api/checkin/desk/snapshot", { as: U.dee });
  const rowAfter = after.body.guests.find((g) => g.name === "Ron Reset");
  assert.deepEqual([rowAfter.passCollected, rowAfter.passCollectedAt], [false, null]);

  // Undone again: nothing to undo.
  const twice = await reset(`u-${U.ron._id}`, "rst400000001");
  assert.deepEqual([twice.status, twice.body.code], [409, "not_checked_in"]);

  // Monday's scan: checked in now, green.
  const green = await scan("TECHFEST:rst400000001");
  assert.deepEqual([green.status, green.body.status], [200, "success"]);
  assert.equal((await ticketOf(U.ron, "rst400000001")).checkedIn, true);
  assert.equal((await guestOf("rst400000001")).checkedIn, true);
});

test("undo check-in: a pass-only guest (no account), by the ticket's person id", { skip }, async () => {
  const r = await reset("t-rst400000003", "rst400000003");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.ticketId, new Date(r.body.wasCheckedInAt).getTime()], ["rst400000003", EARLIER.getTime()]);
  assert.deepEqual(await guestOf("rst400000003"), NOT_COLLECTED);
  assert.ok(await M.CheckinEvent.findOne({ kind: "guest", "pass.ticketId": "rst400000003", "pass.collected": false }).lean());
});
