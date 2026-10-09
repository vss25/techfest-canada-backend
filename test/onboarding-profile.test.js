import test from "node:test";
import assert from "node:assert/strict";
import { withCheckoutProfile, mirrorProfileToTickets, consentPatch } from "../services/onboardingProfile.js";

const ticket = (id, date, details) => ({ ticketId: id, type: "influence", purchaseDate: new Date(date), details });

test("checkout answers fill empty account fields; account values win", () => {
  const u = withCheckoutProfile({
    name: "Riley Chen", jobTitle: "", organization: "Own Co", topics: [], objectives: [],
    tickets: [ticket("A", "2026-09-01", { jobTitle: "Old title", organisation: "Ignored", topics: ["AI"] }),
              ticket("B", "2026-09-20", { jobTitle: "Head of Data", jobLevel: "Director", jobFunction: "Data", linkedin: "linkedin.com/in/x" })],
  });
  assert.equal(u.jobTitle, "Head of Data");          // newest ticket wins
  assert.equal(u.organization, "Own Co");            // account value kept
  assert.deepEqual(u.topics, ["AI"]);                // older ticket fills what the newer lacks
  assert.equal(u.fieldOfWork, "Data");
  assert.equal(u.linkedinUrl, "linkedin.com/in/x");
  assert.deepEqual(u.objectives, []);                // nothing invented
});

test("claimed guest rows count as sources; booths and blanks are ignored", () => {
  const u = withCheckoutProfile({ name: "", tickets: [] }, [{ purchaseDate: "2026-09-02", details: { firstName: "Sam", lastName: "Ortiz", jobTitle: "CTO" } }]);
  assert.equal(u.name, "Sam Ortiz");
  assert.equal(u.jobTitle, "CTO");
  assert.equal(withCheckoutProfile(null), null);
});

test("onboarding answers fill ticket detail gaps only, never overwrite checkout", () => {
  const user = { name: "Alex Rivera", jobTitle: "PM", organization: "Acme", topics: ["AI", "Cyber"], objectives: [],
    tickets: [ticket("T1", "2026-09-01", { jobTitle: "Checkout title", source: "checkout" }), ticket("T2", "2026-09-02"), { ticketId: "BOOTH-1" }] };
  const changes = mirrorProfileToTickets(user, new Date("2026-10-09T00:00:00Z"));
  assert.equal(changes.length, 2);
  const [t1, t2] = changes;
  assert.equal(t1.details.jobTitle, "Checkout title");
  assert.equal(t1.details.organisation, "Acme");
  assert.equal(t1.details.source, "checkout");
  assert.equal(t2.details.firstName, "Alex");
  assert.equal(t2.details.lastName, "Rivera");
  assert.deepEqual(t2.details.topics, ["AI", "Cyber"]);
  assert.equal(t2.details.source, "app");
  assert.equal(t2.details.objectives, undefined);
  assert.equal(mirrorProfileToTickets({ name: "A", tickets: [ticket("X", "2026-09-01", { firstName: "A" })] }).length, 0);
});

test("consent: server stamps times; age is confirmed once; terms re-stamp on a new version", () => {
  const now = new Date("2026-10-09T12:00:00Z");
  assert.deepEqual(consentPatch({ ageConfirmed: true, termsVersion: "2026-10" }, {}, now),
    { ageConfirmedAt: now, termsVersion: "2026-10", termsAcceptedAt: now });
  assert.deepEqual(consentPatch({ ageConfirmed: true, termsVersion: "2026-10" }, { ageConfirmedAt: now, termsVersion: "2026-10" }, now), {});
  assert.deepEqual(consentPatch({ ageConfirmed: "yes", termsVersion: 3 }, {}, now), {});
});
