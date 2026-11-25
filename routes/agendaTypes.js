import express from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { AdminAudit } from "../models/Admin.js";
import AdminSetting from "../models/AdminSetting.js";
import { SESSION_FORMATS } from "../services/cmsSchema.js";
import { KEY, DEFAULT_TYPES, cleanTypes, typesFrom, changeSummary } from "../services/agendaTypes.js";

/* =========================================================
   /api/console/agenda-types: the agenda's "Session type" dropdown, edited by staff (Nov 25 2026).
     GET  /                 → { types: [{ label, format }], formats, isDefault }
     PUT  /  { types }      → { types, isDefault: false }
     POST /reset            → { types (the defaults), isDefault: true }
   Any staff admin (management included) can edit; volunteers can't reach the console. Changing the list never
   changes a session: each session keeps the label it was saved with. Rules in services/agendaTypes.js.
========================================================= */

const router = express.Router();
router.use(requireAdmin);

const who = (req) => String(req.user?.name || req.user?.email || "Staff").slice(0, 120);
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error("AGENDA TYPES ERROR:", err?.message || err);
  res.status(500).json({ error: "Something went wrong. Try again." });
});
const audit = (req, detail) =>
  AdminAudit.create({ adminId: req.user._id, adminName: req.user.name, action: "agenda_types_update", targetType: "agenda_types",
                      targetId: KEY, detail: String(detail).slice(0, 500) }).catch(() => {});

router.get("/", wrap(async (req, res) => {
  const row = await AdminSetting.findOne({ key: KEY }).lean();
  res.json({ types: typesFrom(row?.value), formats: SESSION_FORMATS, isDefault: !row });
}));

router.put("/", wrap(async (req, res) => {
  const { value, error } = cleanTypes(req.body?.types);
  if (error) return res.status(400).json({ error });
  const row = await AdminSetting.findOne({ key: KEY }).lean();
  const before = typesFrom(row?.value);
  await AdminSetting.findOneAndUpdate(
    { key: KEY },
    { $set: { value, module: "agenda", valueType: "json", description: "The agenda's session type dropdown", updatedBy: who(req) } },
    { upsert: true, new: true },
  );
  audit(req, changeSummary(before, value));
  res.json({ types: value, formats: SESSION_FORMATS, isDefault: false });
}));

router.post("/reset", wrap(async (req, res) => {
  await AdminSetting.deleteOne({ key: KEY });
  audit(req, "Session types: back to the standard list");
  res.json({ types: DEFAULT_TYPES, formats: SESSION_FORMATS, isDefault: true });
}));

export default router;
