import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanPost, cleanSettings, costUsd, cropUrl, lengthFor, overLimit, postProblems, statusOf, textFor, writerPrompt, writerSchema, writerSystem, SETTING_DEFAULTS } from "../services/socialPosts.js";

test("X counts a link as 23 characters", () => {
  assert.equal(lengthFor("x", "See thetechfestival.com/vancouver now"), 4 + 23 + 4);
  assert.equal(lengthFor("x", "https://example.com/a/very/long/path/that/goes/on"), 23);
  assert.equal(lengthFor("linkedin", "abc"), 3);
  assert.ok(overLimit("x", "a".repeat(281)));
});

test("each channel posts its own chosen version, else the main text", () => {
  const p = { text: "Main", versions: { x: { own: true, chosen: 1, list: [{ text: "X1" }, { text: "X2" }] }, instagram: { own: false, list: [{ text: "IG" }] } } };
  assert.equal(textFor(p, "linkedin"), "Main");
  assert.equal(textFor(p, "x"), "X2");
  assert.equal(textFor(p, "instagram"), "Main");
});

test("status: planned, review, scheduled, posted on time, late, missed", () => {
  const now = Date.parse("2026-11-20T15:00:00Z");
  const base = { channels: { linkedin: true, x: true, instagram: false } };
  assert.equal(statusOf(base, now), "draft");
  assert.equal(statusOf({ ...base, review: { state: "pending" } }, now), "review");
  assert.equal(statusOf({ ...base, review: { state: "approved" }, scheduledAt: "2026-11-21T15:00:00Z" }, now), "scheduled");
  assert.equal(statusOf({ ...base, review: { state: "approved" }, scheduledAt: "2026-11-20T10:00:00Z" }, now), "missed");
  const posted = { linkedin: { at: "2026-11-20T10:10:00Z" }, x: { at: "2026-11-20T10:20:00Z" } };
  assert.equal(statusOf({ ...base, review: { state: "approved" }, scheduledAt: "2026-11-20T10:00:00Z", posted }, now), "posted");
  assert.equal(statusOf({ ...base, review: { state: "approved" }, scheduledAt: "2026-11-20T08:00:00Z", posted }, now), "late");
});

test("posts need a channel, valid dates and website images; problems block approval", () => {
  assert.match(cleanPost({ channels: { linkedin: false, x: false, instagram: false } }).error, /channel/);
  assert.match(cleanPost({ scheduledAt: "nope" }).error, /date/);
  assert.match(cleanPost({ image: { url: "https://evil.example/a.jpg" } }).error, /image library/);
  const v = cleanPost({ text: "Hi", image: { url: "https://cdn.sanity.io/images/p/d/abc.jpg" } }).value;
  assert.equal(v.channels.x, true);
  assert.deepEqual(postProblems({ text: "", channels: { x: true } }), ["Write the post."]);
  assert.match(postProblems({ text: "a".repeat(300), channels: { x: true } })[0], /X is over 280/);
});

test("crops per channel come from the website's image service", () => {
  assert.equal(cropUrl("https://cdn.sanity.io/images/p/d/a.jpg?w=10", "instagram"), "https://cdn.sanity.io/images/p/d/a.jpg?w=1080&h=1350&fit=crop&crop=entropy&auto=format&q=85");
});

test("settings: hashtags tidied, limit range", () => {
  const v = cleanSettings({ brandTags: "TTFC2027, #Tech Festival", topicTags: ["#AI"], monthlyBudgetUsd: 10, handles: { x: "@ttfc" } }).value;
  assert.deepEqual(v.brandTags, ["#TTFC2027", "#Tech", "#Festival"]);
  assert.equal(v.handles.x, "ttfc");
  assert.match(cleanSettings({ monthlyBudgetUsd: -1 }).error, /limit/);
});

test("writer prompt: facts only, previous versions to avoid, schema per channel", () => {
  assert.match(writerSystem(SETTING_DEFAULTS), /Never invent/);
  assert.match(writerSystem(SETTING_DEFAULTS), /#TTFC2027/);
  const p = writerPrompt({ main: "Main post", channels: ["x"], previous: { x: ["Old X"] }, instruction: "shorter" });
  assert.match(p, /Old X/);
  assert.match(p, /shorter/);
  assert.deepEqual(writerSchema(["x", "instagram"]).required, ["x", "instagram"]);
});

test("cost at Opus 5.5 prices", () => {
  assert.equal(costUsd({ input_tokens: 1_000_000, output_tokens: 100_000 }), 4 + 2);
});
