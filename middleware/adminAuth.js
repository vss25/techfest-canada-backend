import jwt from "jsonwebtoken";
import User from "../models/User.js";

export async function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "No token" });

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(decoded.id);
    if (!user || user.role !== "admin") {
      return res.status(403).json({ error: "Admin only" });
    }

    req.user = user;
    next();
  } catch (err) {
    console.error("ADMIN AUTH ERROR:", err);
    res.status(401).json({ error: "Unauthorized" });
  }
}
/* Staff the owner said aren't management. They stay staff until management
   explicitly switches them to management in Staff accounts. */
const DEFAULT_STAFF_EMAILS = ["nicole@thetechfestival.com", "nicole@thetechfestival..com"];

/** Management (vs. regular staff): sees sales, revenue and pricing, manages staff. */
export function isManagement(user) {
  if (user?.role !== "admin") return false;
  if (user.staffRole === "management") return true;
  if (user.staffRole === "staff") return false;
  return !DEFAULT_STAFF_EMAILS.includes(String(user.email || "").toLowerCase());
}

/** Use after requireAdmin: blocks staff who aren't management from money and staff settings. */
export function requireManagement(req, res, next) {
  if (!isManagement(req.user)) return res.status(403).json({ error: "Management only" });
  next();
}

/** requireAdmin + requireManagement in one, for routers that don't load the user themselves. */
export function requireManagementAdmin(req, res, next) {
  requireAdmin(req, res, () => requireManagement(req, res, next));
}
