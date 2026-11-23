import crypto from "node:crypto";
import express from "express";
import mongoose from "mongoose";
import { AdminAudit } from "../models/Admin.js";
import LinkedinProfile from "../models/LinkedinProfile.js";
import LinkedinProfileDraft from "../models/LinkedinProfileDraft.js";
import User from "../models/User.js";
import { safeFetch } from "../services/logoFetch.js";
import {
  POST_MAX, TOPIC_KEYS, composePost, keepDifferent, noDashes, normalizeUrl, similarity, TOO_SIMILAR,
} from "../services/linkedinProfilePosts.js";
import { eventsNow, museBridgeEnabled, settingsOf } from "./linkedinProfilePosts.js";

/* =========================================================
   /api/muse/linkedin-posts: the free Muse bridge for Marketing › LinkedIn posts for my profile.

   The server cannot call Muse, so the writing is split in two. The admin panel's "Write new drafts"
   (POST /api/console/linkedin-posts/write, no Anthropic key) QUEUES a round on the person's profile
   (run.state "working", run.via "muse", the same daily-rounds limit, no spend). Muse (Orion) checks
   this bridge a few times a day, writes the drafts itself with the person's own settings, and delivers
   them here. The panel then shows them like any other round: the owner edits, posts or removes them.

     GET  /pending                 → who is waiting, with everything needed to write for them
     POST /pending/:userId/drafts  → deliver finished drafts (the server re-checks every rule itself)
     POST /pending/:userId/fail    → the round could not be written; the panel shows why

   Off unless MUSE_BRIDGE_ENABLED=true AND MUSE_BRIDGE_KEY are both set on the server (then the key is
   required on every call, header X-Muse-Bridge-Key, compared in constant time). While off, every path
   here answers 404, so merging this changes nothing live. Muse rounds are FREE: they never touch the
   Social posts monthly writing limit (AdminSetting social.usage.*) and a finished round's costUsd is 0.

   Safety, on purpose:
   - Rate limited: 60 requests an hour per source on the whole bridge, 10 deliveries an hour.
   - A source link is only ever opened through safeFetch (services/logoFetch.js, kind "html"), the
     SSRF-safe fetcher: private, loopback and link-local addresses (cloud metadata included) and
     redirects to them are refused, and no other fetch exists in this file. Links must be https.
   - The server trusts nothing Muse sends: it re-runs noDashes, the LinkedIn length limit, the
     source checks, keepDifferent against colleagues' drafts of the last 60 days, the same-story rule
     (no two profiles lead with the same story inside 60 days, and not twice in one delivery) and the
     removed-means-removed rule (nothing too close to, or leading with the same source as, a draft the
     owner themselves removed in the last 60 days).
========================================================= */

const router = express.Router();

/* Swappable in tests. fetchPage is the ONLY way a caller-supplied link is opened. */
export const museDeps = {
  fetchPage: (url) => safeFetch(url, { kind: "html" }),
  now: () => new Date(),
};

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 60 * DAY_MS;   // "recent" for the difference rules, as in the Anthropic rounds

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error("MUSE BRIDGE ERROR:", err?.message || err);
  res.status(500).json({ error: "Something went wrong. Try again." });
});
const cleanStr = (v, max) => String(v ?? "").replace(/\r\n?/g, "\n").replace(/[^\P{Cc}\n\t]/gu, "").slice(0, max);
const cleanTag = (h) => {
  const t = String(h || "").trim().replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "");
  return t ? `#${t.slice(0, 60)}` : "";
};

/* ---------- rate limit (this router only): a small in-memory sliding window per source ---------- */
export function makeRateLimiter({ limit, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  return (req, res, next) => {
    const t = now();
    const key = req.ip || req.socket?.remoteAddress || "unknown";
    const recent = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return res.status(429).json({ error: "Too many bridge requests. Try again later.", code: "rate_limited" });
    }
    recent.push(t);
    hits.set(key, recent);
    next();
  };
}
router.use(makeRateLimiter({ limit: 60, windowMs: 60 * 60 * 1000 }));
const importLimiter = makeRateLimiter({ limit: 10, windowMs: 60 * 60 * 1000 });

/* ---------- the gate: bridge off → 404; on → the key, compared in constant time ---------- */
function keyOk(req) {
  const want = Buffer.from(String(process.env.MUSE_BRIDGE_KEY || ""));
  const got = Buffer.from(String(req.get("x-muse-bridge-key") || ""));
  return want.length > 0 && got.length === want.length && crypto.timingSafeEqual(got, want);
}
router.use((req, res, next) => {
  if (!museBridgeEnabled()) return res.status(404).json({ error: "Not found" });
  if (!keyOk(req)) return res.status(401).json({ error: "The Muse bridge key is missing or wrong.", code: "bad_key" });
  next();
});

/* ---------- who is waiting ---------- */
router.get("/pending", wrap(async (req, res) => {
  const now = museDeps.now();
  const since = new Date(now.getTime() - WINDOW_MS);
  const profiles = await LinkedinProfile.find({ "run.state": "working", "run.via": "muse" }).lean();
  const events = await eventsNow();
  const people = await User.find({ _id: { $in: profiles.map((p) => p.userId) } }, { name: 1, jobTitle: 1 }).lean();
  const personOf = new Map(people.map((u) => [String(u._id), u]));
  const pending = [];
  for (const p of profiles) {
    const userId = p.userId;
    const [mine, dismissed, others] = await Promise.all([
      LinkedinProfileDraft.find({ userId, createdAt: { $gte: since } }, { headline: 1 }).sort({ createdAt: -1 }).limit(20).lean(),
      LinkedinProfileDraft.find({ userId, status: "dismissed", createdAt: { $gte: since } }, { headline: 1, sources: 1 }).sort({ createdAt: -1 }).limit(40).lean(),
      LinkedinProfileDraft.find({ userId: { $ne: userId }, createdAt: { $gte: since } }, { headline: 1, topic: 1, sources: 1 }).sort({ createdAt: -1 }).limit(200).lean(),
    ]);
    const settings = settingsOf(p);
    const person = personOf.get(String(userId));
    if (!p.settings?.displayName && person?.name) settings.displayName = person.name;
    if (!p.settings?.role && person?.jobTitle) settings.role = person.jobTitle;
    pending.push({
      userId: String(userId),
      settings,
      events,
      recentHeadlines: mine.map((d) => d.headline).filter(Boolean),
      dismissed: dismissed.map((d) => ({ headline: d.headline || "", primarySource: d.sources?.[0]?.url || "" })),
      others: others.map((d) => ({ headline: d.headline || "", topic: d.topic || "", primarySource: d.sources?.[0]?.url || "" })),
    });
  }
  res.set("Cache-Control", "no-store");
  res.json({ pending });
}));

/* ---------- the delivery checks (pure, so they are unit-tested directly) ---------- */

/** One source, proved: https only, then really opened through the safe fetcher. → the source, or null. */
export async function verifySource(s, fetchPage = museDeps.fetchPage) {
  const url = String(s?.url || "").trim();
  if (!/^https:\/\//i.test(url)) return null;
  try { await fetchPage(url); } catch { return null; }
  return { url, title: noDashes(cleanStr(s?.title, 200)).trim(), supports: noDashes(cleanStr(s?.supports, 400)) };
}

/**
 * Everything the server re-checks on a delivery, in order: no em-dashes, LinkedIn's length limit,
 * https-only sources that really open, the same-story rules, removed-means-removed, and keepDifferent
 * against colleagues (and, inside it, against each other). `others` / `dismissed` are draft-shaped
 * ({ body, sources }) rows of the last 60 days. → { kept, dropped: [{ headline, why }] }
 */
export async function processImport({ drafts = [], others = [], dismissed = [], fetchPage = museDeps.fetchPage } = {}) {
  const kept = [], dropped = [];
  const otherBodies = others.map((d) => d.body).filter(Boolean);
  const otherPrimary = new Set(others.map((d) => normalizeUrl(d.sources?.[0]?.url)).filter(Boolean));
  const ownPrimary = new Set(dismissed.map((d) => normalizeUrl(d.sources?.[0]?.url)).filter(Boolean));
  const ownBodies = dismissed.map((d) => d.body).filter(Boolean);
  const candidates = [];
  for (const raw of Array.isArray(drafts) ? drafts : []) {
    const body = noDashes(String(raw?.body || "")).trim();
    const headline = noDashes(cleanStr(raw?.headline, 160)).trim() || body.slice(0, 80);
    if (!body) { dropped.push({ headline: headline || "Draft", why: "empty post" }); continue; }
    if (body.length > POST_MAX) { dropped.push({ headline, why: "too long for LinkedIn" }); continue; }
    const sources = [];
    const seenSrc = new Set();
    for (const s of Array.isArray(raw.sources) ? raw.sources : []) {
      const key = normalizeUrl(s?.url);
      if (!key || seenSrc.has(key)) continue;
      seenSrc.add(key);
      const v = await verifySource(s, fetchPage);
      if (v) sources.push(v);
    }
    if (!sources.length) { dropped.push({ headline, why: "no source could be opened" }); continue; }
    const primary = normalizeUrl(sources[0].url);
    if (otherPrimary.has(primary)) { dropped.push({ headline, why: "same story as a colleague's recent post" }); continue; }
    if (ownPrimary.has(primary)) { dropped.push({ headline, why: "same story as a post you removed" }); continue; }
    if (ownBodies.some((t) => similarity(body, t) >= TOO_SIMILAR)) { dropped.push({ headline, why: "too close to a post you removed" }); continue; }
    candidates.push({
      headline, topic: TOPIC_KEYS.includes(raw.topic) ? raw.topic : "", eventKey: cleanStr(raw.eventKey, 80),
      body, hashtags: (Array.isArray(raw.hashtags) ? raw.hashtags : []).map(cleanTag).filter(Boolean).slice(0, 5),
      sources, primary,
      check: { verdict: raw.check?.verdict === "fixed" ? "fixed" : "passed", notes: noDashes(cleanStr(raw.check?.notes, 600)) },
    });
  }
  const different = keepDifferent(candidates, otherBodies);
  dropped.push(...different.dropped);
  const seenPrimary = new Set();
  for (const d of different.kept) {
    if (seenPrimary.has(d.primary)) { dropped.push({ headline: d.headline, why: "same story as another draft in this delivery" }); continue; }
    seenPrimary.add(d.primary);
    kept.push(d);
  }
  return { kept, dropped };
}

/* ---------- deliver drafts ---------- */
async function waitingProfile(userId) {
  if (!mongoose.isValidObjectId(userId)) return null;
  const p = await LinkedinProfile.findOne({ userId }).lean();
  return p && p.run?.state === "working" && p.run?.via === "muse" ? p : null;
}

router.post("/pending/:userId/drafts", importLimiter, wrap(async (req, res) => {
  const profile = await waitingProfile(req.params.userId);
  if (!profile) return res.status(409).json({ error: "That person has no Muse round waiting.", code: "no_round" });
  const userId = profile.userId;
  const now = museDeps.now();
  const since = new Date(now.getTime() - WINDOW_MS);
  const settings = settingsOf(profile);
  const [otherRows, dismissedRows, events] = await Promise.all([
    LinkedinProfileDraft.find({ userId: { $ne: userId }, createdAt: { $gte: since } }, { headline: 1, body: 1, sources: 1 }).sort({ createdAt: -1 }).limit(200).lean(),
    LinkedinProfileDraft.find({ userId, status: "dismissed", createdAt: { $gte: since } }, { body: 1, sources: 1 }).sort({ createdAt: -1 }).limit(40).lean(),
    eventsNow(),
  ]);
  const callerDropped = (Array.isArray(req.body?.dropped) ? req.body.dropped : [])
    .map((d) => ({ headline: noDashes(cleanStr(d?.headline, 160)).trim() || "Draft", why: noDashes(cleanStr(d?.why, 300)).trim() || "Muse left it out" }));
  const { kept, dropped } = await processImport({ drafts: req.body?.drafts, others: otherRows, dismissed: dismissedRows, fetchPage: museDeps.fetchPage });
  const evOf = (key) => [events.recent, events.next, events.main].find((e) => e && e.key === key) || null;
  const docs = kept.map((d) => {
    const ev = evOf(d.eventKey);
    const text = composePost(d, { sourcesInPost: settings.sourcesInPost });
    return {
      userId, headline: d.headline, topic: d.topic, body: d.body, hashtags: d.hashtags, sources: d.sources,
      event: ev ? { key: ev.key, name: ev.name, city: ev.city, when: ev.when } : undefined,
      check: { ...d.check, at: now }, text, generatedText: text, status: "draft", round: profile.run.startedAt || now,
    };
  });
  if (docs.length) await LinkedinProfileDraft.insertMany(docs);
  const allDropped = [...callerDropped, ...dropped].slice(0, 20);
  await LinkedinProfile.updateOne({ userId }, { $set: {
    "run.state": "done", "run.finishedAt": now, "run.made": docs.length, "run.dropped": allDropped,
    "run.error": docs.length ? "" : "Nothing passed the checks this time. Try again, or widen the topics.", "run.costUsd": 0,
  } });
  AdminAudit.create({ adminId: userId, adminName: "Muse (Orion)", action: "linkedin_profile_muse_import",
                      targetType: "linkedin_profile_post", targetId: String(userId),
                      detail: `${docs.length} draft(s) delivered by Muse; ${allDropped.length} left out` }).catch(() => {});
  res.json({ ok: true, made: docs.length, dropped: allDropped });
}));

/* ---------- the round could not be written ---------- */
router.post("/pending/:userId/fail", wrap(async (req, res) => {
  const profile = await waitingProfile(req.params.userId);
  if (!profile) return res.status(409).json({ error: "That person has no Muse round waiting.", code: "no_round" });
  const error = noDashes(cleanStr(req.body?.error, 300)).trim() || "Muse couldn't finish these drafts. Try again.";
  await LinkedinProfile.updateOne({ userId: profile.userId }, { $set: {
    "run.state": "failed", "run.finishedAt": museDeps.now(), "run.error": error, "run.costUsd": 0,
  } });
  res.json({ ok: true });
}));

export default router;
