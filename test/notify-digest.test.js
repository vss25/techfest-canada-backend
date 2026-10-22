/* Activity pushes, notification settings, "What you missed" timing and email, LinkedIn share drafts (Oct 22 2026).
   Pure: no database, no network. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  commentNote, replyNote, mentionNote, likeNote, groupNote, discussionNote, recipientsOf, snippet,
} from "../services/notify.js";
import { NOTIFY_PREFS, PREF_KEYS, prefsOf, prefsUpdate, wants } from "../services/notifyPrefs.js";
import {
  nextDigest, isDue, afterSend, torontoAt, dayKey, slotKey, inQuietHours, afterQuietHours, next5pm, MAX_PER_DAY,
} from "../services/digestRules.js";
import { buildDigestEmail, digestSubject, itemHeadline, sortItems, SAMPLE_ITEMS } from "../services/digestEmail.js";
import { unsubscribeToken, verifyUnsubscribe, dailyCap } from "../services/digest.js";
import {
  cleanShareRequest, shareDraft, shareItemKey, shareReturnUrl, resultsLine, sessionLink, isShareState, newShareState, newShareToken, isShareToken,
} from "../services/linkedinShare.js";
import { webUrlFor, buildWebPayload, pushTopic } from "../services/webPush.js";
import { buildPayload, collapseId } from "../services/apns.js";

const T = (d, h, m = 0) => torontoAt(2026, 10, d, h, m);   // Toronto wall clock, October 2026
const due = (state) => { const n = nextDigest(state); return n && `${slotKey(n.at)} ${n.slot}`; };
const A = "a".repeat(24);
const B = "b".repeat(24);
const C = "c".repeat(24);

/* ---------- push notes ---------- */

test("notes: who did what, a 120-character snippet, the thread that collapses them, the web app route", () => {
  const c = commentNote({ actorName: "Gunant Singh", postId: "p1", body: `Great post! ${"x".repeat(300)}` });
  assert.deepEqual([c.title, c.kind, c.thread, c.id, c.link], ["Gunant Singh commented on your post", "comment", "post.p1", "p1", "ttfc://post/p1"]);
  assert.equal(c.body.length, 120);
  assert.ok(c.body.endsWith("…"));
  assert.equal(webUrlFor(c), "/app/post/p1");
  assert.equal(replyNote({ actorName: "Ann", discussionId: "d1", body: "Agreed" }).title, "Ann replied to your comment");
  assert.equal(webUrlFor(replyNote({ actorName: "Ann", discussionId: "d1", body: "x" })), "/app/discussion/d1");
  assert.deepEqual(mentionNote({ actorName: "Ann", where: "comment", refId: "p2", body: "@Ben look" }), {
    title: "Ann mentioned you", body: "@Ben look", link: "ttfc://post/p2", thread: "post.p2", kind: "mention", id: "p2",
  });
  assert.equal(mentionNote({ actorName: "Ann", where: "reply", refId: "d9", body: "hi" }).thread, "disc.d9");
  const g = mentionNote({ actorName: "Ann", where: "group", refId: "g1", body: "see you", groupName: "AI Keynote chat" });
  assert.deepEqual([g.thread, g.body, webUrlFor(g)], ["group.g1", "in AI Keynote chat: see you", "/app/group/g1"]);
  assert.equal(likeNote({ actorName: "Nicole", postId: "p1" }).body, "Nicole liked your post");
  assert.equal(likeNote({ actorName: "Nicole", postId: "p1", missed: 1 }).body, "Nicole and 1 other liked your post");
  assert.equal(likeNote({ actorName: "Nicole", postId: "p1", missed: 3 }).body, "Nicole and 3 others liked your post");
  assert.equal(groupNote({ groupId: "g1", groupName: "Lounge", actorName: "Ann", body: "Hi" }).body, "Ann: Hi");
  assert.equal(groupNote({ groupId: "g1", groupName: "Lounge", actorName: "Ann", body: "Hi", count: 5 }).body, "5 new messages in Lounge");
  assert.equal(discussionNote({ discussionId: "d1", title: "Best sessions", actorName: "Ann Lee", body: "Keynote", count: 3 }).body, "3 new replies in “Best sessions”");
  assert.equal(discussionNote({ discussionId: "d1", title: "Best sessions", actorName: "Ann Lee", body: "Keynote" }).body, "Ann: Keynote");
  assert.equal(snippet("  a\n b  "), "a b");
});

test("recipients: never yourself, never anyone blocked either way or hidden from you, once each", () => {
  assert.deepEqual(recipientsOf([A, B, A, C, "", null], { actorId: A, blocked: new Set([B]) }), [C]);
  assert.deepEqual(recipientsOf([B, C], { actorId: A, shadow: new Set([C]) }), [B]);
});

test("payloads: url and collapse on every platform", () => {
  const n = { title: "Ann commented on your post", body: "Nice", thread: `post.${A}`, kind: "comment", id: A, url: `/app/post/${A}` };
  assert.equal(buildPayload(n).url, `/app/post/${A}`);
  assert.equal(collapseId(n.thread), `post.${A}`);
  assert.equal(collapseId("x".repeat(65)), "");
  assert.equal(buildWebPayload(n).tag, `post.${A}`);
  assert.equal(pushTopic(`post.${A}`), `post-${A}`);
  assert.equal(pushTopic(`group.${A}`).length <= 32, true);
  assert.equal(pushTopic("a.b c"), "");
});

/* ---------- settings ---------- */

test("notification settings: everything on until switched off, only booleans saved", () => {
  assert.deepEqual(PREF_KEYS, ["messages", "comments", "mentions", "likes", "groups", "connections", "announcements", "digestEmail"]);
  assert.deepEqual(NOTIFY_PREFS.map((p) => p.label), ["Messages", "Comments and replies", "Mentions", "Likes", "Group and session chats",
    "Connection requests", "Announcements from TTFC", "Email me a summary of what I missed"]);
  assert.ok(Object.values(prefsOf({})).every(Boolean));
  assert.equal(prefsOf({ notifyPrefs: { likes: false } }).likes, false);
  assert.equal(wants({ notifyPrefs: { likes: false } }, "likes"), false);
  assert.equal(wants({}, "unknown"), true);
  assert.deepEqual(prefsUpdate({ likes: false, groups: "no", other: true }), { "notifyPrefs.likes": false });
  assert.equal(prefsUpdate({}), null);
});

/* ---------- digest timing (Toronto) ---------- */

test("digest timing: 3 hours after the first missed item, and 5 PM", () => {
  assert.equal(due({ pendingSince: T(22, 10) }), "2026-10-22T13:00 3h");
  assert.equal(due({ pendingSince: T(22, 16, 30) }), "2026-10-22T17:00 5pm");    // 5 PM comes first
  assert.equal(due({ pendingSince: T(22, 17, 30) }), "2026-10-22T20:30 3h");
  assert.equal(due({}), null);
});

test("digest timing: a 3-hour digest due 4–5 PM waits for the 5 PM one", () => {
  assert.equal(due({ pendingSince: T(22, 13, 0) }), "2026-10-22T17:00 5pm");      // 4:00 PM → 5 PM
  assert.equal(due({ pendingSince: T(22, 13, 59) }), "2026-10-22T17:00 5pm");     // 4:59 PM → 5 PM
  assert.equal(due({ pendingSince: T(22, 12, 59) }), "2026-10-22T15:59 3h");      // 3:59 PM goes
});

test("digest timing: quiet hours 9 PM – 8 AM (a digest due then goes at 8 AM)", () => {
  assert.equal(due({ pendingSince: T(22, 18, 30) }), "2026-10-23T08:00 3h");
  assert.equal(due({ pendingSince: T(22, 3) }), "2026-10-22T08:00 3h");
  assert.equal(due({ pendingSince: T(22, 17, 59) }), "2026-10-22T20:59 3h");
  assert.equal(inQuietHours(T(22, 21)), true);
  assert.equal(inQuietHours(T(22, 20, 59)), false);
  assert.equal(slotKey(afterQuietHours(T(22, 23))), "2026-10-23T08:00");
  assert.equal(slotKey(next5pm(T(22, 17, 1))), "2026-10-23T17:00");
});

test("digest timing: never two within 60 minutes, at most 3 a day", () => {
  assert.equal(due({ pendingSince: T(22, 10, 30), lastSentAt: T(22, 13, 0) }), "2026-10-22T14:00 later");
  // Sent at 3:55 PM, a new item at 3:56: the next one can't be before 4:55, which is in the 4–5 PM hour → 5 PM.
  assert.equal(due({ pendingSince: T(22, 15, 56), lastSentAt: T(22, 15, 55) }), "2026-10-22T17:00 5pm");
  assert.equal(due({ pendingSince: T(22, 9), sentDay: "2026-10-22", sentToday: MAX_PER_DAY }), "2026-10-23T08:00 later");
  assert.equal(due({ pendingSince: T(22, 9), sentDay: "2026-10-21", sentToday: MAX_PER_DAY }), "2026-10-22T12:00 3h");
  assert.equal(isDue({ pendingSince: T(22, 10) }, T(22, 13)), true);
  assert.equal(isDue({ pendingSince: T(22, 10) }, T(22, 12, 59)), false);
  assert.deepEqual(afterSend({ sentDay: "2026-10-22", sentToday: 2 }, T(22, 17)), { lastSentAt: T(22, 17), emailedUntil: T(22, 17), sentDay: "2026-10-22", sentToday: 3 });
  assert.equal(afterSend({ sentDay: "2026-10-21", sentToday: 3 }, T(22, 9)).sentToday, 1);
  assert.equal(dayKey(T(22, 23, 30)), "2026-10-22");                               // Toronto's day, not UTC's
  assert.equal(slotKey(torontoAt(2026, 11, 1, 8)), "2026-11-01T08:00");             // the day the clocks go back
});

/* ---------- digest email ---------- */

test("digest email: grouped list, links to the web app, one button, unsubscribe; subject '+ N more on TTFC'", () => {
  const items = [
    { kind: "like", names: ["Nicole", "Ben"], count: 2, text: "FOUR DAYS TO GO!!!!", url: "/app/post/p1", at: T(22, 10) },
    { kind: "comment", names: ["Gunant"], count: 1, text: "FOUR DAYS TO GO!!!!", url: "/app/post/p1", at: T(22, 11) },
    { kind: "group", name: "AI Keynote chat", count: 7, url: "/app/group/g1", at: T(22, 9) },
    { kind: "request", name: "Ann Lee", text: "Met at the booth", url: "/app/network", at: T(22, 8) },
  ];
  assert.equal(digestSubject(items), "Gunant commented on your post + 3 more on TTFC");
  assert.equal(digestSubject([items[2]]), "7 new messages in AI Keynote chat on TTFC");
  assert.deepEqual(sortItems(items).map((x) => x.kind), ["comment", "request", "like", "group"]);
  assert.equal(itemHeadline({ kind: "dm", name: "Ann", count: 3 }), "Ann sent you 3 messages");
  assert.equal(itemHeadline({ kind: "mention", names: ["Ann"], where: "discussion" }), "Ann mentioned you in a discussion");
  assert.equal(itemHeadline({ kind: "reply", count: 1 }), "1 new reply in a discussion you follow");
  const e = buildDigestEmail({ firstName: "Nicole", items, unsubscribeUrl: "https://api.example.com/api/app/digest/unsubscribe?t=x.y" });
  assert.deepEqual(e.sections.map((s) => s.title), ["On your posts", "Connection requests", "Group and session chats"]);
  assert.deepEqual(e.sections[0].items.map((x) => x.headline), ["Gunant commented on your post", "Nicole and 1 other liked your post"]);
  assert.equal(e.sections[0].items[0].url, "https://www.thetechfestival.com/app/post/p1");
  assert.match(e.html, /Hi Nicole,/);
  assert.match(e.html, />Open TTFC</);
  assert.match(e.html, /href="https:\/\/api\.example\.com\/api\/app\/digest\/unsubscribe\?t=x\.y"/);
  assert.match(e.text, /Turn off these emails: https:\/\/api\.example\.com/);
  assert.match(e.html, /&ldquo;|“FOUR DAYS TO GO!!!!”/);
  assert.equal(buildDigestEmail({ items: [{ kind: "dm", name: "<script>", count: 1, text: "<b>x</b>", url: "/app/chat/1" }] }).html.includes("<script>"), false);
  assert.ok(SAMPLE_ITEMS.length >= 3);
});

test("unsubscribe tokens: only ours, for that account", () => {
  const t = unsubscribeToken(A, "s3cret");
  assert.equal(verifyUnsubscribe(t, "s3cret"), A);
  assert.equal(verifyUnsubscribe(t, "other"), "");
  assert.equal(verifyUnsubscribe(t.replace(A, B), "s3cret"), "");
  assert.equal(verifyUnsubscribe("nope", "s3cret"), "");
  assert.equal(unsubscribeToken("not-an-id", "s3cret"), "");
  assert.equal(dailyCap({}), 4000);
  assert.equal(dailyCap({ DIGEST_DAILY_CAP: "250" }), 250);
  assert.equal(dailyCap({ DIGEST_DAILY_CAP: "-1" }), 4000);
});

/* ---------- LinkedIn share drafts ---------- */

test("share requests: a poll needs its session and id; a discussion is a discussion id or a session id", () => {
  assert.deepEqual(cleanShareRequest({ kind: "poll", id: "d1-5-p1", sessionId: "d1-5", question: " Where are you? ", options: ["A", "B", ""] }),
    { kind: "poll", id: "d1-5-p1", sessionId: "d1-5", question: "Where are you?", options: ["A", "B"] });
  assert.equal(cleanShareRequest({ kind: "poll", id: "d1-5/d1-5-p1" }).sessionId, "d1-5");
  assert.ok(cleanShareRequest({ kind: "poll", id: "p1" }).error);
  assert.deepEqual(cleanShareRequest({ kind: "discussion", id: A }), { kind: "discussion", id: A, sessionId: "" });
  assert.deepEqual(cleanShareRequest({ kind: "discussion", sessionId: "d1-7" }), { kind: "discussion", id: "d1-7", sessionId: "d1-7" });
  assert.ok(cleanShareRequest({ kind: "post", id: A }).error);
  assert.ok(cleanShareRequest({ kind: "discussion", id: "../x y" }).error);
});

test("share drafts: the session, the question and results, #TTFC2026, the TTFC page named (tagged when posted)", () => {
  assert.equal(resultsLine(["Exploring", "Piloting"], [3, 1]), "Exploring 75% · Piloting 25%");
  assert.equal(resultsLine(["A"], [0]), "");
  const p = shareDraft({ kind: "poll", question: "Where is your organisation on the AI journey?", options: ["Exploring", "Piloting"], counts: [3, 1] },
    { title: "The AI Agenda" }, { sessionId: "d1-5" });
  assert.equal(p.link, "https://www.thetechfestival.com/agenda?session=d1-5");
  assert.equal(p.title, "The AI Agenda");
  assert.match(p.text, /^"Where is your organisation on the AI journey\?" I just voted in the live poll at "The AI Agenda" at The Tech Festival Canada\./);
  assert.match(p.text, /Results so far: Exploring 75% · Piloting 25%/);
  assert.match(p.text, /#TTFC2026$/);
  const d = shareDraft({ kind: "discussion", discussionTitle: "Quantum in banking", discussionBody: "Who is piloting?" }, null);
  assert.equal(d.link, "https://www.thetechfestival.com");
  assert.match(d.text, /^Joining the conversation on "Quantum in banking" at The Tech Festival Canada\./);
  assert.equal(sessionLink("d1 7"), "https://www.thetechfestival.com/agenda?session=d1%207");
  assert.equal(shareItemKey({ kind: "poll", id: "d1-5-p1", sessionId: "d1-5" }), "poll:d1-5:d1-5-p1");
  assert.equal(shareItemKey({ kind: "discussion", id: A }), `discussion:${A}`);
  assert.equal(shareItemKey({ kind: "discussion", id: "d1-7" }), "session:d1-7");
});

test("share return URLs, states and tokens", () => {
  const post = "https://www.linkedin.com/feed/update/urn:li:share:123/";
  assert.equal(shareReturnUrl("https://www.thetechfestival.com/", { post }), `https://www.thetechfestival.com/share/linkedin#posted=1&post=${encodeURIComponent(post)}`);
  const t = newShareToken();
  assert.ok(isShareToken(t));
  assert.equal(shareReturnUrl("https://x.test", { error: "cancelled", token: t }), `https://x.test/share/linkedin#post_error=cancelled&t=${t}`);
  assert.equal(shareReturnUrl("https://x.test", { post: "https://evil.example.com/" }), "https://x.test/share/linkedin#posted=1");
  assert.ok(isShareState(newShareState()));
  assert.equal(isShareState("ttfc-att.p" + "0".repeat(32)), false);
});
