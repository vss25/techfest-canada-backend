import { test } from "node:test";
import assert from "node:assert/strict";
import { planSync, isTicketSession } from "../services/stripeSync.js";

const T = 1790000000;                       // session.created (seconds)
const sess = (id, email, tier, created = T, { metadata = {}, ...extra } = {}) => ({
  id, created, payment_status: "paid", metadata: { tier, ...metadata },
  customer_details: { email, name: "Buyer" }, ...extra,
});
const att = (id, email, tier, at, extra = {}) => ({ _id: id, email, ticketType: tier, purchaseDate: new Date(at), ...extra });

test("one purchase that the old sync copied 3 times: keep the emailed ticket, hide the 3 copies", () => {
  const sessions = [sess("cs_1", "anvit@x.com", "connect")];
  const attendees = [
    att("a0", "anvit@x.com", "connect", T * 1000 + 4200),     // webhook ticket (emailed), seconds later
    att("a1", "anvit@x.com", "connect", T * 1000),            // sync copy #1
    att("a2", "anvit@x.com", "connect", T * 1000),            // sync copy #2
    att("a3", "Anvit@x.com", "connect", T * 1000),            // sync copy #3
  ];
  const p = planSync(sessions, attendees, []);
  assert.deepEqual(p.create, []);
  assert.deepEqual(p.hide.sort(), ["a1", "a2", "a3"]);
  assert.deepEqual(p.link.map((l) => [l.id, l.sessionId]), [["a0", "cs_1"]]);
});

test("account purchase: the ticket on the account wins, sync copies hidden", () => {
  const sessions = [sess("cs_2", "g@x.com", "apex", T, { metadata: { userId: "u1" } })];
  const users = [{ _id: "u1", email: "g@x.com", tickets: [{ ticketId: "t1", type: "apex", purchaseDate: new Date(T * 1000 + 2000) }] }];
  const attendees = [att("c1", "g@x.com", "apex", T * 1000), att("c2", "g@x.com", "apex", T * 1000)];
  const p = planSync(sessions, attendees, users);
  assert.deepEqual(p.hide.sort(), ["c1", "c2"]);
  assert.deepEqual(p.link.map((l) => [l.kind, l.ticketId]), [["user", "t1"]]);
  assert.equal(p.create.length, 0);
});

test("webhook never ran: keep one copy (the checked-in one), hide the rest", () => {
  const sessions = [sess("cs_3", "m@x.com", "influence")];
  const attendees = [att("d1", "m@x.com", "influence", T * 1000), att("d2", "m@x.com", "influence", T * 1000, { checkedIn: true })];
  const p = planSync(sessions, attendees, []);
  assert.deepEqual(p.hide, ["d1"]);
  assert.deepEqual(p.link.map((l) => l.id), ["d2"]);
});

test("already linked sessions are left alone and never re-imported", () => {
  const sessions = [sess("cs_4", "z@x.com", "power")];
  const attendees = [att("e1", "z@x.com", "power", T * 1000 + 1000, { stripeSessionId: "cs_4" })];
  const p = planSync(sessions, attendees, []);
  assert.deepEqual(p, { create: [], link: [], hide: [] });
});

test("two real purchases by the same person are two tickets", () => {
  const sessions = [sess("cs_5", "two@x.com", "connect", T), sess("cs_6", "two@x.com", "connect", T + 600)];
  const attendees = [att("f1", "two@x.com", "connect", T * 1000 + 3000), att("f2", "two@x.com", "connect", (T + 600) * 1000 + 3000)];
  const p = planSync(sessions, attendees, []);
  assert.deepEqual(p.hide, []);
  assert.deepEqual(p.link.map((l) => [l.id, l.sessionId]), [["f1", "cs_5"], ["f2", "cs_6"]]);
});

test("missing ticket is created; booths, upgrades, deposits and unpaid sessions are not tickets", () => {
  const p = planSync([sess("cs_7", "new@x.com", "connect")], [], []);
  assert.equal(p.create.length, 1);
  assert.equal(isTicketSession(sess("b", "a@x.com", "booth-single")), false);
  assert.equal(isTicketSession(sess("u", "a@x.com", "apex", T, { metadata: { type: "upgrade" } })), false);
  assert.equal(isTicketSession({ ...sess("p", "a@x.com", "x"), metadata: { type: "pavilion-deposit" } }), false);
  assert.equal(isTicketSession({ ...sess("n", "a@x.com", "connect"), payment_status: "unpaid" }), false);
});
