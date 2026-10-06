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

/** base64url HMAC-SHA256 of "<purpose>:<ticketId>", or "" when no secret is set.
    Each kind of link has its own purpose prefix, so a signature made for one
    (say the wallet pass) is never valid for another (the profile form). */
export function signForPurpose(purpose, ticketId, secret = walletLinkSecret()) {
  if (!secret || !ticketId || !purpose) return "";
  return crypto.createHmac("sha256", secret).update(`${purpose}:${ticketId}`).digest("base64url");
}

/** Constant-time check of a purpose-bound link signature. */
export function verifyForPurpose(purpose, ticketId, sig, secret = walletLinkSecret()) {
  if (!secret || !ticketId || typeof sig !== "string" || !sig) return false;
  const expected = Buffer.from(signForPurpose(purpose, String(ticketId), secret));
  const given = Buffer.from(sig);
  return expected.length > 0 && given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const WALLET_PURPOSE = "ttfc-wallet:v1";

/** base64url HMAC-SHA256 of the ticket ID, or "" when no secret is set. */
export function signTicketId(ticketId, secret = walletLinkSecret()) {
  return signForPurpose(WALLET_PURPOSE, ticketId, secret);
}

/** Constant-time check of a link signature. */
export function verifyTicketSig(ticketId, sig, secret = walletLinkSecret()) {
  return verifyForPurpose(WALLET_PURPOSE, ticketId, sig, secret);
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
