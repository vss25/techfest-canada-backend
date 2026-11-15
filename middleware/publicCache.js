/* =========================================================
   Public-read caching (Phase 5 — cost/perf hardening)

   The public, unauthenticated GET payloads (organisations,
   exhibitors, awards, swag, intel, RSVP options, app content…)
   already set their own `Cache-Control: public, max-age=…`
   in their handlers, and most memoize the payload in-process.
   What none of them had is `stale-while-revalidate`, so every
   cache expiry was a hard wait on this one small instance.

   This middleware is applied in server.js ONLY to the mounts
   (or exact paths) on the public allowlist. For GET requests
   it:
     - appends `stale-while-revalidate=<2× max-age>` to a
       `public` Cache-Control value the handler sets itself;
     - if the handler sets no Cache-Control and the response
       is a 2xx, applies the mount's default
       `public, max-age=<ttl>, stale-while-revalidate=<2×ttl>`;
     - NEVER touches a response the handler marked
       `no-store`, `private`, `no-cache` or `immutable`, and
       never runs for non-GET requests or non-allowlisted
       paths — so signed-in, per-user and token flows that
       share a mount prefix keep exactly their own headers.

   Usage:
     publicCache(60)                          → whole mount, 60 s default
     publicCache({ "/organisations": 120 })   → only that exact sub-path
========================================================= */

const SWR_FACTOR = 2;

const normalize = (p) => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);

/** Add stale-while-revalidate to a handler-set public value; leave anything else byte-identical. */
function augment(value, fallbackTtl) {
  const v = String(value ?? "");
  const lower = v.toLowerCase();
  if (
    !lower.startsWith("public") ||
    lower.includes("no-store") ||
    lower.includes("private") ||
    lower.includes("no-cache") ||
    lower.includes("immutable") ||
    lower.includes("stale-while-revalidate")
  ) {
    return v;
  }
  const m = lower.match(/max-age=(\d+)/);
  const maxAge = m ? Number(m[1]) : fallbackTtl;
  if (!Number.isFinite(maxAge) || maxAge <= 0) return v;
  return `${v}, stale-while-revalidate=${maxAge * SWR_FACTOR}`;
}

export function publicCache(ttlOrPaths) {
  const wholeMount = typeof ttlOrPaths === "number";
  const mountTtl = wholeMount ? ttlOrPaths : 0;
  const table = wholeMount
    ? null
    : new Map(Object.entries(ttlOrPaths || {}).map(([p, ttl]) => [normalize(p), ttl]));

  return function publicCacheMiddleware(req, res, next) {
    if (req.method !== "GET") return next();
    const ttl = wholeMount ? mountTtl : table.get(normalize(req.path || "/"));
    if (!ttl) return next();

    const fallback = `public, max-age=${ttl}, stale-while-revalidate=${ttl * SWR_FACTOR}`;
    let handlerSet = false;

    const wrapSetter = (orig) =>
      function (field, value) {
        if (typeof field === "string" && field.toLowerCase() === "cache-control") {
          handlerSet = true;
          return orig.call(this, field, augment(value, ttl));
        }
        if (field && typeof field === "object") {
          // res.set({ "Cache-Control": …, … }) object form
          const copy = { ...field };
          for (const k of Object.keys(copy)) {
            if (k.toLowerCase() === "cache-control") {
              handlerSet = true;
              copy[k] = augment(copy[k], ttl);
            }
          }
          return orig.call(this, copy);
        }
        return orig.apply(this, arguments);
      };
    res.set = wrapSetter(res.set);
    res.setHeader = wrapSetter(res.setHeader);

    const wrapSend = (orig) =>
      function (...args) {
        if (!handlerSet && res.statusCode >= 200 && res.statusCode < 300 && !res.get("Cache-Control")) {
          res.set("Cache-Control", fallback);
        }
        return orig.apply(this, args);
      };
    res.json = wrapSend(res.json);
    res.send = wrapSend(res.send);

    return next();
  };
}

export default publicCache;
