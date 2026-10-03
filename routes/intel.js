import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import IntelCard from "../models/IntelCard.js";
import { companiesFor, ALL_COMPANIES } from "../data/intelCompanies.js";
import { generateCard, isConfigured as geminiConfigured } from "../services/gemini.js";
import { fetchCompanyNews, GDELT_SPACING_MS } from "../services/newsFeed.js";
import { requireAdmin } from "../middleware/adminAuth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESCRIPTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "companyDescriptions.json"), "utf8"));

/* =========================================================
   GET  /api/intel?topics=Artificial%20Intelligence,Cybersecurity
   =========================================================
   Returns cached company cards for the app's home-screen spotlight:
     [ { name, whatTheyDo, updates:[{headline, source, dateLabel, url}], refreshedAt } ]
   Cards older than INTEL_TTL_HOURS (default 24) are refreshed in the
   background — Gemini (search-grounded summaries) when GEMINI_API_KEY is
   set, otherwise real headlines from GDELT (no key needed). Refreshes run
   one at a time, spaced for GDELT's rate limit, and a daily sweep keeps
   every partner fresh. The request never waits on a refresh.

   POST /api/intel/refresh   (admin) — refresh every company now.
========================================================= */

const router = express.Router();
const TTL_MS = Number(process.env.INTEL_TTL_HOURS || 24) * 3600 * 1000;
const inflight = new Set();
const queue = [];
let draining = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isStale(card, now = Date.now(), ttl = TTL_MS) {
  return !card || !card.refreshedAt || now - new Date(card.refreshedAt).getTime() > ttl;
}

/** One company → fresh card (Gemini if configured, else GDELT headlines). */
async function refreshCompany(name) {
  try {
    let card;
    if (geminiConfigured()) {
      card = await generateCard(name);
    } else {
      const updates = await fetchCompanyNews(name);
      if (!updates.length) {
        // Nothing new this week: keep the old card but mark it checked.
        await IntelCard.updateOne({ name }, { $set: { refreshedAt: new Date() } }, { upsert: false });
        return;
      }
      card = { whatTheyDo: DESCRIPTIONS[name] || "", updates, model: "gdelt" };
    }
    if (!card.whatTheyDo) card.whatTheyDo = DESCRIPTIONS[name] || "";
    await IntelCard.findOneAndUpdate({ name }, { ...card, name, refreshedAt: new Date() }, { upsert: true, new: true });
    console.log("🧠 intel refreshed:", name, `(${card.model})`);
  } catch (err) {
    console.error("intel refresh failed:", name, err.response?.data?.error?.message || err.message);
  }
}

/** Serial queue so GDELT sees ≤ 1 request per GDELT_SPACING_MS. */
function enqueue(names) {
  for (const n of names) {
    if (!inflight.has(n)) { inflight.add(n); queue.push(n); }
  }
  if (draining) return;
  draining = true;
  (async () => {
    while (queue.length) {
      const n = queue.shift();
      await refreshCompany(n);
      inflight.delete(n);
      if (queue.length) await sleep(geminiConfigured() ? 1500 : GDELT_SPACING_MS);
    }
    draining = false;
  })();
}

export async function warmStale() {
  const cards = await IntelCard.find({ name: { $in: ALL_COMPANIES } }).select("name refreshedAt").lean();
  const byName = new Map(cards.map((c) => [c.name, c]));
  enqueue(ALL_COMPANIES.filter((n) => isStale(byName.get(n))));
}

// Daily sweep (and once shortly after boot) so news is fresh every morning.
if (process.env.NODE_ENV !== "test" && process.env.INTEL_AUTOREFRESH !== "false") {
  setTimeout(() => warmStale().catch(() => {}), 30_000).unref?.();
  setInterval(() => warmStale().catch(() => {}), 6 * 3600 * 1000).unref?.();
}

router.get("/", async (req, res) => {
  try {
    const topics = String(req.query.topics || "").split(",").map((t) => t.trim()).filter(Boolean);
    const names = topics.length ? companiesFor(topics) : ALL_COMPANIES;
    const cards = await IntelCard.find({ name: { $in: names } }).lean();
    const byName = new Map(cards.map((c) => [c.name, c]));

    // Queue background refreshes for missing/stale cards (fire and forget).
    enqueue(names.filter((n) => isStale(byName.get(n))));

    const fresh = names.map((n) => byName.get(n)).filter(Boolean);
    if (!fresh.length) return res.status(503).json({ error: "Intel warming up — try again shortly" });
    res.set("Cache-Control", "public, max-age=900");
    res.json(fresh.map((c) => ({
      name: c.name,
      whatTheyDo: c.whatTheyDo,
      updates: (c.updates || []).map(({ headline, source, dateLabel, url }) => ({ headline, source, dateLabel, url })),
      refreshedAt: c.refreshedAt,
      provider: c.model === "gdelt" ? "GDELT" : "Gemini",
    })));
  } catch (err) {
    console.error("INTEL ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/refresh", requireAdmin, async (req, res) => {
  const names = Array.isArray(req.body?.companies) && req.body.companies.length ? req.body.companies : ALL_COMPANIES;
  enqueue(names);
  res.json({ queued: names.length, provider: geminiConfigured() ? "Gemini" : "GDELT" });
});

router.get("/status", async (_req, res) => {
  const count = await IntelCard.countDocuments();
  res.json({ provider: geminiConfigured() ? "Gemini" : "GDELT", cachedCompanies: count, totalCompanies: ALL_COMPANIES.length, queued: queue.length });
});

export default router;
