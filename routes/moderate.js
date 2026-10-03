import express from "express";
import jwt from "jsonwebtoken";
import { moderateText, isConfigured } from "../services/deepcleer.js";

/* =========================================================
   POST /api/moderate  { text, context? }
   =========================================================
   Text-moderation proxy for the iOS app (feed posts, chat, Q&A). Keeps the
   DeepCleer key on the server. Any signed-in user may call it; anonymous
   calls are allowed but rate-limited harder. Returns
     { flagged, reason, riskLevel, labels }
   or 503 { error } when DeepCleer isn't configured — the app then falls
   back to its on-device word list.
========================================================= */

const router = express.Router();

// Tiny in-memory limiter: 60 checks / minute per user (or IP for anonymous).
const WINDOW_MS = 60_000;
const LIMIT_USER = Number(process.env.MODERATE_RPM_USER || 60);
const LIMIT_ANON = Number(process.env.MODERATE_RPM_ANON || 10);
const buckets = new Map();

export function allow(key, limit, now = Date.now()) {
  const b = buckets.get(key) || { start: now, n: 0 };
  if (now - b.start > WINDOW_MS) { b.start = now; b.n = 0; }
  b.n += 1;
  buckets.set(key, b);
  return b.n <= limit;
}

function userIdFrom(req) {
  const h = req.headers.authorization;
  if (!h) return null;
  try { return jwt.verify(h.split(" ")[1], process.env.JWT_SECRET).id; } catch { return null; }
}

router.get("/status", (_req, res) => res.json({ configured: isConfigured() }));

router.post("/", async (req, res) => {
  try {
    const { text, context } = req.body || {};
    if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "text required" });
    if (text.length > 10000) return res.status(413).json({ error: "text too long" });

    const userId = userIdFrom(req);
    const key = userId ? `u:${userId}` : `ip:${req.ip}`;
    if (!allow(key, userId ? LIMIT_USER : LIMIT_ANON)) {
      return res.status(429).json({ error: "Too many checks, slow down" });
    }
    if (!isConfigured()) return res.status(503).json({ error: "Moderation not configured" });

    const verdict = await moderateText({ text, userId: userId || req.ip, context });
    res.json(verdict);
  } catch (err) {
    console.error("MODERATE ERROR:", err.response?.data || err.message);
    // Never block an attendee on vendor trouble: tell the client to fall back.
    res.status(503).json({ error: "Moderation unavailable" });
  }
});

export default router;
