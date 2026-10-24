/* TTFC Check-in desk: the pure rules (services/checkinDesk.js). Guest rows from the People directory (one per person,
   the Event summary's counting passes, the main pass), every pass type the backend can produce mapped to a desk pass
   (and "Other: …" for anything else), the yes / no marks, what volunteers never get (emails, ticket IDs), keys, the
   cursor that never skips a write in flight, actions as the app sends them, the undo window, entitlement per day,
   where lobby arrivals are announced, speakers' sessions from the agenda, NO DETAILS FOUND actions and cards (C8). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPeople } from "../services/people.js";
import { TIERS } from "../services/rsvp.js";
import {
  DESK_TIERS, HOLE_MS, UNDO_GRACE_MS, buildDeskIndex, canUndo, cleanAction, deskTier, entitlement, eventView, guestKey, guestView, isGuestKey,
  boothKey, isBoothKey, markView, notifyStations, safeCursor, sessionsIndex, tapTime, auditLine,
  CLIENT_AT_MAX_AGE_MS, CLIENT_AT_MAX_AHEAD_MS, LATE_SYNC_MS, HOLE_ANCIENT_MS, tapClock, speakerNameMatches, guestExtras, boothsOf,
  UNKNOWN_LIMITS, isUnknownKey, keyOfSubject, unknownKeyOf, unknownRows,
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

test("contract C4: a tap's time is its clientAt clamped to [now − 12 h, now + 2 min]; over a minute old is a late sync", () => {
  const now = new Date("2026-10-26T13:00:00Z");
  assert.equal(tapTime("2026-10-26T12:58:00Z", now).toISOString(), "2026-10-26T12:58:00.000Z");
  assert.equal(tapTime("2026-10-26T13:01:30Z", now).toISOString(), "2026-10-26T13:01:30.000Z", "a device a little ahead keeps its time");
  assert.equal(tapTime("2026-10-26T13:05:00Z", now).toISOString(), new Date(now.getTime() + CLIENT_AT_MAX_AHEAD_MS).toISOString());
  assert.equal(tapTime("2026-10-25T13:00:00Z", now).toISOString(), new Date(now.getTime() - CLIENT_AT_MAX_AGE_MS).toISOString());
  assert.equal(tapTime(null, now).toISOString(), now.toISOString());
  assert.deepEqual(pickC(tapClock("2026-10-26T12:59:30Z", now)), [false, false]);
  assert.deepEqual(pickC(tapClock("2026-10-26T12:58:59Z", now)), [true, false]);
  assert.deepEqual(pickC(tapClock("2026-10-25T00:00:00Z", now)), [true, true]);
  assert.deepEqual(pickC(tapClock("2026-10-26T14:00:00Z", now)), [false, true]);
  assert.equal(CLIENT_AT_MAX_AGE_MS, 12 * 3600 * 1000);
  assert.equal(LATE_SYNC_MS, 60 * 1000);
});
const pickC = (c) => [c.late, c.clamped];

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

test("undo: a volunteer's own practice mark (not an event day, contract C6) at any time; someone else's never", () => {
  const target = { kind: "mark", byId: "v1", practice: true, at: new Date("2026-10-25T13:00:00Z"), clientAt: new Date("2026-10-25T13:00:00Z") };
  const later = new Date("2026-10-25T19:00:00Z");
  assert.ok(canUndo({ target, actorId: "v1", undoClientAt: later, now: later }).ok, "6 hours later");
  assert.equal(canUndo({ target, actorId: "v2", undoClientAt: later, now: later }).status, 403);
  assert.ok(!canUndo({ target: { ...target, practice: false }, actorId: "v1", undoClientAt: later, now: later }).ok, "a real mark: the window");
});

test("undo queued offline by someone else (contract C3): only a tap sent from the same sign-in", () => {
  const now = new Date("2026-10-26T13:00:20Z");
  const at = new Date("2026-10-26T13:00:00Z");
  const sentByVal = { kind: "mark", byId: "val", at, clientAt: at };
  const queuedOnVics = { kind: "mark", byId: "val", recordedById: "vic", queuedOffline: true, at, clientAt: at };
  const undoAt = new Date("2026-10-26T13:00:10Z");
  // Vic's sign-in sends an undo naming Val: never of a tap Val sent from her own sign-in…
  assert.equal(canUndo({ target: sentByVal, actorId: "val", undoClientAt: undoAt, now, signedInId: "vic" }).status, 403);
  assert.equal(canUndo({ target: { ...sentByVal, practice: true }, actorId: "val", undoClientAt: undoAt, now, signedInId: "vic" }).status, 403);
  // …only of Val's tap that went out from Vic's sign-in too (the same offline queue).
  assert.ok(canUndo({ target: queuedOnVics, actorId: "val", undoClientAt: undoAt, now, signedInId: "vic" }).ok);
  assert.equal(canUndo({ target: queuedOnVics, actorId: "val", undoClientAt: undoAt, now, signedInId: "ann" }).status, 403);
  // Val's own sign-in: as before.
  assert.ok(canUndo({ target: sentByVal, actorId: "val", undoClientAt: undoAt, now }).ok);
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

test("contract C2 / C3 on the wire: undo by `target` (ref still works), queuedBy { id, name }", () => {
  const key = guestKey("abc123def456");
  assert.equal(cleanAction({ clientId: "abcdefgh1", kind: "undo", target: "abcdefgh2", station: "lobby" }).value.ref, "abcdefgh2");
  assert.equal(cleanAction({ clientId: "abcdefgh1", kind: "undo", target: "abcdefgh3", ref: "abcdefgh2", station: "lobby" }).value.ref, "abcdefgh3", "target wins");
  assert.ok(!cleanAction({ clientId: "abcdefgh1", kind: "undo", target: "abcdefgh1", station: "lobby" }).ok);
  const q = cleanAction({ clientId: "abcdefgh1", kind: "mark", point: "arrived", key, station: "lobby", queuedBy: { id: "6a1b2c3d4e5f6a1b2c3d4e5f", name: "  Val   Volunteer " } });
  assert.deepEqual(q.value.queuedBy, { id: "6a1b2c3d4e5f6a1b2c3d4e5f", name: "Val Volunteer" });
  assert.ok(!cleanAction({ clientId: "abcdefgh1", kind: "mark", point: "arrived", key, station: "lobby", queuedBy: { id: "not-an-id" } }).ok);
  assert.ok(!cleanAction({ clientId: "abcdefgh1", kind: "mark", point: "arrived", key, station: "lobby", queuedBy: "Val" }).ok);
  assert.equal(cleanAction({ clientId: "abcdefgh1", kind: "mark", point: "arrived", key, station: "lobby", queuedBy: null }).value.queuedBy, undefined);
});

test("the cursor: a gap counts from when this reader first saw it missing, so a write that commits late isn't skipped", () => {
  const now = Date.parse("2026-10-26T13:00:10Z");
  const ev = (seq, ago = 0) => ({ seq, at: new Date(now - ago) });
  // 5 was stamped 20 s ago (it waited for a slow database, like 4); this reader only now sees 4 missing: wait.
  const seen = new Map();
  const firstSeen = (k) => { if (!seen.has(k)) seen.set(k, 1000); return seen.get(k); };
  assert.equal(safeCursor([ev(5, 20000), ev(6)], 3, { now, firstSeen, seenNow: 1000 }), 3);
  assert.equal(safeCursor([ev(5, 20000), ev(6)], 3, { now, firstSeen, seenNow: 1000 + HOLE_MS - 1 }), 3);
  // Missing for longer than HOLE_MS here: a failed write, move on.
  assert.equal(safeCursor([ev(5, 20000), ev(6)], 3, { now, firstSeen, seenNow: 1000 + HOLE_MS + 1 }), 6);
  // A gap before an event that is ancient (a failed write long ago) is skipped at once.
  assert.equal(safeCursor([ev(5, HOLE_ANCIENT_MS + 1), ev(6)], 3, { now, firstSeen: () => 5000, seenNow: 5000 }), 6);
  // Two missing numbers: the newest sighting decides.
  const two = new Map([[4, 0], [5, 9000]]);
  assert.equal(safeCursor([ev(6, 30000)], 3, { now, firstSeen: (k) => two.get(k), seenNow: 0 + HOLE_MS + 1 }), 3);
});

test("inclusions: an extra any of their counting passes includes (the Event summary's rule), switches on the pass that decides", () => {
  const users = [];
  const attendees = [
    // Ava bought a Connect Pass, then staff gave her a Power Pass (emailed, not claimed yet): the main pass is the paid Connect.
    { _id: "b1", name: "Ava Twopass", email: "ava@example.com", ticketId: "con000000031", ticketType: "connect", stripeSessionId: "cs31", purchaseDate: new Date("2026-09-01") },
    { _id: "b2", name: "Ava Twopass", email: "ava@example.com", ticketId: "pow000000032", ticketType: "power", promoCode: "ISSUED", passEmailSentAt: new Date("2026-10-10"), purchaseDate: new Date("2026-10-10") },
    // Ben's second pass is refunded-or-hidden (hidden by staff): it never counts.
    { _id: "b3", name: "Ben Hidden", email: "ben@example.com", ticketId: "con000000033", ticketType: "connect", stripeSessionId: "cs33" },
    { _id: "b4", name: "Ben Hidden", email: "ben@example.com", ticketId: "apx000000034", ticketType: "apex", stripeSessionId: "cs34", hiddenByStaff: true },
  ];
  const idx = buildDeskIndex(buildPeople({ users, attendees, rsvps: [], speakers: [] }).people);
  const ava = idx.guests.find((g) => g.name === "Ava Twopass");
  assert.equal(ava.passName, "Connect Pass", "counted under the paid pass");
  assert.deepEqual(ava.extras, { cxo: false, lunch: true, gala: true, awards: true });
  assert.equal(entitlement(ava, "lunch", "day1").included, true);
  assert.equal(entitlement(ava, "evening", "day1").included, true);
  assert.equal(ava.extrasView.lunch.ticketId, "pow000000032", "the Power Pass decides the luncheons");
  assert.equal(ava.extrasView.lunch.included, true);
  assert.equal(ava.extrasView.cxo.ticketId, "con000000031", "nothing includes it: the main pass's switch");
  assert.deepEqual(ava.passExtras.map((p) => [p.ticketId, p.extrasView.lunch.included]), [["con000000031", false], ["pow000000032", true]]);
  assert.ok(!("passExtras" in guestView(ava)), "staff only");
  const ben = idx.guests.find((g) => g.name === "Ben Hidden");
  assert.deepEqual(ben.extras, { cxo: false, lunch: false, gala: false, awards: false });
  assert.deepEqual(guestExtras([]).extras, { cxo: false, lunch: false, gala: false, awards: false });
});

test("Exhibitor = No from staff wins over an exhibitor pass: no exhibitor mark, no booth", () => {
  const attendees = [
    { _id: "e1", name: "Eve Exhibitor", email: "eve@example.com", ticketId: "exh000000041", ticketType: "connect", promoCode: "EXHIBITOR", exhibitor: false,
      passEmailSentAt: new Date("2026-10-04"), issuedPass: { booth: { booth: "B7" } } },
    { _id: "e2", name: "Ed Exhibitor", email: "ed@example.com", ticketId: "exh000000042", ticketType: "connect", promoCode: "EXHIBITOR",
      passEmailSentAt: new Date("2026-10-04"), issuedPass: { booth: { booth: "B7" } } },
  ];
  const users = [{ _id: "u41", name: "Oz Account", email: "oz@example.com", typesOff: ["exhibitor"], tickets: [t("exh000000043", "connect", { promoCode: "EXHIBITOR" })] }];
  const idx = buildDeskIndex(buildPeople({ users, attendees, rsvps: [], speakers: [] }).people);
  const by = Object.fromEntries(idx.guests.map((g) => [g.name, g]));
  assert.equal(by["Eve Exhibitor"].marks.exhibitor, false);
  assert.equal(by["Eve Exhibitor"].booth, "");
  assert.equal(by["Oz Account"].marks.exhibitor, false, "typesOff on an account");
  assert.equal(by["Ed Exhibitor"].marks.exhibitor, true);
  assert.deepEqual(idx.booths.map((b) => [b.booth, b.guests.length]), [["B7", 1]]);
  assert.deepEqual(notifyStations(by["Eve Exhibitor"]), ["desk"]);
  assert.deepEqual(boothsOf(idx.guests), idx.booths);
});

test("AV: speakers are matched to sessions by name the way the agenda prints it (titles, middle names, nicknames, slips)", () => {
  const pairs = [
    ["Dr. Christian Weedbrook", "Christian Weedbrook"], ["Vic Fedeli", "Victor (Vic) Fedeli"], ["Ashley J. Casovan", "Ashley Casovan"],
    ["Ashley Casovan", "Ashley J. Casovan"], ["Dr. Rulan S. Parekh", "Rulan Parekh"], ["Heling (Alex) Pu", "Alex Pu"],
    ["Kulbir (Colin) Singh Dhillon", "Colin Dhillon"], ["Dr. Chris Golden", "Christopher Golden"], ["Hon. Vic Fedelli", "Victor Fedeli"],
    ["Prof. Aspuru-Guzik", "Alán Aspuru-Guzik"], ["BGen Jane Roe", "Jane Roe"], ["Jo-Anne Ryan", "Jo Anne Ryan"], ["Geneviève Decambra", "Genevieve DECAMBRA"],
    ["Na'im Merchant", "Naim Merchant"], ["Dr Maha Hosain Aziz", "Maha Aziz"],
  ];
  for (const [agenda, person] of pairs) assert.ok(speakerNameMatches(agenda, person), `${agenda} ~ ${person}`);
  const different = [["Daniel Sax", "Daniel Wigdor"], ["Chris Golden", "Chris Gold"], ["Mark Paulsen", "Mark Schaan"], ["Peter Aceto", "Peter Routledge"], ["Ryan Gariepy", "Ryan"]];
  for (const [agenda, person] of different) assert.ok(!speakerNameMatches(agenda, person), `${agenda} ≠ ${person}`);

  const of = sessionsIndex([
    { day: 1, time: "10:00", endTime: "10:30", title: "Light Years", speakers: [{ name: "Dr. Christian Weedbrook" }] },
    { day: 1, time: "09:30", endTime: "10:00", title: "From Investment to Industrial Capacity", speakers: [{ name: "Hon. Vic Fedelli" }, { name: "Ashley J. Casovan" }] },
    { day: 2, time: "14:00", endTime: "14:30", title: "Regulation", speakers: [{ name: "Vic Fedeli" }], moderator: { name: "Heling (Alex) Pu" } },
  ]);
  assert.deepEqual(of({ name: "Christian Weedbrook" }).map((x) => x.title), ["Light Years"]);
  assert.deepEqual(of({ name: "Victor (Vic) Fedeli" }).map((x) => [x.day, x.title]), [["day1", "From Investment to Industrial Capacity"], ["day2", "Regulation"]]);
  assert.deepEqual(of({ name: "Ashley Casovan" }).map((x) => x.start), ["09:30"]);
  assert.deepEqual(of({ name: "Alex Pu" }).map((x) => x.title), ["Regulation"]);
  // Their website speaker profile's name counts too (People links it to their pass).
  assert.deepEqual(of({ name: "C. Weedbrook-Smith", speaker: { name: "Christian Weedbrook" } }).map((x) => x.title), ["Light Years"]);
  assert.deepEqual(of({ name: "Nobody Here" }), []);
});

test("on the wire: practice marks, late syncs, offline taps sent from another sign-in, override reasons, guest rows", () => {
  const m = markView({ subject: "con000000010", day: "2026-10-25", point: "checked_in", rev: 1, at: new Date("2026-10-25T15:00:00Z"), byId: "u9", byName: "Val",
    station: "desk", practice: true, lateSync: true, queuedOffline: true, recordedById: "u8", recordedByName: "Sam", override: "late_sync" });
  assert.equal(m.practice, true);
  assert.equal(m.lateSync, true);
  assert.equal(m.queuedOffline, true);
  assert.deepEqual(m.recordedBy, { id: "u8", name: "Sam" });
  assert.equal(m.overrideReason, "late sync outside hours");
  const plain = markView({ subject: "con000000010", day: "2026-10-26", point: "arrived", rev: 1, at: new Date(), byName: "Val" });
  for (const k of ["practice", "lateSync", "queuedOffline", "recordedBy", "overrideReason"]) assert.ok(!(k in plain), k);
  const row = { key: guestKey("con000000010"), keys: [guestKey("con000000010")], name: "Gus Guest", email: "gus@example.com", ticketId: "con000000010", norm: "con000000010", norms: ["con000000010"] };
  const ev = eventView({ seq: 3, kind: "guest", subject: "con000000010", at: new Date(), guest: row });
  assert.equal(ev.guest.name, "Gus Guest");
  assert.ok(!JSON.stringify(ev).includes("gus@example.com") && !JSON.stringify(ev).includes("con000000010"), "volunteers: no email or ticket ID");
  assert.equal(eventView({ seq: 3, kind: "guest", subject: "con000000010", at: new Date(), guest: row }, { staff: true }).guest.email, "gus@example.com");
  const tomb = eventView({ seq: 4, kind: "undo", tombstone: true, ref: "abcdefgh2", at: new Date(), queuedOffline: true, recordedById: "u8", recordedByName: "Sam" });
  assert.equal(tomb.tombstone, true);
  assert.equal(tomb.target, "abcdefgh2");
  assert.equal(tomb.recordedBy.name, "Sam");
  assert.equal(auditLine({ guest: { name: "Nina", passName: "Speaker Pass" }, kind: "mark", point: "cxo", station: "breakfast", override: "late_sync", item: { label: "CxO Breakfast" } }),
    "Nina · Speaker Pass: Admitted to CxO Breakfast outside its hours (late sync from an offline device) (CxO Breakfast)");
});

/* ---------- Contract C8: NO DETAILS FOUND ---------- */

test("C8 actions as the app sends them: unknown_arrival (name as typed), unknown_done (outcome), unknown_link (staff)", () => {
  const base = { clientId: "lobbytap01", station: "lobby" };
  const a = cleanAction({ ...base, kind: "unknown_arrival", name: "  Jo   Bloggs ", company: "Acme", note: "says registered" });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.deepEqual([a.value.name, a.value.company, a.value.note], ["Jo Bloggs", "Acme", "says registered"]);
  assert.equal(cleanAction({ ...base, kind: "unknown_arrival", name: "Jo" }).value.company, "", "company and note are optional");
  assert.equal(cleanAction({ ...base, kind: "unknown_arrival", name: "   " }).field, "name");
  assert.equal(cleanAction({ ...base, kind: "unknown_arrival", name: "x".repeat(UNKNOWN_LIMITS.name + 1) }).field, "name");
  assert.equal(cleanAction({ ...base, kind: "unknown_arrival", name: "Jo", company: "x".repeat(81) }).field, "company");
  assert.equal(cleanAction({ ...base, kind: "unknown_arrival", name: "Jo", note: "x".repeat(201) }).field, "note");
  assert.equal(cleanAction({ ...base, kind: "unknown_arrival", name: "Jo", note: "x".repeat(200) }).ok, true);
  assert.equal(cleanAction({ ...base, kind: "unknown_arrival", name: 42 }).ok, false);
  const done = cleanAction({ clientId: "desktap001", station: "desk", kind: "unknown_done", target: "u:lobbytap01", outcome: "pass_issued" });
  assert.deepEqual([done.ok, done.value.target, done.value.outcome], [true, "u:lobbytap01", "pass_issued"]);
  assert.equal(cleanAction({ clientId: "desktap001", station: "desk", kind: "unknown_done", target: "u:lobbytap01", outcome: "vanished" }).field, "outcome");
  assert.equal(cleanAction({ clientId: "desktap001", station: "desk", kind: "unknown_done", target: "lobbytap01", outcome: "left" }).field, "target");
  const key = guestKey("con000000005");
  const link = cleanAction({ clientId: "desktap002", station: "desk", kind: "unknown_link", target: "u:lobbytap01", guestKey: key });
  assert.deepEqual([link.ok, link.value.guestKey], [true, key]);
  assert.equal(cleanAction({ clientId: "desktap002", station: "desk", kind: "unknown_link", target: "u:lobbytap01", guestKey: "con000000005" }).field, "guestKey");
  assert.equal(unknownKeyOf("lobbytap01"), "u:lobbytap01");
  assert.ok(isUnknownKey("u:lobbytap01") && !isUnknownKey("u:") && !isUnknownKey("g0123"));
  assert.equal(keyOfSubject("u:lobbytap01"), "u:lobbytap01", "a card's events travel under its own key");
  // The lobby's arrival can be undone like a tap (its author within the window; staff any time).
  const target = { kind: "unknown_arrival", byId: "v1", at: new Date("2026-10-26T13:00:01Z"), clientAt: new Date("2026-10-26T13:00:00Z") };
  assert.ok(canUndo({ target, actorId: "v1", undoClientAt: new Date("2026-10-26T13:00:05Z"), now: new Date("2026-10-26T13:00:06Z") }).ok);
  assert.equal(canUndo({ target: { ...target, kind: "unknown_done" }, actorId: "v1", now: new Date("2026-10-26T13:00:06Z") }).status, 400);
});

test("C8 on the wire: the arrival as typed (at = when it was tapped); a snapshot's cards, newest event wins, undone left out", () => {
  const arrival = (seq, clientId, extra = {}) => ({
    seq, kind: "unknown_arrival", clientId, subject: `u:${clientId}`, day: "2026-10-26", at: new Date("2026-10-26T13:10:00Z"),
    arrivedAt: new Date("2026-10-26T13:05:00Z"), station: "lobby", byName: "Val Volunteer", name: "Jo Bloggs", company: "Acme", note: "", ...extra,
  });
  const v = eventView(arrival(5, "lobbytap01"));
  assert.deepEqual([v.kind, v.key, v.name, v.company, v.byName, v.at, v.day], ["unknown_arrival", "u:lobbytap01", "Jo Bloggs", "Acme", "Val Volunteer", "2026-10-26T13:05:00.000Z", "2026-10-26"]);
  const d = eventView({ seq: 6, kind: "unknown_done", subject: "u:lobbytap01", ref: "u:lobbytap01", outcome: "left", at: new Date(), byName: "Dee" });
  assert.deepEqual([d.key, d.target, d.outcome], ["u:lobbytap01", "u:lobbytap01", "left"]);
  const l = eventView({ seq: 7, kind: "unknown_link", subject: "u:lobbytap02", guestKey: "g0123456789abcdef0123", at: new Date() });
  assert.equal(l.guestKey, "g0123456789abcdef0123");
  const u = eventView({ seq: 8, kind: "undo", subject: "u:lobbytap03", ref: "lobbytap03", at: new Date() });
  assert.deepEqual([u.key, u.target], ["u:lobbytap03", "lobbytap03"]);

  const rows = unknownRows(
    [arrival(5, "lobbytap01"), arrival(9, "lobbytap02"), arrival(11, "lobbytap03"), arrival(12, "lobbytap04")],
    [
      { seq: 13, kind: "unknown_done", subject: "u:lobbytap01", outcome: "sent_to_help", at: new Date("2026-10-26T13:20:00Z"), byName: "Dee" },
      { seq: 14, kind: "unknown_link", subject: "u:lobbytap02", guestKey: "g0123456789abcdef0123", at: new Date("2026-10-26T13:21:00Z"), byName: "Sam" },
      { seq: 15, kind: "undo", subject: "u:lobbytap03", at: new Date() },
      { seq: 4, kind: "unknown_done", subject: "u:lobbytap04", outcome: "left", at: new Date() }, // older than its arrival: ignored
    ],
  );
  assert.deepEqual(rows.map((r) => [r.key, r.status]), [["u:lobbytap01", "sent_to_help"], ["u:lobbytap02", "linked"], ["u:lobbytap04", "open"]]);
  assert.deepEqual([rows[0].outcome, rows[0].doneBy, rows[0].doneAt], ["sent_to_help", "Dee", "2026-10-26T13:20:00.000Z"]);
  assert.equal(rows[1].guestKey, "g0123456789abcdef0123");
  assert.equal(rows[2].at, "2026-10-26T13:05:00.000Z");
  assert.ok(!("seq" in rows[0]));
});

/* ---------- Round 3 (Oct 23 2026): ISSUE PASS (C7), C8 events, undo coverage (C2) ---------- */

function noPassPeople() {
  const users = [
    { _id: "u10", name: "Sia Speaker", email: "sia@example.com", types: ["speaker"], organization: "Talkco", jobTitle: "VP" },
    { _id: "u11", name: "Mel Media", email: "mel@example.com", types: ["media"], vip: true },
    // An exhibitor with only a booth order: a booth isn't a pass, so she's ISSUE PASS.
    { _id: "u12", name: "Exa Exhibitor", email: "exa@example.com", types: ["exhibitor"], tickets: [t("BOOTH-A1", "booth")] },
    // Hidden-only and refunded-only people stay out (as on the Event summary).
    { _id: "u13", name: "Hank Hidden", email: "hank@example.com", types: ["speaker"], tickets: [t("apx000000020", "apex", { hiddenByStaff: true })] },
    { _id: "u14", name: "Rhea Refunded", email: "rhea@example.com", types: ["media"], tickets: [t("pow000000021", "power", { stripeSessionId: "cs_refunded" })] },
    // No type: not on the list.
    { _id: "u15", name: "Ola Other", email: "ola@example.com" },
  ];
  const refunds = new Map([["cs_refunded", { total: 100, refunded: 100 }]]);
  return buildPeople({ users, attendees: [], rsvps: [], speakers: [{ _id: "spk-noel", name: "Noel Nopass", company: "Quantumly", title: "Chief Scientist" }], refunds });
}

test("C7 ISSUE PASS: a speaker with no Speaker Pass, Media or an exhibitor with no pass; hidden-only, refunded-only and untyped people out", async () => {
  const { noPassPerson, deskNoPassFrom, personKey, personSubject, NO_PASS_LABEL } = await import("../services/checkinDesk.js");
  const built = noPassPeople();
  const by = Object.fromEntries(built.people.map((p) => [p.name, p]));
  for (const name of ["Sia Speaker", "Mel Media", "Exa Exhibitor", "Noel Nopass"]) assert.equal(noPassPerson(by[name]), true, name);
  for (const name of ["Hank Hidden", "Rhea Refunded", "Ola Other"]) assert.equal(noPassPerson(by[name]), false, name);
  const idx = buildDeskIndex(built.people, { aliases: built.byId });
  assert.deepEqual(idx.guests.map((g) => g.name).sort(), ["Exa Exhibitor", "Mel Media", "Noel Nopass", "Sia Speaker"]);
  const sia = deskNoPassFrom(by["Sia Speaker"]);
  assert.equal(sia.key, personKey(personSubject("u-u10")));
  assert.match(sia.key, /^n[0-9a-f]{20}$/);
  assert.ok(isGuestKey(sia.key), "an ISSUE PASS key is a guest key (actions accept it)");
  assert.deepEqual([sia.noPass, sia.tier, sia.passName, sia.norm, sia.company, sia.title], [true, null, null, "person:u-u10", "Talkco", "VP"]);
  assert.deepEqual(sia.extras, { cxo: false, lunch: false, gala: false, awards: false });
  assert.deepEqual([sia.band.key, sia.band.passName], ["speaker", NO_PASS_LABEL]);
  assert.equal(deskNoPassFrom(by["Mel Media"]).band.key, "vip", "the People band: VIP gold first");
  assert.equal(deskNoPassFrom(by["Mel Media"]).marks.vip, true);
  assert.equal(deskNoPassFrom(by["Noel Nopass"]).marks.speaker, true);
  // Volunteers: the row without who it is.
  const v = guestView(sia, { staff: false });
  assert.equal(v.noPass, true);
  assert.equal(v.band.key, "speaker");
  for (const k of ["personId", "email", "norm", "norms", "ticketIds"]) assert.ok(!(k in v), k);
  assert.ok(!JSON.stringify(v).includes("u10"));
  // On the wire: marks and notes on "person:<id>" travel by the person's key.
  assert.equal(keyOfSubject("person:u-u10"), sia.key);
  assert.equal(markView({ subject: "person:u-u10", day: "2026-10-26", point: "arrived", at: new Date(), rev: 1 }).key, sia.key);
  // Every id the person goes by resolves (a speaker's s- id once an account joins them, say).
  const noel = idx.guests.find((g) => g.name === "Noel Nopass");
  assert.equal(idx.byKey.get(personKey("person:s-spk-noel")).guest, noel);
});

test("C7: once a person on the ISSUE PASS list holds a pass, their old key still finds them and a tap on it lands on their main pass", async () => {
  const { personKey } = await import("../services/checkinDesk.js");
  const built = buildPeople({ users: [{ _id: "u20", name: "Exa Exhibitor", email: "exa@example.com", types: ["exhibitor"], tickets: [t("con000000030", "connect", { stripeSessionId: "cs30" })] }], attendees: [], rsvps: [], speakers: [] });
  const idx = buildDeskIndex(built.people, { aliases: built.byId });
  const old = idx.byKey.get(personKey("person:u-u20"));
  assert.equal(old.guest.name, "Exa Exhibitor");
  assert.equal(old.norm, "con000000030", "recorded on the pass");
  assert.equal(old.guest.noPass, undefined);
  assert.deepEqual(old.guest.keys, [guestKey("con000000030")], "the row's own keys stay the pass's");
});

test("C2: whose undo may take a tap back (a tombstone): staff's, or the author's from the same sign-in (C3)", async () => {
  const { tombCovers } = await import("../services/checkinDeskActions.js");
  const tap = { byId: "a1", sentFromId: "a1" };
  assert.equal(tombCovers({ byRole: "staff", byId: "s1" }, tap), true);
  assert.equal(tombCovers({ byRole: "volunteer", byId: "a1" }, tap), true);
  assert.equal(tombCovers({ byRole: "volunteer", byId: "b2" }, tap), false, "someone else's never hides the author's tap");
  assert.equal(tombCovers({ byRole: "volunteer", byId: "a1", signedInId: "b2" }, tap), false, "queued as a1 from b2's sign-in: only a tap sent from b2");
  assert.equal(tombCovers({ byRole: "volunteer", byId: "a1", signedInId: "b2" }, { byId: "a1", sentFromId: "b2" }), true);
  assert.equal(tombCovers({ byRole: "volunteer", byId: null }, { byId: null }), false);
});

test("C8 events carry who closed a card (byName), and the undo of an arrival its u: key", () => {
  const done = eventView({ seq: 5, kind: "unknown_done", subject: "u:t123456789", at: new Date("2026-10-26T13:30:00Z"), byName: "Vic", outcome: "left", ref: "u:t123456789" });
  assert.deepEqual([done.key, done.outcome, done.byName, done.at], ["u:t123456789", "left", "Vic", "2026-10-26T13:30:00.000Z"]);
  const link = eventView({ seq: 6, kind: "unknown_link", subject: "u:t123456789", at: new Date(), byName: "Sam", guestKey: "gabc", marks: [{ subject: "con000000010", day: "2026-10-26", point: "arrived", at: new Date(), rev: 1 }] });
  assert.deepEqual([link.key, link.guestKey, link.byName, link.marks[0].point], ["u:t123456789", "gabc", "Sam", "arrived"]);
  const undo = eventView({ seq: 7, kind: "undo", subject: "u:t123456789", ref: "t123456789", at: new Date(), byName: "Val" });
  assert.deepEqual([undo.key, undo.target, undo.byName], ["u:t123456789", "t123456789", "Val"]);
});
