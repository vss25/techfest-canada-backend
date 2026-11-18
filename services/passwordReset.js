import crypto from "crypto";

/* =========================================================
   Password reset by email (Nov 18 2026: "allow the ability to reset password on the admin panel.
   Send a link to email to reset").

   The link carries a random 32-byte token; only its SHA-256 is stored (User.resetPasswordToken),
   so a database read never gives a working link. One hour, single use.
   Staff and volunteer accounts asking from the admin sign-in get a link back to the admin sign-in
   (/admin-login?reset=<token>); everyone else the website's /reset-password/<token> page.
========================================================= */

export const RESET_MS = 60 * 60 * 1000;
export const MIN_PASSWORD = 8;
export const RESET_SENT = "If that email has an account, a reset link is on its way. It works for 1 hour.";

export const newResetToken = () => crypto.randomBytes(32).toString("hex");

export const hashResetToken = (token) =>
  crypto.createHash("sha256").update(String(token || "")).digest("hex");

/** Tokens are 64 hex characters; anything else is never looked up. */
export const isResetToken = (token) => typeof token === "string" && /^[a-f0-9]{64}$/.test(token);

export const isStaffAccount = (user) => user?.role === "admin" || user?.role === "volunteer";

export function resetLinkFor(user, token, { base, admin = false } = {}) {
  const root = String(base || "https://www.thetechfestival.com").replace(/\/+$/, "");
  return admin && isStaffAccount(user)
    ? `${root}/admin-login?reset=${token}`
    : `${root}/reset-password/${token}`;
}

/** "" when the new password is fine, else the sentence to show. */
export function passwordProblem(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (password.length > 200) return "Use 200 characters or fewer.";
  return "";
}
