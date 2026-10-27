/* "Win the TTFC swag kit" (Oct 22 2026): the settings, the rules, who can win, and the campaign email. Pure. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  SWAG_DEFAULTS, swagSettings, cleanSwagContent, fillSwag, longTime, shortTime, publicSwag, swagPhase, swagEligible, pickWinners, WINNER_NOTE,
  snapshotCounts, publicWinners, SNAPSHOT_TOLERANCE_MS, clockTime,
} from "../services/swagRules.js";
import { CONTENT_KEYS, cleanContent } from "../services/adminHelpers.js";
import { DEFAULT_COPY, FIELDS, PLACEHOLDERS, fillInvite } from "../services/appInviteCopy.js";
import { buildAppInviteEmail, appInviteEmailFor, swagJpg, SWAG_CID } from "../services/appInviteEmail.js";
import { CAMPAIGNS } from "../services/engagement.js";
import { APP_INVITE_CAMPAIGN, APP_INVITE_SWAG_KEY, inviteSendKey, planAppInvites, pickBatch } from "../services/appInvite.js";

const defaults = swagSettings({});

test("settings: off until management turns it on; 3 kits; Day 1 4 PM and 5 PM (Toronto); stored as app content keys", () => {
  assert.deepEqual(Object.keys(SWAG_DEFAULTS), ["swag.enabled", "swag.kits", "swag.cutoff", "swag.announce", "swag.title", "swag.rules", "swag.autoAnnounce"]);
  for (const k of Object.keys(SWAG_DEFAULTS)) assert.equal(CONTENT_KEYS[k], SWAG_DEFAULTS[k], k);   // GET /api/app/content carries them
  assert.deepEqual([defaults.enabled, defaults.kits, defaults.title], [false, 3, "Win the TTFC swag kit"]);
  assert.equal(defaults.cutoff.toISOString(), "2026-10-26T20:00:00.000Z");
  assert.equal(defaults.announce.toISOString(), "2026-10-26T21:00:00.000Z");
  assert.equal(longTime(defaults.cutoff), "4:00 PM on Monday, October 26");
  assert.equal(longTime(defaults.announce), "5:00 PM on Monday, October 26");
  assert.equal(shortTime(defaults.cutoff), "Oct 26, 4 PM");
  assert.equal(swagSettings({ "swag.enabled": true, "swag.kits": "5" }).kits, 5);
  assert.equal(swagSettings({ "swag.kits": "zero" }).kits, 3);
});

test("saving: kits 1–50, times with their offset; the rest as usual", () => {
  assert.deepEqual(cleanContent("swag.kits", " 5 "), ["swag.kits", "5"]);
  for (const bad of ["0", "51", "2.5", "three", ""]) assert.equal(cleanContent("swag.kits", bad), null, bad);
  assert.deepEqual(cleanContent("swag.cutoff", "2026-10-27T14:30:00-04:00"), ["swag.cutoff", "2026-10-27T14:30:00-04:00"]);
  for (const bad of ["2026-10-27 15:00", "tomorrow", "2026-10-27T15:00:00"]) assert.equal(cleanContent("swag.cutoff", bad), null, bad);
  assert.deepEqual(cleanContent("swag.enabled", "true"), ["swag.enabled", true]);
  assert.deepEqual(cleanContent("swag.title", "Win big"), ["swag.title", "Win big"]);
  assert.equal(cleanSwagContent("site.announcement", "x"), undefined);
});

test("the rules: only app users can win, first; {kits}, {cutoff}, {announce} filled in; phases; the pitch", () => {
  const rules = fillSwag(defaults.rulesText, defaults);
  assert.match(rules, /^Only people using the TTFC app can win\. Download the app, sign in and earn points by connecting, saving sessions, posting and taking part\. The top 3 people on the leaderboard at 4:00 PM on Monday, October 26 each win a TTFC swag kit\./);
  assert.match(rules, /TTFC staff, volunteers and their families can't win\./);
  assert.match(rules, /Winners are told in the app at the end of Day 1 \(5:00 PM on Monday, October 26\) and collect their kit at the registration desk, Harbour Ballroom foyer, after answering a skill-testing question\./);
  assert.match(rules, /Quebec residents, TTFC staff, volunteers and their families can't win\./);
  assert.match(rules, /Free to enter for TTFC 2026 pass holders\. Prizes have no cash value and can't be exchanged\.$/);
  const p = publicSwag(defaults, { now: new Date("2026-10-26T12:00:00Z") });
  assert.deepEqual([p.enabled, p.kits, p.phase, p.cutoffShort, p.rulesUrl, p.installUrl], [false, 3, "open", "Oct 26, 4 PM", "https://www.thetechfestival.com/swag", "https://www.thetechfestival.com/app/install"]);
  assert.deepEqual([p.appOnly, p.pitch], [true, "Only people using the TTFC app can win"]);
  assert.equal(swagPhase(defaults, { now: new Date("2026-10-26T20:00:00Z") }), "closed");
  assert.equal(swagPhase(defaults, { announced: true }), "announced");
  assert.deepEqual(WINNER_NOTE, { title: "You won a TTFC swag kit!", body: "Collect it at the registration desk." });
});

test("who can win: on the leaderboard with a pass of their own; never staff, volunteers, moderators or suspended", () => {
  const ann = { role: "user", tickets: [{ ticketId: "con1", type: "connect" }] };
  assert.equal(swagEligible(ann, { types: ["attendee"], rights: {} }), true);
  assert.equal(swagEligible({ ...ann, tickets: [] }, { types: ["attendee"] }), false);
  assert.equal(swagEligible({ ...ann, tickets: [{ ticketId: "BOOTH-1", type: "booth" }] }, { types: [] }), false);
  assert.equal(swagEligible({ ...ann, role: "admin" }, { types: ["staff"] }), false);
  assert.equal(swagEligible({ ...ann, role: "volunteer" }, { types: ["volunteer"] }), false);
  assert.equal(swagEligible(ann, { types: ["attendee", "staff"] }), false);
  assert.equal(swagEligible(ann, { types: ["attendee"], rights: { moderate: true } }), false);
  for (const flag of ["banned", "hideFromLeaderboard", "directoryHidden"]) assert.equal(swagEligible({ ...ann, [flag]: true }, { types: [] }), false, flag);
  const rows = [1, 2, 3, 4, 5].map((n) => ({ rank: n, points: 100 - n, user: { id: `u${n}`, name: `P${n}`, organization: "" } }));
  assert.deepEqual(pickWinners(rows, (id) => id !== "u2", 3).map((w) => [w.userId, w.rank]), [["u1", 1], ["u3", 3], ["u4", 4]]);
});

const on = swagSettings({ "swag.enabled": true });

test("the app invite carries the offer while the contest is on: the photo, the key point, Day 1, its subject", () => {
  for (const k of ["swagSubject", "swagHeadline", "swagOnly", "swagText"]) assert.ok(FIELDS.some((f) => f.key === k && f.section === "swag"), k);
  assert.deepEqual(PLACEHOLDERS, ["{firstName}", "{email}", "{kits}", "{cutoff}", "{announce}"]);
  assert.deepEqual([DEFAULT_COPY.swagSubject, DEFAULT_COPY.swagHeadline, DEFAULT_COPY.swagOnly, DEFAULT_COPY.swagText], [
    "Get the TTFC app — only app users can win the swag kit",
    "Download the app to win the TTFC swag kit",
    "Only people using the TTFC app can win — download it, sign in and earn points.",
    "The top {kits} on the app's leaderboard win. Winners are announced at the end of Day 1 ({announce}).",
  ]);
  const e = buildAppInviteEmail({ firstName: "Jane", email: "jane@example.com", swag: on, swagSrc: `cid:${SWAG_CID}` });
  assert.equal(e.subject, "Get the TTFC app — only app users can win the swag kit");
  assert.match(e.html, /<a href="https:\/\/www\.thetechfestival\.com\/swag" target="_blank"[^>]*><img src="cid:swag-kit" width="560" alt="TTFC swag kit: backpack, bottle, mug, notebook, umbrella and more"/);
  assert.match(e.html, />Download the app to win the TTFC swag kit</);
  assert.match(e.html, />Only people using the TTFC app can win — download it, sign in and earn points\.</);
  assert.match(e.html, /The top 3 on the app&#39;s leaderboard win\. Winners are announced at the end of Day 1 \(5:00 PM on Monday, October 26\)\./);
  assert.match(e.html, /Free for TTFC 2026 pass holders · Quebec residents excluded · <a href="https:\/\/www\.thetechfestival\.com\/swag"[^>]*>Rules<\/a>/);
  // Right after the intro, before what's in the app and the App Store / Google Play buttons; the same layout otherwise.
  const at = (s2) => e.html.indexOf(s2);
  assert.ok(at("Download it free on the App Store or Google Play.") > 0);
  assert.ok(at("Download the app to win") > at("Download it free on the App Store or Google Play.") && at("Download the app to win") < at("What&#39;s in it"));
  assert.ok(at("cid:swag-kit") < at(">Get the TTFC app<") && at(">Get the TTFC app<") > 0);
  assert.match(e.text, /DOWNLOAD THE APP TO WIN THE TTFC SWAG KIT\nOnly people using the TTFC app can win/);
  // Off: the invite as it was (no block, the usual subject), word for word.
  const off = buildAppInviteEmail({ firstName: "Jane", email: "jane@example.com" });
  assert.equal(off.subject, "Your TTFC 2026 app is ready");
  assert.equal(off.html.includes("swag"), false);
  assert.equal(buildAppInviteEmail({ firstName: "Jane", email: "jane@example.com", swag: null }).html, off.html);
  // A real send attaches the photo (as supplied) only while it's on; previews inline it.
  const real = appInviteEmailFor({ firstName: "Jane", email: "jane@example.com" }, { inline: false, swag: on });
  const photo = real.attachments.find((a) => a.content_id === "swag-kit");
  assert.deepEqual([photo.content_type, Buffer.from(photo.content, "base64").length], ["image/jpeg", swagJpg().length]);
  assert.equal(swagJpg().length, fs.statSync(new URL("../assets/email/swag-kit.jpg", import.meta.url)).size);
  assert.equal(appInviteEmailFor({ firstName: "Jane" }, { inline: false, swag: defaults }).attachments.some((a) => a.content_id === "swag-kit"), false);   // off
  assert.match(appInviteEmailFor({ firstName: "Jane" }, { swag: on }).html, /src="data:image\/jpeg;base64,/);
  assert.equal(fillInvite("{firstName}: top {kits} by {cutoff}, told {announce}", { kits: 5, cutoff: "noon", announce: "1 PM" }), "there: top 5 by noon, told 1 PM");
  assert.equal(fillInvite("{kits}", {}), "{kits}");
});

test("this version's own claims: people who got the earlier invite and still aren't on the app can get it once", () => {
  assert.deepEqual([APP_INVITE_SWAG_KEY, inviteSendKey(true), inviteSendKey(false)], ["app-invite-2026-swag", "app-invite-2026-swag", APP_INVITE_CAMPAIGN]);
  assert.equal(CAMPAIGNS.appSwag, undefined);   // no separate campaign any more
  const people = [
    { id: "u-1", name: "Gus Got-Earlier", email: "gus@example.com", passList: [{ ticketId: "con1", tier: "connect", purchaseDate: "2026-10-01" }] },
    { id: "u-2", name: "Hal Got-This", email: "hal@example.com", passList: [{ ticketId: "con2", tier: "connect", purchaseDate: "2026-10-01" }] },
  ];
  const earlier = [{ email: "gus@example.com", status: "sent", sentAt: new Date("2026-10-21") }, { email: "hal@example.com", status: "sent", sentAt: new Date("2026-10-21") }];
  const plan = planAppInvites(people, { sends: [{ email: "hal@example.com", status: "sent", sentAt: new Date() }], earlierSends: earlier, swag: true });
  const [gus, hal] = plan.rows;
  assert.deepEqual([gus.willGet, gus.version, String(gus.earlierSentAt.toISOString?.() || gus.earlierSentAt)], [true, "swag", "2026-10-21T00:00:00.000Z"]);
  assert.deepEqual([hal.willGet, hal.reason, hal.label], [false, "alreadySent", "Already got this version"]);
  assert.deepEqual(pickBatch(plan, ["hal@example.com"], { kind: "next" }).dropped.map((d) => d.label), ["Already got this version"]);
  // Off: the earlier invite's own records, as before.
  const off = planAppInvites(people, { sends: earlier });
  assert.deepEqual(off.rows.map((r) => [r.reason, r.label, r.version, r.earlierSentAt]), [["alreadySent", "Already sent", "standard", null], ["alreadySent", "Already sent", "standard", null]]);
});

test("a kept leaderboard counts only for its cutoff: one kept before the cutoff moved later is stale (Oct 26 2026)", () => {
  const moved = swagSettings({ "swag.enabled": true, "swag.cutoff": "2026-10-27T17:00:00-04:00", "swag.announce": "2026-10-27T17:00:00-04:00" });
  const stale = { takenAt: new Date("2026-10-26T20:00:48Z"), rows: [] };   // the one production kept at the old cutoff
  assert.equal(snapshotCounts(stale, defaults.cutoff), true);
  assert.equal(snapshotCounts(stale, moved.cutoff), false);
  assert.equal(snapshotCounts({ takenAt: new Date("2026-10-27T21:00:30Z") }, moved.cutoff), true);
  // A few minutes' leeway (server clocks, a cutoff nudged after the job ran), no more.
  assert.equal(SNAPSHOT_TOLERANCE_MS, 5 * 60 * 1000);
  assert.equal(snapshotCounts({ takenAt: new Date("2026-10-27T20:56:00Z") }, moved.cutoff), true);
  assert.equal(snapshotCounts({ takenAt: new Date("2026-10-27T20:54:59Z") }, moved.cutoff), false);
  // A cutoff moved earlier than the kept one: it still counts (it was kept after the cutoff).
  assert.equal(snapshotCounts({ takenAt: new Date("2026-10-27T21:00:30Z") }, new Date("2026-10-27T15:00:00-04:00")), true);
  for (const bad of [null, {}, { takenAt: "soon" }]) assert.equal(snapshotCounts(bad, moved.cutoff), false);
});

test("GET /api/app/swag's winners: only once announced; the podium place, the photo now, never an email", () => {
  const announced = { at: new Date(), winners: [
    { userId: "u4", name: "Ann", organization: "Acme", points: 40, rank: 4, email: "ann@example.com" },
    { userId: "u6", name: "Cal", organization: "", points: 20, rank: 6 },
  ] };
  const w = publicWinners(announced, (id) => (id === "u4" ? "/api/files/avatar/u4?v=2" : ""));
  assert.deepEqual(w, [
    { rank: 1, boardRank: 4, name: "Ann", organization: "Acme", avatarUrl: "/api/files/avatar/u4?v=2", points: 40, userId: "u4" },
    { rank: 2, boardRank: 6, name: "Cal", organization: "", avatarUrl: "", points: 20, userId: "u6" },
  ]);
  assert.equal(JSON.stringify(w).includes("@"), false);
  assert.deepEqual(publicWinners(null), []);
  const before = publicSwag(on, { announced: false, winners: w });
  assert.equal("winners" in before, false);
  assert.deepEqual(publicSwag(on, { announced: true, winners: w }).winners, w);
  assert.equal("winners" in publicSwag(on, { announced: true }), false);   // the admin panel's copy of the settings
});

test("the announcement is automatic by default (Oct 26 2026): swag.autoAnnounce, a switch management can turn off", () => {
  assert.equal(SWAG_DEFAULTS["swag.autoAnnounce"], true);
  assert.equal(CONTENT_KEYS["swag.autoAnnounce"], true);
  assert.equal(defaults.autoAnnounce, true);
  assert.equal(swagSettings({ "swag.autoAnnounce": false }).autoAnnounce, false);
  assert.equal(swagSettings({ "swag.autoAnnounce": "false" }).autoAnnounce, false);
  assert.equal(swagSettings({ "swag.autoAnnounce": "" }).autoAnnounce, true);
  assert.deepEqual(cleanContent("swag.autoAnnounce", "false"), ["swag.autoAnnounce", false]);
  assert.deepEqual(cleanContent("swag.autoAnnounce", true), ["swag.autoAnnounce", true]);
  assert.equal(clockTime("2026-10-27T17:00:00-04:00"), "5 PM");
  assert.equal(clockTime("2026-10-27T16:30:00-04:00"), "4:30 PM");
});
