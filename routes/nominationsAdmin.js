import express from "express";
import Nomination from "../models/Nomination.js";
import { AdminAudit } from "../models/Admin.js";
import { requireAdmin, requireManagement } from "../middleware/adminAuth.js";
import {
  NOMINATION_STATUSES, cleanNominationPatch, isNominationEmail, nominationDetail, nominationRow, nominationsCsv,
  parseNominationEmail,
} from "../services/nominations.js";

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

router.get("/:id", async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: "Nomination not found" });
  const n = await Nomination.findById(req.params.id).lean();
  if (!n) return res.status(404).json({ error: "Nomination not found" });
  res.json({ nomination: nominationDetail(n) });
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
  await audit(req, "nomination_edit", n._id, `${n.nomineeName}: ${what}`);
  res.json({ nomination: nominationDetail(n) });
});

router.delete("/:id", requireManagement, async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: "Nomination not found" });
  const n = await Nomination.findByIdAndDelete(req.params.id).lean();
  if (!n) return res.status(404).json({ error: "Nomination not found" });
  await audit(req, "nomination_delete", n._id, `${n.nomineeName} (${n.nominatorEmail || "no email"})`);
  res.json({ deleted: true });
});

export default router;
