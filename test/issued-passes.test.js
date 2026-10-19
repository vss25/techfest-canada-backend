import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ISSUED_PROMO, issuedPassDoc, issuedPassRow, issuedPassUpdate, issuedVariant, validateIssuedPass,
} from "../services/issuedPasses.js";
import { buildSpeakerPassEmail } from "../services/speakerPassEmail.js";

test("validateIssuedPass: name, emails, tier and the optional extras", () => {
  const ok = validateIssuedPass({ name: " Jane  Doe ", email: "J@x.com, ea@x.com", tier: "Apex", title: "CTO", rsvp: false, subject: "Hi {firstName}" });
  assert.ok(ok.ok);
  assert.deepEqual(ok.value.emails, ["j@x.com", "ea@x.com"]);
  assert.equal(ok.value.tier, "apex");
  assert.equal(ok.value.rsvp, false);
  assert.deepEqual(ok.value.copy, { subject: "Hi {firstName}" });
  assert.match(validateIssuedPass({ name: "Jane", email: "j@x.com", tier: "power" }).error, /first and last name/);
  assert.match(validateIssuedPass({ name: "Jane Doe", email: "j@x.com", tier: "gold" }).error, /Pass must be one of/);
  // Strictly four passes: the old "Speaker / All Access" tier is gone, and its names are never printed.
  assert.match(validateIssuedPass({ name: "Jane Doe", email: "j@x.com", tier: "speaker" }).error, /Pass must be one of: connect, influence, power, apex\./);
  for (const label of ["Speaker Pass", "All Access Pass", "exhibitor pass"]) {
    assert.equal(validateIssuedPass({ label }, { partial: true }).value.label, "", label);
  }
  assert.deepEqual(validateIssuedPass({ label: "VIP Guest" }, { partial: true }).value, { label: "VIP Guest" });
});

test("issuedPassDoc → an Attendee that works like any ticket", () => {
  const v = validateIssuedPass({ name: "Jane Q Doe", email: "j@x.com, ea@x.com", tier: "power", company: "Acme", label: "VIP Guest Pass" }).value;
  const d = issuedPassDoc(v, { ticketId: "abc123abc123", by: "Gunant" });
  assert.equal(d.promoCode, ISSUED_PROMO);
  assert.equal(d.ticketType, "power");
  assert.equal(d.email, "j@x.com");
  assert.deepEqual(d.alsoTo, ["ea@x.com"]);
  assert.equal(d.details.lastName, "Doe");
  assert.equal(d.details.organisation, "Acme");
  const row = issuedPassRow({ _id: "1", ...d });
  assert.equal(row.status, "ready");
  assert.equal(row.tierLabel, "Power Pass");
  assert.equal(row.label, "VIP Guest Pass");
  assert.deepEqual(issuedPassUpdate({ tier: "apex", rsvp: false }, d), { ticketType: "apex", "issuedPass.rsvp": false });
});

test("the email follows the pass: label, access, inclusions, RSVP on/off, wording", () => {
  const pass = { ticketType: "apex", issuedPass: { label: "VIP Guest Pass", rsvp: false } };
  const e = buildSpeakerPassEmail({ name: "Jane Doe", ticketId: "abc123", variant: issuedVariant(pass) });
  assert.equal(e.subject, "Jane, your VIP Guest Pass for TTFC 2026");
  assert.match(e.html, /VIP GUEST PASS/);
  assert.match(e.html, /All Access \+ Apex/);
  assert.match(e.html, /Pre-Matched Business Meetings/);
  assert.doesNotMatch(e.html, /RSVP Now/);
  assert.doesNotMatch(e.html, /speaking at TTFC/);
  const connect = buildSpeakerPassEmail({ name: "Sam Lee", ticketId: "x", variant: issuedVariant({ ticketType: "connect" }), copy: { headline: "Welcome, {firstName}!" } });
  assert.match(connect.html, /CONNECT PASS/);
  assert.match(connect.html, /RSVP Now/);
  assert.match(connect.html, /Welcome, Sam!/);
  assert.doesNotMatch(connect.html, /CxO Breakfasts/);
  // The speakers' email (no variant) is their Power Pass.
  const sp = buildSpeakerPassEmail({ name: "Jane Doe", ticketId: "abc" });
  assert.match(sp.html, /POWER PASS/);
  assert.match(sp.html, /speaking at TTFC/);
  assert.doesNotMatch(sp.html + sp.text, /Speaker Pass|All Access Pass/i);
});

test("an old Speaker / All Access issued pass is a Power Pass marked as a speaker's: breakfasts and the VIP Lounge stay", () => {
  // As the migration leaves it (services/fourPasses.js): ticketType power, speakerPass true, the old label cleared.
  const migrated = { _id: "9", ticketType: "power", speakerPass: true, promoCode: "ISSUED", name: "Kim Lee", email: "kim@example.com", issuedPass: { label: "", rsvp: true } };
  const v = issuedVariant(migrated);
  assert.equal(v.label, "Power Pass");
  assert.equal(v.access, "All Access · Speaker");
  assert.ok(v.includes.some((r) => r[0] === "2× CxO Breakfasts"));
  assert.ok(v.includes.some((r) => r[0] === "The VIP Lounge"));
  assert.match(v.rsvpReason, /CxO breakfasts/);
  const row = issuedPassRow(migrated);
  assert.deepEqual([row.tier, row.tierLabel, row.speaker, row.cxoEffective], ["power", "Power Pass", true, true]);
  // Not yet migrated (ticketType "speaker", label "All Access Pass"): read the same way.
  const old = issuedVariant({ ticketType: "speaker", issuedPass: { label: "All Access Pass" } });
  assert.deepEqual([old.label, old.includes.some((r) => r[0] === "The VIP Lounge")], ["Power Pass", true]);
  const e = buildSpeakerPassEmail({ name: "Kim Lee", ticketId: "abc", variant: v });
  assert.match(e.subject, /your Power Pass/);
  assert.doesNotMatch(e.html + e.text + e.subject, /Speaker Pass|All Access Pass|Exhibitor Pass/i);
  // A plain Power Pass has neither.
  const plain = issuedVariant({ ticketType: "power" });
  assert.deepEqual([plain.access, plain.includes.some((r) => /CxO|VIP Lounge/.test(r[0]))], ["All Access", false]);
});
