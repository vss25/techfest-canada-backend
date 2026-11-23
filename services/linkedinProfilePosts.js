import crypto from "node:crypto";
import { PILLARS, SECTORS } from "./nominations.js";
import { originAllowed } from "./corsOrigins.js";

/* =========================================================
   Marketing › LinkedIn posts for my profile (Nov 22 2026). Pure parts only; routes in
   routes/linkedinProfilePosts.js.

   The owner: drafts management post on their OWN LinkedIn profiles about Canada's 5 pillars and
   5 sectors, Canadian government relationships and policies (and updates on them), what those
   policies and decisions mean for the Canadian market and the world, and geopolitical events
   that touch Canada or Canadian companies in those pillars and sectors. Each post leads with
   real insight and lightly invites sponsors, speakers and exhibitors to the most recent event,
   the next one or the main event. Never a sales pitch. No em-dashes (enforced here, after
   generation, not only in the prompt). Every post is checked and cites real sources found by
   web search; anything that can't be sourced is dropped. No two people get the same content.
========================================================= */

export { PILLARS, SECTORS };

/** What a post can be about. Keys are stored; labels are what the panel shows. */
export const TOPICS = Object.freeze([
  { key: "pillars", label: "Canada's 5 tech pillars", hint: PILLARS.join(", ") },
  { key: "sectors", label: "Canada's 5 sectors", hint: SECTORS.join(", ") },
  { key: "government", label: "Government relationships and policy updates", hint: "Federal and provincial policy, programmes, trade and partnerships" },
  { key: "impact", label: "What policy means for the market and the world", hint: "The effect of decisions on Canadian companies, investment and global partners" },
  { key: "geopolitics", label: "Geopolitics that affects Canada", hint: "World events touching Canadian companies in these pillars and sectors" },
]);
export const TOPIC_KEYS = TOPICS.map((t) => t.key);

export const VOICES = Object.freeze([
  { key: "warm", label: "Warm and personal", prompt: "Warm, personal and generous. First person. Sounds like a person sharing what they noticed, not a company." },
  { key: "expert", label: "Thoughtful expert", prompt: "Calm, precise and analytical. First person. Explains why something matters with one clear point of view." },
  { key: "bold", label: "Bold and direct", prompt: "Direct and confident. Short sentences. Takes a clear position and backs it with the facts." },
  { key: "plain", label: "Simple and plain", prompt: "Plain, simple words. Short paragraphs. No jargon. Easy to read on a phone." },
]);
export const VOICE_KEYS = VOICES.map((v) => v.key);

export const LENGTHS = Object.freeze([
  { key: "short", label: "Short (about 80 words)", words: [50, 110] },
  { key: "medium", label: "Medium (about 150 words)", words: [110, 190] },
  { key: "long", label: "Long (about 250 words)", words: [190, 300] },
]);
export const LENGTH_KEYS = LENGTHS.map((l) => l.key);

export const INVITE_WHO = Object.freeze([
  { key: "sponsors", label: "Sponsors", path: "/sponsor" },
  { key: "speakers", label: "Speakers", path: "/speak" },
  { key: "exhibitors", label: "Exhibitors", path: "/exhibit" },
]);
export const INVITE_KEYS = INVITE_WHO.map((w) => w.key);

/** Which event the invitation points to: Claude picks, or always one of these. */
export const INVITE_EVENT = Object.freeze([
  { key: "auto", label: "Let Claude pick the best fit" },
  { key: "next", label: "Our next event" },
  { key: "recent", label: "Our most recent event" },
  { key: "main", label: "The Toronto main event" },
]);

export const SETTINGS_DEFAULTS = Object.freeze({
  displayName: "",
  role: "",
  about: "",
  voice: "warm",
  length: "medium",
  topics: [...TOPIC_KEYS],
  pillars: [],                 // empty = any of the 5
  sectors: [],                 // empty = any of the 5
  inviteWho: [...INVITE_KEYS],
  inviteEvent: "auto",
  emoji: false,
  hashtags: 3,
  sourcesInPost: true,         // the post ends with its sources' links
  avoid: "",
  notes: "",
  spelling: "Canadian",
  count: 3,                    // drafts per round
});

/* Claude Opus 5.5 ($4 in, $20 out per million tokens, cache reads $0.20) + web search at $10 per 1,000 searches.
   Web fetch costs only the tokens it reads. */
export const PRICE = { input: 4, output: 20, cacheRead: 0.2, search: 0.01 };
export function costUsd(usage = {}) {
  const searches = Number(usage.server_tool_use?.web_search_requests || 0);
  return ((usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0)) * PRICE.input / 1e6
    + (usage.cache_read_input_tokens || 0) * PRICE.cacheRead / 1e6
    + (usage.output_tokens || 0) * PRICE.output / 1e6
    + searches * PRICE.search;
}

export const DAILY_ROUNDS = 6;          // writing rounds per person per Toronto day
export const RUN_STALE_MS = 15 * 60 * 1000;
export const POST_MAX = 3000;           // LinkedIn's limit

const str = (v, max) => String(v ?? "").replace(/\r\n?/g, "\n").replace(/[^\P{Cc}\n\t]/gu, "").slice(0, max);
const pickList = (v, allowed) => [...new Set((Array.isArray(v) ? v : []).map(String).filter((x) => allowed.includes(x)))];

/** One person's settings from the panel → { value } or { error }. Missing fields keep their defaults. */
export function cleanSettings(body = {}, base = SETTINGS_DEFAULTS) {
  const b = { ...base, ...(body || {}) };
  const topics = pickList(b.topics, TOPIC_KEYS);
  if (!topics.length) return { error: "Pick at least one topic." };
  const inviteWho = pickList(b.inviteWho, INVITE_KEYS);
  if (!inviteWho.length) return { error: "Pick who the posts invite: sponsors, speakers or exhibitors." };
  const hashtags = Math.round(Number(b.hashtags));
  const count = Math.round(Number(b.count));
  return { value: {
    displayName: str(b.displayName, 80).trim(),
    role: str(b.role, 120).trim(),
    about: str(b.about, 1200).trim(),
    voice: VOICE_KEYS.includes(b.voice) ? b.voice : "warm",
    length: LENGTH_KEYS.includes(b.length) ? b.length : "medium",
    topics,
    pillars: pickList(b.pillars, PILLARS),
    sectors: pickList(b.sectors, SECTORS),
    inviteWho,
    inviteEvent: INVITE_EVENT.some((e) => e.key === b.inviteEvent) ? b.inviteEvent : "auto",
    emoji: !!b.emoji,
    hashtags: Number.isFinite(hashtags) ? Math.max(0, Math.min(5, hashtags)) : 3,
    sourcesInPost: b.sourcesInPost !== false,
    avoid: str(b.avoid, 400).trim(),
    notes: str(b.notes, 800).trim(),
    spelling: ["American", "British"].includes(b.spelling) ? b.spelling : "Canadian",
    count: Number.isFinite(count) ? Math.max(1, Math.min(4, count)) : 3,
  } };
}

/* ---------- no em-dashes ---------- */

/**
 * Takes every em-dash (and the dashes that read like one) out of generated text, keeping it readable:
 * "Canada — and its partners" → "Canada, and its partners"; "2026–2027" → "2026-2027"; a dash that opens a
 * line becomes "- ". Runs after generation, whatever the prompt said.
 */
export function noDashes(text) {
  return String(text || "")
    .replace(/(\d)\s*[–‒]\s*(\d)/g, "$1-$2")               // number ranges keep a hyphen
    .replace(/^[ \t]*[—–―‒][ \t]*/gm, "- ")                 // a dash opening a line (a list) → hyphen
    .replace(/\s*[—–―‒]+\s*(?=[,.;:!?)]|$)/gm, "")          // a dash before punctuation or at a line end → gone
    .replace(/\s*[—–―‒]+\s*/g, ", ")                         // anything else → a comma
    .replace(/\s+--\s+/g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/[ \t]+\n/g, "\n");
}
export const hasDash = (text) => /[—–―‒]/.test(String(text || ""));

/* ---------- sources: only what the web search really returned ---------- */

/** A URL as we compare it: https only, no hash, no tracking parameters, no trailing slash. "" when unusable. */
export function normalizeUrl(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { return ""; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "";
  if (!u.hostname.includes(".")) return "";
  u.hash = "";
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_|ref$|ref_src$)/i.test(k)) u.searchParams.delete(k);
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  return `${u.hostname}${u.pathname.replace(/\/+$/, "")}${u.search}`;
}

/**
 * Every page the web tools really returned in a response's content: web search results, pages web fetch
 * opened, and citations on text. Map normalized URL → { url, title, pageAge }.
 */
export function seenSources(content = [], into = new Map()) {
  const add = (url, title = "", pageAge = "") => {
    const key = normalizeUrl(url);
    if (key && /^https?:\/\//.test(String(url)) && !into.has(key)) into.set(key, { url: String(url), title: String(title || "").slice(0, 300), pageAge: String(pageAge || "") });
  };
  for (const b of content || []) {
    if (b?.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content) if (r?.type === "web_search_result") add(r.url, r.title, r.page_age);
    } else if (b?.type === "web_fetch_tool_result" && b.content?.type === "web_fetch_result") {
      add(b.content.url, b.content.content?.title || "");
    } else if (b?.type === "text" && Array.isArray(b.citations)) {
      for (const c of b.citations) if (c?.url) add(c.url, c.title);
    }
  }
  return into;
}

/** The JSON a structured answer carries: the text blocks after the last tool result, else every text block. */
export function answerJson(content = []) {
  const blocks = content || [];
  let last = -1;
  blocks.forEach((b, i) => { if (/_tool_result$/.test(String(b?.type || "")) || b?.type === "server_tool_use") last = i; });
  const after = blocks.slice(last + 1).filter((b) => b?.type === "text").map((b) => b.text).join("");
  for (const text of [after, blocks.filter((b) => b?.type === "text").map((b) => b.text).join("")]) {
    if (!text.trim()) continue;
    try { return JSON.parse(text); } catch { /* try the outermost braces */ }
    const i = text.indexOf("{"), j = text.lastIndexOf("}");
    if (i >= 0 && j > i) { try { return JSON.parse(text.slice(i, j + 1)); } catch { /* next */ } }
  }
  return null;
}

/* ---------- different for every person ---------- */

const words = (t) => String(t || "").toLowerCase().replace(/https?:\/\/\S+/g, " ").match(/[\p{L}\p{N}']+/gu) || [];
function shingles(t, n = 3) {
  const w = words(t);
  const out = new Set();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}
/** How much two posts share, 0…1 (Jaccard over 3-word runs). */
export function similarity(a, b) {
  const A = shingles(a), B = shingles(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const s of A) if (B.has(s)) both++;
  return both / (A.size + B.size - both);
}
export const TOO_SIMILAR = 0.3;

/* ---------- events to invite people to ---------- */

const DAY = 24 * 60 * 60 * 1000;

/**
 * From EventConfig rows: the most recent event (ended within 120 days), the next one, and the Toronto main event
 * (the next one, else the latest). Each { key, name, city, type, start, end, when } or null. Drafts and past rows
 * count; a row with no dates is skipped.
 */
export function pickEvents(rows = [], now = new Date()) {
  const t = now.getTime();
  const list = rows.filter((r) => r?.eventKey && r.startDate).map((r) => {
    const start = new Date(r.startDate), end = new Date(r.endDate || r.startDate);
    return { key: String(r.eventKey), name: String(r.name || r.eventKey), city: String(r.city || ""), type: r.type === "main-event" ? "main-event" : "briefing",
             start, end, when: start.toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) };
  }).filter((e) => !Number.isNaN(e.start.getTime())).sort((a, b) => a.start - b.start);
  const recent = [...list].reverse().find((e) => e.end.getTime() < t && e.end.getTime() > t - 120 * DAY) || null;
  const next = list.find((e) => e.end.getTime() >= t) || null;
  const mains = list.filter((e) => e.type === "main-event");
  const main = mains.find((e) => e.end.getTime() >= t) || mains[mains.length - 1] || null;
  const shown = (e) => (e ? { ...e, start: e.start.toISOString(), end: e.end.toISOString() } : null);
  return { recent: shown(recent), next: shown(next), main: shown(main) };
}

/* ---------- the prompts ---------- */

const topicLines = (s) => TOPICS.filter((t) => s.topics.includes(t.key)).map((t) => {
  if (t.key === "pillars") return `- ${t.label}: ${(s.pillars.length ? s.pillars : PILLARS).join("; ")}`;
  if (t.key === "sectors") return `- ${t.label}: ${(s.sectors.length ? s.sectors : SECTORS).join("; ")}`;
  return `- ${t.label}: ${t.hint}`;
}).join("\n");

/** The writer's instructions. Stable per person, so it caches between their rounds. */
export function writerSystem() {
  return [
    "You draft LinkedIn posts that senior people at The Tech Festival Canada (TTFC) publish on their own personal profiles.",
    "TTFC runs city Briefings across Canada and a main event in Toronto. Its focus is Canada's five technology pillars",
    `(${PILLARS.join("; ")}) across five sectors (${SECTORS.join("; ")}).`,
    "",
    "How every post works:",
    "1. Lead with real, current insight: a recent development (ideally from the last 30 days) in Canadian policy, government relationships, the market, or world events that affect Canada or Canadian companies in those pillars and sectors. Say what happened and why it matters, with one clear point of view.",
    "2. Then, lightly and briefly, invite sponsors, speakers or exhibitors to the event given. One or two sentences at most, near the end. It must never read like a sales pitch: no prices, no urgency, no \"don't miss\", no \"limited spots\". Think of a person mentioning where the conversation continues.",
    "3. Write in the first person as the profile owner. No em-dashes or en-dashes at all: use commas, full stops or colons.",
    "",
    "Research rules (strict):",
    "- Use web search to find real, current, reputable sources: Government of Canada and provincial sites, official statements, regulators, established news outlets, respected research bodies.",
    "- Every fact, number, date and name in a post must come from a source you found in this conversation. Never invent facts, quotes, figures or URLs.",
    "- List each post's sources with the exact URL as the search returned it. If you can't source a post well, leave it out rather than guess.",
    "- Never name or speak for a TTFC sponsor, speaker or partner unless a source says it.",
    "",
    "Return JSON only, in the given schema. `body` is the post text without the sources list and without hashtags; `hashtags` are separate.",
  ].join("\n");
}

/** One round's request: who's writing, their settings, the events, and what others already wrote (to be different). */
export function writerPrompt({ settings: s, person = {}, events = {}, eventChoice = null, inviteLinks = {}, mine = [], others = [], today = new Date() }) {
  const voice = VOICES.find((v) => v.key === s.voice) || VOICES[0];
  const length = LENGTHS.find((l) => l.key === s.length) || LENGTHS[1];
  const ev = (label, e) => (e ? `- ${label}: ${e.name}${e.city ? `, ${e.city}` : ""}, ${e.when} (key "${e.key}")` : "");
  const evLines = eventChoice
    ? [ev("Invite people to", eventChoice)]
    : [ev("Most recent event", events.recent), ev("Next event", events.next), ev("Main event", events.main)];
  const parts = [
    `Today is ${today.toISOString().slice(0, 10)}.`,
    `Write ${s.count} different LinkedIn posts for ${s.displayName || person.name || "a TTFC leader"}${s.role || person.title ? `, ${s.role || person.title}` : ""} at The Tech Festival Canada.`,
    s.about ? `About them, in their words:\n<about>\n${s.about}\n</about>` : "",
    `Voice: ${voice.prompt}`,
    `Length: ${length.words[0]} to ${length.words[1]} words for the body.`,
    `Spelling: ${s.spelling} English.`,
    s.emoji ? "Emoji: one or two where natural." : "Emoji: none.",
    `Hashtags: ${s.hashtags ? `${s.hashtags}, relevant and common` : "none"}.`,
    s.avoid ? `Never use these words or phrases: ${s.avoid}.` : "",
    s.notes ? `Their extra direction: ${s.notes}` : "",
    `Topics to choose from (spread the posts across different ones):\n${topicLines(s)}`,
    `The invitation is for: ${INVITE_WHO.filter((w) => s.inviteWho.includes(w.key)).map((w) => w.label.toLowerCase()).join(", ")}.`,
    `Events (use one per post; give its key as eventKey):\n${evLines.filter(Boolean).join("\n") || "- The Tech Festival Canada main event in Toronto (key \"\")"}`,
    Object.keys(inviteLinks).length ? `Links you may use once in the invitation (optional): ${Object.entries(inviteLinks).map(([k, v]) => `${k} ${v}`).join("; ")}` : "",
    mine.length ? `They already have drafts about these, so pick different news and angles:\n${mine.map((m) => `- ${m}`).join("\n")}` : "",
    others.length ? `Colleagues already have posts about these. Every post here must be clearly different in news, angle and wording:\n${others.map((m) => `- ${m}`).join("\n")}` : "",
  ];
  return parts.filter(Boolean).join("\n\n");
}

export const writerSchema = {
  type: "object",
  properties: {
    posts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          headline: { type: "string" },
          topic: { type: "string", enum: TOPIC_KEYS },
          eventKey: { type: "string" },
          body: { type: "string" },
          hashtags: { type: "array", items: { type: "string" } },
          sources: {
            type: "array",
            items: {
              type: "object",
              properties: { url: { type: "string" }, title: { type: "string" }, supports: { type: "string" } },
              required: ["url", "title", "supports"],
              additionalProperties: false,
            },
          },
        },
        required: ["headline", "topic", "eventKey", "body", "hashtags", "sources"],
        additionalProperties: false,
      },
    },
  },
  required: ["posts"],
  additionalProperties: false,
};

/** The fact-checker's instructions. */
export function checkerSystem() {
  return [
    "You fact-check LinkedIn post drafts before a senior person publishes them on their own profile.",
    "For each draft, open its source URLs with web fetch (open every source you need; only the URLs listed) and check every fact, number, date, name and claim in the body against them.",
    "Verdicts: \"keep\" when every claim is supported; \"fix\" when small corrections make it accurate (return the corrected body, same voice and length, and nothing new that the sources don't support); \"drop\" when a key claim isn't supported, a source doesn't load or doesn't say it, the news is stale, or the post reads like a sales pitch.",
    "`confirmed` lists only the source URLs you opened that support the post, exactly as given. Never add a URL.",
    "No em-dashes or en-dashes in a corrected body. Return JSON only, in the given schema.",
  ].join("\n");
}

export function checkerPrompt(drafts = []) {
  return [
    `Check these ${drafts.length} drafts.`,
    ...drafts.map((d, i) => [
      `<draft index="${i}">`,
      `<body>\n${d.body}\n</body>`,
      "Sources:",
      ...d.sources.map((s) => `- ${s.url} (${s.title}): ${s.supports}`),
      "</draft>",
    ].join("\n")),
  ].join("\n\n");
}

export const checkerSchema = {
  type: "object",
  properties: {
    reviews: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          verdict: { type: "string", enum: ["keep", "fix", "drop"] },
          body: { type: "string" },
          confirmed: { type: "array", items: { type: "string" } },
          notes: { type: "string" },
        },
        required: ["index", "verdict", "body", "confirmed", "notes"],
        additionalProperties: false,
      },
    },
  },
  required: ["reviews"],
  additionalProperties: false,
};

/* ---------- from Claude's answers to saved drafts ---------- */

const tag = (h) => {
  const t = String(h || "").trim().replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "");
  return t ? `#${t.slice(0, 60)}` : "";
};

/**
 * Keeps only sources the web tools really returned (`seen`), with their real URL. Posts with none are dropped.
 * → { kept: [draft], dropped: [{ headline, why }] }
 */
export function keepSourced(posts = [], seen = new Map()) {
  const kept = [], dropped = [];
  for (const p of Array.isArray(posts) ? posts : []) {
    const body = String(p?.body || "").trim();
    if (!body) continue;
    const sources = [];
    const used = new Set();
    for (const s of Array.isArray(p.sources) ? p.sources : []) {
      const key = normalizeUrl(s?.url);
      const real = key && seen.get(key);
      if (!real || used.has(key)) continue;
      used.add(key);
      sources.push({ url: real.url, title: String(s.title || real.title || "").slice(0, 200).trim() || real.title, supports: String(s.supports || "").slice(0, 400) });
    }
    if (!sources.length) { dropped.push({ headline: String(p.headline || body.slice(0, 80)), why: "no real source" }); continue; }
    kept.push({ headline: String(p.headline || "").slice(0, 160), topic: TOPIC_KEYS.includes(p.topic) ? p.topic : "", eventKey: String(p.eventKey || "").slice(0, 80),
                body, hashtags: (Array.isArray(p.hashtags) ? p.hashtags : []).map(tag).filter(Boolean).slice(0, 5), sources });
  }
  return { kept, dropped };
}

/**
 * Applies the fact-check: "drop" goes, "fix" takes the corrected body, and each post keeps only the sources the
 * checker confirmed (and we had). A post left with no confirmed source, or that the checker skipped, is dropped.
 */
export function applyChecks(drafts = [], reviews = []) {
  const byIndex = new Map((Array.isArray(reviews) ? reviews : []).map((r) => [Number(r?.index), r]));
  const kept = [], dropped = [];
  drafts.forEach((d, i) => {
    const r = byIndex.get(i);
    if (!r) { dropped.push({ headline: d.headline, why: "not checked" }); return; }
    if (r.verdict === "drop") { dropped.push({ headline: d.headline, why: String(r.notes || "didn't pass the check").slice(0, 300) }); return; }
    const ok = new Set((Array.isArray(r.confirmed) ? r.confirmed : []).map(normalizeUrl).filter(Boolean));
    const sources = d.sources.filter((s) => ok.has(normalizeUrl(s.url)));
    if (!sources.length) { dropped.push({ headline: d.headline, why: "no source confirmed it" }); return; }
    const body = r.verdict === "fix" && String(r.body || "").trim() ? String(r.body).trim() : d.body;
    kept.push({ ...d, body, sources, check: { verdict: r.verdict === "fix" ? "fixed" : "passed", notes: String(r.notes || "").slice(0, 600) } });
  });
  return { kept, dropped };
}

/** The post as it's first shown: body, hashtags, then (by default) the sources' links. No dashes. Within LinkedIn's limit. */
export function composePost(d, { sourcesInPost = true } = {}) {
  const body = noDashes(d.body).trim();
  const tags = (d.hashtags || []).join(" ");
  const src = sourcesInPost && d.sources?.length
    ? `Sources:\n${d.sources.map((s) => `${noDashes(s.title || "Source").replace(/\s+/g, " ").trim()}: ${s.url}`).join("\n")}` : "";
  let out = [body, src, tags].filter(Boolean).join("\n\n");
  if (out.length > POST_MAX) out = [body, tags].filter(Boolean).join("\n\n").slice(0, POST_MAX);
  return out;
}

/** Leaves out drafts too close to someone else's (or to an earlier one in the same round). */
export function keepDifferent(drafts = [], against = []) {
  const kept = [], dropped = [];
  for (const d of drafts) {
    const near = [...against, ...kept.map((k) => k.body)].some((t) => similarity(d.body, t) >= TOO_SIMILAR);
    if (near) dropped.push({ headline: d.headline, why: "too close to another post" });
    else kept.push(d);
  }
  return { kept, dropped };
}

/* ---------- posting from the person's own LinkedIn ---------- */

export const LIP_STATE = /^ttfc-lip\.[0-9a-f]{32}$/;
export const newLipState = () => `ttfc-lip.${crypto.randomBytes(16).toString("hex")}`;
export const isLipState = (s) => typeof s === "string" && LIP_STATE.test(s);
export const newGoKey = () => crypto.randomBytes(16).toString("hex");
export const isGoKey = (s) => typeof s === "string" && /^[0-9a-f]{32}$/.test(s);
export const LIP_COOKIE = "ttfc_lip_li";
export const GO_TTL_MS = 5 * 60 * 1000;
export const STATE_TTL_MS = 10 * 60 * 1000;

/** Where the panel lives (the admin page sends its own origin): a website origin we trust, else "". */
export function cleanReturnTo(raw, env = process.env) {
  let u;
  try { u = new URL(String(raw || "")); } catch { return ""; }
  const origin = u.origin;
  if (!origin || origin === "null" || /onrender\.com$/.test(u.hostname)) return "";
  return originAllowed(origin, env) ? origin : "";
}

/** Back to the page after LinkedIn: `#posted=<id>&post=<url>` or `#post_error=<code>&d=<id>`. */
export function returnUrl(origin, { id = "", post = "", error = "" } = {}) {
  const q = new URLSearchParams();
  if (error) { q.set("post_error", error); if (id) q.set("d", id); }
  else { q.set("posted", id); if (post) q.set("post", post); }
  return `${origin}/admin/linkedin-posts#${q.toString()}`;
}

/** LinkedIn's share box with the text filled in (works without our LinkedIn app; the person posts it themselves). */
export const shareBoxUrl = (text) => `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(String(text || "").slice(0, POST_MAX))}`;

/** Toronto calendar day, for the daily round limit. */
export const torontoDay = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
