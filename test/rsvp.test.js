import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RSVP_OPTIONS, OPTION_KEYS, EXPERIENCE_KEYS, TIERS, PASS_TIERS, DAY_KEYS, DIETARY_KEYS, rsvpOptionsPayload,
  tierIncludes, allowedExperiences, checkOptions, tierFromTicketType, foldName, nameWords, fullNameMatches,
  personNameKey, matchSpeaker, parseSpeakers, makeSpeakerCache, buildHolderIndex, matchHolder, cleanLookup,
  validateRsvp, resolvePass, rsvpKeys, rsvpsFilter, summarizeRsvps, rsvpRow, rsvpDetail, rsvpsCsv, CSV_HEAD, optionLabel,
} from "../services/rsvp.js";
import { makeLookup, makeRsvpHandlers, publicLookup, cached, TOO_MANY } from "../services/rsvpHandler.js";
import { makeLimiter } from "../services/ticketAccess.js";

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

test("day-specific options belong to their day; the Gala isn't tied to one yet", () => {
  const day = Object.fromEntries(RSVP_OPTIONS.map((o) => [o.key, o.day]));
  assert.deepEqual(day, {
    day1: "day1", day2: "day2", lunch_d1: "day1", lunch_d2: "day2", cxo_d1: "day1", cxo_d2: "day2",
    gala: null, awards: "day1", meetings: null, lounge: null,
  });
  assert.match(RSVP_OPTIONS.find((o) => o.key === "lounge").label, /19\+/);
  assert.ok(RSVP_OPTIONS.find((o) => o.key === "lounge").note);
  assert.equal(optionLabel("lunch_d2"), "Networking Luncheon (Day 2)");
  assert.equal(optionLabel("awards"), "Catalyst Awards Night (Day 1 evening)");
});

test("what each pass can choose, by day", () => {
  assert.deepEqual(allowedExperiences("connect", ["day1", "day2"]), []);
  assert.deepEqual(allowedExperiences("influence", ["day2"]), ["lunch_d2"]);
  assert.deepEqual(allowedExperiences("power", ["day1"]), ["lunch_d1", "cxo_d1", "gala", "awards"]);
  assert.deepEqual(allowedExperiences("power", ["day2"]), ["lunch_d2", "cxo_d2", "gala"]);
  assert.deepEqual(allowedExperiences("apex", ["day1", "day2"]), EXPERIENCE_KEYS);
  assert.deepEqual(allowedExperiences("speaker", ["day1", "day2"]), EXPERIENCE_KEYS);
  assert.deepEqual(allowedExperiences("apex", []), ["gala", "meetings", "lounge"]);
  assert.deepEqual(allowedExperiences("bogus", ["day1"]), []);
});

test("checkOptions accepts what's included and rejects the rest", () => {
  assert.deepEqual(checkOptions("apex", ["day1"], ["lounge", "lunch_d1", "lounge", "day1"]), { ok: true, options: ["lunch_d1", "lounge"] });
  const r = checkOptions("power", ["day1"], ["gala", "lounge", "lunch_d2"]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.invalid, ["lounge", "lunch_d2"]);
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
  ];
  for (const [cand, f, l] of no) assert.equal(fullNameMatches(cand, f, l), false, `${JSON.stringify(cand)} !~ ${f} ${l}`);
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

const TICKETS = { // ticketId → { lastNames, type }
  abc123def: { ticketId: "ABC123DEF", type: "power", lastNames: ["Doe"] },
  spk999xyz: { ticketId: "SPK999XYZ", type: "connect", lastNames: ["Golden"] },
};
function makeWorld() {
  const verifyCalls = [];
  const lookup = makeLookup({
    verifyTicket: async (id, last) => {
      verifyCalls.push(id);
      const t = TICKETS[id];
      return t && t.lastNames.some((l) => l.toLowerCase() === last.toLowerCase()) ? { ticketId: t.ticketId, type: t.type } : null;
    },
    getHolders: async () => buildHolderIndex(USERS, GUESTS),
    getSpeakers: async () => ["Dr. Chris Golden", "Alán Aspuru-Guzik"],
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
});

test("lookup endpoint: honeypot, one-name requests, rate limits and no personal data", async () => {
  const { lookup, verifyCalls } = makeWorld();
  let calls = 0;
  const counting = async (q) => { calls += 1; return lookup(q); };
  const h = makeRsvpHandlers({
    lookup: counting, store: {}, log: { error() {} },
    lookupIpLimiter: makeLimiter({ max: 6, windowMs: 60_000 }),
    lookupNameLimiter: makeLimiter({ max: 2, windowMs: 60_000 }),
    lookupTicketLimiter: makeLimiter({ max: 1, windowMs: 60_000 }),
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
  const limited = await run({ firstName: "Jane", lastName: "Doe" }, "2.2.2.2"); // per name, across addresses
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.body.kind, "none");

  await run({ lastName: "Doe", ticketId: "abc123def" }, "3.3.3.3");
  assert.equal((await run({ lastName: "Doe", ticketId: "ABC123DEF" }, "4.4.4.4")).statusCode, 429); // per ticket
  assert.equal(verifyCalls.length, 1);

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

test("resolvePass: verified ticket > speaker > what they chose (unverified)", () => {
  assert.deepEqual(resolvePass({ kind: "ticket", tier: "connect", verified: true }, "apex"), { ok: true, tier: "connect", tierVerified: true, kind: "ticket" });
  assert.deepEqual(resolvePass({ kind: "speaker", tier: "speaker", verified: true }, "connect"), { ok: true, tier: "speaker", tierVerified: true, kind: "speaker" });
  assert.deepEqual(resolvePass({ kind: "ticket", tier: "power", verified: false }, "apex"), { ok: true, tier: "apex", tierVerified: false, kind: "ticket", detectedTier: "power" });
  assert.deepEqual(resolvePass({ kind: "none", verified: false }, "influence"), { ok: true, tier: "influence", tierVerified: false, kind: "none", detectedTier: "" });
  assert.equal(resolvePass({ kind: "none", verified: false }, "speaker").ok, false); // can't pick "speaker"
  assert.equal(resolvePass({ kind: "none", verified: false }, "").ok, false);
});

test("rsvpKeys: a verified ticket first, then the folded full name", () => {
  assert.deepEqual(rsvpKeys({ ticketId: "ABC123", ticketVerified: true, firstName: "José", lastName: "Núñez" }), ["t:abc123", "n:jose nunez"]);
  assert.deepEqual(rsvpKeys({ ticketId: "ABC123", ticketVerified: false, firstName: "Jose", lastName: "NUNEZ" }), ["n:jose nunez"]);
  assert.deepEqual(rsvpKeys({ firstName: "Dr. Jane", lastName: "Doe " }), ["n:jane doe"]);
});

/* ---------- submit + upsert ---------- */
function memoryStore() {
  const rows = [];
  let n = 0;
  return {
    rows,
    async findByKeys(keys) {
      for (const k of keys) { const hit = rows.find((r) => r.key === k && !r.spam); if (hit) return hit; }
      return null;
    },
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
  };
}

function submitter() {
  const { lookup } = makeWorld();
  const store = memoryStore();
  const h = makeRsvpHandlers({ lookup, store, log: { error() {} } });
  const run = async (body, ip = "5.5.5.5") => { const res = fakeRes(); await h.submit({ body, ip, headers: { "user-agent": "Test" } }, res); return res; };
  return { run, store };
}

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
  assert.deepEqual(store.rows[0].options, ["cxo_d1", "gala"]);
  assert.equal(store.rows[0].key, "t:abc123def");
  assert.equal(store.rows[0].ticketId, "ABC123DEF");
  assert.equal(store.rows[0].chosenTier, "apex");

  // Speakers get everything, whatever they picked.
  const r3 = await run({ ...GOOD, firstName: "Chris", lastName: "Golden", tier: "connect", options: ["lounge", "meetings", "awards"] });
  assert.deepEqual([r3.statusCode, r3.body.tier, r3.body.tierVerified], [201, "speaker", true]);

  // Nobody we know: their choice stands, unverified.
  const r4 = await run({ ...GOOD, firstName: "New", lastName: "Person", tier: "influence", options: ["lunch_d2"] });
  assert.deepEqual([r4.statusCode, r4.body.tier, r4.body.tierVerified, r4.body.kind], [201, "influence", false, "none"]);
  const r5 = await run({ ...GOOD, firstName: "Other", lastName: "Person", tier: "speaker", options: [] });
  assert.equal(r5.statusCode, 400);

  // One ticket holder by that name: kept as chosen, their ticket's pass noted for staff.
  await run({ ...GOOD, firstName: "Ana", lastName: "Nunez", tier: "apex", options: [] });
  const ana = store.rows.find((r) => r.lastName === "Nunez");
  assert.deepEqual([ana.tier, ana.tierVerified, ana.kind, ana.detectedTier], ["apex", false, "ticket", "power"]);
});

test("submit: one RSVP per person; re-submitting updates it", async () => {
  const { run, store } = submitter();
  await run({ ...GOOD, firstName: "Lee", lastName: "Park", tier: "connect", options: [], email: "lee@x.com" });
  await run({ ...GOOD, firstName: " LEE ", lastName: "park", tier: "influence", options: ["lunch_d1"], email: "" });
  assert.equal(store.rows.length, 1);
  assert.deepEqual([store.rows[0].tier, store.rows[0].submissions, store.rows[0].email], ["influence", 2, "lee@x.com"]);

  // Jane first without her ticket, then with it: the same row, now keyed by the ticket.
  await run({ ...GOOD, tier: "connect", options: [] });
  assert.equal(store.rows.length, 2);
  assert.equal(store.rows[1].key, "n:jane doe");
  const r = await run({ ...GOOD, ticketId: "TECHFEST:ABC123DEF", tier: "", options: ["gala"] });
  assert.equal(r.body.updated, true);
  assert.equal(store.rows.length, 2);
  assert.deepEqual([store.rows[1].key, store.rows[1].tier, store.rows[1].tierVerified], ["t:abc123def", "power", true]);

  // A wrong ticket ID isn't a key: it doesn't split one person into two rows.
  await run({ ...GOOD, firstName: "Lee", lastName: "Park", ticketId: "zzz999zzz", tier: "connect", options: [] });
  assert.equal(store.rows.length, 2);
  assert.equal(store.rows[0].ticketId, "zzz999zzz");
  assert.equal(store.rows[0].ticketVerified, false);
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
  for (let i = 0; i < 9; i++) last = await many.run({ ...GOOD, tier: "connect", options: [] }, `10.0.0.${i}`);
  assert.equal(last.statusCode, 429); // per name
  assert.equal(last.body.message, TOO_MANY);
});

test("submit: a save error is a friendly 500", async () => {
  const { lookup } = makeWorld();
  const h = makeRsvpHandlers({ lookup, log: { error() {} }, store: { findByKeys: async () => null, insert: async () => { throw new Error("db down"); } } });
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
test("console filter: search, pass, day or experience, verified", () => {
  assert.deepEqual(rsvpsFilter({}), { spam: { $ne: true } });
  assert.deepEqual(rsvpsFilter({ tier: "Apex", option: "gala", verified: "0" }), { spam: { $ne: true }, tier: "apex", options: "gala", tierVerified: { $ne: true } });
  assert.deepEqual(rsvpsFilter({ option: "day2", tier: "bogus" }), { spam: { $ne: true }, days: "day2" });
  const f = rsvpsFilter({ q: "Jane D(" });
  assert.equal(f.$or.length, 6);
  assert.ok(f.$or[0].name.test("jane d("));
});

test("headcounts per day, experience, dietary need and pass", () => {
  const s = summarizeRsvps([
    { tier: "apex", tierVerified: true, days: ["day1", "day2"], options: ["gala", "lounge", "lunch_d1"], dietary: ["vegan", "nut_allergy"] },
    { tier: "power", tierVerified: false, days: ["day1"], options: ["gala"], dietary: ["other"], dietaryOther: "No pork", name: "Sam Lee" },
    { tier: "speaker", tierVerified: true, days: ["day2"], options: [], dietary: [] },
  ]);
  assert.equal(s.total, 3);
  assert.deepEqual(s.counts, { day1: 2, day2: 2, lunch_d1: 1, lunch_d2: 0, cxo_d1: 0, cxo_d2: 0, gala: 2, awards: 0, meetings: 0, lounge: 1 });
  assert.equal(s.dietary.vegan, 1);
  assert.equal(s.dietary.other, 1);
  assert.deepEqual(s.dietaryNotes, [{ name: "Sam Lee", note: "No pork" }]);
  assert.deepEqual(s.tiers.apex, { total: 1, verified: 1 });
  assert.deepEqual(s.tiers.power, { total: 1, verified: 0 });
  assert.equal(s.unverified, 1);
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
  assert.ok(!("accessibility" in row) && !("ticketId" in row));
  const det = rsvpDetail(doc);
  assert.deepEqual(det.optionLabels, ["Gala Dinner & Networking Reception"]);
  assert.deepEqual(det.dietaryLabels, ["Other"]);
  const csv = rsvpsCsv([doc]);
  assert.ok(csv.startsWith("﻿"));
  const [head, line] = csv.slice(1).split("\n");
  assert.equal(head.split(",").length, CSV_HEAD.length);
  assert.match(line, /^2026-10-12 10:00:00,'=cmd,Doe,j@x.com,Power Pass,Yes,Ticket holder,ABC,Yes,,/);
  assert.match(line, /'\+no fish/);
  assert.match(line, /"Wheelchair, ""step-free"""/);
  assert.ok(CSV_HEAD.includes("Gala Dinner & Networking Reception"));
});

test("PASS_TIERS are what people can pick", () => {
  assert.deepEqual(PASS_TIERS, ["connect", "influence", "power", "apex"]);
});
