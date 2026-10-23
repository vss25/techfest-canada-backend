import crypto from "node:crypto";
import express from "express";
import axios from "axios";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import LinkedinShare from "../models/LinkedinShare.js";
import LinkedinShareDraft from "../models/LinkedinShareDraft.js";
import { Discussion } from "../models/Community.js";
import { SessionVote } from "../models/Social.js";
import { makeLimiter, SHARED_ADDRESS } from "../services/ticketAccess.js";
import { frontendUrl } from "../services/profileRequest.js";
import { LI_POST_SCOPE, attendingLink, cleanPostText, linkedinAuthUrl, linkedinConfigured, readCookie, splitName } from "../services/attendingCampaign.js";
import { signTrack } from "../services/trackToken.js";
import { CAMPAIGNS } from "../services/engagement.js";
import { postArticleToLinkedin, TTFC_PAGE } from "../services/linkedinPost.js";
import { makeAgendaCache, linkedinCounts, RULES } from "../services/points.js";
import { tally } from "../services/socialHelpers.js";
import {
  HASHTAG, POST_MAX, SESSION_TITLES_URL, SHARE_COOKIE, SHARE_TTL_MS, cleanShareRequest, isShareState, isShareToken,
  newShareState, newShareToken, parseSessionTitles, shareDraft, shareItemKey, shareReturnUrl,
} from "../services/linkedinShare.js";

/* =========================================================
   LinkedIn from the apps (Oct 22 2026)
   ---------------------------------------------------------
   Signed in (the app's JWT), mounted at /api/app:
     GET  /attending-link → { url, posted, points }
          The website's "I'm attending" page for this person (their name, title and company filled in, and their
          signed token, #…&r=, so the post LinkedIn confirms is theirs). Open it in an in-app browser.
          `posted`: they already have a confirmed post (hide the Home card). `points`: what it's worth.
     POST /linkedin/share { kind: "discussion" | "poll", id, sessionId?, question?, options? } → 201 { url, expiresAt, points }
          poll: id = the poll's id and sessionId its session (or id "<sessionId>/<pollId>"); question and options
          as the app shows them (the app bundles its polls), the results come from the votes here.
          discussion: id = a discussion's id, or a session's id (its session discussion).
          → the website's /share/linkedin?t=<token> (2 hours) to edit and post. 404 for a session that isn't on the
          agenda or a discussion they can't see; 503 { code: "unavailable" } when LinkedIn isn't set up.
   The website's /share/linkedin page (no sign-in: the token is the key), mounted at /api/linkedin-share:
     GET  /draft?t= → { kind, sessionTitle, title, description, link, text, maxLength, hashtag, page, expiresAt, available }
          404 { code: "expired" } once it's gone (posted, or 2 hours old)
     POST /text { t, text } → { ok, text } (the edited post, ≤ 3,000 characters)
     GET  /post?t= → LinkedIn sign-in ("openid profile w_member_social", the website's LinkedIn app and its registered
          redirect URI, LINKEDIN_REDIRECT_URI = /api/auth/linkedin/callback); the state "ttfc-shr.<hex>" is also in a
          short-lived HttpOnly cookie.
     GET  /api/auth/linkedin/callback (linkedinShareCallback, mounted in server.js before routes/auth.js): share
          states only (others fall through). Posts the text with the session as a link card and the TTFC page
          tagged, records it (models/LinkedinShare.js: points), deletes the draft and sends the browser to
          /share/linkedin#posted=1&post=<URL>, or #post_error=<code>&t=<token> (cancelled | denied | expired |
          unavailable | failed; the draft stays for another try).
========================================================= */

export const appRouter = express.Router();
export const publicRouter = express.Router();

const sharePerUser = makeLimiter({ max: 30, windowMs: 60 * 60 * 1000 });
const pagePerIp = makeLimiter(SHARED_ADDRESS); // a venue shares one address; each share is 3 calls
const COOKIE_PATH = "/api/auth/linkedin";
const COOKIE_MAX_AGE_S = 10 * 60;
const pointsOf = (key) => RULES.find((r) => r.key === key)?.points || 0;
const titles = makeAgendaCache({ url: SESSION_TITLES_URL, parse: parseSessionTitles, label: "SHARE AGENDA", ttlMs: 10 * 60 * 1000 });

async function signedInUser(req, res) {
  try {
    const h = String(req.headers.authorization || "");
    if (!h.startsWith("Bearer ")) throw new Error("no token");
    const decoded = jwt.verify(h.slice(7), process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select("name email jobTitle organization banned").lean();
    if (!user) throw new Error("no user");
    if (user.banned) { res.status(403).json({ error: "This account is suspended. Contact enquire@thetechfestival.com." }); return null; }
    return user;
  } catch {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
}

/* ---------- the apps ---------- */

appRouter.get("/attending-link", async (req, res) => {
  const user = await signedInUser(req, res);
  if (!user) return;
  const { firstName, lastName } = splitName(user.name);
  const r = signTrack({ c: CAMPAIGNS.attending, e: user.email });
  const oid = new mongoose.Types.ObjectId(String(user._id));
  const { attending } = await linkedinCounts(oid);
  res.set("Cache-Control", "no-store");
  res.json({
    url: attendingLink({ firstName, lastName, title: user.jobTitle || "", company: user.organization || "", r }),
    posted: attending.has(String(user._id)),
    points: pointsOf("linkedin.attending"),
  });
});

appRouter.post("/linkedin/share", async (req, res) => {
  const user = await signedInUser(req, res);
  if (!user) return;
  if (!sharePerUser.hit(String(user._id))) return res.status(429).json({ error: "That's a lot of shares. Try again in a while." });
  const r = cleanShareRequest(req.body);
  if (r.error) return res.status(400).json({ error: r.error });
  if (!linkedinConfigured()) return res.status(503).json({ error: "Posting to LinkedIn isn't available right now.", code: "unavailable" });
  const agenda = await titles.get();   // null when it can't be read: then any session id is taken as is
  const share = { kind: r.kind };
  let sessionId = r.sessionId;
  if (r.kind === "poll") {
    if (agenda && !agenda.has(sessionId)) return res.status(404).json({ error: "That session isn't on the agenda." });
    const votes = await SessionVote.find({ sessionId, pollId: r.id }).select("optionIndex").lean();
    Object.assign(share, { question: r.question, options: r.options, counts: tally(votes, Math.max(r.options.length, 1)) });
  } else if (/^[a-f0-9]{24}$/i.test(r.id)) {
    const d = await Discussion.findById(r.id).select("title body status authorId").lean();
    if (!d || (d.status !== "approved" && String(d.authorId) !== String(user._id))) return res.status(404).json({ error: "Not found" });
    Object.assign(share, { discussionTitle: d.title, discussionBody: d.body });
  } else {
    sessionId = r.id;
    if (agenda && !agenda.has(sessionId)) return res.status(404).json({ error: "That session isn't on the agenda." });
  }
  const session = sessionId ? agenda?.get(sessionId) || null : null;
  const draft = shareDraft(share, session, { sessionId });
  const token = newShareToken();
  const expiresAt = new Date(Date.now() + SHARE_TTL_MS);
  await LinkedinShareDraft.create({
    token, userId: user._id, kind: r.kind, itemKey: shareItemKey({ ...r, sessionId }), sessionId, sessionTitle: session?.title || "",
    ...draft, expiresAt,
  });
  res.status(201).json({ url: `${frontendUrl()}/share/linkedin?t=${token}`, expiresAt, points: pointsOf("linkedin.share") });
});

/* ---------- the website's /share/linkedin page ---------- */

const liveDraft = (t) => (isShareToken(t) ? LinkedinShareDraft.findOne({ token: t, expiresAt: { $gt: new Date() } }) : null);
const isHttps = (req) => req.secure || req.protocol === "https";
const back = (res, opts) => res.redirect(302, shareReturnUrl(frontendUrl(), opts));

function setStateCookie(req, res, value, maxAge = COOKIE_MAX_AGE_S) {
  const parts = [`${SHARE_COOKIE}=${encodeURIComponent(value)}`, `Path=${COOKIE_PATH}`, `Max-Age=${maxAge}`, "HttpOnly", "SameSite=Lax"];
  if (isHttps(req)) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

publicRouter.get("/draft", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!pagePerIp.hit(req.ip || "?")) return res.status(429).json({ error: "Too many requests. Try again in a few minutes." });
  const d = await liveDraft(String(req.query.t || ""));
  if (!d) return res.status(404).json({ error: "This share link has expired. Share it again from the app.", code: "expired" });
  res.json({
    kind: d.kind, sessionTitle: d.sessionTitle, title: d.title, description: d.description, link: d.link, text: d.text,
    maxLength: POST_MAX, hashtag: HASHTAG, page: TTFC_PAGE.name, expiresAt: d.expiresAt, available: linkedinConfigured(),
  });
});

publicRouter.post("/text", express.json({ limit: "16kb" }), async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!pagePerIp.hit(req.ip || "?")) return res.status(429).json({ error: "Too many requests. Try again in a few minutes." });
  const text = cleanPostText(req.body?.text);
  if (!text) return res.status(400).json({ error: "Write something for your post first.", code: "text" });
  const d = await liveDraft(String(req.body?.t || ""));
  if (!d) return res.status(404).json({ error: "This share link has expired. Share it again from the app.", code: "expired" });
  d.text = text;
  await d.save();
  res.json({ ok: true, text });
});

publicRouter.get("/post", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const t = String(req.query.t || "");
  if (!linkedinConfigured()) return back(res, { error: "unavailable", token: t });
  if (!pagePerIp.hit(req.ip || "?")) return back(res, { error: "busy", token: t });
  const state = newShareState();
  const d = isShareToken(t) ? await LinkedinShareDraft.findOneAndUpdate({ token: t, expiresAt: { $gt: new Date() } }, { $set: { state } }) : null;
  if (!d) return back(res, { error: "expired" });
  setStateCookie(req, res, state);
  res.redirect(302, linkedinAuthUrl({ clientId: process.env.LINKEDIN_CLIENT_ID, redirectUri: process.env.LINKEDIN_REDIRECT_URI, state, scope: LI_POST_SCOPE }));
});

const CANCELLED = new Set(["user_cancelled_login", "user_cancelled_authorize"]);
const sameState = (a, b) => {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** For GET /api/auth/linkedin/callback: share states only; everything else goes on (attending, then sign-in). */
export async function linkedinShareCallback(req, res, next) {
  const state = typeof req.query?.state === "string" ? req.query.state : "";
  if (!isShareState(state)) return next();
  res.set("Cache-Control", "no-store");
  const cookie = readCookie(req.headers.cookie, SHARE_COOKIE);
  setStateCookie(req, res, "", 0); // single use
  const d = await LinkedinShareDraft.findOne({ state, expiresAt: { $gt: new Date() } });
  const fail = (error) => back(res, { error, token: d?.token || "" });
  if (!d || !sameState(state, cookie)) return fail("expired");
  if (req.query.error) {
    const e = String(req.query.error);
    return fail(CANCELLED.has(e) ? "cancelled" : /scope/i.test(e) ? "unavailable" : "denied");
  }
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!code || !linkedinConfigured()) return fail(code ? "unavailable" : "denied");
  try {
    const token = await axios.post("https://www.linkedin.com/oauth/v2/accessToken", new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: process.env.LINKEDIN_REDIRECT_URI,
      client_id: process.env.LINKEDIN_CLIENT_ID, client_secret: process.env.LINKEDIN_CLIENT_SECRET,
    }), { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10000 });
    const info = await axios.get("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${token.data?.access_token}` }, timeout: 10000 });
    const { url } = await postArticleToLinkedin({
      accessToken: token.data?.access_token, personId: info.data?.sub, text: d.text, link: d.link, title: d.title, description: d.description,
    });
    await LinkedinShare.create({ userId: d.userId, kind: d.kind, itemKey: d.itemKey, sessionId: d.sessionId, postUrl: url });
    await LinkedinShareDraft.deleteOne({ _id: d._id });
    return back(res, { post: url });
  } catch (err) {
    const status = err.response?.status;
    console.error("LINKEDIN SHARE POST ERROR:", status || "", err.response?.data?.code || "", err.response?.data?.message || err.message);
    return fail(status === 403 ? "unavailable" : "failed");
  }
}

/** The "I'm attending" page's confirmed post (routes/attending.js): theirs by account, so the points follow the person. */
export async function recordAttendingShare(email, postUrl = "") {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return;
  let userId = (await User.findOne({ email: e }).select("_id").lean())?._id;
  if (!userId) userId = (await Attendee.findOne({ email: e, claimedBy: { $exists: true } }).select("claimedBy").lean())?.claimedBy;
  if (!userId) return;
  await LinkedinShare.create({ userId, kind: "attending", itemKey: "attending", postUrl: String(postUrl || "") });
}
