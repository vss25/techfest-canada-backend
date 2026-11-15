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

export default priceOrder;
