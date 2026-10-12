import express from "express";
import axios from "axios";
import { makeLimiter } from "../services/ticketAccess.js";
import { frontendUrl } from "../services/profileRequest.js";
import AttendingPost from "../models/AttendingPost.js";
import {
  LI_COOKIE, LI_POST_SCOPE, PHOTO_MAX_BYTES, PHOTO_TYPES, attendingReturnUrl, cleanPostText, isAttendingState, isDraftId,
  isPostState, licdnPhotoUrl, linkedinAuthUrl, linkedinConfigured, newDraftId, newLinkedinPostState, newLinkedinState,
  pngFromDataUrl, postReturnUrl, readCookie, statesMatch,
} from "../services/attendingCampaign.js";
import { postImageToLinkedin } from "../services/linkedinPost.js";

/* =========================================================
   /api/attending: the website's "I'm attending" page (/attending)
   ---------------------------------------------------------
   The page itself works without the backend (the image is drawn in
   the browser). These help with option (a), the LinkedIn photo:

   GET /linkedin
     Starts LinkedIn sign-in ("Sign In with LinkedIn using OpenID
     Connect", scope "openid profile") with the website's existing
     LinkedIn app: LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET and
     LINKEDIN_REDIRECT_URI (the redirect URI already registered for
     routes/auth.js, /api/auth/linkedin/callback). The state is
     "ttfc-att.<random>", also kept in a short-lived HttpOnly cookie.
     Not configured → back to /attending#li_error=unavailable.

   GET /api/auth/linkedin/callback (attendingLinkedinCallback, mounted
     in server.js before routes/auth.js)
     Only for an attending state; anything else falls through to the
     normal LinkedIn sign-in. Checks the state against the cookie,
     reads /v2/userinfo (given_name, family_name, picture) and sends
     the browser to /attending#li=1&fn=…&ln=…&pic=…. Nothing is saved:
     no account is created and the token is dropped.

   "Post to LinkedIn" (computers; phones use the share sheet):
   POST /api/attending/post { image: "data:image/png;base64,…", text }
     (attendingPostDraft, mounted in server.js with a bigger body
     limit) keeps the finished image and text for 30 minutes
     (models/AttendingPost.js) → { id }.
   GET /linkedin/post?d=<id>
     LinkedIn sign-in with "openid profile w_member_social" (the app
     needs LinkedIn's "Share on LinkedIn" product). The callback above
     posts the image with the text (services/linkedinPost.js), deletes
     the draft and sends the browser to /attending#posted=1&post=<URL>,
     or #post_error=<code>. The token is used once and dropped.

   GET /photo?u=<media.licdn.com URL>
     The LinkedIn picture, for browsers where LinkedIn's CDN refuses a
     cross-origin read (the canvas would be "tainted" and couldn't be
     exported). Only https media.licdn.com hosts, no redirects, images
     only, 5 MB max, rate-limited per IP.
========================================================= */

const router = express.Router();
const photoPerIp = makeLimiter({ max: 30, windowMs: 15 * 60 * 1000 });
const startPerIp = makeLimiter({ max: 20, windowMs: 15 * 60 * 1000 });
const draftPerIp = makeLimiter({ max: 10, windowMs: 15 * 60 * 1000 });
const COOKIE_PATH = "/api/auth/linkedin";
const COOKIE_MAX_AGE_S = 10 * 60;

const back = (res, error) => res.redirect(302, attendingReturnUrl(frontendUrl(), { error }));
const backFromPost = (res, error) => res.redirect(302, postReturnUrl(frontendUrl(), { error }));
const isHttps = (req) => req.secure || req.protocol === "https";

function setStateCookie(req, res, value, maxAge = COOKIE_MAX_AGE_S) {
  const parts = [`${LI_COOKIE}=${encodeURIComponent(value)}`, `Path=${COOKIE_PATH}`, `Max-Age=${maxAge}`, "HttpOnly", "SameSite=Lax"];
  if (isHttps(req)) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

router.get("/linkedin", (req, res) => {
  if (!linkedinConfigured()) return back(res, "unavailable");
  if (!startPerIp.hit(req.ip || "?")) return back(res, "busy");
  const state = newLinkedinState();
  setStateCookie(req, res, state);
  res.set("Cache-Control", "no-store");
  res.redirect(302, linkedinAuthUrl({
    clientId: process.env.LINKEDIN_CLIENT_ID,
    redirectUri: process.env.LINKEDIN_REDIRECT_URI,
    state,
  }));
});

/** POST /api/attending/post: keeps the finished image + text while they approve posting on LinkedIn. */
export async function attendingPostDraft(req, res) {
  if (!linkedinConfigured()) return res.status(503).json({ error: "Posting to LinkedIn isn't available right now.", code: "unavailable" });
  if (!draftPerIp.hit(req.ip || "?")) return res.status(429).json({ error: "Too many tries. Wait a few minutes, then try again.", code: "busy" });
  const png = pngFromDataUrl(req.body?.image);
  if (!png) return res.status(400).json({ error: "That image couldn't be used.", code: "image" });
  const text = cleanPostText(req.body?.text);
  if (!text) return res.status(400).json({ error: "Write something for your post first.", code: "text" });
  const draftId = newDraftId();
  await AttendingPost.create({ draftId, png, text });
  res.set("Cache-Control", "no-store");
  res.json({ id: draftId });
}

router.get("/linkedin/post", async (req, res) => {
  if (!linkedinConfigured()) return backFromPost(res, "unavailable");
  if (!startPerIp.hit(req.ip || "?")) return backFromPost(res, "busy");
  const draftId = typeof req.query.d === "string" ? req.query.d : "";
  const state = newLinkedinPostState();
  const draft = isDraftId(draftId) ? await AttendingPost.findOneAndUpdate({ draftId }, { $set: { state } }) : null;
  if (!draft) return backFromPost(res, "expired");
  setStateCookie(req, res, state);
  res.set("Cache-Control", "no-store");
  res.redirect(302, linkedinAuthUrl({
    clientId: process.env.LINKEDIN_CLIENT_ID,
    redirectUri: process.env.LINKEDIN_REDIRECT_URI,
    state,
    scope: LI_POST_SCOPE,
  }));
});

const CANCELLED = new Set(["user_cancelled_login", "user_cancelled_authorize"]);

/** For GET /api/auth/linkedin/callback: handles attending states, passes everything else on. */
export async function attendingLinkedinCallback(req, res, next) {
  const state = typeof req.query?.state === "string" ? req.query.state : "";
  if (!isAttendingState(state)) return next();
  res.set("Cache-Control", "no-store");
  const posting = isPostState(state);
  const fail = posting ? (code) => backFromPost(res, code) : (code) => back(res, code);
  const cookie = readCookie(req.headers.cookie, LI_COOKIE);
  setStateCookie(req, res, "", 0); // single use
  if (!statesMatch(state, cookie)) return fail("expired");
  if (req.query.error) {
    const e = String(req.query.error);
    if (CANCELLED.has(e)) return fail("cancelled");
    // The LinkedIn app doesn't have "Share on LinkedIn" (w_member_social) yet.
    return fail(posting && /scope/i.test(e) ? "unavailable" : "denied");
  }
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!code || !linkedinConfigured()) return fail(code ? "unavailable" : "denied");
  try {
    const token = await axios.post("https://www.linkedin.com/oauth/v2/accessToken", new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: process.env.LINKEDIN_REDIRECT_URI,
      client_id: process.env.LINKEDIN_CLIENT_ID,
      client_secret: process.env.LINKEDIN_CLIENT_SECRET,
    }), { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10000 });
    const info = await axios.get("https://api.linkedin.com/v2/userinfo", {
      headers: { Authorization: `Bearer ${token.data?.access_token}` }, timeout: 10000,
    });
    const u = info.data || {};
    if (posting) {
      const draft = await AttendingPost.findOneAndDelete({ state });
      if (!draft) return fail("expired");
      const { url } = await postImageToLinkedin({
        accessToken: token.data?.access_token, personId: u.sub, png: draft.png, text: draft.text,
        altText: "I'm attending The Tech Festival Canada 2026, 26–27 October, Toronto",
      });
      return res.redirect(302, postReturnUrl(frontendUrl(), { post: url }));
    }
    return res.redirect(302, attendingReturnUrl(frontendUrl(), {
      firstName: u.given_name || "", lastName: u.family_name || "", picture: u.picture || "",
    }));
  } catch (err) {
    const status = err.response?.status;
    console.error(posting ? "ATTENDING LINKEDIN POST ERROR:" : "ATTENDING LINKEDIN ERROR:", status || "",
      err.response?.data?.error || err.response?.data?.code || "", err.response?.data?.message || err.message);
    return fail(posting && status === 403 ? "unavailable" : "failed");
  }
}

router.get("/photo", async (req, res) => {
  if (!photoPerIp.hit(req.ip || "?")) return res.status(429).json({ error: "Too many requests. Try again in a few minutes." });
  const url = licdnPhotoUrl(typeof req.query.u === "string" ? req.query.u : "");
  if (!url) return res.status(400).json({ error: "Only LinkedIn profile pictures can be loaded." });
  try {
    const r = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 8000,
      maxRedirects: 0,
      maxContentLength: PHOTO_MAX_BYTES,
      maxBodyLength: PHOTO_MAX_BYTES,
      headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8" },
      validateStatus: (s) => s === 200,
    });
    const type = String(r.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    const body = Buffer.from(r.data);
    if (!PHOTO_TYPES.test(type) || !body.length || body.length > PHOTO_MAX_BYTES) {
      return res.status(415).json({ error: "That isn't a picture we can use." });
    }
    res.set({
      "Content-Type": type,
      "Content-Length": String(body.length),
      "Cache-Control": "private, max-age=600",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
    });
    return res.send(body);
  } catch (err) {
    const status = err.response?.status;
    console.error("ATTENDING PHOTO PROXY:", status || err.code || err.message);
    return res.status(502).json({ error: "Couldn't load the LinkedIn picture." });
  }
});

export default router;
