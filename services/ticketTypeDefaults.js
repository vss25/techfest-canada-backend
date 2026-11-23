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

/* =========================================================
   Own copy per event (Nov 22 2026, the owner: "every event should have a separate ticket counter
   and pricing available", choosing "own copy per event"). A Briefing no longer keeps selling the
   shared set: it gets its own copy of the defaults, so changing one event's prices never changes
   another's. The default set stays as the template a new Briefing starts from. Copies are made
   when an event is created, when staff open its tickets, and once at boot for every Briefing that
   has none yet. Safe to repeat: the (eventKey, slug) unique index refuses a second copy.
========================================================= */

/** Gives this Briefing its own copy of the default tickets if it has none. → number copied. */
export async function ensureOwnCopy(eventKey, Model = TicketType) {
  if (!usesBriefingDefaults(eventKey)) return 0;
  if (await Model.exists({ eventKey })) return 0;
  const defaults = await Model.find({ eventKey: DEFAULT_BRIEFING_KEY }).lean();
  if (!defaults.length) return 0;
  try {
    const made = await Model.insertMany(defaults.map((t) => copyOf(t, eventKey)), { ordered: false });
    return made.length;
  } catch (e) {
    if (e?.code === 11000 || e?.writeErrors) return e?.insertedDocs?.length || 0; // another request copied first
    throw e;
  }
}

/** Once at boot: every Briefing in Admin › Events without its own tickets gets a copy. */
export async function copyDefaultsToBriefingsOnce({ EventConfig, Model = TicketType, log = console }) {
  try {
    const events = await EventConfig.find({}, { eventKey: 1 }).lean();
    let n = 0;
    for (const e of events) n += await ensureOwnCopy(e.eventKey, Model);
    if (n) log.log(`🎟 Gave Briefings their own copy of the default tickets (${n} ticket types)`);
  } catch (e) {
    log.error("Copying default tickets to Briefings failed:", e.message);
  }
}
