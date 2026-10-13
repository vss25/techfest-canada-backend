import { test } from "node:test";
import assert from "node:assert/strict";
import { passRecipients, passStatus, speakerPassRow, validateSpeakerEmails } from "../services/speakerPasses.js";
import { DEFAULT_COPY, buildSpeakerPassEmail, cleanCopy } from "../services/speakerPassEmail.js";
import { sessionInviteIcs } from "../services/runOfShow.js";

test("validateSpeakerEmails: lists, de-duplicates, rejects bad ones and too many", () => {
  assert.deepEqual(validateSpeakerEmails("A@x.com, b@y.co; a@x.com").list, ["a@x.com", "b@y.co"]);
  assert.deepEqual(validateSpeakerEmails(["c@z.io"]).list, ["c@z.io"]);
  assert.deepEqual(validateSpeakerEmails("").list, []);
  assert.match(validateSpeakerEmails("a@x.com, nope").error, /nope isn't a valid/);
  assert.equal(validateSpeakerEmails("a@a.co,b@b.co,c@c.co", { max: 2 }).ok, false);
  assert.equal(validateSpeakerEmails(42).ok, false);
});

test("several addresses: all are recipients; sent only to that exact list", () => {
  const a = { _id: "1", ticketId: "t", email: "a@x.com", alsoTo: ["ea@x.com"] };
  assert.deepEqual(passRecipients(a), ["a@x.com", "ea@x.com"]);
  assert.equal(passStatus(a), "ready");
  assert.equal(passStatus({ ...a, passEmailSentAt: new Date(), passEmailSentTo: "a@x.com, ea@x.com" }), "sent");
  assert.equal(passStatus({ ...a, passEmailSentAt: new Date(), passEmailSentTo: "a@x.com" }), "ready");
  assert.equal(passStatus({ email: "a@x.com", passEmailSentAt: new Date(), passEmailSentTo: "a@x.com" }), "sent");
  assert.deepEqual(speakerPassRow(a).emails, ["a@x.com", "ea@x.com"]);
});

test("cleanCopy: plain text, limits, paragraphs kept", () => {
  const c = cleanCopy({ subject: "  Hi\u0007 {firstName}  ", message: "Para one\r\n\r\n\r\nPara two  \nline", extra: "x" });
  assert.deepEqual(c, { subject: "Hi {firstName}", message: "Para one\n\nPara two\nline" });
  assert.equal(cleanCopy({ headline: "x".repeat(500) }).headline.length, 200);
});

test("edited wording replaces the built-in text, placeholders filled, escaped", () => {
  const e = buildSpeakerPassEmail({ name: "Dennis Darby", ticketId: "abc", copy: {
    subject: "{firstName}: your TTFC pass", headline: "See you soon, {fullName}", message: "Line <one>\n\nSecond paragraph" } });
  assert.equal(e.subject, "Dennis: your TTFC pass");
  assert.match(e.html, /See you soon, Dennis Darby/);
  assert.match(e.html, /Line &lt;one&gt;/);
  assert.match(e.html, /Second paragraph/);
  assert.doesNotMatch(e.html, /The conversations that shape/);
  assert.match(e.text, /Second paragraph/);
  const plain = buildSpeakerPassEmail({ name: "Dennis Darby", ticketId: "abc" });
  assert.match(plain.html, /The conversations that shape/);
  assert.match(DEFAULT_COPY.subject, /\{firstName\}/);
});

test("invite lists every recipient as an attendee", () => {
  const ics = sessionInviteIcs({ ticketId: "x", name: "A", to: ["a@x.com", "ea@x.com"],
    session: { day: 1, start: "09:30", end: "10:00", title: "T", lineup: [] }, organizer: { name: "L", email: "l@x.co" } })
    .replace(/\r\n /g, "");
  assert.equal((ics.match(/^ATTENDEE/gm) || []).length, 2);
  assert.match(ics, /mailto:ea@x.com/);
});
