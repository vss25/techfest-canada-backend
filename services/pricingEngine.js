/* =========================================================
   The one place multi-attendee ticket prices are computed
   (plan §9.4). Pure: no database, no Stripe — the quote
   endpoint (routes/ticketsQuote.js), the multi-attendee
   checkout (routes/orders.js) and tests all run the same
   math, always server-side, always integer cents.

   Order of application (fixed, deterministic):
     1. base price      unitPriceCents × quantity
     2. BOGO            promo kind "bogo": in every complete
                        group of buyQuantity + getQuantity
                        tickets, getQuantity are free
     3. group discount  promo kind "group-percent" /
                        "group-fixed", only when the order
                        reaches promo.minQuantity tickets
     4. code discount   promo kind "percent" / "fixed",
                        off what is left

   A promo has ONE kind, so for a single code at most one of
   steps 2–4 fires; the fixed order still decides how the
   breakdown reads. The plan's "cheapest free" for BOGO is
   automatic here: one ticket type has one unit price, so
   every free ticket is worth exactly unitPriceCents.

   HST is NOT included: like the single-ticket checkout
   (routes/payments.js), tax is added on top by Stripe.

   priceOrder({ ticketType, quantity, promo })
     ticketType  anything with priceCents (and optionally name)
     quantity    whole tickets, 1..100
     promo       a Promo-shaped object or null:
                 { kind, discount (percent), amountCents,
                   buyQuantity, getQuantity, minQuantity }
   → { unitPriceCents, quantity, subtotalCents,
       bogoDiscountCents, groupDiscountCents, codeDiscountCents,
       totalCents, freeTickets, breakdown }
   breakdown lists the base step and every step that changed
   the price (discounts negative), so the buyer sees exactly
   what each rule saved.
========================================================= */

const MAX_QUANTITY = 100;

const cents = (n) => Math.max(0, Math.round(Number(n) || 0));

/** Percent off an amount, rounded down to whole cents. Pure. */
const percentOf = (amountCents, percent) => {
  const p = Math.min(100, Math.max(0, Number(percent) || 0));
  return Math.floor((amountCents * p) / 100);
};

export function priceOrder({ ticketType, quantity, promo } = {}) {
  const unitPriceCents = cents(ticketType?.priceCents);
  const qty = Math.floor(Number(quantity) || 0);
  if (qty < 1 || qty > MAX_QUANTITY) {
    throw new Error(`quantity must be a whole number between 1 and ${MAX_QUANTITY}`);
  }

  const subtotalCents = unitPriceCents * qty;
  let remaining = subtotalCents;
  let freeTickets = 0;
  let bogoDiscountCents = 0;
  let groupDiscountCents = 0;
  let codeDiscountCents = 0;

  const name = ticketType?.name || "ticket";
  const breakdown = [
    { step: "base", label: `${qty} × ${name}`, amountCents: subtotalCents }
  ];

  const kind = promo?.kind || null;

  // 2. BOGO — complete groups only.
  if (kind === "bogo") {
    const buy = Math.floor(Number(promo.buyQuantity) || 0);
    const get = Math.floor(Number(promo.getQuantity) || 0);
    if (buy >= 1 && get >= 1) {
      freeTickets = Math.floor(qty / (buy + get)) * get;
      bogoDiscountCents = Math.min(remaining, freeTickets * unitPriceCents);
      remaining -= bogoDiscountCents;
      if (bogoDiscountCents > 0) {
        breakdown.push({
          step: "bogo",
          label: `Buy ${buy}, get ${get} free — ${freeTickets} free`,
          amountCents: -bogoDiscountCents
        });
      }
    }
  }

  // 3. Group discount — once the order reaches the threshold.
  if (kind === "group-percent" || kind === "group-fixed") {
    const min = Math.floor(Number(promo.minQuantity) || 0);
    if (min >= 1 && qty >= min) {
      groupDiscountCents =
        kind === "group-percent"
          ? percentOf(remaining, promo.discount)
          : Math.min(remaining, cents(promo.amountCents));
      remaining -= groupDiscountCents;
      if (groupDiscountCents > 0) {
        breakdown.push({
          step: "group",
          label: `Group discount (${qty} tickets)`,
          amountCents: -groupDiscountCents
        });
      }
    }
  }

  // 4. Code discount — percent or fixed off what is left.
  if (kind === "percent" || kind === "fixed") {
    codeDiscountCents =
      kind === "percent"
        ? percentOf(remaining, promo.discount)
        : Math.min(remaining, cents(promo.amountCents));
    remaining -= codeDiscountCents;
    if (codeDiscountCents > 0) {
      breakdown.push({
        step: "code",
        label: "Promo code",
        amountCents: -codeDiscountCents
      });
    }
  }

  return {
    unitPriceCents,
    quantity: qty,
    subtotalCents,
    bogoDiscountCents,
    groupDiscountCents,
    codeDiscountCents,
    totalCents: remaining,
    freeTickets,
    breakdown
  };
}

/* =========================================================
   priceBasket — the whole order at once (Nov 2026).

   priceOrder above prices ONE ticket type. An order can hold
   several types, and pricing each line on its own got two
   things wrong: a fixed-amount code came off once PER LINE,
   and a group code's minQuantity was judged per line instead
   of on the order. priceBasket fixes both:

     1. base           every line's unitPriceCents × quantity
     2. BOGO           per line (one unit price per line)
     3. event discount the event's automatic quantity discount
                       (Admin › Events, set per event): when the
                       order reaches minQuantity tickets,
                       percent off what is left. No code needed.
     4. group code     "group-percent" / "group-fixed" when the
                       ORDER reaches promo.minQuantity
     5. code           "percent" / "fixed" — a fixed amount
                       comes off ONCE per order

   Order-level discounts (3–5) are spread over the lines in
   proportion to what each line has left (largest remainder,
   so the line totals always add up to the order total);
   Stripe gets one amount per line.

   priceBasket({ lines: [{ ticketType, quantity }], promo,
                 eventDiscount: { minQuantity, percent } })
   → { subtotalCents, bogoDiscountCents, eventDiscountCents,
       groupDiscountCents, codeDiscountCents, totalCents,
       quantity, freeTickets, lines: [{ …priceOrder-like,
       totalCents }], breakdown }
========================================================= */

/** Spread `amount` over `weights` in proportion, whole cents, exact sum. Pure. */
export function spreadCents(amount, weights) {
  const total = weights.reduce((s, w) => s + w, 0);
  if (amount <= 0 || total <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (amount * w) / total);
  const out = raw.map((r) => Math.floor(r));
  let left = amount - out.reduce((s, v) => s + v, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k += 1, left -= 1) out[order[k].i] += 1;
  return out;
}

/** The event's automatic quantity discount, cleaned: null when off. Pure. */
export function cleanEventDiscount(d) {
  const min = Math.floor(Number(d?.minQuantity) || 0);
  const pct = Number(d?.percent) || 0;
  if (!d || d.enabled === false || min < 2 || pct <= 0) return null;
  return { minQuantity: min, percent: Math.min(100, pct) };
}

export function priceBasket({ lines = [], promo = null, eventDiscount = null } = {}) {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error("an order needs at least one line");
  const kind = promo?.kind || null;

  // 1–2: each line's base and BOGO (codes other than BOGO are order-level).
  const priced = lines.map((l) =>
    priceOrder({ ticketType: l.ticketType, quantity: l.quantity, promo: kind === "bogo" ? promo : null })
  );
  const quantity = priced.reduce((s, p) => s + p.quantity, 0);
  if (quantity > MAX_QUANTITY) throw new Error(`an order is at most ${MAX_QUANTITY} tickets`);
  const subtotalCents = priced.reduce((s, p) => s + p.subtotalCents, 0);
  const bogoDiscountCents = priced.reduce((s, p) => s + p.bogoDiscountCents, 0);
  const freeTickets = priced.reduce((s, p) => s + p.freeTickets, 0);

  const remaining = priced.map((p) => p.totalCents);
  const left = () => remaining.reduce((s, v) => s + v, 0);
  const takeOff = (amount) => {
    const parts = spreadCents(Math.min(amount, left()), remaining);
    parts.forEach((c, i) => { remaining[i] -= c; });
    return parts.reduce((s, v) => s + v, 0);
  };

  const breakdown = priced.flatMap((p) => p.breakdown);

  // 3. The event's automatic quantity discount.
  let eventDiscountCents = 0;
  const ev = cleanEventDiscount(eventDiscount);
  if (ev && quantity >= ev.minQuantity) {
    eventDiscountCents = takeOff(percentOf(left(), ev.percent));
    if (eventDiscountCents > 0) {
      breakdown.push({
        step: "event",
        label: `${ev.percent}% off ${ev.minQuantity}+ tickets`,
        amountCents: -eventDiscountCents
      });
    }
  }

  // 4. Group code, judged on the whole order.
  let groupDiscountCents = 0;
  if (kind === "group-percent" || kind === "group-fixed") {
    const min = Math.floor(Number(promo.minQuantity) || 0);
    if (min >= 1 && quantity >= min) {
      groupDiscountCents = takeOff(
        kind === "group-percent" ? percentOf(left(), promo.discount) : cents(promo.amountCents)
      );
      if (groupDiscountCents > 0) {
        breakdown.push({ step: "group", label: `Group discount (${quantity} tickets)`, amountCents: -groupDiscountCents });
      }
    }
  }

  // 5. Code: percent, or a fixed amount ONCE per order.
  let codeDiscountCents = 0;
  if (kind === "percent" || kind === "fixed") {
    codeDiscountCents = takeOff(
      kind === "percent" ? percentOf(left(), promo.discount) : cents(promo.amountCents)
    );
    if (codeDiscountCents > 0) {
      breakdown.push({ step: "code", label: "Promo code", amountCents: -codeDiscountCents });
    }
  }

  return {
    subtotalCents,
    bogoDiscountCents,
    eventDiscountCents,
    groupDiscountCents,
    codeDiscountCents,
    totalCents: left(),
    quantity,
    freeTickets,
    lines: priced.map((p, i) => ({ ...p, totalCents: remaining[i] })),
    breakdown
  };
}

export default priceOrder;
