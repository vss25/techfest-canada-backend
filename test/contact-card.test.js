import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTACT_KINDS, MAX_CONTACT_ITEMS, CONTACT_SELECT, TOO_MANY_ERROR, cleanValue, cleanLabel, cleanItems, contactItemsFor,
  contactCardDTO, cleanShareIds, sideOf, pickedShare, setShare, effectiveShareIds, sharedContactFrom, shareFields,
  legacyEmail, firstLinkedIn, syncLinkedInItem, accountEmailOf, isPlaceholderEmail, qrShareOf, applyQrShare,
} from "../services/contactCard.js";
import { RIGHTS, RIGHT_LABELS, rightsFor } from "../services/appRights.js";
import { userCard, publicProfile } from "../services/socialHelpers.js";
import { sanitizeProfilePatch } from "../routes/profile.js";

const can = Object.fromEntries(RIGHTS.map((r) => [r, true]));
const cannot = { ...can, shareContact: false };

const ok = (kind, raw) => cleanValue(kind, raw).value;
const bad = (kind, raw) => assert.ok(cleanValue(kind, raw).error, `${kind} ${JSON.stringify(raw)} should be refused`);

/* ---------- values per kind ---------- */

test("kinds and limits", () => {
  assert.deepEqual(CONTACT_KINDS, ["email", "phone", "whatsapp", "linkedin", "website", "x", "instagram", "wechat", "other"]);
  assert.equal(MAX_CONTACT_ITEMS, 12);
  assert.match(CONTACT_SELECT, /contactItems/);
  assert.equal(RIGHT_LABELS.shareContact, "Share contact details");
});

test("email: trimmed, lower case, checked", () => {
  assert.equal(ok("email", "  Ann.Lee+ttfc@Example.CO.uk "), "ann.lee+ttfc@example.co.uk");
  for (const v of ["", "ann", "ann@", "@x.com", "ann@x", "ann lee@x.com", "ann@x.c", "a<b>@x.com"]) bad("email", v);
  bad("email", `${"a".repeat(250)}@x.com`);
});

test("phone and WhatsApp: digits, spaces, + and brackets, 6 to 15 digits", () => {
  assert.equal(ok("phone", "+1 (416) 555-0100"), "+1 (416) 555-0100");
  assert.equal(ok("phone", "  416   555 0100 "), "416 555 0100");
  assert.equal(ok("whatsapp", "+447700900123"), "+447700900123");
  for (const v of ["12345", "+1 416 555 0100 999999", "call me", "416-555-01OO", "4+16 555 0100", "++14165550100"]) bad("phone", v);
  bad("whatsapp", "abc");
});

test("LinkedIn: links, in/ paths and bare names become one https link", () => {
  assert.equal(ok("linkedin", "linkedin.com/in/annlee"), "https://www.linkedin.com/in/annlee");
  assert.equal(ok("linkedin", "https://ca.linkedin.com/in/ann-lee-123/?trk=x"), "https://www.linkedin.com/in/ann-lee-123");
  assert.equal(ok("linkedin", "www.linkedin.com/company/atlaslink/"), "https://www.linkedin.com/company/atlaslink");
  assert.equal(ok("linkedin", "in/annlee"), "https://www.linkedin.com/in/annlee");
  assert.equal(ok("linkedin", "annlee"), "https://www.linkedin.com/in/annlee");
  for (const v of ["https://evil.com/in/annlee", "linkedin.com", "linkedin.com/feed", "a b", "x"]) bad("linkedin", v);
});

test("website: http(s) only, a real host name, https added", () => {
  assert.equal(ok("website", "atlaslink.ca"), "https://atlaslink.ca");
  assert.equal(ok("website", "http://www.example.com/team?x=1"), "http://www.example.com/team?x=1");
  for (const v of ["javascript:alert(1)", "ftp://x.com", "localhost", "http://10.0.0.1", "exa mple.com", "https://user:pw@x.com", "example"]) bad("website", v);
});

test("X and Instagram: handles or profile links → @handle", () => {
  assert.equal(ok("x", "@ttfc_2026"), "@ttfc_2026");
  assert.equal(ok("x", "https://twitter.com/jack?lang=en"), "@jack");
  assert.equal(ok("x", "x.com/jack"), "@jack");
  for (const v of ["@this_handle_is_way_too_long", "jack.doe", "facebook.com/jack", "@"]) bad("x", v);
  assert.equal(ok("instagram", "@ann.lee_"), "@ann.lee_");
  assert.equal(ok("instagram", "ann.lee"), "@ann.lee");
  assert.equal(ok("instagram", "https://www.instagram.com/ann.lee/"), "@ann.lee");
  for (const v of ["ann lee", "tiktok.com/@ann", "instagram.com"]) bad("instagram", v);
});

test("WeChat, other and unknown kinds", () => {
  assert.equal(ok("wechat", "ann_lee-88"), "ann_lee-88");
  bad("wechat", "ann lee");
  bad("wechat", "a");
  assert.equal(ok("other", "  Signal:   ann.88 "), "Signal: ann.88");
  bad("other", "   ");
  bad("other", "x".repeat(201));
  assert.equal(cleanValue("fax", "123").error, "Pick what kind of contact detail this is.");
});

test("labels: tidied and capped at 30, control characters gone", () => {
  assert.equal(cleanLabel("  Work\n phone "), "Work phone");
  assert.equal(cleanLabel("x".repeat(40)).length, 30);
  assert.equal(cleanLabel(undefined), "");
  assert.equal(cleanLabel("Wo\u202erk"), "Wo rk");
});

/* ---------- the list ---------- */

test("cleanItems: tidies each, keeps order, fresh ids for bad or repeated ones", () => {
  const out = cleanItems([
    { id: "a1", kind: "phone", label: "Work", value: "+1 416 555 0100", shareByDefault: true },
    { id: "a1", kind: "email", value: "Ann@X.com" },
    { id: "bad id!", kind: "x", value: "@ann" },
    { kind: "website", value: "ann.dev", shareByDefault: "yes" },
  ], { accountEmail: "ann@lee.com" });
  assert.equal(out.error, undefined);
  assert.equal(out.items.length, 4);
  assert.deepEqual(out.items[0], { id: "a1", kind: "phone", label: "Work", value: "+1 416 555 0100", shareByDefault: true });
  assert.notEqual(out.items[1].id, "a1");
  assert.equal(out.items[1].value, "ann@x.com");
  assert.match(out.items[2].id, /^[A-Za-z0-9_-]{8}$/);
  assert.equal(out.items[3].shareByDefault, false);
  assert.equal(new Set(out.items.map((i) => i.id)).size, 4);
});

test("cleanItems: refuses a bad value with its index, more than 12, non-lists", () => {
  assert.deepEqual(cleanItems([{ kind: "email", value: "ann@x.com" }, { kind: "email", value: "nope" }]), { error: "Enter a valid email address.", index: 1 });
  assert.deepEqual(cleanItems(Array.from({ length: 13 }, () => ({ kind: "other", value: "x" }))), { error: TOO_MANY_ERROR });
  assert.ok(cleanItems("nope").error);
  assert.equal(cleanItems([null]).index, 0);
  assert.equal(cleanItems(Array.from({ length: 12 }, () => ({ kind: "other", value: "x" }))).items.length, 12);
});

test("cleanItems: the account email item stores no value, once, and only with a real email", () => {
  const out = cleanItems([
    { id: "acc", account: true, kind: "phone", value: "spoofed@evil.com", label: "Sign-in", shareByDefault: true },
    { id: "acc2", account: true },
  ], { accountEmail: "ann@lee.com" });
  assert.deepEqual(out.items, [{ id: "acc", kind: "email", label: "Sign-in", value: "", shareByDefault: true, account: true }]);
  assert.deepEqual(cleanItems([{ account: true }], { accountEmail: "" }).items, []);
});

test("accountEmailOf: never a ticket sign-in placeholder", () => {
  assert.equal(accountEmailOf({ email: " Ann@Lee.com " }), "ann@lee.com");
  assert.equal(accountEmailOf({ email: "tk123@ticket.thetechfestival.com" }), "");
  assert.ok(isPlaceholderEmail("X@TICKET.THETECHFESTIVAL.COM"));
  assert.equal(accountEmailOf(null), "");
});

/* ---------- reading a card ---------- */

const ann = {
  _id: "u-ann", name: "Ann Lee", email: "ann@lee.com", linkedinUrl: "https://linkedin.com/in/annlee",
  contactCardSavedAt: new Date("2026-10-18"),
  contactItems: [
    { id: "acc", kind: "email", label: "", value: "", shareByDefault: false, account: true },
    { id: "ph", kind: "phone", label: "Mobile", value: "+1 416 555 0100", shareByDefault: true },
    { id: "wa", kind: "whatsapp", label: "", value: "+1 416 555 0100", shareByDefault: false },
    { id: "li", kind: "linkedin", label: "", value: "https://www.linkedin.com/in/annlee", shareByDefault: true },
  ],
};

test("contactItemsFor: saved card with the account email filled in live", () => {
  const items = contactItemsFor(ann);
  assert.equal(items.length, 4);
  assert.deepEqual(items[0], { id: "acc", kind: "email", label: "", value: "ann@lee.com", shareByDefault: false, account: true });
  assert.equal(contactItemsFor({ ...ann, email: "new@lee.com" })[0].value, "new@lee.com");
  // A placeholder sign-in email never shows; broken rows are skipped.
  const p = contactItemsFor({ ...ann, email: "x@ticket.thetechfestival.com", contactItems: [...ann.contactItems, { id: "z", kind: "fax", value: "1" }, { kind: "email", value: "a@b.co" }] });
  assert.deepEqual(p.map((i) => i.id), ["ph", "wa", "li"]);
  assert.deepEqual(contactItemsFor(null), []);
});

test("contactItemsFor: never saved → account email + profile LinkedIn, shared by default", () => {
  const fresh = { _id: "u2", email: "bo@x.com", linkedinUrl: "linkedin.com/in/bo-x", contactItems: [] };
  assert.deepEqual(contactItemsFor(fresh), [
    { id: "account", kind: "email", label: "", value: "bo@x.com", shareByDefault: true, account: true },
    { id: "linkedin", kind: "linkedin", label: "", value: "https://www.linkedin.com/in/bo-x", shareByDefault: true },
  ]);
  assert.deepEqual(contactItemsFor({ email: "t@ticket.thetechfestival.com", linkedinUrl: "not a link at all" }), []);
  // Saved but emptied stays empty (no re-migration).
  assert.deepEqual(contactItemsFor({ ...fresh, contactCardSavedAt: new Date(), contactItems: [] }), []);
});

test("contactCardDTO: own card, account email, sharing right", () => {
  const dto = contactCardDTO(ann, can);
  assert.equal(dto.items.length, 4);
  assert.equal(dto.accountEmail, "ann@lee.com");
  assert.equal(dto.canShare, true);
  assert.equal(dto.saved, true);
  assert.equal(dto.max, 12);
  assert.equal(contactCardDTO(ann, cannot).canShare, false);
  assert.equal(contactCardDTO({ email: "a@b.co" }, can).saved, false);
});

/* ---------- sharing per connection ---------- */

const bo = { _id: "u-bo", name: "Bo", email: "bo@x.com", linkedinUrl: "", contactItems: [] };
const conn = (extra = {}) => ({ _id: "c1", fromUserId: "u-ann", toUserId: "u-bo", status: "accepted", kind: "online", ...extra });

test("cleanShareIds: only current item ids, once, in the owner's order", () => {
  const items = contactItemsFor(ann);
  assert.deepEqual(cleanShareIds(["li", "ph", "ph", "nope", 5], items), ["ph", "li"]);
  assert.deepEqual(cleanShareIds([], items), []);
  assert.equal(cleanShareIds(undefined, items), null);
  assert.equal(cleanShareIds("ph", items), null);
});

test("sides, picks and setShare", () => {
  const c = conn();
  assert.equal(sideOf(c, "u-ann"), "from");
  assert.equal(sideOf(c, "u-bo"), "to");
  assert.equal(sideOf(c, "u-x"), null);
  assert.deepEqual(pickedShare(c, "u-ann"), { picked: false, ids: [] });
  const at = new Date("2026-10-26T10:00:00Z");
  assert.equal(setShare(c, "u-bo", ["account"], at), true);
  assert.deepEqual(c.toShare, ["account"]);
  assert.equal(c.toShareAt, at);
  assert.equal(c.fromShare, undefined);
  assert.deepEqual(pickedShare(c, "u-bo"), { picked: true, ids: ["account"] });
  assert.equal(setShare(c, "u-x", ["a"]), false);
  setShare(c, "u-ann", []);
  assert.deepEqual(pickedShare(c, "u-ann"), { picked: true, ids: [] });
});

test("what someone shares: their pick, resolved live (edits show, deletions vanish)", () => {
  const c = conn({ fromShare: ["ph", "acc", "gone"] });
  assert.deepEqual(sharedContactFrom(c, ann, can), [
    { kind: "email", label: "", value: "ann@lee.com" },
    { kind: "phone", label: "Mobile", value: "+1 416 555 0100" },
  ]);
  const edited = { ...ann, contactItems: ann.contactItems.filter((i) => i.id !== "acc").map((i) => (i.id === "ph" ? { ...i, value: "+1 647 555 0199" } : i)) };
  assert.deepEqual(sharedContactFrom(c, edited, can), [{ kind: "phone", label: "Mobile", value: "+1 647 555 0199" }]);
  // Never ids, defaults or account flags.
  for (const it of sharedContactFrom(c, ann, can)) assert.deepEqual(Object.keys(it), ["kind", "label", "value"]);
});

test("what someone shares: nothing until accepted, without shareContact, or across a block", () => {
  const c = conn({ fromShare: ["ph"] });
  assert.deepEqual(sharedContactFrom({ ...c, status: "pending" }, ann, can), []);
  assert.deepEqual(sharedContactFrom({ ...c, status: "declined" }, ann, can), []);
  assert.deepEqual(sharedContactFrom(c, ann, cannot), []);
  assert.deepEqual(sharedContactFrom(c, ann, can, { blocked: true }), []);
  assert.deepEqual(sharedContactFrom(c, ann, null), []);
});

test("a side that never picked: defaults in person (as before), nothing online", () => {
  // Never-saved card in person = the account email (+ public LinkedIn), what a badge scan shared before.
  const inPerson = conn({ kind: "inPerson" });
  assert.deepEqual(sharedContactFrom(inPerson, { ...bo, linkedinUrl: "" }, can), [{ kind: "email", label: "", value: "bo@x.com" }]);
  assert.deepEqual(sharedContactFrom(inPerson, ann, can).map((i) => i.kind), ["phone", "linkedin"]);
  assert.deepEqual(sharedContactFrom(conn(), ann, can), []);
  assert.deepEqual(sharedContactFrom(conn(), bo, can), []);
  // A placeholder sign-in email is never shared.
  assert.deepEqual(sharedContactFrom(inPerson, { ...bo, email: "z@ticket.thetechfestival.com" }, can), []);
});

test("shareFields: the viewer sees only the other side's items and their own ids", () => {
  const c = conn({ kind: "inPerson", fromShare: ["wa"], toShare: ["account"] });
  const forBo = shareFields(c, { viewer: bo, viewerRights: can, other: ann, otherRights: can });
  assert.deepEqual(forBo, { sharedContact: [{ kind: "whatsapp", label: "", value: "+1 416 555 0100" }], myShare: ["account"], mySharePicked: true });
  const forAnn = shareFields(c, { viewer: ann, viewerRights: can, other: bo, otherRights: can });
  assert.deepEqual(forAnn, { sharedContact: [{ kind: "email", label: "", value: "bo@x.com" }], myShare: ["wa"], mySharePicked: true });
  // Not picked yet: myShare = what is shared now (defaults in person), mySharePicked false.
  const unpicked = shareFields(conn({ kind: "inPerson" }), { viewer: ann, viewerRights: can, other: bo, otherRights: can });
  assert.deepEqual(unpicked.myShare, ["ph", "li"]);
  assert.equal(unpicked.mySharePicked, false);
  // A viewer without the right shares nothing, whatever is stored.
  assert.deepEqual(shareFields(c, { viewer: ann, viewerRights: cannot, other: bo, otherRights: can }).myShare, []);
  assert.deepEqual(shareFields(null, { viewer: ann }), { sharedContact: [], myShare: [], mySharePicked: false });
});

test("existing in-person connections keep sharing the account email until that side picks", () => {
  const legacy = { _id: "c9", fromUserId: "u-bo", toUserId: "u-cy", status: "accepted", kind: "inPerson" };
  const cy = { _id: "u-cy", email: "cy@z.org", linkedinUrl: "", contactItems: [] };
  assert.equal(legacyEmail(sharedContactFrom(legacy, bo, can)), "bo@x.com");
  assert.equal(legacyEmail(sharedContactFrom(legacy, cy, can)), "cy@z.org");
  setShare(legacy, "u-bo", []);
  assert.deepEqual(sharedContactFrom(legacy, bo, can), []);
  // Cy hasn't picked: still as before.
  assert.equal(legacyEmail(sharedContactFrom(legacy, cy, can)), "cy@z.org");
  // A vendor / VIP type without shareContact shares nothing (as before).
  assert.deepEqual(sharedContactFrom(legacy, cy, rightsFor({ types: ["vip"], tickets: [{ type: "power" }] })), []);
});

test("legacyEmail and firstLinkedIn", () => {
  assert.equal(legacyEmail([{ kind: "phone", value: "1" }, { kind: "email", value: "a@b.co" }]), "a@b.co");
  assert.equal(legacyEmail([]), "");
  assert.equal(firstLinkedIn(contactItemsFor(ann)), "https://www.linkedin.com/in/annlee");
  assert.equal(firstLinkedIn([]), "");
});

/* ---------- connect QR ---------- */

test("qrShareOf: the QR sheet's pick (resolved live), else share-by-default items", () => {
  assert.deepEqual(qrShareOf(ann), { ids: ["ph", "li"], picked: false });
  assert.deepEqual(qrShareOf({ ...ann, contactQrShare: ["wa", "gone", "acc"] }), { ids: ["acc", "wa"], picked: true });
  assert.deepEqual(qrShareOf({ ...ann, contactQrShare: [] }), { ids: [], picked: true });
  assert.deepEqual(contactCardDTO({ ...ann, contactQrShare: ["wa"] }, can).qrShare, ["wa"]);
  assert.equal(contactCardDTO(ann, can).qrSharePicked, false);
});

test("applyQrShare: copies the QR pick onto a scan of the QR, never over a pick or without the right", () => {
  const scanned = { ...ann, contactQrShare: ["wa"] };
  const c = conn({ fromUserId: "u-bo", toUserId: "u-ann", kind: "inPerson" });
  assert.equal(applyQrShare(c, scanned, can), true);
  assert.deepEqual(c.toShare, ["wa"]);
  assert.deepEqual(sharedContactFrom(c, scanned, can), [{ kind: "whatsapp", label: "", value: "+1 416 555 0100" }]);
  // Already picked for this person: left alone.
  assert.equal(applyQrShare(c, { ...scanned, contactQrShare: ["ph"] }, can), false);
  assert.deepEqual(c.toShare, ["wa"]);
  // No QR pick (defaults apply by themselves) or no right: nothing stored.
  const c2 = conn({ fromUserId: "u-bo", toUserId: "u-ann", kind: "inPerson" });
  assert.equal(applyQrShare(c2, ann, can), false);
  assert.equal(applyQrShare(c2, scanned, cannot), false);
  assert.equal(c2.toShare, undefined);
});

/* ---------- profile LinkedIn ⇄ first LinkedIn item ---------- */

test("syncLinkedInItem: edits, adds and removes the card's LinkedIn; never-saved cards are left alone", () => {
  const edited = syncLinkedInItem(ann, "https://linkedin.com/in/ann-new");
  assert.equal(edited.find((i) => i.id === "li").value, "https://www.linkedin.com/in/ann-new");
  assert.equal(edited.find((i) => i.id === "acc").account, true);
  assert.equal(edited.length, 4);
  assert.equal(syncLinkedInItem(ann, "https://www.linkedin.com/in/annlee"), null);
  const removed = syncLinkedInItem(ann, "");
  assert.deepEqual(removed.map((i) => i.id), ["acc", "ph", "wa"]);
  const noLi = { ...ann, contactItems: ann.contactItems.filter((i) => i.kind !== "linkedin") };
  const added = syncLinkedInItem(noLi, "https://linkedin.com/in/x-y");
  assert.equal(added.at(-1).kind, "linkedin");
  assert.equal(added.at(-1).shareByDefault, true);
  assert.equal(syncLinkedInItem(noLi, ""), null);
  assert.equal(syncLinkedInItem(ann, "https://example.com/me"), null);
  assert.equal(syncLinkedInItem({ email: "a@b.co", contactItems: [] }, "https://linkedin.com/in/a"), null);
  const full = { ...noLi, contactItems: Array.from({ length: 12 }, (_, i) => ({ id: `o${i}`, kind: "other", value: "x" })) };
  assert.equal(syncLinkedInItem(full, "https://linkedin.com/in/a"), null);
});

/* ---------- never on public cards ---------- */

test("public cards and profiles never carry contact items or the email", () => {
  const card = userCard(ann);
  const profile = publicProfile(ann);
  for (const o of [card, profile]) {
    assert.equal(o.contactItems, undefined);
    assert.equal(o.email, undefined);
    assert.ok(!JSON.stringify(o).includes("555 0100"));
  }
  // The profile PATCH never takes contact items (only /api/social/contact-card does).
  assert.deepEqual(sanitizeProfilePatch({ contactItems: [{ kind: "email", value: "a@b.co" }], contactCardSavedAt: "x" }), {});
});
