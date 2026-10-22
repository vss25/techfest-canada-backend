/* Web Push (Oct 21 2026) through the real routes and services, against a real (throwaway) MongoDB: the VAPID key
   pair made once (race-safe) and kept, env keys winning, the private key never in an answer; subscribe /
   unsubscribe, one owner per endpoint, five per person; the fan-out from a chat message, a broadcast, 404 / 410
   cleanup, banned people skipped, a hidden person's pushes dropped, and account deletion taking the
   subscriptions with it. Starts a local mongod in a temp folder on a free port and stops it after; skipped when
   the binary isn't there (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). No
   network: the web push sender is a stub (useSender), every other fetch is blocked. Fictional people, example.com. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const BIN = process.env.TTFC_TEST_MONGOD || path.join(os.homedir(), ".cache/mongodb-binaries/mongod-arm64-darwin-8.2.6");
const HAVE = fs.existsSync(BIN);
const skip = HAVE ? false : `no local mongod at ${BIN}`;

process.env.JWT_SECRET ||= "local-test-only";
process.env.RESEND_API_KEY ||= "re_dummy";
delete process.env.STRIPE_SECRET_KEY;
delete process.env.FCM_SERVICE_ACCOUNT;
delete process.env.APNS_KEY;
delete process.env.DEEPCLEER_ACCESS_KEY;
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.includes(".sanity.io/")) return new Response(JSON.stringify({ result: [] }), { status: 200, headers: { "content-type": "application/json" } });
  throw new Error(`blocked in the test: ${url}`);
};

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await pause(50);
  }
}
const portOpen = (port) => new Promise((ok) => { const c = net.connect(port, "127.0.0.1", () => { c.end(); ok(true); }); c.on("error", () => ok(false)); });

let mongod = null;
let dbDir = "";
let server = null;
let base = "";
let jwt;
let mongoose;
let forgetHidden;
let W;      // services/webPush.js
let P;      // services/push.js
const M = {};
const U = {};
/** What the stub "sent": { endpoint, payload (parsed), options }. */
const sent = [];
/** endpoint → HTTP status the stub push service answers (default 201). */
const answers = new Map();

/** A browser-like subscription: a real P-256 public key and a 16-byte auth secret. */
function browserSub(name) {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint: `https://push.example.com/send/${name}-${crypto.randomBytes(6).toString("hex")}`,
    keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") },
  };
}

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-webpush-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await pause(250);
  await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_webpush_test`);
  ({ default: jwt } = await import("jsonwebtoken"));
  ({ forgetHidden } = await import("../services/appHide.js"));
  W = await import("../services/webPush.js");
  P = await import("../services/push.js");
  W.useSender(async (subscription, payload, options) => {
    sent.push({ endpoint: subscription.endpoint, keys: subscription.keys, payload: JSON.parse(payload), options });
    const status = answers.get(subscription.endpoint) ?? 201;
    if (status >= 300) throw Object.assign(new Error("Received unexpected response code"), { statusCode: status });
    return { statusCode: status };
  });
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.WebPushKey = await imp("../models/WebPushKey.js");
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/social", await imp("../routes/social.js"));
  app.use("/api/app", await imp("../routes/appApi.js"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const onApp = { appOnboarded: true, lastActiveAt: new Date("2026-10-20T12:00:00Z") };
  const t = (id) => [{ ticketId: id, type: "connect", purchaseDate: new Date("2026-10-01") }];
  const mk = (key, doc) => M.User.create(doc).then((u) => { U[key] = u; });
  await Promise.all([
    mk("ann", { name: "Ann Writer", email: "ann.writer@example.com", tickets: t("con600000001"), ...onApp }),
    mk("ben", { name: "Ben Browser", email: "ben.browser@example.com", tickets: t("con600000002"), ...onApp }),
    mk("cal", { name: "Cal Phone", email: "cal.phone@example.com", tickets: t("con600000003"), ...onApp }),
    mk("bob", { name: "Bob Banned", email: "bob.banned@example.com", tickets: t("con600000004"), ...onApp }),
    mk("hal", { name: "Hal Hidden", email: "hal.hidden@example.com", tickets: t("con600000005"), ...onApp }),
    mk("del", { name: "Del Leaving", email: "del.leaving@example.com", tickets: t("con600000006"), ...onApp }),
  ]);
});

after(async () => {
  W?.useSender(null);
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const tokenFor = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function call(method, url, { as, body, raw = false } = {}) {
  const headers = { "content-type": "application/json" };
  if (as) headers.authorization = `Bearer ${tokenFor(as)}`;
  const r = await realFetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (raw) return { status: r.status, text, headers: r.headers };
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
const subsOf = async (u) => (await M.User.findById(u._id).select("+webPushSubs").lean()).webPushSubs || [];
const subscribe = (as, sub) => ok(call("POST", "/api/app/webpush", { as, body: { subscription: sub } }));
const sentTo = (endpoint) => sent.filter((s) => s.endpoint === endpoint);

/* ---------- keys ---------- */

test("VAPID keys: made once even when several servers start together, kept, reused; the private key never leaves", { skip }, async () => {
  assert.equal(await M.WebPushKey.countDocuments(), 0);
  // Three "servers" at once, each with nothing cached.
  const pairs = await Promise.all([W.bootstrapVapidKeys(), W.bootstrapVapidKeys(), W.bootstrapVapidKeys()]);
  assert.equal(new Set(pairs.map((p) => p.publicKey)).size, 1);
  assert.equal(new Set(pairs.map((p) => p.privateKey)).size, 1);
  assert.ok(W.validKeyPair(pairs[0].publicKey, pairs[0].privateKey));
  assert.equal(await M.WebPushKey.countDocuments(), 1);
  // A restart (or another server) reads the same pair back.
  W.forgetKeys();
  const again = await Promise.all([W.vapidKeys(), W.vapidKeys()]);
  assert.deepEqual(again[0], pairs[0]);
  assert.deepEqual(again[1], pairs[0]);
  // The row hides the private key unless asked for.
  const row = await M.WebPushKey.findById("vapid").lean();
  assert.equal(row.publicKey, pairs[0].publicKey);
  assert.equal("privateKey" in row, false);
  // GET /api/app/webpush-key: no sign-in, only the public key.
  const r = await call("GET", "/api/app/webpush-key", { raw: true });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.text), { publicKey: pairs[0].publicKey });
  assert.ok(!r.text.includes(pairs[0].privateKey));
});

test("env VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY win when both are set and valid; otherwise the stored pair", { skip }, async () => {
  const stored = await W.vapidKeys();
  const { default: webpush } = await import("web-push");
  const envPair = webpush.generateVAPIDKeys();
  try {
    process.env.VAPID_PUBLIC_KEY = envPair.publicKey;
    process.env.VAPID_PRIVATE_KEY = envPair.privateKey;
    assert.equal((await W.vapidKeys()).publicKey, envPair.publicKey);
    assert.equal((await ok(call("GET", "/api/app/webpush-key"))).publicKey, envPair.publicKey);
    process.env.VAPID_PRIVATE_KEY = "not-a-key";
    const errors = [];
    const realError = console.error;
    console.error = (...a) => errors.push(a.join(" "));
    try { assert.equal((await W.vapidKeys()).publicKey, stored.publicKey); } finally { console.error = realError; }
    assert.ok(errors.some((e) => /VAPID/.test(e)));
    assert.ok(!errors.some((e) => e.includes(envPair.privateKey) || e.includes(stored.privateKey)), "no key in the log");
    delete process.env.VAPID_PRIVATE_KEY;
    assert.equal((await W.vapidKeys()).publicKey, stored.publicKey);
  } finally {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
  }
  assert.equal(await M.WebPushKey.countDocuments(), 1);
});

/* ---------- subscriptions ---------- */

test("subscribe: signed in, an https endpoint with real keys; refreshed in place, newest last, at most five", { skip }, async () => {
  const { ben } = U;
  const s1 = browserSub("ben1");
  assert.equal((await call("POST", "/api/app/webpush", { body: { subscription: s1 } })).status, 401);
  for (const bad of [undefined, {}, { ...s1, endpoint: "http://push.example.com/x" }, { endpoint: s1.endpoint, keys: { p256dh: "abc", auth: "def" } }]) {
    assert.equal((await call("POST", "/api/app/webpush", { as: ben, body: { subscription: bad } })).status, 400);
  }
  assert.deepEqual(await subscribe(ben, s1), { ok: true, pushing: true });
  let subs = await subsOf(ben);
  assert.equal(subs.length, 1);
  assert.deepEqual([subs[0].endpoint, subs[0].p256dh, subs[0].auth], [s1.endpoint, s1.keys.p256dh, s1.keys.auth]);
  assert.ok(subs[0].updatedAt instanceof Date);
  assert.equal(typeof subs[0].ua, "string");
  // The same browser again: still one.
  await subscribe(ben, s1);
  assert.equal((await subsOf(ben)).length, 1);
  // Six more browsers: the five newest are kept, newest last.
  const more = Array.from({ length: 6 }, (_, i) => browserSub(`ben-more${i}`));
  for (const s of more) await subscribe(ben, s);
  subs = await subsOf(ben);
  assert.deepEqual(subs.map((s) => s.endpoint), more.slice(1).map((s) => s.endpoint));
  // Never in an answer about the account.
  assert.equal("webPushSubs" in (await M.User.findById(ben._id).lean()), false);
});

test("one owner per endpoint: a browser that signs in to another account moves to it", { skip }, async () => {
  const { ann, cal } = U;
  const shared = browserSub("shared");
  await subscribe(ann, shared);
  assert.ok((await subsOf(ann)).some((s) => s.endpoint === shared.endpoint));
  await subscribe(cal, shared);
  assert.ok(!(await subsOf(ann)).some((s) => s.endpoint === shared.endpoint));
  assert.ok((await subsOf(cal)).some((s) => s.endpoint === shared.endpoint));
  assert.equal(await M.User.countDocuments({ "webPushSubs.endpoint": shared.endpoint }), 1);
});

test("unsubscribe: only your own browser; an endpoint is required", { skip }, async () => {
  const { ann, cal } = U;
  const calSub = (await subsOf(cal))[0];
  assert.equal((await call("DELETE", "/api/app/webpush", { as: cal, body: {} })).status, 400);
  assert.equal((await call("DELETE", "/api/app/webpush", { body: { endpoint: calSub.endpoint } })).status, 401);
  // Ann can't take Cal's browser off.
  assert.deepEqual(await ok(call("DELETE", "/api/app/webpush", { as: ann, body: { endpoint: calSub.endpoint } })), { ok: true });
  assert.equal((await subsOf(cal)).length, 1);
  assert.deepEqual(await ok(call("DELETE", "/api/app/webpush", { as: cal, body: { endpoint: calSub.endpoint } })), { ok: true });
  assert.equal((await subsOf(cal)).length, 0);
});

/* ---------- sending ---------- */

test("a chat message pushes to every browser of the recipient: title, body, thread, kind, id, url, from; 12 h, high", { skip }, async () => {
  const { ann, ben } = U;
  sent.length = 0;
  const keys = await W.vapidKeys();
  const m = await ok(call("POST", `/api/social/messages/${idOf(ben)}`, { as: ann, body: { body: "Meet at the Coffee bar?" } }), 201);
  const benSubs = await subsOf(ben);
  assert.equal(benSubs.length, 5);
  await waitFor(() => benSubs.every((s) => sentTo(s.endpoint).length === 1));
  for (const s of benSubs) {
    const [one] = sentTo(s.endpoint);
    assert.ok(one, s.endpoint);
    assert.deepEqual(one.keys, { p256dh: s.p256dh, auth: s.auth });
    assert.deepEqual(one.payload, {
      title: "Ann Writer", body: "Meet at the Coffee bar?", link: "ttfc://tab/network", thread: `dm.${idOf(ann)}`, kind: "dm",
      id: m.id, url: `/app/chat/${idOf(ann)}`, tag: `dm.${idOf(ann)}`, from: idOf(ann),
    });
    assert.equal(one.options.TTL, 43200);
    assert.equal(one.options.urgency, "high");
    assert.deepEqual(one.options.vapidDetails, { subject: "mailto:enquire@thetechfestival.com", publicKey: keys.publicKey, privateKey: keys.privateKey });
  }
  // Nobody else got it (Ann's own browsers aren't pushed for her own message).
  assert.equal(sent.length, benSubs.length);
});

test("gone browsers (404 / 410) are removed; other failures keep the subscription", { skip }, async () => {
  const { ben } = U;
  const subs = await subsOf(ben);
  answers.set(subs[0].endpoint, 410);
  answers.set(subs[1].endpoint, 404);
  answers.set(subs[2].endpoint, 500);
  answers.set(subs[3].endpoint, 429);
  sent.length = 0;
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    await W.pushToUsers([ben._id], { title: "TTFC", body: "Doors open at 8", kind: "personal", id: "n1" });
  } finally {
    console.error = realError;
  }
  assert.equal(sent.length, 5);
  const left = (await subsOf(ben)).map((s) => s.endpoint);
  assert.deepEqual(left, [subs[2].endpoint, subs[3].endpoint, subs[4].endpoint]);
  // Failures are logged by host only, never the whole endpoint.
  assert.ok(errors.some((e) => /WEB PUSH send failed: 500 push\.example\.com/.test(e)));
  assert.ok(!errors.some((e) => subs.some((s) => e.includes(s.endpoint))));
  answers.clear();
  // Personal notifications are normal urgency and open the notifications page.
  assert.equal(sent[0].options.urgency, "normal");
  assert.equal(sent[0].payload.url, "/app/notifications");
});

test("a person hidden from the app pushes nobody (chat route and services/push.js); banned people get nothing", { skip }, async () => {
  const { hal, ben, bob, ann } = U;
  await M.User.updateOne({ _id: hal._id }, { $set: { appHidden: { at: new Date(), byName: "Staff" } } }, { timestamps: false });
  forgetHidden();
  sent.length = 0;
  await ok(call("POST", `/api/social/messages/${idOf(ben)}`, { as: hal, body: { body: "Hello?" } }), 201);
  P.pushToUsers([ben._id], { title: "Hal Hidden", body: "x", link: "ttfc://tab/network", thread: `dm.${idOf(hal)}`, kind: "dm", id: "z" }, { from: hal._id });
  await pause(500);
  assert.equal(sent.length, 0);
  // A banned person's browser never gets anything.
  const bobSub = browserSub("bob");
  await subscribe(bob, bobSub);
  await M.User.updateOne({ _id: bob._id }, { $set: { banned: true } });
  await W.pushToUsers([bob._id], { title: "x", body: "y", kind: "dm", thread: `dm.${idOf(ann)}` });
  assert.equal(sentTo(bobSub.endpoint).length, 0);
});

test("announcements reach every browser with web push on (not banned people), once each", { skip }, async () => {
  const { ann } = U;
  const annSub = browserSub("ann-own");
  await subscribe(ann, annSub);
  sent.length = 0;
  P.pushToEveryone({ title: "TTFC update", body: "Keynote in 10 minutes", link: "ttfc://tab/feed", kind: "announcement", id: "p1" });
  const expected = (await M.User.find({ "webPushSubs.endpoint": { $exists: true }, banned: { $ne: true } }).select("+webPushSubs").lean())
    .flatMap((u) => u.webPushSubs.map((s) => s.endpoint));
  assert.ok(expected.includes(annSub.endpoint));
  await waitFor(() => sent.length >= expected.length);
  await pause(200);
  assert.deepEqual(sent.map((s) => s.endpoint).sort(), [...expected].sort());
  assert.equal(sent[0].payload.url, "/app/");
  assert.equal(sent[0].options.urgency, "normal");
  assert.ok(!sent.some((s) => s.endpoint.includes("/bob-")));
});

test("deleting the account takes its browsers with it", { skip }, async () => {
  const { del } = U;
  const s = browserSub("del");
  await subscribe(del, s);
  assert.equal(await M.User.countDocuments({ "webPushSubs.endpoint": s.endpoint }), 1);
  assert.deepEqual(await ok(call("DELETE", "/api/app/account", { as: del })), { deleted: true });
  assert.equal(await M.User.countDocuments({ "webPushSubs.endpoint": s.endpoint }), 0);
  sent.length = 0;
  await W.pushToUsers([del._id], { title: "x", body: "y" });
  assert.equal(sent.length, 0);
});
