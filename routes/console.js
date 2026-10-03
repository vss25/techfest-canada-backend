import express from "express";
import mongoose from "mongoose";
import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import { requireAdmin } from "../middleware/adminAuth.js";
import {
  SocialPost, SocialComment, SocialConnection, SocialMessage, SessionRegistration, SessionQuestion,
} from "../models/Social.js";
import { Discussion, DiscussionReply, CommunityGroup, GroupMessage } from "../models/Community.js";
import { AppEvent, AppContent, AdminAudit, Report } from "../models/Admin.js";
import { CONTENT_KEYS, cleanContent, summarize } from "../services/adminHelpers.js";
import { deleteAccount } from "../services/accountDeletion.js";
import { trimBody, threadKey } from "../services/socialHelpers.js";

/* =========================================================
   /api/console — the TTFC admin console (staff only).
   Everything here is restricted to role "admin". Viewing a
   person's private messages and every change is written to the
   audit log, which the console also shows.
========================================================= */

const router = express.Router();
router.use(requireAdmin);

const isId = (s) => mongoose.isValidObjectId(String(s || ""));
const rx = (q) => new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

async function audit(req, action, targetType = "", targetId = "", detail = "") {
  await AdminAudit.create({ adminId: req.user._id, adminName: req.user.name, action, targetType,
                            targetId: String(targetId), detail: String(detail).slice(0, 500) }).catch(() => {});
}

/* ---------- Overview ---------- */
router.get("/stats", async (req, res) => {
  const day = new Date(Date.now() - 864e5);
  const week = new Date(Date.now() - 7 * 864e5);
  const [users, ticketHolders, guests, posts, messages, groups, discussions, openReports,
         activeToday, activeWeek, eventsToday, topScreens, topTaps] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments({ "tickets.0": { $exists: true } }),
    Attendee.countDocuments({ claimedBy: { $exists: false } }),
    SocialPost.countDocuments({}),
    SocialMessage.countDocuments({}),
    CommunityGroup.countDocuments({}),
    Discussion.countDocuments({}),
    Report.countDocuments({ status: "open" }),
    AppEvent.distinct("userId", { at: { $gte: day }, userId: { $ne: null } }).then((a) => a.length),
    AppEvent.distinct("userId", { at: { $gte: week }, userId: { $ne: null } }).then((a) => a.length),
    AppEvent.countDocuments({ at: { $gte: day } }),
    AppEvent.aggregate([{ $match: { name: "screen_view", at: { $gte: week } } },
      { $group: { _id: "$screen", n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 10 }]),
    AppEvent.aggregate([{ $match: { name: "tap", at: { $gte: week } } },
      { $group: { _id: { s: "$screen", t: "$target" }, n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 10 }]),
  ]);
  res.json({ users, ticketHolders, guests, posts, messages, groups, discussions, openReports,
             activeToday, activeWeek, eventsToday,
             topScreens: topScreens.map((x) => ({ key: x._id || "(none)", count: x.n })),
             topTaps: topTaps.map((x) => ({ key: `${x._id.s} › ${x._id.t}`, count: x.n })) });
});

/* ---------- People ---------- */
router.get("/users", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const filter = q ? { $or: [{ name: rx(q) }, { email: rx(q) }, { organization: rx(q) }, { "tickets.ticketId": q.toLowerCase() }] } : {};
  if (req.query.role) filter.role = String(req.query.role);
  if (req.query.banned === "true") filter.banned = true;
  const page = Math.max(0, Number(req.query.page) || 0);
  const [rows, total] = await Promise.all([
    User.find(filter).select("name email role jobTitle organization topics tickets banned lastActiveAt createdAt provider")
      .sort({ lastActiveAt: -1, createdAt: -1 }).skip(page * 50).limit(50).lean(),
    User.countDocuments(filter),
  ]);
  res.json({ total, page, users: rows.map((u) => ({
    id: String(u._id), name: u.name, email: u.email, role: u.role, jobTitle: u.jobTitle, organization: u.organization,
    topics: u.topics || [], tickets: (u.tickets || []).length, banned: !!u.banned, provider: u.provider,
    lastActiveAt: u.lastActiveAt, createdAt: u.createdAt,
  })) });
});

router.get("/users/:id", async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const u = await User.findById(req.params.id).select("-password -resetPasswordToken -resetPasswordExpires").lean();
  if (!u) return res.status(404).json({ error: "Not found" });
  const id = u._id;
  const [events, posts, comments, connections, msgCount, regs, groups, discussions, reportsAbout, reportsBy] = await Promise.all([
    AppEvent.find({ userId: id }).sort({ at: -1 }).limit(500).lean(),
    SocialPost.find({ authorId: id }).sort({ createdAt: -1 }).limit(50).lean(),
    SocialComment.find({ authorId: id }).sort({ createdAt: -1 }).limit(50).lean(),
    SocialConnection.find({ $or: [{ fromUserId: id }, { toUserId: id }] }).lean(),
    SocialMessage.countDocuments({ $or: [{ fromUserId: id }, { toUserId: id }] }),
    SessionRegistration.find({ userId: id }).lean(),
    CommunityGroup.find({ members: id }).select("name").lean(),
    Discussion.find({ authorId: id }).select("title status createdAt").lean(),
    Report.find({ targetId: String(id) }).lean(),
    Report.find({ reporterId: id }).lean(),
  ]);
  const peerIds = connections.map((c) => (String(c.fromUserId) === String(id) ? c.toUserId : c.fromUserId));
  const peers = await User.find({ _id: { $in: peerIds } }).select("name organization").lean();
  const peerName = Object.fromEntries(peers.map((p) => [String(p._id), `${p.name}${p.organization ? " · " + p.organization : ""}`]));
  res.json({
    user: { ...u, id: String(u._id) },
    activity: summarize(events),
    events: events.slice(0, 200),
    posts, comments, discussions, groups: groups.map((g) => g.name),
    sessions: regs.map((r) => r.sessionId),
    connections: connections.map((c) => {
      const other = String(c.fromUserId) === String(id) ? c.toUserId : c.fromUserId;
      return { id: String(c._id), with: peerName[String(other)] || String(other), withId: String(other), status: c.status, kind: c.kind, createdAt: c.createdAt };
    }),
    messageCount: msgCount,
    reportsAbout, reportsBy,
  });
});

const EDITABLE = ["name", "email", "jobTitle", "organization", "linkedinUrl", "country", "fieldOfWork", "topics", "role", "banned", "bannedReason", "directoryHidden"];
router.patch("/users/:id", async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const u = await User.findById(req.params.id);
  if (!u) return res.status(404).json({ error: "Not found" });
  const changed = [];
  for (const k of EDITABLE) {
    if (req.body?.[k] === undefined) continue;
    let v = req.body[k];
    if (k === "topics") v = Array.isArray(v) ? v.filter((t) => typeof t === "string").slice(0, 20) : u.topics;
    else if (k === "banned" || k === "directoryHidden") v = v === true || v === "true";
    else if (k === "role") v = v === "admin" ? "admin" : "user";
    else if (k === "email") v = String(v).trim().toLowerCase().slice(0, 200);
    else v = String(v).slice(0, 300);
    if (JSON.stringify(u[k]) !== JSON.stringify(v)) { u[k] = v; changed.push(k); }
  }
  await u.save();
  if (changed.length) await audit(req, "edit_user", "user", u._id, changed.join(", "));
  res.json({ ok: true, changed });
});

router.delete("/users/:id", async (req, res) => {
  if (!isId(req.params.id) || String(req.params.id) === String(req.user._id)) return res.status(400).json({ error: "Can't delete this account" });
  const ok = await deleteAccount(req.params.id);
  if (ok) await audit(req, "delete_user", "user", req.params.id);
  res.json({ deleted: ok });
});

router.get("/users/:id/events", async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const before = req.query.before ? new Date(String(req.query.before)) : new Date();
  const events = await AppEvent.find({ userId: req.params.id, at: { $lt: before } }).sort({ at: -1 }).limit(200).lean();
  res.json(events);
});

/* Private messages: listing threads and opening one are audited. */
router.get("/users/:id/threads", async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const id = new mongoose.Types.ObjectId(req.params.id);
  const rows = await SocialMessage.aggregate([
    { $match: { $or: [{ fromUserId: id }, { toUserId: id }] } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: "$threadKey", last: { $first: "$body" }, at: { $first: "$createdAt" }, n: { $sum: 1 } } },
    { $sort: { at: -1 } }, { $limit: 100 },
  ]);
  const otherIds = rows.map((r) => r._id.split(":").find((x) => x !== req.params.id)).filter(isId);
  const others = await User.find({ _id: { $in: otherIds } }).select("name").lean();
  const nm = Object.fromEntries(others.map((o) => [String(o._id), o.name]));
  await audit(req, "list_threads", "user", req.params.id);
  res.json(rows.map((r) => {
    const other = r._id.split(":").find((x) => x !== req.params.id);
    return { threadKey: r._id, otherId: other, otherName: nm[other] || "Deleted user", last: r.last, at: r.at, count: r.n };
  }));
});

router.get("/threads/:key", async (req, res) => {
  const key = String(req.params.key);
  const [a, b] = key.split(":");
  if (!isId(a) || !isId(b) || threadKey(a, b) !== key) return res.status(400).json({ error: "Bad thread" });
  const [msgs, users] = await Promise.all([
    SocialMessage.find({ threadKey: key }).sort({ createdAt: 1 }).limit(1000).lean(),
    User.find({ _id: { $in: [a, b] } }).select("name").lean(),
  ]);
  const nm = Object.fromEntries(users.map((u) => [String(u._id), u.name]));
  await audit(req, "view_messages", "thread", key, `${nm[a] || a} ↔ ${nm[b] || b}`);
  res.json(msgs.map((m) => ({ id: String(m._id), from: nm[String(m.fromUserId)] || "Deleted user", fromId: String(m.fromUserId),
                              body: m.body, status: m.status, at: m.createdAt })));
});

/* ---------- Activity stream ---------- */
router.get("/events", async (req, res) => {
  const filter = {};
  if (req.query.name) filter.name = String(req.query.name);
  if (req.query.screen) filter.screen = String(req.query.screen);
  const before = req.query.before ? new Date(String(req.query.before)) : new Date();
  filter.at = { $lt: before };
  const events = await AppEvent.find(filter).sort({ at: -1 }).limit(200).lean();
  const ids = [...new Set(events.map((e) => String(e.userId || "")).filter(isId))];
  const users = await User.find({ _id: { $in: ids } }).select("name").lean();
  const nm = Object.fromEntries(users.map((u) => [String(u._id), u.name]));
  res.json(events.map((e) => ({ ...e, userName: e.userId ? nm[String(e.userId)] || "Deleted user" : "Signed out" })));
});

/* ---------- Content moderation ---------- */
const MODELS = {
  post: [SocialPost, "body"], comment: [SocialComment, "body"], message: [SocialMessage, "body"],
  discussion: [Discussion, "title"], reply: [DiscussionReply, "body"], group: [CommunityGroup, "name"],
  groupMessage: [GroupMessage, "body"], question: [SessionQuestion, "body"],
};

router.get("/content/:type", async (req, res) => {
  const m = MODELS[req.params.type]; if (!m || req.params.type === "message") return res.status(404).json({ error: "Unknown type" });
  const filter = req.query.status ? { status: String(req.query.status) } : {};
  if (req.query.q) filter[m[1]] = rx(req.query.q);
  const rows = await m[0].find(filter).sort({ createdAt: -1 }).limit(200).lean();
  res.json(rows.map((r) => ({ ...r, id: String(r._id) })));
});

router.patch("/content/:type/:id", async (req, res) => {
  const m = MODELS[req.params.type]; if (!m || !isId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const status = String(req.body?.status || "");
  const allowed = ["approved", "held", "hidden", "pending"];
  if (!allowed.includes(status)) return res.status(400).json({ error: "Bad status" });
  const r = await m[0].updateOne({ _id: req.params.id }, { $set: { status } }, { runValidators: false });
  await audit(req, "set_status", req.params.type, req.params.id, status);
  res.json({ ok: r.matchedCount === 1 });
});

router.patch("/content/:type/:id/text", async (req, res) => {
  const m = MODELS[req.params.type]; if (!m || !isId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const text = trimBody(req.body?.text, 4000);
  if (!text) return res.status(400).json({ error: "text required" });
  await m[0].updateOne({ _id: req.params.id }, { $set: { [m[1]]: text } });
  await audit(req, "edit_text", req.params.type, req.params.id);
  res.json({ ok: true });
});

router.delete("/content/:type/:id", async (req, res) => {
  const m = MODELS[req.params.type]; if (!m || !isId(req.params.id)) return res.status(404).json({ error: "Not found" });
  await m[0].deleteOne({ _id: req.params.id });
  if (req.params.type === "post") await SocialComment.deleteMany({ postId: req.params.id });
  await audit(req, "delete_content", req.params.type, req.params.id);
  res.json({ ok: true });
});

/* ---------- Reports ---------- */
router.get("/reports", async (req, res) => {
  const rows = await Report.find({ status: String(req.query.status || "open") }).sort({ createdAt: -1 }).limit(200).lean();
  const out = [];
  for (const r of rows) {
    const m = MODELS[r.targetType];
    let preview = "";
    if (m && isId(r.targetId)) { const doc = await m[0].findById(r.targetId).lean(); preview = doc ? String(doc[m[1]] || "") : "(deleted)"; }
    if (r.targetType === "user" && isId(r.targetId)) { const u = await User.findById(r.targetId).select("name").lean(); preview = u?.name || "(deleted)"; }
    out.push({ ...r, id: String(r._id), preview: preview.slice(0, 300) });
  }
  res.json(out);
});

router.patch("/reports/:id", async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const status = req.body?.status === "dismissed" ? "dismissed" : "resolved";
  await Report.updateOne({ _id: req.params.id }, { $set: { status, resolvedBy: req.user.name } });
  await audit(req, "resolve_report", "report", req.params.id, status);
  res.json({ ok: true });
});

/* ---------- App texts & switches ---------- */
router.get("/app-content", async (req, res) => {
  const rows = await AppContent.find({}).lean();
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  res.json(Object.entries(CONTENT_KEYS).map(([key, def]) => ({
    key, default: def, value: byKey[key] ? byKey[key].value : def,
    updatedBy: byKey[key]?.updatedBy || "", updatedAt: byKey[key]?.updatedAt || null,
  })));
});

router.put("/app-content/:key", async (req, res) => {
  const c = cleanContent(req.params.key, req.body?.value);
  if (!c) return res.status(400).json({ error: "Unknown key" });
  await AppContent.updateOne({ key: c[0] }, { $set: { value: c[1], updatedBy: req.user.name } }, { upsert: true });
  await audit(req, "edit_app_text", "content", c[0], String(c[1]).slice(0, 120));
  res.json({ ok: true });
});

/* ---------- Broadcast: an official post everyone sees + a notification ---------- */
router.post("/broadcast", async (req, res) => {
  const body = trimBody(req.body?.body, 4000);
  if (!body) return res.status(400).json({ error: "body required" });
  const post = await SocialPost.create({
    authorId: req.user._id, authorName: "The Tech Festival Canada", authorTitle: "Organizers", authorOrg: "AtlasLink Markets",
    kind: "announcement", body, status: "approved",
  });
  if (req.body?.banner === true) {
    await AppContent.updateOne({ key: "home.announcement" }, { $set: { value: body.slice(0, 280), updatedBy: req.user.name } }, { upsert: true });
  }
  await audit(req, "broadcast", "post", post._id, body.slice(0, 120));
  res.status(201).json({ ok: true, id: String(post._id) });
});

router.get("/audit", async (req, res) => {
  res.json(await AdminAudit.find({}).sort({ at: -1 }).limit(300).lean());
});

export default router;
