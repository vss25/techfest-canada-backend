import express from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { AppEvent, AppContent, Report, Block } from "../models/Admin.js";
import AppNotification from "../models/AppNotification.js";
import { pushToUsers } from "../services/push.js";
import { buildReportNotifications } from "../services/socialActivity.js";
import { holdersQuery, rightsFor } from "../services/appRights.js";
import { rightsContext, RIGHTS_SELECT } from "../services/rightsStore.js";
import { cleanEvent, eventPlatform, CONTENT_KEYS } from "../services/adminHelpers.js";
import { deleteAccount } from "../services/accountDeletion.js";
import { trimBody } from "../services/socialHelpers.js";
import { makeLimiter } from "../services/ticketAccess.js";
import { isHidden } from "../services/appHide.js";
import { cleanToken, cleanEnv, upsertToken, isConfigured } from "../services/apns.js";
import { cleanFcmToken, upsertFcmToken, isConfigured as fcmConfigured } from "../services/fcm.js";
import * as webPush from "../services/webPush.js";

const eventLimiter = makeLimiter({ max: 120, windowMs: 60 * 1000 });   // batches per IP per minute
const reportAlertLimiter = makeLimiter({ max: 10, windowMs: 10 * 60 * 1000 });   // staff alerts per reporter
const webPushLimiter = makeLimiter({ max: 30, windowMs: 10 * 60 * 1000 });   // web push subscribes per account

/* =========================================================
   /api/app — things every iOS client needs:
   POST   /events        usage analytics (signed in or anonymous device) from the
                         apps and the website's installable app (/app/):
                         { deviceId, appVersion, platform: ios|android|web, events }
                         (platform missing → ios, or android from appVersion)
   GET    /content       admin-editable texts + feature switches
   POST   /report        report a post, comment, message, user… (signed in);
                         everyone who can moderate gets a "Content reported" notification
   POST   /block         block a user;  DELETE /block/:userId unblock
   GET    /blocks        my blocked user ids
   DELETE /account       delete my account (Apple 5.1.1(v))
   POST   /push-token    register this phone for push
                         iOS { token, env } · Android { token, platform: "android" }
   DELETE /push-token    stop pushing to this phone { token } (sign out)
   GET    /webpush-key   the web app's Web Push key { publicKey } (no sign-in needed)
   POST   /webpush       push to this browser { subscription: { endpoint, keys: { p256dh, auth } } }
                         → { ok, pushing: true }
   DELETE /webpush       stop pushing to this browser { endpoint } (sign out)
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
  const platform = eventPlatform(req.body);
  const docs = list.map((e) => cleanEvent(e)).filter(Boolean)
    .map((e) => ({ ...e, userId: user?._id, deviceId, appVersion, platform }));
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
  const report = await Report.create({ reporterId: me._id, reporterName: me.name, targetType, targetId: String(targetId).slice(0, 64),
                        reason: trimBody(req.body?.reason, 500) });
  await alertStaff(me, report);
  res.status(201).json({ ok: true });
});

/* Everyone with the moderate right (staff accounts always, plus any type the
   App rights matrix lets moderate) gets "Content reported" in its app inbox (and
   a push). The report is always saved; past 10 in 10 min from one person the alerts stop.
   A person hidden from the app (services/appHide.js) alerts nobody: their reports are
   saved and listed in App moderation, labelled. */
const MAX_REPORT_ALERTS = 500;
async function moderators() {
  const ctx = await rightsContext();
  const rows = await User.find(holdersQuery("moderate", ctx.matrix)).select(RIGHTS_SELECT).limit(5000).lean();
  return rows.filter((u) => rightsFor(u, ctx).moderate).slice(0, MAX_REPORT_ALERTS);
}
async function alertStaff(me, report) {
  try {
    if (await isHidden(me._id)) return;
    if (!reportAlertLimiter.hit(String(me._id))) return;
    const staff = await moderators();
    const rows = buildReportNotifications({
      reporterId: me._id, reporterName: me.name, targetType: report.targetType, targetId: report.targetId, reason: report.reason,
      reportId: report._id, staffIds: staff.map((u) => u._id),
    });
    if (!rows.length) return;
    await AppNotification.insertMany(rows);
    const [{ title, body, link }] = rows;
    pushToUsers(rows.map((r) => r.userId), { title, body, link, thread: "reports", kind: "report", id: String(report._id) }, { from: me._id });
  } catch (err) {
    console.error("REPORT ALERT ERROR:", err?.message || err);
  }
}

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
   (APNs key / FCM service account configured for that platform); when false
   the app keeps showing local notifications. */
router.post("/push-token", async (req, res) => {
  const me = await requireUser(req, res); if (!me) return;
  if (req.body?.platform === "android") {
    const token = cleanFcmToken(req.body?.token);
    if (!token) return res.status(400).json({ error: "token required" });
    await User.updateMany({ _id: { $ne: me._id } }, { $pull: { fcmTokens: { token } } });
    const u = await User.findById(me._id).select("+fcmTokens");
    u.fcmTokens = upsertFcmToken(u.fcmTokens || [], token);
    await u.save();
    return res.json({ ok: true, pushing: fcmConfigured() });
  }
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
  const apnsToken = cleanToken(req.body?.token);
  const fcmToken = cleanFcmToken(req.body?.token);
  const pull = {};
  if (apnsToken) pull.apnsTokens = { token: apnsToken };
  if (fcmToken) pull.fcmTokens = { token: fcmToken };
  if (Object.keys(pull).length) await User.updateOne({ _id: me._id }, { $pull: pull });
  res.json({ ok: true });
});

/* Web Push for the web app (services/webPush.js). The key pair is made once and kept, so `pushing`
   is always true. A browser's endpoint belongs to one account: subscribing takes it off any other. */
router.get("/webpush-key", async (req, res) => {
  try {
    const publicKey = await webPush.publicKey();
    res.set("Cache-Control", "public, max-age=300");
    res.json({ publicKey });
  } catch (err) {
    console.error("WEB PUSH KEY ERROR:", err?.message || err);
    res.status(503).json({ error: "Notifications aren't available right now. Try again later." });
  }
});

router.post("/webpush", async (req, res) => {
  const me = await requireUser(req, res); if (!me) return;
  const sub = webPush.cleanSubscription(req.body?.subscription);
  if (!sub) return res.status(400).json({ error: "subscription with an https endpoint and keys required" });
  if (!webPushLimiter.hit(String(me._id))) return res.status(429).json({ error: "Slow down" });
  await webPush.subscribe(me._id, sub, { ua: req.headers["user-agent"] });
  res.json({ ok: true, pushing: webPush.isConfigured() });
});

router.delete("/webpush", async (req, res) => {
  const me = await requireUser(req, res); if (!me) return;
  const endpoint = webPush.cleanEndpoint(req.body?.endpoint);
  if (!endpoint) return res.status(400).json({ error: "endpoint required" });
  await webPush.unsubscribe(me._id, endpoint);
  res.json({ ok: true });
});

router.delete("/account", async (req, res) => {
  const me = await requireUser(req, res); if (!me) return;
  await deleteAccount(me._id);
  res.json({ deleted: true });
});

export default router;
