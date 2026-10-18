/* =========================================================
   Points: the apps' gamification layer
   ---------------------------------------------------------
   Points are DERIVED on the server from records it already keeps
   (profile, saved sessions, poll votes, Q&A, connections, the feed).
   The app never reports points, so a modified client can't award
   itself anything, and nothing extra is stored: every read recomputes.

   Session ids in the votes and questions collections come from the URL,
   so live points (votes, questions, their upvotes, attendance) count only
   for sessions on the agenda (Sanity session docs, the `sessionId` or
   `_id` the apps use), and votes are capped per session and in total.

   Pure parts (RULES, LEVELS, scoreFromCounts, activityFromCounts, levelFor,
   mergeCounts, ranking) are exported for unit tests. The Mongo side only gathers
   counts: six aggregations grouped by person, shared by pointsFor (one
   person) and the leaderboard (everyone, cached for 60 s).
========================================================= */

import mongoose from "mongoose";
import User from "../models/User.js";
import {
  SocialPost, SocialComment, SocialConnection,
  SessionRegistration, SessionQuestion, SessionVote,
} from "../models/Social.js";
import { avatarPath } from "./socialHelpers.js";
import { SANITY_PROJECT } from "./rsvp.js";

/* ================= RULES & LEVELS ================= */

/** How to earn points, in display order. `max` caps how many are counted
    (null = no cap), `per` says what that cap applies to: "total", "day"
    (calendar day, UTC), "session", "question" or "post"; `maxTotal` is an
    overall cap on top of a per-day/session/question/post one (null = none).
    Sent to the apps as is. */
export const RULES = Object.freeze([
  { key: "profile.linkedin",   label: "Add your LinkedIn",   description: "Add your LinkedIn profile to your TTFC profile.", points: 20, max: 1, per: "total", maxTotal: null },
  { key: "profile.topics",     label: "Pick your topics",    description: "Choose 3 or more topics of interest.", points: 10, max: 1, per: "total", maxTotal: null },
  { key: "session.saved",      label: "Save a session",      description: "Each session you save to your agenda (up to 10).", points: 5, max: 10, per: "total", maxTotal: null },
  { key: "session.attended",   label: "Take part in a session", description: "Each session where you vote in a poll or ask a question (up to 40).", points: 20, max: 40, per: "total", maxTotal: null },
  { key: "live.vote",          label: "Vote in a poll",      description: "Each live poll you vote in (up to 3 per session, 60 in all).", points: 5, max: 3, per: "session", maxTotal: 60 },
  { key: "live.question",      label: "Ask a question",      description: "Each question you ask that's published.", points: 10, max: null, per: null, maxTotal: null },
  { key: "live.upvoted",       label: "Get upvoted",         description: "Each upvote your questions get from others (up to 10 per question).", points: 2, max: 10, per: "question", maxTotal: null },
  { key: "network.request",    label: "Reach out",           description: "Each connection request you send (up to 20).", points: 5, max: 20, per: "total", maxTotal: null },
  { key: "network.connection", label: "Make a connection",   description: "Each accepted connection.", points: 15, max: null, per: null, maxTotal: null },
  { key: "network.inPerson",   label: "Meet in person",      description: "Extra for each connection made by scanning a badge (up to 30).", points: 10, max: 30, per: "total", maxTotal: null },
  { key: "feed.post",          label: "Post on the feed",    description: "Each post (up to 3 a day).", points: 10, max: 3, per: "day", maxTotal: null },
  { key: "feed.comment",       label: "Comment",             description: "Each comment (up to 10 a day).", points: 3, max: 10, per: "day", maxTotal: null },
  { key: "feed.likes",         label: "Get likes",           description: "Each like your posts get from others (up to 25 per post).", points: 1, max: 25, per: "post", maxTotal: null },
].map((r) => Object.freeze(r)));

/** Lowest total for each level, ascending. */
export const LEVELS = Object.freeze([
  { key: "explorer",    name: "Explorer",    min: 0 },
  { key: "connector",   name: "Connector",   min: 100 },
  { key: "insider",     name: "Insider",     min: 300 },
  { key: "trailblazer", name: "Trailblazer", min: 600 },
  { key: "catalyst",    name: "Catalyst",    min: 1000 },
].map((l) => Object.freeze(l)));

/* ================= PURE SCORING ================= */

/** Non-negative whole number (anything else → 0). */
const whole = (v) => {
  const x = Math.floor(Number(v));
  return Number.isFinite(x) && x > 0 ? x : 0;
};
/** Array, or the values of a { day: n } map. */
const list = (v) => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : []);
const capTotal = (v, max) => (max == null ? whole(v) : Math.min(whole(v), max));
const capEach = (v, max) => list(v).reduce((sum, x) => sum + capTotal(x, max), 0);
const topicCount = (t) => (Array.isArray(t)
  ? new Set(t.map((s) => String(s ?? "").trim().toLowerCase()).filter(Boolean)).size
  : whole(t));

/** What a person has done, before caps. Every field is optional. */
export function emptyCounts() {
  return {
    hasLinkedin: false,
    topics: 0,                  // number of topics (or the array itself)
    sessionsSaved: 0,
    sessionsAttended: 0,        // distinct agenda sessions with a poll vote or an approved question
    votesPerSession: [],        // poll votes, one entry per agenda session (or a { sessionId: n } map)
    questionsApproved: 0,       // approved questions in agenda sessions
    upvotesPerQuestion: [],     // upvotes from others, one entry per counted question
    requestsSent: 0,            // connection requests sent, any status
    connections: 0,             // accepted, either direction
    inPersonConnections: 0,     // accepted and kind inPerson
    postsPerDay: [],            // approved posts per UTC day
    commentsPerDay: [],         // approved comments per UTC day
    likesPerPost: [],           // likes from others, one entry per approved post
  };
}

/** How many times each rule is counted, caps applied. */
const COUNTERS = {
  "profile.linkedin":   (c) => (c.hasLinkedin ? 1 : 0),
  "profile.topics":     (c) => (topicCount(c.topics) >= 3 ? 1 : 0),
  "session.saved":      (c, r) => capTotal(c.sessionsSaved, r.max),
  "session.attended":   (c, r) => capTotal(c.sessionsAttended, r.max),
  "live.vote":          (c, r) => capTotal(capEach(c.votesPerSession, r.max), r.maxTotal),
  "live.question":      (c) => whole(c.questionsApproved),
  "live.upvoted":       (c, r) => capEach(c.upvotesPerQuestion, r.max),
  "network.request":    (c, r) => capTotal(c.requestsSent, r.max),
  "network.connection": (c) => whole(c.connections),
  "network.inPerson":   (c, r) => capTotal(c.inPersonConnections, r.max),
  "feed.post":          (c, r) => capEach(c.postsPerDay, r.max),
  "feed.comment":       (c, r) => capEach(c.commentsPerDay, r.max),
  "feed.likes":         (c, r) => capEach(c.likesPerPost, r.max),
};

/** The level a total reaches. */
export function levelFor(total) {
  const t = whole(total);
  let level = LEVELS[0];
  for (const l of LEVELS) if (t >= l.min) level = l;
  return level;
}

/** The next level up (null at the top). */
export function nextLevelFor(total) {
  const t = whole(total);
  return LEVELS.find((l) => l.min > t) || null;
}

/** counts → { total, breakdown: [{ key, label, points, count }], level, nextLevel, toNext }.
    `breakdown` lists every rule in RULES order (zeros too); toNext is 0 at the top level. */
export function scoreFromCounts(counts = {}) {
  const c = counts || {};
  const breakdown = RULES.map((r) => {
    const count = COUNTERS[r.key](c, r);
    return { key: r.key, label: r.label, points: count * r.points, count };
  });
  const total = breakdown.reduce((sum, b) => sum + b.points, 0);
  const nextLevel = nextLevelFor(total);
  return { total, breakdown, level: levelFor(total), nextLevel, toNext: nextLevel ? nextLevel.min - total : 0 };
}

/** What the person actually did for each rule, before caps: { [rule key]: n }.
    The apps' "Your activity" summary shows these (the breakdown's `count` is
    what was counted for points, so it stops at a rule's cap). Every rule key
    is present, zeros included. */
export function activityFromCounts(counts = {}) {
  const c = counts || {};
  const sum = (v) => list(v).reduce((n, x) => n + whole(x), 0);
  const raw = {
    "profile.linkedin":   c.hasLinkedin ? 1 : 0,
    "profile.topics":     topicCount(c.topics),
    "session.saved":      whole(c.sessionsSaved),
    "session.attended":   whole(c.sessionsAttended),
    "live.vote":          sum(c.votesPerSession),
    "live.question":      whole(c.questionsApproved),
    "live.upvoted":       sum(c.upvotesPerQuestion),
    "network.request":    whole(c.requestsSent),
    "network.connection": whole(c.connections),
    "network.inPerson":   whole(c.inPersonConnections),
    "feed.post":          sum(c.postsPerDay),
    "feed.comment":       sum(c.commentsPerDay),
    "feed.likes":         sum(c.likesPerPost),
  };
  return Object.fromEntries(RULES.map((r) => [r.key, raw[r.key] ?? 0]));
}

/* ================= PURE: PROFILE, MERGING, RANKING ================= */

const LINKEDIN_RX = /(linkedin\.com|lnkd\.in)\//i;

/** The profile part of the counts (a LinkedIn link, the topics). */
export function profileCounts(user) {
  return {
    hasLinkedin: LINKEDIN_RX.test(String(user?.linkedinUrl || "")),
    topics: topicCount(Array.isArray(user?.topics) ? user.topics : []),
  };
}

/** Aggregation rows (see countPipelines) → Map<userId, counts>. With `sessions`
    (a Set of agenda session ids), votes and questions in any other session are
    left out; null counts every session (the agenda couldn't be read). */
export function mergeCounts({ saved = [], votes = [], questions = [], connections = [], posts = [], comments = [] } = {}, { sessions = null } = {}) {
  const known = (s) => !sessions || sessions.has(String(s));
  const map = new Map();
  const attended = new Map();
  const get = (id) => {
    const k = String(id);
    if (!map.has(k)) { map.set(k, emptyCounts()); attended.set(k, new Set()); }
    return map.get(k);
  };
  const attend = (id, sessions) => { for (const s of list(sessions)) attended.get(String(id)).add(String(s)); };
  const rows = (a) => list(a).filter((r) => r && r._id != null);

  for (const r of rows(saved)) get(r._id).sessionsSaved = whole(r.n);
  for (const r of rows(votes)) {
    const per = list(r.perSession).filter((x) => x && known(x.s));
    get(r._id).votesPerSession = per.map((x) => whole(x.n));
    attend(r._id, per.map((x) => x.s));
  }
  for (const r of rows(questions)) {
    const items = list(r.items).filter((q) => q && known(q.s));
    const c = get(r._id);
    c.questionsApproved = items.length;
    c.upvotesPerQuestion = items.map((q) => whole(q.up));
    attend(r._id, items.map((q) => q.s));
  }
  for (const r of rows(connections)) {
    const c = get(r._id);
    c.requestsSent = whole(r.sent);
    c.connections = whole(r.accepted);
    c.inPersonConnections = whole(r.inPerson);
  }
  for (const r of rows(posts)) {
    const c = get(r._id);
    c.postsPerDay = list(r.perDay).map(whole);
    c.likesPerPost = list(r.likes).flat().map(whole);
  }
  for (const r of rows(comments)) get(r._id).commentsPerDay = list(r.perDay).map(whole);
  for (const [k, set] of attended) map.get(k).sessionsAttended = set.size;
  return map;
}

/** Staff, banned people and anyone who opted out (of the leaderboard or the
    attendee directory) never appear on the leaderboard. */
export function onLeaderboard(user) {
  if (!user) return false;
  if (String(user.role || "").toLowerCase() === "admin") return false;
  return !user.banned && !user.hideFromLeaderboard && !user.directoryHidden;
}

/** Public card on the leaderboard: never email, never role. */
export function leaderboardCard(user) {
  const id = String(user?._id || user?.id || "");
  return {
    id,
    name: user?.name || "",
    organization: user?.organization || "",
    jobTitle: user?.jobTitle || "",
    avatarUrl: avatarPath(id, user?.avatarVersion),
  };
}

/** Most points first (ties by name); tied people share a rank (1, 2, 2, 4). */
export function rankRows(rows) {
  const sorted = [...rows].sort((a, b) => (b.points - a.points)
    || String(a.user?.name || "").localeCompare(String(b.user?.name || ""))
    || String(a.user?.id || "").localeCompare(String(b.user?.id || "")));
  let rank = 0;
  return sorted.map(({ rank: _old, ...r }, i) => {
    if (i === 0 || r.points !== sorted[i - 1].points) rank = i + 1;
    return { rank, ...r };
  });
}

/** Where `points` places this person on a ranked board (null with no points). */
export function rankAmong(rows, userId, points) {
  const p = whole(points);
  if (!p) return null;
  const me = String(userId);
  return 1 + rows.filter((r) => r.user.id !== me && r.points > p).length;
}

/** ?limit= → 1…50, default 10. */
export function clampLimit(v, { def = 10, max = 50 } = {}) {
  const x = Math.floor(Number(v));
  if (!Number.isFinite(x) || x < 1) return def;
  return Math.min(x, max);
}

/* ================= MONGO: GATHERING COUNTS ================= */

const DAY = { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } };   // UTC
/** Size of an id array with the owner's own id left out (self-likes, the auto-upvote). */
const fromOthers = (field, owner) => ({
  $size: { $filter: { input: { $ifNull: [field, []] }, cond: { $ne: ["$$this", owner] } } },
});

/** One aggregation per collection, grouped by person. With `oid` they only
    read that person's records (each match is on an indexed field). */
export function countPipelines(oid = null) {
  const match = (field, extra = {}) => ({ $match: { ...(oid ? { [field]: oid } : {}), ...extra } });
  return {
    saved: [
      match("userId"),
      { $group: { _id: "$userId", n: { $sum: 1 } } },
    ],
    votes: [
      match("userId"),
      { $group: { _id: { u: "$userId", s: "$sessionId" }, n: { $sum: 1 } } },
      { $group: { _id: "$_id.u", perSession: { $push: { s: "$_id.s", n: "$n" } } } },
    ],
    questions: [
      match("authorId", { status: "approved" }),
      { $group: { _id: "$authorId", items: { $push: { s: "$sessionId", up: fromOthers("$upvotes", "$authorId") } } } },
    ],
    // Each connection counts for both people: once as "sent" for fromUserId.
    connections: [
      { $match: oid ? { $or: [{ fromUserId: oid }, { toUserId: oid }] } : {} },
      { $project: { status: 1, kind: 1, side: [
        { u: "$fromUserId", sent: { $literal: 1 } },
        { u: "$toUserId", sent: { $literal: 0 } },
      ] } },
      { $unwind: "$side" },
      ...(oid ? [{ $match: { "side.u": oid } }] : []),
      { $group: {
        _id: "$side.u",
        sent: { $sum: "$side.sent" },
        accepted: { $sum: { $cond: [{ $eq: ["$status", "accepted"] }, 1, 0] } },
        inPerson: { $sum: { $cond: [{ $and: [{ $eq: ["$status", "accepted"] }, { $eq: ["$kind", "inPerson"] }] }, 1, 0] } },
      } },
    ],
    posts: [
      match("authorId", { status: "approved" }),
      { $group: { _id: { u: "$authorId", day: DAY }, n: { $sum: 1 }, likes: { $push: fromOthers("$likes", "$authorId") } } },
      { $group: { _id: "$_id.u", perDay: { $push: "$n" }, likes: { $push: "$likes" } } },
    ],
    comments: [
      match("authorId", { status: "approved" }),
      { $group: { _id: { u: "$authorId", day: DAY }, n: { $sum: 1 } } },
      { $group: { _id: "$_id.u", perDay: { $push: "$n" } } },
    ],
  };
}

/* ---------- agenda session ids (Sanity, public CDN) ---------- */

const AGENDA_QUERY = '*[_type=="session" && !(_id in path("drafts.**"))]{_id, sessionId}';
export const AGENDA_URL =
  `https://${SANITY_PROJECT}.apicdn.sanity.io/v2021-10-21/data/query/production?query=${encodeURIComponent(AGENDA_QUERY)}`;

/** Sanity result → Set of the ids the apps may use for a session (its
    `sessionId`, else its `_id`; both are kept). Null when there are none. */
export function parseSessionIds(json) {
  const ids = new Set();
  for (const s of list(json?.result)) {
    for (const v of [s?.sessionId, s?._id]) {
      const id = typeof v === "string" ? v.trim() : "";
      if (id) ids.add(id);
    }
  }
  return ids.size ? ids : null;
}

/** Agenda session ids, cached 10 minutes. A failed fetch keeps the last good
    set and retries after a minute; until one has loaded, get() gives null
    (count every session, the caps still apply). Never throws. Logs the first
    failure of an outage, not every retry.
    Also used by services/sessionLive.js with its own `url`, `parse` and `label`
    (parse: Sanity JSON → value, or null when it shouldn't be trusted). */
export function makeAgendaCache({
  fetchImpl = globalThis.fetch, url = AGENDA_URL, parse = parseSessionIds, label = "POINTS AGENDA",
  ttlMs = 10 * 60 * 1000, retryMs = 60 * 1000, now = () => Date.now(), log = console,
} = {}) {
  let ids = null;
  let expires = 0;
  let pending = null;
  let failing = false;
  async function load() {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`Sanity ${res.status}`);
      const parsed = parse(await res.json());
      if (!parsed) throw new Error("no sessions on the agenda");
      ids = parsed;
      expires = now() + ttlMs;
      failing = false;
    } catch (err) {
      if (!failing) log.error?.(`${label} ERROR:`, err?.message || err);
      failing = true;
      expires = now() + retryMs;
    }
    return ids;
  }
  return {
    async get() {
      if (now() < expires) return ids;
      if (!pending) pending = load().finally(() => { pending = null; });
      return pending;
    },
  };
}

const agenda = makeAgendaCache();

async function queryCounts(oid = null) {
  const p = countPipelines(oid);
  const [sessions, saved, votes, questions, connections, posts, comments] = await Promise.all([
    agenda.get(),
    SessionRegistration.aggregate(p.saved),
    SessionVote.aggregate(p.votes),
    SessionQuestion.aggregate(p.questions),
    SocialConnection.aggregate(p.connections),
    SocialPost.aggregate(p.posts),
    SocialComment.aggregate(p.comments),
  ]);
  return mergeCounts({ saved, votes, questions, connections, posts, comments }, { sessions });
}

const isObjectId = (id) => /^[a-f0-9]{24}$/i.test(String(id || ""));

/** One person's score, plus `activity` (activityFromCounts). Pass `user`
    (with linkedinUrl + topics) to skip loading it. */
export async function pointsFor(userId, { user } = {}) {
  const scored = (c) => ({ ...scoreFromCounts(c), activity: activityFromCounts(c) });
  if (!isObjectId(userId)) return scored(emptyCounts());
  const oid = new mongoose.Types.ObjectId(String(userId));
  const [u, map] = await Promise.all([
    user || User.findById(oid).select("linkedinUrl topics").lean(),
    queryCounts(oid),
  ]);
  return scored({ ...(map.get(String(oid)) || emptyCounts()), ...profileCounts(u) });
}

/* ================= LEADERBOARD (cached 60 s) ================= */

const BOARD_TTL_MS = 60_000;
let cache = { at: 0, rows: null };
let pending = null;
let generation = 0;

async function buildBoard() {
  const map = await queryCounts();
  const users = await User.find({
    role: { $ne: "admin" },          // onLeaderboard below also catches "Admin"
    banned: { $ne: true },
    hideFromLeaderboard: { $ne: true },
    directoryHidden: { $ne: true },
    $or: [
      { _id: { $in: [...map.keys()].filter(isObjectId) } },
      // Profile points alone count once they're on the app.
      { $and: [
        { $or: [{ appOnboarded: true }, { lastActiveAt: { $exists: true } }] },
        { $or: [{ linkedinUrl: LINKEDIN_RX }, { "topics.2": { $exists: true } }] },
      ] },
    ],
  }).select("name jobTitle organization avatarVersion linkedinUrl topics role banned hideFromLeaderboard directoryHidden").lean();

  const rows = [];
  for (const u of users) {
    if (!onLeaderboard(u)) continue;
    const score = scoreFromCounts({ ...(map.get(String(u._id)) || emptyCounts()), ...profileCounts(u) });
    if (score.total > 0) rows.push({ user: leaderboardCard(u), points: score.total, level: score.level });
  }
  return rankRows(rows);
}

/** Everyone on the leaderboard, ranked: [{ rank, user, points, level }]. */
export async function rankedBoard() {
  if (cache.rows && Date.now() - cache.at < BOARD_TTL_MS) return cache.rows;
  if (!pending) {
    const gen = generation;
    pending = buildBoard()
      .then((rows) => {
        if (gen === generation) cache = { at: Date.now(), rows };
        return rows;
      })
      .finally(() => { pending = null; });
  }
  return pending;
}

/** The top `limit` (1…50), leaving out ids in `exclude` (ranks unchanged). */
export async function leaderboard(limit = 10, { exclude } = {}) {
  const skip = exclude instanceof Set ? exclude : new Set((exclude || []).map(String));
  const rows = await rankedBoard();
  return rows.filter((r) => !skip.has(r.user.id)).slice(0, clampLimit(limit));
}

/** Someone just opted out: take them off the cached board now rather than in a
    minute. (Opting back in shows up on the next rebuild; not rebuilding on every
    toggle keeps the PATCH from forcing a full recount.) */
export function dropFromBoard(userId) {
  generation += 1;
  const id = String(userId);
  if (cache.rows) cache = { ...cache, rows: rankRows(cache.rows.filter((r) => r.user.id !== id)) };
}

/** A person's fresh score and their place on the board (null when off it). */
export async function standingFor(user) {
  const [score, board] = await Promise.all([pointsFor(user._id, { user }), rankedBoard()]);
  return { score, rank: onLeaderboard(user) ? rankAmong(board, user._id, score.total) : null };
}
