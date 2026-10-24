/* TTFC Check-in desk app, Oct 23 2026 round 3, through the real routes and models against a real (throwaway) MongoDB:
     C7 ISSUE PASS   people on the list with no pass on file are guests ("n" keys): a speaker with no Speaker Pass, Media
                     and an exhibitor with no pass; hidden-only people stay out; Arrived and Checked in (= a pass issued
                     at the desk) on them; never a meal without a pass
     C8              NO DETAILS FOUND events and snapshot cards in the website's shapes
     C9              Arrived, Checked in, the media desk, AV and the exhibitor desk at 6 AM: no override, no audit; the
                     CxO Breakfast still keeps its hours
     C10             attendance by day in GET /api/checkin/desk/counts (staff, password sign-in) and GET
                     /api/console/summary: each person once per point and day, practice marks out, overrides counted,
                     a two-pass person, Media = Yes, an override admit, an ISSUE PASS guest, NO DETAILS FOUND
     R2              a pass given a moment ago (on another instance) counts at the meal door before any rebuild
     R3              a rehearsal door scan's desk marks are practice marks (in no attendance); the ticket write is unchanged
     R8              guest / inclusions events (and People's PATCH replies) carry the whole guest row
   Starts a local mongod in a temp folder (skipped when the binary isn't there). Sanity answers one speaker and an
   empty agenda (the fallback times); nothing else leaves the machine; no Stripe key. Fictional people. */
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
  if (url.includes(".sanity.io/")) {
    // The website's speaker list has one speaker with no pass row at all (contract C7); the agenda is empty.
    // Hana's only Speaker Pass is hidden (round 4: she stays out, not ISSUE PASS).
    if (decodeURIComponent(url).includes('_type=="speaker"')) {
      return json({ result: [{ _id: "spk-noel", name: "Noel Nopass", title: "Chief Scientist", company: "Quantumly" }, { _id: "spk-hana", name: "Hana Hiddenpass", title: "CTO", company: "Hideco" }] });
    }
    return json({ result: [] });
  }
  throw new Error(`blocked in the test: ${url}`);
};
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });

let mongod = null;
let dbDir = "";
let server = null;
let base = "";
let mongoose;
let jwt;
let fakeNow = new Date("2026-10-26T10:15:00Z"); // Day 1, 6:15 AM Toronto
const M = {};
const U = {};
let guestKey;
let personKey;
let n = 0;
const cid = (p = "t") => `${p}${Date.now().toString(36)}${(n++).toString(36).padStart(5, "0")}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const D = "/api/checkin/desk";
const DAY1 = "2026-10-26";
const ticket = (ticketId, type, extra = {}) => ({ ticketId, type, purchaseDate: new Date("2026-10-01"), ...extra });

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-desk-counts-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_desk_counts`, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await sleep(250); }
  }
  ({ default: jwt } = await import("jsonwebtoken"));
  (await import("../services/checkinDeskLog.js")).setDeskClock(() => new Date(fakeNow));
  ({ guestKey, personKey } = await import("../services/checkinDesk.js"));
  M.User = (await import("../models/User.js")).default;
  M.Attendee = (await import("../models/Attendee.js")).default;
  M.Rsvp = (await import("../models/Rsvp.js")).default;
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
  app.use("/api/console/summary", (await import("../routes/eventSummary.js")).default);
  app.use("/api/console/issued-passes", (await import("../routes/issuedPasses.js")).issuedPassRouter("issued"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const mk = async (k, doc) => { U[k] = await M.User.create(doc); };
  await mk("mia", { name: "Mia Manager", email: "mia.c@example.com", role: "admin", staffRole: "management" });
  await mk("sam", { name: "Sam Staff", email: "sam.c@example.com", role: "admin", staffRole: "staff" });
  await mk("val", { name: "Val Volunteer", email: "val.c@example.com", role: "volunteer" });
  await mk("priya", { name: "Priya Power", email: "priya.c@example.com", tickets: [ticket("pow300000001", "power", { stripeSessionId: "cs_p" })] });
  // A speaker with a Speaker Pass and a Power Pass: one person (counted once, under Speaker).
  await mk("sid", { name: "Sid Twopass", email: "sid.c@example.com", tickets: [ticket("spk300000002", "speaker"), ticket("pow300000003", "power", { stripeSessionId: "cs_s" })] });
  // ISSUE PASS (C7): a speaker, Media and an exhibitor with no pass at all; a speaker whose only pass staff hid (out).
  await mk("sia", { name: "Sia Speaker", email: "sia.c@example.com", types: ["speaker"], organization: "Talkco", jobTitle: "VP Research" });
  await mk("mel", { name: "Mel Media", email: "mel.c@example.com", types: ["media"], organization: "Daily Bytes" });
  await mk("exa", { name: "Exa Exhibitor", email: "exa.c@example.com", types: ["exhibitor"], organization: "Boothco" });
  await mk("hank", { name: "Hank Hidden", email: "hank.c@example.com", types: ["speaker"], tickets: [ticket("apx300000009", "apex", { hiddenByStaff: true })] });
  await M.Attendee.create([
    { name: "Mo Media", email: "mo.c@example.com", ticketId: "con300000004", ticketType: "connect", media: true, stripeSessionId: "cs_m" },
    { name: "Ana Apex", email: "ana.c@example.com", ticketId: "apx300000005", ticketType: "apex", stripeSessionId: "cs_a" },
    { name: "Gus Guest", email: "gus.c@example.com", ticketId: "con300000006", ticketType: "connect", stripeSessionId: "cs_g" },
    { name: "Ray Rehearsal", email: "ray.c@example.com", ticketId: "con300000007", ticketType: "connect", stripeSessionId: "cs_r" },
    // Ava: a paid Connect Pass, and an issued Power Pass (the luncheons and the evenings come from that one).
    { name: "Ava Twopass", email: "ava.c@example.com", ticketId: "con300000010", ticketType: "connect", stripeSessionId: "cs_av", purchaseDate: new Date("2026-09-01") },
    { name: "Ava Twopass", email: "ava.c@example.com", ticketId: "pow300000011", ticketType: "power", promoCode: "ISSUED", passEmailSentAt: new Date("2026-10-10"), purchaseDate: new Date("2026-10-10") },
    // A website speaker whose only pass (her Speaker Pass, never claimed) staff hid: not ISSUE PASS (contract C7).
    { name: "Hana Hiddenpass", email: "hana.c@example.com", ticketId: "spk300000013", ticketType: "speaker", promoCode: "SPEAKER", speakerId: "spk-hana", hiddenByStaff: true },
  ]);
  const at = new Date("2026-10-15T12:00:00Z");
  const r = (key, first, last, extra) => ({ key, firstName: first, lastName: last, name: `${first} ${last}`, nameKey: `${first} ${last}`.toLowerCase(),
    ticketVerified: true, kind: "ticket", tierVerified: true, source: "attendee", attendeeSubmittedAt: at, submissions: 1, ...extra });
  await M.Rsvp.create([
    r("t:pow300000001", "Priya", "Power", { ticketId: "POW300000001", tier: "power", days: ["day1", "day2"], options: ["lunch_d1", "awards"] }),
    r("t:spk300000002", "Sid", "Twopass", { ticketId: "SPK300000002", tier: "speaker", days: ["day1"], options: ["cxo_d1", "lunch_d1"] }),
    r("t:con300000004", "Mo", "Media", { ticketId: "CON300000004", tier: "connect", days: ["day1"], options: ["cxo_d1"] }),
    r("t:apx300000005", "Ana", "Apex", { ticketId: "APX300000005", tier: "apex", days: ["day1"], options: ["cxo_d1"] }),
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
  headers.authorization = `Bearer ${token || tokenFor(as)}`;
  const r = await realFetch(`${base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j };
}
const act = (body, as = U.val) => call("POST", `${D}/actions`, { as, body: { clientAt: fakeNow.toISOString(), ...body } });
const K = (id) => guestKey(id);
const markOf = (subject, point, day = DAY1) => M.CheckinMark.findOne({ subject, day, point }).lean();
const snapshot = async (as = U.sam) => { const s = await call("GET", `${D}/snapshot`, { as }); assert.equal(s.status, 200, JSON.stringify(s.body)); return s.body; };
const byName = (s, name) => s.guests.find((g) => g.name === name);
const mk2 = async (k, doc) => { U[k] = await M.User.create(doc); return U[k]; };

test("C7 ISSUE PASS: on the list with no pass on file (speaker, Media, exhibitor, the website's speaker list); hidden-only people out", { skip }, async () => {
  const s = await snapshot();
  for (const name of ["Sia Speaker", "Mel Media", "Exa Exhibitor", "Noel Nopass"]) {
    const g = byName(s, name);
    assert.ok(g, `${name} is a guest`);
    assert.equal(g.noPass, true, name);
    assert.equal(g.tier, null);
    assert.equal(g.passName, null);
    assert.match(g.key, /^n[0-9a-f]{20}$/);
    assert.deepEqual(g.keys, [g.key]);
    assert.deepEqual(g.extras, { cxo: false, lunch: false, gala: false, awards: false });
    assert.equal(g.passCollected, false);
    assert.equal(g.band.passName, "No pass on file");
    assert.ok(g.personId, "staff see who it is");
  }
  const sia = byName(s, "Sia Speaker");
  assert.deepEqual({ ...sia.marks }, { vip: false, media: false, speaker: true, exhibitor: false, staff: false, volunteer: false });
  assert.equal(sia.band.key, "speaker");
  assert.equal(sia.company, "Talkco");
  assert.equal(sia.title, "VP Research");
  assert.equal(sia.key, personKey(`person:${sia.personId}`), "the key is the person's, never a ticket's");
  assert.equal(byName(s, "Mel Media").marks.media, true);
  assert.equal(byName(s, "Mel Media").band.key, "media");
  assert.equal(byName(s, "Exa Exhibitor").marks.exhibitor, true);
  assert.equal(byName(s, "Noel Nopass").marks.speaker, true);
  assert.equal(byName(s, "Noel Nopass").company, "Quantumly");
  assert.ok(!byName(s, "Hank Hidden"), "a speaker whose only pass is hidden stays out");
  assert.ok(!byName(s, "Hana Hiddenpass"), "a website speaker whose only Speaker Pass is hidden (never claimed: the directory leaves it out) stays out too");
  assert.ok(!byName(s, "Val Volunteer") && !byName(s, "Sam Staff"), "staff and volunteers without a pass stay out");
  // Pass holders aren't ISSUE PASS.
  assert.equal(byName(s, "Priya Power").noPass, undefined);
  // Volunteers: the same rows without who it is.
  const v = await snapshot(U.val);
  const vs = byName(v, "Sia Speaker");
  assert.equal(vs.noPass, true);
  for (const k of ["personId", "email", "ticketIds", "extrasView"]) assert.ok(!(k in vs), `volunteers never get ${k}`);
});

test("C9: at 6 AM on Day 1 Arrived, the media desk, AV and the exhibitor desk are just recorded; the CxO Breakfast keeps its hours", { skip }, async () => {
  fakeNow = new Date("2026-10-26T10:15:00Z"); // 6:15 AM
  const arr = await act({ clientId: cid("arr"), kind: "mark", point: "arrived", key: K("pow300000001"), station: "lobby" });
  assert.equal(arr.status, 200, JSON.stringify(arr.body));
  assert.equal(arr.body.events[0].override, undefined);
  assert.equal((await markOf("pow300000001", "arrived")).override, "");
  for (const [point, station, key] of [["media", "media", K("con300000004")], ["av", "av", K("spk300000002")], ["exhibitor", "exhibitor", K("con300000006")]]) {
    const r = await act({ clientId: cid(point.slice(0, 3)), kind: "mark", point, key, station });
    assert.equal(r.status, 200, `${point}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.events[0].override, undefined, point);
  }
  // An offline lobby tap from 5:30 AM reaching the server now: recorded at its time, a late sync, but no override.
  const late = await act({ clientId: cid("arr"), kind: "mark", point: "arrived", key: K("spk300000002"), station: "lobby", clientAt: "2026-10-26T09:30:00.000Z" });
  assert.equal(late.status, 200, JSON.stringify(late.body));
  assert.equal(late.body.events[0].lateSync, true);
  assert.equal(late.body.events[0].override, undefined);
  assert.equal(await M.AdminAudit.countDocuments({ action: { $in: ["checkin_desk_override", "checkin_desk_late_sync"] } }), 0, "nothing audited");
  // The header says so.
  const clock = (await call("GET", `${D}/clock`, { as: U.val })).body;
  assert.equal(clock.stationStates.lobby.text, "Day 1 · Arrivals open all day");
  assert.equal(clock.stationStates.lobby.open, true);
  // The breakfast is still closed at 6:15: refused until "Admit anyway".
  const brk = await act({ clientId: cid("brk"), kind: "mark", point: "cxo", key: K("con300000004"), station: "breakfast" });
  assert.equal(brk.status, 409, JSON.stringify(brk.body));
  assert.equal(brk.body.code, "outside_window");
  assert.equal(clock.stationStates.breakfast.open, false);
});

test("C7: an ISSUE PASS guest is marked Arrived and Checked in (a pass issued at the desk: no ticket touched), never admitted to a meal", { skip }, async () => {
  fakeNow = new Date("2026-10-26T12:10:00Z"); // 8:10 AM
  const sia = byName(await snapshot(), "Sia Speaker");
  const arr = await act({ clientId: cid("arr"), kind: "mark", point: "arrived", key: sia.key, station: "lobby" });
  assert.equal(arr.status, 200, JSON.stringify(arr.body));
  assert.equal(arr.body.events[0].key, sia.key);
  assert.equal(arr.body.mark.key, sia.key);
  const chk = await act({ clientId: cid("chk"), kind: "mark", point: "checked_in", key: sia.key, station: "desk" });
  assert.equal(chk.status, 200, JSON.stringify(chk.body));
  assert.equal(chk.body.events[0].pass, undefined, "no ticket to collect");
  const subject = `person:${sia.personId}`;
  assert.ok((await markOf(subject, "checked_in")).at);
  assert.ok((await markOf(subject, "arrived")).at);
  assert.equal(await M.Attendee.countDocuments({ checkedIn: true }), 0, "no pass collected anywhere");
  // A second tap: already.
  assert.equal((await act({ clientId: cid("chk"), kind: "mark", point: "checked_in", key: sia.key, station: "desk" })).body.already, true);
  // The snapshot shows the marks on her row (keyed by her key).
  const s = await snapshot(U.val);
  assert.ok(s.marks.some((m) => m.key === sia.key && m.point === "checked_in" && m.at));
  // The breakfast: no pass, no meal (staff give a pass first).
  const brk = await act({ clientId: cid("brk"), kind: "mark", point: "cxo", key: sia.key, station: "breakfast" });
  assert.equal(brk.status, 409, JSON.stringify(brk.body));
  assert.equal(brk.body.code, "not_included");
  assert.match(brk.body.error, /^No pass on file/);
  // Staff's history and a reset work on her key.
  assert.equal((await call("GET", `${D}/history/${sia.key}`)).status, 200);
});

test("meals: a two-pass speaker, Media = Yes at the breakfast, an override admit, an ISSUE PASS guest's NO DETAILS FOUND neighbours", { skip }, async () => {
  fakeNow = new Date("2026-10-26T12:15:00Z"); // 8:15 AM: breakfast open
  // Sid checks in on his Power Pass (his main pass is the Speaker Pass): one person.
  const chk = await act({ clientId: cid("chk"), kind: "mark", point: "checked_in", key: K("pow300000003"), station: "desk" });
  assert.equal(chk.status, 200, JSON.stringify(chk.body));
  // Mo (Media = Yes on a Connect Pass): the CxO Breakfast is his.
  const mo = await act({ clientId: cid("brk"), kind: "mark", point: "cxo", key: K("con300000004"), station: "breakfast" });
  assert.equal(mo.status, 200, JSON.stringify(mo.body));
  // Ana (Apex) at 10:00, after the doors closed: "Admit anyway", an audited override.
  fakeNow = new Date("2026-10-26T14:00:00Z");
  const ana = await act({ clientId: cid("brk"), kind: "mark", point: "cxo", key: K("apx300000005"), station: "breakfast", override: true });
  assert.equal(ana.status, 200, JSON.stringify(ana.body));
  assert.equal(ana.body.events[0].override, "outside_window");
  // A practice mark that somehow sits on Day 1 (never counted), and Gus's lobby arrival undone (never counted).
  await M.CheckinMark.create({ subject: "con300000006", day: DAY1, point: "arrived", at: new Date("2026-10-26T13:00:00Z"), practice: true, ref: "practice-row-1" });
  // NO DETAILS FOUND: five recorded, one undone; closed three ways, one left open.
  const ids = [];
  for (const name of ["Zed One", "Zed Two", "Zed Three", "Zed Four", "Zed Five"]) {
    const id = cid("unk");
    ids.push(id);
    const r = await act({ clientId: id, kind: "unknown_arrival", name, company: "Somewhere", note: "says she registered", station: "lobby" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const close = async (id, outcome) => {
    const r = await act({ clientId: cid("done"), kind: "unknown_done", target: `u:${id}`, outcome, station: "desk" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r;
  };
  const sent = await close(ids[0], "sent_to_help");
  // C8 shapes: the event the website applies.
  const ev = sent.body.events[0];
  assert.deepEqual([ev.kind, ev.key, ev.outcome, ev.byName], ["unknown_done", `u:${ids[0]}`, "sent_to_help", "Val Volunteer"]);
  assert.ok(ev.at);
  await close(ids[1], "left");
  await close(ids[2], "pass_issued");
  const un = await act({ clientId: cid("und"), kind: "undo", target: ids[4], station: "lobby", clientAt: new Date(fakeNow.getTime() + 2000).toISOString() });
  assert.equal(un.status, 200, JSON.stringify(un.body));
  assert.equal(un.body.events[0].key, `u:${ids[4]}`);
  const s = await snapshot();
  assert.deepEqual(s.unknowns.map((u) => [u.name, u.status]), [["Zed One", "sent_to_help"], ["Zed Two", "left"], ["Zed Three", "pass_issued"], ["Zed Four", "open"]]);
  for (const u of s.unknowns) {
    for (const f of ["key", "name", "company", "note", "at", "byName", "status"]) assert.ok(f in u, `unknowns[].${f}`);
    assert.equal(u.key, `u:${u.clientId}`);
  }
  // Day 2: Priya again (both days).
  fakeNow = new Date("2026-10-27T13:00:00Z");
  assert.equal((await act({ clientId: cid("arr"), kind: "mark", point: "arrived", key: K("pow300000001"), station: "lobby" })).status, 200);
});

test("R3: a rehearsal door scan's desk marks are practice marks (in no attendance); the scanner's own ticket write is unchanged", { skip }, async () => {
  fakeNow = new Date("2026-10-25T15:00:00Z"); // Sun Oct 25
  const scan = await call("POST", "/api/checkin/scan", { as: U.val, body: { ticketId: "con300000007" } });
  assert.equal(scan.body.status, "success", JSON.stringify(scan.body));
  // The desk's records come after the scanner's answer: wait for its event.
  const evOf = async (day) => { for (let i = 0; i < 80; i++) { const x = await M.CheckinEvent.findOne({ subject: "con300000007", kind: "mark", day }).lean(); if (x) return x; await sleep(25); } return null; };
  assert.ok(await evOf("2026-10-25"));
  const m = await markOf("con300000007", "checked_in", "2026-10-25");
  assert.ok(m?.at, "the desk shows it");
  assert.equal(m.practice, true);
  assert.equal(m.passSetAt, null, "a practice mark never owns the pass collection");
  assert.equal((await markOf("con300000007", "arrived", "2026-10-25")).practice, true);
  assert.equal((await evOf("2026-10-25")).practice, true);
  assert.equal((await M.Attendee.findOne({ ticketId: "con300000007" }).lean()).checkedIn, true, "the scanner collected the pass as it always has");
  // A staff reset of the practice check-in doesn't give the scanner's collection back.
  const rs = await act({ clientId: cid("rst"), kind: "reset", point: "arrived", key: K("con300000007"), station: "desk" }, U.sam);
  assert.equal(rs.status, 200, JSON.stringify(rs.body));
  assert.equal((await M.Attendee.findOne({ ticketId: "con300000007" }).lean()).checkedIn, true);
  // Scanned again on Day 1: a real check-in mark (the pass was collected before).
  fakeNow = new Date("2026-10-26T13:30:00Z");
  await call("POST", "/api/checkin/scan", { as: U.val, body: { ticketId: "con300000007" } });
  assert.ok(await evOf(DAY1));
  const d1 = await markOf("con300000007", "checked_in");
  assert.ok(d1?.at);
  assert.equal(d1.practice, false);
});

test("R2: a pass given a moment ago on another instance counts at the meal door at once (before any rebuild here)", { skip }, async () => {
  fakeNow = new Date("2026-10-26T16:40:00Z"); // 12:40 PM: lunch
  await snapshot(); // this instance's index (and its directory copy): Gus holds a Connect Pass only
  const no = await act({ clientId: cid("lun"), kind: "mark", point: "lunch", key: K("con300000006"), station: "lunch" });
  assert.equal(no.status, 409, JSON.stringify(no.body));
  assert.equal(no.body.code, "not_included");
  // Give a pass on another instance: an issued Power Pass to his address (this instance's directory isn't told).
  await M.Attendee.create({ name: "Gus Guest", email: "gus.c@example.com", ticketId: "pow300000012", ticketType: "power", promoCode: "ISSUED", passEmailSentAt: new Date("2026-10-26T16:39:00Z") });
  const yes = await act({ clientId: cid("lun"), kind: "mark", point: "lunch", key: K("con300000006"), station: "lunch" });
  assert.equal(yes.status, 200, JSON.stringify(yes.body));
  assert.equal((await markOf("con300000006", "lunch")).item, "lunch_d1");
  // Hidden by staff a moment later (another instance again): the next door refuses at once.
  await M.Attendee.updateOne({ ticketId: "pow300000012" }, { $set: { hiddenByStaff: true } });
  fakeNow = new Date("2026-10-26T21:30:00Z"); // 5:30 PM: Awards Night
  const ev = await act({ clientId: cid("eve"), kind: "mark", point: "evening", key: K("con300000006"), station: "evening" });
  assert.equal(ev.status, 409, JSON.stringify(ev.body));
  await M.Attendee.updateOne({ ticketId: "pow300000012" }, { $set: { hiddenByStaff: false } });
  const { forgetPeople } = await import("../routes/people.js");
  forgetPeople();
});

test("R8: guest and inclusions events, and People's replies, carry the guest's whole row (inclusions across all their passes)", { skip }, async () => {
  fakeNow = new Date("2026-10-26T17:00:00Z");
  const ava = byName(await snapshot(), "Ava Twopass");
  assert.equal(ava.ticketId, "con300000010", "her main pass is the paid Connect Pass");
  assert.equal(ava.extras.lunch, true, "the luncheons come from her Power Pass");
  // Staff switch the luncheons off on her Connect Pass: she still has them (the Power Pass includes them).
  const r = await call("PATCH", `/api/console/people/${ava.personId}/passes/${ava.ticketId}`, { body: { extras: { lunch: false } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const onePass = r.body.person.passes.find((t) => t.ticketId === "con300000010");
  assert.equal(onePass.extras.lunch.included, false, "that one pass's answer");
  assert.equal(r.body.deskGuest.key, ava.key);
  assert.equal(r.body.deskGuest.extras.lunch, true, "the guest's own inclusions: use this, never the one pass's");
  assert.equal(r.body.deskGuest.extrasView.lunch.ticketId, "pow300000011");
  const inc = await M.CheckinEvent.findOne({ kind: "inclusions", seq: r.body.deskSeq }).lean();
  assert.equal(inc.extras.lunch, true);
  assert.equal(inc.guest.name, "Ava Twopass");
  assert.deepEqual(inc.guest.keys, ava.keys);
  // Give a pass: the guest event carries the new guest's row.
  const made = await call("POST", "/api/console/issued-passes", { body: { name: "Wes Walkin", email: "wes.c@example.com", tier: "influence" } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const gev = await M.CheckinEvent.findOne({ kind: "guest", subject: made.body.row.ticketId.toLowerCase() }).lean();
  assert.equal(gev.guest?.name, "Wes Walkin");
  assert.equal(gev.guest.passName, "Influence Pass");
  // The devices get the row as volunteers may see it.
  const evs = (await call("GET", `${D}/events?since=${gev.seq - 1}`, { as: U.val })).body.events;
  const seen = evs.find((e) => e.seq === gev.seq);
  assert.equal(seen.guest.name, "Wes Walkin");
  assert.ok(!("email" in seen.guest));
  // An inclusions change whose person can't be read: a row-less guest event (the desks reload), never one pass's extras.
  const Log = await import("../services/checkinDeskLog.js");
  const bare = await Log.deskInclusionsChanged({ ticketId: "con300000010", extras: { lunch: false }, user: U.sam, person: null });
  assert.equal(bare.kind, "guest");
  assert.equal(bare.guest, undefined);
  assert.equal(bare.extras, undefined);
  // Staff delete Wes's pass: the event says so (no row: he's gone).
  const del = await call("DELETE", `/api/console/issued-passes/${made.body.row.id}`, { as: U.mia });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(await M.CheckinEvent.countDocuments({ kind: "guest", subject: made.body.row.ticketId.toLowerCase() }), 2);
});

test("C7: someone who came through as ISSUE PASS and was given a pass since: one row, their marks on it, counted once", { skip }, async () => {
  fakeNow = new Date("2026-10-26T13:00:00Z"); // 9:00 AM
  const exa = byName(await snapshot(), "Exa Exhibitor");
  assert.equal(exa.noPass, true);
  const arr = await act({ clientId: cid("arr"), kind: "mark", point: "arrived", key: exa.key, station: "lobby" });
  assert.equal(arr.status, 200, JSON.stringify(arr.body));
  // The pass desk gives her a pass (Give a pass, her address): she's a pass holder now, the same person.
  const made = await call("POST", "/api/console/issued-passes", { body: { name: "Exa Exhibitor", email: "exa.c@example.com", tier: "connect" } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const tid = made.body.row.ticketId;
  const s = await snapshot(U.val);
  const rows = s.guests.filter((g) => g.name === "Exa Exhibitor");
  assert.equal(rows.length, 1, "one row");
  assert.equal(rows[0].noPass, undefined);
  assert.equal(rows[0].passName, "Connect Pass");
  assert.equal(rows[0].key, K(tid));
  assert.ok(rows[0].keys.includes(exa.key), "her arrival (on her no-pass key) shows on her row");
  assert.ok(s.marks.some((m) => m.key === exa.key && m.point === "arrived" && m.at));
  // A device still holding her old row checks her in on the old key: recorded on her pass, which is now collected.
  const chk = await act({ clientId: cid("chk"), kind: "mark", point: "checked_in", key: exa.key, station: "desk" });
  assert.equal(chk.status, 200, JSON.stringify(chk.body));
  assert.equal(chk.body.mark.key, K(tid));
  assert.equal((await M.Attendee.findOne({ ticketId: tid }).lean()).checkedIn, true);
});

test("C10: attendance by day for the desk (staff, password sign-in) and the Event summary: each person once, practice out, overrides counted", { skip }, async () => {
  fakeNow = new Date("2026-10-26T17:30:00Z");
  // Who may read it.
  assert.equal((await call("GET", `${D}/counts`, { as: U.val })).status, 403, "volunteers");
  const code = await call("GET", `${D}/counts`, { token: tokenFor(U.sam, { via: "email" }) });
  assert.equal(code.status, 403);
  assert.equal(code.body.code, "password_required");
  const r = await call("GET", `${D}/counts`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = r.body;
  assert.deepEqual(a.attendance.days, a.days, "the same under `attendance`");
  const [d1, d2] = a.days;
  assert.deepEqual([d1.day, d1.date, d1.label, d2.day, d2.date], ["day1", DAY1, "Day 1", "day2", "2026-10-27"]);
  // Day 1 arrived: Priya (6:15), Sid (5:30 late sync, and checked in on his other pass: once), Sia (ISSUE PASS), Ray (Day 1
  // scan), Exa (ISSUE PASS, then a pass: once). Not Gus (only a practice row and a lunch), not Mo / Ana (meals and the media
  // desk only), not the NO DETAILS ones.
  assert.equal(d1.arrived, 5);
  assert.equal(d1.checkedIn, 4, "Sid, Sia, Ray, Exa");
  // Passes collected by the end of Day 1: Sid's Power Pass (the desk), Ray's (the rehearsal scan on Oct 25), Exa's new one.
  assert.equal(d1.passesCollectedToDate, 3);
  assert.deepEqual(d1.meals.cxo, {
    key: "cxo_d1", label: "CxO Breakfast", admitted: 2, entitled: d1.meals.cxo.entitled, rsvpd: 3, admittedOfRsvpd: 2, pctOfRsvpd: 67, noShows: 1,
    overrides: 1, notRsvpdAdmitted: 0, notEntitledAdmitted: 0,
  });
  assert.equal(d1.meals.lunch.label, "Networking Luncheon");
  assert.equal(d1.meals.lunch.admitted, 1, "Gus, on the pass given a moment before");
  assert.equal(d1.meals.lunch.notRsvpdAdmitted, 1);
  assert.deepEqual([d1.meals.dinner.key, d1.meals.dinner.label, d1.meals.dinner.admitted], ["awards", "Catalyst Awards Night", 0]);
  assert.deepEqual([d2.meals.dinner.key, d2.meals.dinner.label], ["gala", "Gala Dinner & Networking Reception"]);
  // By pass colour, each person once: Sid under Speaker, Mo under Media (not also Connect), Ana Apex, Priya and Ray.
  assert.deepEqual(d1.byPass.speaker, { label: "Speaker", people: 1, arrived: 1, checkedIn: 1, cxo: 0, lunch: 0, dinner: 0 });
  assert.deepEqual([d1.byPass.media.cxo, d1.byPass.media.people], [1, 1]);
  assert.equal(d1.byPass.connect.cxo, 0);
  assert.equal(d1.byPass.apex.cxo, 1);
  // Priya under Power; Ray, Exa and Gus under Connect (Gus's main pass is still the one he paid for, as on the Event summary).
  assert.deepEqual([d1.byPass.power.arrived, d1.byPass.power.lunch, d1.byPass.connect.arrived, d1.byPass.connect.checkedIn, d1.byPass.connect.lunch], [1, 0, 2, 2, 1]);
  const sumArrived = Object.values(d1.byPass).reduce((t, x) => t + x.arrived, 0);
  assert.equal(sumArrived + d1.issuePass.arrivedNoPass, d1.arrived, "the groups and the ISSUE PASS guests still without a pass add up to the total");
  // ISSUE PASS: Sia and Exa came through it, both handed a pass at the desk; Sia still has none; Mel and Noel didn't come.
  assert.deepEqual(d1.issuePass, { people: 3, arrived: 2, issued: 2, arrivedNoPass: 1 });
  assert.deepEqual(d1.noDetails, { recorded: 4, open: 1, sentToHelp: 1, passIssued: 1, left: 1, linked: 0 });
  assert.equal(d1.unmatched, 0);
  // Day 2: Priya again.
  assert.equal(d2.arrived, 1);
  assert.deepEqual(a.overall, { arrived: 5, checkedIn: 4, bothDays: 1 });
  // Practice marks never count, on any day.
  assert.ok(!a.days.some((d) => d.date === "2026-10-25"));
  assert.equal(a.practiceExcluded, true);

  // The Event summary: the same attendance (same rules), with its own entitled / RSVP'd per meal.
  const s = await call("GET", "/api/console/summary?refresh=1");
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const sa = s.body.attendance;
  assert.deepEqual(sa.days, (await call("GET", `${D}/counts`)).body.days);
  const row = (key) => s.body.meals.rows.find((m) => m.key === key);
  assert.equal(sa.days[0].meals.cxo.entitled, row("cxo_d1").entitled, "entitled: the Event summary's own count");
  assert.equal(sa.days[0].meals.cxo.rsvpd, row("cxo_d1").rsvpd);
  assert.equal(sa.days[0].meals.lunch.entitled, row("lunch_d1").entitled);
  assert.equal(sa.days[1].meals.dinner.rsvpd, row("gala").rsvpd);
  assert.equal(sa.days[0].meals.cxo.entitled, 3, "Sid (speaker), Mo (Media = Yes), Ana (Apex)");
  assert.equal((await call("GET", "/api/console/summary", { as: U.val })).status, 403, "volunteers never read the summary");
});

/* ---------- Round 4 (Oct 24 2026): the round-3 verifier's V5, V7, V8; the Counts limit ---------- */

test("C7: a pass given on ANOTHER instance to an ISSUE PASS guest: one row here at once (the event's row in place of the ISSUE PASS one), counted once", { skip }, async () => {
  fakeNow = new Date("2026-10-26T18:00:00Z"); // Day 1, 2 PM
  const People = await import("../routes/people.js");
  const Log = await import("../services/checkinDeskLog.js");
  await mk2("nia", { name: "Nia Newsdesk", email: "nia.c@example.com", types: ["media"], organization: "Wire Daily" });
  People.forgetPeople(); // (a person added since the last build: this instance's next reload has her)
  const nia = byName(await snapshot(U.val), "Nia Newsdesk");
  assert.equal(nia.noPass, true);
  assert.equal((await act({ clientId: cid("arr"), kind: "mark", point: "arrived", key: nia.key, station: "lobby" })).status, 200);
  const before = (await call("GET", `${D}/counts`)).body.days[0];
  // Another instance gives her a pass: its directory, its guest event with her row; this instance isn't told otherwise.
  const tid = "CON300000077";
  await M.Attendee.create({ name: "Nia Newsdesk", email: "nia.c@example.com", ticketId: tid, ticketType: "connect", promoCode: "ISSUED", passEmailSentAt: new Date("2026-10-26T17:59:00Z") });
  const there = await People.directory({ fresh: true });
  const ev = await Log.deskGuestChanged({ ticketIds: [tid], user: U.sam, person: there.byId.get(`t-${tid.toLowerCase()}`) });
  assert.equal(ev.guest.passName, "Connect Pass");
  const seen = (await call("GET", `${D}/events?since=${ev.seq - 1}`, { as: U.val })).body.events.find((e) => e.seq === ev.seq);
  assert.ok(!("aliasSubjects" in seen.guest), "the ids it goes by stay on the server");
  // This instance's snapshot (its index still has the ISSUE PASS row): one row, the pass one, her arrival on it.
  for (const as of [U.val, U.sam]) {
    const s = await snapshot(as);
    const rows = s.guests.filter((g) => g.name === "Nia Newsdesk");
    assert.equal(rows.length, 1, `one row (${as.name}): ${JSON.stringify(rows.map((g) => g.key))}`);
    assert.equal(rows[0].key, K(tid));
    assert.equal(rows[0].noPass, undefined);
    assert.ok(rows[0].keys.includes(nia.key), "her ISSUE PASS arrival shows on her row");
    if (as === U.sam) assert.ok(s.attendance.some((x) => x.day === DAY1 && x.point === "arrived" && x.people >= 1));
  }
  // The Counts: still her once (arrived, never twice), the groups plus ISSUE PASS still add up.
  const d1 = (await call("GET", `${D}/counts`)).body.days[0];
  assert.equal(d1.arrived, before.arrived, "she isn't counted twice");
  const groups = Object.values(d1.byPass).reduce((t, x) => t + x.arrived, 0);
  assert.equal(groups + d1.issuePass.arrivedNoPass, d1.arrived);
});

test("C7: once a pass is given, staff's reset of Arrived and the history on their row include the marks made on their ISSUE PASS row", { skip }, async () => {
  const People = await import("../routes/people.js");
  People.forgetPeople(); // this instance's index has her pass now
  const s = await snapshot();
  const nia = s.guests.find((g) => g.name === "Nia Newsdesk");
  assert.equal(nia.noPass, undefined);
  const old = nia.keys.find((k) => k.startsWith("n"));
  assert.ok(old, "her old key is still on her row (today has a mark on it)");
  const h = await call("GET", `${D}/history/${nia.key}`);
  assert.equal(h.status, 200, JSON.stringify(h.body));
  assert.ok(h.body.events.some((e) => e.kind === "mark" && e.point === "arrived" && e.key === old), "her ISSUE PASS arrival is in her history");
  const rs = await act({ clientId: cid("rst"), kind: "reset", point: "arrived", key: nia.key, station: "desk" }, U.sam);
  assert.equal(rs.status, 200, JSON.stringify(rs.body));
  assert.ok(!rs.body.noop, "something was reset");
  assert.ok(rs.body.events[0].marks.some((m) => m.key === old && m.point === "arrived" && m.at === null), "the arrival on her old key");
  assert.equal(await M.CheckinMark.countDocuments({ subject: `person:u-${U.nia._id}`, day: DAY1, at: { $ne: null } }), 0, "her ISSUE PASS arrival is cleared");
  assert.ok((await snapshot()).marks.every((m) => !(m.key === old && m.at)), "not arrived any more");
});

test("R2: at the meal door, someone whose only pass was hidden a moment ago gets nothing included, never a colleague's pass on the same address", { skip }, async () => {
  fakeNow = new Date("2026-10-26T16:40:00Z"); // 12:40 PM, Day 1 lunch
  const People = await import("../routes/people.js");
  await M.Attendee.create([
    { name: "Kim Colleague", email: "shared.c@corp.example", ticketId: "pow300000021", ticketType: "power", stripeSessionId: "cs_k", purchaseDate: new Date("2026-09-01") },
    { name: "Jo Guest", email: "shared.c@corp.example", ticketId: "inf300000022", ticketType: "influence", stripeSessionId: "cs_j", purchaseDate: new Date("2026-09-05") },
  ]);
  People.forgetPeople();
  const s = await snapshot();
  const jo = byName(s, "Jo Guest");
  assert.equal(jo.extras.lunch, true, "her Influence Pass includes the luncheons");
  assert.notEqual(jo.personId, byName(s, "Kim Colleague").personId, "two people on one address");
  // Staff hide Jo's only pass on another instance (this one isn't told): nothing is included for her any more.
  await M.Attendee.updateOne({ ticketId: "inf300000022" }, { $set: { hiddenByStaff: true } });
  const r = await act({ clientId: cid("lun"), kind: "mark", point: "lunch", key: jo.key, station: "lunch" });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, "not_included");
  await M.Attendee.updateOne({ ticketId: "inf300000022" }, { $set: { hiddenByStaff: false } });
  assert.equal((await act({ clientId: cid("lun"), kind: "mark", point: "lunch", key: jo.key, station: "lunch" })).status, 200, "shown again: admitted");
});

test("GET /counts: several iPads on one staff sign-in may refresh often (130 in a minute, no 429)", { skip }, async () => {
  const all = await Promise.all(Array.from({ length: 130 }, () => call("GET", `${D}/counts`)));
  assert.deepEqual([...new Set(all.map((r) => r.status))], [200]);
});

test("nothing was emailed", { skip }, () => {
  assert.equal(resendCalls, 0);
});
