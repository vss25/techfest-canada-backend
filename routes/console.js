import express from "express";
import mongoose from "mongoose";
import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import { requireAdmin, requireManagement, isManagement } from "../middleware/adminAuth.js";
import { staffDirectoryHide } from "../services/directoryHide.js";
import {
  SocialPost, SocialComment, SocialConnection, SocialMessage, SessionRegistration, SessionQuestion,
} from "../models/Social.js";
import { Discussion, DiscussionReply, CommunityGroup, GroupMessage } from "../models/Community.js";
import { AppEvent, AppContent, AdminAudit, Report } from "../models/Admin.js";
import { CONTENT_KEYS, cleanContent, summarize } from "../services/adminHelpers.js";
import { pwaStats, clampDays } from "../services/pwaStats.js";
import { deleteAccount } from "../services/accountDeletion.js";
import { pushToUsers, pushToEveryone } from "../services/push.js";
import { trimBody, threadKey } from "../services/socialHelpers.js";
import { cleanRole, typeInfo, PERSON_TYPES } from "../services/teamRoles.js";
import {
  DEFAULT_MATRIX, RIGHTS, RIGHT_LABELS, INBOUND_RIGHTS, ADMIN_POWERS, mergeMatrix, cleanMatrix, matrixChanges,
  consoleTypes, typesEdit, typeCandidates, vipEdit,
} from "../services/appRights.js";
import { rightsContext, matrixInfo, loadMatrix, saveMatrix, loadFlags } from "../services/rightsStore.js";
import { loadExhibitors } from "../services/exhibitorCache.js";
import { getKillState, setKillState, DEFAULT_MESSAGE } from "../services/killSwitch.js";
import bcrypt from "bcryptjs";
import TicketInventory from "../models/TicketInventory.js";
import { collectTickets, duplicateKeys, matchRows, salesSummary, recountSold } from "../services/staffTickets.js";
import { DETAIL_COLUMNS, cleanStaffEdit, mergeStaffEdit } from "../services/attendeeDetails.js";
import { stripeRows, stripeSummary } from "../services/stripeSales.js";
import { planProfileRequests, countReasons, profileLink, profileLinksReady, requestStamp, sendSequentially } from "../services/profileRequest.js";
import { buildProfileRequestEmail } from "../services/profileEmail.js";
import { sendProfileRequestEmail } from "../services/emailService.js";
import { firstNameFor } from "../services/ticketInfo.js";
import Stripe from "stripe";
import crypto from "crypto";
import { validateComplimentary, COMP_PROMO } from "../services/complimentary.js";
import AppNotification from "../models/AppNotification.js";
import { validateNotify, recipientFilter, recipientDTO, groupHistory, MAX_RECIPIENTS } from "../services/notifyHelpers.js";
import Brochure from "../models/Brochure.js";
import { downloadsFilter, downloadRow, downloadsCsv, botReason } from "../services/brochureDownloads.js";
import PavilionApplication from "../models/PavilionApplication.js";
import PavilionDeposit from "../models/PavilionDeposit.js";
import {
  STATUSES, applicationsFilter, applicationRow, applicationDetail, depositRow, cleanPatch, applicationsCsv,
} from "../services/pavilionApplications.js";
import { linkDeposits, syncDepositsFromStripe } from "../services/pavilionDeposits.js";
import FormSubmission from "../models/FormSubmission.js";
import {
  FORM_KEYS, STATUSES as FORM_STATUSES, submissionsFilter, submissionRow, submissionDetail, cleanSubmissionPatch,
  submissionsCsv, planImport, importKey,
} from "../services/formSubmissions.js";
import Rsvp from "../models/Rsvp.js";
import { rsvpsFilter, rsvpListPayload, rsvpDetail, rsvpsCsv, LIVE_RSVPS } from "../services/rsvp.js";
import { resolveRsvpDuplicate } from "../services/rsvpHandler.js";
import {
  SPEAKER_TYPE, syncSpeakerPasses, speakerPassRow, speakerPassCounts,
  readyToSend, SAMPLE_SPEAKER, manualSpeakerPassDoc, validateSpeakerEmails, passRecipients,
} from "../services/speakerPasses.js";
import EmailTemplate from "../models/EmailTemplate.js";
import { DEFAULT_COPY, cleanCopy } from "../services/speakerPassEmail.js";
import { validateRunOfShow, validateContact } from "../services/runOfShow.js";
import { sendSessionInvites } from "../services/speakerInvites.js";
import { speakerPassEmailFor } from "../services/speakerPassEmail.js";
import { loadWebsite, applyWebsite, planWebsiteLinks, nudgeCopy, NUDGE_COPY } from "../services/speakerWebsite.js";
import { sendSpeakerPassEmail } from "../services/emailService.js";

/* =========================================================
   /api/console — the TTFC admin console (staff only).
   Everything here is restricted to role "admin". Viewing a
   person's private messages and every change is written to the
   audit log, which the console also shows.
========================================================= */

const router = express.Router();
router.use(requireAdmin);

/* Who am I, and what may I see? (The panel hides sales/money for non-management staff.) */
router.get("/me", (req, res) => {
  res.json({ id: String(req.user._id), name: req.user.name, email: req.user.email,
             staffRole: isManagement(req.user) ? "management" : "staff", isManagement: isManagement(req.user) });
});

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

/* ---------- People ----------
   Rows carry `types`: their effective person types (services/teamRoles.js) and `vip` (the VIP switch).
   `?type=speaker` (any of PERSON_TYPES) keeps only people who have that type; `?type=vip` (the old
   VIP type, now the switch) keeps the VIPs. */
const PEOPLE_SELECT = "name email role jobTitle organization topics tickets banned directoryHidden messagesOff requestsOff lastActiveAt createdAt provider types typesOff vip";
const PEOPLE_PAGE = 50;
router.get("/users", async (req, res) => {
  const q = String(req.query.q || "").trim();
  let filter = q ? { $or: [{ name: rx(q) }, { email: rx(q) }, { organization: rx(q) }, { "tickets.ticketId": q.toLowerCase() }] } : {};
  if (req.query.role) filter.role = String(req.query.role);
  if (req.query.banned === "true") filter.banned = true;
  const page = Math.max(0, Number(req.query.page) || 0);
  const type = req.query.type ? String(req.query.type).toLowerCase() : "";
  if (type && type !== "vip" && !PERSON_TYPES.includes(type)) return res.status(400).json({ error: `type must be one of: ${PERSON_TYPES.join(", ")}` });
  const exhibitors = await loadExhibitors();
  const sort = { lastActiveAt: -1, createdAt: -1 };
  let rows;
  let total;
  if (type) {
    // Automatic types (passes, roles) can't all be queried, so narrow, then keep exact matches.
    const cand = type === "vip" ? {} : typeCandidates(type);
    if (Object.keys(cand).length) filter = { $and: [filter, cand] };
    const all = (await User.find(filter).select(PEOPLE_SELECT).sort(sort).limit(5000).lean())
      .filter((u) => { const info = typeInfo(u, exhibitors); return type === "vip" ? info.vip : info.types.includes(type); });
    total = all.length;
    rows = all.slice(page * PEOPLE_PAGE, (page + 1) * PEOPLE_PAGE);
  } else {
    [rows, total] = await Promise.all([
      User.find(filter).select(PEOPLE_SELECT).sort(sort).skip(page * PEOPLE_PAGE).limit(PEOPLE_PAGE).lean(),
      User.countDocuments(filter),
    ]);
  }
  res.json({ total, page, users: rows.map((u) => ({
    id: String(u._id), name: u.name, email: u.email, role: u.role, jobTitle: u.jobTitle, organization: u.organization,
    topics: u.topics || [], tickets: (u.tickets || []).length, banned: !!u.banned, provider: u.provider,
    directoryHidden: !!u.directoryHidden, messagesOff: !!u.messagesOff, requestsOff: !!u.requestsOff,
    types: typeInfo(u, exhibitors).types,
    vip: typeInfo(u, exhibitors).vip,
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
  const [peers, ctx] = await Promise.all([User.find({ _id: { $in: peerIds } }).select("name organization").lean(), rightsContext()]);
  const peerName = Object.fromEntries(peers.map((p) => [String(p._id), `${p.name}${p.organization ? " · " + p.organization : ""}`]));
  res.json({
    // types / typesOff (stored), autoTypes, holdsPass, effectiveTypes and rights: services/appRights.js consoleTypes.
    user: { ...u, id: String(u._id), messagesOff: !!u.messagesOff, requestsOff: !!u.requestsOff, ...consoleTypes(u, ctx) },
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

const EDITABLE = ["name", "email", "jobTitle", "organization", "linkedinUrl", "country", "fieldOfWork", "topics", "role", "banned", "bannedReason", "directoryHidden",
  "tagline", "salutation", "gender", "jobLevel", "objectives", "availabilitySlots", "meetingSpot", "appOnboarded",
  "messagesOff", "requestsOff"];   // contact switches for VIPs (services/contactSwitches.js)
const EDIT_BOOLS = new Set(["banned", "directoryHidden", "appOnboarded", "messagesOff", "requestsOff"]);
const EDIT_LISTS = { topics: 20, objectives: 12, availabilitySlots: 40 };
router.patch("/users/:id", async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const u = await User.findById(req.params.id);
  if (!u) return res.status(404).json({ error: "Not found" });
  const changed = [];
  if (req.body?.role !== undefined && !isManagement(req.user)) return res.status(403).json({ error: "Only management can change staff access" });
  // user (attendee) | admin (staff) | volunteer (app staff sign-in + door check-in only)
  if (req.body?.role !== undefined && !cleanRole(req.body.role)) return res.status(400).json({ error: "Role must be user, admin or volunteer" });
  if (req.body?.role !== undefined && String(u._id) === String(req.user._id) && cleanRole(req.body.role) !== "admin") {
    return res.status(400).json({ error: "You can't remove your own staff access" });
  }
  // A staff account's email is its password-reset address: only management may
  // change it (or anyone's email), so staff can't take over each other's accounts.
  if (!isManagement(req.user) && (u.role === "admin" || req.body?.email !== undefined)) {
    return res.status(403).json({ error: "Only management can change staff accounts or email addresses" });
  }
  // Person types (services/appRights.js typesEdit): validated; staff / volunteer types are management only.
  const typed = typesEdit(u, req.body, { management: isManagement(req.user) });
  if (typed.error) return res.status(typed.status).json({ error: typed.error });
  // The VIP switch (services/teamRoles.js isVip): a flag on the account, not a type.
  const vipped = vipEdit(u, req.body, { vipPass: req.body?.vip !== undefined ? (await loadExhibitors()).hasVipPass(u) : false });
  if (vipped.error) return res.status(vipped.status).json({ error: vipped.error });
  for (const k of EDITABLE) {
    if (req.body?.[k] === undefined) continue;
    let v = req.body[k];
    if (EDIT_LISTS[k]) v = Array.isArray(v) ? v.filter((t) => typeof t === "string").map((t) => t.trim().slice(0, 80)).filter(Boolean).slice(0, EDIT_LISTS[k]) : u[k];
    else if (EDIT_BOOLS.has(k)) v = v === true || v === "true";
    else if (k === "name" && !String(v).trim()) continue;
    else if (k === "role") v = cleanRole(v);
    else if (k === "email") v = String(v).trim().toLowerCase().slice(0, 200);
    else v = String(v).slice(0, 300);
    if (JSON.stringify(u[k]) !== JSON.stringify(v)) { u[k] = v; changed.push(k); }
  }
  // staffRole only means something for staff. An unset one counts as management
  // (accounts from before levels existed), so someone newly made staff starts at "staff".
  if (changed.includes("role")) u.staffRole = u.role === "admin" ? "staff" : undefined;
  for (const [k, v] of Object.entries(typed.set)) { u[k] = v; changed.push(k); }
  for (const [k, v] of Object.entries(vipped.set)) { u[k] = v; changed.push(k); }
  // The attendee-list switch is staff-only now: record that staff made the call (services/directoryHide.js).
  if (req.body?.directoryHidden !== undefined) {
    const hide = staffDirectoryHide(req.body.directoryHidden);
    if (u.directoryHiddenByStaff !== hide) { u.directoryHiddenByStaff = hide; if (!changed.includes("directoryHidden")) changed.push("directoryHidden"); }
  }
  await u.save();
  if (changed.length) await audit(req, "edit_user", "user", u._id, [changed.join(", "), typed.note, vipped.note].filter(Boolean).join(" | "));
  res.json({ ok: true, changed });
});

router.delete("/users/:id", async (req, res) => {
  if (!isId(req.params.id) || String(req.params.id) === String(req.user._id)) return res.status(400).json({ error: "Can't delete this account" });
  const target = await User.findById(req.params.id).select("role").lean();
  if (target?.role === "admin" && !isManagement(req.user)) return res.status(403).json({ error: "Only management can delete staff accounts" });
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

/* ---------- Web app (PWA) installs + launches ----------
   The website's installable app at /app/ posts pwa_* events with platform "web".
   ?days=1…120 (default 30, Toronto days, today included); kept a minute,
   ?refresh=1 skips the copy. Read-only like /stats, so not audited.
   Shape and rules in services/pwaStats.js. */
router.get("/pwa", async (req, res) => {
  res.json(await pwaStats({ AppEvent, User }, { days: clampDays(req.query.days), refresh: req.query.refresh === "1" }));
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

/* ---------- App rights: what each person type may do in the app ----------
   One matrix (services/appRights.js, stored by services/rightsStore.js).
   Everyone on the console can read it; only management can change it.
   PUT { matrix: { type: { right: bool } } } (left-out cells keep their
   defaults) or { reset: true }. Changes are audited with a diff. */
async function appRightsPayload(req) {
  const [{ matrix, updatedBy, updatedAt }, flags] = await Promise.all([matrixInfo(), loadFlags()]);
  return {
    matrix, defaults: mergeMatrix(DEFAULT_MATRIX), types: PERSON_TYPES, rights: RIGHTS, labels: RIGHT_LABELS,
    inbound: INBOUND_RIGHTS, adminPowers: ADMIN_POWERS, flags, updatedBy, updatedAt, canEdit: isManagement(req.user),
  };
}

router.get("/app-rights", async (req, res) => {
  res.json(await appRightsPayload(req));
});

router.put("/app-rights", requireManagement, async (req, res) => {
  const reset = req.body?.reset === true;
  const c = cleanMatrix(reset ? DEFAULT_MATRIX : req.body?.matrix);
  if (c.error) return res.status(400).json({ error: c.error });
  const changes = matrixChanges(await loadMatrix(), c.matrix);
  if (changes.length) {
    await saveMatrix(c.matrix, req.user.name);
    await audit(req, reset ? "app_rights_reset" : "app_rights", "app-rights", "matrix",
      `${changes.length} change${changes.length === 1 ? "" : "s"}: ${changes.join("; ")}`);
  }
  res.json({ ...(await appRightsPayload(req)), changed: changes });
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
  // Phones with push get it straight away; the rest see it on their next check-in.
  pushToEveryone({ title: "TTFC update", body, link: "ttfc://tab/feed", kind: "announcement", id: String(post._id) });
  res.status(201).json({ ok: true, id: String(post._id) });
});

/* ---------- Personal notifications: staff → one or a few people on the app ----------
   No push service yet: the apps poll /api/social/notifications, so a person sees
   it in their in-app inbox and as a phone notification the next time the app
   checks in. Only people who have signed into the app can be picked. */
router.get("/notify/recipients", async (req, res) => {
  const ids = String(req.query.ids || "").split(",").filter(Boolean).slice(0, MAX_RECIPIENTS);
  const rows = await User.find(recipientFilter(req.query.q, ids))
    .select("name email organization jobTitle avatarVersion lastActiveAt")
    .sort({ lastActiveAt: -1, name: 1 }).limit(ids.length ? MAX_RECIPIENTS : 25).lean();
  res.json({ recipients: rows.map(recipientDTO) });
});

router.post("/notify", async (req, res) => {
  const v = validateNotify(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const { userIds, title, body, link } = v.value;
  const eligible = await User.find(recipientFilter("", userIds)).select("_id name").lean();
  if (!eligible.length) return res.status(400).json({ error: "None of those people are on the app yet." });
  const batchId = new mongoose.Types.ObjectId().toString();
  await AppNotification.insertMany(eligible.map((u) => ({
    userId: u._id, title, body, link, kind: "personal", batchId, sentBy: req.user._id, sentByName: req.user.name || "",
  })));
  const sentIds = new Set(eligible.map((u) => String(u._id)));
  const skipped = userIds.filter((id) => !sentIds.has(id));
  pushToUsers(eligible.map((u) => u._id), { title, body, link: link || "", kind: "personal", id: batchId });
  const who = eligible.length === 1 ? eligible[0].name : `${eligible.length} people`;
  await audit(req, "notify_person", "user", [...sentIds].join(",").slice(0, 200), `${who}: ${title}`);
  res.status(201).json({ ok: true, sent: eligible.length, skipped, batchId });
});

router.get("/notify/history", async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
  const latest = await AppNotification.aggregate([{ $match: { kind: "personal" } },
    { $group: { _id: "$batchId", at: { $max: "$createdAt" } } }, { $sort: { at: -1 } }, { $limit: limit }]);
  const rows = await AppNotification.find({ kind: "personal", batchId: { $in: latest.map((b) => b._id) } })
    .sort({ createdAt: -1 }).lean();
  const users = await User.find({ _id: { $in: [...new Set(rows.map((r) => String(r.userId)))] } }).select("name").lean();
  res.json({ sends: groupHistory(rows, new Map(users.map((u) => [String(u._id), u.name])), limit) });
});

router.get("/audit", async (req, res) => {
  res.json(await AdminAudit.find({}).sort({ at: -1 }).limit(300).lean());
});

/* ---------- Staff accounts ----------
   Staff = role "admin". Passwords are typed by an admin here and stored
   only as bcrypt hashes; they are never kept in code or logs. */
const isEmail = (s) => /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(String(s || ""));
export const strongEnough = (pw) => typeof pw === "string" && pw.length >= 8;

router.get("/staff", requireManagement, async (req, res) => {
  const staff = await User.find({ role: { $in: ["admin", "volunteer"] } }).select("name email role provider lastActiveAt createdAt password staffRole").lean();
  res.json(staff.map((u) => ({ id: String(u._id), name: u.name, email: u.email, provider: u.provider || "local",
    role: u.role === "volunteer" ? "volunteer" : "admin",
    // Volunteers have no access level (they can't open the admin panel).
    staffRole: u.role === "volunteer" ? "" : isManagement({ ...u, role: "admin" }) ? "management" : "staff",
    hasPassword: !!u.password, lastActiveAt: u.lastActiveAt || null, createdAt: u.createdAt, isMe: String(u._id) === String(req.user._id) })));
});

/* Add or promote staff ({ role: "admin" }, the default) or a volunteer ({ role: "volunteer" }:
   the apps' staff sign-in for door check-in, never this panel; no staffRole). */
router.post("/staff", requireManagement, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const name = trimBody(req.body?.name, 80);
  const password = req.body?.password;
  const role = req.body?.role === undefined ? "admin" : cleanRole(req.body.role);
  if (role !== "admin" && role !== "volunteer") return res.status(400).json({ error: "Role must be admin or volunteer" });
  const volunteer = role === "volunteer";
  if (!isEmail(email)) return res.status(400).json({ error: "Enter a valid email address" });
  if (password !== undefined && password !== "" && !strongEnough(password)) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }
  let user = await User.findOne({ email });
  const created = !user;
  if (!user) {
    if (!password) return res.status(400).json({ error: volunteer ? "New volunteers need a password" : "New staff need a password" });
    user = new User({ name: name || email.split("@")[0], email, provider: "local" });
  }
  if (volunteer && String(user._id) === String(req.user._id)) return res.status(400).json({ error: "You can't remove your own staff access" });
  const wasStaff = user.role === "admin";
  user.role = role;
  if (name) user.name = name;
  if (volunteer) user.staffRole = undefined;
  // New staff default to "staff" (no sales/money) unless management is chosen.
  else if (req.body?.staffRole === "management" || req.body?.staffRole === "staff") user.staffRole = req.body.staffRole;
  else if (created || !wasStaff) user.staffRole = "staff";   // unset would mean management
  if (password) user.password = await bcrypt.hash(password, 10);
  await user.save();
  const action = volunteer ? (created ? "volunteer_add" : "volunteer_set") : (created ? "staff_add" : "staff_promote");
  await audit(req, action, "user", user._id, email);
  res.status(created ? 201 : 200).json({ id: String(user._id), email, name: user.name, role, created });
});

router.delete("/staff/:id", requireManagement, async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ error: "Bad id" });
  if (String(req.params.id) === String(req.user._id)) return res.status(400).json({ error: "You can't remove your own staff access" });
  const user = await User.findByIdAndUpdate(req.params.id, { $set: { role: "user" } }, { new: true });
  if (!user) return res.status(404).json({ error: "Not found" });
  await audit(req, "staff_remove", "user", user._id, user.email);
  res.json({ ok: true });
});

/* Management ↔ staff. You can't demote yourself (so there's always someone in charge). */
router.patch("/staff/:id", requireManagement, async (req, res) => {
  const role = req.body?.staffRole;
  if (role !== "management" && role !== "staff") return res.status(400).json({ error: "staffRole must be management or staff" });
  if (!isId(req.params.id)) return res.status(400).json({ error: "Bad id" });
  if (String(req.params.id) === String(req.user._id) && role === "staff") return res.status(400).json({ error: "You can't remove your own management access" });
  const user = await User.findOneAndUpdate({ _id: req.params.id, role: "admin" }, { $set: { staffRole: role } }, { new: true });
  if (!user) return res.status(404).json({ error: "Not a staff member" });
  await audit(req, "staff_role", "user", user._id, `${user.email} → ${role}`);
  res.json({ id: String(user._id), staffRole: role });
});

/* Change your own password (also lets Google sign-in staff set one). */
router.post("/me/password", async (req, res) => {
  const { current, next } = req.body || {};
  if (!strongEnough(next)) return res.status(400).json({ error: "New password must be at least 8 characters" });
  const me = await User.findById(req.user._id);
  if (me.password && !(await bcrypt.compare(String(current || ""), me.password))) {
    return res.status(403).json({ error: "Current password is wrong" });
  }
  me.password = await bcrypt.hash(next, 10);
  await me.save();
  await audit(req, "password_change", "user", me._id);
  res.json({ ok: true });
});

/* ---------- Kill switch (website + app offline) ----------
   Needs the signed-in admin's own password, or KILL_SWITCH_PASSWORD
   if that is set on the server. */
router.get("/kill-switch", async (req, res) => {
  const s = await getKillState();
  res.json({ enabled: s.enabled, message: s.message || DEFAULT_MESSAGE, by: s.by || "", since: s.since || null });
});

router.post("/kill-switch", requireManagement, async (req, res) => {
  const { enabled, password, message } = req.body || {};
  if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled must be true or false" });
  const pw = String(password || "");
  const me = await User.findById(req.user._id);
  const okOwn = me.password ? await bcrypt.compare(pw, me.password) : false;
  const okEnv = !!process.env.KILL_SWITCH_PASSWORD && pw === process.env.KILL_SWITCH_PASSWORD;
  if (!okOwn && !okEnv) {
    await audit(req, "kill_switch_denied", "site", "", enabled ? "on" : "off");
    return res.status(403).json({ error: me.password ? "Wrong password" : "Set a password for your account first (Staff → Change password)" });
  }
  const s = await setKillState({ enabled, message: message || DEFAULT_MESSAGE, by: req.user.name || req.user.email });
  await audit(req, enabled ? "kill_switch_on" : "kill_switch_off", "site", "", s.message);
  res.json({ enabled: s.enabled, message: s.message, by: s.by, since: s.since });
});

/* ---------- Tickets (staff view) ----------
   Hiding a ticket only removes it from staff lists and analytics. The
   owner keeps it: it still shows in their app/website and works at the door. */
async function allTicketRows() {
  const [users, guests] = await Promise.all([
    User.find({ "tickets.0": { $exists: true } }).select("name email tickets").lean(),
    Attendee.find({}).select("name email ticketId ticketType purchaseDate checkedIn hiddenByStaff promoCode details").lean(),
  ]);
  return collectTickets(users, guests);
}

router.get("/tickets", async (req, res) => {
  const show = String(req.query.show || "visible");
  let rows = await allTicketRows();
  const dupes = new Set(duplicateKeys(rows));
  rows = rows.map((r) => ({ ...r, duplicate: dupes.has(r.key) }));
  if (show === "visible") rows = rows.filter((r) => !r.hidden);
  else if (show === "hidden") rows = rows.filter((r) => r.hidden);
  else if (show === "duplicates") rows = rows.filter((r) => r.duplicate);
  rows = matchRows(rows, req.query.q || "");
  if (req.query.promo) {
    const code = String(req.query.promo).toUpperCase();
    rows = rows.filter((r) => (code === "ANY" ? !!r.promoCode : r.promoCode === code));
  }
  const page = Math.max(0, Number(req.query.page) || 0), size = 100;
  res.json({ total: rows.length, duplicates: dupes.size, rows: rows.slice(page * size, page * size + size) });
});

// Spreadsheet of every visible ticket with what the buyer told us at checkout.
// Management only: it holds phone numbers and other personal details.
router.get("/tickets/export", requireManagement, async (req, res) => {
  const rows = (await allTicketRows()).filter((r) => !r.hidden);
  const cell = (v) => {
    const s = Array.isArray(v) ? v.join("; ") : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ["Ticket ID", "Pass", "Name", "Email", "Purchased", "Checked in", "Promo code", "Source",
    ...DETAIL_COLUMNS.map(([, label]) => label), "Organisation from email", "Profile link emailed", "Profile completed by attendee"];
  const date = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");
  const lines = rows.map((r) => [r.ticketId, r.tier, r.name, r.email,
    date(r.purchaseDate), r.checkedIn, r.promoCode,
    r.source === "account" ? "Account" : "Guest checkout",
    ...DETAIL_COLUMNS.map(([k]) => r.details?.[k]), r.emailOrg,
    date(r.profileRequestedAt), date(r.profileCompletedAt)].map(cell).join(","));
  await audit(req, "tickets_export", "ticket", "", `${rows.length} rows`);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="ttfc-attendees-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send("\uFEFF" + [head.map(cell).join(","), ...lines].join("\n"));
});

/* ---------- Brochure downloads (website /brochures form) ---------- */
// Newest first, 50 a page. ?q= searches name, email, company, job title, phone, industry.
// Bot sign-ups are hidden unless ?spam=1 (then only those are listed).

// Rows saved before the bot check existed get flagged once per server start.
let spamBackfill = null;
function backfillSpamFlags() {
  spamBackfill ||= (async () => {
    const legacy = await Brochure.find({ spam: { $exists: false } }, { firstName: 1, lastName: 1, company: 1, jobTitle: 1 }).lean();
    const bots = legacy.map((d) => [d._id, botReason(d)]).filter(([, why]) => why);
    for (const [id, why] of bots) await Brochure.updateOne({ _id: id }, { $set: { spam: true, spamReason: why } });
    await Brochure.updateMany({ spam: { $exists: false } }, { $set: { spam: false } });
  })().catch((err) => { spamBackfill = null; console.error("BROCHURE SPAM BACKFILL ERROR:", err?.message || err); });
  return spamBackfill;
}

const spamScope = (req) => (req.query.spam === "1" ? { spam: true } : { spam: { $ne: true } });

router.get("/brochure-downloads", async (req, res) => {
  await backfillSpamFlags();
  const filter = { ...downloadsFilter(req.query.q), ...spamScope(req) };
  const page = Math.max(0, Number(req.query.page) || 0), size = 50;
  const [rows, total, all, spam] = await Promise.all([
    Brochure.find(filter).sort({ createdAt: -1 }).skip(page * size).limit(size).lean(),
    Brochure.countDocuments(filter),
    Brochure.countDocuments({ spam: { $ne: true } }),
    Brochure.countDocuments({ spam: true }),
  ]);
  res.json({ total, all, spam, page, size, rows: rows.map(downloadRow) });
});

// Spreadsheet of every download. Management only, like the attendee list: it holds phone numbers.
router.get("/brochure-downloads/export", requireManagement, async (req, res) => {
  await backfillSpamFlags();
  const rows = await Brochure.find({ ...downloadsFilter(req.query.q), ...spamScope(req) }).sort({ createdAt: -1 }).lean();
  await audit(req, "brochure_downloads_export", "brochure", "", `${rows.length} rows`);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="ttfc-brochure-downloads-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(downloadsCsv(rows));
});

/* ---------- India Pavilion applications (website /exhibit/india-pavilion) ----------
   Saved by routes/pavilion.js. Deposits come from the Stripe webhook and from
   the revenue page's Stripe read (which also brings in deposits paid before
   applications were saved); see services/pavilionDeposits.js.
   Newest first, 50 a page. ?q= searches company, contact, email, phone,
   reference, CIN/DPIIT. ?status= new|contacted|accepted|declined.
   Bot applications are hidden unless ?spam=1 (then only those are listed). */

// Read deposits from Stripe, but never hold the list up for more than a few seconds.
async function syncPavilionDeposits(req) {
  if (!process.env.STRIPE_SECRET_KEY) return "STRIPE_SECRET_KEY isn't set on the server, so deposits are only recorded as they're paid";
  const sync = syncDepositsFromStripe(new Stripe(process.env.STRIPE_SECRET_KEY), { force: req.query.refresh === "1" }).then(() => "");
  const slow = new Promise((resolve) => setTimeout(() => resolve("slow"), 8000));
  try {
    const r = await Promise.race([sync, slow]);
    if (r === "slow") sync.catch((err) => console.error("PAVILION STRIPE SYNC ERROR:", err?.message || err));
    return r === "slow" ? "Stripe is slow to answer; deposits will update on the next refresh" : "";
  } catch (err) {
    return `Couldn't read deposits from Stripe: ${err?.message || err}`;
  }
}

const pavilionSpamScope = (req) => (req.query.spam === "1" ? { spam: true } : { spam: { $ne: true } });

router.get("/pavilion-applications", async (req, res) => {
  const stripeError = await syncPavilionDeposits(req);
  await linkDeposits().catch((err) => console.error("PAVILION DEPOSIT LINK ERROR:", err?.message || err));
  const filter = { ...applicationsFilter(req.query.q, req.query.status), ...pavilionSpamScope(req) };
  const page = Math.max(0, Number(req.query.page) || 0), size = 50;
  const [rows, total, all, spam, byStatus, unmatched, deposits] = await Promise.all([
    PavilionApplication.find(filter).sort({ createdAt: -1 }).skip(page * size).limit(size).lean(),
    PavilionApplication.countDocuments(filter),
    PavilionApplication.countDocuments({ spam: { $ne: true } }),
    PavilionApplication.countDocuments({ spam: true }),
    PavilionApplication.aggregate([{ $match: { spam: { $ne: true } } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    PavilionDeposit.find({ applicationId: null }).sort({ paidAt: -1 }).lean(),
    PavilionDeposit.countDocuments(),
  ]);
  const counts = Object.fromEntries(STATUSES.map((st) => [st, 0]));
  for (const g of byStatus) counts[g._id || "new"] = (counts[g._id || "new"] || 0) + g.n;
  res.json({
    total, all, spam, page, size, counts, rows: rows.map(applicationRow),
    unmatchedDeposits: unmatched.map(depositRow), depositsPaid: deposits, stripeError,
  });
});

// Spreadsheet of every application matching the search. Management only: it holds phone numbers and company financials.
router.get("/pavilion-applications/export", requireManagement, async (req, res) => {
  const rows = await PavilionApplication.find({ ...applicationsFilter(req.query.q, req.query.status), ...pavilionSpamScope(req) }).sort({ createdAt: -1 }).lean();
  await audit(req, "pavilion_applications_export", "pavilion", "", `${rows.length} rows`);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="ttfc-india-pavilion-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(applicationsCsv(rows));
});

router.get("/pavilion-applications/:id", async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: "Application not found" });
  const a = await PavilionApplication.findById(req.params.id).lean();
  if (!a) return res.status(404).json({ error: "Application not found" });
  const deposits = await PavilionDeposit.find({ applicationId: a._id }).sort({ paidAt: -1 }).lean();
  res.json({ application: applicationDetail(a), deposits: deposits.map(depositRow) });
});

// Staff (not only management) move an application along and keep notes. Body { status?, notes? }.
router.patch("/pavilion-applications/:id", async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: "Application not found" });
  const patch = cleanPatch(req.body);
  if (!patch.ok) return res.status(400).json({ error: patch.error });
  const before = await PavilionApplication.findById(req.params.id, { status: 1, legalName: 1 }).lean();
  if (!before) return res.status(404).json({ error: "Application not found" });
  const set = { ...patch.set, lastEditedBy: req.user.name || req.user.email || "", lastEditedAt: new Date() };
  if (set.status && set.status !== (before.status || "new")) set.statusChangedAt = new Date();
  const a = await PavilionApplication.findByIdAndUpdate(req.params.id, { $set: set }, { new: true }).lean();
  const what = [
    patch.set.status && patch.set.status !== (before.status || "new") ? `status ${before.status || "new"} → ${patch.set.status}` : "",
    patch.set.notes !== undefined ? "notes" : "",
  ].filter(Boolean).join(", ") || "no change";
  await audit(req, "pavilion_application_edit", "pavilion", a._id, `${before.legalName}: ${what}`);
  const deposits = await PavilionDeposit.find({ applicationId: a._id }).sort({ paidAt: -1 }).lean();
  res.json({ application: applicationDetail(a), deposits: deposits.map(depositRow) });
});

/* ---------- Website form submissions (volunteer, speaker, booth, sponsor, partnership, enquiry) ----------
   Saved by routes/forms.js (they went through EmailJS before Oct 2026).
   Newest first, 50 a page. ?form= one form, ?status=, ?q= searches name,
   email, phone, company, job title and message. Bots are hidden unless
   ?spam=1 (then only those are listed). `counts` is per form, without bots. */
const formSpamScope = (req) => (req.query.spam === "1" ? { spam: true } : { spam: { $ne: true } });
const formQuery = (req) => ({ ...submissionsFilter(req.query), ...formSpamScope(req) });

router.get("/form-submissions", async (req, res) => {
  const filter = formQuery(req);
  const page = Math.max(0, Number(req.query.page) || 0), size = 50;
  // Tabs count every form under the same search/status/spam view, so switching tabs doesn't surprise.
  const { form: _f, ...acrossForms } = filter;
  const [rows, total, all, spam, byForm, byStatus] = await Promise.all([
    FormSubmission.find(filter).sort({ createdAt: -1 }).skip(page * size).limit(size).lean(),
    FormSubmission.countDocuments(filter),
    FormSubmission.countDocuments({ spam: { $ne: true } }),
    FormSubmission.countDocuments({ spam: true }),
    FormSubmission.aggregate([{ $match: acrossForms }, { $group: { _id: "$form", n: { $sum: 1 } } }]),
    FormSubmission.aggregate([{ $match: { ...(filter.form ? { form: filter.form } : {}), spam: { $ne: true } } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
  ]);
  const counts = Object.fromEntries(FORM_KEYS.map((k) => [k, 0]));
  for (const g of byForm) if (g._id in counts) counts[g._id] = g.n;
  const statusCounts = Object.fromEntries(FORM_STATUSES.map((k) => [k, 0]));
  for (const g of byStatus) statusCounts[g._id || "new"] = (statusCounts[g._id || "new"] || 0) + g.n;
  res.json({ total, all, spam, page, size, counts, statusCounts, rows: rows.map(submissionRow) });
});

// Spreadsheet of every submission matching the view. Management only: it holds phone numbers.
router.get("/form-submissions/export", requireManagement, async (req, res) => {
  const rows = await FormSubmission.find(formQuery(req)).sort({ createdAt: -1 }).lean();
  await audit(req, "form_submissions_export", "form", String(req.query.form || ""), `${rows.length} rows`);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="ttfc-form-submissions-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(submissionsCsv(rows));
});

/* Load submissions recovered from EmailJS's history. Management only, audited, never emailed.
   Body { rows: [{ form, name, email, phone, company, message, fields, receivedAt }] }
   (firstName / lastName / jobTitle also accepted). Saved with source "recovered" and
   createdAt = receivedAt. Same form + email + receivedAt as an existing row → skipped. */
router.post("/form-submissions/import", requireManagement, async (req, res) => {
  const first = planImport(req.body);
  if (!first.ok) return res.status(400).json({ error: first.error });
  // Look up only the rows that could clash, then plan again against them.
  const existing = first.docs.length ? await FormSubmission.find(
    { $or: first.docs.map((d) => ({ form: d.form, email: d.email, createdAt: d.createdAt })) },
    { form: 1, email: 1, createdAt: 1 },
  ).lean() : [];
  const plan = planImport(req.body, new Set(existing.map(importKey)));
  const by = req.user.name || req.user.email || "";
  const saved = [];
  for (const d of plan.docs) saved.push(await FormSubmission.create({ ...d, updatedBy: by }));
  await audit(req, "form_submissions_import", "form", "", `${saved.length} imported, ${plan.skipped.length} skipped`);
  res.status(201).json({
    imported: saved.length,
    skipped: plan.skipped,
    duplicates: plan.skipped.filter((s) => s.reason === "duplicate").length,
    rows: saved.map((d) => submissionRow(d.toObject())),
  });
});

router.get("/form-submissions/:id", async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: "Submission not found" });
  const s = await FormSubmission.findById(req.params.id).lean();
  if (!s) return res.status(404).json({ error: "Submission not found" });
  res.json({ submission: submissionDetail(s) });
});

// Staff (not only management) move a submission along and keep notes. Body { status?, notes? }.
router.patch("/form-submissions/:id", async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: "Submission not found" });
  const patch = cleanSubmissionPatch(req.body);
  if (!patch.ok) return res.status(400).json({ error: patch.error });
  const before = await FormSubmission.findById(req.params.id, { status: 1, name: 1, form: 1 }).lean();
  if (!before) return res.status(404).json({ error: "Submission not found" });
  const set = { ...patch.set, updatedBy: req.user.name || req.user.email || "" };
  const statusChanged = set.status && set.status !== (before.status || "new");
  if (statusChanged) set.statusChangedAt = new Date();
  const s = await FormSubmission.findByIdAndUpdate(req.params.id, { $set: set }, { new: true }).lean();
  const what = [
    statusChanged ? `status ${before.status || "new"} → ${set.status}` : "",
    patch.set.notes !== undefined ? "notes" : "",
  ].filter(Boolean).join(", ") || "no change";
  await audit(req, "form_submission_edit", "form", s._id, `${before.form} · ${before.name || "no name"}: ${what}`);
  res.json({ submission: submissionDetail(s) });
});

/* ---------- TTFC 2026 RSVPs (website /rsvp, unlinked) ----------
   Saved by routes/rsvp.js, one row per person. Newest change first, 50 a page.
   ?q= name, email or ticket ID; ?tier= connect|influence|power|apex|speaker;
   ?option= day1|day2|lunch_d1|…|lounge; ?verified=0|1; ?review=1 possible
   duplicates. `summary` counts every RSVP (not just this view) per day,
   experience, dietary need and pass, so catering numbers are there at a glance
   (`verifiedCounts`: verified passes only). Bots are never listed or counted;
   possible duplicates (`duplicateOf`) are listed but not counted until staff
   resolve them (POST /rsvps/:id/resolve). `catalog` is GET /api/rsvp/options,
   so this page keeps its labels while the kill switch has the public API off. */
router.get("/rsvps", async (req, res) => {
  const filter = rsvpsFilter(req.query);
  const page = Math.max(0, Number(req.query.page) || 0), size = 50;
  const [rows, total, everyone] = await Promise.all([
    Rsvp.find(filter).sort({ updatedAt: -1 }).skip(page * size).limit(size).lean(),
    Rsvp.countDocuments(filter),
    Rsvp.find(LIVE_RSVPS, { tier: 1, tierVerified: 1, days: 1, options: 1, dietary: 1, dietaryOther: 1, name: 1, firstName: 1, lastName: 1, duplicateOf: 1 }).lean(),
  ]);
  res.json(rsvpListPayload({ total, page, size, everyone, rows }));
});

// Spreadsheet of every RSVP in this view. Management only: it holds emails and accessibility notes.
router.get("/rsvps/export", requireManagement, async (req, res) => {
  const rows = await Rsvp.find(rsvpsFilter(req.query)).sort({ updatedAt: -1 }).lean();
  await audit(req, "rsvps_export", "rsvp", "", `${rows.length} rows`);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="ttfc-rsvps-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(rsvpsCsv(rows));
});

// Delete an RSVP for good (management). Rows that pointed at it as their duplicate are unflagged.
router.delete("/rsvps/:id", requireManagement, async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: "RSVP not found" });
  const r = await Rsvp.findByIdAndDelete(req.params.id).lean();
  if (!r) return res.status(404).json({ error: "RSVP not found" });
  await Rsvp.updateMany({ duplicateOf: String(r._id) }, { $unset: { duplicateOf: "" } });
  await audit(req, "rsvp_delete", "rsvp", String(r._id), `${[r.firstName, r.lastName].filter(Boolean).join(" ")} (${r.tier || ""})`);
  res.json({ ok: true });
});

router.get("/rsvps/:id", async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: "RSVP not found" });
  const r = await Rsvp.findById(req.params.id).lean();
  if (!r) return res.status(404).json({ error: "RSVP not found" });
  res.json({ rsvp: rsvpDetail(r) });
});

// A possible duplicate (a second RSVP for a name, not proven to be the same person). Body { action }:
//   "merge"    the same person: one row stays listed, the ticket-verified one (its key and pass) or else the
//              RSVP this duplicates, with the NEWER of the two sets of answers; the other is kept for the record.
//   "separate" a different person with the same name: counted on its own, never flagged again.
// Logic and tests: services/rsvpHandler.js resolveRsvpDuplicate, services/rsvp.js planRsvpMerge.
const rsvpResolveStore = {
  findLive: (id) => (isId(id) ? Rsvp.findOne({ _id: id, ...LIVE_RSVPS }).select("+editTokenHash").lean() : Promise.resolve(null)),
  update: (id, set, inc) => Rsvp.findByIdAndUpdate(id, { $set: set, ...(inc ? { $inc: inc } : {}) }, { new: true }).lean(),
  repoint: (fromId, toId) => Rsvp.updateMany({ duplicateOf: fromId, ...LIVE_RSVPS }, { $set: { duplicateOf: toId } }),
};
router.post("/rsvps/:id/resolve", async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: "RSVP not found" });
  const r = await resolveRsvpDuplicate(rsvpResolveStore, req.params.id, String(req.body?.action || ""), { name: req.user?.name });
  if (r.error) return res.status(r.status).json({ error: r.error });
  await audit(req, r.audit.action, "rsvp", r.audit.targetId, r.audit.detail);
  res.json({ rsvp: rsvpDetail(r.row), dropped: r.dropped });
});

// Staff fill in or correct what we know about a ticket holder.
// Body: { key: "u:<userId>:<ticketId>" | "g:<ticketId>", details: { organisation, jobTitle, phone, linkedin, country, notes }, name? }
// `name` only applies to guest tickets (account names belong to the person's profile).
router.patch("/tickets/details", async (req, res) => {
  const parts = String(req.body?.key || "").split(":");
  const edit = cleanStaffEdit(req.body?.details);
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 120) : "";
  let details;
  if (parts[0] === "u" && parts.length >= 3 && isId(parts[1])) {
    const ticketId = parts.slice(2).join(":");
    const user = await User.findOne({ _id: parts[1], "tickets.ticketId": ticketId }).select("tickets").lean();
    const t = user?.tickets?.find((x) => x.ticketId === ticketId);
    if (!t) return res.status(404).json({ error: "Ticket not found" });
    details = mergeStaffEdit(t.details, edit);
    await User.updateOne({ _id: parts[1], "tickets.ticketId": ticketId }, { $set: { "tickets.$.details": details } });
  } else if (parts[0] === "g" && parts.length >= 2) {
    const ticketId = parts.slice(1).join(":");
    const a = await Attendee.findOne({ ticketId }).select("details").lean();
    if (!a) return res.status(404).json({ error: "Ticket not found" });
    details = mergeStaffEdit(a.details, edit);
    await Attendee.updateOne({ ticketId }, { $set: { details, ...(name ? { name } : {}) } });
  } else {
    return res.status(400).json({ error: "Unknown ticket" });
  }
  await audit(req, "ticket_details_edit", "ticket", parts.slice(-1)[0], Object.keys(edit).concat(name ? ["name"] : []).join(", "));
  res.json({ details, ...(name && parts[0] === "g" ? { name } : {}) });
});

/* ---------- "Complete your profile" requests ----------
   Many tickets were bought before checkout answers were saved. Staff can
   email those people a personal link to fill the form in themselves
   (website /complete-profile, public API routes/completeProfile.js).
   Management only: it emails attendees. Nothing is sent without
   preview: false, which the panel only does after a confirm click. */

const PROFILE_SEND_MAX = 500;         // per request; the rest go on the next click
const PROFILE_SEND_GAP_MS = 600;      // Resend allows ~2 emails a second

const firstNameOf = (r) => firstNameFor({ firstName: r.details?.firstName, name: r.name });
const profileRowOut = (r) => ({
  key: r.key, name: r.name, email: r.email, ticketId: r.ticketId, tier: r.tier, purchaseDate: r.purchaseDate,
  source: r.source, profileRequestedAt: r.profileRequestedAt, profileCompletedAt: r.profileCompletedAt,
  organisation: r.details?.organisation || "", jobTitle: r.details?.jobTitle || "",
});

/** Where the stamp goes: dotted paths keep anything written to details meanwhile. */
async function stampProfileRequest(r) {
  const stamp = requestStamp(r.details);
  const hasObj = r.details && typeof r.details === "object";
  const parts = r.key.split(":");
  if (r.source === "account") {
    const $set = hasObj
      ? { "tickets.$.details.profileRequestedAt": stamp.profileRequestedAt, "tickets.$.details.profileRequestCount": stamp.profileRequestCount }
      : { "tickets.$.details": stamp };
    await User.updateOne({ _id: parts[1], "tickets.ticketId": r.ticketId }, { $set });
  } else {
    const $set = hasObj
      ? { "details.profileRequestedAt": stamp.profileRequestedAt, "details.profileRequestCount": stamp.profileRequestCount }
      : { details: stamp };
    await Attendee.updateOne({ ticketId: r.ticketId }, { $set });
  }
}

// Body: { keys?: [...], preview?: true, force?: true (single key only), sampleKey? }
// preview → { count, rows, skipped: { reason: n }, sample: { to, subject, html, text } }
// send    → { sent, skipped, failed, remaining, failures: [{ key, name, email, error }] }
router.post("/tickets/profile-request", requireManagement, async (req, res) => {
  const keys = Array.isArray(req.body?.keys) ? req.body.keys.filter((k) => typeof k === "string").slice(0, 5000) : [];
  const force = req.body?.force === true;
  if (!profileLinksReady()) {
    return res.status(503).json({ error: "Profile links can't be signed: set WALLET_LINK_SECRET (or JWT_SECRET) on the server." });
  }
  const { eligible, skipped } = planProfileRequests(await allTicketRows(), { keys, force });

  if (req.body?.preview) {
    const sampleRow = eligible.find((r) => r.key === req.body?.sampleKey) || eligible[0];
    const sample = sampleRow
      ? { to: sampleRow.email, name: sampleRow.name, ...buildProfileRequestEmail({ firstName: firstNameOf(sampleRow), tier: sampleRow.tier, link: profileLink(sampleRow.ticketId) }) }
      : null;
    return res.json({ count: eligible.length, rows: eligible.map(profileRowOut), skipped: countReasons(skipped), sample, maxPerSend: PROFILE_SEND_MAX });
  }

  const batch = eligible.slice(0, PROFILE_SEND_MAX);
  const { sent, failed } = await sendSequentially(batch, async (r) => {
    await sendProfileRequestEmail({ email: r.email, firstName: firstNameOf(r), tier: r.tier, link: profileLink(r.ticketId) });
    await stampProfileRequest(r).catch((e) => console.error("PROFILE REQUEST STAMP ERROR:", r.key, e?.message));
  }, { delayMs: PROFILE_SEND_GAP_MS });

  const who = keys.length === 1 ? ` · ${keys[0]}${force ? " (forced)" : ""}` : "";
  await audit(req, "profile_request_send", "ticket", keys.length === 1 ? keys[0].split(":").slice(-1)[0] : "",
    `sent ${sent.length}, skipped ${skipped.length}, failed ${failed.length}${who}`);
  res.json({
    sent: sent.length, skipped: skipped.length, failed: failed.length,
    remaining: Math.max(0, eligible.length - batch.length),
    skippedReasons: countReasons(skipped),
    failures: failed.map(({ item, error }) => ({ key: item.key, name: item.name, email: item.email, error })),
  });
});

// A ticket's personal form link, for staff to send themselves. ?key=u:<userId>:<ticketId> | g:<ticketId>
router.get("/tickets/profile-link", requireManagement, async (req, res) => {
  const key = String(req.query.key || "");
  const row = (await allTicketRows()).find((r) => r.key === key);
  if (!row) return res.status(404).json({ error: "Ticket not found" });
  const link = profileLink(row.ticketId);
  if (!link) return res.status(503).json({ error: "Profile links can't be signed: set WALLET_LINK_SECRET (or JWT_SECRET) on the server." });
  await audit(req, "profile_link_copy", "ticket", row.ticketId, row.email);
  res.json({ link });
});

async function setHidden(keys, hidden) {
  let changed = 0;
  for (const key of keys.slice(0, 1000)) {
    const parts = String(key).split(":");
    if (parts[0] === "u" && parts.length >= 3 && isId(parts[1])) {
      const r = await User.updateOne({ _id: parts[1], "tickets.ticketId": parts.slice(2).join(":") },
                                     { $set: { "tickets.$.hiddenByStaff": hidden } });
      changed += r.modifiedCount || 0;
    } else if (parts[0] === "g" && parts.length >= 2) {
      const r = await Attendee.updateOne({ ticketId: parts.slice(1).join(":") }, { $set: { hiddenByStaff: hidden } });
      changed += r.modifiedCount || 0;
    }
  }
  return changed;
}

// Complimentary pass (speakers, guests, App Review). Management only.
// Body: { name: "First Last", email, tier }. The holder signs in to the apps with the
// last name + ticket ID, or with a sign-in link to this email.
router.post("/tickets/complimentary", requireManagement, async (req, res) => {
  const check = validateComplimentary(req.body);
  if (!check.ok) return res.status(400).json({ error: check.error });
  const { name, email, tier } = check.value;
  const attendee = await Attendee.create({
    name, email, ticketType: tier, promoCode: COMP_PROMO,
    ticketId: crypto.randomBytes(6).toString("hex"),
  });
  await audit(req, "ticket_complimentary", "ticket", attendee.ticketId, `${tier} pass for ${email}`);
  res.status(201).json({ ticketId: attendee.ticketId, name, email, tier, lastName: name.split(" ").slice(-1)[0] });
});

/* ---------- Speaker Passes ----------
   A ghost pass (ticketType "speaker", never sold or listed) for every speaker on the
   website, made from the Sanity speaker list with no email (services/speakerPasses.js).
   Staff add each speaker's email, preview the pass email, then management sends it.
   Nothing is ever emailed without a send click; send-all needs { confirm: "SEND" }. */

const SPEAKER_PASS_FIELDS = "name email alsoTo ticketId ticketType speakerId details passEmailSentAt passEmailSentTo " +
  "passEmailSentCount claimedBy checkedIn createdAt purchaseDate runOfShow speakerContact invitesSentAt invitesSentCount " +
  "speakerNudgedAt speakerNudgeCount";
// Who's copied on speaker emails and invites until staff change it in Edit email (SPEAKER_CC, comma-separated).
const DEFAULT_SPEAKER_CC = () => String(process.env.SPEAKER_CC ?? "lubna@thetechfestival.com").split(",")
  .map((e) => e.trim().toLowerCase()).filter(Boolean);
const SPEAKER_TEMPLATE_KEY = "speaker-pass";

/** The saved wording and cc list: { copy: { subject, headline, message } ("" = built-in), cc: [] }. */
async function speakerTemplate() {
  const t = await EmailTemplate.findOne({ key: SPEAKER_TEMPLATE_KEY }).lean();
  return {
    copy: { subject: t?.subject || "", headline: t?.headline || "", message: t?.message || "" },
    cc: Array.isArray(t?.cc) ? t.cc : DEFAULT_SPEAKER_CC(),
    updatedAt: t?.updatedAt || null,
    updatedBy: t?.updatedBy || "",
  };
}

/**
 * This send's wording, recipients and cc: the saved template, with anything in `body` taking over
 * (subject / headline / message: "" = built-in; to / cc: "a@x, b@y" or a list).
 * → { ok, copy, to?, cc } | { ok: false, error }
 */
function sendOptions(body = {}, template) {
  const copy = { ...template.copy, ...cleanCopy(body) };
  let to;
  if (body.to !== undefined) {
    const check = validateSpeakerEmails(body.to);
    if (!check.ok || !check.list.length) return { ok: false, error: check.ok ? "Add at least one address to send to." : check.error };
    to = check.list;
  }
  let cc = template.cc;
  if (body.cc !== undefined) {
    const check = validateSpeakerEmails(body.cc, { max: 10 });
    if (!check.ok) return { ok: false, error: `Cc: ${check.error}` };
    cc = check.list;
  }
  return { ok: true, copy, to, cc };
}
const SPEAKER_SCOPE = { ticketType: SPEAKER_TYPE };
let speakerSendAllRunning = false;

const findSpeakerPass = (id) => (isId(id)
  ? Attendee.findOne({ _id: id, ...SPEAKER_SCOPE }).select(SPEAKER_PASS_FIELDS).lean()
  : null);

/**
 * The pass as the website has it now (services/speakerWebsite.js): its speaker's current name,
 * title and company (stored when they changed) and the run of show from the agenda.
 * → { doc, source: "agenda" | "saved" | null, onWebsite }
 */
async function livePass(a, site) {
  const live = applyWebsite(a, site === undefined ? await loadWebsite() : site);
  if (live.changes) await Attendee.updateOne({ _id: a._id, ...SPEAKER_SCOPE }, { $set: live.changes }).catch(() => {});
  return live;
}

/**
 * Emails one pass (with its run of show), then a calendar invite per session, and records both.
 * `opts`: { to (default: the pass's addresses), cc, copy }. Anyone in To is dropped from Cc.
 * An invite failure doesn't undo the pass email: it comes back as `inviteError`.
 */
async function sendSpeakerPass(a, opts = {}) {
  const row = speakerPassRow((await livePass(a, opts.site)).doc);
  const to = opts.to?.length ? opts.to : passRecipients(a);
  const cc = (opts.cc ?? DEFAULT_SPEAKER_CC()).filter((e) => !to.includes(e));
  await sendSpeakerPassEmail({ to, pass: row, cc, copy: opts.copy || {} });
  let updated = await Attendee.findOneAndUpdate(
    { _id: a._id, ...SPEAKER_SCOPE },
    // The Speaker Pass email always has the RSVP button (People › "RSVP email sent").
    { $set: { passEmailSentAt: new Date(), passEmailSentTo: to.join(", "), passEmailRsvp: true }, $inc: { passEmailSentCount: 1 } },
    { new: true },
  ).select(SPEAKER_PASS_FIELDS).lean();
  if (!row.sessions) return updated;
  try {
    await sendSessionInvites({ pass: row, to, cc, sequence: row.invitesSentCount });
    updated = await Attendee.findOneAndUpdate(
      { _id: a._id, ...SPEAKER_SCOPE },
      { $set: { invitesSentAt: new Date() }, $inc: { invitesSentCount: 1 } },
      { new: true },
    ).select(SPEAKER_PASS_FIELDS).lean();
    return updated;
  } catch (err) {
    return { ...updated, inviteError: String(err?.message || err).slice(0, 300) };
  }
}

/** RSVPs keyed by ticket ID → { at, days, options } for the speaker passes list. */
async function speakerRsvps(ticketIds) {
  const ids = ticketIds.filter(Boolean);
  if (!ids.length) return new Map();
  const docs = await Rsvp.find({ ...LIVE_RSVPS, ticketId: { $in: ids.flatMap((t) => [t, t.toUpperCase(), t.toLowerCase()]) } })
    .select("ticketId days options updatedAt").lean();
  return new Map(docs.map((r) => [String(r.ticketId).toLowerCase(), { at: r.updatedAt || null, days: r.days || [], options: r.options || [] }]));
}

// The editable wording + cc list. → { template: { subject, headline, message, cc }, defaults, updatedAt, updatedBy }
router.get("/speaker-passes/template", async (req, res) => {
  const t = await speakerTemplate();
  res.json({ template: { ...t.copy, cc: t.cc }, defaults: { ...DEFAULT_COPY, cc: DEFAULT_SPEAKER_CC() }, updatedAt: t.updatedAt, updatedBy: t.updatedBy });
});

// Body: { subject, headline, message ("" = built-in text), cc: "a@x, b@y" | [] }. Management.
router.put("/speaker-passes/template", requireManagement, async (req, res) => {
  const copy = cleanCopy(req.body || {});
  const check = validateSpeakerEmails(req.body?.cc ?? DEFAULT_SPEAKER_CC(), { max: 10 });
  if (!check.ok) return res.status(400).json({ error: `Cc: ${check.error}` });
  // Saving the built-in text unchanged keeps it "built-in" (so the no-run-of-show wording still applies).
  for (const k of ["subject", "headline", "message"]) if (copy[k] === DEFAULT_COPY[k]) copy[k] = "";
  const by = String(req.user?.name || req.user?.email || "");
  await EmailTemplate.findOneAndUpdate({ key: SPEAKER_TEMPLATE_KEY },
    { $set: { subject: copy.subject || "", headline: copy.headline || "", message: copy.message || "", cc: check.list, updatedBy: by } },
    { upsert: true });
  await audit(req, "speaker_pass_template", "ticket", "", `subject ${copy.subject ? "custom" : "default"}, cc: ${check.list.join(", ") || "nobody"}`);
  const t = await speakerTemplate();
  res.json({ template: { ...t.copy, cc: t.cc }, defaults: { ...DEFAULT_COPY, cc: DEFAULT_SPEAKER_CC() }, updatedAt: t.updatedAt, updatedBy: t.updatedBy });
});

// Emails the passes picked in the list. Body: { ids: [...], confirm: "SEND", cc?, subject?, headline?, message? }.
// Passes without an email are skipped. → { sent, failed, skipped, inviteErrors, failures }
router.post("/speaker-passes/send-selected", requireManagement, async (req, res) => {
  if (req.body?.confirm !== "SEND") return res.status(400).json({ error: "Type SEND to confirm." });
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter(isId).slice(0, 200);
  if (!ids.length) return res.status(400).json({ error: "Pick at least one speaker." });
  if (speakerSendAllRunning) return res.status(409).json({ error: "A send to speakers is already running." });
  const opts = sendOptions({ ...req.body, to: undefined }, await speakerTemplate());
  if (!opts.ok) return res.status(400).json({ error: opts.error });
  speakerSendAllRunning = true;
  try {
    const docs = await Attendee.find({ _id: { $in: ids }, ...SPEAKER_SCOPE }).select(SPEAKER_PASS_FIELDS).lean();
    const withEmail = docs.filter((d) => passRecipients(d).length);
    let inviteErrors = 0;
    const { sent, failed } = await sendSequentially(withEmail, async (d) => {
      const u = await sendSpeakerPass(d, opts);
      if (u?.inviteError) inviteErrors++;
    }, { delayMs: PROFILE_SEND_GAP_MS });
    await audit(req, "speaker_pass_send_selected", "ticket", "", `sent ${sent.length}, failed ${failed.length}, skipped ${docs.length - withEmail.length}, cc: ${opts.cc.join(", ") || "nobody"}`);
    res.json({
      sent: sent.length, failed: failed.length, skipped: docs.length - withEmail.length, inviteErrors,
      failures: failed.map(({ item, error }) => ({ id: String(item._id), name: item.name, email: item.email, error })),
    });
  } finally {
    speakerSendAllRunning = false;
  }
});

// → { rows: [speakerPassRow], counts: { passes, withEmail, sent, ready } }
// Each row also has sessionsSource ("agenda" | "saved" | null) and onWebsite (false: not a speaker on
// the website any more, or never was: a manual pass).
router.get("/speaker-passes", async (req, res) => {
  const docs = await Attendee.find(SPEAKER_SCOPE).select(SPEAKER_PASS_FIELDS).lean();
  const [rsvps, site] = await Promise.all([speakerRsvps(docs.map((d) => d.ticketId)), loadWebsite()]);
  const live = await Promise.all(docs.map((d) => livePass(d, site)));
  const rows = live.map(({ doc, source, onWebsite }) => ({
    ...speakerPassRow(doc), sessionsSource: source, onWebsite,
    rsvp: rsvps.get(String(doc.ticketId).toLowerCase()) || null,
  })).sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  res.json({ rows, counts: speakerPassCounts(rows), websiteOk: !!site });
});

/**
 * Before creating passes: a manual pass ("manual:<name>", made before the speaker was on the
 * website) is linked to its website speaker, and the empty second pass a sync made for them is
 * removed (never one with an address, a send, the app, a check-in or an RSVP).
 * → { linked: [names], merged: [names], dupes: [names] }
 */
async function linkManualPasses(site) {
  const passes = await Attendee.find(SPEAKER_SCOPE).select(SPEAKER_PASS_FIELDS).lean();
  const plan = planWebsiteLinks(passes, site.speakers);
  const out = { linked: [], merged: [], dupes: plan.dupes.map((d) => d.speaker.name) };
  const toSpeaker = (sp) => ({ speakerId: sp.speakerId, name: sp.name, "details.jobTitle": sp.title || "", "details.organisation": sp.company || "" });
  for (const { keep, speaker } of plan.link) {
    await Attendee.updateOne({ _id: keep._id, ...SPEAKER_SCOPE }, { $set: toSpeaker(speaker) });
    out.linked.push(speaker.name);
  }
  for (const { keep, drop, speaker } of plan.merge) {
    const t = String(drop.ticketId || "");
    if (await Rsvp.exists({ ticketId: { $in: [t, t.toUpperCase(), t.toLowerCase()] } })) { out.dupes.push(speaker.name); continue; }
    const gone = await Attendee.deleteOne({
      _id: drop._id, ...SPEAKER_SCOPE, passEmailSentAt: { $in: [null] }, claimedBy: { $in: [null] }, checkedIn: { $ne: true },
      $or: [{ email: { $in: [null, ""] } }, { email: { $exists: false } }],
    });
    if (!gone.deletedCount) { out.dupes.push(speaker.name); continue; }
    await Attendee.updateOne({ _id: keep._id, ...SPEAKER_SCOPE }, { $set: toSpeaker(speaker) });
    out.merged.push(speaker.name);
  }
  return out;
}

// Makes a pass for every speaker who doesn't have one (keyed by Sanity _id; Chris Golden excluded),
// after linking manual passes to their speaker (linkManualPasses). Safe to run again.
// → { total, created, existing, excluded, createdNames, excludedNames, linkedNames, mergedNames, duplicateNames }
router.post("/speaker-passes/sync", requireManagement, async (req, res) => {
  try {
    const site = await loadWebsite({ fresh: true });
    if (!site) throw new Error("speaker list unavailable");
    const links = await linkManualPasses(site);
    const result = await syncSpeakerPasses({
      loadSpeakers: async () => site.speakers,
      existingSpeakerIds: async () => (await Attendee.find({ speakerId: { $nin: [null, ""] } }).select("speakerId").lean()).map((a) => a.speakerId),
      create: (doc) => Attendee.create(doc),
    });
    await audit(req, "speaker_passes_sync", "ticket", "",
      `${result.created} created, ${result.existing} existing, ${result.excluded} excluded${result.createdNames.length ? `: ${result.createdNames.join(", ")}` : ""}` +
      `${links.linked.length ? `; linked ${links.linked.join(", ")}` : ""}${links.merged.length ? `; merged ${links.merged.join(", ")}` : ""}`);
    res.json({ ...result, linkedNames: links.linked, mergedNames: links.merged, duplicateNames: links.dupes });
  } catch (err) {
    console.error("SPEAKER PASS SYNC ERROR:", err?.message || err);
    res.status(502).json({ error: `Couldn't create the passes: ${err?.message || "speaker list unavailable"}` });
  }
});

// The "Preview email" button: a made-up speaker, nothing personal.
async function samplePreview(req, res) {
  const opts = sendOptions(req.method === "POST" ? { ...req.body, to: undefined } : {}, await speakerTemplate());
  if (!opts.ok) return res.status(400).json({ error: opts.error });
  const { subject, html, text } = await speakerPassEmailFor(SAMPLE_SPEAKER, { inline: true, copy: opts.copy });
  res.json({ to: "", cc: opts.cc, subject, html, text });
}
router.get("/speaker-passes/preview-sample", samplePreview);
router.post("/speaker-passes/preview-sample", samplePreview);

// Body: any of { email ("" clears it), contact ("own" | "handler" | "team" | ""), runOfShow (null clears it),
// name, title, company (manual passes only: a website speaker's come from Admin → Speakers) }.
// Staff and management.
router.patch("/speaker-passes/:id", async (req, res) => {
  const body = req.body || {};
  const set = {};
  const details = ["name", "title", "company"].filter((k) => k in body);
  if (details.length) {
    const pass = await findSpeakerPass(req.params.id);
    if (!pass) return res.status(404).json({ error: "Speaker pass not found" });
    if (!String(pass.speakerId || "").startsWith("manual:")) {
      return res.status(400).json({ error: "This speaker is on the website: change their name, title or company in Admin → Speakers and the pass follows." });
    }
    const tidy = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
    if ("name" in body) {
      if (tidy(body.name, 120).length < 3) return res.status(400).json({ error: "Enter the speaker's full name." });
      set.name = tidy(body.name, 120);
    }
    if ("title" in body) set["details.jobTitle"] = tidy(body.title, 200);
    if ("company" in body) set["details.organisation"] = tidy(body.company, 200);
  }
  if ("email" in body || !("runOfShow" in body || "contact" in body || details.length)) {
    // "a@x.com, b@y.com": the first is the main address, the rest also get the pass email.
    const check = validateSpeakerEmails(body.email ?? "");
    if (!check.ok) return res.status(400).json({ error: check.error });
    set.email = check.list[0] || "";
    set.alsoTo = check.list.slice(1);
  }
  if ("contact" in body) {
    const check = validateContact(body.contact);
    if (!check.ok) return res.status(400).json({ error: check.error });
    set.speakerContact = check.value;
  }
  if ("runOfShow" in body) {
    const check = validateRunOfShow(body.runOfShow);
    if (!check.ok) return res.status(400).json({ error: check.error });
    set.runOfShow = check.value;
  }
  const before = await findSpeakerPass(req.params.id);
  if (!before) return res.status(404).json({ error: "Speaker pass not found" });
  const a = await Attendee.findOneAndUpdate({ _id: before._id, ...SPEAKER_SCOPE }, { $set: set }, { new: true })
    .select(SPEAKER_PASS_FIELDS).lean();
  if ("email" in set && passRecipients(before).join(", ") !== passRecipients(a).join(", ")) {
    await audit(req, "speaker_pass_email", "ticket", a.ticketId,
      `${a.name}: ${passRecipients(before).join(", ") || "no email"} → ${passRecipients(a).join(", ") || "no email"}`);
  }
  if ("runOfShow" in set) {
    await audit(req, "speaker_pass_run_of_show", "ticket", a.ticketId, `${a.name}: ${set.runOfShow?.sessions?.length || 0} session(s)`);
  }
  if (details.length) {
    await audit(req, "speaker_pass_details", "ticket", a.ticketId, `${before.name} → ${a.name}${a.details?.jobTitle ? `, ${a.details.jobTitle}` : ""}${a.details?.organisation ? `, ${a.details.organisation}` : ""}`);
  }
  const live = await livePass(a);
  res.json({ row: { ...speakerPassRow(live.doc), sessionsSource: live.source, onWebsite: live.onWebsite } });
});

// A pass for a speaker who isn't on the website. Body: { name, title?, company? }. Management.
router.post("/speaker-passes", requireManagement, async (req, res) => {
  const name = String(req.body?.name || "").replace(/\s+/g, " ").trim();
  if (name.length < 3) return res.status(400).json({ error: "Enter the speaker's full name." });
  const doc = manualSpeakerPassDoc({ name, title: req.body?.title, company: req.body?.company });
  try {
    const a = await Attendee.create(doc);
    await audit(req, "speaker_pass_create", "ticket", a.ticketId, name);
    res.status(201).json({ row: speakerPassRow(a.toObject()) });
  } catch (err) {
    if (err?.code === 11000) return res.status(409).json({ error: "There's already a pass for that name." });
    throw err;
  }
});

// → { to, toList, cc, subject, html, text } with the QR inline, for the admin preview.
// POST previews unsaved edits (same body as /send).
async function passPreview(req, res) {
  const a = await findSpeakerPass(req.params.id);
  if (!a) return res.status(404).json({ error: "Speaker pass not found" });
  const opts = sendOptions(req.method === "POST" ? req.body || {} : {}, await speakerTemplate());
  if (!opts.ok) return res.status(400).json({ error: opts.error });
  const row = speakerPassRow((await livePass(a)).doc);
  const to = opts.to || row.emails;
  const { subject, html, text } = await speakerPassEmailFor(row, { inline: true, copy: opts.copy });
  res.json({ to: to.join(", "), toList: to, cc: opts.cc.filter((e) => !to.includes(e)), subject, html, text });
}
router.get("/speaker-passes/:id/preview", passPreview);
router.post("/speaker-passes/:id/preview", passPreview);

// Emails one speaker their pass (again, if it was sent before). Management only.
// Body (all optional, this send only): { to, cc, subject, headline, message }.
router.post("/speaker-passes/:id/send", requireManagement, async (req, res) => {
  const a = await findSpeakerPass(req.params.id);
  if (!a) return res.status(404).json({ error: "Speaker pass not found" });
  const opts = sendOptions(req.body || {}, await speakerTemplate());
  if (!opts.ok) return res.status(400).json({ error: opts.error });
  const to = opts.to || passRecipients(a);
  if (!to.length) return res.status(400).json({ error: "Add the speaker's email first." });
  const again = speakerPassRow(a).sentCount > 0;
  let updated;
  try {
    updated = await sendSpeakerPass(a, { ...opts, to });
  } catch (err) {
    await audit(req, "speaker_pass_send_failed", "ticket", a.ticketId, `${a.name} → ${to.join(", ")}: ${err?.message || err}`);
    return res.status(502).json({ error: `Couldn't send: ${err?.message || "the email service refused it"}` });
  }
  await audit(req, "speaker_pass_send", "ticket", a.ticketId,
    `${a.name} → ${to.join(", ")}${opts.cc.length ? ` (cc ${opts.cc.join(", ")})` : ""}${again ? " (resent)" : ""}`);
  if (updated?.inviteError) await audit(req, "speaker_invite_failed", "ticket", a.ticketId, `${a.name}: ${updated.inviteError}`);
  const live = await livePass(updated || a);
  res.json({
    row: { ...speakerPassRow(live.doc), sessionsSource: live.source, onWebsite: live.onWebsite },
    ...(updated?.inviteError ? { inviteError: updated.inviteError } : {}),
  });
});

/* ---------- Nudges: a reminder to RSVP ----------
   The Speaker Pass email again (same pass, run of show and RSVP button) with nudge wording
   (services/speakerWebsite.js NUDGE_COPY, editable per send) and the usual cc. No calendar
   invites. Speakers who have RSVP'd are always skipped. */

/** Wording, To and Cc for a nudge: the nudge defaults (not the pass wording) and the usual cc. */
async function nudgeOptions(body = {}) {
  const t = await speakerTemplate();
  const opts = sendOptions(body, { ...t, copy: {} });
  return opts.ok ? { ...opts, copy: nudgeCopy(opts.copy) } : opts;
}

async function nudgeSpeaker(a, opts) {
  const row = speakerPassRow((await livePass(a, opts.site)).doc);
  const to = opts.to?.length ? opts.to : passRecipients(a);
  const cc = (opts.cc ?? DEFAULT_SPEAKER_CC()).filter((e) => !to.includes(e));
  await sendSpeakerPassEmail({ to, pass: row, cc, copy: opts.copy });
  return Attendee.findOneAndUpdate({ _id: a._id, ...SPEAKER_SCOPE },
    { $set: { speakerNudgedAt: new Date() }, $inc: { speakerNudgeCount: 1 } }, { new: true })
    .select(SPEAKER_PASS_FIELDS).lean();
}

/** Without ids: everyone who was sent their pass and has an address. → { docs, targets (no RSVP yet) } */
async function nudgeTargets(ids) {
  const filter = ids ? { _id: { $in: ids }, ...SPEAKER_SCOPE } : { ...SPEAKER_SCOPE, passEmailSentAt: { $ne: null } };
  const docs = (await Attendee.find(filter).select(SPEAKER_PASS_FIELDS).lean()).filter((d) => passRecipients(d).length);
  const rsvps = await speakerRsvps(docs.map((d) => d.ticketId));
  return { docs, targets: docs.filter((d) => !rsvps.has(String(d.ticketId).toLowerCase())) };
}

// The wording a nudge starts from. → { defaults: { subject, headline, message }, cc }
router.get("/speaker-passes/nudge/defaults", async (req, res) => {
  const t = await speakerTemplate();
  res.json({ defaults: NUDGE_COPY, cc: t.cc });
});

// Body: { confirm: "SEND", ids?, cc?, subject?, headline?, message? }. Without ids: everyone sent their
// pass with no RSVP yet. → { sent, failed, skipped (RSVP'd already), failures }. Management.
router.post("/speaker-passes/nudge", requireManagement, async (req, res) => {
  if (req.body?.confirm !== "SEND") return res.status(400).json({ error: "Type SEND to confirm." });
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(isId).slice(0, 200) : null;
  if (ids && !ids.length) return res.status(400).json({ error: "Pick at least one speaker." });
  if (speakerSendAllRunning) return res.status(409).json({ error: "A send to speakers is already running." });
  const opts = await nudgeOptions({ ...req.body, to: undefined });
  if (!opts.ok) return res.status(400).json({ error: opts.error });
  speakerSendAllRunning = true;
  try {
    const { docs, targets } = await nudgeTargets(ids);
    const site = await loadWebsite();
    const { sent, failed } = await sendSequentially(targets, (d) => nudgeSpeaker(d, { ...opts, site }), { delayMs: PROFILE_SEND_GAP_MS });
    await audit(req, "speaker_nudge_all", "ticket", "", `nudged ${sent.length}, failed ${failed.length}, skipped ${docs.length - targets.length} (RSVP'd)`);
    res.json({
      sent: sent.length, failed: failed.length, skipped: docs.length - targets.length,
      failures: failed.map(({ item, error }) => ({ id: String(item._id), name: item.name, email: item.email, error })),
    });
  } finally {
    speakerSendAllRunning = false;
  }
});

// → { to, toList, cc, subject, html, text }: one nudge as it would go, with unsaved edits (same body as /nudge).
router.post("/speaker-passes/:id/nudge/preview", async (req, res) => {
  const a = await findSpeakerPass(req.params.id);
  if (!a) return res.status(404).json({ error: "Speaker pass not found" });
  const opts = await nudgeOptions(req.body || {});
  if (!opts.ok) return res.status(400).json({ error: opts.error });
  const row = speakerPassRow((await livePass(a)).doc);
  const to = opts.to || row.emails;
  const { subject, html, text } = await speakerPassEmailFor(row, { inline: true, copy: opts.copy });
  res.json({ to: to.join(", "), toList: to, cc: opts.cc.filter((e) => !to.includes(e)), subject, html, text });
});

// Nudges one speaker. Body (optional): { to, cc, subject, headline, message }. Management.
router.post("/speaker-passes/:id/nudge", requireManagement, async (req, res) => {
  const a = await findSpeakerPass(req.params.id);
  if (!a) return res.status(404).json({ error: "Speaker pass not found" });
  const opts = await nudgeOptions(req.body || {});
  if (!opts.ok) return res.status(400).json({ error: opts.error });
  const to = opts.to || passRecipients(a);
  if (!to.length) return res.status(400).json({ error: "Add the speaker's email first." });
  let updated;
  try {
    updated = await nudgeSpeaker(a, { ...opts, to });
  } catch (err) {
    await audit(req, "speaker_nudge_failed", "ticket", a.ticketId, `${a.name} → ${to.join(", ")}: ${err?.message || err}`);
    return res.status(502).json({ error: `Couldn't send: ${err?.message || "the email service refused it"}` });
  }
  await audit(req, "speaker_nudge", "ticket", a.ticketId, `${a.name} → ${to.join(", ")}${opts.cc.length ? ` (cc ${opts.cc.join(", ")})` : ""}`);
  const live = await livePass(updated || a);
  res.json({ row: { ...speakerPassRow(live.doc), sessionsSource: live.source, onWebsite: live.onWebsite } });
});

// Emails every pass that has an email and hasn't been sent to it. Body must be { confirm: "SEND" }.
// → { sent, failed, skipped, failures: [{ id, name, email, error }] }
router.post("/speaker-passes/send-all", requireManagement, async (req, res) => {
  if (req.body?.confirm !== "SEND") return res.status(400).json({ error: 'Type SEND to confirm.' });
  if (speakerSendAllRunning) return res.status(409).json({ error: "A send to all speakers is already running." });
  speakerSendAllRunning = true;
  try {
    const all = await Attendee.find(SPEAKER_SCOPE).select(SPEAKER_PASS_FIELDS).lean();
    const ready = readyToSend(all);
    const opts = sendOptions({}, await speakerTemplate());
    const { sent, failed } = await sendSequentially(ready, (d) => sendSpeakerPass(d, opts), { delayMs: PROFILE_SEND_GAP_MS });
    await audit(req, "speaker_pass_send_all", "ticket", "", `sent ${sent.length}, failed ${failed.length}, skipped ${all.length - ready.length}`);
    res.json({
      sent: sent.length, failed: failed.length, skipped: all.length - ready.length,
      failures: failed.map(({ item, error }) => ({ id: String(item._id), name: item.name, email: item.email, error })),
    });
  } finally {
    speakerSendAllRunning = false;
  }
});

// Body: { keys: ["u:<userId>:<ticketId>" | "g:<ticketId>", …], hidden: true|false }
router.post("/tickets/hide", async (req, res) => {
  const keys = Array.isArray(req.body?.keys) ? req.body.keys : [];
  const hidden = req.body?.hidden !== false;
  if (!keys.length) return res.status(400).json({ error: "No tickets selected" });
  const changed = await setHidden(keys, hidden);
  await audit(req, hidden ? "tickets_hide" : "tickets_unhide", "ticket", "", `${changed} ticket(s): ${keys.slice(0, 20).join(", ")}`);
  res.json({ changed });
});

// Hide every duplicate (same email), keeping each person's most recent ticket.
// Body: { preview: true } returns what would be hidden without changing anything.
router.post("/tickets/hide-duplicates", async (req, res) => {
  const rows = await allTicketRows();
  const keys = duplicateKeys(rows);
  if (req.body?.preview) {
    const set = new Set(keys);
    return res.json({ count: keys.length, rows: rows.filter((r) => set.has(r.key)) });
  }
  const changed = await setHidden(keys, true);
  await audit(req, "tickets_hide_duplicates", "ticket", "", `${changed} duplicate ticket(s)`);
  res.json({ changed });
});

/* ---------- Sales analytics ----------
   Revenue comes only from Stripe (what was actually paid, after promo codes,
   before HST, minus refunds), with booths / pavilion / other payments shown
   separately. Ticket counts, buyers and check-ins come from the ticket records. */
router.get("/sales", requireManagement, async (req, res) => {
  const range = ["day", "week", "month", "all"].includes(req.query.range) ? req.query.range : "month";
  const [rows, inventory] = await Promise.all([allTicketRows(), TicketInventory.find().lean()]);
  const prices = Object.fromEntries(inventory.map((t) => [t.tier, t.price || 0]));
  const records = salesSummary(rows, prices, { range });
  const out = {
    ...records,
    inventory: inventory.map((t) => ({ tier: t.tier, price: t.price || 0, sold: t.sold || 0, total: t.total || 0, archived: !!t.archived })),
  };
  let stripe = null;
  try {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY isn't set on the server");
    const client = new Stripe(process.env.STRIPE_SECRET_KEY);
    stripe = stripeSummary(await stripeRows(client, { force: req.query.refresh === "1" }), { range });
  } catch (err) {
    out.stripeError = err.message || "Couldn't reach Stripe";
  }
  if (stripe) {
    const checkins = Object.fromEntries(records.byTier.map((t) => [t.tier, t.checkedIn]));
    out.source = "stripe";
    out.totals = { ...records.totals, totalRevenue: stripe.ticketRevenue, paidTickets: stripe.paidTickets };
    out.sales = stripe.sales;
    out.byTier = stripe.byTier.map((t) => ({ ...t, checkedIn: checkins[t.tier] || 0 }));
    out.recent = stripe.recent;
    out.revenueBreakdown = stripe.breakdown;
    out.note = "Ticket revenue is synced from Stripe: what buyers actually paid after promo codes, before HST, minus refunds. " +
      "Booths, pavilion deposits and other Stripe payments are listed separately and are not counted as ticket sales. " +
      "Sponsorships invoiced outside Stripe aren't included. Refreshes every 5 minutes.";
  } else {
    out.source = "records";
    out.totals = { ...records.totals, totalRevenue: null };
    out.sales = records.sales.map((b) => ({ ...b, revenue: null }));
    out.byTier = records.byTier.map((t) => ({ ...t, revenue: null }));
    out.note = "Revenue unavailable: couldn't read Stripe. Ticket counts come from ticket records.";
  }
  res.json(out);
});

/* ---------- Inventory recount ----------
   The "sold" counters drifted (old webhook retries, duplicate imports).
   Recount from real tickets: visible pass tickets per tier (hidden test /
   duplicate tickets excluded) + paid booth orders from Stripe.
   Body { preview: true } shows the changes without saving. */
router.post("/inventory/recount", requireManagement, async (req, res) => {
  const [rows, inventory] = await Promise.all([allTicketRows(), TicketInventory.find()]);
  let booths = {}, boothNote = "";
  try {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY isn't set");
    for (const r of await stripeRows(new Stripe(process.env.STRIPE_SECRET_KEY))) {
      if (r.category === "booths" && r.tier) booths[r.tier] = (booths[r.tier] || 0) + 1;
    }
  } catch (e) { booths = null; boothNote = `Booths left unchanged: ${e.message}`; }
  const target = recountSold(rows, booths || {});
  const changes = [];
  for (const t of inventory) {
    const isBooth = t.tier.startsWith("booth-");
    if (isBooth && booths === null) continue;            // can't verify booths without Stripe
    const next = target[t.tier] || 0;
    if (next !== (t.sold || 0)) changes.push({ tier: t.tier, from: t.sold || 0, to: next, archived: !!t.archived });
  }
  if (req.body?.preview) return res.json({ changes, boothNote });
  for (const c of changes) {
    const doc = inventory.find((t) => t.tier === c.tier);
    doc.sold = c.to;
    if ((doc.total || 0) < c.to) doc.total = c.to;       // never leave sold above the allocation
    await doc.save();
  }
  await audit(req, "inventory_recount", "inventory", "", changes.map((c) => `${c.tier} ${c.from}→${c.to}`).join(", ") || "no changes");
  res.json({ changes, boothNote });
});

export default router;
