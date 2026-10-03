import express from "express";
import IntelCard from "../models/IntelCard.js";
import { companiesFor, ALL_COMPANIES } from "../data/intelCompanies.js";
import { generateCard, isConfigured } from "../services/gemini.js";
import { requireAdmin } from "../middleware/adminAuth.js";

/* =========================================================
   GET  /api/intel?topics=Artificial%20Intelligence,Cybersecurity
   =========================================================
   Returns cached company cards for the app's home-screen spotlight:
     [ { name, whatTheyDo, updates:[{headline, source, dateLabel}] } ]
   Cards older than INTEL_TTL_HOURS (default 24) are refreshed in the
   background via Gemini; the request never waits on the model. With no
   GEMINI_API_KEY and an empty cache → 503, and the app uses its bundled
   snapshot.

   POST /api/intel/refresh   (admin) — refresh every company now.
========================================================= */

const router = express.Router();
const TTL_MS = Number(process.env.INTEL_TTL_HOURS || 24) * 3600 * 1000;
const inflight = new Set();

export function isStale(card, now = Date.now(), ttl = TTL_MS) {
  return !card || !card.refreshedAt || now - new Date(card.refreshedAt).getTime() > ttl;
}

async function refreshCompany(name) {
  if (inflight.has(name) || !isConfigured()) return;
  inflight.add(name);
  try {
    const card = await generateCard(name);
    await IntelCard.findOneAndUpdate(
      { name },
      { ...card, name, refreshedAt: new Date() },
      { upsert: true, new: true }
    );
    console.log("🧠 intel refreshed:", name);
  } catch (err) {
    console.error("intel refresh failed:", name, err.response?.data?.error?.message || err.message);
  } finally {
    inflight.delete(name);
  }
}

router.get("/", async (req, res) => {
  try {
    const topics = String(req.query.topics || "").split(",").map((t) => t.trim()).filter(Boolean);
    const names = topics.length ? companiesFor(topics) : ALL_COMPANIES;
    const cards = await IntelCard.find({ name: { $in: names } }).lean();
    const byName = new Map(cards.map((c) => [c.name, c]));

    // Kick off background refreshes for missing/stale cards (fire and forget).
    for (const n of names) if (isStale(byName.get(n))) refreshCompany(n);

    const fresh = names.map((n) => byName.get(n)).filter(Boolean);
    if (!fresh.length) {
      return res.status(503).json({ error: isConfigured() ? "Intel warming up — try again shortly" : "Intel agent not configured" });
    }
    res.set("Cache-Control", "public, max-age=900");
    res.json(fresh.map((c) => ({
      name: c.name,
      whatTheyDo: c.whatTheyDo,
      updates: (c.updates || []).map(({ headline, source, dateLabel }) => ({ headline, source, dateLabel })),
      refreshedAt: c.refreshedAt,
    })));
  } catch (err) {
    console.error("INTEL ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/refresh", requireAdmin, async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: "GEMINI_API_KEY not set" });
  const names = Array.isArray(req.body?.companies) && req.body.companies.length ? req.body.companies : ALL_COMPANIES;
  // Sequential to stay well inside Gemini rate limits.
  (async () => { for (const n of names) await refreshCompany(n); })();
  res.json({ started: names.length });
});

router.get("/status", async (_req, res) => {
  const count = await IntelCard.countDocuments();
  res.json({ configured: isConfigured(), cachedCompanies: count, totalCompanies: ALL_COMPANIES.length });
});

export default router;
