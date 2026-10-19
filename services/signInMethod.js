/* =========================================================
   How an app JWT was signed in: its `via` claim
   ---------------------------------------------------------
   "email"  the emailed link or 6-digit code (routes/emailLink.js)
   "ticket" pass ID + last name (routes/ticketAuth.js)
   none     a password (website, admin panel, the apps' staff
            sign-in), Google or LinkedIn, and every token issued
            before the claim existed. These count as password tokens.

   Anyone, staff included, may sign in to the apps by email. The
   admin panel stays password-only: requireAdmin
   (middleware/adminAuth.js) refuses tokens without a password.
   In-app staff features (door check-in, moderation, removing
   posts) go by role and app rights, not by how someone signed in.
   POST /api/auth/refresh keeps the claim, so a refreshed email
   token is still an email token. Pure, unit-tested.
========================================================= */

export const VIA_EMAIL = "email";
export const VIA_TICKET = "ticket";
const PASSWORDLESS = new Set([VIA_EMAIL, VIA_TICKET]);

/** A `via` value worth keeping in a token, or undefined (password / unknown). */
export const cleanVia = (via) => (PASSWORDLESS.has(via) ? via : undefined);

/** True for a decoded token that was signed in without a password. */
export const signedInWithoutPassword = (decoded) => PASSWORDLESS.has(decoded?.via);

/** The JWT payload for an account: { id, role } plus `via` when it isn't a password sign-in. */
export function tokenClaims(user, via) {
  const v = cleanVia(via);
  return { id: user._id, role: user.role, ...(v ? { via: v } : {}) };
}

export const PASSWORD_REQUIRED = "Sign in to the admin panel with your staff password.";
/** Sent with PASSWORD_REQUIRED so the admin panel can send staff to its sign-in page. */
export const PASSWORD_REQUIRED_CODE = "password_required";
