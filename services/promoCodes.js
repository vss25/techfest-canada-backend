/* =========================================================
   The coupon code a ticket was bought with (Oct 20 2026)
   ---------------------------------------------------------
   The organiser: "on RSVP, People, and Tickets page can you show
   what coupon code did the person use to purchase the ticket".

   Where the code is kept: the checkout puts the code the buyer
   applied in the Stripe session's metadata.promoCode
   (routes/payments.js), the webhook copies it onto the ticket
   (User.tickets[].promoCode for a buyer signed in, Attendee.promoCode
   for a guest; "" = bought without a code), and Tickets › Sync from
   Stripe writes it onto tickets it links or creates
   (services/stripeSync.js). A pass someone claimed in the app keeps
   it on its Attendee row (the account's copy has none). Nothing here
   calls Stripe.

   Staff-made passes carry internal markers in the same field, never
   a coupon: COMP (a complimentary ticket), ISSUED (Give a pass),
   EXHIBITOR (an exhibitor pass), SPEAKER (a Speaker Pass). A Speaker
   Pass with no Stripe payment counts as staff-made whatever its field
   says.

   codeOf() → { kind, code, discount, label }:
     code     "SPRING20 · 20% off" (the discount from the Promo row
              today; just the code when it's gone)
     none     "No code": bought through the checkout without one (a
              Stripe session, or the field saved empty)
     staff    "Given by staff", "Complimentary", "Given by staff ·
              exhibitor" (never "Exhibitor Pass": exhibitors hold Connect
              Passes), "Speaker Pass"
     unknown  "—": nothing on record (e.g. a ticket from before the
              field existed)
   Pure, unit-tested (test/promo-codes.test.js).
========================================================= */

import { normalizeTicketId } from "./ticketAccess.js";

/** The internal markers and what staff see instead. */
export const STAFF_MARKERS = Object.freeze({
  ISSUED: "Given by staff",
  COMP: "Complimentary",
  EXHIBITOR: "Given by staff · exhibitor", // an exhibitor's Connect Pass (the pass is never called "Exhibitor Pass")
  SPEAKER: "Speaker Pass",
});
export const NO_CODE = "No code";
export const UNKNOWN_CODE = "—";

/** A code as the checkout keeps it: trimmed, upper-case. */
export const cleanCode = (v) => String(v ?? "").trim().toUpperCase();

const isSpeakerTier = (r) => /^\s*speaker\s*$/i.test(String(r?.type ?? r?.ticketType ?? r?.tier ?? ""));

/** Promo rows ({ code, discount }) → Map(code → percent off). */
export function discountMap(promos = []) {
  const m = new Map();
  for (const p of promos || []) {
    const code = cleanCode(p?.code);
    const d = Number(p?.discount);
    if (code && Number.isFinite(d) && d > 0) m.set(code, d);
  }
  return m;
}

/**
 * One ticket's code. `records`: the ticket's records, the account's copy first, then its Attendee row
 * (either may be missing): { promoCode, stripeSessionId, type | ticketType }. `discounts`: discountMap().
 */
export function codeOf(records, { discounts = new Map() } = {}) {
  const list = (Array.isArray(records) ? records : [records]).filter(Boolean);
  const codes = list.map((r) => cleanCode(r.promoCode)).filter(Boolean);
  const marker = codes.find((c) => STAFF_MARKERS[c]);
  if (marker) return { kind: "staff", code: "", discount: null, label: STAFF_MARKERS[marker], marker };
  const session = list.some((r) => String(r.stripeSessionId || "").trim());
  if (!session && list.some(isSpeakerTier)) return { kind: "staff", code: "", discount: null, label: STAFF_MARKERS.SPEAKER, marker: "SPEAKER" };
  const code = codes[0];
  if (code) {
    const discount = discounts.get(code) ?? null;
    return { kind: "code", code, discount, label: discount ? `${code} · ${discount}% off` : code };
  }
  if (session || list.some((r) => typeof r.promoCode === "string")) return { kind: "none", code: "", discount: null, label: NO_CODE };
  return { kind: "unknown", code: "", discount: null, label: UNKNOWN_CODE };
}

/** The code facts staff see (no internal marker names). */
export const codeView = (c) => ({ kind: c.kind, code: c.code, discount: c.discount, label: c.label });

/**
 * Codes for a list of ticket IDs (the RSVP page), from the database. Models are passed in (tests use fakes):
 * → Map(normalised ticket ID → codeView).
 */
export async function codesForTickets(ticketIds, { User, Attendee, Promo }) {
  const ids = [...new Set((ticketIds || []).map((t) => normalizeTicketId(t)).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  const variants = [...new Set(ids.flatMap((id) => [id, id.toUpperCase()]))];
  const [users, attendees, promos] = await Promise.all([
    User.find({ "tickets.ticketId": { $in: variants } }).select("tickets.ticketId tickets.promoCode tickets.stripeSessionId tickets.type").lean(),
    Attendee.find({ ticketId: { $in: variants } }).select("ticketId promoCode stripeSessionId ticketType").lean(),
    Promo.find({}).select("code discount").lean(),
  ]);
  const byId = new Map(ids.map((id) => [id, []]));
  for (const u of users) for (const t of u.tickets || []) byId.get(normalizeTicketId(t.ticketId))?.unshift(t);
  for (const a of attendees) byId.get(normalizeTicketId(a.ticketId))?.push(a);
  const discounts = discountMap(promos);
  for (const [id, recs] of byId) out.set(id, codeView(codeOf(recs, { discounts })));
  return out;
}
