/* priceBasket (services/pricingEngine.js, Nov 2026): the whole order is priced at once,
   so a fixed-amount code comes off once per order, a group code's threshold counts every
   ticket in the order, and the event's automatic quantity discount applies with no code.
   Pure: no database, no Stripe. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { priceBasket, priceOrder, spreadCents, cleanEventDiscount } from "../services/pricingEngine.js";

const GA = { name: "General", priceCents: 20000 };
const VIP = { name: "VIP", priceCents: 50000 };

test("one line, no promo: the same totals as priceOrder", () => {
  const b = priceBasket({ lines: [{ ticketType: GA, quantity: 3 }] });
  const o = priceOrder({ ticketType: GA, quantity: 3 });
  assert.equal(b.totalCents, o.totalCents);
  assert.equal(b.subtotalCents, 60000);
  assert.equal(b.quantity, 3);
});

test("a fixed-amount code comes off ONCE per order, not once per ticket type", () => {
  const promo = { kind: "fixed", amountCents: 5000 };
  const b = priceBasket({ lines: [{ ticketType: GA, quantity: 1 }, { ticketType: VIP, quantity: 1 }], promo });
  assert.equal(b.codeDiscountCents, 5000);
  assert.equal(b.totalCents, 70000 - 5000);
  assert.equal(b.lines.reduce((s, l) => s + l.totalCents, 0), b.totalCents);
});

test("a fixed amount bigger than the order makes it $0, never negative", () => {
  const b = priceBasket({ lines: [{ ticketType: GA, quantity: 1 }], promo: { kind: "fixed", amountCents: 999999 } });
  assert.equal(b.totalCents, 0);
  assert.ok(b.lines.every((l) => l.totalCents === 0));
});

test("a group code's minimum counts every ticket in the order", () => {
  const promo = { kind: "group-percent", discount: 10, minQuantity: 4 };
  const b = priceBasket({ lines: [{ ticketType: GA, quantity: 2 }, { ticketType: VIP, quantity: 2 }], promo });
  assert.equal(b.groupDiscountCents, Math.floor(140000 * 0.1));
  const under = priceBasket({ lines: [{ ticketType: GA, quantity: 2 }, { ticketType: VIP, quantity: 1 }], promo });
  assert.equal(under.groupDiscountCents, 0);
});

test("the event's quantity discount applies automatically at the threshold, before codes", () => {
  const eventDiscount = { enabled: true, minQuantity: 5, percent: 15 };
  const b = priceBasket({ lines: [{ ticketType: GA, quantity: 5 }], eventDiscount });
  assert.equal(b.eventDiscountCents, 15000);
  assert.equal(b.totalCents, 85000);
  const withCode = priceBasket({ lines: [{ ticketType: GA, quantity: 5 }], eventDiscount, promo: { kind: "percent", discount: 10 } });
  assert.equal(withCode.codeDiscountCents, 8500); // 10% of what is left after the event discount
  assert.equal(withCode.totalCents, 76500);
  const four = priceBasket({ lines: [{ ticketType: GA, quantity: 4 }], eventDiscount });
  assert.equal(four.eventDiscountCents, 0);
});

test("a switched-off or empty quantity discount does nothing", () => {
  assert.equal(cleanEventDiscount({ enabled: false, minQuantity: 5, percent: 15 }), null);
  assert.equal(cleanEventDiscount({ enabled: true, minQuantity: 1, percent: 15 }), null);
  assert.equal(cleanEventDiscount({ enabled: true, minQuantity: 5, percent: 0 }), null);
  assert.equal(cleanEventDiscount(null), null);
  assert.deepEqual(cleanEventDiscount({ minQuantity: 3, percent: 150 }), { minQuantity: 3, percent: 100 });
});

test("BOGO stays per line (one unit price per line)", () => {
  const promo = { kind: "bogo", buyQuantity: 1, getQuantity: 1 };
  const b = priceBasket({ lines: [{ ticketType: GA, quantity: 2 }, { ticketType: VIP, quantity: 1 }], promo });
  assert.equal(b.bogoDiscountCents, 20000);
  assert.equal(b.freeTickets, 1);
});

test("order discounts are spread over lines in proportion and always add up", () => {
  assert.deepEqual(spreadCents(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(spreadCents(0, [5, 5]), [0, 0]);
  assert.deepEqual(spreadCents(10, [0, 0]), [0, 0]);
  const b = priceBasket({
    lines: [{ ticketType: { priceCents: 333 }, quantity: 1 }, { ticketType: { priceCents: 667 }, quantity: 1 }],
    promo: { kind: "fixed", amountCents: 101 }
  });
  assert.equal(b.lines[0].totalCents + b.lines[1].totalCents, 1000 - 101);
});

test("more than 100 tickets across lines is refused", () => {
  assert.throws(() => priceBasket({ lines: [{ ticketType: GA, quantity: 60 }, { ticketType: VIP, quantity: 41 }] }));
});
