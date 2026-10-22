/* "Win the TTFC swag kit" (Oct 22 2026): the settings, the rules, who can win, and the campaign email. Pure. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  SWAG_DEFAULTS, swagSettings, cleanSwagContent, fillSwag, longTime, shortTime, publicSwag, swagPhase, swagEligible, pickWinners, WINNER_NOTE,
} from "../services/swagRules.js";
import { CONTENT_KEYS, cleanContent } from "../services/adminHelpers.js";
import { DEFAULT_COPY, wordingToSave, fillSwagInvite, TEMPLATE_KEY } from "../services/swagInviteCopy.js";
import { DEFAULT_COPY as INVITE_COPY } from "../services/appInviteCopy.js";
import { buildSwagInviteEmail, swagInviteEmailFor, swagInviteLink, swagJpg, APP_SWAG_CAMPAIGN, SWAG_CID } from "../services/swagInviteEmail.js";
import { CAMPAIGNS, engagementKey } from "../services/engagement.js";
import { VISIT_CAMPAIGNS } from "../routes/engagement.js";

const defaults = swagSettings({});

test("settings: off until management turns it on; 3 kits; 3 PM and 4 PM on Oct 27 (Toronto); stored as app content keys", () => {
  assert.deepEqual(Object.keys(SWAG_DEFAULTS), ["swag.enabled", "swag.kits", "swag.cutoff", "swag.announce", "swag.title", "swag.rules"]);
  for (const k of Object.keys(SWAG_DEFAULTS)) assert.equal(CONTENT_KEYS[k], SWAG_DEFAULTS[k], k);   // GET /api/app/content carries them
  assert.deepEqual([defaults.enabled, defaults.kits, defaults.title], [false, 3, "Win the TTFC swag kit"]);
  assert.equal(defaults.cutoff.toISOString(), "2026-10-27T19:00:00.000Z");
  assert.equal(defaults.announce.toISOString(), "2026-10-27T20:00:00.000Z");
  assert.equal(longTime(defaults.cutoff), "3:00 PM on Tuesday, October 27");
  assert.equal(shortTime(defaults.cutoff), "Oct 27, 3 PM");
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

test("the rules: {kits}, {cutoff}, {announce} filled in; phases", () => {
  const rules = fillSwag(defaults.rulesText, defaults);
  assert.match(rules, /^Earn points in the TTFC app by connecting, saving sessions, posting and taking part\. The top 3 people on the leaderboard at 3:00 PM on Tuesday, October 27 each win a TTFC swag kit\./);
  assert.match(rules, /Winners are told in the app at 4:00 PM on Tuesday, October 27 and collect their kit at the registration desk, Harbour Ballroom foyer/);
  assert.match(rules, /No purchase necessary\. Prizes have no cash value and can't be exchanged\.$/);
  const p = publicSwag(defaults, { now: new Date("2026-10-26T12:00:00Z") });
  assert.deepEqual([p.enabled, p.kits, p.phase, p.cutoffShort, p.rulesUrl, p.installUrl], [false, 3, "open", "Oct 27, 3 PM", "https://www.thetechfestival.com/swag", "https://www.thetechfestival.com/app/install"]);
  assert.equal(swagPhase(defaults, { now: new Date("2026-10-27T19:00:00Z") }), "closed");
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

test("the email: subject, preheader, the photo inline (CID swag-kit) linked to the rules, utm link, install steps, rules line", () => {
  assert.equal(TEMPLATE_KEY, "app-swag-email");
  assert.equal(APP_SWAG_CAMPAIGN, "app-swag-2026");
  assert.equal(DEFAULT_COPY.subject, "Get the TTFC app — and you could win the swag kit");
  assert.equal(DEFAULT_COPY.preheader, "Top earners on the app leaderboard win a TTFC swag kit");
  assert.deepEqual([DEFAULT_COPY.iphoneSteps, DEFAULT_COPY.androidSteps], [INVITE_COPY.iphoneSteps, INVITE_COPY.androidSteps]);
  assert.equal(swagInviteLink(), "https://www.thetechfestival.com/app/install?utm_source=email&utm_campaign=app-swag");
  assert.equal(swagInviteLink("abc.def"), "https://www.thetechfestival.com/app/install?utm_source=email&utm_campaign=app-swag#r=abc.def");
  const e = buildSwagInviteEmail({ swag: defaults, firstName: "Jane", email: "jane@example.com", photoSrc: `cid:${SWAG_CID}` });
  assert.equal(e.subject, DEFAULT_COPY.subject);
  assert.match(e.html, /<a href="https:\/\/www\.thetechfestival\.com\/swag" target="_blank"[^>]*><img src="cid:swag-kit" width="560" alt="TTFC swag kit: backpack, bottle, mug, notebook, umbrella and more"/);
  assert.match(e.html, /Earn points by connecting, saving sessions and posting — the top 3 at 3:00 PM on Tuesday, October 27 win a TTFC swag kit\./);
  assert.match(e.html, /href="https:\/\/www\.thetechfestival\.com\/app\/install\?utm_source=email&amp;utm_campaign=app-swag"/);
  assert.match(e.html, />Get the app</);
  assert.match(e.html, /No purchase necessary\. <a href="https:\/\/www\.thetechfestival\.com\/swag"/);
  assert.match(e.html, /Sign in with this email: jane@example\.com/);
  assert.match(e.text, /Read the rules: https:\/\/www\.thetechfestival\.com\/swag/);
  assert.match(e.text, /iPhone:\n {2}1\. Open thetechfestival\.com\/app in Safari\./);
  // A real send: the logo, the light logo and the photo as attachments (the JPEG as supplied); previews inline.
  const real = swagInviteEmailFor({ firstName: "Jane", email: "jane@example.com" }, { inline: false, swag: defaults });
  const photo = real.attachments.find((a) => a.content_id === "swag-kit");
  assert.equal(photo.content_type, "image/jpeg");
  assert.equal(Buffer.from(photo.content, "base64").length, swagJpg().length);
  assert.equal(swagJpg().length, fs.statSync(new URL("../assets/email/swag-kit.jpg", import.meta.url)).size);
  assert.match(swagInviteEmailFor({ firstName: "Jane" }, { swag: defaults }).html, /src="data:image\/jpeg;base64,/);
  // Staff's wording: only what differs is kept; placeholders.
  assert.deepEqual(wordingToSave({ subject: DEFAULT_COPY.subject, heading: "New heading" }), { heading: "New heading" });
  assert.equal(fillSwagInvite("{firstName}: top {kits} by {cutoff}", { kits: 5, cutoff: "noon" }), "there: top 5 by noon");
});

test("tracking like the app invite: one row per address, the web app's visit counts", () => {
  assert.equal(CAMPAIGNS.appSwag, "app-swag-2026");
  assert.deepEqual(engagementKey({ c: "app-swag-2026", e: "Jane@Example.com", t: "con1" }), { campaign: "app-swag-2026", email: "jane@example.com", ticketId: "" });
  assert.ok(VISIT_CAMPAIGNS.includes("app-swag-2026"));
});
