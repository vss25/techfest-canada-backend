import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RSVP_OPTIONS, OPTION_KEYS, EXPERIENCE_KEYS, TIERS, PASS_TIERS, DAY_KEYS, DIETARY_KEYS, rsvpOptionsPayload,
  tierIncludes, allowedExperiences, checkOptions, tierFromTicketType, foldName, nameWords, fullNameMatches,
  personNameKey, matchSpeaker, parseSpeakers, makeSpeakerCache, buildHolderIndex, matchHolder, cleanLookup,
  validateRsvp, resolvePass, rsvpKeys, rsvpsFilter, summarizeRsvps, rsvpRow, rsvpDetail, rsvpsCsv, CSV_HEAD, optionLabel,
  nameVariants, ticketPersonNames, newEditToken, hashEditToken, planRsvpMerge,
} from "../services/rsvp.js";
import { makeLookup, makeRsvpHandlers, publicLookup, cached, TOO_MANY } from "../services/rsvpHandler.js";
import { makeLimiter, makeGuessLimiter } from "../services/ticketAccess.js";

/* ---------- the matrix (must match the Tickets page) ---------- */
// Same table as src/pages/Tickets.jsx passFeatureMap, plus speakers (everything).
const EXPECTED = {
  day1: ["connect", "influence", "power", "apex", "speaker"],
  day2: ["connect", "influence", "power", "apex", "speaker"],
  lunch_d1: ["influence", "power", "apex", "speaker"],
  lunch_d2: ["influence", "power", "apex", "speaker"],
  cxo_d1: ["power", "apex", "speaker"],
  cxo_d2: ["power", "apex", "speaker"],
  gala: ["power", "apex", "speaker"],
  awards: ["power", "apex", "speaker"],
  meetings: ["apex", "speaker"],
  lounge: ["apex", "speaker"],
};

test("the option matrix matches the Tickets page", () => {
  assert.deepEqual(OPTION_KEYS, Object.keys(EXPECTED));
  for (const [key, tiers] of Object.entries(EXPECTED)) {
    for (const t of TIERS) assert.equal(tierIncludes(t, key), tiers.includes(t), `${t} / ${key}`);
  }
  assert.deepEqual(TIERS, ["connect", "influence", "power", "apex", "speaker"]);
  assert.deepEqual(DAY_KEYS, ["day1", "day2"]);
  assert.equal(tierIncludes("apex", "nope"), false);
  assert.equal(tierIncludes("vip", "day1"), false);
});

test("day-specific options belong to their day; the Gala is on the evening of Day 2 (agenda d2-21)", () => {
  const day = Object.fromEntries(RSVP_OPTIONS.map((o) => [o.key, o.day]));
  assert.deepEqual(day, {
    day1: "day1", day2: "day2", lunch_d1: "day1", lunch_d2: "day2", cxo_d1: "day1", cxo_d2: "day2",
    gala: "day2", awards: "day1", meetings: null, lounge: null,
  });
  assert.match(RSVP_OPTIONS.find((o) => o.key === "lounge").label, /19\+/);
  assert.ok(RSVP_OPTIONS.find((o) => o.key === "lounge").note);
  assert.equal(optionLabel("lunch_d2"), "Networking Luncheon (Day 2)");
  assert.equal(optionLabel("awards"), "Catalyst Awards Night (Day 1 evening)");
  assert.equal(optionLabel("gala"), "Gala Dinner & Networking Reception (Day 2 evening)");
});

test("what each pass can choose, by day", () => {
  assert.deepEqual(allowedExperiences("connect", ["day1", "day2"]), []);
  assert.deepEqual(allowedExperiences("influence", ["day2"]), ["lunch_d2"]);
  assert.deepEqual(allowedExperiences("power", ["day1"]), ["lunch_d1", "cxo_d1", "awards"]);
  assert.deepEqual(allowedExperiences("power", ["day2"]), ["lunch_d2", "cxo_d2", "gala"]);
  assert.deepEqual(allowedExperiences("apex", ["day1", "day2"]), EXPERIENCE_KEYS);
  assert.deepEqual(allowedExperiences("speaker", ["day1", "day2"]), EXPERIENCE_KEYS);
  assert.deepEqual(allowedExperiences("apex", []), ["meetings", "lounge"]);
  assert.deepEqual(allowedExperiences("bogus", ["day1"]), []);
});

test("checkOptions accepts what's included and rejects the rest", () => {
  assert.deepEqual(checkOptions("apex", ["day1"], ["lounge", "lunch_d1", "lounge", "day1"]), { ok: true, options: ["lunch_d1", "lounge"] });
  const r = checkOptions("power", ["day1"], ["awards", "lounge", "lunch_d2"]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.invalid, ["lounge", "lunch_d2"]);
  // Day-1-only guests can't book the Day 2 Gala.
  assert.deepEqual(checkOptions("power", ["day1"], ["gala"]).invalid, ["gala"]);
  assert.deepEqual(checkOptions("power", ["day2"], ["gala"]), { ok: true, options: ["gala"] });
  assert.match(r.error, /Power Pass/);
  assert.equal(checkOptions("connect", ["day1", "day2"], ["lunch_d1"]).ok, false);
  assert.equal(checkOptions("influence", ["day1"], ["cxo_d1"]).ok, false);
  assert.equal(checkOptions("speaker", ["day2"], ["awards"]).ok, false); // awards is on Day 1
  assert.deepEqual(checkOptions("connect", ["day1"], []), { ok: true, options: [] });
  assert.equal(checkOptions("apex", ["day1"], ["__proto__"]).ok, false);
});

test("the options payload is the shared config the website reads", () => {
  const p = rsvpOptionsPayload();
  assert.deepEqual(p.tiers.map((t) => t.key), TIERS);
  assert.equal(p.tiers.find((t) => t.key === "speaker").sold, false);
  assert.deepEqual(p.options.map((o) => o.key), OPTION_KEYS);
  assert.deepEqual(p.options.find((o) => o.key === "gala").tiers, ["power", "apex", "speaker"]);
  assert.deepEqual(p.dietary.map((d) => d.key), DIETARY_KEYS);
  assert.deepEqual(p.days.map((d) => d.date), ["2026-10-26", "2026-10-27"]);
  p.options[0].tiers.push("hacked"); // a copy, not the real list
  assert.equal(tierIncludes("hacked", "day1"), false);
});

/* ---------- ticket type → pass ---------- */
test("stored ticket types map to the four passes", () => {
  const cases = {
    connect: "connect", influence: "influence", power: "power", apex: "apex", vip: "apex", VIP: "apex",
    "Apex Pass": "apex", "TTFC Power Pass": "power", " Influence ": "influence", "TTFC 2026 Apex Pass": "apex",
    discover: "connect", early: "connect", festival: "connect", session: "connect", "": "connect", undefined: "connect",
    "all-access": "apex",
  };
  for (const [type, tier] of Object.entries(cases)) assert.equal(tierFromTicketType(type === "undefined" ? undefined : type), tier, type);
});

/* ---------- names ---------- */
test("names fold accents, case and punctuation", () => {
  assert.equal(foldName("Alán Aspuru-Guzik"), "alanaspuruguzik");
  assert.equal(foldName("Øyvind Strauß"), "oyvindstrauss");
  assert.equal(foldName("O'Brien"), "obrien");
  assert.deepEqual(nameWords("Dr. Rulan S. Parekh"), ["rulan", "s", "parekh"]);
  assert.deepEqual(nameWords("Hon. Vic Fedeli"), ["vic", "fedeli"]);
  assert.deepEqual(nameWords("Jane Smith, PhD"), ["jane", "smith"]);
  assert.deepEqual(nameWords("Martin Luther King Jr."), ["martin", "luther", "king"]);
  assert.deepEqual(nameWords("Dr"), ["dr"]); // a lone word is never stripped
  assert.equal(personNameKey("  José ", "NÚÑEZ "), "jose nunez");
  assert.equal(personNameKey("Dr. Jane", "Doe"), "jane doe");
});

test("full-name matching: accents, honorifics, middle names, nicknames", () => {
  const yes = [
    ["Dr. Noelle Ibrahim ", "noelle", "IBRAHIM"],
    ["Alán Aspuru-Guzik", "Alan", "Aspuru Guzik"],
    ["Alán Aspuru-Guzik", "Alán", "Aspuru-Guzik"],
    ["Dennis A. Darby", "Dennis", "Darby"],
    ["Dr. Rulan S. Parekh", "Rulan S.", "Parekh"],
    ["Baldeep Singh Pahwa", "Baldeep", "Pahwa"],
    ["Baldeep Singh Pahwa", "Baldeep", "Singh Pahwa"],
    ["Baldeep Singh Pahwa", "Baldeep Singh", "Pahwa"],
    ['Kulbir "Colin" Singh Dhillon', "Kulbir", "Dhillon"],
    ['Kulbir "Colin" Singh Dhillon', "Colin", "Dhillon"],
    ["Hon. Vic Fedeli", "Mr Vic", "Fedeli"],
    ["Jo-Anne Ryan", "Jo Anne", "Ryan"],
    ["Mary O'Brien", "mary", "obrien"],
    ["Jane Smith, PhD", "Jane", "Smith"],
    [{ firstName: "Jane", lastName: "Doe" }, "jane", "DOE"],
    [{ firstName: "Mary Ann", lastName: "Lee" }, "Mary", "Lee"],
    ["Heling (Alex) Pu", "Alex", "Pu"], // a nickname in brackets
    ["Heling (Alex) Pu", "Heling", "Pu"],
  ];
  for (const [cand, f, l] of yes) assert.equal(fullNameMatches(cand, f, l), true, `${JSON.stringify(cand)} ~ ${f} ${l}`);
  const no = [
    ["Dennis A. Darby", "Dennis", ""], // last name required
    ["Dennis A. Darby", "", "Darby"], // first name required
    ["Dennis A. Darby", "Denis", "Darby"],
    ["Dennis A. Darby", "Dennis", "Darb"],
    ["Dennis A. Darby", "Darby", "Dennis"],
    ["Madonna", "Madonna", "Madonna"], // one-word names never match
    ["Baldeep Singh Pahwa", "Singh", "Pahwa"], // a middle name isn't a first name
    ["Ms. Jane", "Ms", "Jane"],
    [null, "Jane", "Doe"],
    [{ firstName: "Jane" }, "Jane", "Doe"],
    ["Jane Smith (PhD)", "PhD", "Smith"], // a bracketed post-nominal isn't a nickname
  ];
  for (const [cand, f, l] of no) assert.equal(fullNameMatches(cand, f, l), false, `${JSON.stringify(cand)} !~ ${f} ${l}`);
  assert.deepEqual(nameVariants("Heling (Alex) Pu"), [["heling", "pu"], ["alex", "pu"]]);
  assert.deepEqual(nameVariants("Jane Smith (Dr)"), [["jane", "smith"]]);
});

test("speakers from the public Sanity list", async () => {
  const names = parseSpeakers({ result: [{ name: "Amy Flood" }, { name: " Dr. Chris Golden " }, { name: "" }, {}, null] });
  assert.deepEqual(names, ["Amy Flood", "Dr. Chris Golden"]);
  assert.deepEqual(parseSpeakers(null), []);
  assert.equal(matchSpeaker(names, "chris", "golden"), "Dr. Chris Golden");
  assert.equal(matchSpeaker(names, "Chris", ""), "");
  assert.equal(matchSpeaker(names, "Amy", "Floods"), "");

  // Cached for 10 minutes; a failure keeps the last good list and retries after a minute.
  let t = 0, calls = 0, fail = false;
  const fetchImpl = async () => { calls += 1; if (fail) throw new Error("down"); return { ok: true, json: async () => ({ result: [{ name: `Speaker ${calls}` }] }) }; };
  const cache = makeSpeakerCache({ fetchImpl, now: () => t, log: { error() {} } });
  assert.deepEqual(await cache.get(), ["Speaker 1"]);
  t = 9 * 60 * 1000;
  assert.deepEqual(await cache.get(), ["Speaker 1"]);
  assert.equal(calls, 1);
  t = 10 * 60 * 1000 + 1; fail = true;
  assert.deepEqual(await cache.get(), ["Speaker 1"]);
  assert.equal(calls, 2);
  t += 30 * 1000;
  await cache.get();
  assert.equal(calls, 2); // waits a minute before trying again
  t += 31 * 1000; fail = false;
  assert.deepEqual(await cache.get(), ["Speaker 3"]);
});

/* ---------- ticket holders by name ---------- */
const USERS = [
  { _id: "u1", name: "Jane Doe", tickets: [{ ticketId: "AAA111", type: "influence" }, { ticketId: "BBB222", type: "apex" }] },
  { _id: "u2", name: "Sam Lee", tickets: [{ ticketId: "CCC333", type: "power" }] },
  { _id: "u3", name: "Sam Lee", tickets: [{ ticketId: "DDD444", type: "connect" }] }, // a second Sam Lee
  { _id: "u4", name: "Renamed Person", tickets: [{ ticketId: "EEE555", type: "vip", details: { firstName: "Priya", lastName: "Shah" } }] },
  { _id: "u5", name: "Booth Owner", tickets: [{ ticketId: "BOOTH-1", type: "booth-single" }] },
  { _id: "u6", name: "Hidden Test", tickets: [{ ticketId: "FFF666", type: "apex", hiddenByStaff: true }] },
];
const GUESTS = [
  { _id: "g1", name: "Ana Núñez", email: "ana@x.com", ticketId: "GGG777", ticketType: "power" },
  { _id: "g2", name: "Original Name", email: "jane@x.com", ticketId: "aaa111", ticketType: "influence" }, // claimed by u1
  { _id: "g3", name: "Dup Copy", email: "d@x.com", ticketId: "HHH888", ticketType: "apex", syncDuplicate: true },
];

test("holder index: one entry per ticket, claimed tickets keep their original name", () => {
  const idx = buildHolderIndex(USERS, GUESTS);
  assert.equal(idx.length, 6); // AAA, BBB, CCC, DDD, EEE, GGG (no booth, hidden or duplicate)
  const aaa = idx.find((h) => h.owner === "u:u1" && h.tier === "influence");
  assert.ok(aaa.names.includes("Original Name"));
});

test("a ticket's checkout name, not the buyer's account name, says who it is for", () => {
  assert.deepEqual(ticketPersonNames("Jane Doe", { firstName: "Bob", lastName: "Ray" }), [{ firstName: "Bob", lastName: "Ray" }]);
  assert.deepEqual(ticketPersonNames("Jane Doe", {}), ["Jane Doe"]);
  assert.deepEqual(ticketPersonNames("", null), []);
  // Jane holds a Connect pass and bought an Apex pass for her CEO.
  const idx = buildHolderIndex([{ _id: "u1", name: "Jane Doe", tickets: [
    { ticketId: "J1", type: "connect", details: { firstName: "Jane", lastName: "Doe" } },
    { ticketId: "J2", type: "apex", details: { firstName: "Bob", lastName: "Ray" } },
  ] }], [{ _id: "g9", name: "Buyer Person", email: "b@x.com", ticketId: "G9", ticketType: "power", details: { firstName: "Ann", lastName: "Lo" } }]);
  assert.deepEqual(matchHolder(idx, "Jane", "Doe"), { tier: "connect" });
  assert.deepEqual(matchHolder(idx, "Bob", "Ray"), { tier: "apex" });
  assert.deepEqual(matchHolder(idx, "Ann", "Lo"), { tier: "power" });
  assert.equal(matchHolder(idx, "Buyer", "Person"), null);
  // The renamed account's ticket is known by its checkout name only.
  assert.equal(matchHolder(buildHolderIndex(USERS, GUESTS), "Renamed", "Person"), null);
});

test("name-only matching returns a pass only for exactly one person", () => {
  const idx = buildHolderIndex(USERS, GUESTS);
  assert.deepEqual(matchHolder(idx, "Jane", "Doe"), { tier: "apex" }); // highest of her two
  assert.equal(matchHolder(idx, "Sam", "Lee"), null); // two people
  assert.deepEqual(matchHolder(idx, "priya", "SHAH"), { tier: "apex" }); // checkout name, vip → apex
  assert.deepEqual(matchHolder(idx, "Ana", "Nunez"), { tier: "power" });
  assert.deepEqual(matchHolder(idx, "Original", "Name"), { tier: "influence" });
  assert.equal(matchHolder(idx, "Hidden", "Test"), null);
  assert.equal(matchHolder(idx, "Booth", "Owner"), null);
  assert.equal(matchHolder(idx, "Dup", "Copy"), null);
  assert.equal(matchHolder(idx, "Nobody", "Here"), null);
});

/* ---------- lookup ---------- */
function fakeRes() {
  return {
    statusCode: 200, body: undefined, headers: {}, headersSent: false,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
    setHeader(k, v) { this.headers[k] = v; },
  };
}

const TICKETS = { // ticketId → { lastNames, type, names (who it is for) }
  abc123def: { ticketId: "ABC123DEF", type: "power", lastNames: ["Doe"], names: ["Jane Doe"] },
  spk999xyz: { ticketId: "SPK999XYZ", type: "connect", lastNames: ["Golden"], names: ["Chris Golden"] },
  ccc333ddd444: { ticketId: "CCC333DDD444", type: "connect", lastNames: ["Golden"], names: [{ firstName: "Bob", lastName: "Golden" }] },
  eee555fff666: { ticketId: "EEE555FFF666", type: "connect", lastNames: ["Chen"], names: ["Michael Chen"] },
};
function makeWorld() {
  const verifyCalls = [];
  const lookup = makeLookup({
    verifyTicket: async (id, last) => {
      verifyCalls.push(id);
      const t = TICKETS[id];
      return t && t.lastNames.some((l) => l.toLowerCase() === last.toLowerCase()) ? { ticketId: t.ticketId, type: t.type, names: t.names } : null;
    },
    getHolders: async () => buildHolderIndex(USERS, GUESTS),
    getSpeakers: async () => ["Dr. Chris Golden", "Alán Aspuru-Guzik", "Michael J. Chen", "Heling (Alex) Pu"],
  });
  return { lookup, verifyCalls };
}

test("lookup: ticket ID + last name is verified; speakers see everything; one name is never enough", async () => {
  const { lookup } = makeWorld();
  const r1 = await lookup(cleanLookup({ firstName: "", lastName: "doe", ticketId: "TECHFEST:ABC123DEF" }));
  assert.deepEqual(publicLookup(r1, { ticketId: "abc123def" }), { kind: "ticket", verified: true, tier: "power", tierLabel: "Power Pass", ticketMatched: true });
  const r2 = await lookup(cleanLookup({ firstName: "Jane", lastName: "Smith", ticketId: "abc123def" }));
  assert.equal(r2.kind, "none"); // wrong last name, and no Jane Smith holds a ticket
  assert.equal(publicLookup(r2, { ticketId: "abc123def" }).ticketMatched, false);
  const r3 = await lookup(cleanLookup({ firstName: "alan", lastName: "aspuru guzik" }));
  assert.deepEqual(publicLookup(r3), { kind: "speaker", verified: true, tier: "speaker", tierLabel: "Speaker", displayName: "Alán Aspuru-Guzik" });
  // A speaker with a verified (complimentary Connect) ticket still sees everything.
  const r4 = await lookup(cleanLookup({ firstName: "Chris", lastName: "Golden", ticketId: "spk999xyz" }));
  assert.equal(r4.kind, "speaker");
  assert.equal(r4.ticket.ticketId, "SPK999XYZ");
  const r5 = await lookup(cleanLookup({ firstName: "Jane", lastName: "Doe" }));
  assert.deepEqual(publicLookup(r5), { kind: "ticket", verified: false, tier: "apex", tierLabel: "Apex Pass", displayName: "Jane" });
  const r6 = await lookup(cleanLookup({ firstName: "", lastName: "Doe" }));
  assert.equal(r6.kind, "none");
  const r7 = await lookup(cleanLookup({ firstName: "Sam", lastName: "Lee" }));
  assert.equal(r7.kind, "none");
  // Someone else's ticket with the same last name: that ticket's pass, never the speaker's.
  const r8 = await lookup(cleanLookup({ firstName: "Chris", lastName: "Golden", ticketId: "ccc333ddd444" }));
  assert.deepEqual([r8.kind, r8.tier, r8.verified, r8.ticket.holderMatch], ["ticket", "connect", true, false]);
  assert.equal(r4.ticket.holderMatch, true);
  const r9 = await lookup(cleanLookup({ firstName: "Alex", lastName: "Pu" }));
  assert.equal(r9.kind, "speaker");
});

test("lookup endpoint: honeypot, one-name requests, rate limits and no personal data", async () => {
  const { lookup, verifyCalls } = makeWorld();
  let calls = 0;
  const counting = async (q) => { calls += 1; return lookup(q); };
  const h = makeRsvpHandlers({
    lookup: counting, store: {}, log: { error() {} },
    lookupIpLimiter: makeLimiter({ max: 6, windowMs: 60_000 }),
    lookupNameLimiter: makeLimiter({ max: 2, windowMs: 60_000 }),
    ticketGuessLimiter: makeGuessLimiter({ max: 1, windowMs: 60_000 }),
  });
  const run = async (body, ip = "1.1.1.1") => { const res = fakeRes(); await h.lookup({ body, ip }, res); return res; };

  assert.deepEqual((await run({ firstName: "Jane", lastName: "Doe", _hp: "x" })).body, { kind: "none", verified: false });
  assert.deepEqual((await run({ lastName: "Doe" })).body, { kind: "none", verified: false });
  assert.deepEqual((await run({ firstName: "Jane" })).body, { kind: "none", verified: false });
  assert.equal(calls, 0);

  const ok = await run({ firstName: "Jane", lastName: "Doe" });
  assert.equal(ok.body.tier, "apex");
  const text = JSON.stringify(ok.body);
  for (const secret of ["@", "AAA111", "BBB222", "u1", "Original"]) assert.ok(!text.includes(secret), secret);

  await run({ firstName: "jane", lastName: "DOE" });
  const limited = await run({ firstName: "Jane", lastName: "Doe" }); // per address + name
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.body.kind, "none");
  // ...so nobody else can use up a person's lookups.
  assert.equal((await run({ firstName: "Jane", lastName: "Doe" }, "2.2.2.2")).body.tier, "apex");

  await run({ lastName: "Doe", ticketId: "abc123def" }, "3.3.3.3");
  // The same last name again is no new guess; another one is, from any address (per ticket).
  assert.equal((await run({ lastName: "doe", ticketId: "TECHFEST:ABC123DEF" }, "4.4.4.4")).statusCode, 200);
  assert.equal((await run({ lastName: "Dough", ticketId: "ABC123DEF" }, "4.4.4.4")).statusCode, 429);
  assert.equal(verifyCalls.length, 2);

  for (let i = 0; i < 6; i++) await run({ firstName: `P${i}`, lastName: "Zed" }, "9.9.9.9");
  assert.equal((await run({ firstName: "Q", lastName: "Zed" }, "9.9.9.9")).statusCode, 429); // per address
});

/* ---------- validation ---------- */
const GOOD = {
  firstName: " Jane ", lastName: "Doe", email: " Jane@Example.COM ", ticketId: "", tier: "power",
  days: ["day2", "day1", "day1"], options: ["gala", "lunch_d1"], dietary: ["none", "vegan"], dietaryOther: "ignored",
  accessibility: " Step-free\r\naccess ", page: "/rsvp?x=1", _hp: "", elapsedMs: 60000,
};

test("validateRsvp cleans a good RSVP", () => {
  const r = validateRsvp(GOOD);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, {
    firstName: "Jane", lastName: "Doe", email: "jane@example.com", ticketId: "", tier: "power",
    dietaryOther: "", accessibility: "Step-free\naccess", page: "/rsvp",
    days: ["day1", "day2"], options: ["gala", "lunch_d1"], dietary: ["vegan"],
  });
  assert.deepEqual(validateRsvp({ ...GOOD, dietary: ["none"] }).value.dietary, ["none"]);
  assert.equal(validateRsvp({ ...GOOD, dietary: ["other"], dietaryOther: "Low FODMAP" }).value.dietaryOther, "Low FODMAP");
  assert.equal(validateRsvp({ ...GOOD, tier: "" }).ok, true); // resolved later (ticket / speaker)
  assert.equal(validateRsvp({ ...GOOD, ticketId: "TECHFEST:Abc 123" }).value.ticketId, "abc123");
});

test("validateRsvp rejects bad input", () => {
  const bad = [
    [{ firstName: "" }, "firstName"], [{ lastName: " " }, "lastName"], [{ firstName: "x".repeat(81) }, "firstName"],
    [{ lastName: "http://spam.example" }, "lastName"], [{ firstName: "..." }, "firstName"],
    [{ email: "nope" }, "email"], [{ tier: "vip" }, "tier"], [{ days: [] }, "days"], [{ days: ["day3"] }, "days"],
    [{ days: "day1" }, "days"], [{ options: "gala" }, "options"], [{ options: ["spa"] }, "options"],
    [{ dietary: ["paleo"] }, "dietary"], [{ dietary: ["other"], dietaryOther: "" }, "dietaryOther"],
    [{ dietary: ["other"], dietaryOther: "x".repeat(201) }, "dietaryOther"], [{ accessibility: "x".repeat(601) }, "accessibility"],
    [{ ticketId: "x".repeat(65) }, "ticketId"],
  ];
  for (const [patch, field] of bad) {
    const r = validateRsvp({ ...GOOD, ...patch });
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.equal(r.field, field, JSON.stringify(patch));
  }
  assert.equal(validateRsvp(null).ok, false);
});

test("resolvePass: verified ticket > speaker (unverified: the list is public) > what they chose", () => {
  assert.deepEqual(resolvePass({ kind: "ticket", tier: "connect", verified: true }, "apex"), { ok: true, tier: "connect", tierVerified: true, kind: "ticket" });
  assert.deepEqual(resolvePass({ kind: "speaker", tier: "speaker", verified: true }, "connect"), { ok: true, tier: "speaker", tierVerified: false, kind: "speaker", detectedTier: "" });
  assert.deepEqual(resolvePass({ kind: "speaker", tier: "speaker", verified: true, ticket: { type: "connect" } }, ""),
    { ok: true, tier: "speaker", tierVerified: false, kind: "speaker", detectedTier: "connect" });
  // The one holder with their name has a Power pass: they can't claim more without the ticket.
  const up = resolvePass({ kind: "ticket", tier: "power", verified: false }, "apex");
  assert.deepEqual([up.ok, up.field], [false, "ticketId"]);
  assert.match(up.error, /ticket ID.*Apex Pass/);
  assert.deepEqual(resolvePass({ kind: "ticket", tier: "power", verified: false }, "power"), { ok: true, tier: "power", tierVerified: false, kind: "ticket", detectedTier: "power" });
  assert.deepEqual(resolvePass({ kind: "ticket", tier: "power", verified: false }, "influence"), { ok: true, tier: "influence", tierVerified: false, kind: "ticket", detectedTier: "power" });
  assert.deepEqual(resolvePass({ kind: "none", verified: false }, "influence"), { ok: true, tier: "influence", tierVerified: false, kind: "none", detectedTier: "" });
  assert.equal(resolvePass({ kind: "none", verified: false }, "speaker").ok, false); // can't pick "speaker"
  assert.equal(resolvePass({ kind: "none", verified: false }, "").ok, false);
});

test("rsvpKeys: the verified ticket, and the name only when it is the ticket holder's", () => {
  assert.deepEqual(rsvpKeys({ ticketId: "ABC123", ticketVerified: true, holderMatch: true, firstName: "José", lastName: "Núñez" }), { ticket: "t:abc123", name: "jose nunez" });
  assert.deepEqual(rsvpKeys({ ticketId: "ABC123", ticketVerified: true, holderMatch: false, firstName: "José", lastName: "Núñez" }), { ticket: "t:abc123", name: "" });
  assert.deepEqual(rsvpKeys({ ticketId: "ABC123", ticketVerified: false, firstName: "Jose", lastName: "NUNEZ" }), { ticket: "", name: "jose nunez" });
  assert.deepEqual(rsvpKeys({ firstName: "Dr. Jane", lastName: "Doe " }), { ticket: "", name: "jane doe" });
});

test("edit tokens: random, and only their hash is kept", () => {
  const a = newEditToken(), b = newEditToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{32}$/);
  assert.match(hashEditToken(a), /^[0-9a-f]{64}$/);
  assert.equal(hashEditToken(` ${a} `), hashEditToken(a));
  for (const bad of ["", "short", "x".repeat(65), "has spaces in it, twenty+", null, 42, {}]) assert.equal(hashEditToken(bad), "", String(bad));
});

/* ---------- submit + upsert ---------- */
function memoryStore() {
  const rows = [];
  let n = 0;
  const live = (r) => !r.spam && !r.mergedInto;
  return {
    rows,
    async findByKey(key) { return rows.find((r) => r.key === key && !r.spam) || null; },
    async findByNameKey(nameKey) { return nameKey ? rows.filter((r) => r.nameKey === nameKey && live(r)) : []; },
    async insert(doc) {
      if (!doc.spam && rows.some((r) => r.key === doc.key && !r.spam)) { const e = new Error("E11000 duplicate key"); e.code = 11000; throw e; }
      const d = { ...doc, _id: `r${++n}`, createdAt: new Date(), updatedAt: new Date() };
      rows.push(d);
      return d;
    },
    async update(id, set) {
      const d = rows.find((r) => r._id === id);
      Object.assign(d, set, { submissions: (d.submissions || 1) + 1, updatedAt: new Date() });
      return d;
    },
    async mark(id, set) { Object.assign(rows.find((r) => r._id === id), set); },
  };
}

function submitter(opts = {}) {
  const world = makeWorld();
  const store = memoryStore();
  const h = makeRsvpHandlers({ lookup: world.lookup, store, log: { error() {} }, ticketGuessLimiter: makeGuessLimiter({ max: 5, windowMs: 60_000 }), ...opts });
  const run = async (body, ip = "5.5.5.5") => { const res = fakeRes(); await h.submit({ body, ip, headers: { "user-agent": "Test" } }, res); return res; };
  return { run, store, verifyCalls: world.verifyCalls, h };
}
const counted = (store) => summarizeRsvps(store.rows);
const withoutToken = ({ editToken, ...rest }) => rest;

test("submit: the server's pass wins and options are checked against it", async () => {
  const { run, store } = submitter();
  // Ticket says Power; they claimed Apex and asked for the lounge → rejected.
  const r1 = await run({ ...GOOD, ticketId: "abc123def", tier: "apex", options: ["gala", "lounge"] });
  assert.equal(r1.statusCode, 400);
  assert.deepEqual(r1.body.invalid, ["lounge"]);
  assert.equal(store.rows.length, 0);

  const r2 = await run({ ...GOOD, ticketId: "abc123def", tier: "apex", options: ["gala", "cxo_d1"] });
  assert.equal(r2.statusCode, 201);
  assert.deepEqual([r2.body.tier, r2.body.tierVerified, r2.body.kind, r2.body.updated], ["power", true, "ticket", false]);
  assert.ok(!("id" in r2.body)); // no row id goes out
  assert.equal(typeof r2.body.editToken, "string");
  assert.deepEqual(store.rows[0].options, ["cxo_d1", "gala"]);
  assert.equal(store.rows[0].key, "t:abc123def");
  assert.equal(store.rows[0].ticketId, "ABC123DEF");
  assert.equal(store.rows[0].chosenTier, "apex");
  assert.equal(store.rows[0].editTokenHash, hashEditToken(r2.body.editToken));

  // Speakers get everything, whatever they picked, but a name on the public list is no proof.
  const r3 = await run({ ...GOOD, firstName: "Chris", lastName: "Golden", tier: "connect", options: ["lounge", "meetings", "awards"] });
  assert.deepEqual([r3.statusCode, r3.body.tier, r3.body.tierVerified, r3.body.kind], [201, "speaker", false, "speaker"]);
  assert.equal(store.rows[1].matchedSpeaker, "Dr. Chris Golden");

  // Nobody we know: their choice stands, unverified.
  const r4 = await run({ ...GOOD, firstName: "New", lastName: "Person", tier: "influence", options: ["lunch_d2"] });
  assert.deepEqual([r4.statusCode, r4.body.tier, r4.body.tierVerified, r4.body.kind], [201, "influence", false, "none"]);
  const r5 = await run({ ...GOOD, firstName: "Other", lastName: "Person", tier: "speaker", options: [] });
  assert.equal(r5.statusCode, 400);

  // One ticket holder by that name: their ticket's pass is the most they can claim without it.
  const over = await run({ ...GOOD, firstName: "Ana", lastName: "Nunez", tier: "apex", options: ["lounge"] });
  assert.deepEqual([over.statusCode, over.body.field], [400, "ticketId"]);
  await run({ ...GOOD, firstName: "Ana", lastName: "Nunez", tier: "influence", options: [] });
  const ana = store.rows.find((r) => r.lastName === "Nunez");
  assert.deepEqual([ana.tier, ana.tierVerified, ana.kind, ana.detectedTier], ["influence", false, "ticket", "power"]);
});

test("submit: a speaker's verified ticket is noted, but the speaker match stays unverified", async () => {
  const { run, store } = submitter();
  // A Connect holder whose name is also on the speaker list ("Michael J. Chen").
  const r = await run({ ...GOOD, firstName: "Michael", lastName: "Chen", ticketId: "eee555fff666", tier: "connect", days: ["day1"], options: ["lounge", "meetings"] });
  assert.deepEqual([r.statusCode, r.body.tier, r.body.tierVerified, r.body.kind], [201, "speaker", false, "speaker"]);
  const row = store.rows[0];
  assert.deepEqual([row.key, row.ticketVerified, row.detectedTier, row.matchedSpeaker], ["t:eee555fff666", true, "connect", "Michael J. Chen"]);
  assert.equal(summarizeRsvps(store.rows).verifiedCounts.lounge, 0); // not in the verified headcounts
  assert.deepEqual(rsvpsFilter({ verified: "1" }).tierVerified, true);
});

test("submit: the edit token changes the RSVP it was given for", async () => {
  const { run, store } = submitter();
  const first = await run({ ...GOOD, firstName: "Lee", lastName: "Park", tier: "connect", options: [], email: "lee@x.com" });
  const token = first.body.editToken;
  const again = await run({ ...GOOD, firstName: " LEE ", lastName: "park", tier: "influence", options: ["lunch_d1"], email: "", editToken: token });
  assert.deepEqual([again.statusCode, again.body.updated, again.body.editToken], [201, true, token]);
  assert.equal(store.rows.length, 1);
  assert.deepEqual([store.rows[0].tier, store.rows[0].submissions, store.rows[0].email], ["influence", 2, "lee@x.com"]);

  // A wrong ticket ID isn't a key: with the token it is the same row, not a second one.
  await run({ ...GOOD, firstName: "Lee", lastName: "Park", ticketId: "zzz999zzz", tier: "connect", options: [], editToken: token });
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0].ticketId, "zzz999zzz");
  assert.equal(store.rows[0].ticketVerified, false);

  // Jane first without her ticket, then with it and her token: the same row, now keyed by the ticket.
  const jane = await run({ ...GOOD, tier: "connect", options: [] });
  assert.equal(store.rows[1].key, "n:jane doe");
  const r = await run({ ...GOOD, ticketId: "TECHFEST:ABC123DEF", tier: "", options: ["gala"], editToken: jane.body.editToken });
  assert.equal(r.body.updated, true);
  assert.equal(store.rows.length, 2);
  assert.deepEqual([store.rows[1].key, store.rows[1].tier, store.rows[1].tierVerified], ["t:abc123def", "power", true]);
});

test("submit: a name alone never changes someone's RSVP, and the answer doesn't say they had one", async () => {
  const { run, store } = submitter();
  const real = await run({ ...GOOD, firstName: "Chris", lastName: "Golden", email: "chris@real.com", tier: "", days: ["day1", "day2"],
    options: ["gala", "awards", "lunch_d1"], dietary: ["nut_allergy"], accessibility: "Wheelchair, step-free" });
  assert.equal(real.statusCode, 201);
  const fake = await run({ ...GOOD, firstName: "chris", lastName: "GOLDEN", email: "attacker@evil.example", tier: "connect", days: ["day2"],
    options: [], dietary: ["none"], accessibility: "" }, "6.6.6.6");
  assert.equal(fake.statusCode, 201);
  assert.deepEqual(withoutToken(fake.body), withoutToken(real.body)); // same answer as a first RSVP
  assert.equal(fake.body.updated, false);

  const [orig, dup] = store.rows;
  assert.deepEqual([orig.days, orig.options, orig.dietary, orig.accessibility, orig.email, orig.submissions],
    [["day1", "day2"], ["lunch_d1", "gala", "awards"], ["nut_allergy"], "Wheelchair, step-free", "chris@real.com", 1]);
  assert.equal(dup.duplicateOf, orig._id);
  assert.match(dup.key, /^dup:/);
  const s = counted(store);
  assert.deepEqual([s.total, s.duplicates, s.counts.day1, s.counts.gala, s.dietary.none], [1, 1, 1, 1, 0]);

  // Two different people with one name: the second waits for staff instead of replacing the first.
  await run({ ...GOOD, firstName: "Sam", lastName: "Ray", tier: "connect", days: ["day1"], options: [], dietary: ["vegan"] });
  await run({ ...GOOD, firstName: "Sam", lastName: "Ray", tier: "connect", days: ["day2"], options: [], dietary: ["halal"] }, "7.7.7.7");
  const sams = store.rows.filter((r) => r.lastName === "Ray");
  assert.deepEqual(sams.map((r) => r.dietary[0]), ["vegan", "halal"]);
  assert.equal(sams[1].duplicateOf, sams[0]._id);
  // A token for another row proves nothing here.
  await run({ ...GOOD, firstName: "Sam", lastName: "Ray", tier: "connect", days: ["day2"], options: [], editToken: real.body.editToken });
  assert.equal(store.rows.filter((r) => r.lastName === "Ray" && !r.duplicateOf).length, 1);
  assert.equal(sams[0].dietary[0], "vegan");
});

test("submit: re-sending without the ticket ID doesn't count the person twice or lose the verified pass", async () => {
  const { run, store } = submitter();
  const first = await run({ ...GOOD, ticketId: "abc123def", tier: "power", days: ["day1"], options: ["cxo_d1"], dietary: ["vegan"] });
  assert.equal(store.rows[0].key, "t:abc123def");
  // Another device, no ticket ID: kept apart, not counted.
  const again = await run({ ...GOOD, ticketId: "", tier: "power", days: ["day1"], options: ["cxo_d1"], dietary: ["halal"] });
  assert.equal(again.body.updated, false);
  assert.equal(store.rows.length, 2);
  assert.equal(store.rows[1].duplicateOf, store.rows[0]._id);
  let s = counted(store);
  assert.deepEqual([s.total, s.counts.day1, s.counts.cxo_d1, s.dietary.vegan, s.dietary.halal, s.tiers.power.total], [1, 1, 1, 1, 0, 1]);

  // Same browser (its token), no ticket ID: the verified row changes and keeps its pass.
  const mine = await run({ ...GOOD, ticketId: "", tier: "power", days: ["day1"], options: ["lunch_d1"], dietary: ["halal"], editToken: first.body.editToken });
  assert.deepEqual([mine.body.updated, mine.body.tier, mine.body.tierVerified, mine.body.kind], [true, "power", true, "ticket"]);
  const row = store.rows[0];
  assert.deepEqual([row.key, row.tier, row.tierVerified, row.ticketId, row.ticketVerified, row.dietary[0], row.options[0]],
    ["t:abc123def", "power", true, "ABC123DEF", true, "halal", "lunch_d1"]);
  s = counted(store);
  assert.deepEqual([s.total, s.dietary.halal, s.dietary.vegan], [1, 1, 0]);
  // Claiming more than the verified pass without the ticket changes nothing.
  const more = await run({ ...GOOD, ticketId: "", tier: "apex", days: ["day1"], options: ["lounge"], editToken: first.body.editToken });
  assert.deepEqual([more.statusCode, more.body.invalid], [400, ["lounge"]]);
  assert.deepEqual([row.tier, row.options], ["power", ["lunch_d1"]]);
});

test("submit: a browser's own possible duplicate, later proven by its ticket, becomes the counted RSVP", async () => {
  const { run, store } = submitter();
  await run({ ...GOOD, tier: "connect", days: ["day2"], options: [] }); // someone (maybe Jane) without a ticket
  const mine = await run({ ...GOOD, tier: "connect", days: ["day1"], options: [] }, "9.9.9.9");
  assert.equal(store.rows[1].duplicateOf, store.rows[0]._id);
  const proven = await run({ ...GOOD, ticketId: "abc123def", tier: "", days: ["day1"], options: ["cxo_d1"], editToken: mine.body.editToken }, "9.9.9.9");
  assert.deepEqual([proven.body.updated, proven.body.tierVerified], [true, true]);
  const [other, own] = store.rows;
  assert.deepEqual([own.key, own.duplicateOf, own.tier], ["t:abc123def", "", "power"]);
  assert.equal(other.duplicateOf, own._id);
  assert.deepEqual(other.days, ["day2"]);
  assert.equal(counted(store).total, 1);
});

test("submit: a ticket-verified RSVP stands in for an earlier name-only one, without overwriting it", async () => {
  const { run, store } = submitter();
  // Jane Doe #1, no ticket ID.
  await run({ ...GOOD, email: "first@jane.com", tier: "connect", days: ["day2"], options: [], dietary: ["kosher"] });
  // Jane Doe #2 (or Jane, later) with the ticket, no token.
  const r = await run({ ...GOOD, email: "second@jane.com", ticketId: "abc123def", tier: "", days: ["day1"], options: ["cxo_d1"], dietary: ["vegan"] });
  assert.equal(r.body.updated, false);
  const [one, two] = store.rows;
  assert.deepEqual([one.key, one.email, one.days, one.dietary], ["n:jane doe", "first@jane.com", ["day2"], ["kosher"]]); // untouched
  assert.equal(one.duplicateOf, two._id); // out of the headcounts until staff decide
  assert.deepEqual([two.key, two.email, two.tierVerified], ["t:abc123def", "second@jane.com", true]);
  assert.equal(counted(store).total, 1);
});

test("submit: a ticket holder can't take over a namesake's RSVP by typing their first name", async () => {
  const { run, store } = submitter();
  await run({ ...GOOD, firstName: "Chris", lastName: "Golden", email: "chris@real.com", tier: "", days: ["day1", "day2"], options: ["gala", "lounge"] });
  // Bob Golden's own Connect ticket, with Chris's first name typed.
  const bad = await run({ ...GOOD, firstName: "Chris", lastName: "Golden", ticketId: "ccc333ddd444", tier: "connect", days: ["day1", "day2"], options: ["lounge", "meetings", "gala"] }, "8.8.8.8");
  assert.equal(bad.statusCode, 400); // his ticket's pass, not the speaker's
  const ok = await run({ ...GOOD, firstName: "Chris", lastName: "Golden", ticketId: "ccc333ddd444", tier: "connect", days: ["day1"], options: [] }, "8.8.8.8");
  assert.deepEqual([ok.statusCode, ok.body.kind, ok.body.tier, ok.body.updated], [201, "ticket", "connect", false]);
  const [chris, bob] = store.rows;
  assert.deepEqual([chris.key, chris.email, chris.tier, chris.options, chris.duplicateOf || ""], ["n:chris golden", "chris@real.com", "speaker", ["gala", "lounge"], ""]);
  assert.deepEqual([bob.key, bob.nameKey], ["t:ccc333ddd444", ""]);
  // ...and it doesn't shadow Chris's name either.
  assert.equal(counted(store).total, 2);
});

test("submit: bots never touch a real RSVP; honeypot and limits", async () => {
  const { run, store } = submitter();
  await run({ ...GOOD, tier: "connect", options: [] });
  const fast = await run({ ...GOOD, tier: "apex", options: ["lounge"], elapsedMs: 900 });
  assert.equal(fast.statusCode, 201);
  assert.equal(store.rows.length, 2);
  assert.equal(store.rows[0].tier, "connect"); // untouched
  assert.equal(store.rows[1].spam, true);
  assert.match(store.rows[1].spamReason, /too fast/);
  const random = await run({ ...GOOD, firstName: "sBjcqBNbVdtgTqNp", tier: "connect", options: [] });
  assert.equal(random.statusCode, 201);
  assert.equal(store.rows[2].spam, true);
  const hp = await run({ ...GOOD, _hp: "http://x" });
  assert.equal(hp.statusCode, 201);
  assert.equal(store.rows.length, 3);

  const many = submitter();
  let last;
  for (let i = 0; i < 9; i++) last = await many.run({ ...GOOD, tier: "connect", options: [] }, "10.0.0.1");
  assert.equal(last.statusCode, 429); // per address + name
  assert.equal(last.body.message, TOO_MANY);
  assert.match(TOO_MANY, /15 minutes/);
});

test("submit: nobody can use up a person's RSVP quota", async () => {
  const { run, store } = submitter();
  // Bot-speed submissions and rejected ones, from many addresses, in Chris Golden's name.
  for (let i = 0; i < 9; i++) await run({ ...GOOD, firstName: "Chris", lastName: "Golden", tier: "connect", days: ["day1"], options: [], elapsedMs: 10 }, `11.0.0.${i}`);
  for (let i = 0; i < 9; i++) {
    const r = await run({ ...GOOD, firstName: "Ada", lastName: "Lovelace", tier: "connect", days: ["day1"], options: ["cxo_d2"] }, `12.0.0.${i % 2}`);
    assert.equal(r.statusCode, 400);
  }
  for (const [first, last] of [["Chris", "Golden"], ["Ada", "Lovelace"]]) {
    const r = await run({ ...GOOD, firstName: first, lastName: last, tier: "connect", days: ["day1"], options: [] }, "13.0.0.1");
    assert.equal(r.statusCode, 201, first);
  }
  assert.equal(store.rows.filter((r) => !r.spam).length, 2);
});

test("submit: ticket ID + last name guesses share the per-ticket budget with lookups and the app sign-in", async () => {
  const guesses = makeGuessLimiter({ max: 5, windowMs: 60_000 });
  const { run, store, verifyCalls, h } = submitter({ ticketGuessLimiter: guesses });
  for (const [i, last] of ["Aa", "Bb", "Cc", "Dd"].entries()) {
    const r = await run({ ...GOOD, firstName: "X", lastName: last, ticketId: "abc123def", tier: "connect", options: [] }, `14.0.0.${i}`);
    assert.equal(r.statusCode, 201);
  }
  const res = fakeRes();
  await h.lookup({ body: { firstName: "X", lastName: "Ee", ticketId: "TECHFEST:ABC123DEF" }, ip: "15.0.0.1" }, res);
  assert.equal(res.body.kind, "none");
  // A sixth last name for this ticket, from a fresh address: refused before the ticket is checked.
  const sixth = await run({ ...GOOD, firstName: "Jane", lastName: "Doe", ticketId: "ABC123DEF", tier: "connect", options: [] }, "16.0.0.1");
  assert.equal(sixth.statusCode, 429);
  assert.equal(verifyCalls.length, 5);
  assert.ok(!store.rows.some((r) => r.tierVerified));
  // The same key the app sign-in uses (routes/ticketAuth.js).
  assert.equal(guesses.hit("t:abc123def", "Ff"), false);
  assert.equal(guesses.hit("t:abc123def", "aa"), true); // tried already: no new guess
});

test("submit: a save error is a friendly 500", async () => {
  const { lookup } = makeWorld();
  const h = makeRsvpHandlers({ lookup, log: { error() {} }, store: { findByKey: async () => null, findByNameKey: async () => [], insert: async () => { throw new Error("db down"); } } });
  const res = fakeRes();
  await h.submit({ body: { ...GOOD, tier: "connect", options: [] }, ip: "1.1.1.1", headers: {} }, res);
  assert.equal(res.statusCode, 500);
  assert.match(res.body.message, /enquire@thetechfestival\.com/);
});

test("options endpoint serves the shared config", () => {
  const h = makeRsvpHandlers({ lookup: async () => ({}), store: {} });
  const res = fakeRes();
  h.options({}, res);
  assert.deepEqual(res.body, rsvpOptionsPayload());
  assert.match(res.headers["Cache-Control"], /max-age/);
});

test("cached() loads once per TTL and retries failures", async () => {
  let t = 0, n = 0, fail = true;
  const get = cached(async () => { n += 1; if (fail) throw new Error("x"); return n; }, 1000, () => t);
  await assert.rejects(get());
  fail = false;
  assert.equal(await get(), 2);
  assert.equal(await get(), 2);
  t = 1001;
  assert.equal(await get(), 3);
});

/* ---------- admin console ---------- */
test("console filter: search, pass, day or experience, verified, possible duplicates", () => {
  const live = { spam: { $ne: true }, mergedInto: { $in: ["", null] } };
  assert.deepEqual(rsvpsFilter({}), live);
  assert.deepEqual(rsvpsFilter({ tier: "Apex", option: "gala", verified: "0" }), { ...live, tier: "apex", options: "gala", tierVerified: { $ne: true } });
  assert.deepEqual(rsvpsFilter({ option: "day2", tier: "bogus" }), { ...live, days: "day2" });
  assert.deepEqual(rsvpsFilter({ review: "1" }), { ...live, duplicateOf: { $nin: ["", null] } });
  const f = rsvpsFilter({ q: "Jane D(" });
  assert.equal(f.$or.length, 6);
  assert.ok(f.$or[0].name.test("jane d("));
});

test("headcounts per day, experience, dietary need and pass", () => {
  const s = summarizeRsvps([
    { tier: "apex", tierVerified: true, days: ["day1", "day2"], options: ["gala", "lounge", "lunch_d1"], dietary: ["vegan", "nut_allergy"] },
    { tier: "power", tierVerified: false, days: ["day1", "day2"], options: ["gala"], dietary: ["other"], dietaryOther: "No pork", name: "Sam Lee" },
    { tier: "speaker", tierVerified: false, days: ["day2"], options: [], dietary: [] },
    { tier: "apex", tierVerified: false, days: ["day1", "day2"], options: ["lounge", "meetings"], dietary: ["halal"], duplicateOf: "r1" }, // waits for staff
    { tier: "apex", days: ["day1"], options: ["lounge"], mergedInto: "r1" },
  ]);
  assert.equal(s.total, 3);
  assert.equal(s.duplicates, 1);
  assert.deepEqual(s.counts, { day1: 2, day2: 3, lunch_d1: 1, lunch_d2: 0, cxo_d1: 0, cxo_d2: 0, gala: 2, awards: 0, meetings: 0, lounge: 1 });
  assert.deepEqual(s.verifiedCounts, { day1: 1, day2: 1, lunch_d1: 1, lunch_d2: 0, cxo_d1: 0, cxo_d2: 0, gala: 1, awards: 0, meetings: 0, lounge: 1 });
  assert.equal(s.dietary.halal, 0);
  assert.equal(s.dietary.vegan, 1);
  assert.equal(s.dietary.other, 1);
  assert.deepEqual(s.dietaryNotes, [{ name: "Sam Lee", note: "No pork" }]);
  assert.deepEqual(s.tiers.apex, { total: 1, verified: 1 });
  assert.deepEqual(s.tiers.power, { total: 1, verified: 0 });
  assert.deepEqual(s.tiers.speaker, { total: 1, verified: 0 });
  assert.equal(s.unverified, 2);
});

test("staff merge a possible duplicate: its answers, the kept row's pass", () => {
  const keep = { tier: "power", tierVerified: true, email: "old@x.com", days: ["day1"], options: ["cxo_d1"] };
  const dup = { tier: "apex", days: ["day2", "day1"], options: ["gala", "lounge", "cxo_d2"], dietary: ["vegan"], dietaryOther: "", accessibility: "Ramp", email: "new@x.com" };
  assert.deepEqual(planRsvpMerge(keep, dup), {
    set: { days: ["day1", "day2"], options: ["cxo_d2", "gala"], dietary: ["vegan"], dietaryOther: "", accessibility: "Ramp", email: "new@x.com" },
    dropped: ["lounge"],
  });
  assert.equal("email" in planRsvpMerge(keep, { ...dup, email: "" }).set, false);
});

test("rows, detail and the CSV (formula-escaped, one column per option)", () => {
  const doc = {
    _id: "r1", firstName: "=cmd", lastName: "Doe", name: "=cmd Doe", email: "j@x.com", kind: "ticket", tier: "power",
    tierVerified: true, ticketId: "ABC", ticketVerified: true, days: ["day1"], options: ["gala"], dietary: ["other"],
    dietaryOther: "+no fish", accessibility: "Wheelchair, \"step-free\"", submissions: 2,
    createdAt: new Date("2026-10-11T10:00:00Z"), updatedAt: new Date("2026-10-12T10:00:00Z"), userAgent: "UA",
  };
  const row = rsvpRow(doc);
  assert.equal(row.tierLabel, "Power Pass");
  assert.equal(row.hasAccessibility, true);
  assert.equal(row.duplicateOf, "");
  assert.ok(!("accessibility" in row) && !("ticketId" in row));
  const det = rsvpDetail({ ...doc, editTokenHash: "secret" });
  assert.ok(!JSON.stringify(det).includes("secret"));
  assert.deepEqual(det.optionLabels, ["Gala Dinner & Networking Reception (Day 2 evening)"]);
  assert.deepEqual(det.dietaryLabels, ["Other"]);
  const csv = rsvpsCsv([doc]);
  assert.ok(csv.startsWith("﻿"));
  const [head, line] = csv.slice(1).split("\n");
  assert.equal(head.split(",").length, CSV_HEAD.length);
  assert.match(line, /^2026-10-12 10:00:00,'=cmd,Doe,j@x.com,Power Pass,Yes,Ticket holder,ABC,Yes,,/);
  assert.match(line, /'\+no fish/);
  assert.match(line, /"Wheelchair, ""step-free"""/);
  assert.match(line, /,Yes$/);
  assert.match(rsvpsCsv([{ ...doc, duplicateOf: "r9" }]), /,No: possible duplicate$/);
  assert.ok(CSV_HEAD.includes("Gala Dinner & Networking Reception (Day 2 evening)"));
  assert.equal(CSV_HEAD.at(-1), "In headcounts");
});

test("PASS_TIERS are what people can pick", () => {
  assert.deepEqual(PASS_TIERS, ["connect", "influence", "power", "apex"]);
});
