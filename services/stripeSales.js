/* Revenue straight from Stripe: what people actually paid (after promo
   codes, before HST, minus refunds), split by what they bought. Ticket
   revenue never includes booths, pavilion deposits or other payments.
   Sponsorships invoiced outside Stripe aren't visible here. */

import { makeBuckets } from "./staffTickets.js";

const TTL = 5 * 60 * 1000;
let cache = { at: 0, data: null };

/** Which bucket a paid Checkout Session belongs to. Pure. */
export function categoryOf(meta = {}) {
  const type = String(meta.type || "");
  const tier = String(meta.tier || "");
  if (type === "upgrade") return "upgrades";
  if (type === "booth" || tier.startsWith("booth-")) return "booths";
  if (type === "pavilion-deposit") return "pavilion";
  if (type === "ticket" || (!type && tier)) return "tickets";
  return "other";
}

/** Stripe session → plain row (amounts in dollars). Pure. */
export function rowFromSession(s, refundedByIntent = new Map()) {
  const total = (s.amount_total || 0) / 100;
  const tax = (s.total_details?.amount_tax || 0) / 100;
  const refunded = (refundedByIntent.get(s.payment_intent) || 0) / 100;
  // Refunds come back including tax; take the same share off the pre-tax amount.
  const share = total > 0 ? Math.min(1, refunded / total) : 0;
  const net = Math.round(((s.amount_subtotal || 0) / 100 - (s.total_details?.amount_discount || 0) / 100) * (1 - share) * 100) / 100;
  return {
    id: s.id,
    at: new Date((s.created || 0) * 1000),
    category: categoryOf(s.metadata || {}),
    tier: String(s.metadata?.tier || ""),
    name: s.customer_details?.name || "",
    email: String(s.customer_details?.email || s.customer_email || "").toLowerCase(),
    revenue: Math.max(0, net),
    tax, total, refunded,
    promoCode: String(s.metadata?.promoCode || "").toUpperCase(),
    discount: (s.total_details?.amount_discount || 0) / 100,
  };
}

async function fetchRows(stripe) {
  const refunded = new Map();
  for await (const r of stripe.refunds.list({ limit: 100 })) {
    if (r.status === "succeeded" || r.status === "pending") {
      refunded.set(r.payment_intent, (refunded.get(r.payment_intent) || 0) + r.amount);
    }
  }
  const rows = [];
  for await (const s of stripe.checkout.sessions.list({ limit: 100, status: "complete" })) {
    if (s.payment_status !== "paid") continue;
    rows.push(rowFromSession(s, refunded));
  }
  return rows;
}

/** Paid sessions, cached for 5 minutes. `force` refetches. */
export async function stripeRows(stripe, { force = false } = {}) {
  if (!force && cache.data && Date.now() - cache.at < TTL) return cache.data;
  const data = await fetchRows(stripe);
  cache = { at: Date.now(), data };
  return data;
}

const sum = (list) => Math.round(list.reduce((n, r) => n + r.revenue, 0) * 100) / 100;

/** Revenue summary for the analytics page. Pure. */
export function stripeSummary(rows, { range = "month", now = new Date() } = {}) {
  const groups = { tickets: [], upgrades: [], booths: [], pavilion: [], other: [] };
  for (const r of rows) groups[r.category].push(r);
  const ticketish = [...groups.tickets, ...groups.upgrades];

  const buckets = makeBuckets(range, now, ticketish.map((r) => r.at));
  const sales = buckets.map((b) => {
    const inB = ticketish.filter((r) => r.at >= b.from && r.at < b.to);
    return { name: b.name, tickets: inB.filter((r) => r.category === "tickets").length, revenue: sum(inB) };
  });

  const byTier = {};
  for (const r of groups.tickets) {
    byTier[r.tier] = byTier[r.tier] || { tier: r.tier || "unknown", tickets: 0, revenue: 0 };
    byTier[r.tier].tickets += 1;
    byTier[r.tier].revenue = Math.round((byTier[r.tier].revenue + r.revenue) * 100) / 100;
  }
  if (groups.upgrades.length) byTier.__upgrades = { tier: "upgrades", tickets: groups.upgrades.length, revenue: sum(groups.upgrades) };

  const breakdown = Object.fromEntries(Object.entries(groups).map(([k, list]) => [k, { count: list.length, revenue: sum(list) }]));
  return {
    ticketRevenue: sum(ticketish),
    paidTickets: groups.tickets.length,
    breakdown,
    sales,
    byTier: Object.values(byTier).sort((a, b) => b.revenue - a.revenue),
    recent: ticketish.sort((a, b) => b.at - a.at).slice(0, 12)
      .map((r) => ({ name: r.name, tier: r.category === "upgrades" ? `upgrade → ${r.tier}` : r.tier, purchaseDate: r.at, amount: r.revenue, source: "stripe" })),
  };
}

/** Paid uses per promo code (tickets + booths), from Stripe. Pure. */
export function promoUsage(rows) {
  const out = {};
  for (const r of rows) {
    if (!r.promoCode) continue;
    const u = (out[r.promoCode] = out[r.promoCode] || { code: r.promoCode, paidUses: 0, revenue: 0, discountGiven: 0, lastUsedAt: null });
    u.paidUses += 1;
    u.revenue = Math.round((u.revenue + r.revenue) * 100) / 100;
    u.discountGiven = Math.round((u.discountGiven + r.discount) * 100) / 100;
    if (!u.lastUsedAt || r.at > u.lastUsedAt) u.lastUsedAt = r.at;
  }
  return out;
}
