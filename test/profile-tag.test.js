import test from "node:test";
import assert from "node:assert/strict";
import { profileTagOf, bestPassTier, PROFILE_TAG_KEYS, PROFILE_TAG_LABELS, PROFILE_TAG_COLORS } from "../services/profileTag.js";
import {
  PERSON_TYPES, TYPE_LABELS, KIND_PRIORITY, PUBLIC_TYPES, autoTypes, effectiveTypes, exhibitorIndex, isMediaPass, typeInfo, cleanTypes, primaryKind,
} from "../services/teamRoles.js";
import { DEFAULT_MATRIX, effectiveRights, typeCandidates, holdersQuery, consoleTypes, mergeMatrix } from "../services/appRights.js";
import { autoExtras, effectiveExtras, ticketsWithExtras, cxoPerson, extrasMeta } from "../services/passExtras.js";
import { autoCxo, effectiveCxo } from "../services/cxoBreakfast.js";
import {
  MARK_TIERS, PASS_MARKS, issuedPassDoc, issuedPassRow, issuedPassUpdate, issuedVariant, validateIssuedPass,
} from "../services/issuedPasses.js";
import { buildPeople, personRow, rsvpRulesFor, filterPeople } from "../services/people.js";
import { makeLookup } from "../services/rsvpHandler.js";

/* The app Profile page's colour (Oct 20 2026): VIP gold > Media dark blue > Speaker red > Staff purple >
   Volunteer orange > any other pass holder green (their pass, or "Exhibitor") > no colour. The Media type,
   "Staff" for the type that said "Organizer", and the CxO Breakfasts for VIPs and media on any pass.
   Fictional people, example.com addresses. */

const pass = (type, ticketId = `${type.slice(0, 3)}000000001`) => ({ ticketId, type, purchaseDate: new Date("2026-10-01") });
const person = (extra = {}) => ({ _id: "u1", name: "Pat Person", role: "user", tickets: [], ...extra });
const tagOf = (u, opts) => profileTagOf(u, opts);

/* ---------- the contract ---------- */

test("profileTag: keys, labels and colours in the order they win", () => {
  assert.deepEqual(PROFILE_TAG_KEYS, ["vip", "media", "speaker", "staff", "volunteer", "pass"]);
  assert.deepEqual(PROFILE_TAG_LABELS, { vip: "VIP", media: "Media", speaker: "Speaker", staff: "Staff", volunteer: "Volunteer" });
  assert.deepEqual(PROFILE_TAG_COLORS, {
    vip: { bg: "#F5C400", text: "#3D2E00" }, media: { bg: "#0B3D91", text: "#FFFFFF" }, speaker: { bg: "#D01F2F", text: "#FFFFFF" },
    staff: { bg: "#7B2FD0", text: "#FFFFFF" }, volunteer: { bg: "#FF6B00", text: "#3A1500" }, pass: { bg: "#18A957", text: "#052E16" },
  });
  assert.equal(tagOf(null), null);
});

test("profileTag: each tag on its own", () => {
  assert.deepEqual(tagOf(person({ vip: true, tickets: [pass("power")] })), { key: "vip", label: "VIP" });
  assert.deepEqual(tagOf(person({ types: ["media"], tickets: [pass("power")] })), { key: "media", label: "Media" });
  assert.deepEqual(tagOf(person({ types: ["speaker"], tickets: [pass("influence")] })), { key: "speaker", label: "Speaker" });
  assert.deepEqual(tagOf(person({ tickets: [pass("speaker")] })), { key: "speaker", label: "Speaker" });   // a Speaker Pass
  assert.deepEqual(tagOf(person({ role: "admin" })), { key: "staff", label: "Staff" });                    // staff account
  assert.deepEqual(tagOf(person({ types: ["staff"], tickets: [pass("connect")] })), { key: "staff", label: "Staff" });
  assert.deepEqual(tagOf(person({ role: "volunteer", tickets: [pass("connect")] })), { key: "volunteer", label: "Volunteer" });
  assert.deepEqual(tagOf(person({ types: ["volunteer"] })), { key: "volunteer", label: "Volunteer" });
  assert.deepEqual(tagOf(person({ tickets: [pass("apex")] })), { key: "pass", label: "Apex" });
});

test("profileTag: the organiser's precedence — VIP overrules everything, media beats speaker, staff beats volunteer", () => {
  // "All VIPs are speakers … VIP overrules everything."
  assert.equal(tagOf(person({ vip: true, types: ["speaker"], tickets: [pass("speaker")] })).key, "vip");
  assert.equal(tagOf(person({ vip: true, types: ["media", "speaker", "staff", "volunteer"], role: "admin" })).key, "vip");
  // "Some speakers are media. So, media colors takes precedence over speaker color."
  assert.equal(tagOf(person({ types: ["speaker", "media"], tickets: [pass("power")] })).key, "media");
  assert.equal(tagOf(person({ types: ["media"], tickets: [pass("speaker")] })).key, "media");
  // Speaker over staff and volunteer (staff and volunteers who speak are red).
  assert.equal(tagOf(person({ role: "admin", types: ["speaker"] })).key, "speaker");
  assert.equal(tagOf(person({ role: "volunteer", tickets: [pass("speaker")] })).key, "speaker");
  // "All Volunteers are staff, but only few staff are organizers. Organizer color overrides volunteer color."
  assert.equal(tagOf(person({ types: ["staff", "volunteer"], tickets: [pass("connect")] })).key, "staff");
  assert.equal(tagOf(person({ role: "admin", types: ["volunteer"] })).key, "staff");
  // Volunteer over a pass.
  assert.equal(tagOf(person({ types: ["volunteer"], tickets: [pass("apex")] })).key, "volunteer");
  // Media over staff and volunteer too.
  assert.equal(tagOf(person({ role: "admin", types: ["media"] })).key, "media");
});

test("profileTag: VIP from the account flag or from a pass of theirs; the account's No wins", () => {
  assert.equal(tagOf(person({ vip: true })).key, "vip");                                         // a VIP with no pass yet
  const claimed = { ticketId: "pow000000001", ticketType: "power", claimedBy: "u1", vip: true };
  assert.equal(tagOf(person({ tickets: [pass("power")] }), { attendees: [claimed] }).key, "vip");
  assert.equal(tagOf(person({ vip: false, tickets: [pass("power")] }), { attendees: [claimed] }).label, "Power");
  assert.equal(tagOf(person({ types: ["vip"], tickets: [pass("power")] })).key, "vip");          // an old stored VIP type
  // What the caller worked out wins (GET /auth/me passes accessOf's types and vip).
  assert.equal(tagOf(person({ tickets: [pass("power")] }), { vip: true }).key, "vip");
  assert.equal(tagOf(person({ vip: true, tickets: [pass("power")] }), { vip: false }).label, "Power");
  assert.equal(tagOf(person({ tickets: [pass("power")] }), { types: ["media"] }).key, "media");
});

test("profileTag: Media from a pass staff marked Media, unless switched off on the account", () => {
  const marked = { ticketId: "pow000000001", ticketType: "power", claimedBy: "u1", media: true };
  assert.equal(tagOf(person({ tickets: [pass("power")] }), { attendees: [marked] }).key, "media");
  assert.equal(tagOf(person({ tickets: [pass("power")], typesOff: ["media"] }), { attendees: [marked] }).label, "Power");
  // A speaker switched off still shows red while they hold a Speaker Pass (the pass is internal: never green).
  assert.equal(tagOf(person({ tickets: [pass("speaker")], typesOff: ["speaker"] })).key, "speaker");
});

test("profileTag: green — the best pass's name, All Access is Power, Exhibitor on a Connect Pass", () => {
  assert.deepEqual(tagOf(person({ tickets: [pass("connect")] })), { key: "pass", label: "Connect" });
  assert.deepEqual(tagOf(person({ tickets: [pass("influence")] })), { key: "pass", label: "Influence" });
  assert.deepEqual(tagOf(person({ tickets: [pass("power")] })), { key: "pass", label: "Power" });
  assert.deepEqual(tagOf(person({ tickets: [pass("All Access Pass", "aaa000000001")] })), { key: "pass", label: "Power" });
  // Several passes: the best one.
  assert.deepEqual(tagOf(person({ tickets: [pass("connect"), pass("apex"), pass("influence")] })), { key: "pass", label: "Apex" });
  // Exhibitors hold Connect Passes: "Exhibitor" (the type from staff, or from an exhibitor pass).
  assert.deepEqual(tagOf(person({ types: ["exhibitor"], tickets: [pass("connect")] })), { key: "pass", label: "Exhibitor" });
  assert.deepEqual(tagOf(person({ tickets: [{ ...pass("connect"), promoCode: "EXHIBITOR" }] })), { key: "pass", label: "Exhibitor" });
  assert.deepEqual(tagOf(person({ tickets: [pass("connect")] }), { attendees: [{ ticketId: "con000000001", ticketType: "connect", promoCode: "EXHIBITOR" }] }),
    { key: "pass", label: "Exhibitor" });
  assert.deepEqual(tagOf(person({ types: ["exhibitor"] })), { key: "pass", label: "Exhibitor" });   // marked exhibitor, pass to come
  // An exhibitor who also bought a better pass: that pass is named.
  assert.deepEqual(tagOf(person({ types: ["exhibitor"], tickets: [pass("connect"), pass("power")] })), { key: "pass", label: "Power" });
  // Vendors and delegates with a pass are green too.
  assert.deepEqual(tagOf(person({ types: ["vendor"], tickets: [pass("connect")] })), { key: "pass", label: "Connect" });
  assert.deepEqual(tagOf(person({ types: ["attendee"], tickets: [pass("influence")] })), { key: "pass", label: "Influence" });
});

test("profileTag: no pass and none of the tags → null; booth orders aren't passes", () => {
  assert.equal(tagOf(person()), null);
  assert.equal(tagOf(person({ types: ["vendor"] })), null);
  assert.equal(tagOf(person({ types: ["attendee"] })), null);
  assert.equal(tagOf(person({ tickets: [{ ticketId: "BOOTH-STANDARD", type: "booth-standard" }] })), null);
  assert.equal(tagOf(person({ tickets: [{ ticketId: "x1", type: "booth" }] })), null);
  assert.equal(bestPassTier([{ type: "speaker" }]), "");
  assert.equal(bestPassTier([{ ticketType: "power" }, { type: "connect" }]), "power");
  assert.equal(bestPassTier(null), "");
});

/* ---------- the Media type ---------- */

test("Media: a seventh type, labelled Media; Staff (not Organizer); never a badge", () => {
  assert.ok(PERSON_TYPES.includes("media"));
  assert.equal(TYPE_LABELS.media, "Media");
  assert.equal(TYPE_LABELS.staff, "Staff");
  assert.equal(KIND_PRIORITY.includes("media"), false);
  assert.equal(PUBLIC_TYPES.includes("media"), false);
  assert.equal(primaryKind(["media"]), "");
  assert.equal(primaryKind(["media", "speaker"]), "speaker");
  assert.deepEqual(cleanTypes(["media"]), ["media"]);
  // An attendee's rights by default, and in the stored matrix.
  assert.deepEqual(DEFAULT_MATRIX.media, DEFAULT_MATRIX.attendee);
  assert.deepEqual(mergeMatrix({ media: { post: false } }).media.post, false);
  assert.deepEqual(effectiveRights(["media"]), effectiveRights(["attendee"]));
  assert.deepEqual(typeCandidates("media"), {});
  assert.deepEqual(holdersQuery("post"), { banned: { $ne: true } });
});

test("Media from a pass: Attendee.media, the exhibitor index, autoTypes and typeInfo", () => {
  assert.equal(isMediaPass({ media: true }), true);
  assert.equal(isMediaPass({ media: false }), false);
  assert.equal(isMediaPass({}), false);
  const u = person({ _id: "u7", tickets: [pass("power", "pow000000007")] });
  assert.deepEqual(autoTypes(u, { media: true }), [{ type: "media", from: "pass" }]);
  assert.deepEqual(effectiveTypes(u, { media: true }), ["media"]);
  assert.deepEqual(effectiveTypes({ ...u, typesOff: ["media"] }, { media: true }), ["attendee"]);
  const byClaim = exhibitorIndex([], { mediaRows: [{ claimedBy: "u7" }] });
  const byTicket = exhibitorIndex([], { mediaRows: [{ ticketId: "pow000000007" }] });
  const none = exhibitorIndex([], { vipRows: [{ claimedBy: "u7" }] });
  assert.equal(byClaim.hasMediaPass(u), true);
  assert.equal(byTicket.hasMediaPass(u), true);
  assert.equal(none.hasMediaPass(u), false);
  assert.equal(none.hasVipPass(u), true);
  assert.deepEqual(typeInfo(u, byClaim).types, ["media"]);
  assert.equal(typeInfo(u, byClaim).kind, "");
  const ct = consoleTypes(u, { exhibitors: byTicket });
  assert.deepEqual(ct.autoTypes, [{ type: "media", from: "pass" }]);
  assert.deepEqual(ct.effectiveTypes, ["media"]);
});

/* ---------- CxO Breakfasts: VIPs and media on any pass ---------- */

test("CxO Breakfasts: automatic for a VIP and for the media type on any pass; staff's No still wins; booths never", () => {
  assert.equal(cxoPerson([], true), true);
  assert.equal(cxoPerson(["media"]), true);
  assert.equal(cxoPerson(["speaker"]), true);
  assert.equal(cxoPerson(["staff", "volunteer"]), false);
  assert.equal(autoExtras("power").cxo, false);
  assert.equal(autoExtras("power", [], { vip: true }).cxo, true);
  assert.equal(autoExtras("connect", ["media"]).cxo, true);
  assert.equal(autoExtras("connect", ["volunteer"]).cxo, false);
  assert.equal(autoExtras("booth-standard", ["media"], { vip: true }).cxo, false);
  // The other extras still follow the pass.
  assert.deepEqual(autoExtras("connect", [], { vip: true }), { cxo: true, lunch: false, gala: false, awards: false });
  assert.equal(effectiveExtras({ ticketType: "power", vip: true }).cxo, true);
  assert.equal(effectiveExtras({ ticketType: "power", vip: true, override: { cxo: false } }).cxo, false);
  assert.equal(effectiveExtras({ ticketType: "power", types: ["media"], override: { cxo: false } }).cxo, false);
  assert.equal(autoCxo("influence", [], { vip: true }), true);
  assert.equal(effectiveCxo({ ticketType: "influence", types: ["media"] }), true);
  assert.equal(effectiveCxo({ ticketType: "influence", types: ["media"], override: false }), false);
  assert.match(extrasMeta().find((x) => x.key === "cxo").auto, /speakers, VIPs and media on any pass/);
});

test("/auth/me tickets: cxoBreakfast and the CxO line for a VIP or media holder of a Power Pass", () => {
  const t = [pass("power", "pow000000001"), { ticketId: "BOOTH-STANDARD", type: "booth-standard" }];
  const [plain] = ticketsWithExtras(t, { types: [] });
  assert.equal(plain.cxoBreakfast, false);
  const [vip, booth] = ticketsWithExtras(t, { types: [], vip: true });
  assert.equal(vip.cxoBreakfast, true);
  assert.ok(vip.inclusions.includes("2× CxO Breakfasts"));
  assert.equal(booth.cxoBreakfast, false);
  const [media] = ticketsWithExtras(t, { types: ["media"] });
  assert.equal(media.cxoBreakfast, true);
  // A No on the pass's record beats it.
  const [no] = ticketsWithExtras(t, { types: ["media"], vip: true, attendees: [{ ticketId: "POW000000001", cxoBreakfast: false }] });
  assert.equal(no.cxoBreakfast, false);
});

test("RSVP lookup: a verified ticket of a VIP or media holder offers the CxO Breakfasts", async () => {
  const mk = (t) => makeLookup({ verifyTicket: async () => t, getHolders: async () => [], getSpeakers: async () => [] });
  const base = { ticketId: "pow000000001", type: "power", names: ["Pat Person"] };
  const q = { firstName: "Pat", lastName: "Person", ticketId: "pow000000001" };
  assert.equal((await mk({ ...base, types: [] })(q)).cxoBreakfast, false);
  assert.equal((await mk({ ...base, types: [], vip: true })(q)).cxoBreakfast, true);
  assert.equal((await mk({ ...base, types: ["media"] })(q)).cxoBreakfast, true);
  assert.equal((await mk({ ...base, types: [], vip: true, extras: { cxo: false } })(q)).cxoBreakfast, false);
});

/* ---------- Give a pass: Mark as VIP / Media ---------- */

test("Give a pass: VIP and Media marks are saved on the pass; Power is picked for them, Connect for volunteers", () => {
  assert.deepEqual(PASS_MARKS, ["vip", "media"]);
  assert.deepEqual(MARK_TIERS, { vip: "power", media: "power", volunteer: "connect" });
  const v = validateIssuedPass({ name: "Vera Vip", email: "vera.vip@example.com", tier: "power", vip: true, media: false });
  assert.equal(v.ok, true);
  assert.equal(v.value.vip, true);
  assert.equal(v.value.media, false);
  assert.equal(validateIssuedPass({ name: "Vera Vip", email: "vera.vip@example.com", tier: "power", vip: "yes" }).ok, false);
  const doc = issuedPassDoc(v.value, { ticketId: "aaa000000001" });
  assert.equal(doc.vip, true);
  assert.equal("media" in doc, false);
  assert.equal(issuedPassDoc({ ...v.value, vip: false }, { ticketId: "aaa000000002" }).vip, undefined);
  // An edit: true sets the mark, false takes it off (null: the route $unsets it).
  assert.deepEqual(issuedPassUpdate({ vip: false, media: true }), { vip: null, media: true });
});

test("Give a pass: a VIP or Media pass gets the CxO Breakfasts on Automatic, in the email and on the row", () => {
  const power = { _id: "a1", name: "Mo Media", ticketId: "pow000000009", ticketType: "power", promoCode: "ISSUED", issuedPass: {} };
  const plain = issuedVariant(power);
  assert.equal(plain.extras.cxo, false);
  assert.equal(plain.includes.some(([head]) => /CxO/.test(head)), false);
  for (const marked of [{ ...power, media: true }, { ...power, vip: true }]) {
    const v = issuedVariant(marked);
    assert.equal(v.extras.cxo, true);
    assert.ok(v.includes.some(([head]) => head === "2× CxO Breakfasts"));
    assert.match(v.rsvpReason, /CxO breakfasts/);
    const row = issuedPassRow(marked);
    assert.equal(row.cxoEffective, true);
    assert.deepEqual(row.extras.cxo, { override: null, auto: true, included: true });
  }
  assert.equal(issuedPassRow({ ...power, media: true }).media, true);
  assert.equal(issuedPassRow({ ...power, vip: true }).vip, true);
  assert.equal(issuedPassRow(power).vip, false);
  // Staff's No on the pass still wins.
  assert.equal(issuedVariant({ ...power, vip: true, cxoBreakfast: false }).extras.cxo, false);
});

/* ---------- Admin › People ---------- */

test("Admin › People: Media from a pass-only person's pass and an account's type; filters; CxO for VIPs and media", () => {
  const w = {
    users: [
      { _id: "u1", name: "Ana Account", email: "ana.account@example.com", role: "user", types: ["media"], tickets: [{ ticketId: "pow000000001", type: "power", purchaseDate: new Date("2026-10-01") }] },
      { _id: "u2", name: "Vic Vip", email: "vic.vip@example.com", role: "user", vip: true, tickets: [{ ticketId: "inf000000002", type: "influence", purchaseDate: new Date("2026-10-01") }] },
    ],
    attendees: [
      { _id: "a1", name: "Pia Press", email: "pia.press@example.com", ticketId: "pow000000003", ticketType: "power", promoCode: "ISSUED", media: true, purchaseDate: new Date("2026-10-02") },
      { _id: "a2", name: "Ola Other", email: "ola.other@example.com", ticketId: "pow000000004", ticketType: "power", purchaseDate: new Date("2026-10-02") },
    ],
    rsvps: [], speakers: [], companies: [],
  };
  const { people } = buildPeople(w);
  const by = (name) => people.find((p) => p.name === name);
  assert.deepEqual(by("Ana Account").types, ["media"]);
  assert.deepEqual(by("Pia Press").types, ["media"]);
  assert.equal(personRow(by("Pia Press")).mediaPass, true);
  assert.deepEqual(by("Ola Other").types, ["attendee"]);
  assert.deepEqual(filterPeople(people, { type: "media" }).map((p) => p.name).sort(), ["Ana Account", "Pia Press"]);
  // CxO Breakfasts: automatic for both media people and the VIP, not for the plain Power Pass.
  assert.equal(by("Ana Account").primary.cxo, true);
  assert.equal(by("Pia Press").primary.cxo, true);
  assert.equal(by("Vic Vip").primary.cxo, true);
  assert.equal(by("Ola Other").primary.cxo, false);
  assert.equal(personRow(by("Vic Vip")).pass.extras.cxo.auto, true);
  // No pass yet: the RSVP rules still give a VIP or media person the CxO Breakfasts.
  assert.equal(rsvpRulesFor({ primary: null, types: ["media"], vip: false, rsvps: [], dupRsvps: [] }).cxo, true);
  assert.equal(rsvpRulesFor({ primary: null, types: [], vip: true, rsvps: [], dupRsvps: [] }).cxo, true);
  assert.equal(rsvpRulesFor({ primary: null, types: ["volunteer"], vip: false, rsvps: [], dupRsvps: [] }).cxo, undefined);
});
