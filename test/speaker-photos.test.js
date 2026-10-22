/* Speaker photos as avatars (Oct 22 2026). Pure: no database, no network. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  speakerAvatarUrl, namesAgree, buildSpeakerPhotos, photoFor, speakerIdFor, setSpeakerPhotos, currentSpeakerPhotos, AVATAR_PX,
} from "../services/speakerPhotos.js";
import { avatarFor, userCard, commentDTO, postDTO } from "../services/socialHelpers.js";
import { leaderboardCard } from "../services/points.js";
import { buildDirectory } from "../services/ticketAccess.js";

const IMG = "https://cdn.sanity.io/images/021qtoci/production/abc123-1200x1600.jpg";
const NIC = "a".repeat(24);
const STAFF = "b".repeat(24);
const ASSIST = "c".repeat(24);
const OTHER = "d".repeat(24);

const speakers = [
  { _id: "spk-nicole", name: "Nicole Louis", imageUrl: IMG, hotspot: { x: 0.5, y: 0.3 }, dims: { width: 1200, height: 1600 } },
  { _id: "spk-raj", name: "Dr. Raj Patel", imageUrl: "https://cdn.sanity.io/images/021qtoci/production/raj-800x800.png" },
  { _id: "spk-nophoto", name: "No Photo" },
  { _id: "drafts.spk-x", name: "Draft Person", imageUrl: IMG },
];
const passes = [
  { speakerId: "spk-nicole", name: "Nicole Louis", email: "nicole.l@example.com", ticketId: "spk000000001", claimedBy: NIC },
  // A staff member's email on another speaker's pass (they had no email of their own on file), plus the speaker's own as alsoTo.
  { speakerId: "spk-raj", name: "Raj Patel", email: "staff.person@example.com", alsoTo: ["raj@example.com"], ticketId: "spk000000002" },
  { speakerId: "spk-nophoto", name: "No Photo", email: "nophoto@example.com", ticketId: "spk000000003" },
  { speakerId: "manual:Someone", name: "Someone", email: "someone@example.com", ticketId: "spk000000004" },
];

test("speakerAvatarUrl: a square WebP avatar from the Sanity CDN, framed as staff set it", () => {
  assert.equal(speakerAvatarUrl(speakers[0]), `${IMG}?w=${AVATAR_PX}&h=${AVATAR_PX}&fit=crop&fm=webp&q=80&crop=focalpoint&fp-x=0.5&fp-y=0.3`);
  assert.equal(AVATAR_PX, 256);
  // No focal point: the busiest region. A crop becomes a rect on the original size.
  assert.equal(speakerAvatarUrl({ imageUrl: IMG, crop: { top: 0.1, bottom: 0.2, left: 0.25, right: 0 }, dims: { width: 1200, height: 1600 } }),
    `${IMG}?rect=300,160,900,1120&w=256&h=256&fit=crop&fm=webp&q=80&crop=entropy`);
  // Only this kind of URL; nothing else becomes an avatar.
  for (const imageUrl of ["", null, "http://cdn.sanity.io/images/x/y/z.jpg", "https://evil.example.com/a.jpg", `${IMG}?w=10`, "javascript:alert(1)"]) {
    assert.equal(speakerAvatarUrl({ imageUrl }), "", String(imageUrl));
  }
});

test("namesAgree: the people-directory rules (accents, honorifics, middle names)", () => {
  assert.equal(namesAgree("Nicole Louis", "Nicole Louis"), true);
  assert.equal(namesAgree("Raj Patel", "Dr. Raj Patel"), true);
  assert.equal(namesAgree("Nicole A. Louis", "Nicole Louis"), true);
  assert.equal(namesAgree("Zoë Brûlé", "Zoe Brule"), true);
  assert.equal(namesAgree("Sam Staff", "Raj Patel"), false);
  assert.equal(namesAgree("", "Raj Patel"), false);
});

test("photoFor: the account that claimed or holds a speaker's pass, or has its email, when the names agree", () => {
  const users = [
    { _id: NIC, name: "Nicole Louis", email: "nicole.l@example.com", tickets: [{ ticketId: "spk000000001" }] },
    { _id: STAFF, name: "Sam Staff", email: "staff.person@example.com", tickets: [] },
  ];
  const snap = buildSpeakerPhotos({ speakers, passes, users });
  assert.equal(snap.speakers, 2);   // with a photo, published
  const nicole = speakerAvatarUrl(speakers[0]);
  const raj = speakerAvatarUrl(speakers[1]);
  assert.equal(snap.byUser.get(NIC).url, nicole);
  // Claimed (by id only, as a card is loaded), holding the ticket, or the pass email: all Nicole.
  assert.equal(photoFor({ _id: NIC, name: "Nicole Louis" }, snap), nicole);
  assert.equal(photoFor({ _id: OTHER, name: "Nicole Louis", tickets: [{ ticketId: "spk000000001" }] }, snap), nicole);
  assert.equal(photoFor({ _id: OTHER, name: "Nicole Louis", email: "Nicole.L@Example.com" }, snap), nicole);
  // The speaker's own address in alsoTo works; a staff member whose email is on the pass doesn't get the face.
  assert.equal(photoFor({ _id: OTHER, name: "Raj Patel", email: "raj@example.com" }, snap), raj);
  assert.equal(photoFor(users[1], snap), "");
  assert.equal(snap.byUser.has(STAFF), false);
  // An assistant's account that ended up holding the pass (signed in with the pass email): names don't agree.
  assert.equal(photoFor({ _id: ASSIST, name: "Alex Assistant", tickets: [{ ticketId: "spk000000002" }] }, snap), "");
  // Someone else entirely, a speaker without a photo, a pass made before the speaker was on the website, drafts.
  assert.equal(photoFor({ _id: OTHER, name: "Nicole Louis" }, snap), "");
  assert.equal(photoFor({ _id: OTHER, name: "No Photo", email: "nophoto@example.com" }, snap), "");
  assert.equal(photoFor({ _id: OTHER, name: "Someone", email: "someone@example.com" }, snap), "");
  assert.equal(photoFor({ _id: OTHER, name: "Draft Person", tickets: [{ ticketId: "x" }] }, snap), "");
  assert.equal(photoFor(null, snap), "");
  // Which website speaker they are (Oct 22 2026: their speaker page from a comment's name), photo or not.
  assert.equal(speakerIdFor({ _id: NIC, name: "Nicole Louis" }, snap), "spk-nicole");
  assert.equal(speakerIdFor({ _id: OTHER, name: "No Photo", email: "nophoto@example.com" }, snap), "spk-nophoto");
  assert.equal(speakerIdFor(users[1], snap), "");
  assert.equal(speakerIdFor({ _id: OTHER, name: "Someone", email: "someone@example.com" }, snap), "");
  // Placeholder addresses (ticket-only accounts) never match.
  const ph = buildSpeakerPhotos({ speakers, passes: [{ ...passes[0], claimedBy: null, email: "spk000000001@ticket.thetechfestival.com" }] });
  assert.equal(ph.byEmail.size, 0);
});

test("avatarFor: an uploaded photo always wins; else the speaker photo, in every card the server builds", () => {
  const snap = buildSpeakerPhotos({ speakers, passes, users: [{ _id: NIC, name: "Nicole Louis", email: "nicole.l@example.com" }] });
  const was = currentSpeakerPhotos();
  setSpeakerPhotos(snap);
  try {
    const photo = speakerAvatarUrl(speakers[0]);
    const nicole = { _id: NIC, name: "Nicole Louis", email: "nicole.l@example.com", tickets: [{ ticketId: "spk000000001", type: "speaker" }] };
    assert.equal(avatarFor(nicole), photo);
    assert.equal(avatarFor({ ...nicole, avatarVersion: 1761000000000 }), `/api/files/avatar/${NIC}?v=1761000000000`);
    assert.equal(avatarFor({ _id: OTHER, name: "Ann Other" }), "");
    assert.equal(avatarFor(null), "");
    // The same field names as always.
    assert.equal(userCard(nicole).avatarUrl, photo);
    assert.equal(leaderboardCard(nicole).avatarUrl, photo);
    assert.equal(commentDTO({ _id: OTHER, postId: OTHER, authorId: NIC, authorName: "Nicole Louis", body: "Hi" }, nicole).authorAvatarUrl, photo);
    assert.equal(commentDTO({ _id: OTHER, postId: OTHER, authorId: NIC, authorName: "Nicole Louis", body: "Hi" }, null).authorAvatarUrl, "");
    const post = { _id: OTHER, authorId: NIC, authorName: "Nicole Louis", body: "FOUR DAYS TO GO!!!!" };
    assert.equal(postDTO(post, OTHER, new Map([[NIC, photo]])).authorAvatarUrl, photo);
    assert.equal(postDTO(post, OTHER, new Map([[NIC, 7]])).authorAvatarUrl, `/api/files/avatar/${NIC}?v=7`);   // a version still works
    assert.equal(postDTO(post, OTHER, new Map()).authorAvatarUrl, "");
    const dir = buildDirectory([{ ...nicole, appOnboarded: true }], [], { avatarOf: avatarFor });
    assert.equal(dir[0].avatarUrl, photo);
    assert.equal(buildDirectory([{ ...nicole, appOnboarded: true }], [])[0].avatarUrl, "");   // default: uploaded photos only
  } finally {
    setSpeakerPhotos(was);
  }
  // Nothing loaded (tests, or before the first load): uploaded photos only, as before.
  assert.equal(avatarFor({ _id: NIC, name: "Nicole Louis", email: "nicole.l@example.com" }), "");
});
