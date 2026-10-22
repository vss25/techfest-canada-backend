import express from "express";
import Juror from "../models/Juror.js";
import JuryAssignment from "../models/JuryAssignment.js";
import JurySignInRequest from "../models/JurySignInRequest.js";
import Nomination from "../models/Nomination.js";
import { makeLimiter } from "../services/ticketAccess.js";
import { cleanCode, isValidEmail, newCode, normalizeEmail, sameHash } from "../services/emailLink.js";
import {
  CODE_REFUSED, CODE_TTL_MS, MAX_CODE_TRIES, TOO_MANY, VIA_CODE, hashJuryCode,
  jurorCanSignIn, makeRequireJuror, signJuryToken,
} from "../services/juryAuth.js";

const CODE_ONLY = "Jurors sign in with a one-time 6-digit code by email.";
import {
  COMMENT_MAX, RECOMMENDATIONS, STATE_LABELS, assessmentState, cleanComment, cleanRecommendation, cleanScores, formatDeadline, isLocked,
  isObjectId, juryOrder, missingCriteria, nomineeForJury, nomineeSummary, oneLine, plainScoreSet, progressOf, visibleToJury, weightedTotal,
} from "../services/jury.js";
import { currentRubric, loadSettings } from "../services/juryStore.js";

/* =========================================================
   /api/jury: the Catalyst Awards jury portal
   (thetechfestival.com/awards/jury-admin, Oct 2026). Jurors only:
   every route but sign-in needs a jury token (services/juryAuth.js),
   and everything is the signed-in juror's own: their allocations,
   the nominations allocated to them (nominee and statements only,
   services/jury.js nomineeForJury) and their own assessments.
   Nothing here reads another juror's scores, a nominator's or
   nominee's contact details, or anything in the admin console.

   Sign-in (no token; rate-limited; the answers never say whether an
   email is a juror's):
   POST /auth/login        → 410 (passwords removed Oct 22; code only)
   POST /auth/code         { email }            → { sent: true } (always; only active jurors get an email)
   POST /auth/code/verify  { email, code }      → { token, juror }

   Signed in:
   GET  /me                → { juror, deadline, deadlineText, locked, rubric, recommendations, commentMax, progress }
   POST /password          → 410 (passwords removed Oct 22)
   GET  /assignments       → { rows, conflicts, progress, nextId, criteriaCount, deadline, deadlineText, locked }
   GET  /nominations/:id   → { nominee, assessment, rubric, prevId, nextId, position, count, … }
   PUT  /nominations/:id/draft    { scores, recommendation, comment } → { state, savedAt, total, missing }
   POST /nominations/:id/submit   { scores, recommendation, comment } → { state, submittedAt, total }
   POST /nominations/:id/edit     → { state: "editing", draft } (reopens a submitted one until the deadline)
   POST /nominations/:id/discard  → { state: "submitted" } (drops the changes; the submitted one stands)
   POST /nominations/:id/conflict { reason? } → { state: "conflict" } (off their list; staff reassign it)
   After the deadline every change answers 423 { code: "locked" }.
========================================================= */

const clientIp = (req) => String(req.ip || "unknown");
const jurorView = (j) => ({
  id: String(j._id), name: j.name || "", email: j.email || "", organisation: j.organisation || "", title: j.title || "",
  hasPassword: !!j.passwordSetAt,
});
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error("JURY ERROR:", err);
  if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Please try again." });
});

// Not declared, or declared and cleared by staff.
const NOT_CONFLICT = { $or: [{ "conflict.at": null }, { "conflict.clearedAt": { $ne: null } }] };

async function defaultSendCode(payload) {
  // Imported lazily so the router can be built without a Resend key.
  const { sendJuryCodeEmail } = await import("../services/juryEmail.js");
  return sendJuryCodeEmail(payload);
}

/**
 * @param {object} [deps]
 * @param {(p: { to, code, name, minutes }) => Promise<any>} [deps.sendCode]
 * @param {() => number} [deps.now]
 * @param {object} [deps.limits] per-15-minute caps (tests raise them): codePerIp, codePerEmail, verifyPerIp
 */
export const JURY_LIMITS = Object.freeze({ codePerIp: 20, codePerEmail: 5, verifyPerIp: 40 });

export function createJuryRouter({ sendCode = defaultSendCode, now = () => Date.now(), limits = {} } = {}) {
  const router = express.Router();
  const requireJuror = makeRequireJuror({ Juror, now });
  const cap = { ...JURY_LIMITS, ...limits };
  const limiter = (k) => makeLimiter({ max: cap[k], windowMs: 15 * 60 * 1000 });

  const codePerIp = limiter("codePerIp");
  const codePerEmail = limiter("codePerEmail");
  const verifyPerIp = limiter("verifyPerIp");

  const signedIn = async (juror, via) => {
    await Juror.updateOne({ _id: juror._id }, { $set: { lastSignInAt: new Date(now()), lastActiveAt: new Date(now()) } });
    return { token: signJuryToken(juror, { via }), juror: jurorView(juror) };
  };

  /* ---------- sign in ---------- */

  // Passwords were removed (the organiser, Oct 22 2026): jurors sign in with a one-time code only.
  router.post("/auth/login", (_req, res) => res.status(410).json({ error: CODE_ONLY }));

  router.post("/auth/code", wrap(async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!isValidEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
    if (!codePerIp.hit(`ip:${clientIp(req)}`) || !codePerEmail.hit(`email:${email}`)) {
      return res.status(429).json({ error: "Too many codes asked for. Please wait 15 minutes and try again." });
    }
    const juror = await Juror.findOne({ email }).lean();
    if (jurorCanSignIn(juror)) {
      // A new code replaces any older one still waiting.
      await JurySignInRequest.updateMany({ email, status: "pending" }, { $set: { status: "replaced" } });
      const code = newCode();
      await JurySignInRequest.create({
        email, juror: juror._id, codeHash: hashJuryCode(email, code), expiresAt: new Date(now() + CODE_TTL_MS), ip: clientIp(req),
      });
      // Not awaited: the answer takes as long for a juror as for anyone else.
      Promise.resolve().then(() => sendCode({ to: email, code, name: juror.name, minutes: Math.round(CODE_TTL_MS / 60000) }))
        .catch((err) => console.error("JURY CODE EMAIL ERROR:", err?.message || err));
    }
    res.json({ sent: true });
  }));

  router.post("/auth/code/verify", wrap(async (req, res) => {
    if (!verifyPerIp.hit(`ip:${clientIp(req)}`)) return res.status(429).json({ error: TOO_MANY });
    const email = normalizeEmail(req.body?.email);
    const code = cleanCode(req.body?.code);
    if (!isValidEmail(email)) return res.status(400).json({ error: "Enter the email the code was sent to." });
    if (!code) return res.status(400).json({ error: "Enter the 6-digit code from the email." });
    // Reserve this try atomically before comparing, so parallel guesses can't get more than MAX_CODE_TRIES.
    const request = await JurySignInRequest.findOneAndUpdate(
      { email, status: "pending", expiresAt: { $gt: new Date(now()) }, attempts: { $lt: MAX_CODE_TRIES } },
      { $inc: { attempts: 1 } },
      { returnDocument: "after", sort: { createdAt: -1 } },
    );
    if (!request) {
      await JurySignInRequest.updateMany({ email, status: "pending", attempts: { $gte: MAX_CODE_TRIES } }, { $set: { status: "locked" } });
      return res.status(400).json({ error: CODE_REFUSED });
    }
    if (!sameHash(hashJuryCode(email, code), request.codeHash)) {
      if (request.attempts >= MAX_CODE_TRIES) await JurySignInRequest.updateOne({ _id: request._id, status: "pending" }, { $set: { status: "locked" } });
      return res.status(400).json({ error: CODE_REFUSED });
    }
    // Single use: only the first caller to flip it from pending gets in.
    const claimed = await JurySignInRequest.findOneAndUpdate(
      { _id: request._id, status: "pending" }, { $set: { status: "used", usedAt: new Date(now()) } }, { returnDocument: "after" },
    );
    if (!claimed) return res.status(400).json({ error: CODE_REFUSED });
    const juror = await Juror.findById(claimed.juror).lean();
    // Switched off or removed after the code was sent.
    if (!jurorCanSignIn(juror) || juror.email !== email) return res.status(400).json({ error: CODE_REFUSED });
    res.json(await signedIn(juror, VIA_CODE));
  }));

  /* ---------- everything else: the signed-in juror's own ---------- */

  router.use(requireJuror);

  /** The juror's allocations they can see now, in list order: [{ a, n, item }]. Conflicts separately. */
  async function myList(jurorId) {
    const rows = await JuryAssignment.find({ juror: jurorId, active: true }).lean();
    const noms = rows.length ? await Nomination.find({ _id: { $in: rows.map((r) => r.nomination) } }).lean() : [];
    const byId = new Map(noms.map((n) => [String(n._id), n]));
    const all = rows.map((a) => ({ a, n: byId.get(String(a.nomination)) })).filter((x) => visibleToJury(x.n))
      .map((x) => ({ ...x, state: assessmentState(x.a), item: nomineeSummary(x.n) }))
      .sort((x, y) => juryOrder(x.item, y.item));
    return { open: all.filter((x) => x.state !== "conflict"), conflicts: all.filter((x) => x.state === "conflict") };
  }

  async function context() {
    const [settings, rubric] = await Promise.all([loadSettings(), currentRubric()]);
    return { settings, rubric, locked: isLocked(settings, now()), deadline: settings.deadline, deadlineText: formatDeadline(settings.deadline) };
  }

  const LOCKED = (ctx) => ({ code: "locked", error: ctx.deadlineText
    ? `The jury portal closed on ${ctx.deadlineText}. Assessments can't be changed any more.`
    : "The jury portal is closed. Assessments can't be changed any more." });

  const rowOf = (x, criteria) => {
    const current = x.state === "submitted" ? x.a.submission : x.a.draft || x.a.submission;
    const scores = plainScoreSet(current)?.scores || {};
    return {
      ...x.item,
      state: x.state,
      stateLabel: STATE_LABELS[x.state],
      total: weightedTotal(scores, criteria),
      scored: criteria.filter((k) => scores[k.key]).length,
      savedAt: x.a.lastSavedAt || null,
      submittedAt: x.a.submission?.submittedAt || null,
    };
  };

  router.get("/me", wrap(async (req, res) => {
    const [ctx, list] = await Promise.all([context(), myList(req.juror._id)]);
    res.json({
      juror: jurorView(req.juror), signedInWith: req.juryVia,
      deadline: ctx.deadline, deadlineText: ctx.deadlineText, locked: ctx.locked,
      rubric: { version: ctx.rubric.version, criteria: ctx.rubric.criteria }, recommendations: RECOMMENDATIONS, commentMax: COMMENT_MAX,
      progress: progressOf([...list.open, ...list.conflicts].map((x) => x.state)),
    });
  }));

  router.post("/password", (_req, res) => res.status(410).json({ error: CODE_ONLY }));

  router.get("/assignments", wrap(async (req, res) => {
    const [ctx, list] = await Promise.all([context(), myList(req.juror._id)]);
    const rows = list.open.map((x) => rowOf(x, ctx.rubric.criteria));
    const next = rows.find((r) => r.state === "draft" || r.state === "editing") || rows.find((r) => r.state === "not_started");
    res.json({
      rows,
      conflicts: list.conflicts.map((x) => ({ ...x.item, state: "conflict", stateLabel: STATE_LABELS.conflict, declaredAt: x.a.conflict?.at || null })),
      progress: progressOf([...list.open, ...list.conflicts].map((x) => x.state)),
      nextId: next?.id || null,
      criteriaCount: ctx.rubric.criteria.length,
      deadline: ctx.deadline, deadlineText: ctx.deadlineText, locked: ctx.locked,
    });
  }));

  /** This juror's open assignment for nomination :id (not a conflict, still visible), or null. */
  async function mine(req) {
    if (!isObjectId(req.params.id)) return null;
    const a = await JuryAssignment.findOne({ juror: req.juror._id, nomination: req.params.id, active: true }).lean();
    if (!a || assessmentState(a) === "conflict") return null;
    const n = await Nomination.findById(req.params.id).lean();
    return visibleToJury(n) ? { a, n } : null;
  }
  const NOT_YOURS = { error: "This nomination isn't on your list." };

  router.get("/nominations/:id", wrap(async (req, res) => {
    const found = await mine(req);
    if (!found) return res.status(404).json(NOT_YOURS);
    const [ctx, list] = await Promise.all([context(), myList(req.juror._id)]);
    const ids = list.open.map((x) => x.item.id);
    const i = ids.indexOf(req.params.id);
    const state = assessmentState(found.a);
    res.json({
      nominee: nomineeForJury(found.n),
      assessment: {
        state, stateLabel: STATE_LABELS[state],
        draft: state === "submitted" ? null : plainScoreSet(found.a.draft),
        submission: plainScoreSet(found.a.submission),
        resubmissions: (found.a.history || []).length,
        lastSavedAt: found.a.lastSavedAt || null,
      },
      rubric: { version: ctx.rubric.version, criteria: ctx.rubric.criteria }, recommendations: RECOMMENDATIONS, commentMax: COMMENT_MAX,
      prevId: i > 0 ? ids[i - 1] : null, nextId: i >= 0 && i < ids.length - 1 ? ids[i + 1] : null,
      position: i + 1, count: ids.length,
      deadline: ctx.deadline, deadlineText: ctx.deadlineText, locked: ctx.locked,
    });
  }));

  const cleanBody = (body = {}, criteria) => ({
    scores: cleanScores(body.scores, criteria),
    recommendation: cleanRecommendation(body.recommendation),
    comment: cleanComment(body.comment),
  });

  router.put("/nominations/:id/draft", wrap(async (req, res) => {
    const found = await mine(req);
    if (!found) return res.status(404).json(NOT_YOURS);
    const ctx = await context();
    if (ctx.locked) return res.status(423).json(LOCKED(ctx));
    if (assessmentState(found.a) === "submitted") return res.status(409).json({ code: "submitted", error: "You've submitted this one. Tap Edit to change it." });
    const at = new Date(now());
    const draft = { ...cleanBody(req.body, ctx.rubric.criteria), rubricVersion: ctx.rubric.version, savedAt: at };
    const updated = await JuryAssignment.findOneAndUpdate(
      { _id: found.a._id, active: true, $and: [NOT_CONFLICT, { $or: [{ "submission.submittedAt": null }, { editing: true }] }] },
      { $set: { draft, lastSavedAt: at } },
      { returnDocument: "after" },
    ).lean();
    if (!updated) return res.status(409).json({ code: "changed", error: "This assessment changed in another window. Reload to see it." });
    const state = assessmentState(updated);
    res.json({ state, stateLabel: STATE_LABELS[state], savedAt: at, total: weightedTotal(draft.scores, ctx.rubric.criteria), missing: missingCriteria(draft.scores, ctx.rubric.criteria) });
  }));

  router.post("/nominations/:id/submit", wrap(async (req, res) => {
    const found = await mine(req);
    if (!found) return res.status(404).json(NOT_YOURS);
    const ctx = await context();
    if (ctx.locked) return res.status(423).json(LOCKED(ctx));
    const state = assessmentState(found.a);
    if (state === "submitted") return res.status(409).json({ code: "submitted", error: "You've already submitted this one." });
    const body = cleanBody(req.body, ctx.rubric.criteria);
    const missing = missingCriteria(body.scores, ctx.rubric.criteria);
    if (missing.length) {
      const names = ctx.rubric.criteria.filter((k) => missing.includes(k.key)).map((k) => k.label);
      return res.status(400).json({ code: "incomplete", missing, error: `Score every criterion before you submit. Still to score: ${names.join(", ")}.` });
    }
    const at = new Date(now());
    const before = found.a.submission?.submittedAt ? plainScoreSet(found.a.submission) : null;
    const update = {
      $set: { submission: { ...body, rubricVersion: ctx.rubric.version, submittedAt: at }, editing: false, lastSavedAt: at },
      $unset: { draft: "" },
      ...(before ? { $push: { history: { ...before, replacedAt: at } } } : {}),
    };
    const filter = { _id: found.a._id, active: true, $and: [NOT_CONFLICT, before
      ? { editing: true, "submission.submittedAt": found.a.submission.submittedAt }
      : { "submission.submittedAt": null }] };
    const updated = await JuryAssignment.findOneAndUpdate(filter, update, { returnDocument: "after" }).lean();
    if (!updated) return res.status(409).json({ code: "changed", error: "This assessment changed in another window. Reload to see it." });
    res.json({ state: "submitted", stateLabel: STATE_LABELS.submitted, submittedAt: at, total: weightedTotal(body.scores, ctx.rubric.criteria), resubmitted: !!before });
  }));

  router.post("/nominations/:id/edit", wrap(async (req, res) => {
    const found = await mine(req);
    if (!found) return res.status(404).json(NOT_YOURS);
    const ctx = await context();
    if (ctx.locked) return res.status(423).json(LOCKED(ctx));
    const state = assessmentState(found.a);
    if (state === "editing") return res.json({ state, stateLabel: STATE_LABELS.editing, draft: plainScoreSet(found.a.draft) });
    if (state !== "submitted") return res.status(409).json({ code: "not_submitted", error: "This one hasn't been submitted yet." });
    const at = new Date(now());
    const s = plainScoreSet(found.a.submission);
    const draft = { scores: s.scores, recommendation: s.recommendation, comment: s.comment, rubricVersion: s.rubricVersion, savedAt: at };
    const updated = await JuryAssignment.findOneAndUpdate(
      { _id: found.a._id, active: true, editing: false, "submission.submittedAt": found.a.submission.submittedAt, ...NOT_CONFLICT },
      { $set: { editing: true, draft } },
      { returnDocument: "after" },
    ).lean();
    if (!updated) return res.status(409).json({ code: "changed", error: "This assessment changed in another window. Reload to see it." });
    res.json({ state: "editing", stateLabel: STATE_LABELS.editing, draft: plainScoreSet(updated.draft) });
  }));

  router.post("/nominations/:id/discard", wrap(async (req, res) => {
    const found = await mine(req);
    if (!found) return res.status(404).json(NOT_YOURS);
    const ctx = await context();
    if (ctx.locked) return res.status(423).json(LOCKED(ctx));
    if (assessmentState(found.a) !== "editing") return res.status(409).json({ code: "not_editing", error: "There are no changes to discard." });
    await JuryAssignment.updateOne({ _id: found.a._id, editing: true }, { $set: { editing: false }, $unset: { draft: "" } });
    res.json({ state: "submitted", stateLabel: STATE_LABELS.submitted });
  }));

  router.post("/nominations/:id/conflict", wrap(async (req, res) => {
    const found = await mine(req);
    if (!found) return res.status(404).json(NOT_YOURS);
    const ctx = await context();
    if (ctx.locked) return res.status(423).json(LOCKED(ctx));
    const at = new Date(now());
    const updated = await JuryAssignment.findOneAndUpdate(
      { _id: found.a._id, active: true, ...NOT_CONFLICT },
      { $set: { conflict: { at, reason: oneLine(req.body?.reason, 300) } } },
      { returnDocument: "after" },
    ).lean();
    if (!updated) return res.status(409).json({ code: "changed", error: "This assessment changed in another window. Reload to see it." });
    res.json({ state: "conflict", stateLabel: STATE_LABELS.conflict, declaredAt: at });
  }));

  return router;
}

export default createJuryRouter();
