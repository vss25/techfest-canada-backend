/* A person's profile opened from anywhere (a comment's name, the People list, a chat) — GET /api/social/users/:id
   (Oct 22 2026): the full public card they chose to share, the same as their People list row (photo with the speaker
   fallback, title, company, tagline, country, topics, LinkedIn, when and where they meet, kind and badges, their
   organisation's key), their profile colour (a pass holder's tier only on their own), the contact details they share
   with a connection, the connection's status; blocks, hidden people and staff's "hide from the attendee list" as
   before. Against a real (throwaway) MongoDB; Sanity is a stubbed fetch, nothing leaves the machine. Starts a local
   mongod in a temp folder on a free port and stops it after; skipped when the binary isn't there (TTFC_TEST_MONGOD,
   else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Fictional people, example.com. */
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

const PHOTO = "https://cdn.sanity.io/images/021qtoci/production/nicole0002-800x800.jpg";
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.includes(".sanity.io/")) {
    const result = url.includes("image.asset") ? [{ _id: "spk-nicole", name: "Nicole Louis", imageUrl: PHOTO }] : [];
    return new Response(JSON.stringify({ result }), { status: 200, headers: { "content-type": "application/json" } });
  }
  throw new Error(`blocked in the test: ${url}`);
};

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port) => new Promise((ok) => { const c = net.connect(port, "127.0.0.1", () => { c.end(); ok(true); }); c.on("error", () => ok(false)); });

let mongod = null;
let dbDir = "";
let server = null;
let base = "";
let jwt;
let mongoose;
let setSpeakerPhotos;
const M = {};
const U = {};

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-profile-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await pause(250);
  await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_profile_test`);
  ({ default: jwt } = await import("jsonwebtoken"));
  ({ setSpeakerPhotos } = await import("../services/speakerPhotos.js"));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.Attendee = await imp("../models/Attendee.js");
  Object.assign(M, await import("../models/Admin.js"), await import("../models/Social.js"));
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/social", await imp("../routes/social.js"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const onApp = { appOnboarded: true, lastActiveAt: new Date("2026-10-21T12:00:00Z") };
  const pass = (id, type) => [{ ticketId: id, type, purchaseDate: new Date("2026-10-01") }];
  const mk = (key, doc) => M.User.create({ ...onApp, ...doc }).then((u) => { U[key] = u; });
  await Promise.all([
    mk("mia", { name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management" }),
    mk("ben", { name: "Ben Viewer", email: "ben.viewer@example.com", tickets: pass("con110000001", "connect") }),
    mk("nicole", {
      name: "Nicole Louis", email: "nicole.louis@example.com", tickets: pass("spk110000001", "speaker"),
      jobTitle: "Chief Marketing Officer", organization: "Louis & Co", tagline: "Brand, AI and community", country: "Canada",
      topics: ["AI", "Marketing", "Community"], linkedinUrl: "https://www.linkedin.com/in/nicole-louis-example",
      availabilitySlots: ["d1-10", "d1-12"], meetingSpot: "Harbour Ballroom foyer", availabilitySpots: { "d1-12": "Expo floor" },
      fieldOfWork: "Marketing", objectives: ["Meet partners"],
    }),
    mk("cal", {
      name: "Cal Power", email: "cal.power@example.com", tickets: pass("pow110000001", "power"), jobTitle: "VP", organization: "Calco",
      contactItems: [{ id: "ph", kind: "phone", label: "", value: "+1 416 555 0123", shareByDefault: true }], contactCardSavedAt: new Date(),
    }),
    mk("dee", { name: "Dee Listed-Not", email: "dee.hidden@example.com", tickets: pass("con110000002", "connect"), directoryHidden: true }),
    mk("hal", { name: "Hal Hidden", email: "hal.hidden@example.com", tickets: pass("con110000003", "connect"),
      appHidden: { at: new Date("2026-10-21T10:00:00Z"), byName: "Mia", reason: "test" } }),
    mk("bob", { name: "Bob Blocked", email: "bob.blocked@example.com", tickets: pass("con110000004", "connect") }),
  ]);
  await M.Attendee.create({ name: "Nicole Louis", email: "nicole.louis@example.com", ticketId: "spk110000001", ticketType: "speaker",
    promoCode: "SPEAKER", speakerId: "spk-nicole", claimedBy: U.nicole._id });
  await M.Block.create({ userId: U.ben._id, blockedId: U.bob._id });
  const { refreshSpeakerPhotos } = await import("../services/speakerPhotoStore.js");
  await refreshSpeakerPhotos({ fetchImpl: globalThis.fetch });
});

after(async () => {
  server?.close();
  setSpeakerPhotos?.(null);
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
const ok = async (p, want = 200) => {
  const r = await p;
  assert.equal(r.status, want, JSON.stringify(r.body));
  return r.body;
};
const idOf = (u) => String(u._id);
const profile = (as, u) => call("GET", `/api/social/users/${idOf(u)}`, { as });

test("the full card they share, the same as their People list row, with their (speaker) photo and colour", { skip }, async () => {
  const p = await ok(profile(U.ben, U.nicole));
  assert.match(p.avatarUrl, /^https:\/\/cdn\.sanity\.io\/images\/021qtoci\/production\/nicole0002-800x800\.jpg\?w=256&h=256&fit=crop&fm=webp&q=80/);
  assert.deepEqual([p.name, p.jobTitle, p.organization, p.tagline, p.country, p.linkedinUrl, p.meetingSpot],
    ["Nicole Louis", "Chief Marketing Officer", "Louis & Co", "Brand, AI and community", "Canada", "https://www.linkedin.com/in/nicole-louis-example", "Harbour Ballroom foyer"]);
  assert.deepEqual(p.topics, ["AI", "Marketing", "Community"]);
  assert.deepEqual(p.availabilitySlots, ["d1-10", "d1-12"]);
  assert.deepEqual(p.availabilitySpots, { "d1-12": "Expo floor" });   // the rest: meetingSpot
  assert.deepEqual([p.kind, p.tier, p.types], ["speaker", "Speaker", ["speaker"]]);
  assert.deepEqual(p.profileTag, { key: "speaker", label: "Speaker" });
  assert.equal(typeof p.orgKey, "string");
  assert.deepEqual([p.fieldOfWork, p.objectives], ["Marketing", ["Meet partners"]]);
  assert.deepEqual([p.connectionId, p.connectionStatus, p.sharedContact], ["", "", []]);
  for (const k of ["email", "role", "tickets", "contactItems", "appHidden"]) assert.equal(k in p, false, k);
  // Every field of their People list row is on the profile, with the same value.
  const row = (await ok(call("GET", "/api/social/attendees", { as: U.ben }))).find((x) => x.id === idOf(U.nicole));
  for (const k of Object.keys(row).filter((x) => !["ticketType", "purchaseDate"].includes(x))) {
    assert.deepEqual(p[k], row[k], k);
  }
});

test("a pass holder's tier shows only on their own profile; contact details once connected", { skip }, async () => {
  const others = await ok(profile(U.ben, U.cal));
  assert.deepEqual([others.profileTag, others.tier], [{ key: "pass", label: "Delegate" }, ""]);
  const own = await ok(profile(U.cal, U.cal));
  assert.deepEqual(own.profileTag, { key: "pass", label: "Power" });
  assert.deepEqual(others.sharedContact, []);
  const req = await ok(call("POST", "/api/social/connections/request", { as: U.ben, body: { toUserId: idOf(U.cal) } }), 201);
  assert.equal((await ok(profile(U.ben, U.cal))).connectionStatus, "pending");
  await ok(call("POST", `/api/social/connections/${req.id}/respond`, { as: U.cal, body: { accept: true, share: ["ph"] } }));
  const now = await ok(profile(U.ben, U.cal));
  assert.equal(now.connectionStatus, "accepted");
  assert.deepEqual(now.sharedContact.map((x) => [x.kind, x.value]), [["phone", "+1 416 555 0123"]]);
});

test("blocks and hidden people: not found; staff's 'hide from the attendee list': only once you've connected or chatted", { skip }, async () => {
  assert.deepEqual(await profile(U.ben, U.bob), { status: 404, body: { error: "Not found" } });
  assert.equal((await profile(U.bob, U.ben)).status, 404);
  assert.equal((await profile(U.ben, U.hal)).status, 404);
  assert.equal((await profile(U.mia, U.hal)).status, 200);                // staff see hidden people
  assert.equal((await profile(U.hal, U.hal)).status, 200);                // and they see themselves
  assert.equal((await profile(U.ben, U.dee)).status, 404);
  await ok(call("POST", `/api/social/messages/${idOf(U.ben)}`, { as: U.dee, body: { body: "Hello Ben" } }), 201);
  assert.equal((await ok(profile(U.ben, U.dee))).name, "Dee Listed-Not");
});
