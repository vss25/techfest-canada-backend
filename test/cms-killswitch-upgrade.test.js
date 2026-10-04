import { test } from "node:test";
import assert from "node:assert/strict";
import { toSanityPatch, CMS_TYPES } from "../services/cmsSchema.js";
import { allowedWhileOff } from "../services/killSwitch.js";
import { avatarPath, decodeDataUrl, postDTO } from "../services/socialHelpers.js";
import { sanitizeProfilePatch } from "../routes/profile.js";
import { upgradeQuote } from "../routes/payments.js";

test("CMS types mirror the website schema", () => {
  assert.deepEqual(CMS_TYPES, ["speaker", "partner", "sponsor", "sponsorMarquee", "homeSponsor", "siteSettings", "session"]);
});

test("speaker create needs the required fields", () => {
  assert.match(toSanityPatch("speaker", { name: "Ada" }, { creating: true }).error, /title is required/);
  const ok = toSanityPatch("speaker", { name: "Ada Lovelace", title: "CTO", company: "Analytical", order: 3,
    image: "image-abc123-400x400-jpg", linkedin: "linkedin.com/in/ada", speakerType: "keynote" }, { creating: true });
  assert.equal(ok.error, null);
  assert.equal(ok.set.linkedin, "https://linkedin.com/in/ada");
  assert.deepEqual(ok.set.image, { _type: "image", asset: { _type: "reference", _ref: "image-abc123-400x400-jpg" } });
});

test("CMS rejects bad enums, numbers and image ids; empty optional fields unset", () => {
  assert.match(toSanityPatch("speaker", { speakerType: "boss" }, { creating: false }).error, /speakerType/);
  assert.match(toSanityPatch("partner", { order: "x" }, { creating: false }).error, /number/);
  assert.match(toSanityPatch("partner", { logo: "https://evil" }, { creating: false }).error, /upload/);
  const p = toSanityPatch("speaker", { bio: "", twitter: null }, { creating: false });
  assert.deepEqual(p.unset, ["bio", "twitter"]);
  assert.match(toSanityPatch("speaker", { name: "" }, { creating: false }).error, /required/);
});

test("new logos default to active", () => {
  const p = toSanityPatch("partner", { name: "IBM", category: "corporateEnterprisePartners", logo: "image-a1-10x10-png" }, { creating: true });
  assert.equal(p.set.active, true);
});

test("kill switch keeps staff, sign-in and webhooks working", () => {
  for (const ok of ["/api/status", "/api/console/kill-switch", "/api/cms/speaker", "/api/admin/attendees",
                    "/api/webhook", "/api/auth/login", "/api/auth/me", "/api/checkin/scan"]) assert.ok(allowedWhileOff(ok), ok);
  for (const off of ["/api/social/feed", "/api/auth/register", "/api/payments/create-checkout", "/api/app/content", "/api/statusx"])
    assert.ok(!allowedWhileOff(off), off);
});

test("upgrade charges the difference only", () => {
  assert.deepEqual(upgradeQuote(299, 899), { difference: 600, hst: 78, total: 678 });
  assert.match(upgradeQuote(899, 299).error, /already/);
  assert.match(upgradeQuote(899, 899).error, /already/);
  assert.match(upgradeQuote(299, 0).error, /isn't on sale/);
});

test("photos: paths and data URL decoding", () => {
  assert.equal(avatarPath("u1", 0), "");
  assert.equal(avatarPath("u1", 42), "/api/files/avatar/u1?v=42");
  const d = decodeDataUrl("data:image/jpeg;base64,/9j/AA==");
  assert.equal(d.contentType, "image/jpeg");
  assert.equal(decodeDataUrl("data:text/html;base64,PGI+"), null);
  const dto = postDTO({ _id: "p1", authorId: "a1", authorName: "A", body: "", imageData: "data:image/jpeg;base64,AA" }, "x", new Map([["a1", 7]]));
  assert.equal(dto.imageData, "");
  assert.equal(dto.imageUrl, "/api/files/post/p1");
  assert.equal(dto.authorAvatarUrl, "/api/files/avatar/a1?v=7");
});

test("profile accepts appOnboarded as a boolean only", () => {
  assert.deepEqual(sanitizeProfilePatch({ appOnboarded: true }), { appOnboarded: true });
  assert.deepEqual(sanitizeProfilePatch({ appOnboarded: "yes" }), {});
});

test("profile accepts every field the app collects", () => {
  const p = sanitizeProfilePatch({ name: " Gunant Pahwa ", tagline: "Building TTFC", jobLevel: "Founder", gender: "Male",
    objectives: ["Find partners", 5, ""], availabilitySlots: ["d1-am"], meetingSpot: "Lobby", salutation: "Mr." });
  assert.deepEqual(p, { name: "Gunant Pahwa", tagline: "Building TTFC", salutation: "Mr.", gender: "Male", jobLevel: "Founder",
    objectives: ["Find partners"], availabilitySlots: ["d1-am"], meetingSpot: "Lobby" });
  assert.deepEqual(sanitizeProfilePatch({ name: "  " }), {});
});

import { sessionDoc, cleanPerson } from "../services/cmsSchema.js";

test("agenda sessions: import shape, times, people, formats", () => {
  const { doc } = sessionDoc({ id: "d1-06", day: 1, time: "10:10", endTime: "10:35", title: "Conviction Before Consensus",
    type: "Fireside Chat", format: "fireside", pillar: "quantum", speakers: [{ name: "Dr. Christian Weedbrook" }, { name: " " }],
    moderator: { name: "Shawn Abbott" } });
  assert.equal(doc._id, "session-d1-06");
  assert.equal(doc.sessionId, "d1-06");
  assert.equal(doc.speakers.length, 1);
  assert.ok(doc.speakers[0]._key);
  assert.deepEqual(doc.moderator, { name: "Shawn Abbott" });
  assert.match(toSanityPatch("session", { time: "9:5" }, { creating: false }).error, /time like/);
  assert.equal(toSanityPatch("session", { time: "9:05" }, { creating: false }).set.time, "09:05");
  assert.equal(toSanityPatch("session", { day: "2" }, { creating: false }).set.day, 2);
  assert.match(toSanityPatch("session", { format: "jamboree" }, { creating: false }).error, /format/);
  assert.equal(cleanPerson({ name: "A", tentative: true, org: "" }).tentative, true);
});

test("photo framing and logo size", () => {
  const p = toSanityPatch("speaker", { image: { asset: "image-abc123-400x500-jpg", crop: { top: .1, bottom: .2, left: 0, right: .05 }, hotspot: { x: .5, y: .4, width: .6, height: .6 } } }, { creating: false });
  assert.equal(p.error, null);
  assert.equal(p.set.image.crop.top, 0.1);
  assert.equal(p.set.image.hotspot._type, "sanity.imageHotspot");
  assert.match(toSanityPatch("speaker", { image: { asset: "image-abc123-400x500-jpg", crop: { top: 2, bottom: 0, left: 0, right: 0 } } }, { creating: false }).error, /between 0 and 1/);
  assert.equal(toSanityPatch("partner", { logoScale: 140 }, { creating: false }).set.logoScale, 140);
  assert.match(toSanityPatch("partner", { logoScale: 900 }, { creating: false }).error, /between/);
});
