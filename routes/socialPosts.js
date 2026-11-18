import express from "express";
import mongoose from "mongoose";
import Anthropic from "@anthropic-ai/sdk";
import { requireAdmin, isManagement } from "../middleware/adminAuth.js";
import { AdminAudit } from "../models/Admin.js";
import AdminSetting from "../models/AdminSetting.js";
import MarketingPost from "../models/MarketingPost.js";
import { Contract } from "../models/Contract.js";
import {
  CHANNELS, CHANNEL_KEYS, SETTING_DEFAULTS, STATUS_LABELS, cleanPost, cleanSettings, costUsd, cropUrl, lengthFor,
  postProblems, statusOf, textFor, writerPrompt, writerSchema, writerSystem,
} from "../services/socialPosts.js";

/* =========================================================
   /api/console/social: Marketing › Social posts and the Social media calendar (Nov 18 2026).
   Any staff writes posts, asks Claude for X / Instagram / LinkedIn versions, submits for
   approval and marks posts posted (with the link). Management approves or sends back, and
   changes the settings (hashtags, voice, monthly writing limit, handles).
   Writing uses Claude Opus 5.5 through ANTHROPIC_API_KEY; with no key the panel says so.
   Spend is counted per month (AdminSetting social.usage.YYYY-MM) and stops at the limit.
   A post linked to a signed contract's promised post ticks that task when it's posted.
========================================================= */

const router = express.Router();
router.use(requireAdmin);

const MODEL = "claude-opus-5-5";
const who = (req) => String(req.user?.name || req.user?.email || "Staff").slice(0, 120);
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error("SOCIAL POSTS ERROR:", err?.message || err);
  res.status(500).json({ error: "Something went wrong. Try again." });
});
const audit = (req, action, id, detail) =>
  AdminAudit.create({ adminId: req.user._id, adminName: req.user.name, action, targetType: "social_post",
                      targetId: String(id).slice(0, 120), detail: String(detail).slice(0, 500) }).catch(() => {});
const managementOnly = (req, res, next) =>
  isManagement(req.user) ? next() : res.status(403).json({ error: "Management only", code: "management_only" });

/* Swappable in tests: () => an Anthropic client, or null when there's no key. */
export const socialDeps = {
  claude: () => (process.env.ANTHROPIC_API_KEY ? new Anthropic() : null),
};

const SETTINGS_KEY = "social.settings";
async function loadSettings() {
  const row = await AdminSetting.findOne({ key: SETTINGS_KEY }).lean();
  return { ...SETTING_DEFAULTS, ...(row?.value || {}), handles: { ...SETTING_DEFAULTS.handles, ...(row?.value?.handles || {}) } };
}
const monthKey = (d = new Date()) => `social.usage.${d.toISOString().slice(0, 7)}`;
async function usageNow() {
  const row = await AdminSetting.findOne({ key: monthKey() }).lean();
  return { costUsd: Math.round((row?.value?.costUsd || 0) * 10000) / 10000, calls: row?.value?.calls || 0 };
}
async function addUsage(cost) {
  await AdminSetting.updateOne({ key: monthKey() },
    { $inc: { "value.costUsd": cost, "value.calls": 1 }, $setOnInsert: { module: "social", valueType: "json" } }, { upsert: true });
}

/** A post as the panel shows it. */
function view(p, now = Date.now()) {
  const status = statusOf(p, now);
  return {
    ...p, id: String(p._id), status, statusLabel: STATUS_LABELS[status],
    texts: Object.fromEntries(CHANNEL_KEYS.map((c) => [c, textFor(p, c)])),
    lengths: Object.fromEntries(CHANNEL_KEYS.map((c) => [c, lengthFor(c, textFor(p, c))])),
    crops: p.image?.url ? Object.fromEntries(CHANNEL_KEYS.map((c) => [c, cropUrl(p.image.url, c)])) : null,
    problems: postProblems(p),
  };
}

const load = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) { res.status(404).json({ error: "Not found" }); return null; }
  const p = await MarketingPost.findById(req.params.id).lean();
  if (!p) res.status(404).json({ error: "Not found" });
  return p;
};

/* ---------- settings ---------- */
router.get("/settings", wrap(async (req, res) => {
  res.json({ settings: await loadSettings(), usage: await usageNow(), writing: !!socialDeps.claude(), model: MODEL,
             channels: CHANNELS, canEdit: isManagement(req.user) });
}));

router.put("/settings", managementOnly, wrap(async (req, res) => {
  const { value, error } = cleanSettings(req.body);
  if (error) return res.status(400).json({ error });
  await AdminSetting.findOneAndUpdate({ key: SETTINGS_KEY },
    { key: SETTINGS_KEY, module: "social", value, valueType: "json", updatedBy: who(req) }, { upsert: true });
  audit(req, "social_settings", SETTINGS_KEY, `monthly writing limit $${value.monthlyBudgetUsd}`);
  res.json({ settings: value });
}));

/* ---------- writing with Claude ----------
   POST /write { channels: ["x","instagram"] | ["linkedin"], main?, source?, instruction?, previous?: {x: [..]}, eventName? }
   → { texts: { x: "…" }, usage } */
router.post("/write", wrap(async (req, res) => {
  const client = socialDeps.claude();
  if (!client) return res.status(503).json({ error: "Writing with Claude isn't set up yet: the server needs an Anthropic API key (ANTHROPIC_API_KEY).", code: "no_key" });
  const settings = await loadSettings();
  const usage = await usageNow();
  if (settings.monthlyBudgetUsd <= 0 || usage.costUsd >= settings.monthlyBudgetUsd) {
    return res.status(429).json({ error: `This month's writing limit ($${settings.monthlyBudgetUsd}) is used up. Management can raise it in Settings.`, code: "budget" });
  }
  const channels = [...new Set((req.body?.channels || []).filter((c) => CHANNEL_KEYS.includes(c)))];
  if (!channels.length) return res.status(400).json({ error: "Pick a channel to write for." });
  const main = String(req.body?.main || "").slice(0, 3000);
  const source = String(req.body?.source || "").slice(0, 8000);
  if (!main.trim() && !source.trim()) return res.status(400).json({ error: "Write the main post or pick something to write about first." });
  const previous = {};
  for (const c of channels) previous[c] = (req.body?.previous?.[c] || []).slice(-5).map((t) => String(t).slice(0, 3000));

  let response;
  try {
    response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: writerSchema(channels) } },
      system: [{ type: "text", text: writerSystem(settings), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: writerPrompt({ source, main, channels, previous,
        instruction: String(req.body?.instruction || "").slice(0, 500), eventName: String(req.body?.eventName || "").slice(0, 160) }) }],
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return res.status(429).json({ error: "Claude is busy. Try again in a minute." });
    if (err instanceof Anthropic.AuthenticationError) return res.status(503).json({ error: "The Anthropic API key on the server isn't valid.", code: "no_key" });
    console.error("SOCIAL WRITE ERROR:", err?.status || "", err?.message || err);
    return res.status(502).json({ error: "Claude couldn't write that just now. Try again." });
  }
  await addUsage(costUsd(response.usage));
  if (response.stop_reason === "refusal") return res.status(422).json({ error: "Claude declined to write this one. Try rewording the main post." });
  const text = (response.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  let out;
  try { out = JSON.parse(text); } catch { return res.status(502).json({ error: "Claude's answer couldn't be read. Try again." }); }
  const texts = Object.fromEntries(channels.map((c) => [c, String(out?.[c] || "").trim()]));
  res.json({ texts, lengths: Object.fromEntries(channels.map((c) => [c, lengthFor(c, texts[c])])), usage: await usageNow() });
}));

/* ---------- posts ---------- */
router.get("/posts", wrap(async (req, res) => {
  const q = {};
  if (req.query.eventKey) q.eventKey = String(req.query.eventKey);
  const rows = await MarketingPost.find(q).sort({ scheduledAt: 1, updatedAt: -1 }).limit(500).lean();
  const now = Date.now();
  res.json({ posts: rows.map((p) => view(p, now)), statuses: STATUS_LABELS, isManagement: isManagement(req.user) });
}));

router.get("/posts/:id", wrap(async (req, res) => {
  const p = await load(req, res); if (!p) return;
  res.json({ post: view(p) });
}));

router.post("/posts", wrap(async (req, res) => {
  const { value, error } = cleanPost(req.body);
  if (error) return res.status(400).json({ error });
  const p = await MarketingPost.create({ ...value, createdBy: who(req), createdById: String(req.user._id), updatedBy: who(req) });
  audit(req, "social_post_create", p._id, value.title || value.text.slice(0, 60));
  res.status(201).json({ post: view(p.toObject()) });
}));

const CONTENT_FIELDS = ["text", "channels", "versions", "image"];
router.patch("/posts/:id", wrap(async (req, res) => {
  const p = await load(req, res); if (!p) return;
  const { value, error } = cleanPost({ ...p, ...req.body });
  if (error) return res.status(400).json({ error });
  const set = { ...value, updatedBy: who(req) };
  // A change to what gets posted goes back for approval, unless management made it.
  const changed = CONTENT_FIELDS.some((k) => JSON.stringify(value[k] ?? null) !== JSON.stringify(cleanPost(p).value?.[k] ?? null));
  if (changed && ["pending", "approved"].includes(p.review?.state) && !isManagement(req.user)) set.review = { ...p.review, state: "" };
  const saved = await MarketingPost.findByIdAndUpdate(p._id, set, { new: true }).lean();
  res.json({ post: view(saved) });
}));

router.delete("/posts/:id", wrap(async (req, res) => {
  const p = await load(req, res); if (!p) return;
  if (String(p.createdById) !== String(req.user._id) && !isManagement(req.user)) return res.status(403).json({ error: "Only whoever wrote it, or management, can delete it." });
  if (CHANNEL_KEYS.some((c) => p.posted?.[c]?.at)) return res.status(409).json({ error: "It's already posted, so it stays on the calendar." });
  await MarketingPost.deleteOne({ _id: p._id });
  audit(req, "social_post_delete", p._id, p.title || String(p.text || "").slice(0, 60));
  res.json({ ok: true });
}));

router.post("/posts/:id/submit", wrap(async (req, res) => {
  const p = await load(req, res); if (!p) return;
  const problems = postProblems(p);
  if (problems.length) return res.status(400).json({ error: problems.join(" ") });
  const to = (Array.isArray(req.body?.to) ? req.body.to : []).map((n) => String(n).slice(0, 80)).slice(0, 10);
  const saved = await MarketingPost.findByIdAndUpdate(p._id,
    { review: { state: "pending", to, requestedBy: who(req), requestedAt: new Date() }, updatedBy: who(req) }, { new: true }).lean();
  audit(req, "social_post_submit", p._id, `sent for approval${to.length ? ` to ${to.join(", ")}` : ""}`);
  res.json({ post: view(saved) });
}));

router.post("/posts/:id/review", managementOnly, wrap(async (req, res) => {
  const p = await load(req, res); if (!p) return;
  const decision = String(req.body?.decision || "");
  const state = { approve: "approved", changes: "changes", reject: "rejected" }[decision];
  if (!state) return res.status(400).json({ error: "Approve, request changes or reject." });
  if (state === "approved") { const problems = postProblems(p); if (problems.length) return res.status(400).json({ error: problems.join(" ") }); }
  const saved = await MarketingPost.findByIdAndUpdate(p._id,
    { review: { ...(p.review || {}), state, by: who(req), at: new Date(), note: String(req.body?.note || "").slice(0, 1000) }, updatedBy: who(req) }, { new: true }).lean();
  audit(req, `social_post_${decision}`, p._id, p.title || String(p.text || "").slice(0, 60));
  res.json({ post: view(saved) });
}));

/* Mark a channel posted (by hand for now) with the post's link; { posted: false } takes it back. */
router.post("/posts/:id/posted", wrap(async (req, res) => {
  const p = await load(req, res); if (!p) return;
  const channel = String(req.body?.channel || "");
  if (!CHANNEL_KEYS.includes(channel) || !p.channels?.[channel]) return res.status(400).json({ error: "Pick a channel this post goes to." });
  if (req.body?.posted === false) {
    const saved = await MarketingPost.findByIdAndUpdate(p._id, { $unset: { [`posted.${channel}`]: 1 }, updatedBy: who(req) }, { new: true }).lean();
    return res.json({ post: view(saved) });
  }
  if (p.review?.state !== "approved") return res.status(409).json({ error: "It needs approval before it's posted." });
  const url = String(req.body?.url || "").trim().slice(0, 500);
  if (url && !/^https:\/\/\S+$/i.test(url)) return res.status(400).json({ error: "The link starts with https://" });
  const saved = await MarketingPost.findByIdAndUpdate(p._id, { [`posted.${channel}`]: { at: new Date(), url, by: who(req) }, updatedBy: who(req) }, { new: true }).lean();
  // The contract's promised post: ticked once, with the first link.
  if (p.contractRef?.contractId && mongoose.isValidObjectId(p.contractRef.contractId)) {
    await Contract.updateOne(
      { _id: p.contractRef.contractId, status: "signed", deliverables: { $elemMatch: { key: p.contractRef.key, done: false } } },
      { $set: { "deliverables.$.done": true, "deliverables.$.doneAt": new Date(), "deliverables.$.doneBy": who(req), "deliverables.$.link": url } },
    ).catch(() => {});
  }
  audit(req, "social_post_posted", p._id, `${channel}${url ? ` ${url}` : ""}`);
  res.json({ post: view(saved) });
}));

/* ---------- calendar ----------
   GET /calendar?from=YYYY-MM-DD&to=YYYY-MM-DD → { posts, promised, unscheduled, kpis } */
router.get("/calendar", wrap(async (req, res) => {
  const from = new Date(`${String(req.query.from || "").slice(0, 10)}T00:00:00-05:00`);
  const to = new Date(`${String(req.query.to || "").slice(0, 10)}T23:59:59-05:00`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return res.status(400).json({ error: "Give a date range." });
  const [inRange, unscheduledRows, contracts, linked] = await Promise.all([
    MarketingPost.find({ scheduledAt: { $gte: from, $lte: to } }).sort({ scheduledAt: 1 }).lean(),
    MarketingPost.find({ scheduledAt: null }).sort({ updatedAt: -1 }).limit(50).lean(),
    Contract.find({ status: "signed", deliverables: { $elemMatch: { category: "social", done: false } } },
                  { number: 1, company: 1, eventName: 1, deliverables: 1 }).lean(),
    MarketingPost.find({ "contractRef.contractId": { $exists: true, $ne: null } }, { contractRef: 1 }).lean(),
  ]);
  const taken = new Set(linked.map((p) => `${p.contractRef?.contractId}:${p.contractRef?.key}`));
  const promised = [];
  for (const c of contracts) for (const d of c.deliverables || []) {
    if (d.category !== "social" || d.done || taken.has(`${c._id}:${d.key}`)) continue;
    promised.push({ contractId: String(c._id), key: d.key, label: `${d.label} · ${c.company?.name || ""}`.trim(), number: c.number,
                    company: c.company?.name || "", dueDate: d.dueDate || "", owner: d.owner || "" });
  }
  const now = Date.now();
  const posts = inRange.map((p) => view(p, now));
  const count = (s) => posts.filter((p) => s.includes(p.status)).length;
  const done = count(["posted", "late"]);
  const due = posts.filter((p) => new Date(p.scheduledAt).getTime() <= now).length;
  res.json({
    posts, unscheduled: unscheduledRows.map((p) => view(p, now)), promised, statuses: STATUS_LABELS,
    kpis: {
      planned: posts.length + promised.filter((x) => x.dueDate && x.dueDate >= String(req.query.from) && x.dueDate <= String(req.query.to)).length,
      onTime: count(["posted"]), due, posted: done,
      lateOrMissed: count(["late", "missed"]), late: count(["late"]), missed: count(["missed"]),
      upcoming: count(["scheduled", "approved", "review", "draft", "changes"]),
      scheduled: count(["scheduled"]), review: count(["review"]), planned2: count(["draft", "changes"]),
    },
  });
}));

export default router;
