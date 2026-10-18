import test from "node:test";
import assert from "node:assert/strict";
import {
  canMessage, canRequest, contactFlags, contactFirstName, messagesOffError, requestsOffError,
} from "../services/contactSwitches.js";
import { applyAccess } from "../services/contactAccess.js";
import { userCard, publicProfile, CARD_SELECT, PROFILE_SELECT } from "../services/socialHelpers.js";
import { buildDirectory } from "../services/ticketAccess.js";

const attendee = { _id: "a1", name: "Ann Lee", role: "user" };
const staff = { _id: "s1", name: "Sam Staff", role: "admin" };
const vip = { _id: "v1", name: "Hon. Mélanie Joly", role: "user", messagesOff: true, requestsOff: true };
const open = { _id: "o1", name: "Olu Open", role: "user" };

/* ---------- requests ---------- */

test("canRequest: anyone can ask someone without the switch", () => {
  assert.equal(canRequest({ sender: attendee, target: open }), true);
  assert.equal(canRequest({ sender: attendee, target: { ...open, requestsOff: false } }), true);
});

test("canRequest: requests off refuses attendees, allows staff", () => {
  assert.equal(canRequest({ sender: attendee, target: vip }), false);
  assert.equal(canRequest({ sender: staff, target: vip }), true);
});

test("canRequest: the VIP can still ask others (the switch is on the target only)", () => {
  assert.equal(canRequest({ sender: vip, target: attendee }), true);
});

/* ---------- messages ---------- */

test("canMessage: no switch, anyone can write", () => {
  assert.equal(canMessage({ sender: attendee, recipient: open }), true);
});

test("canMessage: messages off refuses a cold message", () => {
  assert.equal(canMessage({ sender: attendee, recipient: vip }), false);
  assert.equal(canMessage({ sender: attendee, recipient: vip, connected: false, theyWroteFirst: false }), false);
});

test("canMessage: messages off still allows staff, accepted connections and replies", () => {
  assert.equal(canMessage({ sender: staff, recipient: vip }), true);
  assert.equal(canMessage({ sender: attendee, recipient: vip, connected: true }), true);
  assert.equal(canMessage({ sender: attendee, recipient: vip, theyWroteFirst: true }), true);
});

test("canMessage: the VIP can message out", () => {
  assert.equal(canMessage({ sender: vip, recipient: attendee }), true);
});

test("missing inputs are safe", () => {
  assert.equal(canMessage(), true);
  assert.equal(canRequest(), true);
  assert.equal(canMessage({ recipient: vip }), false);
  assert.equal(canRequest({ target: vip }), false);
});

/* ---------- error lines ---------- */

test("error lines use the first name, without honorifics", () => {
  assert.equal(messagesOffError(vip), "Mélanie isn't taking messages in the app.");
  assert.equal(requestsOffError(vip), "Mélanie isn't taking connection requests in the app.");
  assert.equal(contactFirstName({ name: "The Honourable  Jane   Doe" }), "Jane");
  assert.equal(contactFirstName({ name: "Rt. Hon. Sir Keir Starmer" }), "Keir");
  assert.equal(contactFirstName({ name: "Dr Ada Lovelace" }), "Ada");
  assert.equal(contactFirstName({ name: "Ann Lee" }), "Ann");
  assert.equal(contactFirstName({ name: "" }), "");
  assert.equal(contactFirstName({ name: "Guest" }), "");
  assert.equal(messagesOffError({ name: "" }), "This person isn't taking messages in the app.");
  assert.equal(requestsOffError(null), "This person isn't taking connection requests in the app.");
});

/* ---------- cards ---------- */

test("userCard exposes the switches as acceptsMessages / acceptsRequests", () => {
  const c = userCard({ ...vip, email: "m@x.com" });
  assert.equal(c.acceptsMessages, false);
  assert.equal(c.acceptsRequests, false);
  assert.equal("messagesOff" in c, false);
  assert.equal("email" in c, false);
  const o = userCard(open);   // field missing (older accounts) reads as accepting
  assert.equal(o.acceptsMessages, true);
  assert.equal(o.acceptsRequests, true);
  const mixed = userCard({ ...open, messagesOff: true });
  assert.deepEqual([mixed.acceptsMessages, mixed.acceptsRequests], [false, true]);
  assert.equal(publicProfile(vip).acceptsMessages, false);
});

test("card queries select the switch fields", () => {
  for (const sel of [CARD_SELECT, PROFILE_SELECT]) {
    const f = sel.split(/\s+/);
    assert.ok(f.includes("messagesOff") && f.includes("requestsOff"), sel);
  }
});

test("contactFlags + applyAccess give the viewer's view of a card", () => {
  const card = userCard(vip);
  assert.deepEqual(contactFlags({ viewer: attendee, user: vip }), { acceptsMessages: false, acceptsRequests: false });
  assert.deepEqual(contactFlags({ viewer: attendee, user: vip, connected: true }), { acceptsMessages: true, acceptsRequests: false });
  assert.deepEqual(contactFlags({ viewer: staff, user: vip }), { acceptsMessages: true, acceptsRequests: true });
  const access = new Map([["v1", contactFlags({ viewer: attendee, user: vip, theyWroteFirst: true })]]);
  const seen = applyAccess(card, access);
  assert.equal(seen.acceptsMessages, true);
  assert.equal(seen.acceptsRequests, false);
  assert.equal(seen.name, card.name);
  assert.equal(applyAccess(userCard(open), access).acceptsMessages, true);   // not in the map: unchanged
  assert.equal(applyAccess(null, access), null);
});

test("directory entries carry the same flags; guests read as accepting", () => {
  const dir = buildDirectory(
    [{ _id: "v1", name: "Hon. Mélanie Joly", email: "m@x.com", appOnboarded: true, messagesOff: true, tickets: [{ ticketId: "t1", type: "power" }] }],
    [{ _id: "g1", name: "Casey Guest", email: "c@x.com", ticketId: "y1", ticketType: "discover" }],
  );
  const m = dir.find((p) => p.id === "v1");
  assert.deepEqual([m.acceptsMessages, m.acceptsRequests], [false, true]);
  const g = dir.find((p) => p.id === "guest:g1");
  assert.deepEqual([g.onApp, g.acceptsMessages, g.acceptsRequests], [false, true, true]);
});
