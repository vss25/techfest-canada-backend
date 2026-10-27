/* Scheduled broadcasts (Oct 27 2026): the rules (services/scheduledBroadcastRules.js). Pure: no database, nothing is
   sent. The routes, the job and the send: test/scheduled-broadcasts-db.test.js. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QUIET_HOURS, MIN_LEAD_MS, MISSED_AFTER_MS, ERRORS, CHUNK, torontoClock, inQuietHours, parseSendAt, validateScheduled,
  isMissed, batchIdOf, chunks, scheduledDTO, auditLine,
} from "../services/scheduledBroadcastRules.js";

const NOON = new Date("2026-10-27T16:00:00Z");   // Day 2, noon in Toronto (EDT, UTC-4)
const GOOD = {
  sendAt: "2026-10-27T19:00:00-04:00", title: "Thank you for coming", body: "TTFC 2026 has ended, but keep using the app for networking. See you in 2027",
  linkUrl: "https://www.thetechfestival.com/stay-updated", feedPost: true, banner: false, notify: true, audience: "app",
};
const v = (patch, opts = {}) => validateScheduled({ ...GOOD, ...patch }, { now: NOON, ...opts });
const field = (patch, opts) => { const r = v(patch, opts); return [r.field, r.error]; };

test("the quiet hours: 22:00 to 08:00 on Toronto's own clock, EDT before Nov 1 and EST after", () => {
  assert.deepEqual(QUIET_HOURS, { from: "22:00", to: "08:00", tz: "America/Toronto" });
  // Oct 27 2026 is EDT (UTC-4).
  assert.deepEqual(torontoClock(new Date("2026-10-27T23:00:00Z")), { hour: 19, minute: 0 });
  assert.equal(inQuietHours(new Date("2026-10-28T01:59:00Z")), false, "21:59 EDT");
  assert.equal(inQuietHours(new Date("2026-10-28T02:00:00Z")), true, "22:00 EDT");
  assert.equal(inQuietHours(new Date("2026-10-27T04:00:00Z")), true, "midnight");
  assert.equal(inQuietHours(new Date("2026-10-27T11:59:00Z")), true, "07:59 EDT");
  assert.equal(inQuietHours(new Date("2026-10-27T12:00:00Z")), false, "08:00 EDT");
  // After Nov 1 2026 Toronto is on EST (UTC-5): the same UTC times are an hour earlier there.
  assert.deepEqual(torontoClock(new Date("2026-11-03T02:30:00Z")), { hour: 21, minute: 30 });
  assert.equal(inQuietHours(new Date("2026-11-03T02:30:00Z")), false, "21:30 EST (22:30 if it were EDT)");
  assert.equal(inQuietHours(new Date("2026-11-03T03:00:00Z")), true, "22:00 EST");
  assert.equal(inQuietHours(new Date("2026-11-02T12:59:00Z")), true, "07:59 EST (08:59 if it were EDT)");
  assert.equal(inQuietHours(new Date("2026-11-02T13:00:00Z")), false, "08:00 EST");
  // Midnight is hour 0, not 24.
  assert.deepEqual(torontoClock(new Date("2026-10-27T04:00:00Z")), { hour: 0, minute: 0 });
});

test("sendAt: an ISO time with its offset, at least 2 minutes ahead, not in the quiet hours", () => {
  assert.deepEqual(v({}).value.sendAt, new Date("2026-10-27T23:00:00Z"));
  // Another offset (or Z) for the same moment is the same thing.
  assert.equal(v({ sendAt: "2026-10-27T23:00:00Z" }).value.sendAt.getTime(), new Date("2026-10-27T23:00:00Z").getTime());
  assert.equal(v({ sendAt: "2026-10-27T19:00:00-0400" }).error, undefined);
  for (const sendAt of [undefined, null, ""]) assert.deepEqual(field({ sendAt }), ["sendAt", ERRORS.sendAtMissing], String(sendAt));
  for (const sendAt of ["2026-10-27T19:00", "2026-10-27 19:00", "tonight", "2026-13-45T19:00:00Z", 1793142000000, { at: 1 }]) {
    assert.deepEqual(field({ sendAt }), ["sendAt", ERRORS.sendAtBad], String(sendAt));
  }
  // Past, now, a minute ahead: too soon; exactly 2 minutes ahead is fine.
  for (const sendAt of ["2026-10-27T15:00:00Z", "2026-10-27T16:00:00Z", "2026-10-27T16:01:59Z"]) {
    assert.deepEqual(field({ sendAt }), ["sendAt", ERRORS.sendAtSoon], sendAt);
  }
  assert.equal(new Date("2026-10-27T16:02:00Z").getTime() - NOON.getTime(), MIN_LEAD_MS);
  assert.equal(v({ sendAt: "2026-10-27T16:02:00Z" }).error, undefined);
  // The organiser's 7 PM is fine; 10 PM, 11:30 PM and 7:59 AM aren't (Toronto).
  for (const sendAt of ["2026-10-27T22:00:00-04:00", "2026-10-27T23:30:00-04:00", "2026-10-28T07:59:00-04:00", "2026-10-28T02:00:00Z"]) {
    assert.deepEqual(field({ sendAt }), ["sendAt", ERRORS.quietHours], sendAt);
  }
  assert.equal(v({ sendAt: "2026-10-27T21:59:00-04:00" }).error, undefined);
  assert.equal(v({ sendAt: "2026-10-28T08:00:00-04:00" }).error, undefined);
  // A DST-correct check: 9:30 PM on Nov 2 is EST, so 02:30Z the next day is fine; 22:00 EST (03:00Z) isn't.
  assert.equal(v({ sendAt: "2026-11-03T02:30:00Z" }).error, undefined);
  assert.deepEqual(field({ sendAt: "2026-11-03T03:00:00Z" }), ["sendAt", ERRORS.quietHours]);
  assert.equal(parseSendAt("2026-10-27T19:00:00.000-04:00").toISOString(), "2026-10-27T23:00:00.000Z");
});

test("title, body, link, channels and audience", () => {
  assert.deepEqual(v({}).value, {
    sendAt: new Date("2026-10-27T23:00:00Z"), title: "Thank you for coming", body: GOOD.body,
    linkUrl: "https://www.thetechfestival.com/stay-updated", feedPost: true, banner: false, notify: true, audience: "app",
  });
  // The title is needed for a notification; without one it's optional.
  assert.deepEqual(field({ title: "  " }), ["title", ERRORS.titleMissing]);
  assert.deepEqual(field({ title: undefined }), ["title", ERRORS.titleMissing]);
  assert.equal(v({ title: "", notify: false }).value.title, "");
  assert.deepEqual(field({ title: "x".repeat(81) }), ["title", ERRORS.titleLong]);
  assert.deepEqual(field({ title: "x".repeat(81), notify: false }), ["title", ERRORS.titleLong]);
  assert.equal(v({ title: "  Rate   the app \n" }).value.title, "Rate the app", "one line");
  // The body is always needed, ≤ 500.
  assert.deepEqual(field({ body: " \n " }), ["body", ERRORS.bodyMissing]);
  assert.deepEqual(field({ body: undefined }), ["body", ERRORS.bodyMissing]);
  assert.deepEqual(field({ body: "x".repeat(501) }), ["body", ERRORS.bodyLong]);
  assert.equal(v({ body: "x".repeat(500) }).error, undefined);
  assert.equal(v({ body: "Line one  \r\n\r\n\r\n\r\nLine two" }).value.body, "Line one\n\nLine two");
  // Links: the personal notifications' rule (app screens, sessions, https pages).
  for (const linkUrl of ["", undefined, null]) assert.equal(v({ linkUrl }).value.linkUrl, "", String(linkUrl));
  assert.equal(v({ linkUrl: "ttfc://tab/Feed" }).value.linkUrl, "ttfc://tab/feed");
  assert.equal(v({ linkUrl: "ttfc://session/d2-04/live" }).value.linkUrl, "ttfc://session/d2-04/live");
  assert.equal(v({ linkUrl: "https://www.thetechfestival.com/stay-updated" }).value.linkUrl, "https://www.thetechfestival.com/stay-updated");
  for (const linkUrl of ["http://www.thetechfestival.com/", "javascript:alert(1)", "ttfc://tab/nowhere", "https://user:pw@x.example/", "https://x.example/a b", "itms-apps://x"]) {
    assert.deepEqual(field({ linkUrl }), ["linkUrl", ERRORS.link], linkUrl);
  }
  // At least one channel; only true switches it on.
  assert.deepEqual(field({ feedPost: false, banner: false, notify: false }), ["channels", ERRORS.channels]);
  assert.deepEqual(field({ feedPost: "true", banner: 1, notify: "yes", title: "" }), ["channels", ERRORS.channels]);
  assert.deepEqual(v({ feedPost: false, banner: true, notify: false }).value.banner, true);
  // Audience: app (the default) or checkedIn.
  assert.equal(v({ audience: undefined }).value.audience, "app");
  assert.equal(v({ audience: "checkedIn" }).value.audience, "checkedIn");
  for (const audience of ["everyone", "", "CHECKEDIN", 1]) assert.deepEqual(field({ audience }), ["audience", ERRORS.audience], String(audience));
  // Not an object at all.
  assert.deepEqual([validateScheduled(null, { now: NOON }).field, validateScheduled([], { now: NOON }).field], ["body", "body"]);
});

test("an edit changes only what it sends; its sendAt is checked only when it sends one", () => {
  const existing = { ...GOOD, sendAt: new Date("2026-10-27T16:01:00Z"), status: "scheduled" };   // due in a minute
  const r = validateScheduled({ body: "Rate the TTFC app" }, { now: NOON, existing });
  assert.equal(r.error, undefined, "the time isn't re-checked when it isn't changed");
  assert.deepEqual(r.value, { ...v({}).value, sendAt: existing.sendAt, body: "Rate the TTFC app" });
  assert.deepEqual(validateScheduled({ sendAt: "2026-10-27T22:30:00-04:00" }, { now: NOON, existing }).field, "sendAt");
  assert.deepEqual(validateScheduled({ notify: true, title: "" }, { now: NOON, existing }).field, "title");
  assert.deepEqual(validateScheduled({ feedPost: false, notify: false }, { now: NOON, existing }).field, "channels");
  assert.equal(validateScheduled({ notify: false, banner: true }, { now: NOON, existing }).value.notify, false);
  assert.equal(validateScheduled({ sendAt: "2026-10-27T18:00:00Z" }, { now: NOON, existing }).value.sendAt.toISOString(), "2026-10-27T18:00:00.000Z");
});

test("missed after 2 hours; the batch id; chunks of 500", () => {
  const item = { sendAt: new Date("2026-10-27T23:00:00Z") };
  assert.equal(MISSED_AFTER_MS, 2 * 3600e3);
  assert.equal(isMissed(item, new Date("2026-10-28T01:00:00Z")), false, "exactly 2 hours late: still sent");
  assert.equal(isMissed(item, new Date("2026-10-28T01:00:01Z")), true);
  assert.equal(isMissed(item, new Date("2026-10-27T22:00:00Z")), false, "early");
  assert.equal(batchIdOf("64b000000000000000000001"), "sched:64b000000000000000000001");
  assert.equal(CHUNK, 500);
  const ids = Array.from({ length: 1203 }, (_, i) => i);
  assert.deepEqual(chunks(ids).map((c) => c.length), [500, 500, 203]);
  assert.deepEqual(chunks([]), []);
});

test("the panel's item: every field; an estimate only for a scheduled notification", () => {
  const d = {
    _id: "64b000000000000000000001", sendAt: new Date("2026-10-27T23:00:00Z"), title: "Thanks", body: "Bye", linkUrl: "", feedPost: true,
    banner: true, notify: true, audience: "checkedIn", status: "scheduled", sentAt: null, recipients: 0, postId: null, error: "",
    createdByName: "Mia Manager", updatedByName: "", createdAt: new Date("2026-10-27T06:30:00Z"), updatedAt: new Date("2026-10-27T06:30:00Z"),
    batchId: "sched:64b000000000000000000001", claimedBy: "host:1", createdBy: "64b000000000000000000009",
  };
  assert.deepEqual(scheduledDTO(d, { estimate: 42 }), {
    id: "64b000000000000000000001", sendAt: "2026-10-27T23:00:00.000Z", title: "Thanks", body: "Bye", linkUrl: "", feedPost: true, banner: true,
    notify: true, audience: "checkedIn", status: "scheduled", sentAt: null, recipients: 0, postId: null, error: "", createdByName: "Mia Manager",
    updatedByName: "", createdAt: "2026-10-27T06:30:00.000Z", updatedAt: "2026-10-27T06:30:00.000Z", estimate: 42,
  });
  assert.equal(scheduledDTO({ ...d, notify: false }, { estimate: 42 }).estimate, null);
  assert.equal(scheduledDTO({ ...d, status: "sent", postId: "64b000000000000000000002", sentAt: new Date("2026-10-27T23:00:05Z") }, { estimate: 42 }).estimate, null);
  assert.equal(scheduledDTO(d).estimate, null, "no number given");
  assert.equal(scheduledDTO({ ...d, status: "sent", postId: "64b000000000000000000002" }).postId, "64b000000000000000000002");
  assert.equal(auditLine(d), "Oct 27, 7:00 PM · post + banner + notify (checkedIn) · Thanks");
  assert.equal(auditLine({ ...d, title: "", banner: false, notify: false }), "Oct 27, 7:00 PM · post · Bye");
});
