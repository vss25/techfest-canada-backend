import express from "express";
import mongoose from "mongoose";
import Lead from "../models/Lead.js";
import User from "../models/User.js";
import Commitment from "../models/Commitment.js";
import JobLock from "../models/JobLock.js";
import AdminSetting from "../models/AdminSetting.js";
import { AdminAudit } from "../models/Admin.js";
import { requireAdmin, isManagement } from "../middleware/adminAuth.js";
import { sendFormSubmissionEmail } from "../services/emailService.js";
import { torontoDay } from "../services/commitments.js";
import { LEAD_STATUSES, cleanStatus, fromExplee, hotLeadsEmail, hotLeadsUrl, isNewerReply, leadDTO, nextCursor } from "../services/explee.js";

/* =========================================================
   Sales › Hot leads (Nov 20 2026): Explee's hot leads, synced by themselves.
   Mounted at /api/console/explee before the console router; any staff.

     GET  /           → { configured, sync: { lastRunAt, lastCount, lastError, total }, leads, statuses, people, me }
     PATCH /leads/:id { status?, ownerId?, notes? } → { lead }
     POST /sync       → { added, updated, removed }  (management: check now instead of waiting)

   The sync (every 10 minutes, one server: JobLock "explee-sync"; off until EXPLEE_API_KEY is
   set on the server): new hot leads become Lead rows (source "explee", matched on Explee's
   person_id) and each gets a task with no owner yet, "Reply to hot lead: …", due today, so it
   shows in Home › My work until someone takes it. A lead who replies again is updated and the
   reply added to their history; their status and owner are never overwritten. A lead Explee
   says asked to be removed has their details wiped here too. One email per sync with new leads
   goes to the sales inbox. The cursor (newest became_hot_at) is AdminSetting "explee.sync".
   Nothing logs a lead's name, email or reply. Private: MongoDB only.
========================================================= */

const router = express.Router();
export default router;

/** Replaced in tests. */
export const expleeDeps = {
  fetch: (url, opts) => fetch(url, opts),
  send: (mail) => sendFormSubmissionEmail(mail),
  key: () => String(process.env.EXPLEE_API_KEY || "").trim(),
};

const SYNC_KEY = "explee.sync";
const JOB_ID = "explee-sync";
const INSTANCE = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const FIRST_LOOKBACK_DAYS = 30;
const link = (path) => `${String(process.env.FRONTEND_URL || "https://www.thetechfestival.com").replace(/\/$/, "")}/admin/${path}`;
const salesInbox = () => String(process.env.BROCHURE_SALES_INBOX || "sales@thetechfestival.com").split(",").map((s) => s.trim()).filter(Boolean);

async function readState() { return (await AdminSetting.findOne({ key: SYNC_KEY }).lean())?.value || {}; }
const writeState = (value) => AdminSetting.findOneAndUpdate({ key: SYNC_KEY },
  { key: SYNC_KEY, module: "explee", value, valueType: "json", updatedBy: "Explee sync" }, { upsert: true });

/** Fetch what's new and store it → { added, updated, removed }. Throws when Explee can't be read. */
export async function syncHotLeads({ now = new Date() } = {}) {
  const key = expleeDeps.key();
  if (!key) return { skipped: "no_key" };
  const state = await readState();
  const since = state.since || new Date(now.getTime() - FIRST_LOOKBACK_DAYS * 86400000).toISOString();
  const all = [];
  for (let offset = 0, page = 0; page < 20; page++) {
    const r = await expleeDeps.fetch(hotLeadsUrl({ since, offset, projectId: process.env.EXPLEE_PROJECT_ID }), { headers: { "X-API-Key": key, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? "Explee refused the API key." : `Explee answered ${r.status}.`);
    const body = await r.json();
    all.push(...(Array.isArray(body?.leads) ? body.leads : []));
    if (!body?.has_more || body.next_offset == null) break;
    offset = body.next_offset;
  }
  const out = { added: 0, updated: 0, removed: 0 };
  const fresh = [];
  for (const raw of all) {
    const l = fromExplee(raw);
    if (!l) continue;
    const existing = await Lead.findOne({ expleePersonId: l.personId });
    if (l.erased) {
      // They asked Explee to remove them: keep the row (so it isn't re-added) with nothing personal on it.
      if (existing && existing.leadName !== "Removed at their request") {
        Object.assign(existing, { leadName: "Removed at their request", email: "", phone: "", linkedin: "", jobTitle: "", companyName: "", company_domain: "",
          website: "", country: "", notes: "", hotReply: "", contactLog: [], status: "lost" });
        await existing.save(); out.removed++;
      }
      continue;
    }
    if (!existing) {
      let doc;
      try {
        doc = await Lead.create({ ...l.contact, ...l.hot, source: "explee", expleePersonId: l.personId, status: "new", score: 90, contactMethod: "Email" });
      } catch (err) { if (err?.code === 11000) continue; throw err; }   // another server added it
      await Commitment.create({ title: `Reply to hot lead: ${l.contact.leadName}${l.contact.companyName ? ` (${l.contact.companyName})` : ""}`.slice(0, 200),
        area: "sales", about: l.contact.companyName || l.contact.leadName, dueDate: torontoDay(now), source: "explee", createdByName: "Explee",
        notes: "They replied with interest to our outreach. Open Sales › Hot leads to read their reply, then take this task and answer them." }).catch(() => {});
      fresh.push(doc.toObject()); out.added++;
    } else if (isNewerReply(existing, l)) {
      existing.contactLog.push({ date: (l.hot.repliedAt || l.hot.becameHotAt).toISOString().slice(0, 10), method: "Explee reply", notes: l.hot.hotReply });
      Object.assign(existing, l.hot);
      // Details we didn't have yet are filled in; nothing staff typed is replaced.
      for (const [k, v] of Object.entries(l.contact)) if (v && !existing[k]) existing[k] = v;
      await existing.save(); out.updated++;
    }
  }
  await writeState({ since: nextCursor(since, all) || since, lastRunAt: now.toISOString(), lastCount: out.added + out.updated, lastError: "" });
  if (fresh.length) Promise.resolve().then(() => expleeDeps.send({ to: salesInbox(), ...hotLeadsEmail(fresh, link("hot-leads")) }))
    .catch((err) => console.error("EXPLEE EMAIL ERROR:", err?.message || err));
  return out;
}

async function runSafely(now = new Date()) {
  try { return await syncHotLeads({ now }); }
  catch (err) {
    const state = await readState().catch(() => ({}));
    await writeState({ ...state, lastRunAt: now.toISOString(), lastError: String(err?.message || "Couldn't reach Explee.").slice(0, 200) }).catch(() => {});
    console.error("EXPLEE SYNC ERROR:", err?.message || err);
    return { error: String(err?.message || "Couldn't reach Explee.") };
  }
}

export function startExpleeSync({ everyMs = 10 * 60 * 1000 } = {}) {
  const tick = async () => {
    if (!expleeDeps.key()) return;
    try {
      const now = new Date();
      const r = await JobLock.findOneAndUpdate({ _id: JOB_ID, until: { $lte: now } },
        { $set: { until: new Date(now.getTime() + everyMs - 30000), owner: INSTANCE } },
        { upsert: true, returnDocument: "after", projection: { owner: 1 } }).lean();
      if (r?.owner !== INSTANCE) return;
    } catch (err) { if (err?.code === 11000) return; console.error("EXPLEE LOCK ERROR:", err?.message || err); return; }
    const out = await runSafely();
    if (out?.added || out?.updated || out?.removed) console.log(`EXPLEE SYNC: ${out.added} new, ${out.updated} updated, ${out.removed} removed`);
  };
  const t = setInterval(tick, everyMs);
  t.unref?.();
  setTimeout(tick, 15000).unref?.();
  return t;
}

/* ---------------- The page ---------------- */

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error("EXPLEE ROUTE ERROR:", err?.message || err);
  if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Try again." });
});

router.use(requireAdmin);

router.get("/", wrap(async (req, res) => {
  const [rows, state, people] = await Promise.all([
    Lead.find({ source: "explee", leadName: { $ne: "Removed at their request" } }).sort({ becameHotAt: -1 }).limit(500).lean(),
    readState(),
    User.find({ role: "admin", banned: { $ne: true } }).select("name email").lean(),
  ]);
  res.json({
    configured: !!expleeDeps.key(),
    sync: { lastRunAt: state.lastRunAt || null, lastCount: state.lastCount || 0, lastError: state.lastError || "", total: rows.length },
    leads: rows.map(leadDTO), statuses: LEAD_STATUSES, me: String(req.user._id), canSync: isManagement(req.user),
    people: people.map((u) => ({ id: String(u._id), name: u.name || u.email })).sort((a, b) => a.name.localeCompare(b.name)),
  });
}));

router.patch("/leads/:id", wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const lead = await Lead.findOne({ _id: req.params.id, source: "explee" });
  if (!lead) return res.status(404).json({ error: "Not found" });
  const b = req.body || {};
  const changed = [];
  if ("status" in b) {
    const s = cleanStatus(b.status);
    if (!s) return res.status(400).json({ error: "Pick a status from the list." });
    lead.status = s; changed.push(`status ${s}`);
    if (s !== "new") { lead.lastContactedAt = lead.lastContactedAt || new Date(); lead.lastContactedBy = lead.lastContactedBy || req.user.name; }
  }
  if ("ownerId" in b) {
    if (!b.ownerId) Object.assign(lead, { assignedTo: null, assignedToName: null, assignedAt: null });
    else {
      const u = mongoose.isValidObjectId(b.ownerId) ? await User.findOne({ _id: b.ownerId, role: "admin" }).select("name email").lean() : null;
      if (!u) return res.status(400).json({ error: "Pick a staff member from the list." });
      Object.assign(lead, { assignedTo: String(u._id), assignedToName: u.name || u.email, assignedAt: new Date() });
      // Their "Reply to hot lead" task follows the lead's owner.
      await Commitment.updateMany({ source: "explee", status: "open", ownerId: null, about: lead.companyName || lead.leadName, title: new RegExp(`^Reply to hot lead: ${lead.leadName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) },
        { $set: { ownerId: u._id, ownerName: u.name || u.email } }).catch(() => {});
    }
    changed.push("owner");
  }
  if ("notes" in b) { lead.notes = String(b.notes ?? "").slice(0, 4000); changed.push("notes"); }
  await lead.save();
  AdminAudit.create({ adminId: req.user._id, adminName: req.user.name, action: "hot_lead_edit", targetType: "lead", targetId: String(lead._id), detail: changed.join(", ") }).catch(() => {});
  res.json({ lead: leadDTO(lead.toObject()) });
}));

router.post("/sync", wrap(async (req, res) => {
  if (!isManagement(req.user)) return res.status(403).json({ error: "Management only", code: "management_only" });
  if (!expleeDeps.key()) return res.status(409).json({ error: "Explee isn't connected yet: the server needs its API key (EXPLEE_API_KEY).", code: "no_key" });
  const out = await runSafely();
  if (out.error) return res.status(502).json({ error: out.error });
  res.json(out);
}));
