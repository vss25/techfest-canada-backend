import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { RIGHT_ERRORS } from "../services/appRights.js";
import { accessOf } from "../services/rightsStore.js";
import { signedInWithoutPassword, PASSWORD_REQUIRED, PASSWORD_REQUIRED_CODE } from "../services/signInMethod.js";

/* The admin panel and every staff-only API behind it (console, cms, people,
   promos, admin, campaigns, leads, …). Password tokens only: staff who signed
   in to an app with an emailed code (or a pass ID) get 403 PASSWORD_REQUIRED,
   with `code` so the panel can send them to its sign-in page. Tokens without
   a `via` claim (older tokens, password, Google) work as before. In-app staff
   features don't use this guard (requireCheckIn, social/community rights). */
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
    if (signedInWithoutPassword(decoded)) {
      return res.status(403).json({ error: PASSWORD_REQUIRED, code: PASSWORD_REQUIRED_CODE });
    }

    req.user = user;
    next();
  } catch (err) {
    console.error("ADMIN AUTH ERROR:", err);
    res.status(401).json({ error: "Unauthorized" });
  }
}
/* Door check-in (POST /api/checkin/scan): anyone whose types give them the
   checkIn right in the App rights matrix (volunteers and staff by default;
   staff accounts always, services/appRights.js). Everything else staff-only
   keeps requireAdmin, so volunteers never reach the admin panel. Any sign-in
   works here, the emailed code included (services/signInMethod.js). */
export async function requireCheckIn(req, res, next) {
  let user;
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "No token" });
    const decoded = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);
    user = await User.findById(decoded.id);
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!user || user.banned) return res.status(403).json({ error: RIGHT_ERRORS.checkIn });
  const { rights } = await accessOf(user);
  if (!rights.checkIn) return res.status(403).json({ error: RIGHT_ERRORS.checkIn });
  req.user = user;
  next();
}

/** Former name of requireCheckIn (staff or volunteers only, before app rights). */
export const requireTeam = requireCheckIn;

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
