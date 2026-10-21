/* "Available to meet" places per block (availabilitySpots, Oct 21 2026) and the read-receipt message DTO.
   Pure: services/availability.js, userCard / publicProfile / messageDTO (services/socialHelpers.js) and the
   attendee directory (services/ticketAccess.js). No database, no network. Fictional people. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanSpots, cleanPlace, spotsOf, spotsPatch, SPOT_KEY, SPOT_MAX } from "../services/availability.js";
import { userCard, publicProfile, messageDTO, CARD_SELECT } from "../services/socialHelpers.js";
import { buildDirectory } from "../services/ticketAccess.js";
import { sanitizeProfilePatch } from "../routes/profile.js";

const ALL = ["d1-08", "d1-10", "d1-12", "d1-14", "d1-16", "d1-18", "d2-08", "d2-10", "d2-12", "d2-14", "d2-16", "d2-18"];

test("block ids: d1 / d2 and the six two-hour starts only", () => {
  for (const id of ALL) assert.ok(SPOT_KEY.test(id), id);
  for (const id of ["d3-08", "d1-09", "d1-20", "d0-08", "d1-8", "d1-am", "D1-08", " d1-08", "d1-08 ", "__proto__", "constructor"]) {
    assert.ok(!SPOT_KEY.test(id), id);
  }
});

test("cleanSpots: valid keys that are picked, trimmed one-line places ≤ 60, empties dropped, block order", () => {
  const slots = ["d2-16", "d1-12", "d1-14", "d1-16"];
  const out = cleanSpots({
    "d2-16": "  Expo   floor ",
    "d1-12": "Harbour Ballroom foyer",
    "d1-14": "   ",                     // empty → dropped (meetingSpot applies)
    "d1-18": "Coffee bar",              // not picked → dropped
    "d3-08": "Nowhere",                 // not a block
    "d1-16": "x".repeat(200),          // capped
    "__proto__": "polluted",
    junk: "Hotel lobby",
  }, slots);
  assert.deepEqual(Object.keys(out), ["d1-12", "d1-16", "d2-16"]);
  assert.equal(out["d2-16"], "Expo floor");
  assert.equal(out["d1-12"], "Harbour Ballroom foyer");
  assert.equal(out["d1-16"].length, SPOT_MAX);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  // Non-string places and non-object inputs.
  assert.deepEqual(cleanSpots({ "d1-12": 5, "d1-14": ["Expo floor"], "d1-16": null }, slots), {});
  for (const bad of [null, undefined, "Expo floor", ["d1-12"], 7, true]) assert.deepEqual(cleanSpots(bad, slots), {});
  // No slots → nothing kept; a Map (Mongoose) is read like an object.
  assert.deepEqual(cleanSpots({ "d1-12": "Expo floor" }, []), {});
  assert.deepEqual(cleanSpots(new Map([["d1-12", "Expo floor"]]), ["d1-12"]), { "d1-12": "Expo floor" });
  // Newlines and tabs become single spaces.
  assert.equal(cleanPlace("Pier 4\n&\t5 foyer"), "Pier 4 & 5 foyer");
});

test("cleanSpots: at most 12 entries (every block of both days)", () => {
  const raw = Object.fromEntries(ALL.map((id, i) => [id, `Place ${i}`]));
  const out = cleanSpots(raw, ALL);
  assert.equal(Object.keys(out).length, 12);
  assert.deepEqual(Object.keys(out), ALL);
});

test("spotsPatch: saved with the slots of the same save; an older app's slots-only save drops places of unpicked blocks", () => {
  const user = { availabilitySlots: ["d1-12", "d1-14"], availabilitySpots: { "d1-12": "Expo floor", "d1-14": "Coffee bar" } };
  // Nothing about availability in the body → nothing to change.
  assert.deepEqual(spotsPatch({ jobTitle: "CTO" }, user, undefined), {});
  // New spots, checked against the stored slots.
  assert.deepEqual(spotsPatch({ availabilitySpots: { "d1-12": "Hotel lobby", "d2-08": "Expo floor" } }, user, undefined),
    { availabilitySpots: { "d1-12": "Hotel lobby" } });
  // New spots with new slots in the same save.
  assert.deepEqual(spotsPatch({ availabilitySpots: { "d2-08": "Expo floor" } }, user, ["d2-08"]), { availabilitySpots: { "d2-08": "Expo floor" } });
  // Slots only (an older app): stored places of blocks no longer picked go.
  assert.deepEqual(spotsPatch({ availabilitySlots: ["d1-14"] }, user, ["d1-14"]), { availabilitySpots: { "d1-14": "Coffee bar" } });
  // null clears; a non-object is ignored (alone: nothing to change).
  assert.deepEqual(spotsPatch({ availabilitySpots: null }, user, undefined), { availabilitySpots: {} });
  assert.deepEqual(spotsPatch({ availabilitySpots: "Expo floor" }, user, undefined), {});
  assert.deepEqual(spotsPatch({ availabilitySpots: "Expo floor" }, user, ["d1-12"]), { availabilitySpots: { "d1-12": "Expo floor" } });
  // The generic profile sanitiser never touches it (it's handled with the slots).
  assert.equal("availabilitySpots" in sanitizeProfilePatch({ availabilitySpots: { "d1-12": "Expo floor" } }), false);
});

test("spotsOf: always an object, re-checked against the slots (legacy or stray data never leaks out)", () => {
  assert.deepEqual(spotsOf({}), {});
  assert.deepEqual(spotsOf(null), {});
  assert.deepEqual(spotsOf({ availabilitySlots: ["d1-am"], meetingSpot: "Lobby" }), {});
  assert.deepEqual(spotsOf({ availabilitySlots: ["d1-12"], availabilitySpots: { "d1-12": "Expo floor", "d1-14": "Coffee bar" } }), { "d1-12": "Expo floor" });
});

test("cards, profiles and the directory carry availabilitySpots next to availabilitySlots and meetingSpot", () => {
  assert.ok(CARD_SELECT.split(" ").includes("availabilitySpots"));
  const ann = {
    _id: "64b000000000000000000001", name: "Ann Example", email: "ann@example.com", appOnboarded: true,
    tickets: [{ ticketId: "con1", type: "connect", purchaseDate: "2026-10-01" }],
    availabilitySlots: ["d1-12", "d1-14", "d2-08"], meetingSpot: "Harbour Ballroom foyer",
    availabilitySpots: { "d2-08": "Expo floor", "d1-18": "Coffee bar" },
  };
  const card = userCard(ann);
  assert.deepEqual(card.availabilitySlots, ["d1-12", "d1-14", "d2-08"]);
  assert.equal(card.meetingSpot, "Harbour Ballroom foyer");
  assert.deepEqual(card.availabilitySpots, { "d2-08": "Expo floor" });
  assert.deepEqual(publicProfile(ann).availabilitySpots, { "d2-08": "Expo floor" });
  assert.deepEqual(userCard({ _id: "64b000000000000000000002", name: "Ben" }).availabilitySpots, {});
  const [entry] = buildDirectory([ann], [], {});
  assert.deepEqual(entry.availabilitySpots, { "d2-08": "Expo floor" });
  assert.equal(entry.meetingSpot, "Harbour Ballroom foyer");
});

/* ---------- read receipts: the message DTO ---------- */

const ME = "64b0000000000000000000aa";
const THEM = "64b0000000000000000000bb";
const at = (m) => new Date(Date.UTC(2026, 9, 26, 12, m));
const msg = (o) => ({ _id: "64b0000000000000000000c1", body: "Hi", fromUserId: ME, toUserId: THEM, status: "approved", createdAt: at(0), ...o });

test("messageDTO: sent → delivered → read on my messages; null, never missing; read implies delivered", () => {
  const sent = messageDTO(msg({}), ME);
  assert.deepEqual(sent, { id: "64b0000000000000000000c1", body: "Hi", sentByMe: true, status: "approved", createdAt: at(0), deliveredAt: null, readAt: null });
  const json = JSON.parse(JSON.stringify(sent));
  assert.equal(json.deliveredAt, null);
  assert.equal(json.readAt, null);
  assert.deepEqual(messageDTO(msg({ deliveredAt: at(1) }), ME).deliveredAt, at(1));
  const read = messageDTO(msg({ deliveredAt: at(1), readAt: at(2) }), ME);
  assert.deepEqual([read.deliveredAt, read.readAt], [at(1), at(2)]);
  // A message read before deliveredAt existed counts as delivered when it was read.
  assert.deepEqual(messageDTO(msg({ readAt: at(3) }), ME).deliveredAt, at(3));
  // Their message to me.
  assert.equal(messageDTO(msg({ fromUserId: THEM, toUserId: ME }), ME).sentByMe, false);
  // Held: no ticks (the apps show a clock).
  const held = messageDTO(msg({ status: "held" }), ME);
  assert.deepEqual([held.status, held.deliveredAt, held.readAt], ["held", null, null]);
});

test("messageDTO masked (I'm hidden from the app, or they blocked me): delivered when sent, never read", () => {
  const m = msg({ deliveredAt: at(5), readAt: at(6) });
  const masked = messageDTO(m, ME, { masked: true });
  assert.deepEqual([masked.deliveredAt, masked.readAt], [at(0), null]);
  assert.deepEqual(messageDTO(msg({}), ME, { masked: true }).deliveredAt, at(0));   // even before their app fetched it
  // A held one stays a clock; their messages to me keep their own times.
  assert.deepEqual([messageDTO(msg({ status: "held" }), ME, { masked: true }).deliveredAt], [null]);
  const theirs = messageDTO(msg({ fromUserId: THEM, toUserId: ME, deliveredAt: at(1), readAt: at(2) }), ME, { masked: true });
  assert.deepEqual([theirs.deliveredAt, theirs.readAt], [at(1), at(2)]);
});
