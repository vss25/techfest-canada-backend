import express from "express";
import mongoose from "mongoose";
import { requireAdmin, isManagement, isSuperAdmin } from "../middleware/adminAuth.js";
import { AdminAudit } from "../models/Admin.js";
import AdminSetting from "../models/AdminSetting.js";
import { Offering, Contract, ContractFile } from "../models/Contract.js";
import {
  CATEGORIES, TRACK, STATUSES, TAX_RATES, SETTING_DEFAULTS, frozenFrom, withIds, cleanOffering, cleanParty, cleanSettings, lineFrom,
  offeredFor, totals, overDiscount, pricingKey, deliverablesFor, unitsTaken, overLimits, contractNumber,
} from "../services/contracts.js";
import { contractPdf } from "../services/contractPdf.js";

/* =========================================================
   Sales contracts and the offerings catalogue (Nov 18 2026). Rules in services/contracts.js.
     /api/console/offerings   the catalogue: any staff reads; the super admin creates, edits, retires
                              (isSuperAdmin: management, and in SUPER_ADMIN_EMAILS when that is set)
     /api/console/contracts   any staff builds and sends contracts; a price further below the catalogue
                              than the settings allow waits for management's approval; signing turns
                              each promised item into a task
   Private data: MongoDB only. Audited (AdminAudit, targetType offering / contract).
========================================================= */

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error("CONTRACTS ERROR:", err?.message || err);
  res.status(500).json({ error: "Something went wrong. Try again." });
});
const who = (req) => String(req.user?.name || req.user?.email || "Staff").slice(0, 120);
const audit = (req, action, targetType, targetId, detail) =>
  AdminAudit.create({ adminId: req.user._id, adminName: req.user.name, action, targetType,
                      targetId: String(targetId).slice(0, 120), detail: String(detail).slice(0, 500) }).catch(() => {});
const validId = (id) => mongoose.isValidObjectId(id);
const superOnly = (req, res, next) =>
  isSuperAdmin(req.user) ? next() : res.status(403).json({ error: "Only the super admin can change the catalogue.", code: "super_admin_only" });
const managementOnly = (req, res, next) =>
  isManagement(req.user) ? next() : res.status(403).json({ error: "Management only", code: "management_only" });

const SETTINGS_KEY = "contracts.settings";
const SEQ_KEY = "contract-seq"; // one running number across years; the year in a number comes from the event
const counters = () => mongoose.connection.collection("counters");
async function lastNumber() { return (await counters().findOne({ _id: SEQ_KEY }))?.seq || 0; }
async function loadSettings() {
  const row = await AdminSetting.findOne({ key: SETTINGS_KEY }).lean();
  const v = row?.value || {};
  const D = SETTING_DEFAULTS;
  return { ...D, ...v, company: { ...D.company, ...(v.company || {}) }, numbering: { ...D.numbering, ...(v.numbering || {}) },
           document: { ...D.document, ...(v.document || {}) }, signatories: withIds(v.signatories || D.signatories), clauses: v.clauses || D.clauses };
}

async function catalogue() {
  const all = await Offering.find({}).sort({ kind: 1, category: 1, sort: 1, name: 1 }).lean();
  const byId = new Map(all.map((o) => [String(o._id), o]));
  return { all, byId: (id) => byId.get(String(id)) || null };
}

/** Units of each offering on OTHER sent / signed contracts for this event. */
async function usedFor(eventKey, exceptId = null) {
  const q = { eventKey, status: { $in: ["sent", "signed"] } };
  if (exceptId) q._id = { $ne: exceptId };
  const rows = await Contract.find(q, { lines: 1 }).lean();
  const used = new Map();
  for (const c of rows) for (const [id, n] of unitsTaken(c.lines)) used.set(id, (used.get(id) || 0) + n);
  return used;
}

/* ---------------- Offerings ---------------- */

export const offeringsRouter = express.Router();
offeringsRouter.use(requireAdmin);

offeringsRouter.get("/", wrap(async (req, res) => {
  const { all } = await catalogue();
  const eventKey = String(req.query.eventKey || "");
  const used = eventKey ? await usedFor(eventKey) : new Map();
  const offerings = all.map((o) => ({
    ...o, id: String(o._id),
    left: eventKey && o.limit ? Math.max(0, o.limit - (used.get(String(o._id)) || 0)) : null,
  }));
  res.json({ offerings, categories: CATEGORIES, track: TRACK, taxRates: TAX_RATES, canEdit: isSuperAdmin(req.user),
             settings: { ...(await loadSettings()), nextNumber: (await lastNumber()) + 1 } });
}));

offeringsRouter.post("/", superOnly, wrap(async (req, res) => {
  const { byId } = await catalogue();
  const { value, error } = cleanOffering(req.body, { packageOf: byId });
  if (error) return res.status(400).json({ error });
  const o = await Offering.create({ ...value, createdBy: who(req), updatedBy: who(req) });
  audit(req, "offering_create", "offering", o._id, `${o.kind}: ${o.name}`);
  res.status(201).json({ offering: { ...o.toObject(), id: String(o._id) } });
}));

offeringsRouter.patch("/:id", superOnly, wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const current = await Offering.findById(req.params.id).lean();
  if (!current) return res.status(404).json({ error: "Not found" });
  const { byId } = await catalogue();
  const { value, error } = cleanOffering({ ...current, price: current.price / 100, ...req.body, kind: current.kind }, { packageOf: byId });
  if (error) return res.status(400).json({ error });
  if (current.kind === "package" && value.items.some((it) => it.offeringId === String(current._id))) {
    return res.status(400).json({ error: "A package can't contain itself." });
  }
  const o = await Offering.findByIdAndUpdate(req.params.id, { ...value, updatedBy: who(req) }, { new: true }).lean();
  audit(req, "offering_edit", "offering", o._id, `${o.name}${current.active !== o.active ? (o.active ? " (brought back)" : " (retired)") : ""}`);
  res.json({ offering: { ...o, id: String(o._id) } });
}));

offeringsRouter.delete("/:id", superOnly, wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const id = String(req.params.id);
  const [onContract, inPackage] = await Promise.all([
    Contract.exists({ $or: [{ "lines.offeringId": id }, { "lines.items.offeringId": id }] }),
    Offering.exists({ "items.offeringId": id }),
  ]);
  if (onContract || inPackage) {
    return res.status(409).json({ error: `It's on ${onContract ? "a contract" : "a package"}, so it can't be deleted. Retire it instead: it stays on old contracts and leaves new ones.`, code: "in_use" });
  }
  const o = await Offering.findByIdAndDelete(id).lean();
  if (!o) return res.status(404).json({ error: "Not found" });
  audit(req, "offering_delete", "offering", id, o.name);
  res.json({ ok: true });
}));

offeringsRouter.put("/settings", superOnly, wrap(async (req, res) => {
  const { value, error } = cleanSettings(req.body);
  if (error) return res.status(400).json({ error });
  const next = req.body?.nextNumber;
  if (next !== undefined && next !== null && next !== "") {
    const n = Number(next), last = await lastNumber();
    if (!Number.isInteger(n) || n < 1 || n > 999999) return res.status(400).json({ error: "The next contract number is a whole number." });
    if (n <= last) return res.status(400).json({ error: `Numbers up to ${last} are already used. Pick ${last + 1} or more.` });
    await counters().updateOne({ _id: SEQ_KEY }, { $set: { seq: n - 1 } }, { upsert: true });
  }
  await AdminSetting.findOneAndUpdate({ key: SETTINGS_KEY },
    { key: SETTINGS_KEY, module: "contracts", value, valueType: "json", updatedBy: who(req) }, { upsert: true });
  audit(req, "contract_settings", "contract", SETTINGS_KEY, `discount limit ${value.maxDiscountPct}%, tax ${value.taxRate}%`);
  res.json({ settings: { ...value, nextNumber: (await lastNumber()) + 1 } });
}));

/* ---------------- Contracts ---------------- */

export const contractsRouter = express.Router();
contractsRouter.use(requireAdmin);

/** Everything the panel shows for one contract. */
async function view(c, req, settings = null) {
  settings = settings || await loadSettings();
  const { byId } = await catalogue();
  const t = totals(c.lines, c.taxRate);
  const over = overDiscount(c.lines, settings.maxDiscountPct);
  const approvedPrices = !over.length || c.approval?.key === pricingKey(c.lines, c.taxRate);
  const limits = c.status === "signed" || c.status === "cancelled" ? []
    : overLimits(c.lines, byId, await usedFor(c.eventKey, c._id));
  const mine = String(c.createdById || "") === String(req.user._id);
  return {
    ...c, id: String(c._id), totals: t, overDiscount: over, approvedPrices, overLimits: limits,
    hasSignedCopy: !!c.signedCopy?.size,
    can: {
      edit: c.status === "draft",
      approve: isManagement(req.user) && !approvedPrices,
      send: c.status === "draft" && approvedPrices && !limits.length && c.lines.length > 0,
      sign: (c.status === "sent" || c.status === "draft") && approvedPrices && !limits.length && c.lines.length > 0,
      cancel: isManagement(req.user) && c.status !== "cancelled",
      remove: c.status === "draft" && (mine || isManagement(req.user)),
    },
  };
}

const summary = (c) => {
  const t = totals(c.lines, c.taxRate);
  const done = (c.deliverables || []).filter((d) => d.done).length;
  return { id: String(c._id), number: c.number, eventKey: c.eventKey, eventName: c.eventName, company: c.company?.name || "",
           contact: c.contact?.name || "", status: c.status, total: t.total, subtotal: t.subtotal,
           items: (c.lines || []).length, deliverables: { done, total: (c.deliverables || []).length },
           approvalNeeded: !!c.approval?.needed && c.approval?.key !== pricingKey(c.lines, c.taxRate),
           createdBy: c.createdBy, updatedAt: c.updatedAt, signedAt: c.signedAt };
};

contractsRouter.get("/", wrap(async (req, res) => {
  const q = {};
  if (req.query.eventKey) q.eventKey = String(req.query.eventKey);
  const rows = await Contract.find(q).sort({ updatedAt: -1 }).limit(500).lean();
  const list = rows.map(summary);
  const counts = Object.fromEntries(STATUSES.map((s) => [s.key, list.filter((c) => c.status === s.key).length]));
  counts.approval = list.filter((c) => c.approvalNeeded && c.status === "draft").length;
  res.json({ contracts: list, counts, statuses: STATUSES, isManagement: isManagement(req.user) });
}));

async function load(req, res) {
  if (!validId(req.params.id)) { res.status(404).json({ error: "Not found" }); return null; }
  const c = await Contract.findById(req.params.id).lean();
  if (!c) { res.status(404).json({ error: "Not found" }); return null; }
  return c;
}

contractsRouter.get("/:id", wrap(async (req, res) => {
  const c = await load(req, res); if (!c) return;
  res.json({ contract: await view(c, req) });
}));

/** The panel's fields → what to save, or { error }. */
async function fieldsFrom(body, { eventKey, settings }) {
  const party = cleanParty(body);
  if (party.error) return party;
  const { byId } = await catalogue();
  const lines = [];
  for (const input of Array.isArray(body.lines) ? body.lines.slice(0, 60) : []) {
    const o = byId(input?.offeringId);
    if (!o) return { error: "One of the items is no longer in the catalogue." };
    const existing = input.snapshot && input.offeringId === String(o._id) ? input.snapshot : null;
    if (!existing && !offeredFor(o, eventKey)) return { error: `${o.name} isn't offered for this event.` };
    // A line already on the contract keeps what it was sold as (catalogue price, description, package items).
    const base = existing ? { ...existing, _id: existing.offeringId, price: existing.listPrice } : o;
    const { value, error } = lineFrom(input, base, byId);
    if (error) return { error };
    if (existing) value.items = existing.items || [];
    lines.push(value);
  }
  const taxRate = body.taxRate === undefined ? settings.taxRate : Number(body.taxRate);
  if (!TAX_RATES.some((t) => t.rate === taxRate)) return { error: "Pick a tax rate." };
  const str = (v, max) => String(v ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
  return { value: {
    ...party.value, lines, taxRate,
    paymentTerms: str(body.paymentTerms, 1000) || settings.paymentTerms,
    terms: str(body.terms, 6000),   // this contract's special terms, on top of the standard clauses
    notes: str(body.notes, 2000),
    // Who signs for TTFC: one of the signing authorities in Contract settings ("" = not chosen yet).
    signatoryId: (settings.signatories || []).some((sg) => sg.id === body.signatoryId && sg.name) ? String(body.signatoryId) : "",
  } };
}

async function nextNumber(eventYear, eventName = "", settings = SETTING_DEFAULTS) {
  const year = /^20\d\d$/.test(String(eventYear || "")) ? String(eventYear)
    : (/20\d\d/.exec(eventName) || [String(new Date().getFullYear())])[0];
  const r = await counters().findOneAndUpdate({ _id: SEQ_KEY }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" });
  const seq = (r?.value ?? r)?.seq || 1;
  return contractNumber(year, seq, settings.numbering);
}

contractsRouter.post("/", wrap(async (req, res) => {
  const eventKey = String(req.body?.eventKey || "").trim().slice(0, 80);
  if (!eventKey) return res.status(400).json({ error: "Choose the event in the top bar first." });
  const settings = await loadSettings();
  const { value, error } = await fieldsFrom(req.body, { eventKey, settings });
  if (error) return res.status(400).json({ error });
  const eventName = String(req.body?.eventName || "").slice(0, 160);
  const over = overDiscount(value.lines, settings.maxDiscountPct);
  const c = await Contract.create({
    ...value, eventKey, eventName, number: await nextNumber(req.body?.eventYear, eventName, settings),
    approval: { needed: over.length > 0 },
    createdBy: who(req), createdById: String(req.user._id), updatedBy: who(req),
  });
  audit(req, "contract_create", "contract", c._id, `${c.number} · ${c.company.name}`);
  res.status(201).json({ contract: await view(c.toObject(), req, settings) });
}));

contractsRouter.patch("/:id", wrap(async (req, res) => {
  const c = await load(req, res); if (!c) return;
  if (c.status !== "draft") return res.status(409).json({ error: "Only a draft can be changed. Move it back to draft first.", code: "not_draft" });
  const settings = await loadSettings();
  // Lines already on the contract keep their snapshot even if the offering has since been retired.
  const known = new Map(c.lines.map((l) => [l.offeringId, l]));
  const body = { ...req.body, lines: (req.body?.lines || []).map((l) => ({ ...l, snapshot: known.get(l?.offeringId) || null })) };
  const { value, error } = await fieldsFrom(body, { eventKey: c.eventKey, settings });
  if (error) return res.status(400).json({ error });
  const over = overDiscount(value.lines, settings.maxDiscountPct);
  const approval = { ...(c.approval || {}), needed: over.length > 0 };
  const saved = await Contract.findByIdAndUpdate(c._id, { ...value, approval, updatedBy: who(req) }, { new: true }).lean();
  audit(req, "contract_edit", "contract", c._id, `${c.number} · ${saved.company.name}`);
  res.json({ contract: await view(saved, req, settings) });
}));

contractsRouter.post("/:id/approve", managementOnly, wrap(async (req, res) => {
  const c = await load(req, res); if (!c) return;
  const key = pricingKey(c.lines, c.taxRate);
  const saved = await Contract.findByIdAndUpdate(c._id,
    { approval: { needed: true, key, by: who(req), at: new Date() }, updatedBy: who(req) }, { new: true }).lean();
  audit(req, "contract_approve", "contract", c._id, `${c.number}: prices approved`);
  res.json({ contract: await view(saved, req) });
}));

contractsRouter.post("/:id/status", wrap(async (req, res) => {
  const c = await load(req, res); if (!c) return;
  const to = String(req.body?.status || "");
  const v = await view(c, req);
  const set = { updatedBy: who(req) };
  if (to === "sent") {
    if (!v.can.send) return res.status(409).json({ error: !v.approvedPrices ? "A manager needs to approve the prices first." : v.overLimits.length ? "Some items are over what's left to sell." : "Only a draft with items can be sent.", code: "cant_send" });
    Object.assign(set, { status: "sent", sentAt: new Date(), sentBy: who(req), frozen: c.frozen || frozenFrom(await loadSettings(), c.signatoryId) });
  } else if (to === "draft") {
    if (c.status !== "sent") return res.status(409).json({ error: "Only a sent contract can go back to draft.", code: "cant_draft" });
    Object.assign(set, { status: "draft", frozen: null });
  } else if (to === "signed") {
    if (!v.can.sign) return res.status(409).json({ error: !v.approvedPrices ? "A manager needs to approve the prices first." : v.overLimits.length ? "Some items are over what's left to sell." : "This contract can't be marked signed.", code: "cant_sign" });
    const signerName = String(req.body?.signerName || "").trim().slice(0, 120);
    const kept = new Map((c.deliverables || []).map((d) => [d.key, d]));
    const deliverables = deliverablesFor(c.lines).map((d) => ({ ...d, ...(kept.get(d.key) || {}), label: d.label }));
    Object.assign(set, { status: "signed", signedAt: new Date(), signedBy: who(req), signerName, deliverables,
                         frozen: c.frozen || frozenFrom(await loadSettings(), c.signatoryId) });
  } else if (to === "cancelled") {
    if (!isManagement(req.user)) return res.status(403).json({ error: "Management only", code: "management_only" });
    if (c.status === "cancelled") return res.status(409).json({ error: "Already cancelled." });
    Object.assign(set, { status: "cancelled", cancelledAt: new Date(), cancelledBy: who(req) });
  } else return res.status(400).json({ error: "Unknown status." });
  const saved = await Contract.findByIdAndUpdate(c._id, set, { new: true }).lean();
  audit(req, `contract_${to}`, "contract", c._id, `${c.number} · ${c.company.name}: ${c.status} → ${to}`);
  res.json({ contract: await view(saved, req) });
}));

contractsRouter.patch("/:id/deliverables/:key", wrap(async (req, res) => {
  const c = await load(req, res); if (!c) return;
  if (c.status !== "signed") return res.status(409).json({ error: "Tasks start once the contract is signed." });
  const i = (c.deliverables || []).findIndex((d) => d.key === req.params.key);
  if (i < 0) return res.status(404).json({ error: "Not found" });
  const b = req.body || {}, d = { ...c.deliverables[i] };
  if (typeof b.done === "boolean" && b.done !== d.done) Object.assign(d, { done: b.done, doneAt: b.done ? new Date() : null, doneBy: b.done ? who(req) : "" });
  if (b.dueDate !== undefined) {
    if (b.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(b.dueDate)) return res.status(400).json({ error: "Use a date like 2027-01-15." });
    d.dueDate = b.dueDate || "";
  }
  if (b.owner !== undefined) d.owner = String(b.owner).trim().slice(0, 120);
  if (b.note !== undefined) d.note = String(b.note).trim().slice(0, 500);
  if (b.link !== undefined) {
    const link = String(b.link).trim().slice(0, 500);
    if (link && !/^https?:\/\/\S+$/i.test(link)) return res.status(400).json({ error: "The link starts with https://" });
    d.link = link;
  }
  const saved = await Contract.findOneAndUpdate({ _id: c._id, "deliverables.key": d.key }, { $set: { "deliverables.$": d } }, { new: true }).lean();
  if (typeof b.done === "boolean") audit(req, "contract_task", "contract", c._id, `${c.number}: ${d.label} ${d.done ? "done" : "not done"}`);
  res.json({ contract: await view(saved, req) });
}));

contractsRouter.get("/:id/pdf", wrap(async (req, res) => {
  const c = await load(req, res); if (!c) return;
  const v = await view(c, req);
  const pdf = await contractPdf(c, { approvedPrices: v.approvedPrices, issuer: c.frozen || frozenFrom(await loadSettings(), c.signatoryId) });
  const name = `${c.number || "contract"}-${String(c.company?.name || "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}.pdf`;
  res.set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "private, no-store" });
  res.send(pdf);
}));

contractsRouter.post("/:id/signed-copy", express.raw({ type: "application/pdf", limit: "10mb" }), wrap(async (req, res) => {
  const c = await load(req, res); if (!c) return;
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length < 5 || buf.subarray(0, 5).toString() !== "%PDF-") {
    return res.status(400).json({ error: "Upload the signed contract as a PDF (up to 10 MB)." });
  }
  const name = String(req.query.name || "signed-contract.pdf").replace(/[^\w.\- ]+/g, "").slice(0, 120) || "signed-contract.pdf";
  await ContractFile.findOneAndUpdate({ contractId: String(c._id) },
    { contractId: String(c._id), name, size: buf.length, data: buf, uploadedBy: who(req) }, { upsert: true });
  const saved = await Contract.findByIdAndUpdate(c._id,
    { signedCopy: { name, size: buf.length, at: new Date(), by: who(req) }, updatedBy: who(req) }, { new: true }).lean();
  audit(req, "contract_signed_copy", "contract", c._id, `${c.number}: signed copy uploaded`);
  res.json({ contract: await view(saved, req) });
}));

contractsRouter.get("/:id/signed-copy", wrap(async (req, res) => {
  const c = await load(req, res); if (!c) return;
  const f = await ContractFile.findOne({ contractId: String(c._id) }).lean();
  if (!f) return res.status(404).json({ error: "No signed copy yet." });
  res.set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${f.name}"`, "Cache-Control": "private, no-store" });
  res.send(Buffer.from(f.data.buffer || f.data));
}));

contractsRouter.delete("/:id", wrap(async (req, res) => {
  const c = await load(req, res); if (!c) return;
  const v = await view(c, req);
  if (!v.can.remove) return res.status(409).json({ error: "Only a draft can be deleted, by whoever made it or by management. Cancel it instead.", code: "cant_delete" });
  await Promise.all([Contract.deleteOne({ _id: c._id }), ContractFile.deleteOne({ contractId: String(c._id) })]);
  audit(req, "contract_delete", "contract", c._id, `${c.number} · ${c.company?.name || ""}`);
  res.json({ ok: true });
}));
