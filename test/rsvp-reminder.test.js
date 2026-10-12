import { test } from "node:test";
import assert from "node:assert/strict";
import { planRecipients } from "../services/attendingCampaign.js";
import {
  REMINDER_COOLDOWN_MS, buildRsvpReminderEmail, planReminders, reminderCounts, rsvpLink, withReminderStatus,
} from "../services/rsvpReminder.js";

const users = [
  { email: "buyer@x.com", name: "Pat Buyer", tickets: [
    { ticketId: "aaa111bbb222", type: "power", details: { firstName: "Pat", lastName: "Buyer" }, purchaseDate: "2026-09-01" },
    { ticketId: "ccc333ddd444", type: "power", details: { firstName: "Sam", lastName: "Colleague" }, purchaseDate: "2026-09-01" },
  ] },
  { email: "done@x.com", name: "Done Person", tickets: [{ ticketId: "eee555fff666", type: "connect", purchaseDate: "2026-09-02" }] },
];
const guests = [
  { email: "old@x.com", name: "Olive Oldform", ticketId: "ggg777hhh888", ticketType: "apex", details: { firstName: "Olive", lastName: "Oldform" } },
];
const rsvps = [
  { ticketId: "EEE555FFF666", firstName: "Done", lastName: "Person" },     // by ticket ID (any case)
  { ticketId: "", firstName: "Olive", lastName: "Oldform" },               // older RSVP: by full name
  { ticketId: "ccc333ddd444", firstName: "Sam", lastName: "Colleague", spam: true }, // spam doesn't count
];

test("planRecipients keeps every ticket on an email", () => {
  const { recipients } = planRecipients({ users, guests });
  const buyer = recipients.find((r) => r.email === "buyer@x.com");
  assert.deepEqual(buyer.tickets.map((t) => t.ticketId).sort(), ["aaa111bbb222", "ccc333ddd444"]);
  assert.equal(buyer.tickets.find((t) => t.ticketId === "ccc333ddd444").firstName, "Sam");
});

test("planReminders leaves out people whose tickets all have an RSVP", () => {
  const { recipients } = planRecipients({ users, guests });
  const { rows, rsvpd } = planReminders(recipients, rsvps);
  assert.deepEqual(rows.map((r) => r.email), ["buyer@x.com"]);
  assert.equal(rows[0].tickets.length, 2);
  assert.equal(rsvpd, 2);
  const once = planReminders(recipients, [...rsvps, { ticketId: "aaa111bbb222" }]).rows[0];
  assert.deepEqual(once.tickets.map((t) => t.ticketId), ["ccc333ddd444"]);
});

test("withReminderStatus: due when never sent, failed, or past the cool-down", () => {
  const now = Date.parse("2026-10-12T12:00:00Z");
  const rows = ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"].map((email) => ({ email, tickets: [{}] }));
  const sends = [
    { email: "b@x.com", status: "sent", sentAt: new Date(now - 60 * 60 * 1000), sends: 1 },
    { email: "c@x.com", status: "sent", sentAt: new Date(now - REMINDER_COOLDOWN_MS - 1), sends: 2 },
    { email: "d@x.com", status: "failed", error: "bounced" },
    { email: "e@x.com", status: "sending" },
  ];
  const out = withReminderStatus(rows, sends, { now });
  assert.deepEqual(out.map((r) => [r.status, r.due]), [["never", true], ["reminded", false], ["reminded", true], ["failed", true], ["sending", false]]);
  assert.equal(out[2].reminders, 2);
  assert.deepEqual(reminderCounts(out, 4), { holders: 9, rsvpd: 4, notRsvpd: 5, due: 3, reminded: 2 });
});

test("rsvpLink puts the ticket and name in the fragment", () => {
  assert.equal(rsvpLink({ ticketId: "abc123", firstName: "José", lastName: "Núñez" }),
    "https://www.thetechfestival.com/rsvp#t=ABC123&fn=Jos%C3%A9&ln=N%C3%BA%C3%B1ez");
});

test("reminder email: one button per open ticket, everything escaped", () => {
  const one = buildRsvpReminderEmail({ firstName: "Pat", lastName: "Buyer", tickets: [{ ticketId: "aaa111", firstName: "Pat", lastName: "Buyer" }] });
  assert.match(one.subject, /^Pat, a quick reminder to RSVP/);
  assert.equal(one.links.length, 1);
  assert.match(one.html, />RSVP Now</);
  const two = buildRsvpReminderEmail({ firstName: "<b>Pat</b>", lastName: "Buyer", tickets: [
    { ticketId: "aaa111", firstName: "Pat", lastName: "Buyer" }, { ticketId: "ccc333", firstName: "Sam", lastName: "Colleague" }] });
  assert.equal(two.links.length, 2);
  assert.match(two.html, /RSVP for Sam Colleague/);
  assert.ok(!two.html.includes("<b>Pat</b>"));
  assert.match(two.text, /Each ticket needs its own RSVP/);
});
