import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPeople, passStatus, primaryPass, namesMatch, personRow, personDetail, filterPeople, sortPeople, peopleCounts, peopleCsv,
  PEOPLE_CSV_HEAD, agendaFor, specialEvents, suggestDomain, editInfo,
} from "../services/people.js";
import { companyKey, cleanDomain, domainOfUrl, companyDTO } from "../services/companies.js";
import { passKind } from "../services/teamRoles.js";
import { EXHIBITOR_FILTER } from "../services/exhibitorCache.js";

const d = (s) => new Date(`2026-${s}T12:00:00Z`);

/* A small world: accounts, guest passes of every kind, RSVPs and speakers. */
function world() {
  const users = [
    // Bought a Power Pass on their account; staff gave them the VIP type.
    { _id: "u1", name: "Jane Doe", email: "jane@acme.com", role: "user", types: ["vip"], organization: "Acme Inc.", jobTitle: "CTO", linkedinUrl: "https://linkedin.com/in/jane",
      tickets: [{ ticketId: "AAA111", type: "power", purchaseDate: d("09-01"), stripeSessionId: "cs_1" }] },
    // Staff account, no ticket.
    { _id: "u2", name: "Nicole Staff", email: "nicole@thetechfestival.com", role: "admin", tickets: [] },
    // Claimed a Speaker Pass with the ticket-ID sign-in (placeholder email).
    { _id: "u3", name: "Alán Aspuru-Guzik", email: "spk111@ticket.thetechfestival.com", role: "user", provider: "ticket",
      tickets: [{ ticketId: "SPK111", type: "speaker", purchaseDate: d("09-05") }] },
    // App account with no ticket; a guest pass under the same email but bought for a colleague.
    { _id: "u4", name: "Bob Buyer", email: "bob@globex.com", role: "user", tickets: [] },
    // Bought a booth (BOOTH- ticket) and nothing else.
    { _id: "u5", name: "Booth Owner", email: "booth@initech.com", role: "user", tickets: [{ ticketId: "BOOTH-STARTUP", type: "booth-startup" }] },
  ];
  const attendees = [
    // The guest record of Jane's ticket (claimed copy): same ticket ID.
    { _id: "a1", name: "Jane Doe", email: "jane@acme.com", ticketId: "AAA111", ticketType: "power", stripeSessionId: "cs_1", purchaseDate: d("09-01") },
    // Speaker Pass claimed by u3.
    { _id: "a2", name: "Alán Aspuru-Guzik", email: "", ticketId: "SPK111", ticketType: "speaker", promoCode: "SPEAKER", speakerId: "spk-alan", claimedBy: "u3", passEmailSentAt: d("09-06"), purchaseDate: d("09-05") },
    // Unclaimed Speaker Pass, never emailed → pending.
    { _id: "a3", name: "Michael Chen", email: "", ticketId: "SPK222", ticketType: "speaker", promoCode: "SPEAKER", speakerId: "spk-mike", purchaseDate: d("09-05"),
      details: { organisation: "Chen Labs", jobTitle: "Founder" } },
    // Bob bought for Carol (checkout name) under his email: Carol is her own person.
    { _id: "a4", name: "Carol Colleague", email: "bob@globex.com", ticketId: "CCC333", ticketType: "influence", purchaseDate: d("09-10"), stripeSessionId: "cs_4",
      details: { firstName: "Carol", lastName: "Colleague", organisation: "Globex" } },
    // Carol's second pass (comp, same name, no email): joins her.
    { _id: "a5", name: "Carol Colleague", email: "", ticketId: "CMP444", ticketType: "connect", promoCode: "COMP", purchaseDate: d("09-11") },
    // An exhibitor pass, emailed, unclaimed → issued, not claimed.
    { _id: "a6", name: "Ed Exhibitor", email: "ed@booth.io", ticketId: "EXH555", ticketType: "connect", promoCode: "EXHIBITOR", passEmailSentAt: d("10-01"), issuedPass: { booth: { booth: "B12" } },
      details: { organisation: "Booth IO" } },
    // A staff-hidden test ticket: left out.
    { _id: "a7", name: "Test Person", email: "test@x.com", ticketId: "TST666", ticketType: "apex", hiddenByStaff: true },
    // A refunded purchase.
    { _id: "a8", name: "Rita Refund", email: "rita@x.com", ticketId: "RFD777", ticketType: "apex", stripeSessionId: "cs_8", purchaseDate: d("09-20") },
    // Staff marked this guest as an exhibitor (no exhibitor pass).
    { _id: "a9", name: "Fay Flagged", email: "fay@vendor.co", ticketId: "FLG888", ticketType: "connect", exhibitor: true, purchaseDate: d("09-21") },
  ];
  const rsvps = [
    { _id: "r1", key: "t:aaa111", nameKey: "jane doe", firstName: "Jane", lastName: "Doe", ticketId: "AAA111", ticketVerified: true, tier: "power", tierVerified: true,
      days: ["day1", "day2"], options: ["sessions_d1", "gala", "cxo_d1"], updatedAt: d("10-02"), createdAt: d("10-01"), attendeeSubmittedAt: d("10-02") },
    { _id: "r2", key: "t:cmp444", nameKey: "carol colleague", firstName: "Carol", lastName: "Colleague", ticketId: "CMP444", ticketVerified: true, tier: "connect",
      source: "staff", staffUpdatedBy: "Nicole Staff", staffUpdatedAt: d("10-05"), days: ["day2"], options: [], updatedAt: d("10-05"), createdAt: d("10-05") },
    // Name-only RSVP that matches nobody.
    { _id: "r3", key: "n:walk in", nameKey: "walk in", firstName: "Walk", lastName: "In", tier: "connect", days: ["day1"], options: [], createdAt: d("10-06"), updatedAt: d("10-06") },
    // A possible duplicate of Jane's.
    { _id: "r4", key: "dup:1", nameKey: "jane doe", firstName: "Jane", lastName: "Doe", duplicateOf: "r1", tier: "connect", days: ["day1"], options: [], createdAt: d("10-07"), updatedAt: d("10-07") },
    // Michael's RSVP by name (his Speaker Pass person has his name).
    { _id: "r5", key: "n:michael chen", nameKey: "michael chen", firstName: "Michael", lastName: "Chen", tier: "speaker", days: ["day1"], options: ["awards"], createdAt: d("10-08"), updatedAt: d("10-08") },
  ];
  const speakers = [
    { _id: "spk-alan", name: "Alán Aspuru-Guzik", company: "U of T", title: "Professor", imageUrl: "https://cdn.sanity.io/images/x/alan.jpg" },
    { _id: "spk-mike", name: "Michael J. Chen", company: "Chen Labs" },
    { _id: "spk-chris", name: "Dr. Chris Golden", company: "Golden AI" }, // no pass, no account
  ];
  const companies = [{ nameKey: "acme", name: "Acme", logoUrl: "https://cdn.sanity.io/images/021qtoci/production/acme.png", domain: "acme.com" }];
  const refunds = new Map([["cs_8", { total: 1000, refunded: 1000 }], ["cs_1", { total: 500, refunded: 100 }]]);
  return { users, attendees, rsvps, speakers, companies, refunds };
}

const byName = (people, name) => people.find((p) => p.name === name);

test("one person per human: accounts, passes, speakers and RSVPs joined by ticket, email + name and name key", () => {
  const { people, byId } = buildPeople(world());
  const names = people.map((p) => p.name).sort();
  assert.deepEqual(names, [
    "Alán Aspuru-Guzik", "Bob Buyer", "Booth Owner", "Carol Colleague", "Dr. Chris Golden", "Ed Exhibitor", "Fay Flagged",
    "Jane Doe", "Michael Chen", "Nicole Staff", "Rita Refund", "Walk In",
  ]);
  const jane = byName(people, "Jane Doe");
  assert.equal(jane.id, "u-u1");
  assert.equal(jane.passList.length, 1); // the account ticket and its guest record are one pass
  assert.deepEqual(jane.attendees.map((a) => a._id), ["a1"]);
  assert.equal(byId.get("a-a1"), jane);
  assert.equal(byId.get("r-r1"), jane);
  assert.equal(byId.get("r-r4"), jane); // the possible duplicate is listed with her
  assert.equal(jane.rsvp._id, "r1");
  assert.equal(jane.dupRsvps.length, 1);

  // Bob's account doesn't swallow the pass he bought for Carol; Carol's two passes are one person.
  const bob = byName(people, "Bob Buyer");
  const carol = byName(people, "Carol Colleague");
  assert.equal(bob.passList.length, 0);
  assert.equal(carol.id, "a-a4");
  assert.deepEqual(carol.passList.map((t) => t.ticketId).sort(), ["CCC333", "CMP444"]);
  assert.equal(carol.email, "bob@globex.com");
  assert.equal(carol.company, "Globex");
  assert.equal(carol.rsvp._id, "r2");

  // The claimed Speaker Pass is on the account; the speaker list joins by speakerId.
  const alan = byName(people, "Alán Aspuru-Guzik");
  assert.equal(alan.id, "u-u3");
  assert.equal(alan.email, ""); // placeholder addresses are never shown
  assert.equal(alan.speaker._id, "spk-alan");
  assert.equal(byId.get("s-spk-alan"), alan);
  assert.equal(alan.company, "U of T");
  // Michael: speakerId joins the CMS doc even though the names differ (middle initial); the name-only RSVP joins by name key.
  const mike = byName(people, "Michael Chen");
  assert.equal(mike.speaker._id, "spk-mike");
  assert.equal(mike.rsvp._id, "r5");
  // A speaker with no pass or account is a person of their own.
  assert.equal(byName(people, "Dr. Chris Golden").id, "s-spk-chris");
  // An RSVP nobody matches is a person of its own; hidden test tickets are left out.
  assert.equal(byName(people, "Walk In").id, "r-r3");
  assert.equal(byId.get("a-a7"), undefined);
  // Booth orders aren't passes.
  const booth = byName(people, "Booth Owner");
  assert.deepEqual([booth.passList.length, booth.boothOrders], [0, ["BOOTH-STARTUP"]]);
});

test("pass status from the ticket records (and Stripe refunds)", () => {
  const { people } = buildPeople(world());
  const st = (n) => byName(people, n).primary?.status || "none";
  assert.equal(st("Jane Doe"), "paid"); // a partial refund is still paid
  assert.equal(st("Alán Aspuru-Guzik"), "complimentary"); // Speaker Pass claimed in the app
  assert.equal(st("Michael Chen"), "pending"); // Speaker Pass not emailed yet
  assert.equal(st("Ed Exhibitor"), "issued"); // emailed, not claimed
  assert.equal(st("Rita Refund"), "refunded");
  assert.equal(st("Nicole Staff"), "none");
  assert.equal(st("Dr. Chris Golden"), "none");
  // Carol: a paid Influence beats a comp Connect.
  assert.deepEqual([byName(people, "Carol Colleague").primary.ticketId, st("Carol Colleague")], ["CCC333", "paid"]);
  // Without Stripe there's no "refunded".
  const noStripe = buildPeople({ ...world(), refunds: null }).people;
  assert.equal(byName(noStripe, "Rita Refund").primary.status, "paid");
  // The rules on their own.
  assert.equal(passStatus({ promoCode: "COMP" }), "issued");
  assert.equal(passStatus({ promoCode: "COMP", checkedIn: true }), "complimentary");
  assert.equal(passStatus({ promoCode: "ISSUED" }), "pending");
  assert.equal(passStatus({ promoCode: "ISSUED", passEmailSentAt: d("10-01") }), "issued");
  assert.equal(passStatus({ promoCode: "EARLYBIRD" }), "paid");
  assert.equal(passStatus({ stripeSessionId: "x" }, new Map([["x", { total: 0, refunded: 0 }]])), "paid");
  assert.equal(primaryPass([{ status: "refunded", tier: "apex" }, { status: "paid", tier: "connect" }]).tier, "connect");
  assert.equal(primaryPass([{ status: "paid", tier: "apex", hidden: true }]), null);
});

test("types: effective person types, unclaimed passes and the speaker list", () => {
  const { people } = buildPeople(world());
  const types = (n) => byName(people, n).types;
  assert.deepEqual(types("Jane Doe"), ["vip"]); // VIP only: attendee is automatic only with no other type
  assert.deepEqual(types("Nicole Staff"), ["staff"]);
  assert.deepEqual(types("Alán Aspuru-Guzik"), ["speaker"]);
  assert.deepEqual(types("Michael Chen"), ["speaker"]);
  assert.deepEqual(types("Ed Exhibitor"), ["exhibitor"]);
  assert.deepEqual(types("Fay Flagged"), ["exhibitor"]); // staff's flag gives the type, like an exhibitor pass
  assert.deepEqual(types("Carol Colleague"), ["attendee"]);
  assert.deepEqual(types("Dr. Chris Golden"), ["speaker"]);
  assert.deepEqual(types("Walk In"), []);
  assert.deepEqual(types("Bob Buyer"), []);
  assert.deepEqual(types("Booth Owner"), ["attendee"]); // a booth order counts as holding a ticket in the apps (teamRoles holdsPass)
  // typesOff still wins over an unclaimed pass found for the account.
  const w = world();
  w.users[3].typesOff = ["speaker"];
  w.attendees.push({ _id: "a10", name: "Bob Buyer", email: "bob@globex.com", ticketId: "SPK999", ticketType: "speaker", promoCode: "SPEAKER" });
  assert.deepEqual(byName(buildPeople(w).people, "Bob Buyer").types, ["attendee"]);
});

test("exhibitor: an explicit staff field, default No, separate from the exhibitor pass", () => {
  const { people } = buildPeople(world());
  const ex = (n) => [byName(people, n).exhibitor, byName(people, n).exhibitorPass];
  assert.deepEqual(ex("Jane Doe"), [false, false]);
  assert.deepEqual(ex("Ed Exhibitor"), [false, true]); // has an exhibitor pass, but staff haven't said Yes
  assert.deepEqual(ex("Fay Flagged"), [true, false]);
  const w = world();
  w.users[0].types = ["vip", "exhibitor"];
  assert.equal(byName(buildPeople(w).people, "Jane Doe").exhibitor, true);
  // The app's exhibitor inference reads the same flag.
  assert.equal(passKind({ exhibitor: true }), "exhibitor");
  assert.equal(passKind({ promoCode: "EXHIBITOR" }), "exhibitor");
  assert.equal(passKind({}), "");
  assert.deepEqual(EXHIBITOR_FILTER, { $or: [{ promoCode: "EXHIBITOR" }, { exhibitor: true }] });
});

test("companies: everyone at a company shows its logo; a person's own logo wins", () => {
  const w = world();
  w.attendees.push({ _id: "a11", name: "Ann Acme", email: "ann@acme.com", ticketId: "ACM001", ticketType: "connect", details: { organisation: "ACME" } });
  w.attendees.push({ _id: "a12", name: "Al Acme", email: "al@acme.com", ticketId: "ACM002", ticketType: "connect", details: { organisation: "Acme Ltd" }, companyLogoUrl: "https://res.cloudinary.com/x/own.png" });
  const { people } = buildPeople(w);
  for (const n of ["Jane Doe", "Ann Acme"]) {
    assert.deepEqual([byName(people, n).companyKey, byName(people, n).logoFrom], ["acme", "company"]);
    assert.match(byName(people, n).logoUrl, /acme\.png$/);
  }
  assert.deepEqual([byName(people, "Al Acme").logoFrom, byName(people, "Al Acme").logoUrl], ["person", "https://res.cloudinary.com/x/own.png"]);
  assert.deepEqual([byName(people, "Ed Exhibitor").logoUrl, byName(people, "Ed Exhibitor").logoFrom], ["", ""]);
  assert.equal(companyKey("Dell Technologies, Inc."), "dell technologies");
  assert.equal(companyKey("The Toronto-Dominion Bank"), "toronto dominion bank");
  assert.equal(companyKey("AT&T"), "at and t");
  assert.equal(companyKey("Société Générale S.A."), "societe generale");
  assert.equal(companyKey("Inc"), "inc");
  assert.equal(companyKey(""), "");
  assert.deepEqual(cleanDomain("https://www.Acme.com/about"), { host: "www.acme.com", domain: "acme.com" });
  assert.deepEqual(cleanDomain("acme.co.uk"), { host: "acme.co.uk", domain: "acme.co.uk" });
  for (const bad of ["localhost", "10.0.0.1", "http://acme.com:8080", "ftp://acme.com", "https://user@acme.com", "acme", "", "a b.com"]) assert.equal(cleanDomain(bad), null, bad);
  assert.equal(domainOfUrl("https://www.dell.com/en-ca"), "dell.com");
  assert.equal(companyDTO(null), null);
  assert.equal(companyDTO({ nameKey: "acme", logoUrl: "u" }).key, "acme");
});

test("RSVP status on the row: not yet, the attendee's, or staff's; duplicates don't count", () => {
  const { people } = buildPeople(world());
  const row = (n) => personRow(byName(people, n));
  assert.deepEqual([row("Jane Doe").rsvp.status, row("Jane Doe").rsvp.id, row("Jane Doe").rsvpDuplicates], ["attendee", "r1", 1]);
  assert.deepEqual([row("Carol Colleague").rsvp.status, row("Carol Colleague").rsvp.by], ["staff", "Nicole Staff"]);
  assert.equal(row("Bob Buyer").rsvp.status, "none");
  const r = row("Jane Doe");
  assert.deepEqual([r.pass.label, r.pass.status, r.passStatusLabel, r.company, r.hasAccount], ["Power Pass", "paid", "Paid", "Acme Inc.", true]);
  assert.equal(row("Ed Exhibitor").pass.label, "Exhibitor Pass");
  assert.equal(row("Alán Aspuru-Guzik").photoUrl, "https://cdn.sanity.io/images/x/alan.jpg");
});

test("search, filters, sorting and counts", () => {
  const { people } = buildPeople(world());
  const names = (list) => list.map((p) => p.name);
  assert.deepEqual(names(filterPeople(people, { q: "acme" })), ["Jane Doe"]);
  assert.deepEqual(names(filterPeople(people, { q: "cmp444" })), ["Carol Colleague"]);
  assert.deepEqual(names(filterPeople(people, { q: "alan guzik" })), ["Alán Aspuru-Guzik"]);
  assert.deepEqual(names(filterPeople(people, { type: "speaker" })).sort(), ["Alán Aspuru-Guzik", "Dr. Chris Golden", "Michael Chen"]);
  assert.deepEqual(names(filterPeople(people, { type: "none" })).sort(), ["Bob Buyer", "Walk In"]);
  assert.deepEqual(names(filterPeople(people, { status: "pending" })), ["Michael Chen"]);
  assert.deepEqual(names(filterPeople(people, { pass: "power" })), ["Jane Doe"]);
  assert.equal(filterPeople(people, { pass: "none" }).length, 5);
  assert.deepEqual(names(filterPeople(people, { rsvp: "staff" })), ["Carol Colleague"]);
  assert.equal(filterPeople(people, { rsvp: "any" }).length, 4);
  assert.equal(filterPeople(people, { rsvp: "none" }).length, 8);
  assert.deepEqual(names(filterPeople(people, { exhibitor: "yes" })), ["Fay Flagged"]);
  assert.equal(filterPeople(people, { exhibitor: "no" }).length, 11);
  assert.equal(filterPeople(people, { type: "nonsense", status: "x" }).length, 12); // unknown filters are ignored

  assert.equal(sortPeople(people)[0].name, "Alán Aspuru-Guzik");
  assert.equal(sortPeople(people, "name", "desc")[0].name, "Walk In");
  const byCompany = sortPeople(people, "company");
  assert.equal(byCompany[0].company, "Acme Inc.");
  assert.equal(byCompany.at(-1).company, ""); // blanks last
  assert.equal(sortPeople(people, "company", "desc").at(-1).company, "");
  assert.equal(sortPeople(people, "pass", "desc")[0].primary.tier, "speaker");
  assert.equal(sortPeople(people, "rsvp", "desc")[0].name, "Michael Chen"); // latest RSVP first
  assert.equal(sortPeople(people, "exhibitor")[0].name, "Fay Flagged");

  const c = peopleCounts(people);
  assert.equal(c.total, 12);
  assert.deepEqual([c.byType.speaker, c.byType.exhibitor, c.byType.vip, c.byType.none], [3, 2, 1, 2]);
  assert.deepEqual([c.byStatus.paid, c.byStatus.pending, c.byStatus.refunded, c.byStatus.none], [3, 1, 1, 5]);
  assert.deepEqual([c.byRsvp.attendee, c.byRsvp.staff, c.byRsvp.none], [3, 1, 8]);
  assert.equal(c.exhibitors, 1);
});

test("CSV export: one row per person with pass, RSVP and a profile link", () => {
  const { people } = buildPeople(world());
  const csv = peopleCsv(sortPeople(filterPeople(people, { q: "jane" })), { profileBase: "https://www.thetechfestival.com/" });
  const [head, line] = csv.replace(/^﻿/, "").split("\n");
  assert.equal(head.split(",").length, PEOPLE_CSV_HEAD.length);
  assert.match(line, /^Jane Doe,jane@acme\.com,VIP,Acme Inc\.,CTO,Power Pass,AAA111,Paid,1,RSVP'd by attendee,Attendee,/);
  assert.match(line, /Day 1 & Day 2,CxO Breakfast \(Day 1\); Gala Dinner & Networking Reception \(Day 2\),No,/);
  assert.match(line, /,https:\/\/www\.thetechfestival\.com\/admin\/people\/u-u1$/);
  // Formula-looking cells are escaped like every other export.
  const w = world();
  w.users[0].organization = "=HYPERLINK(1)";
  assert.match(peopleCsv(buildPeople(w).people), /'=HYPERLINK/);
});

test("profile: passes, special events, the agenda from the app, a domain to search, what can be edited", () => {
  const { people } = buildPeople(world());
  const jane = byName(people, "Jane Doe");
  const det = personDetail(jane, { management: false, cmsLogos: [] });
  assert.deepEqual(det.passes.map((p) => [p.ticketId, p.status, p.claimed]), [["AAA111", "paid", true]]);
  assert.deepEqual(det.specialEvents.map((e) => e.key), ["cxo_d1", "gala"]); // the conference days themselves aren't events
  assert.equal(det.specialEvents[1].day, "Day 2");
  assert.deepEqual([det.edit.where, det.edit.canEdit, det.edit.canEditEmail], ["account", true, false]);
  assert.equal(det.suggestedDomain, "acme.com"); // the company record's
  assert.equal(personDetail(jane, { management: true }).edit.canEditEmail, true);
  // Staff accounts: management only.
  assert.equal(editInfo(byName(people, "Nicole Staff"), { management: false }).canEdit, false);
  // Nowhere to save: a speaker with no pass, an RSVP-only person.
  assert.deepEqual([editInfo(byName(people, "Walk In")).where, editInfo(byName(people, "Walk In")).canEditRsvp], ["none", true]);
  // Domains from a website partner with the same name, then a work email.
  const ed = byName(people, "Ed Exhibitor");
  assert.equal(suggestDomain(ed, [{ name: "Booth IO", url: "https://www.booth.io/" }]), "booth.io");
  assert.equal(suggestDomain(byName(people, "Rita Refund"), []), "x.com"); // from the work email
  assert.equal(suggestDomain(byName(people, "Michael Chen"), []), ""); // no email, no company record
  assert.equal(specialEvents(null).length, 0);

  const agenda = [
    { _id: "s-b", sessionId: "d2-03", day: 2, time: "10:00", endTime: "10:30", title: "Quantum now", stage: "Pier 5" },
    { _id: "s-a", sessionId: "d1-06", day: 1, time: "14:00", endTime: "14:45", title: "AI in banks", stage: "Harbour Ballroom", type: "Panel" },
  ];
  const sessions = agendaFor(["d2-03", "s-a", "gone-1", "d2-03"], agenda);
  assert.deepEqual(sessions.map((s) => [s.id, s.found, s.title, s.day]), [["s-a", true, "AI in banks", 1], ["d2-03", true, "Quantum now", 2], ["gone-1", false, "", null]]);
  assert.equal(sessions[0].stage, "Harbour Ballroom");
  assert.deepEqual(agendaFor(["x"], null).map((s) => s.found), [false]); // agenda unreadable: ids still listed
});

test("names: accents, middle names, honorifics and nicknames", () => {
  assert.equal(namesMatch("Jane Doe", { firstName: "jane", lastName: "DOE" }), true);
  assert.equal(namesMatch("Dr. Jane Q. Doe", "Jane Doe"), true);
  assert.equal(namesMatch("Alán Aspuru-Guzik", "Alan Aspuru Guzik"), true);
  assert.equal(namesMatch("Bob Buyer", { firstName: "Carol", lastName: "Colleague" }), false);
  assert.equal(namesMatch("", "Jane Doe"), false);
});

test("listing never needs anything but the records it's given", () => {
  // No speakers, companies or refunds: still one row each.
  const { people } = buildPeople({ users: world().users, attendees: [], rsvps: [] });
  assert.equal(people.length, 5);
  assert.deepEqual(buildPeople().people, []);
});
