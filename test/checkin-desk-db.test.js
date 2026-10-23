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
  ({ guestKey } = await import("../services/checkinDesk.js"));
  setDeskClock(() => new Date(fakeNow));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.Attendee = await imp("../models/Attendee.js");
  M.CheckinMark = await imp("../models/CheckinMark.js");
  M.CheckinEvent = await imp("../models/CheckinEvent.js");
  Object.assign(M, await import("../models/Admin.js"));
  await Promise.all([M.CheckinMark.init(), M.CheckinEvent.init()]);
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/checkin/desk", (await import("../routes/checkinDesk.js")).default);
  app.use("/api/checkin", (await import("../routes/checkin.js")).default);
  app.use("/api/console/people", (await import("../routes/people.js")).default);
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
  // Staff signed in to an app with an emailed code are volunteers here (the admin panel's password rule).
  const byEmail = await call("GET", `${D}/snapshot`, { token: tokenFor(U.sam, { via: "email" }) });
  assert.equal(byEmail.status, 200);
  assert.equal(byEmail.body.staff, false);
  assert.ok(!("email" in byEmail.body.guests[0]));
});

test("the guests: pass types (Other for an unknown one), Media / VIP / Exhibitor marks, pending, booths, today", { skip }, async () => {
  const s = (await call("GET", `${D}/snapshot`, { as: U.sam })).body;
  const by = Object.fromEntries(s.guests.map((g) => [g.name, g]));
  assert.equal(by["Priya Sharma"].tier, "power");
  assert.equal(by["Priya Sharma"].passName, "Power Pass");
  assert.equal(by["Mo Media"].tier, "connect");
  assert.equal(by["Mo Media"].marks.media, true);
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
  const m = await markOf("con100000003", "checked_in");
  assert.equal(m.station, "scanner");
  assert.ok(m.passSetAt);
  const ev = await call("GET", `${D}/events?since=${before}`, { as: U.val });
  const mine = ev.body.events.find((e) => e.key === K("con100000003"));
  assert.equal(mine.point, "checked_in");
  assert.equal(mine.station, "scanner");
  assert.equal(mine.pass.collected, true);
  // Scanning again records nothing more today.
  await call("POST", "/api/checkin/scan", { as: U.val, body: { ticketId: "con100000003" } });
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
async function readStream(p, { as = U.val, until, ms = 4000 } = {}) {
  const ctl = new AbortController();
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
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(raw)?.[1];
        const data = /^data: (.+)$/m.exec(raw)?.[1];
        if (ev) frames.push({ event: ev, data: data ? JSON.parse(data) : null });
      }
      if (until(frames)) break;
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

test("nothing was emailed", { skip }, () => {
  assert.equal(resendCalls, 0);
});
