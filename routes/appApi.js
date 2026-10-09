import express from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { AppEvent, AppContent, Report, Block } from "../models/Admin.js";
import { cleanEvent, CONTENT_KEYS } from "../services/adminHelpers.js";
import { deleteAccount } from "../services/accountDeletion.js";
import { trimBody } from "../services/socialHelpers.js";
import { makeLimiter } from "../services/ticketAccess.js";
import { cleanToken, cleanEnv, upsertToken, isConfigured } from "../services/apns.js";

const eventLimiter = makeLimiter({ max: 120, windowMs: 60 * 1000 });   // batches per IP per minute

/* =========================================================
   /api/app — things every iOS client needs:
   POST   /events        usage analytics (signed in or anonymous device)
   GET    /content       admin-editable texts + feature switches
   POST   /report        report a post, comment, message, user… (signed in)
   POST   /block         block a user;  DELETE /block/:userId unblock
   GET    /blocks        my blocked user ids
   DELETE /account       delete my account (Apple 5.1.1(v))
   POST   /push-token    register this phone for push { token, env }
   DELETE /push-token    stop pushing to this phone { token } (sign out)
========================================================= */

const router = express.Router();

async function optionalUser(req) {
  const h = req.headers.authorization;
  if (!h) return null;
  try {
    const decoded = jwt.verify(h.split(" ")[1], process.env.JWT_SECRET);
    return await User.findById(decoded.id).select("_id name role banned");
  } catch {
    return null;
  }
}

async function requireUser(req, res) {
  const u = await optionalUser(req);
  if (!u) { res.status(401).json({ error: "Unauthorized" }); return null; }
  return u;
}

router.post("/events", async (req, res) => {
  if (!eventLimiter.hit(req.ip)) return res.status(429).json({ error: "Slow down" });
  const list = Array.isArray(req.body?.events) ? req.body.events.slice(0, 200) : [];
  const user = await optionalUser(req);
  const deviceId = String(req.body?.deviceId || "").slice(0, 64);
  const appVersion = String(req.body?.appVersion || "").slice(0, 20);
  const docs = list.map((e) => cleanEvent(e)).filter(Boolean)
    .map((e) => ({ ...e, userId: user?._id, deviceId, appVersion, platform: "ios" }));
  if (docs.length) await AppEvent.insertMany(docs, { ordered: false }).catch(() => {});
  if (user) User.updateOne({ _id: user._id }, { $set: { lastActiveAt: new Date() } }).catch(() => {});
  res.json({ accepted: docs.length });
});

router.get("/content", async (req, res) => {
  const rows = await AppContent.find({}).lean();
  const out = { ...CONTENT_KEYS };
  for (const r of rows) if (Object.prototype.hasOwnProperty.call(CONTENT_KEYS, r.key)) out[r.key] = r.value;
  res.set("Cache-Control", "public, max-age=60");
  res.json(out);
});

const TARGETS = new Set(["post", "comment", "message", "discussion", "reply", "group", "groupMessage", "user", "question"]);

router.post("/report", async (req, res) => {
  const me = await requireUser(req, res); if (!me) return;
  const { targetType, targetId } = req.body || {};
  if (!TARGETS.has(targetType) || !targetId) return res.status(400).json({ error: "targetType and targetId required" });
  await Report.create({ reporterId: me._id, reporterName: me.name, targetType, targetId: String(targetId).slice(0, 64),
                        reason: trimBody(req.body?.reason, 500) });
  res.status(201).json({ ok: true });
});

router.post("/block", async (req, res) => {
  const me = await requireUser(req, res); if (!me) return;
  const other = String(req.body?.userId || "");
  if (!/^[a-f0-9]{24}$/.test(other) || other === String(me._id)) return res.status(400).json({ error: "userId required" });
  await Block.updateOne({ userId: me._id, blockedId: other }, { $setOnInsert: { userId: me._id, blockedId: other } }, { upsert: true });
  res.json({ ok: true });
});

router.delete("/block/:userId", async (req, res) => {
  const me = await requireUser(req, res); if (!me) return;
  await Block.deleteOne({ userId: me._id, blockedId: req.params.userId });
  res.json({ ok: true });
});

router.get("/blocks", async (req, res) => {
  const me = await requireUser(req, res); if (!me) return;
  const rows = await Block.find({ userId: me._id }).lean();
  res.json(rows.map((r) => String(r.blockedId)));
});

/* Push tokens. `pushing` tells the app whether the server can push right now
   (APNs key configured); when false the app keeps showing local notifications. */
router.post("/push-token", async (req, res) => {
  const me = await requireUser(req, res); if (!me) return;
  const token = cleanToken(req.body?.token);
  if (!token) return res.status(400).json({ error: "token required" });
  // A phone belongs to one account at a time: drop it from anyone else first.
  await User.updateMany({ _id: { $ne: me._id } }, { $pull: { apnsTokens: { token } } });
  const u = await User.findById(me._id).select("+apnsTokens");
  u.apnsTokens = upsertToken(u.apnsTokens || [], token, cleanEnv(req.body?.env));
  await u.save();
  res.json({ ok: true, pushing: isConfigured() });
});

router.delete("/push-token", async (req, res) => {
  const me = await requireUser(req, res); if (!me) return;
  const token = cleanToken(req.body?.token);
  if (token) await User.updateOne({ _id: me._id }, { $pull: { apnsTokens: { token } } });
  res.json({ ok: true });
});

router.delete("/account", async (req, res) => {
  const me = await requireUser(req, res); if (!me) return;
  await deleteAccount(me._id);
  res.json({ deleted: true });
});

export default router;
