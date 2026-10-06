/* Staff view of every ticket (account tickets + guest purchases), duplicate
   detection and real sales numbers. Pure functions, unit-tested.

   "Hidden" tickets are only hidden from staff lists and analytics: the
   owner's ticket stays valid in the app, on the website and at the door. */

const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** One row per ticket. A guest ticket already linked to an account appears once (as the account's). */
export function collectTickets(users = [], guests = []) {
  const rows = [];
  const onAccounts = new Set();
  for (const u of users) {
    for (const t of u.tickets || []) {
      if (!t?.ticketId) continue;
      onAccounts.add(t.ticketId);
      rows.push({
        key: `u:${u._id}:${t.ticketId}`, source: "account", ownerId: String(u._id),
        name: u.name || "", email: String(u.email || "").toLowerCase(), ticketId: t.ticketId,
        tier: String(t.type || "").toLowerCase(), purchaseDate: t.purchaseDate || null,
        checkedIn: !!t.checkedIn, hidden: !!t.hiddenByStaff, promoCode: t.promoCode || "",
        details: t.details || null,
      });
    }
  }
  for (const g of guests) {
    if (!g?.ticketId || onAccounts.has(g.ticketId) || /^BOOTH-/i.test(g.ticketId)) continue;
    rows.push({
      key: `g:${g.ticketId}`, source: "guest", ownerId: "",
      name: g.name || "", email: String(g.email || "").toLowerCase(), ticketId: g.ticketId,
      tier: String(g.ticketType || "").toLowerCase(), purchaseDate: g.purchaseDate || null,
      checkedIn: !!g.checkedIn, hidden: !!g.hiddenByStaff, promoCode: g.promoCode || "",
      details: g.details || null,
    });
  }
  return rows.sort((a, b) => new Date(b.purchaseDate || 0) - new Date(a.purchaseDate || 0));
}

export const personKey = (r) => r.email || `name:${fold(r.name)}`;

/** Visible tickets that repeat a person (same email): every one except their most recent. */
export function duplicateKeys(rows) {
  const byPerson = new Map();
  for (const r of rows) {
    if (r.hidden) continue;
    const k = personKey(r);
    if (!byPerson.has(k)) byPerson.set(k, []);
    byPerson.get(k).push(r);
  }
  const out = [];
  for (const list of byPerson.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => new Date(b.purchaseDate || 0) - new Date(a.purchaseDate || 0));
    for (const r of list.slice(1)) out.push(r.key);
  }
  return out;
}

/** Matches rows by name or email (case/accents ignored). */
export function matchRows(rows, q) {
  const needle = fold(q);
  if (!needle) return rows;
  return rows.filter((r) => fold(r.name).includes(needle) || r.email.includes(String(q).trim().toLowerCase()) || r.ticketId.includes(String(q).trim().toLowerCase())
    || fold(r.details?.organisation).includes(needle) || fold(r.details?.jobTitle).includes(needle));
}

const DAY = 864e5;

/** Time buckets: day = 24 hourly, week = 7 daily, month = 30 daily, all = weekly since the first date. */
export function makeBuckets(range, now = new Date(), dates = []) {
  const start = new Date(now);
  let buckets = [];
  const live = dates.map((d) => ({ purchaseDate: d }));
  if (range === "day") {
    start.setMinutes(0, 0, 0);
    for (let i = 23; i >= 0; i--) {
      const from = new Date(start.getTime() - i * 3600e3);
      buckets.push({ from, to: new Date(from.getTime() + 3600e3), name: from.toLocaleTimeString("en-CA", { hour: "numeric", timeZone: "America/Toronto" }) });
    }
  } else if (range === "all") {
    const first = live.reduce((m, r) => Math.min(m, new Date(r.purchaseDate || now).getTime()), now.getTime());
    const weeks = Math.max(1, Math.ceil((now - first) / (7 * DAY)) + 1);
    for (let i = weeks - 1; i >= 0; i--) {
      const to = new Date(now.getTime() - i * 7 * DAY);
      const from = new Date(to.getTime() - 7 * DAY);
      buckets.push({ from, to, name: from.toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "America/Toronto" }) });
    }
  } else {
    const days = range === "week" ? 7 : 30;
    start.setHours(0, 0, 0, 0);
    for (let i = days - 1; i >= 0; i--) {
      const from = new Date(start.getTime() - i * DAY);
      buckets.push({ from, to: new Date(from.getTime() + DAY), name: from.toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "America/Toronto" }) });
    }
  }
  return buckets;
}

/** Real sales from ticket purchase dates (hidden tickets excluded). Revenue uses tier list prices. */
export function salesSummary(rows, prices = {}, { range = "month", now = new Date() } = {}) {
  const live = rows.filter((r) => !r.hidden);
  const price = (t) => Number(prices[t] || 0);
  const byTier = {};
  for (const r of live) {
    byTier[r.tier] = byTier[r.tier] || { tier: r.tier, tickets: 0, revenue: 0, checkedIn: 0 };
    byTier[r.tier].tickets += 1;
    byTier[r.tier].revenue += price(r.tier);
    if (r.checkedIn) byTier[r.tier].checkedIn += 1;
  }

  const buckets = makeBuckets(range, now, live.map((r) => r.purchaseDate));
  const sales = buckets.map((b) => {
    const inB = live.filter((r) => { const d = new Date(r.purchaseDate || 0); return d >= b.from && d < b.to; });
    return { name: b.name, tickets: inB.length, revenue: inB.reduce((s, r) => s + price(r.tier), 0) };
  });

  const since = (ms) => live.filter((r) => now - new Date(r.purchaseDate || 0) < ms);
  const people = new Set(live.map(personKey));
  return {
    totals: {
      totalTickets: live.length,
      totalRevenue: live.reduce((s, r) => s + price(r.tier), 0),
      uniqueBuyers: people.size,
      checkedIn: live.filter((r) => r.checkedIn).length,
      today: since(DAY).length,
      last7Days: since(7 * DAY).length,
      hiddenTickets: rows.length - live.length,
      duplicates: duplicateKeys(rows).length,
    },
    sales,
    byTier: Object.values(byTier).sort((a, b) => b.revenue - a.revenue),
    recent: live.slice(0, 12).map(({ name, tier, purchaseDate, source }) => ({ name, tier, purchaseDate, source })),
  };
}

/** What each tier's "sold" counter should be: visible pass tickets per tier,
    plus paid booth orders (booths have no ticket records). Pure. */
export function recountSold(rows, boothCounts = {}) {
  const sold = {};
  for (const r of rows) {
    if (r.hidden || !r.tier) continue;
    sold[r.tier] = (sold[r.tier] || 0) + 1;
  }
  for (const [tier, n] of Object.entries(boothCounts)) sold[tier] = (sold[tier] || 0) + n;
  return sold;
}
