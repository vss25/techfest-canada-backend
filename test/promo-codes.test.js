import test from "node:test";
import assert from "node:assert/strict";
import { codeOf, codeView, codesForTickets, discountMap, STAFF_MARKERS, NO_CODE, UNKNOWN_CODE, cleanCode } from "../services/promoCodes.js";
import { collectTickets, filterByCode, matchRows } from "../services/staffTickets.js";
import { rsvpCode, rsvpListPayload, rsvpRow, rsvpTicketId, rsvpsCsv, CSV_HEAD } from "../services/rsvp.js";
import { buildPeople, filterPeople, personRow, sortPeople, peopleCsv, PEOPLE_CSV_HEAD } from "../services/people.js";

/* The coupon code a ticket was bought with, on the People, RSVP and Tickets pages (Oct 20 2026, the organiser:
   "show what coupon code did the person use to purchase the ticket"). Staff-made passes' internal markers are
   never shown as a coupon. Fictional people, example.com. */

const discounts = discountMap([{ code: "SPRING20", discount: 20 }, { code: "half", discount: 50 }, { code: "BAD", discount: 0 }]);

test("codeOf: the buyer's code with its discount, 'No code', a staff pass, or '—'", () => {
  assert.deepEqual(codeView(codeOf({ promoCode: "spring20", stripeSessionId: "cs_1", type: "power" }, { discounts })),
    { kind: "code", code: "SPRING20", discount: 20, label: "SPRING20 · 20% off" });
  assert.deepEqual(codeOf({ promoCode: "HALF" }, { discounts }).label, "HALF · 50% off");
  // A code whose Promo row is gone (or never had a discount): just the code.
  assert.deepEqual(codeView(codeOf({ promoCode: "OLDCODE", stripeSessionId: "cs_2" }, { discounts })), { kind: "code", code: "OLDCODE", discount: null, label: "OLDCODE" });
  assert.equal(codeOf({ promoCode: "BAD" }, { discounts }).label, "BAD");
  // Bought through the checkout without a code: a Stripe session, or the field saved empty.
  assert.deepEqual(codeView(codeOf({ promoCode: "", stripeSessionId: "cs_3", type: "connect" })), { kind: "none", code: "", discount: null, label: NO_CODE });
  assert.equal(codeOf({ stripeSessionId: "cs_4" }).label, "No code");
  assert.equal(codeOf({ promoCode: "" }).label, "No code");
  // Nothing on record.
  assert.deepEqual(codeView(codeOf({ type: "connect" })), { kind: "unknown", code: "", discount: null, label: UNKNOWN_CODE });
  assert.equal(codeOf([]).label, "—");
  assert.equal(codeOf(null).label, "—");
  assert.equal(cleanCode("  spring20 "), "SPRING20");
});

test("codeOf: every internal marker is a staff pass, never a coupon", () => {
  assert.deepEqual(STAFF_MARKERS, { ISSUED: "Given by staff", COMP: "Complimentary", EXHIBITOR: "Given by staff · exhibitor", SPEAKER: "Speaker Pass" });
  for (const [marker, label] of Object.entries(STAFF_MARKERS)) {
    const c = codeOf({ promoCode: marker.toLowerCase(), type: "connect" }, { discounts });
    assert.deepEqual([c.kind, c.label, c.code], ["staff", label, ""], marker);
  }
  // A Speaker Pass with no Stripe payment is staff-made whatever its field says; one bought then changed keeps its code.
  assert.equal(codeOf({ type: "speaker" }).label, "Speaker Pass");
  assert.equal(codeOf({ type: "speaker", promoCode: "" }).label, "Speaker Pass");
  assert.equal(codeOf({ type: "speaker", promoCode: "SPRING20", stripeSessionId: "cs_5" }, { discounts }).label, "SPRING20 · 20% off");
  // A pass claimed in the app: the account's copy has no code, its pass row keeps the marker.
  assert.equal(codeOf([{ type: "power" }, { promoCode: "ISSUED", ticketType: "power" }]).label, "Given by staff");
  // A guest purchase claimed in the app: the code from its pass row.
  assert.equal(codeOf([{ type: "power" }, { promoCode: "SPRING20", stripeSessionId: "cs_6" }], { discounts }).label, "SPRING20 · 20% off");
  // Never "Exhibitor Pass": exhibitors hold Connect Passes.
  assert.doesNotMatch(Object.values(STAFF_MARKERS).join(" "), /Exhibitor Pass/i);
});

test("Tickets page rows: the code on every row, searchable, ANY = coupon codes only, the account's claimed pass row counts", () => {
  const users = [{ _id: "u1", name: "Pat Example", email: "pat@example.com", tickets: [
    { ticketId: "aaa111", type: "power", promoCode: "SPRING20", stripeSessionId: "cs_1", purchaseDate: new Date("2026-10-01") },
    { ticketId: "bbb222", type: "connect", purchaseDate: new Date("2026-10-02") }, // claimed issued pass: no code on the account's copy
  ] }];
  const guests = [
    { ticketId: "bbb222", name: "Pat Example", email: "pat@example.com", ticketType: "connect", promoCode: "ISSUED", claimedBy: "u1" },
    { ticketId: "ccc333", name: "Gus Example", email: "gus@example.com", ticketType: "influence", promoCode: "", stripeSessionId: "cs_3", purchaseDate: new Date("2026-10-03") },
    { ticketId: "ddd444", name: "Cara Example", email: "cara@example.com", ticketType: "connect", promoCode: "COMP", purchaseDate: new Date("2026-10-04") },
    { ticketId: "eee555", name: "Old Example", email: "old@example.com", ticketType: "connect", purchaseDate: new Date("2026-08-01") },
  ];
  const rows = collectTickets(users, guests, { discounts });
  const by = Object.fromEntries(rows.map((r) => [r.ticketId, r.code.label]));
  assert.deepEqual(by, { aaa111: "SPRING20 · 20% off", bbb222: "Given by staff", ccc333: "No code", ddd444: "Complimentary", eee555: "—" });
  assert.deepEqual(matchRows(rows, "spring20").map((r) => r.ticketId), ["aaa111"]);
  assert.deepEqual(matchRows(rows, "COMP").map((r) => r.ticketId), []); // a marker isn't a code to search for
  assert.deepEqual(filterByCode(rows, "any").map((r) => r.ticketId), ["aaa111"]);
  assert.deepEqual(filterByCode(rows, "SPRING20").map((r) => r.ticketId), ["aaa111"]);
  assert.deepEqual(filterByCode(rows, "ISSUED"), []);
  assert.equal(filterByCode(rows, "").length, rows.length);
  // Without discounts (older callers): the code alone.
  assert.equal(collectTickets(users, guests).find((r) => r.ticketId === "aaa111").code.label, "SPRING20");
});

test("RSVP page: the code of the ticket each RSVP belongs to, in the rows, the drawer and the CSV", () => {
  const codes = new Map([["aaa111", { kind: "code", code: "SPRING20", discount: 20, label: "SPRING20 · 20% off" }]]);
  const verified = { _id: "r1", key: "t:aaa111", ticketId: "AAA111", ticketVerified: true, firstName: "Pat", lastName: "Example", tier: "power" };
  const byKey = { _id: "r2", key: "t:aaa111", firstName: "Pat", lastName: "Example", tier: "power" };
  const speaker = { _id: "r3", key: "n:sol example", kind: "speaker", firstName: "Sol", lastName: "Example", tier: "speaker" };
  assert.equal(rsvpTicketId(verified), "aaa111");
  assert.equal(rsvpTicketId(byKey), "aaa111");
  assert.equal(rsvpTicketId(speaker), "");
  assert.equal(rsvpTicketId({ ticketId: "zzz", ticketVerified: false, key: "n:x" }), "");
  assert.equal(rsvpCode(verified, codes).label, "SPRING20 · 20% off");
  assert.equal(rsvpCode(speaker, codes).label, "—");
  assert.equal(rsvpCode(verified, null), undefined);
  assert.equal(rsvpRow(verified, codes).code.label, "SPRING20 · 20% off");
  assert.equal("code" in rsvpRow(verified), false);       // no codes given: no field (older callers, e.g. People)
  assert.equal("code" in rsvpRow(verified, 0), false);    // .map(rsvpRow) passes an index
  const p = rsvpListPayload({ rows: [verified, speaker], codes });
  assert.deepEqual(p.rows.map((r) => r.code.label), ["SPRING20 · 20% off", "—"]);
  const i = CSV_HEAD.indexOf("Code");
  assert.equal(CSV_HEAD[i - 1], "Ticket ID");
  const [, line] = rsvpsCsv([verified], codes).slice(1).split("\n");
  assert.equal(line.split(",")[i], "SPRING20 · 20% off");
});

test("People: each pass's code, the directory's, search by code, sort by code, the CSV", () => {
  const w = {
    users: [
      { _id: "u1", name: "Pat Example", email: "pat@example.com", role: "user", tickets: [{ ticketId: "aaa111", type: "power", promoCode: "SPRING20", stripeSessionId: "cs_1", purchaseDate: new Date("2026-10-01") }] },
      { _id: "u2", name: "Nia Example", email: "nia@example.com", role: "user", tickets: [{ ticketId: "fff666", type: "influence", promoCode: "", stripeSessionId: "cs_9", purchaseDate: new Date("2026-10-01") }] },
    ],
    attendees: [
      { _id: "a1", name: "Gia Example", email: "gia@example.com", ticketId: "ggg777", ticketType: "power", promoCode: "ISSUED", purchaseDate: new Date("2026-10-02") },
      { _id: "a2", name: "Sol Example", email: "", ticketId: "spk888", ticketType: "speaker", promoCode: "SPEAKER", purchaseDate: new Date("2026-10-02") },
      { _id: "a3", name: "Hal Example", email: "hal@example.com", ticketId: "hhh999", ticketType: "connect", promoCode: "HALF", stripeSessionId: "cs_h", purchaseDate: new Date("2026-10-03") },
    ],
    rsvps: [], speakers: [], companies: [],
    promos: [{ code: "SPRING20", discount: 20 }, { code: "HALF", discount: 50 }],
  };
  const { people } = buildPeople(w);
  const by = (n) => people.find((p) => p.name === n);
  const label = (n) => personRow(by(n)).pass?.code?.label;
  assert.equal(label("Pat Example"), "SPRING20 · 20% off");
  assert.equal(label("Nia Example"), "No code");
  assert.equal(label("Gia Example"), "Given by staff");
  assert.equal(label("Sol Example"), "Speaker Pass");
  assert.equal(label("Hal Example"), "HALF · 50% off");
  assert.deepEqual(filterPeople(people, { q: "spring20" }).map((p) => p.name), ["Pat Example"]);
  assert.deepEqual(filterPeople(people, { q: "issued" }).map((p) => p.name), []);
  assert.deepEqual(sortPeople(people, "code").map((p) => p.name), ["Hal Example", "Pat Example", "Nia Example", "Gia Example", "Sol Example"]);
  const i = PEOPLE_CSV_HEAD.indexOf("Code");
  assert.equal(PEOPLE_CSV_HEAD[i - 1], "Pass status");
  const csv = peopleCsv(sortPeople(filterPeople(people, { q: "pat" })));
  assert.equal(csv.slice(1).split("\n")[1].split(",")[i], "SPRING20 · 20% off");
  // Without promo rows (older callers): the code alone.
  assert.equal(personRow(buildPeople({ ...w, promos: undefined }).people.find((p) => p.name === "Pat Example")).pass.code.label, "SPRING20");
});

test("codesForTickets: one query per collection, account copy first, normalised IDs, '—' for unknown tickets", async () => {
  const calls = [];
  const lean = (v) => ({ select: () => ({ lean: async () => v }) });
  const User = { find: (q) => { calls.push(["User", q]); return lean([{ tickets: [{ ticketId: "AAA111", type: "power" }, { ticketId: "zzz", type: "connect", promoCode: "X" }] }]); } };
  const Attendee = { find: (q) => { calls.push(["Attendee", q]); return lean([{ ticketId: "aaa111", promoCode: "SPRING20", stripeSessionId: "cs_1", ticketType: "power" }, { ticketId: "bbb222", promoCode: "EXHIBITOR", ticketType: "connect" }]); } };
  const Promo = { find: () => { calls.push(["Promo"]); return lean([{ code: "SPRING20", discount: 20 }]); } };
  const m = await codesForTickets(["AAA111", " bbb222 ", "TECHFEST:ccc333", "", "aaa111"], { User, Attendee, Promo });
  assert.deepEqual([...m.keys()], ["aaa111", "bbb222", "ccc333"]);
  assert.equal(m.get("aaa111").label, "SPRING20 · 20% off");
  assert.equal(m.get("bbb222").label, "Given by staff · exhibitor");
  assert.equal(m.get("ccc333").label, "—");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1][1].ticketId.$in.sort(), ["AAA111", "BBB222", "CCC333", "aaa111", "bbb222", "ccc333"]);
  assert.equal((await codesForTickets([], { User, Attendee, Promo })).size, 0);
  assert.equal(calls.length, 3); // nothing to look up: no queries
});
