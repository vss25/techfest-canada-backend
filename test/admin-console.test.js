import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanEvent, cleanContent, summarize, CONTENT_KEYS } from "../services/adminHelpers.js";

test("cleanEvent keeps valid events and strips junk", () => {
  const now = Date.parse("2026-10-03T12:00:00Z");
  const e = cleanEvent({ name: "Tap", screen: "Home", target: "Connect", props: { topic: "AI", n: 3, bad: { x: 1 }, "bad key": "x" }, at: "2026-10-03T11:59:00Z" }, now);
  assert.equal(e.name, "tap");
  assert.deepEqual(e.props, { topic: "AI", n: 3 });
  assert.equal(cleanEvent({ name: "drop table" }, now), null);
  assert.equal(cleanEvent({ name: "tap", at: "2030-01-01" }, now), null);
  assert.equal(cleanEvent(null, now), null);
});

test("cleanContent only accepts known keys and coerces flags", () => {
  assert.deepEqual(cleanContent("flag.allow_posts", "false"), ["flag.allow_posts", false]);
  assert.deepEqual(cleanContent("home.announcement", "Doors at 8"), ["home.announcement", "Doors at 8"]);
  assert.equal(cleanContent("evil.key", "x"), null);
  assert.ok(Object.keys(CONTENT_KEYS).length >= 10);
});

test("summarize ranks screens, taps, interests and searches", () => {
  const ev = [
    { name: "screen_view", screen: "Home", at: new Date(1) },
    { name: "screen_view", screen: "Home", at: new Date(2) },
    { name: "tap", screen: "Home", target: "Connect", at: new Date(3) },
    { name: "interest", props: { company: "IBM" }, at: new Date(4) },
    { name: "search", props: { query: "quantum" }, at: new Date(5) },
  ];
  const s = summarize(ev);
  assert.equal(s.total, 5);
  assert.deepEqual(s.screens[0], { key: "Home", count: 2 });
  assert.equal(s.taps[0].key, "Home › Connect");
  assert.equal(s.interests[0].key, "IBM");
  assert.equal(s.searches[0].key, "quantum");
  assert.equal(s.lastSeen.getTime(), 5);
});
