import crypto from "node:crypto";
import express from "express";
import axios from "axios";
import Nomination from "../models/Nomination.js";
import AwardPost from "../models/AwardPost.js";
import { makeLimiter, SHARED_ADDRESS } from "../services/ticketAccess.js";
import { frontendUrl } from "../services/profileRequest.js";
import { switchOn } from "../services/liveSwitches.js";
import { LI_POST_SCOPE, cleanPostText, isDraftId, linkedinAuthUrl, linkedinConfigured, newDraftId, readCookie } from "../services/attendingCampaign.js";
import { postImageToLinkedin, TTFC_PAGE } from "../services/linkedinPost.js";
import {
  AWARDS_NIGHT, AWARD_COOKIE, AWARD_DRAFTS_MAX, AWARD_DRAFTS_PER_IP, EVENT_NAME, VENUE, WINNERS_KEY, awardReturnUrl,
  certificateAltText, certificateFromDataUrl, isAwardState, isWinnerId, newAwardState, publicWinners, winnerIdOfState,
} from "../services/awardWinners.js";

/* =========================================================
   /api/awards: the Catalyst Awards winners on the website's /awards
   page and /awards/winners/<id> (Oct 31 2026, services/awardWinners.js).
   No sign-in. Off (site.award_winners) = { live: false, winners: [] }
   and 404 for one.

   GET  /winners      → { live, awardsNight, event, venue, page, winners: [{ id, award, company, presentedTo,
                          showCompany, presentedOn, citation, pillar, sector, special, individual, website }] }
   GET  /winners/:id  → { winner, event, venue, page } | 404
   "Post to LinkedIn" from a winner's page (anyone: the winner, their team, a well-wisher):
   POST /post { id, image: "data:image/jpeg|png;base64,…", text } (awardPostDraft, mounted in server.js with a
        bigger body limit) keeps the certificate (2 MB at most) and the text for 30 minutes (models/AwardPost.js)
        → { id }. 20 per address per 15 minutes, and 503 busy while AWARD_DRAFTS_MAX are waiting.
   GET  /linkedin/post?d=<draft id>&w=<winner id> → LinkedIn sign-in ("openid profile w_member_social", the website's
        LinkedIn app and its registered redirect URI); the state "ttfc-awd.<hex>.<winner id>" is also in a short-lived
        HttpOnly cookie. `w` only says where to come back to when the draft is gone.
   GET  /api/auth/linkedin/callback (awardLinkedinCallback, mounted in server.js before routes/auth.js): award
        states only, others fall through. Checks the winner is still shown (not hidden, still a winner, the switch
        on; else the draft is dropped and nothing is posted: "withdrawn"), then posts the certificate with their
        text and The Tech Festival Canada's page tagged (services/linkedinPost.js), deletes the draft and sends the
        browser to /awards/winners/<id>#posted=1&post=<URL>, or #post_error=<code> (cancelled | denied | expired |
        unavailable | failed | busy | withdrawn). The LinkedIn token is used once and dropped; nothing about them
        is kept.
========================================================= */

const router = express.Router();
const readPerIp = makeLimiter({ ...SHARED_ADDRESS, max: 600 });
const draftPerIp = makeLimiter({ ...SHARED_ADDRESS, max: AWARD_DRAFTS_PER_IP });
const startPerIp = makeLimiter(SHARED_ADDRESS);
const COOKIE_PATH = "/api/auth/linkedin";
const COOKIE_MAX_AGE_S = 10 * 60;
const CACHE_MS = 30_000;

let cached = null; // { at, winners }

/** The public list, cached briefly (Admin › Winners clears it on this server). */
export async function loadWinners() {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.winners;
  const noms = await Nomination.find({ status: "winner" })
    .select("status categoryType pillar sector specialAward nomineeType nomineeName nomineeOrganisation nomineeWebsite award")
    .lean();
  const winners = publicWinners(noms);
  cached = { at: Date.now(), winners };
  return winners;
}
export function forgetWinners() { cached = null; }

const about = { awardsNight: AWARDS_NIGHT, event: EVENT_NAME, venue: VENUE, page: TTFC_PAGE.name };

router.get("/winners", async (req, res) => {
  if (!readPerIp.hit(req.ip || "?")) return res.status(429).json({ error: "Too many requests. Try again in a few minutes." });
  const live = await switchOn(WINNERS_KEY);
  res.set("Cache-Control", "public, max-age=60");
  res.json({ live, ...about, winners: live ? await loadWinners() : [] });
});

router.get("/winners/:id", async (req, res) => {
  if (!readPerIp.hit(req.ip || "?")) return res.status(429).json({ error: "Too many requests. Try again in a few minutes." });
  const id = String(req.params.id || "").toLowerCase();
  const winner = isWinnerId(id) && (await switchOn(WINNERS_KEY)) ? (await loadWinners()).find((w) => w.id === id) : null;
  res.set("Cache-Control", "public, max-age=60");
  if (!winner) return res.status(404).json({ error: "We couldn't find that award.", code: "not_found" });
  res.json({ winner, ...about });
});

/** POST /api/awards/post: keeps the certificate + text while they approve posting on LinkedIn. */
export async function awardPostDraft(req, res) {
  res.set("Cache-Control", "no-store");
  if (!linkedinConfigured()) return res.status(503).json({ error: "Posting to LinkedIn isn't available right now.", code: "unavailable" });
  if (!draftPerIp.hit(req.ip || "?")) return res.status(429).json({ error: "Too many tries. Wait a few minutes, then try again.", code: "busy" });
  const id = String(req.body?.id || "").toLowerCase();
  const winner = isWinnerId(id) && (await switchOn(WINNERS_KEY)) ? (await loadWinners()).find((w) => w.id === id) : null;
  if (!winner) return res.status(404).json({ error: "We couldn't find that award.", code: "not_found" });
  const image = certificateFromDataUrl(req.body?.image);
  if (!image) return res.status(400).json({ error: "That image couldn't be used.", code: "image" });
  const text = cleanPostText(req.body?.text);
  if (!text) return res.status(400).json({ error: "Write something for your post first.", code: "text" });
  if (await AwardPost.estimatedDocumentCount() >= AWARD_DRAFTS_MAX) {
    return res.status(503).json({ error: "Lots of people are posting right now. Try again in a few minutes.", code: "busy" });
  }
  const draftId = newDraftId();
  await AwardPost.create({ draftId, winnerId: id, image, text });
  res.json({ id: draftId });
}

const isHttps = (req) => req.secure || req.protocol === "https";
const back = (res, opts) => res.redirect(302, awardReturnUrl(frontendUrl(), opts));

function setStateCookie(req, res, value, maxAge = COOKIE_MAX_AGE_S) {
  const parts = [`${AWARD_COOKIE}=${encodeURIComponent(value)}`, `Path=${COOKIE_PATH}`, `Max-Age=${maxAge}`, "HttpOnly", "SameSite=Lax"];
  if (isHttps(req)) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

router.get("/linkedin/post", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const draftId = typeof req.query.d === "string" ? req.query.d : "";
  const asked = typeof req.query.w === "string" ? req.query.w.toLowerCase() : "";
  const id = isWinnerId(asked) ? asked : "";
  if (!linkedinConfigured()) return back(res, { id, error: "unavailable" });
  if (!startPerIp.hit(req.ip || "?")) return back(res, { id, error: "busy" });
  const draft = isDraftId(draftId) ? await AwardPost.findOne({ draftId }).select("winnerId").lean() : null;
  if (!draft) return back(res, { id, error: "expired" });
  const state = newAwardState(draft.winnerId);
  await AwardPost.updateOne({ _id: draft._id }, { $set: { state } });
  setStateCookie(req, res, state);
  res.redirect(302, linkedinAuthUrl({ clientId: process.env.LINKEDIN_CLIENT_ID, redirectUri: process.env.LINKEDIN_REDIRECT_URI, state, scope: LI_POST_SCOPE }));
});

const CANCELLED = new Set(["user_cancelled_login", "user_cancelled_authorize"]);
const sameState = (a, b) => {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** For GET /api/auth/linkedin/callback: award states only; everything else goes on (attending, app shares, sign-in). */
export async function awardLinkedinCallback(req, res, next) {
  const state = typeof req.query?.state === "string" ? req.query.state : "";
  if (!isAwardState(state)) return next();
  res.set("Cache-Control", "no-store");
  const cookie = readCookie(req.headers.cookie, AWARD_COOKIE);
  setStateCookie(req, res, "", 0); // single use
  const draft = await AwardPost.findOne({ state });
  const fail = (error) => back(res, { id: draft?.winnerId || winnerIdOfState(state), error });
  if (!draft || !sameState(state, cookie)) return fail("expired");
  if (req.query.error) {
    const e = String(req.query.error);
    // "Share on LinkedIn" (w_member_social) missing from the LinkedIn app reads as a scope error.
    return fail(CANCELLED.has(e) ? "cancelled" : /scope/i.test(e) ? "unavailable" : "denied");
  }
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!code || !linkedinConfigured()) return fail(code ? "unavailable" : "denied");
  // Still shown? Hidden, no longer a winner, or the winners switched off since the draft: nothing is posted.
  const w = (await switchOn(WINNERS_KEY)) ? (await loadWinners()).find((x) => x.id === draft.winnerId) : null;
  if (!w) {
    await AwardPost.deleteOne({ _id: draft._id });
    return fail("withdrawn");
  }
  try {
    const token = await axios.post("https://www.linkedin.com/oauth/v2/accessToken", new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: process.env.LINKEDIN_REDIRECT_URI,
      client_id: process.env.LINKEDIN_CLIENT_ID, client_secret: process.env.LINKEDIN_CLIENT_SECRET,
    }), { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10000 });
    const info = await axios.get("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${token.data?.access_token}` }, timeout: 10000 });
    const { url } = await postImageToLinkedin({
      accessToken: token.data?.access_token, personId: info.data?.sub, png: draft.image, text: draft.text,
      title: w.award.slice(0, 200), altText: certificateAltText(w),
    });
    await AwardPost.deleteOne({ _id: draft._id });
    return back(res, { id: draft.winnerId, post: url });
  } catch (err) {
    const status = err.response?.status;
    console.error("AWARD LINKEDIN POST ERROR:", status || "", err.response?.data?.code || "", err.response?.data?.message || err.message);
    return fail(status === 403 ? "unavailable" : "failed");
  }
}

export default router;
