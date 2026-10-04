import express from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { avatarPath, cleanImageData } from "../services/socialHelpers.js";

/* =========================================================
   ATTENDEE PROFILE — GET / PATCH /api/profile
   =========================================================
   The website's onboarding survey (OnboardingSurvey.jsx) and the iOS app
   both PATCH { linkedinUrl, fieldOfWork } here. Until now the route didn't
   exist, so the website's call silently failed. Only the listed fields can
   be changed; name/email/password stay on /api/auth routes.
========================================================= */

const router = express.Router();

const EDITABLE = ["linkedinUrl", "fieldOfWork", "jobTitle", "organization", "country", "topics", "directoryHidden", "appOnboarded"];
const MAX = { linkedinUrl: 300, fieldOfWork: 120, jobTitle: 120, organization: 160, country: 80 };

/** Pure: pick + sanitise the editable fields from a body. Exported for tests. */
export function sanitizeProfilePatch(body = {}) {
  const out = {};
  for (const key of EDITABLE) {
    if (body[key] === undefined) continue;
    if (key === "topics") {
      if (!Array.isArray(body.topics)) continue;
      out.topics = body.topics
        .filter((t) => typeof t === "string")
        .map((t) => t.trim().slice(0, 80))
        .filter(Boolean)
        .slice(0, 20);
      continue;
    }
    if (key === "directoryHidden" || key === "appOnboarded") { if (typeof body[key] === "boolean") out[key] = body[key]; continue; }
    if (typeof body[key] !== "string") continue;
    let v = body[key].trim().slice(0, MAX[key]);
    if (key === "linkedinUrl" && v && !/^https?:\/\//i.test(v)) v = `https://${v.replace(/^\/+/, "")}`;
    out[key] = v;
  }
  return out;
}

async function requireUser(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader) { res.status(401).json({ error: "Unauthorized" }); return null; }
  try {
    const decoded = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select("-password -resetPasswordToken -resetPasswordExpires");
    if (!user) { res.status(404).json({ error: "User not found" }); return null; }
    return user;
  } catch {
    res.status(401).json({ error: "Invalid token" });
    return null;
  }
}

router.get("/", async (req, res) => {
  const user = await requireUser(req, res);
  if (user) res.json({ ...user.toObject(), avatarUrl: avatarPath(user._id, user.avatarVersion) });
});

/* Profile photo, shown to everyone on every device. Send
   { avatarData: "data:image/jpeg;base64,…" } (≤150 KB) or "" to remove. */
router.put("/avatar", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const raw = req.body?.avatarData;
  if (raw === "" || raw === null) {
    await User.updateOne({ _id: user._id }, { $set: { avatarData: "", avatarVersion: 0 } });
    return res.json({ avatarUrl: "" });
  }
  const data = cleanImageData(raw, 150_000);
  if (!data) return res.status(400).json({ error: "Send a JPEG or PNG under 150 KB" });
  const avatarVersion = Date.now();
  await User.updateOne({ _id: user._id }, { $set: { avatarData: data, avatarVersion } });
  res.json({ avatarUrl: avatarPath(user._id, avatarVersion) });
});

router.patch("/", async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const patch = sanitizeProfilePatch(req.body);
    if (!Object.keys(patch).length) return res.status(400).json({ error: "No editable fields supplied" });
    Object.assign(user, patch);
    await user.save();
    res.json({ success: true, user });
  } catch (err) {
    console.error("PROFILE PATCH ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
