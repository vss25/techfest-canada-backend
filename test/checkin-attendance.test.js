/* TTFC Check-in desk: attendance by day (contract C10, services/checkinAttendance.js attendanceFrom), pure: from the
   People directory (buildPeople), the desk's marks, the collected tickets and the NO DETAILS FOUND cards. Each person
   once per point and day (a two-pass speaker), practice marks never, overrides counted on their own, Media = Yes at the
   breakfast, the Event summary's own entitled / RSVP'd, colour groups without double counting, ISSUE PASS, unmatched
   marks, passes collected to date, the cards. Fictional people. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPeople } from "../services/people.js";
import { eventSummary } from "../services/eventSummary.js";
import { attendanceFrom, ATTENDANCE_GROUPS } from "../services/checkinAttendance.js";

const t = (ticketId, type, extra = {}) => ({ ticketId, type, purchaseDate: new Date("2026-10-01"), ...extra });
const at = new Date("2026-10-15T12:00:00Z");
const rsvp = (key, first, last, options, extra = {}) => ({ _id: `r-${key}`, key, firstName: first, lastName: last, ticketVerified: true, kind: "ticket", source: "attendee",
  attendeeSubmittedAt: at, days: ["day1"], options, ...extra });

function directory() {
  const users = [
    { _id: "u1", name: "Sid Twopass", email: "sid@example.com", tickets: [t("spk000000001", "speaker"), t("pow000000002", "power", { stripeSessionId: "cs1" })] },
    { _id: "u2", name: "Priya Power", email: "priya@example.com", tickets: [t("pow000000003", "power", { stripeSessionId: "cs2", checkedIn: true, checkedInAt: new Date("2026-10-26T12:00:00Z") })] },
    { _id: "u3", name: "Sia Speaker", email: "sia@example.com", types: ["speaker"] },
    { _id: "u4", name: "Vic Vip", email: "vic@example.com", vip: true, tickets: [t("con000000004", "connect", { stripeSessionId: "cs3" })] },
  ];
  const attendees = [
    { _id: "a1", name: "Mo Media", email: "mo@example.com", ticketId: "con000000005", ticketType: "connect", media: true, stripeSessionId: "cs4" },
    { _id: "a2", name: "Ana Apex", email: "ana@example.com", ticketId: "apx000000006", ticketType: "apex", stripeSessionId: "cs5", checkedIn: true, checkedInAt: new Date("2026-10-27T12:00:00Z") },
    { _id: "a3", name: "Old Pass", email: "old@example.com", ticketId: "con000000007", ticketType: "connect", stripeSessionId: "cs6", checkedIn: true },
  ];
  const rsvps = [
    rsvp("t:spk000000001", "Sid", "Twopass", ["cxo_d1", "lunch_d1"]),
    rsvp("t:con000000005", "Mo", "Media", ["cxo_d1"]),
    rsvp("t:apx000000006", "Ana", "Apex", ["cxo_d1", "gala"], { days: ["day1", "day2"] }),
  ];
  return buildPeople({ users, attendees, rsvps, speakers: [] });
}
const mark = (subject, point, day, hhmmZ, extra = {}) => ({ subject, point, day, at: new Date(`${day}T${hhmmZ}:00Z`), override: "", practice: false, ...extra });

test("each person once per point and day; practice marks never; overrides counted; the Event summary's entitled and RSVP'd", () => {
  const d = directory();
  const marks = [
    // Sid: arrived on his Speaker Pass, checked in (and arrived) on his Power Pass: one person.
    mark("spk000000001", "arrived", "2026-10-26", "11:00"),
    mark("pow000000002", "checked_in", "2026-10-26", "11:05"),
    mark("pow000000002", "arrived", "2026-10-26", "11:05"),
    // Mo (Media = Yes) at the breakfast; Ana let in after the doors closed (an override).
    mark("con000000005", "cxo", "2026-10-26", "12:10"),
    mark("apx000000006", "cxo", "2026-10-26", "14:00", { override: "outside_window" }),
    // Vic (VIP) arrived; a practice mark for Priya on Day 1 (never counted) and a cleared one.
    mark("con000000004", "arrived", "2026-10-26", "12:00"),
    mark("pow000000003", "arrived", "2026-10-26", "12:00", { practice: true }),
    { subject: "pow000000003", point: "checked_in", day: "2026-10-26", at: null },
    // Sia: ISSUE PASS, arrived and handed a pass at the desk.
    mark("person:u-u3", "arrived", "2026-10-26", "12:30"),
    mark("person:u-u3", "checked_in", "2026-10-26", "12:35"),
    // A pass nobody in the directory holds (deleted since), a booth, a rehearsal day.
    mark("zzz000000099", "arrived", "2026-10-26", "13:00"),
    mark("booth:a1", "booth", "2026-10-26", "10:00"),
    mark("con000000005", "arrived", "2026-10-25", "13:00", { practice: true }),
    // Day 2: Sid and Ana at the Gala.
    mark("spk000000001", "arrived", "2026-10-27", "11:00"),
    mark("apx000000006", "evening", "2026-10-27", "21:40"),
  ];
  const collected = [
    { norm: "pow000000003", at: new Date("2026-10-26T12:00:00Z") }, // Priya, Day 1
    { norm: "apx000000006", at: new Date("2026-10-27T12:00:00Z") }, // Ana, Day 2
    { norm: "con000000007", at: null }, // collected long ago, no time recorded
    { norm: "zzz000000099", at: new Date("2026-10-26T13:00:00Z") }, // nobody's
  ];
  const cards = [
    { key: "u:a1", day: "2026-10-26", status: "open" }, { key: "u:a2", day: "2026-10-26", status: "sent_to_help" },
    { key: "u:a3", day: "2026-10-26", status: "linked" }, { key: "u:a4", day: "2026-10-27", status: "left" },
    { key: "u:a5", day: "2026-10-26", status: "pass_issued" }, { key: "u:a6", day: "2026-10-25", status: "open", practice: true },
  ];
  const a = attendanceFrom({ people: d.people, byId: d.byId, marks, collected, cards, peopleAt: new Date("2026-10-26T15:00:00Z"), now: new Date("2026-10-26T15:01:00Z") });
  const [d1, d2] = a.days;
  assert.deepEqual([d1.day, d1.date, d1.label, d2.day, d2.date], ["day1", "2026-10-26", "Day 1", "day2", "2026-10-27"]);
  assert.equal(d1.arrived, 4, "Sid once, Vic, Sia, and the unmatched pass");
  assert.equal(d1.checkedIn, 2, "Sid, Sia");
  assert.equal(d1.unmatched, 1);
  assert.equal(d1.passesCollectedToDate, 2, "Priya (Day 1) and the old pass with no time; Ana's is Day 2's");
  assert.equal(d2.passesCollectedToDate, 3);
  // The Event summary's entitled and RSVP'd, each person once.
  const s = eventSummary(d.people);
  const row = (k) => s.meals.rows.find((m) => m.key === k);
  assert.deepEqual(d1.meals.cxo, {
    key: "cxo_d1", label: "CxO Breakfast", admitted: 2, entitled: row("cxo_d1").entitled, rsvpd: row("cxo_d1").rsvpd, admittedOfRsvpd: 2, pctOfRsvpd: 67,
    noShows: 1, overrides: 1, notRsvpdAdmitted: 0, notEntitledAdmitted: 0,
  });
  assert.equal(d1.meals.cxo.entitled, 4, "Sid (speaker), Vic (VIP), Mo (Media = Yes), Ana (Apex)");
  assert.equal(d1.meals.cxo.rsvpd, 3);
  assert.deepEqual([d1.meals.lunch.key, d1.meals.lunch.rsvpd, d1.meals.lunch.admitted, d1.meals.lunch.noShows], ["lunch_d1", 1, 0, 1]);
  assert.deepEqual([d1.meals.dinner.key, d1.meals.dinner.label], ["awards", "Catalyst Awards Night"]);
  assert.deepEqual([d2.meals.dinner.key, d2.meals.dinner.label, d2.meals.dinner.admitted, d2.meals.dinner.admittedOfRsvpd, d2.meals.dinner.entitled],
    ["gala", "Gala Dinner & Networking Reception", 1, 1, row("gala").entitled]);
  // Colour groups: each person in one (Vic VIP, not also Connect; Mo Media; Sid Speaker), unmatched under Other.
  assert.deepEqual(Object.keys(d1.byPass), ATTENDANCE_GROUPS);
  assert.deepEqual([d1.byPass.vip.arrived, d1.byPass.connect.arrived, d1.byPass.speaker.arrived, d1.byPass.speaker.checkedIn, d1.byPass.other.arrived], [1, 0, 1, 1, 1]);
  assert.deepEqual([d1.byPass.media.cxo, d1.byPass.apex.cxo, d1.byPass.connect.cxo], [1, 1, 0]);
  assert.deepEqual([d1.byPass.vip.people, d1.byPass.media.people, d1.byPass.speaker.people], [1, 1, 1]);
  assert.deepEqual(d1.issuePass, { people: 1, arrived: 1, issued: 1, arrivedNoPass: 1 });
  assert.equal(Object.values(d1.byPass).reduce((n, x) => n + x.arrived, 0) + d1.issuePass.arrivedNoPass, d1.arrived);
  assert.deepEqual(d1.noDetails, { recorded: 4, open: 1, sentToHelp: 1, passIssued: 1, left: 0, linked: 1 });
  assert.deepEqual(d2.noDetails, { recorded: 1, open: 0, sentToHelp: 0, passIssued: 0, left: 1, linked: 0 });
  assert.equal(d2.arrived, 1);
  assert.deepEqual(a.overall, { arrived: 4, checkedIn: 2, bothDays: 1 });
  assert.equal(a.builtAt, "2026-10-26T15:01:00.000Z");
  assert.equal(a.peopleAt, "2026-10-26T15:00:00.000Z");
  assert.equal(a.practiceExcluded, true);
});

test("nothing marked: zeros, and the entitled / RSVP'd still there", () => {
  const d = directory();
  const a = attendanceFrom({ people: d.people, byId: d.byId });
  assert.equal(a.days[0].arrived, 0);
  assert.equal(a.days[0].meals.cxo.admitted, 0);
  assert.equal(a.days[0].meals.cxo.noShows, a.days[0].meals.cxo.rsvpd);
  assert.equal(a.days[0].meals.cxo.pctOfRsvpd, 0);
  assert.equal(attendanceFrom({}).days[0].meals.cxo.pctOfRsvpd, null, "nobody RSVP'd: no percentage");
});
