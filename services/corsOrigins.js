/* =========================================================
   Which browser origins may call the API (Nov 2026).

   Before: a fixed list, and any other origin got
   `new Error("CORS not allowed")`, which Express turned into a
   500 (the flood of "CORS not allowed" in the Render logs) and
   which shut out every Vercel preview, so staging couldn't be
   tested against the API.

   Now, allowed:
     - the live site, its Vercel project address and our API hosts
     - this project's Vercel previews and branch addresses only
       (techfest-canada-frontend-…-ttfc-projects.vercel.app) and the
       staging website's own address (staging.thetechfestival.com)
     - local development on the usual Vite ports
     - anything in CORS_EXTRA_ORIGINS (comma-separated exact
       origins, e.g. a staging domain or a Cloudflare Pages
       address once the site moves)
   Anything else is refused quietly: no CORS headers, so the
   browser blocks it, and no 500. Requests without an Origin
   (the apps, Stripe, servers, curl) are unaffected.
========================================================= */

export const FIXED_ORIGINS = [
  "https://www.thetechfestival.com",
  "https://thetechfestival.com",
  "https://staging.thetechfestival.com",   // the staging website, where staff check content before it goes live
  "https://techfest-canada-frontend.vercel.app",
  "https://techfest-canada-backend.onrender.com",
  "https://techfest-api.onrender.com"
];

const VERCEL_PREVIEW = /^https:\/\/techfest-canada-frontend-[a-z0-9-]{1,80}-ttfc-projects\.vercel\.app$/;
const LOCAL_DEV = /^http:\/\/(localhost|127\.0\.0\.1):(5173|5174|4173|3000)$/;

export function extraOrigins(env = process.env) {
  return String(env.CORS_EXTRA_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter((s) => /^https?:\/\/[^/\s]+$/.test(s));
}

/** May a browser on this origin call the API? Pure. */
export function originAllowed(origin, env = process.env) {
  if (!origin) return true; // apps, webhooks, servers
  const o = String(origin);
  if (FIXED_ORIGINS.includes(o)) return true;
  if (VERCEL_PREVIEW.test(o)) return true;
  if (LOCAL_DEV.test(o)) return true;
  return extraOrigins(env).includes(o);
}

/** The `origin` option for the cors package: never throws. */
export function corsOrigin(origin, callback) {
  callback(null, originAllowed(origin));
}
