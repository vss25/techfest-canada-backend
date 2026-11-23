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

/* ---------- post templates and designed images per channel (Nov 23 2026) ---------- */
import { POST_TEMPLATES, TEMPLATE_KEYS, cleanWritten, imageFor } from "../services/socialPosts.js";

test("templates: each one says what it's built from and what the post must carry", () => {
  assert.deepEqual(TEMPLATE_KEYS, ["speaker", "panel", "partner", "callSpeakers", "callSponsors", "tickets"]);
  for (const t of POST_TEMPLATES) {
    assert.ok(["speaker", "session", "partner", "event"].includes(t.source), t.key);
    assert.ok(t.brief.length > 60, t.key);
    assert.doesNotMatch(t.brief, /[—–]/, t.key);
  }
  const p = writerPrompt({ source: "Speaker: Ada Lovelace", channels: ["linkedin", "x"], template: "speaker", link: "https://www.thetechfestival.com/tickets" });
  assert.match(p, /^Template: Speaker announcement\. Announce one confirmed speaker/);
  assert.match(p, /nobody will edit it/);
  assert.match(p, /Link to use: https:\/\/www\.thetechfestival\.com\/tickets/);
  assert.doesNotMatch(writerPrompt({ source: "x", channels: ["x"], template: "nope" }), /Template:/);
  assert.match(writerSystem(), /Never use em-dashes or en-dashes/);
});

test("generated copy never keeps an em-dash", () => {
  assert.equal(cleanWritten("  Big news — Ada joins us – in Vancouver.  "), "Big news, Ada joins us, in Vancouver.");
});

test("a templated post keeps its own designed image per channel; others use the photo cropped", () => {
  const img = (n) => `https://cdn.sanity.io/images/abc/production/${n}-1200x627.png`;
  const { value } = cleanPost({ text: "Hi", template: "speaker", image: { url: img("photo") },
    images: { linkedin: { url: img("li"), alt: "Ada" }, x: { url: img("x") }, instagram: { url: "" } } });
  assert.equal(value.template, "speaker");
  assert.deepEqual(Object.keys(value.images), ["linkedin", "x"]);
  assert.equal(imageFor(value, "linkedin"), img("li"));
  assert.match(imageFor(value, "instagram"), /photo-1200x627\.png\?w=1080&h=1350&fit=crop/);
  assert.equal(imageFor({}, "x"), "");
  assert.match(cleanPost({ text: "Hi", images: { x: { url: "https://evil.example.com/a.png" } } }).error, /image library/);
  assert.equal(cleanPost({ text: "Hi", template: "made-up" }).value.template, "");
});
