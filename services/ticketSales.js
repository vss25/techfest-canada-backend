import Attendee from "../models/Attendee.js";
import Order from "../models/Order.js";
import TicketType from "../models/TicketType.js";

/* =========================================================
   Ticket counts and multi-event passes (Nov 22 2026, the owner).

   Sold counts: "every event should have a separate ticket counter … The default counter should be
   zero until a sale has happened." A ticket type's sold count is the tickets in PAID orders for
   that event (status paid / fulfilled), matched on the ticket's slug, so an order placed while the
   event still sold the shared default Briefing tickets counts towards the event's own copy.

   Multi-event passes: "an all access pass for that city and the Toronto main event … and a pass
   such that I can select multi city along with Toronto". A pass is a TicketType stored under
   MULTI_EVENT_KEY with `covers` = the events it gets you into, always including a Main Event.
   It is listed on every event it covers, sold from any of them, and buying it issues one pass
   (Attendee) per covered event (services/orderFulfilment.js), so pass holders count towards each
   event's attendees and delegate target. Pass sales are counted on their own line, never inside
   an event's own ticket types.
========================================================= */

export const MULTI_EVENT_KEY = "multi-event";

const PAID = ["paid", "fulfilled"];
const DAY_MS = 24 * 60 * 60 * 1000;

export const isPass = (type) => type?.eventKey === MULTI_EVENT_KEY;
/** An event's Main Event (the Toronto Main Event), by the eventKey style ("ttfc-2027-toronto-main"). */
export const isMainEvent = (eventKey) => /-main$/.test(String(eventKey || ""));

/** Checks a pass's events. → { covers } (cleaned, unique) or { error }. `known` = eventKeys in Admin › Events. */
export function cleanCovers(v, known) {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return { error: "covers must be a list of events" };
  const covers = [...new Set(v.map((x) => x.trim()).filter(Boolean))];
  if (covers.length < 2) return { error: "A pass covers the Main Event and at least one city." };
  const unknown = covers.find((k) => !known.has(k));
  if (unknown) return { error: `No event "${unknown}" in Admin › Events.` };
  if (!covers.some(isMainEvent)) return { error: "A pass always includes the Main Event." };
  // Cities first, the Main Event last ("Vancouver + Calgary + Toronto").
  return { covers: [...covers.filter((k) => !isMainEvent(k)), ...covers.filter(isMainEvent)] };
}

/** The query for what an event sells: its own tickets (or the shared Briefing set) plus the passes that cover it. */
export const sellsAt = (eventKey, typesKey) => ({ $or: [{ eventKey: typesKey }, { eventKey: MULTI_EVENT_KEY, covers: eventKey }] });

/** Taken for capacity: tickets in live orders (paid / fulfilled, plus pending orders from the last
    24 h: a Stripe session lives at most that long) and passes issued by hand (staff-issued
    Attendees). Passes issued BY an order are not counted again (until Nov 22 2026 they were,
    which counted every sold ticket twice). A pass's capacity counts across all its events. */
export async function soldOrReserved(eventKey, type, { Att = Attendee, Ord = Order } = {}) {
  const live = { $or: [{ status: { $in: PAID } }, { status: "pending", createdAt: { $gte: new Date(Date.now() - DAY_MS) } }] };
  if (isPass(type)) {
    const rows = await Ord.aggregate([
      { $match: { ...live, "items.ticketTypeId": type._id } },
      { $unwind: "$items" },
      { $match: { "items.ticketTypeId": type._id } },
      { $group: { _id: null, n: { $sum: "$items.quantity" } } },
    ]);
    return rows[0]?.n || 0;
  }
  const byHand = await Att.countDocuments({ eventKey, ticketType: type.slug, "details.orderId": { $exists: false } });
  const rows = await Ord.aggregate([
    { $match: { eventKey, ...live } },
    { $unwind: "$items" },
    { $match: { "items.passCovers.0": { $exists: false }, $or: [{ "items.ticketTypeId": type._id }, { "items.slug": type.slug }] } },
    { $group: { _id: null, n: { $sum: "$items.quantity" } } },
  ]);
  return byHand + (rows[0]?.n || 0);
}

/** One event's sold counts from paid orders. → { bySlug: { slug: n }, passes: [{ id, name, sold }], ownTickets, passTickets } */
export async function soldForEvent(eventKey, { Ord = Order, Type = TicketType } = {}) {
  const own = await Ord.aggregate([
    { $match: { eventKey, status: { $in: PAID } } },
    { $unwind: "$items" },
    { $match: { "items.passCovers.0": { $exists: false } } },
    { $group: { _id: "$items.slug", n: { $sum: "$items.quantity" } } },
  ]);
  const bySlug = {};
  for (const r of own) bySlug[r._id || ""] = r.n;
  const passTypes = await Type.find({ eventKey: MULTI_EVENT_KEY, covers: eventKey }, { name: 1, sortOrder: 1 }).sort({ sortOrder: 1, name: 1 }).lean();
  const ids = passTypes.map((t) => t._id);
  const passRows = ids.length ? await Ord.aggregate([
    { $match: { status: { $in: PAID }, "items.ticketTypeId": { $in: ids } } },
    { $unwind: "$items" },
    { $match: { "items.ticketTypeId": { $in: ids } } },
    { $group: { _id: "$items.ticketTypeId", n: { $sum: "$items.quantity" } } },
  ]) : [];
  const passSold = new Map(passRows.map((r) => [String(r._id), r.n]));
  const passes = passTypes.map((t) => ({ id: String(t._id), name: t.name, sold: passSold.get(String(t._id)) || 0 }));
  return {
    bySlug,
    passes,
    ownTickets: own.reduce((n, r) => n + r.n, 0),
    passTickets: passes.reduce((n, p) => n + p.sold, 0),
  };
}

/** Each pass's sold count across all its events, from paid orders. → Map(id → n) */
export async function soldPerPass(ids, { Ord = Order } = {}) {
  if (!ids.length) return new Map();
  const rows = await Ord.aggregate([
    { $match: { status: { $in: PAID }, "items.ticketTypeId": { $in: ids } } },
    { $unwind: "$items" },
    { $match: { "items.ticketTypeId": { $in: ids } } },
    { $group: { _id: "$items.ticketTypeId", n: { $sum: "$items.quantity" } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}
