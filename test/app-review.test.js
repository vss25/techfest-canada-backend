/* "Rate the app" (Oct 27 2026): the rating window's content keys (services/appReview.js), in the content registry
   (services/adminHelpers.js) and management only (services/staffPowers.js). Pure. Through the routes:
   test/app-review-db.test.js. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REVIEW_DEFAULTS, REVIEW_KEYS, REVIEW_LABELS, ENABLED_ERROR, TIME_ERROR, cleanReviewContent, reviewContentError,
} from "../services/appReview.js";
import { CONTENT_KEYS, CONTENT_LABELS, cleanContent, contentError } from "../services/adminHelpers.js";
import { MANAGEMENT_CONTENT_KEYS, contentAccess, contentEditRefusal } from "../services/staffPowers.js";

test("the defaults: on, Day 2 from noon to 11:59 PM Toronto; served with the other app content", () => {
  assert.deepEqual(REVIEW_DEFAULTS, {
    "review.enabled": "true", "review.ask_from": "2026-10-27T12:00:00-04:00", "review.ask_until": "2026-10-27T23:59:00-04:00",
  });
  for (const k of REVIEW_KEYS) assert.equal(CONTENT_KEYS[k], REVIEW_DEFAULTS[k], k);
  assert.equal(new Date(REVIEW_DEFAULTS["review.ask_from"]).toISOString(), "2026-10-27T16:00:00.000Z");
  assert.equal(new Date(REVIEW_DEFAULTS["review.ask_until"]).toISOString(), "2026-10-28T03:59:00.000Z");
});

test("labels for the admin panel", () => {
  assert.deepEqual(Object.keys(REVIEW_LABELS), REVIEW_KEYS);
  assert.equal(REVIEW_LABELS["review.ask_from"].label, "Ask for an app rating: from");
  assert.equal(REVIEW_LABELS["review.ask_until"].label, "Ask for an app rating: until");
  assert.equal(REVIEW_LABELS["review.enabled"].label, "Ask for an app rating");
  for (const k of REVIEW_KEYS) {
    assert.match(REVIEW_LABELS[k].description, /the apps show Apple's \/ Google's own rating prompt once, after a good moment, inside this window/i, k);
    assert.deepEqual(CONTENT_LABELS[k], REVIEW_LABELS[k]);
  }
});

test("validation: true / false; ISO times with their offset; refused values say why", () => {
  for (const [v, want] of [[true, "true"], [false, "false"], ["true", "true"], [" FALSE ", "false"]]) {
    assert.deepEqual(cleanContent("review.enabled", v), ["review.enabled", want], String(v));
  }
  for (const v of ["yes", "", "1", 1, null, undefined, "on"]) {
    assert.equal(cleanContent("review.enabled", v), null, String(v));
    assert.equal(contentError("review.enabled", v), ENABLED_ERROR);
  }
  for (const k of ["review.ask_from", "review.ask_until"]) {
    for (const v of ["2026-10-27T13:00:00-04:00", "2026-10-27T17:00:00Z", "2026-10-27T13:00-0400", "2026-10-27T13:00:00.000-04:00"]) {
      assert.deepEqual(cleanContent(k, ` ${v} `), [k, v], `${k} ${v}`);
      assert.equal(contentError(k, v), "");
    }
    for (const v of ["", "2026-10-27", "2026-10-27T13:00:00", "tomorrow at 1", "2026-13-40T13:00:00-04:00", "2026-10-27T13:00:00-04:00x", 1793142000000]) {
      assert.equal(cleanContent(k, v), null, `${k} ${v}`);
      assert.equal(contentError(k, v), TIME_ERROR, `${k} ${v}`);
    }
  }
  assert.equal(cleanReviewContent("review.nope", "x"), undefined);
  assert.equal(cleanContent("review.nope", "x"), null, "unknown keys are refused");
  assert.equal(reviewContentError("swag.title", ""), "");
});

test("management only", () => {
  for (const k of REVIEW_KEYS) {
    assert.ok(MANAGEMENT_CONTENT_KEYS.includes(k), k);
    assert.deepEqual(contentAccess(k), { managementOnly: true, locked: false });
    const value = cleanContent(k, REVIEW_DEFAULTS[k])[1];
    assert.equal(contentEditRefusal(k, value, { management: false })?.code, "management_only", k);
    assert.equal(contentEditRefusal(k, value, { management: true }), null, k);
  }
});
