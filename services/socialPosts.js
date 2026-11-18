/* =========================================================
   Marketing › Social posts and the Social media calendar (Nov 18 2026). Pure parts only.
   The organiser: "provide ability to repurpose the content for X, insta. Not just resizing the
   image, but generating the shortened content with right hashtags, ability to edit that
   regenerated content or ability to create a different variant, etc."

   A post has a main text (LinkedIn) and, once written, its own version for X and Instagram,
   each keeping every version written so far (pick one, edit it, ask for another). One photo,
   cropped per channel. Draft → In review → Approved (with a time = Scheduled) → Posted per
   channel (by hand for now, with the post's link). Late = posted more than an hour after its
   time; missed = its time passed two hours ago with a channel not posted.
========================================================= */

export const CHANNELS = [
  { key: "linkedin", label: "LinkedIn", limit: 3000, size: [1200, 627] },
  { key: "instagram", label: "Instagram", limit: 2200, size: [1080, 1350] },
  { key: "x", label: "X", limit: 280, size: [1600, 900] },
];
export const CHANNEL_KEYS = CHANNELS.map((c) => c.key);
const LIMIT = Object.fromEntries(CHANNELS.map((c) => [c.key, c.limit]));

export const SETTING_DEFAULTS = {
  brandTags: ["#TTFC2027", "#TheTechFestivalCanada"],
  topicTags: ["#AI", "#FinTech", "#Cybersecurity", "#CleanTech", "#HealthTech", "#Startups", "#Innovation"],
  tone: "Confident, warm and specific. Lead with the news. No hype words.",
  avoid: "revolutionary, game-changing, synergy, unlock, delve",
  spelling: "Canadian",
  monthlyBudgetUsd: 10,
  handles: { linkedin: "The Tech Festival Canada", instagram: "thetechfestival", x: "thetechfestival" },
};

/* Claude Opus 5.5 (the default model): $4 in, $20 out per million tokens. */
export const PRICE_PER_MTOK = { input: 4, output: 20 };
export const costUsd = (usage = {}) =>
  ((usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0)) * PRICE_PER_MTOK.input / 1e6
  + (usage.cache_read_input_tokens || 0) * 0.2 / 1e6
  + (usage.output_tokens || 0) * PRICE_PER_MTOK.output / 1e6;

/** Characters as each channel counts them: X counts every link as 23. */
export function lengthFor(channel, text = "") {
  const t = String(text || "");
  if (channel === "x") return t.replace(/(https?:\/\/\S+|\b[\w-]+(\.[\w-]+)*\.(com|ca|org|net|io|co|ai|app|dev|gov|edu|info|biz|me|tv|ly|gl)\b(\/\S*)?)/gi, "x".repeat(23)).length;
  return t.length;
}
export const overLimit = (channel, text) => lengthFor(channel, text) > LIMIT[channel];

/** The text a channel posts: its own chosen version when it has one, else the main text. */
export function textFor(post, channel) {
  if (channel === "linkedin") return post.text || "";
  const v = post.versions?.[channel];
  if (v?.own && v.list?.length) return v.list[Math.min(v.chosen || 0, v.list.length - 1)]?.text || "";
  return post.text || "";
}

/** Status as the calendar shows it. */
export function statusOf(post, now = Date.now()) {
  const on = CHANNEL_KEYS.filter((c) => post.channels?.[c]);
  const posted = on.filter((c) => post.posted?.[c]?.at);
  const at = post.scheduledAt ? new Date(post.scheduledAt).getTime() : null;
  if (on.length && posted.length === on.length) {
    const last = Math.max(...posted.map((c) => new Date(post.posted[c].at).getTime()));
    return at && last > at + 60 * 60 * 1000 ? "late" : "posted";
  }
  if (post.review?.state === "pending") return "review";
  if (post.review?.state === "changes") return "changes";
  if (post.review?.state === "approved") {
    if (at && now > at + 2 * 60 * 60 * 1000) return "missed";
    return at ? "scheduled" : "approved";
  }
  if (at && now > at + 2 * 60 * 60 * 1000) return "missed";
  return "draft";
}

export const STATUS_LABELS = {
  draft: "Planned", review: "In review", changes: "Changes requested", approved: "Approved", scheduled: "Scheduled",
  posted: "Posted on time", late: "Late", missed: "Missed",
};

const str = (v, max) => String(v ?? "").replace(/\r\n/g, "\n").slice(0, max);

/** A post from the panel → { value } or { error }. */
export function cleanPost(body = {}) {
  const channels = Object.fromEntries(CHANNEL_KEYS.map((c) => [c, body.channels ? !!body.channels[c] : true]));
  if (!CHANNEL_KEYS.some((c) => channels[c])) return { error: "Pick at least one channel." };
  const versions = {};
  for (const c of ["x", "instagram"]) {
    const v = body.versions?.[c] || {};
    const list = (Array.isArray(v.list) ? v.list : []).slice(-12).map((x) => ({
      text: str(x?.text, 4000), ai: !!x?.ai, edited: !!x?.edited, at: x?.at ? new Date(x.at) : new Date(),
    })).filter((x) => x.text.trim());
    versions[c] = { own: !!v.own && list.length > 0, list, chosen: Math.max(0, Math.min(Number(v.chosen) || 0, Math.max(0, list.length - 1))) };
  }
  let scheduledAt = null;
  if (body.scheduledAt) {
    const d = new Date(body.scheduledAt);
    if (Number.isNaN(d.getTime())) return { error: "That date and time isn't valid." };
    scheduledAt = d;
  }
  const image = body.image?.url && /^https:\/\/cdn\.sanity\.io\/images\//.test(body.image.url)
    ? { url: str(body.image.url, 500), alt: str(body.image.alt, 200) } : null;
  if (body.image?.url && !image) return { error: "Photos come from the website's image library (upload one here)." };
  return { value: {
    title: str(body.title, 120).trim(),
    text: str(body.text, 3000),
    channels, versions, scheduledAt, image,
    timezone: ["America/Toronto", "America/Vancouver", "America/Edmonton"].includes(body.timezone) ? body.timezone : "America/Toronto",
    eventKey: str(body.eventKey, 80), eventName: str(body.eventName, 160),
    source: body.source?.kind ? { kind: str(body.source.kind, 20), id: str(body.source.id, 80), label: str(body.source.label, 160) } : null,
    contractRef: body.contractRef?.contractId ? { contractId: str(body.contractRef.contractId, 40), key: str(body.contractRef.key, 40), label: str(body.contractRef.label, 160) } : null,
  } };
}

/** Problems that stop a post going for approval or being marked approved. */
export function postProblems(post) {
  const out = [];
  if (!String(post.text || "").trim()) out.push("Write the post.");
  for (const c of CHANNEL_KEYS) if (post.channels?.[c] && overLimit(c, textFor(post, c))) {
    out.push(`${CHANNELS.find((x) => x.key === c).label} is over ${LIMIT[c].toLocaleString("en-CA")} characters.`);
  }
  return out;
}

/** Sanity image URL cropped for a channel ("auto-resized"), keeping the busiest part in view. */
export function cropUrl(url, channel) {
  const ch = CHANNELS.find((c) => c.key === channel);
  if (!url || !ch) return url || "";
  const [w, h] = ch.size;
  const base = String(url).split("?")[0];
  return `${base}?w=${w}&h=${h}&fit=crop&crop=entropy&auto=format&q=85`;
}

/** Settings from the panel → { value } or { error }. */
export function cleanSettings(body = {}) {
  const tags = (v) => [...new Set((Array.isArray(v) ? v : String(v || "").split(/[\s,]+/))
    .map((t) => String(t).trim()).filter(Boolean).map((t) => (t.startsWith("#") ? t : `#${t}`))
    .filter((t) => /^#[\p{L}\p{N}_]{1,60}$/u.test(t)))].slice(0, 30);
  const budget = Number(body.monthlyBudgetUsd);
  if (!Number.isFinite(budget) || budget < 0 || budget > 1000) return { error: "The monthly limit is between $0 and $1,000." };
  const h = body.handles || {};
  return { value: {
    brandTags: tags(body.brandTags), topicTags: tags(body.topicTags),
    tone: str(body.tone, 500).trim(), avoid: str(body.avoid, 500).trim(),
    spelling: body.spelling === "American" ? "American" : body.spelling === "British" ? "British" : "Canadian",
    monthlyBudgetUsd: Math.round(budget * 100) / 100,
    handles: { linkedin: str(h.linkedin, 80).trim(), instagram: str(h.instagram, 40).replace(/^@/, "").trim(), x: str(h.x, 40).replace(/^@/, "").trim() },
  } };
}

/** The instructions for writing posts (system prompt), from the settings. Stable, so it caches. */
export function writerSystem(settings = SETTING_DEFAULTS) {
  return [
    "You write social media posts for The Tech Festival Canada (TTFC), a Canadian technology festival with briefings in Vancouver, Calgary, Ottawa, Montreal and Toronto and a main event in Toronto.",
    `Voice: ${settings.tone || SETTING_DEFAULTS.tone}`,
    settings.avoid ? `Never use these words: ${settings.avoid}.` : "",
    `Spelling: ${settings.spelling || "Canadian"} English.`,
    "Only state facts given in the source. Never invent names, numbers, dates, prices, quotes or links. Keep every link the source gives exactly as written.",
    "Per channel:",
    "- linkedin: up to 1,300 characters. A clear first line, short paragraphs, the link, then 3 to 5 hashtags on the last line.",
    "- x: must fit 280 characters, counting every link as 23. Lead with the news, keep the link, 1 or 2 hashtags.",
    "- instagram: a hook in the first line, short paragraphs, a call to action saying \"link in bio\" instead of a link, emoji only where natural, 3 to 5 hashtags at the end.",
    `Hashtags: always include one of these brand tags: ${(settings.brandTags || []).join(" ") || "#TTFC2027"}. Add a city tag when the post is about a city's event. Pick topic tags from this list when they fit: ${(settings.topicTags || []).join(" ")}; otherwise use common, relevant tags.`,
    "Return only the requested channels.",
  ].filter(Boolean).join("\n");
}

/** The request (user message) for one writing job. */
export function writerPrompt({ source = "", main = "", channels = [], instruction = "", previous = {}, eventName = "" }) {
  const parts = [];
  if (eventName) parts.push(`Event: ${eventName}`);
  if (source) parts.push(`Source material:\n<source>\n${source}\n</source>`);
  if (main) parts.push(`The main (LinkedIn) post:\n<main>\n${main}\n</main>`);
  for (const c of channels) {
    const prev = (previous[c] || []).filter(Boolean);
    if (prev.length) parts.push(`Versions already written for ${c} (write something clearly different from these):\n${prev.map((p, i) => `<v${i + 1}>\n${p}\n</v${i + 1}>`).join("\n")}`);
  }
  if (instruction) parts.push(`Extra direction from the team: ${instruction}`);
  parts.push(`Write: ${channels.join(", ")}.`);
  return parts.join("\n\n");
}

export const writerSchema = (channels) => ({
  type: "object",
  properties: Object.fromEntries(channels.map((c) => [c, { type: "string" }])),
  required: channels,
  additionalProperties: false,
});
