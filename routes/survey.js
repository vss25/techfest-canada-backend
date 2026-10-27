import express from "express";
import { AdminAudit } from "../models/Admin.js";
import SurveyResponse from "../models/SurveyResponse.js";
import { requireAdmin, requireManagement, isManagement } from "../middleware/adminAuth.js";
import { makeLimiter, SHARED_ADDRESS } from "../services/ticketAccess.js";
import { buildSurveyEmail, surveyLogoPng } from "../services/surveyEmail.js";
import { previewUnsubscribeUrl } from "../services/unsubscribe.js";
import {
  SURVEY_PAGE, AUDIENCES, publicSurvey, appSurveyCard, responseRow, responsesCsv, signSurveyToken, surveyOpen,
} from "../services/surveyRules.js";
import {
  loadSurvey, saveSurvey, identify, bearerUser, hasResponded, submitResponse, surveyStats, sendPrompt, emailPlan,
  sendSurveyEmails,
} from "../services/survey.js";
import { directory as peopleDirectory } from "./people.js";

/* =========================================================
   The post-event survey (Oct 26 2026): services/survey.js, services/surveyRules.js, services/surveyEmail.js.
   The website's /survey page and the native apps are built against these paths and fields.

   Who's answering: the app's sign-in (Authorization: Bearer <the app's user JWT>), else a personal link's
   t=<token> (kind "u" = an account, "p" = a pass with no account; services/surveyRules.js), else nobody (the shared
   link: they type their email, one response per email).

   Public (no sign-in needed), mounted at /api/survey:
     GET  /[?t=][&preview=1]   Cache-Control private, no-store
          → { open, opensAt, closesAt (ISO with offset), title, intro, thankYou, questions,
              respondent: { name, email, title, company } | null, responded, preview? }
            open = enabled && opensAt <= now < closesAt. questions only while open (else []); ?preview=1 with a staff
            account's Authorization shows them before it opens (preview: true). respondent: what we know about the
            person (to prefill About you); responded: they have answered already (answering again updates it).
            question: { id, section, type: "rating" | "nps" | "choice" | "multi" | "text" | "longtext" | "consent",
              label, required, help?, options? (choice / multi), minLabel? / maxLabel? (rating / nps),
              allowNA (rating / nps / choice: "na" is a valid answer, "Not applicable"),
              showIf? { question, includes } (show it only while that earlier choice / multi question's answer is, or
              includes, that option) }
     POST /responses  { answers: { [questionId]: value }, name?, email?, title?, company?, t? }
          → 201 { ok: true, first }   (first: false when it updated their earlier answers)
          → 400 { ok: false, field, error }   rating an integer 1–5, nps 0–10, choice one of options, multi a list of
            options, text ≤ 200, longtext ≤ 4000, consent true / false, "na" where allowNA; required ones answered
            (by default only name and email); an email that's an email. Blank = skipped (not stored); a question that
            isn't shown (showIf) is ignored and never required.
          → 403 { ok: false, code: "closed", error } outside the window · 429 { ok: false, error } (per address, sized
            for the venue's shared Wi-Fi, and per person)
          Stored: source "app" (an account: the app's sign-in or a "u" link) | "link" (a pass's link, the shared link),
          userId when known, the user agent (first 160 characters), a hash of the address.
     GET  /email-logo.png   the TTFC logo for the survey email (Resend's batch API takes no inline images)

   The app (signed in), mounted at /api/app/survey:
     GET  /   → { show, open, responded, opensAt, closesAt, title, body, cta: "Share feedback", url }
              url = https://www.thetechfestival.com/survey?t=<their token>; show = open && !responded.
              Cache-Control private, no-store. 401 without a sign-in.

   Admin (staff read, management changes and sends; audited), mounted at /api/console/survey:
     GET  /                 → { config, counts: { responses, app, link }, averages: { [ratingOrNpsId]: n | null },
                                na: { [id]: n }, open, url: "https://www.thetechfestival.com/survey", canEdit,
                                audiences: ["day1", "day2", "both"] }
                              config: { enabled, opensAt, closesAt, title, intro, thankYou, notifyTitle, notifyBody,
                                autoNotify, notifiedAt, notifiedCount, questions, retired (deleted questions, their
                                answers kept), saved, updatedAt, updatedBy }. averages leave "na" out.
     PUT  /  { any config fields, questions: the full list } (management) → { config, changed }
              Questions added without an id get one from their label (unique, never a deleted question's). Ids:
              unique slugs; types known; choice / multi need 2–20 options; at most 40; showIf must point to a choice /
              multi question above it and one of its options. A question left out is deleted: it moves to retired and
              its answers stay in the responses (the CSV marks it "(removed)"). 400 { error, field, index? }.
              notifiedAt is never set by a save.
     GET  /responses?page=  → { total, page, size: 50, questions, retired, rows: [{ id, at, firstAt, count, source,
                                name, email, title, company, userId, answers }] }   newest first
     GET  /export           CSV: one column per question (and per deleted question anyone answered, "(removed)"),
                            BOM, formula-escaped. Audited survey_export.
     POST /notify { confirm: "SEND" } (management) → { sent, already, answered, hidden }   the app prompt now: an
              in-app notification (their own link) + a push to everyone on the app who hasn't answered or been
              prompted. 403 { code: "closed" } while the survey isn't open; 409 { code: "busy" } while one is running.
     GET  /email?audience=day1|day2|both → { audience, count, sample: [up to 5 names], counts: { checkedIn, toSend,
              unsubscribed, alreadySent, responded, noEmail }, subject, html, text }   nothing is sent
     POST /email { audience, confirm: "SEND" } (management) → { sent, skipped, failed, counts }
              people with a door check-in that day (both = Day 1 or Day 2), each address once, never twice, never the
              unsubscribed, not people who've answered. 403 { code: "closed" } while the survey isn't open.
   Nothing here or in the jobs sends by itself with the defaults (autoNotify is off).
========================================================= */

export const publicRouter = express.Router();
export const appRouter = express.Router();
export const adminRouter = express.Router();

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error("SURVEY ERROR:", err?.message || err);
  if (!res.headersSent) res.status(err?.status === 400 ? 400 : 500).json({ ok: false, error: err?.status === 400 ? err.message : "Something went wrong. Try again." });
});
const noStore = (res) => res.set("Cache-Control", "private, no-store");
const tokenOf = (req) => String(req.query?.t || req.body?.t || "").slice(0, 200);

// Venue Wi-Fi: hundreds of people behind one address (ticketAccess SHARED_ADDRESS, like the other public forms).
const ipLimiter = makeLimiter(SHARED_ADDRESS);
const personLimiter = makeLimiter({ max: 20, windowMs: 60 * 60 * 1000 });
const TOO_MANY = "Too many tries. Please wait a few minutes, or email enquire@thetechfestival.com.";

/* ---------- public ---------- */

publicRouter.get("/email-logo.png", (req, res) => {
  res.set("Cache-Control", "public, max-age=86400");
  res.type("png").send(surveyLogoPng());
});

publicRouter.get("/", wrap(async (req, res) => {
  const [cfg, who] = await Promise.all([loadSurvey(), identify({ authorization: req.headers.authorization, token: tokenOf(req) })]);
  const preview = String(req.query.preview || "") === "1" && who?.user?.role === "admin";
  noStore(res);
  res.json(publicSurvey(cfg, { preview, respondent: who ? { ...who.known } : null, responded: await hasResponded(who) }));
}));

publicRouter.post("/responses", wrap(async (req, res) => {
  if (!ipLimiter.hit(String(req.ip || "unknown"))) return res.status(429).json({ ok: false, error: TOO_MANY });
  const who = await identify({ authorization: req.headers.authorization, token: tokenOf(req) });
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const person = who?.key || `e:${String(b.email || b.answers?.email || "").trim().toLowerCase().slice(0, 254)}`;
  if (!personLimiter.hit(person)) return res.status(429).json({ ok: false, error: TOO_MANY });
  const r = await submitResponse({ who, body: b, ip: req.ip, userAgent: req.headers["user-agent"] });
  noStore(res);
  if (!r.ok) return res.status(r.status).json({ ok: false, ...(r.code ? { code: r.code } : {}), ...(r.field ? { field: r.field } : {}), error: r.error });
  res.status(201).json({ ok: true, first: r.first });
}));

/* ---------- the app ---------- */

appRouter.get("/", wrap(async (req, res) => {
  noStore(res);
  const user = await bearerUser(req.headers.authorization);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  if (user.banned) return res.status(403).json({ error: "This account is suspended. Contact enquire@thetechfestival.com." });
  const cfg = await loadSurvey();
  const responded = await hasResponded({ key: `u:${user._id}`, known: { email: String(user.email || "").toLowerCase() } });
  res.json(appSurveyCard(cfg, { responded, token: signSurveyToken("u", String(user._id)) }));
}));

/* ---------- admin ---------- */

adminRouter.use(requireAdmin);

async function audit(req, action, detail = "") {
  await AdminAudit.create({ adminId: req.user._id, adminName: req.user.name, action, targetType: "survey", targetId: "2026",
    detail: String(detail).slice(0, 500) }).catch(() => {});
}
const PAGE_SIZE = 50;

adminRouter.get("/", wrap(async (req, res) => {
  const cfg = await loadSurvey({ fresh: true });
  const stats = await surveyStats(cfg);
  res.json({
    config: cfg, ...stats, open: surveyOpen(cfg), url: SURVEY_PAGE, canEdit: isManagement(req.user), audiences: Object.keys(AUDIENCES),
  });
}));

adminRouter.put("/", requireManagement, wrap(async (req, res) => {
  const r = await saveSurvey(req.body, { by: String(req.user?.name || req.user?.email || "") });
  if (r.error) return res.status(400).json({ error: r.error, field: r.field, ...(r.index !== undefined ? { index: r.index } : {}) });
  const q = r.config.questions.length;
  await audit(req, "survey_edit", `${r.changed.join(", ") || "nothing"}${r.changed.includes("questions") ? ` (${q} questions, ${r.config.retired.length} deleted kept)` : ""}`);
  res.json({ config: r.config, changed: r.changed });
}));

adminRouter.get("/responses", wrap(async (req, res) => {
  const cfg = await loadSurvey();
  const page = Math.max(0, Math.floor(Number(req.query.page)) || 0);
  const [rows, total] = await Promise.all([
    SurveyResponse.find({}).sort({ submittedAt: -1, _id: -1 }).skip(page * PAGE_SIZE).limit(PAGE_SIZE).lean(),
    SurveyResponse.countDocuments({}),
  ]);
  res.json({ total, page, size: PAGE_SIZE, questions: cfg.questions, retired: cfg.retired, rows: rows.map(responseRow) });
}));

adminRouter.get("/export", wrap(async (req, res) => {
  const cfg = await loadSurvey();
  const rows = await SurveyResponse.find({}).sort({ submittedAt: -1, _id: -1 }).lean();
  await audit(req, "survey_export", `${rows.length} responses`);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="ttfc-2026-survey-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(responsesCsv(rows, { questions: cfg.questions, retired: cfg.retired }));
}));

adminRouter.post("/notify", requireManagement, wrap(async (req, res) => {
  if (req.body?.confirm !== "SEND") return res.status(400).json({ error: "Type SEND to confirm." });
  const cfg = await loadSurvey({ fresh: true });
  if (!surveyOpen(cfg)) return res.status(403).json({ code: "closed", error: "The survey isn't open, so nothing was sent." });
  const out = await sendPrompt({ cfg, by: String(req.user?.name || "TTFC"), byId: req.user._id });
  if (out.busy) return res.status(409).json({ code: "busy", error: "The prompt is being sent right now. Try again in a minute." });
  await audit(req, "survey_notify", `${out.sent} sent (${out.already} already prompted, ${out.answered} answered, ${out.hidden} hidden)`);
  res.json(out);
}));

const audienceOf = (v) => (Object.prototype.hasOwnProperty.call(AUDIENCES, String(v || "")) ? String(v) : "");

adminRouter.get("/email", wrap(async (req, res) => {
  const audience = audienceOf(req.query.audience);
  if (!audience) return res.status(400).json({ error: "audience must be day1, day2 or both." });
  const [cfg, dir] = await Promise.all([loadSurvey(), peopleDirectory()]);
  const plan = await emailPlan(audience, dir);
  const first = plan.toSend[0] || plan.rows[0] || null;
  // The admin panel's preview: the first person's greeting, the page without a personal link, the logo inline.
  const logoSrc = `data:image/png;base64,${surveyLogoPng().toString("base64")}`;
  const e = buildSurveyEmail({ firstName: first?.firstName || "", url: SURVEY_PAGE, copy: cfg, logoSrc, unsubscribeUrl: previewUnsubscribeUrl() });
  res.json({
    audience, count: plan.toSend.length, sample: plan.toSend.slice(0, 5).map((r) => r.name || r.firstName || "(no name)"),
    counts: plan.counts, subject: e.subject, html: e.html, text: e.text,
  });
}));

adminRouter.post("/email", requireManagement, wrap(async (req, res) => {
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const audience = audienceOf(b.audience);
  if (!audience) return res.status(400).json({ error: "audience must be day1, day2 or both." });
  if (b.confirm !== "SEND") return res.status(400).json({ error: "Type SEND to confirm." });
  const cfg = await loadSurvey({ fresh: true });
  if (!surveyOpen(cfg)) return res.status(403).json({ code: "closed", error: "The survey isn't open, so nothing was sent." });
  const plan = await emailPlan(audience, await peopleDirectory());
  const out = await sendSurveyEmails({ plan, cfg, by: String(req.user?.name || req.user?.email || "") });
  await audit(req, "survey_email", `${audience}: ${out.sent} sent, ${out.skipped} skipped, ${out.failed} failed`);
  res.json(out);
}));
