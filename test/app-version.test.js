// "Update the app" (Oct 24 2026): the version keys in /api/app/content, their checks and who may change them.
// Run: node --test test/app-version.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { APP_VERSION_DEFAULTS, APP_VERSION_KEYS, compareVersions, parseVersion, cleanAppVersionContent, appVersionContentError, VERSION_ERROR } from "../services/appVersion.js";
import { CONTENT_KEYS, cleanContent, contentError } from "../services/adminHelpers.js";
import { contentAccess, contentEditRefusal } from "../services/staffPowers.js";

test("defaults: this release's versions, no minimum (nobody blocked)", () => {
  assert.deepEqual(APP_VERSION_DEFAULTS, {
    "app.ios_latest": "1.0.3", "app.ios_minimum": "", "app.android_latest": "1.0.6", "app.android_minimum": "", "app.update_message": "",
  });
  for (const k of APP_VERSION_KEYS) assert.equal(CONTENT_KEYS[k], APP_VERSION_DEFAULTS[k], k);
});

test("versions compare numerically, part by part", () => {
  assert.equal(compareVersions("1.0.10", "1.0.9"), 1);
  assert.equal(compareVersions("1.0.2", "1.0.3"), -1);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.equal(compareVersions("2", "1.9.9"), 1);
  assert.equal(compareVersions("1.0.3", ""), null);
  assert.equal(compareVersions("1.0.3 (20)", "1.0.3"), null);
  assert.deepEqual(parseVersion(" 1.0.6 "), [1, 0, 6]);
  assert.equal(parseVersion("v1.0"), null);
});

test("the admin panel: versions or empty, the message trimmed, anything else refused with words", () => {
  assert.deepEqual(cleanContent("app.ios_latest", " 1.0.4 "), ["app.ios_latest", "1.0.4"]);
  assert.deepEqual(cleanContent("app.android_minimum", ""), ["app.android_minimum", ""]);
  assert.equal(cleanContent("app.ios_minimum", "1.0.3 (20)"), null);
  assert.equal(cleanContent("app.android_latest", "latest"), null);
  assert.equal(contentError("app.android_latest", "latest"), VERSION_ERROR);
  assert.equal(contentError("app.android_latest", "1.0.7"), "");
  assert.deepEqual(cleanContent("app.update_message", "  Get the newest TTFC  "), ["app.update_message", "Get the newest TTFC"]);
  assert.equal(cleanContent("app.update_message", "x".repeat(400))[1].length, 280);
  assert.equal(cleanAppVersionContent("site.announcement", "x"), undefined);
  assert.equal(appVersionContentError("app.update_message", "anything"), "");
});

test("management only", () => {
  for (const k of APP_VERSION_KEYS) {
    assert.equal(contentAccess(k).managementOnly, true, k);
    assert.equal(contentEditRefusal(k, "1.0.9", { management: false })?.code, "management_only", k);
    assert.equal(contentEditRefusal(k, "1.0.9", { management: true }), null, k);
  }
});
