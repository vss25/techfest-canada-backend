import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BRIEFING_KEY, copyOf, ticketTypeKey, usesBriefingDefaults } from "../services/ticketTypeDefaults.js";

test("Briefings use the default tickets; the Toronto Main Event never does", () => {
  assert.equal(usesBriefingDefaults("ttfc-2027-vancouver-briefing"), true);
  assert.equal(usesBriefingDefaults("ttfc-2027-toronto-briefing"), true);
  assert.equal(usesBriefingDefaults("ttfc-2027-toronto-main"), false);
  assert.equal(usesBriefingDefaults(DEFAULT_BRIEFING_KEY), false);
  assert.equal(usesBriefingDefaults(""), false);
});

test("a Briefing sells the default set until it has its own tickets", async () => {
  const own = new Set(["ttfc-2027-calgary-briefing"]);
  const Model = { exists: async ({ eventKey }) => (own.has(eventKey) ? { _id: 1 } : null) };
  assert.equal(await ticketTypeKey("ttfc-2027-vancouver-briefing", Model), DEFAULT_BRIEFING_KEY);
  assert.equal(await ticketTypeKey("ttfc-2027-calgary-briefing", Model), "ttfc-2027-calgary-briefing");
  assert.equal(await ticketTypeKey("ttfc-2027-toronto-main", Model), "ttfc-2027-toronto-main");
});

test("customising copies the ticket's fields onto the event, never its id", () => {
  const t = { _id: "x", eventKey: DEFAULT_BRIEFING_KEY, name: "Buy-side delegate", slug: "buy-side", priceCents: 14900, inclusions: ["All sessions"], active: true, createdAt: new Date() };
  const c = copyOf(t, "ttfc-2027-vancouver-briefing");
  assert.deepEqual(c, { eventKey: "ttfc-2027-vancouver-briefing", name: "Buy-side delegate", slug: "buy-side", priceCents: 14900, inclusions: ["All sessions"], active: true });
});
