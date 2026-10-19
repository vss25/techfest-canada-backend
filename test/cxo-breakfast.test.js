import test from "node:test";
import assert from "node:assert/strict";
import { autoCxo, effectiveCxo, cxoOverride, cleanCxoSwitch, cxoLabel, ticketsWithCxo } from "../services/cxoBreakfast.js";
import { inclusionsFor, PASS_INCLUSIONS, CXO_INCLUSION } from "../services/ticketInfo.js";
import { buildTicketEmail } from "../services/ticketEmail.js";
import { ISSUE_TIERS, issuedVariant, validateIssuedPass, issuedPassDoc, issuedPassUpdate, issuedPassRow, includesWithCxo } from "../services/issuedPasses.js";
import { buildSpeakerPassEmail } from "../services/speakerPassEmail.js";
import { checkOptions, allowedExperiences, extraOptionsFor, rsvpOptionsPayload, DAY_KEYS, CXO_KEYS } from "../services/rsvp.js";
import { makeLookup, makeRsvpHandlers, publicLookup } from "../services/rsvpHandler.js";
import { planStaffRsvp } from "../services/rsvpStaff.js";
import { buildPeople, personDetail, personRow, peopleCsv, PEOPLE_CSV_HEAD } from "../services/people.js";
import { makeGuessLimiter } from "../services/ticketAccess.js";

/* CxO Breakfasts (Oct 19 2026): Apex and Speaker Passes, speakers on any pass, and passes staff
   switch on ("CxO Breakfast included"). Power no longer. A breakfast already on an RSVP stays. */

test("the rule: Apex and Speaker Passes, a speaker on any pass; staff's switch wins either way", () => {
  assert.deepEqual(["connect", "influence", "power", "apex", "speaker", "vip", "TTFC Apex Pass"].map((t) => autoCxo(t)), [false, false, false, true, true, true, true]);
  assert.equal(autoCxo("influence", ["speaker"]), true);
  assert.equal(autoCxo("power", ["attendee", "exhibitor"]), false);
  assert.equal(autoCxo("booth-gold", ["speaker"]), false);
  assert.equal(effectiveCxo({ ticketType: "power", override: true }), true);
  assert.equal(effectiveCxo({ ticketType: "apex", override: false }), false);
  assert.equal(effectiveCxo({ ticketType: "apex" }), true);
  assert.equal(cxoOverride({ cxoBreakfast: true }, { cxoBreakfast: false }), true); // the account's ticket first
  assert.equal(cxoOverride({}, { cxoBreakfast: false }), false);
  assert.equal(cxoOverride({}, null), undefined);
  assert.deepEqual([true, false, null, "auto", "yes", undefined].map(cleanCxoSwitch), [true, false, null, null, undefined, undefined]);
  assert.deepEqual([cxoLabel(true, true), cxoLabel(undefined, false)], ["Yes", "automatic (No)"]);
});

test("ticket inclusions per ticket: Power without, Power switched on, Apex switched off", () => {
  assert.equal(PASS_INCLUSIONS.power.includes(CXO_INCLUSION), false);
  assert.equal(PASS_INCLUSIONS.apex.includes(CXO_INCLUSION), true);
  // No "speaker" pass any more (Oct 19 2026): an old speaker ticket is a Power Pass, the breakfasts come per ticket.
  assert.equal(PASS_INCLUSIONS.speaker, undefined);
  assert.deepEqual(inclusionsFor("speaker", { cxoBreakfast: true }), inclusionsFor("power", { cxoBreakfast: true }));
  assert.deepEqual(inclusionsFor("power"), PASS_INCLUSIONS.power);
  const on = inclusionsFor("power", { cxoBreakfast: true });
  assert.deepEqual(on.slice(0, 3), ["2x Day Conference Access", CXO_INCLUSION, "2x Luncheons"]);
  assert.equal(inclusionsFor("apex", { cxoBreakfast: false }).includes(CXO_INCLUSION), false);
  assert.deepEqual(inclusionsFor("apex", { cxoBreakfast: true }), PASS_INCLUSIONS.apex);
  // The purchase email (and PDF) list them for that ticket.
  assert.match(buildTicketEmail({ name: "Ada Test", ticketId: "abc123", tier: "power", cxoBreakfast: true }).html, /2x CxO Breakfasts/);
  assert.doesNotMatch(buildTicketEmail({ name: "Ada Test", ticketId: "abc123", tier: "power" }).html, /CxO Breakfast/);
  assert.doesNotMatch(buildTicketEmail({ name: "Ada Test", ticketId: "abc123", tier: "apex", cxoBreakfast: false }).text, /CxO Breakfast/);
});

test("the apps' contract: every ticket on /api/auth/me carries cxoBreakfast true|false (the effective value)", () => {
  const tickets = [
    { ticketId: "P1", type: "power" },
    { ticketId: "P2", type: "power", cxoBreakfast: true },        // staff switched it on (account ticket)
    { ticketId: "A1", type: "apex" },
    { ticketId: "A2", type: "apex" },                             // switched off on its Attendee row
    { ticketId: "BOOTH-GOLD", type: "booth-gold" },
  ];
  const out = ticketsWithCxo(tickets, { types: ["attendee"], attendees: [{ ticketId: "a2", cxoBreakfast: false }] });
  assert.deepEqual(out.map((t) => [t.ticketId, t.cxoBreakfast]), [["P1", false], ["P2", true], ["A1", true], ["A2", false], ["BOOTH-GOLD", false]]);
  // A speaker-type person on Influence gets them.
  assert.equal(ticketsWithCxo([{ ticketId: "I1", type: "influence" }], { types: ["speaker"] })[0].cxoBreakfast, true);
  for (const t of out) assert.equal(typeof t.cxoBreakfast, "boolean");
});

test("issued passes: a Power pass issued with the CxO Breakfast on lists it and asks to RSVP for it", () => {
  assert.equal(ISSUE_TIERS.power.includes.some((r) => /CxO/.test(r[0])), false);
  assert.equal(ISSUE_TIERS.apex.includes.some((r) => /CxO/.test(r[0])), true);
  assert.doesNotMatch(ISSUE_TIERS.power.rsvpReason, /breakfast/i);
  const v = validateIssuedPass({ name: "Pat Power", email: "pat@example.com", tier: "power", cxoBreakfast: true });
  assert.equal(v.value.cxoBreakfast, true);
  assert.equal(validateIssuedPass({ name: "Pat Power", email: "pat@example.com", tier: "power", cxoBreakfast: "maybe" }).ok, false);
  assert.equal(validateIssuedPass({ cxoBreakfast: null }, { partial: true }).value.cxoBreakfast, null);
  const doc = issuedPassDoc(v.value, { ticketId: "ISS001" });
  assert.equal(doc.cxoBreakfast, true);
  assert.equal("cxoBreakfast" in issuedPassDoc({ ...v.value, cxoBreakfast: null }, { ticketId: "ISS002" }), false); // automatic: nothing stored
  const variant = issuedVariant(doc);
  assert.deepEqual(variant.includes[0], ["2× CxO Breakfasts", "Senior-leader breakfasts, both mornings"]);
  assert.match(variant.rsvpReason, /CxO breakfasts/);
  const email = buildSpeakerPassEmail({ name: doc.name, ticketId: doc.ticketId, variant });
  assert.match(email.html, /2× CxO Breakfasts/);
  assert.match(email.html, /Senior-leader breakfasts, both mornings/);
  assert.match(email.text, /RSVP for the CxO breakfasts/);
  // Automatic Power: no breakfast in the email.
  const plain = issuedVariant({ ...doc, cxoBreakfast: undefined });
  assert.equal(plain.includes.some((r) => /CxO/.test(r[0])), false);
  assert.doesNotMatch(buildSpeakerPassEmail({ name: doc.name, ticketId: doc.ticketId, variant: plain }).html, /CxO Breakfast/);
  // Apex switched off: no breakfast, its own reason.
  const apexOff = issuedVariant({ ticketType: "apex", cxoBreakfast: false });
  assert.equal(apexOff.includes.some((r) => /CxO/.test(r[0])), false);
  assert.doesNotMatch(apexOff.rsvpReason, /breakfast/i);
  assert.equal(issuedVariant({ ticketType: "apex" }).rsvpReason, ISSUE_TIERS.apex.rsvpReason);
  // The admin row shows the switch and what the pass gets; an edit back to automatic is a null.
  assert.deepEqual([issuedPassRow(doc).cxoBreakfast, issuedPassRow(doc).cxoEffective], [true, true]);
  assert.deepEqual([issuedPassRow({ ...doc, cxoBreakfast: undefined }).cxoBreakfast, issuedPassRow({ ...doc, cxoBreakfast: undefined }).cxoEffective], [null, false]);
  assert.deepEqual(issuedPassUpdate({ cxoBreakfast: null }, doc), { cxoBreakfast: null });
  assert.deepEqual(includesWithCxo(ISSUE_TIERS.apex.includes, true), ISSUE_TIERS.apex.includes); // same order as before
});

/* ---------- The RSVP page and its save ---------- */

const TICKETS = {
  pow000000001: { ticketId: "POW000000001", type: "power", last: "power", names: ["Pam Power"] },
  pow000000002: { ticketId: "POW000000002", type: "power", last: "override", names: ["Oscar Override"], cxoOverride: true },
  apx000000001: { ticketId: "APX000000001", type: "apex", last: "apex", names: ["Ann Apex"] },
  apx000000002: { ticketId: "APX000000002", type: "apex", last: "off", names: ["Abe Off"], cxoOverride: false },
  inf000000001: { ticketId: "INF000000001", type: "influence", last: "speaker", names: ["Sue Speaker"], types: ["speaker"] },
  pow000000003: { ticketId: "POW000000003", type: "power", last: "early", names: ["Ed Early"] },
};
function rsvpWorld() {
  const rows = [];
  let n = 0;
  const live = (r) => !r.spam && !r.mergedInto;
  const store = {
    rows,
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
      return t && t.last === last.toLowerCase() ? { ticketId: t.ticketId, type: t.type, names: t.names, types: t.types || [], cxoOverride: t.cxoOverride } : null;
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

test("RSVP page: the lookup's allowedOptions: speaker on Influence, Power switched on, Power without, Apex, Apex switched off", async () => {
  const w = rsvpWorld();
  const allowed = async (f, l, t) => (await w.look(who(f, l, t))).allowedOptions || [];
  const hasCxo = (list) => CXO_KEYS.every((k) => list.includes(k));
  const noCxo = (list) => CXO_KEYS.every((k) => !list.includes(k));
  const speaker = await allowed("Sue", "Speaker", "INF000000001");
  assert.ok(hasCxo(speaker) && speaker.includes("lunch_d1") && !speaker.includes("gala"));   // breakfasts only, on top of Influence
  assert.ok(hasCxo(await allowed("Oscar", "Override", "POW000000002")));
  const power = await allowed("Pam", "Power", "POW000000001");
  assert.ok(noCxo(power) && power.includes("gala"));
  assert.ok(hasCxo(await allowed("Ann", "Apex", "APX000000001")));
  assert.ok(noCxo(await allowed("Abe", "Off", "APX000000002")));
  // The lookup and the save use the same rule.
  assert.deepEqual(await allowed("Pam", "Power", "POW000000001"), allowedExperiences("power", DAY_KEYS, { cxo: false }));
  // Saves: the same people, the same answer.
  assert.equal((await w.submit({ ...who("Sue", "Speaker", "INF000000001"), options: ["cxo_d1", "lunch_d2"] })).statusCode, 201);
  assert.equal((await w.submit({ ...who("Oscar", "Override", "POW000000002"), options: ["cxo_d2"] })).statusCode, 201);
  const refused = await w.submit({ ...who("Pam", "Power", "POW000000001"), options: ["cxo_d1"] });
  assert.deepEqual([refused.statusCode, refused.body.invalid], [400, ["cxo_d1"]]);
  assert.equal((await w.submit({ ...who("Ann", "Apex", "APX000000001"), options: ["cxo_d1", "lounge"] })).statusCode, 201);
  const off = await w.submit({ ...who("Abe", "Off", "APX000000002"), options: ["cxo_d1"] });
  assert.deepEqual([off.statusCode, off.body.invalid], [400, ["cxo_d1"]]);
  assert.deepEqual(w.rows.map((r) => r.options), [["cxo_d1", "lunch_d2"], ["cxo_d2"], ["cxo_d1", "lounge"]]);
});

test("a breakfast already on an attendee's RSVP is kept and still offered; the RSVP itself is never changed", async () => {
  const w = rsvpWorld();
  // Ed RSVP'd (with a breakfast) while Power still included it: his row as it was saved.
  w.rows.push({ _id: "old", key: "t:pow000000003", nameKey: "ed early", firstName: "Ed", lastName: "Early", ticketId: "POW000000003", ticketVerified: true,
    tier: "power", tierVerified: true, kind: "ticket", source: "attendee", days: ["day1", "day2"], options: ["cxo_d1", "lunch_d1", "gala"], submissions: 1 });
  const before = JSON.stringify(w.rows);
  const answer = await w.look(who("Ed", "Early", "POW000000003"));
  assert.deepEqual(answer.keepOptions, ["cxo_d1"]);
  assert.ok(answer.allowedOptions.includes("cxo_d1"));
  assert.ok(!answer.allowedOptions.includes("cxo_d2")); // only the one he had
  assert.equal(JSON.stringify(w.rows), before); // looking never changes an RSVP
  // Re-opening and sending again keeps it.
  const again = await w.submit({ ...who("Ed", "Early", "POW000000003"), options: ["cxo_d1", "gala"] });
  assert.equal(again.statusCode, 201);
  assert.deepEqual(w.rows[0].options, ["cxo_d1", "gala"]);
  // The other breakfast was never his.
  assert.equal((await w.submit({ ...who("Ed", "Early", "POW000000003"), options: ["cxo_d2"] })).statusCode, 400);
  // Someone who never RSVP'd with a Power Pass doesn't see it (an RSVP link sent but never opened).
  assert.ok(!(await w.look(who("Pam", "Power", "POW000000001"))).allowedOptions.includes("cxo_d1"));
  assert.deepEqual(extraOptionsFor([{ options: ["cxo_d2", "gala"] }, { options: ["cxo_d1"] }]), ["cxo_d1", "cxo_d2"]);
  // The public options list says Apex (speakers get them on any pass, by the lookup's cxoBreakfast).
  const cxo = rsvpOptionsPayload().options.find((o) => o.key === "cxo_d1");
  assert.deepEqual(cxo.tiers, ["apex"]);
  assert.deepEqual(publicLookup({ kind: "none", verified: false }), { kind: "none", verified: false });
});

test("staff RSVPs follow the pass's switch; staff can add a breakfast to an attendee's RSVP on purpose, never remove theirs", () => {
  const staff = { id: "s1", name: "Nicole Staff" };
  const person = { name: "Pam Power", firstName: "Pam", lastName: "Power", pass: { ticketId: "POW000000001", type: "power" } };
  assert.equal(planStaffRsvp({ person: { ...person, cxo: false }, body: { days: ["day1"], options: ["cxo_d1"] }, staff }).code, "outside_pass");
  assert.equal(planStaffRsvp({ person: { ...person, cxo: true }, body: { days: ["day1"], options: ["cxo_d1"] }, staff }).create, true);
  assert.equal(planStaffRsvp({ person: { ...person, pass: { ticketId: "A", type: "apex" }, cxo: false }, body: { days: ["day1"], options: ["cxo_d1"] }, staff }).code, "outside_pass");
  const theirs = { _id: "r", source: "attendee", tier: "power", tierVerified: true, days: ["day1"], options: ["cxo_d1"] };
  // Their breakfast from before the change: it stays, even with the switch off.
  const keep = planStaffRsvp({ existing: theirs, person: { ...person, cxo: false, extra: ["cxo_d1"] }, body: { options: ["cxo_d1", "awards"] }, staff });
  assert.deepEqual([keep.set.options, keep.set.staffAdded], [["cxo_d1", "awards"], ["awards"]]);
  assert.equal(planStaffRsvp({ existing: theirs, person, body: { options: [] }, staff }).code, "attendee_rsvp");
  assert.ok(checkOptions("power", ["day1"], ["cxo_d1"], { extra: ["cxo_d1"] }).ok);
});

test("Admin → People: CxO Breakfast per pass (automatic or staff's switch), in the profile and the CSV", () => {
  const users = [
    { _id: "u1", name: "Pam Power", email: "pam@example.com", role: "user", tickets: [{ ticketId: "POW1", type: "power" }] },
    { _id: "u2", name: "Oscar Override", email: "oscar@example.com", role: "user", tickets: [{ ticketId: "POW2", type: "power", cxoBreakfast: true }] },
    { _id: "u3", name: "Sue Speaker", email: "sue@example.com", role: "user", types: ["speaker"], tickets: [{ ticketId: "INF1", type: "influence" }] },
  ];
  const attendees = [
    { _id: "a1", name: "Abe Off", email: "abe@example.com", ticketId: "APX2", ticketType: "apex", cxoBreakfast: false },
    { _id: "a2", name: "Ann Apex", email: "ann@example.com", ticketId: "APX1", ticketType: "apex" },
    // A guest record of Pam's account ticket switched on: the account ticket has no switch, so this one applies.
    { _id: "a3", name: "Pia Guest", email: "pia@example.com", ticketId: "POW3", ticketType: "power", cxoBreakfast: true, claimedBy: "u4" },
  ];
  users.push({ _id: "u4", name: "Pia Guest", email: "pia@example.com", role: "user", tickets: [{ ticketId: "POW3", type: "power" }] });
  const { people } = buildPeople({ users, attendees });
  const cxo = (n) => { const p = people.find((x) => x.name === n); return [p.primary.cxo, p.primary.cxoAuto, p.primary.cxoOverride]; };
  assert.deepEqual(cxo("Pam Power"), [false, false, undefined]);
  assert.deepEqual(cxo("Oscar Override"), [true, false, true]);
  assert.deepEqual(cxo("Sue Speaker"), [true, true, undefined]);
  assert.deepEqual(cxo("Abe Off"), [false, true, false]);
  assert.deepEqual(cxo("Ann Apex"), [true, true, undefined]);
  assert.deepEqual(cxo("Pia Guest"), [true, false, true]);
  const det = personDetail(people.find((x) => x.name === "Oscar Override"));
  assert.deepEqual([det.passes[0].cxoBreakfast, det.passes[0].cxoOverride, det.passes[0].cxoAuto, det.edit.canEditCxo], [true, true, false, true]);
  assert.deepEqual(det.rsvpRules, { cxo: true, keep: [] });
  assert.equal(personRow(people.find((x) => x.name === "Abe Off")).cxoBreakfast, false);
  const i = PEOPLE_CSV_HEAD.indexOf("CxO Breakfast");
  const lines = peopleCsv(people).replace(/^﻿/, "").split("\n").slice(1);
  const cell = (n) => lines.find((l) => l.startsWith(n)).split(",")[i];
  assert.deepEqual(["Pam Power", "Oscar Override", "Sue Speaker", "Abe Off"].map(cell), ["No", "Yes", "Yes", "No"]);
});
