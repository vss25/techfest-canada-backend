import TicketInventory from "../models/TicketInventory.js";

/* =========================================================
   Scheduled price changes for ticket tiers.
   A tier can carry nextPrice + nextPriceAt ("from Thu 22 Oct, 12:00 AM
   Toronto, Power is $1,099"). When that moment passes the change is
   written into `price` and the schedule is cleared, so every existing
   reader of `price` (website, checkout, upgrades, reports) sees it.
   It's applied by a 30 s timer, and again right before the website's
   inventory, checkout and upgrade quotes read prices (throttled), so
   nobody is charged the old price after the switch.
========================================================= */

/** The price a tier sells at `now` (pure). */
export function priceAt(item, now = Date.now()) {
  const at = item?.nextPriceAt ? new Date(item.nextPriceAt).getTime() : NaN;
  const due = Number.isFinite(at) && now >= at && Number.isFinite(item?.nextPrice) && item.nextPrice > 0;
  return due ? item.nextPrice : item?.price ?? 0;
}

/**
 * Admin input → { ok, set } with set = { nextPrice, nextPriceAt } (both null to clear),
 * or { ok: false, error }. Only looked at when the body mentions one of the two fields.
 */
export function parseSchedule(body, now = Date.now()) {
  const hasPrice = body && "nextPrice" in body;
  const hasAt = body && "nextPriceAt" in body;
  if (!hasPrice && !hasAt) return { ok: true, set: null };
  const empty = (v) => v === null || v === undefined || v === "";
  if (empty(body.nextPrice) && empty(body.nextPriceAt)) return { ok: true, set: { nextPrice: null, nextPriceAt: null } };
  const price = Number(body.nextPrice);
  if (!Number.isFinite(price) || price <= 0) return { ok: false, error: "New price must be more than 0" };
  const at = new Date(String(body.nextPriceAt || ""));
  if (Number.isNaN(at.getTime())) return { ok: false, error: "Choose when the new price starts" };
  if (at.getTime() <= now) return { ok: false, error: "The start time has to be in the future (change the price directly instead)" };
  return { ok: true, set: { nextPrice: Math.round(price * 100) / 100, nextPriceAt: at } };
}

let lastRun = 0;
let running = null;

/** Writes due scheduled prices into `price`. Returns how many tiers changed. Never throws. */
export async function applyDuePrices({ Model = TicketInventory, now = new Date(), minGapMs = 5000, log = console } = {}) {
  if (running) return running;
  if (minGapMs && now.getTime() - lastRun < minGapMs) return 0;
  lastRun = now.getTime();
  running = (async () => {
    try {
      const due = await Model.find({ nextPriceAt: { $ne: null, $lte: now }, nextPrice: { $gt: 0 } }).lean();
      for (const t of due) {
        // Conditional on the schedule still being the one we read, so two servers can't apply it twice
        const r = await Model.updateOne(
          { _id: t._id, nextPriceAt: t.nextPriceAt, nextPrice: t.nextPrice },
          { $set: { price: t.nextPrice, nextPrice: null, nextPriceAt: null } },
        );
        if (r.modifiedCount) log.log?.(`💲 Scheduled price applied: ${t.tier} $${t.price} → $${t.nextPrice}`);
      }
      return due.length;
    } catch (err) {
      log.error?.("SCHEDULED PRICE ERROR:", err?.message || err);
      return 0;
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Checks every 30 s while the server runs. */
export function startPriceScheduler({ everyMs = 30_000 } = {}) {
  applyDuePrices({ minGapMs: 0 });
  const t = setInterval(() => applyDuePrices({ minGapMs: 0 }), everyMs);
  t.unref?.();
  return t;
}

/** For tests. */
export function resetPriceSchedulerForTests() { lastRun = 0; running = null; }
