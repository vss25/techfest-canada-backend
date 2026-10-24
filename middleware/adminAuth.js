import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { RIGHT_ERRORS } from "../services/appRights.js";
import { accessOf } from "../services/rightsStore.js";
import { passwordSignIn, signedInWithoutPassword, PASSWORD_REQUIRED, PASSWORD_REQUIRED_CODE } from "../services/signInMethod.js";

/* The answer every staff-only API gives a volunteer account (the volunteer panel, Oct 23 2026: volunteers are
   students helping at the event; they may look people up and nothing else). `code` lets the panel tell it apart. */
export const VOLUNTEER_FORBIDDEN = "Volunteer accounts can only look up people.";
export const VOLUNTEER_FORBIDDEN_CODE = "volunteer_forbidden";
export const refuseVolunteer = (res) => res.status(403).json({ error: VOLUNTEER_FORBIDDEN, code: VOLUNTEER_FORBIDDEN_CODE });

/* The admin panel and every staff-only API behind it (console, cms, people,
   promos, admin, campaigns, leads, …). Password tokens only: staff who signed
   in to an app with an emailed code (or a pass ID) get 403 PASSWORD_REQUIRED,
   with `code` so the panel can send them to its sign-in page. Tokens without
   a `via` claim (older tokens, password) and Google / LinkedIn tokens work as
   before. In-app staff features don't use this guard (requireCheckIn,
   social/community rights).
   A volunteer account (role "volunteer") gets 403 VOLUNTEER_FORBIDDEN here,
   however they signed in: the few routes of the volunteer panel use
   requirePanel instead (below). */
export async function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "No token" });

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(decoded.id);
    if (user?.role === "volunteer") return refuseVolunteer(res);
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

/* The volunteer panel's routes only (Oct 23 2026): GET /api/console/me, the People list and one person's profile
   (routes/people.js, in the volunteer's safe form) and the search box (People only, routes/console.js). Staff
   (role "admin") pass exactly as with requireAdmin; so do volunteer accounts (role "volunteer", never the
   volunteer person type on an attendee's account) signed in with their PASSWORD (services/signInMethod.js
   passwordSignIn: a token with no `via` claim, for an account that has a password; Google, LinkedIn, the emailed
   code and a pass ID → 403 password_required), not suspended. Sets
   req.panelRole: "staff" (management included: isManagement) or "volunteer". Every other staff-only route keeps
   requireAdmin, so a new route is closed to volunteers unless it's given this guard on purpose. */
export async function requirePanel(req, res, next) {
  let decoded;
  let user;
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "No token" });
    decoded = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);
    user = await User.findById(decoded.id);
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!user || (user.role !== "admin" && user.role !== "volunteer")) return res.status(403).json({ error: "Admin only" });
  if (signedInWithoutPassword(decoded) || (user.role === "volunteer" && !passwordSignIn(decoded, user))) {
    return res.status(403).json({ error: PASSWORD_REQUIRED, code: PASSWORD_REQUIRED_CODE });
  }
  if (user.role === "volunteer" && user.banned) return res.status(403).json({ error: "This account is suspended.", code: "suspended" });
  req.user = user;
  req.panelRole = user.role === "volunteer" ? "volunteer" : "staff";
  next();
}

/** After requirePanel: is this a volunteer (People look-up only)? */
export const isVolunteerPanel = (req) => req?.panelRole === "volunteer";

/* Door check-in (POST /api/checkin/scan): anyone whose types give them the
   checkIn right in the App rights matrix (volunteers and staff by default;
   staff accounts always, services/appRights.js). Everything else staff-only
   keeps requireAdmin (volunteers: requirePanel's People look-up only). Any sign-in
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
