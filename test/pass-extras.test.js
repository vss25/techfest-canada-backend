import test from "node:test";
import assert from "node:assert/strict";
import PDFDocument from "pdfkit";
import {
  EXTRAS, EXTRA_KEYS, autoExtras, effectiveExtras, extrasOverride, cleanExtras, extrasWrite, extraLabel, extrasView, ticketsWithExtras, timesWording,
} from "../services/passExtras.js";
import { inclusionsFor, PASS_INCLUSIONS } from "../services/ticketInfo.js";
import { buildTicketEmail, purchaseEmailDefaults } from "../services/ticketEmail.js";
import { generateTicketPDF } from "../services/pdfTicket.js";
import {
  ISSUE_TIERS, includesWithExtras, issuedVariant, issuedPassDoc, issuedPassRow, issuedPassUpdate, rsvpReasonFor, validateIssuedPass,
} from "../services/issuedPasses.js";
import { exhibitorCopyFor } from "../services/exhibitorPasses.js";
import { buildPassEmail, passVariant, speakerVariant } from "../services/passEmail.js";
import { SPEAKER_INCLUDES, RSVP_REASON } from "../services/speakerPassEmail.js";
import { speakerPassRow } from "../services/speakerPasses.js";
import { allowedExperiences, checkOptions, extraOptionsFor, DAY_KEYS, EXTRA_OPTIONS } from "../services/rsvp.js";
import { makeLookup, makeRsvpHandlers } from "../services/rsvpHandler.js";
import { planStaffRsvp } from "../services/rsvpStaff.js";
import { buildPeople, personDetail, personRow, peopleCounts, peopleCsv, eligibleCounts, rsvpRulesFor, PEOPLE_CSV_HEAD } from "../services/people.js";
import { makeGuessLimiter } from "../services/ticketAccess.js";

/* Pass extras (Oct 19 2026): staff add meals and events to one pass, or take them off, the way the
   "CxO Breakfast included" switch works: CxO Breakfasts, Networking Luncheons, the Gala Dinner &
   Networking Reception and the Catalyst Awards Night, each Automatic / Yes / No. Yes: the RSVP page
   offers it, the ticket lists it, the admin counts the pass as eligible. No: no longer offered, but a
   choice already on the attendee's RSVP stays. Fictional people, example.com addresses. */

const ALL = { cxo: true, lunch: true, gala: true, awards: true };
const NONE = { cxo: false, lunch: false, gala: false, awards: false };

/* ---------- 1. Automatic, per tier ---------- */

test("automatic: Influence and up get the luncheons; Power, Apex and the Speaker Pass the Gala and Awards; CxO unchanged", () => {
  assert.deepEqual(EXTRA_KEYS, ["cxo", "lunch", "gala", "awards"]);
  assert.deepEqual(autoExtras("connect"), NONE);
  assert.deepEqual(autoExtras("influence"), { ...NONE, lunch: true });
  assert.deepEqual(autoExtras("power"), { cxo: false, lunch: true, gala: true, awards: true });
  assert.deepEqual(autoExtras("apex"), ALL);
  assert.deepEqual(autoExtras("speaker"), ALL);              // the internal Speaker Pass
  assert.deepEqual(autoExtras("vip"), ALL);                  // retired key = Apex
  assert.deepEqual(autoExtras("All Access Pass"), autoExtras("power"));
  assert.deepEqual(autoExtras("booth-gold", ["speaker"]), NONE);
  // The speaker type gives the CxO Breakfasts on any pass, and nothing else.
  assert.deepEqual(autoExtras("connect", ["speaker"]), { ...NONE, cxo: true });
  assert.deepEqual(autoExtras("influence", ["speaker"]), { ...NONE, cxo: true, lunch: true });
  // Unknown / older ticket types are Connect.
  assert.deepEqual(autoExtras("early"), NONE);
});

test("Yes / No per extra beats automatic; the account's ticket wins over its pass row; switches are cleaned", () => {
  for (const x of EXTRA_KEYS) {
    assert.equal(effectiveExtras({ ticketType: "connect", override: { [x]: true } })[x], true, `${x} Yes on Connect`);
    assert.equal(effectiveExtras({ ticketType: "apex", override: { [x]: false } })[x], false, `${x} No on Apex`);
    // The others stay automatic.
    const others = EXTRA_KEYS.filter((k) => k !== x);
    for (const k of others) assert.equal(effectiveExtras({ ticketType: "apex", override: { [x]: false } })[k], true);
  }
  assert.deepEqual(extrasOverride({ galaDinner: true, cxoBreakfast: false }, { galaDinner: false, luncheons: true }), { cxo: false, lunch: true, gala: true });
  assert.deepEqual(extrasOverride({}, null), {});
  assert.deepEqual(EXTRAS.map((e) => e.field), ["cxoBreakfast", "luncheons", "galaDinner", "awardsNight"]);
  assert.deepEqual(cleanExtras({ extras: { gala: true, lunch: null, awards: "auto" }, cxoBreakfast: false }).value, { cxo: false, gala: true, lunch: null, awards: null });
  assert.deepEqual(cleanExtras({ cxoBreakfast: true, extras: { cxo: false } }).value, { cxo: false }); // extras.cxo wins
  assert.equal(cleanExtras({ extras: { dinner: true } }).ok, false);
  assert.equal(cleanExtras({ extras: { gala: "yes" } }).ok, false);
  assert.equal(cleanExtras({ extras: ["gala"] }).ok, false);
  assert.deepEqual(extrasWrite({ gala: true, lunch: null, cxo: false }), { set: { galaDinner: true, cxoBreakfast: false }, unset: { luncheons: 1 } });
  assert.deepEqual([extraLabel(true, true), extraLabel(undefined, true), extraLabel(false, false)], ["Yes", "automatic (Yes)", "No"]);
  assert.deepEqual(extrasView({ gala: true }, autoExtras("connect"), effectiveExtras({ ticketType: "connect", override: { gala: true } })).gala, { override: true, auto: false, included: true });
});

/* ---------- 2. The RSVP page: offered or refused ---------- */

const TICKETS = {
  con000000001: { ticketId: "CON000000001", type: "connect", last: "gala", names: ["Cara Gala"], extras: { gala: true } },
  con000000002: { ticketId: "CON000000002", type: "connect", last: "plain", names: ["Cy Plain"] },
  pow000000001: { ticketId: "POW000000001", type: "power", last: "nogala", names: ["Pat Nogala"], extras: { gala: false, lunch: false } },
  pow000000002: { ticketId: "POW000000002", type: "power", last: "kept", names: ["Kim Kept"], extras: { gala: false, awards: false } },
  inf000000001: { ticketId: "INF000000001", type: "influence", last: "awards", names: ["Ike Awards"], extras: { awards: true, cxo: true } },
  apx000000001: { ticketId: "APX000000001", type: "apex", last: "nolunch", names: ["Ada Nolunch"], extras: { lunch: false } },
};
function rsvpWorld() {
  const rows = [];
  let n = 0;
  const live = (r) => !r.spam && !r.mergedInto;
  const store = {
    async findByKey(key) { return rows.find((r) => r.key === key && !r.spam) || null; },
    async findByNameKey(nk) { return nk ? rows.filter((r) => r.nameKey === nk && live(r)) : []; },
    async findByEditToken(h) { return (h && rows.find((r) => r.editTokenHash === h && live(r))) || null; },
    async insert(doc) { const d = { ...doc, _id: `r${++n}`, createdAt: new Date(), updatedAt: new Date() }; rows.push(d); return d; },
    async update(id, set) { const d = rows.find((r) => r._id === id); Object.assign(d, set, { submissions: (d.submissions || 1) + 1, updatedAt: new Date() }); return d; },
    async mark(id, set) { Object.assign(rows.find((r) => r._id === id), set); },
  };
  const lookup = makeLookup({
    verifyTicket: async (id, last) => {
      const t = TICKETS[String(id).toLowerCase()];
      return t && t.last === last.toLowerCase() ? { ticketId: t.ticketId, type: t.type, names: t.names, types: [], extras: t.extras || {} } : null;
    },
    getHolders: async () => [],
    getSpeakers: async () => [],
  });
  const h = makeRsvpHandlers({ lookup, store, log: { error() {} }, ticketGuessLimiter: makeGuessLimiter({ max: 50, windowMs: 60_000 }) });
  const res = () => ({ statusCode: 200, body: undefined, headersSent: false, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; }, setHeader() {} });
  const submit = async (body) => { const r = res(); await h.submit({ body: { _hp: "", elapsedMs: 60000, page: "/rsvp", days: ["day1", "day2"], ...body }, ip: "1.2.3.4", headers: {} }, r); return r; };
  const look = async (body) => { const r = res(); await h.lookup({ body, ip: "1.2.3.4", headers: {} }, r); return r.body; };
  return { rows, submit, look };
}
const who = (first, last, ticketId) => ({ firstName: first, lastName: last, ticketId });

test("RSVP: an extra set to Yes is offered and saved (a Connect Pass with the Gala); No is refused", async () => {
  const w = rsvpWorld();
  const cara = await w.look(who("Cara", "Gala", "CON000000001"));
  assert.ok(cara.allowedOptions.includes("gala"));
  assert.ok(!cara.allowedOptions.includes("awards") && !cara.allowedOptions.includes("lunch_d1"));
  assert.deepEqual(cara.allowedOptions, allowedExperiences("connect", DAY_KEYS, { extras: { ...NONE, gala: true } }));
  const plain = await w.look(who("Cy", "Plain", "CON000000002"));
  assert.ok(!plain.allowedOptions.includes("gala"));
  // The save takes it for Cara and refuses it for Cy.
  const saved = await w.submit({ ...who("Cara", "Gala", "CON000000001"), options: ["gala", "sessions_d2"] });
  assert.equal(saved.statusCode, 201);
  assert.deepEqual(w.rows[0].options, ["sessions_d2", "gala"]);
  const refused = await w.submit({ ...who("Cy", "Plain", "CON000000002"), options: ["gala"] });
  assert.deepEqual([refused.statusCode, refused.body.invalid], [400, ["gala"]]);

  // Power with the Gala and the luncheons switched off: no longer offered, refused on save; the Awards still there.
  const pat = await w.look(who("Pat", "Nogala", "POW000000001"));
  assert.ok(!pat.allowedOptions.includes("gala") && !pat.allowedOptions.includes("lunch_d1") && !pat.allowedOptions.includes("lunch_d2"));
  assert.ok(pat.allowedOptions.includes("awards"));
  const patNo = await w.submit({ ...who("Pat", "Nogala", "POW000000001"), options: ["gala", "lunch_d2", "awards"] });
  assert.deepEqual([patNo.statusCode, patNo.body.invalid], [400, ["gala", "lunch_d2"]]);
  // Influence + the Awards Night and the CxO Breakfasts: offered on top of the luncheons, never the Gala.
  const ike = await w.look(who("Ike", "Awards", "INF000000001"));
  assert.ok(["awards", "cxo_d1", "cxo_d2", "lunch_d1", "lunch_d2"].every((k) => ike.allowedOptions.includes(k)));
  assert.ok(!ike.allowedOptions.includes("gala"));
  assert.equal(ike.cxoBreakfast, true);
  assert.equal((await w.submit({ ...who("Ike", "Awards", "INF000000001"), options: ["awards", "cxo_d1"] })).statusCode, 201);
  // Apex without the luncheons: everything else of Apex.
  const ada = await w.look(who("Ada", "Nolunch", "APX000000001"));
  assert.ok(!ada.allowedOptions.includes("lunch_d1") && ["cxo_d1", "gala", "awards", "meetings", "lounge"].every((k) => ada.allowedOptions.includes(k)));
});

test("RSVP: switching an extra to No never removes or changes what the attendee already chose", async () => {
  const w = rsvpWorld();
  // Kim RSVP'd for the Gala and the Awards Night before staff switched both off on her Power Pass.
  w.rows.push({ _id: "old", key: "t:pow000000002", nameKey: "kim kept", firstName: "Kim", lastName: "Kept", ticketId: "POW000000002", ticketVerified: true,
    tier: "power", tierVerified: true, kind: "ticket", source: "attendee", days: ["day1", "day2"], options: ["lunch_d1", "awards", "gala"], submissions: 1 });
  const before = JSON.stringify(w.rows);
  const kim = await w.look(who("Kim", "Kept", "POW000000002"));
  assert.equal(JSON.stringify(w.rows), before);          // looking never changes an RSVP
  assert.ok(kim.allowedOptions.includes("gala") && kim.allowedOptions.includes("awards")); // still offered to her
  assert.deepEqual(kim.keepOptions, ["awards", "gala"]);   // kept from her RSVP, beyond what the pass offers now
  // Sending it again keeps them.
  const again = await w.submit({ ...who("Kim", "Kept", "POW000000002"), options: ["lunch_d1", "awards", "gala"] });
  assert.equal(again.statusCode, 201);
  assert.deepEqual(w.rows[0].options, ["lunch_d1", "awards", "gala"]);
  // The rule underneath: every extra on a row is kept, in display order.
  assert.deepEqual(extraOptionsFor([{ options: ["gala", "lunch_d2", "sessions_d1"] }, { options: ["cxo_d1"] }]), ["cxo_d1", "lunch_d2", "gala"]);
  assert.ok(checkOptions("power", DAY_KEYS, ["gala"], { extras: { ...ALL, gala: false }, extra: ["gala"] }).ok);
  assert.equal(checkOptions("power", DAY_KEYS, ["gala"], { extras: { ...ALL, gala: false } }).ok, false);
  assert.deepEqual(Object.values(EXTRA_OPTIONS).flat().sort(), ["awards", "cxo_d1", "cxo_d2", "gala", "lunch_d1", "lunch_d2"]);
});

test("staff can still add to an attendee's RSVP: inside the pass when the extra is Yes, a staff override when it's No", () => {
  const staff = { id: "s1", name: "Nicole Staff" };
  const person = { name: "Cara Gala", firstName: "Cara", lastName: "Gala", pass: { ticketId: "CON000000001", type: "connect" } };
  const theirs = { _id: "r", source: "attendee", tier: "connect", tierVerified: true, days: ["day1", "day2"], options: ["sessions_d1"] };
  const yes = planStaffRsvp({ existing: theirs, person: { ...person, extras: { ...NONE, gala: true } }, body: { options: ["sessions_d1", "gala"] }, staff });
  assert.deepEqual([yes.set.options, yes.set.staffAdded, yes.set.passLimitOverride, yes.warning], [["sessions_d1", "gala"], ["gala"], false, ""]);
  const no = planStaffRsvp({ existing: theirs, person: { ...person, extras: NONE }, body: { options: ["sessions_d1", "gala"] }, staff });
  assert.equal(no.code, "outside_pass");
  const anyway = planStaffRsvp({ existing: theirs, person: { ...person, extras: NONE }, body: { options: ["sessions_d1", "gala"], allowOutsidePass: true }, staff });
  assert.deepEqual([anyway.set.staffAdded, anyway.set.passLimitOverride], [["gala"], true]);
  // Their own choice stays even with the extra off.
  const kept = { ...theirs, tier: "power", options: ["gala"] };
  assert.equal(planStaffRsvp({ existing: kept, person: { ...person, extras: { ...ALL, gala: false }, extra: ["gala"] }, body: { options: [] }, staff }).code, "attendee_rsvp");
  // A new staff RSVP for a Power Pass without the luncheons.
  const fresh = planStaffRsvp({ person: { ...person, pass: { ticketId: "P", type: "power" }, extras: { cxo: false, lunch: false, gala: true, awards: true } }, body: { days: ["day1"], options: ["lunch_d1"] }, staff });
  assert.equal(fresh.code, "outside_pass");
});

/* ---------- 3. The ticket: emails, PDF, the apps ---------- */

test("ticket inclusions: each extra Yes adds its line in the pass's order, No takes it out", () => {
  assert.deepEqual(inclusionsFor("connect", { extras: { gala: true } }),
    ["2x Day Conference Access", "1x Gala Dinner & Networking Reception", "Expo Floor Access", "Networking Breaks"]);
  assert.deepEqual(inclusionsFor("connect", { extras: ALL }),
    ["2x Day Conference Access", "2x CxO Breakfasts", "2x Luncheons", "1x Gala Dinner & Networking Reception", "1x Awards Night", "Expo Floor Access", "Networking Breaks"]);
  assert.deepEqual(inclusionsFor("influence", { extras: { awards: true } }),
    ["2x Day Conference Access", "2x Luncheons", "1x Awards Night", "Expo Floor Access", "Networking Breaks"]);
  assert.deepEqual(inclusionsFor("power", { extras: { lunch: false, gala: false, awards: false } }), PASS_INCLUSIONS.connect);
  assert.deepEqual(inclusionsFor("apex", { extras: { lunch: false } }).filter((f) => /Lunch/.test(f)), []);
  // Automatic (nothing set) is the pass's own list, exactly as before.
  for (const t of ["connect", "influence", "power", "apex", "speaker"]) assert.deepEqual(inclusionsFor(t, { extras: autoExtras(t) }), PASS_INCLUSIONS[t]);
});

test("purchase email (its default list) and PDF list the extras switched on, never the ones switched off", async () => {
  const connectGala = { name: "Cara Gala", ticketId: "abc123def456", tier: "connect", extras: { ...NONE, gala: true } };
  const e = buildTicketEmail(connectGala);
  assert.match(e.html, /1x Gala Dinner &amp; Networking Reception/);
  assert.match(e.text, /1x Gala Dinner & Networking Reception/);
  assert.deepEqual(purchaseEmailDefaults({ tier: "connect", extras: { gala: true } }).includes, inclusionsFor("connect", { extras: { gala: true } }));
  const powerNoGala = buildTicketEmail({ name: "Pat Nogala", ticketId: "abc123def457", tier: "power", extras: { ...autoExtras("power"), gala: false } });
  assert.doesNotMatch(`${powerNoGala.html}${powerNoGala.text}`, /Gala Dinner/);
  assert.match(powerNoGala.text, /1x Awards Night/);
  // Staff's own list for Power (Purchase email template): the Gala row comes off this pass, the CxO row goes on another's.
  const template = { tiers: { power: { includes: ["2x Day Conference Access", "Our Gala dinner on Day 2", "2x Luncheons", "Awards Night (Day 1)"] } } };
  const t1 = buildTicketEmail({ name: "Pat Nogala", ticketId: "abc123def458", tier: "power", extras: { ...autoExtras("power"), gala: false }, template });
  assert.doesNotMatch(t1.text, /Gala/);
  assert.match(t1.text, /Awards Night \(Day 1\)/);
  const t2 = buildTicketEmail({ name: "Oscar Cxo", ticketId: "abc123def459", tier: "power", extras: { ...autoExtras("power"), cxo: true }, template });
  assert.match(t2.text, /2x CxO Breakfasts/);
  assert.match(t2.text, /Our Gala dinner on Day 2/);

  // The PDF: what it writes on the page (pdfkit's text calls), for a Connect Pass with the Gala and a Power Pass without.
  const pdfText = async (ticket) => {
    const seen = [];
    const original = PDFDocument.prototype.text;
    PDFDocument.prototype.text = function (str, ...rest) { seen.push(String(str)); return original.call(this, str, ...rest); };
    try { await generateTicketPDF(ticket); } finally { PDFDocument.prototype.text = original; }
    return seen;
  };
  const pdfGala = await pdfText(connectGala);
  assert.ok(pdfGala.includes("1x Gala Dinner & Networking Reception"));
  assert.ok(!pdfGala.includes("1x Awards Night"));
  const pdfNoGala = await pdfText({ name: "Pat Nogala", ticketId: "abc123def457", tier: "power", extras: { ...autoExtras("power"), gala: false } });
  assert.ok(!pdfNoGala.some((s) => /Gala Dinner/.test(s)));
  assert.ok(pdfNoGala.includes("1x Awards Night") && pdfNoGala.includes("2x Luncheons"));
});

test("issued, exhibitor and speaker pass emails: the default list has the extras switched on, never the ones off", () => {
  const heads = (rows) => rows.map((r) => r[0]);
  // Issued Connect Pass with the Gala and the Awards Night.
  const v = validateIssuedPass({ name: "Cara Gala", email: "cara@example.com", tier: "connect", extras: { gala: true, awards: true } });
  assert.ok(v.ok);
  assert.deepEqual([v.value.galaDinner, v.value.awardsNight], [true, true]);
  const doc = issuedPassDoc(v.value, { ticketId: "ISS000000001" });
  assert.deepEqual([doc.galaDinner, doc.awardsNight, "luncheons" in doc], [true, true, false]);
  const variant = issuedVariant(doc);
  assert.deepEqual(heads(variant.includes).slice(0, 2), ["1× Gala Dinner & Networking Reception", "1× Catalyst Awards Night"]);
  assert.equal(variant.rsvpReason, "RSVP for the Gala Dinner and the Catalyst Awards Night, so we can save your seat and plan catering.");
  const email = buildPassEmail({ name: "Cara Gala", ticketId: "ISS000000001", variant: passVariant(doc) });
  assert.match(email.text, /1× Gala Dinner & Networking Reception/);
  assert.match(email.text, /1× Catalyst Awards Night/);
  // Power with the luncheons off.
  const off = issuedVariant({ ticketType: "power", luncheons: false });
  assert.ok(!heads(off.includes).some((h) => /Lunch/.test(h)));
  assert.equal(off.rsvpReason, "RSVP for the Gala Dinner and the Catalyst Awards Night, so we can save your seat and plan catering.");
  // Exhibitor pass (a Connect Pass) with a luncheon added by staff.
  const ex = passVariant({ ticketType: "connect", promoCode: "EXHIBITOR", luncheons: true, issuedPass: { booth: { booth: "07" } } }, { copyFor: exhibitorCopyFor(null) });
  assert.ok(heads(ex.includes).includes("2× Luncheons"));
  // The Edit email template's own Connect list keeps following this pass's extras.
  const tpl = { tiers: { connect: { includes: [["Two days of the conference", "Both days"], ["The expo", ""]] } } };
  const exT = passVariant({ ticketType: "connect", galaDinner: true }, { template: tpl });
  assert.deepEqual(heads(exT.includes), ["1× Gala Dinner & Networking Reception", "Two days of the conference", "The expo"]);
  const powT = passVariant({ ticketType: "power", galaDinner: false }, { template: { tiers: { power: { includes: [["The Gala, Day 2", ""], ["Lunch both days", ""]] } } } });
  assert.deepEqual(heads(powT.includes), ["Lunch both days"]);
  // Edits: each extra set, null back to automatic.
  assert.deepEqual(issuedPassUpdate(validateIssuedPass({ extras: { gala: null, lunch: false } }, { partial: true }).value, doc), { galaDinner: null, luncheons: false });
  const row = issuedPassRow({ ...doc, _id: "x" });
  assert.deepEqual(row.extras.gala, { override: true, auto: false, included: true });
  assert.deepEqual(row.extras.lunch, { override: null, auto: false, included: false });
  assert.equal(validateIssuedPass({ name: "A B", email: "a@example.com", tier: "power", extras: { gala: "maybe" } }).ok, false);

  // Speaker Pass: all four on; a No takes that one off the speakers' email.
  assert.deepEqual(speakerVariant().includes, SPEAKER_INCLUDES);
  assert.equal(speakerVariant().rsvpReason, RSVP_REASON);
  const noGala = speakerVariant({ gala: false });
  assert.ok(!heads(noGala.includes).some((h) => /Gala/.test(h)));
  assert.equal(noGala.rsvpReason, "RSVP for the CxO breakfasts, luncheons and the Catalyst Awards Night, so we can save your seat and plan catering.");
  const pass = speakerPassRow({ _id: "s1", name: "Kai Speaker", ticketId: "spk000000001", ticketType: "speaker", galaDinner: false });
  assert.deepEqual(pass.extras, { gala: false });
  const se = buildPassEmail({ name: "Kai Speaker", ticketId: "spk000000001", extras: pass.extras });
  assert.doesNotMatch(se.text, /Gala Dinner/);
  assert.match(se.text, /Catalyst Awards Night/);
  assert.deepEqual(speakerPassRow({ _id: "s2", name: "Lee", ticketId: "t" }).extras, undefined); // nothing set: nothing extra on the row
});

test("the built-in RSVP reasons are what rsvpReasonFor says for each pass's own extras", () => {
  const T = ISSUE_TIERS;
  assert.equal(rsvpReasonFor("connect", NONE), T.connect.rsvpReason);
  assert.equal(rsvpReasonFor("connect", { ...NONE, cxo: true }), T.connect.rsvpReasonCxo);
  assert.equal(rsvpReasonFor("influence", autoExtras("influence")), T.influence.rsvpReason);
  assert.equal(rsvpReasonFor("influence", { ...autoExtras("influence"), cxo: true }), T.influence.rsvpReasonCxo);
  assert.equal(rsvpReasonFor("power", autoExtras("power")), T.power.rsvpReason);
  assert.equal(rsvpReasonFor("power", { ...autoExtras("power"), cxo: true }), T.power.rsvpReasonCxo);
  assert.equal(rsvpReasonFor("apex", ALL), T.apex.rsvpReason);
  assert.equal(rsvpReasonFor("apex", { ...ALL, cxo: false }), T.apex.rsvpReasonNoCxo);
  assert.equal(rsvpReasonFor("speaker", ALL), T.speaker.rsvpReason);
  assert.equal(rsvpReasonFor("speaker", { ...ALL, cxo: false }), T.speaker.rsvpReasonNoCxo);
  assert.deepEqual(includesWithExtras(T.power.includes, autoExtras("power")), T.power.includes);
});

test("the apps' contract: /auth/me tickets keep cxoBreakfast and add inclusions in the website's wording", () => {
  const tickets = [
    { ticketId: "c1", type: "connect", galaDinner: true },                     // staff: Gala Yes (account ticket)
    { ticketId: "p1", type: "power" },                                         // switched off on its pass row
    { ticketId: "a1", type: "apex", manualValue: 900 },
    { ticketId: "BOOTH-GOLD", type: "booth-gold" },
  ];
  const out = ticketsWithExtras(tickets, { types: ["attendee"], attendees: [{ ticketId: "P1", luncheons: false, awardsNight: false }] });
  assert.deepEqual(out.map((t) => t.cxoBreakfast), [false, false, true, false]);
  assert.deepEqual(out[0].inclusions, ["2× Day Conference Access", "1× Gala Dinner & Networking Reception", "Expo Floor Access", "Networking Breaks"]);
  assert.deepEqual(out[1].inclusions, ["2× Day Conference Access", "1× Gala Dinner & Networking Reception", "Expo Floor Access", "Networking Breaks"]);
  assert.ok(out[2].inclusions.includes("2× CxO Breakfasts") && out[2].inclusions.includes("2× Luncheons") && out[2].inclusions.includes("1× Awards Night"));
  assert.deepEqual(out[3].inclusions, []);
  // Staff's switches and the manual value stay out of the app.
  for (const t of out) for (const f of ["galaDinner", "luncheons", "awardsNight", "manualValue"]) assert.equal(f in t, false, f);
  assert.equal(timesWording("2x Luncheons"), "2× Luncheons");
  assert.equal(timesWording("Expo Floor Access"), "Expo Floor Access");
});

/* ---------- 4. Admin → People ---------- */

test("Admin → People: extras per pass (automatic, Yes, No), the row's badge data, counts, eligibility and the CSV", () => {
  const users = [
    { _id: "u1", name: "Cara Gala", email: "cara@example.com", role: "user", tickets: [{ ticketId: "CON1", type: "connect", galaDinner: true }] },
    { _id: "u2", name: "Pat Power", email: "pat@example.com", role: "user", tickets: [{ ticketId: "POW1", type: "power" }] },
  ];
  const attendees = [
    { _id: "a1", name: "Ina Nolunch", email: "ina@example.com", ticketId: "INF1", ticketType: "influence", luncheons: false, awardsNight: true },
    { _id: "a2", name: "Hid Den", email: "hid@example.com", ticketId: "APX9", ticketType: "apex", hiddenByStaff: true },
  ];
  const { people } = buildPeople({ users, attendees });
  const by = (n) => people.find((p) => p.name === n);
  const cara = personDetail(by("Cara Gala"));
  assert.deepEqual(cara.passes[0].extras.gala, { override: true, auto: false, included: true });
  assert.deepEqual(cara.passes[0].extras.awards, { override: null, auto: false, included: false });
  assert.equal(cara.edit.canEditExtras, true);
  assert.deepEqual(cara.rsvpRules.extras, { cxo: false, lunch: false, gala: true, awards: false });
  assert.deepEqual(rsvpRulesFor(by("Ina Nolunch")).extras, { cxo: false, lunch: false, gala: false, awards: true });
  assert.equal(personRow(by("Pat Power")).pass.extras.lunch.included, true);
  assert.deepEqual(peopleCounts(people).extras, { cxo: 0, lunch: 1, gala: 2, awards: 2 });
  const el = eligibleCounts(people);
  assert.deepEqual(el.byExtra, { cxo: 0, lunch: 1, gala: 2, awards: 2 }); // the hidden Apex pass isn't counted
  assert.deepEqual(el.byOption, { cxo_d1: 0, lunch_d1: 1, awards: 2, cxo_d2: 0, lunch_d2: 1, gala: 2 });
  assert.equal(el.passes, 3);
  const head = PEOPLE_CSV_HEAD;
  const lines = peopleCsv(people).replace(/^﻿/, "").split("\n").slice(1);
  const cells = (n) => { const l = lines.find((x) => x.startsWith(n)).split(","); return ["CxO Breakfast", "Networking Luncheons", "Gala Dinner & Networking Reception", "Catalyst Awards Night", "Extras set by staff"].map((h) => l[head.indexOf(h)]); };
  assert.deepEqual(cells("Cara Gala"), ["No", "No", "Yes", "No", "Gala Dinner & Networking Reception: Yes"]);
  assert.deepEqual(cells("Pat Power"), ["No", "Yes", "Yes", "Yes", ""]);
  assert.deepEqual(cells("Ina Nolunch"), ["No", "No", "No", "Yes", "Networking Luncheons: No; Catalyst Awards Night: Yes"]);
});
