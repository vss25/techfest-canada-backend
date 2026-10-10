/* Complimentary tickets: staff-issued passes for speakers, guests and App Review.
   Pure validation here; routes/console.js stores the Attendee. */

export const COMP_TIERS = ["discover", "connect", "influence", "power", "apex", "session"];
export const COMP_PROMO = "COMP";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Checks a request body. Returns { ok, value } or { ok: false, error }. */
export function validateComplimentary(body = {}) {
  const name = String(body.name || "").trim().replace(/\s+/g, " ").slice(0, 120);
  const email = String(body.email || "").trim().toLowerCase();
  const tier = String(body.tier || "").trim().toLowerCase();
  if (name.split(" ").length < 2) return { ok: false, error: "Enter a first and last name (sign-in uses the last name)." };
  if (!EMAIL.test(email)) return { ok: false, error: "Enter a valid email address." };
  if (!COMP_TIERS.includes(tier)) return { ok: false, error: `Pass must be one of: ${COMP_TIERS.join(", ")}.` };
  return { ok: true, value: { name, email, tier } };
}
