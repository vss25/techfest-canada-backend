/* TTFC Check-in desk app: DRINK COUPONS (Oct 27 2026, Day 2), through the real routes and models against a real
   (throwaway) MongoDB. The organiser: "add the ability to collect drinks token in the pwa from registration desk. So
   that would be a soft indicator when someone has checked in." People who collected their badge on Day 1 never pass
   the pass desk on Day 2; handing out a drink coupon at the Drinks station marks them arrived for the day.
     - point "drinks": once per person per day (any of their passes), the number in the mark's item ("2" by default:
       the desk setting drinks.perPerson); the tap also marks them arrived (same ref), never an arrival made earlier
     - undo takes back exactly what the tap set (an arrival the lobby made stays)
     - a second tap: "already issued"; volunteers can't "Issue again", staff can (adds more, an audited override) and
       its undo puts the row back as it was
     - no pass on file (ISSUE PASS): refused at the Drinks station ("send them to the pass desk first") until the
       pass desk has checked them in; the pass desk issues them with the pass
     - the pass desk: coupons and Checked in are independent, either order
     - counts (GET /counts, the Event summary): people and coupons per day and by pass group; arrived includes them;
       the survey's door check-in (services/survey.js isCheckedIn) sees them
     - settings: drinks.perPerson 1–5, a save without it keeps it; practice marks off the event days
   Starts a local mongod in a temp folder (skipped when the binary isn't there). Nothing leaves the machine: Sanity
   answers an empty list, Resend is never reached, no Stripe key. Fictional people, example.com. */
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
const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.startsWith("https://api.resend.com/")) { resendCalls += 1; return json({ id: "stub" }); }
  if (url.includes(".sanity.io/")) return json({ result: [] });
  throw new Error(`blocked in the test: ${url}`);
};
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });

let mongod = null;
let dbDir = "";
let server = null;
let base = "";
let mongoose;
let jwt;
let guestKey;
let personKey;
let isCheckedIn;
let fakeNow = new Date("2026-10-27T14:00:00Z"); // Day 2, 10:00 AM Toronto
const M = {};
const U = {};
let n = 0;
const cid = (p = "d") => `${p}${Date.now().toString(36)}${(n++).toString(36).padStart(5, "0")}`;
const D = "/api/checkin/desk";
const DAY2 = "2026-10-27";
const ticket = (ticketId, type, extra = {}) => ({ ticketId, type, purchaseDate: new Date("2026-10-01"), ...extra });

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-desk-drinks-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_desk_drinks`, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  ({ default: jwt } = await import("jsonwebtoken"));
  (await import("../services/checkinDeskLog.js")).setDeskClock(() => new Date(fakeNow));
  ({ guestKey, personKey } = await import("../services/checkinDesk.js"));
  ({ isCheckedIn } = await import("../services/survey.js"));
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
  app.use("/api/console/summary", (await import("../routes/eventSummary.js")).default);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const mk = async (k, doc) => { U[k] = await M.User.create(doc); };
  await mk("mia", { name: "Mia Manager", email: "mia.d@example.com", role: "admin", staffRole: "management" });
  await mk("sam", { name: "Sam Staff", email: "sam.d@example.com", role: "admin", staffRole: "staff" });
  await mk("val", { name: "Val Volunteer", email: "val.d@example.com", role: "volunteer" });
  await mk("vic", { name: "Vic Volunteer", email: "vic.d@example.com", role: "volunteer" });
  // A speaker with a Speaker Pass and a Power Pass: one person, coupons once.
  await mk("sid", { name: "Sid Twopass", email: "sid.d@example.com", tickets: [ticket("spk400000001", "speaker"), ticket("pow400000002", "power", { stripeSessionId: "cs_s" })] });
  // ISSUE PASS (contract C7): a speaker and Media with no pass on file.
  await mk("sia", { name: "Sia Nopass", email: "sia.d@example.com", types: ["speaker"], organization: "Talkco" });
  await mk("mel", { name: "Mel Nopass", email: "mel.d@example.com", types: ["media"], organization: "Daily Bytes" });
  const day1 = new Date("2026-10-26T13:05:00Z");
  await M.Attendee.create([
    // Collected their badge on Day 1 (the reason for the coupons): they never pass the pass desk on Day 2.
    { name: "Dana Dayone", email: "dana.d@example.com", ticketId: "con400000003", ticketType: "connect", stripeSessionId: "cs_d", checkedIn: true, checkedInAt: day1 },
    { name: "Lou Lobby", email: "lou.d@example.com", ticketId: "con400000004", ticketType: "connect", stripeSessionId: "cs_l", checkedIn: true, checkedInAt: day1 },
    { name: "Fay Firsttime", email: "fay.d@example.com", ticketId: "inf400000005", ticketType: "influence", stripeSessionId: "cs_f" },
    { name: "Una Undo", email: "una.d@example.com", ticketId: "apx400000006", ticketType: "apex", stripeSessionId: "cs_u", checkedIn: true, checkedInAt: day1 },
    { name: "Ari Again", email: "ari.d@example.com", ticketId: "pow400000007", ticketType: "power", stripeSessionId: "cs_a", checkedIn: true, checkedInAt: day1 },
    { name: "Pia Practice", email: "pia.d@example.com", ticketId: "con400000008", ticketType: "connect", stripeSessionId: "cs_p" },
    { name: "Set Settings", email: "set.d@example.com", ticketId: "con400000009", ticketType: "connect", stripeSessionId: "cs_x" },
    { name: "Vee Vip", email: "vee.d@example.com", ticketId: "pow400000010", ticketType: "power", vip: true, stripeSessionId: "cs_v", checkedIn: true, checkedInAt: day1 },
  ]);
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const tokenFor = (u, extra = {}) => jwt.sign({ id: String(u._id), ...extra }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function call(method, p, { as = U.sam, body } = {}) {
  const headers = { "content-type": "application/json", authorization: `Bearer ${tokenFor(as)}` };
  const r = await realFetch(`${base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let out = null;
  try { out = JSON.parse(text); } catch { out = text; }
  return { status: r.status, body: out };
}
const act = (body, as = U.val) => call("POST", `${D}/actions`, { as, body: { clientAt: fakeNow.toISOString(), ...body } });
const drinks = (key, extra = {}, as = U.val) => act({ clientId: cid(), kind: "mark", point: "drinks", station: "drinks", key, ...extra }, as);
const markOf = (subject, point, day = DAY2) => M.CheckinMark.findOne({ subject, day, point }).lean();
const K = (id) => guestKey(id);

test("Drinks station: a Day 1 badge holder gets the day's coupons (2 by default) and is marked arrived by the same tap", { skip }, async () => {
  const snap = (await call("GET", `${D}/snapshot`, { as: U.val })).body;
  assert.equal(snap.today.eventDay, "day2");
  assert.deepEqual(snap.drinks, { perPerson: 2, min: 1, max: 5, default: 2 }, "the stepper starts at the desk setting (default 2)");
  assert.ok(snap.stations.some((s) => s.key === "drinks" && s.label === "Drinks" && s.enabled), "the Drinks station is in the list");
  assert.equal(snap.stationStates.drinks.open, true);
  assert.equal(snap.stationStates.drinks.allDay, true, "no hours: open all day on an event day");
  assert.equal(snap.stationStates.drinks.text, "Day 2 · Drink coupons all day");

  const r = await drinks(K("con400000003"));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mark.point, "drinks");
  assert.equal(r.body.mark.count, 2);
  const ev = r.body.events[0];
  assert.equal(ev.point, "drinks");
  assert.deepEqual(ev.marks.map((m) => m.point).sort(), ["arrived", "drinks"], "the coupons and the day's arrival, in one event");
  const d = await markOf("con400000003", "drinks");
  const a = await markOf("con400000003", "arrived");
  assert.equal(d.item, "2");
  assert.equal(d.station, "drinks");
  assert.equal(a.ref, d.ref, "the arrival is this tap's (an undo takes both back)");
  assert.equal(a.station, "drinks");
  assert.equal(a.practice, false);
  // Nothing about the pass changes (collected on Day 1).
  assert.equal(ev.pass, undefined);
  assert.equal((await M.Attendee.findOne({ ticketId: "con400000003" }).lean()).checkedInAt.toISOString(), "2026-10-26T13:05:00.000Z");
  // The survey's door check-in sees them (services/surveyRules.js DOOR_POINTS: arrived, checked_in; unchanged).
  assert.equal(await isCheckedIn({ tickets: ["con400000003"] }, { directory: async () => ({ people: [], byId: new Map() }) }), true);
  // Every device gets the drinks mark with its count.
  const again = (await call("GET", `${D}/snapshot`, { as: U.vic })).body;
  const m = again.marks.find((x) => x.key === K("con400000003") && x.point === "drinks");
  assert.equal(m.count, 2);
  assert.equal(m.by.name, "Val Volunteer");
  assert.ok(again.marks.some((x) => x.key === K("con400000003") && x.point === "arrived"));
});

test("once per person per day: a second tap says who issued them and how many; another pass of theirs too", { skip }, async () => {
  const second = await drinks(K("con400000003"), {}, U.vic);
  assert.equal(second.status, 200);
  assert.equal(second.body.already, true);
  assert.match(second.body.message, /^Drink coupons already issued today at 10:00 AM by Val Volunteer · 2 coupons$/);
  assert.equal((await markOf("con400000003", "drinks")).item, "2", "nothing changed");
  // Sid holds two passes: coupons on his main one, then the other one's key is "already" too.
  const snap = (await call("GET", `${D}/snapshot`, { as: U.sam })).body;
  const sid = snap.guests.find((g) => g.name === "Sid Twopass");
  assert.equal(sid.keys.length, 2);
  const first = await drinks(sid.key);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const other = sid.keys.find((k) => k !== sid.key);
  const dup = await drinks(other, {}, U.vic);
  assert.equal(dup.body.already, true, JSON.stringify(dup.body));
  assert.equal(await M.CheckinMark.countDocuments({ day: DAY2, point: "drinks", subject: { $in: ["spk400000001", "pow400000002"] }, at: { $ne: null } }), 1);
  // Counts in range only.
  const bad = await drinks(K("con400000009"), { count: 6 });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.field, "count");
});

test("undo takes back exactly what the tap set: an arrival the lobby made earlier stays", { skip }, async () => {
  // Lou came through the lobby this morning, then got coupons.
  const lobby = await act({ clientId: cid("lob"), kind: "mark", point: "arrived", station: "lobby", key: K("con400000004") });
  assert.equal(lobby.status, 200);
  const lobbyRef = (await markOf("con400000004", "arrived")).ref;
  const tapId = cid();
  const r = await act({ clientId: tapId, kind: "mark", point: "drinks", station: "drinks", key: K("con400000004") });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.events[0].marks.map((m) => m.point), ["drinks"], "already arrived: the tap sets only the coupons");
  const u = await act({ clientId: cid("u"), kind: "undo", target: tapId, station: "drinks" });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.equal((await markOf("con400000004", "drinks")).at, null, "the coupons are taken back");
  const arr = await markOf("con400000004", "arrived");
  assert.ok(arr.at, "the lobby's arrival stays");
  assert.equal(arr.ref, lobbyRef);

  // Una: the coupons set her arrival, so the undo takes both back.
  const t2 = cid();
  await act({ clientId: t2, kind: "mark", point: "drinks", station: "drinks", key: K("apx400000006") });
  assert.ok((await markOf("apx400000006", "arrived")).at);
  const u2 = await act({ clientId: cid("u"), kind: "undo", target: t2, station: "drinks" });
  assert.equal(u2.status, 200);
  assert.equal((await markOf("apx400000006", "drinks")).at, null);
  assert.equal((await markOf("apx400000006", "arrived")).at, null);
  assert.deepEqual(u2.body.events[0].marks.map((m) => m.point).sort(), ["arrived", "drinks"]);
  // Issued again from scratch afterwards (the row was cleared, not deleted).
  const again = await drinks(K("apx400000006"), { count: 1 });
  assert.equal(again.body.mark.count, 1);
});

test("Issue again: volunteers can't; staff add more (an audited override); its undo puts the row back as it was", { skip }, async () => {
  const firstId = cid();
  await act({ clientId: firstId, kind: "mark", point: "drinks", station: "drinks", key: K("pow400000007") });
  const before = await markOf("pow400000007", "drinks");
  assert.equal(before.item, "2");
  const vol = await drinks(K("pow400000007"), { again: true, count: 1 }, U.vic);
  assert.equal(vol.status, 403);
  assert.equal(vol.body.code, "staff_only");

  fakeNow = new Date("2026-10-27T14:20:00Z");
  const againId = cid("again");
  const r = await act({ clientId: againId, kind: "mark", point: "drinks", station: "drinks", key: K("pow400000007"), again: true, count: 1 }, U.sam);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mark.count, 3, "2 + 1 more");
  assert.equal(r.body.mark.override, "issued_again");
  assert.equal(r.body.mark.by.name, "Sam Staff");
  assert.match(r.body.mark.overrideReason, /issued again/);
  const row = await markOf("pow400000007", "drinks");
  assert.equal(row.item, "3");
  assert.equal(row.ref, againId);
  assert.equal(row.prev.length, 1);
  const audit = await M.AdminAudit.findOne({ action: "checkin_desk_override", targetId: "pow400000007" }).lean();
  assert.ok(audit, "audited");
  assert.match(audit.detail, /Ari Again · Power Pass: 1 coupon more issued \(3 coupons today\) \(staff override\) \(Drinks\)/);
  // Issue again on someone with nothing yet today is an ordinary first issue.
  const fresh = await act({ clientId: cid(), kind: "mark", point: "drinks", station: "drinks", key: K("pow400000010"), again: true, count: 2 }, U.sam);
  assert.equal(fresh.body.mark.count, 2);
  assert.equal(fresh.body.mark.override || "", "");

  // Undo the "Issue again": back to 2, by the volunteer, at the first time; the arrival untouched.
  const u = await act({ clientId: cid("u"), kind: "undo", target: againId, station: "drinks" }, U.sam);
  assert.equal(u.status, 200, JSON.stringify(u.body));
  const after = await markOf("pow400000007", "drinks");
  assert.equal(after.item, "2");
  assert.equal(after.ref, firstId);
  assert.equal(after.override, "");
  assert.equal(after.byName, "Val Volunteer");
  assert.equal(after.at.toISOString(), before.at.toISOString());
  assert.deepEqual(after.prev, []);
  assert.equal(u.body.events[0].marks[0].count, 2, "devices get the row back as it was");
  assert.ok((await markOf("pow400000007", "arrived")).at, "the arrival stays");
  // Staff reset clears the day's coupons.
  const reset = await act({ clientId: cid("r"), kind: "reset", point: "drinks", station: "drinks", key: K("pow400000007") }, U.sam);
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.equal((await markOf("pow400000007", "drinks")).at, null);
  fakeNow = new Date("2026-10-27T14:00:00Z");
});

test("no pass on file: the Drinks station sends them to the pass desk; the pass desk issues coupons with the pass", { skip }, async () => {
  const snap = (await call("GET", `${D}/snapshot`, { as: U.val })).body;
  const sia = snap.guests.find((g) => g.name === "Sia Nopass");
  const mel = snap.guests.find((g) => g.name === "Mel Nopass");
  assert.equal(sia.noPass, true);
  const no = await drinks(sia.key);
  assert.equal(no.status, 409);
  assert.equal(no.body.code, "no_pass");
  assert.equal(no.body.error, "No pass on file: send them to the pass desk first.");
  assert.equal(await M.CheckinMark.countDocuments({ subject: { $regex: /^person:/ }, point: { $in: ["drinks", "arrived"] }, at: { $ne: null } }), 0, "nothing recorded");
  // The pass desk: coupons first, then the pass (either order).
  const desk = await act({ clientId: cid(), kind: "mark", point: "drinks", station: "desk", key: sia.key });
  assert.equal(desk.status, 200, JSON.stringify(desk.body));
  const issued = await act({ clientId: cid(), kind: "mark", point: "checked_in", station: "desk", key: sia.key });
  assert.equal(issued.status, 200);
  // Mel: checked in at the pass desk (pass issued), then the Drinks station gives the coupons.
  await act({ clientId: cid(), kind: "mark", point: "checked_in", station: "desk", key: mel.key });
  const ok = await drinks(mel.key);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.mark.count, 2);
  assert.equal(personKey((await M.CheckinMark.findOne({ point: "drinks", subject: { $regex: /^person:u-/ }, station: "drinks" }).lean()).subject), mel.key);
});

test("the pass desk, a first-time check-in: coupons and Checked in are independent, in either order", { skip }, async () => {
  // Fay comes up from the lobby; the desk hands over the coupons, then the pass.
  await act({ clientId: cid("lob"), kind: "mark", point: "arrived", station: "lobby", key: K("inf400000005") });
  const coupon = cid();
  const r = await act({ clientId: coupon, kind: "mark", point: "drinks", station: "desk", key: K("inf400000005") });
  assert.equal(r.status, 200);
  const checkin = await act({ clientId: cid(), kind: "mark", point: "checked_in", station: "desk", key: K("inf400000005") });
  assert.equal(checkin.status, 200);
  assert.equal(checkin.body.events[0].pass.collected, true, "the pass is collected by the check-in, as before");
  // Undo the coupons: the check-in, the pass collection and the lobby's arrival stay.
  const u = await act({ clientId: cid("u"), kind: "undo", target: coupon, station: "desk" });
  assert.equal(u.status, 200);
  assert.equal((await markOf("inf400000005", "drinks")).at, null);
  assert.ok((await markOf("inf400000005", "checked_in")).at);
  assert.ok((await markOf("inf400000005", "arrived")).at);
  assert.equal((await M.Attendee.findOne({ ticketId: "inf400000005" }).lean()).checkedIn, true);
  // …and the other order: checked in already, then the coupons.
  const late = await act({ clientId: cid(), kind: "mark", point: "drinks", station: "desk", key: K("inf400000005") });
  assert.equal(late.status, 200);
  assert.deepEqual(late.body.events[0].marks.map((m) => m.point), ["drinks"]);
});

test("counts: drink coupons per day (people, coupons, issued again) and by pass group; arrived includes them", { skip }, async () => {
  const c = await call("GET", `${D}/counts`, { as: U.sam });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const d2 = c.body.days.find((d) => d.day === "day2");
  // Dana 2, Sid 2, Una 1, Ari 0 (reset), Vee 2, Sia 2, Mel 2, Fay 2.
  assert.equal(d2.drinks.people, 7, JSON.stringify(d2.drinks));
  assert.equal(d2.drinks.coupons, 13);
  assert.deepEqual(d2.drinks.noPass, { people: 2, coupons: 4 });
  assert.deepEqual(d2.drinks.byPass.connect, { label: "Connect Pass", people: 1, coupons: 2 });
  assert.deepEqual(d2.drinks.byPass.speaker, { label: "Speaker", people: 1, coupons: 2 });
  assert.deepEqual(d2.drinks.byPass.vip, { label: "VIP", people: 1, coupons: 2 });
  assert.deepEqual(d2.drinks.byPass.apex, { label: "Apex Pass", people: 1, coupons: 1 });
  assert.equal(d2.drinks.issuedAgain, 0, "Ari's issue-again was undone, then reset");
  assert.equal(Object.values(d2.drinks.byPass).reduce((s, x) => s + x.people, 0) + d2.drinks.noPass.people, d2.drinks.people);
  // Arrived (each person once): the coupons' arrivals are in it (Dana, Sid, Una, Vee) with the lobby's and the desk's.
  assert.ok(d2.arrived >= 9, String(d2.arrived));
  const d1 = c.body.days.find((d) => d.day === "day1");
  assert.equal(d1.drinks.people, 0);
  // The Event summary: the same attendance.
  const s = await call("GET", "/api/console/summary?refresh=1");
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.attendance.days.find((d) => d.day === "day2").drinks, d2.drinks);
  assert.equal(resendCalls, 0, "nothing emailed");
});

test("settings: drink coupons per person (1–5), a save without it keeps it; the next tap issues that many", { skip }, async () => {
  const g = await call("GET", `${D}/settings`, { as: U.mia });
  assert.equal(g.body.drinks.perPerson, 2);
  const bad = await call("PUT", `${D}/settings`, { as: U.mia, body: { windows: {}, buffers: {}, stations: {}, drinks: { perPerson: 6 } } });
  assert.equal(bad.status, 400);
  const put = await call("PUT", `${D}/settings`, { as: U.mia, body: { windows: {}, buffers: {}, stations: {}, drinks: { perPerson: 3 } } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.drinks.perPerson, 3);
  // A page from before drink coupons saves the hours only: the number stays.
  const old = await call("PUT", `${D}/settings`, { as: U.mia, body: { windows: {}, buffers: {}, stations: { evening: true } } });
  assert.equal(old.status, 200);
  assert.equal(old.body.drinks.perPerson, 3);
  assert.equal((await call("GET", `${D}/clock`, { as: U.val })).body.drinks.perPerson, 3);
  const r = await drinks(K("con400000009"));
  assert.equal(r.body.mark.count, 3, "no count sent: the desk setting");
  await call("PUT", `${D}/settings`, { as: U.mia, body: { windows: {}, buffers: {}, stations: {}, drinks: { perPerson: 2 } } });
});

test("a day that isn't Day 1 / Day 2: practice coupons (and a practice arrival), never counted", { skip }, async () => {
  fakeNow = new Date("2026-10-25T15:00:00Z");
  const r = await drinks(K("con400000008"));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.events[0].practice, true);
  const d = await markOf("con400000008", "drinks", "2026-10-25");
  const a = await markOf("con400000008", "arrived", "2026-10-25");
  assert.equal(d.practice, true);
  assert.equal(a.practice, true);
  fakeNow = new Date("2026-10-27T14:00:00Z");
  await new Promise((ok) => setTimeout(ok, 1100)); // the Counts answer is kept for a second
  const c = await call("GET", `${D}/counts`, { as: U.sam });
  const d2 = c.body.days.find((x) => x.day === "day2");
  assert.equal(d2.drinks.people, 8, "Set's 3 from the settings test; practice marks never count");
  assert.equal(d2.drinks.coupons, 16);
  assert.equal(c.body.days.find((x) => x.day === "day1").drinks.people, 0);
});
