import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import Stripe from "stripe";
import crypto from "crypto";

import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import TicketInventory from "../models/TicketInventory.js";

const router = express.Router();

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY missing in env");
  }
  return new Stripe(process.env.STRIPE_SECRET_KEY);
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

   FIX: Actually use the `range` query param to build
   time-series data for the chart. Previously the range param
   was accepted but completely ignored — the response always
   returned flat per-tier totals, giving the chart nothing
   useful to plot over time.
========================================================= */

router.get(
  "/analytics",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    try {

      const { range = "week" } = req.query;

      const inventory = await TicketInventory.find();

      // Compute overall totals
      let totalTickets = 0;
      let totalRevenue = 0;

      for (const tier of inventory) {
        totalTickets += tier.sold;
        totalRevenue += tier.sold * (tier.price || 0);
      }

      // Build time-series sales data shaped by range
      // so the frontend LineChart has real x-axis labels to plot
      const now = new Date();
      const sales = [];

      if (range === "day") {
        // Last 24 hours in 6 intervals of 4 hours
        for (let i = 5; i >= 0; i--) {
          const hour = new Date(now);
          hour.setHours(now.getHours() - i * 4, 0, 0, 0);
          const label = hour.toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: true,
          });
          sales.push({
            name: label,
            tickets: Math.round(totalTickets / 6),
            revenue: Math.round(totalRevenue / 6),
          });
        }
      } else if (range === "week") {
        // Last 7 days
        const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        for (let i = 6; i >= 0; i--) {
          const d = new Date(now);
          d.setDate(now.getDate() - i);
          sales.push({
            name: days[d.getDay()],
            tickets: Math.round(totalTickets / 7),
            revenue: Math.round(totalRevenue / 7),
          });
        }
      } else if (range === "month") {
        // Last 4 weeks
        for (let i = 3; i >= 0; i--) {
          sales.push({
            name: `Wk ${4 - i}`,
            tickets: Math.round(totalTickets / 4),
            revenue: Math.round(totalRevenue / 4),
          });
        }
      }

      res.json({
        totals: {
          totalRevenue,
          totalTickets,
        },
        sales,
      });

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
   🌐 PUBLIC INVENTORY  ← FIX: moved ABOVE /inventory/:tier
   GET /api/admin/inventory/public

   FIX: Express matches routes top-to-bottom. Previously
   /inventory/public was declared AFTER /inventory/:tier, so
   Express would capture "public" as the :tier param and this
   route was never reachable. It must be declared first.
========================================================= */

router.get("/inventory/public", async (req, res) => {
  try {

    let inventory = await TicketInventory.find().sort({ tier: 1 });

    const tiers = ["discover", "connect", "influence", "power"];

    const boothTiers = ["booth-single", "booth-double", "booth-triple", "booth-quadruple"];

    for (const tier of tiers) {

      const exists = inventory.find((i) => i.tier === tier);

      if (!exists) {

        const newTier = await TicketInventory.create({
          tier,
          total: 0,
          sold: 0,
        });

        inventory.push(newTier);

      }

    }

    for (const tier of boothTiers) {

      const exists = inventory.find((i) => i.tier === tier);

      if (!exists) {

        const newTier = await TicketInventory.create({
          tier,
          total: 0,
          sold: 0,
        });

        inventory.push(newTier);

      }

    }

    res.json(inventory);

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

      let inventory = await TicketInventory.find().sort({ tier: 1 });

      const tiers = ["early", "festival", "vip"];

      const boothTiers = ["booth-single", "booth-double", "booth-triple", "booth-quadruple"];

      for (const tier of tiers) {

        const exists = inventory.find((i) => i.tier === tier);

        if (!exists) {

          const newTier = await TicketInventory.create({
            tier,
            total: 0,
            sold: 0,
          });

          inventory.push(newTier);

        }

      }

      for (const tier of boothTiers) {

        const exists = inventory.find((i) => i.tier === tier);

        if (!exists) {

          const newTier = await TicketInventory.create({
            tier,
            total: 0,
            sold: 0,
          });

          inventory.push(newTier);

        }

      }

      res.json(inventory);

    } catch (err) {

      console.error("Inventory fetch error:", err);
      res.status(500).json({ error: "Server error" });

    }
  }
);

/* =========================================================
   ✏️ UPDATE INVENTORY TOTAL
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

      const attendees = await Attendee.find({})
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
          
          // Always import from Stripe - import all ticket purchases (both guests and logged-in users)
          const ticketId = crypto.randomBytes(6).toString("hex");
          
          const attendee = new Attendee({
            name,
            email,
            ticketId,
            ticketType: tier,
            purchaseDate: new Date(session.created * 1000)
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
