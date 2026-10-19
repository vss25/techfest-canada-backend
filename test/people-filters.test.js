import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPeople, personRow, personDetail, filterPeople, sortPeople, peopleCounts, ticketValue, valueBand, stripeMaps,
  planPeopleReminders, rsvpRulesFor, VALUE_BAND_LABELS, RSVP_STATUS_LABELS, SPEAKER_RSVP_LINK_FROM,
} from "../services/people.js";
import { campaignSendStore, makeReminderSender, reminderJob, REMINDER_CAMPAIGN } from "../services/rsvpReminder.js";
import { planVipMigration, migrateVipTypeOnce, MIGRATION_KEY } from "../services/vipFlag.js";

/* Admin → People filters (Oct 19 2026): ticket value after payment, RSVP status, RSVP email sent,
   VIP, and the "Send RSVP reminder" targeting. Fictional people, example.com addresses. */

const d = (s) => new Date(`2026-${s}Z`);
const names = (list) => list.map((p) => p.name).sort();
const by = (people, name) => people.find((p) => p.name === name);

function world() {
  const users = [
    // Paid $749 for Connect on the account, nothing refunded.
    { _id: "u1", name: "Ava Paid", email: "ava@example.com", role: "user", tickets: [{ ticketId: "PAID01", type: "connect", stripeSessionId: "cs_paid" }] },
    // Influence bought with a big discount: $95 before HST.
    { _id: "u2", name: "Ben Discount", email: "ben@example.com", role: "user", tickets: [{ ticketId: "DISC01", type: "influence", stripeSessionId: "cs_disc", promoCode: "PARTNER90" }] },
    // Exactly 100.00 → above.
    { _id: "u3", name: "Cy Hundred", email: "cy@example.com", role: "user", tickets: [{ ticketId: "HUND01", type: "connect", stripeSessionId: "cs_100" }] },
    // A 100% code: Stripe completed it with no payment.
    { _id: "u4", name: "Di Free", email: "di@example.com", role: "user", tickets: [{ ticketId: "FREE01", type: "power", stripeSessionId: "cs_free", promoCode: "FULLCOMP" }] },
    // A ticket with no Stripe session we can find: value unknown.
    { _id: "u5", name: "Eli Unknown", email: "eli@example.com", role: "user", tickets: [{ ticketId: "UNKN01", type: "connect" }] },
    // Influence for $90, then a paid upgrade of $40 → $130.
    { _id: "u6", name: "Flo Upgrade", email: "flo@example.com", role: "user", tickets: [{ ticketId: "UPGR01", type: "power", stripeSessionId: "cs_up0" }] },
    // No ticket: neither band.
    { _id: "u7", name: "Gus Nopass", email: "gus@example.com", role: "user", tickets: [] },
    // Staff switched VIP off on the account, though a pass of theirs says VIP.
    { _id: "u8", name: "Hal Notvip", email: "hal@example.com", role: "user", vip: false, tickets: [{ ticketId: "HALV01", type: "apex", promoCode: "COMP" }] },
    // Banned account, Unconfirmed.
    { _id: "u9", name: "Ivy Banned", email: "ivy@example.com", role: "user", banned: true, tickets: [{ ticketId: "BANN01", type: "connect", promoCode: "COMP" }] },
    // Old stored VIP type (before the migration ran): still a VIP.
    { _id: "u10", name: "Jo Legacy", email: "jo@example.com", role: "user", types: ["vip"], tickets: [{ ticketId: "LEGA01", type: "connect", promoCode: "COMP" }] },
  ];
  const attendees = [
    // Speaker Pass emailed after the RSVP button existed → RSVP email sent.
    { _id: "a1", name: "Kai Speaker", email: "kai@example.com", ticketId: "SPKR01", ticketType: "speaker", promoCode: "SPEAKER", passEmailSentAt: d("10-14T15:00:00") },
    // Speaker Pass emailed in the hour before the RSVP button: not counted.
    { _id: "a2", name: "Lea Early", email: "lea@example.com", ticketId: "SPKR02", ticketType: "speaker", promoCode: "SPEAKER", passEmailSentAt: d("10-12T01:30:00") },
    // Issued pass emailed with the RSVP button switched off.
    { _id: "a3", name: "Max Norsvp", email: "max@example.com", ticketId: "ISSU01", ticketType: "power", promoCode: "ISSUED", passEmailSentAt: d("10-15T12:00:00"), issuedPass: { rsvp: false } },
    // Issued pass emailed with the button (recorded at send time).
    { _id: "a4", name: "Nia Issued", email: "nia@example.com", ticketId: "ISSU02", ticketType: "power", promoCode: "ISSUED", passEmailSentAt: d("10-16T12:00:00"), passEmailRsvp: true },
    // Pass-only VIP (staff switched it on the pass).
    { _id: "a5", name: "Oli Passvip", email: "oli@example.com", ticketId: "PVIP01", ticketType: "connect", promoCode: "COMP", vip: true },
    // Hal's claimed pass carries a VIP mark; his account switch says No.
    { _id: "a6", name: "Hal Notvip", email: "hal@example.com", ticketId: "HALV01", ticketType: "apex", promoCode: "COMP", vip: true, claimedBy: "u8" },
    // A speaker nudged (reminder to RSVP), pass email never recorded.
    { _id: "a7", name: "Pia Nudged", email: "pia@example.com", ticketId: "SPKR03", ticketType: "speaker", promoCode: "SPEAKER", speakerNudgedAt: d("10-17T10:00:00") },
    // A guest pass under Ava's address but for her colleague Quin (checkout name): their own person.
    { _id: "a8", name: "Quin Colleague", email: "ava@example.com", ticketId: "COLL01", ticketType: "connect", stripeSessionId: "cs_coll",
      details: { firstName: "Quin", lastName: "Colleague" } },
    // Unsubscribed from our emails.
    { _id: "a9", name: "Ray Optout", email: "ray@example.com", ticketId: "OPTO01", ticketType: "connect", promoCode: "COMP" },
    // No email at all (a Speaker Pass waiting for one).
    { _id: "a10", name: "Sol Noemail", email: "", ticketId: "SPKR04", ticketType: "speaker", promoCode: "SPEAKER" },
  ];
  const rsvps = [
    { _id: "r1", key: "t:paid01", nameKey: "ava paid", firstName: "Ava", lastName: "Paid", ticketId: "PAID01", ticketVerified: true, tier: "connect", tierVerified: true,
      days: ["day1"], options: [], createdAt: d("10-10T10:00:00"), updatedAt: d("10-10T10:00:00"), attendeeSubmittedAt: d("10-10T10:00:00") },
    { _id: "r2", key: "t:disc01", nameKey: "ben discount", firstName: "Ben", lastName: "Discount", ticketId: "DISC01", ticketVerified: true, tier: "influence", tierVerified: true,
      source: "staff", staffUpdatedBy: "Nicole Staff", staffUpdatedAt: d("10-11T10:00:00"), days: ["day2"], options: ["gala"], staffAdded: ["gala"], passLimitOverride: true,
      createdAt: d("10-11T10:00:00"), updatedAt: d("10-11T10:00:00") },
  ];
  const stripe = stripeMaps({
    rows: [
      { id: "cs_paid", category: "tickets", total: 846.37, refunded: 0, revenue: 749 },
      { id: "cs_disc", category: "tickets", total: 107.35, refunded: 0, revenue: 95 },
      { id: "cs_100", category: "tickets", total: 113, refunded: 0, revenue: 100 },
      { id: "cs_up0", category: "tickets", total: 101.7, refunded: 0, revenue: 90 },
      { id: "cs_up1", category: "upgrades", total: 45.2, refunded: 0, revenue: 40, upgradeFrom: "UPGR01" },
      { id: "cs_coll", category: "tickets", total: 846.37, refunded: 0, revenue: 749 },
    ],
    free: ["cs_free"],
  });
  const reminders = [{ email: "ben@example.com", sentAt: d("10-18T09:00:00") }];
  return { users, attendees, rsvps, refunds: stripe.refunds, stripe: stripe.values, reminders };
}

/* ---------- Ticket value after payment ---------- */

test("ticket value: paid after promo codes (before HST), upgrades added, staff-made and $0 checkouts are 0, unknown is neither", () => {
  const { people } = buildPeople(world());
  const v = (n) => by(people, n).primary?.value;
  assert.deepEqual([v("Ava Paid"), v("Ben Discount"), v("Cy Hundred"), v("Di Free"), v("Eli Unknown"), v("Flo Upgrade")], [749, 95, 100, 0, null, 130]);
  assert.deepEqual([v("Kai Speaker"), v("Max Norsvp"), v("Oli Passvip")], [0, 0, 0]); // Speaker Pass, issued, comp
  const band = (n) => personRow(by(people, n)).valueBand;
  assert.deepEqual([band("Ava Paid"), band("Ben Discount"), band("Cy Hundred"), band("Di Free"), band("Eli Unknown"), band("Gus Nopass"), band("Flo Upgrade")],
    ["above", "below", "above", "below", "unknown", "none", "above"]);
  assert.equal(VALUE_BAND_LABELS.below, "Below 100 CAD");
  assert.equal(VALUE_BAND_LABELS.above, "Above 100 CAD");
  assert.deepEqual([valueBand(99.99), valueBand(100), valueBand(0), valueBand(null)], ["below", "above", "below", "unknown"]);
  // Filters: unknown values and people with no pass match neither band.
  const below = names(filterPeople(people, { value: "below" }));
  const above = names(filterPeople(people, { value: "above" }));
  assert.ok(below.includes("Ben Discount") && below.includes("Di Free") && below.includes("Kai Speaker"));
  assert.deepEqual(above, ["Ava Paid", "Cy Hundred", "Flo Upgrade", "Quin Colleague"]);
  for (const n of ["Eli Unknown", "Gus Nopass"]) assert.ok(!below.includes(n) && !above.includes(n), n);
  const c = peopleCounts(people);
  assert.deepEqual([c.byValue.above, c.byValue.unknown, c.byValue.none], [4, 1, 1]);
  // Sorting by value puts unknown last.
  assert.equal(sortPeople(people, "value", "desc")[0].name, "Ava Paid");
  // Without Stripe a bought ticket has no value; staff-made ones are still 0.
  const off = buildPeople({ ...world(), stripe: null }).people;
  assert.deepEqual([by(off, "Ava Paid").primary.value, by(off, "Kai Speaker").primary.value], [null, 0]);
  // Two tickets on one session never count the payment twice.
  assert.equal(ticketValue({ stripeSessionId: "s", ticketId: "t" }, { paid: new Map([["s", 200]]), shared: new Map([["s", 2]]) }), 100);
});

test("ticket value: only management sees the amount on the profile; everyone sees the band", () => {
  const { people } = buildPeople(world());
  const ava = by(people, "Ava Paid");
  assert.equal(personDetail(ava, { management: true }).passes[0].value, 749);
  assert.equal("value" in personDetail(ava, { management: false }).passes[0], false);
  assert.equal(personDetail(ava, { management: false }).passes[0].valueBand, "above");
  assert.equal("value" in personRow(ava), false);
});

test("stripeMaps: refunds, ticket payments, $0 sessions and upgrades by ticket", () => {
  const m = stripeMaps({ rows: [{ id: "a", category: "tickets", total: 10, refunded: 1, revenue: 8 }, { id: "b", category: "upgrades", revenue: 5, upgradeFrom: "ABC 123" }, { id: "c", category: "booths", revenue: 999 }], free: ["z"] });
  assert.deepEqual(m.refunds.get("a"), { total: 10, refunded: 1 });
  assert.equal(m.values.paid.get("a"), 8);
  assert.equal(m.values.paid.has("c"), false); // booths aren't passes
  assert.equal(m.values.upgrades.get("abc123"), 5);
  assert.ok(m.values.free.has("z"));
});

/* ---------- RSVP status ---------- */

test("RSVP status: Confirmed by Individual, Confirmed by Staff, Unconfirmed", () => {
  const { people } = buildPeople(world());
  assert.deepEqual(RSVP_STATUS_LABELS, { none: "Unconfirmed", attendee: "Confirmed by Individual", staff: "Confirmed by Staff" });
  assert.deepEqual(names(filterPeople(people, { rsvp: "attendee" })), ["Ava Paid"]);
  assert.deepEqual(names(filterPeople(people, { rsvp: "staff" })), ["Ben Discount"]);
  assert.equal(filterPeople(people, { rsvp: "none" }).length, people.length - 2);
  const ben = personRow(by(people, "Ben Discount"));
  assert.deepEqual([ben.rsvp.label, ben.rsvp.by, ben.rsvp.staffAdded], ["Confirmed by Staff", "Nicole Staff", ["gala"]]);
});

/* ---------- RSVP email sent ---------- */

test("RSVP email sent: pass emails with the RSVP button, speaker reminders and RSVP reminders; nothing guessed", () => {
  const { people } = buildPeople(world());
  const sent = (n) => personRow(by(people, n)).rsvpEmail;
  assert.deepEqual([sent("Kai Speaker").sent, sent("Kai Speaker").via], [true, ["Speaker Pass email"]]);
  assert.equal(sent("Lea Early").sent, false); // sent before the Speaker Pass email had the RSVP button
  assert.ok(d("10-12T01:30:00") < SPEAKER_RSVP_LINK_FROM);
  assert.equal(sent("Max Norsvp").sent, false); // issued pass emailed without the RSVP button
  assert.deepEqual([sent("Nia Issued").sent, sent("Nia Issued").via], [true, ["Pass email"]]);
  assert.deepEqual([sent("Pia Nudged").sent, sent("Pia Nudged").via], [true, ["Speaker reminder"]]);
  assert.deepEqual([sent("Ben Discount").sent, sent("Ben Discount").via, String(sent("Ben Discount").at)], [true, ["RSVP reminder"], String(d("10-18T09:00:00"))]);
  for (const n of ["Ava Paid", "Gus Nopass", "Oli Passvip"]) assert.equal(sent(n).sent, false, n); // the purchase email has no RSVP link
  // Older issued passes (before passEmailRsvp was recorded) follow the pass's RSVP setting.
  const w = world();
  w.attendees.push({ _id: "a20", name: "Old Issued", email: "old@example.com", ticketId: "ISSU09", ticketType: "influence", promoCode: "ISSUED", passEmailSentAt: d("10-14T12:00:00") });
  assert.equal(personRow(by(buildPeople(w).people, "Old Issued")).rsvpEmail.sent, true);
  const yes = names(filterPeople(people, { rsvpEmail: "yes" }));
  assert.deepEqual(yes, ["Ben Discount", "Kai Speaker", "Nia Issued", "Pia Nudged"]);
  assert.equal(filterPeople(people, { rsvpEmail: "no" }).length, people.length - 4);
  assert.equal(peopleCounts(people).rsvpEmailSent, 4);
});

/* ---------- VIP ---------- */

test("VIP: the account's switch, else a VIP pass; pass-only people by their passes; an old VIP type still counts", () => {
  const { people } = buildPeople(world());
  const vip = (n) => [by(people, n).vip, by(people, n).vipFrom];
  assert.deepEqual(vip("Oli Passvip"), [true, "pass"]);
  assert.deepEqual(vip("Hal Notvip"), [false, ""]); // staff's account switch beats the pass mark
  assert.deepEqual(vip("Jo Legacy"), [true, "account"]);
  assert.deepEqual(vip("Ava Paid"), [false, ""]);
  assert.deepEqual(by(people, "Jo Legacy").types, ["attendee"]); // "vip" is no type any more
  assert.deepEqual(names(filterPeople(people, { vip: "yes" })), ["Jo Legacy", "Oli Passvip"]);
  assert.equal(peopleCounts(people).vips, 2);
  assert.equal(personRow(by(people, "Oli Passvip")).vip, true);
  assert.equal(personDetail(by(people, "Oli Passvip")).edit.canEditVip, true);
  // Combined filters are ANDed.
  assert.deepEqual(names(filterPeople(people, { vip: "yes", value: "below" })), ["Jo Legacy", "Oli Passvip"]);
  assert.deepEqual(names(filterPeople(people, { vip: "yes", rsvpEmail: "yes" })), []);
});

test("VIP migration: the VIP type becomes VIP Yes, leaves type lists and the rights matrix", async () => {
  const plan = planVipMigration([
    { _id: "1", types: ["vip"], typesOff: [] },
    { _id: "2", types: ["vip", "speaker"], typesOff: ["vip"] }, // switched off: not a VIP
    { _id: "3", types: ["attendee"], typesOff: ["vip"] },
    { _id: "4", types: ["VIP"], vip: false },                   // staff already set the switch: kept
  ]);
  assert.deepEqual(plan, { makeVip: ["1"], cleanOnly: ["2", "3", "4"], keptOwnFlag: 1 });

  const users = [
    { _id: "1", types: ["vip"], typesOff: [] }, { _id: "2", types: ["vip", "speaker"], typesOff: ["vip"] },
    { _id: "3", types: ["attendee"], typesOff: [] },
  ];
  const content = [{ key: "app.rights", value: { attendee: { post: true }, vip: { post: false } } }];
  const audits = [];
  const matches = (u, f) => (f.$or || []).some((c) => Object.entries(c).some(([k, rx]) => (u[k] || []).some((t) => rx.test(t))));
  const User = {
    find(f) { return { select: () => ({ lean: async () => users.filter((u) => matches(u, f)).map((u) => ({ ...u })) }) }; },
    async updateMany(f, upd) {
      let n = 0;
      for (const u of users) {
        if (!f._id.$in.includes(u._id)) continue;
        if (f.vip?.$exists === false && "vip" in u) continue;
        if (upd.$set) { Object.assign(u, upd.$set); n++; }
        if (upd.$pull) { for (const [k, rx] of Object.entries(upd.$pull)) u[k] = (u[k] || []).filter((t) => !rx.test(t)); n++; }
      }
      return { modifiedCount: n };
    },
  };
  const AppContent = {
    async exists(f) { return content.some((c) => c.key === f.key); },
    findOne(f) { return { lean: async () => content.find((c) => c.key === f.key) || null }; },
    async updateOne(f, upd) { const c = content.find((x) => x.key === f.key); if (upd.$unset) for (const k of Object.keys(upd.$unset)) delete c.value[k.split(".")[1]]; },
    async create(doc) { content.push(doc); },
  };
  const AdminAudit = { async create(doc) { audits.push(doc); } };
  let done = 0;
  const out = await migrateVipTypeOnce({ User, AppContent, AdminAudit, log: { log() {}, error() {} }, onDone: () => { done++; } });
  assert.deepEqual([out.vipYes, out.typesCleaned, out.rightsColumnRemoved], [1, 2, true]);
  assert.deepEqual(users.map((u) => [u.types, u.typesOff, u.vip]), [[[], [], true], [["speaker"], [], undefined], [["attendee"], [], undefined]]);
  assert.deepEqual(Object.keys(content[0].value), ["attendee"]);
  assert.equal(audits[0].action, "vip_migration");
  assert.match(audits[0].detail, /1 people with the VIP type set to VIP Yes/);
  assert.equal(done, 1);
  // Runs once.
  assert.equal(await migrateVipTypeOnce({ User, AppContent, AdminAudit, log: { log() {}, error() {} } }), null);
  assert.ok(content.some((c) => c.key === MIGRATION_KEY));
});

/* ---------- Send RSVP reminder (targeting) ---------- */

test("reminder targeting: Unconfirmed people with a usable email and a pass; everyone else listed with the reason", () => {
  const w = world();
  const { people } = buildPeople(w);
  const sends = [
    { email: "eli@example.com", status: "sent", sentAt: new Date(Date.now() - 2 * 3600 * 1000) },  // reminded 2 hours ago
    { email: "cy@example.com", status: "sent", sentAt: new Date(Date.now() - 30 * 3600 * 1000) },  // 30 hours ago: due again
    { email: "flo@example.com", status: "sending" },
  ];
  const plan = planPeopleReminders(people, { rsvps: w.rsvps, optedOut: ["ray@example.com"], sends });
  const reason = Object.fromEntries(plan.skipped.map((s) => [s.name, s.reason]));
  assert.deepEqual(reason, {
    "Gus Nopass": "noPass", "Ivy Banned": "banned", "Ray Optout": "unsubscribed", "Sol Noemail": "noEmail",
    "Eli Unknown": "reminded", "Flo Upgrade": "sending",
  });
  assert.equal(plan.counts.confirmed, 2); // Ava and Ben have an RSVP
  // Quin's pass is under Ava's address: one email to ava@ with Quin's button only (Ava's own ticket has an RSVP).
  const ava = plan.targets.find((t) => t.email === "ava@example.com");
  assert.deepEqual(ava.tickets.map((t) => [t.ticketId, t.firstName, t.lastName]), [["COLL01", "Quin", "Colleague"]]);
  assert.deepEqual(ava.people.map((p) => p.name), ["Quin Colleague"]);
  assert.ok(plan.targets.some((t) => t.email === "cy@example.com"));
  assert.equal(plan.counts.emails, plan.targets.length);
  assert.equal(plan.counts.skipped, 6);
  assert.equal(plan.skipped.find((s) => s.reason === "noPass").label, "No pass, so no RSVP link");
  // The current filters decide who's considered at all.
  const vipOnly = planPeopleReminders(filterPeople(people, { vip: "yes" }), { rsvps: w.rsvps });
  assert.deepEqual(vipOnly.targets.map((t) => t.email).sort(), ["jo@example.com", "oli@example.com"]);
  // Two people on one address: one email, a button each.
  const pair = buildPeople({ ...w, attendees: [...w.attendees, { _id: "a30", name: "Tia Twin", email: "oli@example.com", ticketId: "TWIN01", ticketType: "connect", promoCode: "COMP", details: { firstName: "Tia", lastName: "Twin" } }] }).people;
  const both = planPeopleReminders(filterPeople(pair, { q: "oli@example.com" }), { rsvps: w.rsvps });
  assert.equal(both.targets.length, 1);
  assert.deepEqual(both.targets[0].tickets.map((t) => t.ticketId).sort(), ["PVIP01", "TWIN01"]);
});

test("reminder sending: claimed once per address, stubbed sender only, failures recorded, cool-down respected", async () => {
  const rows = new Map();
  const CampaignSend = {
    async updateOne(f, upd) {
      const r = rows.get(f.email);
      if (!r || r.campaign !== f.campaign) return { matchedCount: 0 };
      if (f.$or) {
        const cut = f.$or[1].$or[0].sentAt.$lt;
        const ok = r.status === "failed" || (r.status === "sent" && (!r.sentAt || r.sentAt < cut));
        if (!ok) return { matchedCount: 0 };
      }
      Object.assign(r, upd.$set || {});
      for (const [k, n] of Object.entries(upd.$inc || {})) r[k] = (r[k] || 0) + n;
      return { matchedCount: 1 };
    },
    async create(doc) {
      if (rows.has(doc.email)) { const e = new Error("dup"); e.code = 11000; throw e; }
      rows.set(doc.email, { ...doc });
    },
  };
  const sent = [];
  let fail = false;
  const send = async ({ to, row }) => { if (fail) throw new Error("Resend said no"); sent.push([to, row.tickets.length]); return { id: `re_${sent.length}` }; };
  const sendTo = makeReminderSender({ store: campaignSendStore(CampaignSend), send });
  const target = { email: "zed@example.com", name: "Zed Test", firstName: "Zed", lastName: "Test", tickets: [{ ticketId: "ZED001", firstName: "Zed", lastName: "Test" }] };
  const at = await sendTo(target, "staff@example.com");
  assert.ok(at instanceof Date);
  assert.deepEqual(sent, [["zed@example.com", 1]]);
  assert.deepEqual([rows.get("zed@example.com").status, rows.get("zed@example.com").sends, rows.get("zed@example.com").campaign], ["sent", 1, REMINDER_CAMPAIGN]);
  // Again straight away: inside the cool-down, nothing goes.
  assert.equal(await sendTo(target, "staff@example.com"), "skipped");
  assert.equal(sent.length, 1);
  // A failure is recorded and retried next time.
  fail = true;
  await assert.rejects(sendTo({ ...target, email: "fail@example.com" }, "x"), /Resend said no/);
  assert.deepEqual([rows.get("fail@example.com").status, rows.get("fail@example.com").error], ["failed", "Resend said no"]);
  fail = false;
  assert.ok((await sendTo({ ...target, email: "fail@example.com" }, "x")) instanceof Date);
  // One run at a time, whichever page started it.
  reminderJob.start("Nicole", "people", 3);
  assert.deepEqual([reminderJob.view().running, reminderJob.view().from, reminderJob.view().total], [true, "people", 3]);
  reminderJob.finish();
  assert.equal(reminderJob.view().running, false);
});

test("RSVP rules for staff: the main pass's CxO switch, the speaker type without a pass, breakfasts already chosen", () => {
  const { people } = buildPeople(world());
  // `extras`: every pass extra of the main pass (Oct 19 2026: luncheons, Gala, Awards next to the CxO Breakfasts).
  const connect = { cxo: false, lunch: false, gala: false, awards: false };
  assert.deepEqual(rsvpRulesFor(by(people, "Ava Paid")), { cxo: false, extras: connect, extra: [], speaker: false });
  assert.deepEqual(rsvpRulesFor(by(people, "Kai Speaker")), { cxo: true, extras: { cxo: true, lunch: true, gala: true, awards: true }, extra: [], speaker: true });
  assert.deepEqual(rsvpRulesFor(by(people, "Gus Nopass")), { cxo: undefined, extras: undefined, extra: [], speaker: false });
});
