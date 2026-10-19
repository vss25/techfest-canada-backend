import express from "express";
import { makeLimiter } from "../services/ticketAccess.js";
import { verifyTrack } from "../services/trackToken.js";
import { engagementKey } from "../services/engagement.js";
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

const router = express.Router();
router.get("/o/:file", openPixel);

export default router;
