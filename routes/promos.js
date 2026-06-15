import express from "express";
import Promo from "../models/Promo.js";
import { requireAdmin } from "../middleware/adminAuth.js";

const router = express.Router();

router.post("/promos/validate", async (req, res) => {
  try {
    const code = String(req.body.code || "").trim().toUpperCase();
    if (!code) return res.status(400).json({ valid: false, error: "Code required" });

    const promo = await Promo.findOne({ code });
    if (!promo) return res.status(404).json({ valid: false, error: "Invalid code" });
    if (!promo.active) return res.status(400).json({ valid: false, error: "This code is no longer active" });

    return res.json({ valid: true, code: promo.code, discount: promo.discount });
  } catch (err) {
    console.error("Promo validate error:", err);
    res.status(500).json({ valid: false, error: "Server error" });
  }
});

router.get("/admin/promos", requireAdmin, async (_req, res) => {
  try {
    const promos = await Promo.find().sort({ createdAt: -1 });
    res.json(promos);
  } catch (err) {
    res.status(500).json({ error: "Failed to load promos" });
  }
});

router.post("/admin/promos", requireAdmin, async (req, res) => {
  try {
    const code = String(req.body.code || "").trim().toUpperCase().replace(/\s+/g, "");
    const discount = Number(req.body.discount);
    if (!code) return res.status(400).json({ error: "Code required" });
    if (!discount || discount < 1 || discount > 100) return res.status(400).json({ error: "Discount must be 1-100" });

    const existing = await Promo.findOne({ code });
    if (existing) return res.status(409).json({ error: "Code already exists" });

    const promo = await Promo.create({ code, discount, active: true });
    res.json(promo);
  } catch (err) {
    console.error("Promo create error:", err);
    res.status(500).json({ error: "Create failed" });
  }
});

router.put("/admin/promos/:id", requireAdmin, async (req, res) => {
  try {
    const update = {};
    if (typeof req.body.active === "boolean") update.active = req.body.active;
    if (typeof req.body.discount === "number") update.discount = req.body.discount;
    const promo = await Promo.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!promo) return res.status(404).json({ error: "Not found" });
    res.json(promo);
  } catch (err) {
    res.status(500).json({ error: "Update failed" });
  }
});

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
