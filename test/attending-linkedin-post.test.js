import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanPostText, isAttendingState, isPostState, newLinkedinPostState, newLinkedinState, pngFromDataUrl, postReturnUrl,
} from "../services/attendingCampaign.js";
import { TTFC_PAGE, apiVersions, littleText, postImageToLinkedin, withPageMention } from "../services/linkedinPost.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 7)]);

test("littleText escapes reserved characters and keeps hashtags", () => {
  assert.equal(
    littleText("Hi (all) @you *bold* a_b C# x\\y\n#TTFC2026 #TheTechFestivalCanada"),
    "Hi \\(all\\) \\@you \\*bold\\* a\\_b C\\# x\\\\y\n{hashtag|\\#|TTFC2026} {hashtag|\\#|TheTechFestivalCanada}",
  );
  assert.equal(littleText("Learn more: https://www.thetechfestival.com"), "Learn more: https://www.thetechfestival.com");
});

const TAG = "@[The Tech Festival Canada](urn:li:organization:105812464)";

test("withPageMention tags The Tech Festival Canada's page once", () => {
  assert.equal(TTFC_PAGE.urn, "urn:li:organization:105812464");
  const text = littleText("I'm attending The Tech Festival Canada 2026! See you at The Tech Festival Canada.\n#TheTechFestivalCanada");
  assert.equal(withPageMention(text), `I'm attending ${TAG} 2026! See you at The Tech Festival Canada.\n{hashtag|\\#|TheTechFestivalCanada}`);
  // Someone typed the @ themselves, or changed the case: still one clean tag.
  assert.equal(withPageMention(littleText("Off to @The Tech Festival Canada")), `Off to ${TAG}`);
  assert.equal(withPageMention(littleText("off to the tech festival canada")), `off to ${TAG}`);
  // Not named in the text: the tag goes on its own line at the end.
  assert.equal(withPageMention(littleText("See you in Toronto #TTFC2026")), `See you in Toronto {hashtag|\\#|TTFC2026}\n\n${TAG}`);
  assert.equal(withPageMention(""), TAG);
  assert.equal(withPageMention("x", null), "x");
});

test("post states are attending states, photo states are not post states", () => {
  const p = newLinkedinPostState();
  assert.ok(isAttendingState(p) && isPostState(p));
  assert.ok(!isPostState(newLinkedinState()));
  assert.ok(!isPostState("ttfc-att.pnothex"));
});

test("pngFromDataUrl accepts only real PNGs", () => {
  assert.deepEqual(pngFromDataUrl(`data:image/png;base64,${PNG.toString("base64")}`), PNG);
  assert.equal(pngFromDataUrl(`data:image/png;base64,${Buffer.alloc(100).toString("base64")}`), null);
  assert.equal(pngFromDataUrl(`data:image/jpeg;base64,${PNG.toString("base64")}`), null);
  assert.equal(pngFromDataUrl(42), null);
});

test("cleanPostText keeps new lines, drops control characters, caps length", () => {
  assert.equal(cleanPostText(" a\r\nb\u0007c "), "a\nbc");
  assert.equal(cleanPostText("x".repeat(4000)).length, 3000);
  assert.equal(cleanPostText({}), "");
});

test("postReturnUrl: success carries only a real post URL; errors carry a code", () => {
  const url = "https://www.linkedin.com/feed/update/urn:li:share:7123/";
  assert.equal(postReturnUrl("https://x.com/", { post: url }), `https://x.com/attending#posted=1&post=${encodeURIComponent(url)}`);
  assert.equal(postReturnUrl("https://x.com", { post: "https://evil.com/" }), "https://x.com/attending#posted=1");
  assert.equal(postReturnUrl("https://x.com", { error: "cancelled" }), "https://x.com/attending#post_error=cancelled");
});

test("apiVersions puts LINKEDIN_API_VERSION first", () => {
  assert.equal(apiVersions({ LINKEDIN_API_VERSION: "202701" })[0], "202701");
  assert.equal(apiVersions({ LINKEDIN_API_VERSION: "nope" })[0], "202609");
});

function fakeHttp({ retireFirst = false, processingOnce = false, refuseTag = false } = {}) {
  const calls = [];
  let processing = processingOnce;
  const fail = (status, data = {}) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });
  return {
    calls,
    async post(url, body, opts) {
      calls.push({ method: "POST", url, body, version: opts.headers["LinkedIn-Version"] });
      if (retireFirst && opts.headers["LinkedIn-Version"] === "202609") throw fail(426, { code: "NONEXISTENT_VERSION" });
      if (url.includes("initializeUpload")) return { data: { value: { uploadUrl: "https://upload.example/u", image: "urn:li:image:abc" } } };
      if (processing) { processing = false; throw fail(422); }
      if (refuseTag && String(body.commentary).includes("urn:li:organization")) throw fail(422);
      return { status: 201, headers: { "x-restli-id": "urn:li:share:7123" }, data: {} };
    },
    async put(url, body) { calls.push({ method: "PUT", url, size: body.length }); return { status: 201 }; },
  };
}

test("postImageToLinkedin uploads, then posts the image with escaped text", async () => {
  const http = fakeHttp();
  const r = await postImageToLinkedin({ accessToken: "t", personId: "abc123", png: PNG, text: "Hi (all) #TTFC2026", http, versions: ["202609"] });
  assert.deepEqual(r, { urn: "urn:li:share:7123", url: "https://www.linkedin.com/feed/update/urn:li:share:7123/" });
  assert.deepEqual(http.calls.map((c) => c.method), ["POST", "PUT", "POST"]);
  assert.equal(http.calls[0].body.initializeUploadRequest.owner, "urn:li:person:abc123");
  const post = http.calls[2].body;
  assert.equal(post.author, "urn:li:person:abc123");
  assert.equal(post.content.media.id, "urn:li:image:abc");
  assert.equal(post.commentary, `Hi \\(all\\) {hashtag|\\#|TTFC2026}\n\n${TAG}`);
  assert.equal(post.visibility, "PUBLIC");
});

test("postImageToLinkedin moves to an older API version on 426, and retries a still-processing image once", async () => {
  const http = fakeHttp({ retireFirst: true, processingOnce: true });
  const r = await postImageToLinkedin({ accessToken: "t", personId: "p", png: PNG, text: "x", http, versions: ["202609", "202606"], wait: async () => {} });
  assert.equal(r.urn, "urn:li:share:7123");
  assert.ok(http.calls.some((c) => c.version === "202606"));
});

test("postImageToLinkedin still posts, untagged, when LinkedIn refuses the tag", async () => {
  const http = fakeHttp({ refuseTag: true });
  const r = await postImageToLinkedin({ accessToken: "t", personId: "p", png: PNG, text: "I'm attending The Tech Festival Canada", http, versions: ["202609"], wait: async () => {} });
  assert.equal(r.urn, "urn:li:share:7123");
  const posts = http.calls.filter((c) => c.url.endsWith("/posts"));
  assert.equal(posts.length, 3);
  assert.equal(posts[0].body.commentary, `I'm attending ${TAG}`);
  assert.equal(posts[2].body.commentary, "I'm attending The Tech Festival Canada");
});
