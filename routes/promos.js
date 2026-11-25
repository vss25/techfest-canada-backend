import express from "express";
import Promo from "../models/Promo.js";
import { eventClause, cleanEventKey } from "../services/attendeeVisibility.js";
import { requireAdmin, isManagement } from "../middleware/adminAuth.js";   // staff add codes; past the safeguard they wait for a manager (services/promoApproval.js)
import { AdminAudit } from "../models/Admin.js";
import { managerReasons, forStaff } from "../services/promoApproval.js";
import Stripe from "stripe";
import { stripeRows, promoUsage } from "../services/stripeSales.js";
import { LIMIT_REACHED, EXPIRED, isFull, parseMaxUses, parseExpiresAt, promoExpired, promoUsageNow } from "../services/promoLimits.js";

const router = express.Router();

const who = (req) => String(req.user?.name || req.user?.email || "Staff").slice(0, 120);
const audit = (req, action, promo, detail) =>
  AdminAudit.create({ adminId: req.user._id, adminName: req.user.name, action, targetType: "promo",
                      targetId: String(promo?._id || ""), detail: `${promo?.code || ""}: ${detail}`.slice(0, 500) }).catch(() => {});
const plain = (d) => (d?.toObject ? d.toObject() : d);
const managementOnly = (req, res, next) =>
  isManagement(req.user) ? next() : res.status(403).json({ error: "Management only", code: "management_only" });

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
    if (promoExpired(promo)) return res.status(410).json({ valid: false, error: EXPIRED });

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

    return res.json({ valid: true, code: promo.code, discount: promo.discount, expiresAt: promo.expiresAt || null });
  } catch (err) {
    console.error("Promo validate error:", err);
    res.status(500).json({ valid: false, error: "Server error" });
  }
});

/* ============ ADMIN: list ============
   Full URL: GET /api/admin/promos
============================================================ */
router.get("/admin/promos", requireAdmin, async (req, res) => {
  try {
    // ?eventKey= (Nov 23 2026): that event's codes only (codes without one are the 2026 main event's); none = all.
    const promos = await Promo.find(eventClause(req.query.eventKey)).sort({ createdAt: -1 }).lean();
    // Paid uses come from Stripe (a checkout that was never paid isn't a use).
    let usage = null, usageError = "";
    try {
      if (!process.env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY isn't set");
      usage = promoUsage(await stripeRows(new Stripe(process.env.STRIPE_SECRET_KEY)));
    } catch (e) { usageError = e.message; }
    const mgmt = isManagement(req.user);
    res.json(promos.map((p) => {
      const u = usage?.[String(p.code).toUpperCase()];
      // "Used" in the admin = paidUses (paid Stripe sessions, cached up to 5 min).
      const paidUses = usage ? (u?.paidUses || 0) : null;
      const row = { ...p, maxUses: p.maxUses ?? null, expiresAt: p.expiresAt ?? null, expired: promoExpired(p), full: paidUses != null && isFull(paidUses, p.maxUses),
               paidUses, revenue: u?.revenue || 0,
               discountGiven: u?.discountGiven || 0, lastUsedAt: u?.lastUsedAt || null, usageError,
               waiting: !!p.approval?.needed, canApprove: mgmt && !!p.approval?.needed };
      return mgmt ? row : forStaff(row);
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

    const ends = parseExpiresAt(req.body.expiresAt);  // empty = no end date
    if (!ends.ok) return res.status(400).json({ error: ends.error });

    const existing = await Promo.findOne({ code });
    if (existing) return res.status(409).json({ error: "Code already exists" });

    // Staff: past the safeguard, the code is saved switched off until a manager approves it.
    const reasons = isManagement(req.user) ? [] : managerReasons({ discount, maxUses: limit.value });
    const eventKey = cleanEventKey(req.body.eventKey) || undefined;   // optional; left off = the 2026 main event
    const promo = await Promo.create({ code, discount, tiers, maxUses: limit.value, expiresAt: ends.value, active: !reasons.length, eventKey,
      createdBy: who(req), approval: reasons.length ? { needed: true, reasons, requestedBy: who(req), requestedAt: new Date() } : undefined });
    audit(req, "promo_create", promo, `${discount}% off${limit.value ? `, ${limit.value} uses` : ", unlimited"}${reasons.length ? ` (waits for a manager: ${reasons.join(", ")})` : ""}`);
    res.json({ ...plain(promo), waiting: reasons.length > 0,
      notice: reasons.length ? `Saved. It's ${reasons.join(" and ")}, so a manager approves it before it works.` : "" });
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
    if ("expiresAt" in req.body) {                   // "" or null = no end date
      const ends = parseExpiresAt(req.body.expiresAt);
      if (!ends.ok) return res.status(400).json({ error: ends.error });
      update.expiresAt = ends.value;
    }

    const current = await Promo.findById(req.params.id).lean();
    if (!current) return res.status(404).json({ error: "Not found" });
    if (isManagement(req.user)) {
      // A manager's change counts as approving what they leave in place.
      if (current.approval?.needed && (update.active === true || "discount" in update || "maxUses" in update)) {
        update.approval = { ...(current.approval || {}), needed: false, by: who(req), at: new Date() };
      }
    } else {
      const next = { discount: update.discount ?? current.discount, maxUses: "maxUses" in update ? update.maxUses : current.maxUses };
      const reasons = managerReasons(next);
      const termsChanged = "discount" in update || "maxUses" in update;
      if (reasons.length && (termsChanged || current.approval?.needed)) {
        if (update.active === true) return res.status(403).json({ error: `A manager approves this code first (it's ${reasons.join(" and ")}).`, code: "needs_manager" });
        if (termsChanged) Object.assign(update, { active: false, approval: { needed: true, reasons, requestedBy: who(req), requestedAt: new Date() } });
      }
    }
    const promo = await Promo.findByIdAndUpdate(req.params.id, update, { new: true });
    audit(req, "promo_edit", promo, Object.keys(update).filter((k) => k !== "approval").join(", ") + (promo.approval?.needed ? " (waits for a manager)" : ""));
    res.json({ ...plain(promo), waiting: !!promo.approval?.needed });
  } catch (err) {
    res.status(500).json({ error: "Update failed" });
  }
});

/* ============ ADMIN: delete ============ */
/* ============ ADMIN: approve a staff-made code (management) ============ */
router.post("/admin/promos/:id/approve", requireAdmin, managementOnly, async (req, res) => {
  try {
    const promo = await Promo.findByIdAndUpdate(req.params.id,
      { active: true, "approval.needed": false, "approval.by": who(req), "approval.at": new Date() }, { new: true });
    if (!promo) return res.status(404).json({ error: "Not found" });
    audit(req, "promo_approve", promo, "approved and switched on");
    res.json({ ...plain(promo), waiting: false });
  } catch (err) {
    res.status(500).json({ error: "Approve failed" });
  }
});

/* ============ ADMIN: delete (management) ============ */
router.delete("/admin/promos/:id", requireAdmin, managementOnly, async (req, res) => {
  try {
    const promo = await Promo.findByIdAndDelete(req.params.id);
    if (!promo) return res.status(404).json({ error: "Not found" });
    audit(req, "promo_delete", promo, "deleted");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Delete failed" });
  }
});

export default router;
