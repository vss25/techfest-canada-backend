import { test } from "node:test";
import assert from "node:assert/strict";
import { arriveAt, dayPlans, fmtTime, foldLine, sessionInviteIcs, validateContact, validateRunOfShow } from "../services/runOfShow.js";
import { buildSpeakerPassEmail } from "../services/speakerPassEmail.js";
import { buildSessionInvite } from "../services/speakerInvites.js";

const ROS = {
  sessions: [{
    day: 1, start: "09:30", end: "10:00", title: "From Investment to Industrial Capacity", format: "Panel", role: "Panellist",
    lineup: [
      { name: "Dominick Miserandino", role: "Moderator", org: "RTMNexus" },
      { name: "Dennis Darby", role: "Panellist", org: "Canadian Manufacturers & Exporters" },
    ],
  }],
};

test("validateRunOfShow tidies and sorts; rejects bad times", () => {
  const ok = validateRunOfShow({ sessions: [{ ...ROS.sessions[0], day: "2", start: "14:00", end: "14:30" }, ROS.sessions[0]] });
  assert.ok(ok.ok);
  assert.deepEqual(ok.value.sessions.map((s) => `${s.day} ${s.start}`), ["1 09:30", "2 14:00"]);
  assert.equal(validateRunOfShow({ sessions: [{ day: 1, start: "10:00", end: "09:30", title: "x" }] }).ok, false);
  assert.equal(validateRunOfShow({ sessions: [{ day: 3, start: "09:00", end: "09:30", title: "x" }] }).ok, false);
  assert.deepEqual(validateRunOfShow(null), { ok: true, value: null });
  assert.equal(validateContact("handler").value, "handler");
  assert.equal(validateContact("boss").ok, false);
});

test("times: 12-hour labels, mic fitting 30 minutes early", () => {
  assert.equal(fmtTime("09:30"), "9:30 AM");
  assert.equal(fmtTime("12:35"), "12:35 PM");
  assert.equal(fmtTime("17:30"), "5:30 PM");
  assert.equal(arriveAt("09:30"), "09:00");
});

test("dayPlans puts mic fitting and the session among the day's events", () => {
  const [d1, d2] = dayPlans(ROS);
  const titles = d1.items.map((i) => `${i.start} ${i.kind}`);
  assert.deepEqual(titles, ["07:45 anchor", "08:00 anchor", "09:00 micup", "09:30 session", "12:35 anchor", "17:30 anchor"]);
  assert.equal(d2.items.filter((i) => i.kind !== "anchor").length, 0);
});

test("invite .ics: REQUEST, Toronto times in UTC, escaped and folded", () => {
  const ics = sessionInviteIcs({ ticketId: "ABC123", name: "Dennis Darby", session: ROS.sessions[0], to: "jackie@example.com",
    organizer: { name: "Lubna Soni", email: "lubna@thetechfestival.com" }, now: new Date("2026-10-13T12:00:00Z") });
  const flat = ics.replace(/\r\n /g, "");
  assert.match(flat, /METHOD:REQUEST/);
  assert.match(flat, /DTSTART:20261026T130000Z/); // 9:00 AM EDT
  assert.match(flat, /DTEND:20261026T140000Z/);   // 10:00 AM EDT
  assert.match(flat, /UID:ttfc26-abc123-d1-0930@thetechfestival.com/);
  assert.match(flat, /ORGANIZER;CN=Lubna Soni:mailto:lubna@thetechfestival.com/);
  assert.match(flat, /RSVP=TRUE:mailto:jackie@example.com/);
  assert.match(flat, /LOCATION:The Westin Harbour Castle\\, 1 Harbour Square/);
  for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, line);
  assert.equal(foldLine("x".repeat(80)).split("\r\n ").map((l) => l.length).join(","), "75,5");
});

test("pass email: run of show, mic fitting and the assistant note", () => {
  const e = buildSpeakerPassEmail({ name: "Dennis Darby", ticketId: "abc123", runOfShow: ROS, contact: "handler" });
  assert.match(e.subject, /Speaker Pass and run of show/);
  assert.match(e.html, /Your session/);
  assert.match(e.html, /VIP Lounge at least 30 minutes before your session for mic fitting/);
  assert.match(e.html, /Dennis Darby \(you\)/);
  assert.match(e.html, /the contact for <b[^>]*>Dennis Darby<\/b>/);
  assert.match(e.text, /9:00 AM  Mic fitting in the VIP Lounge/);
  const plain = buildSpeakerPassEmail({ name: "Jane Doe", ticketId: "abc123" });
  assert.doesNotMatch(plain.html, /Your session/);
  assert.match(plain.subject, /your Speaker Pass for TTFC 2026$/);
});

test("session invite email carries the .ics", () => {
  const inv = buildSessionInvite({ name: "Dennis Darby", ticketId: "abc123", session: ROS.sessions[0], to: "x@example.com",
    org: { name: "Lubna Soni", email: "lubna@thetechfestival.com" } });
  assert.match(inv.subject, /^Invitation: From Investment/);
  assert.match(inv.ics, /BEGIN:VEVENT/);
  assert.match(inv.text, /9:00 AM  Mic fitting/);
});
