import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { renamePassNames, renameCopy } from "../services/passNames.js";
import { isSpeakerPass, holdsSpeakerPass, autoTypes, effectiveTypes, passKind, typesTier, SPEAKER_TIER } from "../services/teamRoles.js";
import { ticketsWithCxo, autoCxo } from "../services/cxoBreakfast.js";
import { buildTicketEmail } from "../services/ticketEmail.js";
import { generateTicketPDF } from "../services/pdfTicket.js";
import { passContent, tierLabel as walletTier } from "../services/walletPass.js";
import { displayPassName, inclusionsFor, PASS_INCLUSIONS, CXO_INCLUSION, VIP_LOUNGE_INCLUSION, hasLounge, knowBeforeYouGo, tierKey } from "../services/ticketInfo.js";
import { passName } from "../services/ticketAccess.js";
import { allowedExperiences, rsvpOptionsPayload, EXPERIENCE_KEYS, DAY_KEYS, TIER_LABELS, tierFromTicketType } from "../services/rsvp.js";
import { commentDTO, userCard, tierName } from "../services/socialHelpers.js";
import { buildPeople, personRow, personDetail, ticketValue, valueSource } from "../services/people.js";
import { personDeletionScope, emailHash } from "../services/accountDeletion.js";
import { COMP_TIERS } from "../services/complimentary.js";

/* Pass names (Oct 19 2026): the four on sale (Connect, Influence, Power, Apex) and the internal Speaker Pass
   (tier "speaker": never sold or listed; Power + both CxO Breakfasts + the VIP Lounge, no Apex extras).
   "All Access Pass = Power Pass only"; exhibitor passes are Connect Passes, named so. */

const RETIRED = /All[- ]Access Pass|Exhibitor Pass/i;

test("staff wording: All Access → Power, Exhibitor → Connect; Speaker Pass stays", () => {
  assert.equal(renamePassNames("Your All Access Pass is below. All Access Passes go out today."), "Your Power Pass is below. Power Passes go out today.");
  assert.equal(renamePassNames("Your Exhibitor Pass and the Exhibitor Manual"), "Your Connect Pass and the Exhibitor Manual");
  assert.equal(renamePassNames("Exhibitor Passes for the booth"), "Connect Passes for the booth");
  assert.equal(renamePassNames("YOUR ALL ACCESS PASS"), "YOUR POWER PASS");
  assert.equal(renamePassNames("Your Speaker Pass and run of show"), "Your Speaker Pass and run of show");
  // On a Speaker Pass "All Access Pass" was its own old name.
  assert.equal(renamePassNames("Your All Access Pass. ALL ACCESS PASSES", { speaker: true }), "Your Speaker Pass. SPEAKER PASSES");
  assert.equal(renamePassNames("Your Exhibitor Pass", { speaker: true }), "Your Connect Pass");
  assert.equal(renamePassNames("all access to the expo"), "all access to the expo");
  assert.equal(renamePassNames(""), "");
  assert.equal(renamePassNames(undefined), undefined);
  assert.deepEqual(renameCopy({ subject: "Your Exhibitor Pass", headline: "Hello", message: "Your Speaker Pass" }, "issuedPass.copy."),
    { set: { "issuedPass.copy.subject": "Your Connect Pass" }, changed: 1 });
});

test("the internal Speaker Pass: tier speaker, named Speaker Pass; holding one makes a speaker; All Access is Power", () => {
  assert.equal(TIER_LABELS.speaker, "Speaker Pass");
  assert.deepEqual(rsvpOptionsPayload().tiers.map((t) => [t.key, t.label, t.sold]), [
    ["connect", "Connect Pass", true], ["influence", "Influence Pass", true], ["power", "Power Pass", true], ["apex", "Apex Pass", true],
    ["speaker", "Speaker Pass", false],
  ]);
  for (const t of ["speaker", "Speaker Pass"]) assert.equal(tierFromTicketType(t), "speaker", t);
  for (const t of ["all access", "All Access Pass", "all-access"]) assert.equal(tierFromTicketType(t), "power", t);
  assert.equal(tierKey("All Access"), "power");
  assert.equal(isSpeakerPass({ type: "speaker" }), true);
  assert.equal(isSpeakerPass({ ticketType: "speaker", promoCode: "SPEAKER" }), true);
  assert.equal(isSpeakerPass({ type: "power" }), false);
  const u = { role: "user", tickets: [{ ticketId: "t1", type: "speaker" }] };
  assert.equal(holdsSpeakerPass(u.tickets), true);
  assert.deepEqual(autoTypes(u), [{ type: "speaker", from: "pass" }]);
  assert.deepEqual(effectiveTypes(u), ["speaker"]);
  assert.equal(passKind({ ticketType: "speaker" }), "speaker");
  // CxO Breakfasts: Apex, the Speaker Pass and the speaker type; Power alone never.
  assert.deepEqual(["connect", "influence", "power", "apex", "speaker"].map((t) => autoCxo(t)), [false, false, false, true, true]);
  assert.equal(autoCxo("power", ["speaker"]), true);
  assert.deepEqual(COMP_TIERS, ["connect", "influence", "power", "apex"]);
});

test("Speaker Pass inclusions and RSVP options: Power + both CxO Breakfasts + the VIP Lounge; no Apex extras", () => {
  const sp = PASS_INCLUSIONS.speaker;
  for (const f of PASS_INCLUSIONS.power) assert.ok(sp.includes(f), f);
  assert.ok(sp.includes(CXO_INCLUSION));
  assert.ok(sp.includes(VIP_LOUNGE_INCLUSION));
  assert.equal(VIP_LOUNGE_INCLUSION, "VIP Lounge Access (both days)");
  for (const f of ["2x Pre-Matched Business Meetings", "Preferential Seating", "Private Scotch & Cocktail Lounge (19+)"]) assert.ok(!sp.includes(f), f);
  assert.deepEqual(inclusionsFor("speaker"), sp);
  // The 19+ Scotch lounge tip is for Apex only (the speakers' VIP Lounge isn't it).
  assert.equal(hasLounge("speaker"), false);
  assert.equal(hasLounge("apex"), true);
  assert.ok(!knowBeforeYouGo("speaker").some((t) => /19\+/.test(t)));
  // RSVP: Power's options plus the two CxO Breakfasts.
  const power = allowedExperiences("power", DAY_KEYS);
  const speaker = allowedExperiences("speaker", DAY_KEYS);
  assert.deepEqual(speaker, EXPERIENCE_KEYS.filter((k) => power.includes(k) || k === "cxo_d1" || k === "cxo_d2"));
  assert.ok(!speaker.includes("meetings") && !speaker.includes("lounge"));
});

test("/auth/me tickets: type as stored (the four or speaker), cxoBreakfast; staff's manual value stays out", () => {
  const out = ticketsWithCxo([
    { ticketId: "a1", type: "speaker" },
    { ticketId: "a2", type: "power", manualValue: 500, manualValueNote: "Invoice 1", manualValueBy: "Mia" },
    { ticketId: "a3", type: "influence" },
    { ticketId: "BOOTH-SINGLE", type: "booth-single" },
  ], { types: ["speaker"] });
  assert.deepEqual(out.map((t) => [t.type, t.cxoBreakfast]), [["speaker", true], ["power", true], ["influence", true], ["booth-single", false]]);
  assert.equal("manualValue" in out[1] || "manualValueNote" in out[1] || "manualValueBy" in out[1], false);
  assert.equal("speakerPass" in out[0], false);
  assert.doesNotMatch(JSON.stringify(out), RETIRED);
});

test("ticket email, PDF and Apple Wallet: the Speaker Pass is named so; never All Access Pass or Exhibitor Pass", async () => {
  assert.equal(displayPassName("speaker", "abc"), "Speaker Pass");
  assert.equal(passName("speaker"), "Speaker Pass");
  assert.equal(walletTier("speaker"), "Speaker Pass");
  assert.equal(walletTier("All Access"), "Power Pass");
  assert.equal(tierName("speaker"), "Speaker Pass");
  const e = buildTicketEmail({ name: "Kai Speaker", ticketId: "kai000000001", tier: "speaker", cxoBreakfast: true });
  assert.match(e.subject + e.html, /Speaker Pass/);
  assert.match(e.html + e.text, /VIP Lounge Access \(both days\)/);
  assert.doesNotMatch(`${e.subject}${e.html}${e.text}`, RETIRED);
  assert.doesNotMatch(`${e.html}${e.text}`, /Pre-Matched|Preferential Seating|Scotch/i);
  const wallet = passContent({ ticketId: "kai000000001", tier: "speaker", name: "Kai Speaker" });
  assert.equal(wallet.secondary[0].value, "Speaker Pass");
  assert.doesNotMatch(JSON.stringify(wallet), RETIRED);
  // The PDF's own title and subject (its document info), decoded, and its readable text.
  const pdf = await generateTicketPDF({ ticketId: "kai000000001", tier: "speaker", name: "Kai Speaker" });
  const raw = pdf.toString("latin1");
  const utf16 = (bytes) => { const b = Buffer.from(bytes, "latin1"); return b.subarray(0, b.length - (b.length % 2)).swap16().toString("utf16le"); };
  const strings = [...raw.matchAll(/\(\xfe\xff([\s\S]*?)\)\nendobj/g)].map((m) => utf16(m[1]))
    .concat([...raw.matchAll(/\(([^\xfe][^)]*)\)/g)].map((m) => m[1]));
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try { strings.push(zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1")); } catch { /* images */ }
  }
  assert.ok(strings.some((s) => /Speaker Pass/.test(s)), "the PDF names the Speaker Pass");
  assert.ok(!strings.some((s) => RETIRED.test(s)), "and never a retired name");
});

test("public badges: comments and cards carry the person's kind; tier says Speaker or Exhibitor (a type)", () => {
  const speaker = { _id: "u1", name: "Kai", role: "user", tickets: [{ ticketId: "t1", type: "speaker" }] };
  const plain = { _id: "u2", name: "Ann", role: "user", tickets: [{ ticketId: "t2", type: "apex" }] };
  const c = { _id: "c1", postId: "p1", authorId: "u1", authorName: "Kai", authorTier: "", body: "Hi", status: "approved", createdAt: new Date() };
  assert.deepEqual([commentDTO(c, speaker).kind, commentDTO(c, speaker).authorTier], ["speaker", SPEAKER_TIER]);
  assert.equal(SPEAKER_TIER, "Speaker"); // older apps lower-case it and look for "speaker"
  assert.deepEqual([commentDTO(c, plain).kind, commentDTO(c, plain).authorTier], ["", ""]);
  assert.deepEqual([commentDTO({ ...c, authorTier: "Speaker Pass" }, null).kind, commentDTO({ ...c, authorTier: "Speaker Pass" }, null).authorTier], ["speaker", "Speaker"]);
  // authorAvatarUrl (Oct 22 2026): their photo, never anything private.
  assert.deepEqual(Object.keys(commentDTO(c, plain)).sort(), ["authorAvatarUrl", "authorId", "authorName", "authorTier", "body", "createdAt", "id", "kind", "postId", "status"]);
  assert.deepEqual([userCard(speaker).kind, userCard(speaker).tier, userCard(speaker, { self: true }).tier], ["speaker", "Speaker", "Speaker Pass"]);
  assert.equal(typesTier(["exhibitor"]), "Exhibitor");
});

test("Admin › People: passes named by tier (Speaker Pass internal), exhibitors on Connect, manual ticket value", () => {
  const users = [
    { _id: "u1", name: "Kai Speaker", email: "kai@example.com", role: "user", tickets: [{ ticketId: "KAI1", type: "speaker" }] },
    { _id: "u2", name: "Val Invoice", email: "val@example.com", role: "user", tickets: [{ ticketId: "VAL1", type: "apex", promoCode: "ISSUED", manualValue: 1499, manualValueNote: "Bank transfer", manualValueBy: "Mia" }] },
  ];
  const attendees = [
    { _id: "a1", name: "Kai Speaker", email: "", ticketId: "KAI1", ticketType: "speaker", promoCode: "SPEAKER", claimedBy: "u1", speakerId: "spk1" },
    { _id: "a2", name: "Eve Exhibitor", email: "eve@example.com", ticketId: "EVE1", ticketType: "connect", promoCode: "EXHIBITOR", issuedPass: { label: "Exhibitor Pass" } },
    { _id: "a3", name: "Ida Issued", email: "ida@example.com", ticketId: "IDA1", ticketType: "speaker", promoCode: "ISSUED", issuedPass: { label: "All Access Pass" } },
    { _id: "a4", name: "Bo Bought", email: "bo@example.com", ticketId: "BO1", ticketType: "power", stripeSessionId: "cs_bo", manualValue: 5 },
  ];
  const { people } = buildPeople({ users, attendees, speakers: [{ _id: "spk1", name: "Kai Speaker" }] });
  const row = (n) => personRow(people.find((p) => p.name === n));
  assert.deepEqual([row("Kai Speaker").pass.label, row("Kai Speaker").types, row("Kai Speaker").pass.cxoBreakfast], ["Speaker Pass", ["speaker"], true]);
  assert.deepEqual([row("Ida Issued").pass.label, row("Ida Issued").types], ["Speaker Pass", ["speaker"]]);
  assert.deepEqual([row("Eve Exhibitor").pass.label, row("Eve Exhibitor").exhibitor], ["Connect Pass", true]);
  for (const p of people) assert.doesNotMatch(JSON.stringify(personDetail(p, { management: true })), RETIRED);
  const val = personDetail(people.find((p) => p.name === "Val Invoice"), { management: true }).passes[0];
  assert.deepEqual([val.value, val.valueSource, val.valueBand, val.manualValueNote], [1499, "manual", "above", "Bank transfer"]);
  const bo = people.find((p) => p.name === "Bo Bought").passList[0];
  assert.deepEqual([ticketValue(bo, null), valueSource(bo)], [null, "stripe"]);
  assert.equal("value" in personDetail(people.find((p) => p.name === "Val Invoice")).passes[0], false);
  assert.equal("manualValue" in personDetail(people.find((p) => p.name === "Val Invoice")).passes[0], false);
  assert.equal(ticketValue({ ticketId: "X", type: "speaker", promoCode: "SPEAKER" }, null), 0);
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
  assert.deepEqual([sb.userId, sb.emails.length, sb.sharedEmails, sb.accountTickets], ["507f1f77bcf86cd799439011", 0, ["bob@example.com"], 1]);
  assert.match(emailHash("Bob@Example.com "), /^[0-9a-f]{16}$/);
  assert.equal(emailHash("Bob@Example.com"), emailHash("bob@example.com"));
  assert.equal(emailHash("x@ticket.thetechfestival.com"), "");
});
