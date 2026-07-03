import express from "express";
import Promo from "../models/Promo.js";
import { requireAdmin } from "../middleware/adminAuth.js";

const router = express.Router();

const ALLOWED_TIERS = ["connect", "influence", "power"];

/* ============ PUBLIC: validate code ============
   Mounted at /api in server.js → full URL: POST /api/promos/validate
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

    // Tier scoping: empty tiers array = valid for all passes
    if (Array.isArray(promo.tiers) && promo.tiers.length > 0) {
      if (!tier || !promo.tiers.includes(tier)) {
        return res.status(404).json(genericInvalid);
      }
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
    const promos = await Promo.find().sort({ createdAt: -1 });
    res.json(promos);
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

    let tiers = Array.isArray(req.body.tiers) ? req.body.tiers : [];
    tiers = tiers
      .map(t => String(t).trim().toLowerCase())
      .filter(t => ALLOWED_TIERS.includes(t));
    tiers = [...new Set(tiers)];

    const existing = await Promo.findOne({ code });
    if (existing) return res.status(409).json({ error: "Code already exists" });

    const promo = await Promo.create({ code, discount, tiers, active: true });
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
    if (typeof req.body.discount === "number") update.discount = req.body.discount;

    if (Array.isArray(req.body.tiers)) {
      let tiers = req.body.tiers
        .map(t => String(t).trim().toLowerCase())
        .filter(t => ALLOWED_TIERS.includes(t));
      update.tiers = [...new Set(tiers)];
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
