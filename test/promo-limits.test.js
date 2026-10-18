import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import {
  parseMaxUses, isFull, countPromoUses, promoUsageNow, lockPromo, LIMIT_REACHED,
  promoExpired, parseExpiresAt, EXPIRED,
} from "../services/promoLimits.js";
import Promo from "../models/Promo.js";
import User from "../models/User.js";
import promosRouter, { promoDeps } from "../routes/promos.js";

const NOW = 1790000000;                                     // seconds
const sess = (id, code, status, payment_status = "unpaid", extra = {}) =>
  ({ id, status, payment_status, created: NOW - 60, metadata: { promoCode: code }, ...extra });
const row = (id, code) => ({ id, promoCode: code });

/** Minimal Stripe stand-in: checkout.sessions.list and refunds.list as async iterables. */
const fakeStripe = (sessions) => ({
  checkout: { sessions: { list: async function* (params = {}) {
    for (const s of sessions) {
      if (params.status && s.status !== params.status) continue;
      if (params.created?.gte && s.created < params.created.gte) continue;
      yield s;
    }
  } } },
  refunds: { list: async function* () {} },
});

/* ---------- maxUses input ---------- */
test("maxUses: empty means unlimited, whole numbers of 1 or more are kept", () => {
  for (const v of [undefined, null, "", "   "]) assert.deepEqual(parseMaxUses(v), { ok: true, value: null });
  assert.deepEqual(parseMaxUses(50), { ok: true, value: 50 });
  assert.deepEqual(parseMaxUses(" 12 "), { ok: true, value: 12 });
  assert.deepEqual(parseMaxUses(1), { ok: true, value: 1 });
});

test("maxUses: zero, negatives, decimals, words and other types are refused", () => {
  for (const v of [0, "0", -3, "-3", 2.5, "2.5", "ten", "1e3", NaN, Infinity, true, {}, [5]]) {
    const r = parseMaxUses(v);
    assert.equal(r.ok, false, `expected ${JSON.stringify(v)} to be refused`);
    assert.match(r.error, /whole number of 1 or more/);
  }
});

test("isFull: uses at or over the limit; no limit is never full", () => {
  assert.equal(isFull(49, 50), false);
  assert.equal(isFull(50, 50), true);
  assert.equal(isFull(51, 50), true);
  assert.equal(isFull(1000, null), false);
  assert.equal(isFull(1000, undefined), false);
  assert.equal(isFull(0, 1), false);
});

/* ---------- counting ---------- */
test("paid uses = cached paid rows + sessions paid since, each session once", () => {
  const rows = [row("cs_1", "SPRING"), row("cs_2", "SPRING"), row("cs_x", "OTHER")];
  const recent = [
    sess("cs_2", "SPRING", "complete", "paid"),             // already in the cached rows
    sess("cs_3", "spring", "complete", "paid"),             // paid after the cache was filled
    sess("cs_4", "OTHER", "complete", "paid"),
  ];
  assert.deepEqual(countPromoUses("spring", rows, recent, NOW), { paidUses: 3, held: 0, total: 3 });
});

test("checkouts in progress hold a place; expired and abandoned ones don't", () => {
  const recent = [
    sess("cs_open", "SPRING", "open", "unpaid", { expires_at: NOW + 600 }),
    sess("cs_old", "SPRING", "open", "unpaid", { expires_at: NOW - 1 }),     // past its expiry
    sess("cs_exp", "SPRING", "expired"),
    sess("cs_debit", "SPRING", "complete", "unpaid"),                         // bank debit still clearing
    sess("cs_none", "", "open", "unpaid", { expires_at: NOW + 600 }),
  ];
  assert.deepEqual(countPromoUses("SPRING", [], recent, NOW), { paidUses: 0, held: 2, total: 2 });
});

test("promoUsageNow reads paid sessions and the last 25 hours from Stripe", async () => {
  const now = Math.floor(Date.now() / 1000);
  const stripe = fakeStripe([
    { ...sess("cs_a", "LIVE", "open", "unpaid", { expires_at: now + 900 }), created: now - 30 },
    { ...sess("cs_b", "LIVE", "open", "unpaid", { expires_at: now + 900 }), created: now - 26 * 3600 },  // too old to list
  ]);
  const u = await promoUsageNow(stripe, "LIVE", { rows: async () => [row("cs_p", "LIVE")] });
  assert.deepEqual(u, { paidUses: 1, held: 1, total: 2 });
});

test("lockPromo: checkouts for one code run one at a time, other codes don't wait", async () => {
  const order = [];
  const relA = await lockPromo("ONE");
  const second = lockPromo("one").then((rel) => { order.push("second"); rel(); });
  const other = lockPromo("TWO").then((rel) => { order.push("other"); rel(); });
  await other;
  order.push("first-done");
  relA();
  await second;
  assert.deepEqual(order, ["other", "first-done", "second"]);
});

test("lockPromo: a lock that's never released is let go after maxHoldMs", async () => {
  await lockPromo("STUCK", { maxHoldMs: 20 });
  const rel = await lockPromo("STUCK");                   // resolves once the first times out
  rel();
});

/* ---------- routes: validate refuses, admin validates maxUses ---------- */
const promos = new Map();               // code → promo doc
let created = null, updated = null;
Promo.findOne = async ({ code }) => promos.get(code) || null;
Promo.create = async (doc) => { created = doc; return { _id: "p_new", ...doc }; };
Promo.findByIdAndUpdate = async (id, update) => { updated = update; return { _id: id, code: "X", ...update }; };
User.findById = async () => ({ _id: "u1", role: "admin", staffRole: "management", email: "boss@x.com" });
process.env.JWT_SECRET = "test-secret";
const auth = { Authorization: `Bearer ${jwt.sign({ id: "u1" }, "test-secret")}`, "Content-Type": "application/json" };

const now = Math.floor(Date.now() / 1000);
promoDeps.stripe = () => fakeStripe([
  { ...sess("cs_p1", "CAPPED", "complete", "paid"), created: now - 100 },
  { ...sess("cs_p2", "CAPPED", "complete", "paid"), created: now - 90 },
  { ...sess("cs_h1", "CAPPED", "open", "unpaid", { expires_at: now + 900 }), created: now - 30 },
]);
promos.set("CAPPED", { code: "CAPPED", discount: 20, tiers: [], active: true, maxUses: 3 });   // 2 paid + 1 in checkout
promos.set("ROOMY", { code: "ROOMY", discount: 20, tiers: [], active: true, maxUses: 10 });
promos.set("OPEN", { code: "OPEN", discount: 15, tiers: [], active: true, maxUses: null });

const app = express();
app.use(express.json());
app.use("/api", promosRouter);
const server = app.listen(0);
after(() => server.close());
const url = (p) => `http://127.0.0.1:${server.address().port}/api${p}`;
const post = (p, body, headers = { "Content-Type": "application/json" }) =>
  fetch(url(p), { method: "POST", headers, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const put = (p, body) =>
  fetch(url(p), { method: "PUT", headers: auth, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

test("validate: a code whose uses (paid + in checkout) reached maxUses is refused with a friendly message", async () => {
  const r = await post("/promos/validate", { code: "capped", tier: "connect" });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { valid: false, error: LIMIT_REACHED });
  assert.equal(LIMIT_REACHED, "This code has reached its limit.");
});

test("validate: codes under their limit or without one still work", async () => {
  assert.deepEqual((await post("/promos/validate", { code: "ROOMY" })).body, { valid: true, code: "ROOMY", discount: 20, expiresAt: null });
  assert.deepEqual((await post("/promos/validate", { code: "OPEN" })).body, { valid: true, code: "OPEN", discount: 15, expiresAt: null });
});

test("admin create: maxUses saved, empty = unlimited, bad values refused", async () => {
  let r = await post("/admin/promos", { code: "new50", discount: 10, maxUses: "50" }, auth);
  assert.equal(r.status, 200);
  assert.equal(created.maxUses, 50);
  r = await post("/admin/promos", { code: "newfree", discount: 10, maxUses: "" }, auth);
  assert.equal(r.status, 200);
  assert.equal(created.maxUses, null);
  created = null;
  for (const maxUses of [0, -1, 2.5, "lots"]) {
    r = await post("/admin/promos", { code: "nope", discount: 10, maxUses }, auth);
    assert.equal(r.status, 400, `maxUses ${maxUses}`);
    assert.match(r.body.error, /Usage limit/);
  }
  assert.equal(created, null);
});

test("admin update: maxUses can be set, cleared and is validated; omitted leaves it alone", async () => {
  assert.equal((await put("/admin/promos/p1", { maxUses: 25 })).status, 200);
  assert.equal(updated.maxUses, 25);
  assert.equal((await put("/admin/promos/p1", { maxUses: null })).status, 200);
  assert.equal(updated.maxUses, null);
  assert.equal((await put("/admin/promos/p1", { maxUses: "" })).status, 200);
  assert.equal(updated.maxUses, null);
  await put("/admin/promos/p1", { active: false });
  assert.equal("maxUses" in updated, false);
  const bad = await put("/admin/promos/p1", { maxUses: 0 });
  assert.equal(bad.status, 400);
  assert.equal((await put("/admin/promos/p1", { discount: 150 })).status, 400);
});

/* ---------- end dates (APP50 guest offer, Oct 2026) ---------- */
test("promoExpired / parseExpiresAt", () => {
  const ends = "2026-10-21T23:59:00-04:00";
  assert.equal(promoExpired({ expiresAt: ends }, Date.parse("2026-10-21T23:58:59-04:00")), false);
  assert.equal(promoExpired({ expiresAt: ends }, Date.parse("2026-10-22T00:00:00-04:00")), true);
  assert.equal(promoExpired({ expiresAt: null }), false);
  assert.equal(promoExpired({}), false);
  assert.deepEqual(parseExpiresAt(""), { ok: true, value: null });
  assert.deepEqual(parseExpiresAt(null), { ok: true, value: null });
  assert.equal(parseExpiresAt(ends).value.toISOString(), "2026-10-22T03:59:00.000Z");
  assert.equal(parseExpiresAt("next wednesday").ok, false);
  assert.equal(parseExpiresAt("1999-01-01").ok, false);
});

test("validate: an expired code is refused; one still running shows its end date", async () => {
  promos.set("OLD50", { code: "OLD50", discount: 50, tiers: ["connect"], active: true, maxUses: null, expiresAt: new Date(Date.now() - 1000) });
  const soon = new Date(Date.now() + 86400e3);
  promos.set("APP50", { code: "APP50", discount: 50, tiers: ["connect", "influence", "power"], active: true, maxUses: null, expiresAt: soon });
  const old = await post("/promos/validate", { code: "OLD50", tier: "connect" });
  assert.equal(old.status, 410);
  assert.deepEqual(old.body, { valid: false, error: EXPIRED });
  const live = await post("/promos/validate", { code: "app50", tier: "power" });
  assert.equal(live.status, 200);
  assert.equal(live.body.discount, 50);
  assert.equal(live.body.expiresAt, soon.toISOString());
  assert.equal((await post("/promos/validate", { code: "APP50", tier: "apex" })).status, 404);
});

test("admin: end date is saved on create, can be changed or cleared, and is validated", async () => {
  let r = await post("/admin/promos", { code: "ends", discount: 50, tiers: ["connect"], expiresAt: "2026-10-21T23:59:00-04:00" }, auth);
  assert.equal(r.status, 200);
  assert.equal(created.expiresAt.toISOString(), "2026-10-22T03:59:00.000Z");
  r = await post("/admin/promos", { code: "noend", discount: 10 }, auth);
  assert.equal(created.expiresAt, null);
  r = await post("/admin/promos", { code: "badend", discount: 10, expiresAt: "soon" }, auth);
  assert.equal(r.status, 400);
  assert.equal((await put("/admin/promos/p1", { expiresAt: "2026-10-25T12:00:00Z" })).status, 200);
  assert.equal(updated.expiresAt.toISOString(), "2026-10-25T12:00:00.000Z");
  assert.equal((await put("/admin/promos/p1", { expiresAt: "" })).status, 200);
  assert.equal(updated.expiresAt, null);
  await put("/admin/promos/p1", { active: true });
  assert.equal("expiresAt" in updated, false);
});
