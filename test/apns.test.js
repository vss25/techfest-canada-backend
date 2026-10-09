import test from "node:test";
import assert from "node:assert/strict";
import { buildPayload, upsertToken, cleanToken, cleanEnv, isConfigured } from "../services/apns.js";

test("payload: alert, sound, thread and app fields; long text is capped", () => {
  const p = buildPayload({ title: "Riley Chen", body: "x".repeat(900), thread: "dm.1", link: "ttfc://tab/network", kind: "dm", id: "m1" });
  assert.equal(p.aps.alert.title, "Riley Chen");
  assert.equal(p.aps.alert.body.length, 400);
  assert.equal(p.aps.sound, "default");
  assert.equal(p.aps["thread-id"], "dm.1");
  assert.deepEqual([p.link, p.kind, p.id], ["ttfc://tab/network", "dm", "m1"]);
  assert.equal(buildPayload({ body: "hi" }).aps.alert.title, undefined);
});

test("tokens: hex only, refreshed token moves last, at most five per person", () => {
  const hex = "a".repeat(64);
  assert.equal(cleanToken(hex.toUpperCase()), hex);
  assert.equal(cleanToken("not-a-token"), "");
  assert.equal(cleanToken({ $ne: "" }), "");
  let list = [];
  for (let i = 0; i < 7; i++) list = upsertToken(list, String(i).repeat(64), "production");
  assert.equal(list.length, 5);
  list = upsertToken(list, "3".repeat(64), "sandbox");
  assert.equal(list.at(-1).token, "3".repeat(64));
  assert.equal(list.at(-1).env, "sandbox");
  assert.equal(list.length, 5);
  assert.equal(cleanEnv("weird"), "production");
});

test("not configured without the APNs key", () => {
  delete process.env.APNS_KEY;
  assert.equal(isConfigured(), false);
});
