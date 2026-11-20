import express from "express";
import mongoose from "mongoose";
import User from "../models/User.js";
import Commitment from "../models/Commitment.js";
import JobLock from "../models/JobLock.js";
import { AdminAudit } from "../models/Admin.js";
import { requireAdmin, isManagement } from "../middleware/adminAuth.js";
import { sendFormSubmissionEmail } from "../services/emailService.js";
import {
  AREAS, SEVERITIES, addDays, assignedEmail, cleanCommitment, cleanFlag, commitmentDTO, flagEmail, reminderEmail, reminderFor,
  sortForList, torontoDay,
} from "../services/commitments.js";

/* =========================================================
   Tasks (commitments) and flags, Nov 20 2026. Admin › Home › My work.
   Mounted at /api/console/commitments before the console router. Any staff
   account (requireAdmin: volunteers and app sign-ins get 403).

     GET  /?scope=mine|given|all&status=open|done|all&eventKey=&area=
          → { items, counts: { mine, overdue, flags }, today, areas, severities, people: [{ id, name }], me, canSeeAll }
     Private (Nov 20 2026, the owner: "others shouldn't be able to see an individual's dashboard"): staff see
     only tasks they own, tasks they gave to someone (scope=given) and flags they raised; they can change only
     those (404 otherwise). Management sees and changes everyone's (scope=all) and every flag. A task with no
     owner yet is management's until someone is given it.
     POST / { title, ownerId?, dueDate?, notes?, area?, eventKey?, about? } → 201 { item }
          (no owner = yours; giving it to someone else emails them)
     PATCH /:id  the same fields → { item }   (any staff; a new owner is emailed)
     POST /:id/done { done: true|false } → { item }   (done also closes an open flag)
     DELETE /:id → { ok }   (whoever made it, or management)
     POST /flag { note, severity?, title?, eventKey?, area?, about? } → 201 { item }
          "Raise a flag" from anywhere: a new task with an open flag and no owner yet
     POST /:id/flag { note, severity? } → { item }   (on an existing task)
     POST /:id/flag/resolve { resolution } → { item }
   A raised flag emails management and the task's owner at once.

   Reminders: every morning (8 AM Toronto, one server: JobLock "commitment-reminders")
   each owner gets ONE email listing their tasks due in a week, tomorrow, today, and
   overdue (the first day, then Mondays). Rules in services/commitments.js.
   Private: MongoDB only. Audited (commitment_*; titles only, never notes).
========================================================= */

const router = express.Router();
export default router;

/** Replaced in tests: where emails go. */
export const commitmentDeps = {
  send: ({ to, subject, html, text }) => sendFormSubmissionEmail({ to, subject, html, text }),
};

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error("COMMITMENTS ERROR:", err?.message || err);
  if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Try again." });
});
const who = (req) => String(req.user?.name || req.user?.email || "Staff").slice(0, 120);
const audit = (req, action, id, detail) =>
  AdminAudit.create({ adminId: req.user._id, adminName: req.user.name, action, targetType: "commitment",
                      targetId: String(id).slice(0, 120), detail: String(detail).slice(0, 500) }).catch(() => {});
const validId = (id) => mongoose.isValidObjectId(id);
const link = () => `${String(process.env.FRONTEND_URL || "https://www.thetechfestival.com").replace(/\/$/, "")}/admin/work`;
const realEmail = (e) => /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(String(e || "")) && !/@ticket\.thetechfestival\.com$/i.test(e);
const email = (to, mail) => {
  const list = [...new Set((Array.isArray(to) ? to : [to]).filter(realEmail))];
  if (!list.length) return;
  Promise.resolve().then(() => commitmentDeps.send({ to: list, ...mail })).catch((err) => console.error("COMMITMENT EMAIL ERROR:", err?.message || err));
};

/** What this person may see: everything for management; else what they own, made or flagged. */
const mineOnly = (req) => (isManagement(req.user) ? {} : { $or: [{ ownerId: req.user._id }, { createdById: req.user._id }, { "flag.raisedById": req.user._id }] });
const findVisible = (req, id) => (validId(id) ? Commitment.findOne({ _id: id, ...mineOnly(req) }) : Promise.resolve(null));

const staff = () => User.find({ role: "admin", banned: { $ne: true } }).select("name email staffRole role").lean();
async function ownerFor(id) {
  if (!id) return { ownerId: null, ownerName: "" };
  if (!validId(id)) return null;
  const u = await User.findOne({ _id: id, role: "admin" }).select("name email").lean();
  return u ? { ownerId: u._id, ownerName: u.name || u.email, email: u.email } : null;
}

router.use(requireAdmin);

router.get("/", wrap(async (req, res) => {
  const today = torontoDay();
  const me = String(req.user._id);
  const q = {};
  const status = ["open", "done", "all"].includes(req.query.status) ? req.query.status : "open";
  if (status !== "all") q.status = status;
  const manager = isManagement(req.user);
  if (req.query.scope === "given") Object.assign(q, { createdById: req.user._id, ownerId: { $ne: req.user._id } });
  else if (req.query.scope === "all") Object.assign(q, mineOnly(req));
  else q.ownerId = req.user._id;
  if (req.query.eventKey) q.eventKey = String(req.query.eventKey).toLowerCase().slice(0, 80);
  if (AREAS.some((a) => a.key === req.query.area)) q.area = req.query.area;
  const [rows, people, mine, overdue, flags] = await Promise.all([
    Commitment.find(q).sort({ updatedAt: -1 }).limit(500).lean(),
    staff(),
    Commitment.countDocuments({ status: "open", ownerId: req.user._id }),
    Commitment.countDocuments({ status: "open", ownerId: req.user._id, dueDate: { $ne: "", $lt: today } }),
    Commitment.countDocuments({ status: "open", "flag.open": true, ...mineOnly(req) }),
  ]);
  res.json({
    items: sortForList(rows, today).map((c) => commitmentDTO(c, today)),
    counts: { mine, overdue, flags }, today, areas: AREAS, severities: SEVERITIES, me, canSeeAll: manager,
    people: people.map((u) => ({ id: String(u._id), name: u.name || u.email })).sort((a, b) => a.name.localeCompare(b.name)),
  });
}));

router.post("/", wrap(async (req, res) => {
  const { set, error } = cleanCommitment(req.body || {}, { creating: true });
  if (error) return res.status(400).json({ error });
  const owner = await ownerFor(set.ownerId || String(req.user._id));
  if (!owner) return res.status(400).json({ error: "Pick a staff member from the list." });
  const c = await Commitment.create({ ...set, ownerId: owner.ownerId, ownerName: owner.ownerName,
    createdById: req.user._id, createdByName: who(req), source: "manual" });
  audit(req, "commitment_add", c._id, `${c.title} → ${owner.ownerName}${c.dueDate ? `, due ${c.dueDate}` : ""}`);
  if (String(owner.ownerId) !== String(req.user._id)) email(owner.email, assignedEmail(c, who(req), link()));
  res.status(201).json({ item: commitmentDTO(c.toObject()) });
}));

/* Declared before /:id routes. */
router.post("/flag", wrap(async (req, res) => {
  const { flag, error } = cleanFlag(req.body || {});
  if (error) return res.status(400).json({ error });
  const firstLine = flag.note.split("\n")[0].slice(0, 120);
  const { set, error: e2 } = cleanCommitment({ ...req.body, title: req.body?.title || firstLine, ownerId: undefined }, { creating: true });
  if (e2) return res.status(400).json({ error: e2 });
  delete set.ownerId;
  const c = await Commitment.create({ ...set, source: "flag", createdById: req.user._id, createdByName: who(req),
    flag: { ...flag, open: true, raisedById: req.user._id, raisedByName: who(req), raisedAt: new Date() } });
  audit(req, "commitment_flag", c._id, `${flag.severity}: ${c.title}`);
  notifyFlag(c.toObject());
  res.status(201).json({ item: commitmentDTO(c.toObject()) });
}));

async function notifyFlag(c) {
  const people = await staff();
  const to = people.filter((u) => isManagement(u) || String(u._id) === String(c.ownerId || "")).map((u) => u.email);
  email(to, flagEmail(c, link()));
}

router.patch("/:id", wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const c = await findVisible(req, req.params.id);
  if (!c) return res.status(404).json({ error: "Not found" });
  const { set, error } = cleanCommitment(req.body || {});
  if (error) return res.status(400).json({ error });
  let newOwner = null;
  if ("ownerId" in set) {
    const owner = await ownerFor(set.ownerId);
    if (!owner) return res.status(400).json({ error: "Pick a staff member from the list." });
    if (String(owner.ownerId || "") !== String(c.ownerId || "")) newOwner = owner;
    set.ownerId = owner.ownerId; set.ownerName = owner.ownerName;
  }
  Object.assign(c, set);
  await c.save();
  audit(req, "commitment_edit", c._id, `${c.title} (${Object.keys(set).join(", ")})`);
  if (newOwner?.ownerId && String(newOwner.ownerId) !== String(req.user._id)) email(newOwner.email, assignedEmail(c, who(req), link()));
  res.json({ item: commitmentDTO(c.toObject()) });
}));

router.post("/:id/done", wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const done = req.body?.done !== false;
  const set = done ? { status: "done", doneAt: new Date(), doneByName: who(req) } : { status: "open", doneAt: null, doneByName: "" };
  const c = await findVisible(req, req.params.id);
  if (!c) return res.status(404).json({ error: "Not found" });
  Object.assign(c, set);
  // Finishing the task settles its flag.
  if (done && c.flag?.open) Object.assign(c.flag, { open: false, resolvedByName: who(req), resolvedAt: new Date(), resolution: c.flag.resolution || "Task done" });
  await c.save();
  audit(req, done ? "commitment_done" : "commitment_reopen", c._id, c.title);
  res.json({ item: commitmentDTO(c.toObject()) });
}));

router.post("/:id/flag", wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const { flag, error } = cleanFlag(req.body || {});
  if (error) return res.status(400).json({ error });
  const c = await findVisible(req, req.params.id);
  if (!c) return res.status(404).json({ error: "Not found" });
  c.flag = { ...flag, open: true, raisedById: req.user._id, raisedByName: who(req), raisedAt: new Date(), resolvedByName: "", resolvedAt: null, resolution: "" };
  if (c.status === "done") Object.assign(c, { status: "open", doneAt: null, doneByName: "" });
  await c.save();
  audit(req, "commitment_flag", c._id, `${flag.severity}: ${c.title}`);
  notifyFlag(c.toObject());
  res.json({ item: commitmentDTO(c.toObject()) });
}));

router.post("/:id/flag/resolve", wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const resolution = String(req.body?.resolution ?? "").trim().slice(0, 1000);
  if (!resolution) return res.status(400).json({ error: "Say how it was sorted out, in a sentence." });
  const c = await findVisible(req, req.params.id);
  if (!c) return res.status(404).json({ error: "Not found" });
  if (!c.flag?.open) return res.status(409).json({ error: "This flag is already resolved." });
  Object.assign(c.flag, { open: false, resolvedByName: who(req), resolvedAt: new Date(), resolution });
  await c.save();
  audit(req, "commitment_flag_resolve", c._id, c.title);
  res.json({ item: commitmentDTO(c.toObject()) });
}));

router.delete("/:id", wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const c = await findVisible(req, req.params.id);
  if (!c) return res.status(404).json({ error: "Not found" });
  if (String(c.createdById || "") !== String(req.user._id) && !isManagement(req.user)) {
    return res.status(403).json({ error: "Only the person who added it, or a manager, can delete it. You can mark it done instead." });
  }
  await Commitment.deleteOne({ _id: c._id });
  audit(req, "commitment_delete", c._id, c.title);
  res.json({ ok: true });
}));

/* ---------------- Morning reminders ---------------- */

const JOB_ID = "commitment-reminders";
const INSTANCE = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const torontoHour = (now) => Number(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", hour: "2-digit", hour12: false }).format(now)) % 24;

/** One morning's emails → { owners, tasks }. Exported for tests. */
export async function sendReminders({ today = torontoDay() } = {}) {
  const rows = await Commitment.find({ status: "open", ownerId: { $ne: null }, dueDate: { $ne: "", $lte: addDays(today, 7) } }).lean();
  const byOwner = new Map();
  for (const c of rows) {
    const kind = reminderFor(c, today);
    if (!kind) continue;
    const k = String(c.ownerId);
    if (!byOwner.has(k)) byOwner.set(k, []);
    byOwner.get(k).push({ kind, title: c.title, dueDate: c.dueDate, about: c.about });
  }
  if (!byOwner.size) return { owners: 0, tasks: 0 };
  const owners = await User.find({ _id: { $in: [...byOwner.keys()] }, role: "admin", banned: { $ne: true } }).select("name email").lean();
  let tasks = 0;
  for (const u of owners) {
    const items = byOwner.get(String(u._id));
    tasks += items.length;
    email(u.email, reminderEmail(u.name, items, link()));
  }
  return { owners: owners.length, tasks };
}

/** Once a day from 8 AM Toronto, on one server (the lock is held until the next morning). */
export async function runReminderTick({ now = new Date() } = {}) {
  if (torontoHour(now) < 8) return null;
  try {
    const nextDay = new Date(`${addDays(torontoDay(now), 1)}T11:00:00Z`); // before 8 AM Toronto tomorrow, summer or winter
    const r = await JobLock.findOneAndUpdate(
      { _id: JOB_ID, until: { $lte: now } },
      { $set: { until: nextDay, owner: INSTANCE } },
      { upsert: true, returnDocument: "after", projection: { owner: 1 } },
    ).lean();
    if (r?.owner !== INSTANCE) return null;
  } catch (err) {
    if (err?.code === 11000) return null;
    throw err;
  }
  const out = await sendReminders({ today: torontoDay(now) });
  console.log(`COMMITMENT REMINDERS: ${out.owners} people, ${out.tasks} tasks`);
  return out;
}

export function startCommitmentReminders({ everyMs = 10 * 60 * 1000 } = {}) {
  const tick = () => { runReminderTick().catch((err) => console.error("COMMITMENT REMINDERS ERROR:", err?.message || err)); };
  const t = setInterval(tick, everyMs);
  t.unref?.();
  tick();
  return t;
}
