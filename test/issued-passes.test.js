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
  // The Speaker Pass email is unchanged when no variant is given.
  const sp = buildSpeakerPassEmail({ name: "Jane Doe", ticketId: "abc" });
  assert.match(sp.html, /SPEAKER PASS/);
  assert.match(sp.html, /speaking at TTFC/);
});
