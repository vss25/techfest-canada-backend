/* Staff may add promo codes (Nov 17 2026, the organiser: "Staff may add promo codes"), with a
   safeguard: a code that's more than 50% off, free, or has no usage limit waits for a manager
   before it works (it's saved switched off with approval.needed). Codes management creates or
   changes don't wait. */

export const STAFF_MAX_DISCOUNT = 50;

/** Why a code needs a manager's approval ([] = it doesn't). */
export function managerReasons({ discount, maxUses } = {}) {
  const out = [];
  const d = Number(discount);
  if (d >= 100) out.push("free tickets");
  else if (d > STAFF_MAX_DISCOUNT) out.push(`more than ${STAFF_MAX_DISCOUNT}% off`);
  if (maxUses === null || maxUses === undefined || maxUses === "") out.push("no usage limit");
  return out;
}

/** The answer staff see: management-only numbers (revenue, discount given) left out. */
export function forStaff(row) {
  const { revenue, discountGiven, ...rest } = row;   // eslint-disable-line no-unused-vars
  return rest;
}
