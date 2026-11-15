import express from "express";
import jwt from "jsonwebtoken";
import AdminAuditLog from "../models/AdminAuditLog.js";
import { requireAdmin } from "../middleware/adminAuth.js";

const router = express.Router();

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
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
};

// The audit log is staff-only, like the routes it records.
const adminMiddleware = (req, res, next) => requireAdmin(req, res, next);

// ================= LIST AUDIT ENTRIES =================
// Newest first. Filters: ?resource=event, ?actor=<email> (case-insensitive
// substring), ?action=create|update|delete|login. Pagination: ?page=1
// (default) and ?limit=50 (default, max 200).
router.get("/", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));

    const filter = {};
    if (typeof req.query.resource === "string" && req.query.resource) {
      filter.resource = req.query.resource;
    }
    if (typeof req.query.action === "string" && req.query.action) {
      filter.action = req.query.action;
    }
    if (typeof req.query.actor === "string" && req.query.actor) {
      const escaped = req.query.actor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.actorEmail = { $regex: escaped, $options: "i" };
    }

    const [total, entries] = await Promise.all([
      AdminAuditLog.countDocuments(filter),
      AdminAuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);
    res.json({ entries, page, limit, total, pages: Math.ceil(total / limit) || 1 });
  } catch (err) {
    console.error("GET admin audit log error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
