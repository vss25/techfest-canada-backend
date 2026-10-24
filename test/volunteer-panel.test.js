/* The volunteer panel's pure parts (services/volunteerPanel.js, the volunteer viewer of services/adminSearch.js) and
   the site status that replaced the kill switch (services/siteStatus.js). No database, no network. Fictional
   people, example.com addresses. The real routes: test/volunteer-panel-db.test.js. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPeople, personRow } from "../services/people.js";
import {
  PERSON_ID, VOLUNTEER_FILTERS, VOLUNTEER_READS, VOLUNTEER_SORTS, couponCodes, volunteerCounts, volunteerList, volunteerPass, volunteerProfile,
  volunteerQuery, volunteerRow, volunteerSearch, speakingSessions,
} from "../services/volunteerPanel.js";
import { runSearch, groupsFor } from "../services/adminSearch.js";
import { MASK, NO_NAME, escapeRx, safeName, safeSearchText, safeText, safeUrl, volunteerText } from "../services/volunteerSafe.js";
import { cleanVia, passwordSignIn, signedInWithoutPassword, tokenClaims, VIA_GOOGLE, VIA_LINKEDIN } from "../services/signInMethod.js";
import {
  KILL_SWITCH_KEY, KILL_SWITCH_REMOVED_CODE, SITE_STATUS, isRetiredContentKey, killSwitchGone, statusHandler,
} from "../services/siteStatus.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const d = (s) => new Date(`2026-${s}T12:00:00Z`);

/* Secrets a volunteer must never get back, whatever they ask. */
const SECRETS = {
  email: "mara.secret@example.com", guestEmail: "omar.guest@example.com", rsvpEmail: "walkin.rsvp@example.com",
  ticket: "beefcafe0001", guestTicket: "c0ffee000002", speakerTicket: "5pea4e000003",
  code: "SECRETCODE20", stripe: "cs_test_secretsession", phone: "4165550199", linkedin: "linkedin.com/in/mara-secret",
  manualNote: "Invoice SECRET-NOTE-77", hideReason: "SECRET-HIDE-REASON", accessibility: "Wheelchair SECRET-ACCESS",
};

function world() {
  const users = [
    { _id: "u1", name: "Mara Delegate", email: SECRETS.email, role: "user", organization: "Example Bank", jobTitle: "Head of Digital",
      linkedinUrl: `https://${SECRETS.linkedin}`, vip: true, avatarVersion: 3,
      appHidden: { at: d("10-20"), by: "s1", byName: "Sam Staff", reason: SECRETS.hideReason },
      tickets: [{ ticketId: SECRETS.ticket, type: "power", purchaseDate: d("10-01"), stripeSessionId: SECRETS.stripe, promoCode: SECRETS.code,
        checkedIn: true, checkedInAt: d("10-26"), details: { phone: `+1 ${SECRETS.phone}`, linkedin: SECRETS.linkedin } }] },
    { _id: "u2", name: "Sam Staff", email: "sam.staff@example.com", role: "admin", staffRole: "staff", tickets: [] },
  ];
  const attendees = [
    { _id: "a1", name: "Omar Guest", email: SECRETS.guestEmail, ticketId: SECRETS.guestTicket, ticketType: "connect", purchaseDate: d("10-02"),
      manualValue: 1234.56, manualValueNote: SECRETS.manualNote, details: { firstName: "Omar", lastName: "Guest", organisation: "Robotics Example", phone: SECRETS.phone } },
    { _id: "a2", name: "Kai Speaker", ticketId: SECRETS.speakerTicket, ticketType: "speaker", promoCode: "SPEAKER", speakerId: "spk-kai", purchaseDate: d("10-03"),
      issuedPass: { booth: { booth: "B7" } }, details: { jobTitle: "Chief Scientist", organisation: "Quantum Example" } },
  ];
  const rsvps = [
    { _id: "r1", key: `t:${SECRETS.ticket}`, nameKey: "mara delegate", firstName: "Mara", lastName: "Delegate", email: SECRETS.email, ticketId: SECRETS.ticket,
      ticketVerified: true, tier: "power", days: ["day1", "day2"], options: ["sessions_d1", "lunch_d1", "gala", "awards"], dietary: ["vegan", "nut_allergy"],
      dietaryOther: "No mushrooms", accessibility: SECRETS.accessibility, updatedAt: d("10-10"), createdAt: d("10-10"), attendeeSubmittedAt: d("10-10") },
    { _id: "r2", key: "n:walk in", nameKey: "walk in", firstName: "Walk", lastName: "In", email: SECRETS.rsvpEmail, tier: "connect", days: ["day1"], options: [],
      createdAt: d("10-11"), updatedAt: d("10-11") },
  ];
  const speakers = [{ _id: "spk-kai", name: "Kai Speaker", title: "Chief Scientist", company: "Quantum Example" }];
  const stripe = { paid: new Map([[SECRETS.stripe, 849]]), free: new Set(), upgrades: new Map() };
  const engagement = [{ campaign: "attending-2026", email: SECRETS.email, opens: 3, firstOpenAt: d("10-12"), lastOpenAt: d("10-13") }];
  return buildPeople({ users, attendees, rsvps, speakers, stripe, engagement, promos: [{ code: SECRETS.code, discount: 20 }] });
}

/** Every key in a JSON value, deep. */
function keysOf(v, out = new Set()) {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
  return out;
}
const FORBIDDEN_KEY = /email|phone|linkedin|ticketid|stripe|promo|coupon|^code$|value|price|engagement|attending|rsvpemail|note|audit|manual|hidden|contact|outreach|qr|userid|account|refund|paid|source|edit|apphide|reminder|nudge|catalog/i;
function assertSafe(json, label) {
  const bad = [...keysOf(json)].filter((k) => FORBIDDEN_KEY.test(k) && !["dietaryOther"].includes(k));
  assert.deepEqual(bad, [], `${label}: forbidden keys`);
  const text = JSON.stringify(json).toLowerCase();
  for (const [name, secret] of Object.entries(SECRETS)) assert.ok(!text.includes(String(secret).toLowerCase()), `${label}: ${name} leaked`);
  for (const amount of ["849", "1234.56"]) assert.ok(!text.includes(amount), `${label}: amount ${amount}`);
}

test("a volunteer's row and profile: only the safe fields, nothing financial, no contact details, no ticket IDs", () => {
  const { people } = world();
  const mara = people.find((p) => p.name === "Mara Delegate");
  // The staff row has them all (unchanged), the volunteer's none.
  assert.equal(personRow(mara).email, SECRETS.email);
  const row = volunteerRow(mara);
  assert.deepEqual(Object.keys(row).sort(), ["band", "booth", "checkedIn", "checkedInAt", "company", "exhibitor", "id", "jobTitle", "logoUrl", "media", "name",
    "pass", "passCount", "photoUrl", "rsvp", "speaker", "types", "vip"].sort());
  assert.deepEqual(Object.keys(row.pass).sort(), ["booth", "checkedIn", "checkedInAt", "exhibitorPass", "extras", "label", "pending", "printedLabel", "tier", "tierLabel"].sort());
  assert.equal(row.name, "Mara Delegate");
  assert.equal(row.jobTitle, "Head of Digital");
  assert.equal(row.company, "Example Bank");
  assert.equal(row.vip, true);
  assert.equal(row.pass.label, "Power Pass");
  assert.equal(row.pass.pending, false);
  assert.deepEqual(row.pass.extras, { cxo: true, lunch: true, gala: true, awards: true }); // VIP: the CxO Breakfasts on a Power Pass
  assert.equal(row.checkedIn, true);
  assert.equal(row.checkedInAt, d("10-26").toISOString());
  assert.match(row.photoUrl, /^\/api\/files\/avatar\/u1\?v=3$/);
  assertSafe(row, "row");

  const prof = volunteerProfile(mara);
  assert.deepEqual(prof.rsvp.dayLabels.length, 2);
  assert.deepEqual(prof.rsvp.events.map((e) => e.key), ["lunch_d1", "awards", "gala"]);
  assert.deepEqual(prof.rsvp.dietary.map((x) => x.label), ["Vegan", "Nut allergy"]);
  assert.equal(prof.rsvp.dietaryOther, "No mushrooms");
  assert.equal(prof.rsvp.accessibility, true, "the flag only");
  assert.equal(prof.passes.length, 1);
  assertSafe(prof, "profile");
  for (const p of people) { assertSafe(volunteerRow(p), p.name); assertSafe(volunteerProfile(p), p.name); }
});

test("a pass made by staff and not emailed yet shows Pending; a booth and the speaker's sessions", () => {
  const { people } = world();
  const kai = people.find((p) => p.name === "Kai Speaker");
  const row = volunteerRow(kai);
  assert.equal(row.pass.pending, true);
  assert.equal(row.pass.label, "Speaker Pass");
  assert.equal(row.booth, "B7");
  assert.equal(row.speaker, true);
  const agenda = [
    { day: 1, time: "10:00", endTime: "10:30", title: "Quantum Computing in Finance", format: "panel", speakers: [{ name: "Kai Speaker" }, { name: "Ann Other" }] },
    { day: 2, time: "09:00", endTime: "09:20", title: "Opening", format: "keynote", moderator: { name: "Kai Speaker" } },
    { day: 2, time: "11:00", endTime: "11:30", title: "Not theirs", format: "panel", speakers: [{ name: "Ann Other" }] },
  ];
  assert.deepEqual(speakingSessions(kai, agenda), [
    { day: 1, start: "10:00", end: "10:30", title: "Quantum Computing in Finance", format: "Panel", role: "Panellist" },
    { day: 2, start: "09:00", end: "09:20", title: "Opening", format: "Keynote", role: "Moderator" },
  ]);
  assert.deepEqual(speakingSessions(people.find((p) => p.name === "Mara Delegate"), agenda), [], "not a speaker");
  assert.deepEqual(volunteerProfile(kai, { sessions: agenda }).sessions.length, 2);
  assert.equal(volunteerPass(null), null);
});

test("search: words in the name, company and job title; an exact email or ticket ID finds them; never part of an email, a ticket or a code", () => {
  const { people } = world();
  const names = (q) => volunteerSearch(people, q).map((p) => p.name).sort();
  assert.deepEqual(names("mara"), ["Mara Delegate"]);
  assert.deepEqual(names("example bank"), ["Mara Delegate"]);
  assert.deepEqual(names("chief"), ["Kai Speaker"]);
  assert.deepEqual(names(SECRETS.email), ["Mara Delegate"]);
  assert.deepEqual(names(SECRETS.email.toUpperCase()), ["Mara Delegate"]);
  assert.deepEqual(names(SECRETS.ticket), ["Mara Delegate"]);
  assert.deepEqual(names(`TECHFEST:${SECRETS.guestTicket.toUpperCase()}`), ["Omar Guest"]);
  assert.deepEqual(names(SECRETS.rsvpEmail), ["Walk In"]);
  for (const q of ["mara.secret", "example.com", "@example.com", "beefcafe", "cafe0001", SECRETS.code, "secretcode", "4165550199", "cs_test", "invoice"]) {
    assert.deepEqual(names(q), [], q);
  }
  assert.equal(volunteerSearch(people, "").length, people.length);
});

test("filters and sorts: the allowed ones only; ticket value, pass status, RSVP email, engagement and hidden are ignored", () => {
  const { people } = world();
  assert.deepEqual(volunteerQuery({ value: "above", status: "paid", rsvpEmail: "yes", attending: "posted", appHidden: "yes", rsvp: "form", sort: "value" }),
    { q: "", filters: {}, sort: "name", dir: "asc", page: 0 });
  assert.deepEqual(volunteerQuery({ type: "Speaker", pass: "power", rsvp: "any", exhibitor: "yes", vip: "no", media: "maybe", sort: "company", dir: "desc", page: "2" }),
    { q: "", filters: { type: "speaker", pass: "power", rsvp: "any", exhibitor: "yes", vip: "no" }, sort: "company", dir: "desc", page: 2 });
  for (const s of ["code", "status", "value", "rsvpEmail", "attending"]) assert.ok(!VOLUNTEER_SORTS.includes(s), s);
  assert.deepEqual([...VOLUNTEER_FILTERS], ["type", "pass", "rsvp", "exhibitor", "vip", "media"]);
  const all = volunteerList(people, {}).list.map((p) => p.id);
  for (const q of [{ value: "above" }, { value: "below" }, { rsvpEmail: "yes" }, { attending: "opened" }, { appHidden: "yes" }, { status: "pending" }, { sort: "value" }, { sort: "code" }]) {
    assert.deepEqual(volunteerList(people, q).list.map((p) => p.id), all, JSON.stringify(q));
  }
  // Sorting by value falls back to the name (the direction still applies).
  assert.deepEqual(volunteerList(people, { sort: "value", dir: "desc" }).list.map((p) => p.id), [...all].reverse());
  assert.deepEqual(volunteerList(people, { type: "speaker" }).list.map((p) => p.name), ["Kai Speaker"]);
  assert.deepEqual(volunteerList(people, { pass: "power" }).list.map((p) => p.name), ["Mara Delegate"]);
  assert.deepEqual(volunteerList(people, { vip: "yes" }).list.map((p) => p.name), ["Mara Delegate"]);
  const counts = volunteerCounts(people);
  assert.deepEqual(Object.keys(counts).sort(), ["byRsvp", "byType", "checkedIn", "exhibitors", "media", "total", "vips"].sort());
  assert.equal(counts.total, people.length);
  assert.equal(counts.checkedIn, 1);
  assert.equal(counts.byType.speaker, 1);
  assertSafe(counts, "counts");
});

test("person ids in links, and the read budget", () => {
  for (const ok of ["u-64b000000000000000000001", "a-64b000000000000000000001", "s-spk-kai", "r-64b0000000000000000000ff", "t-beefcafe0001"]) assert.ok(PERSON_ID.test(ok), ok);
  for (const no of ["export", "reminder", "nudge", "eligible", "app-hidden", "x-1", "u-", "u-a/b", ""]) assert.ok(!PERSON_ID.test(no), no);
  assert.deepEqual({ ...VOLUNTEER_READS }, { max: 120, windowMs: 60000 });
});

test("the search box for a volunteer: People only, no email, no staff-only badge, an exact email or ticket ID never repeated", async () => {
  const d0 = world();
  const sources = {
    directory: async () => ({ people: d0.people, rsvps: [] }),
    ticketDocs: async () => { throw new Error("not for volunteers"); },
    cms: async () => { throw new Error("not for volunteers"); },
  };
  assert.deepEqual(groupsFor({ volunteer: true }).map((g) => g.key), ["people"]);
  assert.ok(groupsFor({ management: false }).length > 5, "staff unchanged");
  const byName = await runSearch({ q: "mara", viewer: { volunteer: true }, sources });
  assert.deepEqual(byName.groups.map((g) => g.key), ["people"]);
  assert.deepEqual(byName.failed, []);
  const item = byName.groups[0].items[0];
  assert.equal(item.title, "Mara Delegate");
  assert.ok(!item.subtitle.includes("@"), item.subtitle);
  assert.ok(!item.badges.includes("Hidden from app"));
  assert.equal(byName.query.text, "mara");
  assert.ok(byName.groups[0].seeAll);
  for (const q of [SECRETS.email, SECRETS.ticket, `TECHFEST:${SECRETS.ticket}`]) {
    const out = await runSearch({ q, viewer: { volunteer: true }, sources });
    assert.equal(out.groups[0].items[0].title, "Mara Delegate", q);
    assert.equal(out.groups[0].items[0].exact, true);
    assert.equal(out.query.text, "");
    assert.equal(out.groups[0].seeAll, undefined);
    const text = JSON.stringify(out).toLowerCase();
    assert.ok(!text.includes(SECRETS.email) && !text.includes(SECRETS.ticket), q);
  }
  // Staff see what they always saw: the email, the Hidden from app badge, the ticket group.
  const staff = await runSearch({ q: "mara", viewer: { management: false }, sources: { ...sources, cms: async () => [], ticketDocs: async () => [] } });
  const s = staff.groups.find((g) => g.key === "people").items[0];
  assert.match(s.subtitle, /mara\.secret@example\.com/);
  assert.ok(s.badges.includes("Hidden from app"));
});

test("site status: always live; the kill switch's key can't be written; its route is gone", () => {
  const res = { headers: {}, code: 200, body: null, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  statusHandler({}, res);
  assert.deepEqual([res.code, res.body, res.headers["Cache-Control"]], [200, { live: true, message: "" }, "no-store"]);
  assert.deepEqual({ ...SITE_STATUS }, { live: true, message: "" });
  const gone = { ...res, headers: {}, code: 200, body: null };
  killSwitchGone({}, gone);
  assert.equal(gone.code, 410);
  assert.deepEqual(Object.keys(gone.body).sort(), ["code", "error"]);
  assert.equal(gone.body.code, KILL_SWITCH_REMOVED_CODE);
  assert.equal(KILL_SWITCH_KEY, "site.kill");
  for (const k of ["site.kill", " SITE.KILL ", "Site.Kill"]) assert.ok(isRetiredContentKey(k), k);
  for (const k of ["site.announcement", "site.killer", "", null]) assert.ok(!isRetiredContentKey(k), String(k));
  // Nothing in the backend uses the old kill switch any more.
  assert.equal(fs.existsSync(path.join(ROOT, "services/killSwitch.js")), false);
  const files = ["server.js", ...["routes", "services", "middleware"].flatMap((dir) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(".js")).map((f) => `${dir}/${f}`))];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.doesNotMatch(src, /killSwitch\.js|killSwitchMiddleware|getKillState|setKillState/, f);
  }
});

/* ---------- Free text: an email, phone number or ticket ID typed into a name, company, title or note ---------- */

const LEAKS = {
  yaraEmail: "yara.leak@example.com", yaraLocal: "yara.leak", yaraTicket: "acac56565656",
  staffEmail: "noname.staffer@example.org", staffLocal: "noname.staffer",
  leeEmail: "lee@leakmail.example.com", leeDomain: "leakmail.example.com", leePhone: "555-0188", leePhone2: "5550188",
  dietPhone: "416 555 0177", dietPhone2: "5550177", label: "dd00ee000099",
};
function leakyWorld() {
  const users = [
    // A staff account added without a name: POST /api/console/staff names it after the email's local part.
    { _id: "u10", name: LEAKS.staffLocal, email: LEAKS.staffEmail, role: "admin", staffRole: "staff", tickets: [] },
    // Contact details typed into the company and the job title.
    { _id: "u11", name: "Lee Leaky", email: "lee.account@example.com", role: "user", organization: `Contact ${LEAKS.leeEmail}`,
      jobTitle: `CTO, +1 (647) ${LEAKS.leePhone}`, tickets: [{ ticketId: "ab12ab12ab12", type: "connect", purchaseDate: d("10-04") }] },
    // A real name that happens to start like the email: kept.
    { _id: "u12", name: "Yara Leak", email: "yara.leak2@example.com", role: "user", organization: "CEO @ Acme", jobTitle: "Founder", tickets: [] },
  ];
  const attendees = [
    // A buyer who typed their email as their name.
    { _id: "a10", name: LEAKS.yaraEmail, email: LEAKS.yaraEmail, ticketId: LEAKS.yaraTicket, ticketType: "connect", purchaseDate: d("10-05"),
      issuedPass: { label: `Pass ${LEAKS.label}` }, details: {} },
  ];
  const rsvps = [
    { _id: "r10", key: `t:${LEAKS.yaraTicket}`, nameKey: "", email: LEAKS.yaraEmail, ticketId: LEAKS.yaraTicket, ticketVerified: true, tier: "connect",
      days: ["day1"], options: [], dietary: ["other"], dietaryOther: `Nut allergy, call ${LEAKS.dietPhone} or ${LEAKS.yaraEmail}`,
      createdAt: d("10-12"), updatedAt: d("10-12") },
  ];
  return buildPeople({ users, attendees, rsvps });
}
function assertNoLeak(json, label) {
  const text = JSON.stringify(json).toLowerCase();
  for (const [name, secret] of Object.entries(LEAKS)) assert.ok(!text.includes(secret.toLowerCase()), `${label}: ${name} leaked`);
}

test("safe text: emails, phone numbers and ticket IDs in a person's free text are hidden; a name that is one shows No name", () => {
  const p = { name: "x", email: "yara.leak@example.com", emails: new Set(["yara.alt@example.org"]), passList: [{ ticketId: "beefcafe0001" }] };
  const name = (n, q = p) => safeName({ ...q, name: n });
  // The whole name is an email (theirs or not), the part before one of their @, or a ticket ID of theirs.
  for (const n of ["yara.leak@example.com", "YARA.LEAK@EXAMPLE.COM", " yara.leak@example.com ", "someone.else@example.net", "yara.leak", "Yara.Leak",
    "yara.alt", "beefcafe0001", "TECHFEST:BEEFCAFE0001", "yara​.leak@example.com", "yara＠example.com", "<yara.leak@example.com>", "", "No name"]) {
    assert.equal(name(n), NO_NAME, JSON.stringify(n));
  }
  // An email or a handle inside a name: what's left.
  assert.equal(name("Yara (yara.leak@example.com)"), "Yara");
  assert.equal(name("Yara - yara.leak"), "Yara");
  assert.equal(name("Yara Leak, 4165550199"), "Yara Leak");
  // Real names stay as they are.
  for (const n of ["Yara Leak", "José Núñez", "O'Brien-Smith", "Dr. Ann Other, PhD", "Team 42"]) assert.equal(name(n), n);
  // A one-word name equal to the part before their @ is hidden too (the staff-account default looks the same).
  assert.equal(safeName({ name: "Priya", email: "priya@example.com" }), NO_NAME);
  assert.equal(safeName({ name: "Priya Patel", email: "priya@example.com" }), "Priya Patel");

  // Other fields: [hidden] where something was taken out, "" when nothing else is left.
  assert.equal(safeText("Contact lee@leakmail.example.com", p), `Contact ${MASK}`);
  assert.equal(safeText("yara.leak@example.com", p), "");
  assert.equal(safeText("CTO, +1 (647) 555-0188", p), `CTO, ${MASK}`);
  assert.equal(safeText("+1 (416) 555 0199", p), "");
  assert.equal(safeText("Nut allergy, call 416.555.0177 or yara.leak@example.com", p), `Nut allergy, call ${MASK} or ${MASK}`);
  assert.equal(safeText("Pass dd00ee000099", p), `Pass ${MASK}`);
  assert.equal(safeText("Booth BOOTH-1a2b", p), `Booth ${MASK}`);
  assert.equal(safeText("Ask for yara.leak at the desk", p), `Ask for ${MASK} at the desk`);
  for (const t of ["CEO @ Acme", "Head of Digital", "Startup Pass", "B7", "No mushrooms", "Section 12, row 3", "Class of 2026"]) assert.equal(safeText(t, p), t);
  assert.equal(safeText("x".repeat(300), p, 60).length, 60);
  // A mask is never cut in half: "x x … x [hid" → "x x … x".
  assert.equal(safeText(`${"x ".repeat(28)}4165550199`, p, 60), "x ".repeat(28).trim());
  // Photo / logo addresses.
  assert.equal(safeUrl("/api/files/avatar/64b000000000000000000001?v=3", p), "/api/files/avatar/64b000000000000000000001?v=3");
  assert.equal(safeUrl("https://cdn.example.com/logo.png", p), "https://cdn.example.com/logo.png");
  for (const u of ["https://cdn.example.com/yara.leak@example.com.png", "https://cdn.example.com/a%40b.png", "https://cdn.example.com/beefcafe0001.png"]) assert.equal(safeUrl(u, p), "", u);
  // The search text is the safe text, without the masks.
  assert.equal(safeSearchText({ name: "Yara (yara.leak@example.com)", email: "yara.leak@example.com", company: "Call 4165550199", jobTitle: "Founder" }), "Yara Call Founder");
});

test("a name that is an email, a staff account named after its email: hidden from the volunteer's rows, profile, search and sort", async () => {
  const { people, byId } = leakyWorld();
  const yara = byId.get(`t-${LEAKS.yaraTicket}`);
  const staff = byId.get("u-u10");
  const lee = byId.get("u-u11");
  const real = byId.get("u-u12");
  // Staff still see what was typed (unchanged).
  assert.equal(personRow(yara).name, LEAKS.yaraEmail);
  assert.equal(personRow(staff).name, LEAKS.staffLocal);

  assert.equal(volunteerRow(yara).name, NO_NAME);
  assert.equal(volunteerRow(staff).name, NO_NAME);
  assert.deepEqual(volunteerRow(staff).types, ["staff"]);
  assert.deepEqual([volunteerRow(lee).company, volunteerRow(lee).jobTitle], [`Contact ${MASK}`, `CTO, ${MASK}`]);
  assert.deepEqual([volunteerRow(real).name, volunteerRow(real).company], ["Yara Leak", "CEO @ Acme"]);
  const prof = volunteerProfile(yara);
  assert.equal(prof.name, NO_NAME);
  assert.equal(prof.pass.printedLabel, `Pass ${MASK}`);
  assert.deepEqual(prof.rsvp.dietary, [{ key: "other", label: "Other" }]);
  assert.equal(prof.rsvp.dietaryOther, `Nut allergy, call ${MASK} or ${MASK}`);
  for (const p of people) { assertNoLeak(volunteerRow(p), `row ${p.id}`); assertNoLeak(volunteerProfile(p), `profile ${p.id}`); }

  // Word search: the hidden text never matches.
  const names = (q) => volunteerSearch(people, q).map((p) => p.id).sort();
  for (const q of ["example.com", "@example.com", "example", "yara.leak", "noname", "staffer", "noname.staffer", "leakmail", "lee@leakmail", "647", "555-0188", "dd00ee"]) {
    assert.deepEqual(names(q), [], q);
  }
  assert.deepEqual(names("yara"), ["u-u12"], "the real Yara Leak only");
  assert.deepEqual(names("leak"), ["u-u11", "u-u12"].sort());
  assert.deepEqual(names("contact"), ["u-u11"]);
  // An exact email / ticket ID still finds them (the help desk).
  assert.deepEqual(names(LEAKS.yaraEmail), [yara.id]);
  assert.deepEqual(names(LEAKS.yaraTicket), [yara.id]);
  assert.deepEqual(names(LEAKS.staffEmail), ["u-u10"]);

  // The list's order: "No name" sorts with the blanks (last), never where the hidden name would be.
  const order = volunteerList(people, { sort: "name" }).list.map((p) => volunteerRow(p).name);
  assert.deepEqual(order, ["Lee Leaky", "Yara Leak", NO_NAME, NO_NAME]);
  assert.deepEqual(volunteerList(people, { sort: "name", dir: "desc" }).list.map((p) => volunteerRow(p).name), ["Yara Leak", "Lee Leaky", NO_NAME, NO_NAME]);
  assert.ok(volunteerList(people, { sort: "company" }).list.every((p) => people.includes(p)), "the people themselves come back");

  // The search box (the testers' requests): the title is the safe name; an exact email is never echoed.
  const sources = { directory: async () => ({ people, rsvps: [] }) };
  for (const q of ["example.com", "@example.com", "noname", "staffer", "leakmail"]) {
    const out = await runSearch({ q, viewer: { volunteer: true }, sources });
    assert.deepEqual(out.groups, [], q);
  }
  for (const [q, id] of [[LEAKS.yaraEmail, yara.id], [LEAKS.staffEmail, "u-u10"], [LEAKS.yaraTicket, yara.id]]) {
    const out = await runSearch({ q, viewer: { volunteer: true }, sources });
    const item = out.groups[0].items[0];
    assert.deepEqual([item.id, item.title, item.exact, out.query.text], [id, NO_NAME, true, ""], q);
    assertNoLeak(out, `search ${q}`);
  }
  const leeHit = await runSearch({ q: "lee", viewer: { volunteer: true }, sources });
  assert.equal(leeHit.groups[0].items[0].subtitle, `CTO, ${MASK}, Contact ${MASK} · Connect Pass`);
  assertNoLeak(leeHit, "search lee");
  // Staff see the stored text, as before.
  const staffOut = await runSearch({ q: "noname", viewer: { management: true }, sources: { ...sources, cms: async () => [], ticketDocs: async () => [] } });
  assert.equal(staffOut.groups.find((g) => g.key === "people").items[0].title, LEAKS.staffLocal);
});

test("the volunteer profile's shape (the website's People look-up reads exactly these names)", () => {
  const { people } = world();
  const mara = volunteerProfile(people.find((p) => p.name === "Mara Delegate"));
  assert.deepEqual(Object.keys(mara.rsvp).sort(), ["accessibility", "dayLabels", "days", "dietary", "dietaryOther", "events", "label", "status"]);
  assert.deepEqual(Object.keys(mara.rsvp.events[0]).sort(), ["day", "key", "label", "time"]);
  assert.deepEqual(mara.rsvp.dietary[0], { key: "vegan", label: "Vegan" });
  assert.equal(typeof mara.rsvp.dietaryOther, "string");
  assert.equal(typeof mara.rsvp.accessibility, "boolean");
  assert.ok(Array.isArray(mara.passes) && Array.isArray(mara.sessions));
  const agenda = [{ day: 1, time: "10:00", endTime: "10:30", title: "Quantum Computing in Finance", format: "panel", speakers: [{ name: "Kai Speaker" }] }];
  const kai = volunteerProfile(people.find((p) => p.name === "Kai Speaker"), { sessions: agenda });
  assert.deepEqual(kai.sessions, [{ day: 1, start: "10:00", end: "10:30", title: "Quantum Computing in Finance", format: "Panel", role: "Panellist" }]);
});

/* ---------- Odd characters in a person's emails, ticket IDs and names (the third round of testing) ----------
   A hyphen in an email's local part, a booth order (BOOTH-…) or a ticket ID once made the volunteer view build an
   invalid pattern: the list answered 500 for every volunteer and the search's People group failed. */

const ODD = {
  mary: "mary-jane@example.com", maryTicket: "f00d00000123", booth: "BOOTH-GOLD-7",
  jean: "jean-luc.x@example.com", siobhan: "o'brien+ttfc@example.com", zoe: "zoë.ünï-code@example.com",
  meta: "a.b*c?(d)[e]{f}|g^h$i\\j/k+l-m@example.com", metaTicket: "x-y.z+(1)[2]{3}|4^5$6\\7/8?9*",
  ann: "ann-marie.d'arcy@example.com", annTicket: "dead-beef-0042", greek: "δοκιμή-1@example.gr",
};
function oddWorld() {
  const users = [
    { _id: "u20", name: "Mary Jane (mary-jane)", email: ODD.mary, role: "user", organization: "Ask for mary-jane at the desk",
      tickets: [{ ticketId: ODD.maryTicket, type: "connect", purchaseDate: d("10-04") }, { ticketId: ODD.booth, type: "booth-single", purchaseDate: d("10-04") }] },
    { _id: "u21", name: "Jean-Luc Picard", email: ODD.jean, role: "user", organization: "Star-Fleet+Co. [HQ]", jobTitle: "Captain (ret.) / R&D", tickets: [] },
    { _id: "u22", name: "Siobhán O'Brien", email: ODD.siobhan, role: "user", jobTitle: "Head of R&D, o'brien+ttfc", tickets: [] },
    { _id: "u23", name: "Zoë Ünïcode-Smith", email: ODD.zoe, role: "user", jobTitle: "Writes to zoë.ünï-code", tickets: [] },
    { _id: "u24", name: "Regex (Test) [Person] a.b*c?(d)[e]{f}|g^h$i\\j/k+l-m", email: ODD.meta, role: "user", organization: "$1 \\1 (?<x>) [^]",
      tickets: [{ ticketId: ODD.metaTicket, type: "connect", purchaseDate: d("10-04") }] },
  ];
  const attendees = [
    { _id: "a20", name: "Ann-Marie D'Arcy", email: ODD.ann, ticketId: ODD.annTicket, ticketType: "connect", purchaseDate: d("10-05"),
      issuedPass: { label: `Guest ${ODD.annTicket}` }, details: { jobTitle: "Booth BOOTH-GOLD-7 helper" } },
    { _id: "a21", name: "Δοκιμή Ελληνικά", email: ODD.greek, ticketId: "c0ffee000099", ticketType: "connect", purchaseDate: d("10-05"), details: {} },
  ];
  return buildPeople({ users, attendees });
}

test("hyphens, dots, plus signs, apostrophes, unicode and regex characters in emails, ticket IDs and names never break the volunteer view", async () => {
  const { people, byId } = oddWorld();
  const mary = byId.get("u-u20");
  assert.deepEqual(mary.boothOrders, [ODD.booth]);
  // No throw for anyone, anywhere: rows, profiles, the safe text, the sort and the word search.
  for (const p of people) {
    assert.doesNotThrow(() => volunteerRow(p), p.id);
    assert.doesNotThrow(() => volunteerProfile(p), p.id);
    assert.doesNotThrow(() => safeName(p), p.id);
    assert.doesNotThrow(() => safeSearchText(p), p.id);
    assert.doesNotThrow(() => safeText("Ticket dead-beef-0042, BOOTH-GOLD-7, mary-jane", p), p.id);
  }
  assert.equal(volunteerList(people, {}).list.length, people.length);
  assert.equal(volunteerList(people, { sort: "company", dir: "desc" }).list.length, people.length);
  assert.deepEqual(volunteerSearch(people, "jean-luc").map((p) => p.id), ["u-u21"]);
  assert.deepEqual(volunteerSearch(people, "o'brien").map((p) => p.id), ["u-u22"]);

  // Real names and companies with those characters stay as they are.
  assert.equal(volunteerRow(byId.get("u-u21")).name, "Jean-Luc Picard");
  assert.equal(volunteerRow(byId.get("u-u21")).company, "Star-Fleet+Co. [HQ]");
  assert.equal(volunteerRow(byId.get("u-u21")).jobTitle, "Captain (ret.) / R&D");
  assert.equal(volunteerRow(byId.get("u-u22")).name, "Siobhán O'Brien");
  assert.equal(volunteerRow(byId.get("u-u23")).name, "Zoë Ünïcode-Smith");
  assert.equal(volunteerRow(byId.get(`t-${ODD.annTicket}`)).name, "Ann-Marie D'Arcy");
  assert.equal(volunteerRow(byId.get("t-c0ffee000099")).name, "Δοκιμή Ελληνικά");

  // And the masking still works on them.
  assert.equal(volunteerRow(mary).name, "Mary Jane");
  assert.equal(volunteerRow(mary).company, `Ask for ${MASK} at the desk`);
  assert.equal(safeText(`Booth ${ODD.booth}`, mary), `Booth ${MASK}`);
  assert.equal(safeText(`Pass ${ODD.maryTicket}`, mary), `Pass ${MASK}`);
  assert.equal(volunteerRow(byId.get("u-u22")).jobTitle, `Head of R&D, ${MASK}`);
  assert.equal(volunteerRow(byId.get("u-u23")).jobTitle, `Writes to ${MASK}`);
  const ann = byId.get(`t-${ODD.annTicket}`);
  assert.equal(volunteerRow(ann).pass.printedLabel, `Guest ${MASK}`);
  assert.equal(volunteerRow(ann).jobTitle, `Booth ${MASK} helper`);
  const meta = byId.get("u-u24");
  assert.equal(volunteerRow(meta).name, "Regex (Test) [Person]");
  assert.equal(safeText(`Ticket ${ODD.metaTicket} here`, meta), `Ticket ${MASK} here`);
  assert.equal(volunteerRow(meta).company, "$1 \\1 (?<x>) [^]");
  for (const p of people) {
    const text = JSON.stringify([volunteerRow(p), volunteerProfile(p)]).toLowerCase();
    for (const s of [ODD.mary, "mary-jane", ODD.booth.toLowerCase(), ODD.maryTicket, ODD.annTicket, "o'brien+ttfc", "zoë.ünï-code", ODD.metaTicket.toLowerCase()]) {
      assert.ok(!text.includes(s), `${p.id}: ${s}`);
    }
  }

  // The search box: the People group answers (it once came back failed), exact look-ups still work, never echoed.
  const sources = { directory: async () => ({ people, rsvps: [] }) };
  const words = await runSearch({ q: "mary", viewer: { volunteer: true }, sources });
  assert.deepEqual([words.failed, words.groups.map((g) => g.key), words.groups[0].items[0].title], [[], ["people"], "Mary Jane"]);
  for (const [q, id] of [[ODD.mary, "u-u20"], [ODD.maryTicket, "u-u20"], [ODD.annTicket, ann.id], [ODD.siobhan, "u-u22"]]) {
    const out = await runSearch({ q, viewer: { volunteer: true }, sources });
    assert.deepEqual(out.failed, [], q);
    assert.deepEqual([out.groups[0].items[0].id, out.groups[0].items[0].exact, out.query.text], [id, true, ""], q);
    assert.ok(!JSON.stringify(out).toLowerCase().includes(q.toLowerCase()), q);
  }
});

test("one person's data that can't be read fails closed, field by field, and the log never quotes it", () => {
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  try {
    // A directory record whose email throws when read, and a value that can't be turned into text.
    const { people } = world();
    const p = people.find((x) => x.name === "Omar Guest");
    Object.defineProperty(p, "email", { get() { throw new Error("secret-from-getter@example.com"); } });
    const bad = { toString() { throw new Error("secret-text@example.com"); } };
    assert.equal(safeName(p), NO_NAME);
    assert.equal(safeText("Robotics Example", p), MASK);
    assert.equal(safeText(bad, { name: "x" }), MASK);
    assert.equal(safeUrl("https://cdn.example.com/a.png", p), "");
    assert.equal(safeSearchText(p), "");
    const row = volunteerRow(p);
    // Every free-text field of theirs fails closed; the yes / no facts still come through.
    assert.deepEqual([row.id, row.name, row.company, row.pass.label, row.pass.tier, row.passCount], [p.id, NO_NAME, MASK, MASK, "connect", 1]);
    // Everyone else is untouched, and the list, its sort and the word search still answer.
    assert.equal(volunteerList(people, { sort: "company" }).list.length, people.length);
    assert.deepEqual(volunteerList(people, { q: "mara" }).list.map((x) => x.name), ["Mara Delegate"]);
    assert.equal(volunteerRow(people.find((x) => x.name === "Mara Delegate")).company, "Example Bank");
    // A record that breaks the row itself: only that row is empty.
    const broken = { id: "u-broken", get passList() { throw new Error("secret-pass"); } };
    assert.deepEqual([volunteerRow(broken).id, volunteerRow(broken).name, volunteerRow(broken).pass], ["u-broken", NO_NAME, null]);
    assert.deepEqual(Object.keys(volunteerRow(broken)).sort(), Object.keys(volunteerRow({ id: "u-ok", name: "Ok" })).sort());
    const prof = volunteerProfile(broken);
    assert.deepEqual([prof.passes, prof.sessions, prof.rsvp.accessibility], [[], [], false]);
  } finally {
    console.error = orig;
  }
  assert.ok(logged.length >= 1, "reported");
  for (const l of logged) assert.doesNotMatch(l, /secret-|example\.com|@/, l);
  // The u flag: literals with every special character still make a valid pattern.
  for (const lit of ["mary-jane", "a.b*c?(d)[e]{f}|g^h$i\\j/k+l-m", "o'brien+ttfc", "zoë.ünï-code", "BOOTH-GOLD-7", "#!%&=~`@\"<>,;:"]) {
    assert.doesNotThrow(() => new RegExp(`(?:${escapeRx(lit)})`, "giu"), lit);
    assert.ok(new RegExp(`^(?:${escapeRx(lit)})$`, "iu").test(lit), lit);
  }
});

/* ---------- Links, Stripe IDs, coupon codes and written-out emails in free text (the third round of testing) ---------- */

const MORE = {
  slug: "olga-secret-li", liUrl: "https://www.linkedin.com/in/olga-secret-li/", liBare: "linkedin.com/in/olga-secret-li",
  stripe: "cs_test_secretsession", pi: "pi_3MtwBwLkdIwHu7ix28a3tqPa", ch: "ch_3N1a2b3c4d5e6f",
  code: "SECRETCODE20", code2: "SPRINGSALE", own: "MYCODE10", priyaDomain: "priyamail.example.com", priyaLocal: "priya.secret",
};
function moreWorld() {
  const users = [
    { _id: "u30", name: "Olga Linked", email: "olga.linked@example.com", role: "user", organization: MORE.liBare, jobTitle: MORE.liUrl,
      linkedinUrl: MORE.liUrl, tickets: [] },
    { _id: "u31", name: "Tia Tester", email: "tia.t@example.com", role: "user", jobTitle: `Order ${MORE.stripe}`, organization: `Paid ${MORE.pi} / ${MORE.ch}`,
      tickets: [{ ticketId: "ab34ab34ab34", type: "connect", purchaseDate: d("10-04"), stripeSessionId: "cs_live_a1B2c3D4e5F6g7", promoCode: MORE.own }] },
    { _id: "u32", name: `Priya ${MORE.priyaLocal} [at] ${MORE.priyaDomain}`, email: `${MORE.priyaLocal}@${MORE.priyaDomain}`, role: "user",
      jobTitle: "Write to jane.doe (at) example (dot) com or jane.doe at example.com", organization: "Engineer at Shopify.com", tickets: [] },
  ];
  const attendees = [
    // A staff-issued pass whose printed name holds a ticket ID and a real coupon code.
    { _id: "a30", name: "Kim Partner", email: "kim.partner@example.com", ticketId: "abcd12340042", ticketType: "connect", promoCode: "ISSUED",
      purchaseDate: d("10-05"), issuedPass: { label: `Partner beefcafe0001 ${MORE.code}` }, details: { jobTitle: "Speaker, Exhibitor lead" } },
  ];
  const rsvps = [
    { _id: "r30", key: "t:abcd12340042", nameKey: "kim partner", firstName: "Kim", lastName: "Partner", email: "kim.partner@example.com", ticketId: "abcd12340042",
      ticketVerified: true, tier: "connect", days: ["day1"], options: [], dietary: ["other"],
      dietaryOther: `No nuts. Use code ${MORE.code2.toLowerCase()} or ${MORE.own}; see www.example.com/menu`, createdAt: d("10-12"), updatedAt: d("10-12") },
  ];
  return buildPeople({ users, attendees, rsvps, promos: [{ code: MORE.code, discount: 20 }, { code: MORE.code2, discount: 10 }] });
}

test("safe text: links (a LinkedIn profile), Stripe IDs, coupon codes and written-out emails are hidden; ordinary text stays", () => {
  const p = { name: "x", email: "olga.linked@example.com", linkedinUrl: MORE.liUrl, passList: [{ ticketId: "beefcafe0001", promoCode: MORE.own, stripeSessionId: "cs_live_a1B2c3D4e5F6g7" }] };
  const t = volunteerText({ codes: [MORE.code, MORE.code2, "SPEAKER", "ab"] });
  // Links.
  for (const v of [MORE.liUrl, MORE.liBare, "www.linkedin.com/in/someone-else", "http://example.com/profile", "lnkd.in/abc123", "ftp://files.example.org/x"]) {
    assert.equal(t.text(v, p), "", v);
  }
  assert.equal(t.text(`Find me: ${MORE.liUrl} (DMs open)`, p), `Find me: ${MASK} (DMs open)`);
  assert.equal(t.text(`See ${MORE.slug} on LinkedIn`, p), `See ${MASK} on LinkedIn`);
  assert.equal(t.name({ ...p, name: `Olga (${MORE.slug})` }), "Olga");
  assert.equal(t.name({ ...p, name: MORE.slug }), NO_NAME);
  // Stripe IDs.
  for (const v of [MORE.stripe, MORE.pi, MORE.ch, "cs_live_a1B2c3D4", "cus_Nabc123def", "in_1MxYz2AbCdEf"]) assert.equal(t.text(`Order ${v}`, p), `Order ${MASK}`, v);
  assert.equal(t.text("Ref cs_live_a1B2c3D4e5F6g7", p), `Ref ${MASK}`);
  // Coupon codes: the directory's and their own, whole words in any case; never the internal markers.
  assert.equal(t.text(`Partner beefcafe0001 ${MORE.code}`, p), `Partner ${MASK}`);
  assert.equal(t.text("use springsale today", p), `use ${MASK} today`);
  assert.equal(t.text(`Code: ${MORE.own.toLowerCase()}`, p), `Code: ${MASK}`);
  assert.equal(safeText(`Code ${MORE.own}`, p), `Code ${MASK}`, "their own codes without the directory's list too");
  assert.equal(t.text(MORE.code, p), "");
  assert.equal(t.name({ ...p, name: `Ann ${MORE.code}` }), "Ann");
  // Written-out emails.
  for (const v of ["priya.secret [at] priyamail.example.com", "jane.doe(at)example(dot)com", "jane.doe at example.com", "jane @ example.com", "jane{at}example.com"]) {
    assert.equal(t.text(`Mail ${v}`, p), `Mail ${MASK}`, v);
  }
  // Ordinary text stays as it is.
  for (const v of ["CEO @ Acme", "Engineer at Shopify.com", "Acme.com", "LinkedIn", "Speaker Pass", "Exhibitor lead", "Head of R&D", "In person, Day 1",
    "in_person", "B.Sc/M.Sc", "Ph.D/MBA", "50/50 Ventures", "Toronto (at heart)", "Class of 2026", "VP, Sales"]) {
    assert.equal(t.text(v, p), v, v);
  }
  // Photo and logo addresses.
  for (const u of [`https://cdn.example.com/${MORE.stripe}.png`, `https://media.example.com/${MORE.liBare}`]) assert.equal(t.url(u, p), "", u);
  assert.equal(t.url("https://cdn.example.com/logo.png", p), "https://cdn.example.com/logo.png");
  // The search text never holds them.
  assert.equal(t.searchText({ ...p, name: "Olga Linked", company: MORE.liBare, jobTitle: `Order ${MORE.stripe} ${MORE.code}` }), "Olga Linked Order");
});

test("links, Stripe IDs, coupon codes and written-out emails: hidden in the volunteer's rows, profile, list search, sort and search box", async () => {
  const { people, byId } = moreWorld();
  const codes = couponCodes({ promos: [{ code: MORE.code }, { code: MORE.code2 }], people });
  assert.deepEqual(codes.sort(), [MORE.code, MORE.own, MORE.code2].sort(), "the Promo list and every code a pass was bought with, never ISSUED");
  const olga = byId.get("u-u30");
  const tia = byId.get("u-u31");
  const priya = byId.get("u-u32");
  const kim = byId.get("t-abcd12340042");
  // Staff see what was typed (unchanged).
  assert.equal(personRow(olga).jobTitle, MORE.liUrl);
  assert.equal(personRow(kim).pass.printedLabel ?? kim.primary.printedLabel, `Partner beefcafe0001 ${MORE.code}`);

  assert.deepEqual([volunteerRow(olga, { codes }).name, volunteerRow(olga, { codes }).company, volunteerRow(olga, { codes }).jobTitle], ["Olga Linked", "", ""]);
  assert.deepEqual([volunteerRow(tia, { codes }).jobTitle, volunteerRow(tia, { codes }).company], [`Order ${MASK}`, `Paid ${MASK}`]);
  assert.equal(volunteerRow(priya, { codes }).name, "Priya");
  assert.equal(volunteerRow(priya, { codes }).jobTitle, `Write to ${MASK} or ${MASK}`);
  assert.equal(volunteerRow(priya, { codes }).company, "Engineer at Shopify.com");
  const kimRow = volunteerRow(kim, { codes });
  assert.equal(kimRow.pass.printedLabel, `Partner ${MASK}`);
  assert.equal(kimRow.jobTitle, "Speaker, Exhibitor lead", "the internal markers ISSUED / SPEAKER / EXHIBITOR never mask words");
  const kimProf = volunteerProfile(kim, { codes });
  assert.equal(kimProf.passes[0].printedLabel, `Partner ${MASK}`);
  assert.equal(kimProf.rsvp.dietaryOther, `No nuts. Use code ${MASK} or ${MASK}; see ${MASK}`);
  const LEAK = [MORE.slug, "linkedin.com", MORE.stripe, MORE.pi, MORE.ch, "cs_live_", MORE.code, MORE.code2, MORE.own, MORE.priyaDomain, MORE.priyaLocal,
    "jane.doe", "beefcafe0001", "www.example.com"];
  for (const p of people) {
    const text = JSON.stringify([volunteerRow(p, { codes }), volunteerProfile(p, { codes })]).toLowerCase();
    for (const s of LEAK) assert.ok(!text.includes(s.toLowerCase()), `${p.id}: ${s}`);
  }

  // The list's word search and sort read the safe text only.
  const ids = (q) => volunteerList(people, { q }, { codes }).list.map((p) => p.id).sort();
  for (const q of ["linkedin", MORE.slug, "olga-secret", "cs_test", "secretsession", "pi_3mtw", MORE.code, "springsale", MORE.own, "priyamail", "priya.secret", "jane.doe", "menu"]) {
    assert.deepEqual(ids(q), [], q);
  }
  assert.deepEqual(ids("olga"), ["u-u30"]);
  assert.deepEqual(ids("shopify"), ["u-u32"]);
  assert.equal(volunteerList(people, { sort: "company" }, { codes }).list.length, people.length);

  // The search box: titles, subtitles (job title, company, pass name) and matching.
  const sources = { directory: async () => ({ people, rsvps: [], promoCodes: codes }) };
  for (const q of ["linkedin", "secretsession", MORE.code, "springsale", "priyamail", MORE.slug]) {
    const out = await runSearch({ q, viewer: { volunteer: true }, sources });
    assert.deepEqual(out.groups, [], q);
  }
  for (const q of ["olga", "tia", "priya", "kim"]) {
    const out = await runSearch({ q, viewer: { volunteer: true }, sources });
    assert.equal(out.groups[0].items.length, 1, q);
    const text = JSON.stringify(out).toLowerCase();
    for (const s of LEAK) assert.ok(!text.includes(s.toLowerCase()), `search ${q}: ${s}`);
  }
  // Staff search: unchanged.
  const staff = await runSearch({ q: "olga", viewer: { management: true }, sources: { ...sources, cms: async () => [], ticketDocs: async () => [] } });
  assert.match(staff.groups.find((g) => g.key === "people").items[0].subtitle, /linkedin\.com\/in\/olga-secret-li/);
});

test("sign-in method: Google and LinkedIn tokens are marked and kept on refresh; only a password sign-in counts as one", () => {
  const u = { _id: "u1", role: "volunteer", password: "hash" };
  assert.deepEqual(tokenClaims(u, VIA_GOOGLE), { id: "u1", role: "volunteer", via: "google" });
  assert.deepEqual(tokenClaims(u, VIA_LINKEDIN), { id: "u1", role: "volunteer", via: "linkedin" });
  assert.deepEqual(tokenClaims(u), { id: "u1", role: "volunteer" });
  assert.deepEqual([cleanVia("google"), cleanVia("linkedin"), cleanVia("password"), cleanVia("apple")], ["google", "linkedin", undefined, undefined]);
  // Staff: Google / LinkedIn still open the admin panel (only the emailed code and a pass ID don't).
  assert.deepEqual([signedInWithoutPassword({ via: "google" }), signedInWithoutPassword({ via: "linkedin" }), signedInWithoutPassword({ via: "email" })], [false, false, true]);
  // The volunteer panel: no claim at all, for an account with a password.
  assert.equal(passwordSignIn({ id: "u1" }, u), true);
  assert.equal(passwordSignIn({ id: "u1" }), true);
  for (const via of ["google", "linkedin", "email", "ticket", "password", "", null]) assert.equal(passwordSignIn({ id: "u1", via }, u), false, String(via));
  assert.equal(passwordSignIn({ id: "u1" }, { role: "volunteer" }), false, "an account without a password can't have signed in with one");
  assert.equal(passwordSignIn(null, u), false);
});
