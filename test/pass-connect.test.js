/* Connect by pass (C-PASS, Oct 24 2026), the pure parts (services/passConnect.js): the forms a scanned code can take,
   which account holds a ticket (never a buyer for a colleague's pass), passes that don't count, the answers and the
   push. No cap on scans (the organiser, Oct 24 2026). The route: test/connect-by-pass-db.test.js. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PASS_CONNECT_ERRORS, passConnectPush, passConnectNotification, passVariants, pickHolder, sessionRefunded, passIsOut,
} from "../services/passConnect.js";

test("every QR form of a ticket gives the stored form and the forms to look up", () => {
  for (const raw of ["TECHFEST:a1b2c3d4e5f6", "techfest:A1B2C3D4E5F6", "A1B2C3D4E5F6", " a1b2 c3d4 e5f6 ", "TECHFEST: a1b2c3d4e5f6\n"]) {
    const { typed, variants } = passVariants(raw);
    assert.equal(typed, "a1b2c3d4e5f6", JSON.stringify(raw));
    assert.ok(variants.includes("a1b2c3d4e5f6"));
    assert.ok(variants.includes("A1B2C3D4E5F6"));
  }
  // Not a pass: empty, too short, a connect QR, a link.
  for (const raw of ["", null, undefined, "TECHFEST:", "abc", "TTFC2026|C|Ada|x|y|z|w|id|123456", "https://example.com/x"]) {
    assert.deepEqual(passVariants(raw), { typed: "", variants: [] }, JSON.stringify(raw));
  }
});

test("the holder of a ticket on accounts: the one whose name the pass carries, or who claimed it; never the buyer", () => {
  const ada = { _id: "u1", name: "Ada Lovelace", tickets: [{ ticketId: "a1b2c3d4e5f6" }] };
  assert.equal(pickHolder({ holders: [ada], typed: "a1b2c3d4e5f6" }).account, ada);
  // Bought by Bob for Cara (the checkout form names her): not Bob's.
  const bob = { _id: "u2", name: "Bob Buyer", tickets: [{ ticketId: "C0FFEE000001", details: { firstName: "Cara", lastName: "Colleague" } }] };
  const picked = pickHolder({ holders: [bob], typed: "c0ffee000001" });
  assert.equal(picked.account, null);
  assert.equal(picked.ticket.ticketId, "C0FFEE000001");
  // Claimed by the account: theirs whatever the name.
  assert.equal(pickHolder({ holders: [bob], typed: "c0ffee000001", attendee: { claimedBy: "u2", name: "Cara Colleague" } }).account, bob);
  // Old data with the ticket on two accounts: the one the name agrees with.
  const cara = { _id: "u3", name: "Cara Colleague", tickets: [{ ticketId: "c0ffee000001", details: { firstName: "Cara", lastName: "Colleague" } }] };
  assert.equal(pickHolder({ holders: [bob, cara], typed: "c0ffee000001" }).account, cara);
  assert.deepEqual(pickHolder({ holders: [], typed: "x" }), { account: null, ticket: null });
});

test("passes that don't count: hidden by staff, sync duplicates, fully refunded", () => {
  assert.equal(passIsOut({ ticket: { hiddenByStaff: true } }), true);
  assert.equal(passIsOut({ attendee: { hiddenByStaff: true } }), true);
  assert.equal(passIsOut({ attendee: { syncDuplicate: true } }), true);
  assert.equal(passIsOut({ ticket: { hiddenByStaff: false }, attendee: { hiddenByStaff: false } }), false);
  const rows = [{ id: "cs_full", total: 113, refunded: 113 }, { id: "cs_part", total: 113, refunded: 50 }, { id: "cs_free", total: 0, refunded: 0 }];
  assert.equal(sessionRefunded("cs_full", rows), true);
  assert.equal(sessionRefunded("cs_part", rows), false);
  assert.equal(sessionRefunded("cs_free", rows), false);
  assert.equal(sessionRefunded("cs_full", null), false, "Stripe not read on this instance: counts");
  assert.equal(passIsOut({ ticket: { stripeSessionId: "cs_full" }, stripeRows: rows }), true);
  assert.equal(passIsOut({ attendee: { stripeSessionId: "cs_full" }, stripeRows: rows }), true);
  assert.equal(passIsOut({ ticket: { stripeSessionId: "cs_part" }, stripeRows: rows }), false);
});

test("the answers and the push", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(PASS_CONNECT_ERRORS).map(([k, v]) => [k, [v.status, v.code]])), {
    not_found: [404, "not_found"], not_on_app: [409, "not_on_app"], self: [400, "self"],
  });
  assert.equal(PASS_CONNECT_ERRORS.not_found.error, "That isn't a TTFC pass we know.");
  assert.equal(PASS_CONNECT_ERRORS.not_on_app.error, "They haven't joined the TTFC app yet. You can connect once they sign in.");
  assert.equal(PASS_CONNECT_ERRORS.self.error, "That's your own pass.");
  assert.deepEqual(passConnectPush("Sid Scanner"), { title: "Sid Scanner connected with you", body: "Scanned your TTFC pass" });
  assert.equal(passConnectPush("  ").title, "Someone connected with you");
  assert.deepEqual(passConnectNotification({ toUserId: "u2", scanner: { _id: "u1", name: "Sid Scanner" }, connectionId: "c9" }), {
    userId: "u2", title: "Sid Scanner connected with you", body: "Scanned your TTFC pass", link: "ttfc://tab/network",
    kind: "conn", batchId: "conn:c9", sentBy: "u1", sentByName: "Sid Scanner",
  });
});
