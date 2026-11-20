import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toCents, money, cleanOffering, lineFrom, totals, overDiscount, pricingKey, deliverablesFor, unitsTaken,
  overLimits, contractNumber, cleanParty, cleanSettings, offeredFor, signatoriesFor, frozenFrom,
} from "../services/contracts.js";

const booth = { _id: "b1", kind: "offering", name: "10×10 booth", category: "booth", unit: "each", price: 500000, track: "once", limit: 20 };
const li = { _id: "l1", kind: "offering", name: "LinkedIn post", category: "social", unit: "post", price: 50000, track: "each" };
const pass = { _id: "p1", kind: "offering", name: "Power Pass", category: "tickets", unit: "pass", price: 99900, track: "none", taxable: true };
const gold = { _id: "g1", kind: "package", name: "Gold sponsor", category: "package", price: 1500000, items: [{ offeringId: "b1", qty: 1 }, { offeringId: "l1", qty: 2 }] };
const byId = (id) => ({ b1: booth, l1: li, p1: pass, g1: gold })[id] || null;

test("dollars to cents and back", () => {
  assert.equal(toCents("1,250.50"), 125050);
  assert.equal(toCents(0), 0);
  assert.equal(toCents(-1), null);
  assert.equal(toCents("abc"), null);
  assert.equal(money(125050), "$1,250.50");
});

test("an offering needs a name, a price and a category; a package needs real items", () => {
  assert.match(cleanOffering({ price: 1 }).error, /name/);
  assert.match(cleanOffering({ name: "X", price: "" }).error, /price/);
  assert.match(cleanOffering({ name: "X", price: 1 }).error, /category/);
  const ok = cleanOffering({ name: "Instagram post", price: "300", category: "social", track: "each", limit: "" });
  assert.equal(ok.value.price, 30000);
  assert.equal(ok.value.limit, null);
  assert.match(cleanOffering({ kind: "package", name: "P", price: 1, items: [] }).error, /at least one/);
  assert.match(cleanOffering({ kind: "package", name: "P", price: 1, items: [{ offeringId: "g1", qty: 1 }] }, { packageOf: byId }).error, /another package/);
  assert.deepEqual(cleanOffering({ kind: "package", name: "P", price: 1, items: [{ offeringId: "b1", qty: 2 }] }, { packageOf: byId }).value.items, [{ offeringId: "b1", qty: 2 }]);
});

test("an offering is for every event unless events are listed, and never once retired", () => {
  assert.ok(offeredFor(booth, "van-2027"));
  assert.ok(!offeredFor({ ...booth, eventKeys: ["tor-2027"] }, "van-2027"));
  assert.ok(!offeredFor({ ...booth, active: false }, "van-2027"));
});

test("lines snapshot the catalogue; packages carry their items", () => {
  const l = lineFrom({ qty: 2 }, li).value;
  assert.equal(l.unitPrice, 50000);
  assert.equal(l.listPrice, 50000);
  const g = lineFrom({ qty: 1, unitPrice: "14000" }, gold, byId).value;
  assert.equal(g.unitPrice, 1400000);
  assert.deepEqual(g.items.map((it) => [it.name, it.qty]), [["10×10 booth", 1], ["LinkedIn post", 2]]);
  assert.match(lineFrom({ qty: 0 }, li).error, /Quantity/);
});

test("totals, discount and tax", () => {
  const lines = [lineFrom({ qty: 1, unitPrice: 4500 }, booth).value, lineFrom({ qty: 2 }, li).value];
  const t = totals(lines, 13);
  assert.equal(t.subtotal, 450000 + 100000);
  assert.equal(t.list, 500000 + 100000);
  assert.equal(t.discount, 50000);
  assert.equal(t.tax, Math.round(550000 * 0.13));
  assert.equal(t.total, 550000 + t.tax);
});

test("a price more than the limit below the catalogue needs approval, and an approval is for those prices only", () => {
  const lines = [lineFrom({ qty: 1, unitPrice: 4000 }, booth).value];
  assert.deepEqual(overDiscount(lines, 10).map((x) => x.pct), [20]);
  assert.equal(overDiscount(lines, 25).length, 0);
  const k = pricingKey(lines, 13);
  assert.notEqual(k, pricingKey([{ ...lines[0], unitPrice: 300000 }], 13));
  assert.notEqual(k, pricingKey(lines, 5));
});

test("signing turns promises into tasks: one per post, one per spotlight, none for passes", () => {
  const lines = [lineFrom({ qty: 2 }, li).value, lineFrom({ qty: 1 }, booth).value, lineFrom({ qty: 4 }, pass).value,
                 lineFrom({ qty: 1 }, gold, byId).value];
  const d = deliverablesFor(lines);
  assert.deepEqual(d.map((x) => x.label), ["LinkedIn post 1 of 2", "LinkedIn post 2 of 2", "10×10 booth", "10×10 booth", "LinkedIn post 1 of 2", "LinkedIn post 2 of 2"]);
  assert.equal(new Set(d.map((x) => x.key)).size, d.length);
});

test("limits count packages' items and other contracts", () => {
  const lines = [lineFrom({ qty: 2 }, booth).value, lineFrom({ qty: 1 }, gold, byId).value];
  assert.equal(unitsTaken(lines).get("b1"), 3);
  assert.deepEqual(overLimits(lines, byId, new Map([["b1", 18]])).map((x) => [x.left, x.asked]), [[2, 3]]);
  assert.equal(overLimits(lines, byId, new Map([["b1", 17]])).length, 0);
});

test("numbers, parties and settings", () => {
  assert.equal(contractNumber(2027, 7), "TTFC-27-0007");
  assert.match(cleanParty({}).error, /company/);
  assert.match(cleanParty({ company: { name: "Acme" }, contact: { email: "nope" } }).error, /email/);
  assert.equal(cleanParty({ company: { name: " Acme  Corp " } }).value.company.name, "Acme Corp");
  assert.match(cleanSettings({ maxDiscountPct: 10, taxRate: 7 }).error, /tax/);
  const base = { maxDiscountPct: 12.5, taxRate: 13, company: { legalName: "TTFC Inc." }, numbering: { prefix: "ttfc", digits: 4 } };
  assert.equal(cleanSettings(base).value.maxDiscountPct, 12.5);
  assert.equal(cleanSettings(base).value.numbering.prefix, "TTFC");
  assert.match(cleanSettings({ ...base, company: {} }).error, /legal name/);
  assert.match(cleanSettings({ ...base, signatories: [{ name: "A", signature: "data:text/html;base64,AAAA" }] }).error, /signature/);
  assert.equal(cleanSettings({ ...base, signatories: [{ name: "A" }, { name: "B" }, { name: "C" }] }).value.signatories.length, 3);
  const many = cleanSettings({ ...base, signatories: Array.from({ length: 12 }, (_, i) => ({ name: "P" + i, id: "same" })) }).value.signatories;
  assert.equal(many.length, 8);
  assert.equal(new Set(many.map((x) => x.id)).size, 8);
  // A contract prints the authority chosen on it; with none chosen, the first two as before.
  const st = { signatories: [{ id: "a1", name: "A" }, { name: "B" }, { id: "c3", name: "C" }] };
  assert.deepEqual(signatoriesFor(st, "c3").map((x) => x.name), ["C"]);
  assert.deepEqual(signatoriesFor(st, "s2").map((x) => x.name), ["B"]);
  assert.deepEqual(signatoriesFor(st, "").map((x) => x.name), ["A", "B"]);
  assert.deepEqual(frozenFrom({ ...st, company: {} }, "a1").signatories.map((x) => x.name), ["A"]);
  assert.equal(contractNumber(2027, 42, { prefix: "TF", digits: 5 }), "TF-27-00042");
});
