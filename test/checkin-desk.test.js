/* TTFC Check-in desk: the pure rules (services/checkinDesk.js). Guest rows from the People directory (one per person,
   the Event summary's counting passes, the main pass), every pass type the backend can produce mapped to a desk pass
   (and "Other: …" for anything else), the yes / no marks, what volunteers never get (emails, ticket IDs), keys, the
   cursor that never skips a write in flight, actions as the app sends them, the undo window, entitlement per day,
   where lobby arrivals are announced, speakers' sessions from the agenda. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPeople } from "../services/people.js";
import { TIERS } from "../services/rsvp.js";
import {
  DESK_TIERS, HOLE_MS, UNDO_GRACE_MS, buildDeskIndex, canUndo, cleanAction, deskTier, entitlement, eventView, guestKey, guestView, isGuestKey,
  boothKey, isBoothKey, markView, notifyStations, safeCursor, sessionsIndex, tapTime, auditLine,
} from "../services/checkinDesk.js";

const t = (ticketId, type, extra = {}) => ({ ticketId, type, purchaseDate: new Date("2026-10-01"), ...extra });
const quiet = { warn: () => {} };

function people() {
  const users = [
    { _id: "u1", name: "Priya Sharma", email: "priya@example.com", organization: "Northwind", jobTitle: "CTO", tickets: [t("pow000000001", "power", { stripeSessionId: "cs1" })] },
    // A speaker with a Speaker Pass and a Power Pass of her own: one row, under the Speaker Pass.
    { _id: "u2", name: "Rae Speaker", email: "rae@example.com", tickets: [t("spk000000002", "speaker"), t("pow000000003", "power", { stripeSessionId: "cs2" })] },
    { _id: "u3", name: "Sam Staff", email: "sam@example.com", role: "admin" },
    { _id: "u4", name: "Hal Hidden", email: "hal@example.com", tickets: [t("apx000000004", "apex", { hiddenByStaff: true })] },
  ];
  const attendees = [
    { _id: "a1", name: "Rae Speaker", email: "rae@example.com", ticketId: "spk000000002", ticketType: "speaker", promoCode: "SPEAKER", claimedBy: "u2", passEmailSentAt: new Date("2026-10-04") },
    { _id: "a2", name: "Mo Media", email: "mo@example.com", ticketId: "con000000005", ticketType: "connect", media: true, stripeSessionId: "cs3" },
    { _id: "a3", name: "Vera Vip", email: "vera@example.com", ticketId: "pow000000006", ticketType: "All Access Pass", vip: true, stripeSessionId: "cs4" },
    { _id: "a4", name: "Eve Exhibitor", email: "eve@example.com", ticketId: "exh000000007", ticketType: "connect", promoCode: "EXHIBITOR", passEmailSentAt: new Date("2026-10-04"), issuedPass: { booth: { booth: "a-12" } } },
    { _id: "a5", name: "Pat Pending", email: "pat@example.com", ticketId: "spk000000008", ticketType: "speaker", promoCode: "SPEAKER" },
    { _id: "a6", name: "Dot Discover", email: "dot@example.com", ticketId: "dis000000009", ticketType: "discover", stripeSessionId: "cs5" },
    { _id: "a7", name: "Gus Guest", email: "gus@example.com", ticketId: "con000000010", ticketType: "connect", checkedIn: true, checkedInAt: new Date("2026-10-26T13:05:00Z"), stripeSessionId: "cs6",
      details: { firstName: "Gus", lastName: "Guest" } },
    { _id: "a8", name: "Old Legacy", email: "old@example.com", ticketId: "fes000000011", ticketType: "festival", hiddenByStaff: true },
  ];
  const rsvps = [{ _id: "r1", key: "t:con000000010", firstName: "Gus", lastName: "Guest", ticketVerified: true, ticketId: "con000000010", kind: "ticket", source: "attendee",
    attendeeSubmittedAt: new Date("2026-10-15"), tier: "connect", days: ["day1"], options: ["lunch_d1"], dietary: ["vegan", "nut_allergy", "none"] }];
  return buildPeople({ users, attendees, rsvps, speakers: [] }).people;
}

test("every pass type the backend can produce has a desk pass with a name; anything else is Other, never blank", () => {
  // services/rsvp.js TIERS (the four on sale and the internal Speaker Pass), the old names, and empty.
  for (const tier of TIERS) assert.equal(deskTier(tier, { log: quiet }).tier, tier);
  const cases = {
    connect: ["connect", "Connect Pass"], influence: ["influence", "Influence Pass"], power: ["power", "Power Pass"], apex: ["apex", "Apex Pass"],
    speaker: ["speaker", "Speaker Pass"], "All Access Pass": ["power", "Power Pass"], "all-access": ["power", "Power Pass"], "": ["connect", "Connect Pass"],
    "TTFC 2026 Influence Pass": ["influence", "Influence Pass"], exhibitor: ["connect", "Connect Pass"], VIP: ["apex", "Apex Pass"],
    discover: ["other", "Other: Discover"], festival: ["other", "Other: Festival"], standard: ["other", "Other: Standard"], "Student day": ["other", "Other: Student day"],
  };
  for (const [raw, [tier, name]] of Object.entries(cases)) {
    assert.deepEqual(deskTier(raw, { log: quiet }), { tier, passName: name }, raw);
    assert.ok(DESK_TIERS.includes(tier), raw);
  }
  const logged = [];
  deskTier("galaxy", { log: { warn: (m) => logged.push(m) } });
  deskTier("galaxy", { log: { warn: (m) => logged.push(m) } });
  assert.equal(logged.length, 1, "logged once");
});

test("guests: one row per person with a counting pass, the main pass, marks, pending, booth, RSVP and dietary", () => {
  const idx = buildDeskIndex(people(), {});
  const by = Object.fromEntries(idx.guests.map((g) => [g.name, g]));
  assert.deepEqual(Object.keys(by).sort(), ["Dot Discover", "Eve Exhibitor", "Gus Guest", "Mo Media", "Pat Pending", "Priya Sharma", "Rae Speaker", "Vera Vip"]);
  assert.equal(by["Rae Speaker"].tier, "speaker");
  assert.equal(by["Rae Speaker"].keys.length, 2, "both of her passes map to her");
  assert.equal(by["Rae Speaker"].key, guestKey("spk000000002"));
  assert.deepEqual(by["Vera Vip"].marks, { vip: true, media: false, speaker: false, exhibitor: false, staff: false, volunteer: false });
  assert.equal(by["Vera Vip"].tier, "power", "All Access is Power");
  assert.equal(by["Mo Media"].marks.media, true);
  assert.equal(by["Mo Media"].tier, "connect", "Media is a yes / no mark; the pass type stays");
  assert.equal(by["Eve Exhibitor"].marks.exhibitor, true);
  assert.equal(by["Eve Exhibitor"].booth, "a-12");
  assert.equal(by["Eve Exhibitor"].boothKey, "b-A-12");
  assert.equal(by["Pat Pending"].pending, true);
  assert.equal(by["Dot Discover"].passName, "Other: Discover");
  assert.equal(by["Gus Guest"].passCollected, true);
  assert.equal(by["Gus Guest"].passCollectedAt, "2026-10-26T13:05:00.000Z");
  assert.equal(by["Gus Guest"].lastName, "Guest");
  assert.deepEqual(by["Gus Guest"].rsvp, { rsvpd: true, by: "attendee", days: ["day1"], options: ["lunch_d1"], dietary: ["vegan", "nut_allergy"], dietaryOther: "" });
  assert.equal(by["Priya Sharma"].rsvp.rsvpd, false);
  assert.deepEqual(idx.booths.map((b) => [b.key, b.booth, b.guests.length]), [["b-A-12", "A-12", 1]]);
  assert.equal(idx.byKey.get(guestKey("pow000000003")).guest.name, "Rae Speaker");
  assert.equal(idx.byNorm.get("con000000010").name, "Gus Guest");
});

test("volunteers never get emails, ticket IDs or the inclusions' switches; staff do", () => {
  const g = buildDeskIndex(people(), {}).guests.find((x) => x.name === "Gus Guest");
  const v = guestView(g, { staff: false });
  for (const k of ["email", "ticketId", "ticketIds", "personId", "extrasView", "norm", "norms"]) assert.ok(!(k in v), k);
  assert.ok(!JSON.stringify(v).includes("con000000010"));
  assert.ok(!JSON.stringify(v).includes("@example.com"));
  const s = guestView(g, { staff: true });
  assert.equal(s.email, "gus@example.com");
  assert.equal(s.ticketId, "con000000010");
  assert.ok(s.extrasView.cxo && "override" in s.extrasView.cxo);
  assert.ok(!("norm" in s), "server-only fields never leave");
});

test("keys: the same for every spelling of a ticket ID, opaque, and booths", () => {
  assert.equal(guestKey("TECHFEST:ABC123DEF456"), guestKey("abc123def456"));
  assert.ok(isGuestKey(guestKey("abc123def456")));
  assert.notEqual(guestKey("abc123def456"), guestKey("abc123def457"));
  assert.ok(!guestKey("abc123def456").includes("abc123"));
  assert.equal(guestKey(""), "");
  assert.equal(boothKey(" a 12 "), "b-A12");
  assert.ok(isBoothKey("b-A12") && !isBoothKey("b-") && !isBoothKey(guestKey("x1")));
});

test("the cursor never moves past a number still being written, and skips one that failed", () => {
  const now = Date.parse("2026-10-26T13:00:10Z");
  const ev = (seq, ago = 0) => ({ seq, at: new Date(now - ago) });
  assert.equal(safeCursor([ev(1), ev(2), ev(3)], 0, { now }), 3);
  assert.equal(safeCursor([ev(5), ev(6)], 4, { now }), 6);
  // 4 missing, 5 written just now: stay at 3 (4 is probably still being saved).
  assert.equal(safeCursor([ev(5), ev(6)], 3, { now }), 3);
  // …but if 5 was written long enough ago, 4 failed: move on.
  assert.equal(safeCursor([ev(5, HOLE_MS + 1), ev(6)], 3, { now }), 6);
  assert.equal(safeCursor([ev(2), ev(4), ev(5)], 1, { now }), 2);
  assert.equal(safeCursor([], 7, { now }), 7);
  assert.equal(safeCursor([ev(3)], 5, { now }), 5, "never backwards");
});

test("actions as the app sends them", () => {
  const key = guestKey("abc123def456");
  const ok = (a) => cleanAction(a).ok;
  assert.ok(ok({ clientId: "abcdefgh1", kind: "mark", point: "arrived", key, station: "lobby", clientAt: "2026-10-26T13:00:00Z" }));
  assert.equal(cleanAction({ clientId: "abcdefgh1", kind: "mark", point: "cxo", key, station: "breakfast", override: true }).value.override, true);
  assert.equal(cleanAction({ clientId: "abcdefgh1", kind: "mark", point: "cxo", key, station: "breakfast", override: "yes" }).value.override, false);
  assert.ok(ok({ clientId: "abcdefgh1", kind: "mark", point: "booth", key: "b-A12", station: "exhibitor" }));
  assert.ok(!ok({ clientId: "abcdefgh1", kind: "mark", point: "booth", key, station: "exhibitor" }));
  assert.ok(!ok({ clientId: "abcdefgh1", kind: "mark", point: "arrived", key: "con000000010", station: "lobby" }), "ticket IDs aren't keys");
  assert.ok(!ok({ clientId: "short", kind: "mark", point: "arrived", key, station: "lobby" }));
  assert.ok(!ok({ clientId: "abcdefgh1", kind: "mark", point: "teleported", key, station: "lobby" }));
  assert.ok(!ok({ clientId: "abcdefgh1", kind: "mark", point: "arrived", key, station: "rooftop" }));
  assert.ok(!ok({ clientId: "abcdefgh1", kind: "undo", ref: "abcdefgh1", station: "lobby" }), "can't undo itself");
  assert.ok(ok({ clientId: "abcdefgh1", kind: "undo", ref: "abcdefgh2", station: "lobby" }));
  assert.ok(!ok({ clientId: "abcdefgh1", kind: "note", key, note: "x".repeat(141), station: "desk" }));
  assert.equal(cleanAction({ clientId: "abcdefgh1", kind: "note", key, note: "  Collect at   VIP desk ", station: "desk" }).value.note, "Collect at VIP desk");
  assert.ok(!ok({ clientId: "abcdefgh1", kind: "mark", point: "av", key, station: "av", note: "x".repeat(81) }));
  assert.ok(ok({ clientId: "abcdefgh1", kind: "query_add", who: "Lee", request: "Press kit", station: "media" }));
  assert.ok(!ok({ clientId: "abcdefgh1", kind: "query_add", who: "Lee", request: " ", station: "media" }));
  assert.ok(!ok({ clientId: "abcdefgh1", kind: "query_add", request: "Press kit", station: "media" }), "who's asking");
  assert.ok(ok({ clientId: "abcdefgh1", kind: "query_update", id: "6a1b2c3d4e5f6a1b2c3d4e5f", status: "done", station: "media" }));
  assert.ok(!ok({ clientId: "abcdefgh1", kind: "query_update", id: "6a1b2c3d4e5f6a1b2c3d4e5f", station: "media" }));
  assert.ok(!ok({ clientId: "abcdefgh1", kind: "query_update", id: "6a1b2c3d4e5f6a1b2c3d4e5f", status: "closed", station: "media" }));
});

test("taps from the offline queue keep their time (within hours, never in the future)", () => {
  const now = new Date("2026-10-26T13:00:00Z");
  assert.equal(tapTime("2026-10-26T12:58:00Z", now).toISOString(), "2026-10-26T12:58:00.000Z");
  assert.equal(tapTime("2026-10-26T13:05:00Z", now).toISOString(), now.toISOString());
  assert.equal(tapTime("2026-10-25T13:00:00Z", now).toISOString(), now.toISOString());
  assert.equal(tapTime(null, now).toISOString(), now.toISOString());
});

test("undo: volunteers their own taps within the window (device clock), staff anything", () => {
  const now = new Date("2026-10-26T13:01:00Z");
  const target = { kind: "mark", byId: "v1", at: new Date("2026-10-26T13:00:50Z"), clientAt: new Date("2026-10-26T13:00:00Z") };
  assert.ok(canUndo({ target, actorId: "v1", undoClientAt: new Date("2026-10-26T13:00:12Z"), now }).ok);
  assert.ok(!canUndo({ target, actorId: "v1", undoClientAt: new Date(target.clientAt.getTime() + UNDO_GRACE_MS + 1), now }).ok);
  assert.equal(canUndo({ target, actorId: "v2", undoClientAt: new Date("2026-10-26T13:00:05Z"), now }).status, 403);
  assert.ok(canUndo({ target, actorId: "s1", staff: true, now: new Date("2026-10-26T18:00:00Z") }).ok);
  assert.equal(canUndo({ target: null, actorId: "v1", now }).status, 404);
  assert.equal(canUndo({ target: { ...target, kind: "note" }, actorId: "v1", now }).status, 400);
  // Hours later, even with device clocks that look close: too late.
  assert.ok(!canUndo({ target, actorId: "v1", undoClientAt: new Date("2026-10-26T13:00:05Z"), now: new Date("2026-10-26T15:00:00Z") }).ok);
});

test("entitlement per day: the pass's extra for today's item, and whether they RSVP'd for it", () => {
  const g = { extras: { cxo: false, lunch: true, gala: false, awards: true }, rsvp: { options: ["lunch_d1", "awards"] } };
  assert.deepEqual(pickE(entitlement(g, "lunch", "day1")), ["lunch_d1", true, true]);
  assert.deepEqual(pickE(entitlement(g, "lunch", "day2")), ["lunch_d2", true, false]);
  assert.deepEqual(pickE(entitlement(g, "breakfast", "day1")), ["cxo_d1", false, false]);
  assert.deepEqual(pickE(entitlement(g, "evening", "day1")), ["awards", true, true]);
  assert.deepEqual(pickE(entitlement(g, "evening", "day2")), ["gala", false, false]);
  assert.deepEqual(entitlement(g, "breakfast", null), { item: null, included: null, rsvpd: null });
  assert.deepEqual(entitlement(g, "lobby", "day1"), { item: null, included: null, rsvpd: null });
});
const pickE = (e) => [e.item.key, e.included, e.rsvpd];

test("lobby arrivals go to the pass desk, and also AV (speakers), exhibitors' desk and the media desk", () => {
  assert.deepEqual(notifyStations({ marks: {} }), ["desk"]);
  assert.deepEqual(notifyStations({ marks: { speaker: true } }), ["desk", "av"]);
  assert.deepEqual(notifyStations({ marks: { exhibitor: true } }), ["desk", "exhibitor"]);
  assert.deepEqual(notifyStations({ marks: { media: true, vip: true } }), ["desk", "media"]);
  assert.deepEqual(notifyStations({ marks: { speaker: true, exhibitor: true, media: true } }), ["desk", "av", "exhibitor", "media"]);
  assert.deepEqual(notifyStations(null), ["desk"]);
});

test("speakers' sessions from the agenda: by name, today first, breaks left out", () => {
  const of = sessionsIndex([
    { day: 1, time: "10:05", endTime: "10:30", title: "Conviction Before Consensus", format: "fireside", speakers: [{ name: "Dr. Raj Patel" }] },
    { day: 2, time: "09:00", endTime: "09:25", title: "Canada's Frontier", speakers: [{ name: "Raj Patel" }], moderator: { name: "Mia Moderator" } },
    { day: 1, time: "12:35", endTime: "13:20", title: "Networking Lunch", isBreak: true, speakers: [{ name: "Raj Patel" }] },
    { day: 1, time: "09:30", endTime: "10:00", title: "Ontario's Next Ten Years", stage: "Harbour Ballroom", speakers: [{ name: "Raj Patel" }] },
  ]);
  const raj = of({ name: "Raj Patel" });
  assert.deepEqual(raj.map((s) => [s.day, s.start, s.room]), [["day1", "09:30", "Harbour Ballroom"], ["day1", "10:05", "Main Stage, Harbour Ballroom"], ["day2", "09:00", "Main Stage, Harbour Ballroom"]]);
  assert.equal(of({ name: "Mia Moderator" }).length, 1);
  assert.deepEqual(of({ name: "Nobody" }), []);
});

test("marks and events on the wire carry keys, never ticket IDs", () => {
  const m = markView({ subject: "con000000010", day: "2026-10-26", point: "arrived", rev: 3, at: new Date("2026-10-26T13:00:00Z"), byId: "u9", byName: "Val", station: "lobby" });
  assert.equal(m.key, guestKey("con000000010"));
  assert.equal(m.by.name, "Val");
  const cleared = markView({ subject: "booth:a12", day: "2026-10-26", point: "booth", rev: 4, at: null, byName: "Val" });
  assert.equal(cleared.key, "b-A12");
  assert.equal(cleared.at, null);
  assert.equal(cleared.by, null);
  const e = eventView({ seq: 9, kind: "mark", point: "checked_in", subject: "con000000010", day: "2026-10-26", at: new Date(), byName: "Val", clientId: "c1",
    pass: { ticketId: "con000000010", collected: true, collectedAt: new Date("2026-10-26T13:00:00Z") }, extrasView: { cxo: {} } });
  assert.ok(!JSON.stringify(e).includes("con000000010"));
  assert.equal(e.pass.key, guestKey("con000000010"));
  assert.ok(!("extrasView" in e), "staff only");
  assert.ok("extrasView" in eventView({ seq: 1, kind: "inclusions", subject: "x1", at: new Date(), extrasView: { cxo: {} } }, { staff: true }));
});

test("audit lines say who, what and where", () => {
  assert.equal(auditLine({ guest: { name: "Nina", passName: "Speaker Pass" }, kind: "mark", point: "cxo", station: "breakfast", override: "outside_window", item: { label: "CxO Breakfast" } }),
    "Nina · Speaker Pass: Admitted to CxO Breakfast outside its hours (override) (CxO Breakfast)");
  assert.equal(auditLine({ booth: { booth: "A12" }, kind: "reset", point: "booth", station: "exhibitor" }), "Booth A12: cleared Booth set up (Exhibitor desk)");
  assert.equal(auditLine({ guest: { name: "Vera", passName: "Power Pass" }, kind: "note", note: "", station: "desk" }), "Vera · Power Pass: desk note cleared (Pass desk)");
});
