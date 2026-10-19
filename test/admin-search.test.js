/* Admin global search: the pure parts (services/adminSearch.js). The People directory records come from the real
   buildPeople, so the groups see exactly what Admin › People sees. Fictional people, example.com addresses. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseQuery, matchScore, tokens, foldText, escapeRegex, accentRegex, prefilter, groupsFor, runSearch, GROUPS, GROUP_CAP,
  peopleItems, ticketItems, passItems, rsvpItems, cmsItems, nominationItems, formItems, brochureItems, pavilionItems, staffItems,
  SEARCH_MIN_CHARS,
} from "../services/adminSearch.js";
import { ticketVariants, CMS_SEARCH_GROQ, makeSearchSources } from "../services/adminSearchSources.js";
import { buildPeople } from "../services/people.js";

const d = (s) => new Date(`2026-${s}T12:00:00Z`);

function world() {
  const users = [
    { _id: "u1", name: "Jane Doe", email: "jane.doe@example.com", role: "user", organization: "Acme Example", jobTitle: "CTO",
      tickets: [{ ticketId: "a1b2c3d4e5f6", type: "power", purchaseDate: d("09-01"), stripeSessionId: "cs_jane" }] },
    { _id: "u2", name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management", tickets: [] },
    { _id: "u3", name: "Sam Staff", email: "sam.staff@example.com", role: "admin", staffRole: "staff", tickets: [] },
    { _id: "u4", name: "Val Volunteer", email: "val.volunteer@example.com", role: "volunteer", tickets: [] },
    { _id: "u5", name: "Paid Outside", email: "paid.outside@example.com", role: "user",
      tickets: [{ ticketId: "0f0f0f0f0f0f", type: "apex", purchaseDate: d("09-02"), manualValue: 1499 }] },
  ];
  const attendees = [
    { _id: "a1", name: "Kai Speaker", email: "", ticketId: "5pk000000001", ticketType: "speaker", promoCode: "SPEAKER", speakerId: "spk-kai",
      details: { jobTitle: "Chief Scientist", organisation: "Quantum Example" } },
    { _id: "a2", name: "Ivan Invoice", email: "ivan.invoice@example.com", ticketId: "155000000001", ticketType: "power", promoCode: "ISSUED",
      issuedPass: { label: "Partner Pass" }, details: { firstName: "Ivan", lastName: "Invoice", organisation: "Adventure Works" } },
    { _id: "a3", name: "Eve Exhibitor", email: "eve.exhibitor@example.com", ticketId: "e0e000000001", ticketType: "connect", promoCode: "EXHIBITOR",
      issuedPass: { booth: { booth: "B7" } }, details: { firstName: "Eve", lastName: "Exhibitor", organisation: "Robotics Example" } },
    { _id: "a4", name: "José Núñez", email: "jose.nunez@example.com", ticketId: "c0c000000001", ticketType: "connect", stripeSessionId: "cs_jose",
      details: { firstName: "José", lastName: "Núñez", organisation: "Ñandú Example" } },
    // Hidden by staff, held by no account: not in the directory, found by ticket ID only.
    { _id: "a5", name: "Test Pass", email: "test.pass@example.com", ticketId: "dead00000001", ticketType: "connect", hiddenByStaff: true },
  ];
  const rsvps = [
    { _id: "r1", key: "n:rita rsvp", firstName: "Rita", lastName: "Rsvp", name: "Rita Rsvp", nameKey: "rita rsvp", email: "rita.rsvp@example.com",
      tier: "connect", days: ["day1"], options: [], source: "attendee", createdAt: d("10-10"), updatedAt: d("10-10") },
    { _id: "r2", key: "t:a1b2c3d4e5f6", firstName: "Jane", lastName: "Doe", name: "Jane Doe", nameKey: "jane doe", ticketId: "A1B2C3D4E5F6",
      ticketVerified: true, tier: "power", days: ["day1", "day2"], options: ["gala"], source: "attendee", createdAt: d("10-11"), updatedAt: d("10-11") },
  ];
  const speakers = [{ _id: "spk-kai", name: "Kai Speaker", title: "Chief Scientist", company: "Quantum Example" }];
  return { users, attendees, rsvps, speakers };
}
const dir = () => {
  const w = world();
  return { ...buildPeople(w), rsvps: w.rsvps };
};

const CMS = [
  { _id: "s1", _type: "session", title: "Quantum Computing in Finance", day: 1, time: "10:00", endTime: "10:30", stage: "Harbour Ballroom", type: "Panel",
    speakers: ["Kai Speaker", "Lee Panelist"], moderator: "Mona Moderator", sessionId: "d1-04" },
  { _id: "s2", _type: "session", title: "Opening Keynote", day: 1, time: "09:00", endTime: "09:20", stage: "Centre Stage" },
  { _id: "spk-kai", _type: "speaker", name: "Kai Speaker", title: "Chief Scientist", company: "Quantum Example", featured: true },
  { _id: "p1", _type: "partner", name: "Example Robotics", category: "corporateEnterprisePartners", matrixGroup: "featured", active: true },
  { _id: "p2", _type: "partner", name: "Example University", category: "academicResearchInstitutions", active: false },
  { _id: "l1", _type: "sponsor", name: "Example Logistics" },
  { _id: "l2", _type: "sponsorMarquee", name: "Example Marquee Co" },
  { _id: "drafts.p3", _type: "partner", name: "Example Draft" },
];
const NOMINATIONS = [
  { _id: "n1", nomineeName: "Nora Nominee", nomineeOrganisation: "Example Health", nomineeEmail: "nora@example.com", nominatorName: "Ned Nominator",
    nominatorEmail: "ned@example.com", categoryType: "special", specialAward: "rising", status: "shortlisted" },
];
const FORMS = [{ _id: "f1", form: "sponsor", name: "Fay Former", email: "fay.former@example.com", company: "Example Bank", status: "new", createdAt: d("10-01") }];
const BROCHURES = [{ _id: "b1", firstName: "Bea", lastName: "Brochure", email: "bea.brochure@example.com", company: "Example Retail", jobTitle: "VP Sales", brochure: "sponsorship", createdAt: d("10-02") }];
const PAVILION = [{ _id: "pv1", legalName: "Example Pvt Ltd", repName: "Priya Rep", repEmail: "Priya.Rep@Example.com", reference: "IP-7K3QXM", status: "contacted" }];
const STAFF = world().users.filter((u) => u.role !== "user");

const sources = (over = {}) => ({
  directory: async () => dir(),
  ticketDocs: async (pq) => world().attendees.filter((a) => pq.ticket && a.ticketId.toLowerCase() === pq.ticket),
  cms: async () => CMS,
  nominations: async () => NOMINATIONS,
  forms: async () => FORMS,
  brochures: async () => BROCHURES,
  pavilion: async () => PAVILION,
  staff: async () => STAFF,
  ...over,
});
const quiet = { error() {}, log() {} };
const MGMT = { management: true, isManagement: (u) => u.staffRole === "management" };
const STAFF_VIEW = { management: false, isManagement: (u) => u.staffRole === "management" };
const group = (out, key) => out.groups.find((g) => g.key === key);

/* ---------- The query ---------- */

test("parseQuery: trims, folds, at least 2 characters; emails and ticket IDs recognised", () => {
  assert.equal(SEARCH_MIN_CHARS, 2);
  assert.equal(parseQuery("k").tooShort, true);
  assert.equal(parseQuery(" k ").tooShort, true);
  assert.equal(parseQuery("ka").tooShort, false);
  assert.deepEqual(parseQuery("  José   NÚÑEZ ").words, ["jose", "nunez"]);
  assert.equal(parseQuery("Jane.Doe@Example.com").email, "jane.doe@example.com");
  assert.equal(parseQuery("jane.doe@exam").email, "");
  assert.equal(parseQuery("TECHFEST:A1B2C3D4E5F6").ticket, "a1b2c3d4e5f6");
  assert.equal(parseQuery("TECHFEST: A1B2C3D4E5F6").ticket, "a1b2c3d4e5f6");
  assert.equal(parseQuery("a1b2 c3d4").ticket, "", "two words are not a ticket ID");
  assert.equal(parseQuery("speaker").ticket, "", "a plain word is not a ticket ID");
  assert.equal(parseQuery("BOOTH-STARTUP").ticket, "booth-startup");
  assert.equal(parseQuery("x".repeat(500)).text.length, 100);
  // Only strings: an object from a JSON body or an operator is nothing at all.
  for (const bad of [{ $ne: null }, { $gt: "" }, 42, null, undefined, [{ $ne: 1 }]]) {
    const pq = parseQuery(bad);
    assert.equal(pq.tooShort, true, JSON.stringify(bad));
    assert.equal(typeof pq.text, "string");
  }
  assert.equal(parseQuery(["kai", "x"]).text, "kai", "?q=a&q=b: the first");
  // Punctuation alone is no search.
  assert.equal(parseQuery(".*").tooShort, true);
  assert.equal(parseQuery("$$").tooShort, true);
});

test("matchScore: every word must start a word of the record; names weigh most; accents ignored", () => {
  assert.deepEqual(tokens("O'Brien-Smith, Jr."), ["o", "brien", "smith", "jr"]);
  assert.equal(foldText("Ñandú"), "nandu");
  const f = [["Jane Doe", 10], ["Acme Example", 5]];
  assert.ok(matchScore(["ja"], f) > 0);
  assert.ok(matchScore(["jane", "acme"], f) > 0);
  assert.equal(matchScore(["ane"], f), 0, "inside a word doesn't count");
  assert.equal(matchScore(["jane", "zzz"], f), 0, "every word must match");
  assert.ok(matchScore(["jane"], f) > matchScore(["acme"], f), "the name weighs more than the company");
  assert.ok(matchScore(["jane"], f) > matchScore(["jan"], f), "a whole word beats a prefix");
});

test("escaping: the database regexes only ever match the literal words typed", () => {
  const hostile = "a.*(b)[c]?^$|\\/-+{2}";
  const rx = new RegExp(escapeRegex(hostile));
  assert.ok(rx.test(`xx${hostile}yy`));
  assert.ok(!rx.test("aXXb"));
  // accentRegex: accents and case, nothing else; even a hostile token stays literal.
  const jose = accentRegex("jose");
  assert.ok(jose.test("José Núñez") && jose.test("JOSE") && !jose.test("jxse"));
  for (const word of ["(a+)+$", ".*", "a|b", "[^x]", "\\d", "${x}"]) {
    const r = accentRegex(word);
    assert.ok(r.test(`--${word}--`), word);
    assert.ok(!r.test("zzzz"), word);
  }
  // The prefilter is built from the folded words only: no operator, no raw query.
  const pq = parseQuery('{"$where": "sleep(5000)"} .* (a+)+');
  const f = prefilter(pq, { text: ["name", "company"], emails: ["email"], base: { spam: { $ne: true } } });
  assert.deepEqual(Object.keys(f).sort(), ["$or", "spam"]);
  assert.equal(f.$or.length, 2);
  for (const c of f.$or) {
    const [[field, value]] = Object.entries(c);
    assert.ok(["name", "company"].includes(field));
    assert.ok(value instanceof RegExp);
    assert.equal(value.flags, "i");
    assert.ok(!/\$where|sleep|\(\.|\+\)/.test(value.source), value.source);
  }
  // Email mode: equality on the email fields (indexed), never a regex.
  const pe = prefilter(parseQuery("Jane.Doe@Example.com"), { text: ["name"], emails: ["email", "repEmail"] });
  assert.deepEqual(pe.$or, [{ email: { $in: ["jane.doe@example.com", "Jane.Doe@Example.com"] } }, { repEmail: { $in: ["jane.doe@example.com", "Jane.Doe@Example.com"] } }]);
  assert.equal(prefilter(parseQuery("x@example.com"), { text: ["name"] }), null, "no email field: nothing to read");
  assert.deepEqual(ticketVariants(parseQuery("TECHFEST: a1b2c3d4e5f6")), ["a1b2c3d4e5f6", "A1B2C3D4E5F6"]);
});

/* ---------- Each group ---------- */

test("people: accounts, pass holders, website speakers and RSVP-only people, by merged person id", () => {
  const { people } = dir();
  const kai = peopleItems(people, parseQuery("kai sp"));
  assert.equal(kai.length, 1);
  assert.match(kai[0].id, /^a-a1$/);                          // Kai's pass and the website speaker are one person
  assert.equal(kai[0].link, "/admin/people/a-a1");
  assert.match(kai[0].subtitle, /Chief Scientist, Quantum Example · Speaker Pass/);
  assert.deepEqual(kai[0].badges, ["Speaker"]);
  // RSVP-only person (no pass, no account): her r- id.
  const rita = peopleItems(people, parseQuery("rita"));
  assert.deepEqual(rita.map((x) => [x.id, x.subtitle]), [["r-r1", "rita.rsvp@example.com · RSVP only"]]);
  // Company and job title match; accents ignored.
  assert.deepEqual(peopleItems(people, parseQuery("adventure")).map((x) => x.title), ["Ivan Invoice"]);
  assert.deepEqual(peopleItems(people, parseQuery("cto")).map((x) => x.title), ["Jane Doe"]);
  assert.deepEqual(peopleItems(people, parseQuery("nunez")).map((x) => x.title), ["José Núñez"]);
  assert.deepEqual(peopleItems(people, parseQuery("Ñandú")).map((x) => x.title), ["José Núñez"]);
  // Emails exactly: the whole address finds them, part of it doesn't.
  const exact = peopleItems(people, parseQuery("Jane.Doe@example.com"));
  assert.deepEqual(exact.map((x) => [x.title, x.exact]), [["Jane Doe", true]]);
  assert.equal(peopleItems(people, parseQuery("rita.rsvp@exam")).length, 0, "part of an email isn't an email");
  assert.equal(peopleItems(people, parseQuery("rita.rsvp@example.com")).length, 1);
  assert.equal(peopleItems(people, parseQuery("example.com")).length, 0, "an email domain isn't a name");
  // Ticket ID exactly.
  assert.deepEqual(peopleItems(people, parseQuery("A1B2C3D4E5F6")).map((x) => [x.title, x.exact]), [["Jane Doe", true]]);
  assert.equal(peopleItems(people, parseQuery("a1b2c3")).length, 0, "part of a ticket ID doesn't match");
});

test("tickets: exact ticket ID only → the person's profile, else Tickets; amounts for management only", () => {
  const { people } = dir();
  const jane = ticketItems(people, parseQuery("techfest:a1b2c3d4e5f6"));
  assert.deepEqual(jane.map((x) => [x.title, x.link, x.exact]), [["Power Pass · A1B2C3D4E5F6", "/admin/people/u-u1", true]]);
  assert.equal(ticketItems(people, parseQuery("a1b2c3d4e5")).length, 0);
  assert.equal(ticketItems(people, parseQuery("jane")).length, 0);
  // Paid outside Stripe: the amount management typed, shown to management only.
  const m = ticketItems(people, parseQuery("0F0F0F0F0F0F"), { amounts: true });
  assert.match(m[0].subtitle, /CA\$1499\.00/);
  const s = ticketItems(people, parseQuery("0F0F0F0F0F0F"), { amounts: false });
  assert.doesNotMatch(JSON.stringify(s), /CA\$|1499/);
  // A hidden pass nobody's account holds: the Tickets page, every tab.
  const hidden = ticketItems(people, parseQuery("DEAD00000001"), { extra: world().attendees.filter((a) => a.ticketId === "dead00000001") });
  assert.deepEqual(hidden.map((x) => [x.title, x.link]), [["Connect Pass · DEAD00000001", "/admin/attendees?q=dead00000001&show=hidden"]]);
  assert.match(hidden[0].subtitle, /Hidden from staff lists/);
});

test("passes: speaker, issued and exhibitor passes → their own page, searched by the ticket ID", () => {
  const { people } = dir();
  const rows = (q) => passItems(people, parseQuery(q)).map((x) => [x.type, x.title, x.link]);
  assert.deepEqual(rows("kai"), [["speaker-pass", "Kai Speaker", "/admin/speaker-passes?q=5pk000000001"]]);
  assert.deepEqual(rows("ivan"), [["issued-pass", "Ivan Invoice", "/admin/issued-passes?q=155000000001"]]);
  assert.deepEqual(rows("b7"), [["exhibitor-pass", "Eve Exhibitor", "/admin/exhibitor-passes?q=e0e000000001"]]);
  assert.match(passItems(people, parseQuery("eve"))[0].subtitle, /Connect Pass \(exhibitor\) · Booth B7/);
  assert.match(passItems(people, parseQuery("ivan"))[0].subtitle, /“Partner Pass”/);
  assert.deepEqual(rows("jane"), [], "a bought pass isn't a staff-made pass");
  assert.deepEqual(rows("155000000001").map((r) => r[1]), ["Ivan Invoice"]);
  assert.deepEqual(rows("speaker pass").map((r) => r[1]), ["Kai Speaker"], "the pass's own name");
});

test("rsvps: name, exact email or ticket ID → that RSVP on Leads › RSVPs", () => {
  const { rsvps } = dir();
  assert.deepEqual(rsvpItems(rsvps, parseQuery("rita")).map((x) => [x.title, x.link]), [["Rita Rsvp", "/admin/rsvps?id=r1"]]);
  assert.match(rsvpItems(rsvps, parseQuery("jane"))[0].subtitle, /Power Pass · Both days · Confirmed by Individual/);
  assert.equal(rsvpItems(rsvps, parseQuery("rita.rsvp@example.com"))[0].exact, true);
  assert.equal(rsvpItems(rsvps, parseQuery("a1b2c3d4e5f6"))[0].title, "Jane Doe");
});

test("CMS: sessions (title, speakers, moderator), website speakers, partners and sponsors, logo strips → their editors", () => {
  const all = (q) => cmsItems(CMS, parseQuery(q));
  assert.deepEqual(all("quantum").sessions.map((x) => [x.title, x.link]), [["Quantum Computing in Finance", "/admin/content/agenda?edit=s1"]]);
  assert.match(all("quantum").sessions[0].subtitle, /^Day 1 · 10:00–10:30 · Harbour Ballroom · Panel · Kai Speaker, Lee Panelist, Mona Moderator$/);
  assert.equal(all("derator").sessions.length, 0, "inside a word doesn't count");
  assert.equal(all("mona mod").sessions.length, 1, "the moderator");
  assert.equal(all("lee").sessions.length, 1, "a speaker");
  assert.deepEqual(all("d1-04").sessions.map((x) => x.id), ["s1"]);
  assert.deepEqual(all("kai").speakers.map((x) => [x.title, x.subtitle, x.link]), [["Kai Speaker", "Chief Scientist, Quantum Example · Featured", "/admin/content/speakers?edit=spk-kai"]]);
  const partners = all("example").partners;
  assert.deepEqual(partners.map((x) => [x.title, x.subtitle]),
    [["Example Robotics", "Featured Partner (sponsor)"], ["Example University", "Academic and Research Institutions · Hidden"]]);
  assert.deepEqual(partners[0].meta, { matrixGroup: "featured", category: "corporateEnterprisePartners", active: true });
  assert.ok(!partners.some((x) => x.id.startsWith("drafts.")), "drafts never");
  assert.deepEqual(all("example").logos.map((x) => [x.title, x.link]),
    [["Example Logistics", "/admin/content/alumni-logos?edit=l1"], ["Example Marquee Co", "/admin/content/sponsor-marquee?edit=l2"]]);
  assert.deepEqual(Object.values(all("kai@example.com")).flat(), [], "no emails in the CMS");
  assert.match(CMS_SEARCH_GROQ, /drafts/);
});

test("leads: nominations, form submissions, brochure downloads, India Pavilion; staff accounts", () => {
  assert.deepEqual(nominationItems(NOMINATIONS, parseQuery("nora")).map((x) => [x.title, x.link]), [["Nora Nominee", "/admin/awards?id=n1"]]);
  assert.match(nominationItems(NOMINATIONS, parseQuery("ned"))[0].subtitle, /Rising Innovator · Example Health · by Ned Nominator · Shortlisted/);
  assert.equal(nominationItems(NOMINATIONS, parseQuery("ned@example.com"))[0].exact, true, "the nominator's email");
  assert.deepEqual(formItems(FORMS, parseQuery("fay")).map((x) => [x.title, x.link]), [["Fay Former", "/admin/form-submissions?id=f1"]]);
  assert.match(formItems(FORMS, parseQuery("example bank"))[0].subtitle, /^Sponsor enquiry · Example Bank · New · 2026-10-01$/);
  assert.deepEqual(brochureItems(BROCHURES, parseQuery("bea")).map((x) => [x.title, x.link]), [["Bea Brochure", "/admin/brochure-downloads?q=bea.brochure%40example.com"]]);
  assert.deepEqual(pavilionItems(PAVILION, parseQuery("priya.rep@example.com")).map((x) => [x.title, x.exact]), [["Example Pvt Ltd", true]]);
  assert.equal(pavilionItems(PAVILION, parseQuery("ip-7k3qxm"))[0].exact, true, "the reference");
  assert.doesNotMatch(JSON.stringify(pavilionItems(PAVILION, parseQuery("example"))), /deposit|\$/i);
  assert.deepEqual(staffItems(STAFF, parseQuery("val"), MGMT).map((x) => [x.title, x.subtitle, x.link]),
    [["Val Volunteer", "Volunteer · val.volunteer@example.com", "/admin/staff?highlight=u4"]]);
  assert.deepEqual(staffItems(STAFF, parseQuery("mia"), MGMT).map((x) => x.subtitle), ["Management · mia.manager@example.com"]);
  assert.deepEqual(staffItems(world().users, parseQuery("jane"), MGMT), [], "only staff and volunteers");
});

/* ---------- Running a search: permissions, order, cap, failures ---------- */

test("permissions: staff see every page's group except Staff accounts; management see all; amounts management only", async () => {
  assert.deepEqual(groupsFor({ management: false }).map((g) => g.key), GROUPS.filter((g) => g.key !== "staff").map((g) => g.key));
  assert.deepEqual(groupsFor({ management: true }).map((g) => g.key), GROUPS.map((g) => g.key));
  assert.ok(!groupsFor({}).some((g) => g.key === "staff"), "unknown viewer = staff");

  let staffCalls = 0;
  const src = sources({ staff: async () => { staffCalls += 1; return STAFF; } });
  const asStaff = await runSearch({ q: "sam", viewer: STAFF_VIEW, sources: src, log: quiet });
  assert.equal(group(asStaff, "staff"), undefined);
  assert.equal(staffCalls, 0, "the Staff accounts source isn't even read for staff");
  const asMgmt = await runSearch({ q: "sam", viewer: MGMT, sources: src, log: quiet });
  assert.deepEqual(group(asMgmt, "staff").items.map((x) => x.title), ["Sam Staff"]);
  assert.equal(staffCalls, 1);

  const ticketStaff = await runSearch({ q: "0f0f0f0f0f0f", viewer: STAFF_VIEW, sources: src, log: quiet });
  assert.doesNotMatch(JSON.stringify(ticketStaff), /CA\$|1499/);
  const ticketMgmt = await runSearch({ q: "0f0f0f0f0f0f", viewer: MGMT, sources: src, log: quiet });
  assert.match(group(ticketMgmt, "tickets").items[0].subtitle, /CA\$1499\.00/);
});

test("runSearch: mixed groups with See all links; an exact ticket ID or email comes first", async () => {
  const out = await runSearch({ q: "kai", viewer: STAFF_VIEW, sources: sources(), log: quiet });
  assert.deepEqual(out.groups.map((g) => g.key), ["people", "passes", "sessions", "speakers"]);
  assert.deepEqual(group(out, "people").seeAll, { label: "See all in People", link: "/admin/people?q=kai" });
  assert.equal(group(out, "passes").seeAll, undefined, "three pages: no single See all");
  for (const g of out.groups) for (const it of g.items) {
    assert.deepEqual(Object.keys(it).filter((k) => !["badges", "exact", "meta"].includes(k)).sort(), ["id", "link", "subtitle", "title", "type"]);
    assert.ok(it.link.startsWith("/admin/"));
    assert.equal(it.score, undefined);
  }
  const t = await runSearch({ q: "TECHFEST:A1B2C3D4E5F6", viewer: STAFF_VIEW, sources: sources(), log: quiet });
  assert.equal(t.query.exact, "ticket");
  assert.equal(t.groups[0].key, "tickets");
  assert.deepEqual(t.groups[0].seeAll, { label: "See it in Tickets", link: "/admin/attendees?q=TECHFEST%3AA1B2C3D4E5F6" });
  assert.ok(t.groups.every((g) => g.items[0].exact), "only exact hits for a ticket ID");
  const e = await runSearch({ q: "rita.rsvp@example.com", viewer: STAFF_VIEW, sources: sources(), log: quiet });
  assert.equal(e.query.exact, "email");
  assert.deepEqual(e.groups.map((g) => g.key), ["people", "rsvps"]);
  // No Tickets group (and no ticket lookup) for a query that can't be a ticket ID.
  let lookups = 0;
  await runSearch({ q: "jane", viewer: STAFF_VIEW, sources: sources({ ticketDocs: async () => { lookups += 1; return []; } }), log: quiet });
  assert.equal(lookups, 0);
});

test("runSearch: too short → nothing read", async () => {
  let reads = 0;
  const counting = Object.fromEntries(Object.keys(sources()).map((k) => [k, async () => { reads += 1; return []; }]));
  const out = await runSearch({ q: "k", viewer: MGMT, sources: counting, log: quiet });
  assert.deepEqual([out.tooShort, out.groups, out.minChars, reads], [true, [], 2, 0]);
});

test("cap: at most 5 per group, `more` and `total` say there are others", async () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ _id: `f${i}`, form: "inquiry", name: `Capper Number${i}`, email: `capper${i}@example.com`, createdAt: d("10-01") }));
  const out = await runSearch({ q: "capper", viewer: STAFF_VIEW, sources: sources({ forms: async () => many }), log: quiet });
  const g = group(out, "forms");
  assert.equal(GROUP_CAP, 5);
  assert.deepEqual([g.items.length, g.total, g.more], [5, 8, true]);
  const few = await runSearch({ q: "fay", viewer: STAFF_VIEW, sources: sources(), log: quiet });
  assert.deepEqual([group(few, "forms").items.length, group(few, "forms").more], [1, false]);
});

test("partial failure: a broken or slow source leaves only its own groups out; nothing logged with the terms", async () => {
  const lines = [];
  const log = { error: (...a) => lines.push(a.join(" ")), log: (...a) => lines.push(a.join(" ")) };
  const broken = Object.assign(new Error("Regular expression is invalid near jane.doe@example.com"), { name: "MongoServerError", code: 51091 });
  const out = await runSearch({
    q: "jane.doe@example.com", viewer: MGMT, log, timeoutMs: 50,
    sources: sources({ cms: () => new Promise(() => {}), forms: async () => { throw broken; }, staff: undefined }),
  });
  assert.deepEqual(out.groups.map((g) => g.key), ["people"], "people still answer");
  assert.deepEqual(out.failed.map((f) => [f.key, f.reason]), [
    ["sessions", "timeout"], ["speakers", "timeout"], ["partners", "timeout"], ["logos", "timeout"], ["forms", "error"], ["staff", "error"],
  ]);
  assert.equal(lines.length, 2);
  for (const l of lines) {
    assert.doesNotMatch(l, /jane|example\.com|Regular expression/i, l);
    assert.match(l, /^ADMIN SEARCH: (cms timed out after 50 ms|forms failed \(MongoServerError 51091\))$/);
  }
  // The directory failing takes People, passes, RSVPs (and tickets) out; the CMS and leads still answer.
  const noDir = await runSearch({ q: "kai", viewer: STAFF_VIEW, log: quiet, sources: sources({ directory: async () => { throw new Error("db down"); } }) });
  assert.deepEqual(noDir.groups.map((g) => g.key), ["sessions", "speakers"]);
  assert.deepEqual(noDir.failed.map((f) => f.key), ["people", "passes", "rsvps"]);
  // A builder that throws is reported like a source.
  const odd = await runSearch({ q: "nora", viewer: STAFF_VIEW, log: quiet, sources: sources({ nominations: async () => [null] }) });
  assert.deepEqual(odd.failed.map((f) => f.key), ["nominations"]);
});

test("sources: the Staff accounts read is limited to staff and volunteers; prefilters are capped and timed", async () => {
  const calls = [];
  const fake = (name) => ({
    find(filter) { calls.push([name, filter]); const q = { select: () => q, sort: () => q, limit: (n) => { calls.push([name, "limit", n]); return q; }, maxTimeMS: (n) => { calls.push([name, "maxTimeMS", n]); return q; }, lean: async () => [] }; return q; },
  });
  const models = Object.fromEntries(["Attendee", "User", "Nomination", "FormSubmission", "Brochure", "PavilionApplication"].map((m) => [m, fake(m)]));
  const src = makeSearchSources({ directory: async () => ({ people: [], rsvps: [] }), cms: async () => [], models, maxTimeMS: 1234 });
  await src.staff(parseQuery("sam"));
  await src.forms(parseQuery("sam"));
  await src.ticketDocs(parseQuery("a1b2c3d4e5f6"));
  const staffFilter = calls.find(([n, f]) => n === "User" && typeof f === "object").at(1);
  assert.deepEqual(staffFilter.role, { $in: ["admin", "volunteer"] });
  assert.ok(staffFilter.name instanceof RegExp);
  const formFilter = calls.find(([n, f]) => n === "FormSubmission" && typeof f === "object").at(1);
  assert.deepEqual(formFilter.spam, { $ne: true }, "bots never");
  assert.ok(calls.some(([n, k, v]) => n === "FormSubmission" && k === "maxTimeMS" && v === 1234));
  assert.ok(calls.some(([n, k, v]) => n === "FormSubmission" && k === "limit" && v === 300));
  assert.deepEqual(calls.find(([n, f]) => n === "Attendee" && typeof f === "object").at(1), { ticketId: { $in: ["a1b2c3d4e5f6", "A1B2C3D4E5F6"] } });
  // Nothing read for an email when the collection has no email field.
  assert.deepEqual(await src.staff(parseQuery("..")), []);
});
