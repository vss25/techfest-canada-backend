import test from "node:test";
import assert from "node:assert/strict";
import { publicTier, exhibitorIndex, SPEAKER_TIER, EXHIBITOR_TIER } from "../services/teamRoles.js";
import { userCard, publicProfile, postDTO } from "../services/socialHelpers.js";
import { buildDirectory } from "../services/ticketAccess.js";

/* Other attendees only see a Speaker Pass, or "Exhibitor" for exhibitors.
   Everyone else's pass (Discover … Apex) is private; the person still sees their own. */

test("publicTier: Speaker Pass and Exhibitor show, every other pass is private", () => {
  assert.equal(SPEAKER_TIER, "Speaker Pass");
  assert.equal(EXHIBITOR_TIER, "Exhibitor");
  assert.equal(publicTier("Speaker Pass"), "Speaker Pass");
  assert.equal(publicTier("", "speaker"), "Speaker Pass");
  assert.equal(publicTier("Connect Pass", "exhibitor"), "Exhibitor");
  assert.equal(publicTier("Exhibitor"), "Exhibitor");             // already-public value stored on a post
  assert.equal(publicTier("Speaker Pass", "exhibitor"), "Speaker Pass");
  for (const t of ["Discover Pass", "Connect Pass", "Influence Pass", "Power Pass", "Apex Pass", "Session Pass", "", undefined]) {
    assert.equal(publicTier(t), "", String(t));
  }
  assert.equal(publicTier("Apex Pass", "staff"), "");
  assert.equal(publicTier("Power Pass", "volunteer"), "");
});

test("userCard: tier hidden from others except speakers / exhibitors; own card keeps it", () => {
  const apex = { _id: "u1", name: "Ava", role: "user", tickets: [{ ticketId: "t1", type: "apex" }] };
  assert.equal(userCard(apex).tier, "");
  assert.equal(userCard(apex, { self: true }).tier, "Apex Pass");
  assert.equal(userCard({ ...apex, tickets: [{ type: "connect" }, { type: "speaker" }] }).tier, "Speaker Pass");
  // Exhibitor by a claimed exhibitor pass (index) or the promo on their own ticket.
  const idx = exhibitorIndex([{ claimedBy: "u1", ticketId: "x1", issuedPass: { booth: { booth: "B7" } } }]);
  assert.equal(userCard(apex, { exhibitors: idx }).tier, "Exhibitor");
  assert.equal(userCard(apex, { exhibitors: idx, self: true }).tier, "Apex Pass");
  assert.equal(userCard({ ...apex, tickets: [{ type: "influence", promoCode: "EXHIBITOR" }] }).tier, "Exhibitor");
  // Staff with a bought pass: still private.
  assert.equal(userCard({ ...apex, role: "admin" }).tier, "");
  assert.equal(userCard({ _id: "u9", name: "No pass" }).tier, "");
});

test("publicProfile follows the same rule (self keeps the pass)", () => {
  const u = { _id: "u2", name: "Pia", tickets: [{ type: "power" }], fieldOfWork: "AI" };
  assert.equal(publicProfile(u).tier, "");
  assert.equal(publicProfile(u, { self: true }).tier, "Power Pass");
  assert.equal(publicProfile({ ...u, tickets: [{ type: "speaker" }] }).tier, "Speaker Pass");
});

test("buildDirectory: app users and guests show only Speaker Pass / Exhibitor", () => {
  const users = [
    { _id: "a1", name: "Ann App", email: "a@x.com", lastActiveAt: "2026-10-01", tickets: [{ ticketId: "t1", type: "apex", purchaseDate: "2026-08-01" }] },
    { _id: "a2", name: "Sam Speaker", email: "s@x.com", lastActiveAt: "2026-10-01", tickets: [{ ticketId: "t2", type: "speaker", purchaseDate: "2026-08-01" }] },
    // Latest purchase wins the pass: a speaker pass bought after a Connect pass.
    { _id: "a3", name: "Cal Later", email: "c@x.com", tickets: [{ ticketId: "t3", type: "connect", purchaseDate: "2026-08-01" },
      { ticketId: "t4", type: "speaker", purchaseDate: "2026-09-01" }] },
  ];
  const guests = [
    { _id: "g1", name: "Gina Guest", email: "g@x.com", ticketId: "y1", ticketType: "power", purchaseDate: "2026-09-01" },
    { _id: "g2", name: "Eli Exhibit", email: "e@x.com", ticketId: "y2", ticketType: "connect", promoCode: "EXHIBITOR", purchaseDate: "2026-09-01" },
    { _id: "g3", name: "Spe Guest", email: "sg@x.com", ticketId: "y3", ticketType: "speaker", purchaseDate: "2026-09-01" },
  ];
  const dir = buildDirectory(users, guests, {});
  const tier = (name) => dir.find((p) => p.name === name).tier;
  assert.equal(tier("Ann App"), "");
  assert.equal(tier("Sam Speaker"), "Speaker Pass");
  assert.equal(tier("Cal Later"), "Speaker Pass");
  assert.equal(tier("Gina Guest"), "");
  assert.equal(tier("Eli Exhibit"), "Exhibitor");
  assert.equal(tier("Spe Guest"), "Speaker Pass");
  for (const p of dir) assert.equal("ticketType" in p, false);
});

test("postDTO authorTier: older posts' stored pass names are filtered too", () => {
  const post = { _id: "p1", authorId: "u1", authorName: "Ava", body: "hi", likes: [] };
  assert.equal(postDTO({ ...post, authorTier: "Apex Pass" }, "u2").authorTier, "");
  assert.equal(postDTO({ ...post, authorTier: "Speaker Pass" }, "u2").authorTier, "Speaker Pass");
  assert.equal(postDTO({ ...post, authorTier: "Exhibitor" }, "u2").authorTier, "Exhibitor");
  assert.equal(postDTO({ ...post }, "u2").authorTier, "");
});
