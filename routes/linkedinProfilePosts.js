import crypto from "node:crypto";
import express from "express";
import axios from "axios";
import mongoose from "mongoose";
import Anthropic from "@anthropic-ai/sdk";
import { requireAdmin, isManagement } from "../middleware/adminAuth.js";
import { AdminAudit } from "../models/Admin.js";
import AdminSetting from "../models/AdminSetting.js";
import EventConfig from "../models/EventConfig.js";
import LinkedinProfile from "../models/LinkedinProfile.js";
import LinkedinProfileDraft from "../models/LinkedinProfileDraft.js";
import { SETTING_DEFAULTS as SOCIAL_DEFAULTS } from "../services/socialPosts.js";
import { frontendUrl } from "../services/profileRequest.js";
import { LI_POST_SCOPE, linkedinAuthUrl, linkedinConfigured, readCookie } from "../services/attendingCampaign.js";
import { postTextToLinkedin } from "../services/linkedinPost.js";
import {
  DAILY_ROUNDS, GO_TTL_MS, INVITE_EVENT, INVITE_WHO, LENGTHS, LIP_COOKIE, PILLARS, POST_MAX, RUN_STALE_MS, SECTORS,
  SETTINGS_DEFAULTS, STATE_TTL_MS, TOPICS, VOICES, answerJson, applyChecks, checkerPrompt, checkerSchema, checkerSystem,
  cleanReturnTo, cleanSettings, composePost, costUsd, hasDash, isGoKey, isLipState, keepDifferent, keepSourced, newGoKey,
  newLipState, noDashes, pickEvents, returnUrl, seenSources, shareBoxUrl, torontoDay, writerPrompt, writerSchema, writerSystem,
} from "../services/linkedinProfilePosts.js";

/* =========================================================
   /api/console/linkedin-posts: Marketing › LinkedIn posts for my profile (Nov 22 2026). Management only; each
   person sees only their own settings and drafts (keyed to their staff account).

   A writing round (POST /write, answers 202 and runs in the background; the panel polls GET /me):
     1. Claude Opus 5.5 with web search (web_search_20260209, up to 6 searches) researches current news on the
        person's topics and writes `count` drafts in their voice, each with its sources (structured output).
     2. Code keeps only sources the search really returned (exact URL); a draft with none is dropped.
     3. Claude fact-checks every draft against its sources with web fetch: keep / fix / drop, and which sources
        confirmed it. A draft with no confirmed source is dropped.
     4. Code takes out every em-dash, drops drafts too close to anyone else's recent drafts (or each other), adds
        the sources' links and hashtags, and saves them.
   Spend (both calls + $10 per 1,000 searches) counts toward Marketing › Social posts' monthly writing limit
   (AdminSetting social.usage.YYYY-MM vs social.settings.monthlyBudgetUsd). DAILY_ROUNDS rounds per person a day.

   Post to LinkedIn, as the person: POST /drafts/:id/linkedin → { url } (a one-time link on this API, 5 min) →
   GET /api/linkedin-posts/go?k= sets a state cookie and sends them to LinkedIn's sign-in (openid profile
   w_member_social, the registered LINKEDIN_REDIRECT_URI) → linkedinProfilePostCallback posts the text (Posts API)
   and returns to <admin origin>/admin/linkedin-posts#posted=<id>&post=<url> (or #post_error=<code>&d=<id>).
   No LinkedIn token is kept. Copy always works too (and LinkedIn's own share box with the text filled in).
========================================================= */

export const consoleRouter = express.Router();
export const publicRouter = express.Router();

const MODEL = "claude-opus-5-5";
const COOKIE_PATH = "/api/auth/linkedin";

/* Swappable in tests. */
export const lipDeps = {
  claude: () => (process.env.ANTHROPIC_API_KEY ? new Anthropic() : null),
  now: () => new Date(),
  background: (fn) => { fn().catch((err) => console.error("LINKEDIN POSTS ROUND ERROR:", err?.message || err)); },
};

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error("LINKEDIN POSTS ERROR:", err?.message || err);
  res.status(500).json({ error: "Something went wrong. Try again." });
});
const audit = (req, action, id, detail) =>
  AdminAudit.create({ adminId: req.user._id, adminName: req.user.name, action, targetType: "linkedin_profile_post",
                      targetId: String(id).slice(0, 120), detail: String(detail).slice(0, 500) }).catch(() => {});

consoleRouter.use(requireAdmin);
consoleRouter.use((req, res, next) => (isManagement(req.user)
  ? next() : res.status(403).json({ error: "LinkedIn posts for your profile are for management.", code: "management_only" })));

/* ---------- spend: the Social posts writing limit ---------- */
const monthKey = (d) => `social.usage.${d.toISOString().slice(0, 7)}`;
async function budget() {
  const [settings, usage] = await Promise.all([
    AdminSetting.findOne({ key: "social.settings" }).lean(),
    AdminSetting.findOne({ key: monthKey(lipDeps.now()) }).lean(),
  ]);
  const limit = Number(settings?.value?.monthlyBudgetUsd ?? SOCIAL_DEFAULTS.monthlyBudgetUsd);
  const used = Math.round((usage?.value?.costUsd || 0) * 10000) / 10000;
  return { limit, used, left: Math.max(0, Math.round((limit - used) * 100) / 100) };
}
const addUsage = (cost) => AdminSetting.updateOne({ key: monthKey(lipDeps.now()) },
  { $inc: { "value.costUsd": cost, "value.calls": 1 }, $setOnInsert: { module: "social", valueType: "json" } }, { upsert: true });

/* ---------- reads ---------- */
const settingsOf = (p) => ({ ...SETTINGS_DEFAULTS, ...(p?.settings ? Object.fromEntries(Object.entries(p.settings).filter(([, v]) => v !== undefined && v !== null)) : {}) });
const topicLabel = (k) => TOPICS.find((t) => t.key === k)?.label || "";

function draftView(d) {
  return {
    id: String(d._id), headline: d.headline || "", topic: d.topic || "", topicLabel: topicLabel(d.topic),
    event: d.event?.key || d.event?.name ? d.event : null,
    text: d.text || "", generatedText: d.generatedText || "", edited: !!d.edited, length: (d.text || "").length,
    hasDash: hasDash(d.text), sources: (d.sources || []).map((s) => ({ url: s.url, title: s.title, supports: s.supports })),
    check: d.check?.verdict ? { verdict: d.check.verdict, notes: d.check.notes || "", at: d.check.at } : null,
    status: d.status, postUrl: d.postUrl || "", postedAt: d.postedAt || null, postedVia: d.postedVia || "",
    copiedAt: d.copiedAt || null, createdAt: d.createdAt, shareUrl: shareBoxUrl(d.text),
  };
}

function runView(run, now) {
  if (!run?.state) return { state: "" };
  const stale = run.state === "working" && run.startedAt && now - new Date(run.startedAt) > RUN_STALE_MS;
  return {
    state: stale ? "failed" : run.state, startedAt: run.startedAt || null, finishedAt: run.finishedAt || null,
    made: run.made || 0, dropped: run.dropped || [], error: stale ? "That round took too long and stopped. Try again." : run.error || "",
  };
}

async function eventsNow() {
  const rows = await EventConfig.find({}, { eventKey: 1, name: 1, city: 1, type: 1, startDate: 1, endDate: 1 }).lean();
  return pickEvents(rows, lipDeps.now());
}

consoleRouter.get("/me", wrap(async (req, res) => {
  const now = lipDeps.now();
  const [profile, drafts, events, money] = await Promise.all([
    LinkedinProfile.findOne({ userId: req.user._id }).lean(),
    LinkedinProfileDraft.find({ userId: req.user._id, status: { $ne: "dismissed" } }).sort({ createdAt: -1 }).limit(40).lean(),
    eventsNow(),
    budget(),
  ]);
  const day = torontoDay(now);
  const used = profile?.rounds?.day === day ? profile.rounds.count || 0 : 0;
  res.set("Cache-Control", "no-store");
  res.json({
    settings: { ...settingsOf(profile), displayName: profile?.settings?.displayName || req.user.name || "", role: profile?.settings?.role ?? (req.user.jobTitle || "") },
    saved: !!profile?.savedAt,
    run: runView(profile?.run, now),
    rounds: { used, max: DAILY_ROUNDS, left: Math.max(0, DAILY_ROUNDS - used) },
    writing: !!lipDeps.claude(),
    linkedin: linkedinConfigured(),
    budget: { left: money.left, used: money.used, limit: money.limit },
    events,
    options: { topics: TOPICS, voices: VOICES.map(({ key, label }) => ({ key, label })), lengths: LENGTHS.map(({ key, label }) => ({ key, label })),
               inviteWho: INVITE_WHO.map(({ key, label }) => ({ key, label })), inviteEvent: INVITE_EVENT, pillars: PILLARS, sectors: SECTORS },
    drafts: drafts.map(draftView),
    postMax: POST_MAX,
  });
}));

consoleRouter.put("/settings", wrap(async (req, res) => {
  const { value, error } = cleanSettings(req.body);
  if (error) return res.status(400).json({ error });
  const p = await LinkedinProfile.findOneAndUpdate({ userId: req.user._id }, { $set: { settings: value, savedAt: lipDeps.now() } }, { upsert: true, new: true }).lean();
  res.json({ settings: settingsOf(p), saved: true });
}));

/* ---------- a writing round ---------- */

async function callClaude(client, { system, schema, tools, content, effort = "medium" }) {
  const messages = [{ role: "user", content }];
  const all = [];
  let cost = 0;
  let response;
  for (let turn = 0; turn < 4; turn++) {
    response = await client.beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort, format: { type: "json_schema", schema } },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools,
      messages,
    }).finalMessage();
    cost += costUsd(response.usage);
    all.push(...(response.content || []));
    if (response.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: response.content });   // the server picks up where it paused
  }
  return { response, all, cost };
}

async function runRound(userId, person) {
  const client = lipDeps.claude();
  const now = lipDeps.now();
  let spent = 0;
  const finish = (set) => LinkedinProfile.updateOne({ userId }, { $set: { "run.finishedAt": lipDeps.now(), ...set } });
  try {
    const profile = await LinkedinProfile.findOne({ userId }).lean();
    const settings = settingsOf(profile);
    if (!profile?.settings?.displayName && person.name) settings.displayName = person.name;
    if (!profile?.settings?.role && person.title) settings.role = person.title;
    const events = await eventsNow();
    const eventChoice = { next: events.next, recent: events.recent, main: events.main }[settings.inviteEvent] || null;
    const since = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    const [mineRows, otherRows] = await Promise.all([
      LinkedinProfileDraft.find({ userId, createdAt: { $gte: since } }, { headline: 1 }).sort({ createdAt: -1 }).limit(20).lean(),
      LinkedinProfileDraft.find({ userId: { $ne: userId }, createdAt: { $gte: since } }, { headline: 1, body: 1, sources: 1 }).sort({ createdAt: -1 }).limit(200).lean(),
    ]);
    const base = frontendUrl();
    const inviteLinks = Object.fromEntries(INVITE_WHO.filter((w) => settings.inviteWho.includes(w.key)).map((w) => [w.label.toLowerCase(), `${base}${w.path}`]));

    // 1. research and write
    const write = await callClaude(client, {
      system: writerSystem(),
      schema: writerSchema,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 6, user_location: { type: "approximate", country: "CA", timezone: "America/Toronto" } }],
      content: writerPrompt({
        settings, person, events, eventChoice, inviteLinks, today: now,
        mine: mineRows.map((d) => d.headline).filter(Boolean),
        others: otherRows.slice(0, 40).map((d) => [d.headline, d.sources?.[0]?.title].filter(Boolean).join(" · ")).filter(Boolean),
      }),
    });
    spent += write.cost;
    if (write.response.stop_reason === "refusal") throw Object.assign(new Error("refusal"), { show: "Claude declined to write these. Try different topics or notes." });
    const written = answerJson(write.all);
    if (!written?.posts) throw Object.assign(new Error("unreadable"), { show: "Claude's answer couldn't be read. Try again." });
    const seen = seenSources(write.all);
    const sourced = keepSourced(written.posts, seen);
    const dropped = [...sourced.dropped];

    // 2. fact-check against the sources
    let checked = { kept: [], dropped: [] };
    if (sourced.kept.length) {
      const check = await callClaude(client, {
        system: checkerSystem(),
        schema: checkerSchema,
        tools: [{ type: "web_fetch_20260209", name: "web_fetch", max_uses: Math.min(12, sourced.kept.reduce((n, d) => n + d.sources.length, 0)), max_content_tokens: 20000 }],
        content: checkerPrompt(sourced.kept),
        effort: "medium",
      });
      spent += check.cost;
      seenSources(check.all, seen);
      if (check.response.stop_reason === "refusal") throw Object.assign(new Error("refusal"), { show: "The fact-check declined these drafts. Try different topics." });
      const reviews = answerJson(check.all)?.reviews;
      if (!Array.isArray(reviews)) throw Object.assign(new Error("unreadable check"), { show: "The fact-check couldn't be read. Try again." });
      checked = applyChecks(sourced.kept, reviews);
    }
    dropped.push(...checked.dropped);

    // 3. no dashes, different from everyone else, then save
    const cleaned = checked.kept.map((d) => ({ ...d, body: noDashes(d.body) }));
    const different = keepDifferent(cleaned, otherRows.map((d) => d.body));
    dropped.push(...different.dropped);
    const evOf = (key) => [events.recent, events.next, events.main].find((e) => e && e.key === key) || eventChoice || events.next || events.main || null;
    const docs = different.kept.map((d) => {
      const ev = evOf(d.eventKey);
      const text = composePost(d, { sourcesInPost: settings.sourcesInPost });
      return {
        userId, headline: noDashes(d.headline), topic: d.topic, body: d.body, hashtags: d.hashtags, sources: d.sources.map((s) => ({ ...s, title: noDashes(s.title), supports: noDashes(s.supports) })),
        event: ev ? { key: ev.key, name: ev.name, city: ev.city, when: ev.when } : undefined,
        check: { ...d.check, notes: noDashes(d.check.notes), at: lipDeps.now() }, text, generatedText: text, status: "draft", round: now,
      };
    });
    if (docs.length) await LinkedinProfileDraft.insertMany(docs);
    await finish({ "run.state": "done", "run.made": docs.length, "run.dropped": dropped.slice(0, 20), "run.error": docs.length ? "" : "Nothing passed the checks this time. Try again, or widen the topics.", "run.costUsd": spent });
  } catch (err) {
    let show = err?.show;
    if (!show && err instanceof Anthropic.RateLimitError) show = "Claude is busy. Try again in a minute.";
    if (!show && err instanceof Anthropic.AuthenticationError) show = "The Anthropic API key on the server isn't valid.";
    if (!err?.show) console.error("LINKEDIN POSTS ROUND ERROR:", err?.status || "", err?.message || err);
    await finish({ "run.state": "failed", "run.error": show || "Claude couldn't write these just now. Try again.", "run.costUsd": spent });
  } finally {
    if (spent > 0) await addUsage(spent).catch(() => {});
  }
}

consoleRouter.post("/write", wrap(async (req, res) => {
  if (!lipDeps.claude()) return res.status(503).json({ error: "Writing with Claude isn't set up yet: the server needs an Anthropic API key (ANTHROPIC_API_KEY).", code: "no_key" });
  const money = await budget();
  if (money.limit <= 0 || money.left <= 0) return res.status(429).json({ error: `This month's writing limit ($${money.limit}) is used up. It can be raised in Marketing › Social posts › Settings.`, code: "budget" });
  const now = lipDeps.now();
  const day = torontoDay(now);
  const existing = await LinkedinProfile.findOne({ userId: req.user._id }).lean();
  const used = existing?.rounds?.day === day ? existing.rounds.count || 0 : 0;
  if (used >= DAILY_ROUNDS) return res.status(429).json({ error: `That's ${DAILY_ROUNDS} rounds today. Try again tomorrow.`, code: "daily" });
  // One round at a time per person (a round stuck for 15 minutes counts as finished).
  const stale = new Date(now.getTime() - RUN_STALE_MS);
  let claimed;
  try {
    claimed = await LinkedinProfile.findOneAndUpdate(
      { userId: req.user._id, $or: [{ "run.state": { $ne: "working" } }, { "run.startedAt": { $lt: stale } }] },
      { $set: { run: { state: "working", startedAt: now, made: 0, dropped: [], error: "", costUsd: 0 }, rounds: { day, count: used + 1 } } },
      { upsert: true, new: true },
    ).lean();
  } catch (err) {
    if (err?.code === 11000) claimed = null; else throw err;   // the upsert lost to a round already working
  }
  if (!claimed) return res.status(409).json({ error: "Claude is already writing your drafts. They'll appear here in a minute or two.", code: "working" });
  audit(req, "linkedin_profile_write", req.user._id, "writing round started");
  lipDeps.background(() => runRound(req.user._id, { name: req.user.name || "", title: req.user.jobTitle || "" }));
  res.status(202).json({ run: runView(claimed.run, now), rounds: { used: used + 1, max: DAILY_ROUNDS, left: Math.max(0, DAILY_ROUNDS - used - 1) } });
}));

/* ---------- drafts (the owner's only) ---------- */
async function own(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) { res.status(404).json({ error: "Not found" }); return null; }
  const d = await LinkedinProfileDraft.findOne({ _id: req.params.id, userId: req.user._id });
  if (!d) res.status(404).json({ error: "Not found" });
  return d;
}
const cleanText = (raw) => String(typeof raw === "string" ? raw : "").replace(/\r\n?/g, "\n").replace(/[^\P{Cc}\n\t]/gu, "").trim();

consoleRouter.patch("/drafts/:id", wrap(async (req, res) => {
  const d = await own(req, res); if (!d) return;
  const text = cleanText(req.body?.text);
  if (!text) return res.status(400).json({ error: "The post is empty." });
  if (text.length > POST_MAX) return res.status(400).json({ error: `LinkedIn takes up to ${POST_MAX.toLocaleString("en-CA")} characters.` });
  d.text = text;
  d.edited = text !== d.generatedText;
  await d.save();
  res.json({ draft: draftView(d.toObject()) });
}));

consoleRouter.post("/drafts/:id/reset", wrap(async (req, res) => {
  const d = await own(req, res); if (!d) return;
  d.text = d.generatedText; d.edited = false;
  await d.save();
  res.json({ draft: draftView(d.toObject()) });
}));

consoleRouter.post("/drafts/:id/copied", wrap(async (req, res) => {
  const d = await own(req, res); if (!d) return;
  if (d.status === "draft") d.status = "copied";
  d.copiedAt = lipDeps.now();
  await d.save();
  res.json({ draft: draftView(d.toObject()) });
}));

/* Posted by hand (after Copy): { posted: true, url? } or { posted: false } to take it back. */
consoleRouter.post("/drafts/:id/posted", wrap(async (req, res) => {
  const d = await own(req, res); if (!d) return;
  if (req.body?.posted === false) {
    if (d.postedVia === "linkedin") return res.status(409).json({ error: "This one was posted from here, so it stays posted." });
    Object.assign(d, { status: d.copiedAt ? "copied" : "draft", postedAt: undefined, postUrl: "", postedVia: "" });
  } else {
    const url = String(req.body?.url || "").trim().slice(0, 500);
    if (url && !/^https:\/\/(www\.)?linkedin\.com\/\S+$/i.test(url)) return res.status(400).json({ error: "Paste the post's LinkedIn link (it starts with https://www.linkedin.com/), or leave it empty." });
    Object.assign(d, { status: "posted", postedAt: lipDeps.now(), postUrl: url, postedVia: "by hand" });
  }
  await d.save();
  res.json({ draft: draftView(d.toObject()) });
}));

consoleRouter.post("/drafts/:id/dismiss", wrap(async (req, res) => {
  const d = await own(req, res); if (!d) return;
  if (d.status === "posted") return res.status(409).json({ error: "It's already posted." });
  d.status = "dismissed";               // kept, so later rounds (yours and others') stay different from it
  await d.save();
  res.json({ ok: true });
}));

consoleRouter.post("/drafts/:id/linkedin", wrap(async (req, res) => {
  const d = await own(req, res); if (!d) return;
  if (!linkedinConfigured()) return res.status(503).json({ error: "Posting to LinkedIn from here isn't set up. Use Copy instead.", code: "unavailable" });
  if (d.status === "posted") return res.status(409).json({ error: "It's already posted." });
  const returnTo = cleanReturnTo(req.body?.returnTo);
  if (!returnTo) return res.status(400).json({ error: "Open this page from the admin panel and try again." });
  if (req.body?.text !== undefined) {
    const text = cleanText(req.body.text);
    if (!text) return res.status(400).json({ error: "The post is empty." });
    if (text.length > POST_MAX) return res.status(400).json({ error: `LinkedIn takes up to ${POST_MAX.toLocaleString("en-CA")} characters.` });
    d.text = text; d.edited = text !== d.generatedText;
  }
  d.goKey = newGoKey();
  d.goExpiresAt = new Date(Date.now() + GO_TTL_MS);
  d.returnTo = returnTo;
  await d.save();
  res.json({ url: `${req.protocol}://${req.get("host")}/api/linkedin-posts/go?k=${d.goKey}` });
}));

/* ---------- the hop to LinkedIn (no sign-in: the one-time key is the key) ---------- */
const isHttps = (req) => req.secure || req.protocol === "https";
function setStateCookie(req, res, value, maxAge = STATE_TTL_MS / 1000) {
  const parts = [`${LIP_COOKIE}=${encodeURIComponent(value)}`, `Path=${COOKIE_PATH}`, `Max-Age=${Math.round(maxAge)}`, "HttpOnly", "SameSite=Lax"];
  if (isHttps(req)) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}
const sameState = (a, b) => {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};
const fallbackOrigin = () => frontendUrl().replace(/\/+$/, "");

publicRouter.get("/go", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const k = String(req.query.k || "");
  const state = newLipState();
  const d = isGoKey(k) && linkedinConfigured()
    ? await LinkedinProfileDraft.findOneAndUpdate({ goKey: k, goExpiresAt: { $gt: new Date() } },
      { $set: { state, stateExpiresAt: new Date(Date.now() + STATE_TTL_MS) }, $unset: { goKey: 1, goExpiresAt: 1 } }, { new: true })
    : null;
  if (!d) return res.redirect(302, returnUrl(fallbackOrigin(), { error: "expired" }));
  setStateCookie(req, res, state);
  res.redirect(302, linkedinAuthUrl({ clientId: process.env.LINKEDIN_CLIENT_ID, redirectUri: process.env.LINKEDIN_REDIRECT_URI, state, scope: LI_POST_SCOPE }));
});

const CANCELLED = new Set(["user_cancelled_login", "user_cancelled_authorize"]);

/** For GET /api/auth/linkedin/callback: "ttfc-lip." states only; everything else goes on. */
export async function linkedinProfilePostCallback(req, res, next) {
  const state = typeof req.query?.state === "string" ? req.query.state : "";
  if (!isLipState(state)) return next();
  res.set("Cache-Control", "no-store");
  const cookie = readCookie(req.headers.cookie, LIP_COOKIE);
  setStateCookie(req, res, "", 0); // single use
  const d = await LinkedinProfileDraft.findOneAndUpdate({ state, stateExpiresAt: { $gt: new Date() } }, { $unset: { state: 1, stateExpiresAt: 1 } });
  const origin = d?.returnTo || fallbackOrigin();
  const fail = (error) => res.redirect(302, returnUrl(origin, { error, id: d ? String(d._id) : "" }));
  if (!d || !sameState(state, cookie)) return fail("expired");
  if (req.query.error) {
    const e = String(req.query.error);
    return fail(CANCELLED.has(e) ? "cancelled" : /scope/i.test(e) ? "unavailable" : "denied");
  }
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!code || !linkedinConfigured()) return fail(code ? "unavailable" : "denied");
  if (d.status === "posted") return res.redirect(302, returnUrl(origin, { id: String(d._id), post: d.postUrl }));
  try {
    const token = await axios.post("https://www.linkedin.com/oauth/v2/accessToken", new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: process.env.LINKEDIN_REDIRECT_URI,
      client_id: process.env.LINKEDIN_CLIENT_ID, client_secret: process.env.LINKEDIN_CLIENT_SECRET,
    }), { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10000 });
    const info = await axios.get("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${token.data?.access_token}` }, timeout: 10000 });
    const { url } = await postTextToLinkedin({ accessToken: token.data?.access_token, personId: info.data?.sub, text: d.text });
    await LinkedinProfileDraft.updateOne({ _id: d._id }, { $set: { status: "posted", postedAt: new Date(), postUrl: url, postedVia: "linkedin" } });
    AdminAudit.create({ adminId: d.userId, adminName: "", action: "linkedin_profile_posted", targetType: "linkedin_profile_post",
                        targetId: String(d._id), detail: url ? "posted to LinkedIn" : "posted to LinkedIn (no link returned)" }).catch(() => {});
    return res.redirect(302, returnUrl(origin, { id: String(d._id), post: url }));
  } catch (err) {
    const status = err.response?.status;
    console.error("LINKEDIN PROFILE POST ERROR:", status || "", err.response?.data?.code || "", err.response?.data?.message || err.message);
    return fail(status === 403 ? "unavailable" : "failed");
  }
}
