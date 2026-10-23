import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanMentions, mentionedUserIds, keepKnownMentions, buildActivity, toggleLike, seenAt, unreadFilter,
  countUnread, parseSection, activityDTO, buildReportNotifications, reportLink, removeMode, canViewPost, MAX_MENTIONS,
  canInteractPost, POST_GONE, isRepeatPost, REPEAT_POST_MS, seenWatermark, SEEN_AHEAD_MS,
} from "../services/socialActivity.js";
import { postDTO, publicProfile } from "../services/socialHelpers.js";

const A = "a".repeat(24);
const B = "b".repeat(24);
const C = "c".repeat(24);
const S = "5".repeat(24);   // staff

/* ---------- mentions ---------- */

test("cleanMentions keeps well-formed user + speaker mentions, trims names", () => {
  const out = cleanMentions([
    { type: "user", id: A.toUpperCase(), name: "  Ann   Lee  " },
    { type: "speaker", id: "speaker-jane.doe_1", name: "Jane" },
    { type: "user", id: "not-an-id", name: "X" },
    { type: "speaker", id: "has space", name: "Y" },
    { type: "group", id: A, name: "Z" },
    null, "x", { type: "user", id: 42, name: "N" },
    { type: "user", id: A, name: "dupe" },
  ]);
  assert.deepEqual(out, [
    { type: "user", id: A, name: "Ann Lee" },
    { type: "speaker", id: "speaker-jane.doe_1", name: "Jane" },
  ]);
  assert.equal(cleanMentions([{ type: "user", id: A, name: "n".repeat(200) }])[0].name.length, 80);
  assert.deepEqual(cleanMentions("nope"), []);
  assert.deepEqual(cleanMentions(undefined), []);
});

test("cleanMentions caps at ten", () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ type: "speaker", id: `s${i}`, name: `S${i}` }));
  assert.equal(cleanMentions(many).length, MAX_MENTIONS);
  assert.equal(MAX_MENTIONS, 10);
});

test("keepKnownMentions drops unknown users, fills blank names, needs speaker names", () => {
  const m = cleanMentions([
    { type: "user", id: A, name: "" }, { type: "user", id: B, name: "Bo" },
    { type: "speaker", id: "sp1", name: "" }, { type: "speaker", id: "sp2", name: "Kay" },
  ]);
  assert.deepEqual(mentionedUserIds(m), [A, B]);
  assert.deepEqual(keepKnownMentions(m, new Map([[A, "Ann"]])), [
    { type: "user", id: A, name: "Ann" },
    { type: "speaker", id: "sp2", name: "Kay" },
  ]);
  assert.deepEqual(keepKnownMentions(m), [{ type: "speaker", id: "sp2", name: "Kay" }]);
});

test("postDTO returns mentions (default []) and canRemove", () => {
  const base = { _id: "p1", authorId: A, authorName: "Ann", body: "hi" };
  assert.deepEqual(postDTO(base, B).mentions, []);
  const p = { ...base, mentions: [{ type: "user", id: B, name: "Bo" }] };
  assert.deepEqual(postDTO(p, B).mentions, [{ type: "user", id: B, name: "Bo" }]);
  assert.equal(postDTO(p, A).canRemove, true);           // author
  assert.equal(postDTO(p, B).canRemove, false);          // someone else
  assert.equal(postDTO(p, S, new Map(), { staff: true }).canRemove, true);
  assert.equal(postDTO(p, "").canRemove, false);
});

/* ---------- activity rules ---------- */

test("buildActivity: one row per recipient, never self, never blocked, no dupes", () => {
  const rows = buildActivity({ kind: "mention", section: "feed", actorId: A, actorName: "Ann", refId: "p1",
    recipients: [B, A, C, B, "", null], blocked: new Set([C]) });
  assert.deepEqual(rows, [{ userId: B, actorId: A, actorName: "Ann", kind: "mention", section: "feed", refId: "p1" }]);
});

test("buildActivity: like / comment go to the post author, not when it's your own post", () => {
  const like = buildActivity({ kind: "like", section: "feed", actorId: B, actorName: "Bo", refId: "p1", recipients: [A] });
  assert.equal(like.length, 1);
  assert.equal(like[0].userId, A);
  assert.equal(like[0].kind, "like");
  assert.deepEqual(buildActivity({ kind: "comment", section: "feed", actorId: A, refId: "p1", recipients: [A] }), []);
});

test("buildActivity: reply goes to the discussion author unless either blocked the other", () => {
  const ok = buildActivity({ kind: "reply", section: "discussions", actorId: B, actorName: "Bo", refId: "d1", recipients: [A] });
  assert.equal(ok[0].section, "discussions");
  // req.blocked holds both directions, so "A blocked B" and "B blocked A" look the same here.
  assert.deepEqual(buildActivity({ kind: "reply", section: "discussions", actorId: B, refId: "d1", recipients: [A], blocked: new Set([A]) }), []);
});

test("buildActivity rejects unknown kinds/sections and missing ids", () => {
  assert.deepEqual(buildActivity({ kind: "share", section: "feed", actorId: A, refId: "p", recipients: [B] }), []);
  assert.deepEqual(buildActivity({ kind: "like", section: "groups", actorId: A, refId: "p", recipients: [B] }), []);
  assert.deepEqual(buildActivity({ kind: "like", section: "feed", actorId: A, recipients: [B] }), []);
});

test("toggleLike: only a first-ever like counts; unlike + relike is quiet", () => {
  let s = { likes: [], everLiked: [] };
  let t = toggleLike({ ...s, actorId: B });
  assert.deepEqual([t.liked, t.firstLike, t.likes, t.everLiked], [true, true, [B], [B]]);
  t = toggleLike({ likes: t.likes, everLiked: t.everLiked, actorId: B });       // unlike
  assert.deepEqual([t.liked, t.firstLike, t.likes, t.everLiked], [false, false, [], [B]]);
  t = toggleLike({ likes: t.likes, everLiked: t.everLiked, actorId: B });       // relike
  assert.deepEqual([t.liked, t.firstLike, t.likes], [true, false, [B]]);
  // A like from before everLiked existed: unliking remembers it, so the relike is quiet too.
  t = toggleLike({ likes: [C], everLiked: [], actorId: C });
  assert.deepEqual([t.liked, t.everLiked], [false, [C]]);
  assert.equal(toggleLike({ likes: t.likes, everLiked: t.everLiked, actorId: C }).firstLike, false);
  // Inputs aren't mutated.
  s = { likes: [A], everLiked: [A] };
  toggleLike({ ...s, actorId: B });
  assert.deepEqual(s, { likes: [A], everLiked: [A] });
});

/* ---------- unread ---------- */

test("unreadFilter: newer than the section's seen time, minus blocked actors", () => {
  const seen = { feed: new Date("2026-10-20T10:00:00Z") };
  assert.deepEqual(unreadFilter(A, "feed", seen), { userId: A, section: "feed", createdAt: { $gt: seen.feed } });
  const f = unreadFilter(A, "discussions", seen, new Set([B]));
  assert.equal(f.createdAt.$gt.getTime(), 0);                      // never opened → everything
  assert.deepEqual(f.actorId, { $nin: [B] });
  assert.equal(seenAt({ feed: "garbage" }, "feed").getTime(), 0);
});

test("countUnread counts per section after each seen time", () => {
  const seen = { feed: new Date("2026-10-20T10:00:00Z"), discussions: new Date("2026-10-21T00:00:00Z") };
  const ev = (section, at, actorId = B) => ({ section, createdAt: new Date(at), actorId });
  const events = [
    ev("feed", "2026-10-20T09:00:00Z"),           // before seen
    ev("feed", "2026-10-20T10:00:00Z"),           // exactly at seen: read
    ev("feed", "2026-10-20T11:00:00Z"),
    ev("feed", "2026-10-20T12:00:00Z", C),        // C is blocked
    ev("discussions", "2026-10-20T23:00:00Z"),
    ev("discussions", "2026-10-21T01:00:00Z"),
    ev("groups", "2026-10-22T00:00:00Z"),
  ];
  assert.deepEqual(countUnread(events, seen, new Set([C])), { feed: 1, discussions: 1 });
  assert.deepEqual(countUnread(events, {}), { feed: 4, discussions: 2 });
  assert.deepEqual(countUnread([], seen), { feed: 0, discussions: 0 });
});

test("parseSection + activityDTO", () => {
  assert.equal(parseSection("Feed"), "feed");
  assert.equal(parseSection("discussions"), "discussions");
  assert.equal(parseSection("groups"), null);
  assert.equal(parseSection(undefined), null);
  const at = new Date();
  assert.deepEqual(activityDTO({ _id: "e1", userId: A, actorId: B, actorName: "Bo", kind: "like", section: "feed", refId: "p1", createdAt: at }),
    { id: "e1", kind: "like", actorId: B, actorName: "Bo", refId: "p1", createdAt: at });
});

/* ---------- reports → staff ---------- */

test("buildReportNotifications: one per staff account, not the reporter", () => {
  const rows = buildReportNotifications({ reporterId: A, reporterName: "Ann", targetType: "post", reason: "  spam   link ",
    reportId: "r1", staffIds: [S, A, S, C] });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.userId), [S, C]);
  assert.deepEqual({ ...rows[0], userId: undefined }, {
    userId: undefined, title: "Content reported", body: "Ann reported a post: spam link", link: "ttfc://moderation",
    kind: "report", batchId: "report:r1", sentBy: A, sentByName: "Ann",
  });
});

test("reportLink: a reported post opens the post, everything else the queue", () => {
  const P = "64b7f0c2a1b2c3d4e5f60718";
  assert.equal(reportLink("post", P), `ttfc://post/${P}`);
  const [r] = buildReportNotifications({ reporterId: A, reporterName: "Ann", targetType: "post", targetId: P, staffIds: [S] });
  assert.equal(r.link, `ttfc://post/${P}`);
  assert.equal(reportLink("post", "../x"), "ttfc://moderation");
  assert.equal(reportLink("post", ""), "ttfc://moderation");
  assert.equal(reportLink("comment", P), "ttfc://moderation");
});

test("buildReportNotifications: no reason, readable target names, body ≤ 500", () => {
  const [r] = buildReportNotifications({ reporterId: A, reporterName: "Ann", targetType: "groupMessage", reason: "", staffIds: [S] });
  assert.equal(r.body, "Ann reported a group message: no reason given");
  const [u] = buildReportNotifications({ reporterId: A, reporterName: "Ann", targetType: "user", staffIds: [S] });
  assert.equal(u.body, "Ann reported a user: no reason given");
  const [long] = buildReportNotifications({ reporterId: A, reporterName: "Ann", targetType: "comment", reason: "x".repeat(600), staffIds: [S] });
  assert.equal(long.body.length, 500);
  assert.deepEqual(buildReportNotifications({ reporterId: S, reporterName: "Staff", targetType: "post", staffIds: [S] }), []);
});

/* ---------- remove / view a post ---------- */

test("removeMode: author deletes, staff hides, everyone else can't", () => {
  const post = { authorId: A };
  assert.equal(removeMode(post, { _id: A, role: "user" }), "author");
  assert.equal(removeMode(post, { _id: S, role: "admin" }), "staff");
  assert.equal(removeMode({ authorId: S }, { _id: S, role: "admin" }), "author");   // staff's own post
  assert.equal(removeMode(post, { _id: B, role: "user" }), null);
  assert.equal(removeMode(null, { _id: A }), null);
});

test("canViewPost: hidden/held only for author or staff; blocks hide it", () => {
  const approved = { authorId: A, status: "approved" };
  const hidden = { authorId: A, status: "hidden" };
  const held = { authorId: A, status: "held" };
  const bo = { _id: B, role: "user" };
  assert.equal(canViewPost(approved, bo), true);
  assert.equal(canViewPost(hidden, bo), false);
  assert.equal(canViewPost(held, bo), false);
  assert.equal(canViewPost(hidden, { _id: A }), true);
  assert.equal(canViewPost(hidden, { _id: S, role: "admin" }), true);
  assert.equal(canViewPost(approved, bo, new Set([A])), false);
  assert.equal(canViewPost(null, bo), false);
});

/* ---------- public profile ---------- */

test("publicProfile shows what they filled in, never email/phone/role/tickets", () => {
  const p = publicProfile({
    _id: A, name: "Ann", email: "ann@x.com", phone: "+1 416", role: "admin", gender: "F", salutation: "Dr",
    jobTitle: "CTO", organization: "Acme", tagline: "Robots", topics: ["AI"], linkedinUrl: "https://linkedin.com/in/ann",
    country: "Canada", fieldOfWork: "Engineering", jobLevel: "C-level", objectives: ["Find partners"],
    availabilitySlots: ["d1-10"], meetingSpot: "Lobby", tickets: [{ ticketId: "T1", type: "power" }], avatarVersion: 7, appOnboarded: true,
  });
  assert.equal(p.name, "Ann");
  assert.equal(p.tier, "");   // passes are private, except Speaker / Exhibitor
  assert.equal(publicProfile({ _id: A, name: "Ann", tickets: [{ type: "power" }] }, { self: true }).tier, "Power Pass");
  assert.equal(p.onApp, true);
  assert.equal(p.avatarUrl, `/api/files/avatar/${A}?v=7`);
  assert.deepEqual([p.fieldOfWork, p.jobLevel, p.objectives, p.tagline, p.country], ["Engineering", "C-level", ["Find partners"], "Robots", "Canada"]);
  for (const k of ["email", "phone", "role", "tickets", "gender", "salutation"]) assert.equal(k in p, false, k);
  assert.equal(publicProfile(null), null);
});

/* ---------- reacting to a post, retried posts (Oct 22 2026) ---------- */

test("canInteractPost: whoever can see a post can like and comment on it; nobody can on a removed one", () => {
  const NIC = "e".repeat(24);
  const OTHER = "f".repeat(24);
  const author = { _id: NIC };
  const viewer = { _id: OTHER };
  const moderator = { _id: S };
  const modRights = { moderate: true };
  const approved = { _id: "p1", authorId: NIC, status: "approved" };
  const held = { ...approved, status: "held" };
  const removed = { ...approved, status: "hidden" };
  assert.equal(canInteractPost(approved, viewer), true);
  assert.equal(canInteractPost({ _id: "p0", authorId: NIC }, viewer), true);   // older posts without a status
  assert.equal(canInteractPost(held, author), true);                           // the author sees their own held post
  assert.equal(canInteractPost(held, viewer), false);
  assert.equal(canInteractPost(held, moderator, new Set(), modRights), true);
  for (const who of [author, viewer, moderator]) assert.equal(canInteractPost(removed, who, new Set(), modRights), false);
  // Blocked either way, or hidden from the app (in `unseen`): not there for them.
  assert.equal(canInteractPost(approved, viewer, new Set([NIC])), false);
  assert.equal(canInteractPost(approved, author, new Set([NIC])), true);
  assert.equal(canInteractPost(null, viewer), false);
  assert.equal(POST_GONE, "This post isn't available any more.");
});

test("isRepeatPost: the same post sent again (a retry) is recognised; a different one never is", () => {
  const text = { body: "FOUR DAYS TO GO!!!!", linkUrl: "", imageData: "", media: [{ type: "image", publicId: "ttfc/feed/a1", url: "u1" }] };
  // A retry uploads the photo again under a new name: same text, same number of items → the same post.
  assert.equal(isRepeatPost(text, { ...text, media: [{ type: "image", publicId: "ttfc/feed/b2", url: "u2" }] }), true);
  assert.equal(isRepeatPost({ body: "Hi", linkUrl: "" }, { body: "Hi", linkUrl: "" }), true);
  assert.equal(isRepeatPost(text, { ...text, body: "FOUR DAYS TO GO!!!" }), false);
  assert.equal(isRepeatPost(text, { ...text, linkUrl: "https://example.com" }), false);
  assert.equal(isRepeatPost(text, { ...text, media: [] }), false);
  assert.equal(isRepeatPost(text, { ...text, media: [...text.media, { type: "image", publicId: "x" }] }), false);
  // Photo-only posts must carry the very same photos.
  const photo = { body: "", linkUrl: "", imageData: "data:image/jpeg;base64,AAAA", media: [] };
  assert.equal(isRepeatPost(photo, { ...photo }), true);
  assert.equal(isRepeatPost(photo, { ...photo, imageData: "data:image/jpeg;base64,BBBB" }), false);
  assert.equal(isRepeatPost({ body: "", media: [{ publicId: "a" }] }, { body: "", media: [{ publicId: "b" }] }), false);
  assert.equal(isRepeatPost(null, photo), false);
  assert.equal(REPEAT_POST_MS, 120_000);
});

test("seenWatermark: upTo is exactly what the app counted (capped a few minutes ahead); without it, everything there is", () => {
  const now = new Date("2026-10-26T14:00:00.000Z");
  const iso = (d) => d.toISOString();
  // Newer apps: the newest event they counted, even if it's a little behind or ahead of this server's clock.
  assert.equal(iso(seenWatermark({ upTo: "2026-10-26T13:59:58.000Z", now })), "2026-10-26T13:59:58.000Z");
  assert.equal(iso(seenWatermark({ upTo: "2026-10-26T14:00:20.000Z", now })), "2026-10-26T14:00:20.000Z");
  assert.equal(seenWatermark({ upTo: "2099-01-01T00:00:00Z", now }).getTime(), now.getTime() + SEEN_AHEAD_MS);
  // Older apps (no upTo) or junk: now, or the newest event's createdAt when another instance's clock put it ahead.
  assert.equal(iso(seenWatermark({ now })), iso(now));
  assert.equal(iso(seenWatermark({ upTo: "garbage", now })), iso(now));
  assert.equal(iso(seenWatermark({ upTo: "", newest: new Date("2026-10-26T14:00:20.000Z"), now })), "2026-10-26T14:00:20.000Z");
  assert.equal(iso(seenWatermark({ newest: new Date("2026-10-26T13:00:00.000Z"), now })), iso(now));
});
