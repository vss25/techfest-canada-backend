import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import Stripe from "stripe";
import crypto from "crypto";
import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import TicketInventory from "../models/TicketInventory.js";
import { collectTickets, salesSummary } from "../services/staffTickets.js";

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

async function ensureTiers() {
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

const adminMiddleware = (req, res, next) => {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
};

/* =========================================================
   📊 SALES ANALYTICS DASHBOARD
   GET /api/admin/analytics?range=day|week|month
========================================================= */
router.get(
  "/analytics",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    try {
      const { range = "week" } = req.query;
      // Real numbers from ticket purchase dates (was an even split of the totals).
      const [inventory, users, guests] = await Promise.all([
        TicketInventory.find().lean(),
        User.find({ "tickets.0": { $exists: true } }).select("name email tickets").lean(),
        Attendee.find({}).select("name email ticketId ticketType purchaseDate checkedIn hiddenByStaff").lean(),
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
  authMiddleware,
  adminMiddleware,
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
    res.json(await ensureTiers());
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
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    try {
      const { tier } = req.params;
      const { total, price } = req.body;

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

      const syncedAttendees = [];
      const skipped = [];

      // Fetch all completed checkout sessions (pagination: 100 at a time)
      let hasMore = true;
      let lastSessionId = null;

      while (hasMore) {
        const params = {
          limit: 100,
          status: "complete",
        };

        if (lastSessionId) {
          params.starting_after = lastSessionId;
        }

        const sessions = await stripe.checkout.sessions.list(params);

        for (const session of sessions.data) {
          // Skip if not a ticket purchase
          const purchaseType = session.metadata?.type;
          if (purchaseType === "booth") continue;

          const tier = session.metadata?.tier;
          if (!tier) continue;

          // Booth purchases are exhibitors, not delegates — no pass to issue
          if (String(tier).startsWith("booth-")) continue;

          const email = session.customer_details?.email;
          const name = session.customer_details?.name || "Guest";

          if (!email) {
            skipped.push({
              reason: "no_email",
              sessionId: session.id,
              tier
            });
            continue;
          }

          // Don't re-import a session we've already turned into an attendee
          const already = await Attendee.findOne({ stripeSessionId: session.id });
          if (already) {
            skipped.push({ reason: "already_imported", sessionId: session.id, tier });
            continue;
          }

          const ticketId = crypto.randomBytes(6).toString("hex");

          const attendee = new Attendee({
            name,
            email,
            ticketId,
            ticketType: tier,
            purchaseDate: new Date(session.created * 1000),
            stripeSessionId: session.id,
          });

          await attendee.save();

          syncedAttendees.push({
            name,
            email,
            ticketId,
            ticketType: tier,
            purchaseDate: attendee.purchaseDate
          });

          console.log("🔄 Synced guest from Stripe:", email, tier);
        }

        lastSessionId = sessions.data[sessions.data.length - 1]?.id;
        hasMore = sessions.has_more;
      }

      res.json({
        success: true,
        synced: syncedAttendees.length,
        skipped: skipped.length,
        attendees: syncedAttendees,
        skippedDetails: skipped.slice(0, 20) // Return first 20 skipped for info
      });
    } catch (err) {
      console.error("Sync error:", err);
      res.status(500).json({ error: "Sync failed: " + err.message });
    }
  }
);

export default router;
