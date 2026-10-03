import express from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { buildPass, isConfigured } from "../services/walletPass.js";

/* =========================================================
   GET /api/wallet/pass/:ticketId   (Bearer user token)
   → application/vnd.apple.pkpass for a ticket the caller owns
     (staff may fetch any). 503 until the Pass Type ID cert is
     configured — see services/walletPass.js.
   GET /api/wallet/status → { configured }
========================================================= */

const router = express.Router();

router.get("/status", (_req, res) => res.json({ configured: isConfigured() }));

router.get("/pass/:ticketId", async (req, res) => {
  try {
    const h = req.headers.authorization;
    if (!h) return res.status(401).json({ error: "Unauthorized" });
    let decoded;
    try { decoded = jwt.verify(h.split(" ")[1], process.env.JWT_SECRET); }
    catch { return res.status(401).json({ error: "Invalid token" }); }

    const ticketId = String(req.params.ticketId);
    const user = await User.findById(decoded.id).select("name role tickets");
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    let owner = user;
    let ticket = user.tickets.find((t) => t.ticketId === ticketId);
    if (!ticket && user.role === "admin") {
      owner = await User.findOne({ "tickets.ticketId": ticketId }).select("name tickets");
      ticket = owner?.tickets.find((t) => t.ticketId === ticketId);
    }
    if (!ticket) return res.status(404).json({ error: "Ticket not found on this account" });
    if (!isConfigured()) return res.status(503).json({ error: "Apple Wallet passes are not set up yet" });

    const buf = await buildPass({ ticketId, tier: ticket.type, name: owner.name, purchaseDate: ticket.purchaseDate });
    res.set("Content-Type", "application/vnd.apple.pkpass");
    res.set("Content-Disposition", `attachment; filename="TTFC-${ticketId}.pkpass"`);
    res.send(buf);
  } catch (err) {
    console.error("WALLET PASS ERROR:", err);
    res.status(500).json({ error: "Could not build the pass" });
  }
});

export default router;
