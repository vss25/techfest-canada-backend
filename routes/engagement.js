import express from "express";
import { makeLimiter } from "../services/ticketAccess.js";
import { verifyTrack } from "../services/trackToken.js";
import { CAMPAIGNS, engagementKey } from "../services/engagement.js";
import { trackLater } from "../services/engagementStore.js";

/* =========================================================
   GET /api/t/o/<token>.gif: the open pixel (Oct 19 2026)
   ---------------------------------------------------------
   The 1×1 image at the end of the "I'm attending" email, the RSVP
   reminder and the pass emails with the RSVP button. Always the same
   transparent GIF, never cached, whatever the token. An open is
   recorded only when the token is ours (services/trackToken.js), at
   most a few times per token in 15 minutes, after the image has gone,
   and nothing about the visitor is kept. Mounted in server.js before
   the kill switch, so emails never show a broken image.
   What it means and its limits: services/engagement.js.
========================================================= */

export const PIXEL_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const HEADERS = {
  "Content-Type": "image/gif",
  "Content-Length": String(PIXEL_GIF.length),
  "Cache-Control": "no-store, no-cache, must-revalidate, private, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
  "X-Content-Type-Options": "nosniff",
};

/** The handler, with the recorder and the per-token limit passed in for tests. */
export function makeOpenPixel({ record = trackLater, perToken = makeLimiter({ max: 20, windowMs: 15 * 60 * 1000 }) } = {}) {
  return function openPixel(req, res) {
    res.set(HEADERS);
    res.status(200).end(PIXEL_GIF);
    if (req.method !== "GET") return;
    const file = String(req.params?.file || "");
    const token = file.endsWith(".gif") ? file.slice(0, -4) : "";
    const p = token ? verifyTrack(token) : null;
    if (p && perToken.hit(token)) record(engagementKey(p), "open");
  };
}

export const openPixel = makeOpenPixel();

/* POST /api/t/v { r }: the web app was opened from an email's button (Oct 20 2026: the app invite email's link
   carries #r=<token>; the web app sends it back once, src/app/lib/inviteVisit.js). Recorded as a "visit" when the
   token is ours and for an email whose button opens the app; anything else is ignored. Always 204 (text/plain or
   JSON, so the page needs no CORS preflight), at most a few per token, rate-limited per IP. */
export const VISIT_CAMPAIGNS = Object.freeze([CAMPAIGNS.appInvite]);
export function makeAppVisit({ record = trackLater, perToken = makeLimiter({ max: 10, windowMs: 15 * 60 * 1000 }), perIp = makeLimiter({ max: 60, windowMs: 15 * 60 * 1000 }) } = {}) {
  return function appVisit(req, res) {
    res.set("Cache-Control", "no-store");
    if (!perIp.hit(req.ip || "?")) return res.status(429).json({ error: "Too many requests." });
    const r = typeof req.body?.r === "string" ? req.body.r : "";
    const p = r ? verifyTrack(r) : null;
    if (p && VISIT_CAMPAIGNS.includes(p.c) && p.e && perToken.hit(r)) record(engagementKey(p), "visit");
    return res.status(204).end();
  };
}

const router = express.Router();
router.get("/o/:file", openPixel);
router.post("/v", express.json({ type: ["application/json", "text/plain"], limit: "2kb" }), makeAppVisit());

export default router;
