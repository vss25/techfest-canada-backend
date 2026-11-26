// Home page › last year's highlights: the pictures and how many show. Run: node --test test/home-highlights.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { toSanityPatch } from "../services/cmsSchema.js";

const IMG = "image-abcdef0123456789abcdef0123456789abcdef01-1600x900-jpg";

test("the home page takes a list of highlight pictures and how many to show", () => {
  const { set, error } = toSanityPatch("homePage", { highlightPhotos: [IMG, { asset: IMG, alt: "The main stage" }], highlightCount: 3 }, { creating: false, draft: true });
  assert.ok(!error, String(error));
  assert.equal(set.highlightPhotos.length, 2);
  assert.equal(set.highlightPhotos[1].alt, "The main stage");
  assert.equal(set.highlightCount, 3);
  assert.equal(toSanityPatch("homePage", { highlightCount: 0 }, { creating: false, draft: true }).set.highlightCount, 0);
  assert.match(toSanityPatch("homePage", { highlightCount: 25 }, { creating: false, draft: true }).error, /between 0 and 24/);
  assert.match(toSanityPatch("homePage", { highlightPhotos: ["nope"] }, { creating: false, draft: true }).error, /upload each photo first/);
});
