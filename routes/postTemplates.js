import express from "express";
import mongoose from "mongoose";
import { requireAdmin, isManagement } from "../middleware/adminAuth.js";
import { AdminAudit } from "../models/Admin.js";
import PostTemplate from "../models/PostTemplate.js";
import { BOXES, CHANNELS, KINDS, cleanTemplate, readyProblems, sizeOf } from "../services/postTemplateLibrary.js";

/* =========================================================
   /api/console/post-templates: Marketing › Post templates (Nov 23 2026). Any staff sees them (the Create from a
   template dialog uses the ready ones); management uploads, edits, marks ready and deletes.
     GET    /            → { templates: [..with problems], kinds, channels, boxes, sizes, canEdit }
     POST   /            { name, kind } → 201 { template }
     PATCH  /:id         { name?, status?, notes?, channels? } → { template }   (a channel's whole layout at a time)
     DELETE /:id         → { ok }
   Rules and validation in services/postTemplateLibrary.js.
========================================================= */

const router = express.Router();
router.use(requireAdmin);

const who = (req) => String(req.user?.name || req.user?.email || "Staff").slice(0, 120);
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error("POST TEMPLATES ERROR:", err?.message || err);
  res.status(500).json({ error: "Something went wrong. Try again." });
});
const audit = (req, action, id, detail) =>
  AdminAudit.create({ adminId: req.user._id, adminName: req.user.name, action, targetType: "post_template",
                      targetId: String(id).slice(0, 120), detail: String(detail).slice(0, 500) }).catch(() => {});
const managementOnly = (req, res, next) =>
  isManagement(req.user) ? next() : res.status(403).json({ error: "Management only", code: "management_only" });
const view = (t) => ({ ...t, id: String(t._id), problems: readyProblems(t) });

router.get("/", wrap(async (req, res) => {
  const rows = await PostTemplate.find({}).sort({ kind: 1, updatedAt: -1 }).limit(200).lean();
  res.json({ templates: rows.map(view), kinds: KINDS, channels: CHANNELS, boxes: BOXES,
             sizes: Object.fromEntries(KINDS.map((k) => [k, Object.fromEntries(CHANNELS.map((c) => [c, sizeOf(k, c)]))])),
             canEdit: isManagement(req.user) });
}));

router.post("/", managementOnly, wrap(async (req, res) => {
  const { value, error } = cleanTemplate({ name: req.body?.name, kind: req.body?.kind, status: "draft" });
  if (error) return res.status(400).json({ error });
  const t = await PostTemplate.create({ ...value, createdBy: who(req), updatedBy: who(req) });
  audit(req, "post_template_create", t._id, `${value.kind}: ${value.name}`);
  res.status(201).json({ template: view(t.toObject()) });
}));

const load = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) { res.status(404).json({ error: "Not found" }); return null; }
  const t = await PostTemplate.findById(req.params.id).lean();
  if (!t) res.status(404).json({ error: "Not found" });
  return t;
};

router.patch("/:id", managementOnly, wrap(async (req, res) => {
  const t = await load(req, res); if (!t) return;
  const body = { ...req.body };
  delete body.kind;                              // a template keeps its kind: its boxes depend on it
  const { value, error } = cleanTemplate(body, t);
  if (error) return res.status(400).json({ error });
  const saved = await PostTemplate.findByIdAndUpdate(t._id, { ...value, updatedBy: who(req) }, { new: true }).lean();
  if (value.status !== t.status) audit(req, `post_template_${value.status}`, t._id, value.name);
  res.json({ template: view(saved) });
}));

router.delete("/:id", managementOnly, wrap(async (req, res) => {
  const t = await load(req, res); if (!t) return;
  await PostTemplate.deleteOne({ _id: t._id });
  audit(req, "post_template_delete", t._id, t.name);
  res.json({ ok: true });
}));

export default router;
