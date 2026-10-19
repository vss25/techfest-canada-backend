import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RSVP_OPTIONS, OPTION_KEYS, EXPERIENCE_KEYS, TIERS, PASS_TIERS, DAY_KEYS, DIETARY_KEYS, rsvpOptionsPayload,
  tierIncludes, allowedExperiences, checkOptions, tierFromTicketType, foldName, nameWords, fullNameMatches,
  personNameKey, matchSpeaker, parseSpeakers, makeSpeakerCache, buildHolderIndex, matchHolder, cleanLookup,
  validateRsvp, resolvePass, rsvpKeys, rsvpsFilter, summarizeRsvps, rsvpRow, rsvpDetail, rsvpsCsv, CSV_HEAD, optionLabel,
  nameVariants, ticketPersonNames, newEditToken, hashEditToken, planRsvpMerge, lastNameIs, rsvpListPayload,
} from "../services/rsvp.js";
import { buildRsvpEmail, parseRsvpAgenda, agendaTimes, clock12 } from "../services/rsvp.js";
import { makeLookup, makeRsvpHandlers, publicLookup, cached, TOO_MANY, resolveRsvpDuplicate } from "../services/rsvpHandler.js";
import { makeLimiter, makeGuessLimiter } from "../services/ticketAccess.js";

/* ---------- the matrix (must match the Tickets page) ---------- */
// Same table as src/pages/Tickets.jsx passFeatureMap, plus speakers (everything).
const ALL = ["connect", "influence", "power", "apex", "speaker"];
const EXPECTED = {
  day1: ALL,
  day2: ALL,
  // conference days, expo floor and networking breaks: every pass, asked first
  sessions_d1: ALL,
  sessions_d2: ALL,
  expo_d1: ALL,
  expo_d2: ALL,
  breaks_d1: ALL,
  breaks_d2: ALL,
  lunch_d1: ["influence", "power", "apex", "speaker"],
  lunch_d2: ["influence", "power", "apex", "speaker"],
  // Oct 19 2026: "There are only 4 passes." Apex and speakers only; Power no longer (per-pass switch: cxoBreakfast).
  cxo_d1: ["apex", "speaker"],
  cxo_d2: ["apex", "speaker"],
  gala: ["power", "apex", "speaker"],
  awards: ["power", "apex", "speaker"],
  meetings: ["apex"],
  lounge: ["apex"],
};

test("the option matrix matches the Tickets page", () => {
  assert.deepEqual([...OPTION_KEYS].sort(), Object.keys(EXPECTED).sort());
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
    day1: "day1", day2: "day2", sessions_d1: "day1", sessions_d2: "day2", expo_d1: "day1", expo_d2: "day2",
    breaks_d1: "day1", breaks_d2: "day2", lunch_d1: "day1", lunch_d2: "day2", cxo_d1: "day1", cxo_d2: "day2",
    gala: "day2", awards: "day1", meetings: null, lounge: null,
  });
  assert.equal(optionLabel("sessions_d1"), "Keynotes, panels & sessions (Day 1)");
  assert.equal(optionLabel("expo_d2"), "Expo Floor (Day 2)");
  assert.equal(optionLabel("breaks_d1"), "Networking Breaks & Coffee (Day 1)");
  assert.match(RSVP_OPTIONS.find((o) => o.key === "lounge").label, /19\+/);
  assert.ok(RSVP_OPTIONS.find((o) => o.key === "lounge").note);
  assert.equal(optionLabel("lunch_d2"), "Networking Luncheon (Day 2)");
  assert.equal(optionLabel("awards"), "Catalyst Awards Night (Day 1)");
  assert.equal(optionLabel("gala"), "Gala Dinner & Networking Reception (Day 2)");
});

const ON_THE_DAY = ["sessions_d1", "sessions_d2", "expo_d1", "expo_d2", "breaks_d1", "breaks_d2"];

test("what each pass can choose, by day: every pass is asked about the day itself first", () => {
  assert.deepEqual(EXPERIENCE_KEYS.slice(0, 6), ON_THE_DAY);
  assert.deepEqual(allowedExperiences("connect", ["day1", "day2"]), ON_THE_DAY);
  assert.deepEqual(allowedExperiences("connect", ["day2"]), ["sessions_d2", "expo_d2", "breaks_d2"]);
  assert.deepEqual(allowedExperiences("influence", ["day2"]), ["sessions_d2", "expo_d2", "breaks_d2", "lunch_d2"]);
  assert.deepEqual(allowedExperiences("power", ["day1"]), ["sessions_d1", "expo_d1", "breaks_d1", "lunch_d1", "awards"]);
  assert.deepEqual(allowedExperiences("power", ["day2"]), ["sessions_d2", "expo_d2", "breaks_d2", "lunch_d2", "gala"]);
  // The pass's "CxO Breakfast included" (staff's switch, or a speaker on any pass) decides the breakfasts.
  assert.deepEqual(allowedExperiences("power", ["day1"], { cxo: true }), ["sessions_d1", "expo_d1", "breaks_d1", "cxo_d1", "lunch_d1", "awards"]);
  assert.deepEqual(allowedExperiences("apex", ["day2"], { cxo: false }).includes("cxo_d2"), false);
  assert.deepEqual(allowedExperiences("connect", ["day2"], { cxo: true }), ["sessions_d2", "expo_d2", "breaks_d2", "cxo_d2"]);
  // A breakfast already on their RSVP stays offered whatever the pass says.
  assert.deepEqual(allowedExperiences("power", ["day2"], { extra: ["cxo_d2"] }), ["sessions_d2", "expo_d2", "breaks_d2", "cxo_d2", "lunch_d2", "gala"]);
  assert.deepEqual(allowedExperiences("apex", ["day2"], { cxo: false, extra: ["cxo_d2"] }).includes("cxo_d2"), true);
  assert.deepEqual(allowedExperiences("apex", ["day1", "day2"]), EXPERIENCE_KEYS);
  assert.deepEqual(allowedExperiences("speaker", ["day1", "day2"]), EXPERIENCE_KEYS.filter((k) => k !== "meetings" && k !== "lounge"));
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
  assert.deepEqual(checkOptions("connect", ["day1"], []), { ok: true, options: [] }); // nothing ticked: just the day
  assert.deepEqual(checkOptions("connect", ["day1"], ["breaks_d1", "sessions_d1"]), { ok: true, options: ["sessions_d1", "breaks_d1"] });
  assert.deepEqual(checkOptions("connect", ["day1"], ["expo_d2"]).invalid, ["expo_d2"]); // not coming on Day 2
  assert.equal(checkOptions("speaker", ["day2"], ON_THE_DAY.filter((k) => k.endsWith("d2"))).ok, true);
  assert.equal(checkOptions("apex", ["day1"], ["__proto__"]).ok, false);
});

test("the options payload is the shared config the website reads", () => {
  const p = rsvpOptionsPayload();
  assert.deepEqual(p.tiers.map((t) => t.key), TIERS);
  assert.equal(p.tiers.find((t) => t.key === "speaker").sold, false);
  assert.deepEqual(p.options.map((o) => o.key), OPTION_KEYS);
  assert.deepEqual(p.options.filter((o) => o.kind === "experience").slice(0, 6).map((o) => o.key), ON_THE_DAY);
  for (const k of ON_THE_DAY) assert.deepEqual(p.options.find((o) => o.key === k).tiers, TIERS, k);
  assert.deepEqual(p.options.find((o) => o.key === "expo_d1"), {
    key: "expo_d1", kind: "experience", day: "day1", label: "Expo Floor", description: "Exhibitors, product demos and partner stands.", tiers: TIERS,
  });
  assert.deepEqual(p.options.find((o) => o.key === "gala").tiers, ["power", "apex", "speaker"]);
  assert.deepEqual(p.dietary.map((d) => d.key), DIETARY_KEYS);
  assert.deepEqual(p.days.map((d) => d.date), ["2026-10-26", "2026-10-27"]);
  p.options[0].tiers.push("hacked"); // a copy, not the real list
  assert.equal(tierIncludes("hacked", "day1"), false);
});

/* ---------- ticket type → pass ---------- */
test("stored ticket types map to the four passes and the internal Speaker Pass; All Access is Power", () => {
  const cases = {
    connect: "connect", influence: "influence", power: "power", apex: "apex", vip: "apex", VIP: "apex",
    "Apex Pass": "apex", "TTFC Power Pass": "power", " Influence ": "influence", "TTFC 2026 Apex Pass": "apex",
    discover: "connect", early: "connect", festival: "connect", session: "connect", "": "connect", undefined: "connect",
    // Oct 19 2026: "All Access Pass = Power Pass only".
    "all-access": "power", "All Access Pass": "power", "TTFC All Access": "power",
    speaker: "speaker", "Speaker Pass": "speaker",
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
});

test("lastNameIs: the ticket holder's last name, whatever first name was typed", () => {
  for (const [cand, last] of [
    ["Christopher Golden", "Golden"], ["Dr. Chris A. Golden", "golden"], ["Baldeep Singh Pahwa", "Singh Pahwa"],
    ["Alán Aspuru-Guzik", "Aspuru Guzik"], [{ firstName: "Ann", lastName: "Lo" }, "LO"], [{ firstName: "", lastName: "Núñez" }, "Nunez"],
    ['Kulbir "Colin" Singh Dhillon', "Dhillon"], ["Jane Smith, PhD", "Smith"],
  ]) assert.equal(lastNameIs(cand, last), true, `${JSON.stringify(cand)} / ${last}`);
  for (const [cand, last] of [
    ["Christopher Golden", "Gold"], ["Christopher Golden", "Christopher"], ["Madonna", "Madonna"], [{ firstName: "Ann", lastName: "Lo" }, "Golden"],
    [null, "Golden"], ["Christopher Golden", "G"],
  ]) assert.equal(lastNameIs(cand, last), false, `${JSON.stringify(cand)} / ${last}`);
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
  // A speaker listed as "Dr. Chris Golden" whose ticket says Christopher.
  chr111ist222: { ticketId: "CHR111IST222", type: "connect", lastNames: ["Golden"], names: ["Christopher Golden"] },
  // Bought by a Golden for Ann Lo: the ticket check accepts the buyer's last name, but Ann holds it.
  buy111ann222: { ticketId: "BUY111ANN222", type: "influence", lastNames: ["Golden", "Lo"], names: [{ firstName: "Ann", lastName: "Lo" }] },
};
function makeWorld() {
  const verifyCalls = [];
  const lookup = makeLookup({ guessFromName: true,
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
  // A verified ticket also says whether its pass has the CxO Breakfasts (Power: no) and which ones they keep.
  assert.deepEqual(publicLookup(r1, { ticketId: "abc123def" }), {
    kind: "ticket", verified: true, tier: "power", tierLabel: "Power Pass", ticketMatched: true, cxoBreakfast: false, keepOptions: [],
    allowedOptions: allowedExperiences("power", DAY_KEYS),
  });
  const r2 = await lookup(cleanLookup({ firstName: "Jane", lastName: "Smith", ticketId: "abc123def" }));
  assert.equal(r2.kind, "none"); // wrong last name, and no Jane Smith holds a ticket
  assert.equal(publicLookup(r2, { ticketId: "abc123def" }).ticketMatched, false);
  const r3 = await lookup(cleanLookup({ firstName: "alan", lastName: "aspuru guzik" }));
  assert.deepEqual(publicLookup(r3), { kind: "speaker", verified: true, tier: "speaker", tierLabel: "Speaker Pass", displayName: "Alán Aspuru-Guzik", allowedOptions: allowedExperiences("speaker", DAY_KEYS) });
  // A speaker with a verified (complimentary Connect) ticket still sees everything.
  const r4 = await lookup(cleanLookup({ firstName: "Chris", lastName: "Golden", ticketId: "spk999xyz" }));
  assert.equal(r4.kind, "speaker");
  assert.equal(r4.ticket.ticketId, "SPK999XYZ");
  const r5 = await lookup(cleanLookup({ firstName: "Jane", lastName: "Doe" }));
  assert.deepEqual(publicLookup(r5), { kind: "ticket", verified: false, tier: "apex", tierLabel: "Apex Pass", displayName: "Jane", allowedOptions: EXPERIENCE_KEYS });
  const r6 = await lookup(cleanLookup({ firstName: "", lastName: "Doe" }));
  assert.equal(r6.kind, "none");
  const r7 = await lookup(cleanLookup({ firstName: "Sam", lastName: "Lee" }));
  assert.equal(r7.kind, "none");
  // The speaker is matched on the name typed: the ticket's holder has the same last name (it was
  // checked), so the speaker list decides, and resolvePass saves it unverified for staff to confirm.
  const r8 = await lookup(cleanLookup({ firstName: "Chris", lastName: "Golden", ticketId: "ccc333ddd444" }));
  assert.deepEqual([r8.kind, r8.tier, r8.verified, r8.ticket.holderMatch, r8.ticket.holderLastMatch], ["speaker", "speaker", true, false, true]);
  assert.equal(r4.ticket.holderMatch, true);
  const r9 = await lookup(cleanLookup({ firstName: "Alex", lastName: "Pu" }));
  assert.equal(r9.kind, "speaker");
});

test("lookup: a speaker whose ticket has another form of their first name is still a speaker", async () => {
  const { lookup } = makeWorld();
  // Ticket "Christopher Golden", speaker list "Dr. Chris Golden", typed "Chris" + the ticket ID.
  const r = await lookup(cleanLookup({ firstName: "Chris", lastName: "Golden", ticketId: "TECHFEST:CHR111IST222" }));
  assert.deepEqual([r.kind, r.tier, r.verified, r.displayName], ["speaker", "speaker", true, "Dr. Chris Golden"]);
  assert.deepEqual([r.ticket.ticketId, r.ticket.holderMatch, r.ticket.holderLastMatch], ["CHR111IST222", false, true]);
  assert.deepEqual(publicLookup(r, { ticketId: "chr111ist222" }),
    { kind: "speaker", verified: true, tier: "speaker", tierLabel: "Speaker Pass", displayName: "Dr. Chris Golden", ticketMatched: true, cxoBreakfast: true, keepOptions: [],
      allowedOptions: allowedExperiences("speaker", DAY_KEYS) });
  // The full ticket name isn't on the speaker list: the ticket's pass.
  const full = await lookup(cleanLookup({ firstName: "Christopher", lastName: "Golden", ticketId: "chr111ist222" }));
  assert.deepEqual([full.kind, full.tier, full.verified], ["ticket", "connect", true]);
  // A ticket held by someone with another last name (it verified on the buyer's): never the speaker's.
  const other = await lookup(cleanLookup({ firstName: "Chris", lastName: "Golden", ticketId: "buy111ann222" }));
  assert.deepEqual([other.kind, other.tier, other.verified, other.ticket.holderLastMatch], ["ticket", "influence", true, false]);
  // No ticket: the name alone, as before.
  assert.equal((await lookup(cleanLookup({ firstName: "Chris", lastName: "Golden" }))).kind, "speaker");
  // A ticket ID that doesn't check out is no ticket at all.
  assert.equal((await lookup(cleanLookup({ firstName: "Chris", lastName: "Golden", ticketId: "nope00nope00" }))).kind, "speaker");
});

test("lookup endpoint: honeypot, one-name requests, rate limits and no personal data", async () => {
  const { lookup, verifyCalls } = makeWorld();
  let calls = 0;
  const counting = async (q) => { calls += 1; return lookup(q); };
  const h = makeRsvpHandlers({
    requireTicket: false,
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
    async findByEditToken(hash) { return (hash && rows.find((r) => r.editTokenHash === hash && live(r))) || null; },
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
    // What routes/console.js gives resolveRsvpDuplicate.
    resolver: {
      async findLive(id) { return rows.find((r) => r._id === String(id) && live(r)) || null; },
      async update(id, set, inc = {}) {
        const d = rows.find((r) => r._id === String(id));
        Object.assign(d, set, { updatedAt: new Date(Date.now() + 1) });
        for (const [k, v] of Object.entries(inc)) d[k] = (d[k] || 0) + v;
        return d;
      },
      async repoint(fromId, toId) { for (const r of rows) if (r.duplicateOf === fromId && live(r)) r.duplicateOf = toId; },
    },
  };
}

function submitter(opts = {}) {
  const world = makeWorld();
  const store = memoryStore();
  const h = makeRsvpHandlers({ requireTicket: false, lookup: world.lookup, store, log: { error() {} }, ticketGuessLimiter: makeGuessLimiter({ max: 5, windowMs: 60_000 }), ...opts });
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

  // Power no longer includes the CxO Breakfasts (Oct 19 2026).
  const noCxo = await run({ ...GOOD, ticketId: "abc123def", tier: "power", options: ["gala", "cxo_d1"] });
  assert.deepEqual([noCxo.statusCode, noCxo.body.invalid], [400, ["cxo_d1"]]);
  const r2 = await run({ ...GOOD, ticketId: "abc123def", tier: "apex", options: ["gala", "lunch_d1"] });
  assert.equal(r2.statusCode, 201);
  assert.deepEqual([r2.body.tier, r2.body.tierVerified, r2.body.kind, r2.body.updated], ["power", true, "ticket", false]);
  assert.ok(!("id" in r2.body)); // no row id goes out
  assert.equal(typeof r2.body.editToken, "string");
  assert.deepEqual(store.rows[0].options, ["lunch_d1", "gala"]);
  assert.equal(store.rows[0].key, "t:abc123def");
  assert.equal(store.rows[0].ticketId, "ABC123DEF");
  assert.equal(store.rows[0].chosenTier, "apex");
  assert.equal(store.rows[0].editTokenHash, hashEditToken(r2.body.editToken));

  // Speakers get everything, whatever they picked, but a name on the public list is no proof.
  const r3 = await run({ ...GOOD, firstName: "Chris", lastName: "Golden", tier: "connect", options: ["cxo_d1", "cxo_d2", "awards"] });
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
  const r = await run({ ...GOOD, firstName: "Michael", lastName: "Chen", ticketId: "eee555fff666", tier: "connect", days: ["day1"], options: ["cxo_d1", "awards"] });
  assert.deepEqual([r.statusCode, r.body.tier, r.body.tierVerified, r.body.kind], [201, "speaker", false, "speaker"]);
  const row = store.rows[0];
  assert.deepEqual([row.key, row.ticketVerified, row.detectedTier, row.matchedSpeaker], ["t:eee555fff666", true, "connect", "Michael J. Chen"]);
  assert.equal(summarizeRsvps(store.rows).verifiedCounts.awards, 0); // not in the verified headcounts
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
    [["day1", "day2"], ["lunch_d1", "awards", "gala"], ["nut_allergy"], "Wheelchair, step-free", "chris@real.com", 1]);
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
  const first = await run({ ...GOOD, ticketId: "abc123def", tier: "power", days: ["day1"], options: ["awards"], dietary: ["vegan"] });
  assert.equal(store.rows[0].key, "t:abc123def");
  // Another device, no ticket ID: kept apart, not counted.
  const again = await run({ ...GOOD, ticketId: "", tier: "power", days: ["day1"], options: ["awards"], dietary: ["halal"] });
  assert.equal(again.body.updated, false);
  assert.equal(store.rows.length, 2);
  assert.equal(store.rows[1].duplicateOf, store.rows[0]._id);
  let s = counted(store);
  assert.deepEqual([s.total, s.counts.day1, s.counts.awards, s.dietary.vegan, s.dietary.halal, s.tiers.power.total], [1, 1, 1, 1, 0, 1]);

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
  const proven = await run({ ...GOOD, ticketId: "abc123def", tier: "", days: ["day1"], options: ["awards"], editToken: mine.body.editToken }, "9.9.9.9");
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
  const r = await run({ ...GOOD, email: "second@jane.com", ticketId: "abc123def", tier: "", days: ["day1"], options: ["awards"], dietary: ["vegan"] });
  assert.equal(r.body.updated, false);
  const [one, two] = store.rows;
  assert.deepEqual([one.key, one.email, one.days, one.dietary], ["n:jane doe", "first@jane.com", ["day2"], ["kosher"]]); // untouched
  assert.equal(one.duplicateOf, two._id); // out of the headcounts until staff decide
  assert.deepEqual([two.key, two.email, two.tierVerified], ["t:abc123def", "second@jane.com", true]);
  assert.equal(counted(store).total, 1);
});

test("submit: a ticket holder can't take over a namesake's RSVP by typing their first name", async () => {
  const { run, store } = submitter();
  await run({ ...GOOD, firstName: "Chris", lastName: "Golden", email: "chris@real.com", tier: "", days: ["day1", "day2"], options: ["gala", "cxo_d1"] });
  // Bob Golden's own Connect ticket, with Chris's first name typed: a speaker by the name typed (as with
  // no ticket at all), unverified for staff to confirm, in a row of its own.
  const first = await run({ ...GOOD, firstName: "Chris", lastName: "Golden", ticketId: "ccc333ddd444", tier: "connect", days: ["day1", "day2"], options: ["cxo_d2"] }, "8.8.8.8");
  assert.deepEqual([first.statusCode, first.body.kind, first.body.tierVerified, first.body.updated], [201, "speaker", false, false]);
  const again = await run({ ...GOOD, firstName: "Chris", lastName: "Golden", ticketId: "ccc333ddd444", tier: "connect", days: ["day1"], options: [] }, "8.8.8.8");
  assert.deepEqual([again.statusCode, again.body.updated], [201, true]); // his own ticket's row
  const [chris, bob] = store.rows;
  assert.equal(store.rows.length, 2);
  assert.deepEqual([chris.key, chris.email, chris.tier, chris.options, chris.days, chris.duplicateOf || "", chris.submissions],
    ["n:chris golden", "chris@real.com", "speaker", ["cxo_d1", "gala"], ["day1", "day2"], "", 1]);
  assert.deepEqual([bob.key, bob.nameKey, bob.detectedTier, bob.tierVerified], ["t:ccc333ddd444", "", "connect", false]);
  // ...and it doesn't shadow Chris's name either.
  assert.equal(counted(store).total, 2);
  // Nor can Bob's browser token move Chris's RSVP: it only reaches Bob's own row (its ticket's pass kept).
  const token = await run({ ...GOOD, firstName: "Chris", lastName: "Golden", tier: "connect", days: ["day2"], options: [], editToken: again.body.editToken }, "8.8.8.8");
  assert.equal(token.body.updated, true);
  assert.equal(store.rows.length, 2);
  assert.deepEqual([chris.days, chris.submissions], [["day1", "day2"], 1]);
  assert.deepEqual([bob.key, bob.days, bob.tier, bob.detectedTier], ["t:ccc333ddd444", ["day2"], "speaker", "connect"]);
});

test("submit: a speaker whose ticket says Christopher, typing Chris and the ticket ID, gets every option", async () => {
  const { run, store } = submitter();
  const all = ["sessions_d1", "expo_d1", "breaks_d1", "cxo_d1", "lunch_d1", "awards"];
  const r = await run({ ...GOOD, firstName: "Chris", lastName: "Golden", ticketId: "TECHFEST:CHR111IST222", tier: "connect", days: ["day1"], options: all });
  assert.deepEqual([r.statusCode, r.body.kind, r.body.tier, r.body.tierVerified], [201, "speaker", "speaker", false]);
  const row = store.rows[0];
  assert.deepEqual([row.key, row.ticketVerified, row.detectedTier, row.matchedSpeaker, row.options], ["t:chr111ist222", true, "connect", "Dr. Chris Golden", all]);
  // Typed with the ticket's full name instead: the ticket's own (Connect) pass, the same row.
  const full = await run({ ...GOOD, firstName: "Christopher", lastName: "Golden", ticketId: "chr111ist222", tier: "connect", days: ["day1"], options: ["lounge"] });
  assert.deepEqual([full.statusCode, full.body.invalid], [400, ["lounge"]]);
});

test("submit: a nickname typed over your own ticket keeps the name the RSVP is known by", async () => {
  const { run, store } = submitter();
  await run({ ...GOOD, firstName: "Christopher", lastName: "Golden", ticketId: "chr111ist222", tier: "", days: ["day1"], options: ["expo_d1"] });
  const row = store.rows[0];
  assert.deepEqual([row.key, row.nameKey], ["t:chr111ist222", "christopher golden"]);
  // Later, as "Chris" with the same ticket (no token): the ticket proves it is theirs.
  const nick = await run({ ...GOOD, firstName: "Chris", lastName: "Golden", ticketId: "chr111ist222", tier: "", days: ["day1", "day2"], options: ["gala"] }, "9.9.9.9");
  assert.deepEqual([nick.body.updated, nick.body.tier], [true, "speaker"]);
  assert.equal(store.rows.length, 1);
  assert.deepEqual([row.nameKey, row.firstName, row.days, row.options], ["christopher golden", "Chris", ["day1", "day2"], ["gala"]]);
  // ...so a name-only RSVP as Christopher still finds it and waits for staff instead of being counted twice.
  await run({ ...GOOD, firstName: "Christopher", lastName: "Golden", tier: "connect", days: ["day2"], options: [] }, "10.1.1.1");
  assert.equal(store.rows[1].duplicateOf, row._id);
  assert.equal(counted(store).total, 1);
});

test("submit: with its edit token a name-only RSVP changes in place; without it, never someone else's", async () => {
  const { run, store } = submitter();
  const first = await run({ ...GOOD, firstName: "Ada", lastName: "Lovelace", email: "ada@x.com", tier: "influence", days: ["day1"], options: ["lunch_d1"] });
  const [ada] = store.rows;
  // No token: a row of its own, Ada's untouched.
  const stranger = await run({ ...GOOD, firstName: "Ada", lastName: "Lovelace", email: "x@evil.example", tier: "connect", days: ["day2"], options: [] }, "6.6.6.6");
  assert.equal(stranger.body.updated, false);
  assert.deepEqual([ada.days, ada.options, ada.email, ada.submissions], [["day1"], ["lunch_d1"], "ada@x.com", 1]);
  assert.equal(store.rows[1].duplicateOf, ada._id);
  // A malformed or unknown token is no proof either.
  for (const editToken of ["short", newEditToken()]) {
    const r = await run({ ...GOOD, firstName: "Ada", lastName: "Lovelace", tier: "connect", days: ["day2"], options: [], editToken }, "6.6.6.7");
    assert.equal(r.body.updated, false);
  }
  assert.deepEqual([ada.days, ada.submissions], [["day1"], 1]);
  // Her token: the same row, whatever she ticks now (nothing at all is fine: just the days).
  const mine = await run({ ...GOOD, firstName: "ada", lastName: "LOVELACE", email: "", tier: "influence", days: ["day1", "day2"], options: [], editToken: first.body.editToken });
  assert.deepEqual([mine.body.updated, mine.body.editToken], [true, first.body.editToken]);
  assert.deepEqual([ada.days, ada.options, ada.email, ada.submissions, ada.duplicateOf || ""], [["day1", "day2"], [], "ada@x.com", 2, ""]);
  assert.equal(store.rows.filter((r) => !r.duplicateOf).length, 1);
});

test("submit: a speaker's name-only RSVP, later proven by a ticket in another form of their name, stays one RSVP", async () => {
  const { run, store } = submitter();
  const first = await run({ ...GOOD, firstName: "Chris", lastName: "Golden", tier: "", days: ["day1"], options: ["awards"] });
  const [row] = store.rows;
  assert.deepEqual([row.key, row.nameKey], ["n:chris golden", "chris golden"]);
  // His ticket says Christopher: the token proves the RSVP is his, the ticket now keys it.
  const proven = await run({ ...GOOD, firstName: "Chris", lastName: "Golden", ticketId: "chr111ist222", tier: "", days: ["day1"], options: ["awards", "cxo_d1"], editToken: first.body.editToken });
  assert.deepEqual([proven.body.updated, proven.body.tier, proven.body.tierVerified], [true, "speaker", false]);
  assert.equal(store.rows.length, 1);
  assert.deepEqual([row.key, row.nameKey, row.ticketVerified, row.options], ["t:chr111ist222", "chris golden", true, ["cxo_d1", "awards"]]);
  // Then from the same browser without the ticket ID: still that row (a token saved under the ticket works too).
  const again = await run({ ...GOOD, firstName: "Chris", lastName: "Golden", tier: "", days: ["day2"], options: ["gala"], editToken: proven.body.editToken });
  assert.deepEqual([again.body.updated, store.rows.length, row.days, row.key], [true, 1, ["day2"], "t:chr111ist222"]);

  // First saved under the nickname WITH the ticket (no name key yet), then changed by name with the token.
  const s2 = submitter();
  const t = await s2.run({ ...GOOD, firstName: "Chris", lastName: "Golden", ticketId: "chr111ist222", tier: "", days: ["day1"], options: [] });
  assert.equal(s2.store.rows[0].nameKey, "");
  const byName = await s2.run({ ...GOOD, firstName: "Chris", lastName: "Golden", tier: "", days: ["day2"], options: ["expo_d2"], editToken: t.body.editToken });
  assert.deepEqual([byName.body.updated, s2.store.rows.length], [true, 1]);
  assert.deepEqual([s2.store.rows[0].key, s2.store.rows[0].days, s2.store.rows[0].nameKey], ["t:chr111ist222", ["day2"], "chris golden"]);
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
  const h = makeRsvpHandlers({ requireTicket: false, lookup, log: { error() {} }, store: { findByKey: async () => null, findByNameKey: async () => [], insert: async () => { throw new Error("db down"); } } });
  const res = fakeRes();
  await h.submit({ body: { ...GOOD, tier: "connect", options: [] }, ip: "1.1.1.1", headers: {} }, res);
  assert.equal(res.statusCode, 500);
  assert.match(res.body.message, /enquire@thetechfestival\.com/);
});

test("options endpoint serves the shared config", async () => {
  const h = makeRsvpHandlers({ lookup: async () => ({}), store: {} });
  const res = fakeRes();
  await h.options({}, res);
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
    { tier: "apex", tierVerified: true, days: ["day1", "day2"], options: ["sessions_d1", "gala", "lounge", "lunch_d1"], dietary: ["vegan", "nut_allergy"] },
    { tier: "power", tierVerified: false, days: ["day1", "day2"], options: ["sessions_d1", "expo_d2", "gala"], dietary: ["other"], dietaryOther: "No pork", name: "Sam Lee" },
    { tier: "speaker", tierVerified: false, days: ["day2"], options: [], dietary: [] },
    { tier: "apex", tierVerified: false, days: ["day1", "day2"], options: ["lounge", "meetings"], dietary: ["halal"], duplicateOf: "r1" }, // waits for staff
    { tier: "apex", days: ["day1"], options: ["lounge"], mergedInto: "r1" },
  ]);
  assert.equal(s.total, 3);
  assert.equal(s.duplicates, 1);
  const none = { sessions_d1: 0, sessions_d2: 0, expo_d1: 0, expo_d2: 0, breaks_d1: 0, breaks_d2: 0 };
  assert.deepEqual(s.counts, { day1: 2, day2: 3, ...none, sessions_d1: 2, expo_d2: 1, lunch_d1: 1, lunch_d2: 0, cxo_d1: 0, cxo_d2: 0, gala: 2, awards: 0, meetings: 0, lounge: 1 });
  assert.deepEqual(s.verifiedCounts, { day1: 1, day2: 1, ...none, sessions_d1: 1, lunch_d1: 1, lunch_d2: 0, cxo_d1: 0, cxo_d2: 0, gala: 1, awards: 0, meetings: 0, lounge: 1 });
  assert.deepEqual(Object.keys(s.counts), OPTION_KEYS); // the days, then the day itself, then the rest
  assert.equal(s.dietary.halal, 0);
  assert.equal(s.dietary.vegan, 1);
  assert.equal(s.dietary.other, 1);
  assert.deepEqual(s.dietaryNotes, [{ name: "Sam Lee", note: "No pork" }]);
  assert.deepEqual(s.tiers.apex, { total: 1, verified: 1 });
  assert.deepEqual(s.tiers.power, { total: 1, verified: 0 });
  assert.deepEqual(s.tiers.speaker, { total: 1, verified: 0 });
  assert.equal(s.unverified, 2);
});

const at = (iso) => new Date(`2026-10-${iso}Z`);
const tick = () => new Promise((ok) => setTimeout(ok, 5)); // the fake store stamps rows with the clock

test("staff merge: a newer possible duplicate's answers, the verified row's pass", () => {
  const keep = { _id: "k", tier: "power", tierVerified: true, ticketVerified: true, key: "t:abc", email: "old@x.com", days: ["day1"], options: ["cxo_d1"],
    editTokenHash: "keephash", submissions: 2, createdAt: at("10T10:00:00"), updatedAt: at("10T10:00:00") };
  const dup = { _id: "d", tier: "apex", days: ["day2", "day1"], options: ["sessions_d2", "gala", "lounge", "cxo_d2"], dietary: ["vegan"], dietaryOther: "",
    accessibility: "Ramp", email: "new@x.com", editTokenHash: "duphash", duplicateOf: "k", createdAt: at("11T10:00:00"), updatedAt: at("11T10:00:00") };
  const plan = planRsvpMerge(keep, dup);
  assert.deepEqual([plan.survivor._id, plan.retired._id, plan.newer._id], ["k", "d", "d"]);
  assert.deepEqual(plan.set, {
    days: ["day1", "day2"], options: ["sessions_d2", "cxo_d2", "gala"], dietary: ["vegan"], dietaryOther: "", accessibility: "Ramp", email: "new@x.com",
    editTokenHash: "duphash", // the browser that sent the answers kept can go on changing them
  });
  assert.deepEqual(plan.dropped, ["lounge"]); // not in the verified Power pass
  assert.deepEqual(plan.inc, { submissions: 1 });
  assert.equal(planRsvpMerge(keep, { ...dup, email: "" }).set.email, "old@x.com"); // a newer RSVP without an email keeps the old one
});

test("staff merge never rolls answers back: an older possible duplicate changes nothing it shouldn't", () => {
  // Jane's name-only RSVP (Monday), then her ticket-verified one (Tuesday) flagged it as its duplicate.
  const nameOnly = { _id: "n", key: "n:jane doe", tier: "connect", tierVerified: false, days: ["day2"], options: ["expo_d2"], dietary: ["kosher"],
    email: "jane@home.com", accessibility: "", editTokenHash: "phone", duplicateOf: "t", createdAt: at("12T09:00:00"), updatedAt: at("12T09:00:00") };
  const verified = { _id: "t", key: "t:abc123def", tier: "power", tierVerified: true, ticketVerified: true, kind: "ticket", days: ["day1", "day2"],
    options: ["sessions_d1", "gala"], dietary: ["vegan"], email: "", accessibility: "Ramp", editTokenHash: "laptop",
    createdAt: at("13T09:00:00"), updatedAt: at("13T09:00:00") };
  const plan = planRsvpMerge(verified, nameOnly);
  assert.deepEqual([plan.survivor._id, plan.retired._id, plan.newer._id], ["t", "n", "t"]);
  assert.deepEqual(plan.set, {
    days: ["day1", "day2"], options: ["sessions_d1", "gala"], dietary: ["vegan"], dietaryOther: "", accessibility: "Ramp",
    email: "jane@home.com", // filled in from the older RSVP: the newer one had none
  });
  assert.deepEqual(plan.dropped, []);

  // The other way round (the verified row is the possible duplicate): it stays, with its key and pass.
  const flipped = planRsvpMerge({ ...nameOnly, duplicateOf: "" }, { ...verified, duplicateOf: "n" });
  assert.deepEqual([flipped.survivor._id, flipped.retired._id], ["t", "n"]);
  assert.equal(flipped.set.duplicateOf, ""); // the verified row is the RSVP now
  assert.deepEqual(flipped.set.options, ["sessions_d1", "gala"]);
  assert.ok(!("tier" in flipped.set) && !("key" in flipped.set)); // its own pass and key

  // ...and if the name-only row was changed after the verified one, its answers win, checked against the verified pass.
  const later = planRsvpMerge(verified, { ...nameOnly, options: ["expo_d2", "lounge"], updatedAt: at("14T09:00:00") });
  assert.deepEqual([later.survivor._id, later.newer._id, later.set.days, later.set.options, later.dropped], ["t", "n", ["day2"], ["expo_d2"], ["lounge"]]);
  assert.equal(later.set.editTokenHash, "phone");
});

test("staff merge of two unverified RSVPs: the newer answers and the pass they were saved with", () => {
  const first = { _id: "a", key: "n:sam ray", kind: "none", tier: "connect", chosenTier: "connect", tierVerified: false, days: ["day1"], options: [],
    dietary: ["vegan"], email: "sam@x.com", ticketId: "", createdAt: at("10T10:00:00"), updatedAt: at("10T10:00:00") };
  const second = { _id: "b", key: "dup:1", kind: "ticket", tier: "power", chosenTier: "power", detectedTier: "power", tierVerified: false,
    days: ["day2"], options: ["lunch_d2", "gala"], dietary: ["halal"], ticketId: "typo123", duplicateOf: "a", createdAt: at("11T10:00:00"), updatedAt: at("11T10:00:00") };
  const plan = planRsvpMerge(first, second);
  assert.deepEqual([plan.survivor._id, plan.newer._id], ["a", "b"]);
  assert.deepEqual(plan.set, {
    days: ["day2"], options: ["lunch_d2", "gala"], dietary: ["halal"], dietaryOther: "", accessibility: "", email: "sam@x.com",
    kind: "ticket", tier: "power", tierVerified: false, chosenTier: "power", detectedTier: "power", matchedSpeaker: "", ticketId: "typo123", ticketVerified: false,
  });
  // The first one was changed after the second was saved: its answers (and pass) stay.
  const back = planRsvpMerge({ ...first, updatedAt: at("12T10:00:00") }, second);
  assert.deepEqual([back.newer._id, back.set.days, back.set.options, back.set.dietary, "tier" in back.set], ["a", ["day1"], [], ["vegan"], false]);
  // Same last change: the later-created row's; no times at all: nothing moves (the survivor's own answers).
  assert.equal(planRsvpMerge({ ...first, updatedAt: second.updatedAt }, { ...second, createdAt: at("09T10:00:00") }).newer._id, "a");
  const none = planRsvpMerge({ ...first, createdAt: null, updatedAt: null }, { ...second, createdAt: null, updatedAt: null });
  assert.deepEqual([none.newer._id, none.set.days, "tier" in none.set], ["a", ["day1"], false]);
});

test("staff resolve: merging keeps the verified row and the newer answers", async () => {
  const { run, store } = submitter();
  // Jane by name on her phone, then with her ticket on her laptop: the name-only row is flagged.
  await run({ ...GOOD, email: "jane@phone.com", tier: "connect", days: ["day2"], options: [], dietary: ["kosher"] });
  await tick();
  const laptop = await run({ ...GOOD, email: "", ticketId: "abc123def", tier: "", days: ["day1", "day2"], options: ["sessions_d1", "gala"], dietary: ["vegan"] }, "9.9.9.9");
  const [phone, verified] = store.rows;
  assert.equal(phone.duplicateOf, verified._id);
  const r = await resolveRsvpDuplicate(store.resolver, phone._id, "merge", { name: "Staff One" });
  assert.equal(r.row, verified);
  assert.deepEqual([verified.key, verified.tier, verified.tierVerified, verified.days, verified.options, verified.dietary, verified.email],
    ["t:abc123def", "power", true, ["day1", "day2"], ["sessions_d1", "gala"], ["vegan"], "jane@phone.com"]);
  assert.equal(verified.submissions, 2);
  assert.deepEqual([phone.mergedInto, phone.key], [verified._id, `merged:${phone._id}`]);
  assert.equal(r.audit.action, "rsvp_merge");
  assert.equal(r.audit.targetId, verified._id);
  const s = counted(store);
  assert.deepEqual([s.total, s.duplicates, s.counts.gala, s.dietary.kosher], [1, 0, 1, 0]);
  // Her laptop's token still changes it; the phone's row is gone from the list, so its token doesn't.
  const more = await run({ ...GOOD, ticketId: "", tier: "power", days: ["day1"], options: ["awards"], editToken: laptop.body.editToken }, "9.9.9.9");
  assert.deepEqual([more.body.updated, verified.options], [true, ["awards"]]);
});

test("staff resolve: a merge picks the newer answers whichever row they are on, and repoints other duplicates", async () => {
  const { run, store } = submitter();
  const a = await run({ ...GOOD, firstName: "Sam", lastName: "Ray", tier: "connect", days: ["day1"], options: [], dietary: ["vegan"] });
  await run({ ...GOOD, firstName: "Sam", lastName: "Ray", tier: "influence", days: ["day2"], options: ["lunch_d2"], dietary: ["halal"] }, "7.7.7.7");
  await run({ ...GOOD, firstName: "Sam", lastName: "Ray", tier: "connect", days: ["day2"], options: [], dietary: ["none"] }, "7.7.7.8");
  const [one, two, three] = store.rows;
  assert.deepEqual([two.duplicateOf, three.duplicateOf], [one._id, one._id]);
  // Sam #1 changes their RSVP afterwards with their token: theirs are now the newer answers.
  await tick();
  await run({ ...GOOD, firstName: "Sam", lastName: "Ray", tier: "power", days: ["day1"], options: ["awards"], dietary: ["vegan"], editToken: a.body.editToken });
  const r = await resolveRsvpDuplicate(store.resolver, two._id, "merge");
  assert.deepEqual(r.dropped, []);
  assert.deepEqual([one.tier, one.days, one.options, one.dietary], ["power", ["day1"], ["awards"], ["vegan"]]); // not rolled back
  assert.equal(two.mergedInto, one._id);
  assert.equal(three.duplicateOf, one._id);

  // A possible duplicate that is the verified one stays, and the others now point at it.
  const t = submitter();
  await t.run({ ...GOOD, tier: "connect", days: ["day2"], options: [] });
  await t.run({ ...GOOD, tier: "connect", days: ["day1"], options: [] }, "8.8.8.1");
  const [n1, d1] = t.store.rows;
  Object.assign(d1, { key: "t:abc123def", ticketVerified: true, tierVerified: true, kind: "ticket", tier: "power" }); // as if proven
  const flip = await resolveRsvpDuplicate(t.store.resolver, d1._id, "merge");
  assert.equal(flip.row, d1);
  assert.deepEqual([d1.duplicateOf, d1.key, d1.tier, n1.mergedInto], ["", "t:abc123def", "power", d1._id]);
  assert.equal(counted(t.store).total, 1);
});

test("staff resolve: kept separate sticks when the namesake saves again with their ticket", async () => {
  const { run, store } = submitter();
  await run({ ...GOOD, firstName: "Jane", lastName: "Doe", email: "other.jane@x.com", tier: "connect", days: ["day2"], options: ["expo_d2"] });
  const real = await run({ ...GOOD, ticketId: "abc123def", tier: "", days: ["day1"], options: [] }, "9.9.9.9");
  const [otherJane, ticketJane] = store.rows;
  assert.equal(otherJane.duplicateOf, ticketJane._id);
  const r = await resolveRsvpDuplicate(store.resolver, otherJane._id, "separate", { name: "Staff Two" }, () => new Date("2026-10-20T12:00:00Z"));
  assert.equal(r.row, otherJane);
  assert.deepEqual([otherJane.duplicateOf, otherJane.separatedBy, otherJane.separatedFrom, otherJane.separatedAt.toISOString()],
    ["", "Staff Two", ticketJane._id, "2026-10-20T12:00:00.000Z"]);
  assert.equal(r.audit.action, "rsvp_separate");
  assert.equal(counted(store).total, 2);
  // The ticket holder changes her RSVP (by ticket, then by token): the other Jane is not flagged again.
  const byTicket = await run({ ...GOOD, ticketId: "abc123def", tier: "", days: ["day1", "day2"], options: ["gala"] }, "9.9.9.9");
  assert.notEqual(byTicket.body.editToken, real.body.editToken); // saved without it: a new token for this browser
  const byToken = await run({ ...GOOD, tier: "power", days: ["day2"], options: ["gala"], editToken: byTicket.body.editToken }, "9.9.9.9");
  assert.deepEqual([byTicket.body.updated, byToken.body.updated, ticketJane.days], [true, true, ["day2"]]);
  assert.equal(otherJane.duplicateOf, "");
  assert.equal(counted(store).total, 2);
  assert.equal(rsvpRow(otherJane).separated, true);
  assert.deepEqual([rsvpDetail(otherJane).separatedBy, rsvpRow(ticketJane).separated], ["Staff Two", false]);
  // Separate is final for that row; asking again is refused.
  assert.deepEqual(await resolveRsvpDuplicate(store.resolver, otherJane._id, "separate"), { status: 409, error: "This RSVP isn't marked as a possible duplicate" });
});

test("staff resolve: bad action, unknown row, or the row it duplicated is gone", async () => {
  const { run, store } = submitter();
  await run({ ...GOOD, tier: "connect", options: [] });
  await run({ ...GOOD, tier: "connect", options: [] }, "2.2.2.2");
  const [orig, dup] = store.rows;
  assert.equal((await resolveRsvpDuplicate(store.resolver, dup._id, "delete")).status, 400);
  assert.equal((await resolveRsvpDuplicate(store.resolver, "nope", "merge")).status, 404);
  orig.mergedInto = "elsewhere";
  const gone = await resolveRsvpDuplicate(store.resolver, dup._id, "merge");
  assert.deepEqual([gone.status, /separate/.test(gone.error)], [409, true]);
  assert.equal(dup.mergedInto, undefined);
});

test("the staff list carries the catalog, so it works while the public options endpoint is switched off", () => {
  const p = rsvpListPayload({ total: 1, page: 0, size: 50, everyone: [{ tier: "connect", days: ["day1"], options: ["sessions_d1"] }],
    rows: [{ _id: "r1", firstName: "A", lastName: "B", tier: "connect", days: ["day1"], options: ["sessions_d1"], duplicateOf: "r0" }] });
  assert.deepEqual(p.catalog, rsvpOptionsPayload());
  assert.deepEqual([p.total, p.page, p.size, p.summary.counts.sessions_d1, p.summary.duplicates], [1, 0, 50, 1, 0]);
  assert.deepEqual([p.rows[0].id, p.rows[0].duplicateOf, p.rows[0].separated], ["r1", "r0", false]);
});

test("routes wire the store calls the handlers rely on", async () => {
  const { readFile } = await import("node:fs/promises");
  const consoleSrc = await readFile(new URL("../routes/console.js", import.meta.url), "utf8");
  assert.match(consoleSrc, /res\.json\(rsvpListPayload\(/);
  assert.match(consoleSrc, /resolveRsvpDuplicate\(rsvpResolveStore,/);
  assert.match(consoleSrc, /findLive:.*select\("\+editTokenHash"\)/); // the newer browser's token moves with a merge
  const rsvpSrc = await readFile(new URL("../routes/rsvp.js", import.meta.url), "utf8");
  assert.match(rsvpSrc, /findByEditToken: \(hash\) =>/);
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
  assert.deepEqual(det.optionLabels, ["Gala Dinner & Networking Reception (Day 2)"]);
  assert.deepEqual(det.dietaryLabels, ["Other"]);
  const csv = rsvpsCsv([doc]);
  assert.ok(csv.startsWith("﻿"));
  const [head, line] = csv.slice(1).split("\n");
  // Cells split on commas outside quotes ("Keynotes, panels & sessions (Day 1)" is one cell).
  const cells = (l) => l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).slice(0, -1).map((c) => c.replace(/,$/, ""));
  assert.equal(cells(head).length, CSV_HEAD.length);
  assert.equal(cells(line).length, CSV_HEAD.length);
  assert.ok(cells(head).includes('"Keynotes, panels & sessions (Day 1)"'));
  assert.match(line, /^2026-10-12 10:00:00,'=cmd,Doe,j@x.com,Power Pass,Yes,Ticket holder,ABC,Yes,,/);
  assert.match(line, /'\+no fish/);
  assert.match(line, /"Wheelchair, ""step-free"""/);
  assert.match(line, /,Yes$/);
  assert.match(rsvpsCsv([{ ...doc, duplicateOf: "r9" }]), /,No: possible duplicate$/);
  assert.ok(CSV_HEAD.includes("Gala Dinner & Networking Reception (Day 2)"));
  assert.equal(CSV_HEAD.at(-1), "In headcounts");
});

test("PASS_TIERS are what people can pick", () => {
  assert.deepEqual(PASS_TIERS, ["connect", "influence", "power", "apex"]);
});

test("submit: a ticket ID matching the last name is required (live setting)", async () => {
  const { run, store } = submitter({ requireTicket: true });
  const noId = await run({ ...GOOD, ticketId: "", tier: "connect", options: [] });
  assert.equal(noId.statusCode, 400);
  assert.equal(noId.body.field, "ticketId");
  const wrong = await run({ ...GOOD, ticketId: "zzz999zzz", tier: "connect", options: [] });
  assert.equal(wrong.statusCode, 400);
  assert.equal(wrong.body.field, "ticketId");
  assert.equal(store.rows.length, 0);
  const ok = await run({ ...GOOD, ticketId: "abc123def", tier: "power", options: ["gala"] });
  assert.equal(ok.statusCode, 201);
  assert.equal(store.rows.length, 1);
});

test("lookup: the live setting never guesses a pass from a name alone", async () => {
  const lookup = makeLookup({
    verifyTicket: async () => null,
    getHolders: async () => [{ names: ["Jane Doe"], tier: "power" }],
    getSpeakers: async () => [],
  });
  const r = await lookup({ firstName: "Jane", lastName: "Doe", ticketId: "" });
  assert.equal(r.kind, "none");
});

test("team email: lists pass, days, special events and dietary, all escaped", () => {
  const e = buildRsvpEmail({ firstName: "Ann<b>", lastName: "Lee", tier: "apex", ticketId: "ABC123", days: ["day1", "day2"],
    options: ["gala", "lunch_d1"], dietary: ["vegan", "other"], dietaryOther: "no <script>", accessibility: "" });
  assert.match(e.subject, /^\[RSVP\] Ann<b> Lee · Apex Pass$/);
  assert.ok(!e.html.includes("<script>") && !e.html.includes("Ann<b>"));
  assert.match(e.html, /Gala Dinner/);
  assert.match(e.text, /Vegan, Other: no <script>/);
  assert.match(buildRsvpEmail({ firstName: "A", lastName: "B", tier: "connect" }, { updated: true }).subject, /^\[RSVP updated\]/);
});

test("submit: each saved RSVP is passed to notify; a failing email never blocks the RSVP", async () => {
  const sent = [];
  const { run } = submitter({ requireTicket: true, notify: async (row, o) => { sent.push([row, o.updated]); throw new Error("mail down"); } });
  const ok = await run({ ...GOOD, ticketId: "abc123def", tier: "power", options: ["gala"] });
  assert.equal(ok.statusCode, 201);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1], false);
  // The team email names the person and their days (it used to get only the pass: "Someone", no days).
  const [row] = sent[0];
  assert.equal(row.firstName, "Jane");
  assert.deepEqual(row.days, ["day1", "day2"]);
  assert.deepEqual(row.options, ["gala"]);
  assert.equal(row.tier, "power");
  assert.equal(row.editTokenHash, undefined);
  const mail = buildRsvpEmail(row, { updated: false });
  assert.match(mail.subject, /Jane Doe/);
});

test("speakers can't RSVP for the pre-matched meetings or the Scotch lounge (Apex only)", () => {
  const r = checkOptions("speaker", ["day1"], ["meetings", "lounge", "awards"]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.invalid, ["meetings", "lounge"]);
  assert.ok(checkOptions("apex", ["day1"], ["meetings", "lounge"]).ok);
});

test("special-event times come from the agenda", async () => {
  const sessions = parseRsvpAgenda({ result: [
    { day: 1, time: "07:55", title: "CxO Breakfast" },
    { day: 1, time: "12:35", title: "Networking Lunch" },
    { day: 1, time: "17:30", title: "Awards Evening" },
    { day: 2, time: "7:50", title: "CxO Breakfast" },
    { day: 2, time: "12:00", title: "Lunch" },
    { day: 2, time: "17:30", title: "Gala Dinner" },
    { day: 3, time: "09:00", title: "CxO Breakfast" },
    { day: 1, time: "soon", title: "Lunch" },
  ] });
  assert.equal(sessions.length, 6);
  assert.deepEqual(agendaTimes(sessions), {
    cxo_d1: "7:55 AM", lunch_d1: "12:35 PM", awards: "5:30 PM", cxo_d2: "7:50 AM", lunch_d2: "12:00 PM", gala: "5:30 PM",
  });
  assert.equal(parseRsvpAgenda({ result: [] }), null);
  assert.equal(clock12("00:05"), "12:05 AM");
  assert.equal(clock12("12:00"), "12:00 PM");

  // The payload uses the agenda's time when there is one, the fallback otherwise; untimed options stay untimed.
  const p = rsvpOptionsPayload({ cxo_d1: "8:05 AM", expo_d1: "9:00 AM" });
  assert.equal(p.options.find((o) => o.key === "cxo_d1").time, "8:05 AM");
  assert.equal(p.options.find((o) => o.key === "cxo_d2").time, "7:55 AM");
  assert.equal(p.options.find((o) => o.key === "expo_d1").time, undefined);
  assert.ok(!p.options.some((o) => o.time === "Morning"));

  // The handler asks for the times; a failing lookup still serves the page.
  const res = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; }, json(b) { this.body = b; } });
  const ok = makeRsvpHandlers({ lookup: async () => null, store: {}, agendaTimes: async () => ({ gala: "6:00 PM" }) });
  const r1 = res(); await ok.options({}, r1);
  assert.equal(r1.body.options.find((o) => o.key === "gala").time, "6:00 PM");
  assert.equal(r1.headers["Cache-Control"], "public, max-age=60");
  const broken = makeRsvpHandlers({ lookup: async () => null, store: {}, agendaTimes: async () => { throw new Error("down"); } });
  const r2 = res(); await broken.options({}, r2);
  assert.equal(r2.body.options.find((o) => o.key === "gala").time, "5:30 PM");
});
