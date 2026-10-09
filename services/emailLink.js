import crypto from "crypto";

/* =========================================================
   "Email me a sign-in link" — pure helpers
   ---------------------------------------------------------
   POST /api/auth/email-link sends a one-time link + 6-digit code
   to the email a ticket was bought with. Only SHA-256 hashes of
   the token and code are stored (models/SignInRequest.js); the
   request expires after 15 minutes, works once, and allows five
   wrong codes before it locks. routes/emailLink.js wires this to
   Mongo and Resend; everything here is pure and unit-tested.
========================================================= */

export const LINK_TTL_MS = 15 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;
export const CODE_LENGTH = 6;
const DEFAULT_FRONTEND = "https://www.thetechfestival.com";

export function normalizeEmail(raw) {
  return String(raw || "").trim().toLowerCase().slice(0, 254);
}

/** Loose shape check — enough to refuse typos, not an RFC parser. */
export function isValidEmail(raw) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizeEmail(raw));
}

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

/** The token is random enough on its own; hash it as is. */
export const hashToken = (token) => sha256(`ttfc-signin-token:v1:${token}`);

/** A 6-digit code is not, so bind its hash to the email it was sent to. */
export const hashCode = (email, code) => sha256(`ttfc-signin-code:v1:${normalizeEmail(email)}:${code}`);

/** "12 34-56" → "123456"; anything that isn't exactly 6 digits → "". */
export function cleanCode(raw) {
  const digits = String(raw ?? "").replace(/[\s-]/g, "");
  return new RegExp(`^\\d{${CODE_LENGTH}}$`).test(digits) ? digits : "";
}

/** Uniform 6-digit code (000000–999999). */
export function newCode(randomInt = crypto.randomInt) {
  return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0");
}

/** 32 random bytes, base64url (43 chars, safe in URLs and deep links). */
export function newToken(randomBytes = crypto.randomBytes) {
  return randomBytes(32).toString("base64url");
}

/** Everything a new request needs: the secrets to email, and only their hashes to store. */
export function createSignInSecrets(email, { now = Date.now(), ttlMs = LINK_TTL_MS } = {}) {
  const token = newToken();
  const code = newCode();
  return {
    token,
    code,
    record: {
      email: normalizeEmail(email),
      tokenHash: hashToken(token),
      codeHash: hashCode(email, code),
      expiresAt: new Date(now + ttlMs),
      attempts: 0,
      status: "pending",
    },
  };
}

/** True when the token looks like one we issued (cheap pre-check before a DB lookup). */
export function looksLikeToken(raw) {
  return typeof raw === "string" && /^[A-Za-z0-9_-]{32,64}$/.test(raw);
}

/**
 * Can this stored request still be used?
 * → "ok" | "missing" | "used" | "expired" | "locked"
 */
export function requestState(req, now = Date.now()) {
  if (!req) return "missing";
  if (req.status === "used") return "used";
  if (req.status === "locked" || (req.attempts || 0) >= MAX_CODE_ATTEMPTS) return "locked";
  if (req.status !== "pending") return "expired"; // replaced by a newer link
  if (!req.expiresAt || new Date(req.expiresAt).getTime() <= now) return "expired";
  return "ok";
}

/** Constant-time compare of two hex hashes. */
export function sameHash(a, b) {
  const x = Buffer.from(String(a || ""), "utf8");
  const y = Buffer.from(String(b || ""), "utf8");
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Checks a code against a request and says what to store.
 * → { ok, state, attempts, lock, error }
 */
export function checkCode(req, email, code, now = Date.now()) {
  const state = requestState(req, now);
  if (state !== "ok") return { ok: false, state, attempts: req?.attempts || 0, lock: false, error: codeMessageFor(state) };
  const clean = cleanCode(code);
  if (clean && sameHash(hashCode(email, clean), req.codeHash)) {
    return { ok: true, state: "ok", attempts: req.attempts || 0, lock: false, error: "" };
  }
  const attempts = (req.attempts || 0) + 1;
  const left = MAX_CODE_ATTEMPTS - attempts;
  const lock = left <= 0;
  return {
    ok: false,
    state: lock ? "locked" : "wrong",
    attempts,
    lock,
    error: lock ? codeMessageFor("locked") : `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.`,
  };
}

export function messageFor(state) {
  switch (state) {
    case "used": return "That sign-in link has already been used. Request a new one to sign in again.";
    case "locked": return "Too many wrong codes. Request a new sign-in link and try again.";
    case "expired": return "That sign-in link has expired. Request a new one — it only takes a moment.";
    case "missing":
    default: return "That sign-in link isn't valid any more. Request a new one to sign in.";
  }
}

/** Same states, worded for someone who typed the 6-digit code rather than tapped the link. */
export function codeMessageFor(state) {
  switch (state) {
    case "used": return "That code has already been used. Request a new email to sign in again.";
    case "locked": return "Too many wrong codes. Request a new email and try again.";
    case "expired": return "That code has expired. Request a new email — it only takes a moment.";
    case "missing":
    default: return "That code isn't valid any more. Request a new email to sign in.";
  }
}

export function frontendBase(env = process.env) {
  return String(env.FRONTEND_URL || DEFAULT_FRONTEND).trim().replace(/\/+$/, "");
}

/** The link in the email: the website's /app-login page, which opens the app or signs in on the web. */
export function signInLink(token, base = frontendBase()) {
  return `${base}/app-login?token=${encodeURIComponent(token)}`;
}

export const CLIENTS = ["ios", "android", "web"];
export function cleanClient(raw) {
  const c = String(raw || "").toLowerCase();
  return CLIENTS.includes(c) ? c : "web";
}

/** Case-insensitive exact-match regex for legacy rows stored with capitals. */
export function emailRegex(email) {
  return new RegExp(`^${normalizeEmail(email).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
}

/**
 * Which email a sign-in request gets. Links only go to emails tied to a ticket: an account
 * holding at least one ticket, or a guest ticket bought with this email. Staff never get one
 * (they sign in with their password). Everyone else gets the "no ticket" email.
 * @returns {"staff"|"signin"|"no-ticket"}
 */
export function linkDecision(user, guestCount = 0) {
  if (user && String(user.role || "").toLowerCase() === "admin") return "staff";
  const owned = Array.isArray(user?.tickets) ? user.tickets.length : 0;
  return owned > 0 || guestCount > 0 ? "signin" : "no-ticket";
}
