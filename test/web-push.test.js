/* Web Push (services/webPush.js), the pure parts: key pairs, subscriptions, the payload and the options.
   The real web-push library builds an encrypted request here (generateRequestDetails) but nothing is sent:
   no network, no database. */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import webpush from "web-push";
import {
  validKeyPair, cleanEndpoint, cleanSubscription, upsertSub, webUrlFor, buildWebPayload, sendOptions, isGone,
  SUBJECT, TTL_SECONDS,
} from "../services/webPush.js";

/** A browser-like subscription: a real P-256 public key and a 16-byte auth secret. */
function browserSub(endpoint = "https://fcm.googleapis.com/fcm/send/abc123") {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") } };
}

test("VAPID pairs: what generateVAPIDKeys makes is valid; anything else isn't", () => {
  const k = webpush.generateVAPIDKeys();
  assert.ok(validKeyPair(k.publicKey, k.privateKey));
  assert.ok(!validKeyPair(k.privateKey, k.publicKey));
  assert.ok(!validKeyPair("", ""));
  assert.ok(!validKeyPair(k.publicKey, "short"));
  assert.ok(!validKeyPair({ a: 1 }, k.privateKey));
});

test("endpoints: https URLs of at most 1000 characters only", () => {
  assert.equal(cleanEndpoint(" https://web.push.apple.com/QGx1 "), "https://web.push.apple.com/QGx1");
  for (const bad of ["http://push.example.com/x", "javascript:alert(1)", "https://", "not a url", "", null, 5, { $ne: "" },
    `https://push.example.com/${"x".repeat(1000)}`]) {
    assert.equal(cleanEndpoint(bad), "", String(bad));
  }
});

test("subscriptions: PushSubscription.toJSON() shape, real key lengths, base64 turned into base64url", () => {
  const s = browserSub();
  assert.deepEqual(cleanSubscription(s), { endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth });
  // Standard base64 with padding (some libraries send that) is accepted as the same keys.
  const std = { ...s, keys: { p256dh: Buffer.from(s.keys.p256dh, "base64url").toString("base64"), auth: Buffer.from(s.keys.auth, "base64url").toString("base64") } };
  assert.deepEqual(cleanSubscription(std), cleanSubscription(s));
  assert.equal(cleanSubscription({ ...s, endpoint: "http://insecure.example.com/x" }), null);
  assert.equal(cleanSubscription({ endpoint: s.endpoint }), null);
  assert.equal(cleanSubscription({ ...s, keys: { p256dh: s.keys.p256dh, auth: "abc" } }), null);
  assert.equal(cleanSubscription({ ...s, keys: { p256dh: crypto.randomBytes(65).toString("base64url").replace(/^./, "A"), auth: s.keys.auth } }), null);
  assert.equal(cleanSubscription({ ...s, keys: { p256dh: { $gt: "" }, auth: s.keys.auth } }), null);
  for (const bad of [null, "x", 5, []]) assert.equal(cleanSubscription(bad), null);
});

test("a person's subscriptions: refreshed one moves last, at most five, user agent capped", () => {
  let list = [];
  for (let i = 0; i < 7; i++) list = upsertSub(list, { endpoint: `https://p.example.com/${i}`, p256dh: "k", auth: "a" }, { ua: "Safari", now: new Date(i) });
  assert.equal(list.length, 5);
  assert.deepEqual(list.map((s) => s.endpoint.slice(-1)), ["2", "3", "4", "5", "6"]);
  list = upsertSub(list, { endpoint: "https://p.example.com/3", p256dh: "k2", auth: "a2" }, { ua: "x".repeat(500) });
  assert.equal(list.length, 5);
  assert.equal(list.at(-1).endpoint, "https://p.example.com/3");
  assert.equal(list.at(-1).p256dh, "k2");
  assert.equal(list.at(-1).ua.length, 200);
  assert.ok(list.at(-1).updatedAt instanceof Date);
});

test("the page a push opens in the web app (router under /app/)", () => {
  const id = "64b0000000000000000000aa";
  assert.equal(webUrlFor({ thread: `dm.${id}`, kind: "dm", link: "ttfc://tab/network" }), `/app/chat/${id}`);
  assert.equal(webUrlFor({ thread: `group.${id}`, kind: "gm", link: "ttfc://tab/network" }), `/app/group/${id}`);
  assert.equal(webUrlFor({ thread: `disc.${id}`, kind: "disc", link: "ttfc://tab/chats/discussions" }), `/app/discussion/${id}`);
  assert.equal(webUrlFor({ link: `ttfc://post/${id}`, kind: "report" }), `/app/post/${id}`);
  assert.equal(webUrlFor({ link: "ttfc://moderation", kind: "report" }), "/app/notifications");
  assert.equal(webUrlFor({ link: "ttfc://session/s12/live" }), "/app/session/s12/live");
  assert.equal(webUrlFor({ link: "ttfc://tab/feed", kind: "announcement" }), "/app/");
  assert.equal(webUrlFor({ link: "ttfc://tab/network", kind: "conn" }), "/app/network");
  assert.equal(webUrlFor({ link: "ttfc://tab/ticket" }), "/app/profile/pass");
  assert.equal(webUrlFor({ link: "ttfc://tab/chats/discussions" }), "/app/chats/discussions");
  assert.equal(webUrlFor({ link: "https://thetechfestival.com/agenda", kind: "personal" }), "https://thetechfestival.com/agenda");
  assert.equal(webUrlFor({ link: "", kind: "personal" }), "/app/notifications");
  assert.equal(webUrlFor({}), "/app/");
  // Odd ids never make a path.
  assert.equal(webUrlFor({ thread: "dm.../../admin", kind: "dm", link: "ttfc://tab/network" }), "/app/network");
});

test("payload: { title, body, link, thread, kind, id, url, from }, text capped", () => {
  const sender = "64b0000000000000000000bb";
  const p = buildWebPayload({ title: "Riley Chen", body: "x".repeat(900), link: "ttfc://tab/network", thread: `dm.${sender}`, kind: "dm", id: "m1" }, { from: sender });
  assert.deepEqual(Object.keys(p).sort(), ["body", "from", "id", "kind", "link", "thread", "title", "url"]);
  assert.equal(p.body.length, 400);
  assert.equal(p.url, `/app/chat/${sender}`);
  assert.equal(p.from, sender);
  // The sender comes from a chat thread when `from` isn't given; no sender → no `from`.
  assert.equal(buildWebPayload({ thread: `dm.${sender}`, kind: "dm" }).from, sender);
  assert.equal("from" in buildWebPayload({ title: "TTFC update", body: "Doors open", kind: "announcement" }), false);
});

test("options: 12 h to live, chats high urgency, the mailto subject; the real library accepts them (nothing sent)", () => {
  const keys = webpush.generateVAPIDKeys();
  const dm = sendOptions({ kind: "dm" }, keys);
  assert.equal(dm.TTL, TTL_SECONDS);
  assert.equal(TTL_SECONDS, 43200);
  assert.equal(dm.urgency, "high");
  assert.equal(sendOptions({ kind: "announcement" }, keys).urgency, "normal");
  assert.equal(dm.vapidDetails.subject, SUBJECT);
  assert.equal(SUBJECT, "mailto:enquire@thetechfestival.com");
  const sub = browserSub();
  const req = webpush.generateRequestDetails(sub, JSON.stringify(buildWebPayload({ title: "Riley", body: "Hi", kind: "dm" })), dm);
  assert.equal(req.method, "POST");
  assert.equal(req.endpoint, sub.endpoint);
  assert.equal(req.headers.TTL, 43200);
  assert.equal(req.headers.Urgency, "high");
  assert.match(req.headers.Authorization, /^vapid t=.+, k=/);
  assert.ok(Buffer.isBuffer(req.body) && req.body.length > 0);   // encrypted for that browser
});

test("gone subscriptions: 404 and 410 only", () => {
  assert.ok(isGone(404));
  assert.ok(isGone(410));
  for (const s of [0, 201, 400, 401, 403, 413, 429, 500, 503]) assert.ok(!isGone(s), String(s));
});
