import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTicketId, lastNameMatches, latestTicket, buildDirectory, makeLimiter, passName } from "../services/ticketAccess.js";

test("normalizeTicketId strips the QR prefix, spaces and case", () => {
  assert.equal(normalizeTicketId(" TECHFEST:A1B2 C3D4E5F6 "), "a1b2c3d4e5f6");
  assert.equal(normalizeTicketId(null), "");
});

test("lastNameMatches handles multi-word surnames, accents and hyphens", () => {
  assert.ok(lastNameMatches("Gunant Singh Pahwa", "pahwa"));
  assert.ok(lastNameMatches("Gunant Singh Pahwa", "Singh Pahwa"));
  assert.ok(lastNameMatches("Élodie Côté", "cote"));
  assert.ok(lastNameMatches("Liz Sherwood-Randall", "sherwood randall"));
  assert.ok(!lastNameMatches("Gunant Singh Pahwa", "Gunant"));
  assert.ok(!lastNameMatches("Alex Tester", "t"));
  assert.ok(lastNameMatches("Madonna", "madonna"));
});

test("latestTicket picks the most recent purchase and ignores booths", () => {
  const t = latestTicket([
    { ticketId: "a", type: "connect", purchaseDate: "2026-08-01" },
    { ticketId: "b", type: "power", purchaseDate: "2026-09-15" },
    { ticketId: "BOOTH-GOLD", type: "gold", purchaseDate: "2026-10-01" },
  ]);
  assert.equal(t.ticketId, "b");
  assert.equal(latestTicket([]), null);
});

test("buildDirectory merges duplicate buyers, keeps most recent pass, never leaks email", () => {
  const users = [
    { _id: "u1", name: "Gunant Singh Pahwa", email: "g@x.com", jobTitle: "Founder", organization: "AtlasLink",
      lastActiveAt: "2026-10-01", tickets: [{ ticketId: "t1", type: "connect", purchaseDate: "2026-08-01" }] },
    { _id: "me", name: "Me", email: "me@x.com", tickets: [{ ticketId: "t9", type: "power", purchaseDate: "2026-08-01" }] },
    { _id: "u2", name: "Hidden", email: "h@x.com", directoryHidden: true, tickets: [{ ticketId: "t8", type: "power" }] },
  ];
  const guests = [
    ...Array.from({ length: 9 }, (_, i) => ({ _id: `g${i}`, name: "Gunant Singh Pahwa", email: "g@x.com", ticketId: `x${i}`,
      ticketType: i === 8 ? "power" : "discover", purchaseDate: `2026-09-0${i + 1}` })),
    { _id: "g20", name: "Casey Guest", email: "c@x.com", ticketId: "y1", ticketType: "influence", purchaseDate: "2026-09-01" },
    { _id: "g21", name: "Casey Guest", email: "c2@x.com", ticketId: "y2", ticketType: "discover", purchaseDate: "2026-09-20" },
    { _id: "g22", name: "Guest", email: "z@x.com", ticketId: "y3", ticketType: "discover" },
  ];
  const dir = buildDirectory(users, guests, { excludeUserId: "me", excludeEmail: "me@x.com" });
  assert.equal(dir.length, 2);
  const g = dir.find((p) => p.name === "Gunant Singh Pahwa");
  assert.equal(g.onApp, true);   // has signed into the app
  assert.equal(g.tier, "Power Pass");
  assert.equal(g.organization, "AtlasLink");
  const c = dir.find((p) => p.name === "Casey Guest");
  assert.equal(c.onApp, false);
  assert.equal(c.tier, "Discover Pass");
  for (const p of dir) assert.equal(p.email, undefined);
  assert.equal(dir[0].onApp, true);
});

test("limiter blocks after max attempts", () => {
  const l = makeLimiter({ max: 2, windowMs: 1000 });
  assert.ok(l.hit("k")); assert.ok(l.hit("k")); assert.ok(!l.hit("k"));
  l.reset("k"); assert.ok(l.hit("k"));
});

test("passName", () => {
  assert.equal(passName("influence"), "Influence Pass");
  assert.equal(passName("session"), "Session Pass");
});

test("website-only accounts are not 'on the app' until they sign into it", () => {
  const users = [
    { _id: "w1", name: "Web Only", email: "w@x.com", tickets: [{ ticketId: "t1", type: "connect" }] },
    { _id: "a1", name: "App User", email: "a@x.com", appOnboarded: true, tickets: [{ ticketId: "t2", type: "connect" }] },
  ];
  const dir = buildDirectory(users, []);
  assert.equal(dir.find((p) => p.name === "Web Only").onApp, false);
  assert.equal(dir.find((p) => p.name === "App User").onApp, true);
});

test("people on the app appear even without a ticket", () => {
  const dir = buildDirectory([{ _id: "v1", name: "Vishwa", email: "v@x.com", lastActiveAt: "2026-10-03", tickets: [] },
                              { _id: "n1", name: "No Ticket", email: "n@x.com", tickets: [] }], []);
  assert.deepEqual(dir.map((p) => [p.name, p.onApp, p.tier]), [["Vishwa", true, ""]]);
});
