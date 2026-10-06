import express from "express";
import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import { requireAdmin } from "../middleware/adminAuth.js";

const router = express.Router();

// ================= CHECK-IN =================
// Staff only: the website's admin check-in page and the iOS app's scanner
// both send an admin JWT. Previously this endpoint was open, so anyone who
// knew a ticketId could mark it used.
router.post("/scan", requireAdmin, async (req, res) => {
  try {
    // Apple Wallet passes encode "TECHFEST:<ticketId>"; the website scanner sends the raw scan
    const ticketId = String(req.body?.ticketId || "").trim().replace(/^TECHFEST:/i, "");

    if (!ticketId) {
      return res.status(400).json({
        error: "Ticket ID required",
      });
    }

    // First check in User collection
    const user = await User.findOne({
      "tickets.ticketId": ticketId,
    });

    if (user) {
      const ticket = user.tickets.find(
        (t) => t.ticketId === ticketId
      );

      // already used
      if (ticket.checkedIn) {
        return res.json({
          status: "already_checked_in",
          name: user.name,
          time: ticket.checkedInAt,
        });
      }

      // mark as checked in
      ticket.checkedIn = true;
      ticket.checkedInAt = new Date();
      await user.save();
      // Keep the admin attendee list in step when a guest ticket was linked to this account.
      await Attendee.updateOne({ ticketId }, { $set: { checkedIn: true, checkedInAt: ticket.checkedInAt } });

      res.json({
        status: "success",
        name: user.name,
        ticketId,
        ticketType: ticket.type,
      });

      return;
    }

    // Check in Attendee collection (guests)
    const attendee = await Attendee.findOne({ ticketId });

    if (!attendee) {
      return res.status(404).json({
        status: "invalid",
        message: "Ticket not found",
      });
    }

    if (attendee.checkedIn) {
      return res.json({
        status: "already_checked_in",
        name: attendee.name,
        time: attendee.checkedInAt,
      });
    }

    attendee.checkedIn = true;
    attendee.checkedInAt = new Date();
    await attendee.save();

    res.json({
      status: "success",
      name: attendee.name,
      ticketId,
      ticketType: attendee.ticketType,
    });
  } catch (err) {
    console.error("CHECK-IN ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;