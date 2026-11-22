import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTargets } from "../routes/adminEvents.js";

const fake = () => { const vals = {}; return { vals, set: (k, v) => { vals[k] = v; } }; };

test("event targets: whole numbers, empty clears, bad values refused", () => {
  const ev = fake();
  assert.equal(applyTargets(ev, { targets: { delegates: "150", exhibitors: 20 } }), null);
  assert.deepEqual(ev.vals, { "settings.targets.delegates": 150, "settings.targets.exhibitors": 20 });
  const ev2 = fake();
  assert.equal(applyTargets(ev2, { targets: { delegates: "" } }), null);
  assert.deepEqual(ev2.vals, { "settings.targets.delegates": null });
  assert.match(applyTargets(fake(), { targets: { delegates: 12.5 } }), /whole number/);
  assert.match(applyTargets(fake(), { targets: { exhibitors: -1 } }), /whole number/);
  assert.match(applyTargets(fake(), { targets: [] }), /object/);
  assert.equal(applyTargets(fake(), {}), null);
});
