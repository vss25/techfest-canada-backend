import test from "node:test";
import assert from "node:assert/strict";
import { planStaffRsvp, cleanStaffAnswers, rsvpStatusOf, rsvpSource, splitName } from "../services/rsvpStaff.js";
import { makeLookup, makeRsvpHandlers, resolveRsvpDuplicate } from "../services/rsvpHandler.js";
import { planRsvpMerge, rsvpRow, rsvpsCsv, CSV_HEAD, summarizeRsvps } from "../services/rsvp.js";
import { makeGuessLimiter } from "../services/ticketAccess.js";

const STAFF = { id: "s1", name: "Nicole Staff" };
const NOW = new Date("2026-10-20T15:00:00Z");
const PERSON = { name: "Jane Doe", firstName: "Jane", lastName: "Doe", email: "jane@x.com", pass: { ticketId: "ABC123DEF", type: "power" } };
const ANSWERS = { days: ["day1", "day2"], options: ["gala", "lunch_d1"], dietary: ["vegan"] };

/* ---------- planStaffRsvp ---------- */

test("staff create: keyed by the ticket like /rsvp would, pass from the ticket, marked as staff's", () => {
  const plan = planStaffRsvp({ person: PERSON, body: ANSWERS, staff: STAFF, now: NOW });
  assert.equal(plan.create, true);
  const d = plan.doc;
  assert.deepEqual([d.key, d.ticketId, d.ticketVerified, d.tier, d.tierVerified, d.kind], ["t:abc123def", "ABC123DEF", true, "power", true, "ticket"]);
  assert.deepEqual([d.firstName, d.lastName, d.nameKey, d.email], ["Jane", "Doe", "jane doe", "jane@x.com"]);
  assert.deepEqual([d.source, d.staffUpdatedBy, d.staffUpdatedById, d.staffUpdatedAt, d.submissions], ["staff", "Nicole Staff", "s1", NOW, 0]);
  assert.deepEqual(d.options, ["lunch_d1", "gala"]); // display order
  assert.equal(d.passLimitOverride, false);
  assert.equal(plan.audit.action, "rsvp_staff_create");
  assert.match(plan.audit.detail, /Jane Doe: Day 1 & Day 2; Networking Luncheon \(Day 1\), Gala/);
  // A Speaker Pass: speaker, everything a speaker gets.
  const spk = planStaffRsvp({ person: { ...PERSON, pass: { ticketId: "SPK1", type: "speaker" } }, body: { days: ["day1"], options: ["cxo_d1", "awards"] }, staff: STAFF });
  assert.deepEqual([spk.doc.kind, spk.doc.tier, spk.doc.tierVerified], ["speaker", "speaker", true]);
});

test("staff create without a pass: staff choose it, unverified, keyed by the name", () => {
  const none = { name: "Sam Guest", email: "", pass: null };
  const noTier = planStaffRsvp({ person: none, body: ANSWERS, staff: STAFF });
  assert.deepEqual([noTier.status, noTier.field], [400, "tier"]);
  const plan = planStaffRsvp({ person: none, body: { ...ANSWERS, tier: "apex" }, staff: STAFF });
  assert.deepEqual([plan.doc.key, plan.doc.tier, plan.doc.tierVerified, plan.doc.ticketVerified, plan.doc.kind], ["n:sam guest", "apex", false, false, "none"]);
  assert.deepEqual([plan.doc.firstName, plan.doc.lastName], ["Sam", "Guest"]);
  assert.equal(planStaffRsvp({ person: { name: "", pass: null }, body: { ...ANSWERS, tier: "apex" }, staff: STAFF }).status, 400);
});

test("staff edits stay inside the pass unless they say so, then it's a warning", () => {
  const out = planStaffRsvp({ person: { ...PERSON, pass: { ticketId: "C1", type: "connect" } }, body: { days: ["day2"], options: ["gala", "lounge"] }, staff: STAFF });
  assert.deepEqual([out.status, out.code, out.field], [400, "outside_pass", "options"]);
  assert.deepEqual(out.invalid, ["gala", "lounge"]);
  const ok = planStaffRsvp({ person: { ...PERSON, pass: { ticketId: "C1", type: "connect" } }, body: { days: ["day2"], options: ["gala", "lounge"], allowOutsidePass: true }, staff: STAFF });
  assert.equal(ok.create, true);
  assert.deepEqual(ok.doc.options, ["gala", "lounge"]);
  assert.equal(ok.doc.passLimitOverride, true);
  assert.match(ok.warning, /Connect Pass doesn't cover.*Gala Dinner/);
  assert.match(ok.audit.detail, /outside the pass/);
  // An option on a day they aren't coming is outside the pass too.
  assert.equal(planStaffRsvp({ person: PERSON, body: { days: ["day1"], options: ["gala"] }, staff: STAFF }).code, "outside_pass");
});

test("an RSVP the attendee sent is protected: 409 unless staff override on purpose", () => {
  const theirs = { _id: "r1", key: "t:abc123def", tier: "power", tierVerified: true, kind: "ticket", days: ["day1"], options: [], updatedAt: new Date("2026-10-19T10:00:00Z") };
  const legacy = planStaffRsvp({ existing: theirs, person: PERSON, body: ANSWERS, staff: STAFF }); // no `source`: the attendee's
  assert.deepEqual([legacy.status, legacy.code], [409, "attendee_rsvp"]);
  assert.equal(planStaffRsvp({ existing: { ...theirs, source: "attendee" }, person: PERSON, body: { ...ANSWERS, override: "yes" }, staff: STAFF }).code, "attendee_rsvp");
  const over = planStaffRsvp({ existing: { ...theirs, source: "attendee" }, person: PERSON, body: { ...ANSWERS, override: true }, staff: STAFF, now: NOW });
  assert.equal(over.create, false);
  assert.equal(over.id, "r1");
  assert.deepEqual([over.set.source, over.set.staffOverride, over.set.staffUpdatedBy, over.set.staffUpdatedAt], ["staff", true, "Nicole Staff", NOW]);
  assert.equal(over.audit.action, "rsvp_staff_override");
  assert.ok(!("tier" in over.set)); // a ticket's pass never changes here
  // Staff's own RSVP: no confirmation needed; the override note is kept.
  const again = planStaffRsvp({ existing: { ...theirs, source: "staff", staffOverride: true }, person: PERSON, body: ANSWERS, staff: STAFF });
  assert.deepEqual([again.create, again.set.staffOverride, again.audit.action], [false, true, "rsvp_staff_edit"]);
  // Changed since staff opened it.
  const stale = planStaffRsvp({ existing: { ...theirs, source: "staff" }, person: PERSON, body: { ...ANSWERS, basedOn: "2026-10-18T10:00:00Z" }, staff: STAFF });
  assert.deepEqual([stale.status, stale.code], [409, "changed"]);
  const fresh = planStaffRsvp({ existing: { ...theirs, source: "staff" }, person: PERSON, body: { ...ANSWERS, basedOn: "2026-10-19T10:00:00.000Z" }, staff: STAFF });
  assert.equal(fresh.create, false);
});

test("an unverified pass can be corrected by staff; a verified one can't", () => {
  const row = { _id: "r2", source: "staff", tier: "connect", tierVerified: false, days: ["day1"], options: [] };
  const up = planStaffRsvp({ existing: row, person: { name: "Sam Guest" }, body: { days: ["day1"], options: ["cxo_d1"], tier: "power" }, staff: STAFF });
  assert.equal(up.set.tier, "power");
  const locked = planStaffRsvp({ existing: { ...row, tierVerified: true }, person: { name: "Sam Guest" }, body: { days: ["day1"], options: ["cxo_d1"], tier: "power" }, staff: STAFF });
  assert.equal(locked.code, "outside_pass"); // still Connect
});

test("staff answers are checked like the public form's", () => {
  assert.equal(cleanStaffAnswers({ days: [] }).field, "days");
  assert.equal(cleanStaffAnswers({ days: ["day3"] }).field, "days");
  assert.equal(cleanStaffAnswers({ days: ["day1"], options: ["spa"] }).field, "options");
  assert.equal(cleanStaffAnswers({ days: ["day1"], dietary: ["paleo"] }).field, "dietary");
  assert.equal(cleanStaffAnswers({ days: ["day1"], dietary: ["other"] }).field, "dietaryOther");
  const v = cleanStaffAnswers({ days: ["day2", "day1"], options: ["day1", "gala", "gala"], dietary: ["none", "halal"], dietaryOther: "x", accessibility: " Ramp\r\nplease " }).value;
  assert.deepEqual(v, { days: ["day1", "day2"], options: ["gala"], dietary: ["halal"], dietaryOther: "", accessibility: "Ramp\nplease" });
  assert.deepEqual(splitName("Jane Q. Doe"), { firstName: "Jane Q.", lastName: "Doe" });
  assert.deepEqual(splitName("Cher"), { firstName: "Cher", lastName: "" });
});

test("RSVP status: not yet, the attendee's (when), or staff's (who, when)", () => {
  assert.equal(rsvpStatusOf(null).status, "none");
  const a = rsvpStatusOf({ days: ["day1"], updatedAt: "2026-10-01T00:00:00Z", attendeeSubmittedAt: "2026-10-02T00:00:00Z" });
  assert.deepEqual([a.status, a.label, a.at, a.by], ["attendee", "RSVP'd by attendee", "2026-10-02T00:00:00Z", ""]);
  const s = rsvpStatusOf({ source: "staff", staffUpdatedBy: "Nicole", staffUpdatedAt: "2026-10-03T00:00:00Z", days: ["day2"], passLimitOverride: true });
  assert.deepEqual([s.status, s.by, s.at, s.days, s.passLimitOverride], ["staff", "Nicole", "2026-10-03T00:00:00Z", ["day2"], true]);
  assert.equal(rsvpSource({}), "attendee");
});

/* ---------- The attendee's own RSVP wins (services/rsvpHandler.js) ---------- */

const TICKETS = { abc123def: { ticketId: "ABC123DEF", type: "power", last: "doe", names: ["Jane Doe"] } };
function world() {
  const rows = [];
  let n = 0;
  const live = (r) => !r.spam && !r.mergedInto;
  const store = {
    rows,
    async findByKey(key) { return rows.find((r) => r.key === key && !r.spam) || null; },
    async findByNameKey(nk) { return nk ? rows.filter((r) => r.nameKey === nk && live(r)) : []; },
    async findByEditToken(h) { return (h && rows.find((r) => r.editTokenHash === h && live(r))) || null; },
    async insert(doc) {
      if (rows.some((r) => r.key === doc.key && !r.spam)) { const e = new Error("E11000"); e.code = 11000; throw e; }
      const d = { ...doc, _id: `r${++n}`, createdAt: new Date(), updatedAt: new Date() };
      rows.push(d);
      return d;
    },
    async update(id, set) {
      const d = rows.find((r) => r._id === id);
      Object.assign(d, set, { submissions: (d.submissions || 0) + 1, updatedAt: new Date() });
      return d;
    },
    async mark(id, set) { Object.assign(rows.find((r) => r._id === id), set); },
  };
  const lookup = makeLookup({
    verifyTicket: async (id, last) => {
      const t = TICKETS[String(id).toLowerCase()];
      return t && t.last === last.toLowerCase() ? { ticketId: t.ticketId, type: t.type, names: t.names } : null;
    },
    getHolders: async () => [],
    getSpeakers: async () => [],
  });
  const emails = [];
  const h = makeRsvpHandlers({ lookup, store, log: { error() {} }, notify: async (row) => { emails.push(row); }, ticketGuessLimiter: makeGuessLimiter({ max: 50, windowMs: 60_000 }) });
  const res = () => ({ statusCode: 200, body: undefined, headersSent: false, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; }, setHeader() {} });
  const submit = async (body) => { const r = res(); await h.submit({ body: { _hp: "", elapsedMs: 60000, page: "/rsvp", ...body }, ip: "1.2.3.4", headers: {} }, r); return r; };
  // What PUT /api/console/people/:id/rsvp stores (routes/people.js).
  const staffSave = async (plan) => {
    if (plan.create) return store.insert(plan.doc);
    const d = rows.find((r) => r._id === plan.id);
    Object.assign(d, plan.set, { updatedAt: new Date() });
    return d;
  };
  return { rows, submit, staffSave, emails };
}
const JANE = { firstName: "Jane", lastName: "Doe", ticketId: "ABC123DEF", tier: "power" };

test("a staff RSVP under the ticket is found and replaced by the attendee's own (not duplicated)", async () => {
  const w = world();
  await w.staffSave(planStaffRsvp({ person: PERSON, body: { days: ["day1"], options: ["cxo_d1"], dietary: ["halal"] }, staff: STAFF }));
  assert.equal(w.rows[0].source, "staff");
  const r = await w.submit({ ...JANE, days: ["day2"], options: ["gala"], dietary: ["vegan"] });
  assert.equal(r.statusCode, 201);
  assert.equal(w.rows.length, 1);
  const row = w.rows[0];
  assert.deepEqual([row.source, row.days, row.options, row.dietary, row.submissions], ["attendee", ["day2"], ["gala"], ["vegan"], 1]);
  assert.ok(row.attendeeSubmittedAt instanceof Date);
  assert.equal(row.staffUpdatedBy, "Nicole Staff"); // kept as history
  assert.equal(row.passLimitOverride, false);
  assert.equal(r.body.updated, true);
  assert.equal(summarizeRsvps(w.rows).total, 1);
});

test("a staff RSVP made by name (no ticket on file then) is taken over when they RSVP with their ticket", async () => {
  const w = world();
  await w.staffSave(planStaffRsvp({ person: { name: "Jane Doe", pass: null }, body: { days: ["day1"], options: [], tier: "connect" }, staff: STAFF }));
  assert.equal(w.rows[0].key, "n:jane doe");
  const r = await w.submit({ ...JANE, days: ["day1", "day2"], options: ["cxo_d2"] });
  assert.equal(r.statusCode, 201);
  assert.equal(w.rows.length, 1);
  const row = w.rows[0];
  assert.deepEqual([row.key, row.source, row.tier, row.tierVerified, row.ticketVerified, row.duplicateOf], ["t:abc123def", "attendee", "power", true, true, ""]);
  assert.deepEqual(row.options, ["cxo_d2"]);
  // An attendee's own name-only RSVP is NOT taken over that way (no proof it's the same person): it's superseded as before.
  const w2 = world();
  w2.rows.push({ _id: "old", key: "n:jane doe", nameKey: "jane doe", source: "attendee", days: ["day1"], options: [], tier: "connect", firstName: "Jane", lastName: "Doe" });
  await w2.submit({ ...JANE, days: ["day2"], options: [] });
  assert.equal(w2.rows.length, 2);
  assert.equal(w2.rows[0].duplicateOf, w2.rows[1]._id);
});

test("the attendee's next RSVP replaces a staff override", async () => {
  const w = world();
  const first = await w.submit({ ...JANE, days: ["day1"], options: [] });
  const token = first.body.editToken;
  const row = w.rows[0];
  const over = planStaffRsvp({ existing: row, person: PERSON, body: { days: ["day1", "day2"], options: ["gala"], override: true }, staff: STAFF });
  await w.staffSave(over);
  assert.deepEqual([row.source, row.staffOverride], ["staff", true]);
  // They change it again from the same browser (edit token + ticket): theirs wins over the override.
  await w.submit({ firstName: "Jane", lastName: "Doe", ticketId: "ABC123DEF", tier: "power", days: ["day2"], options: [], editToken: token });
  assert.deepEqual([w.rows.length, row.source, row.days, row.options, row.staffOverride], [1, "attendee", ["day2"], [], false]);
});

test("staff edits never email anyone; the attendee's RSVP still emails the team", async () => {
  const w = world();
  await w.staffSave(planStaffRsvp({ person: PERSON, body: ANSWERS, staff: STAFF }));
  assert.equal(w.emails.length, 0);
  await w.submit({ ...JANE, days: ["day1"], options: [] });
  await new Promise((r) => setImmediate(r));
  assert.equal(w.emails.length, 1);
});

test("staff merge: the attendee's answers win over staff's whichever is newer", () => {
  const at = (d) => new Date(`2026-10-${d}Z`);
  const staffRow = { _id: "s", key: "t:abc", ticketVerified: true, tierVerified: true, tier: "power", source: "staff", staffUpdatedBy: "Nicole",
    days: ["day1", "day2"], options: ["gala"], dietary: ["halal"], createdAt: at("10T10:00:00"), updatedAt: at("15T10:00:00") };
  const attendeeRow = { _id: "a", key: "dup:1", duplicateOf: "s", tier: "power", days: ["day1"], options: ["cxo_d1"], dietary: ["vegan"], email: "j@x.com",
    createdAt: at("11T10:00:00"), updatedAt: at("11T10:00:00") };
  const plan = planRsvpMerge(staffRow, attendeeRow);
  assert.equal(plan.survivor, staffRow); // the verified row stays listed
  assert.equal(plan.newer, attendeeRow); // older, but the attendee's own
  assert.deepEqual([plan.set.days, plan.set.options, plan.set.dietary, plan.set.source], [["day1"], ["cxo_d1"], ["vegan"], "attendee"]);
  // The other way round: staff's are the newer row but the attendee's still win.
  const flip = planRsvpMerge({ ...attendeeRow, duplicateOf: "", key: "t:abc", ticketVerified: true, tierVerified: true }, { ...staffRow, duplicateOf: "a", key: "dup:2" });
  assert.deepEqual([flip.set.days, flip.set.source], [["day1"], "attendee"]);
  // Both staff: the newer, with who set it; out-of-pass options staff allowed on purpose are kept.
  const both = planRsvpMerge({ ...staffRow, updatedAt: at("12T10:00:00") }, { ...staffRow, _id: "s2", duplicateOf: "s", staffUpdatedBy: "Baldeep", passLimitOverride: true, tier: "connect", tierVerified: false, ticketVerified: false, days: ["day2"], options: ["gala"], updatedAt: at("16T10:00:00") });
  assert.deepEqual([both.set.source, both.set.staffUpdatedBy, both.set.options, both.set.passLimitOverride], ["staff", "Baldeep", ["gala"], true]);
  // Two attendee rows: unchanged behaviour (no source fields set).
  const plain = planRsvpMerge({ ...attendeeRow, duplicateOf: "", _id: "x" }, { ...attendeeRow, _id: "y", duplicateOf: "x" });
  assert.ok(!("source" in plain.set));
});

test("resolve merge keeps the attendee's answers and says who set them", async () => {
  const rows = [
    { _id: "s", key: "t:abc", ticketVerified: true, tierVerified: true, tier: "power", source: "staff", days: ["day2"], options: [], updatedAt: new Date("2026-10-15") },
    { _id: "a", key: "dup:1", duplicateOf: "s", tier: "power", days: ["day1"], options: [], updatedAt: new Date("2026-10-10") },
  ];
  const store = {
    async findLive(id) { return rows.find((r) => r._id === String(id) && !r.mergedInto) || null; },
    async update(id, set) { const d = rows.find((r) => r._id === String(id)); Object.assign(d, set); return d; },
    async repoint() {},
  };
  const r = await resolveRsvpDuplicate(store, "a", "merge", { name: "Nicole" });
  assert.equal(r.row._id, "s");
  assert.deepEqual([r.row.days, r.row.source], [["day1"], "attendee"]);
});

test("admin rows and the CSV say who entered the RSVP", () => {
  const row = rsvpRow({ _id: "r", source: "staff", staffUpdatedBy: "Nicole", staffUpdatedAt: NOW, passLimitOverride: true, submissions: 0 });
  assert.deepEqual([row.source, row.staffUpdatedBy, row.passLimitOverride, row.submissions], ["staff", "Nicole", true, 0]);
  assert.equal(rsvpRow({ _id: "r" }).source, "attendee");
  assert.equal(rsvpRow({ _id: "r" }).submissions, 1);
  const csv = rsvpsCsv([{ _id: "r", firstName: "J", source: "staff", staffUpdatedBy: "Nicole" }, { _id: "q", firstName: "K" }]).split("\n");
  const i = CSV_HEAD.indexOf("Entered by");
  assert.ok(i > 0 && CSV_HEAD.at(-1) === "In headcounts");
  assert.equal(csv[1].split(",")[i], "Staff: Nicole");
  assert.equal(csv[2].split(",")[i], "Attendee");
});
