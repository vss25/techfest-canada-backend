/* =========================================================
   Catalyst Awards jury: sign-in and sessions (Oct 2026)
   ---------------------------------------------------------
   Jurors are their own accounts (models/Juror.js), never Users.
   Their tokens are JWTs signed with the jury key, which is not
   JWT_SECRET: JURY_JWT_SECRET when it's set, else a key derived
   from JWT_SECRET (HMAC, so it can't be worked back). Every
   other route verifies with JWT_SECRET, so a juror's token fails
   there (401) — the admin console, People, the apps, everything.
   The other way round, jury routes verify with the jury key, the
   "ttfc-jury" audience and the jury issuer, so a staff or app
   token never opens the portal. The token's `tv` must match the
   juror's tokenVersion (bumped when the password changes or the
   juror is switched off or removed) and the juror must be active.
   Codes: 6 digits, hashed with the email and a jury-only prefix,
   15 minutes, five tries, in their own collection
   (models/JurySignInRequest.js). Pure parts are unit-tested in
   test/jury.test.js; routes/jury.js uses them.
========================================================= */

import crypto from "crypto";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { normalizeEmail, sha256 } from "./emailLink.js";

export const JURY_AUDIENCE = "ttfc-jury";
export const JURY_ISSUER = "ttfc-jury-portal";
export const JURY_TOKEN_TTL = "7d";
export const VIA_PASSWORD = "password";
export const VIA_CODE = "code";
export const CODE_TTL_MS = 15 * 60 * 1000;
export const MAX_CODE_TRIES = 5;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;
export const SESSION_ENDED = "Your jury session has ended. Please sign in again.";
export const SIGN_IN_CODE = "jury_signin";

/** The key jury tokens are signed with (never JWT_SECRET itself). */
export function jurySecret(env = process.env) {
  if (env.JURY_JWT_SECRET) return String(env.JURY_JWT_SECRET);
  if (!env.JWT_SECRET) throw new Error("JWT_SECRET isn't set");
  return crypto.createHmac("sha256", String(env.JWT_SECRET)).update("ttfc-jury-token:v1").digest("hex");
}

/** A juror's session token. `via`: how they signed in ("password" | "code"). */
export function signJuryToken(juror, { via = VIA_PASSWORD, secret = jurySecret() } = {}) {
  return jwt.sign({ typ: "jury", tv: Number(juror?.tokenVersion) || 0, via: via === VIA_CODE ? VIA_CODE : VIA_PASSWORD }, secret, {
    subject: String(juror._id), audience: JURY_AUDIENCE, issuer: JURY_ISSUER, expiresIn: JURY_TOKEN_TTL, algorithm: "HS256",
  });
}

/** The token's claims, or null when it isn't a valid jury token (wrong key, audience, issuer, type or expired). */
export function verifyJuryToken(token, { secret = jurySecret() } = {}) {
  if (typeof token !== "string" || token.length > 2000) return null;
  try {
    const d = jwt.verify(token, secret, { audience: JURY_AUDIENCE, issuer: JURY_ISSUER, algorithms: ["HS256"] });
    if (d?.typ !== "jury" || !/^[a-f0-9]{24}$/i.test(String(d.sub || ""))) return null;
    return d;
  } catch { return null; }
}

const bearer = (req) => {
  const h = String(req.headers?.authorization || "");
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
};

/** Can this juror use the portal now? (On the jury, switched on.) */
export const jurorCanSignIn = (j) => !!j && !j.removedAt && j.active !== false;

/**
 * The guard for every jury route but sign-in: a jury token for an active juror whose sessions haven't been
 * ended. Sets req.juror and req.juryVia. 401 `{ code: "jury_signin" }` otherwise (the portal shows sign-in).
 * lastActiveAt is updated at most every 2 minutes.
 */
export function makeRequireJuror({ Juror, now = () => Date.now() }) {
  return async function requireJuror(req, res, next) {
    const claims = verifyJuryToken(bearer(req));
    if (!claims) return res.status(401).json({ error: SESSION_ENDED, code: SIGN_IN_CODE });
    let juror;
    try { juror = await Juror.findById(claims.sub).lean(); } catch { juror = null; }
    if (!jurorCanSignIn(juror) || (Number(juror.tokenVersion) || 0) !== Number(claims.tv)) {
      return res.status(401).json({ error: SESSION_ENDED, code: SIGN_IN_CODE });
    }
    req.juror = juror;
    req.juryVia = claims.via === VIA_CODE ? VIA_CODE : VIA_PASSWORD;
    const t = now();
    if (!juror.lastActiveAt || t - new Date(juror.lastActiveAt).getTime() > 2 * 60 * 1000) {
      Juror.updateOne({ _id: juror._id }, { $set: { lastActiveAt: new Date(t) } }).catch(() => {});
    }
    next();
  };
}

/* ---------- passwords ---------- */

/** "" when the password is fine, else what's wrong with it. */
export function passwordProblem(password, { email = "" } = {}) {
  if (typeof password !== "string" || password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (!password.trim()) return "The password can't be only spaces.";
  if (email && password.trim().toLowerCase() === normalizeEmail(email)) return "Don't use your email address as the password.";
  return "";
}

export const hashPassword = (password) => bcrypt.hash(password, 10);

// Compared against when there's no juror (or no password), so a miss takes as long as a wrong password.
let dummyHash = null;
const dummy = async () => (dummyHash ||= await bcrypt.hash(crypto.randomBytes(16).toString("hex"), 10));

/** Constant-ish time: always runs one bcrypt compare. */
export async function checkPassword(password, hash) {
  if (typeof password !== "string" || !password || password.length > PASSWORD_MAX) {
    await bcrypt.compare("x", await dummy());
    return false;
  }
  if (!hash) {
    await bcrypt.compare(password, await dummy());
    return false;
  }
  return bcrypt.compare(password, hash);
}

/* ---------- 6-digit codes ---------- */

/** A jury code's hash: bound to the email and to the jury (an app code's hash never matches). */
export const hashJuryCode = (email, code) => sha256(`ttfc-jury-code:v1:${normalizeEmail(email)}:${code}`);

/** One message for every wrong, used, expired or locked code: it never says whether the email is a juror's. */
export const CODE_REFUSED = "That code isn't right, or it has expired. Check the latest email, or ask for a new code.";
export const LOGIN_REFUSED = "That email and password don't match. Try again, or sign in with a code instead.";
export const TOO_MANY = "Too many attempts. Please wait 15 minutes and try again.";
