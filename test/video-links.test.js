import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVideoUrl, videoInfo } from "../services/videoLinks.js";
import { toSanityPatch } from "../services/cmsSchema.js";

test("YouTube links in every common shape", () => {
  for (const u of ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s", "youtu.be/dQw4w9WgXcQ", "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ", "https://www.youtube.com/embed/dQw4w9WgXcQ", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "https://www.youtube.com/live/dQw4w9WgXcQ"]) {
    assert.deepEqual(parseVideoUrl(u), { provider: "youtube", videoId: "dQw4w9WgXcQ", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }, u);
  }
});

test("Vimeo links, unlisted ones keep their hash", () => {
  assert.deepEqual(parseVideoUrl("https://vimeo.com/123456789"), { provider: "vimeo", videoId: "123456789", url: "https://vimeo.com/123456789" });
  assert.deepEqual(parseVideoUrl("https://player.vimeo.com/video/123456789?h=abc123def"), { provider: "vimeo", videoId: "123456789:abc123def", url: "https://vimeo.com/123456789/abc123def" });
  assert.equal(parseVideoUrl("https://vimeo.com/123456789/abc123def").videoId, "123456789:abc123def");
});

test("anything else is refused", () => {
  for (const u of ["", "https://example.com/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/watch?v=short", "javascript:alert(1)", "https://vimeo.com/about"]) assert.equal(parseVideoUrl(u), null, u);
});

test("the CMS stores the canonical link with provider and id from it", () => {
  const { set, error } = toSanityPatch("video", { title: "Recap", url: "youtu.be/dQw4w9WgXcQ", provider: "vimeo", videoId: "x" }, { creating: true });
  assert.ok(!error);
  assert.equal(set.url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(set.provider, "youtube");
  assert.equal(set.videoId, "dQw4w9WgXcQ");
  assert.equal(set.active, true);
  assert.equal(set.showOnMedia, true);
  assert.match(toSanityPatch("video", { title: "x", url: "https://example.com" }, { creating: true }).error, /YouTube or Vimeo/);
});

test("oEmbed fills title and a safe thumbnail; offline still answers", async () => {
  const ok = await videoInfo("https://vimeo.com/123456789", { fetchImpl: async () => ({ ok: true, json: async () => ({ title: "TTFC 2026 recap", thumbnail_url: "https://i.vimeocdn.com/video/1.jpg" }) }) });
  assert.equal(ok.title, "TTFC 2026 recap");
  assert.equal(ok.thumbnailUrl, "https://i.vimeocdn.com/video/1.jpg");
  const bad = await videoInfo("https://vimeo.com/123456789", { fetchImpl: async () => ({ ok: true, json: async () => ({ title: "x", thumbnail_url: "https://evil.example/x.jpg" }) }) });
  assert.equal(bad.thumbnailUrl, "");
  const off = await videoInfo("youtu.be/dQw4w9WgXcQ", { fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(off.thumbnailUrl, "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
  assert.equal(off.found, false);
});
