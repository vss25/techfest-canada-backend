import express from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { AdminAudit } from "../models/Admin.js";
import AdminSetting from "../models/AdminSetting.js";
import { KEY, cleanTags, tagsFrom, changeSummary } from "../services/agendaTags.js";

/* =========================================================
   /api/console/agenda-tags: the extra tech pillars and sectors staff add for the agenda (Nov 26 2026).
     GET  /                        → { pillars: [name], sectors: [name] }
     PUT  /  { pillars, sectors }  → the saved lists
   Any staff admin can edit; volunteers can't reach the console. Changing the lists never changes a session.
   Rules in services/agendaTags.js.
========================================================= */

const router = express.Router();
router.use(requireAdmin);

const who = (req) => String(req.user?.name || req.user?.email || "Staff").slice(0, 120);
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error("AGENDA TAGS ERROR:", err?.message || err);
  res.status(500).json({ error: "Something went wrong. Try again." });
});

router.get("/", wrap(async (req, res) => {
  const row = await AdminSetting.findOne({ key: KEY }).lean();
  res.json(tagsFrom(row?.value));
}));

router.put("/", wrap(async (req, res) => {
  const { value, error } = cleanTags(req.body);
  if (error) return res.status(400).json({ error });
  const row = await AdminSetting.findOne({ key: KEY }).lean();
  const before = tagsFrom(row?.value);
  await AdminSetting.findOneAndUpdate(
    { key: KEY },
    { $set: { value, module: "agenda", valueType: "json", description: "Extra tech pillars and sectors for the agenda", updatedBy: who(req) } },
    { upsert: true, new: true },
  );
  AdminAudit.create({ adminId: req.user._id, adminName: req.user.name, action: "agenda_tags_update", targetType: "agenda_tags",
                      targetId: KEY, detail: changeSummary(before, value).slice(0, 500) }).catch(() => {});
  res.json(value);
}));

export default router;
