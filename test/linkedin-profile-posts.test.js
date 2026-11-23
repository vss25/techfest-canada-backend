/* Marketing › LinkedIn posts for my profile (Nov 22 2026): the pure rules in services/linkedinProfilePosts.js.
   No database, no network. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SETTINGS_DEFAULTS, TOPIC_KEYS, answerJson, applyChecks, cleanReturnTo, cleanSettings, composePost, costUsd, hasDash,
  keepDifferent, keepSourced, noDashes, normalizeUrl, pickEvents, returnUrl, seenSources, shareBoxUrl, similarity, writerPrompt,
} from "../services/linkedinProfilePosts.js";
import { postTextToLinkedin } from "../services/linkedinPost.js";

test("no em-dashes: every kind is taken out and the sentence still reads", () => {
  assert.equal(noDashes("Canada — and its partners — moved fast."), "Canada, and its partners, moved fast.");
  assert.equal(noDashes("Canada—its partners"), "Canada, its partners");
  assert.equal(noDashes("Budget 2026–2027 and pages 4 – 9"), "Budget 2026-2027 and pages 4-9");
  assert.equal(noDashes("A list:\n— first\n– second"), "A list:\n- first\n- second");
  assert.equal(noDashes("It ended —."), "It ended.");
  assert.equal(noDashes("Ottawa ― quietly ‒ acted"), "Ottawa, quietly, acted");
  assert.equal(noDashes("plain -- double"), "plain, double");
  assert.equal(noDashes("well-known co-op"), "well-known co-op");   // hyphens stay
  for (const s of ["a — b", "x–y", "— lead", "q ―", "1‒2"]) assert.equal(hasDash(noDashes(s)), false, s);
});

test("settings: defaults, limits, bad values fall back, a topic and an audience are required", () => {
  const { value } = cleanSettings({});
  assert.deepEqual(value.topics, TOPIC_KEYS);
  assert.equal(value.voice, "warm");
  assert.equal(value.count, 3);
  const v = cleanSettings({ voice: "shouty", length: "epic", hashtags: 99, count: 0, pillars: ["Quantum Computing", "Nope"], spelling: "British", emoji: 1 }).value;
  assert.equal(v.voice, "warm");
  assert.equal(v.length, "medium");
  assert.equal(v.hashtags, 5);
  assert.equal(v.count, 1);
  assert.deepEqual(v.pillars, ["Quantum Computing"]);
  assert.equal(v.spelling, "British");
  assert.equal(v.emoji, true);
  assert.match(cleanSettings({ topics: [] }).error, /topic/);
  assert.match(cleanSettings({ inviteWho: ["investors"] }).error, /sponsors/);
  assert.equal(cleanSettings({ about: "x".repeat(5000) }).value.about.length, 1200);
  assert.equal(SETTINGS_DEFAULTS.sourcesInPost, true);
});

const searchBlock = {
  type: "web_search_tool_result",
  content: [
    { type: "web_search_result", url: "https://www.canada.ca/en/news/2026/11/ai-strategy.html?utm_source=x", title: "Canada's AI strategy", page_age: "November 10, 2026" },
    { type: "web_search_result", url: "https://www.reuters.com/world/canada-trade-2026-11-12/", title: "Canada and EU trade" },
  ],
};

test("sources: only URLs the search returned count, matched without www, tracking or a trailing slash", () => {
  assert.equal(normalizeUrl("https://WWW.Canada.ca/en/x/?utm_source=a&id=2#top"), "canada.ca/en/x?id=2");
  assert.equal(normalizeUrl("ftp://canada.ca/x"), "");
  assert.equal(normalizeUrl("not a url"), "");
  const seen = seenSources([searchBlock, { type: "text", text: "x", citations: [{ url: "https://ised-isde.canada.ca/site/x", title: "ISED" }] },
    { type: "web_fetch_tool_result", content: { type: "web_fetch_result", url: "https://www.bankofcanada.ca/2026/11/rate/", content: { title: "Rate" } } }]);
  assert.equal(seen.size, 4);
  const { kept, dropped } = keepSourced([
    { headline: "AI", topic: "pillars", eventKey: "van-2027", body: "Body one.", hashtags: ["AI", "#Canada", "bad tag!"],
      sources: [{ url: "https://canada.ca/en/news/2026/11/ai-strategy.html", title: "", supports: "the plan" },
                { url: "https://made-up.example.com/fake", title: "Fake", supports: "?" },
                { url: "https://www.canada.ca/en/news/2026/11/ai-strategy.html/", title: "dup", supports: "dup" }] },
    { headline: "Invented", topic: "impact", eventKey: "", body: "Body two.", hashtags: [], sources: [{ url: "https://nowhere.example.org/a", title: "A", supports: "b" }] },
  ], seen);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].sources.length, 1);
  assert.equal(kept[0].sources[0].url, "https://www.canada.ca/en/news/2026/11/ai-strategy.html?utm_source=x");  // the real URL as returned
  assert.equal(kept[0].sources[0].title, "Canada's AI strategy");
  assert.deepEqual(kept[0].hashtags, ["#AI", "#Canada", "#badtag"]);
  assert.deepEqual(dropped, [{ headline: "Invented", why: "no real source" }]);
});

test("the fact-check: drop goes, fix takes the new body, only confirmed sources stay, unconfirmed or unchecked drafts go", () => {
  const src = (u) => ({ url: u, title: "t", supports: "s" });
  const drafts = [
    { headline: "A", body: "a", sources: [src("https://a.ca/1"), src("https://a.ca/2")] },
    { headline: "B", body: "b", sources: [src("https://b.ca/1")] },
    { headline: "C", body: "c", sources: [src("https://c.ca/1")] },
    { headline: "D", body: "d", sources: [src("https://d.ca/1")] },
    { headline: "E", body: "e", sources: [src("https://e.ca/1")] },
  ];
  const { kept, dropped } = applyChecks(drafts, [
    { index: 0, verdict: "keep", body: "", confirmed: ["https://www.a.ca/2/"], notes: "ok" },
    { index: 1, verdict: "fix", body: "b fixed", confirmed: ["https://b.ca/1"], notes: "date corrected" },
    { index: 2, verdict: "drop", body: "", confirmed: [], notes: "stale" },
    { index: 3, verdict: "keep", body: "", confirmed: ["https://invented.ca/x"], notes: "" },
  ]);
  assert.deepEqual(kept.map((k) => [k.headline, k.body, k.sources.map((s) => s.url), k.check.verdict]),
    [["A", "a", ["https://a.ca/2"], "passed"], ["B", "b fixed", ["https://b.ca/1"], "fixed"]]);
  assert.deepEqual(dropped.map((d) => [d.headline, d.why]), [["C", "stale"], ["D", "no source confirmed it"], ["E", "not checked"]]);
});

test("the post: body without dashes, the sources' links, hashtags last, within 3,000 characters", () => {
  const d = { body: "Ottawa moved — fast.", hashtags: ["#AI", "#Canada"], sources: [{ url: "https://canada.ca/x", title: "Canada — news" }] };
  assert.equal(composePost(d), "Ottawa moved, fast.\n\nSources:\nCanada, news: https://canada.ca/x\n\n#AI #Canada");
  assert.equal(composePost(d, { sourcesInPost: false }), "Ottawa moved, fast.\n\n#AI #Canada");
  const long = composePost({ body: "w ".repeat(1600), hashtags: [], sources: [{ url: "https://canada.ca/x", title: "x".repeat(300) }] });
  assert.ok(long.length <= 3000);
  assert.match(shareBoxUrl("Hi & bye"), /^https:\/\/www\.linkedin\.com\/feed\/\?shareActive=true&text=Hi%20%26%20bye$/);
});

test("different for every person: near copies of someone else's post (or each other) are dropped", () => {
  const theirs = "Canada's new AI compute strategy puts two billion dollars into sovereign data centres across the country this year.";
  assert.ok(similarity(theirs, theirs) === 1);
  assert.ok(similarity(theirs, "Quantum startups in Montreal raised a record round from European investors last week.") < 0.1);
  const { kept, dropped } = keepDifferent([
    { headline: "copy", body: `${theirs} Here is what it means.` },
    { headline: "own", body: "Montreal quantum startups are drawing European money, and that changes who builds here." },
    { headline: "own again", body: "Montreal quantum startups are drawing European money, and that changes who builds here. Indeed." },
  ], [theirs]);
  assert.deepEqual(kept.map((k) => k.headline), ["own"]);
  assert.deepEqual(dropped.map((d) => d.why), ["too close to another post", "too close to another post"]);
});

test("events: the most recent (ended within 120 days), the next and the main event", () => {
  const rows = [
    { eventKey: "tor-2026", name: "TTFC 2026", city: "Toronto", type: "main-event", startDate: "2026-10-26", endDate: "2026-10-27" },
    { eventKey: "van-2027", name: "Vancouver Briefing", city: "Vancouver", type: "briefing", startDate: "2027-02-03" },
    { eventKey: "tor-2027", name: "TTFC 2027", city: "Toronto", type: "main-event", startDate: "2027-10-20" },
    { eventKey: "nodate", name: "No date" },
  ];
  const e = pickEvents(rows, new Date("2026-11-22T12:00:00Z"));
  assert.equal(e.recent.key, "tor-2026");
  assert.equal(e.next.key, "van-2027");
  assert.equal(e.main.key, "tor-2027");
  assert.equal(e.next.when, "February 3, 2027");
  const later = pickEvents(rows, new Date("2027-06-01T12:00:00Z"));
  assert.equal(later.recent.key, "van-2027");
  assert.equal(pickEvents([], new Date()).next, null);
});

test("the request names the person, their voice and what colleagues already wrote", () => {
  const p = writerPrompt({ settings: { ...cleanSettings({ voice: "bold", count: 2, notes: "Mention Vancouver's AI scene" }).value, displayName: "Sam Lee", role: "CEO" },
    events: { next: { key: "van-2027", name: "Vancouver Briefing", city: "Vancouver", when: "February 3, 2027" } },
    others: ["EU trade deal · Reuters"], mine: ["AI strategy"], today: new Date("2026-11-22T00:00:00Z") });
  assert.match(p, /Write 2 different LinkedIn posts for Sam Lee, CEO/);
  assert.match(p, /Direct and confident/);
  assert.match(p, /Colleagues already have posts about these[\s\S]*EU trade deal/);
  assert.match(p, /key "van-2027"/);
  assert.match(p, /Mention Vancouver's AI scene/);
});

test("Claude's answer: the JSON after the last tool result, the cost with searches", () => {
  const content = [{ type: "text", text: "Let me search." }, { type: "server_tool_use", id: "s1", name: "web_search", input: {} }, searchBlock, { type: "text", text: "{\"posts\":[" }, { type: "text", text: "]}" }];
  assert.deepEqual(answerJson(content), { posts: [] });
  assert.deepEqual(answerJson([{ type: "text", text: "Here: {\"a\":1} done" }]), { a: 1 });
  assert.equal(answerJson([{ type: "text", text: "no json" }]), null);
  assert.equal(Math.round(costUsd({ input_tokens: 100000, output_tokens: 10000, server_tool_use: { web_search_requests: 5 } }) * 100) / 100, 0.65);
});

test("returning to the panel: only our own sites; the hash says what happened", () => {
  assert.equal(cleanReturnTo("https://www.thetechfestival.com/admin/linkedin-posts"), "https://www.thetechfestival.com");
  assert.equal(cleanReturnTo("https://techfest-canada-frontend-abc123-ttfc-projects.vercel.app/x"), "https://techfest-canada-frontend-abc123-ttfc-projects.vercel.app");
  assert.equal(cleanReturnTo("http://localhost:5173/admin"), "http://localhost:5173");
  assert.equal(cleanReturnTo("https://evil.example.com/admin"), "");
  assert.equal(cleanReturnTo("https://techfest-canada-backend.onrender.com/"), "");
  assert.equal(cleanReturnTo("javascript:alert(1)"), "");
  assert.equal(returnUrl("https://www.thetechfestival.com", { id: "abc", post: "https://www.linkedin.com/feed/update/urn:li:share:1/" }),
    "https://www.thetechfestival.com/admin/linkedin-posts#posted=abc&post=https%3A%2F%2Fwww.linkedin.com%2Ffeed%2Fupdate%2Furn%3Ali%3Ashare%3A1%2F");
  assert.equal(returnUrl("https://x.test", { error: "cancelled", id: "abc" }), "https://x.test/admin/linkedin-posts#post_error=cancelled&d=abc");
});

test("a text post on the person's own profile: no link card, the TTFC page tagged only where the text names it", async () => {
  const sent = [];
  const http = { post: async (url, body) => { sent.push(body); return { headers: { "x-restli-id": "urn:li:share:77" } }; } };
  const r = await postTextToLinkedin({ accessToken: "t", personId: "p1", text: "Policy news. #AI", http, versions: ["202609"] });
  assert.equal(r.url, "https://www.linkedin.com/feed/update/urn:li:share:77/");
  assert.equal(sent[0].author, "urn:li:person:p1");
  assert.equal(sent[0].content, undefined);
  assert.equal(sent[0].commentary, "Policy news. {hashtag|\\#|AI}");
  await postTextToLinkedin({ accessToken: "t", personId: "p1", text: "See you at The Tech Festival Canada", http, versions: ["202609"] });
  assert.match(sent[1].commentary, /@\[The Tech Festival Canada\]\(urn:li:organization:105812464\)/);
  await assert.rejects(postTextToLinkedin({ accessToken: "t", personId: "p1", text: "  ", http }));
});
