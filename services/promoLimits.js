/* Usage limits for promo codes (Promo.maxUses; null = unlimited).

   "Used" means PAID USES: Stripe Checkout Sessions that are complete, paid
   and carry the code in metadata.promoCode. It's the same number the admin
   list shows (promoUsage in services/stripeSales.js). Refunded orders still
   count. Promo.timesUsed (the webhook's Mongo counter) isn't used here.

   To stop concurrent checkouts overshooting the limit, the check also
   counts HOLDS: checkouts still in progress with the code (open sessions,
   and complete-but-unpaid ones such as a bank debit still clearing).
   Sessions with a capped code expire after HOLD_MINUTES, so an abandoned
   checkout gives its place back quickly. Checkouts for the same code are
   created one at a time (lockPromo), so two buyers can't both take the
   last place. */

import { stripeRows } from "./stripeSales.js";

export const LIMIT_REACHED = "This code has reached its limit.";
export const EXPIRED = "This code has expired.";

/** Has the code's end date passed? No end date = never expires. */
export function promoExpired(promo, now = Date.now()) {
  const at = promo?.expiresAt ? new Date(promo.expiresAt).getTime() : NaN;
  return Number.isFinite(at) && now > at;
}

/** Admin input → { ok, value: Date|null } or { ok: false, error }. Empty = no end date. */
export function parseExpiresAt(input) {
  if (input === undefined || input === null || input === "") return { ok: true, value: null };
  const d = new Date(String(input));
  if (Number.isNaN(d.getTime())) return { ok: false, error: "End date isn't a valid date and time" };
  if (d.getFullYear() < 2024 || d.getFullYear() > 2100) return { ok: false, error: "End date is out of range" };
  return { ok: true, value: d };
}
export const HOLD_MINUTES = 31;              // Stripe's minimum expiry is 30 min after creation
const RECENT_SECONDS = 25 * 60 * 60;          // a session lives at most 24 h; 1 h slack

/** Admin input → maxUses. Empty / null / undefined = unlimited (null). Pure. */
export function parseMaxUses(input) {
  if (input === undefined || input === null) return { ok: true, value: null };
  if (typeof input !== "number" && typeof input !== "string") return { ok: false, error: "Usage limit must be a whole number of 1 or more" };
  const s = String(input).trim();
  if (s === "") return { ok: true, value: null };
  const n = Number(s);
  if (!/^\d+$/.test(s) || !Number.isSafeInteger(n) || n < 1) {
    return { ok: false, error: "Usage limit must be a whole number of 1 or more (leave it empty for unlimited)" };
  }
  return { ok: true, value: n };
}

/** Has the code reached its limit? No limit = never. Pure. */
export function isFull(uses, maxUses) {
  return Number.isInteger(maxUses) && maxUses > 0 && Number(uses || 0) >= maxUses;
}

/** Paid uses and holds for one code. Pure.
    `paidRows`: stripeRows() output (paid sessions, may be a few minutes old).
    `recent`:   every Checkout Session created in the last 25 hours, fresh from Stripe;
                it covers anything paid or started since the rows were fetched. */
export function countPromoUses(code, paidRows = [], recent = [], nowSec = Math.floor(Date.now() / 1000)) {
  const want = String(code || "").trim().toUpperCase();
  const paid = new Set();
  for (const r of paidRows) if (r.promoCode === want) paid.add(r.id);
  let held = 0;
  for (const s of recent) {
    if (String(s.metadata?.promoCode || "").toUpperCase() !== want || paid.has(s.id)) continue;
    if (s.status === "complete" && s.payment_status === "paid") paid.add(s.id);
    else if (s.status === "complete") held += 1;                                   // payment still clearing
    else if (s.status === "open" && (!s.expires_at || s.expires_at > nowSec)) held += 1;
  }
  return { paidUses: paid.size, held, total: paid.size + held };
}

/** Live paid uses + holds for a code, from Stripe. */
export async function promoUsageNow(stripe, code, { rows = stripeRows } = {}) {
  const since = Math.floor(Date.now() / 1000) - RECENT_SECONDS;
  const recent = [];
  const [paidRows] = await Promise.all([
    rows(stripe),
    (async () => { for await (const s of stripe.checkout.sessions.list({ limit: 100, created: { gte: since } })) recent.push(s); })(),
  ]);
  return countPromoUses(code, paidRows, recent);
}

/* One checkout at a time per code, in this server process. Returns a
   release function; a lock is let go after `maxHoldMs` whatever happens. */
const queues = new Map();
export async function lockPromo(code, { maxHoldMs = 30_000 } = {}) {
  const key = String(code || "").toUpperCase();
  const prev = queues.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const tail = prev.then(() => mine);
  queues.set(key, tail);
  await prev;
  const timer = setTimeout(release, maxHoldMs);
  timer.unref?.();
  return () => {
    clearTimeout(timer);
    release();
    if (queues.get(key) === tail) queues.delete(key);
  };
}
