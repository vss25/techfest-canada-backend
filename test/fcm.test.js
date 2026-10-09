import test from "node:test";
import assert from "node:assert/strict";
import { buildFcmMessage, cleanFcmToken, upsertFcmToken, isDeadToken, parseServiceAccount, isConfigured } from "../services/fcm.js";

const TOKEN = "dGVzdC10b2tlbg:APA91b" + "x".repeat(140);

test("message: notification, Android channel/priority/tag and string data; long text is capped", () => {
  const { message } = buildFcmMessage(TOKEN, { title: "Riley Chen", body: "x".repeat(900), thread: "dm.1", link: "ttfc://tab/network", kind: "dm", id: "m1" });
  assert.equal(message.token, TOKEN);
  assert.equal(message.notification.title, "Riley Chen");
  assert.equal(message.notification.body.length, 400);
  assert.equal(message.android.priority, "HIGH");
  assert.deepEqual(message.android.notification, { channel_id: "ttfc_updates", tag: "dm.1" });
  assert.deepEqual(message.data, { link: "ttfc://tab/network", kind: "dm", id: "m1" });
  const bare = buildFcmMessage(TOKEN, { body: "hi", id: 42 }).message;
  assert.equal(bare.notification.title, undefined);
  assert.equal(bare.android.notification.tag, undefined);
  assert.deepEqual(bare.data, { link: "", kind: "", id: "42" });
  for (const v of Object.values(bare.data)) assert.equal(typeof v, "string");
});

test("tokens: FCM charset and length only, refreshed token moves last, at most five", () => {
  assert.equal(cleanFcmToken(`  ${TOKEN} `), TOKEN);
  assert.equal(cleanFcmToken("short"), "");
  assert.equal(cleanFcmToken("a".repeat(4097)), "");
  assert.equal(cleanFcmToken("bad token with spaces and more chars"), "");
  assert.equal(cleanFcmToken({ $ne: "" }), "");
  let list = [];
  for (let i = 0; i < 7; i++) list = upsertFcmToken(list, String(i).repeat(30));
  assert.equal(list.length, 5);
  list = upsertFcmToken(list, "3".repeat(30));
  assert.equal(list.at(-1).token, "3".repeat(30));
  assert.equal(list.length, 5);
});

test("dead tokens: 404/UNREGISTERED and invalid-token 400 only", () => {
  assert.equal(isDeadToken(404, {}), true);
  assert.equal(isDeadToken(400, { status: "INVALID_ARGUMENT", details: [{ errorCode: "UNREGISTERED" }] }), true);
  assert.equal(isDeadToken(400, { status: "INVALID_ARGUMENT", message: "The registration token is not a valid FCM registration token" }), true);
  assert.equal(isDeadToken(400, { status: "INVALID_ARGUMENT", details: [{ fieldViolations: [{ field: "message.token" }] }] }), true);
  assert.equal(isDeadToken(400, { status: "INVALID_ARGUMENT", message: "Invalid value at 'message.data'" }), false);
  assert.equal(isDeadToken(500, {}), false);
  assert.equal(isDeadToken(0, { message: "network" }), false);
});

test("service account: raw JSON or base64; needs project_id, client_email, private_key", () => {
  const sa = { project_id: "ttfc-test", client_email: "push@ttfc-test.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n" };
  const raw = parseServiceAccount(JSON.stringify(sa));
  assert.equal(raw.projectId, "ttfc-test");
  assert.ok(raw.privateKey.includes("\nabc\n"));
  assert.deepEqual(parseServiceAccount(Buffer.from(JSON.stringify(sa)).toString("base64")), raw);
  assert.equal(parseServiceAccount(JSON.stringify({ ...sa, private_key: "" })), null);
  assert.equal(parseServiceAccount("not json"), null);
  assert.equal(parseServiceAccount(""), null);
});

test("not configured without the service account", () => {
  delete process.env.FCM_SERVICE_ACCOUNT;
  assert.equal(isConfigured(), false);
});
