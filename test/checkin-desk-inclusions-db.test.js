/* TTFC Check-in desk app, Oct 24 2026 (the organiser: "If I update the inclusion on pass type as an admin, the sync
   should be real time" and "On breakfast/lunch/dinner when I search a name I should be able to see whether they are
   permitted or not"), through the real routes and models against a real (throwaway) MongoDB:
     LIVE   an admin's inclusion change (Admin › People: a pass's Lunch switched on / off, the pass type changed,
            Media = Yes) reaches an open desk's live stream as an event carrying the guest's row with the server's
            inclusions (services/passExtras.js, the one rule) within seconds, and changes the desk's answer at the meal
            door at once (Not on the list → admitted; switched off again → refused)
     C11    "Not on the list" at a meal door: volunteers get 409 not_included (and 403 staff_only if they try the
            override); staff's "Admit anyway (override)" ({ notIncluded: true }) is recorded with override
            "not_included" (with a window override: "outside_window+not_included"), audited, the pass unchanged;
            no pass on file (ISSUE PASS) is still refused
   Starts a local mongod in a temp folder (skipped when the binary isn't there). Sanity answers nothing (the fallback
   agenda times); nothing else leaves the machine; no Stripe key. Fictional people. */
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
const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
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
// Day 1, 12:40 PM Toronto: the Networking Luncheon (fallback 12:35–1:20 PM, doors 12:05–1:50 PM) is open.
let fakeNow = new Date("2026-10-26T16:40:00Z");
const M = {};
const U = {};
let guestKey;
let n = 0;
const cid = (p = "t") => `${p}${Date.now().toString(36)}${(n++).toString(36).padStart(5, "0")}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const D = "/api/checkin/desk";
const DAY1 = "2026-10-26";

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-desk-incl-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_desk_incl`, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await sleep(250); }
  }
  ({ default: jwt } = await import("jsonwebtoken"));
  (await import("../services/checkinDeskLog.js")).setDeskClock(() => new Date(fakeNow));
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
  app.use("/api/console/people", (await import("../routes/people.js")).default);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const mk = async (k, doc) => { U[k] = await M.User.create(doc); };
  await mk("mia", { name: "Mia Manager", email: "mia.i@example.com", role: "admin", staffRole: "management" });
  await mk("sam", { name: "Sam Staff", email: "sam.i@example.com", role: "admin", staffRole: "staff" });
  await mk("val", { name: "Val Volunteer", email: "val.i@example.com", role: "volunteer" });
  // Media = Yes with no pass on file: ISSUE PASS (contract C7), never admitted to a meal.
  await mk("mel", { name: "Mel Nopass", email: "mel.i@example.com", types: ["media"], organization: "Daily Bytes" });
  await M.Attendee.create([
    { name: "Cora Connect", email: "cora.i@example.com", ticketId: "con500000001", ticketType: "connect", stripeSessionId: "cs_c1" },
    { name: "Gus Connect", email: "gus.i@example.com", ticketId: "con500000002", ticketType: "connect", stripeSessionId: "cs_c2" },
    { name: "Pia Connect", email: "pia.i@example.com", ticketId: "con500000003", ticketType: "connect", stripeSessionId: "cs_c3" },
    { name: "Max Connect", email: "max.i@example.com", ticketId: "con500000004", ticketType: "connect", stripeSessionId: "cs_c4" },
    { name: "Zed Connect", email: "zed.i@example.com", ticketId: "con500000005", ticketType: "connect", stripeSessionId: "cs_c5" },
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
  let j = null;
  try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j };
}
const act = (body, as = U.val) => call("POST", `${D}/actions`, { as, body: { clientAt: fakeNow.toISOString(), ...body } });
const K = (id) => guestKey(id);
const snapshot = async (as = U.sam) => { const s = await call("GET", `${D}/snapshot`, { as }); assert.equal(s.status, 200, JSON.stringify(s.body)); return s.body; };
const byName = (s, name) => s.guests.find((g) => g.name === name);
const lunch = (key, extra = {}, as = U.val) => act({ clientId: cid("lun"), kind: "mark", point: "lunch", key, station: "lunch", ...extra }, as);

/**
 * The desk's live stream (GET /api/checkin/desk/stream, as the app reads it: fetch with the token in a header), from
 * `since`: resolves with the first event `want(ev)` accepts and how long it took, or rejects after `ms`.
 */
function streamUntil(want, { since, as = U.val, ms = 8000 } = {}) {
  const ctrl = new AbortController();
  const t0 = Date.now();
  const done = (async () => {
    const r = await realFetch(`${base}${D}/stream?since=${since}`, { headers: { authorization: `Bearer ${tokenFor(as)}` }, signal: ctrl.signal });
    assert.equal(r.status, 200);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) throw new Error("stream ended");
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const type = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (!data || type !== "events") continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }
        for (const ev of parsed.events || []) if (want(ev)) return { ev, ms: Date.now() - t0 };
      }
    }
  })();
  const timer = new Promise((_, no) => setTimeout(() => no(new Error(`no matching live event within ${ms} ms`)), ms));
  return Promise.race([done, timer]).finally(() => ctrl.abort());
}

test("LIVE: an admin switches Lunch on for a Connect pass: every open desk gets the guest's new inclusions within seconds, and the lunch door's answer changes", { skip }, async () => {
  fakeNow = new Date("2026-10-26T16:40:00Z");
  const s0 = await snapshot();
  const cora = byName(s0, "Cora Connect");
  assert.ok(cora, "on the list");
  assert.deepEqual(cora.extras, { cxo: false, lunch: false, gala: false, awards: false }, "a Connect Pass: conference only");
  // Not on the list: the volunteer's tap is refused, and the override is staff's.
  const no = await lunch(cora.key);
  assert.equal(no.status, 409, JSON.stringify(no.body));
  assert.equal(no.body.code, "not_included");
  const volOverride = await lunch(cora.key, { notIncluded: true });
  assert.equal(volOverride.status, 403, JSON.stringify(volOverride.body));
  assert.equal(volOverride.body.code, "staff_only");
  assert.equal(await M.CheckinMark.countDocuments({ subject: "con500000001", point: "lunch", at: { $ne: null } }), 0);

  // A volunteer's desk is open (the live stream); an admin changes the pass in Admin › People.
  const live = streamUntil((ev) => (ev.kind === "inclusions" || ev.kind === "guest") && ev.guest?.name === "Cora Connect" && ev.guest.extras?.lunch === true, { since: s0.cursor });
  await sleep(300);
  const patched = await call("PATCH", `/api/console/people/${encodeURIComponent(cora.personId)}/passes/con500000001`, { as: U.sam, body: { extras: { lunch: true } } });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  const got = await live;
  assert.equal(got.ev.kind, "inclusions");
  assert.deepEqual(got.ev.extras, { cxo: false, lunch: true, gala: false, awards: false }, "the server's inclusions, all four");
  assert.equal(got.ev.guest.key, cora.key, "the same guest row on the desk");
  assert.ok(!("extrasView" in got.ev) && !("personId" in got.ev.guest), "a volunteer's stream never carries staff fields");
  assert.ok(got.ms < 5000, `reached the desk in ${got.ms} ms`);
  // A desk that loads now has it too, and the lunch door admits her (the server reads her inclusions from the database).
  assert.equal(byName(await snapshot(U.val), "Cora Connect").extras.lunch, true);
  const yes = await lunch(cora.key);
  assert.equal(yes.status, 200, JSON.stringify(yes.body));
  assert.equal(yes.body.events[0].override, undefined, "on the list: no override");

  // Switched off again: the next desk answer is "not on the list" (Pia, same pass type, still has it off; Cora's own lunch
  // mark stays: an RSVP / a mark made is never taken back).
  const off = streamUntil((ev) => ev.guest?.name === "Cora Connect" && ev.guest.extras?.lunch === false, { since: (await snapshot()).cursor });
  await sleep(300);
  assert.equal((await call("PATCH", `/api/console/people/${encodeURIComponent(cora.personId)}/passes/con500000001`, { as: U.sam, body: { extras: { lunch: false } } })).status, 200);
  const gotOff = await off;
  assert.ok(gotOff.ms < 5000, `switch-off reached the desk in ${gotOff.ms} ms`);
  assert.equal(byName(await snapshot(U.val), "Cora Connect").extras.lunch, false);
  const pia = byName(await snapshot(), "Pia Connect");
  assert.equal((await lunch(pia.key)).body.code, "not_included");
});

test("LIVE: changing the pass type (Connect → Power, management) and Media = Yes reach the desk with the new inclusions", { skip }, async () => {
  fakeNow = new Date("2026-10-26T16:45:00Z");
  const s0 = await snapshot();
  const gus = byName(s0, "Gus Connect");
  const toPower = streamUntil((ev) => ev.guest?.name === "Gus Connect" && ev.guest.tier === "power", { since: s0.cursor, as: U.sam });
  await sleep(300);
  const r = await call("PATCH", `/api/console/people/${encodeURIComponent(gus.personId)}/passes/con500000002`, { as: U.mia, body: { tier: "power" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const got = await toPower;
  assert.ok(got.ms < 5000, `${got.ms} ms`);
  assert.equal(got.ev.guest.passName, "Power Pass");
  assert.deepEqual(got.ev.guest.extras, { cxo: false, lunch: true, gala: true, awards: true }, "Power: luncheons, Gala and the Awards (no CxO Breakfast)");
  assert.ok(got.ev.guest.extrasView, "staff's stream has the switches");
  assert.equal((await lunch(gus.key)).status, 200, "the lunch door admits him now");

  // Media = Yes on Max's Connect Pass: all four, the CxO Breakfasts too (services/passExtras.js personExtras).
  const max = byName(await snapshot(), "Max Connect");
  const media = streamUntil((ev) => ev.guest?.name === "Max Connect" && ev.guest.marks?.media === true, { since: (await snapshot()).cursor });
  await sleep(300);
  assert.equal((await call("PATCH", `/api/console/people/${encodeURIComponent(max.personId)}`, { as: U.sam, body: { media: true } })).status, 200);
  const gotMedia = await media;
  assert.ok(gotMedia.ms < 5000, `${gotMedia.ms} ms`);
  assert.deepEqual(gotMedia.ev.guest.extras, { cxo: true, lunch: true, gala: true, awards: true });
});

test("C11: staff's Admit anyway (override) for a guest who isn't on the list: recorded and audited as an override, the pass unchanged", { skip }, async () => {
  fakeNow = new Date("2026-10-26T16:50:00Z");
  const pia = byName(await snapshot(), "Pia Connect");
  const before = await M.Attendee.findOne({ ticketId: "con500000003" }).lean();
  const r = await lunch(pia.key, { notIncluded: true }, U.sam);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.events[0].override, "not_included");
  assert.match(r.body.events[0].overrideReason, /not on their pass/);
  const m = await M.CheckinMark.findOne({ subject: "con500000003", day: DAY1, point: "lunch" }).lean();
  assert.equal(m.override, "not_included");
  const a = await M.AdminAudit.findOne({ action: "checkin_desk_override", targetId: "con500000003" }).lean();
  assert.ok(a, "audited");
  assert.match(a.detail, /^Pia Connect · Connect Pass: .*Networking Luncheon though it isn't on their pass \(staff override\) \(Lunch\)$/, a.detail);
  const after = await M.Attendee.findOne({ ticketId: "con500000003" }).lean();
  assert.equal(after.luncheons, before.luncheons, "the pass's own switch is untouched");
  assert.equal(byName(await snapshot(), "Pia Connect").extras.lunch, false, "still not included on the pass");
  // A second tap: already admitted.
  const again = await lunch(pia.key, { notIncluded: true }, U.sam);
  assert.equal(again.body.already, true);

  // Outside the lunch hours (2:30 PM) too: "Admit anyway" for the time first, then both, recorded together.
  fakeNow = new Date("2026-10-26T18:30:00Z");
  const zed = byName(await snapshot(), "Zed Connect");
  const late = await lunch(zed.key, { notIncluded: true }, U.sam);
  assert.equal(late.status, 409);
  assert.equal(late.body.code, "outside_window", "the hours are asked first");
  const both = await lunch(zed.key, { notIncluded: true, override: true }, U.sam);
  assert.equal(both.status, 200, JSON.stringify(both.body));
  assert.equal(both.body.events[0].override, "outside_window+not_included");
  assert.match(both.body.events[0].overrideReason, /not on their pass and outside its hours/);

  // No pass on file (ISSUE PASS): still a pass first, override or not.
  fakeNow = new Date("2026-10-26T16:55:00Z");
  const mel = byName(await snapshot(), "Mel Nopass");
  assert.equal(mel.noPass, true);
  const nopass = await lunch(mel.key, { notIncluded: true }, U.sam);
  assert.equal(nopass.status, 409, JSON.stringify(nopass.body));
  assert.equal(nopass.body.code, "not_included");
  assert.equal(nopass.body.noPass, true);
});
