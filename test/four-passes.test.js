import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { renamePassNames, renameCopy } from "../services/fourPasses.js";
import {
  isSpeakerPass, isIssuedSpeakerPass, holdsSpeakerPass, autoTypes, effectiveTypes, passKind, typesTier, SPEAKER_TIER,
} from "../services/teamRoles.js";
import { ticketsWithCxo, autoCxo } from "../services/cxoBreakfast.js";
import { buildTicketEmail } from "../services/ticketEmail.js";
import { generateTicketPDF } from "../services/pdfTicket.js";
import { passContent, tierLabel as walletTier } from "../services/walletPass.js";
import { displayPassName, inclusionsFor } from "../services/ticketInfo.js";
import { passName } from "../services/ticketAccess.js";
import { commentDTO, userCard, tierName } from "../services/socialHelpers.js";
import { buildPeople, personRow, personDetail, ticketValue, valueSource } from "../services/people.js";
import { personDeletionScope, emailHash } from "../services/accountDeletion.js";
import { COMP_TIERS } from "../services/complimentary.js";

/* Oct 19 2026: "There is no 'speaker pass'... The pass types are strictly four: Connect, Influence,
   Power and Apex." Speakers hold Power Passes (and stay speakers by type); exhibitor passes are Connect. */

const RETIRED = /Speaker Pass|All Access Pass|Exhibitor Pass/i;

test("staff wording: the retired pass names become the four, nothing else changes", () => {
  assert.equal(renamePassNames("Your Speaker Pass is below. Speaker Passes go out today."), "Your Power Pass is below. Power Passes go out today.");
  assert.equal(renamePassNames("your All Access Pass"), "your Power Pass");
  assert.equal(renamePassNames("Your Exhibitor Pass and the Exhibitor Manual"), "Your Connect Pass and the Exhibitor Manual");
  assert.equal(renamePassNames("YOUR SPEAKER PASS"), "YOUR POWER PASS");
  assert.equal(renamePassNames("A speaker's lounge pass and the speaker passageway"), "A speaker's lounge pass and the speaker passageway");
  assert.equal(renamePassNames(""), "");
  assert.equal(renamePassNames(undefined), undefined);
  assert.deepEqual(renameCopy({ subject: "Your Speaker Pass", headline: "Hello", message: "x" }, "issuedPass.copy."),
    { set: { "issuedPass.copy.subject": "Your Power Pass" }, changed: 1 });
});

test("the speaker marker: a Power Pass that makes its holder a speaker; old tickets and Speaker passes rows count", () => {
  assert.equal(isSpeakerPass({ type: "power", speakerPass: true }), true);
  assert.equal(isSpeakerPass({ type: "speaker" }), true);                     // not migrated yet
  assert.equal(isSpeakerPass({ ticketType: "power", promoCode: "SPEAKER" }), true);  // Admin › Speaker passes
  assert.equal(isSpeakerPass({ ticketType: "power", promoCode: "SPEAKER", speakerPass: false }), false); // staff switched it off
  assert.equal(isSpeakerPass({ type: "power" }), false);
  // Issued (never sold) vs a bought pass whose holder staff marked as a speaker, and a paid upgrade.
  assert.equal(isIssuedSpeakerPass({ type: "power", speakerPass: true }), true);
  assert.equal(isIssuedSpeakerPass({ type: "power", speakerPass: true, stripeSessionId: "cs_1" }), false);
  assert.equal(isIssuedSpeakerPass({ type: "apex", speakerPass: true, upgradedFrom: "power" }), false);
  const u = { role: "user", tickets: [{ ticketId: "t1", type: "power", speakerPass: true }] };
  assert.equal(holdsSpeakerPass(u.tickets), true);
  assert.deepEqual(autoTypes(u), [{ type: "speaker", from: "pass" }]);
  assert.deepEqual(effectiveTypes(u), ["speaker"]);
  assert.deepEqual(effectiveTypes({ ...u, typesOff: ["speaker"] }), ["attendee"]);   // staff can still switch it off
  assert.equal(passKind({ ticketType: "power", speakerPass: true }), "speaker");
  assert.equal(passKind({ ticketType: "power" }), "");
  // The CxO Breakfasts come with being a speaker (or the speaker's pass itself).
  assert.equal(autoCxo("power", []), false);
  assert.equal(autoCxo("power", [], { speakerPass: true }), true);
  assert.equal(autoCxo("power", ["speaker"]), true);
  assert.equal(autoCxo("speaker", []), true);
  assert.deepEqual(COMP_TIERS, ["connect", "influence", "power", "apex"]);
});

test("/auth/me tickets: type is one of the four, speakerPass says a speaker's, cxoBreakfast; staff's value stays out", () => {
  const out = ticketsWithCxo([
    { ticketId: "a1", type: "speaker" },
    { ticketId: "a2", type: "power", speakerPass: true, manualValue: 500, manualValueNote: "Invoice 1", manualValueBy: "Mia" },
    { ticketId: "a3", type: "influence" },
    { ticketId: "BOOTH-SINGLE", type: "booth-single" },
  ], { types: ["speaker"] });
  assert.deepEqual(out.map((t) => [t.type, t.speakerPass, t.cxoBreakfast]),
    [["power", true, true], ["power", true, true], ["influence", false, true], ["booth-single", false, false]]);
  assert.equal("manualValue" in out[1] || "manualValueNote" in out[1] || "manualValueBy" in out[1], false);
  assert.doesNotMatch(JSON.stringify(out), RETIRED);
  for (const t of out.filter((x) => !/^BOOTH/.test(x.ticketId))) assert.ok(["connect", "influence", "power", "apex"].includes(t.type));
});

test("ticket email, PDF and Apple Wallet: an old speaker ticket is a Power Pass, never a Speaker Pass", async () => {
  for (const tier of ["speaker", "power"]) {
    assert.equal(displayPassName(tier, "abc"), "Power Pass");
    assert.equal(passName(tier), "Power Pass");
    assert.equal(walletTier(tier), "Power Pass");
    assert.equal(tierName(tier), "Power Pass");
    const e = buildTicketEmail({ name: "Kai Speaker", ticketId: "kai000000001", tier, cxoBreakfast: true });
    assert.match(e.subject + e.html, /Power Pass/);
    assert.doesNotMatch(`${e.subject}${e.html}${e.text}`, RETIRED);
    assert.ok(inclusionsFor(tier, { cxoBreakfast: true }).includes("2x CxO Breakfasts"));
    const wallet = passContent({ ticketId: "kai000000001", tier, name: "Kai Speaker" });
    assert.equal(wallet.secondary[0].value, "Power Pass");
    assert.doesNotMatch(JSON.stringify(wallet), RETIRED);
  }
  // The PDF's own title and subject (its document info), decoded.
  const pdf = await generateTicketPDF({ ticketId: "kai000000001", tier: "speaker", name: "Kai Speaker" });
  const raw = pdf.toString("latin1");
  // UTF-16 strings (a byte-order mark, then big-endian characters) in the info objects, and plain ones.
  const utf16 = (bytes) => { const b = Buffer.from(bytes, "latin1"); return b.subarray(0, b.length - (b.length % 2)).swap16().toString("utf16le"); };
  const strings = [...raw.matchAll(/\(\xfe\xff([\s\S]*?)\)\nendobj/g)].map((m) => utf16(m[1]))
    .concat([...raw.matchAll(/\(([^\xfe][^)]*)\)/g)].map((m) => m[1]));
  // Text inside compressed streams too, as far as it's readable.
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try { strings.push(zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1")); } catch { /* images */ }
  }
  assert.ok(strings.some((s) => /Power Pass/.test(s)), "the PDF names the Power Pass");
  assert.ok(!strings.some((s) => RETIRED.test(s)), "and never a retired name");
});

test("public badges: comments and cards carry the person's kind; tier says Speaker or Exhibitor, never a pass", () => {
  const speaker = { _id: "u1", name: "Kai", role: "user", tickets: [{ ticketId: "t1", type: "power", speakerPass: true }] };
  const plain = { _id: "u2", name: "Ann", role: "user", tickets: [{ ticketId: "t2", type: "apex" }] };
  const c = { _id: "c1", postId: "p1", authorId: "u1", authorName: "Kai", authorTier: "", body: "Hi", status: "approved", createdAt: new Date() };
  // From the author's account now: a speaker keeps the badge whatever their pass says (and the comment's stored value).
  assert.deepEqual([commentDTO(c, speaker).kind, commentDTO(c, speaker).authorTier], ["speaker", SPEAKER_TIER]);
  assert.equal(SPEAKER_TIER, "Speaker"); // older apps lower-case it and look for "speaker"
  assert.deepEqual([commentDTO(c, plain).kind, commentDTO(c, plain).authorTier], ["", ""]);
  // A deleted account: what was stored when they commented (an old "Speaker Pass" reads as Speaker).
  assert.deepEqual([commentDTO({ ...c, authorTier: "Speaker Pass" }, null).kind, commentDTO({ ...c, authorTier: "Speaker Pass" }, null).authorTier], ["speaker", "Speaker"]);
  assert.deepEqual(Object.keys(commentDTO(c, plain)).sort(), ["authorId", "authorName", "authorTier", "body", "createdAt", "id", "kind", "postId", "status"]);
  // Group members (cards): kind, and tier "Speaker" for others; their own card keeps their pass.
  assert.deepEqual([userCard(speaker).kind, userCard(speaker).tier, userCard(speaker, { self: true }).tier], ["speaker", "Speaker", "Power Pass"]);
  assert.equal(typesTier(["exhibitor"]), "Exhibitor");
  for (const v of [commentDTO(c, speaker), userCard(speaker), userCard(plain)]) assert.doesNotMatch(JSON.stringify(v), RETIRED);
});

test("Admin › People: the four passes only, the speaker by type, exhibitors on Connect, manual ticket value", () => {
  const users = [
    { _id: "u1", name: "Kai Speaker", email: "kai@example.com", role: "user", tickets: [{ ticketId: "KAI1", type: "power", speakerPass: true }] },
    { _id: "u2", name: "Val Invoice", email: "val@example.com", role: "user", tickets: [{ ticketId: "VAL1", type: "apex", promoCode: "ISSUED", manualValue: 1499, manualValueNote: "Bank transfer", manualValueBy: "Mia" }] },
  ];
  const attendees = [
    { _id: "a1", name: "Kai Speaker", email: "", ticketId: "KAI1", ticketType: "power", promoCode: "SPEAKER", speakerPass: true, claimedBy: "u1", speakerId: "spk1" },
    { _id: "a2", name: "Eve Exhibitor", email: "eve@example.com", ticketId: "EVE1", ticketType: "connect", promoCode: "EXHIBITOR", issuedPass: { label: "Exhibitor Pass" } },
    { _id: "a3", name: "Old Speaker", email: "", ticketId: "OLD1", ticketType: "speaker", promoCode: "SPEAKER", speakerId: "spk2" },
    { _id: "a4", name: "Bo Bought", email: "bo@example.com", ticketId: "BO1", ticketType: "power", stripeSessionId: "cs_bo", manualValue: 5 },
  ];
  const { people } = buildPeople({ users, attendees, speakers: [{ _id: "spk1", name: "Kai Speaker" }] });
  const row = (n) => personRow(people.find((p) => p.name === n));
  assert.deepEqual([row("Kai Speaker").pass.label, row("Kai Speaker").types, row("Kai Speaker").pass.cxoBreakfast], ["Power Pass", ["speaker"], true]);
  assert.deepEqual([row("Old Speaker").pass.label, row("Old Speaker").pass.tier, row("Old Speaker").types], ["Power Pass", "power", ["speaker"]]);
  assert.deepEqual([row("Eve Exhibitor").pass.label, row("Eve Exhibitor").exhibitor], ["Connect Pass", true]);
  for (const p of people) assert.doesNotMatch(JSON.stringify(personDetail(p, { management: true })), RETIRED);
  // Paid outside Stripe: the typed amount, "manual"; a Stripe-paid pass keeps Stripe's (unknown here).
  const val = personDetail(people.find((p) => p.name === "Val Invoice"), { management: true }).passes[0];
  assert.deepEqual([val.value, val.valueSource, val.valueBand, val.manualValueNote], [1499, "manual", "above", "Bank transfer"]);
  const bo = people.find((p) => p.name === "Bo Bought").passList[0];
  assert.deepEqual([ticketValue(bo, null), valueSource(bo)], [null, "stripe"]);
  // Staff without management never see the amount.
  assert.equal("value" in personDetail(people.find((p) => p.name === "Val Invoice")).passes[0], false);
  assert.equal("manualValue" in personDetail(people.find((p) => p.name === "Val Invoice")).passes[0], false);
  // A speaker's pass we issued is worth 0; a paid upgrade of it is what was paid.
  assert.equal(ticketValue({ ticketId: "X", type: "power", speakerPass: true, promoCode: "SPEAKER" }, null), 0);
  assert.equal(ticketValue({ ticketId: "X", norm: "x", type: "apex", speakerPass: true, upgradedFrom: "power" }, { upgrades: new Map([["x", 500]]) }), 500);
});

test("delete scope: their records only; an email someone else here also uses is never used", () => {
  const users = [{ _id: "507f1f77bcf86cd799439011", name: "Bob Buyer", email: "bob@example.com", role: "user", tickets: [{ ticketId: "BOB1", type: "connect" }] }];
  const attendees = [{ _id: "507f1f77bcf86cd799439012", name: "Carol Colleague", email: "bob@example.com", ticketId: "CAR1", ticketType: "influence",
    details: { firstName: "Carol", lastName: "Colleague" } }];
  const { people } = buildPeople({ users, attendees });
  const carol = people.find((p) => p.name === "Carol Colleague");
  const bob = people.find((p) => p.name === "Bob Buyer");
  const sc = personDeletionScope(carol, people);
  assert.deepEqual([sc.userId, sc.attendeeIds, sc.emails, sc.sharedEmails], ["", ["507f1f77bcf86cd799439012"], [], ["bob@example.com"]]);
  assert.ok(sc.ticketIds.includes("CAR1") && sc.ticketKeys.includes("t:car1"));
  const sb = personDeletionScope(bob, people);
  assert.deepEqual([sb.userId, sb.emails.length, sb.sharedEmails], ["507f1f77bcf86cd799439011", 0, ["bob@example.com"]]);
  assert.match(emailHash("Bob@Example.com "), /^[0-9a-f]{16}$/);
  assert.equal(emailHash("Bob@Example.com"), emailHash("bob@example.com"));
  assert.equal(emailHash("x@ticket.thetechfestival.com"), "");
});
