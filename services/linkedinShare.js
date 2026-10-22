import crypto from "node:crypto";
import { EVENT } from "./ticketInfo.js";
import { SANITY_PROJECT } from "./rsvp.js";
import { snippet } from "./notify.js";

/* =========================================================
   "Share on LinkedIn" from the apps (Oct 22 2026). Pure parts.
   ---------------------------------------------------------
   The organiser: "share about a session discussion or poll on
   LinkedIn" via the app, with points. The app asks for a share
   (POST /api/app/linkedin/share), gets a link to the website's
   /share/linkedin?t=<token> page, where the person edits the draft
   and taps "Post to LinkedIn": LinkedIn sign-in ("Share on LinkedIn",
   w_member_social, the website's LinkedIn app and its registered
   redirect URI), then a Posts API post with an article attachment
   (the session on thetechfestival.com) and the TTFC page tagged
   (services/linkedinPost.js). A post LinkedIn confirms is recorded
   (models/LinkedinShare.js) and earns points (services/points.js).
========================================================= */

export const SHARE_KINDS = Object.freeze(["discussion", "poll"]);
export const SHARE_TTL_MS = 2 * 3_600_000;
export const HASHTAG = "#TTFC2026";
export const SHARE_STATE_PREFIX = "ttfc-shr.";
export const SHARE_COOKIE = "ttfc_shr_li";
export const POST_MAX = 3000;

const str = (v) => String(v ?? "");
const line = (v, max) => str(v).replace(/\s+/g, " ").trim().slice(0, max);

export const newShareToken = () => crypto.randomBytes(24).toString("base64url");
export const isShareToken = (t) => typeof t === "string" && /^[A-Za-z0-9_-]{32}$/.test(t);
export const newShareState = () => `${SHARE_STATE_PREFIX}${crypto.randomBytes(16).toString("hex")}`;
export const isShareState = (s) => typeof s === "string" && /^ttfc-shr\.[0-9a-f]{32}$/.test(s);

/** An agenda session id as the apps use them (Sanity sessionId or _id). */
export const isSessionId = (s) => typeof s === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(s);
/** A poll id (the apps bundle the polls: "d1-5-p1"). */
export const isPollId = (s) => typeof s === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(s);

/** The session on the website's agenda (it scrolls to and opens that session). */
export const sessionLink = (sessionId) => `${EVENT.website}/agenda?session=${encodeURIComponent(str(sessionId))}`;

/** POST /api/app/linkedin/share's body → { kind, id, sessionId, question, options } or { error }. */
export function cleanShareRequest(b = {}) {
  const kind = SHARE_KINDS.includes(b?.kind) ? b.kind : "";
  if (!kind) return { error: "kind must be \"discussion\" or \"poll\"." };
  let id = str(b.id).trim();
  let sessionId = str(b.sessionId).trim();
  if (kind === "poll" && !sessionId && id.includes("/")) [sessionId, id] = id.split("/", 2);
  if (kind === "poll") {
    if (!isSessionId(sessionId) || !isPollId(id)) return { error: "A poll needs its sessionId and id." };
    const options = Array.isArray(b.options) ? b.options.slice(0, 16).map((o) => line(o, 80)).filter(Boolean) : [];
    return { kind, id, sessionId, question: line(b.question, 200), options };
  }
  // A discussion: one of the app's discussions (its id), or a session's (its sessionId).
  if (!id && sessionId) id = sessionId;
  if (!/^[a-f0-9]{24}$/i.test(id) && !isSessionId(id)) return { error: "Which discussion? Send its id." };
  return { kind, id, sessionId: isSessionId(sessionId) ? sessionId : "" };
}

/** "Exploring 45% · Piloting 30% · …" from the options and their counts (only once someone has voted). */
export function resultsLine(options = [], counts = []) {
  const total = counts.reduce((a, b) => a + (Number(b) || 0), 0);
  if (!total || !options.length) return "";
  return options.map((o, i) => `${o} ${Math.round(((Number(counts[i]) || 0) / total) * 100)}%`).join(" · ");
}

/**
 * The editable draft for a share: { title, description, link, text }.
 * share: { kind, question?, options?, counts?, discussionTitle?, discussionBody? }, session: { title } | null.
 */
export function shareDraft(share, session, { sessionId = "" } = {}) {
  const sessionTitle = line(session?.title, 160);
  const at = sessionTitle ? `"${sessionTitle}" at The Tech Festival Canada` : "The Tech Festival Canada";
  const link = sessionId && sessionTitle ? sessionLink(sessionId) : EVENT.website;
  const description = `The Tech Festival Canada · ${EVENT.dates} · Toronto`;
  let text;
  let title;
  if (share.kind === "poll") {
    const q = line(share.question, 200);
    const results = resultsLine(share.options || [], share.counts || []);
    title = sessionTitle || "The Tech Festival Canada 2026";
    text = [`${q ? `"${q}" ` : ""}I just voted in the live poll at ${at}.`, results ? `Results so far: ${results}` : "", HASHTAG].filter(Boolean).join("\n\n");
  } else if (share.discussionTitle) {
    title = line(share.discussionTitle, 160);
    const body = snippet(share.discussionBody, 280);
    text = [`Joining the conversation on "${title}" at The Tech Festival Canada.`, body, HASHTAG].filter(Boolean).join("\n\n");
  } else {
    title = sessionTitle || "The Tech Festival Canada 2026";
    text = [`A great discussion at ${at}.`, HASHTAG].join("\n\n");
  }
  return { title, description, link, text: text.slice(0, POST_MAX) };
}

/** The share's item for points: once per item ("poll:<session>:<poll>", "session:<id>", "discussion:<id>"). */
export function shareItemKey({ kind, id, sessionId }) {
  if (kind === "poll") return `poll:${sessionId}:${id}`;
  return /^[a-f0-9]{24}$/i.test(str(id)) ? `discussion:${id}` : `session:${id}`;
}

/** Where /share/linkedin picks up after LinkedIn: #posted=1&post=<URL> or #post_error=<code>&t=<token> (try again). */
export function shareReturnUrl(base, { post = "", error = "", token = "" } = {}) {
  const q = new URLSearchParams();
  if (error) {
    q.set("post_error", error);
    if (isShareToken(token)) q.set("t", token);
  } else {
    q.set("posted", "1");
    if (/^https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:(share|ugcPost):\d+\/$/.test(post)) q.set("post", post);
  }
  return `${str(base).replace(/\/+$/, "")}/share/linkedin#${q.toString()}`;
}

/** Sanity: every session's id(s) → { title } (for the share draft). Null when there are none. */
export const SESSION_TITLES_URL = `https://${SANITY_PROJECT}.apicdn.sanity.io/v2021-10-21/data/query/production?query=${encodeURIComponent('*[_type=="session" && !(_id in path("drafts.**"))]{_id, sessionId, title}')}`;
export function parseSessionTitles(json) {
  const map = new Map();
  for (const s of Array.isArray(json?.result) ? json.result : []) {
    const title = line(s?.title, 200);
    for (const v of [s?.sessionId, s?._id]) if (typeof v === "string" && v.trim() && !map.has(v.trim())) map.set(v.trim(), { title });
  }
  return map.size ? map : null;
}
