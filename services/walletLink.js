import crypto from "crypto";

/* =========================================================
   Signed public links for a ticket (no login needed)
   ---------------------------------------------------------
   Email/PDF buyers are often guests without an app account, so
   the "Add to Apple Wallet" button and the QR image in the
   confirmation email point at public URLs that carry an HMAC of
   the ticket ID:

     GET /api/wallet/pass/:ticketId?sig=<hmac>   → .pkpass
     GET /api/wallet/qr/:ticketId?sig=<hmac>     → QR PNG

   Secret: WALLET_LINK_SECRET, falling back to JWT_SECRET. Rotating
   the secret invalidates every link already emailed, so set
   WALLET_LINK_SECRET once and leave it. The "ttfc-wallet:v1:"
   prefix keeps these HMACs from ever matching a JWT signature
   made with the same key.
========================================================= */

const DEFAULT_API = "https://techfest-canada-backend.onrender.com";

export function walletLinkSecret(env = process.env) {
  return String(env.WALLET_LINK_SECRET || env.JWT_SECRET || "");
}

/** base64url HMAC-SHA256 of the ticket ID, or "" when no secret is set. */
export function signTicketId(ticketId, secret = walletLinkSecret()) {
  if (!secret || !ticketId) return "";
  return crypto.createHmac("sha256", secret).update(`ttfc-wallet:v1:${ticketId}`).digest("base64url");
}

/** Constant-time check of a link signature. */
export function verifyTicketSig(ticketId, sig, secret = walletLinkSecret()) {
  if (!secret || !ticketId || typeof sig !== "string" || !sig) return false;
  const expected = Buffer.from(signTicketId(String(ticketId), secret));
  const given = Buffer.from(sig);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export function apiBaseUrl(env = process.env) {
  return String(env.API_URL || DEFAULT_API).replace(/\/+$/, "");
}

function signedUrl(kind, ticketId, { base = apiBaseUrl(), secret = walletLinkSecret() } = {}) {
  const sig = signTicketId(String(ticketId || ""), secret);
  if (!sig) return "";
  return `${base}/api/wallet/${kind}/${encodeURIComponent(String(ticketId))}?sig=${sig}`;
}

/** Public "Add to Apple Wallet" link, or "" when no secret is configured. */
export const walletPassUrl = (ticketId, opts) => signedUrl("pass", ticketId, opts);

/** Public QR image link (same payload as the PDF), or "" when no secret is configured. */
export const ticketQrUrl = (ticketId, opts) => signedUrl("qr", ticketId, opts);
