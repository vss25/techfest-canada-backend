import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import Stripe from "stripe";
import crypto from "crypto";
import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import TicketInventory from "../models/TicketInventory.js";
import { collectTickets, salesSummary } from "../services/staffTickets.js";
import { planSync, applySync, listCompleteSessions, planDetailsBackfill, applyDetailsBackfill } from "../services/stripeSync.js";
import { requireAdmin, requireManagementAdmin } from "../middleware/adminAuth.js";
import { AppContent } from "../models/Admin.js";

const router = express.Router();

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY missing in env");
  }
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

/* =========================================================
   🎟️ TIER REGISTRY

   Single source of truth for which tiers must exist and what
   they're worth when first created. Add a tier here and it
   appears in the admin table and becomes purchasable on the
   next request — no migration needed.

   NOTE: the `total` defaults are deliberately NOT zero. The
   tickets page computes soldOut as (total - sold) <= 0, so a
   tier seeded with total: 0 renders as SOLD OUT the moment it
   appears. Set the real allocation in the admin table.

   Prices must match the figures shown on the front end
   (Tickets.jsx PASS_META and Exhibit.jsx BOOTH_TIERS) — Stripe
   charges what's stored here, not what the page displays.
========================================================= */
const TIER_DEFAULTS = {
  connect:           { price: 599,  total: 200 },
  influence:         { price: 799,  total: 200 },
  power:             { price: 999,  total: 100 },
  apex:              { price: 1499, total: 50  },
  "booth-single":    { price: 2499, total: 40  },
  "booth-double":    { price: 4499, total: 20  },
  "booth-triple":    { price: 5999, total: 10  },
  "booth-quadruple": { price: 7499, total: 6   },
};

/* Old passes no longer sold. Archived once (the first time this code runs);
   staff can restore one from the admin panel and it stays restored. */
export const RETIRED_TIERS = ["early", "festival", "discover", "vip"];

async function ensureTiers() {
  await TicketInventory.updateMany(
    { tier: { $in: RETIRED_TIERS }, archived: { $exists: false } },
    { $set: { archived: true } }
  );
  const inventory = await TicketInventory.find();

  for (const [tier, d] of Object.entries(TIER_DEFAULTS)) {
    if (!inventory.find((i) => i.tier === tier)) {
      const created = await TicketInventory.create({
        tier,
        total: d.total,
        sold: 0,
        price: d.price,
      });
      console.log("🎟️  Created inventory tier:", tier, `($${d.price})`);
      inventory.push(created);
    }
  }

  return inventory.sort((a, b) => a.tier.localeCompare(b.tier));
}

/* =========================================================
   🔐 AUTH MIDDLEWARE
========================================================= */
const authMiddleware = (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "No token provided" });
    }

    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
};

// Staff-only routes check the database, not the token's "role" claim, so
// removing someone's staff access takes effect immediately.
const adminMiddleware = (req, res, next) => requireAdmin(req, res, next);

/* =========================================================
   📊 SALES ANALYTICS DASHBOARD
   GET /api/admin/analytics?range=day|week|month
========================================================= */
router.get(
  "/analytics",
  requireManagementAdmin,
  async (req, res) => {
    try {
      const { range = "week" } = req.query;
      // Real numbers from ticket purchase dates (was an even split of the totals).
      const [inventory, users, guests] = await Promise.all([
        TicketInventory.find().lean(),
        User.find({ "tickets.0": { $exists: true } }).select("name email tickets").lean(),
        Attendee.find({}).select("name email ticketId ticketType purchaseDate checkedIn hiddenByStaff promoCode").lean(),
      ]);
      const prices = Object.fromEntries(inventory.map((t) => [t.tier, t.price || 0]));
      const summary = salesSummary(collectTickets(users, guests), prices, { range });
      res.json({ totals: summary.totals, sales: summary.sales, byTier: summary.byTier });
    } catch (err) {
      console.error("Analytics error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

/* =========================================================
   👑 PROMOTE USER TO ADMIN
   POST /api/admin/promote
========================================================= */
router.post(
  "/promote",
  requireManagementAdmin,   // only management can make someone staff
  async (req, res) => {
    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({ error: "Email is required" });
      }

      const user = await User.findOne({ email });

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      if (user.role === "admin") {
        return res.json({ success: true, message: "User already admin" });
      }

      user.role = "admin";
      await user.save();

      res.json({
        success: true,
        message: `${email} is now an admin`,
      });
    } catch (err) {
      console.error("Promote error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

/* =========================================================
   🌐 PUBLIC INVENTORY  ← must stay ABOVE /inventory/:tier
   GET /api/admin/inventory/public

   Express matches routes top-to-bottom. Declared after
   /inventory/:tier, Express captures "public" as the :tier
   param and this route is never reachable.
========================================================= */
router.get("/inventory/public", async (req, res) => {
  try {
    res.json((await ensureTiers()).filter((t) => !t.archived));
  } catch (err) {
    console.error("Public inventory error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* =========================================================
   📊 GET INVENTORY
   GET /api/admin/inventory
========================================================= */
router.get(
  "/inventory",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    try {
      res.json(await ensureTiers());
    } catch (err) {
      console.error("Inventory fetch error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

/* =========================================================
   ✏️ UPDATE INVENTORY TOTAL / PRICE
   PUT /api/admin/inventory/:tier
========================================================= */
router.put(
  "/inventory/:tier",
  requireManagementAdmin,
  async (req, res) => {
    try {
      const { tier } = req.params;
      const { total, price, archived } = req.body;

      let inventory = await TicketInventory.findOne({ tier });

      if (!inventory) {
        inventory = new TicketInventory({
          tier,
          total: total || 0,
          sold: 0,
          price: price || 0
        });
      }

      if (typeof total === "number") {
        if (total < inventory.sold) {
          return res.status(400).json({
            error: "Total cannot be less than sold tickets"
          });
        }
        inventory.total = total;
      }

      if (typeof price === "number") {
        inventory.price = price;
      }

      if (typeof archived === "boolean") {
        inventory.archived = archived;
      }

      await inventory.save();

      res.json({
        success: true,
        inventory
      });
    } catch (err) {
      console.error("Inventory update error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

/* =========================================================
    👥 GET ATTENDEES
    GET /api/admin/attendees
========================================================= */
router.get(
  "/attendees",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    try {
      const attendees = await Attendee.find({ hiddenByStaff: { $ne: true } })
        .select("name email ticketId ticketType purchaseDate checkedIn")
        .sort({ purchaseDate: -1 })
        .lean();

      res.json(attendees);
    } catch (err) {
      console.error("Attendees fetch error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

/* =========================================================
    📷 QR CHECK-IN
    POST /api/admin/checkin
========================================================= */
router.post(
  "/checkin",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    try {
      const { ticketId } = req.body;

      if (!ticketId) {
        return res.status(400).json({ error: "Ticket ID required" });
      }

      // First check in User collection
      const user = await User.findOne({
        "tickets.ticketId": ticketId,
      });

      if (user) {
        const ticket = user.tickets.find(
          (t) => t.ticketId === ticketId
        );

        if (ticket.checkedIn) {
          return res.status(400).json({
            error: "Ticket already checked in",
          });
        }

        ticket.checkedIn = true;
        await user.save();

        res.json({
          success: true,
          name: user.name,
          ticketId: ticket.ticketId,
          type: ticket.type,
        });

        return;
      }

      // Check in Attendee collection (guests)
      const attendee = await Attendee.findOne({ ticketId });

      if (!attendee) {
        return res.status(404).json({ error: "Ticket not found" });
      }

      if (attendee.checkedIn) {
        return res.status(400).json({
          error: "Ticket already checked in",
        });
      }

      attendee.checkedIn = true;
      await attendee.save();

      res.json({
        success: true,
        name: attendee.name,
        ticketId: attendee.ticketId,
        type: attendee.ticketType,
      });
    } catch (err) {
      console.error("Check-in error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

/* =========================================================
    🔄 SYNC GUESTS FROM STRIPE
    POST /api/admin/sync-guests-from-stripe
========================================================= */
router.post(
  "/sync-guests-from-stripe",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    try {
      const stripe = getStripe();
      const [sessions, attendees, users] = await Promise.all([
        listCompleteSessions(stripe),
        Attendee.find({}).lean(),
        User.find({ "tickets.0": { $exists: true } }).select("email tickets").lean(),
      ]);
      // One paid session = one ticket: link existing tickets, hide old copies, create only what's missing.
      const plan = planSync(sessions, attendees, users);
      const result = await applySync(plan, { Attendee, User, crypto });
      result.detailsFilled = await backfillDetails(sessions);
      console.log("🔄 Stripe sync:", result);
      res.json({
        success: true,
        synced: result.created,
        linked: result.linked,
        duplicatesHidden: result.duplicatesHidden,
        detailsFilled: result.detailsFilled,
        skipped: sessions.length - result.created,
      });
    } catch (err) {
      console.error("Sync error:", err);
      res.status(500).json({ error: "Sync failed: " + err.message });
    }
  }
);

/* Copy checkout-form details Stripe holds onto tickets that don't have them yet
   (reads fresh records, so run it after any linking). Returns how many were filled. */
async function backfillDetails(sessions) {
  const [attendees, users] = await Promise.all([
    Attendee.find({ stripeSessionId: { $exists: true, $ne: "" } }).select("name stripeSessionId details").lean(),
    User.find({ "tickets.stripeSessionId": { $exists: true } }).select("tickets").lean(),
  ]);
  return applyDetailsBackfill(planDetailsBackfill(sessions, attendees, users), { Attendee, User });
}

/* One-time repair after deploy: link tickets to their Stripe sessions and
   hide the copies the old sync created. Never creates tickets. */
export async function repairStripeSyncOnce() {
  const KEY = "migration.stripe_sync_repair_v2";   // v2 also backfills promo codes
  try {
    if (!process.env.STRIPE_SECRET_KEY) return;
    if (await AppContent.exists({ key: KEY })) return;
    const [sessions, attendees, users] = await Promise.all([
      listCompleteSessions(getStripe()),
      Attendee.find({}).lean(),
      User.find({ "tickets.0": { $exists: true } }).select("email tickets").lean(),
    ]);
    const result = await applySync(planSync(sessions, attendees, users), { Attendee, User, crypto, allowCreate: false });
    await AppContent.create({ key: KEY, value: { ...result, at: new Date() }, updatedBy: "system" });
    console.log("🧹 Stripe sync repair:", result);
  } catch (err) {
    console.error("Stripe sync repair skipped:", err.message);
  }
  await backfillDetailsOnce();
}

/* One-time after deploy: tickets bought before details were saved get
   whatever the checkout form sent to Stripe (name, company, job title, country). */
async function backfillDetailsOnce() {
  const KEY = "migration.attendee_details_backfill_v1";
  try {
    if (!process.env.STRIPE_SECRET_KEY) return;
    if (await AppContent.exists({ key: KEY })) return;
    const sessions = await listCompleteSessions(getStripe());
    await applySync(planSync(sessions, await Attendee.find({}).lean(),
      await User.find({ "tickets.0": { $exists: true } }).select("email tickets").lean()),
      { Attendee, User, crypto, allowCreate: false });
    const filled = await backfillDetails(sessions);
    await AppContent.create({ key: KEY, value: { filled, at: new Date() }, updatedBy: "system" });
    console.log("🗂  Attendee details backfilled:", filled);
  } catch (err) {
    console.error("Attendee details backfill skipped:", err.message);
  }
}

export default router;
