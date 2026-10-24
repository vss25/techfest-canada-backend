/* The door check-in card (Oct 22 2026) through POST /api/checkin/scan, against a real (throwaway) MongoDB: the
   colour band for every key (accounts and pass-only tickets), the photo (uploaded, speaker photo, none, never a
   buyer's on a colleague's pass), the pass name, "already checked in" with the same card, "invalid" with none, and
   nothing at all without the checkIn right (no token, an attendee's token).
   Starts a local mongod in a temp folder on a free port and stops it after; skipped when the binary isn't
   there (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Nothing leaves the
   machine: Sanity and Resend are answered by a stubbed fetch, no Stripe key. Fictional people, example.com. */
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

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.startsWith("https://api.resend.com/")) return new Response(JSON.stringify({ id: "stub" }), { status: 200, headers: { "content-type": "application/json" } });
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
const U = {};
const IMG = "https://cdn.sanity.io/images/021qtoci/production/nina123-800x800.jpg";

const ticket = (ticketId, type, extra = {}) => ({ ticketId, type, purchaseDate: new Date("2026-10-01"), ...extra });

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-checkin-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_checkin_test`, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  ({ default: jwt } = await import("jsonwebtoken"));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.Attendee = await imp("../models/Attendee.js");
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/checkin", (await import("../routes/checkin.js")).default);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const mk = (key, doc) => M.User.create(doc).then((u) => { U[key] = u; });
  await Promise.all([
    mk("door", { name: "Dee Door", email: "dee.door@example.com", role: "admin", staffRole: "staff" }),
    mk("vol", { name: "Val Volunteer", email: "val.volunteer@example.com", role: "volunteer", tickets: [ticket("vol300000001", "connect")] }),
    mk("ada", { name: "Ada Attendee", email: "ada.attendee@example.com", tickets: [ticket("apx300000002", "apex")] }),
    mk("vera", { name: "Vera Vip", email: "vera.vip@example.com", vip: true, types: ["speaker"], jobTitle: "Minister", organization: "Government of Ontario", avatarVersion: 3, avatarData: "data:image/png;base64,iVBORw0KGgo=", tickets: [ticket("pow300000003", "power")] }),
    mk("max", { name: "Max Media", email: "max.media@example.com", types: ["speaker", "media"], tickets: [ticket("pow300000004", "power")] }),
    mk("nina", { name: "Nina Speaker", email: "nina.speaker@example.com", tickets: [ticket("spk300000005", "speaker", { promoCode: "SPEAKER" })] }),
    mk("ola", { name: "Ola Organiser", email: "ola.organiser@example.com", types: ["staff", "volunteer"], tickets: [ticket("con300000006", "connect")] }),
    // Sam (staff, VIP, with a photo) bought a pass for a colleague while signed in: it's on his account with her name.
    mk("sam", { name: "Sam Buyer", email: "sam.buyer@example.com", role: "admin", vip: true, avatarVersion: 9, tickets: [ticket("col300000007", "influence", { details: { firstName: "Cara", lastName: "Colleague", jobTitle: "Engineer", organisation: "Acme" } })] }),
    mk("eve", { name: "Eve Exhibitor", email: "eve.exhibitor@example.com", tickets: [ticket("con300000008", "connect", { promoCode: "EXHIBITOR" })] }),
  ]);
  await M.Attendee.create([
    // Pass-only people (no app account).
    { name: "Gus Guest", email: "gus.guest@example.com", ticketId: "gst300000010", ticketType: "power", vip: true },
    { name: "Mo Media", email: "mo.media@example.com", ticketId: "gst300000011", ticketType: "power", media: true },
    { name: "Raj Patel", email: "raj.office@example.com", ticketId: "spk300000012", ticketType: "speaker", promoCode: "SPEAKER", speakerId: "spk-raj" },
    { name: "Ivy Influence", email: "ivy.influence@example.com", ticketId: "gst300000013", ticketType: "influence", details: { firstName: "Ivy", lastName: "Influence", jobTitle: "Analyst", organisation: "Acme" } },
    { name: "Xena Exhibitor", email: "xena.exhibitor@example.com", ticketId: "exh300000014", ticketType: "connect", promoCode: "EXHIBITOR" },
    // A guest pass bought with Ada's email for someone else: not Ada's account, not Ada's colour or photo.
    { name: "Ben Brother", email: "ada.attendee@example.com", ticketId: "gst300000015", ticketType: "connect" },
    // A guest pass under Max's email with his name: his account (Media), found by email.
    { name: "Max Media", email: "max.media@example.com", ticketId: "gst300000016", ticketType: "influence" },
  ]);
  // Speaker photos (the snapshot services/speakerPhotoStore.js loads from Sanity): Nina (an account) and Raj (pass-only).
  const { buildSpeakerPhotos, setSpeakerPhotos } = await import("../services/speakerPhotos.js");
  setSpeakerPhotos(buildSpeakerPhotos({
    speakers: [{ _id: "spk-nina", name: "Nina Speaker", imageUrl: IMG }, { _id: "spk-raj", name: "Raj Patel", imageUrl: IMG.replace("nina123", "raj456") }],
    passes: [
      { speakerId: "spk-nina", name: "Nina Speaker", email: "nina.speaker@example.com", ticketId: "spk300000005" },
      { speakerId: "spk-raj", name: "Raj Patel", email: "raj.office@example.com", ticketId: "spk300000012" },
    ],
    users: [{ _id: U.nina._id, name: "Nina Speaker", email: "nina.speaker@example.com", tickets: [{ ticketId: "spk300000005" }] }],
  }));
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const tokenFor = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function scan(ticketId, { as = U.door, token } = {}) {
  const headers = { "content-type": "application/json" };
  const tok = token === undefined ? tokenFor(as) : token;
  if (tok) headers.authorization = `Bearer ${tok}`;
  const r = await realFetch(`${base}/api/checkin/scan`, { method: "POST", headers, body: JSON.stringify({ ticketId }) });
  return { status: r.status, body: await r.json() };
}
const band = (b) => [b.badge?.key, b.badge?.label];
const CARD_KEYS = ["avatarUrl", "badge", "company", "cxoBreakfast", "extras", "name", "passName", "speaker", "ticketType", "title"];

test("check-in: the colour band for every key, accounts and pass-only tickets", { skip }, async () => {
  const want = {
    pow300000003: ["vip", "VIP"],            // Vera: VIP + speaker → VIP (door staff see it; the apps don't)
    gst300000010: ["vip", "VIP"],            // Gus: pass-only, his pass marked VIP
    pow300000004: ["media", "Media"],        // Max: media + speaker → media
    gst300000011: ["media", "Media"],        // Mo: pass-only, marked Media
    spk300000005: ["speaker", "Speaker"],    // Nina: her Speaker Pass
    spk300000012: ["speaker", "Speaker"],    // Raj: pass-only Speaker Pass
    con300000006: ["staff", "Staff"],        // Ola: staff + volunteer → staff
    vol300000001: ["volunteer", "Volunteer"],
    apx300000002: ["pass", "Apex Pass"],
    gst300000013: ["pass", "Influence Pass"],
    con300000008: ["pass", "Exhibitor"],     // Eve: an exhibitor on a Connect Pass
    exh300000014: ["pass", "Exhibitor"],     // Xena: pass-only exhibitor pass
    gst300000016: ["media", "Media"],        // Max's guest pass under his email and name: his account
  };
  const colors = { vip: "#F5C400", media: "#0B3D91", speaker: "#D01F2F", staff: "#7B2FD0", volunteer: "#FF6B00", pass: "#18A957" };
  for (const [id, b] of Object.entries(want)) {
    const r = await scan(`TECHFEST:${id}`);
    assert.equal(r.status, 200, `${id}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.status, "success", id);
    assert.deepEqual(band(r.body), b, id);
    assert.equal(r.body.badge.bg, colors[b[0]], id);
    assert.match(r.body.badge.text, /^#[0-9A-F]{6}$/, id);
    for (const k of CARD_KEYS) assert.ok(k in r.body, `${id}: ${k}`);
    assert.equal(r.body.ticketId, id);
    assert.ok(r.body.checkedInAt, id);
  }
});

test("check-in: pass names, name / title / company, meals, and nothing private", { skip }, async () => {
  const vera = (await scan("pow300000003")).body;   // already checked in by the test above
  assert.deepEqual(
    [vera.status, vera.name, vera.title, vera.company, vera.passName, vera.ticketType, vera.cxoBreakfast],
    ["already_checked_in", "Vera Vip", "Minister", "Government of Ontario", "Power Pass", "power", true],
  );
  assert.deepEqual(vera.extras, { cxo: true, lunch: true, gala: true, awards: true });
  const ivy = await M.Attendee.findOne({ ticketId: "gst300000013" }).lean();
  assert.equal(ivy.checkedIn, true);
  const nina = (await scan("spk300000005")).body;
  assert.deepEqual([nina.passName, nina.ticketType, nina.speaker], ["Speaker Pass", "speaker", true]);
  const xena = (await scan("exh300000014")).body;
  assert.deepEqual([xena.passName, xena.ticketType], ["Connect Pass", "connect"]);
  for (const b of [vera, nina, xena]) {
    assert.doesNotMatch(JSON.stringify(b), /@example\.com|avatarData|password|Exhibitor Pass|All Access/);
    assert.equal("vip" in b || "types" in b || "email" in b, false);
  }
});

test("check-in: photo = uploaded, else speaker photo, else none; never the buyer's or an email-sharer's", { skip }, async () => {
  assert.equal((await scan("pow300000003")).body.avatarUrl, `/api/files/avatar/${U.vera._id}?v=3`);
  assert.match((await scan("spk300000005")).body.avatarUrl, /^https:\/\/cdn\.sanity\.io\/images\/021qtoci\/production\/nina123-800x800\.jpg\?/);
  assert.match((await scan("spk300000012")).body.avatarUrl, /raj456/);   // pass-only speaker
  assert.equal((await scan("apx300000002")).body.avatarUrl, "");
  // Cara's pass on Sam's account: her name and job, the pass's own green, no photo (Sam is staff, VIP, with a photo).
  const cara = await scan("col300000007");
  assert.equal(cara.status, 200);
  assert.deepEqual(
    [cara.body.name, cara.body.title, cara.body.company, cara.body.avatarUrl, ...band(cara.body), cara.body.cxoBreakfast],
    ["Cara Colleague", "Engineer", "Acme", "", "pass", "Influence Pass", false],
  );
  // Ben's pass under Ada's email: Ben's name, a plain Connect Pass, no photo of Ada's.
  const ben = (await scan("gst300000015")).body;
  assert.deepEqual([ben.name, ...band(ben), ben.avatarUrl], ["Ben Brother", "pass", "Connect Pass", ""]);
});

test("check-in: already checked in keeps the card and the time; an unknown ticket gets no card", { skip }, async () => {
  const first = await scan("gst300000011");   // Mo, checked in by the first test
  assert.equal(first.body.status, "already_checked_in");
  assert.deepEqual(band(first.body), ["media", "Media"]);
  assert.equal(first.body.name, "Mo Media");
  assert.ok(first.body.time);
  const nope = await scan("nope00000000");
  assert.equal(nope.status, 404);
  assert.deepEqual(nope.body, { status: "invalid", message: "Ticket not found", error: "Ticket not found" });
  assert.equal((await scan("")).status, 400);
});

test("check-in: the card stays behind the checkIn right (no token, an attendee) — volunteers and staff have it", { skip }, async () => {
  const anon = await scan("apx300000002", { token: "" });
  assert.equal(anon.status, 401);
  const attendee = await scan("apx300000002", { as: U.ada });
  assert.equal(attendee.status, 403);
  const forged = await scan("apx300000002", { token: jwt.sign({ id: String(U.door._id) }, "not-the-secret") });
  assert.equal(forged.status, 401);
  for (const r of [anon, attendee, forged]) {
    for (const k of CARD_KEYS) assert.equal(k in r.body, false, k);
    assert.doesNotMatch(JSON.stringify(r.body), /Ada|Apex|#18A957|avatar/);
  }
  // A volunteer at the door gets the same card staff do (VIP included).
  const vol = await scan("gst300000010", { as: U.vol });
  assert.equal(vol.status, 200);
  assert.deepEqual(band(vol.body), ["vip", "VIP"]);
});

test("check-in: one ticket, every QR form (TECHFEST: or bare, any case, stray spaces) finds the same pass", { skip }, async () => {
  // Oct 24 2026, the organiser: "I need one QR code everywhere". Older PDF tickets and purchase emails hold the bare ID;
  // everything else (and now those too) "TECHFEST:<ticketId>" (services/doorQr.js). All of them check in the same pass.
  await M.Attendee.create({ name: "Quinn Qr", email: "quinn.qr@example.com", ticketId: "a1b2c3d4e5f6", ticketType: "connect" });
  await M.User.create({ name: "Rae Qr", email: "rae.qr@example.com", tickets: [ticket("0f9e8d7c6b5a", "power")] });
  const first = await scan("A1B2C3D4E5F6");
  assert.equal(first.status, 200);
  assert.equal(first.body.status, "success");
  assert.equal(first.body.ticketId, "a1b2c3d4e5f6");
  for (const form of ["TECHFEST:a1b2c3d4e5f6", "techfest:A1B2C3D4E5F6", " a1b2 c3d4 e5f6 ", "TECHFEST:A1B2C3D4E5F6\n"]) {
    const r = await scan(form);
    assert.equal(r.status, 200, form);
    assert.equal(r.body.status, "already_checked_in", form);
    assert.equal(r.body.ticketId, "a1b2c3d4e5f6", form);
    assert.equal(r.body.name, "Quinn Qr", form);
  }
  const acc = await scan("TECHFEST:0F9E8D7C6B5A");
  assert.equal(acc.body.status, "success");
  assert.equal(acc.body.ticketId, "0f9e8d7c6b5a");
  assert.equal((await scan("0f9e8d7c6b5a")).body.status, "already_checked_in");
  const stored = await M.User.findOne({ email: "rae.qr@example.com" }).lean();
  assert.equal(stored.tickets[0].checkedIn, true);
});
