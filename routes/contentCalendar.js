import express from "express";
import mongoose from "mongoose";
import CalendarItem from "../models/CalendarItem.js";
import { AdminAudit } from "../models/Admin.js";
import { requireAdmin, isManagement } from "../middleware/adminAuth.js";
import { torontoDay } from "../services/commitments.js";
import { CHANNELS, cleanItem, itemDTO, planVsActual, rowsToItems } from "../services/contentCalendar.js";

/* =========================================================
   Marketing › Social media calendar: content calendar items (Nov 20 2026).
   Mounted at /api/console/content-calendar before the console router; any staff.

     GET  /?from=YYYY-MM-DD&to=YYYY-MM-DD → { items, kpis: { planned, done, late, missed, ahead }, channels, today }
     POST / { title, date, channel?, by?, ownerName?, notes?, eventKey? } → 201 { item }
     POST /import { rows: [[header…], […], …], dryRun? } → { added, skipped: [{ row, why }], batch, preview? }
          rows = the sheet as the panel read it (first row = headers); dryRun only reports what it would add
     PATCH /:id  any field, incl. { doneDate, doneUrl } ("mark as done"; doneDate "" = not done) → { item }
     DELETE /:id → { ok }
     DELETE /batch/:batch → { removed }   (undo an upload: whoever uploaded it, or management)
   Audited (calendar_*; titles only).
========================================================= */

const router = express.Router();
export default router;
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error("CONTENT CALENDAR ERROR:", err?.message || err);
  if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Try again." });
});
const who = (req) => String(req.user?.name || req.user?.email || "Staff").slice(0, 120);
const audit = (req, action, id, detail) => AdminAudit.create({ adminId: req.user._id, adminName: req.user.name, action, targetType: "calendar",
  targetId: String(id).slice(0, 120), detail: String(detail).slice(0, 500) }).catch(() => {});
const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ""));

router.use(requireAdmin);

router.get("/", wrap(async (req, res) => {
  const today = torontoDay();
  const q = {};
  if (isDay(req.query.from) && isDay(req.query.to)) q.date = { $gte: req.query.from, $lte: req.query.to };
  const rows = await CalendarItem.find(q).sort({ date: 1, createdAt: 1 }).limit(2000).lean();
  res.json({ items: rows.map((r) => itemDTO(r, today)), kpis: planVsActual(rows, today), channels: CHANNELS, today });
}));

router.post("/", wrap(async (req, res) => {
  const { set, error } = cleanItem(req.body || {}, { creating: true });
  if (error) return res.status(400).json({ error });
  const it = await CalendarItem.create({ ...set, source: "manual", createdByName: who(req) });
  audit(req, "calendar_add", it._id, `${it.date}: ${it.title}`);
  res.status(201).json({ item: itemDTO(it.toObject(), torontoDay()) });
}));

router.post("/import", wrap(async (req, res) => {
  const out = rowsToItems(req.body?.rows, { year: Number(torontoDay().slice(0, 4)) });
  if (out.error) return res.status(400).json({ error: out.error });
  if (req.body?.dryRun) return res.json({ added: out.items.length, skipped: out.skipped, preview: out.items.slice(0, 8) });
  if (!out.items.length) return res.status(400).json({ error: "No rows could be added.", skipped: out.skipped });
  const batch = new mongoose.Types.ObjectId().toString();
  await CalendarItem.insertMany(out.items.map((i) => ({ ...i, doneByName: i.doneDate ? who(req) : "", source: "upload", batch, createdByName: who(req) })));
  audit(req, "calendar_import", batch, `${out.items.length} items from a spreadsheet, ${out.skipped.length} rows skipped`);
  res.json({ added: out.items.length, skipped: out.skipped, batch });
}));

router.delete("/batch/:batch", wrap(async (req, res) => {
  const batch = String(req.params.batch || "");
  if (!mongoose.isValidObjectId(batch)) return res.status(404).json({ error: "Not found" });
  const one = await CalendarItem.findOne({ batch }).lean();
  if (!one) return res.status(404).json({ error: "Not found" });
  if (one.createdByName !== who(req) && !isManagement(req.user)) return res.status(403).json({ error: "Only the person who uploaded it, or a manager, can undo an upload." });
  const r = await CalendarItem.deleteMany({ batch });
  audit(req, "calendar_import_undo", batch, `${r.deletedCount} items removed`);
  res.json({ removed: r.deletedCount });
}));

router.patch("/:id", wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const it = await CalendarItem.findById(req.params.id);
  if (!it) return res.status(404).json({ error: "Not found" });
  const { set, error } = cleanItem(req.body || {});
  if (error) return res.status(400).json({ error });
  if ("doneDate" in set) set.doneByName = set.doneDate ? who(req) : "";
  if (set.doneDate === "") set.doneUrl = set.doneUrl || "";
  Object.assign(it, set);
  await it.save();
  audit(req, "doneDate" in set ? (set.doneDate ? "calendar_done" : "calendar_not_done") : "calendar_edit", it._id, `${it.date}: ${it.title}`);
  res.json({ item: itemDTO(it.toObject(), torontoDay()) });
}));

router.delete("/:id", wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const it = await CalendarItem.findByIdAndDelete(req.params.id).lean();
  if (!it) return res.status(404).json({ error: "Not found" });
  audit(req, "calendar_delete", it._id, `${it.date}: ${it.title}`);
  res.json({ ok: true });
}));
