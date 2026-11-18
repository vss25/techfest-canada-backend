import TicketType from "../models/TicketType.js";

/* =========================================================
   Default Briefing tickets (Nov 17 2026): "Tickets for each event should be the same by default
   unless we edit and change this. The exception to this is the Toronto Main Event."

   One shared set of ticket types is stored under DEFAULT_BRIEFING_KEY. A Briefing (eventKey
   ending "-briefing") sells that set until staff customise it: customising copies the set onto
   the event's own eventKey, and from then on the event's own types are used. Any other event
   (the Toronto Main Event) only ever has its own.

   Orders and passes keep the event's own eventKey either way, so capacity, sales and passes are
   counted per event even when the ticket type comes from the shared set.
========================================================= */

export const DEFAULT_BRIEFING_KEY = "default-briefing";

/** Does this event fall back to the default Briefing tickets? */
export const usesBriefingDefaults = (eventKey) => /-briefing$/.test(String(eventKey || "")) && eventKey !== DEFAULT_BRIEFING_KEY;

/** Where this event's ticket types live: its own eventKey once it has any, else the default set. */
export async function ticketTypeKey(eventKey, Model = TicketType) {
  if (!usesBriefingDefaults(eventKey)) return eventKey;
  return (await Model.exists({ eventKey })) ? eventKey : DEFAULT_BRIEFING_KEY;
}

/** The fields copied when an event customises the default set. */
export const COPY_FIELDS = [
  "name", "slug", "description", "inclusions", "exclusions", "priceCents",
  "currency", "capacity", "active", "salesStart", "salesEnd", "sortOrder",
];

export function copyOf(type, eventKey) {
  const out = { eventKey };
  for (const f of COPY_FIELDS) if (type[f] !== undefined) out[f] = type[f];
  return out;
}
