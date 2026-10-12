import express from "express";
import Promo from "../models/Promo.js";
import { requireManagementAdmin as requireAdmin } from "../middleware/adminAuth.js";   // promo codes = pricing → management only
import Stripe from "stripe";
import { stripeRows, promoUsage } from "../services/stripeSales.js";
import { LIMIT_REACHED, isFull, parseMaxUses, promoUsageNow } from "../services/promoLimits.js";

const router = express.Router();

// Swappable in tests (test/promo-limits.test.js); null when Stripe isn't configured.
export const promoDeps = {
  stripe: () => (process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null),
};

/* Tiers a code may be scoped to — passes and exhibition booths.
   An empty scope still means "valid everywhere".

   Deliberately duplicated from the enum in models/Promo.js rather
   than imported: a cross-file import means the two files must be
   deployed together, and pushing one without the other crashes the
   server on boot. Keep the two lists in sync by hand. */
const ALLOWED_TIERS = [
  "connect",
  "influence",
  "power",
  "apex",
  "booth-single",
  "booth-double",
  "booth-triple",
  "booth-quadruple",
];

const cleanTiers = (input) => {
  const list = Array.isArray(input) ? input : [];
  return [...new Set(
    list
      .map((t) => String(t).trim().toLowerCase())
      .filter((t) => ALLOWED_TIERS.includes(t))
  )];
};

/* ============ PUBLIC: validate code ============
   Mounted at /api in server.js → full URL: POST /api/promos/validate

   `tier` is optional. Pass "influence", "booth-single", etc. A code with
   an empty tiers array validates against anything, which is what makes
   existing site-wide codes work on booths.
============================================================ */
router.post("/promos/validate", async (req, res) => {
  try {
    const code = String(req.body.code || "").trim().toUpperCase();
    const tier = String(req.body.tier || "").trim().toLowerCase();

    if (!code) return res.status(400).json({ valid: false, error: "Code required" });

    const promo = await Promo.findOne({ code });

    // Generic error for everything — keeps codes private
    const genericInvalid = { valid: false, error: "Invalid code" };

    if (!promo) return res.status(404).json(genericInvalid);
    if (!promo.active) return res.status(400).json(genericInvalid);

    // Tier scoping: empty tiers array = valid for all passes and booths
    if (Array.isArray(promo.tiers) && promo.tiers.length > 0) {
      if (!tier || !promo.tiers.includes(tier)) {
        return res.status(404).json(genericInvalid);
      }
    }

    // Usage limit: paid uses + checkouts in progress (services/promoLimits.js).
    // If Stripe can't be reached the code is shown as valid; checkout checks again.
    const stripe = promo.maxUses ? promoDeps.stripe() : null;
    if (stripe) {
      try {
        const usage = await promoUsageNow(stripe, promo.code);
        if (isFull(usage.total, promo.maxUses)) return res.status(409).json({ valid: false, error: LIMIT_REACHED });
      } catch (e) { console.error("Promo usage check failed:", e.message); }
    }

    return res.json({ valid: true, code: promo.code, discount: promo.discount });
  } catch (err) {
    console.error("Promo validate error:", err);
    res.status(500).json({ valid: false, error: "Server error" });
  }
});

/* ============ ADMIN: list ============
   Full URL: GET /api/admin/promos
============================================================ */
router.get("/admin/promos", requireAdmin, async (_req, res) => {
  try {
    const promos = await Promo.find().sort({ createdAt: -1 }).lean();
    // Paid uses come from Stripe (a checkout that was never paid isn't a use).
    let usage = null, usageError = "";
    try {
      if (!process.env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY isn't set");
      usage = promoUsage(await stripeRows(new Stripe(process.env.STRIPE_SECRET_KEY)));
    } catch (e) { usageError = e.message; }
    res.json(promos.map((p) => {
      const u = usage?.[String(p.code).toUpperCase()];
      // "Used" in the admin = paidUses (paid Stripe sessions, cached up to 5 min).
      const paidUses = usage ? (u?.paidUses || 0) : null;
      return { ...p, maxUses: p.maxUses ?? null, full: paidUses != null && isFull(paidUses, p.maxUses),
               paidUses, revenue: u?.revenue || 0,
               discountGiven: u?.discountGiven || 0, lastUsedAt: u?.lastUsedAt || null, usageError };
    }));
  } catch (err) {
    res.status(500).json({ error: "Failed to load promos" });
  }
});

/* ============ ADMIN: create ============ */
router.post("/admin/promos", requireAdmin, async (req, res) => {
  try {
    const code = String(req.body.code || "").trim().toUpperCase().replace(/\s+/g, "");
    const discount = Number(req.body.discount);

    if (!code) return res.status(400).json({ error: "Code required" });
    if (!discount || discount < 1 || discount > 100) return res.status(400).json({ error: "Discount must be 1-100" });

    const tiers = cleanTiers(req.body.tiers);
    const limit = parseMaxUses(req.body.maxUses);   // empty = unlimited
    if (!limit.ok) return res.status(400).json({ error: limit.error });

    const existing = await Promo.findOne({ code });
    if (existing) return res.status(409).json({ error: "Code already exists" });

    const promo = await Promo.create({ code, discount, tiers, maxUses: limit.value, active: true });
    res.json(promo);
  } catch (err) {
    console.error("Promo create error:", err);
    res.status(500).json({ error: "Create failed" });
  }
});

/* ============ ADMIN: update ============ */
router.put("/admin/promos/:id", requireAdmin, async (req, res) => {
  try {
    const update = {};
    if (typeof req.body.active === "boolean") update.active = req.body.active;
    if (typeof req.body.discount === "number") {
      if (!Number.isFinite(req.body.discount) || req.body.discount < 1 || req.body.discount > 100) return res.status(400).json({ error: "Discount must be 1-100" });
      update.discount = req.body.discount;
    }
    if (Array.isArray(req.body.tiers)) update.tiers = cleanTiers(req.body.tiers);
    if ("maxUses" in req.body) {                     // "" or null = unlimited
      const limit = parseMaxUses(req.body.maxUses);
      if (!limit.ok) return res.status(400).json({ error: limit.error });
      update.maxUses = limit.value;
    }

    const promo = await Promo.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!promo) return res.status(404).json({ error: "Not found" });
    res.json(promo);
  } catch (err) {
    res.status(500).json({ error: "Update failed" });
  }
});

/* ============ ADMIN: delete ============ */
router.delete("/admin/promos/:id", requireAdmin, async (req, res) => {
  try {
    const promo = await Promo.findByIdAndDelete(req.params.id);
    if (!promo) return res.status(404).json({ error: "Not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Delete failed" });
  }
});

export default router;
