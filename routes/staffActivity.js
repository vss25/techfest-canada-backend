import express from "express";
import mongoose from "mongoose";
import User from "../models/User.js";
import StaffSession from "../models/StaffSession.js";
import StaffActivityHour from "../models/StaffActivityHour.js";
import { requireAdmin, isSuperAdmin } from "../middleware/adminAuth.js";
import {
  DEFAULT_TZ, rangeOf, recordActivitySafe, recordSignOut, summarize, validTz,
} from "../services/staffActivity.js";

/* Settings › Staff activity (Nov 24 2026). Rules and storage: services/staffActivity.js.
   POST /ping {kind: "view" | "beat"}  any staff (the panel: a page opened / still in use) → 204
   POST /signout                       any staff (the panel's Sign out, before it drops the token) → 204
   GET  /?from=&to=&tz=&userId=        the super admin only (isSuperAdmin), everyone else 403 super_admin_only */
const router = express.Router();

const superAdminOnly = (req, res, next) =>
  isSuperAdmin(req.user) ? next() : res.status(403).json({ error: "Only the super admin can see staff activity.", code: "super_admin_only" });

router.post("/ping", requireAdmin, (req, res) => {
  const kind = req.body?.kind === "view" ? "view" : req.body?.kind === "beat" ? "beat" : null;
  if (!kind) return res.status(400).json({ error: "kind must be view or beat" });
  recordActivitySafe(req.user._id, kind);
  res.status(204).end();
});

router.post("/signout", requireAdmin, async (req, res) => {
  try { await recordSignOut(req.user._id); } catch (err) { console.error("staff activity signout failed:", err?.message || err); }
  res.status(204).end();
});

router.get("/", requireAdmin, superAdminOnly, async (req, res) => {
  try {
    const tz = validTz(req.query.tz) ? req.query.tz : DEFAULT_TZ;
    const range = rangeOf({ from: req.query.from, to: req.query.to, tz });
    if (range.error) return res.status(400).json({ error: range.error });
    const userFilter = { role: "admin" };
    if (req.query.userId) {
      if (!mongoose.isValidObjectId(req.query.userId)) return res.status(400).json({ error: "Bad userId" });
      userFilter._id = req.query.userId;
    }
    const users = await User.find(userFilter).select("name email").lean();
    const ids = users.map((u) => u._id);
    const [sessions, hours] = await Promise.all([
      StaffSession.find({ userId: { $in: ids }, startedAt: { $gte: range.start, $lte: range.end } }).lean(),
      StaffActivityHour.find({ userId: { $in: ids }, hour: { $gte: range.start, $lte: range.end } }).lean(),
    ]);
    const staff = summarize({ users, sessions, hours, tz, from: range.from, to: range.to });
    res.json({ tz, from: range.from, to: range.to, idleMinutes: 15, staff });
  } catch (err) {
    console.error("GET staff activity error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
