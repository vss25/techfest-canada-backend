import test from "node:test";
import assert from "node:assert/strict";
import { sign, signUpload, cleanMedia, deliveryMedia, MAX_VIDEO_SECONDS } from "../services/cloudinary.js";
import { postDTO } from "../services/socialHelpers.js";

const env = { CLOUDINARY_CLOUD_NAME: "demo", CLOUDINARY_API_KEY: "123", CLOUDINARY_API_SECRET: "abcd" };

test("signature matches Cloudinary's documented example", () => {
  const params = { eager: "w_400,h_300,c_pad|w_260,h_200,c_crop", public_id: "sample_image", timestamp: 1315060510 };
  assert.equal(sign(params, "abcd"), "bfd09f95f331f558cbd1320e67aa8d488770583e");
});

test("video uploads carry the 30 s trim inside the signature; off without keys", () => {
  const v = signUpload({ type: "video", userId: "u1", now: 1_700_000_000_000, env });
  assert.equal(v.resourceType, "video");
  assert.equal(v.params.transformation, `du_${MAX_VIDEO_SECONDS}`);
  assert.equal(v.params.folder, "ttfc/posts/u1");
  const { signature, ...rest } = v.params;
  assert.equal(signature, sign(rest, "abcd"));
  assert.equal(signUpload({ type: "image", userId: "u1", env }).params.transformation, undefined);
  assert.equal(signUpload({ type: "video", userId: "u1", env: {} }), null);
});

test("cleanMedia keeps only our uploads, ≤30 s videos, max six", () => {
  const ok = { type: "image", url: "https://res.cloudinary.com/demo/image/upload/v1/ttfc/posts/u1/a.jpg", width: 1080, height: 1350 };
  const vid = { type: "video", url: "https://res.cloudinary.com/demo/video/upload/v1/ttfc/posts/u1/b.mov", duration: 12.4 };
  const long = { ...vid, duration: 45 };
  const foreign = { type: "image", url: "https://evil.example/ttfc/posts/x.jpg" };
  const wrongKind = { type: "video", url: ok.url };
  assert.deepEqual(cleanMedia([ok, vid, long, foreign, wrongKind], "demo").map((m) => m.type), ["image", "video"]);
  assert.equal(cleanMedia(Array(9).fill(ok), "demo").length, 6);
  assert.deepEqual(cleanMedia([ok], ""), []);
});

test("delivery URLs: sized images, mp4 + poster for video", () => {
  const v = deliveryMedia({ type: "video", url: "https://res.cloudinary.com/demo/video/upload/v1/ttfc/posts/u1/b.mov", duration: 12 });
  assert.match(v.url, /\/upload\/du_30,q_auto,vc_auto,w_720,c_limit\/v1\/.*\.mp4$/);
  assert.match(v.posterUrl, /\/upload\/so_0,q_auto,w_720,c_limit\/.*\.jpg$/);
  const i = deliveryMedia({ type: "image", url: "https://res.cloudinary.com/demo/image/upload/v1/ttfc/posts/u1/a.jpg" });
  assert.match(i.url, /\/upload\/f_auto,q_auto,w_1080,c_limit\//);
});

test("postDTO lists media; a legacy inline photo becomes one image", () => {
  const legacy = postDTO({ _id: "p1", authorId: "u", authorName: "A", body: "", imageData: "data:image/jpeg;base64,AA==" }, "u");
  assert.equal(legacy.media.length, 1);
  assert.equal(legacy.media[0].url, "/api/files/post/p1");
  const none = postDTO({ _id: "p2", authorId: "u", authorName: "A", body: "hi" }, "u");
  assert.deepEqual(none.media, []);
});
