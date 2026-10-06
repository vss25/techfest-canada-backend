import { test } from "node:test";
import assert from "node:assert/strict";
import { detailsFromMetadata, displayName } from "../services/attendeeDetails.js";
import { planDetailsBackfill } from "../services/stripeSync.js";
import { matchRows } from "../services/staffTickets.js";

test("checkout metadata becomes stored details", () => {
  const d = detailsFromMetadata({
    tier: "apex", userId: "u1", firstName: " Jane ", lastName: "Doe", organisation: "Acme",
    jobTitle: "CTO", businessNumber: "+1 416 555 0100", jobLevel: "Other", jobLevelOther: "Founder",
    topics: "AI; Banking, Financial Services & Insurance", objectives: "Hiring", consentUpdates: "true", basePrice: "1499",
  });
  assert.deepEqual(d, {
    firstName: "Jane", lastName: "Doe", jobTitle: "CTO", organisation: "Acme", phone: "+1 416 555 0100",
    jobLevel: "Other: Founder", topics: ["AI", "Banking, Financial Services & Insurance"], objectives: ["Hiring"], consentUpdates: true,
    source: "checkout",
  });
  assert.equal(displayName(d, "CARD HOLDER"), "Jane Doe");
});

test("no form answers → null, and the card name is the fallback", () => {
  assert.equal(detailsFromMetadata({ tier: "power", type: "ticket", promoCode: "" }), null);
  assert.equal(detailsFromMetadata(undefined), null);
  assert.equal(displayName(null, "Card Name"), "Card Name");
});

test("backfill fills only linked tickets that are missing details", () => {
  const sessions = [
    { id: "cs_1", payment_status: "paid", customer_details: { email: "a@x.com" }, metadata: { tier: "power", firstName: "Ann", organisation: "Acme" } },
    { id: "cs_2", payment_status: "paid", customer_details: { email: "b@x.com" }, metadata: { tier: "apex", jobTitle: "VP" } },
    { id: "cs_3", payment_status: "paid", customer_details: { email: "c@x.com" }, metadata: { tier: "booth-single", organisation: "Booth Co" } },
  ];
  const attendees = [
    { _id: "g1", name: "Guest", stripeSessionId: "cs_1" },
    { _id: "g2", name: "Has", stripeSessionId: "cs_2", details: { jobTitle: "old" } },
    { _id: "g3", name: "Booth", stripeSessionId: "cs_3" },
  ];
  const users = [{ _id: "u1", tickets: [{ ticketId: "t1", stripeSessionId: "cs_2" }] }];
  const plan = planDetailsBackfill(sessions, attendees, users);
  assert.deepEqual(plan.map((p) => p.kind + ":" + (p.id || p.ticketId)), ["attendee:g1", "user:t1"]);
  assert.equal(plan[0].name, "Ann");
  assert.equal(plan[1].details.jobTitle, "VP");
});

test("staff search matches company and job title", () => {
  const rows = [
    { name: "Jane", email: "j@x.com", ticketId: "aa", details: { organisation: "Scotiabank", jobTitle: "CISO" } },
    { name: "Bob", email: "b@x.com", ticketId: "bb", details: null },
  ];
  assert.equal(matchRows(rows, "scotia").length, 1);
  assert.equal(matchRows(rows, "ciso")[0].name, "Jane");
});

import { workDomain, orgFromEmail, cleanStaffEdit, mergeStaffEdit } from "../services/attendeeDetails.js";

test("organisation hint from a work email", () => {
  assert.equal(orgFromEmail("dominic@deepcovecyber.com"), "deepcovecyber.com");
  assert.equal(orgFromEmail("nik@nbc.ca"), "National Bank of Canada");
  assert.equal(orgFromEmail("a@uwo.ca"), "Western University");
  assert.equal(orgFromEmail("b.g@ised-isde.gc.ca"), "Innovation, Science and Economic Development Canada");
  assert.equal(workDomain("x@mail.sub.example.co.uk"), "example.co.uk");
  assert.equal(orgFromEmail("noah@gmail.com"), "");
  assert.equal(orgFromEmail(""), "");
});

test("staff edits are whitelisted, trimmed, and empty clears", () => {
  const edit = cleanStaffEdit({ organisation: " Deep Cove Cyber ", jobTitle: "", isAdmin: true, notes: "VIP" });
  assert.deepEqual(edit, { organisation: "Deep Cove Cyber", jobTitle: "", notes: "VIP" });
  const merged = mergeStaffEdit({ jobTitle: "CTO", topics: ["AI"] }, edit);
  assert.deepEqual(merged, { topics: ["AI"], organisation: "Deep Cove Cyber", notes: "VIP", editedByStaff: true });
});
