/* =========================================================
   How an app JWT was signed in: its `via` claim
   ---------------------------------------------------------
   "email"    the emailed link or 6-digit code (routes/emailLink.js)
   "ticket"   pass ID + last name (routes/ticketAuth.js)
   "google"   Sign in with Google (routes/auth.js, Oct 23 2026)
   "linkedin" Sign in with LinkedIn (routes/auth.js, Oct 23 2026)
   none       a password (website, admin panel, the apps' staff
              sign-in), and every token issued before the claim
              existed (Google and LinkedIn tokens from before Oct 23
              2026 included).

   Anyone, staff included, may sign in to the apps by email. The
   admin panel: staff need a password, Google or LinkedIn token
   (requireAdmin, middleware/adminAuth.js, refuses the emailed code
   and the pass ID: signedInWithoutPassword); a volunteer's People
   look-up (requirePanel) takes their password sign-in only
   (passwordSignIn: no claim at all, and an account that has a
   password). In-app staff features (door check-in, moderation,
   removing posts) go by role and app rights, not by how someone
   signed in. POST /api/auth/refresh keeps the claim, so a refreshed
   email or Google token is still one. Pure, unit-tested.
========================================================= */

export const VIA_EMAIL = "email";
export const VIA_TICKET = "ticket";
export const VIA_GOOGLE = "google";
export const VIA_LINKEDIN = "linkedin";
/** The sign-ins staff can't open the admin panel with. */
const PASSWORDLESS = new Set([VIA_EMAIL, VIA_TICKET]);
/** Every claim a token keeps (none = a password). */
const KEPT = new Set([VIA_EMAIL, VIA_TICKET, VIA_GOOGLE, VIA_LINKEDIN]);

/** A `via` value worth keeping in a token, or undefined (password / unknown). */
export const cleanVia = (via) => (KEPT.has(via) ? via : undefined);

/** True for a decoded token signed in with the emailed code or a pass ID (the staff admin panel refuses these;
    Google and LinkedIn tokens open it for staff, as before). */
export const signedInWithoutPassword = (decoded) => PASSWORDLESS.has(decoded?.via);

/**
 * True only for a password sign-in: a decoded token with no `via` claim at all (Google, LinkedIn, the emailed code,
 * a pass ID and any later method carry one), and, when the account is given, an account that has a password (a
 * token from before Google and LinkedIn were marked can't have come from a password the account doesn't have).
 * The volunteer panel's rule (middleware/adminAuth.js requirePanel).
 */
export function passwordSignIn(decoded, user = undefined) {
  if (!decoded || typeof decoded !== "object" || Object.prototype.hasOwnProperty.call(decoded, "via")) return false;
  return user === undefined || !!user?.password;
}

/** The JWT payload for an account: { id, role } plus `via` when it isn't a password sign-in. */
export function tokenClaims(user, via) {
  const v = cleanVia(via);
  return { id: user._id, role: user.role, ...(v ? { via: v } : {}) };
}

export const PASSWORD_REQUIRED = "Sign in to the admin panel with your staff password.";
/** Sent with PASSWORD_REQUIRED so the admin panel can send staff to its sign-in page. */
export const PASSWORD_REQUIRED_CODE = "password_required";
