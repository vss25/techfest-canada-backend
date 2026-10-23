/* Event summary (services/eventSummary.js): the counting rules on a small fictional world built by the real People
   directory join (services/people.js buildPeople). Pure: no database, no network. */
import test from "node:test";
import assert from "node:assert/strict";
import { buildPeople } from "../services/people.js";
import { eventSummary, eventDayOf, torontoDate, countingPasses, mainPass, SUMMARY_MEALS, SUMMARY_TIERS } from "../services/eventSummary.js";

const d = (s) => new Date(`2026-${s}T12:00:00Z`);
const rsvp = (id, ticket, first, last, extra) => ({
  _id: id, key: `t:${ticket.toLowerCase()}`, ticketId: ticket, ticketVerified: true, firstName: first, lastName: last,
  nameKey: `${first} ${last}`.toLowerCase(), source: "attendee", createdAt: d("10-10"), updatedAt: d("10-10"), attendeeSubmittedAt: d("10-10"), ...extra,
});

/* Fictional people:
   Pat (Power, account) RSVP'd both days + luncheon D1, awards, gala; vegetarian; scanned Day 1.
   Cara (Connect, guest) RSVP'd Day 1; staff added luncheon D1 outside her pass; scanned 23:30 Toronto on Oct 26 (UTC Oct 27).
   Ian (Influence, account) staff switched the Gala on for his pass; only a possible-duplicate RSVP; scanned Day 2.
   Annie (Apex, guest) RSVP'd Day 2: CxO D2, luncheon D2, gala; halal, gluten-free, other ("No pork"); scanned Day 2.
   Sam (Speaker Pass, never emailed → pending), no RSVP.
   Ed (exhibitor pass = Connect, emailed → issued) RSVP'd both days, no meals; checked in by the old endpoint (no time).
   Victor (Connect, VIP flag → CxO automatically) RSVP'd Day 1 + CxO D1; vegan; scanned before the event (Oct 23).
   Dana (two passes on her account: Power + Connect) RSVP'd Day 2 + gala.
   Left out: Rita (Apex, fully refunded, RSVP'd), Hal (his only pass hidden by staff), Nina (staff, no pass). */
function world() {
  const users = [
    { _id: "u1", name: "Pat Power", email: "pat@example.com", role: "user",
      tickets: [{ ticketId: "POW1", type: "power", purchaseDate: d("09-01"), stripeSessionId: "cs_p", checkedIn: true, checkedInAt: new Date("2026-10-26T13:30:00Z") }] },
    { _id: "u2", name: "Ian Influence", email: "ian@example.com", role: "user",
      tickets: [{ ticketId: "INF1", type: "influence", purchaseDate: d("09-02"), stripeSessionId: "cs_i", galaDinner: true, checkedIn: true, checkedInAt: new Date("2026-10-27T14:00:00Z") }] },
    { _id: "u3", name: "Victor Vip", email: "victor@example.com", role: "user", vip: true,
      tickets: [{ ticketId: "VIP1", type: "connect", purchaseDate: d("09-03"), stripeSessionId: "cs_v", checkedIn: true, checkedInAt: new Date("2026-10-23T15:00:00Z") }] },
    { _id: "u4", name: "Dana Double", email: "dana@example.com", role: "user",
      tickets: [
        { ticketId: "DBL1", type: "power", purchaseDate: d("09-04"), stripeSessionId: "cs_d1" },
        { ticketId: "DBL2", type: "connect", purchaseDate: d("09-05"), stripeSessionId: "cs_d2" },
      ] },
    { _id: "u5", name: "Hal Hidden", email: "hal@example.com", role: "user",
      tickets: [{ ticketId: "HID1", type: "apex", purchaseDate: d("09-06"), hiddenByStaff: true }] },
    { _id: "u6", name: "Nina Staff", email: "nina@example.com", role: "admin", staffRole: "staff", tickets: [] },
  ];
  const attendees = [
    { _id: "a1", name: "Cara Connect", email: "cara@example.com", ticketId: "CON1", ticketType: "connect", stripeSessionId: "cs_c", purchaseDate: d("09-07"),
      checkedIn: true, checkedInAt: new Date("2026-10-27T03:30:00Z") },
    { _id: "a2", name: "Annie Apex", email: "annie@example.com", ticketId: "APX1", ticketType: "apex", stripeSessionId: "cs_a", purchaseDate: d("09-08"),
      checkedIn: true, checkedInAt: new Date("2026-10-27T12:00:00Z") },
    { _id: "a3", name: "Sam Speaker", email: "", ticketId: "SPK1", ticketType: "speaker", promoCode: "SPEAKER", speakerId: "spk-sam", purchaseDate: d("09-09") },
    { _id: "a4", name: "Ed Exhibitor", email: "ed@example.com", ticketId: "EXH1", ticketType: "connect", promoCode: "EXHIBITOR", passEmailSentAt: d("10-01"),
      purchaseDate: d("09-10"), checkedIn: true },
    { _id: "a5", name: "Rita Refund", email: "rita@example.com", ticketId: "RFD1", ticketType: "apex", stripeSessionId: "cs_r", purchaseDate: d("09-11") },
  ];
  const rsvps = [
    rsvp("r1", "POW1", "Pat", "Power", { tier: "power", days: ["day1", "day2"], options: ["lunch_d1", "awards", "gala"], dietary: ["vegetarian"] }),
    rsvp("r2", "CON1", "Cara", "Connect", { tier: "connect", days: ["day1"], options: ["lunch_d1"], staffAdded: ["lunch_d1"], passLimitOverride: true, dietary: ["none"] }),
    rsvp("r3", "APX1", "Annie", "Apex", { tier: "apex", days: ["day2"], options: ["cxo_d2", "lunch_d2", "gala"], dietary: ["halal", "gluten_free", "other"], dietaryOther: "No pork" }),
    rsvp("r4", "EXH1", "Ed", "Exhibitor", { tier: "connect", days: ["day1", "day2"], options: [], dietary: [] }),
    rsvp("r5", "VIP1", "Victor", "Vip", { tier: "connect", days: ["day1"], options: ["cxo_d1"], dietary: ["vegan"] }),
    rsvp("r6", "DBL1", "Dana", "Double", { tier: "power", days: ["day2"], options: ["gala"], dietary: [] }),
    rsvp("r7", "RFD1", "Rita", "Refund", { tier: "apex", days: ["day1"], options: ["cxo_d1"], dietary: ["vegan"] }),
    // A possible duplicate under Ian's name (no proof it's him): not his RSVP until staff decide.
    { _id: "r8", key: "n:ian influence", nameKey: "ian influence", firstName: "Ian", lastName: "Influence", tier: "influence", duplicateOf: "r-missing",
      days: ["day1"], options: ["lunch_d1"], dietary: ["vegan"], createdAt: d("10-11"), updatedAt: d("10-11") },
  ];
  const speakers = [{ _id: "spk-sam", name: "Sam Speaker" }];
  const refunds = new Map([["cs_r", { total: 1499, refunded: 1499 }], ["cs_p", { total: 999, refunded: 0 }]]);
  return buildPeople({ users, attendees, rsvps, speakers, refunds }).people;
}

const summary = () => eventSummary(world(), { builtAt: new Date("2026-10-23T18:00:00Z"), stripe: "ok" });
const row = (s, tier) => s.passes.rows.find((r) => r.tier === tier);
const meal = (s, key) => s.meals.rows.find((m) => m.key === key);

test("Toronto days: Day 1 is Mon 26 Oct and Day 2 Tue 27 Oct in Toronto time, anything else is another day", () => {
  assert.equal(torontoDate("2026-10-27T03:59:00Z"), "2026-10-26");
  assert.equal(eventDayOf("2026-10-26T04:00:00Z"), "day1");
  assert.equal(eventDayOf("2026-10-27T03:59:59Z"), "day1"); // 11:59 PM on the 26th in Toronto
  assert.equal(eventDayOf("2026-10-27T04:00:00Z"), "day2");
  assert.equal(eventDayOf("2026-10-28T03:59:00Z"), "day2");
  assert.equal(eventDayOf("2026-10-28T04:00:00Z"), "other");
  assert.equal(eventDayOf("2026-10-23T15:00:00Z"), "other");
  assert.equal(eventDayOf(null), "");
  assert.equal(eventDayOf("not a date"), "");
});

test("one row per person: two passes count once (listed), pending counted and shown on its own, exhibitors under Connect", () => {
  const s = summary();
  assert.equal(s.totals.people, 8);
  assert.equal(s.passes.total.people, 8);
  assert.equal(s.passes.rows.reduce((n, r) => n + r.people, 0), 8, "the rows add up to the total");
  assert.deepEqual(s.passes.rows.map((r) => r.tier), SUMMARY_TIERS);
  assert.deepEqual(s.passes.rows.map((r) => r.label), ["Power Pass", "Speaker Pass", "Connect Pass", "Influence Pass", "Apex Pass"]);
  assert.equal(row(s, "power").people, 2, "Pat and Dana (once, under her Power Pass)");
  assert.equal(row(s, "connect").people, 3, "Cara, Victor and Ed's exhibitor pass");
  assert.equal(row(s, "speaker").people, 1);
  assert.equal(row(s, "speaker").pending, 1);
  assert.equal(s.totals.pending, 1);
  assert.deepEqual(s.multiPass.map((m) => [m.name, m.countedAs, m.passes.length]), [["Dana Double", "Power Pass", 2]]);
  const ex = s.passes.marks.find((m) => m.key === "exhibitor");
  assert.equal(ex.people, 1);
  assert.equal(s.passes.marks.find((m) => m.key === "vip").people, 1);
  assert.equal(s.passes.marks.find((m) => m.key === "media").people, 0);
});

test("refunded, hidden and staff with no pass are left out; an RSVP without a counting pass is reported, not counted", () => {
  const s = summary();
  assert.equal(row(s, "apex").people, 1, "Annie only: Rita's refunded and Hal's hidden Apex passes don't count");
  assert.equal(s.leftOut.refunded, 1);
  assert.equal(s.leftOut.hidden, 1);
  assert.equal(s.leftOut.staffNoPass, 1);
  assert.equal(s.leftOut.rsvpNoPass, 1);
  assert.deepEqual(s.leftOut.rsvpNoPassPeople.map((p) => [p.name, p.why]), [["Rita Refund", "refunded"]]);
  assert.equal(meal(s, "cxo_d1").rsvpd, 1, "Rita's CxO RSVP isn't counted (Victor's is)");
  // Without Stripe the summary says refunds couldn't be checked.
  const off = eventSummary(world(), { stripe: "off" });
  assert.equal(off.refundsChecked, false);
  assert.equal(off.stripe, "off");
});

test("RSVP'd, not RSVP'd and the day split; a possible duplicate isn't an RSVP", () => {
  const s = summary();
  assert.equal(s.totals.rsvpd, 6);
  assert.equal(s.totals.notRsvpd, 2, "Ian (only a possible duplicate) and Sam");
  assert.equal(s.totals.pct, 75);
  assert.equal(s.totals.day1, 4); // Pat, Cara, Ed, Victor
  assert.equal(s.totals.day2, 4); // Pat, Annie, Ed, Dana
  assert.equal(s.totals.bothDays, 2);
  assert.deepEqual([row(s, "power").rsvpd, row(s, "power").day1, row(s, "power").day2, row(s, "power").pct], [2, 1, 2, 100]);
  assert.deepEqual([row(s, "connect").rsvpd, row(s, "connect").day1, row(s, "connect").day2], [3, 3, 1]);
  assert.deepEqual([row(s, "influence").rsvpd, row(s, "influence").pct], [0, 0]);
  assert.equal(s.passes.total.rsvpd, 6);
});

test("entitled (by pass type, VIP, speaker, staff switch) vs RSVP'd, with RSVPs outside the pass", () => {
  const s = summary();
  assert.deepEqual(s.meals.rows.map((m) => m.key), SUMMARY_MEALS.map((m) => m.key));
  assert.deepEqual(s.meals.rows.map((m) => m.label), [
    "CxO Breakfast · Day 1", "CxO Breakfast · Day 2", "Networking Luncheon · Day 1", "Networking Luncheon · Day 2",
    "Day 1 dinner: Catalyst Awards Night", "Day 2 dinner: Gala Dinner & Networking Reception",
  ]);
  // CxO: Annie (Apex), Sam (Speaker Pass, pending), Victor (VIP).
  assert.deepEqual([meal(s, "cxo_d1").entitled, meal(s, "cxo_d1").entitledPending, meal(s, "cxo_d1").rsvpd], [3, 1, 1]);
  assert.deepEqual([meal(s, "cxo_d2").entitled, meal(s, "cxo_d2").rsvpd], [3, 1]);
  // Luncheons: Pat, Dana (Power), Ian (Influence), Annie (Apex), Sam (Speaker). Cara's staff-added lunch is outside her pass.
  assert.deepEqual([meal(s, "lunch_d1").entitled, meal(s, "lunch_d1").rsvpd, meal(s, "lunch_d1").outsidePass, meal(s, "lunch_d1").pct], [5, 2, 1, 40]);
  assert.deepEqual([meal(s, "lunch_d2").entitled, meal(s, "lunch_d2").rsvpd], [5, 1]);
  // Awards: Power, Apex, Speaker. Gala: the same plus Ian, whose pass staff switched on.
  assert.deepEqual([meal(s, "awards").entitled, meal(s, "awards").rsvpd], [4, 1]);
  assert.deepEqual([meal(s, "gala").entitled, meal(s, "gala").rsvpd, meal(s, "gala").outsidePass], [5, 3, 0]);
  assert.equal(meal(s, "awards").day, "day1");
  assert.equal(meal(s, "gala").day, "day2");
});

test("dietary needs of the people RSVP'd to each meal, and the 'other' notes for catering", () => {
  const s = summary();
  const g = meal(s, "gala");
  assert.deepEqual({ veg: g.dietary.vegetarian, halal: g.dietary.halal, gf: g.dietary.gluten_free, other: g.dietary.other, none: g.noNeeds }, { veg: 1, halal: 1, gf: 1, other: 1, none: 1 });
  assert.equal(meal(s, "lunch_d1").dietary.vegetarian, 1);
  assert.equal(meal(s, "lunch_d1").noNeeds, 1, "Cara ticked None");
  assert.equal(meal(s, "cxo_d1").dietary.vegan, 1);
  assert.ok(!("none" in g.dietary), "None isn't a need");
  assert.ok(s.meals.dietaryKeys.some((k) => k.key === "kosher" && k.label === "Kosher"));
  const all = s.meals.allRsvps;
  assert.deepEqual([all.rsvpd, all.noNeeds, all.dietary.vegan, all.dietary.vegetarian], [6, 3, 1, 1]);
  assert.deepEqual(s.meals.otherNotes.map((n) => [n.name, n.note, n.meals]), [["Annie Apex", "No pork", ["cxo_d2", "lunch_d2", "gala"]]]);
});

test("check-in: the day of each person's first scan in Toronto; no time and other days kept apart; not RSVP'd counted", () => {
  const s = summary();
  const c = s.checkin;
  assert.deepEqual([c.checkedIn, c.day1, c.day2, c.otherDay, c.noTime, c.notRsvpd], [6, 2, 2, 1, 1, 1]);
  assert.equal(c.firstScanOnly, true);
  assert.equal(c.mealScans, false);
  const by = Object.fromEntries(c.byPass.map((r) => [r.tier, [r.checkedIn, r.day1, r.day2]]));
  assert.deepEqual(by, { power: [1, 1, 0], speaker: [0, 0, 0], connect: [3, 1, 0], influence: [1, 0, 1], apex: [1, 0, 1] });
});

test("the answer carries no email addresses, and building it twice gives the same thing", () => {
  const s = summary();
  assert.ok(!JSON.stringify(s).includes("@"));
  assert.deepEqual(summary(), s);
  assert.equal(s.builtAt, "2026-10-23T18:00:00.000Z");
  assert.equal(s.timeZone, "America/Toronto");
});

test("an empty directory gives zeros and no percentages", () => {
  const s = eventSummary([], {});
  assert.equal(s.totals.people, 0);
  assert.equal(s.totals.pct, null);
  assert.ok(s.meals.rows.every((m) => m.entitled === 0 && m.pct === null));
  assert.deepEqual(countingPasses(null), []);
});

/* "Make sure you are not double counting the speakers and power passes" (the organiser, Oct 23 2026).
   Sara: an account with a Speaker Pass and a paid Power Pass. Mona, Sara's communications manager: her own Power
   Pass bought on Sara's email address (a different person: two people). Ken: a Speaker Pass emailed but not claimed,
   plus a paid Influence Pass (the People list shows the paid one; the summary counts him under Speaker). Exa: a
   Speaker Pass plus an exhibitor's Connect Pass. Pia: a Speaker Pass not emailed yet (pending) plus a paid Power Pass. */
function speakersWorld() {
  const users = [
    { _id: "su1", name: "Sara Speaker", email: "sara@example.com", role: "user",
      tickets: [
        { ticketId: "SSPK1", type: "speaker", purchaseDate: d("09-01") },
        { ticketId: "SPOW1", type: "power", purchaseDate: d("09-02"), stripeSessionId: "cs_s" },
      ] },
  ];
  const attendees = [
    { _id: "sa1", name: "Mona Manager", email: "sara@example.com", ticketId: "MPOW1", ticketType: "power", stripeSessionId: "cs_m", purchaseDate: d("09-03"),
      details: { firstName: "Mona", lastName: "Manager" } },
    { _id: "sa2", name: "Ken Keynote", email: "", ticketId: "KSPK1", ticketType: "speaker", promoCode: "SPEAKER", passEmailSentAt: d("10-01"), purchaseDate: d("09-04") },
    { _id: "sa3", name: "Ken Keynote", email: "ken@example.com", ticketId: "KINF1", ticketType: "influence", stripeSessionId: "cs_k", purchaseDate: d("09-05") },
    { _id: "sa4", name: "Exa Speaker", email: "", ticketId: "ESPK1", ticketType: "speaker", promoCode: "SPEAKER", passEmailSentAt: d("10-01"), purchaseDate: d("09-06") },
    { _id: "sa5", name: "Exa Speaker", email: "exa@example.com", ticketId: "EEXH1", ticketType: "connect", promoCode: "EXHIBITOR", passEmailSentAt: d("10-02"), purchaseDate: d("09-07") },
    { _id: "sa6", name: "Pia Panel", email: "", ticketId: "PSPK1", ticketType: "speaker", promoCode: "SPEAKER", purchaseDate: d("09-08") },
    { _id: "sa7", name: "Pia Panel", email: "pia@example.com", ticketId: "PPOW1", ticketType: "power", stripeSessionId: "cs_pia", purchaseDate: d("09-09") },
  ];
  const rsvps = [
    // Sara's RSVP is on her Power Pass's ticket: one person, one RSVP, whichever ticket it came with.
    rsvp("sr1", "SPOW1", "Sara", "Speaker", { tier: "power", days: ["day1", "day2"], options: ["cxo_d1", "lunch_d1", "gala"], dietary: ["vegan"] }),
    rsvp("sr2", "MPOW1", "Mona", "Manager", { tier: "power", days: ["day1"], options: ["lunch_d1", "awards"], dietary: [] }),
    rsvp("sr3", "KSPK1", "Ken", "Keynote", { tier: "speaker", days: ["day2"], options: ["gala"], dietary: ["halal"] }),
  ];
  return buildPeople({ users, attendees, rsvps, refunds: new Map() }).people;
}

test("no double counting: a speaker with a second pass counts once, under Speaker; the rows add up to the total", () => {
  const people = speakersWorld();
  const s = eventSummary(people, { stripe: "ok" });
  assert.equal(s.totals.people, 5, "Sara, Mona (her own pass on Sara's email: a second person), Ken, Exa, Pia");
  const rows = Object.fromEntries(s.passes.rows.map((r) => [r.tier, r.people]));
  assert.deepEqual(rows, { power: 1, speaker: 4, connect: 0, influence: 0, apex: 0 });
  assert.equal(s.passes.rows.reduce((n, r) => n + r.people, 0), s.totals.people, "each person in exactly one pass row");
  assert.equal(s.passes.rows.reduce((n, r) => n + r.rsvpd, 0), s.totals.rsvpd);
  assert.equal(s.passes.total.people, s.totals.people);
  assert.equal(s.totals.pending, 0, "Pia's Speaker Pass isn't sent yet, but her Power Pass can be used");
  assert.deepEqual(s.multiPass.map((m) => [m.name, m.countedAs, m.passes.length]), [
    ["Exa Speaker", "Speaker Pass", 2], ["Ken Keynote", "Speaker Pass", 2], ["Pia Panel", "Speaker Pass", 2], ["Sara Speaker", "Speaker Pass", 2],
  ]);
  // The People list shows the usable pass first; the summary keeps every speaker under Speaker and says what People shows.
  assert.deepEqual(s.multiPass.filter((m) => m.peopleShows !== m.countedAs).map((m) => [m.name, m.peopleShows]), [["Ken Keynote", "Influence Pass"], ["Pia Panel", "Power Pass"]]);
  assert.equal(s.passes.marks.find((m) => m.key === "exhibitor").people, 0, "Exa counts under Speaker, not as an exhibitor's Connect Pass");
  assert.equal(mainPass([]), null);
});

test("no double counting: meals count each person once, whatever passes they hold", () => {
  const s = eventSummary(speakersWorld(), { stripe: "ok" });
  const meal2 = (key) => s.meals.rows.find((m) => m.key === key);
  // Gala and Awards: the four speakers (Speaker Pass, and Sara's and Pia's Power Passes too) + Mona = 5, not 7.
  assert.equal(meal2("gala").entitled, 5);
  assert.equal(meal2("awards").entitled, 5);
  // Luncheons: the same five (Ken's Influence Pass includes them too).
  assert.equal(meal2("lunch_d1").entitled, 5);
  // CxO Breakfasts: the four speakers only.
  assert.equal(meal2("cxo_d1").entitled, 4);
  assert.deepEqual([meal2("gala").rsvpd, meal2("lunch_d1").rsvpd, meal2("cxo_d1").rsvpd, meal2("awards").rsvpd], [2, 2, 1, 1]);
  assert.deepEqual([meal2("gala").dietary.vegan, meal2("gala").dietary.halal], [1, 1]);
  assert.equal(s.meals.allRsvps.rsvpd, 3);
  for (const m of s.meals.rows) assert.ok(m.entitled <= s.totals.people && m.rsvpd <= s.totals.rsvpd, m.key);
});
