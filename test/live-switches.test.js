import { test } from "node:test";
import assert from "node:assert/strict";
import { switchValue, POLLS_KEY, QA_KEY, UPGRADES_KEY } from "../services/liveSwitches.js";
import { CONTENT_KEYS, cleanContent } from "../services/adminHelpers.js";

test("polls and Q&A switches are app content flags, on by default", () => {
  assert.equal(CONTENT_KEYS[POLLS_KEY], true);
  assert.equal(CONTENT_KEYS[QA_KEY], true);
  assert.deepEqual(cleanContent(QA_KEY, false), [QA_KEY, false]);
  assert.deepEqual(cleanContent(POLLS_KEY, "true"), [POLLS_KEY, true]);
});

test("switchValue reads booleans and text, else the default", () => {
  assert.equal(switchValue(false), false);
  assert.equal(switchValue("false"), false);
  assert.equal(switchValue(true, false), true);
  assert.equal(switchValue("true", false), true);
  assert.equal(switchValue(undefined), true);
  assert.equal(switchValue(null, false), false);
});

test("pass upgrades switch: public app content, OFF by default (no upgrades unless staff turn it on)", () => {
  assert.equal(UPGRADES_KEY, "flag.upgrades");
  assert.equal(CONTENT_KEYS[UPGRADES_KEY], false);
  assert.deepEqual(cleanContent(UPGRADES_KEY, "true"), [UPGRADES_KEY, true]);
  assert.deepEqual(cleanContent(UPGRADES_KEY, "nonsense"), [UPGRADES_KEY, false]);
  // switchOn's default comes from CONTENT_KEYS: a missing row means off.
  assert.equal(switchValue(undefined, CONTENT_KEYS[UPGRADES_KEY] !== false), false);
});
