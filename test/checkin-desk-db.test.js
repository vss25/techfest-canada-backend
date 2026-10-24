/* TTFC Check-in desk app (/api/checkin/desk) through the real routes and models, against a real (throwaway) MongoDB:
   who may do what (no sign-in, an attendee, a volunteer, staff, staff signed in by email code), the lobby → pass desk
   flow (arrived, checked in, undo, reset) kept in step with the ticket's checkedIn / checkedInAt and the door's QR
   scanner, the same tap sent twice, per-day marks (Day 2 keeps the pass collected on Day 1), the station windows
   (outside them: refused, then "Admit anyway" stored as an audited override), meal entitlement and no double admits,
   inclusion and Media edits through Admin › People reaching the desks, booths, media queries, the live stream's
   cursor catch-up and the polling fallback, and that nothing is emailed.
   Starts a local mongod in a temp folder on a free port and stops it after; skipped when the binary isn't there
   (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Nothing leaves the machine: Sanity
   answers an empty list (so the desk uses the agenda's fallback times), Resend is counted and never reached, no
   Stripe key. The desk's clock is set (setDeskClock). Fictional people, example.com. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const BIN = process.env.TTFC_TEST_MONGOD || path.join(os.homedir(), ".cache/mongodb-binaries/mongod-arm64-darwin-8.2.6");
const HAVE = fs.existsSync(BIN);
const skip = HAVE ? false : `no local mongod at ${BIN}`;

process.env.JWT_SECRET ||= "local-test-only";
process.env.RESEND_API_KEY ||= "re_dummy";
delete process.env.STRIPE_SECRET_KEY;

let resendCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.startsWith("https://api.resend.com/")) { resendCalls += 1; return new Response(JSON.stringify({ id: "stub" }), { status: 200, headers: { "content-type": "application/json" } }); }
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
let setDeskClock;
let guestKey;
let Log;
let Other;
const U = {};
let fakeNow = new Date("2026-10-26T13:00:00Z"); // Day 1, 9:00 AM Toronto
let seq = 0;
const cid = (p = "t") => `${p}${Date.now().toString(36)}${(seq++).toString(36).padStart(4, "0")}`;

const ticket = (ticketId, type, extra = {}) => ({ ticketId, type, purchaseDate: new Date("2026-10-01"), ...extra });

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-desk-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_desk_test`, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  ({ default: jwt } = await import("jsonwebtoken"));
  ({ setDeskClock } = await import("../services/checkinDeskLog.js"));
  Log = await import("../services/checkinDeskLog.js");
  // A second server instance's log (its own streams and tail, the same database), for the multi-instance tests.
  Other = await import("../services/checkinDeskLog.js?instance=b");
  Other.setDeskClock(() => new Date(fakeNow));
  ({ guestKey } = await import("../services/checkinDesk.js"));
  setDeskClock(() => new Date(fakeNow));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.Attendee = await imp("../models/Attendee.js");
  M.CheckinMark = await imp("../models/CheckinMark.js");
  M.CheckinEvent = await imp("../models/CheckinEvent.js");
  M.CheckinCounter = (await import("../models/CheckinEvent.js")).CheckinCounter;
  Object.assign(M, await import("../models/Admin.js"));
  await Promise.all([M.CheckinMark.init(), M.CheckinEvent.init(), M.User.init()]);
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/checkin/desk", (await import("../routes/checkinDesk.js")).default);
  app.use("/api/checkin", (await import("../routes/checkin.js")).default);
  app.use("/api/console/people", (await import("../routes/people.js")).default);
  app.use("/api/auth", (await import("../routes/ticketAuth.js")).default);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const mk = (key, doc) => M.User.create(doc).then((u) => { U[key] = u; });
  await Promise.all([
    mk("mia", { name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management" }),
    mk("sam", { name: "Sam Staff", email: "sam.staff@example.com", role: "admin", staffRole: "staff" }),
    mk("val", { name: "Val Volunteer", email: "val.volunteer@example.com", role: "volunteer" }),
    mk("vic", { name: "Vic Volunteer", email: "vic.volunteer@example.com", role: "volunteer" }),
    mk("ada", { name: "Ada Attendee", email: "ada.attendee@example.com", tickets: [ticket("apx100000010", "apex")] }),
    mk("priya", { name: "Priya Sharma", email: "priya.sharma@example.com", organization: "Northwind", jobTitle: "CTO", tickets: [ticket("pow100000001", "power", { stripeSessionId: "cs_p" })] }),
    // An attendee account staff tagged Volunteer in People (contract C1), holding a pass.
    mk("tara", { name: "Tara Typed", email: "tara.typed@example.com", types: ["volunteer"], tickets: [ticket("vol100000020", "connect", { stripeSessionId: "cs_t" })] }),
    // A speaker with a Speaker Pass and a Power Pass of their own (attendance counts them once).
    mk("sid", { name: "Sid Speaker", email: "sid.speaker@example.com", tickets: [ticket("spk100000023", "speaker"), ticket("pow100000024", "power", { stripeSessionId: "cs_s" })] }),
  ]);
  await M.Attendee.create([
    { name: "Priya Sharma", email: "priya.sharma@example.com", ticketId: "pow100000001", ticketType: "power", claimedBy: U.priya._id, stripeSessionId: "cs_p" },
    { name: "Gus Guest", email: "gus.guest@example.com", ticketId: "con100000002", ticketType: "connect", stripeSessionId: "cs_g", details: { firstName: "Gus", lastName: "Guest", organisation: "Acme" } },
    { name: "Mo Media", email: "mo.media@example.com", ticketId: "con100000003", ticketType: "connect", media: true, stripeSessionId: "cs_m" },
    { name: "Vera Vip", email: "vera.vip@example.com", ticketId: "pow100000004", ticketType: "power", vip: true, stripeSessionId: "cs_v" },
    { name: "Nina Speaker", email: "nina.speaker@example.com", ticketId: "spk100000005", ticketType: "speaker", promoCode: "SPEAKER", passEmailSentAt: new Date("2026-10-10") },
    { name: "Eve Exhibitor", email: "eve.exhibitor@example.com", ticketId: "exh100000006", ticketType: "connect", promoCode: "EXHIBITOR", passEmailSentAt: new Date("2026-10-10"), issuedPass: { booth: { booth: "A12", zone: "", passes: "" } }, details: { organisation: "Boothco" } },
    { name: "Ed Exhibitor", email: "ed.exhibitor@example.com", ticketId: "exh100000007", ticketType: "connect", promoCode: "EXHIBITOR", passEmailSentAt: new Date("2026-10-10"), issuedPass: { booth: { booth: "A12", zone: "", passes: "" } }, details: { organisation: "Boothco" } },
    { name: "Hal Hidden", email: "hal.hidden@example.com", ticketId: "apx100000008", ticketType: "apex", hiddenByStaff: true },
    { name: "Ian Influence", email: "ian.influence@example.com", ticketId: "inf100000009", ticketType: "influence", stripeSessionId: "cs_i" },
    { name: "Dot Discover", email: "dot.discover@example.com", ticketId: "dis100000011", ticketType: "discover", stripeSessionId: "cs_d" },
    { name: "Pat Pending", email: "pat.pending@example.com", ticketId: "spk100000012", ticketType: "speaker", promoCode: "SPEAKER" },
    { name: "Tom Tomb", email: "tom.tomb@example.com", ticketId: "tom100000021", ticketType: "connect", stripeSessionId: "cs_tt" },
    { name: "Quinn Queued", email: "quinn.queued@example.com", ticketId: "qqq100000022", ticketType: "connect", stripeSessionId: "cs_q" },
    { name: "Pru Practice", email: "pru.practice@example.com", ticketId: "prc100000025", ticketType: "connect", stripeSessionId: "cs_pr" },
    { name: "Lena Late", email: "lena.late@example.com", ticketId: "apx100000026", ticketType: "apex", stripeSessionId: "cs_l" },
    { name: "Mona Meal", email: "mona.meal@example.com", ticketId: "con100000027", ticketType: "connect", stripeSessionId: "cs_mm" },
    // Ava bought a Connect Pass; staff then gave her a Power Pass (emailed, not claimed yet). Her main pass is the paid one.
    { name: "Ava Twopass", email: "ava.twopass@example.com", ticketId: "con100000028", ticketType: "connect", stripeSessionId: "cs_a", purchaseDate: new Date("2026-09-01") },
    { name: "Ava Twopass", email: "ava.twopass@example.com", ticketId: "pow100000029", ticketType: "power", promoCode: "ISSUED", passEmailSentAt: new Date("2026-10-10"), purchaseDate: new Date("2026-10-10") },
  ]);
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const tokenFor = (u, extra = {}) => jwt.sign({ id: String(u._id), ...extra }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function call(method, p, { as = U.sam, token, body } = {}) {
  const headers = { "content-type": "application/json" };
  const tok = token === undefined ? (as ? tokenFor(as) : "") : token;
  if (tok) headers.authorization = `Bearer ${tok}`;
  const r = await realFetch(`${base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const D = "/api/checkin/desk";
const act = (body, as = U.val) => call("POST", `${D}/actions`, { as, body: { clientAt: fakeNow.toISOString(), ...body } });
const K = (id) => guestKey(id);
const ticketOf = async (id) => {
  const a = await M.Attendee.findOne({ ticketId: id }).lean();
  return { checkedIn: !!a?.checkedIn, checkedInAt: a?.checkedInAt || null };
};
const markOf = (subject, point, day = "2026-10-26") => M.CheckinMark.findOne({ subject, day, point }).lean();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Polls `fn` until it gives something truthy (at most `ms`). */
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v || Date.now() - t0 > ms) return v;
    await sleep(25);
  }
}

test("who may use it: no sign-in 401, attendees 403, volunteers without emails or ticket IDs, staff with them", { skip }, async () => {
  assert.equal((await call("GET", `${D}/snapshot`, { as: null })).status, 401);
  assert.equal((await call("GET", `${D}/snapshot`, { as: U.ada })).status, 403);
  const vol = await call("GET", `${D}/snapshot`, { as: U.val });
  assert.equal(vol.status, 200, JSON.stringify(vol.body));
  assert.equal(vol.body.staff, false);
  assert.equal(vol.body.user.role, "volunteer");
  const names = vol.body.guests.map((g) => g.name);
  assert.ok(names.includes("Priya Sharma") && names.includes("Gus Guest") && names.includes("Mo Media"));
  assert.ok(!names.includes("Hal Hidden"), "a pass staff hid isn't a guest");
  assert.ok(!names.includes("Sam Staff"), "staff without a pass aren't guests");
  for (const g of vol.body.guests) {
    for (const k of ["email", "ticketId", "ticketIds", "personId", "extrasView", "norm", "norms"]) assert.ok(!(k in g), `${g.name}: volunteers never get ${k}`);
    assert.match(g.key, /^g[0-9a-f]{20}$/);
  }
  assert.ok(!JSON.stringify(vol.body).includes("@example.com"), "no email anywhere in a volunteer's snapshot");
  assert.ok(!JSON.stringify(vol.body).includes("con100000002"), "no ticket ID anywhere in a volunteer's snapshot");

  const staff = await call("GET", `${D}/snapshot`, { as: U.sam });
  assert.equal(staff.body.staff, true);
  const gus = staff.body.guests.find((g) => g.name === "Gus Guest");
  assert.equal(gus.email, "gus.guest@example.com");
  assert.equal(gus.ticketId, "con100000002");
  // Contract C1: a passwordless token (emailed code, pass ID + last name) never reaches the desk, staff's included.
  for (const via of ["email", "ticket"]) {
    const no = await call("GET", `${D}/snapshot`, { token: tokenFor(U.sam, { via }) });
    assert.equal(no.status, 403, via);
    assert.equal(no.body.code, "password_required");
    assert.equal(no.body.error, "This app needs your staff or volunteer password sign-in.");
  }
});

test("the guests: pass types (Other for an unknown one), Media / VIP / Exhibitor marks, pending, booths, today", { skip }, async () => {
  const s = (await call("GET", `${D}/snapshot`, { as: U.sam })).body;
  const by = Object.fromEntries(s.guests.map((g) => [g.name, g]));
  assert.equal(by["Priya Sharma"].tier, "power");
  assert.equal(by["Priya Sharma"].passName, "Power Pass");
  assert.equal(by["Mo Media"].tier, "connect");
  assert.equal(by["Mo Media"].marks.media, true);
  // Media = Yes: Power Pass privileges with the CxO Breakfasts on any pass (services/passExtras.js): the desk reads it.
  assert.deepEqual(by["Mo Media"].extras, { cxo: true, lunch: true, gala: true, awards: true });
  assert.deepEqual(by["Gus Guest"].extras, { cxo: false, lunch: false, gala: false, awards: false });
  assert.equal(by["Vera Vip"].marks.vip, true);
  assert.equal(by["Nina Speaker"].tier, "speaker");
  assert.equal(by["Nina Speaker"].marks.speaker, true);
  assert.equal(by["Eve Exhibitor"].marks.exhibitor, true);
  assert.equal(by["Eve Exhibitor"].booth, "A12");
  assert.equal(by["Dot Discover"].tier, "other");
  assert.equal(by["Dot Discover"].passName, "Other: Discover");
  assert.equal(by["Pat Pending"].pending, true);
  assert.equal(by["Gus Guest"].pending, false);
  assert.deepEqual(s.booths.map((b) => [b.booth, b.guests.length]), [["A12", 2]]);
  assert.equal(s.today.eventDay, "day1");
  assert.equal(s.today.date, "2026-10-26");
  assert.equal(s.stationStates.lobby.open, true);
  assert.equal(s.stationStates.breakfast.open, true, s.stationStates.breakfast.text);
  assert.match(s.stationStates.breakfast.detail, /CxO Breakfast 7:55–8:55 AM \(agenda as of Oct 23\) · doors 7:25–9:25 AM/);
  assert.equal(s.agendaRead, false);
});

test("lobby → pass desk: arrived, checked in (the ticket's checkedIn too), a second tap, undo, reset", { skip }, async () => {
  const key = K("pow100000001");
  const a1 = await act({ clientId: cid("arr"), kind: "mark", point: "arrived", key, station: "lobby" });
  assert.equal(a1.status, 200, JSON.stringify(a1.body));
  assert.equal(a1.body.events[0].kind, "mark");
  assert.equal(a1.body.events[0].point, "arrived");
  assert.equal(a1.body.events[0].marks[0].key, key);
  assert.equal(a1.body.events[0].by.name, "Val Volunteer");
  // Another volunteer taps Arrived too: told who did it, nothing counted twice.
  const a2 = await act({ clientId: cid("arr"), kind: "mark", point: "arrived", key, station: "lobby" }, U.vic);
  assert.equal(a2.body.already, true);
  assert.match(a2.body.message, /^Already marked arrived at 9:00 AM by Val Volunteer$/);
  assert.equal(await M.CheckinMark.countDocuments({ subject: "pow100000001", point: "arrived" }), 1);

  fakeNow = new Date("2026-10-26T13:00:40Z");
  const ci = cid("chk");
  const c1 = await act({ clientId: ci, kind: "mark", point: "checked_in", key, station: "desk" }, U.vic);
  assert.equal(c1.status, 200, JSON.stringify(c1.body));
  assert.equal(c1.body.events[0].pass.collected, true);
  const u = await M.User.findById(U.priya._id).lean();
  assert.equal(u.tickets[0].checkedIn, true);
  assert.equal(new Date(u.tickets[0].checkedInAt).toISOString(), "2026-10-26T13:00:40.000Z");
  assert.equal((await ticketOf("pow100000001")).checkedIn, true, "the claimed guest record follows");
  // The door scanner now says "already checked in" with the desk's time.
  const scan = await call("POST", "/api/checkin/scan", { as: U.val, body: { ticketId: "pow100000001" } });
  assert.equal(scan.body.status, "already_checked_in");
  assert.equal(new Date(scan.body.time).toISOString(), "2026-10-26T13:00:40.000Z");

  // Vic undoes his own check-in within 15 s: the pass is no longer collected, the arrival (Val's) stays.
  fakeNow = new Date("2026-10-26T13:00:48Z");
  const un = await act({ clientId: cid("undo"), kind: "undo", ref: ci, station: "desk" }, U.vic);
  assert.equal(un.status, 200, JSON.stringify(un.body));
  assert.equal(un.body.events[0].kind, "undo");
  assert.equal(un.body.events[0].pass.collected, false);
  assert.equal((await M.User.findById(U.priya._id).lean()).tickets[0].checkedIn, false);
  assert.equal((await ticketOf("pow100000001")).checkedIn, false);
  assert.equal((await markOf("pow100000001", "checked_in")).at, null);
  assert.ok((await markOf("pow100000001", "arrived")).at, "the lobby's arrival stays");
  // Val can't undo Vic's tap; nor her own after the window.
  const ci2 = cid("chk");
  await act({ clientId: ci2, kind: "mark", point: "checked_in", key, station: "desk" }, U.vic);
  assert.equal((await act({ clientId: cid("undo"), kind: "undo", ref: ci2, station: "desk" }, U.val)).status, 403);
  fakeNow = new Date("2026-10-26T13:02:00Z");
  const late = await call("POST", `${D}/actions`, { as: U.vic, body: { clientId: cid("undo"), kind: "undo", ref: ci2, station: "desk", clientAt: fakeNow.toISOString() } });
  assert.equal(late.status, 409);
  // Volunteers can't reset; staff can, and that's audited. Reset to not arrived clears the check-in and gives the pass back.
  assert.equal((await act({ clientId: cid("rst"), kind: "reset", point: "arrived", key, station: "desk" }, U.val)).status, 403);
  const rs = await act({ clientId: cid("rst"), kind: "reset", point: "arrived", key, station: "desk" }, U.sam);
  assert.equal(rs.status, 200, JSON.stringify(rs.body));
  assert.equal(rs.body.events[0].marks.length, 2);
  assert.equal((await M.User.findById(U.priya._id).lean()).tickets[0].checkedIn, false);
  const audit = await M.AdminAudit.findOne({ action: "checkin_desk_reset" }).lean();
  assert.match(audit.detail, /Priya Sharma · Power Pass: cleared Arrived \(Pass desk\)/);
});

test("the same tap twice (a retry, the offline queue) is done once", { skip }, async () => {
  const key = K("con100000002");
  const id = cid("dup");
  const one = await act({ clientId: id, kind: "mark", point: "arrived", key, station: "lobby" });
  const two = await act({ clientId: id, kind: "mark", point: "arrived", key, station: "lobby" });
  assert.equal(one.status, 200);
  assert.equal(two.body.duplicate, true);
  assert.equal(two.body.events[0].seq, one.body.events[0].seq);
  // A batch with the same tap twice, in order.
  const id2 = cid("dup");
  const b = await call("POST", `${D}/actions`, { as: U.val, body: { actions: [
    { clientId: id2, kind: "mark", point: "checked_in", key, station: "desk", clientAt: fakeNow.toISOString() },
    { clientId: id2, kind: "mark", point: "checked_in", key, station: "desk", clientAt: fakeNow.toISOString() },
    { clientId: "bad", kind: "mark" },
  ] } });
  assert.equal(b.status, 200);
  assert.equal(b.body.results[0].ok, true);
  assert.equal(b.body.results[1].duplicate, true);
  assert.equal(b.body.results[2].ok, false);
  assert.equal(await M.CheckinEvent.countDocuments({ clientId: { $in: [id, id2] } }), 2);
  assert.equal(await M.CheckinMark.countDocuments({ subject: "con100000002", point: "checked_in", at: { $ne: null } }), 1);
});

test("meals: today's item must be on the pass, one admit a day, outside the window needs Admit anyway (audited)", { skip }, async () => {
  fakeNow = new Date("2026-10-26T12:30:00Z"); // 8:30 AM: breakfast open
  // Gus (Connect): no breakfast; volunteers are told to send him to staff.
  const no = await act({ clientId: cid("brk"), kind: "mark", point: "cxo", key: K("con100000002"), station: "breakfast" });
  assert.equal(no.status, 409);
  assert.equal(no.body.code, "not_included");
  assert.match(no.body.error, /Not on their pass: CxO Breakfast\. Send them to a staff member\./);
  // A volunteer flags him: "Sent to staff".
  const flag = await act({ clientId: cid("flg"), kind: "mark", point: "flag_cxo", key: K("con100000002"), station: "breakfast" });
  assert.equal(flag.status, 200, JSON.stringify(flag.body));
  // Vera (VIP: the CxO Breakfasts on any pass) is admitted; a second admit is "Already admitted at 8:30 AM".
  const yes = await act({ clientId: cid("brk"), kind: "mark", point: "cxo", key: K("pow100000004"), station: "breakfast" });
  assert.equal(yes.status, 200, JSON.stringify(yes.body));
  const again = await act({ clientId: cid("brk"), kind: "mark", point: "cxo", key: K("pow100000004"), station: "breakfast" }, U.vic);
  assert.equal(again.body.already, true);
  assert.match(again.body.message, /^Already admitted at 8:30 AM by Val Volunteer$/);
  assert.equal((await markOf("pow100000004", "cxo")).item, "cxo_d1");
  // Staff switch the CxO Breakfast on for Gus's pass (Admin › People's path: audited, and the desks hear of it).
  const sGus = (await call("GET", `${D}/snapshot`, { as: U.sam })).body.guests.find((g) => g.name === "Gus Guest");
  const sw = await call("PATCH", `/api/console/people/${sGus.personId}/passes/${sGus.ticketId}`, { as: U.sam, body: { extras: { cxo: true } } });
  assert.equal(sw.status, 200, JSON.stringify(sw.body));
  assert.ok(await M.AdminAudit.findOne({ action: "pass_cxo_breakfast", targetId: "con100000002" }).lean());
  const inc = await M.CheckinEvent.findOne({ kind: "inclusions", subject: "con100000002" }).lean();
  assert.equal(inc.extras.cxo, true);
  // Volunteers can't change inclusions (Admin › People is staff only).
  assert.equal((await call("PATCH", `/api/console/people/${sGus.personId}/passes/${sGus.ticketId}`, { as: U.val, body: { extras: { cxo: true } } })).status, 403);
  const now = await act({ clientId: cid("brk"), kind: "mark", point: "cxo", key: K("con100000002"), station: "breakfast" });
  assert.equal(now.status, 200, JSON.stringify(now.body));

  // 10:00 AM: breakfast is closed. A tap is refused with the reason; "Admit anyway" is stored as an override.
  fakeNow = new Date("2026-10-26T14:00:00Z");
  const k = K("spk100000005");
  const closed = await act({ clientId: cid("brk"), kind: "mark", point: "cxo", key: k, station: "breakfast" });
  assert.equal(closed.status, 409);
  assert.equal(closed.body.code, "outside_window");
  assert.match(closed.body.window.text, /^Day 1 · CxO Breakfast · closed: next is Day 2 breakfast, 7:25 AM$/);
  const anyway = await act({ clientId: cid("brk"), kind: "mark", point: "cxo", key: k, station: "breakfast", override: true });
  assert.equal(anyway.status, 200, JSON.stringify(anyway.body));
  assert.equal(anyway.body.events[0].override, "outside_window");
  assert.equal((await markOf("spk100000005", "cxo")).override, "outside_window");
  const ov = await M.AdminAudit.findOne({ action: "checkin_desk_override" }).lean();
  assert.match(ov.detail, /Nina Speaker · Speaker Pass: Admitted to CxO Breakfast outside its hours \(override\) \(CxO Breakfast\)/);
  assert.equal(String(ov.adminId), String(U.val._id));
});

test("Day 2: arrivals count again, the pass collected on Day 1 stays collected", { skip }, async () => {
  fakeNow = new Date("2026-10-26T13:10:00Z");
  const key = K("inf100000009");
  const c = await act({ clientId: cid("chk"), kind: "mark", point: "checked_in", key, station: "desk" });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const d1 = await ticketOf("inf100000009");
  assert.equal(d1.checkedIn, true);
  fakeNow = new Date("2026-10-27T12:15:00Z"); // Tue 8:15 AM
  const snap = (await call("GET", `${D}/snapshot`, { as: U.val })).body;
  assert.equal(snap.today.eventDay, "day2");
  const ian = snap.guests.find((g) => g.name === "Ian Influence");
  assert.equal(ian.passCollected, true);
  assert.equal(ian.passCollectedAt, "2026-10-26T13:10:00.000Z");
  assert.ok(!snap.marks.some((m) => m.key === key), "Day 2 starts empty");
  const arr = await act({ clientId: cid("arr"), kind: "mark", point: "arrived", key, station: "lobby" });
  assert.equal(arr.status, 200);
  const chk = await act({ clientId: cid("chk"), kind: "mark", point: "checked_in", key, station: "desk" });
  assert.equal(chk.status, 200);
  assert.equal(chk.body.events[0].pass.collectedAt, "2026-10-26T13:10:00.000Z", "collected once, on Day 1");
  assert.deepEqual(await ticketOf("inf100000009"), d1);
  assert.equal(await M.CheckinMark.countDocuments({ subject: "inf100000009", point: "checked_in", at: { $ne: null } }), 2, "one row per day");
  fakeNow = new Date("2026-10-26T13:20:00Z");
});

test("a QR scan at the door shows on the pass desk as checked in", { skip }, async () => {
  const before = (await call("GET", `${D}/snapshot`, { as: U.val })).body.cursor;
  const scan = await call("POST", "/api/checkin/scan", { as: U.val, body: { ticketId: "TECHFEST:con100000003" } });
  assert.equal(scan.body.status, "success");
  // The desk's record is written after the scanner's answer (it never slows the scan).
  const m = await until(() => markOf("con100000003", "checked_in"));
  assert.equal(m.station, "scanner");
  assert.ok(m.passSetAt);
  const ev = await call("GET", `${D}/events?since=${before}`, { as: U.val });
  const mine = ev.body.events.find((e) => e.key === K("con100000003"));
  assert.equal(mine.point, "checked_in");
  assert.equal(mine.station, "scanner");
  assert.equal(mine.pass.collected, true);
  // Scanning again records nothing more today.
  await call("POST", "/api/checkin/scan", { as: U.val, body: { ticketId: "con100000003" } });
  await sleep(300);
  assert.equal(await M.CheckinEvent.countDocuments({ subject: "con100000003", kind: "mark" }), 1);
});

test("Media Yes / No through Admin › People: the desks reload the guest", { skip }, async () => {
  const gus = (await call("GET", `${D}/snapshot`, { as: U.sam })).body.guests.find((g) => g.name === "Gus Guest");
  assert.equal(gus.marks.media, false);
  const r = await call("PATCH", `/api/console/people/${gus.personId}`, { as: U.sam, body: { media: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(await M.CheckinEvent.findOne({ kind: "guest", subject: "con100000002" }).lean());
  const after = (await call("GET", `${D}/snapshot?refresh=1`, { as: U.sam })).body.guests.find((g) => g.name === "Gus Guest");
  assert.equal(after.marks.media, true);
  await call("PATCH", `/api/console/people/${gus.personId}`, { as: U.sam, body: { media: false } });
});

test("exhibitor desk: people check in, a booth is set up once; media queries: volunteers add and take, staff close", { skip }, async () => {
  fakeNow = new Date("2026-10-26T13:30:00Z");
  const e = await act({ clientId: cid("exh"), kind: "mark", point: "exhibitor", key: K("exh100000006"), station: "exhibitor" });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  const b1 = await act({ clientId: cid("bth"), kind: "mark", point: "booth", key: "b-A12", station: "exhibitor" });
  assert.equal(b1.status, 200, JSON.stringify(b1.body));
  assert.equal(b1.body.events[0].key, "b-A12");
  const b2 = await act({ clientId: cid("bth"), kind: "mark", point: "booth", key: "b-A12", station: "exhibitor" }, U.vic);
  assert.equal(b2.body.already, true);
  assert.match(b2.body.message, /^Booth already set up at 9:30 AM by Val Volunteer$/);
  assert.equal((await act({ clientId: cid("bth"), kind: "mark", point: "booth", key: "b-Z99", station: "exhibitor" })).status, 404);

  const add = await act({ clientId: cid("qry"), kind: "query_add", who: "Lee Reporter", outlet: "Tech Daily", request: "Interview with Nina Speaker", station: "media" });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  const id = add.body.query.id;
  assert.equal(add.body.query.status, "new");
  const take = await act({ clientId: cid("qry"), kind: "query_update", id, status: "in_progress", station: "media" });
  assert.equal(take.status, 200, JSON.stringify(take.body));
  assert.equal(take.body.query.assignee.name, "Val Volunteer");
  assert.equal((await act({ clientId: cid("qry"), kind: "query_update", id, status: "done", station: "media" })).status, 403);
  assert.equal((await act({ clientId: cid("qry"), kind: "query_update", id, assignee: String(U.vic._id), station: "media" })).status, 403);
  const reassign = await act({ clientId: cid("qry"), kind: "query_update", id, assignee: String(U.vic._id), station: "media" }, U.sam);
  assert.equal(reassign.body.query.assignee.name, "Vic Volunteer");
  const done = await act({ clientId: cid("qry"), kind: "query_update", id, status: "done", station: "media" }, U.sam);
  assert.equal(done.body.query.status, "done");
  assert.ok(await M.AdminAudit.findOne({ action: "checkin_desk_media_query" }).lean());
  const snap = (await call("GET", `${D}/snapshot`, { as: U.val })).body;
  assert.equal(snap.queries.find((q) => q.id === id).status, "done");
});

test("desk notes (staff), ticket ID lookup, the evening station switched off", { skip }, async () => {
  const key = K("pow100000004");
  assert.equal((await act({ clientId: cid("note"), kind: "note", key, note: "Collect at VIP desk", station: "desk" })).status, 403);
  const n = await act({ clientId: cid("note"), kind: "note", key, note: "Collect at VIP desk", station: "desk" }, U.sam);
  assert.equal(n.status, 200);
  const snap = (await call("GET", `${D}/snapshot`, { as: U.val })).body;
  assert.equal(snap.notes[key].text, "Collect at VIP desk");
  assert.equal(snap.notes[key].by, "Sam Staff");

  const look = await call("POST", `${D}/lookup`, { as: U.val, body: { ticketId: "TECHFEST:INF100000009" } });
  assert.equal(look.body.key, K("inf100000009"));
  assert.equal((await call("POST", `${D}/lookup`, { as: U.val, body: { ticketId: "zzz100000000" } })).status, 404);

  assert.equal((await call("PUT", `${D}/settings`, { as: U.val, body: { stations: { evening: false } } })).status, 403);
  const off = await call("PUT", `${D}/settings`, { as: U.sam, body: { stations: { evening: false }, buffers: { breakfast: { day1: { before: 45 } } } } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.stations.find((s) => s.key === "evening").enabled, false);
  assert.equal(off.body.windows.breakfast.day1.open, "07:10");
  assert.ok(await M.AdminAudit.findOne({ action: "checkin_desk_settings" }).lean());
  fakeNow = new Date("2026-10-26T22:00:00Z");
  const ev = await act({ clientId: cid("eve"), kind: "mark", point: "evening", key, station: "evening" });
  assert.equal(ev.status, 409);
  assert.equal(ev.body.code, "station_off");
  await call("PUT", `${D}/settings`, { as: U.sam, body: {} });
  const on = await act({ clientId: cid("eve"), kind: "mark", point: "evening", key, station: "evening" });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal((await markOf("pow100000004", "evening")).item, "awards");
});

/** Reads a Server-Sent Events stream until `until(frames)` is true (or the time runs out). */
async function readStream(p, { as = U.val, until: stop, ms = 4000, onFrame = null, ctl = new AbortController() } = {}) {
  const frames = [];
  const r = await realFetch(`${base}${p}`, { headers: { authorization: `Bearer ${tokenFor(as)}`, accept: "text/event-stream" }, signal: ctl.signal });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /^text\/event-stream/);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) { frames.ended = true; break; }
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(raw)?.[1];
        const data = /^data: (.+)$/m.exec(raw)?.[1];
        if (ev) { frames.push({ event: ev, data: data ? JSON.parse(data) : null, t: Date.now() }); onFrame?.(frames); }
      }
      if (stop(frames)) break;
    }
  } catch (err) { if (err.name !== "AbortError") throw err; }
  finally { clearTimeout(timer); ctl.abort(); }
  return frames;
}

test("the live stream: catch-up from a cursor, then new events within a second; polling gives the same", { skip }, async () => {
  fakeNow = new Date("2026-10-26T13:40:00Z");
  const cursor = (await call("GET", `${D}/snapshot`, { as: U.val })).body.cursor;
  // Two taps while this device is "asleep".
  await act({ clientId: cid("arr"), kind: "mark", point: "arrived", key: K("exh100000007"), station: "lobby" });
  await act({ clientId: cid("arr"), kind: "mark", point: "arrived", key: K("apx100000010"), station: "lobby" });
  const live = cid("live");
  setTimeout(() => { act({ clientId: live, kind: "mark", point: "arrived", key: K("dis100000011"), station: "lobby" }); }, 600);
  const t0 = Date.now();
  const frames = await readStream(`${D}/stream?since=${cursor}`, {
    until: (f) => f.some((x) => x.event === "events" && x.data.events.some((e) => e.clientId === live)),
  });
  assert.equal(frames[0].event, "hello");
  const catchUp = frames.find((f) => f.event === "events" && f.data.catchUp);
  assert.ok(catchUp.data.events.length >= 2, "the two taps it missed");
  assert.ok(catchUp.data.cursor > cursor);
  const got = frames.flatMap((f) => (f.event === "events" ? f.data.events : []));
  assert.ok(got.some((e) => e.clientId === live), "the live tap arrived");
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(new Set(got.map((e) => e.seq)).size, got.length, "no event twice");
  for (const e of got) assert.ok(!JSON.stringify(e).includes("@example.com"));
  // Polling from the same cursor returns the same events, in order, and a cursor past them.
  const poll = await call("GET", `${D}/events?since=${cursor}`, { as: U.val });
  assert.deepEqual(poll.body.events.map((e) => e.seq), [...got.map((e) => e.seq)].sort((a, b) => a - b));
  assert.equal(poll.body.cursor, Math.max(...got.map((e) => e.seq)));
  // A cursor ahead of the log (a wiped database): reload everything.
  assert.equal((await call("GET", `${D}/events?since=999999`, { as: U.val })).body.reset, true);
  assert.equal((await call("GET", `${D}/stream?since=0`, { as: U.ada })).status, 403);
});

test("contract C1: passwordless sign-ins, and accounts that aren't staff or volunteers, never reach the desk; a pass ID never opens one that can", { skip }, async () => {
  // Tara: an attendee account staff typed Volunteer in People. With her password: in, as a volunteer.
  const pw = await call("GET", `${D}/snapshot`, { as: U.tara });
  assert.equal(pw.status, 200, JSON.stringify(pw.body));
  assert.equal(pw.body.staff, false);
  // Her pass ID + last name, or an emailed code: 403 password_required on every route (the guest list and the taps).
  for (const via of ["ticket", "email"]) {
    const token = tokenFor(U.tara, { via });
    const routes = [["GET", `${D}/snapshot`], ["GET", `${D}/me`], ["GET", `${D}/clock`], ["GET", `${D}/events?since=0`],
      ["POST", `${D}/actions`, { clientId: cid("c1"), kind: "mark", point: "arrived", key: K("con100000002"), station: "lobby" }],
      ["POST", `${D}/lookup`, { ticketId: "con100000002" }]];
    for (const [m, path, body] of routes) {
      const r = await call(m, path, { token, body });
      assert.equal(r.status, 403, `${via} ${m} ${path}`);
      assert.equal(r.body.code, "password_required");
    }
    const st = await realFetch(`${base}${D}/stream?since=0`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(st.status, 403);
    await st.text();
  }
  assert.equal(await M.CheckinMark.countDocuments({ subject: "con100000002", byId: U.tara._id }), 0, "nothing recorded");
  // The pass ID sign-in itself refuses an account that can check people in (role or type), and still lets attendees in.
  const tl = await call("POST", "/api/auth/ticket-login", { as: null, body: { lastName: "Typed", ticketId: "vol100000020" } });
  assert.equal(tl.status, 400);
  assert.match(tl.body.error, /^Volunteer accounts sign in with a code sent to their email or their password\.$/);
  const ok = await call("POST", "/api/auth/ticket-login", { as: null, body: { lastName: "Sharma", ticketId: "pow100000001" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await call("GET", `${D}/snapshot`, { token: ok.body.token })).status, 403);
  // A type staff give the checkIn right in the App rights matrix (here: speakers) keeps the door scanner only, not the desk.
  const { saveMatrix, clearRightsCache } = await import("../services/rightsStore.js");
  const { DEFAULT_MATRIX } = await import("../services/appRights.js");
  await saveMatrix({ ...DEFAULT_MATRIX, speaker: { ...DEFAULT_MATRIX.speaker, checkIn: true } }, "test");
  try {
    const sp = await call("GET", `${D}/snapshot`, { as: U.sid });
    assert.equal(sp.status, 403);
    assert.equal(sp.body.code, "team_only");
  } finally {
    await M.AppContent.deleteOne({ key: "app.rights" });
    clearRightsCache();
  }
});

test("contract C5: staff read the desk app's address from the API (it's in no public website file)", { skip }, async () => {
  const r = await call("GET", `${D}/info`, { as: U.sam });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { path: "/checkin-j0s8e5p4akvh/" });
  assert.equal((await call("GET", `${D}/info`, { as: U.val })).status, 403, "volunteers don't hand out the link");
  assert.equal((await call("GET", `${D}/info`, { token: tokenFor(U.sam, { via: "email" }) })).status, 403);
  try {
    process.env.CHECKIN_DESK_PATH = "/checkin-n3wt0ken9876/";
    assert.equal((await call("GET", `${D}/info`, { as: U.sam })).body.path, "/checkin-n3wt0ken9876/");
    process.env.CHECKIN_DESK_PATH = "https://evil.example.com/";
    assert.equal((await call("GET", `${D}/info`, { as: U.sam })).body.path, "/checkin-j0s8e5p4akvh/");
  } finally { delete process.env.CHECKIN_DESK_PATH; }
});

test("contract C2: undo by reference; an undo that reaches the server before its tap leaves a tombstone, and the tap is never recorded", { skip }, async () => {
  fakeNow = new Date("2026-10-26T14:00:00Z"); // 10:00 AM
  const key = K("tom100000021");
  // The server has the tap: undone; the same undo again (or another one): nothing more to undo.
  const tap = cid("tap");
  await act({ clientId: tap, kind: "mark", point: "arrived", key, station: "lobby" });
  const u1 = await act({ clientId: cid("und"), kind: "undo", target: tap, station: "lobby" });
  assert.equal(u1.status, 200, JSON.stringify(u1.body));
  assert.equal(u1.body.events[0].target, tap);
  assert.equal((await markOf("tom100000021", "arrived")).at, null);
  const u2 = await act({ clientId: cid("und"), kind: "undo", target: tap, station: "lobby" });
  assert.equal(u2.status, 200);
  assert.equal(u2.body.noop, true);
  // The undo arrives first (the tap's request was lost and resent later, or two requests raced): a tombstone.
  const lost = cid("chk");
  const tomb = await act({ clientId: cid("und"), kind: "undo", target: lost, station: "desk" });
  assert.equal(tomb.status, 200, JSON.stringify(tomb.body));
  assert.equal(tomb.body.tombstone, true);
  assert.equal(tomb.body.events[0].tombstone, true);
  const late = await act({ clientId: lost, kind: "mark", point: "checked_in", key, station: "desk" });
  assert.equal(late.status, 200, JSON.stringify(late.body));
  assert.equal(late.body.undone, true);
  assert.equal((await markOf("tom100000021", "checked_in"))?.at ?? null, null, "not checked in");
  assert.equal((await ticketOf("tom100000021")).checkedIn, false, "the pass isn't collected");
  assert.equal((await act({ clientId: lost, kind: "mark", point: "checked_in", key, station: "desk" })).body.undone, true, "sent again: still not");
  assert.equal(await M.CheckinEvent.countDocuments({ clientId: lost }), 0);
  // Someone else's tombstone doesn't cancel a volunteer's tap (only the tap's own author, or staff).
  const other = cid("chk");
  await act({ clientId: cid("und"), kind: "undo", target: other, station: "desk" }, U.vic);
  const mine = await act({ clientId: other, kind: "mark", point: "checked_in", key, station: "desk" });
  assert.equal(mine.status, 200);
  assert.ok(!mine.body.undone);
  assert.ok((await markOf("tom100000021", "checked_in")).at);
  // The older field name still works.
  const legacy = await act({ clientId: cid("und"), kind: "undo", ref: other, station: "desk" });
  assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
  assert.equal((await markOf("tom100000021", "checked_in")).at, null);
  assert.equal((await ticketOf("tom100000021")).checkedIn, false);
});

test("contract C3: a tap made offline by one person and sent from another's sign-in is theirs, recorded by the sign-in", { skip }, async () => {
  fakeNow = new Date("2026-10-26T10:30:00Z"); // 6:30 AM: the lobby opens at 7
  const key = K("qqq100000022");
  const q = { id: String(U.val._id), name: "Val Volunteer" };
  // Val tapped "Admit anyway" offline; Sam signed in on that iPad afterwards and the queue went out with his sign-in.
  const r = await act({ clientId: cid("arr"), kind: "mark", point: "arrived", key, station: "lobby", override: true, queuedBy: q }, U.sam);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ev = r.body.events[0];
  assert.deepEqual([ev.by.id, ev.by.name, ev.by.role], [String(U.val._id), "Val Volunteer", "volunteer"]);
  assert.equal(ev.queuedOffline, true);
  assert.deepEqual(ev.recordedBy, { id: String(U.sam._id), name: "Sam Staff" });
  const m = await markOf("qqq100000022", "arrived");
  assert.equal(String(m.byId), String(U.val._id));
  assert.equal(m.queuedOffline, true);
  assert.equal(String(m.recordedById), String(U.sam._id));
  const au = await M.AdminAudit.findOne({ action: "checkin_desk_override", targetId: "qqq100000022" }).lean();
  assert.equal(String(au.adminId), String(U.val._id));
  assert.equal(au.adminName, "Val Volunteer");
  assert.match(au.detail, /\[tapped offline by Val Volunteer; sent from Sam Staff's sign-in\]$/);
  // Staff powers only when both are staff: Val's queued reset, sent from Sam's sign-in, is refused.
  assert.equal((await act({ clientId: cid("rst"), kind: "reset", point: "arrived", key, station: "lobby", queuedBy: q }, U.sam)).status, 403);
  // Val's own undo of it, queued offline and sent from Vic's sign-in: hers to undo, and recorded as hers.
  const un = await act({ clientId: cid("und"), kind: "undo", target: ev.clientId, station: "lobby", queuedBy: q, clientAt: new Date(fakeNow.getTime() + 5000).toISOString() }, U.vic);
  assert.equal(un.status, 200, JSON.stringify(un.body));
  assert.equal(un.body.events[0].by.name, "Val Volunteer");
  assert.equal(un.body.events[0].recordedBy.name, "Vic Volunteer");
  // queuedBy naming the sign-in itself: an ordinary tap.
  const same = await act({ clientId: cid("arr"), kind: "mark", point: "arrived", key, station: "lobby", override: true, queuedBy: { id: String(U.vic._id), name: "Vic" } }, U.vic);
  assert.equal(same.status, 200);
  assert.ok(!same.body.events[0].queuedOffline);
  assert.equal(same.body.events[0].by.name, "Vic Volunteer");
});

test("contract C4: a late sync is judged at its own time; outside the hours it's still recorded, flagged and audited", { skip }, async () => {
  fakeNow = new Date("2026-10-26T14:30:00Z"); // 10:30 AM: breakfast closed at 9:25
  // Lena (Apex: CxO) admitted at 10:00 on an offline iPad that didn't ask "Admit anyway"; it reaches the server now.
  const late = await act({ clientId: cid("brk"), kind: "mark", point: "cxo", key: K("apx100000026"), station: "breakfast", clientAt: "2026-10-26T14:00:00.000Z" });
  assert.equal(late.status, 200, JSON.stringify(late.body));
  assert.equal(late.body.events[0].override, "late_sync");
  assert.equal(late.body.events[0].overrideReason, "late sync outside hours");
  assert.equal(late.body.events[0].lateSync, true);
  const m = await markOf("apx100000026", "cxo");
  assert.equal(m.override, "late_sync");
  assert.equal(new Date(m.at).toISOString(), "2026-10-26T14:00:00.000Z");
  const au = await M.AdminAudit.findOne({ action: "checkin_desk_override", targetId: "apx100000026" }).lean();
  assert.match(au.detail, /Lena Late · Apex Pass: Admitted to CxO Breakfast outside its hours \(late sync from an offline device\)/);
  // A live tap outside the hours is still refused until "Admit anyway".
  const live = await act({ clientId: cid("brk"), kind: "mark", point: "cxo", key: K("con100000003"), station: "breakfast" });
  assert.equal(live.status, 409);
  assert.equal(live.body.code, "outside_window");
  // Mo (Media: CxO) admitted at 8:30, in the hours, synced at 10:30: recorded as tapped, and the gap audited.
  const inHours = await act({ clientId: cid("brk"), kind: "mark", point: "cxo", key: K("con100000003"), station: "breakfast", clientAt: "2026-10-26T12:30:00.000Z" });
  assert.equal(inHours.status, 200, JSON.stringify(inHours.body));
  assert.equal(inHours.body.events[0].override, undefined);
  assert.equal(inHours.body.events[0].lateSync, true);
  const gap = await M.AdminAudit.findOne({ action: "checkin_desk_late_sync", targetId: "con100000003" }).lean();
  assert.match(gap.detail, /tapped 8:30 AM \(device\), reached the server 10:30 AM/);
  // A clock ahead is clamped to 2 minutes ahead; every answer carries the server's time (the device's offset).
  const ahead = await act({ clientId: cid("arr"), kind: "mark", point: "arrived", key: K("apx100000026"), station: "lobby", clientAt: "2026-10-26T15:30:00.000Z" });
  assert.equal(ahead.status, 200, JSON.stringify(ahead.body));
  assert.equal(ahead.body.mark.at, "2026-10-26T14:32:00.000Z");
  assert.equal(ahead.body.serverTime, fakeNow.toISOString());
});

test("contract C6: on a day that isn't Day 1 or Day 2, marks are practice marks: never the ticket's pass, and undo / reset clear them", { skip }, async () => {
  fakeNow = new Date("2026-10-25T15:00:00Z"); // Sun Oct 25, 11 AM: a rehearsal with a real guest
  const key = K("prc100000025");
  const tap = cid("chk");
  const c = await act({ clientId: tap, kind: "mark", point: "checked_in", key, station: "desk" });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.events[0].practice, true);
  assert.equal(c.body.events[0].pass, undefined, "the pass isn't touched");
  assert.equal(c.body.mark.practice, true);
  assert.deepEqual(await ticketOf("prc100000025"), { checkedIn: false, checkedInAt: null });
  assert.equal((await markOf("prc100000025", "checked_in", "2026-10-25")).practice, true);
  // "Admit anyway" (the app asks on a closed day) is a practice mark too, and a rehearsal isn't an audited override.
  const meal = await act({ clientId: cid("lun"), kind: "mark", point: "lunch", key, station: "lunch", override: true });
  assert.equal(meal.status, 200, JSON.stringify(meal.body));
  assert.equal(meal.body.events[0].practice, true);
  assert.equal(meal.body.events[0].override, undefined);
  assert.equal(await M.AdminAudit.countDocuments({ action: "checkin_desk_override", targetId: "prc100000025" }), 0);
  // Undo and a staff reset clear them.
  const un = await act({ clientId: cid("und"), kind: "undo", target: tap, station: "desk" });
  assert.equal(un.status, 200, JSON.stringify(un.body));
  assert.equal((await markOf("prc100000025", "checked_in", "2026-10-25")).at, null);
  const rs = await act({ clientId: cid("rst"), kind: "reset", point: "lunch", key, station: "lunch" }, U.sam);
  assert.equal(rs.status, 200, JSON.stringify(rs.body));
  assert.equal((await markOf("prc100000025", "lunch", "2026-10-25")).at, null);
  // Day 1: her pass is still to be collected; the rehearsal is in no day's attendance.
  await act({ clientId: cid("arr"), kind: "mark", point: "arrived", key, station: "lobby" });
  fakeNow = new Date("2026-10-26T14:40:00Z");
  const s = (await call("GET", `${D}/snapshot`, { as: U.sam })).body;
  assert.equal(s.guests.find((g) => g.name === "Pru Practice").passCollected, false);
  assert.ok(!s.marks.some((x) => x.key === key));
  assert.ok(!s.attendance.some((a) => a.day === "2026-10-25"), "practice marks don't count");
});

test("inclusions from any of their passes: a paid Connect Pass plus an issued Power Pass gets the luncheons and the evenings", { skip }, async () => {
  fakeNow = new Date("2026-10-26T16:40:00Z"); // 12:40 PM: lunch open
  const s = (await call("GET", `${D}/snapshot`, { as: U.sam })).body;
  const ava = s.guests.find((g) => g.name === "Ava Twopass");
  assert.equal(ava.passName, "Connect Pass");
  assert.deepEqual(ava.extras, { cxo: false, lunch: true, gala: true, awards: true });
  assert.equal(ava.extrasView.lunch.ticketId, "pow100000029");
  assert.equal(ava.passExtras.length, 2);
  const lunch = await act({ clientId: cid("lun"), kind: "mark", point: "lunch", key: ava.key, station: "lunch" });
  assert.equal(lunch.status, 200, JSON.stringify(lunch.body));
  // The Event summary counts her as entitled the same way (one rule: eventSummary.js entitledExtras).
  const { directory } = await import("../routes/people.js");
  const { eventSummary } = await import("../services/eventSummary.js");
  const d = await directory();
  const one = eventSummary(d.people.filter((p) => p.name === "Ava Twopass"));
  assert.equal(one.meals.rows.find((x) => x.key === "lunch_d1").entitled, 1);
  assert.equal(one.meals.rows.find((x) => x.key === "cxo_d1").entitled, 0);
});

test("Exhibitor = No from the desk (People's PATCH) takes an exhibitor-pass holder off the exhibitor desk", { skip }, async () => {
  const s0 = (await call("GET", `${D}/snapshot`, { as: U.sam })).body;
  const eve = s0.guests.find((g) => g.name === "Eve Exhibitor");
  assert.equal(eve.marks.exhibitor, true);
  const r = await call("PATCH", `/api/console/people/${eve.personId}`, { as: U.sam, body: { exhibitor: false } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ev = await M.CheckinEvent.findOne({ kind: "guest", subject: "exh100000006" }).sort({ seq: -1 }).lean();
  assert.equal(ev.guest.marks.exhibitor, false, "the event carries her row");
  const s1 = (await call("GET", `${D}/snapshot`, { as: U.val })).body;
  const after = s1.guests.find((g) => g.name === "Eve Exhibitor");
  assert.equal(after.marks.exhibitor, false);
  assert.equal(after.booth, "");
  assert.deepEqual(s1.booths.map((b) => [b.booth, b.guests.length]), [["A12", 1]]);
  // Devices get the row with the event (volunteers: no email, no ticket ID).
  const evs = await call("GET", `${D}/events?since=${ev.seq - 1}`, { as: U.val });
  const gv = evs.body.events.find((e) => e.seq === ev.seq);
  assert.equal(gv.guest.name, "Eve Exhibitor");
  assert.ok(!("email" in gv.guest) && !("ticketId" in gv.guest));
});

test("staff's attendance by day counts each person once (a speaker's two passes, a door scan of the other one)", { skip }, async () => {
  fakeNow = new Date("2026-10-26T14:50:00Z");
  const line = (s, point) => s.attendance.find((a) => a.day === "2026-10-26" && a.point === point) || { people: 0, passes: 0 };
  const before = (await call("GET", `${D}/snapshot`, { as: U.sam })).body;
  const sid = before.guests.find((g) => g.name === "Sid Speaker");
  assert.equal(sid.ticketId, "spk100000023", "counted under the Speaker Pass");
  const a = await act({ clientId: cid("arr"), kind: "mark", point: "arrived", key: sid.key, station: "lobby" });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const scan = await call("POST", "/api/checkin/scan", { as: U.val, body: { ticketId: "pow100000024" } });
  assert.equal(scan.body.status, "success");
  assert.ok(await until(() => markOf("pow100000024", "arrived")));
  await sleep(100);
  const after = (await call("GET", `${D}/snapshot`, { as: U.sam })).body;
  assert.equal(line(after, "arrived").people - line(before, "arrived").people, 1);
  assert.equal(line(after, "arrived").passes - line(before, "arrived").passes, 2);
  assert.equal(line(after, "checked_in").people - line(before, "checked_in").people, 1);
  assert.equal(line(after, "arrived").rows, line(after, "arrived").people);
});

test("an unknown guest key: refused, with at most one directory rebuild, never one per tap", { skip }, async () => {
  const { deskIndexStats } = await import("../routes/checkinDesk.js");
  await call("GET", `${D}/snapshot`, { as: U.val });
  const before = deskIndexStats().freshBuilds;
  const unknown = () => `g${crypto.randomBytes(10).toString("hex")}`;
  const batch = () => Array.from({ length: 10 }, () => ({ clientId: cid("unk"), kind: "mark", point: "arrived", key: unknown(), station: "lobby", clientAt: fakeNow.toISOString() }));
  for (let i = 0; i < 3; i++) {
    const r = await call("POST", `${D}/actions`, { as: U.val, body: { actions: batch() } });
    assert.equal(r.status, 200);
    assert.ok(r.body.results.every((x) => x.status === 404 && x.code === "not_found"), JSON.stringify(r.body.results[0]));
  }
  assert.ok(deskIndexStats().freshBuilds - before <= 1, `fresh rebuilds: ${deskIndexStats().freshBuilds - before}`);
  assert.equal((await call("GET", `${D}/history/not-a-key`, { as: U.sam })).status, 404);
});

test("several instances: a change staff made on another instance counts at once at the meal door and in every snapshot", { skip }, async () => {
  fakeNow = new Date("2026-10-26T16:45:00Z"); // 12:45 PM: lunch
  const key = K("con100000027");
  const s0 = (await call("GET", `${D}/snapshot`, { as: U.val })).body;
  assert.equal(s0.guests.find((g) => g.key === key).extras.lunch, false);
  // Staff switch the luncheons on for Mona's pass on another instance (the record, then its event): this instance isn't told.
  await M.Attendee.updateOne({ ticketId: "con100000027" }, { $set: { luncheons: true } });
  await Other.deskInclusionsChanged({ ticketId: "con100000027", extras: { cxo: false, lunch: true, gala: false, awards: false }, user: U.sam });
  // "Include + admit": the admit lands here straight away and is let in (the door reads her inclusions from the database).
  const admit = await act({ clientId: cid("lun"), kind: "mark", point: "lunch", key, station: "lunch" });
  assert.equal(admit.status, 200, JSON.stringify(admit.body));
  // The devices' reload from this instance has it too.
  const s1 = (await call("GET", `${D}/snapshot`, { as: U.val })).body;
  assert.equal(s1.guests.find((g) => g.key === key).extras.lunch, true);
  // Switched off again elsewhere (no event yet): Day 2's lunch door refuses at once.
  await M.Attendee.updateOne({ ticketId: "con100000027" }, { $set: { luncheons: false } });
  fakeNow = new Date("2026-10-27T16:10:00Z");
  const no = await act({ clientId: cid("lun"), kind: "mark", point: "lunch", key, station: "lunch" });
  assert.equal(no.status, 409, JSON.stringify(no.body));
  assert.equal(no.body.code, "not_included");
  fakeNow = new Date("2026-10-26T16:45:00Z");
  // A guest event from another instance carries the guest's row: a snapshot here uses it at once.
  const { directory } = await import("../routes/people.js");
  const { deskGuestFrom } = await import("../services/checkinDesk.js");
  const p = (await directory()).byId.get("t-con100000002");
  const row = { ...deskGuestFrom(p), company: "Overlay Co" };
  await Other.appendEvent({ kind: "guest", subject: row.norm, guest: row, station: "admin", byName: "Sam Staff", byRole: "staff" });
  const s2 = (await call("GET", `${D}/snapshot`, { as: U.val })).body;
  const gus = s2.guests.filter((g) => g.key === row.key);
  assert.equal(gus.length, 1);
  assert.equal(gus[0].company, "Overlay Co");
  assert.ok(!("email" in gus[0]));
});

test("a tap never waits for a directory rebuild (the last index is used while a new one is read)", { skip }, async () => {
  fakeNow = new Date("2026-10-26T15:00:00Z");
  const { deskIndexStats } = await import("../routes/checkinDesk.js");
  await call("GET", `${D}/snapshot`, { as: U.val });
  // Another instance changed a guest (an event without a row): this instance's index is behind and is rebuilt…
  await Other.deskGuestChanged({ ticketIds: ["con100000002"], user: U.sam });
  // …slowly (a slow read of every pass).
  const orig = M.Attendee.find;
  M.Attendee.find = function (...args) {
    const q = orig.apply(this, args);
    const exec = q.exec.bind(q);
    q.exec = async (...a) => { await sleep(2500); return exec(...a); };
    return q;
  };
  try {
    const snap = call("GET", `${D}/snapshot`, { as: U.val }); // a reload waits for it (the event has no row)
    assert.ok(await until(() => deskIndexStats().pending, 1500), "a rebuild is running");
    const t0 = Date.now();
    const r = await act({ clientId: cid("arr"), kind: "mark", point: "arrived", key: K("tom100000021"), station: "lobby" });
    const took = Date.now() - t0;
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(took < 1500, `the tap took ${took} ms`);
    assert.ok(deskIndexStats().pending, "the rebuild was still running");
    M.Attendee.find = orig;
    assert.equal((await snap).status, 200);
  } finally { M.Attendee.find = orig; }
});

test("live stream: a catch-up that fails ends the stream (the device polls from its own cursor)", { skip }, async () => {
  const cursor = (await call("GET", `${D}/snapshot`, { as: U.val })).body.cursor;
  await until(() => !Log.tailState().running, 3000);
  const orig = M.CheckinEvent.find;
  let failed = false;
  M.CheckinEvent.find = function (filter, ...rest) {
    if (!failed && filter?.seq?.$gt !== undefined) { failed = true; M.CheckinEvent.find = orig; throw new Error("database blip (test)"); }
    return orig.call(this, filter, ...rest);
  };
  try {
    const frames = await readStream(`${D}/stream?since=${cursor}`, { until: () => false, ms: 3000 });
    assert.ok(failed);
    assert.ok(frames.some((f) => f.event === "error"), JSON.stringify(frames.map((f) => f.event)));
    assert.ok(frames.ended, "the stream ended");
    assert.ok(!frames.some((f) => f.data && typeof f.data === "object" && "cursor" in f.data), "no cursor without a catch-up");
  } finally { M.CheckinEvent.find = orig; }
  assert.ok(await until(() => !Log.tailState().running, 2000), "the tail stopped with it");
});

test("live stream: no cursor before the catch-up; another instance's writes arrive through the tail; a write that commits late isn't skipped", { skip }, async () => {
  fakeNow = new Date("2026-10-26T15:10:00Z");
  await until(() => !Log.tailState().running, 3000);
  const cursor = (await call("GET", `${D}/snapshot`, { as: U.val })).body.cursor;
  await act({ clientId: cid("arr"), kind: "mark", point: "arrived", key: K("pow100000004"), station: "lobby" }); // missed while asleep
  // The catch-up read is slow; a tap made here meanwhile reaches the stream first, without a cursor.
  const orig = M.CheckinEvent.find;
  let slowed = false;
  M.CheckinEvent.find = function (filter, ...rest) {
    const q = orig.call(this, filter, ...rest);
    if (!slowed && filter?.seq?.$gt === cursor) {
      slowed = true;
      const exec = q.exec.bind(q);
      q.exec = async (...a) => { await sleep(800); return exec(...a); };
    }
    return q;
  };
  const during = cid("arr");
  setTimeout(() => { act({ clientId: during, kind: "mark", point: "arrived", key: K("con100000028"), station: "lobby" }); }, 300);
  let otherSeq = 0;
  let k = 0;
  let started = false;
  const ctl = new AbortController();
  const onFrame = (frames) => {
    if (started || !frames.some((f) => f.data?.catchUp)) return;
    started = true;
    M.CheckinEvent.find = orig;
    (async () => {
      // Another instance writes: this stream gets it through the tail.
      await sleep(200);
      otherSeq = (await Other.appendEvent({ kind: "mark", point: "arrived", subject: "zzz100000090", station: "lobby", byName: "Elsewhere" })).seq;
      // Then a write takes its number (k) but is held up; the next one (k + 1, stamped 20 s ago) commits first.
      await sleep(1200);
      const c = await M.CheckinCounter.findOneAndUpdate({ _id: "events" }, { $inc: { seq: 2 } }, { returnDocument: "after" }).lean();
      k = c.seq - 1;
      await M.CheckinEvent.create({ seq: k + 1, kind: "mark", point: "arrived", subject: "zzz100000092", at: new Date(fakeNow.getTime() - 20000) });
      await sleep(2500);
      await M.CheckinEvent.create({ seq: k, kind: "mark", point: "arrived", subject: "zzz100000091", at: new Date(fakeNow.getTime() - 21000) });
    })().catch((err) => { console.error(err); ctl.abort(); });
  };
  let frames;
  try {
    frames = await readStream(`${D}/stream?since=${cursor}`, {
      ctl, onFrame, ms: 9000,
      until: (f) => k > 0 && f.some((x) => x.event === "events" && x.data.events.some((e) => e.seq === k)),
    });
  } finally { M.CheckinEvent.find = orig; }
  const firstCursor = frames.findIndex((f) => f.data && typeof f.data === "object" && "cursor" in f.data);
  assert.ok(firstCursor >= 0);
  assert.equal(frames[firstCursor].data.catchUp, true, "the first cursor is the catch-up's");
  const got = frames.flatMap((f) => (f.event === "events" ? f.data.events.map((e) => ({ ...e, frameCursor: f.data.cursor ?? null, i: frames.indexOf(f) })) : []));
  assert.ok(got.some((e) => e.clientId === during), "the tap made during the catch-up arrived");
  assert.ok(got.some((e) => e.seq === otherSeq), "the other instance's write arrived (the tail)");
  const lateOne = got.find((e) => e.seq === k);
  assert.ok(lateOne, "the late write was delivered, not skipped");
  assert.ok(got.some((e) => e.seq === k + 1));
  // No cursor at or past k reached the device before k itself.
  for (const f of frames.slice(0, lateOne.i)) if (f.data && Number.isFinite(f.data.cursor)) assert.ok(f.data.cursor < k, `cursor ${f.data.cursor} before ${k}`);
});

test("the tail stops with the last stream, and a read still in flight never brings back its old cursor", { skip }, async () => {
  await until(() => !Log.tailState().running, 3000);
  const cursor = (await call("GET", `${D}/snapshot`, { as: U.val })).body.cursor;
  const ctl = new AbortController();
  const reading = readStream(`${D}/stream?since=${cursor}`, { ctl, until: () => false, ms: 6000 });
  assert.ok(await until(() => Log.tailState().cursor !== null, 3000), "the tail starts at the catch-up's cursor");
  const orig = M.CheckinEvent.find;
  M.CheckinEvent.find = function (filter, ...rest) {
    const q = orig.call(this, filter, ...rest);
    if (filter?.seq?.$gt !== undefined) { const exec = q.exec.bind(q); q.exec = async (...a) => { await sleep(700); return exec(...a); }; }
    return q;
  };
  try {
    assert.ok(await until(() => Log.tailState().busy, 2500), "a tail read is in flight");
    ctl.abort();
    assert.ok(await until(() => !Log.tailState().running, 2000));
    await sleep(900); // the slow read finishes
    assert.equal(Log.tailState().cursor, null);
    assert.equal(Log.tailState().running, false);
  } finally { M.CheckinEvent.find = orig; }
  await reading;
});

test("users are indexed by their tickets' IDs (the door scan, ticket sign-in, the desk's check-ins)", { skip }, async () => {
  const idx = await M.User.collection.indexes();
  assert.ok(idx.some((i) => i.key["tickets.ticketId"] === 1), JSON.stringify(idx.map((i) => i.key)));
});

test("nothing was emailed", { skip }, () => {
  assert.equal(resendCalls, 0);
});
