import express from "express";
import Nomination from "../models/Nomination.js";
import JuryAssignment from "../models/JuryAssignment.js";
import { AdminAudit } from "../models/Admin.js";
import { requireAdmin, requireManagement } from "../middleware/adminAuth.js";
import {
  CATEGORY_OPTIONS, NOMINATION_STATUSES, categoryChangeText, categoryOf, cleanCategoryChange, cleanFocusChange, cleanNominationPatch,
  cleanRestoreWhat, focusChangeText, focusOf, isNominationEmail, nominationDetail, nominationRow, nominationsCsv, parseNominationEmail,
  sameCategory, sameFocus, snapshotOf, submittedOf,
} from "../services/nominations.js";
import { forgetAwardApplications } from "./appAwards.js";
import { forgetWinners } from "./awards.js";
import { WINNERS_KEY, cleanAwardPatch, sortWinners, winnerAdminRow } from "../services/awardWinners.js";
import { switchOn } from "../services/liveSwitches.js";

/* =========================================================
   /api/console/nominations: Admin → Catalyst Awards → Nominations.
   Staff read and move nominations along (status, notes); export,
   delete and recovering emailed ones are management only. Audited.

   GET    /                    → { rows, counts: { all, pending, shortlisted, winner, rejected }, recovered }
   GET    /export              → CSV of every nomination (management)
   GET    /:id                 → { nomination }
   PATCH  /:id                 { status?, adminNotes? } → { nomination }
   DELETE /:id                 → { deleted: true } (management)
   POST   /recover             { cursor? } → { found, imported, cursor, done } (management)
          Reads the email service's log (Resend) for "[Catalyst Nomination]"
          emails, newest first, a batch per call: the page calls again with
          `cursor` until `done`. Already-saved emails are skipped.

   Changing the award category and the nominee's focus (management, Oct 22 2026):
   PATCH  /:id/category        { categoryType: "matrix", pillar, sector, note? }
                               | { categoryType: "special", specialAward, note? } → { nomination, changed }
   PATCH  /:id/focus           { nomineeSector?, nomineePillar?, note? } → { nomination, changed }
   POST   /:id/restore-submitted { what: "category" | "focus" | "both" } → { nomination, changed }
          Names from the canonical lists only (services/nominations.js PILLARS,
          SECTORS, SPECIAL_AWARDS), else 400; the focus sector may also stay as
          it is. The live fields change, so the jury, results, the apps' category
          count, the CSV and the filters follow; the first change copies what
          was submitted into `submitted` (once). Audited with labels only.

   What the website shows for each winner (Admin › Catalyst Awards › Winners, Oct 31 2026; services/awardWinners.js):
   GET    /winners             → { live, rows: [{ …the public view, hidden, set, defaults, nominee, category }] }
                               (status "winner", the website's order; live = site.award_winners)
   PATCH  /:id/award           { title?, company?, presentedTo?, presentedOn?, citation?, order?, hidden? } → { row }
                               (management; winners only, else 409). Text "" = back to the default. Audited.
========================================================= */

const router = express.Router();
router.use(requireAdmin);

const isId = (id) => /^[a-f0-9]{24}$/i.test(String(id || ""));
const by = (req) => String(req.user?.name || req.user?.email || "");

async function audit(req, action, targetId = "", detail = "") {
  await AdminAudit.create({
    adminId: req.user._id, adminName: req.user.name, action, targetType: "nomination",
    targetId: String(targetId), detail: String(detail).slice(0, 500),
  }).catch(() => {});
}

router.get("/", async (req, res) => {
  const docs = await Nomination.find({}).sort({ submittedAt: -1, createdAt: -1 }).lean();
  const rows = docs.map(nominationRow);
  const counts = { all: rows.length, ...Object.fromEntries(NOMINATION_STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length])) };
  res.json({ rows, counts, recovered: rows.filter((r) => r.source === "email").length });
});

router.get("/export", requireManagement, async (req, res) => {
  const docs = await Nomination.find({}).sort({ submittedAt: -1, createdAt: -1 }).lean();
  await audit(req, "nominations_export", "", `${docs.length} rows`);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="ttfc-catalyst-nominations-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(nominationsCsv(docs));
});

/* ---------- recovering emailed nominations (Resend's log) ---------- */

const RESEND_API = "https://api.resend.com";
const PAUSE_MS = 550; // Resend allows 2 requests a second
const FETCH_PER_CALL = 25; // nomination emails read per call (keeps each call well under a minute)
const PAGES_PER_CALL = 15;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resendGet(path) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`${RESEND_API}${path}`, { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } });
    if (r.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body?.message || `the email service answered ${r.status}`);
    return body;
  }
  throw new Error("the email service is rate-limiting us: try again in a minute");
}

router.post("/recover", requireManagement, async (req, res) => {
  if (!process.env.RESEND_API_KEY) return res.status(503).json({ error: "The email service isn't configured." });
  let cursor = typeof req.body?.cursor === "string" ? req.body.cursor : "";
  let done = false, found = 0, imported = 0, pages = 0;
  const batch = [];
  try {
    while (!done && pages < PAGES_PER_CALL && batch.length < FETCH_PER_CALL) {
      const page = await resendGet(`/emails?limit=100${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`);
      pages++;
      const list = Array.isArray(page?.data) ? page.data : [];
      for (const e of list) if (isNominationEmail(e)) batch.push(e);
      if (list.length) cursor = list[list.length - 1].id;
      done = !page?.has_more || !list.length;
      await sleep(PAUSE_MS);
    }
    found = batch.length;
    const known = new Set((await Nomination.find({ resendId: { $in: batch.map((e) => e.id) } }, { resendId: 1 }).lean()).map((n) => n.resendId));
    for (const e of batch) {
      if (known.has(e.id)) continue;
      const full = await resendGet(`/emails/${encodeURIComponent(e.id)}`);
      await sleep(PAUSE_MS);
      const doc = parseNominationEmail({ ...e, ...full });
      if (!doc) continue;
      // Saved by the website form too (before it kept the email id)? Same nominee + nominator within a day: link it instead.
      const at = doc.submittedAt.getTime();
      const twin = await Nomination.findOne({
        resendId: { $exists: false }, nomineeName: doc.nomineeName, nominatorEmail: doc.nominatorEmail,
        submittedAt: { $gte: new Date(at - 864e5), $lte: new Date(at + 864e5) },
      }).lean();
      if (twin) { await Nomination.updateOne({ _id: twin._id }, { $set: { resendId: doc.resendId } }); continue; }
      await Nomination.create({ ...doc, updatedBy: by(req) }).then(() => imported++, (err) => {
        if (err?.code !== 11000) throw err;
      });
    }
  } catch (err) {
    await audit(req, "nominations_recover_failed", "", String(err?.message || err));
    return res.status(502).json({ error: `Couldn't read the email log: ${err?.message || err}`, imported });
  }
  if (imported) await audit(req, "nominations_recover", "", `${imported} recovered from the email log`);
  res.json({ found, imported, cursor, done });
});

/* ---------- the winners on the website ---------- */

const WINNER_FIELDS = "status categoryType pillar sector specialAward nomineeType nomineeName nomineeOrganisation nomineeWebsite award";

router.get("/winners", async (req, res) => {
  const noms = await Nomination.find({ status: "winner" }).select(WINNER_FIELDS).lean();
  const rows = sortWinners(noms.map(winnerAdminRow));
  res.json({ live: await switchOn(WINNERS_KEY), rows });
});

router.patch("/:id/award", requireManagement, async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: "Nomination not found" });
  const patch = cleanAwardPatch(req.body);
  if (!patch.ok) return res.status(400).json({ error: patch.error });
  const before = await Nomination.findById(req.params.id).select(WINNER_FIELDS).lean();
  if (!before) return res.status(404).json({ error: "Nomination not found" });
  if (before.status !== "winner") return res.status(409).json({ error: "Only winners are shown on the website. Mark it as a winner first." });
  const set = Object.fromEntries(Object.entries(patch.set).map(([k, v]) => [`award.${k}`, v]));
  set["award.updatedBy"] = by(req);
  set["award.updatedAt"] = new Date();
  const n = await Nomination.findByIdAndUpdate(req.params.id, { $set: set }, { new: true }).select(WINNER_FIELDS).lean();
  forgetWinners();
  const what = Object.entries(patch.set).map(([k, v]) => (typeof v === "string" ? `${k} ${v ? `"${v.slice(0, 60)}"` : "(default)"}` : `${k} ${v}`)).join(", ");
  await audit(req, "award_winner_edit", n._id, `${n.nomineeName}: ${what}`);
  res.json({ row: winnerAdminRow(n) });
});

/** Jurors allocated to the nomination now, and assessments saved for it (submitted or draft, any allocation). */
async function juryCounts(id) {
  const rows = await JuryAssignment.find({ nomination: id }, { active: 1, "submission.submittedAt": 1, "draft.savedAt": 1 }).lean();
  return {
    assigned: rows.filter((a) => a.active).length,
    scored: rows.filter((a) => a.submission?.submittedAt || a.draft?.savedAt).length,
  };
}

const detailOf = async (n) => nominationDetail(n, { jury: await juryCounts(n._id) });

router.get("/:id", async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: "Nomination not found" });
  const n = await Nomination.findById(req.params.id).lean();
  if (!n) return res.status(404).json({ error: "Nomination not found" });
  res.json({ nomination: await detailOf(n), options: CATEGORY_OPTIONS });
});

/* ---------- the award category and the nominee's focus (management) ---------- */

const PARTS = {
  category: { same: sameCategory, of: categoryOf, text: categoryChangeText, label: "category" },
  focus: { same: sameFocus, of: focusOf, text: focusChangeText, label: "focus" },
};

/** What was submitted, kept once: only set while there's no `submitted` yet (a second change never overwrites it). */
async function keepSubmitted(before) {
  if (submittedOf(before)) return;
  await Nomination.updateOne({ _id: before._id, submitted: null }, { $set: { submitted: snapshotOf(before) } });
}

/**
 * Changes `parts` ({ category?: values, focus?: values }) on the nomination. `restore`: back to what was
 * submitted (the changed-by fields are cleared). → the response body, or null when it doesn't exist.
 */
async function change(req, before, parts, { note = "", restore = false } = {}) {
  const set = {};
  const lines = [];
  for (const [part, values] of Object.entries(parts)) {
    const P = PARTS[part];
    const was = P.of(before);
    // A restore clears who changed it even when the values already match (someone changed it back by hand).
    if (P.same(was, values) && !restore) continue;
    Object.assign(set, values);
    if (restore) Object.assign(set, { [`${part}ChangedBy`]: "", [`${part}ChangedAt`]: null, [`${part}Note`]: "" });
    else Object.assign(set, { [`${part}ChangedBy`]: by(req), [`${part}ChangedAt`]: new Date(), [`${part}Note`]: note });
    if (!P.same(was, values)) lines.push(`${P.label}: ${P.text(was, values)}`);
  }
  if (!Object.keys(set).length) return { nomination: await detailOf(before), changed: false };
  if (!restore) await keepSubmitted(before);
  const n = await Nomination.findByIdAndUpdate(before._id, { $set: { ...set, updatedBy: by(req) } }, { returnDocument: "after" }).lean();
  if (!n) return null;
  if (lines.length) {
    const action = restore ? "nomination_restore_submitted" : `nomination_${Object.keys(parts)[0]}`;
    await audit(req, action, n._id, `${restore ? "restored as submitted, " : ""}${lines.join("; ")}${note ? " (with a note)" : ""}`);
    forgetAwardApplications(); // the apps' category count follows at once on this server
  }
  return { nomination: await detailOf(n), changed: lines.length > 0 };
}

async function load(req, res) {
  if (!isId(req.params.id)) { res.status(404).json({ error: "Nomination not found" }); return null; }
  const n = await Nomination.findById(req.params.id).lean();
  if (!n) { res.status(404).json({ error: "Nomination not found" }); return null; }
  return n;
}

const send = (res, out) => (out ? res.json(out) : res.status(404).json({ error: "Nomination not found" }));

router.patch("/:id/category", requireManagement, async (req, res) => {
  const c = cleanCategoryChange(req.body || {});
  if (!c.ok) return res.status(400).json({ error: c.error });
  const before = await load(req, res);
  if (!before) return;
  send(res, await change(req, before, { category: c.set }, { note: c.note }));
});

router.patch("/:id/focus", requireManagement, async (req, res) => {
  const before = await load(req, res);
  if (!before) return;
  const c = cleanFocusChange(req.body || {}, before);
  if (!c.ok) return res.status(400).json({ error: c.error });
  send(res, await change(req, before, { focus: c.set }, { note: c.note }));
});

router.post("/:id/restore-submitted", requireManagement, async (req, res) => {
  const what = cleanRestoreWhat(req.body?.what);
  if (!what) return res.status(400).json({ error: 'what must be "category", "focus" or "both".' });
  const before = await load(req, res);
  if (!before) return;
  const sub = submittedOf(before);
  if (!sub) return res.status(409).json({ error: "Nothing to restore: this nomination is as it was submitted." });
  const parts = {};
  if (what !== "focus") parts.category = categoryOf(sub);
  if (what !== "category") parts.focus = focusOf(sub);
  send(res, await change(req, before, parts, { restore: true }));
});

router.patch("/:id", async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: "Nomination not found" });
  const patch = cleanNominationPatch(req.body || {});
  if (!patch.ok) return res.status(400).json({ error: patch.error });
  const before = await Nomination.findById(req.params.id, { status: 1, nomineeName: 1 }).lean();
  if (!before) return res.status(404).json({ error: "Nomination not found" });
  const set = { ...patch.set, updatedBy: by(req) };
  const statusChanged = set.status && set.status !== (before.status || "pending");
  if (statusChanged) set.statusChangedAt = new Date();
  const n = await Nomination.findByIdAndUpdate(req.params.id, { $set: set }, { new: true }).lean();
  const what = [statusChanged ? `status ${before.status || "pending"} → ${set.status}` : "", "adminNotes" in patch.set ? "notes" : ""]
    .filter(Boolean).join(", ") || "no change";
  if (statusChanged) forgetWinners();
  await audit(req, "nomination_edit", n._id, `${n.nomineeName}: ${what}`);
  res.json({ nomination: nominationDetail(n) });
});

router.delete("/:id", requireManagement, async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: "Nomination not found" });
  const n = await Nomination.findByIdAndDelete(req.params.id).lean();
  if (!n) return res.status(404).json({ error: "Nomination not found" });
  if (n.status === "winner") forgetWinners();
  await audit(req, "nomination_delete", n._id, `${n.nomineeName} (${n.nominatorEmail || "no email"})`);
  res.json({ deleted: true });
});

export default router;
