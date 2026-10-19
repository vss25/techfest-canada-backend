import test from "node:test";
import assert from "node:assert/strict";
import {
  PERSON_TYPES, PUBLIC_TYPES, cleanTypes, storedTypes, autoTypes, effectiveTypes, primaryKind, publicTypes,
  cardKind, canUseStaffSignIn, typesTier, typeInfo, exhibitorIndex, strongerKind, isVip, badgeTypes, LEGACY_TYPES, STORED_TYPE_VALUES, TYPE_LABELS,
} from "../services/teamRoles.js";
import {
  RIGHTS, RIGHT_LABELS, INBOUND_RIGHTS, ADMIN_POWERS, DEFAULT_MATRIX, mergeMatrix, cleanMatrix, matrixChanges,
  effectiveRights, personAccess, rightsFor, overridesContact, rightError, RIGHT_ERRORS, holdersQuery,
  sharedEmail, consoleTypes, typesEdit, typeCandidates, vipEdit,
} from "../services/appRights.js";
import { canMessage, canRequest, contactFlags, messagesOffError, requestsOffError } from "../services/contactSwitches.js";
import { removeMode, canViewPost } from "../services/socialActivity.js";
import { userCard, postDTO, CARD_SELECT } from "../services/socialHelpers.js";
import { buildDirectory } from "../services/ticketAccess.js";
import { RIGHTS_SELECT } from "../services/rightsStore.js";

const on = (rights) => RIGHTS.filter((r) => rights[r]);
const speakerPass = [{ ticketId: "sp1", type: "speaker" }];
const anyPass = [{ ticketId: "t1", type: "power" }];

const attendee = { _id: "a1", name: "Ann Lee", role: "user", tickets: anyPass };
// VIP is a yes / no flag now (User.vip), not a type: a VIP with a pass is a delegate (attendee) with the VIP badge.
const vip = { _id: "v1", name: "Hon. Mélanie Joly", role: "user", tickets: anyPass, vip: true };
// A VIP who won't reply: the per-person contact switches do that now.
const minister = { ...vip, _id: "v2", messagesOff: true, requestsOff: true };
const vendor = { _id: "d1", name: "Dee Vendor", role: "user", tickets: anyPass, types: ["vendor"] };
const staff = { _id: "s1", name: "Sam Staff", role: "admin" };
const volunteer = { _id: "o1", name: "Val Vol", role: "volunteer" };

/* ---------- the matrix ---------- */

test("rights and labels: twelve rights, plain labels, inbound + admin powers named", () => {
  assert.equal(RIGHTS.length, 12);
  assert.deepEqual(Object.keys(RIGHT_LABELS), RIGHTS);
  assert.equal(RIGHT_LABELS.shareContact, "Share contact details");
  assert.equal(RIGHT_LABELS.checkIn, "Check people in");
  assert.deepEqual(INBOUND_RIGHTS, ["receiveMessages", "receiveRequests"]);
  assert.deepEqual(ADMIN_POWERS, ["deleteAnyPost", "moderate", "checkIn"]);
  assert.deepEqual(Object.keys(DEFAULT_MATRIX), PERSON_TYPES);
  for (const t of PERSON_TYPES) assert.deepEqual(Object.keys(DEFAULT_MATRIX[t]), RIGHTS, t);
});

test("default matrix matches the agreed columns", () => {
  const everyday = ["sendMessages", "receiveMessages", "sendRequests", "receiveRequests", "post", "comment", "startDiscussions", "createGroups", "shareContact"];
  for (const t of ["attendee", "speaker", "exhibitor"]) assert.deepEqual(on(DEFAULT_MATRIX[t]), everyday, t);
  assert.equal("vip" in DEFAULT_MATRIX, false);   // VIP is a switch, not a column (Oct 19 2026)
  assert.deepEqual(Object.keys(DEFAULT_MATRIX), ["attendee", "speaker", "exhibitor", "staff", "vendor", "volunteer"]);
  assert.deepEqual(on(DEFAULT_MATRIX.staff), RIGHTS);
  assert.deepEqual(on(DEFAULT_MATRIX.vendor), ["sendMessages", "receiveMessages", "comment", "shareContact"]);
  assert.deepEqual(on(DEFAULT_MATRIX.volunteer), [...everyday, "checkIn"]);
  assert.ok(Object.isFrozen(DEFAULT_MATRIX));
});

test("mergeMatrix: stored booleans over defaults, junk ignored", () => {
  const m = mergeMatrix({ vendor: { receiveRequests: true, post: "yes" }, nobody: { post: true }, staff: null, vip: { post: true } });
  assert.equal(m.vendor.receiveRequests, true);
  assert.equal(m.vendor.post, false);   // "yes" ignored → default false
  assert.equal("nobody" in m, false);
  assert.equal("vip" in m, false);      // an old stored VIP column is dropped
  assert.deepEqual(m.staff, DEFAULT_MATRIX.staff);
  assert.deepEqual(mergeMatrix(null), mergeMatrix(DEFAULT_MATRIX));
  assert.notEqual(mergeMatrix(DEFAULT_MATRIX).vendor, DEFAULT_MATRIX.vendor);   // a copy, safe to edit
});

test("cleanMatrix validates types, rights and values; left-out cells keep defaults", () => {
  assert.match(cleanMatrix(null).error, /object/);
  assert.match(cleanMatrix([]).error, /object/);
  assert.equal(cleanMatrix({ guest: {} }).error, "Unknown type: guest");
  assert.equal(cleanMatrix({ vip: {} }).error, "Unknown type: vip");
  assert.equal(cleanMatrix({ vendor: { fly: true } }).error, "Unknown right: fly");
  assert.equal(cleanMatrix({ vendor: { post: "true" } }).error, "vendor.post must be true or false");
  assert.match(cleanMatrix({ vendor: [] }).error, /object of rights/);
  const { matrix } = cleanMatrix({ vendor: { post: true } });
  assert.equal(matrix.vendor.post, true);
  assert.equal(matrix.vendor.sendRequests, false);
  assert.deepEqual(matrix.attendee, DEFAULT_MATRIX.attendee);
});

test("matrixChanges lists each changed cell for the audit log", () => {
  const after = mergeMatrix({ attendee: { createGroups: false }, vendor: { post: true, comment: false } });
  assert.deepEqual(matrixChanges(DEFAULT_MATRIX, after), [
    "attendee.createGroups: on → off", "vendor.post: off → on", "vendor.comment: on → off",
  ]);
  assert.deepEqual(matrixChanges(DEFAULT_MATRIX, DEFAULT_MATRIX), []);
});

/* ---------- types ---------- */

test("cleanTypes: the six types in a fixed order, null for anything unknown (VIP is a switch now)", () => {
  assert.deepEqual(PERSON_TYPES, ["attendee", "speaker", "exhibitor", "staff", "vendor", "volunteer"]);
  assert.deepEqual(TYPE_LABELS, { attendee: "Delegate", speaker: "Speaker", exhibitor: "Exhibitor", staff: "Organizer", vendor: "Vendor", volunteer: "Volunteer" });
  assert.deepEqual(cleanTypes(["Volunteer", " vendor ", "vendor"]), ["vendor", "volunteer"]);
  assert.deepEqual(cleanTypes([]), []);
  assert.equal(cleanTypes(["vip"]), null);
  assert.equal(cleanTypes(["vendor", "minister"]), null);
  assert.equal(cleanTypes("vendor"), null);
  assert.equal(cleanTypes([1]), null);
  assert.deepEqual(storedTypes(["vip", "old-thing", "Staff"]), ["staff"]);   // an old stored "vip" is read as nothing
  assert.deepEqual(storedTypes(undefined), []);
  // The model still accepts the old value so documents saved before the move validate.
  assert.deepEqual(LEGACY_TYPES, ["vip"]);
  assert.deepEqual(STORED_TYPE_VALUES, [...PERSON_TYPES, "vip"]);
});

test("VIP flag: the account's switch, else a VIP pass of theirs, else an old stored VIP type", () => {
  assert.equal(isVip(vip), true);
  assert.equal(isVip({ ...vip, vip: false }, { vipPass: true }), false);   // staff's account switch wins over a pass
  assert.equal(isVip({ role: "user" }, { vipPass: true }), true);
  assert.equal(isVip({ role: "user" }), false);
  assert.equal(isVip({ role: "user", types: ["vip"] }), true);             // not migrated yet
  assert.equal(isVip({ role: "user", types: ["vip"], typesOff: ["vip"] }), false);
  assert.equal(isVip(null), false);
  assert.deepEqual(badgeTypes(["speaker"], true), ["speaker", "vip"]);
  const idx = exhibitorIndex([], { vipRows: [{ claimedBy: "c1", ticketId: "v9" }, { ticketId: "v8" }] });
  assert.equal(idx.hasVipPass({ _id: "c1" }), true);
  assert.equal(idx.hasVipPass({ _id: "c2", tickets: [{ ticketId: "v8" }] }), true);
  assert.equal(idx.hasVipPass({ _id: "c3", tickets: [{ ticketId: "zz" }] }), false);
  assert.deepEqual(typeInfo({ _id: "c1", role: "user", tickets: anyPass }, idx), { types: ["attendee"], vip: true, kind: "vip", booth: "" });
  assert.equal(typeInfo({ _id: "c1", role: "user", tickets: anyPass, vip: false }, idx).kind, "");
});

test("automatic types: role, speaker pass, exhibitor pass", () => {
  assert.deepEqual(autoTypes(staff), [{ type: "staff", from: "role" }]);
  assert.deepEqual(autoTypes(volunteer), [{ type: "volunteer", from: "role" }]);
  assert.deepEqual(autoTypes({ role: "user", tickets: speakerPass }), [{ type: "speaker", from: "pass" }]);
  assert.deepEqual(autoTypes({ role: "user", tickets: [{ type: "connect", promoCode: "EXHIBITOR" }] }), [{ type: "exhibitor", from: "pass" }]);
  assert.deepEqual(autoTypes({ role: "user" }, { exhibitor: true }), [{ type: "exhibitor", from: "pass" }]);
  assert.deepEqual(autoTypes(attendee), []);
  assert.deepEqual(autoTypes(null), []);
});

test("effective types: stored ∪ automatic − typesOff; attendee for pass holders with no other type", () => {
  assert.deepEqual(effectiveTypes(attendee), ["attendee"]);
  assert.deepEqual(effectiveTypes({ role: "user" }), []);                         // no pass, no types
  assert.deepEqual(effectiveTypes({ role: "user", tickets: speakerPass }), ["speaker"]);
  assert.deepEqual(effectiveTypes(vip), ["attendee"]);                            // VIP is not a type: a VIP with a pass is a delegate
  assert.deepEqual(effectiveTypes({ ...vip, tickets: speakerPass }), ["speaker"]);
  assert.deepEqual(effectiveTypes({ role: "user", types: ["vip"], tickets: anyPass }), ["attendee"]);   // an old stored "vip" type is ignored
  // Switching off the only automatic type leaves a pass holder as an attendee.
  assert.deepEqual(effectiveTypes({ role: "user", tickets: speakerPass, typesOff: ["speaker"] }), ["attendee"]);
  assert.deepEqual(effectiveTypes({ ...attendee, typesOff: ["attendee"] }), []);
  assert.deepEqual(effectiveTypes({ ...staff, tickets: speakerPass }), ["speaker", "staff"]);
  assert.deepEqual(effectiveTypes({ ...staff, typesOff: ["staff"] }), []);
  assert.deepEqual(effectiveTypes({ role: "user", types: ["staff", "nonsense"] }), ["staff"]);
  assert.deepEqual(effectiveTypes({ role: "user" }, { exhibitor: true }), ["exhibitor"]);
  assert.deepEqual(effectiveTypes(null), []);
});

test("kind: staff > volunteer > vip > speaker > exhibitor > vendor; public types never include attendee", () => {
  assert.deepEqual(PUBLIC_TYPES, ["staff", "volunteer", "vip", "speaker", "exhibitor", "vendor"]);
  assert.equal(primaryKind(["speaker", "vip"]), "vip");
  assert.equal(primaryKind(["exhibitor", "vendor"]), "exhibitor");
  assert.equal(primaryKind(["vendor"]), "vendor");
  assert.equal(primaryKind(["staff", "volunteer"]), "staff");
  assert.equal(primaryKind(["attendee"]), "");
  assert.equal(primaryKind([]), "");
  assert.deepEqual(publicTypes(["attendee", "speaker", "vip", "staff"]), ["staff", "vip", "speaker"]);
  assert.equal(cardKind({ ...vip, tickets: speakerPass }), "vip");   // the VIP flag still gives the apps kind "vip"
  assert.equal(cardKind({ ...vip, vip: false, tickets: speakerPass }), "speaker");
  assert.equal(cardKind(vendor), "vendor");
  assert.equal(strongerKind("vip", "speaker"), "vip");
  assert.equal(strongerKind("vendor", "exhibitor"), "exhibitor");
  assert.equal(strongerKind("", "vendor"), "vendor");
});

test("typesTier: Speaker / Exhibitor from types, so a switched-off speaker shows nothing", () => {
  assert.equal(typesTier(["speaker", "vip"]), "Speaker");
  assert.equal(typesTier(["exhibitor"]), "Exhibitor");
  assert.equal(typesTier(["vip"]), "");
  assert.equal(typesTier(), "");
});

test("staff sign-in: role admin / volunteer, or the staff / volunteer type", () => {
  assert.equal(canUseStaffSignIn(staff), true);
  assert.equal(canUseStaffSignIn(volunteer), true);
  assert.equal(canUseStaffSignIn({ role: "user", types: ["volunteer"] }), true);
  assert.equal(canUseStaffSignIn({ role: "user", types: ["staff"] }), true);
  assert.equal(canUseStaffSignIn({ role: "user", types: ["staff"], typesOff: ["staff"] }), false);
  assert.equal(canUseStaffSignIn(vip), false);
  assert.equal(canUseStaffSignIn(attendee), false);
  assert.equal(canUseStaffSignIn(null), false);
});

/* ---------- combining ---------- */

test("effectiveRights: no types → the attendee column", () => {
  assert.deepEqual(effectiveRights([], DEFAULT_MATRIX), DEFAULT_MATRIX.attendee);
  assert.deepEqual(effectiveRights(undefined), DEFAULT_MATRIX.attendee);
  assert.deepEqual(effectiveRights(["nonsense"]), DEFAULT_MATRIX.attendee);
});

test("effectiveRights: abilities are OR across types, being contacted is AND", () => {
  const r = effectiveRights(["speaker", "vendor"], DEFAULT_MATRIX);
  // Abilities: the speaker column allows them.
  assert.equal(r.createGroups, true);
  assert.equal(r.shareContact, true);
  // Being contacted: the vendor column is more protective for requests.
  assert.equal(r.receiveMessages, true);
  assert.equal(r.receiveRequests, false);
  const vend = effectiveRights(["vendor"], DEFAULT_MATRIX);
  assert.deepEqual([vend.sendRequests, vend.post, vend.receiveMessages, vend.receiveRequests], [false, false, true, false]);
  const both = effectiveRights(["vendor", "exhibitor"], DEFAULT_MATRIX);
  assert.deepEqual([both.sendRequests, both.post, both.receiveMessages, both.receiveRequests], [true, true, true, false]);
  const vol = effectiveRights(["volunteer"], DEFAULT_MATRIX);
  assert.deepEqual([vol.checkIn, vol.moderate, vol.deleteAnyPost, vol.post], [true, false, false, true]);
  assert.deepEqual(on(effectiveRights(["staff"], DEFAULT_MATRIX)), RIGHTS);
  // An old "vip" type (or one sent by an old client) is no column at all: the attendee column.
  assert.deepEqual(effectiveRights(["vip"], DEFAULT_MATRIX), DEFAULT_MATRIX.attendee);
});

test("VIP rights: before Oct 19 the VIP column (no receiving, no groups, no contact sharing); now their other types' rights", () => {
  // Before: a VIP-only pass holder got sendMessages, sendRequests, post, comment, startDiscussions and nothing else.
  // Now the VIP flag changes no rights: a VIP with a pass gets the attendee (Delegate) column.
  assert.deepEqual(rightsFor(vip), DEFAULT_MATRIX.attendee);
  assert.deepEqual(rightsFor({ ...vip, tickets: speakerPass }), DEFAULT_MATRIX.speaker);
  // Staff keep a VIP from being contacted with the per-person switches.
  const m = rightsFor(minister);
  assert.deepEqual([m.receiveMessages, m.receiveRequests, m.sendMessages, m.shareContact], [false, false, true, true]);
});

test("effectiveRights: per-person switches turn receiving off", () => {
  const r = effectiveRights(["attendee"], DEFAULT_MATRIX, { messagesOff: true });
  assert.deepEqual([r.receiveMessages, r.receiveRequests, r.sendMessages], [false, true, true]);
  const q = effectiveRights([], DEFAULT_MATRIX, { requestsOff: true });
  assert.deepEqual([q.receiveMessages, q.receiveRequests], [true, false]);
  // A switch can't turn receiving back on for a protective type.
  assert.equal(effectiveRights(["vendor"], DEFAULT_MATRIX, { requestsOff: false }).receiveRequests, false);
});

test("effectiveRights: staff accounts keep delete, moderate and check-in whatever the matrix says", () => {
  const m = mergeMatrix({ staff: { deleteAnyPost: false, moderate: false, checkIn: false, post: false } });
  const r = effectiveRights(["staff"], m, staff);
  assert.deepEqual([r.deleteAnyPost, r.moderate, r.checkIn, r.post], [true, true, true, false]);
  // The same column without role admin (the staff type given by hand) follows the matrix.
  const typed = effectiveRights(["staff"], m, { role: "user", types: ["staff"] });
  assert.deepEqual([typed.deleteAnyPost, typed.moderate, typed.checkIn], [false, false, false]);
});

test("effectiveRights: matrix edits apply; global switches apply on top", () => {
  const m = mergeMatrix({ attendee: { createGroups: false }, vendor: { receiveRequests: true } });
  assert.equal(effectiveRights(["attendee"], m).createGroups, false);
  assert.equal(effectiveRights(["vendor"], m).receiveRequests, true);
  const off = effectiveRights(["staff"], DEFAULT_MATRIX, staff, { allowPosts: false, allowGroups: false });
  assert.deepEqual([off.post, off.createGroups, off.comment], [false, false, true]);
  const onFlags = effectiveRights(["attendee"], DEFAULT_MATRIX, null, { allowPosts: true, allowGroups: true });
  assert.deepEqual([onFlags.post, onFlags.createGroups], [true, true]);
});

test("personAccess / rightsFor: types, kind, booth and rights from one context", () => {
  const idx = exhibitorIndex([{ claimedBy: "e1", ticketId: "x1", issuedPass: { booth: { booth: "B4" } } }]);
  const ex = { _id: "e1", name: "Exa", role: "user", tickets: [{ ticketId: "x1", type: "connect" }], types: ["vendor"] };
  const a = personAccess(ex, { exhibitors: idx, matrix: DEFAULT_MATRIX });
  assert.deepEqual(a.types, ["exhibitor", "vendor"]);
  assert.deepEqual(a.publicTypes, ["exhibitor", "vendor"]);
  assert.deepEqual([a.kind, a.booth], ["exhibitor", "B4"]);
  assert.equal(a.rights.sendRequests, true);    // exhibitor column
  assert.equal(a.rights.receiveRequests, false); // vendor column (most protective)
  assert.deepEqual(rightsFor(attendee), DEFAULT_MATRIX.attendee);
  assert.deepEqual(typeInfo(ex, idx).types, ["exhibitor", "vendor"]);
});

/* ---------- enforcement helpers ---------- */

test("messages: a VIP with messages switched off refuses cold messages; replies, connections and moderators still get through", () => {
  const vipRights = rightsFor(minister);
  const sender = rightsFor(attendee);
  assert.equal(canMessage({ sender: attendee, recipient: minister, senderRights: sender, recipientRights: vipRights }), false);
  assert.equal(canMessage({ sender: attendee, recipient: minister, senderRights: sender, recipientRights: vipRights, connected: true }), true);
  assert.equal(canMessage({ sender: attendee, recipient: minister, senderRights: sender, recipientRights: vipRights, theyWroteFirst: true }), true);
  assert.equal(canMessage({ sender: staff, recipient: minister, senderRights: rightsFor(staff), recipientRights: vipRights }), true);
  // A moderator by type (not role admin) can reach them too.
  const mod = { role: "user", types: ["staff"] };
  assert.equal(canMessage({ sender: mod, recipient: minister, senderRights: rightsFor(mod), recipientRights: vipRights }), true);
  // A volunteer has no moderate right, so no override.
  assert.equal(canMessage({ sender: volunteer, recipient: minister, senderRights: rightsFor(volunteer), recipientRights: vipRights }), false);
  // A VIP without the switch takes messages like any delegate; so does a vendor.
  assert.equal(canMessage({ sender: attendee, recipient: vip, senderRights: sender, recipientRights: rightsFor(vip) }), true);
  assert.equal(canMessage({ sender: attendee, recipient: vendor, senderRights: sender, recipientRights: rightsFor(vendor) }), true);
  assert.equal(messagesOffError(minister), "Mélanie isn't taking messages in the app.");
});

test("requests: a VIP with requests off and the vendor type refuse new requests; staff and moderators may still ask", () => {
  for (const target of [minister, vendor]) {
    const tr = rightsFor(target);
    assert.equal(canRequest({ sender: attendee, target, senderRights: rightsFor(attendee), targetRights: tr }), false, target.name);
    assert.equal(canRequest({ sender: staff, target, senderRights: rightsFor(staff), targetRights: tr }), true, target.name);
  }
  assert.equal(canRequest({ sender: vip, target: attendee, senderRights: rightsFor(vip), targetRights: rightsFor(attendee) }), true);
  assert.equal(requestsOffError(vendor), "Dee isn't taking connection requests in the app.");
  // Senders' own abilities come from their types (checked by the routes before canRequest).
  assert.deepEqual([rightsFor(vendor).sendRequests, rightsFor(minister).sendRequests, rightsFor(vendor).sendMessages], [false, true, true]);
});

test("contactFlags with rights: the card flags this viewer would see", () => {
  const vr = rightsFor(minister);
  assert.deepEqual(contactFlags({ viewer: attendee, user: minister, viewerRights: rightsFor(attendee), userRights: vr }), { acceptsMessages: false, acceptsRequests: false });
  assert.deepEqual(contactFlags({ viewer: attendee, user: minister, viewerRights: rightsFor(attendee), userRights: vr, connected: true }), { acceptsMessages: true, acceptsRequests: false });
  assert.deepEqual(contactFlags({ viewer: staff, user: minister, viewerRights: rightsFor(staff), userRights: vr }), { acceptsMessages: true, acceptsRequests: true });
  assert.equal(overridesContact(staff), true);
  assert.equal(overridesContact(attendee, { moderate: true }), true);
  assert.equal(overridesContact(volunteer, rightsFor(volunteer)), false);
});

test("badge scan: contact details only from people who share them, never ticket placeholders", () => {
  assert.equal(sharedEmail({ email: "ann@x.com" }, rightsFor(attendee)), "ann@x.com");
  // A VIP shares like their other types now (the VIP column had shareContact off).
  assert.equal(sharedEmail({ email: "m@gov.ca" }, rightsFor(vip)), "m@gov.ca");
  assert.equal(sharedEmail({ email: "m@gov.ca" }, { shareContact: false }), "");
  assert.equal(sharedEmail({ email: "abc123@ticket.thetechfestival.com" }, rightsFor(attendee)), "");
  assert.equal(sharedEmail({ email: "" }, rightsFor(attendee)), "");
  assert.equal(sharedEmail(null, null), "");
});

test("post removal and moderation follow deleteAnyPost / moderate", () => {
  const post = { authorId: "someone" };
  assert.equal(removeMode(post, staff, rightsFor(staff)), "staff");
  assert.equal(removeMode(post, volunteer, rightsFor(volunteer)), null);
  const typedStaff = { _id: "t1", role: "user", types: ["staff"] };
  assert.equal(removeMode(post, typedStaff, rightsFor(typedStaff)), "staff");
  assert.equal(removeMode({ authorId: "a1" }, attendee, rightsFor(attendee)), "author");
  assert.equal(removeMode(post, attendee, { deleteAnyPost: true }), "staff");
  assert.equal(removeMode(post, staff, { deleteAnyPost: false }), null);   // rights given → they decide
  const held = { authorId: "someone", status: "held" };
  assert.equal(canViewPost(held, typedStaff, new Set(), rightsFor(typedStaff)), true);
  assert.equal(canViewPost(held, volunteer, new Set(), rightsFor(volunteer)), false);
  assert.equal(canViewPost(held, staff), true);   // no rights given: role admin, as before
});

test("refusal lines are readable; switched-off features say so", () => {
  assert.equal(rightError("sendMessages"), "Your account can't send messages in the app.");
  assert.equal(RIGHT_ERRORS.sendMessages, "Your account can't send messages in the app.");
  assert.equal(rightError("post"), "Your account can't post in the feed.");
  assert.equal(rightError("post", { allowPosts: false }), "Posting in the feed is switched off right now.");
  assert.equal(rightError("createGroups", { allowGroups: false }), "New groups are switched off right now.");
  assert.equal(rightError("createGroups", { allowGroups: true }), "Your account can't create groups in the app.");
  assert.equal(rightError("startDiscussions"), "Your account can't start discussions in the app.");
  assert.equal(rightError("comment"), "Your account can't comment in the app.");
  assert.equal(rightError("checkIn"), "Your account can't check people in.");
  assert.equal(rightError("moderate"), "Your account can't moderate content.");
  assert.equal(rightError("nope"), "Your account can't do that in the app.");
  for (const line of Object.values(RIGHT_ERRORS)) assert.equal(/[—–]/.test(line), false, line);
});

test("holdersQuery narrows report alerts to possible moderators", () => {
  assert.deepEqual(holdersQuery("moderate", DEFAULT_MATRIX), { banned: { $ne: true }, $or: [{ types: { $in: ["staff"] } }, { role: "admin" }] });
  const volMod = holdersQuery("moderate", mergeMatrix({ volunteer: { moderate: true } }));
  assert.deepEqual(volMod.$or, [{ types: { $in: ["staff", "volunteer"] } }, { role: "admin" }, { role: "volunteer" }]);
  // If a pass-based column could moderate, anyone might: the route checks each one.
  assert.deepEqual(holdersQuery("moderate", mergeMatrix({ speaker: { moderate: true } })), { banned: { $ne: true } });
});

/* ---------- cards ---------- */

test("cards: public types and kind, receive rights as accepts*, never rights or attendee", () => {
  const c = userCard({ ...minister, tickets: speakerPass });
  assert.deepEqual(c.types, ["vip", "speaker"]);   // the VIP badge from the flag, unchanged for the apps
  assert.equal(c.kind, "vip");
  assert.equal(c.tier, "Speaker");
  assert.deepEqual([c.acceptsMessages, c.acceptsRequests], [false, false]);   // the contact switches
  assert.equal("rights" in c, false);
  assert.equal("typesOff" in c, false);
  const a = userCard(attendee);
  assert.deepEqual([a.types, a.kind, a.acceptsMessages, a.acceptsRequests], [[], "", true, true]);
  const v = userCard(vendor);
  assert.deepEqual([v.kind, v.acceptsMessages, v.acceptsRequests], ["vendor", true, false]);
  // Speaker switched off: shown as VIP only, no Speaker.
  const off = userCard({ ...vip, tickets: speakerPass, typesOff: ["speaker"] });
  assert.deepEqual([off.types, off.kind, off.tier, off.acceptsMessages], [["vip"], "vip", "", true]);
  // Matrix edits reach the cards.
  const open = userCard(vendor, { matrix: mergeMatrix({ vendor: { receiveRequests: true } }) });
  assert.equal(open.acceptsRequests, true);
  for (const f of ["types", "typesOff", "vip"]) assert.ok(CARD_SELECT.split(" ").includes(f), f);
  for (const f of ["role", "tickets", "types", "typesOff", "vip", "messagesOff", "requestsOff"]) assert.ok(RIGHTS_SELECT.split(" ").includes(f), f);
});

test("directory: types on entries, receive rights, typesOff kept when an unclaimed pass merges", () => {
  const users = [
    { _id: "v1", name: "Vee Ip", email: "v@x.com", appOnboarded: true, tickets: anyPass, vip: true, requestsOff: true },
    { _id: "s1", name: "Shown Asvip", email: "s@x.com", appOnboarded: true, tickets: [], vip: true, typesOff: ["speaker"] },
    { _id: "n1", name: "Not Avip", email: "n@x.com", appOnboarded: true, tickets: [], vip: false },
  ];
  const guests = [
    { _id: "g1", name: "Shown Asvip", email: "s@x.com", ticketId: "sp9", ticketType: "speaker", promoCode: "SPEAKER" },
    { _id: "g2", name: "Spe Guest", email: "sg@x.com", ticketId: "sp8", ticketType: "speaker" },
    // Unclaimed passes staff marked VIP: the pass-only person, and an account whose own switch says No.
    { _id: "g3", name: "Pass Vip", email: "pv@x.com", ticketId: "pv1", ticketType: "power", vip: true },
    { _id: "g4", name: "Not Avip", email: "n@x.com", ticketId: "nv1", ticketType: "power", vip: true },
  ];
  const dir = buildDirectory(users, guests, {});
  const by = Object.fromEntries(dir.map((p) => [p.name, p]));
  assert.deepEqual([by["Vee Ip"].types, by["Vee Ip"].kind, by["Vee Ip"].acceptsMessages, by["Vee Ip"].acceptsRequests], [["vip"], "vip", true, false]);
  assert.deepEqual([by["Shown Asvip"].types, by["Shown Asvip"].kind, by["Shown Asvip"].tier], [["vip"], "vip", ""]);
  assert.deepEqual([by["Spe Guest"].types, by["Spe Guest"].kind, by["Spe Guest"].tier], [["speaker"], "speaker", "Speaker"]);
  assert.deepEqual([by["Pass Vip"].types, by["Pass Vip"].kind], [["vip"], "vip"]);
  assert.deepEqual([by["Not Avip"].types, by["Not Avip"].kind], [[], ""]);
  const opened = buildDirectory([{ ...users[0], requestsOff: false, types: ["vendor"] }], [], { matrix: mergeMatrix({ vendor: { receiveRequests: true } }) });
  assert.equal(opened[0].acceptsRequests, true);
});

test("postDTO canRemove follows the staff flag the routes pass (deleteAnyPost)", () => {
  const post = { _id: "p1", authorId: "u1", authorName: "Ava", body: "hi", likes: [] };
  assert.equal(postDTO(post, "u2", new Map(), { staff: rightsFor(staff).deleteAnyPost }).canRemove, true);
  assert.equal(postDTO(post, "u2", new Map(), { staff: rightsFor(volunteer).deleteAnyPost }).canRemove, false);
});

/* ---------- admin console ---------- */

test("consoleTypes: stored, automatic and effective types with rights", () => {
  const u = { _id: "u1", role: "user", tickets: speakerPass, types: ["vendor"], typesOff: ["speaker"], vip: true };
  const t = consoleTypes(u, { matrix: DEFAULT_MATRIX });
  assert.deepEqual(t.types, ["vendor"]);
  assert.deepEqual(t.typesOff, ["speaker"]);
  assert.deepEqual(t.autoTypes, [{ type: "speaker", from: "pass" }]);
  assert.equal(t.holdsPass, true);
  assert.deepEqual(t.effectiveTypes, ["vendor"]);
  assert.deepEqual(t.rights, DEFAULT_MATRIX.vendor);
  assert.deepEqual([t.vip, t.vipFrom], [true, "account"]);
  const fromPass = consoleTypes({ _id: "c1", role: "user", tickets: anyPass }, { exhibitors: exhibitorIndex([], { vipRows: [{ claimedBy: "c1" }] }) });
  assert.deepEqual([fromPass.vip, fromPass.vipFrom], [true, "pass"]);
  const idx = exhibitorIndex([{ claimedBy: "u2", ticketId: "x1" }]);
  const e = consoleTypes({ _id: "u2", role: "admin" }, { exhibitors: idx });
  assert.deepEqual(e.autoTypes, [{ type: "staff", from: "role" }, { type: "exhibitor", from: "pass" }]);
  assert.deepEqual(e.effectiveTypes, ["exhibitor", "staff"]);
});

test("typesEdit: validates, skips no-ops, keeps staff and volunteer types for management", () => {
  const u = { types: ["vendor"], typesOff: [] };
  assert.deepEqual(typesEdit(u, { types: ["vendor", "attendee"] }), { set: { types: ["attendee", "vendor"] }, note: "types: vendor → attendee, vendor" });
  assert.deepEqual(typesEdit(u, { types: ["vendor"] }), { set: {}, note: "" });
  assert.deepEqual(typesEdit(u, {}), { set: {}, note: "" });
  assert.equal(typesEdit(u, { types: ["minister"] }).status, 400);
  assert.match(typesEdit(u, { types: ["vendor", "vip"] }).error, /VIP is a yes \/ no switch now/);
  assert.match(typesEdit(u, { typesOff: "speaker" }).error, /typesOff must be a list/);
  const staffy = typesEdit(u, { types: ["vendor", "staff"] });
  assert.deepEqual([staffy.status, staffy.error], [403, "Only management can give or take away the staff and volunteer types"]);
  assert.equal(typesEdit({ typesOff: [] }, { typesOff: ["volunteer"] }).status, 403);
  assert.deepEqual(typesEdit(u, { types: ["vendor", "staff"] }, { management: true }).set, { types: ["staff", "vendor"] });
  assert.deepEqual(typesEdit({ types: [], typesOff: [] }, { typesOff: ["speaker"], types: [] }), { set: { typesOff: ["speaker"] }, note: "typesOff: none → speaker" });
});

test("vipEdit: a boolean on the account, audited Yes → No", () => {
  assert.deepEqual(vipEdit({ vip: true }, { vip: false }), { set: { vip: false }, note: "VIP: Yes → No" });
  assert.deepEqual(vipEdit({}, { vip: true }), { set: { vip: true }, note: "VIP: No → Yes" });
  assert.deepEqual(vipEdit({}, { vip: true }, { vipPass: true }), { set: { vip: true }, note: "VIP: Yes → Yes" });   // fixed on the account
  assert.deepEqual(vipEdit({ vip: true }, { vip: true }), { set: {} });
  assert.deepEqual(vipEdit({}, {}), { set: {} });
  assert.equal(vipEdit({}, { vip: "yes" }).status, 400);
});

test("typeCandidates: a query per type, null for unknown ones", () => {
  assert.equal(typeCandidates("vip"), null);
  assert.deepEqual(typeCandidates("vendor"), { types: "vendor" });
  assert.deepEqual(typeCandidates("staff"), { $or: [{ role: "admin" }, { types: "staff" }] });
  assert.deepEqual(typeCandidates("volunteer"), { $or: [{ role: "volunteer" }, { types: "volunteer" }] });
  assert.equal(typeCandidates("speaker").$or.length, 2);
  assert.deepEqual(typeCandidates("exhibitor"), {});
  assert.deepEqual(typeCandidates("attendee"), {});
  assert.equal(typeCandidates("minister"), null);
});
