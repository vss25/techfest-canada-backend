/* Ready for the event days (Oct 22 2026): 300 people, 50–70 on the app at once, most of them on the venue's Wi-Fi
   behind one public address. Against a real (throwaway) MongoDB:
     - sign-in (ticket ID, emailed code, password), the RSVP lookup and the apps' analytics don't lock a whole room
       out from one address, while the per-ticket, per-email and per-device limits still hold;
     - the feed, one post and the held queue leave legacy inline photos (imageData) in the database and still link them;
     - the chat list's "sent by me" half has an index;
     - the attendee directory's reads are shared (and still per viewer).
   Every request comes "from" 203.0.113.7 (X-Forwarded-For, trust proxy 1, as on Render). Starts a local mongod in a
   temp folder on a free port and stops it after; skipped when the binary isn't there (TTFC_TEST_MONGOD, else
   ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). No email is sent. Fictional people, example.com. */
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
process.env.TTFC_DIRECTORY_CACHE_MS = "15000"; // the directory's cache on, as on the server
delete process.env.STRIPE_SECRET_KEY;

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.includes(".sanity.io/")) return new Response(JSON.stringify({ result: [] }), { status: 200, headers: { "content-type": "application/json" } });
  throw new Error(`blocked in the test: ${url}`);
};

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port) => new Promise((ok) => { const c = net.connect(port, "127.0.0.1", () => { c.end(); ok(true); }); c.on("error", () => ok(false)); });

const VENUE = "203.0.113.7";
const PHOTO = `data:image/jpeg;base64,${Buffer.alloc(300_000, 7).toString("base64")}`; // a 400 KB legacy photo

let mongod = null;
let dbDir = "";
let server = null;
let base = "";
let jwt;
let mongoose;
let forgetDirectory;
const M = {};
const U = {};
const codes = [];
const ops = []; // mongoose debug: { coll, method, args }

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-load-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await pause(250);
  await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_load_test`, { readPreference: "primary" });
  mongoose.set("debug", (coll, method, ...args) => ops.push({ coll, method, args }));
  ({ default: jwt } = await import("jsonwebtoken"));
  ({ forgetDirectory } = await import("../services/directoryCache.js"));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.Attendee = await imp("../models/Attendee.js");
  Object.assign(M, await import("../models/Social.js"));
  await M.SocialMessage.init();
  const { default: express } = await import("express");
  const { createEmailLinkRouter } = await import("../routes/emailLink.js");
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/auth", await imp("../routes/auth.js"));
  app.use("/api/auth", await imp("../routes/ticketAuth.js"));
  app.use("/api/auth", createEmailLinkRouter({ send: async (kind, p) => { if (kind === "signin") codes.push(p.code); } }));
  app.use("/api/app", await imp("../routes/appApi.js"));
  app.use("/api/social", await imp("../routes/social.js"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const onApp = { appOnboarded: true, lastActiveAt: new Date("2026-10-21T12:00:00Z") };
  const mk = (key, doc) => M.User.create(doc).then((u) => { U[key] = u; });
  await Promise.all([
    mk("mia", { name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management", ...onApp }),
    mk("ben", { name: "Ben Normal", email: "ben.normal@example.com", tickets: [{ ticketId: "con600000001", type: "connect" }], ...onApp }),
    mk("cal", { name: "Cal Normal", email: "cal.normal@example.com", tickets: [{ ticketId: "con600000002", type: "connect" }], ...onApp }),
  ]);
  // 40 guests who bought passes and haven't signed in yet: they all arrive on the venue's Wi-Fi.
  await M.Attendee.create(Array.from({ length: 40 }, (_, i) => ({
    name: `Vera${i} Venue${i}`, email: `vera${i}.venue@example.com`, ticketId: `ven6${String(i).padStart(8, "0")}`, ticketType: "connect",
  })));
});

after(async () => {
  server?.close();
  if (mongoose) { mongoose.set("debug", false); await mongoose.disconnect().catch(() => {}); }
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const tokenFor = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function call(method, url, { as, body, ip = VENUE } = {}) {
  const r = await realFetch(base + url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(as ? { authorization: `Bearer ${tokenFor(as)}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const statuses = (rs) => rs.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});

/* ---------------- one address for the whole room ---------------- */

test("ticket sign-in: 12 typos then 40 people from one address all get in; one ticket's guesses are still capped", { skip }, async () => {
  const typos = [];
  for (let i = 0; i < 12; i++) typos.push(await call("POST", "/api/auth/ticket-login", { body: { ticketId: `ven6${String(i).padStart(8, "0")}`, lastName: "Typo" } }));
  assert.deepEqual(statuses(typos), { 401: 12 }, "the old limit (8 per address) answered 429 from the 9th");
  const ins = [];
  for (let i = 0; i < 40; i++) ins.push(await call("POST", "/api/auth/ticket-login", { body: { ticketId: `TECHFEST:VEN6${String(i).padStart(8, "0")}`, lastName: `Venue${i}` } }));
  assert.deepEqual(statuses(ins), { 200: 40 });
  assert.ok(ins.every((r) => typeof r.body.token === "string"));
  // Guessing one person's last name: 5 different names per ticket, from any address.
  const guesses = [];
  for (const g of ["A", "B", "C", "D", "E", "F"]) guesses.push((await call("POST", "/api/auth/ticket-login", { body: { ticketId: "ven600000039", lastName: g } })).status);
  assert.deepEqual(guesses, [401, 401, 401, 401, 429, 429]);
});

test("emailed codes: 30 people ask from one address; one address can't flood a single inbox", { skip }, async () => {
  const asks = [];
  for (let i = 0; i < 30; i++) asks.push(await call("POST", "/api/auth/email-link", { body: { email: `vera${i}.venue@example.com` } }));
  assert.deepEqual(statuses(asks), { 200: 30 }, "the old limit (20 per address) answered 429 from the 21st");
  assert.equal(codes.length, 30);
  const same = [];
  for (let i = 0; i < 6; i++) same.push((await call("POST", "/api/auth/email-link", { body: { email: "ben.normal@example.com" } })).status);
  assert.deepEqual(same, [200, 200, 200, 200, 200, 429]);
});

test("password sign-in: 40 wrong passwords on 40 accounts from one address aren't a lockout; one account is still capped", { skip }, async () => {
  const tries = [];
  for (let i = 0; i < 40; i++) tries.push(await call("POST", "/api/auth/login", { body: { email: `vera${i}.venue@example.com`, password: "wrong-password" } }));
  assert.equal(statuses(tries)[429], undefined, "the old limit (30 per address) answered 429 from the 31st");
  const one = [];
  for (let i = 0; i < 9; i++) one.push((await call("POST", "/api/auth/login", { body: { email: "cal.normal@example.com", password: "nope" } })).status);
  assert.equal(one.at(-1), 429);
  assert.ok(!one.slice(0, 8).includes(429));
});

test("analytics: 70 phones on one address, 3 batches each, are all taken; one device is still limited", { skip }, async () => {
  const at = new Date().toISOString();
  const sends = [];
  for (let round = 0; round < 3; round++) {
    sends.push(...await Promise.all(Array.from({ length: 70 }, (_, i) => call("POST", "/api/app/events", {
      body: { deviceId: `phone-${i}`, platform: "ios", appVersion: "1.4 (20)", events: [{ name: "screen_view", at, props: { screen: "home" } }] },
    }))));
  }
  assert.deepEqual(statuses(sends), { 200: 210 }, "the old limit (120 batches per address a minute) answered 429 from the 121st");
  let last = 0;
  for (let i = 0; i < 121; i++) last = (await call("POST", "/api/app/events", { body: { deviceId: "chatty-phone", events: [] } })).status;
  assert.equal(last, 429);
  assert.equal((await call("POST", "/api/app/events", { body: { deviceId: "phone-0", events: [] } })).status, 200, "others carry on");
});

test("RSVP lookup: 60 people on one address can look themselves up", { skip }, async () => {
  const { makeRsvpHandlers } = await import("../services/rsvpHandler.js");
  const h = makeRsvpHandlers({ requireTicket: false, lookup: async () => ({ kind: "none" }), store: {}, log: { error() {} } });
  const codesSeen = [];
  for (let i = 0; i < 60; i++) {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
    await h.lookup({ body: { firstName: `Person${i}`, lastName: "Venue" }, ip: VENUE }, res);
    codesSeen.push(res.statusCode);
  }
  assert.ok(!codesSeen.includes(429), "the old limit (40 per address) answered 429 from the 41st");
});

/* ---------------- the feed without legacy photos ---------------- */

test("feed, one post and the held queue: legacy photos stay in the database and are still linked", { skip }, async () => {
  const [legacy, cloud, held] = await M.SocialPost.create([
    { authorId: U.ben._id, authorName: "Ben Normal", body: "Old-style photo", imageData: PHOTO, status: "approved" },
    { authorId: U.cal._id, authorName: "Cal Normal", body: "Cloudinary photo", status: "approved",
      media: [{ type: "image", url: "https://res.cloudinary.com/demo/image/upload/v1/ttfc/a.jpg", publicId: "ttfc/a", width: 800, height: 600 }] },
    { authorId: U.ben._id, authorName: "Ben Normal", body: "Held with a photo", imageData: PHOTO, status: "held" },
  ]);
  ops.length = 0;
  const feed = await call("GET", "/api/social/feed", { as: U.cal });
  assert.equal(feed.status, 200);
  const byId = Object.fromEntries(feed.body.map((p) => [p.id, p]));
  assert.equal(byId[legacy.id].imageUrl, `/api/files/post/${legacy.id}`);
  assert.deepEqual(byId[legacy.id].media.map((m) => m.url), [`/api/files/post/${legacy.id}`]);
  assert.match(byId[cloud.id].imageUrl, /^https:\/\/res\.cloudinary\.com\//, "a Cloudinary photo is linked as before");
  assert.equal(byId[cloud.id].media.length, 1);
  assert.ok(!(held.id in byId), "someone else's held post isn't in the feed");
  const own = await call("GET", "/api/social/feed", { as: U.ben });
  assert.equal(own.body.find((p) => p.id === held.id)?.imageUrl, `/api/files/post/${held.id}`, "the author still sees their held post");
  assert.ok(JSON.stringify(feed.body).length < 20_000, "no photo bytes in the answer");
  const postReads = ops.filter((o) => o.coll === "socialposts");
  assert.ok(postReads.length >= 2);
  for (const o of postReads) {
    assert.equal(o.method, "aggregate", `a ${o.method} on socialposts loads imageData`);
    assert.ok(JSON.stringify(o.args).includes('"$unset":"imageData"'));
  }

  ops.length = 0;
  const one = await call("GET", `/api/social/feed/${legacy.id}`, { as: U.cal });
  assert.equal(one.status, 200);
  assert.equal(one.body.imageUrl, `/api/files/post/${legacy.id}`);
  assert.ok(ops.filter((o) => o.coll === "socialposts").every((o) => o.method === "aggregate"));
  assert.equal((await call("GET", "/api/social/feed/0123456789abcdef01234567", { as: U.cal })).status, 404);

  const queue = await call("GET", "/api/social/admin/held", { as: U.mia });
  assert.equal(queue.status, 200);
  assert.equal(queue.body.posts.find((p) => p.id === held.id)?.imageUrl, `/api/files/post/${held.id}`);
});

/* ---------------- the chat list ---------------- */

test("chat list: both halves of { from me } OR { to me } use an index", { skip }, async () => {
  const key = [String(U.ben._id), String(U.cal._id)].sort().join(":");
  await M.SocialMessage.create(Array.from({ length: 30 }, (_, i) => ({
    threadKey: key, fromUserId: i % 2 ? U.ben._id : U.cal._id, toUserId: i % 2 ? U.cal._id : U.ben._id, body: `Hi ${i}`, status: "approved",
  })));
  const idx = await M.SocialMessage.collection.indexes();
  assert.ok(idx.some((x) => JSON.stringify(x.key) === JSON.stringify({ fromUserId: 1, createdAt: -1 })), JSON.stringify(idx.map((x) => x.key)));
  const me = U.ben._id;
  const plan = await M.SocialMessage.collection.find({ $or: [{ fromUserId: me, status: { $ne: "hidden" } }, { toUserId: me, status: "approved" }] }).explain();
  assert.doesNotMatch(JSON.stringify(plan.queryPlanner.winningPlan), /COLLSCAN/);
  const list = await call("GET", "/api/social/messages", { as: U.ben });
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
});

/* ---------------- the attendee directory ---------------- */

// The directory's read (services/directoryCache.js); the organisations list makes its own, with its own cache.
const directoryReads = () => ops.filter((o) => o.coll === "users" && o.method === "find" && JSON.stringify(o.args[0] || {}).includes('"appOnboarded":true')).length;

test("attendee directory: one read for many requests, still per viewer; a new person shows after the cache", { skip }, async () => {
  forgetDirectory();
  ops.length = 0;
  const together = await Promise.all([U.ben, U.cal, U.ben, U.cal, U.mia].map((u) => call("GET", "/api/social/attendees", { as: u })));
  assert.ok(together.every((r) => r.status === 200));
  assert.equal(directoryReads(), 1, "requests in flight together share one read");
  const ids = (r) => r.body.map((p) => p.id);
  assert.ok(!ids(together[0]).includes(String(U.ben._id)), "never yourself");
  assert.ok(ids(together[0]).includes(String(U.cal._id)));
  assert.ok(!ids(together[1]).includes(String(U.cal._id)));
  assert.ok(ids(together[1]).includes(String(U.ben._id)));
  const search = await call("GET", "/api/social/attendees?q=vera1", { as: U.ben });
  assert.ok(search.body.length >= 1 && search.body.every((p) => /vera1/i.test(p.name)));
  assert.equal(directoryReads(), 1, "kept for the next requests too");

  await M.User.create({ name: "Nina New", email: "nina.new@example.com", tickets: [{ ticketId: "con600000099", type: "connect" }], appOnboarded: true });
  const stale = await call("GET", "/api/social/attendees", { as: U.ben });
  assert.ok(!stale.body.some((p) => p.name === "Nina New"), "within the cache time");
  forgetDirectory();
  const fresh = await call("GET", "/api/social/attendees", { as: U.ben });
  assert.ok(fresh.body.some((p) => p.name === "Nina New"));
  assert.equal(directoryReads(), 2);
});

test("the directory cache: the time limit, a failed read keeps the last rows, forget during a read", async () => {
  const { makeDirectoryCache } = await import("../services/directoryCache.js");
  let now = 0;
  let n = 0;
  let fail = false;
  const c = makeDirectoryCache({ ttlMs: 1000, now: () => now, log: { error() {} }, load: async () => { if (fail) throw new Error("db down"); n += 1; return { n }; } });
  assert.deepEqual(await c.get(), { n: 1 });
  now = 999;
  assert.deepEqual(await c.get(), { n: 1 });
  now = 1000;
  assert.deepEqual(await c.get(), { n: 2 });
  fail = true;
  now = 5000;
  assert.deepEqual(await c.get(), { n: 2 }, "the last good rows");
  fail = false;
  // A forget while a read is running: that read's answer isn't kept.
  now = 9000;
  const p = c.get();
  c.forget();
  assert.deepEqual(await p, { n: 3 });
  assert.deepEqual(await c.get(), { n: 4 });
  // TTL 0: nothing is kept, but reads in flight together are shared.
  let m = 0;
  const z = makeDirectoryCache({ ttlMs: 0, load: async () => { m += 1; await pause(5); return m; } });
  assert.deepEqual(await Promise.all([z.get(), z.get(), z.get()]), [1, 1, 1]);
  assert.equal(await z.get(), 2);
  // Nothing to fall back on: the error goes to the caller.
  const bad = makeDirectoryCache({ load: async () => { throw new Error("db down"); } });
  await assert.rejects(bad.get(), /db down/);
});
