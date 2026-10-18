import { test } from "node:test";
import assert from "node:assert/strict";
import { priceAt, parseSchedule, applyDuePrices, resetPriceSchedulerForTests } from "../services/scheduledPrices.js";

const THU = Date.parse("2026-10-22T00:00:00-04:00");   // 12:00 AM Thursday, Toronto

test("priceAt: the new price from the start time, the old one before", () => {
  const power = { tier: "power", price: 999, nextPrice: 1099, nextPriceAt: new Date(THU) };
  assert.equal(priceAt(power, THU - 1), 999);
  assert.equal(priceAt(power, THU), 1099);
  assert.equal(priceAt(power, THU + 86400e3), 1099);
  assert.equal(priceAt({ price: 849 }, THU), 849);
  assert.equal(priceAt({ price: 849, nextPrice: null, nextPriceAt: new Date(THU) }, THU), 849);
  assert.equal(priceAt({ price: 849, nextPrice: 0, nextPriceAt: new Date(THU) }, THU), 849);
});

test("parseSchedule: both fields together, start in the future, empty clears", () => {
  const now = THU - 3 * 86400e3;
  assert.deepEqual(parseSchedule({ total: 5 }, now), { ok: true, set: null });
  assert.deepEqual(parseSchedule({ nextPrice: "", nextPriceAt: "" }, now), { ok: true, set: { nextPrice: null, nextPriceAt: null } });
  assert.deepEqual(parseSchedule({ nextPrice: null, nextPriceAt: null }, now), { ok: true, set: { nextPrice: null, nextPriceAt: null } });
  const ok = parseSchedule({ nextPrice: "1099", nextPriceAt: "2026-10-22T00:00:00-04:00" }, now);
  assert.equal(ok.ok, true);
  assert.equal(ok.set.nextPrice, 1099);
  assert.equal(ok.set.nextPriceAt.toISOString(), "2026-10-22T04:00:00.000Z");
  assert.equal(parseSchedule({ nextPrice: 0, nextPriceAt: "2026-10-22T04:00:00Z" }, now).ok, false);
  assert.equal(parseSchedule({ nextPrice: 1099 }, now).ok, false);
  assert.equal(parseSchedule({ nextPrice: 1099, nextPriceAt: "soon" }, now).ok, false);
  assert.match(parseSchedule({ nextPrice: 1099, nextPriceAt: "2026-10-01T00:00:00Z" }, now).error, /future/);
});

/** Minimal model: find (with the $lte/$gt/$ne filter) + conditional updateOne. */
function fakeModel(rows) {
  return {
    rows,
    find(q) {
      const out = rows.filter((r) => r.nextPriceAt != null && r.nextPriceAt <= q.nextPriceAt.$lte && r.nextPrice > q.nextPrice.$gt);
      return { lean: async () => out.map((r) => ({ ...r })) };
    },
    async updateOne(filter, update) {
      const r = rows.find((x) => x._id === filter._id && x.nextPriceAt === filter.nextPriceAt && x.nextPrice === filter.nextPrice);
      if (!r) return { modifiedCount: 0 };
      Object.assign(r, update.$set);
      return { modifiedCount: 1 };
    },
  };
}

test("applyDuePrices writes due changes into price once and leaves the rest", async () => {
  resetPriceSchedulerForTests();
  const at = new Date(THU);
  const rows = [
    { _id: 1, tier: "connect", price: 749, nextPrice: 849, nextPriceAt: at },
    { _id: 2, tier: "influence", price: 849, nextPrice: 949, nextPriceAt: at },
    { _id: 3, tier: "booth-single", price: 2499, nextPrice: null, nextPriceAt: null },
    { _id: 4, tier: "apex", price: 1499, nextPrice: 1599, nextPriceAt: new Date(THU + 3600e3) },
  ];
  const Model = fakeModel(rows);
  const quiet = { log() {}, error() {} };
  assert.equal(await applyDuePrices({ Model, now: new Date(THU - 1000), minGapMs: 0, log: quiet }), 0);
  assert.equal(rows[0].price, 749);
  assert.equal(await applyDuePrices({ Model, now: new Date(THU), minGapMs: 0, log: quiet }), 2);
  assert.deepEqual(rows.map((r) => [r.tier, r.price, r.nextPrice]), [
    ["connect", 849, null], ["influence", 949, null], ["booth-single", 2499, null], ["apex", 1499, 1599],
  ]);
  // Running again changes nothing; Apex switches an hour later
  assert.equal(await applyDuePrices({ Model, now: new Date(THU + 60e3), minGapMs: 0, log: quiet }), 0);
  assert.equal(await applyDuePrices({ Model, now: new Date(THU + 3600e3), minGapMs: 0, log: quiet }), 1);
  assert.equal(rows[3].price, 1599);
});

test("applyDuePrices is throttled and never throws", async () => {
  resetPriceSchedulerForTests();
  let calls = 0;
  const Model = { find() { calls += 1; return { lean: async () => [] }; } };
  const now = new Date(THU);
  await applyDuePrices({ Model, now, minGapMs: 5000 });
  await applyDuePrices({ Model, now: new Date(THU + 1000), minGapMs: 5000 });
  assert.equal(calls, 1);
  const broken = { find() { throw new Error("db down"); } };
  assert.equal(await applyDuePrices({ Model: broken, now: new Date(THU + 10_000), minGapMs: 0, log: { error() {} } }), 0);
});
