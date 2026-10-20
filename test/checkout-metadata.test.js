import { test } from "node:test";
import assert from "node:assert/strict";
import { RESERVED_METADATA, cleanMetadata } from "../routes/payments.js";

test("cleanMetadata drops the keys the server sets (a guest can't pick whose account a ticket joins)", () => {
  const out = cleanMetadata({
    firstName: "Jane", company: "Acme", interests: ["AI", "Quantum"], src_visit: "landed /tickets",
    userId: "665f00000000000000000001", tier: "apex", type: "upgrade", upgradeFrom: "PWR-123456",
    fromTier: "power", basePrice: "1", promoCode: "FREE100", discount: "100", client: "ios", taxMode: "none", taxPercent: "0",
  });
  assert.deepEqual(out, { firstName: "Jane", company: "Acme", interests: "AI; Quantum", src_visit: "landed /tickets" });
  for (const k of RESERVED_METADATA) assert.equal(k in out, false, k);
});

test("cleanMetadata still caps keys and values and skips empty answers", () => {
  const out = cleanMetadata({ ["k".repeat(60)]: "v".repeat(600), empty: "", none: null });
  assert.deepEqual(Object.keys(out), ["k".repeat(40)]);
  assert.equal(out["k".repeat(40)].length, 500);
  assert.deepEqual(cleanMetadata(null), {});
});
