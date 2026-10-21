import express from "express";
import Juror from "../models/Juror.js";
import JuryAssignment from "../models/JuryAssignment.js";
import JurySignInRequest from "../models/JurySignInRequest.js";
import Nomination from "../models/Nomination.js";
import { AdminAudit } from "../models/Admin.js";
import { requireAdmin, requireManagement, isManagement } from "../middleware/adminAuth.js";
import { makeLimiter } from "../services/ticketAccess.js";
import { hashPassword, passwordProblem } from "../services/juryAuth.js";
import {
  ANCHOR_MAX, COMMENT_MAX, DEFAULT_CRITERIA, HELP_MAX, LABEL_MAX, MAX_CRITERIA, MIN_CRITERIA, POOL_STATUSES, RECOMMENDATIONS, SCORE_MAX,
  SCORE_MIN, STATE_LABELS, WEIGHT_MAX, WEIGHT_MIN, assessmentState, categoryKey, cleanJuror, cleanRubric, cleanSettings, formatDeadline,
  isLocked, isObjectId, juryOrder, nomineeSummary, nominationResult, planBalanced, plainScoreSet, progressOf, rankBy, recommendationLabel,
  resultsCsv, sameCriteria, visibleToJury, weightShares, weightedTotal,
} from "../services/jury.js";
import {
  currentPool, currentRubric, loadJuryTemplate, loadSettings, rubricVersions, saveJuryTemplate, saveRubricVersion, saveSettings,
  usedCriterionKeys,
} from "../services/juryStore.js";
import {
  DEFAULT_COPY, FIELDS, PLACEHOLDERS, SAMPLE_JUROR, SAMPLE_PROGRESS, SECTIONS, changedWording, cleanCopy, kindOf, varsFor, wordingToSave,
} from "../services/juryEmailCopy.js";
import { previewJuryEmail, sendJuryEmail, portalUrl } from "../services/juryEmail.js";
import { NOMINATION_STATUSES, SPECIAL_AWARDS } from "../services/nominations.js";

/* =========================================================
   /api/console/jury: Admin › Catalyst Awards › Jury, Allocation,
   Scoring rubric and Jury results (Oct 2026). Staff only (requireAdmin:
   a password sign-in, never a juror's token). Staff may look at the
   jurors, the allocation, the rubric and the email wording; every
   change, every email to a juror and the results (scores, comments)
   are for management. Every change is audited (targetType "jury").
   Nothing here emails anyone unless management clicks.

   GET    /overview                 → { jurors, settings, pool, rubric, counts, portalUrl, canManage }
   POST   /jurors                   { name, email, organisation?, title?, active?, password? } → { juror }
   PATCH  /jurors/:id               { name?, email?, organisation?, title?, active?, password? (null clears) } → { juror }
   DELETE /jurors/:id               → { removed: true } (off the jury: sessions end, allocations off, scores no longer count)
   GET    /jurors/:id               → { juror, rows } (their allocations and where each one is; no scores)
   GET    /nominations              → { rows, pool, jurors, filters } (what can be allocated, with coverage)
   POST   /assign                   { jurorIds, nominationIds } → { added, reactivated, skipped }
   POST   /assign-balanced          { nominationIds, jurorIds, perNomination, dryRun? } → { add, short, skipped, added? }
   POST   /unassign                 { pairs: [{ jurorId, nominationId }] } → { removed }
   POST   /conflicts/clear          { jurorId, nominationId } → { cleared: true } (back on the juror's list)
   GET    /rubric                   → { rubric, versions, usage, defaults, limits, recommendations }
   PUT    /rubric                   { criteria } → { rubric, created } (a new version only when something changed)
   PUT    /settings                 { deadline?, poolStatuses? } → { settings, pool }
   GET    /results                  → { rows, criteria, jurors } (management)
   GET    /results.csv              (management)
   GET    /email/:kind              invite | reminder → { copy, defaults, fields, sections, placeholders, canEdit, … }
   PUT    /email/:kind              { ...fields } (management)
   POST   /email/:kind/preview      { ...draft fields, jurorId? } → { subject, preheader, html, text, to }
   POST   /email/:kind/send-test    { ...draft fields } → { sent, to } (to yourself, "[Test] ")
   POST   /jurors/:id/invite        → { sent, at }   (management)
   POST   /jurors/:id/remind        → { sent, at }   (management)
   POST   /remind-all               { confirm: "SEND" } → { sent, skipped, failed } (everyone with assessments left)
========================================================= */

const router = express.Router();
router.use(requireAdmin);

const MAX_PAIRS = 3000;
const SEND_GAP_MS = 600;
const testPerStaff = makeLimiter({ max: 10, windowMs: 60 * 60 * 1000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const by = (req) => String(req.user?.name || req.user?.email || "");
const ids = (v) => [...new Set((Array.isArray(v) ? v : []).map(String).filter(isObjectId))];

async function audit(req, action, targetId = "", detail = "") {
  await AdminAudit.create({
    adminId: req.user._id, adminName: req.user.name, action, targetType: "jury", targetId: String(targetId), detail: String(detail).slice(0, 500),
  }).catch(() => {});
}

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error("JURY ADMIN ERROR:", err);
  if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Try again." });
});

const NOMINATION_FIELDS = {
  categoryType: 1, pillar: 1, sector: 1, specialAward: 1, nomineeName: 1, nomineeType: 1, nomineeOrganisation: 1, status: 1, submittedAt: 1,
  selfNomination: 1,
};

/** Everything the pages need, read once: jurors on the jury, all allocations, the nominations they point at. */
async function snapshot() {
  const [jurors, assignments] = await Promise.all([
    Juror.find({ removedAt: null }).sort({ name: 1 }).lean(),
    JuryAssignment.find({}).lean(),
  ]);
  const noms = await Nomination.find({}, NOMINATION_FIELDS).lean();
  const nomById = new Map(noms.map((n) => [String(n._id), n]));
  const jurorById = new Map(jurors.map((j) => [String(j._id), j]));
  // Allocations that count: active, to a juror on the jury, for a nomination the jury can see.
  const live = assignments
    .filter((a) => a.active && jurorById.has(String(a.juror)) && visibleToJury(nomById.get(String(a.nomination))))
    .map((a) => ({ a, state: assessmentState(a), jurorId: String(a.juror), nominationId: String(a.nomination) }));
  return { jurors, assignments, noms, nomById, jurorById, live };
}

function jurorRow(j, live) {
  const mine = live.filter((x) => x.jurorId === String(j._id));
  return {
    id: String(j._id), name: j.name, email: j.email, organisation: j.organisation || "", title: j.title || "", active: j.active !== false,
    hasPassword: !!j.passwordSetAt, passwordSetBy: j.passwordSetBy || "",
    invitedAt: j.invitedAt || null, inviteCount: j.inviteCount || 0, remindedAt: j.remindedAt || null, reminderCount: j.reminderCount || 0,
    lastSignInAt: j.lastSignInAt || null, lastActiveAt: j.lastActiveAt || null, createdAt: j.createdAt || null,
    lastSavedAt: mine.reduce((m, x) => (x.a.lastSavedAt && (!m || x.a.lastSavedAt > m) ? x.a.lastSavedAt : m), null),
    progress: progressOf(mine.map((x) => x.state)),
  };
}

async function settingsPayload() {
  const settings = await loadSettings();
  const pool = await currentPool(settings);
  return {
    settings: { ...settings, deadlineText: formatDeadline(settings.deadline), locked: isLocked(settings) },
    pool: { statuses: pool.statuses, automatic: pool.automatic, counts: pool.counts },
  };
}

/* ---------- overview & jurors ---------- */

router.get("/overview", wrap(async (req, res) => {
  const [snap, sp, rubric] = await Promise.all([snapshot(), settingsPayload(), currentRubric()]);
  const rows = snap.jurors.map((j) => jurorRow(j, snap.live));
  res.json({
    jurors: rows,
    ...sp,
    rubric: { version: rubric.version, criteria: rubric.criteria },
    counts: {
      jurors: rows.length, active: rows.filter((r) => r.active).length,
      allocations: snap.live.filter((x) => x.state !== "conflict").length,
      submitted: snap.live.filter((x) => x.state === "submitted" || x.state === "editing").length,
      conflicts: snap.live.filter((x) => x.state === "conflict").length,
      nominationsCovered: new Set(snap.live.filter((x) => x.state !== "conflict").map((x) => x.nominationId)).size,
    },
    portalUrl: portalUrl(),
    canManage: isManagement(req.user),
  });
}));

const jurorOut = async (id) => {
  const j = await Juror.findById(id).lean();
  const snap = await snapshot();
  return jurorRow(j, snap.live);
};

router.post("/jurors", requireManagement, wrap(async (req, res) => {
  const c = cleanJuror(req.body || {});
  if (!c.ok) return res.status(400).json({ error: c.error });
  const password = req.body?.password;
  if (password !== undefined && password !== null && password !== "") {
    const problem = passwordProblem(password, { email: c.set.email });
    if (problem) return res.status(400).json({ error: `Password: ${problem}` });
  }
  const pw = typeof password === "string" && password ? { passwordHash: await hashPassword(password), passwordSetAt: new Date(), passwordSetBy: by(req) } : {};
  const existing = await Juror.findOne({ email: c.set.email }).lean();
  let juror;
  if (existing && !existing.removedAt) return res.status(409).json({ error: "A juror with this email is already on the jury." });
  if (existing) {
    // Back on the jury: the same record, so their earlier allocations can be given back (they stay off until then).
    juror = await Juror.findByIdAndUpdate(existing._id, {
      $set: { ...c.set, ...pw, removedAt: null, removedBy: "", updatedBy: by(req) }, $inc: { tokenVersion: 1 },
    }, { returnDocument: "after" }).lean();
    await audit(req, "jury_juror_restore", juror._id, `${juror.name} <${juror.email}>`);
  } else {
    try {
      juror = (await Juror.create({ ...c.set, ...pw, createdBy: by(req), updatedBy: by(req) })).toObject();
    } catch (err) {
      if (err?.code === 11000) return res.status(409).json({ error: "A juror with this email is already on the jury." });
      throw err;
    }
    await audit(req, "jury_juror_add", juror._id, `${juror.name} <${juror.email}>${pw.passwordHash ? ", password set" : ""}`);
  }
  res.status(201).json({ juror: await jurorOut(juror._id) });
}));

router.get("/jurors/:id", wrap(async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(404).json({ error: "Juror not found" });
  const j = await Juror.findOne({ _id: req.params.id, removedAt: null }).lean();
  if (!j) return res.status(404).json({ error: "Juror not found" });
  const snap = await snapshot();
  const rows = snap.assignments.filter((a) => String(a.juror) === String(j._id) && a.active)
    .map((a) => {
      const n = snap.nomById.get(String(a.nomination));
      if (!n) return null;
      const state = assessmentState(a);
      return { ...nomineeSummary(n), status: n.status || "pending", hidden: !visibleToJury(n), state, stateLabel: STATE_LABELS[state],
        savedAt: a.lastSavedAt || null, submittedAt: a.submission?.submittedAt || null, conflictReason: state === "conflict" ? a.conflict?.reason || "" : "" };
    })
    .filter(Boolean)
    .sort(juryOrder);
  res.json({ juror: jurorRow(j, snap.live), rows });
}));

router.patch("/jurors/:id", requireManagement, wrap(async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(404).json({ error: "Juror not found" });
  const before = await Juror.findOne({ _id: req.params.id, removedAt: null }).lean();
  if (!before) return res.status(404).json({ error: "Juror not found" });
  const c = cleanJuror(req.body || {}, { partial: true });
  if (!c.ok) return res.status(400).json({ error: c.error });
  const set = { ...c.set, updatedBy: by(req) };
  const unset = {};
  let endSessions = false;
  const what = [];
  if ("password" in (req.body || {})) {
    const pw = req.body.password;
    if (pw === null || pw === "") {
      Object.assign(unset, { passwordHash: "", passwordSetAt: "" });
      set.passwordSetBy = "";
      what.push("password cleared");
    } else {
      const problem = passwordProblem(pw, { email: c.set.email || before.email });
      if (problem) return res.status(400).json({ error: `Password: ${problem}` });
      Object.assign(set, { passwordHash: await hashPassword(pw), passwordSetAt: new Date(), passwordSetBy: by(req) });
      what.push("password set");
    }
    endSessions = true;
  }
  if (c.set.email && c.set.email !== before.email) {
    const clash = await Juror.findOne({ email: c.set.email, _id: { $ne: before._id } }).lean();
    if (clash) return res.status(409).json({ error: clash.removedAt ? "That email belongs to a juror who was removed. Add them again instead." : "Another juror has this email." });
    await JurySignInRequest.updateMany({ email: before.email, status: "pending" }, { $set: { status: "replaced" } });
    what.push(`email ${before.email} → ${c.set.email}`);
    endSessions = true;
  }
  if ("active" in c.set && c.set.active !== (before.active !== false)) {
    what.push(c.set.active ? "switched on" : "switched off");
    if (!c.set.active) endSessions = true;
  }
  for (const k of ["name", "organisation", "title"]) if (k in c.set && c.set[k] !== (before[k] || "")) what.push(k);
  const update = { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}), ...(endSessions ? { $inc: { tokenVersion: 1 } } : {}) };
  try {
    await Juror.updateOne({ _id: before._id }, update);
  } catch (err) {
    if (err?.code === 11000) return res.status(409).json({ error: "Another juror has this email." });
    throw err;
  }
  await audit(req, "jury_juror_edit", before._id, `${before.name}: ${what.join(", ") || "no change"}`);
  res.json({ juror: await jurorOut(before._id) });
}));

router.delete("/jurors/:id", requireManagement, wrap(async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(404).json({ error: "Juror not found" });
  const j = await Juror.findOneAndUpdate(
    { _id: req.params.id, removedAt: null },
    { $set: { removedAt: new Date(), removedBy: by(req), active: false }, $inc: { tokenVersion: 1 } },
    { returnDocument: "after" },
  ).lean();
  if (!j) return res.status(404).json({ error: "Juror not found" });
  const off = await JuryAssignment.updateMany({ juror: j._id, active: true }, { $set: { active: false, unassignedBy: `${by(req)} (removed from the jury)`, unassignedAt: new Date() } });
  await JurySignInRequest.updateMany({ juror: j._id, status: "pending" }, { $set: { status: "replaced" } });
  await audit(req, "jury_juror_remove", j._id, `${j.name} <${j.email}>, ${off.modifiedCount || 0} allocations off`);
  res.json({ removed: true });
}));

/* ---------- allocation ---------- */

router.get("/nominations", wrap(async (req, res) => {
  const [snap, sp] = await Promise.all([snapshot(), settingsPayload()]);
  const pool = new Set(sp.pool.statuses);
  const byNom = new Map();
  for (const a of snap.assignments) {
    if (!a.active || !snap.jurorById.has(String(a.juror))) continue;
    const k = String(a.nomination);
    if (!byNom.has(k)) byNom.set(k, []);
    byNom.get(k).push(a);
  }
  const rows = snap.noms
    .filter((n) => pool.has(n.status || "pending") || byNom.has(String(n._id)))
    .map((n) => {
      const list = (byNom.get(String(n._id)) || []).map((a) => {
        const state = assessmentState(a);
        const j = snap.jurorById.get(String(a.juror));
        return { id: String(a.juror), name: j.name, active: j.active !== false, state, stateLabel: STATE_LABELS[state],
          conflictReason: state === "conflict" ? a.conflict?.reason || "" : "", conflictAt: state === "conflict" ? a.conflict?.at || null : null };
      }).sort((x, y) => x.name.localeCompare(y.name));
      const counted = list.filter((x) => x.state !== "conflict");
      return {
        ...nomineeSummary(n),
        pillar: n.categoryType === "matrix" ? n.pillar || "" : "",
        sector: n.categoryType === "matrix" ? n.sector || "" : "",
        specialAward: n.categoryType === "special" ? n.specialAward || "" : "",
        status: n.status || "pending",
        inPool: pool.has(n.status || "pending"),
        hidden: !visibleToJury(n),
        assigned: counted.length,
        submitted: counted.filter((x) => x.state === "submitted" || x.state === "editing").length,
        drafts: counted.filter((x) => x.state === "draft").length,
        conflicts: list.length - counted.length,
        jurors: list,
      };
    })
    .sort(juryOrder);
  const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort();
  res.json({
    rows,
    ...sp,
    jurors: snap.jurors.map((j) => jurorRow(j, snap.live)).map(({ id, name, active, organisation, progress }) => ({ id, name, active, organisation, load: progress.assigned, submitted: progress.submitted })),
    filters: {
      pillars: uniq(rows.map((r) => r.pillar)), sectors: uniq(rows.map((r) => r.sector)),
      specialAwards: uniq(rows.map((r) => r.specialAward)).map((k) => ({ key: k, label: SPECIAL_AWARDS[k] || k })),
      statuses: NOMINATION_STATUSES, poolStatuses: POOL_STATUSES,
    },
    canManage: isManagement(req.user),
  });
}));

/** The nominations in `nominationIds` that can be allocated now → { ok: [docs], skipped: [{ nominationId, nomineeName, reason, label }] }. */
async function allocatable(nominationIds) {
  const pool = await currentPool(await loadSettings());
  const noms = await Nomination.find({ _id: { $in: nominationIds } }, { status: 1, nomineeName: 1 }).lean();
  const found = new Set(noms.map((n) => String(n._id)));
  const skipped = nominationIds.filter((id) => !found.has(id)).map((id) => ({ nominationId: id, reason: "missing", label: "Nomination not found" }));
  const ok = [];
  for (const n of noms) {
    if (pool.statuses.includes(n.status || "pending")) ok.push(n);
    else skipped.push({ nominationId: String(n._id), nomineeName: n.nomineeName, reason: "status",
      label: n.status === "rejected" ? "Not progressing: never goes to the jury" : `Status "${n.status || "pending"}" isn't being allocated` });
  }
  return { ok, skipped, pool };
}

/** Adds the pairs (new rows, or the earlier row switched back on: its scores come back). → { added, reactivated } */
async function applyPairs(pairs, existing, who) {
  const byPair = new Map(existing.map((e) => [`${e.juror}:${e.nomination}`, e]));
  const at = new Date();
  const inserts = [];
  const reactivate = [];
  for (const p of pairs) {
    const e = byPair.get(`${p.juror}:${p.nomination}`);
    if (!e) inserts.push({ juror: p.juror, nomination: p.nomination, active: true, assignedBy: who, assignedAt: at });
    else if (!e.active) reactivate.push(e._id);
  }
  let added = 0;
  if (inserts.length) {
    try {
      added = (await JuryAssignment.insertMany(inserts, { ordered: false })).length;
    } catch (err) {
      // A pair added at the same moment by someone else: keep the rest.
      if (err?.code !== 11000 && !err?.writeErrors) throw err;
      added = err?.insertedDocs?.length ?? (inserts.length - (err?.writeErrors?.length || 0));
    }
  }
  if (reactivate.length) {
    await JuryAssignment.updateMany({ _id: { $in: reactivate }, active: false },
      { $set: { active: true, assignedBy: who, assignedAt: at }, $unset: { unassignedBy: "", unassignedAt: "" } });
  }
  return { added, reactivated: reactivate.length };
}

const conflictOpen = (a) => !!a?.conflict?.at && !a?.conflict?.clearedAt;

router.post("/assign", requireManagement, wrap(async (req, res) => {
  const jurorIds = ids(req.body?.jurorIds);
  const nominationIds = ids(req.body?.nominationIds);
  if (!jurorIds.length) return res.status(400).json({ error: "Pick at least one juror." });
  if (!nominationIds.length) return res.status(400).json({ error: "Pick at least one nomination." });
  if (jurorIds.length * nominationIds.length > MAX_PAIRS) return res.status(400).json({ error: `That's more than ${MAX_PAIRS} allocations at once. Pick fewer.` });
  const jurors = await Juror.find({ _id: { $in: jurorIds }, removedAt: null }, { name: 1 }).lean();
  if (!jurors.length) return res.status(400).json({ error: "Those jurors aren't on the jury." });
  const { ok, skipped } = await allocatable(nominationIds);
  const existing = await JuryAssignment.find({ juror: { $in: jurors.map((j) => j._id) }, nomination: { $in: ok.map((n) => n._id) } }).lean();
  const byPair = new Map(existing.map((e) => [`${e.juror}:${e.nomination}`, e]));
  const pairs = [];
  for (const j of jurors) {
    for (const n of ok) {
      const e = byPair.get(`${j._id}:${n._id}`);
      if (conflictOpen(e)) skipped.push({ jurorId: String(j._id), jurorName: j.name, nominationId: String(n._id), nomineeName: n.nomineeName, reason: "conflict", label: "Declared a conflict of interest" });
      else if (e?.active) skipped.push({ jurorId: String(j._id), jurorName: j.name, nominationId: String(n._id), nomineeName: n.nomineeName, reason: "already", label: "Already allocated" });
      else pairs.push({ juror: j._id, nomination: n._id });
    }
  }
  const r = await applyPairs(pairs, existing, by(req));
  await audit(req, "jury_assign", "", `${r.added + r.reactivated} allocations (${jurors.length} jurors × ${ok.length} nominations), ${skipped.length} skipped`);
  res.json({ ...r, skipped });
}));

router.post("/assign-balanced", requireManagement, wrap(async (req, res) => {
  const jurorIds = ids(req.body?.jurorIds);
  const nominationIds = ids(req.body?.nominationIds);
  const perNomination = Math.floor(Number(req.body?.perNomination) || 0);
  if (!jurorIds.length) return res.status(400).json({ error: "Pick the jurors to share the nominations between." });
  if (!nominationIds.length) return res.status(400).json({ error: "Pick at least one nomination." });
  if (perNomination < 1 || perNomination > 50) return res.status(400).json({ error: "Jurors per nomination must be between 1 and 50." });
  const jurors = await Juror.find({ _id: { $in: jurorIds }, removedAt: null }, { name: 1, active: 1 }).lean();
  if (!jurors.length) return res.status(400).json({ error: "Those jurors aren't on the jury." });
  const { ok, skipped } = await allocatable(nominationIds);
  const snap = await snapshot();
  const okIds = new Set(ok.map((n) => String(n._id)));
  const existing = snap.assignments.filter((a) => okIds.has(String(a.nomination)))
    .map((a) => ({ juror: String(a.juror), nomination: String(a.nomination), active: a.active && snap.jurorById.has(String(a.juror)), conflict: conflictOpen(a), _id: a._id }));
  const load = {};
  for (const x of snap.live) if (x.state !== "conflict") load[x.jurorId] = (load[x.jurorId] || 0) + 1;
  const plan = planBalanced({ nominationIds: [...okIds], jurorIds: jurors.map((j) => String(j._id)), perNomination, existing, load });
  const jurorName = new Map(jurors.map((j) => [String(j._id), j.name]));
  const nomName = new Map(ok.map((n) => [String(n._id), n.nomineeName]));
  const named = {
    add: plan.add.map((p) => ({ jurorId: p.juror, jurorName: jurorName.get(p.juror), nominationId: p.nomination, nomineeName: nomName.get(p.nomination) })),
    short: plan.short.map((s) => ({ nominationId: s.nomination, nomineeName: nomName.get(s.nomination), have: s.have, need: s.need })),
    skipped,
    loadAfter: Object.fromEntries(jurors.map((j) => [String(j._id), (load[String(j._id)] || 0) + plan.add.filter((p) => p.juror === String(j._id)).length])),
  };
  if (req.body?.dryRun) return res.json({ ...named, dryRun: true });
  const raw = await JuryAssignment.find({ nomination: { $in: [...okIds] } }).lean();
  const r = await applyPairs(plan.add, raw, by(req));
  await audit(req, "jury_assign_balanced", "", `${perNomination} per nomination over ${ok.length} nominations and ${jurors.length} jurors: ${r.added + r.reactivated} allocations, ${plan.short.length} short`);
  res.json({ ...named, ...r });
}));

router.post("/unassign", requireManagement, wrap(async (req, res) => {
  const pairs = (Array.isArray(req.body?.pairs) ? req.body.pairs : [])
    .filter((p) => isObjectId(p?.jurorId) && isObjectId(p?.nominationId)).slice(0, MAX_PAIRS);
  if (!pairs.length) return res.status(400).json({ error: "Nothing to unassign." });
  const at = new Date();
  const r = await JuryAssignment.bulkWrite(pairs.map((p) => ({
    updateOne: { filter: { juror: p.jurorId, nomination: p.nominationId, active: true }, update: { $set: { active: false, unassignedBy: by(req), unassignedAt: at } } },
  })));
  const removed = r.modifiedCount || 0;
  await audit(req, "jury_unassign", "", `${removed} allocations off`);
  res.json({ removed });
}));

router.post("/conflicts/clear", requireManagement, wrap(async (req, res) => {
  const { jurorId, nominationId } = req.body || {};
  if (!isObjectId(jurorId) || !isObjectId(nominationId)) return res.status(400).json({ error: "Pick the juror and the nomination." });
  const a = await JuryAssignment.findOneAndUpdate(
    { juror: jurorId, nomination: nominationId, "conflict.at": { $ne: null }, "conflict.clearedAt": null },
    { $set: { "conflict.clearedAt": new Date(), "conflict.clearedBy": by(req) } },
    { returnDocument: "after" },
  ).lean();
  if (!a) return res.status(404).json({ error: "There's no open conflict for that juror and nomination." });
  await audit(req, "jury_conflict_clear", a._id, `juror ${jurorId}, nomination ${nominationId}`);
  res.json({ cleared: true });
}));

/* ---------- rubric & settings ---------- */

async function rubricPayload() {
  const [rubric, versions, usageRows] = await Promise.all([
    currentRubric(), rubricVersions(),
    JuryAssignment.aggregate([{ $match: { "submission.submittedAt": { $ne: null } } }, { $group: { _id: "$submission.rubricVersion", n: { $sum: 1 } } }]),
  ]);
  return {
    rubric: { ...rubric, shares: weightShares(rubric.criteria) },
    versions: versions.map((v) => ({ version: v.version, createdBy: v.createdBy, createdAt: v.createdAt, labels: v.criteria.map((x) => x.label) })),
    usage: Object.fromEntries(usageRows.map((u) => [String(u._id || 1), u.n])),
    defaults: DEFAULT_CRITERIA,
    limits: { minCriteria: MIN_CRITERIA, maxCriteria: MAX_CRITERIA, labelMax: LABEL_MAX, helpMax: HELP_MAX, anchorMax: ANCHOR_MAX,
      weightMin: WEIGHT_MIN, weightMax: WEIGHT_MAX, scoreMin: SCORE_MIN, scoreMax: SCORE_MAX, commentMax: COMMENT_MAX },
    recommendations: RECOMMENDATIONS,
  };
}

router.get("/rubric", wrap(async (req, res) => res.json({ ...(await rubricPayload()), ...(await settingsPayload()), canManage: isManagement(req.user) })));

router.put("/rubric", requireManagement, wrap(async (req, res) => {
  const c = cleanRubric(req.body || {}, { usedKeys: await usedCriterionKeys() });
  if (!c.ok) return res.status(400).json({ error: c.error });
  const current = await currentRubric();
  let created = false;
  if (!sameCriteria(current.criteria, c.criteria)) {
    const next = await saveRubricVersion(c.criteria, by(req));
    created = true;
    await audit(req, "jury_rubric", next.version, `v${next.version}: ${c.criteria.map((x) => `${x.label} ×${x.weight}`).join(", ")}`);
  }
  res.json({ ...(await rubricPayload()), created, canManage: true });
}));

router.put("/settings", requireManagement, wrap(async (req, res) => {
  const c = cleanSettings(req.body || {});
  if (!c.ok) return res.status(400).json({ error: c.error });
  if (!Object.keys(c.set).length) return res.status(400).json({ error: "Nothing to change." });
  await saveSettings(c.set, by(req));
  const parts = [];
  if ("deadline" in c.set) parts.push(`deadline ${c.set.deadline ? formatDeadline(c.set.deadline) : "none"}`);
  if ("poolStatuses" in c.set) parts.push(`allocating ${c.set.poolStatuses.length ? c.set.poolStatuses.join(" + ") : "automatic (shortlisted, else pending)"}`);
  await audit(req, "jury_settings", "", parts.join("; "));
  res.json(await settingsPayload());
}));

/* ---------- results (management) ---------- */

async function results() {
  const [snap, rubric] = await Promise.all([snapshot(), currentRubric()]);
  const criteria = rubric.criteria;
  const byNom = new Map();
  for (const x of snap.live) {
    if (!byNom.has(x.nominationId)) byNom.set(x.nominationId, []);
    byNom.get(x.nominationId).push(x);
  }
  const rows = [];
  for (const [nid, list] of byNom) {
    const n = snap.nomById.get(nid);
    const items = list.map((x) => ({ state: x.state, submission: plainScoreSet(x.a.submission), jurorId: x.jurorId, jurorName: snap.jurorById.get(x.jurorId)?.name || "" }));
    const r = nominationResult(items, criteria);
    rows.push({
      ...nomineeSummary(n),
      categoryKey: categoryKey(n),
      status: n.status || "pending",
      ...r,
      jurors: items.map((x) => ({
        id: x.jurorId, name: x.jurorName, state: x.state, stateLabel: STATE_LABELS[x.state],
        total: x.submission && (x.state === "submitted" || x.state === "editing") ? weightedTotal(x.submission.scores, criteria) : null,
        scores: x.submission && (x.state === "submitted" || x.state === "editing") ? x.submission.scores : {},
        recommendation: x.submission ? recommendationLabel(x.submission.recommendation) : "",
        rubricVersion: x.submission?.rubricVersion || null,
        submittedAt: x.submission?.submittedAt || null,
      })).sort((a, b) => a.name.localeCompare(b.name)),
      comments: items.filter((x) => (x.state === "submitted" || x.state === "editing") && x.submission?.comment)
        .map((x) => ({ juror: x.jurorName, jurorId: x.jurorId, comment: x.submission.comment, recommendation: recommendationLabel(x.submission.recommendation), submittedAt: x.submission.submittedAt })),
    });
  }
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.categoryKey)) groups.set(r.categoryKey, []);
    groups.get(r.categoryKey).push(r);
  }
  for (const g of groups.values()) {
    const ranks = rankBy(g);
    for (const r of g) { r.rank = ranks.get(r) ?? null; r.inCategory = g.length; }
  }
  const byCategory = (a, b) => juryOrder({ ...a, nomineeName: "", id: "" }, { ...b, nomineeName: "", id: "" });
  rows.sort((a, b) => byCategory(a, b) || (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.nomineeName.localeCompare(b.nomineeName));
  const shares = weightShares(criteria);
  return { rows, criteria: criteria.map((x) => ({ ...x, share: shares[x.key] })), rubricVersion: rubric.version, jurors: snap.jurors.map((j) => jurorRow(j, snap.live)) };
}

router.get("/results", requireManagement, wrap(async (req, res) => {
  const r = await results();
  await audit(req, "jury_results_view", "", `${r.rows.length} nominations`);
  res.json(r);
}));

router.get("/results.csv", requireManagement, wrap(async (req, res) => {
  const r = await results();
  await audit(req, "jury_results_export", "", `${r.rows.length} rows`);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="ttfc-catalyst-jury-results-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(resultsCsv(r.rows, r.criteria));
}));

/* ---------- emails to jurors ---------- */

/** The placeholders for a juror, with their progress. */
async function varsForJuror(j) {
  const snap = await snapshot();
  const settings = await loadSettings();
  const progress = jurorRow(j, snap.live).progress;
  return { vars: varsFor(j, progress, formatDeadline(settings.deadline)), progress };
}

router.get("/email/:kind", wrap(async (req, res) => {
  const kind = kindOf(req.params.kind);
  if (!kind) return res.status(404).json({ error: "Unknown email" });
  const t = await loadJuryTemplate(kind);
  res.json({ kind, copy: t.copy, defaults: DEFAULT_COPY[kind], fields: FIELDS[kind], sections: SECTIONS.filter((s) => FIELDS[kind].some((f) => f.section === s.key)),
    placeholders: PLACEHOLDERS, updatedBy: t.updatedBy, updatedAt: t.updatedAt, canEdit: isManagement(req.user) });
}));

router.put("/email/:kind", requireManagement, wrap(async (req, res) => {
  const kind = kindOf(req.params.kind);
  if (!kind) return res.status(404).json({ error: "Unknown email" });
  const before = await loadJuryTemplate(kind);
  const after = await saveJuryTemplate(kind, wordingToSave(kind, req.body || {}), by(req));
  const changed = changedWording(kind, before.copy, after.copy);
  await audit(req, `jury_email_${kind}`, "", changed.length ? `wording: ${changed.join(", ")}` : "wording unchanged");
  res.json({ kind, copy: after.copy, defaults: DEFAULT_COPY[kind], fields: FIELDS[kind], sections: SECTIONS.filter((s) => FIELDS[kind].some((f) => f.section === s.key)),
    placeholders: PLACEHOLDERS, updatedBy: after.updatedBy, updatedAt: after.updatedAt, canEdit: true });
}));

async function draftCopy(kind, body = {}) {
  const t = await loadJuryTemplate(kind);
  return { ...t.copy, ...cleanCopy(kind, body) };
}

router.post("/email/:kind/preview", wrap(async (req, res) => {
  const kind = kindOf(req.params.kind);
  if (!kind) return res.status(404).json({ error: "Unknown email" });
  const copy = await draftCopy(kind, req.body || {});
  let vars;
  let to = SAMPLE_JUROR.email;
  if (isObjectId(req.body?.jurorId)) {
    const j = await Juror.findOne({ _id: req.body.jurorId, removedAt: null }).lean();
    if (!j) return res.status(404).json({ error: "Juror not found" });
    ({ vars } = await varsForJuror(j));
    to = j.email;
  } else {
    const settings = await loadSettings();
    vars = varsFor(SAMPLE_JUROR, SAMPLE_PROGRESS, formatDeadline(settings.deadline));
  }
  const e = previewJuryEmail({ kind, copy, vars });
  res.json({ subject: e.subject, preheader: e.preheader, html: e.html, text: e.text, to });
}));

router.post("/email/:kind/send-test", wrap(async (req, res) => {
  const kind = kindOf(req.params.kind);
  if (!kind) return res.status(404).json({ error: "Unknown email" });
  const to = String(req.user?.email || "").trim().toLowerCase();
  if (!to) return res.status(400).json({ error: "Your staff account has no email address to send a test to." });
  if (!testPerStaff.hit(String(req.user._id))) return res.status(429).json({ error: "That's a lot of test emails. Try again in an hour." });
  const copy = await draftCopy(kind, req.body || {});
  const settings = await loadSettings();
  const vars = varsFor({ ...SAMPLE_JUROR, email: to }, SAMPLE_PROGRESS, formatDeadline(settings.deadline));
  try {
    await sendJuryEmail({ to, kind, copy, vars, subjectPrefix: "[Test] " });
  } catch (err) {
    await audit(req, `jury_email_${kind}_test_failed`, "", `${to}: ${err?.message || err}`);
    return res.status(502).json({ error: `Couldn't send: ${err?.message || "the email service refused it"}` });
  }
  await audit(req, `jury_email_${kind}_test`, "", to);
  res.json({ sent: true, to });
}));

/** Sends the invite or reminder to one juror and records it. → { status, body } */
async function sendTo(req, j, kind) {
  if (j.active === false) return { status: 409, body: { code: "inactive", error: `${j.name} is switched off. Switch them on first.` } };
  const { vars, progress } = await varsForJuror(j);
  if (kind === "reminder" && progress.remaining <= 0) return { status: 409, body: { code: "done", error: `${j.name} has nothing left to review.` } };
  const t = await loadJuryTemplate(kind);
  try {
    await sendJuryEmail({ to: j.email, kind, copy: t.copy, vars });
  } catch (err) {
    await audit(req, `jury_${kind}_failed`, j._id, `${j.email}: ${String(err?.message || err).slice(0, 200)}`);
    return { status: 502, body: { error: `Couldn't send: ${err?.message || "the email service refused it"}` } };
  }
  const at = new Date();
  await Juror.updateOne({ _id: j._id }, kind === "invite"
    ? { $set: { invitedAt: at }, $inc: { inviteCount: 1 } }
    : { $set: { remindedAt: at }, $inc: { reminderCount: 1 } });
  await audit(req, `jury_${kind}`, j._id, j.email);
  return { status: 200, body: { sent: true, at, email: j.email } };
}

for (const kind of ["invite", "remind"]) {
  router.post(`/jurors/:id/${kind}`, requireManagement, wrap(async (req, res) => {
    if (!isObjectId(req.params.id)) return res.status(404).json({ error: "Juror not found" });
    const j = await Juror.findOne({ _id: req.params.id, removedAt: null }).lean();
    if (!j) return res.status(404).json({ error: "Juror not found" });
    const r = await sendTo(req, j, kind === "invite" ? "invite" : "reminder");
    res.status(r.status).json(r.body);
  }));
}

router.post("/remind-all", requireManagement, wrap(async (req, res) => {
  if (req.body?.confirm !== "SEND") return res.status(400).json({ error: "Confirm with \"SEND\"." });
  const snap = await snapshot();
  const todo = snap.jurors.filter((j) => j.active !== false && jurorRow(j, snap.live).progress.remaining > 0);
  const out = { sent: [], skipped: snap.jurors.length - todo.length, failed: [] };
  for (const [i, j] of todo.entries()) {
    if (i) await sleep(SEND_GAP_MS);
    const r = await sendTo(req, j, "reminder");
    if (r.status === 200) out.sent.push(j.name); else out.failed.push({ name: j.name, error: r.body.error });
  }
  res.json({ sent: out.sent.length, names: out.sent, skipped: out.skipped, failed: out.failed });
}));

export default router;
