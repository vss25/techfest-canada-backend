import crypto from "crypto";
import { normalizeTicketId } from "./ticketAccess.js";
import { apiBaseUrl } from "./walletLink.js";
import { escapeHtml as esc } from "./ticketInfo.js";

/* =========================================================
   Signed per-person tracking tokens (Oct 19 2026)
   ---------------------------------------------------------
   "Who opened which email, who clicked through, who posted on
   LinkedIn" needs to know whose email it was. Each real send
   carries a short token that says so:

     base64url(JSON {c: campaign, e?: email, t?: ticket ID}) + "." + sig
     sig = the first 16 bytes of HMAC-SHA256("ttfc-track:v1:" + body), base64url

   It goes in the open pixel (GET /api/t/o/<token>.gif) and, for the
   "I'm attending" email, in the /attending link (#…&r=<token>).
   verifyTrack() gives the payload back only when the signature is
   ours (constant-time compare), so nobody can record an open or a
   post for someone else.

   Secret: TRACKING_SECRET, falling back to JWT_SECRET. With neither
   set nothing is signed: emails then simply carry no pixel and no
   token. Rotating the secret only stops older tokens counting.
   The purpose prefix keeps these HMACs from ever matching a JWT or
   a wallet-link signature made with the same key.
========================================================= */

const PURPOSE = "ttfc-track:v1";
const SIG_BYTES = 16; // 22 base64url characters
/** Longest token we read (an email address is at most 254 characters). */
export const TRACK_TOKEN_MAX = 400;
const CAMPAIGN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SHAPE = /^([A-Za-z0-9_-]{8,377})\.([A-Za-z0-9_-]{22})$/;

export function trackSecret(env = process.env) {
  return String(env.TRACKING_SECRET || env.JWT_SECRET || "");
}

const mac = (body, secret) => crypto.createHmac("sha256", secret).update(`${PURPOSE}:${body}`).digest().subarray(0, SIG_BYTES).toString("base64url");
const cleanEmail = (e) => {
  const s = String(e || "").trim().toLowerCase();
  return s && s.length <= 254 && EMAIL.test(s) ? s : "";
};

/** The tidy payload, or null: a campaign key, and an email and / or ticket ID. */
function payloadOf({ c, e = "", t = "" } = {}) {
  const campaign = String(c || "").trim();
  if (!CAMPAIGN.test(campaign)) return null;
  const email = cleanEmail(e);
  const ticket = normalizeTicketId(t);
  if (!email && !ticket) return null;
  return { c: campaign, ...(email ? { e: email } : {}), ...(ticket ? { t: ticket } : {}) };
}

/** The token for { c, e?, t? }, or "" (no secret, nothing to say who it is, or too long for a link). */
export function signTrack(payload, secret = trackSecret()) {
  if (!secret) return "";
  const p = payloadOf(payload);
  if (!p) return "";
  const body = Buffer.from(JSON.stringify(p)).toString("base64url");
  const token = `${body}.${mac(body, secret)}`;
  return token.length <= TRACK_TOKEN_MAX ? token : ""; // a very long address: not tracked

}

/** Looks like a token (no signature check): what the website keeps and sends back. */
export const isTrackTokenShape = (s) => typeof s === "string" && s.length <= TRACK_TOKEN_MAX && SHAPE.test(s);

/** { c, e, t } ("" for a part it doesn't have) when the token is ours, else null. Never throws. */
export function verifyTrack(token, secret = trackSecret()) {
  if (!secret || !isTrackTokenShape(token)) return null;
  const [, body, sig] = SHAPE.exec(token);
  const want = Buffer.from(mac(body, secret));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  let raw;
  try { raw = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  const p = payloadOf(raw);
  return p ? { c: p.c, e: p.e || "", t: p.t || "" } : null;
}

/** The open pixel's address for a token already signed ("" without one). */
export const pixelUrlFor = (token, base = apiBaseUrl()) => (token ? `${base}/api/t/o/${token}.gif` : "");

/** The 1×1 open pixel's address for this send, or "" when nothing can be signed. */
export function openPixelUrl(payload, { base = apiBaseUrl(), secret = trackSecret() } = {}) {
  return pixelUrlFor(signTrack(payload, secret), base);
}

/** The pixel as it goes at the end of an email's body ("" for no pixel). */
export function pixelHtml(src) {
  if (!src) return "";
  return `<img src="${esc(src)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;outline:none;opacity:0;">`;
}

/** Puts the pixel just before </body> (or at the end). Nothing changes when there's no pixel. */
export function withPixel(html, src) {
  const img = pixelHtml(src);
  if (!img) return html;
  const i = String(html).lastIndexOf("</body>");
  return i < 0 ? `${html}${img}` : `${html.slice(0, i)}${img}\n${html.slice(i)}`;
}
