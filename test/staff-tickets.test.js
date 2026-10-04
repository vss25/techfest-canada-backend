import { test } from "node:test";
import assert from "node:assert/strict";
import { collectTickets, duplicateKeys, matchRows, salesSummary } from "../services/staffTickets.js";
import { cleanContent } from "../services/adminHelpers.js";

const d = (s) => new Date(s);
const users = [
  { _id: "u1", name: "Gunant Singh Pahwa", email: "g@x.com", tickets: [
    { ticketId: "t1", type: "influence", purchaseDate: d("2026-09-01") },
    { ticketId: "t2", type: "apex", purchaseDate: d("2026-09-20") },
    { ticketId: "t3", type: "connect", purchaseDate: d("2026-09-10"), hiddenByStaff: true },
  ] },
];
const guests = [
  { ticketId: "t2", name: "Gunant", email: "g@x.com", ticketType: "apex" },        // linked → shown once
  { ticketId: "g1", name: "Anvit Deshpande", email: "a@x.com", ticketType: "connect", purchaseDate: d("2026-09-15") },
  { ticketId: "g2", name: "Anvit Deshpande", email: "a@x.com", ticketType: "connect", purchaseDate: d("2026-09-16"), checkedIn: true },
  { ticketId: "BOOTH-SINGLE", name: "Booth", email: "b@x.com", ticketType: "booth-single" },
];

test("collects each ticket once, newest first, skipping booths", () => {
  const rows = collectTickets(users, guests);
  assert.deepEqual(rows.map((r) => r.ticketId), ["t2", "g2", "g1", "t3", "t1"]);
  assert.equal(rows.find((r) => r.ticketId === "t3").hidden, true);
});

test("duplicates keep each person's most recent visible ticket", () => {
  const rows = collectTickets(users, guests);
  assert.deepEqual(duplicateKeys(rows).sort(), ["g:g1", "u:u1:t1"]);
});

test("search by name ignores case and accents", () => {
  const rows = collectTickets(users, guests);
  assert.equal(matchRows(rows, "anvit").length, 2);
  assert.equal(matchRows(rows, "PAHWA").length, 3);
});

test("sales come from real purchase dates and skip hidden tickets", () => {
  const rows = collectTickets(users, guests);
  const s = salesSummary(rows, { influence: 799, apex: 1499, connect: 599 }, { range: "month", now: d("2026-09-30T12:00:00Z") });
  assert.equal(s.totals.totalTickets, 4);
  assert.equal(s.totals.totalRevenue, 799 + 1499 + 599 + 599);
  assert.equal(s.totals.hiddenTickets, 1);
  assert.equal(s.totals.uniqueBuyers, 2);
  assert.equal(s.totals.checkedIn, 1);
  assert.equal(s.sales.length, 30);
  assert.equal(s.sales.reduce((n, b) => n + b.tickets, 0), 3);   // t1 (Sep 1) is outside the 30-day window
  assert.equal(s.byTier[0].tier, "apex");
});

test("site settings are editable content keys", () => {
  assert.deepEqual(cleanContent("site.ticket_sales_open", "false"), ["site.ticket_sales_open", false]);
  assert.deepEqual(cleanContent("site.announcement", "Early bird ends Friday"), ["site.announcement", "Early bird ends Friday"]);
});
