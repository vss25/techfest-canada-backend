/* Help & SOS (Oct 22 2026): the pure parts. No database, no network. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanSosRequest, cleanCategory, cleanPhone, cleanBody, attendeeDTO, staffDTO, sortForStaff, isResponder, staffNote, attendeeNote,
  alertRecipients, sosEmail, categoryLabel, STATUS_LABELS,
} from "../services/sos.js";
import { buildWebPayload } from "../services/webPush.js";

const ID = "a".repeat(24);
const r = {
  _id: ID, userId: "b".repeat(24), name: "Ann Attendee", email: "ann@example.com", phone: "+1 416 555 0101", category: "medical",
  location: "Harbour Ballroom", message: "My friend fainted", status: "open", createdAt: new Date("2026-10-26T14:05:00Z"),
  messages: [{ from: "staff", staffId: "c".repeat(24), staffName: "Vic Volunteer", body: "On my way", at: new Date("2026-10-26T14:06:00Z") }],
};

test("the request: a category (key or label), a message, the place and phone tidied", () => {
  assert.deepEqual(cleanSosRequest({ category: "Accessibility help", location: "  Pier 4 &  5 ", message: " Need a wheelchair \r\n now ", phone: "(416) 555-0101 ☎" }),
    { category: "accessibility", location: "Pier 4 & 5", message: "Need a wheelchair \n now", phone: "(416) 555-0101" });
  assert.ok(cleanSosRequest({ category: "", message: "x" }).error);
  assert.ok(cleanSosRequest({ category: "medical", message: "" }).error);
  assert.equal(cleanSosRequest({ category: "medical", message: "x".repeat(2000) }).message.length, 1000);
  assert.equal(cleanCategory("MEDICAL"), "medical");
  assert.equal(cleanPhone("call me"), "");
  assert.equal(cleanBody("  hi\u0007 "), "hi");
  assert.equal(categoryLabel("nope"), "Other urgent");
  assert.deepEqual(STATUS_LABELS, { open: "Sent", acknowledged: "Seen by staff", resolved: "Resolved" });
});

test("what the attendee sees (staff by first name) and what staff see (contact links)", () => {
  const a = attendeeDTO(r);
  assert.deepEqual([a.id, a.categoryLabel, a.statusLabel, a.messages[0].staffName], [ID, "Medical", "Sent", "Vic"]);
  assert.equal("email" in a || "userId" in a, false);
  const s = staffDTO(r);
  assert.deepEqual(s.links, { app: `/app/staff/sos/${ID}`, tel: "tel:+14165550101", mailto: "mailto:ann@example.com" });
  assert.equal(s.messages[0].staffName, "Vic Volunteer");
  assert.deepEqual(sortForStaff([{ status: "resolved", createdAt: 3 }, { status: "open", createdAt: 1 }, { status: "acknowledged", createdAt: 2 }, { status: "open", createdAt: 5 }])
    .map((x) => `${x.status}${x.createdAt}`), ["open5", "open1", "acknowledged2", "resolved3"]);
});

test("who answers: staff accounts and the moderate right", () => {
  assert.equal(isResponder({ role: "admin" }, {}), true);
  assert.equal(isResponder({ role: "volunteer" }, { moderate: true }), true);
  assert.equal(isResponder({ role: "volunteer" }, { moderate: false }), false);
  assert.equal(isResponder({ role: "user" }, {}), false);
});

test("pushes: kind sos, the staff inbox or the attendee's Help screen, collapsed per request", () => {
  const n = staffNote(r);
  assert.deepEqual([n.kind, n.thread, n.url, n.title, n.body], ["sos", `sos.${ID}`, `/app/staff/sos/${ID}`, "SOS: Medical", "Ann Attendee · Harbour Ballroom: My friend fainted"]);
  assert.equal(staffNote(r, { followUp: true, body: "Still here" }).title, "SOS: new message from Ann Attendee");
  const b = attendeeNote(r, { staffName: "Vic Volunteer", body: "On my way" });
  assert.deepEqual([b.title, b.url], ["Vic (TTFC staff) replied", "/app/help"]);
  // The web push carries the route the sender chose.
  assert.equal(buildWebPayload(n).url, `/app/staff/sos/${ID}`);
  assert.equal(buildWebPayload({ ...n, url: "https://evil.example.com/" }).url, "/app/");
});

test("the alert email: SOS_ALERT_TO (default enquire@), every detail, the inbox link", () => {
  assert.deepEqual(alertRecipients({}), ["enquire@thetechfestival.com"]);
  assert.deepEqual(alertRecipients({ SOS_ALERT_TO: "a@example.com, b@example.com,a@example.com, not-an-email" }), ["a@example.com", "b@example.com"]);
  const e = sosEmail({ ...r, message: "<script>x</script>" }, { base: "https://www.thetechfestival.com/" });
  assert.equal(e.subject, "SOS (Medical) from Ann Attendee");
  assert.equal(e.link, `https://www.thetechfestival.com/app/staff/sos/${ID}`);
  assert.equal(e.html.includes("<script>"), false);
  for (const v of ["Ann Attendee", "+1 416 555 0101", "ann@example.com", "Harbour Ballroom", "Medical"]) assert.ok(e.html.includes(v), v);
  assert.match(e.text, /Message: <script>x<\/script>/);
});
