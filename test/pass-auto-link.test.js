/* Passes sent to an account's email reach its app (Oct 24 2026), the pure plan: services/passAutoLink.js planPassLinks.
   Fictional people, example.com. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SKIP_REASONS, planPassLinks, ticketFromPass } from "../services/passAutoLink.js";

const ME = { _id: "u1", name: "Killian Sullivan", email: "killian@example.com", tickets: [{ ticketId: "aaa111aaa111" }] };
const pass = (ticketId, name, extra = {}) => ({ _id: `a-${ticketId}`, ticketId, ticketType: "apex", name, email: "killian@example.com", ...extra });
const why = (plan) => Object.fromEntries(plan.skip.map((s) => [s.pass.ticketId, s.why]));

test("pass auto-link: the account's own pass links; a colleague's under the buyer's email never does", () => {
  const plan = planPassLinks({
    account: ME,
    passes: [
      pass("bbb222bbb222", "Killian Sullivan"),
      pass("ccc333ccc333", "Milorad Stefanovic"),
      pass("ddd444ddd444", "Glen Webster", { details: { firstName: "Glen", lastName: "Webster" } }),
      // The checkout form's name wins over the record's.
      pass("eee555eee555", "Killian Sullivan", { details: { firstName: "Glen", lastName: "Webster" } }),
      // A pass that names nobody is the account's (the email is theirs).
      pass("fff666fff666", ""),
      // Any case, stray spaces in the email.
      pass("ggg777ggg777", "killian sullivan", { email: " Killian@Example.COM " }),
    ],
  });
  assert.deepEqual(plan.link.map((a) => a.ticketId), ["bbb222bbb222", "fff666fff666", "ggg777ggg777"]);
  assert.deepEqual(why(plan), { ccc333ccc333: "name_differs", ddd444ddd444: "name_differs", eee555eee555: "name_differs" });
});

test("pass auto-link: hidden, duplicates, refunds, booths, someone else's and another account's are left out; linked ones are quiet", () => {
  const plan = planPassLinks({
    account: ME,
    heldElsewhere: new Set(["hhh888hhh888"]),
    stripeRows: [{ id: "cs_refunded", total: 500, refunded: 500 }, { id: "cs_part", total: 500, refunded: 100 }],
    passes: [
      pass("h1dden000001", "Killian Sullivan", { hiddenByStaff: true }),
      pass("dup000000001", "Killian Sullivan", { syncDuplicate: true }),
      pass("ref000000001", "Killian Sullivan", { stripeSessionId: "cs_refunded" }),
      pass("prt000000001", "Killian Sullivan", { stripeSessionId: "cs_part" }),
      pass("BOOTH-A12", "Killian Sullivan"),
      pass("oth000000001", "Killian Sullivan", { claimedBy: "u2" }),
      pass("hhh888hhh888", "Killian Sullivan"),
      // Already linked: claimed by him and on his account.
      pass("aaa111aaa111", "Killian Sullivan", { claimedBy: "u1" }),
      // Claimed by him but not on his account (an old half-link): put back on it, whatever the name.
      pass("hal000000001", "Somebody Else", { claimedBy: "u1" }),
      // Another email.
      pass("xyz000000001", "Killian Sullivan", { email: "k.sullivan@example.org" }),
      // A placeholder email never links.
      pass("plc000000001", "Killian Sullivan", { email: "x1@ticket.thetechfestival.com" }),
    ],
  });
  assert.deepEqual(plan.link.map((a) => a.ticketId), ["prt000000001", "hal000000001"]);
  assert.deepEqual(why(plan), {
    h1dden000001: "hidden", dup000000001: "duplicate", ref000000001: "refunded", "BOOTH-A12": "booth",
    oth000000001: "claimed_by_other", hhh888hhh888: "on_other_account",
  });
  for (const k of Object.values(why(plan))) assert.ok(SKIP_REASONS[k], k);
  // An account on a placeholder email links nothing.
  assert.deepEqual(planPassLinks({ account: { ...ME, email: "x1@ticket.thetechfestival.com" }, passes: [pass("plc000000001", "Killian Sullivan", { email: "x1@ticket.thetechfestival.com" })] }).link, []);
  assert.deepEqual(planPassLinks({ account: null, passes: [pass("bbb222bbb222", "Killian Sullivan")] }), { link: [], skip: [] });
});

test("pass auto-link: the ticket keeps the pass's ID and what was given at checkout", () => {
  const at = new Date("2026-10-01T12:00:00Z");
  assert.deepEqual(ticketFromPass({ ticketId: "ab9ade3fed48", ticketType: "apex", purchaseDate: at, checkedIn: false, details: { firstName: "Gus" } }),
    { ticketId: "ab9ade3fed48", type: "apex", purchaseDate: at, checkedIn: false, checkedInAt: undefined, details: { firstName: "Gus" } });
});
