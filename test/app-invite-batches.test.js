import test from "node:test";
import assert from "node:assert/strict";
import { GROUP_SIZES, SKIP_LABELS, TYPE_SEND_FROM, droppedSummary, pickBatch, planAppInvites, relevantPasses, rolesOf, ticketOf } from "../services/appInvite.js";
import { GIVEN_SHORT, codeOf, codeView, howGot } from "../services/promoCodes.js";

/* The app invite email in groups and to a selection (Oct 20 2026, the organiser: "allow me to send in groups of 10,
   20, 50, 100, and select who i want to send to and to see whether they purchased ticket or alloted ticket").
   Fictional people, example.com. */

// A pass as People builds it (services/people.js): its code worked out from its records.
const pass = (tier, rec = {}, extra = {}) => ({
  ticketId: extra.ticketId || `ai${Math.random().toString(16).slice(2, 12)}`, tier, label: "Pass", hidden: false, status: "paid",
  purchaseDate: new Date("2026-10-01"), code: codeView(codeOf([{ promoCode: "", stripeSessionId: "", type: tier, ...rec }])), ...extra,
});
const bought = (tier = "power", code = "", extra = {}) => pass(tier, { promoCode: code, stripeSessionId: `cs_${Math.random()}` }, extra);
const given = (marker, tier = "power") => pass(tier, { promoCode: marker }, { status: "issued" });
const person = (id, extra = {}) => ({ id, name: `${id} Example`, firstName: id, email: `${id.toLowerCase()}@example.com`, types: [], passList: [], user: null, ...extra });

test("bought or given: the checkout (with the coupon code), each staff-made pass, nothing on record", () => {
  const h = (recs) => howGot(codeView(codeOf(recs, { discounts: new Map([["SPRING20", 20]]) })));
  assert.deepEqual(h([{ promoCode: "SPRING20", stripeSessionId: "cs_1" }]), { how: "bought", group: "bought", label: "Bought · SPRING20", code: "SPRING20", detail: "Bought on the website with SPRING20 · 20% off" });
  assert.equal(h([{ promoCode: "", stripeSessionId: "cs_2" }]).label, "Bought");
  assert.equal(h([{ promoCode: "", stripeSessionId: "cs_2" }]).group, "bought");
  assert.deepEqual(["ISSUED", "COMP", "EXHIBITOR", "SPEAKER"].map((m) => h([{ promoCode: m }]).label), ["Given by staff", "Complimentary", "Exhibitor", "Speaker Pass"]);
  assert.deepEqual(["ISSUED", "COMP", "EXHIBITOR", "SPEAKER"].map((m) => h([{ promoCode: m }]).how), ["issued", "comp", "exhibitor", "speaker"]);
  assert.ok(["ISSUED", "COMP", "EXHIBITOR", "SPEAKER"].every((m) => h([{ promoCode: m }]).group === "given"));
  assert.equal(h([{ promoCode: "EXHIBITOR" }]).detail, "Given by staff · exhibitor");
  // A Speaker Pass with no Stripe payment is staff-made whatever its field says.
  assert.equal(h([{ promoCode: "", type: "speaker" }]).label, "Speaker Pass");
  assert.deepEqual([h([{}]).group, h([{}]).label], ["unknown", "Pass · not recorded"]);
  assert.equal(howGot(null).group, "unknown");
  // Never "Exhibitor Pass".
  assert.ok(!Object.values(GIVEN_SHORT).some((l) => /exhibitor pass/i.test(l)));
});

test("the Ticket column: the most relevant pass, +N for the rest, every pass's group for the filters", () => {
  assert.deepEqual(ticketOf(person("Ana", { passList: [bought("power", "SPRING20")] })), {
    how: "bought", group: "bought", label: "Bought · SPRING20", code: "SPRING20", detail: "Bought on the website with SPRING20",
    pass: "Power Pass", more: 0, groups: ["bought"], all: ["Power Pass · Bought · SPRING20"],
  });
  assert.equal(ticketOf(person("Gus", { passList: [given("ISSUED")] })).label, "Given by staff");
  assert.equal(ticketOf(person("Cat", { passList: [given("COMP", "connect")] })).label, "Complimentary");
  assert.equal(ticketOf(person("Eve", { passList: [given("EXHIBITOR", "connect")] })).label, "Exhibitor");
  assert.equal(ticketOf(person("Sol", { passList: [given("SPEAKER", "speaker")] })).label, "Speaker Pass");
  // A speaker matched by name, no pass yet.
  const sol = ticketOf(person("Sol", { speaker: { name: "Sol" }, types: ["speaker"] }));
  assert.deepEqual([sol.how, sol.group, sol.label, sol.more, sol.groups], ["none", "none", "No ticket", 0, ["none"]]);
  // Several passes: bought before given (whatever the tier), and "+1"; hidden passes and booth orders don't count.
  const two = person("Max", {
    passList: [given("ISSUED", "apex"), bought("connect"), bought("power", "", { hidden: true }), pass("power", { stripeSessionId: "cs_b" }, { ticketId: "BOOTH-GOLD" })],
  });
  const t = ticketOf(two);
  assert.deepEqual([t.label, t.pass, t.more, t.groups, t.all], ["Bought", "Connect Pass", 1, ["bought", "given"], ["Connect Pass · Bought", "Apex Pass · Given by staff"]]);
  assert.deepEqual(rolesOf(two), ["Connect Pass"]); // "At TTFC as" names the same pass
  // A refunded pass comes after a usable one, and says so.
  const ref = ticketOf(person("Ref", { passList: [bought("apex", "SPRING20", { status: "refunded" }), given("COMP", "connect")] }));
  assert.deepEqual([ref.label, ref.all], ["Complimentary", ["Connect Pass · Complimentary", "Apex Pass · Bought · SPRING20 · refunded"]]);
  assert.equal(ticketOf(person("Rf2", { passList: [bought("power", "", { status: "refunded" })] })).label, "Bought · refunded");
  // Of two bought: the bigger, then the newer.
  assert.equal(relevantPasses(person("Two", { passList: [bought("connect"), bought("power")] }))[0].t.tier, "power");
  // A pass without People's code (older callers): worked out from its records.
  assert.equal(ticketOf(person("Old", { passList: [{ ticketId: "x", tier: "power", codeSources: [{ promoCode: "ISSUED" }] }] })).label, "Given by staff");
});

test("rows: the ticket, who can be picked, and who it can go to again (sent over 3 days ago)", () => {
  const now = new Date("2026-10-20T12:00:00Z").getTime();
  const people = [
    person("Ana", { passList: [bought("power", "SPRING20")] }),
    person("Old", { passList: [bought()] }),                                                        // sent 5 days ago
    person("New", { passList: [bought()] }),                                                        // sent yesterday
    person("App", { passList: [given("ISSUED")], user: { role: "user", lastActiveAt: new Date() } }), // uses the app
    person("Uns", { passList: [given("COMP")] }),                                                    // unsubscribed
    person("Sol", { types: ["speaker"], speaker: { name: "Sol" } }),
  ];
  const sends = [
    { email: "old@example.com", status: "sent", sentAt: new Date("2026-10-15T12:00:00Z") },
    { email: "new@example.com", status: "sent", sentAt: new Date("2026-10-19T12:00:00Z") },
  ];
  const p = planAppInvites(people, { sends, optedOut: ["uns@example.com"], now });
  const r = Object.fromEntries(p.rows.map((x) => [x.name.split(" ")[0], x]));
  assert.deepEqual(Object.values(r).map((x) => [x.ticket.label, x.willGet, x.sendAgain, x.canSelect]), [
    ["Bought · SPRING20", true, false, true],
    ["Bought", false, true, true],
    ["Bought", false, false, false],
    ["Given by staff", false, false, false],
    ["Complimentary", false, false, false],
    ["No ticket", true, false, true],
  ]);
  // The switch off: someone using the app can be picked, and someone sent long ago who uses it too.
  const off = planAppInvites(people, { sends, optedOut: ["uns@example.com"], now, skipUsing: false });
  assert.equal(off.rows.find((x) => x.name.startsWith("App")).canSelect, true);
});

test("a group or a selection: kept in the page's order, only who can get it now, the rest dropped with why", () => {
  const now = new Date("2026-10-20T12:00:00Z").getTime();
  const people = ["Ana", "Bea", "Cal", "Dee", "Eli", "Fox"].map((n, i) => person(n, { passList: [i % 2 ? given("ISSUED") : bought()] }));
  people.push(person("Old", { passList: [bought()] }), person("New", { passList: [bought()] }), person("Uns", { passList: [bought()] }));
  const sends = [
    { email: "old@example.com", status: "sent", sentAt: new Date("2026-10-10") },
    { email: "new@example.com", status: "sent", sentAt: new Date("2026-10-20T08:00:00Z") },
  ];
  const plan = planAppInvites(people, { sends, optedOut: ["uns@example.com"], now });

  // Picked by hand: the order kept, case and spaces ignored, repeats once; an address that isn't on the list, someone
  // emailed this morning and someone unsubscribed are dropped; someone sent 10 days ago can go again.
  const sel = pickBatch(plan, ["CAL@example.com ", "ana@example.com", "cal@example.com", "stranger@example.com", "new@example.com", "uns@example.com", "old@example.com", "not an email"], { kind: "selected" });
  assert.deepEqual(sel.todo.map((r) => r.email), ["cal@example.com", "ana@example.com", "old@example.com"]);
  assert.deepEqual(sel.dropped.map((d) => [d.email, d.reason]), [
    ["stranger@example.com", "notListed"], ["new@example.com", "recent"], ["uns@example.com", "unsubscribed"], ["not an email", "notListed"],
  ]);
  assert.equal(sel.dropped[0].label, SKIP_LABELS.notListed);
  assert.equal(sel.dropped[1].label, SKIP_LABELS.recent);

  // "Send next N": only people who'll get it (not sent yet), so someone sent long ago is dropped as already sent.
  const next = pickBatch(plan, ["old@example.com", "bea@example.com"], { kind: "next" });
  assert.deepEqual([next.todo.map((r) => r.email), next.dropped.map((d) => d.reason)], [["bea@example.com"], ["alreadySent"]]);

  // The page's "Bought" filter, then the next 2 in the list's order: what the page sends back, and what goes.
  const shown = plan.rows.filter((r) => r.ticket.groups.includes("bought"));
  const next2 = shown.filter((r) => r.willGet).slice(0, 2).map((r) => r.email);
  assert.deepEqual(next2, ["ana@example.com", "cal@example.com"]);
  assert.deepEqual(pickBatch(plan, next2, { kind: "next" }).todo.map((r) => r.email), next2);
  // Given: Bea, Dee, Fox.
  assert.deepEqual(plan.rows.filter((r) => r.ticket.groups.includes("given") && r.willGet).map((r) => r.firstName), ["Bea", "Dee", "Fox"]);
  assert.deepEqual(pickBatch(plan, [], { kind: "next" }), { todo: [], dropped: [] });
  assert.deepEqual([GROUP_SIZES, TYPE_SEND_FROM], [[10, 20, 50, 100], 50]);
});

test("what was dropped, in a line: counted by why", () => {
  assert.equal(droppedSummary([{ reason: "notListed" }, { reason: "recent" }, { reason: "notListed" }, { reason: "alreadySent" }]), "2 not on the list, 1 emailed in the last 3 days, 1 already sent");
  assert.equal(droppedSummary([]), "");
});
