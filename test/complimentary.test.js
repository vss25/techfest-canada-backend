import { test } from "node:test";
import assert from "node:assert/strict";
import { validateComplimentary, COMP_TIERS } from "../services/complimentary.js";

test("complimentary tickets need a full name, a valid email and a known pass", () => {
  const ok = validateComplimentary({ name: "  App   Review ", email: "AppReview@TheTechFestival.com ", tier: "Power" });
  assert.deepEqual(ok, { ok: true, value: { name: "App Review", email: "appreview@thetechfestival.com", tier: "power" } });
  assert.equal(validateComplimentary({ name: "Review", email: "a@b.co", tier: "power" }).ok, false);   // no last name
  assert.equal(validateComplimentary({ name: "App Review", email: "nope", tier: "power" }).ok, false);
  assert.equal(validateComplimentary({ name: "App Review", email: "a@b.co", tier: "gold" }).ok, false);
  assert.ok(COMP_TIERS.includes("apex"));
});
