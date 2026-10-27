/* Admin simplification (Oct 19 2026), the pure parts: who may change which switch (services/staffPowers.js),
   the guest offer that nobody can switch on, the "I'm attending" status per person and the LinkedIn nudge's
   skip list (services/attendingNudge.js), and the People directory's I'm attending column, filter and the
   t-<ticket ID> profile link (services/people.js). No database, no network. Fictional people, example.com. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  GUEST_OFFER_KEYS, GUEST_OFFER_UNLOCKED, MANAGEMENT_CONTENT_KEYS, contentAccess, contentEditRefusal, staffNote,
} from "../services/staffPowers.js";
import { CONTENT_KEYS, cleanContent } from "../services/adminHelpers.js";
import {
  ATTENDING_TRACKING, NUDGE_COOLDOWN_MS, NUDGE_SKIP_LABELS, attendingIndex, attendingStatusOf, attendingJob, nudgeRecipient, planAttendingNudges,
} from "../services/attendingNudge.js";
import { buildPeople, filterPeople, peopleCounts, personRow, sortPeople } from "../services/people.js";

const NOW = new Date("2026-10-20T15:00:00Z").getTime();
const daysAgo = (n) => new Date(NOW - n * 864e5);
const edit = (key, value, management) => contentEditRefusal(...cleanContent(key, value), { management });

test("staff can't change the selling switches or the guest offer; they keep the app switches", () => {
  assert.deepEqual(MANAGEMENT_CONTENT_KEYS, [
    "site.ticket_sales_open", "site.ticket_sales_message", "flag.upgrades",
    "flag.guestOffer", "offer.guest_code", "offer.guest_discount", "offer.guest_ends", "offer.guest_passes",
    "swag.enabled", "swag.kits", "swag.cutoff", "swag.announce", "swag.title", "swag.rules", "swag.autoAnnounce",
    // "Update the app" (Oct 24 2026, services/appVersion.js).
    "app.ios_latest", "app.ios_minimum", "app.android_latest", "app.android_minimum", "app.update_message",
  ]);
  const VALID = { "swag.kits": "5", "swag.cutoff": "2026-10-27T15:00:00-04:00", "swag.announce": "2026-10-27T16:00:00-04:00",
    "app.ios_latest": "1.0.4", "app.ios_minimum": "1.0.2", "app.android_latest": "1.0.7", "app.android_minimum": "1.0.5" };
  for (const key of MANAGEMENT_CONTENT_KEYS) {
    const v = typeof CONTENT_KEYS[key] === "boolean" ? false : VALID[key] || "x";
    assert.deepEqual(edit(key, v, false), { status: 403, code: "management_only", error: "Only management can change this." }, key);
    assert.equal(edit(key, v, true), null, key);
  }
  // Everything else stays open to staff: posts, groups, polls, Q&A, the Home banner, the website's texts.
  for (const key of ["flag.allow_posts", "flag.allow_groups", "flag.polls", "flag.qa", "flag.show_news", "flag.pwaPrompt", "home.announcement", "site.announcement", "site.show_agenda"]) {
    assert.equal(edit(key, typeof CONTENT_KEYS[key] === "boolean" ? true : "Doors open at 8", false), null, key);
  }
  assert.equal(staffNote(false), " (by staff)");
  assert.equal(staffNote(true), "");
});

test("the guest offer can't be switched on by anyone, management included; off is allowed", () => {
  assert.equal(GUEST_OFFER_UNLOCKED, false);
  assert.deepEqual(GUEST_OFFER_KEYS, ["flag.guestOffer", "offer.guest_code", "offer.guest_discount", "offer.guest_ends", "offer.guest_passes"]);
  for (const v of [true, "true"]) {
    for (const management of [true, false]) {
      assert.deepEqual(edit("flag.guestOffer", v, management), {
        status: 403, code: "promotions_off", error: "Promotions are switched off for TTFC 2026, so the guest offer can't be turned on.",
      });
    }
  }
  assert.equal(edit("flag.guestOffer", false, true), null);
  assert.equal(edit("flag.guestOffer", false, false).code, "management_only");
  // It defaults to off now (the stored value was switched off on Oct 18 and stays as it is).
  assert.equal(CONTENT_KEYS["flag.guestOffer"], false);
  assert.deepEqual(contentAccess("flag.guestOffer"), { managementOnly: true, locked: true });
  assert.deepEqual(contentAccess("offer.guest_code"), { managementOnly: true, locked: false });
  assert.deepEqual(contentAccess("flag.polls"), { managementOnly: false, locked: false });
});

test("I'm attending status: sent beats unconfirmed beats failed, newest send wins; opens, clicks and posts are tracked", () => {
  const idx = attendingIndex([
    { email: "Ana@Example.com", status: "failed", sentAt: daysAgo(6), sends: 0 },
    { email: "ana.work@example.com", status: "sent", sentAt: daysAgo(4), sends: 2 },
    { email: "ben@example.com", status: "sending" },
    { email: "cy@example.com", status: "failed" },
    { email: "junk@example.com", status: "bogus" },
  ]);
  assert.deepEqual(attendingStatusOf(["ana@example.com", "ana.work@example.com"], idx), {
    status: "sent", label: "Sent", sentAt: daysAgo(4), nudges: 2, email: "ana.work@example.com",
  });
  assert.equal(attendingStatusOf(["ben@example.com", "cy@example.com"], idx).status, "sending");
  assert.equal(attendingStatusOf(["cy@example.com"], idx).label, "Failed");
  assert.deepEqual(attendingStatusOf(["junk@example.com", "", null], idx), { status: "none", label: "Not sent", sentAt: null, nudges: 0, email: "" });
  // Since Oct 19 2026 (services/engagement.js): the pixel, their page opened, and confirmed LinkedIn posts.
  assert.deepEqual(ATTENDING_TRACKING, { opens: true, clicks: true, posts: true });
});

const pass = (ticketId, extra = {}) => ({ ticketId, hidden: false, ...extra });
const person = (id, name, email, extra = {}) => ({ id, name, email, firstName: "", lastName: "", jobTitle: "", company: "", passList: [pass(`${id}-t`)], user: null, ...extra });

test("LinkedIn nudge: the skip list, the cool-down and one email per address", () => {
  const people = [
    person("p1", "Ana Able", "ana@example.com", { jobTitle: "CTO", company: "Example Bank" }),
    person("p2", "Ben Booth", "ben@example.com", { passList: [pass("BOOTH-STARTUP")] }),
    person("p3", "Cy Hidden", "cy@example.com", { passList: [pass("c1", { hidden: true })] }),
    person("p4", "Di Placeholder", "abc@ticket.thetechfestival.com"),
    person("p5", "Ed Suspended", "ed@example.com", { user: { banned: true } }),
    person("p6", "Flo Unsub", "FLO@example.com"),
    person("p7", "Gus Recent", "gus@example.com"),
    person("p8", "Hal Old", "hal@example.com"),
    person("p9", "Ivy Unconfirmed", "ivy@example.com"),
    person("p10", "Ana Twin", "ana@example.com"),
    person("p11", "Jo Failed", "jo@example.com"),
    person("p12", "No name", "nn@example.com", { firstName: "", lastName: "" }),
    // Posted through "Post to LinkedIn" (confirmed): left out. A phone share can't be confirmed: still nudged.
    person("p13", "Kai Posted", "kai@example.com", { attendingEngagement: { stage: "posted", posts: 1 } }),
    person("p14", "Lu Shared", "lu@example.com", { attendingEngagement: { stage: "shared", posts: 0, shares: 1 } }),
  ];
  const sends = [
    { email: "gus@example.com", status: "sent", sentAt: daysAgo(1) },
    { email: "hal@example.com", status: "sent", sentAt: daysAgo(NUDGE_COOLDOWN_MS / 864e5 + 0.1) },
    { email: "ivy@example.com", status: "sending" },
    { email: "jo@example.com", status: "failed" },
  ];
  const plan = planAttendingNudges(people, { optedOut: ["flo@example.com"], sends, now: NOW });
  assert.deepEqual(plan.targets.map((t) => t.email), ["ana@example.com", "hal@example.com", "jo@example.com", "nn@example.com", "lu@example.com"]);
  assert.deepEqual(plan.targets[0], {
    email: "ana@example.com", name: "Ana Able", firstName: "Ana", lastName: "Able", title: "CTO", company: "Example Bank",
    people: [{ id: "p1", name: "Ana Able" }, { id: "p10", name: "Ana Twin" }],
  });
  assert.deepEqual(plan.skipped.map((s) => [s.name, s.reason]), [
    ["Ben Booth", "noPass"], ["Cy Hidden", "noPass"], ["Di Placeholder", "noEmail"], ["Ed Suspended", "banned"],
    ["Flo Unsub", "unsubscribed"], ["Gus Recent", "recent"], ["Ivy Unconfirmed", "sending"], ["Kai Posted", "posted"],
  ]);
  assert.equal(plan.skipped.find((s) => s.reason === "recent").label, "Emailed in the last 3 days");
  assert.deepEqual(plan.counts, {
    matching: 14, emails: 5, people: 6, skipped: 8,
    skippedBy: { noPass: 2, noEmail: 1, banned: 1, unsubscribed: 1, recent: 1, sending: 1, posted: 1 },
  });
  assert.equal(NUDGE_SKIP_LABELS.posted, "Already posted on LinkedIn");
  assert.deepEqual(nudgeRecipient({ name: "Kim Lee Park", firstName: "", lastName: "", jobTitle: "", company: "" }), { firstName: "Kim Lee", lastName: "Park", title: "", company: "" });
});

test("one I'm attending run at a time", () => {
  attendingJob.start("Mia Manager", "people", 3);
  assert.deepEqual([attendingJob.view().running, attendingJob.view().total, attendingJob.view().from], [true, 3, "people"]);
  attendingJob.finish();
  assert.equal(attendingJob.view().running, false);
});

test("People: the I'm attending column, filter, sort and count; Ticket records open the holder's profile (t-<ticket ID>)", () => {
  const users = [
    { _id: "u1", name: "Ana Able", email: "ana@example.com", tickets: [{ ticketId: "con300000001", type: "connect", purchaseDate: daysAgo(30) }] },
    { _id: "u2", name: "Ben Bee", email: "ben@example.com", tickets: [{ ticketId: "inf300000001", type: "influence", purchaseDate: daysAgo(20) }] },
  ];
  const attendees = [
    { _id: "a1", name: "Cy Guest", email: "cy@example.com", ticketId: "POW300000001", ticketType: "power", purchaseDate: daysAgo(10) },
  ];
  const attending = [
    { email: "ana@example.com", status: "sent", sentAt: daysAgo(2), sends: 1 },
    { email: "cy@example.com", status: "failed" },
  ];
  const { people, byId } = buildPeople({ users, attendees, attending });
  const row = (name) => personRow(people.find((p) => p.name === name));
  assert.deepEqual(row("Ana Able").attending, { status: "sent", label: "Sent", sentAt: daysAgo(2), nudges: 1 });
  assert.deepEqual(row("Ben Bee").attending, { status: "none", label: "Not sent", sentAt: null, nudges: 0 });
  assert.equal(row("Cy Guest").attending.status, "failed");
  const names = (list) => list.map((p) => p.name).sort();
  assert.deepEqual(names(filterPeople(people, { attending: "yes" })), ["Ana Able"]);
  assert.deepEqual(names(filterPeople(people, { attending: "no" })), ["Ben Bee", "Cy Guest"]);
  assert.equal(sortPeople(people, "attending")[0].name, "Ana Able");
  assert.equal(peopleCounts(people).attendingSent, 1);
  // Without the sends (an older caller), everyone is Not sent.
  assert.equal(personRow(buildPeople({ users, attendees }).people[0]).attending.status, "none");
  // Ticket records link to /admin/people/t-<ticket ID> (normalised, lower case).
  assert.equal(byId.get("t-pow300000001")?.name, "Cy Guest");
  assert.equal(byId.get("t-con300000001")?.name, "Ana Able");
});
