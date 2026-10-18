import test from "node:test";
import assert from "node:assert/strict";
import {
  ROLES, isStaff, isVolunteer, isTeam, cleanRole, cardKind, passKind, boothOf, exhibitorIndex, kindFields,
  strongerKind, EXHIBITOR_PROMO,
} from "../services/teamRoles.js";
import { EXHIBITOR_PROMO as EXHIBITOR_PASS_PROMO } from "../services/exhibitorPasses.js";
import { userCard, CARD_SELECT } from "../services/socialHelpers.js";
import { buildDirectory } from "../services/ticketAccess.js";
import { removeMode } from "../services/socialActivity.js";
import { canMessage, canRequest } from "../services/contactSwitches.js";

const staff = { _id: "s1", name: "Sam", role: "admin" };
const vol = { _id: "v1", name: "Val", role: "volunteer" };
const att = { _id: "a1", name: "Ann", role: "user" };

/* ---------- roles ---------- */

test("isTeam: staff and volunteers; isStaff: staff only", () => {
  assert.deepEqual([isTeam(staff), isTeam(vol), isTeam(att), isTeam(null), isTeam({})], [true, true, false, false, false]);
  assert.deepEqual([isStaff(staff), isStaff(vol), isStaff(att)], [true, false, false]);
  assert.deepEqual([isVolunteer(staff), isVolunteer(vol), isVolunteer(att)], [false, true, false]);
  assert.equal(isTeam({ role: "Admin" }), true);   // same case-insensitive rule the sign-in routes used
  assert.equal(isTeam({ role: "VOLUNTEER" }), true);
});

test("cleanRole accepts user/admin/volunteer only", () => {
  assert.deepEqual(ROLES, ["user", "admin", "volunteer"]);
  assert.equal(cleanRole("volunteer"), "volunteer");
  assert.equal(cleanRole(" Admin "), "admin");
  assert.equal(cleanRole("user"), "user");
  for (const bad of ["staff", "management", "", null, undefined, 1, "root"]) assert.equal(cleanRole(bad), null, String(bad));
});

test("volunteers get no staff powers: post removal and contact-switch override stay staff-only", () => {
  const post = { authorId: "someone-else" };
  assert.equal(removeMode(post, staff), "staff");
  assert.equal(removeMode(post, vol), null);
  const vip = { messagesOff: true, requestsOff: true };
  assert.equal(canMessage({ sender: vol, recipient: vip }), false);
  assert.equal(canRequest({ sender: vol, target: vip }), false);
  assert.equal(canMessage({ sender: staff, recipient: vip }), true);
});

/* ---------- kinds ---------- */

test("cardKind priority: staff > volunteer > speaker > exhibitor > attendee", () => {
  const speakerTix = [{ ticketId: "t1", type: "speaker" }];
  assert.equal(cardKind({ ...staff, tickets: speakerTix }), "staff");
  assert.equal(cardKind({ ...vol, tickets: speakerTix }, { exhibitor: true }), "volunteer");
  assert.equal(cardKind({ ...att, tickets: speakerTix }, { exhibitor: true }), "speaker");
  assert.equal(cardKind(att, { exhibitor: true }), "exhibitor");
  assert.equal(cardKind({ ...att, tickets: [{ ticketId: "t2", type: "connect", promoCode: "EXHIBITOR" }] }), "exhibitor");
  assert.equal(cardKind({ ...att, tickets: [{ ticketId: "t3", type: "power" }] }), "");
  assert.equal(cardKind(null), "");
  assert.equal(strongerKind("speaker", "exhibitor"), "speaker");
  assert.equal(strongerKind("", "exhibitor"), "exhibitor");
});

test("passKind / boothOf read Attendee rows", () => {
  assert.equal(EXHIBITOR_PROMO, EXHIBITOR_PASS_PROMO);   // kept in step with services/exhibitorPasses.js
  assert.equal(passKind({ ticketType: "speaker", promoCode: "SPEAKER" }), "speaker");
  assert.equal(passKind({ ticketType: "connect", promoCode: "EXHIBITOR" }), "exhibitor");
  assert.equal(passKind({ ticketType: "connect", promoCode: "ISSUED" }), "");
  assert.equal(boothOf({ issuedPass: { booth: { booth: " 12 " } } }), "12");
  assert.equal(boothOf({}), "");
});

test("exhibitorIndex finds a claimed exhibitor by account, then by ticket ID", () => {
  const idx = exhibitorIndex([
    { claimedBy: "u1", ticketId: "x1", issuedPass: { booth: { booth: "A7" } } },
    { ticketId: "x2", issuedPass: { booth: { booth: "" } } },
  ]);
  assert.equal(idx.boothFor({ _id: "u1", tickets: [] }), "A7");
  assert.equal(idx.boothFor({ _id: "u2", tickets: [{ ticketId: "x2" }] }), "");
  assert.equal(idx.boothFor({ _id: "u3", tickets: [{ ticketId: "zz" }] }), null);
  assert.deepEqual(kindFields({ _id: "u1", role: "user" }, idx), { kind: "exhibitor", booth: "A7" });
  assert.deepEqual(kindFields({ _id: "u1", role: "admin" }, idx), { kind: "staff", booth: "" });
  assert.deepEqual(kindFields({ _id: "u3", role: "user" }, idx), { kind: "", booth: "" });
  assert.deepEqual(kindFields({ _id: "u3", role: "user" }), { kind: "", booth: "" });
});

test("userCard carries kind and booth, never role", () => {
  assert.ok(CARD_SELECT.split(" ").includes("role"));
  const idx = exhibitorIndex([{ claimedBy: "e1", ticketId: "x1", issuedPass: { booth: { booth: "B3" } } }]);
  const e = userCard({ _id: "e1", name: "Exa", role: "user", tickets: [{ ticketId: "x1", type: "connect" }] }, { exhibitors: idx });
  assert.deepEqual([e.kind, e.booth, e.tier], ["exhibitor", "B3", "Exhibitor"]);   // never their bought pass
  const v = userCard(vol);
  assert.deepEqual([v.kind, v.booth], ["volunteer", ""]);
  assert.equal("role" in v, false);
  assert.equal(userCard(staff).kind, "staff");
  assert.equal(userCard({ ...att, tickets: [{ type: "speaker" }] }).kind, "speaker");
  assert.equal(userCard(att).kind, "");
});

test("directory: kinds for accounts, unclaimed exhibitor and speaker passes", () => {
  const idx = exhibitorIndex([{ claimedBy: "e1", ticketId: "x1", issuedPass: { booth: { booth: "C9" } } }]);
  const users = [
    { _id: "s1", name: "Sam Staff", email: "s@x.com", role: "admin", appOnboarded: true, tickets: [] },
    { _id: "v1", name: "Val Vol", email: "v@x.com", role: "volunteer", appOnboarded: true, tickets: [] },
    { _id: "e1", name: "Exa Hibit", email: "e@x.com", role: "user", appOnboarded: true, tickets: [{ ticketId: "x1", type: "connect" }] },
    { _id: "a1", name: "Ann Att", email: "a@x.com", role: "user", appOnboarded: true, tickets: [{ ticketId: "t1", type: "power" }] },
    { _id: "m1", name: "Mo Merge", email: "m@x.com", role: "user", appOnboarded: true, tickets: [] },
  ];
  const guests = [
    { _id: "g1", name: "Gia Booth", email: "g@x.com", ticketId: "x2", ticketType: "connect", promoCode: "EXHIBITOR", issuedPass: { booth: { booth: "D1" } } },
    { _id: "g2", name: "Spe Aker", ticketId: "sp1", ticketType: "speaker", promoCode: "SPEAKER" },
    { _id: "g3", name: "Mo Merge", email: "m@x.com", ticketId: "x3", ticketType: "connect", promoCode: "EXHIBITOR", issuedPass: { booth: { booth: "E4" } } },
    { _id: "g4", name: "Gus Guest", email: "gg@x.com", ticketId: "y1", ticketType: "discover" },
  ];
  const dir = buildDirectory(users, guests, { exhibitors: idx });
  const by = Object.fromEntries(dir.map((p) => [p.name, [p.kind, p.booth]]));
  assert.deepEqual(by["Sam Staff"], ["staff", ""]);
  assert.deepEqual(by["Val Vol"], ["volunteer", ""]);
  assert.deepEqual(by["Exa Hibit"], ["exhibitor", "C9"]);
  assert.deepEqual(by["Ann Att"], ["", ""]);
  assert.deepEqual(by["Gia Booth"], ["exhibitor", "D1"]);
  assert.deepEqual(by["Spe Aker"], ["speaker", ""]);
  assert.deepEqual(by["Mo Merge"], ["exhibitor", "E4"]);   // app account + unclaimed exhibitor pass, same email
  assert.deepEqual(by["Gus Guest"], ["", ""]);
  for (const p of dir) assert.equal("role" in p, false);
  // No index given: still works (kinds from role and tickets only).
  assert.equal(buildDirectory([users[2]], []).find((p) => p.id === "e1").kind, "");
});
