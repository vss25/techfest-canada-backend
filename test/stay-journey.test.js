/* "Stay updated": the TTFC 2027 journey (services/stayJourney.js) and how app content saves it
   (services/adminHelpers.js cleanContent / contentError). Pure: no database, nothing is sent. */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CITIES, DEFAULT_JOURNEY, DEFAULT_JOURNEY_JSON, JOURNEY_KEY, KINDS, MAX_LEN, MAX_STOPS, PILLARS, SECTORS,
  cityNamed, cleanJourneyContent, journeyContentError, journeyFrom, validateJourney,
} from "../services/stayJourney.js";
import { CONTENT_KEYS, cleanContent, contentError } from "../services/adminHelpers.js";
import { STAY_DEFAULTS } from "../services/waitlist.js";
import { contentAccess } from "../services/staffPowers.js";

const KEYS = ["city", "month", "kind", "pillar", "sector", "date", "venue", "note"];
const at = (city, month, extra = {}) => ({ city, month, kind: "briefing", pillar: "", sector: "", date: "", venue: "", note: "", ...extra });

test("the default journey: the organiser's order, five one-day briefings then the festival in Toronto, all to be announced", () => {
  assert.deepEqual(DEFAULT_JOURNEY.map((s) => [s.month, s.city, s.kind]), [
    ["February 2027", "Vancouver", "briefing"],
    ["April 2027", "Montreal", "briefing"],
    ["June 2027", "Calgary", "briefing"],
    ["June 2027", "Toronto", "briefing"],
    ["September 2027", "Ottawa", "briefing"],
    ["November 2027", "Toronto", "festival"],
  ]);
  for (const s of DEFAULT_JOURNEY) {
    assert.deepEqual(Object.keys(s), KEYS, "the stored shape");
    assert.deepEqual([s.pillar, s.sector, s.date, s.venue, s.note], ["", "", "", "", ""], "focus, date and venue to be announced");
  }
  assert.equal(DEFAULT_JOURNEY_JSON, JSON.stringify(DEFAULT_JOURNEY));
  assert.equal(validateJourney(DEFAULT_JOURNEY_JSON).json, DEFAULT_JOURNEY_JSON, "the default saves as it is");
  // An app content key like the page's other words: served by GET /api/app/content, any staff may change it.
  assert.equal(JOURNEY_KEY, "stay.journey");
  assert.equal(CONTENT_KEYS[JOURNEY_KEY], DEFAULT_JOURNEY_JSON);
  assert.equal(STAY_DEFAULTS[JOURNEY_KEY], DEFAULT_JOURNEY_JSON);
  assert.deepEqual(contentAccess(JOURNEY_KEY), { managementOnly: false, locked: false });
});

test("the lists: five pillars, five sectors, two kinds, the cities with coordinates in Canada", () => {
  assert.deepEqual(PILLARS, ["AI & Machine Learning", "Quantum Computing", "Cybersecurity & Digital Trust", "Robotics & Automation", "CleanTech & Sustainability"]);
  assert.deepEqual(SECTORS, ["Financial Services & Banking", "Healthcare & Life Sciences", "Energy & Critical Infrastructure",
    "Manufacturing, Supply Chain & Mobility", "Public Sector, National Defence & Security"]);
  assert.deepEqual(KINDS, ["briefing", "festival"]);
  const names = CITIES.map((c) => c.name);
  for (const need of ["Vancouver", "Calgary", "Edmonton", "Winnipeg", "Toronto", "Waterloo", "Ottawa", "Montreal", "Quebec City", "Halifax"]) {
    assert.ok(names.includes(need), need);
  }
  assert.equal(new Set(names).size, names.length, "no duplicates");
  for (const c of CITIES) {
    assert.ok(c.lat > 41.6 && c.lat < 70 && c.lon > -141 && c.lon < -52, `${c.name} is in Canada`);
    assert.match(c.province, /^[A-Z]{2}$/);
  }
  const t = CITIES.find((c) => c.name === "Toronto");
  assert.ok(Math.abs(t.lat - 43.65) < 0.05 && Math.abs(t.lon + 79.38) < 0.05, "Toronto's real coordinates");
});

test("cityNamed: case, accents and punctuation don't matter; anything else isn't a city", () => {
  assert.equal(cityNamed("Montréal").name, "Montreal");
  assert.equal(cityNamed("  toronto ").name, "Toronto");
  assert.equal(cityNamed("Québec").name, "Quebec City");
  assert.equal(cityNamed("St Johns").name, "St. John's");
  assert.equal(cityNamed("Boston"), null);
  assert.equal(cityNamed(""), null);
  assert.equal(cityNamed({ name: "Toronto" }), null);
});

test("validateJourney: tidies a good journey into the stored shape (canonical names, fixed keys, extras dropped)", () => {
  const r = validateJourney(JSON.stringify([
    { city: "vancouver", month: "  February   2027 ", pillar: "ai & machine learning", sector: "HEALTHCARE & LIFE SCIENCES", date: "Feb 18", venue: "TBC\nhall", note: "Invite only", extra: "dropped" },
    { city: "Toronto", month: "November 2027", kind: "Festival" },
  ]));
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.stops, [
    at("Vancouver", "February 2027", { pillar: "AI & Machine Learning", sector: "Healthcare & Life Sciences", date: "Feb 18", venue: "TBC hall", note: "Invite only" }),
    at("Toronto", "November 2027", { kind: "festival" }),
  ]);
  assert.equal(r.json, JSON.stringify(r.stops));
  // The list itself works too (not only its JSON text).
  assert.deepEqual(validateJourney([{ city: "Ottawa" }]).stops, [at("Ottawa", "")]);
});

test("validateJourney: refusals in plain words, with the stop and the field", () => {
  const bad = (input, error, index, field) => {
    const r = validateJourney(input);
    assert.equal(r.ok, false, JSON.stringify(input).slice(0, 80));
    assert.equal(r.error, error);
    if (index !== undefined) assert.deepEqual([r.index, r.field], [index, field]);
  };
  bad("{not json", "The journey couldn't be read. Reload the page and try again.");
  bad("{}", "The journey must be a list of stops.");
  bad("[]", "Add at least one stop.");
  bad(JSON.stringify(Array.from({ length: MAX_STOPS + 1 }, () => ({ city: "Toronto" }))), "The journey can have 12 stops at most.");
  bad([{ city: "Toronto" }, "Ottawa"], "Stop 2: this isn't a stop.", 1, "");
  bad([{ city: "Boston" }], "Stop 1: pick a city from the list.", 0, "city");
  bad([{ city: "Toronto", kind: "gala" }], "Stop 1: the type must be a one-day briefing or the festival.", 0, "kind");
  bad([{ city: "Toronto" }, { city: "Ottawa", pillar: "Blockchain" }], "Stop 2: pick the technology pillar from the list, or “To be announced”.", 1, "pillar");
  bad([{ city: "Toronto", sector: "Retail" }], "Stop 1: pick the sector from the list, or “To be announced”.", 0, "sector");
  bad([{ city: "Toronto", venue: "x".repeat(MAX_LEN.venue + 1) }], "Stop 1: the venue is too long (120 characters at most).", 0, "venue");
  bad([{ city: "Toronto", note: "x".repeat(MAX_LEN.note + 1) }], "Stop 1: the note is too long (280 characters at most).", 0, "note");
  bad("[" + " ".repeat(20001) + "]", "The journey is too long. Use fewer or shorter stops.");
  // Exactly at the limits is fine.
  const ok = validateJourney(Array.from({ length: MAX_STOPS }, () => ({ city: "Halifax", month: "m".repeat(40), date: "d".repeat(60), venue: "v".repeat(120), note: "n".repeat(280) })));
  assert.equal(ok.ok, true, ok.error);
});

test("journeyFrom: what the page shows for a saved value; the default when it's empty or can't be read", () => {
  assert.deepEqual(journeyFrom(""), DEFAULT_JOURNEY.map((s) => ({ ...s })));
  assert.deepEqual(journeyFrom(undefined), DEFAULT_JOURNEY.map((s) => ({ ...s })));
  assert.deepEqual(journeyFrom("[oops"), DEFAULT_JOURNEY.map((s) => ({ ...s })));
  assert.deepEqual(journeyFrom(JSON.stringify([{ city: "Halifax", month: "May 2027" }])), [at("Halifax", "May 2027")]);
});

test("app content: PUT /console/app-content/stay.journey saves the tidied JSON, \"\" goes back to the default, a bad one says why", () => {
  assert.deepEqual(cleanContent("stay.journey", JSON.stringify([{ city: "montreal", month: "April 2027" }])),
    ["stay.journey", JSON.stringify([at("Montreal", "April 2027")])]);
  assert.deepEqual(cleanContent("stay.journey", [{ city: "Calgary" }]), ["stay.journey", JSON.stringify([at("Calgary", "")])]);
  assert.deepEqual(cleanContent("stay.journey", ""), ["stay.journey", ""]);
  assert.deepEqual(cleanContent("stay.journey", "   "), ["stay.journey", ""]);
  assert.equal(cleanContent("stay.journey", JSON.stringify([{ city: "Paris" }])), null);
  assert.equal(contentError("stay.journey", JSON.stringify([{ city: "Paris" }])), "Stop 1: pick a city from the list.");
  assert.equal(contentError("stay.journey", ""), "");
  assert.equal(contentError("stay.thanks", "x"), "");
  assert.equal(contentError("no.such.key", "x"), "");
  // Only stay.journey is checked this way; other keys are unchanged.
  assert.equal(cleanJourneyContent("stay.thanks", "x"), undefined);
  assert.equal(journeyContentError("stay.thanks", "[]"), "");
  assert.deepEqual(cleanContent("stay.journey_title", "  TTFC 2027 on tour "), ["stay.journey_title", "  TTFC 2027 on tour "]);
  // A full journey is longer than the 2000 characters other texts are cut to, and isn't cut.
  const long = Array.from({ length: MAX_STOPS }, (_, i) => ({ city: CITIES[i % CITIES.length].name, month: "September 2027", venue: "v".repeat(100), note: "n".repeat(200) }));
  const saved = cleanContent("stay.journey", JSON.stringify(long));
  assert.ok(saved[1].length > 2000);
  assert.equal(JSON.parse(saved[1]).length, MAX_STOPS);
});
