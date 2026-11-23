import express from "express";
import mongoose from "mongoose";
import { requireAdmin, isManagement, isSuperAdmin } from "../middleware/adminAuth.js";
import { AdminAudit } from "../models/Admin.js";
import { MouItem, Mou } from "../models/Mou.js";
import { loadSettings } from "./contracts.js";
import { withIds, cleanParty } from "../services/contracts.js";
import {
  SIDES, ITEM_CATEGORIES, ITEM_FIELDS, PLACEHOLDERS, STARTER_ITEMS, MOU_CLAUSES, STATUSES, SCHEDULE_MODES, REPEAT_EVERY,
  cleanItem, lineFrom, lineText, cleanTerms, defaultTerms, cleanSigners, reviewChecks, mouNumber, mouDocument, exportName,
} from "../services/mou.js";
import { mouPdf, mouDocx } from "../services/mouExport.js";

/* =========================================================
   MOU drafts (Nov 23 2026). Rules in services/mou.js, files in services/mouExport.js.
     /api/console/mou-items   the MOU catalogue (what TTFC offers, what partners deliver): any staff
                              reads; the super admin adds, edits, retires (isSuperAdmin)
     /api/console/mous        any staff builds MOUs for the event in the top bar: tick items, set how
                              many / when / codes / wording, terms, who signs; draft → review →
                              exported; PDF and Word at any time (a draft prints DRAFT)
   TTFC's details and signing authorities come from Contract settings (routes/contracts.js).
   Private data: MongoDB only. Audited (AdminAudit, targetType mou-item / mou).
========================================================= */

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error("MOU ERROR:", err?.message || err);
  res.status(500).json({ error: "Something went wrong. Try again." });
});
const who = (req) => String(req.user?.name || req.user?.email || "Staff").slice(0, 120);
const audit = (req, action, targetType, targetId, detail) =>
  AdminAudit.create({ adminId: req.user._id, adminName: req.user.name, action, targetType,
                      targetId: String(targetId).slice(0, 120), detail: String(detail).slice(0, 500) }).catch(() => {});
const validId = (id) => mongoose.isValidObjectId(id);
const superOnly = (req, res, next) =>
  isSuperAdmin(req.user) ? next() : res.status(403).json({ error: "Only the super admin can change the MOU catalogue.", code: "super_admin_only" });

const SEQ_KEY = "mou-seq";
const counters = () => mongoose.connection.collection("counters");
const itemView = (o) => ({ ...o, id: String(o._id) });

/* ---------------- Catalogue ---------------- */

export const mouItemsRouter = express.Router();
mouItemsRouter.use(requireAdmin);

mouItemsRouter.get("/", wrap(async (req, res) => {
  const items = await MouItem.find({}).sort({ side: -1, category: 1, sort: 1, name: 1 }).lean();
  const settings = await loadSettings();
  res.json({
    items: items.map(itemView), sides: SIDES, categories: ITEM_CATEGORIES, fields: ITEM_FIELDS, placeholders: PLACEHOLDERS,
    clauses: MOU_CLAUSES, scheduleModes: SCHEDULE_MODES, repeatEvery: REPEAT_EVERY, defaultTerms: defaultTerms(),
    signatories: withIds(settings.signatories).filter((s) => s.name).map(({ id, name, title }) => ({ id, name, title })),
    company: settings.company, canEdit: isSuperAdmin(req.user), starterCount: STARTER_ITEMS.length,
  });
}));

mouItemsRouter.post("/starter", superOnly, wrap(async (req, res) => {
  const have = new Set((await MouItem.find({}, { side: 1, name: 1 }).lean()).map((o) => `${o.side}|${o.name.toLowerCase()}`));
  const add = STARTER_ITEMS.filter((s) => !have.has(`${s.side}|${s.name.toLowerCase()}`))
    .map((s, i) => ({ ...cleanItem(s).value, sort: i, createdBy: who(req), updatedBy: who(req) }));
  if (add.length) await MouItem.insertMany(add);
  audit(req, "mou_item_starter", "mou-item", "starter", `${add.length} starter items added`);
  res.status(201).json({ added: add.length });
}));

mouItemsRouter.post("/", superOnly, wrap(async (req, res) => {
  const { value, error } = cleanItem(req.body);
  if (error) return res.status(400).json({ error });
  const o = await MouItem.create({ ...value, createdBy: who(req), updatedBy: who(req) });
  audit(req, "mou_item_create", "mou-item", o._id, `${o.side}: ${o.name}`);
  res.status(201).json({ item: itemView(o.toObject()) });
}));

mouItemsRouter.patch("/:id", superOnly, wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const current = await MouItem.findById(req.params.id).lean();
  if (!current) return res.status(404).json({ error: "Not found" });
  const { value, error } = cleanItem({ ...current, ...req.body, side: current.side });
  if (error) return res.status(400).json({ error });
  const o = await MouItem.findByIdAndUpdate(current._id, { ...value, updatedBy: who(req) }, { new: true }).lean();
  audit(req, "mou_item_edit", "mou-item", o._id, `${o.name}${current.active !== o.active ? (o.active ? " (brought back)" : " (retired)") : ""}`);
  res.json({ item: itemView(o) });
}));

mouItemsRouter.delete("/:id", superOnly, wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const id = String(req.params.id);
  if (await Mou.exists({ "lines.itemId": id })) {
    return res.status(409).json({ error: "It's on an MOU, so it can't be deleted. Retire it instead: it stays on old MOUs and leaves new ones.", code: "in_use" });
  }
  const o = await MouItem.findByIdAndDelete(id).lean();
  if (!o) return res.status(404).json({ error: "Not found" });
  audit(req, "mou_item_delete", "mou-item", id, o.name);
  res.json({ ok: true });
}));

/* ---------------- MOUs ---------------- */

export const mousRouter = express.Router();
mousRouter.use(requireAdmin);

/** TTFC's side as it prints: frozen at export, else the current Contract settings. */
function issuerFor(m, settings) {
  if (m.frozen) return m.frozen;
  const all = withIds(settings.signatories).filter((s) => s.name);
  return { company: settings.company, signatories: all.filter((s) => (m.ttfcSignatoryIds || []).includes(s.id)) };
}

async function view(m, req, settings = null) {
  settings = settings || await loadSettings();
  const signatories = withIds(settings.signatories);
  const checks = reviewChecks(m, { signatories });
  const ctx = { partner: m.partner?.name, event: m.eventName || m.eventKey };
  const mine = String(m.createdById || "") === String(req.user._id);
  const blocked = checks.some((c) => c.level === "block");
  // The document exactly as it exports (signature images left out of the answer).
  const doc = mouDocument(m, issuerFor(m, settings), { final: m.status === "exported" });
  doc.signers = doc.signers.map(({ signature, ...rest }) => ({ ...rest, signed: !!signature }));
  return {
    ...m, id: String(m._id),
    frozen: m.frozen ? { ...m.frozen, signatories: (m.frozen.signatories || []).map(({ signature, ...rest }) => rest) } : null,
    lines: (m.lines || []).map((l) => ({ ...l, text: lineText(l, ctx) })),
    checks, document: doc,
    can: {
      edit: m.status === "draft",
      review: m.status === "draft" && !blocked,
      backToDraft: m.status !== "draft",
      export: m.status !== "draft" && !blocked,
      remove: m.status === "draft" && (mine || isManagement(req.user)),
    },
  };
}

const summary = (m) => ({
  id: String(m._id), number: m.number, eventKey: m.eventKey, eventName: m.eventName, partner: m.partner?.name || "",
  contact: m.contact?.name || "", status: m.status,
  offers: (m.lines || []).filter((l) => l.side === "ttfc").length, delivers: (m.lines || []).filter((l) => l.side === "partner").length,
  binding: !!m.terms?.binding, financial: !!m.terms?.financial, amount: m.terms?.amount ?? null,
  createdBy: m.createdBy, updatedAt: m.updatedAt, exportedAt: m.exportedAt,
});

mousRouter.get("/", wrap(async (req, res) => {
  const q = {};
  if (req.query.eventKey) q.eventKey = String(req.query.eventKey);
  const rows = (await Mou.find(q).sort({ updatedAt: -1 }).limit(500).lean()).map(summary);
  const counts = Object.fromEntries(STATUSES.map((s) => [s.key, rows.filter((m) => m.status === s.key).length]));
  res.json({ mous: rows, counts, statuses: STATUSES });
}));

async function load(req, res) {
  if (!validId(req.params.id)) { res.status(404).json({ error: "Not found" }); return null; }
  const m = await Mou.findById(req.params.id).lean();
  if (!m) { res.status(404).json({ error: "Not found" }); return null; }
  return m;
}

mousRouter.get("/:id", wrap(async (req, res) => {
  const m = await load(req, res); if (!m) return;
  res.json({ mou: await view(m, req) });
}));

/** The panel's fields → what to save, or { error }. `known` = lines already on the MOU (they keep their snapshot). */
async function fieldsFrom(body, { settings, known = [] }) {
  const p = cleanParty({ company: body.partner, contact: body.contact });
  if (p.error) return p;
  const items = new Map((await MouItem.find({}).lean()).map((o) => [String(o._id), o]));
  const kept = new Map(known.map((l) => [l.itemId, l]));
  const lines = [];
  for (const input of Array.isArray(body.lines) ? body.lines.slice(0, 60) : []) {
    const id = String(input?.itemId || "");
    const snap = kept.get(id);
    const item = snap ? { ...snap, wording: snap.baseWording } : items.get(id);
    if (!item) return { error: "One of the items is no longer in the catalogue." };
    if (!snap && item.active === false) return { error: `${item.name} has been retired.` };
    const { value, error } = lineFrom(input, item);
    if (error) return { error };
    lines.push(value);
  }
  const ids = new Set(withIds(settings.signatories).filter((s) => s.name).map((s) => s.id));
  return { value: {
    partner: p.value.company, contact: p.value.contact, lines,
    terms: cleanTerms(body.terms || {}),
    ttfcSignatoryIds: [...new Set((Array.isArray(body.ttfcSignatoryIds) ? body.ttfcSignatoryIds : []).map(String))].filter((id) => ids.has(id)),
    partnerSigners: cleanSigners(body.partnerSigners),
    notes: String(body.notes ?? "").replace(/\r\n/g, "\n").trim().slice(0, 2000),
  } };
}

async function nextNumber(eventYear, eventName = "") {
  const year = /^20\d\d$/.test(String(eventYear || "")) ? String(eventYear)
    : (/20\d\d/.exec(eventName) || [String(new Date().getFullYear())])[0];
  const r = await counters().findOneAndUpdate({ _id: SEQ_KEY }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" });
  return mouNumber(year, (r?.value ?? r)?.seq || 1);
}

mousRouter.post("/", wrap(async (req, res) => {
  const eventKey = String(req.body?.eventKey || "").trim().slice(0, 80);
  if (!eventKey) return res.status(400).json({ error: "Choose the event in the top bar first." });
  const settings = await loadSettings();
  const { value, error } = await fieldsFrom(req.body, { settings });
  if (error) return res.status(400).json({ error });
  const eventName = String(req.body?.eventName || "").slice(0, 160);
  const m = await Mou.create({
    ...value, eventKey, eventName, number: await nextNumber(req.body?.eventYear, eventName),
    createdBy: who(req), createdById: String(req.user._id), updatedBy: who(req),
  });
  audit(req, "mou_create", "mou", m._id, `${m.number} · ${m.partner?.name || ""}`);
  res.status(201).json({ mou: await view(m.toObject(), req, settings) });
}));

mousRouter.patch("/:id", wrap(async (req, res) => {
  const m = await load(req, res); if (!m) return;
  if (m.status !== "draft") return res.status(409).json({ error: "Only a draft can be changed. Move it back to draft first.", code: "not_draft" });
  const settings = await loadSettings();
  const { value, error } = await fieldsFrom(req.body, { settings, known: m.lines || [] });
  if (error) return res.status(400).json({ error });
  const saved = await Mou.findByIdAndUpdate(m._id, { ...value, updatedBy: who(req) }, { new: true }).lean();
  audit(req, "mou_edit", "mou", m._id, `${m.number} · ${saved.partner?.name || ""}`);
  res.json({ mou: await view(saved, req, settings) });
}));

mousRouter.post("/:id/status", wrap(async (req, res) => {
  const m = await load(req, res); if (!m) return;
  const to = String(req.body?.status || "");
  const settings = await loadSettings();
  const v = await view(m, req, settings);
  const set = { updatedBy: who(req) };
  if (to === "review") {
    if (!v.can.review) return res.status(409).json({ error: m.status !== "draft" ? "Only a draft goes to review." : v.checks.find((c) => c.level === "block").text, code: "cant_review", checks: v.checks });
    Object.assign(set, { status: "review", reviewAt: new Date(), reviewBy: who(req) });
  } else if (to === "draft") {
    if (m.status === "draft") return res.status(409).json({ error: "It's already a draft." });
    Object.assign(set, { status: "draft", frozen: null });
  } else return res.status(400).json({ error: "Unknown status." });
  const saved = await Mou.findByIdAndUpdate(m._id, set, { new: true }).lean();
  audit(req, `mou_${to}`, "mou", m._id, `${m.number}: ${m.status} → ${to}`);
  res.json({ mou: await view(saved, req, settings) });
}));

/** Export: from review, freezes TTFC's details and signatories and marks it exported (again later = same freeze). */
mousRouter.post("/:id/export", wrap(async (req, res) => {
  const m = await load(req, res); if (!m) return;
  const settings = await loadSettings();
  const v = await view(m, req, settings);
  if (!v.can.export) return res.status(409).json({ error: m.status === "draft" ? "Send it to review first." : "Fix what the review list says first.", code: "cant_export" });
  const saved = await Mou.findByIdAndUpdate(m._id, {
    status: "exported", frozen: m.frozen || issuerFor(m, settings), exportedAt: m.exportedAt || new Date(),
    exportedBy: m.exportedBy || who(req), $inc: { exports: 1 }, updatedBy: who(req),
  }, { new: true }).lean();
  if (m.status !== "exported") audit(req, "mou_export", "mou", m._id, `${m.number} · ${m.partner?.name || ""}: exported`);
  res.json({ mou: await view(saved, req, settings) });
}));

/** The file: ?format=pdf (default) | docx. Any status; drafts and reviews print DRAFT, only exported ones carry signatures. */
mousRouter.get("/:id/file", wrap(async (req, res) => {
  const m = await load(req, res); if (!m) return;
  const format = req.query.format === "docx" ? "docx" : "pdf";
  const final = m.status === "exported";
  const d = mouDocument(m, issuerFor(m, await loadSettings()), { final });
  const buf = format === "docx" ? mouDocx(d) : await mouPdf(d);
  res.set({
    "Content-Type": format === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/pdf",
    "Content-Disposition": `attachment; filename="${exportName(m, format)}"`, "Cache-Control": "private, no-store",
  });
  res.send(buf);
}));

mousRouter.delete("/:id", wrap(async (req, res) => {
  const m = await load(req, res); if (!m) return;
  const v = await view(m, req);
  if (!v.can.remove) return res.status(409).json({ error: "Only a draft can be deleted, by whoever made it or by management.", code: "cant_delete" });
  await Mou.deleteOne({ _id: m._id });
  audit(req, "mou_delete", "mou", m._id, `${m.number} · ${m.partner?.name || ""}`);
  res.json({ ok: true });
}));
