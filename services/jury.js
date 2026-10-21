/* =========================================================
   Catalyst Awards jury: the rules (Oct 2026)
   ---------------------------------------------------------
   The organiser: "a TTFC portal where jury can login and see the
   awards and rank it objectively on certain parameters … The jury
   will be allocated startups to evaluate by the admin itself … The
   jury shouldn't be spending more than 5 minutes per person to rate.
   So, the metrics should be easy to follow … ability to edit their
   feedback before submitting the final assessment and … save the
   draft."
     - The rubric: up to six criteria scored 1–5, each with a one-line
       anchor for 1, 3 and 5, a weight (equal by default), an optional
       recommendation and a short comment. Versioned: every score keeps
       the version and criterion keys it was given on.
     - States of one assessment: not started → draft → submitted
       (→ editing → submitted again), or conflict (declared by the
       juror, off their list). Nothing can change after the deadline.
     - Results: averages per criterion, a weighted total on a 0–100
       scale (1 = 0, 3 = 50, 5 = 100) per juror, averaged; the
       recommendation tally; rank within the category.
     - Allocation: which nominations can be allocated (shortlisted by
       default, pending when nothing is shortlisted, never rejected),
       and the balanced plan ("each nomination to N jurors").
     - What a juror sees of a nomination: the nominee and the
       statements, never anyone's email or phone, never the nominator's
       name ("Self-nominated" / "Nominated by {organisation}").
   Pure (no database), unit-tested in test/jury.test.js. Routes:
   routes/jury.js (the portal) and routes/juryAdmin.js (the admin).
========================================================= */

import crypto from "crypto";
import { SPECIAL_AWARDS, categoryLabel, categoryShort } from "./nominations.js";

export const SCORE_MIN = 1;
export const SCORE_MAX = 5;
export const MIN_CRITERIA = 1;
export const MAX_CRITERIA = 6;
export const COMMENT_MAX = 500;
export const LABEL_MAX = 60;
export const HELP_MAX = 160;
export const ANCHOR_MAX = 160;
export const WEIGHT_MIN = 0.1;
export const WEIGHT_MAX = 10;
export const ANCHOR_POINTS = Object.freeze(["1", "3", "5"]);

/** Oct 25, 2026, 11:59 PM in Toronto (EDT, UTC−4): the night before the awards (Day 1 evening). */
export const DEFAULT_DEADLINE = "2026-10-26T03:59:00.000Z";
export const JURY_TIMEZONE = "America/Toronto";

export const RECOMMENDATIONS = Object.freeze([
  Object.freeze({ key: "strong_yes", label: "Strong yes" }),
  Object.freeze({ key: "yes", label: "Yes" }),
  Object.freeze({ key: "maybe", label: "Maybe" }),
  Object.freeze({ key: "no", label: "No" }),
]);
const RECOMMENDATION_KEYS = RECOMMENDATIONS.map((r) => r.key);

/** Nomination statuses that can be given to the jury; rejected ones never are. */
export const POOL_STATUSES = Object.freeze(["pending", "shortlisted", "winner"]);

const c = (key, label, help, a1, a3, a5) => Object.freeze({ key, label, help, weight: 1, anchors: Object.freeze({ 1: a1, 3: a3, 5: a5 }) });

/** The built-in rubric (version 1): five criteria, equal weights. */
export const DEFAULT_CRITERIA = Object.freeze([
  c("innovation", "Innovation", "How new or different the solution is.",
    "Much like what's already widely available.",
    "A clear improvement on existing approaches.",
    "Genuinely new; could change how the field works."),
  c("impact", "Impact", "Real-world results for people, customers or society, backed by evidence.",
    "Little or no real-world result shown yet.",
    "Measurable results for some people or customers.",
    "Significant, proven results at scale, with evidence."),
  c("traction", "Traction & evidence", "Customers, revenue, deployments, awards, data shown.",
    "Claims only: no customers, data or proof.",
    "Some customers, pilots or data to back it up.",
    "Strong proof: paying customers, deployments, revenue or independent recognition."),
  c("team", "Team & execution", "Ability to deliver and scale.",
    "Unclear who will deliver it, or how.",
    "A capable team with a credible plan.",
    "A proven team with a record of delivering at scale."),
  c("fit", "Fit for the category", "How well it matches this award: its pillar × sector, or the special award.",
    "A weak link to this category.",
    "Fits the category reasonably well.",
    "A standout example of this exact category."),
]);

/** The built-in rubric as a version (no JuryRubric row yet). */
export const DEFAULT_RUBRIC = Object.freeze({ version: 1, criteria: DEFAULT_CRITERIA, createdBy: "", createdAt: null, builtIn: true });

/* ---------- small helpers ---------- */

const noControls = (s) => String(s ?? "").replace(/\r\n?/g, "\n").replace(/[^\P{Cc}\n]/gu, "");
export const oneLine = (s, max) => noControls(s).replace(/\s+/g, " ").trim().slice(0, max);
export const manyLines = (s, max) => noControls(s).replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
const round1 = (n) => Math.round(n * 10) / 10;
export const isObjectId = (id) => /^[a-f0-9]{24}$/i.test(String(id || ""));

/** "Fit for the category" → "fit-for-the-category" (a criterion's key, made once). */
export function slugKey(label) {
  return String(label || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "criterion";
}

/* ---------- the rubric ---------- */

/** A stored criterion (or a default) → its plain shape. */
export function plainCriterion(x = {}) {
  const anchors = x.anchors && typeof x.anchors === "object" ? x.anchors : {};
  return {
    key: String(x.key || ""),
    label: String(x.label || ""),
    help: String(x.help || ""),
    weight: Number.isFinite(Number(x.weight)) && Number(x.weight) > 0 ? Number(x.weight) : 1,
    anchors: Object.fromEntries(ANCHOR_POINTS.map((p) => [p, String(anchors[p] ?? anchors[Number(p)] ?? "")])),
  };
}

/** A JuryRubric row (or null) → { version, criteria, createdBy, createdAt, builtIn }. */
export function plainRubric(row) {
  if (!row || !Array.isArray(row.criteria) || !row.criteria.length) {
    return { ...DEFAULT_RUBRIC, criteria: DEFAULT_CRITERIA.map(plainCriterion) };
  }
  return {
    version: Number(row.version) || 1,
    criteria: row.criteria.map(plainCriterion),
    createdBy: row.createdBy || "",
    createdAt: row.createdAt || null,
    builtIn: false,
  };
}

/** Each criterion's share of the total, in % (one decimal), by key. */
export function weightShares(criteria = []) {
  const sum = criteria.reduce((s, x) => s + (Number(x.weight) || 0), 0) || 1;
  return Object.fromEntries(criteria.map((x) => [x.key, round1(((Number(x.weight) || 0) / sum) * 100)]));
}

/**
 * The rubric staff saved → { ok, criteria } | { ok: false, error }.
 * Existing criteria keep their key (renaming keeps the scores); new ones get one made from the label that has
 * never been used (`usedKeys`: every key in every version), so a removed criterion's scores are never
 * mistaken for a new one's.
 */
export function cleanRubric(raw, { usedKeys = [] } = {}) {
  const list = Array.isArray(raw?.criteria) ? raw.criteria : Array.isArray(raw) ? raw : null;
  if (!list) return { ok: false, error: "Send the list of criteria." };
  if (list.length < MIN_CRITERIA) return { ok: false, error: "Keep at least one criterion." };
  if (list.length > MAX_CRITERIA) return { ok: false, error: `Use at most ${MAX_CRITERIA} criteria, so each nominee still takes about 5 minutes.` };
  const used = new Set(usedKeys.map(String));
  const seen = new Set();
  const out = [];
  for (const [i, item] of list.entries()) {
    const label = oneLine(item?.label, LABEL_MAX);
    if (!label) return { ok: false, error: `Criterion ${i + 1} needs a name.` };
    const weight = Number(item?.weight ?? 1);
    if (!Number.isFinite(weight) || weight < WEIGHT_MIN || weight > WEIGHT_MAX) {
      return { ok: false, error: `The weight of "${label}" must be between ${WEIGHT_MIN} and ${WEIGHT_MAX}.` };
    }
    let key = String(item?.key || "").trim();
    if (key && (!used.has(key) || seen.has(key))) key = ""; // an unknown or repeated key is a new criterion
    if (!key) {
      const base = slugKey(label);
      key = base;
      for (let n = 2; used.has(key) || seen.has(key); n++) key = `${base}-${n}`;
    }
    seen.add(key);
    const anchors = item?.anchors && typeof item.anchors === "object" ? item.anchors : {};
    out.push({
      key,
      label,
      help: oneLine(item?.help, HELP_MAX),
      weight: round1(weight),
      anchors: Object.fromEntries(ANCHOR_POINTS.map((p) => [p, oneLine(anchors[p] ?? anchors[Number(p)], ANCHOR_MAX)])),
    });
  }
  if (new Set(out.map((x) => x.label.toLowerCase())).size !== out.length) return { ok: false, error: "Two criteria have the same name." };
  return { ok: true, criteria: out };
}

/** Same criteria (keys, names, anchors, weights, order)? Then saving doesn't make a new version. */
export function sameCriteria(a = [], b = []) {
  return JSON.stringify(a.map(plainCriterion)) === JSON.stringify(b.map(plainCriterion));
}

/* ---------- settings (AppContent "jury.settings") ---------- */

export const SETTINGS_KEY = "jury.settings";

/** Stored settings → { deadline: ISO | null, poolStatuses: [] (= automatic) }. Unset deadline = the default. */
export function plainSettings(value) {
  const v = value && typeof value === "object" ? value : {};
  let deadline = DEFAULT_DEADLINE;
  if (v.deadline === null) deadline = null;
  else if (v.deadline) {
    const d = new Date(v.deadline);
    deadline = Number.isNaN(d.getTime()) ? DEFAULT_DEADLINE : d.toISOString();
  }
  const poolStatuses = Array.isArray(v.poolStatuses) ? POOL_STATUSES.filter((s) => v.poolStatuses.includes(s)) : [];
  return { deadline, poolStatuses };
}

/** What staff sent → { ok, set } | { ok: false, error }. deadline: an ISO date, or null / "" for none. */
export function cleanSettings(body = {}, now = Date.now()) {
  const set = {};
  if ("deadline" in body) {
    if (body.deadline === null || body.deadline === "") set.deadline = null;
    else {
      const d = new Date(body.deadline);
      if (Number.isNaN(d.getTime())) return { ok: false, error: "That deadline isn't a date." };
      if (d.getTime() < now - 365 * 864e5 || d.getTime() > now + 365 * 864e5) return { ok: false, error: "Pick a deadline within a year." };
      set.deadline = d.toISOString();
    }
  }
  if ("poolStatuses" in body) {
    if (!Array.isArray(body.poolStatuses)) return { ok: false, error: "poolStatuses must be a list." };
    if (body.poolStatuses.includes("rejected")) return { ok: false, error: "Nominations that aren't progressing can't go to the jury." };
    const bad = body.poolStatuses.filter((s) => !POOL_STATUSES.includes(s));
    if (bad.length) return { ok: false, error: `Statuses must be among: ${POOL_STATUSES.join(", ")}.` };
    set.poolStatuses = POOL_STATUSES.filter((s) => body.poolStatuses.includes(s));
  }
  return { ok: true, set };
}

/** Which statuses can be allocated now: staff's choice, else shortlisted (pending when nothing is shortlisted). */
export function poolStatusesFor(settings, counts = {}) {
  const chosen = plainSettings(settings).poolStatuses;
  if (chosen.length) return { statuses: chosen, automatic: false };
  return { statuses: (counts.shortlisted || 0) > 0 ? ["shortlisted"] : ["pending"], automatic: true };
}

/** Past the deadline: nothing can be saved, submitted, reopened or declared. */
export function isLocked(settings, now = Date.now()) {
  const d = plainSettings(settings).deadline;
  return !!d && now > new Date(d).getTime();
}

/** "Sunday, October 25, 11:59 PM ET" (Toronto time). "" = no deadline. */
export function formatDeadline(iso, { weekday = true } = {}) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const date = d.toLocaleDateString("en-US", { timeZone: JURY_TIMEZONE, ...(weekday ? { weekday: "long" } : {}), month: "long", day: "numeric" });
  const time = d.toLocaleTimeString("en-US", { timeZone: JURY_TIMEZONE, hour: "numeric", minute: "2-digit" });
  return `${date}, ${time} ET`;
}

/* ---------- scores ---------- */

const asObject = (m) => (m instanceof Map ? Object.fromEntries(m) : m && typeof m === "object" ? { ...m } : {});

/** Scores from a request → { key: 1–5 } for the criteria in `criteria` (anything else, 0 or "" is dropped). */
export function cleanScores(raw, criteria = []) {
  const src = asObject(raw);
  const out = {};
  for (const x of criteria) {
    const v = Number(src[x.key]);
    if (Number.isInteger(v) && v >= SCORE_MIN && v <= SCORE_MAX) out[x.key] = v;
  }
  return out;
}

export const cleanRecommendation = (v) => (RECOMMENDATION_KEYS.includes(String(v || "")) ? String(v) : "");
export const cleanComment = (v) => manyLines(v, COMMENT_MAX);
export const recommendationLabel = (k) => RECOMMENDATIONS.find((r) => r.key === k)?.label || "";

/** The criteria in `criteria` without a score. */
export const missingCriteria = (scores, criteria = []) => criteria.filter((x) => !asObject(scores)[x.key]).map((x) => x.key);

/**
 * A weighted total on a 0–100 scale (1 = 0, 3 = 50, 5 = 100), one decimal, over the criteria in `criteria`
 * that have a score (their weights only). null = none scored. Scores for criteria no longer in the rubric
 * are left out; a criterion added later simply has no score from older assessments.
 */
export function weightedTotal(scores, criteria = []) {
  const s = asObject(scores);
  let w = 0, sum = 0;
  for (const x of criteria) {
    const v = Number(s[x.key]);
    if (!Number.isInteger(v) || v < SCORE_MIN || v > SCORE_MAX) continue;
    const weight = Number(x.weight) || 0;
    w += weight;
    sum += weight * ((v - SCORE_MIN) / (SCORE_MAX - SCORE_MIN));
  }
  return w > 0 ? round1((sum / w) * 100) : null;
}

/** A stored draft / submission → its plain shape (scores as an object). */
export function plainScoreSet(set) {
  if (!set) return null;
  const scores = asObject(set.scores);
  const at = set.submittedAt || set.savedAt || null;
  if (!at && !Object.keys(scores).length && !set.comment && !set.recommendation) return null;
  return {
    scores,
    recommendation: set.recommendation || "",
    comment: set.comment || "",
    rubricVersion: Number(set.rubricVersion) || 0,
    ...(set.submittedAt ? { submittedAt: set.submittedAt } : {}),
    ...(set.savedAt ? { savedAt: set.savedAt } : {}),
    ...(set.replacedAt ? { replacedAt: set.replacedAt } : {}),
  };
}

/** Has the draft anything in it? */
export const draftHasContent = (d) => !!d && (Object.keys(asObject(d.scores)).length > 0 || !!d.comment || !!d.recommendation);

/** One assessment's state: "conflict" | "editing" | "submitted" | "draft" | "not_started". */
export function assessmentState(a) {
  if (!a) return "not_started";
  if (a.conflict?.at && !a.conflict?.clearedAt) return "conflict";
  if (a.submission?.submittedAt) return a.editing ? "editing" : "submitted";
  if (draftHasContent(a.draft)) return "draft";
  return "not_started";
}

export const STATE_LABELS = Object.freeze({
  not_started: "Not started", draft: "Draft", submitted: "Submitted", editing: "Editing", conflict: "Conflict",
});

/** Counts an assessment as done: submitted, or reopened (its last submission still counts). */
export const isDone = (state) => state === "submitted" || state === "editing";

/** A juror's progress over their assessments (conflicts left out of the total). */
export function progressOf(states = []) {
  const p = { assigned: 0, submitted: 0, editing: 0, drafts: 0, notStarted: 0, conflicts: 0 };
  for (const s of states) {
    if (s === "conflict") { p.conflicts++; continue; }
    p.assigned++;
    if (isDone(s)) p.submitted++;
    if (s === "editing") p.editing++;
    if (s === "draft") p.drafts++;
    if (s === "not_started") p.notStarted++;
  }
  p.remaining = p.assigned - p.submitted;
  return p;
}

/* ---------- what a juror sees of a nomination ---------- */

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Phone numbers written with separators: +1 (416) 555-0199, 416.555.0199, +44 20 7946 0958 …
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]\d{3,4}[\s.-]\d{3,4}\b/g;

/** Statement text for the jury: contact details taken out (the jury never gets anyone's email or phone). */
export function redactContacts(text) {
  return String(text || "").replace(EMAIL_RE, "[email removed]").replace(PHONE_RE, (m) => (m.replace(/\D/g, "").length >= 9 ? "[phone removed]" : m));
}

/** A website / LinkedIn field → a safe https link ("" when it isn't one). */
export function safeLink(v) {
  let s = String(v || "").trim();
  if (!s || /\s/.test(s)) return "";
  if (!/^https?:\/\//i.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^:/]+:\d+(\/|$)/.test(s)) return ""; // mailto:, tel:, javascript: …
    if (s.split("/")[0].includes("@")) return ""; // an email address, not a site
    s = `https://${s}`;
  }
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".") || u.username || u.password) return "";
    return u.toString();
  } catch { return ""; }
}

export const STATEMENTS = Object.freeze([
  Object.freeze({ key: "overview", field: "statementOverview", title: "Overview" }),
  Object.freeze({ key: "impact", field: "statementImpact", title: "Innovation & impact" }),
  Object.freeze({ key: "achievements", field: "statementAchievements", title: "Key achievements" }),
  Object.freeze({ key: "evidence", field: "statementEvidence", title: "Supporting evidence" }),
]);

/** "Self-nominated" / "Nominated by Example Labs" / "Nominated by a third party". Never the nominator's name. */
export function nominatedByLine(n = {}) {
  if (n.selfNomination) return "Self-nominated";
  const org = oneLine(n.nominatorOrganisation, 200);
  return org ? `Nominated by ${org}` : "Nominated by a third party";
}

/** The category key results are ranked in: "matrix:<pillar>|<sector>" or "special:<award>". */
export const categoryKey = (n = {}) => (n.categoryType === "matrix" ? `matrix:${n.pillar || ""}|${n.sector || ""}` : `special:${n.specialAward || ""}`);

/** The nomination as the jury sees it: the nominee and their statements, nothing else. */
export function nomineeForJury(n = {}) {
  return {
    id: String(n._id || n.id || ""),
    categoryType: n.categoryType === "special" ? "special" : "matrix",
    category: categoryShort(n),
    categoryLabel: categoryLabel(n),
    categoryKey: categoryKey(n),
    pillar: n.categoryType === "matrix" ? n.pillar || "" : "",
    sector: n.categoryType === "matrix" ? n.sector || "" : "",
    specialAward: n.categoryType === "special" ? SPECIAL_AWARDS[n.specialAward] || "Special Recognition" : "",
    nomineeName: n.nomineeName || "",
    nomineeType: n.nomineeType || "",
    nomineeTitle: n.nomineeTitle || "",
    nomineeOrganisation: n.nomineeOrganisation || "",
    nomineeSector: n.nomineeSector || "",
    nomineeLocation: n.nomineeLocation || "",
    website: safeLink(n.nomineeWebsite),
    linkedin: safeLink(n.nomineeLinkedIn),
    nominatedBy: nominatedByLine(n),
    statements: STATEMENTS.map((s) => ({ key: s.key, title: s.title, text: redactContacts(manyLines(n[s.field], 8000)) })).filter((s) => s.text),
  };
}

/** The short version for the juror's list. */
export function nomineeSummary(n = {}) {
  const full = nomineeForJury(n);
  return {
    id: full.id, category: full.category, categoryLabel: full.categoryLabel, categoryKey: full.categoryKey, categoryType: full.categoryType,
    nomineeName: full.nomineeName, nomineeType: full.nomineeType, nomineeOrganisation: full.nomineeOrganisation,
  };
}

/** May the jury see this nomination? (It exists and isn't rejected.) */
export const visibleToJury = (n) => !!n && n.status !== "rejected";

/** The juror's list order: matrix categories (by pillar, then sector), then special awards, then nominee name. */
export function juryOrder(a, b) {
  const t = (x) => (x.categoryType === "special" ? 1 : 0);
  return t(a) - t(b)
    || String(a.categoryLabel || "").localeCompare(String(b.categoryLabel || ""))
    || String(a.nomineeName || "").localeCompare(String(b.nomineeName || ""))
    || String(a.id || "").localeCompare(String(b.id || ""));
}

/* ---------- allocation ---------- */

/** A stable pseudo-random number for (juror, nomination): spreads ties without always picking the same juror. */
const tieBreak = (a, b) => crypto.createHash("sha1").update(`${a}:${b}`).digest().readUInt32BE(0);

/**
 * "Give each nomination N jurors, balanced": the assignments to add so every nomination in `nominationIds` has
 * `perNomination` active jurors, picking the least-loaded jurors in `jurorIds` who aren't on it already and
 * didn't declare a conflict on it. Existing assignments count (active or conflict, from `existing`:
 * [{ juror, nomination, active, conflict }]); `load`: { jurorId: active assignments now }.
 * → { add: [{ juror, nomination }], short: [{ nomination, have, need }] }
 */
export function planBalanced({ nominationIds = [], jurorIds = [], perNomination = 1, existing = [], load = {} } = {}) {
  const per = Math.max(1, Math.min(50, Math.floor(Number(perNomination) || 1)));
  const jurors = [...new Set(jurorIds.map(String))];
  const loadNow = Object.fromEntries(jurors.map((j) => [j, Number(load[j]) || 0]));
  const on = new Map(); // nomination → Set of jurors on it (active or conflict)
  const activeCount = new Map();
  for (const e of existing) {
    const n = String(e.nomination), j = String(e.juror);
    if (!on.has(n)) on.set(n, new Set());
    if (e.active || e.conflict) on.get(n).add(j);
    if (e.active && !e.conflict) activeCount.set(n, (activeCount.get(n) || 0) + 1);
  }
  const noms = [...new Set(nominationIds.map(String))]
    .sort((a, b) => (activeCount.get(a) || 0) - (activeCount.get(b) || 0) || a.localeCompare(b));
  const add = [];
  const short = [];
  for (const n of noms) {
    const taken = on.get(n) || new Set();
    let have = activeCount.get(n) || 0;
    const candidates = jurors.filter((j) => !taken.has(j));
    while (have < per && candidates.length) {
      candidates.sort((a, b) => loadNow[a] - loadNow[b] || tieBreak(a, n) - tieBreak(b, n));
      const j = candidates.shift();
      add.push({ juror: j, nomination: n });
      loadNow[j]++;
      have++;
    }
    if (have < per) short.push({ nomination: n, have, need: per });
  }
  return { add, short };
}

/* ---------- results ---------- */

/** Standard competition ranking (1, 1, 3) by total, highest first; null totals aren't ranked. */
export function rankBy(rows, value = (r) => r.total) {
  const ranked = rows.filter((r) => value(r) !== null && value(r) !== undefined).sort((a, b) => value(b) - value(a));
  const out = new Map();
  ranked.forEach((r, i) => {
    const prev = ranked[i - 1];
    out.set(r, prev && value(prev) === value(r) ? out.get(prev) : i + 1);
  });
  return out;
}

/**
 * Results for one nomination from its assessments (`items`: [{ state, submission, jurorName, jurorId }], only
 * jurors still on the jury and assignments still active, conflicts included so they're counted).
 * `criteria`: the current rubric's.
 */
export function nominationResult(items = [], criteria = []) {
  const counted = items.filter((x) => x.state !== "conflict");
  const done = counted.filter((x) => isDone(x.state) && x.submission);
  const perCriterion = {};
  for (const k of criteria) {
    const vals = done.map((x) => Number(asObject(x.submission.scores)[k.key])).filter((v) => Number.isInteger(v));
    perCriterion[k.key] = vals.length ? { avg: round1(vals.reduce((s, v) => s + v, 0) / vals.length), n: vals.length } : { avg: null, n: 0 };
  }
  const totals = done.map((x) => weightedTotal(x.submission.scores, criteria)).filter((v) => v !== null);
  const tally = Object.fromEntries([...RECOMMENDATION_KEYS, "none"].map((k) => [k, 0]));
  for (const x of done) tally[cleanRecommendation(x.submission.recommendation) || "none"]++;
  return {
    assigned: counted.length,
    submitted: done.length,
    editing: counted.filter((x) => x.state === "editing").length,
    drafts: counted.filter((x) => x.state === "draft").length,
    conflicts: items.length - counted.length,
    perCriterion,
    total: totals.length ? round1(totals.reduce((s, v) => s + v, 0) / totals.length) : null,
    min: totals.length ? Math.min(...totals) : null,
    max: totals.length ? Math.max(...totals) : null,
    tally,
    olderRubric: done.filter((x) => missingCriteria(x.submission.scores, criteria).length > 0).length,
  };
}

/* ---------- CSV ---------- */

const cell = (v) => {
  const s = v instanceof Date ? v.toISOString() : String(v ?? "");
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(guarded) || guarded !== s ? `"${guarded.replace(/"/g, '""')}"` : guarded;
};

/** The results table as CSV: one row per nomination, the current criteria's averages, the tally, the comments. */
export function resultsCsv(rows = [], criteria = []) {
  const head = ["Rank in category", "Category", "Nominee", "Organisation", "Status", "Jurors assigned", "Submitted", "Conflicts",
    "Weighted total (0-100)", "Lowest", "Highest", ...criteria.map((x) => `${x.label} (avg 1-5)`),
    ...RECOMMENDATIONS.map((r) => r.label), "No recommendation", "Comments"];
  const lines = [head.map(cell).join(",")];
  for (const r of rows) {
    lines.push([
      r.rank ?? "", r.category, r.nomineeName, r.nomineeOrganisation, r.status, r.assigned, r.submitted, r.conflicts,
      r.total ?? "", r.min ?? "", r.max ?? "", ...criteria.map((x) => r.perCriterion?.[x.key]?.avg ?? ""),
      ...RECOMMENDATIONS.map((x) => r.tally?.[x.key] || 0), r.tally?.none || 0,
      (r.comments || []).map((cm) => `${cm.juror}: ${cm.comment}`).join("\n"),
    ].map(cell).join(","));
  }
  return lines.join("\r\n");
}

/* ---------- jurors ---------- */

export const NAME_MAX = 120;

/** Staff's juror form → { ok, set } | { ok: false, error }. `partial`: a PATCH (only the keys sent). */
export function cleanJuror(body = {}, { partial = false } = {}) {
  const set = {};
  if (!partial || "name" in body) {
    const name = oneLine(body.name, NAME_MAX);
    if (!name) return { ok: false, error: "Enter the juror's name." };
    set.name = name;
  }
  if (!partial || "email" in body) {
    const email = String(body.email || "").trim().toLowerCase().slice(0, 254);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { ok: false, error: "Enter a valid email address." };
    set.email = email;
  }
  if (!partial || "organisation" in body) set.organisation = oneLine(body.organisation, 160);
  if (!partial || "title" in body) set.title = oneLine(body.title, 160);
  if ("active" in body) {
    if (typeof body.active !== "boolean") return { ok: false, error: "active must be true or false." };
    set.active = body.active;
  } else if (!partial) set.active = true;
  return { ok: true, set };
}

/** "Jane" from "Jane Example". */
export const firstNameOf = (name) => String(name || "").trim().split(/\s+/)[0] || "";
