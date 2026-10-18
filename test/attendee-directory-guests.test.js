import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDirectory, guestName, guestWork, looksLikeTicketNumber, GUEST_FALLBACK_NAME, GUEST_DETAILS_SELECT,
} from "../services/ticketAccess.js";

/* GET /social/attendees: pass holders not on the app yet (unclaimed Attendee
   rows) show company + title from their checkout details, and never a ticket
   or order number as their name. */

test("looksLikeTicketNumber: digits or the ticket ID itself", () => {
  assert.equal(looksLikeTicketNumber("1234567"), true);
  assert.equal(looksLikeTicketNumber("#12 345-6"), true);
  assert.equal(looksLikeTicketNumber("A1B2C3D4E5F6", "a1b2c3d4e5f6"), true);
  assert.equal(looksLikeTicketNumber("TECHFEST:A1B2C3D4E5F6", "a1b2c3d4e5f6"), true);
  assert.equal(looksLikeTicketNumber("Jane Doe", "a1b2c3d4e5f6"), false);
  assert.equal(looksLikeTicketNumber("Agent 47"), false);
  assert.equal(looksLikeTicketNumber(""), false);
  assert.equal(looksLikeTicketNumber("#"), false);
});

test("guestName: stored name, else details name, else TTFC attendee", () => {
  assert.deepEqual(guestName({ name: "  Jane   Doe ", ticketId: "t1" }), { name: "Jane Doe", real: true });
  assert.deepEqual(guestName({ name: "48213377", ticketId: "t1", details: { firstName: "Raj", lastName: "Patel" } }),
    { name: "Raj Patel", real: true });
  assert.deepEqual(guestName({ name: "ABC123XYZ", ticketId: "abc123xyz" }), { name: GUEST_FALLBACK_NAME, real: false });
  assert.deepEqual(guestName({ name: "   ", ticketId: "t1" }), { name: "TTFC attendee", real: false });
  assert.deepEqual(guestName({ name: "", ticketId: "t1", details: { firstName: "Mo" } }), { name: "Mo", real: true });
  assert.deepEqual(guestName({ name: "998877", details: { firstName: "112233" } }), { name: "TTFC attendee", real: false });
  assert.deepEqual(guestName(null), { name: "TTFC attendee", real: false });
});

test("guestWork: company and title only, from the usual keys", () => {
  assert.deepEqual(guestWork({ organisation: " Acme  Ltd ", jobTitle: "CTO", phone: "+1 416", email: "x@y.z" }),
    { organization: "Acme Ltd", jobTitle: "CTO" });
  assert.deepEqual(guestWork({ organization: "Org Two", title: "VP" }), { organization: "Org Two", jobTitle: "VP" });
  assert.deepEqual(guestWork({ company: "Co Three" }), { organization: "Co Three", jobTitle: "" });
  assert.deepEqual(guestWork({ organisation: "", organization: "Fallback" }), { organization: "Fallback", jobTitle: "" });
  assert.deepEqual(guestWork({ organisation: 42, jobTitle: ["x"] }), { organization: "", jobTitle: "" });
  assert.deepEqual(guestWork(null), { organization: "", jobTitle: "" });
  assert.equal(guestWork({ jobTitle: "x".repeat(300) }).jobTitle.length, 120);
});

test("GUEST_DETAILS_SELECT names only the detail fields the directory reads", () => {
  const fields = GUEST_DETAILS_SELECT.split(" ");
  assert.ok(fields.every((f) => f.startsWith("details.")));
  for (const f of ["organisation", "organization", "company", "jobTitle", "title", "firstName", "lastName"]) assert.ok(fields.includes(`details.${f}`), f);
  for (const f of ["phone", "email", "linkedin"]) assert.equal(fields.includes(`details.${f}`), false, f);
});

test("buildDirectory: guests carry company + title, number names fall back, nothing else from details", () => {
  const guests = [
    { _id: "g1", name: "Jane Doe", email: "j@x.com", ticketId: "t1", ticketType: "connect", purchaseDate: "2026-09-01",
      details: { organisation: "Acme", jobTitle: "CTO", phone: "+1 416 555", linkedin: "https://linkedin.com/in/j", topics: ["AI"] } },
    { _id: "g2", name: "50012345", email: "n@x.com", ticketId: "t2", ticketType: "power", purchaseDate: "2026-09-01",
      details: { company: "Beta Co", title: "Analyst" } },
    { _id: "g3", name: "T3XYZ", email: "m@x.com", ticketId: "t3xyz", ticketType: "discover", purchaseDate: "2026-09-01" },
    { _id: "g4", name: "77777", email: "", ticketId: "t4", ticketType: "discover", purchaseDate: "2026-09-02" },
    { _id: "g5", name: "Guest", email: "z@x.com", ticketId: "t5", ticketType: "discover" },
  ];
  const dir = buildDirectory([], guests, {});
  const jane = dir.find((p) => p.id === "guest:g1");
  assert.deepEqual([jane.name, jane.organization, jane.jobTitle, jane.onApp], ["Jane Doe", "Acme", "CTO", false]);
  for (const k of ["email", "phone", "linkedin", "details", "ticketId", "ticketType"]) assert.equal(k in jane, false, k);
  assert.equal(jane.linkedinUrl, "");
  assert.deepEqual(jane.topics, []);
  const beta = dir.find((p) => p.id === "guest:g2");
  assert.deepEqual([beta.name, beta.organization, beta.jobTitle], ["TTFC attendee", "Beta Co", "Analyst"]);
  // Two different "TTFC attendee" guests are not merged into one person.
  assert.equal(dir.filter((p) => p.name === GUEST_FALLBACK_NAME).length, 3);
  assert.equal(dir.some((p) => /\d{5}|t3xyz/i.test(p.name)), false);
  assert.equal(dir.some((p) => p.id === "guest:g5"), false);   // "Guest" placeholders stay out, as before
});

test("buildDirectory: a guest's second pass fills an empty company / title; app users keep their profile", () => {
  const guests = [
    { _id: "g1", name: "Kim Lee", email: "k@x.com", ticketId: "a1", ticketType: "connect", purchaseDate: "2026-09-01" },
    { _id: "g2", name: "Kim Lee", email: "k@x.com", ticketId: "a2", ticketType: "connect", purchaseDate: "2026-09-02",
      details: { organisation: "Gamma", jobTitle: "Founder" } },
    { _id: "g3", name: "App Person", email: "app@x.com", ticketId: "a3", ticketType: "connect", purchaseDate: "2026-09-03",
      details: { organisation: "Old Co", jobTitle: "Old title" } },
  ];
  const users = [{ _id: "u1", name: "App Person", email: "app@x.com", jobTitle: "", organization: "New Co",
    lastActiveAt: "2026-10-01", tickets: [{ ticketId: "a0", type: "connect", purchaseDate: "2026-08-01" }] }];
  const dir = buildDirectory(users, guests, {});
  const kim = dir.find((p) => p.name === "Kim Lee");
  assert.deepEqual([kim.organization, kim.jobTitle], ["Gamma", "Founder"]);
  const app = dir.find((p) => p.id === "u1");
  assert.deepEqual([app.organization, app.jobTitle], ["New Co", ""]);
  assert.equal(dir.length, 2);
});
