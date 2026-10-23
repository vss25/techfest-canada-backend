/* =========================================================
   "Stay updated": the TTFC 2027 journey across Canada
   (Oct 23 2026). Pure, unit-tested (test/stay-journey.test.js).
   ---------------------------------------------------------
   The organiser: "for stay updated page, remove the programme
   type, and 5*5. Put canada's map and show cities to show the
   journey. Also, the 5 briefing are in this order February -
   Vancouver, April - Montreal, June - Calgary/Toronto, September -
   Ottawa, November - Toronto. Briefings would pick a sector and
   tech pillar and would be very focused. The briefing will be
   updated later. Put this in the admin panel." Confirmed with
   them: June has two briefings (Calgary and Toronto); November in
   Toronto is the main festival (The Tech Festival Canada, two
   days); the briefings are one-day events; dates to be announced
   for every event; no attendee count on 2027 material.

   The journey is one app content key, `stay.journey`: a JSON
   string, a list of stops in order (at most MAX_STOPS):
     { city, month, kind: "briefing" | "festival", pillar, sector,
       date, venue, note }
   "" = to be announced (month, pillar, sector, date, venue) or
   nothing (note). `city` is one of CITIES (the website draws it on
   its map of Canada at these coordinates), `pillar` one of PILLARS
   and `sector` one of SECTORS. Saved through the usual
   PUT /api/console/app-content/stay.journey (any staff; Admin ›
   Sales & emails › 2027 waitlist › 2027 journey), checked here
   (cleanJourneyContent → services/adminHelpers.js cleanContent;
   the refusal's words: journeyContentError) and stored in a fixed
   shape. Empty = DEFAULT_JOURNEY. The website mirrors these lists
   in src/lib/stayJourney.js.
========================================================= */

export const JOURNEY_KEY = "stay.journey";

/** The five technology pillars (a briefing's focus is one of these × one sector). */
export const PILLARS = Object.freeze([
  "AI & Machine Learning",
  "Quantum Computing",
  "Cybersecurity & Digital Trust",
  "Robotics & Automation",
  "CleanTech & Sustainability",
]);

/** The five applied sectors. */
export const SECTORS = Object.freeze([
  "Financial Services & Banking",
  "Healthcare & Life Sciences",
  "Energy & Critical Infrastructure",
  "Manufacturing, Supply Chain & Mobility",
  "Public Sector, National Defence & Security",
]);

/** briefing: a one-day briefing; festival: The Tech Festival Canada (two days). */
export const KINDS = Object.freeze(["briefing", "festival"]);

/** The cities staff can pick (city centres; the website's map puts the dots here). */
export const CITIES = Object.freeze([
  { name: "Vancouver", province: "BC", lat: 49.2827, lon: -123.1207 },
  { name: "Victoria", province: "BC", lat: 48.4284, lon: -123.3656 },
  { name: "Calgary", province: "AB", lat: 51.0447, lon: -114.0719 },
  { name: "Edmonton", province: "AB", lat: 53.5461, lon: -113.4938 },
  { name: "Saskatoon", province: "SK", lat: 52.1332, lon: -106.6700 },
  { name: "Regina", province: "SK", lat: 50.4452, lon: -104.6189 },
  { name: "Winnipeg", province: "MB", lat: 49.8951, lon: -97.1384 },
  { name: "Toronto", province: "ON", lat: 43.6532, lon: -79.3832 },
  { name: "Waterloo", province: "ON", lat: 43.4643, lon: -80.5204 },
  { name: "Ottawa", province: "ON", lat: 45.4215, lon: -75.6972 },
  { name: "Montreal", province: "QC", lat: 45.5019, lon: -73.5674 },
  { name: "Quebec City", province: "QC", lat: 46.8139, lon: -71.2080, aliases: ["quebec", "ville de quebec"] },
  { name: "Fredericton", province: "NB", lat: 45.9636, lon: -66.6431 },
  { name: "Halifax", province: "NS", lat: 44.6488, lon: -63.5752 },
  { name: "St. John's", province: "NL", lat: 47.5615, lon: -52.7126, aliases: ["st johns", "saint john s", "saint johns"] },
].map((c) => Object.freeze({ ...c, aliases: Object.freeze(c.aliases || []) })));

export const MAX_STOPS = 12;
/** Characters at most, per field. */
export const MAX_LEN = Object.freeze({ month: 40, date: 60, venue: 120, note: 280 });
const FIELD_WORD = Object.freeze({ month: "month", date: "date", venue: "venue", note: "note" });
/** A saved journey can't be longer than this (12 stops at their longest fit easily). */
const MAX_INPUT = 20000;

const stop = (city, month, kind = "briefing") => Object.freeze({ city, month, kind, pillar: "", sector: "", date: "", venue: "", note: "" });
/** The organiser's journey (Oct 23 2026): five one-day briefings, then the festival in Toronto. Focus, dates and
    venues to be announced. */
export const DEFAULT_JOURNEY = Object.freeze([
  stop("Vancouver", "February 2027"),
  stop("Montreal", "April 2027"),
  stop("Calgary", "June 2027"),
  stop("Toronto", "June 2027"),
  stop("Ottawa", "September 2027"),
  stop("Toronto", "November 2027", "festival"),
]);
export const DEFAULT_JOURNEY_JSON = JSON.stringify(DEFAULT_JOURNEY);

/** Case, accents and punctuation don't matter: "Montréal" = "montreal", "St Johns" = "St. John's". */
const fold = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** One line of plain text: control characters and runs of spaces become one space. */
const clean = (v) => (typeof v === "string" || typeof v === "number" ? String(v) : "")
  .replace(/[\u0000-\u001F\u007F\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();

/** The city's entry (CITIES), whatever the case, accents or punctuation; null when it isn't one of them. */
export function cityNamed(v) {
  const f = fold(v);
  if (!f) return null;
  return CITIES.find((c) => fold(c.name) === f || c.aliases.includes(f)) || null;
}
const fromList = (list, v) => list.find((x) => fold(x) === fold(v)) ?? null;

/**
 * Checks a journey staff want to save: the JSON text (or the list itself).
 * @returns {{ ok: true, stops, json } | { ok: false, error: string, index?: number, field?: string }}
 *   `stops` in the stored shape (fixed keys and order, canonical names); `index` is 0-based.
 */
export function validateJourney(input) {
  let list = input;
  if (typeof input === "string") {
    if (input.length > MAX_INPUT) return { ok: false, error: "The journey is too long. Use fewer or shorter stops." };
    try { list = JSON.parse(input); } catch { return { ok: false, error: "The journey couldn't be read. Reload the page and try again." }; }
  }
  if (!Array.isArray(list)) return { ok: false, error: "The journey must be a list of stops." };
  if (!list.length) return { ok: false, error: "Add at least one stop." };
  if (list.length > MAX_STOPS) return { ok: false, error: `The journey can have ${MAX_STOPS} stops at most.` };
  const stops = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const n = i + 1;
    const fail = (field, error) => ({ ok: false, index: i, field, error: `Stop ${n}: ${error}` });
    if (!s || typeof s !== "object" || Array.isArray(s)) return fail("", "this isn't a stop.");
    const city = cityNamed(s.city);
    if (!city) return fail("city", "pick a city from the list.");
    const kindRaw = clean(s.kind).toLowerCase();
    const kind = kindRaw || "briefing";
    if (!KINDS.includes(kind)) return fail("kind", "the type must be a one-day briefing or the festival.");
    const pillarRaw = clean(s.pillar);
    const pillar = pillarRaw ? fromList(PILLARS, pillarRaw) : "";
    if (pillar === null) return fail("pillar", "pick the technology pillar from the list, or “To be announced”.");
    const sectorRaw = clean(s.sector);
    const sector = sectorRaw ? fromList(SECTORS, sectorRaw) : "";
    if (sector === null) return fail("sector", "pick the sector from the list, or “To be announced”.");
    const text = {};
    for (const f of Object.keys(MAX_LEN)) {
      text[f] = clean(s[f]);
      if (text[f].length > MAX_LEN[f]) return fail(f, `the ${FIELD_WORD[f]} is too long (${MAX_LEN[f]} characters at most).`);
    }
    stops.push({ city: city.name, month: text.month, kind, pillar, sector, date: text.date, venue: text.venue, note: text.note });
  }
  return { ok: true, stops, json: JSON.stringify(stops) };
}

/** The stops to show for a saved value: the default when it's empty or can't be read (never throws). */
export function journeyFrom(value) {
  if (typeof value !== "string" || !value.trim()) return DEFAULT_JOURNEY.map((s) => ({ ...s }));
  const v = validateJourney(value);
  return v.ok ? v.stops : DEFAULT_JOURNEY.map((s) => ({ ...s }));
}

const isEmpty = (value) => value === undefined || value === null || (typeof value === "string" && !value.trim());

/**
 * For services/adminHelpers.js cleanContent: undefined for any other key; for stay.journey [key, json]
 * ("" = back to the default) or null when it can't be saved (journeyContentError says why).
 */
export function cleanJourneyContent(key, value) {
  if (key !== JOURNEY_KEY) return undefined;
  if (isEmpty(value)) return [key, ""];
  const v = validateJourney(value);
  return v.ok ? [key, v.json] : null;
}

/** Why stay.journey can't be saved, in plain words ("" when it can, or for another key). */
export function journeyContentError(key, value) {
  if (key !== JOURNEY_KEY || isEmpty(value)) return "";
  const v = validateJourney(value);
  return v.ok ? "" : v.error;
}
