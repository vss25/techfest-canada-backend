/* services/corsOrigins.js (Nov 2026): the live site, this project's Vercel previews,
   local development and CORS_EXTRA_ORIGINS are allowed; anything else is refused
   quietly (no throw, so no 500). Pure. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { originAllowed, corsOrigin, extraOrigins } from "../services/corsOrigins.js";

const env = {};

test("the live site and requests without an Origin are allowed", () => {
  assert.ok(originAllowed("https://www.thetechfestival.com", env));
  assert.ok(originAllowed("https://thetechfestival.com", env));
  assert.ok(originAllowed(undefined, env));
});

test("this project's Vercel previews and branch addresses are allowed, other Vercel projects are not", () => {
  assert.ok(originAllowed("https://techfest-canada-frontend-o3mmd8evh-ttfc-projects.vercel.app", env));
  assert.ok(originAllowed("https://techfest-canada-frontend-git-staging-ttfc-projects.vercel.app", env));
  assert.ok(!originAllowed("https://evil-ttfc-projects.vercel.app", env));
  assert.ok(!originAllowed("https://techfest-canada-frontend-x-otherteam.vercel.app", env));
  assert.ok(!originAllowed("https://techfest-canada-frontend-abc-ttfc-projects.vercel.app.evil.com", env));
});

test("local development ports are allowed, other localhost ports are not", () => {
  assert.ok(originAllowed("http://localhost:5173", env));
  assert.ok(originAllowed("http://127.0.0.1:4173", env));
  assert.ok(!originAllowed("http://localhost:8080", env));
});

test("CORS_EXTRA_ORIGINS adds exact origins (a staging domain, Cloudflare Pages)", () => {
  const e = { CORS_EXTRA_ORIGINS: "https://staging.thetechfestival.com, https://ttfc.pages.dev/ ,not a url" };
  assert.deepEqual(extraOrigins(e), ["https://staging.thetechfestival.com", "https://ttfc.pages.dev"]);
  assert.ok(originAllowed("https://staging.thetechfestival.com", e));
  assert.ok(!originAllowed("https://other.pages.dev", e));
});

test("a refused origin never throws (it used to become a 500)", () => {
  let args;
  corsOrigin("https://example.org", (...a) => { args = a; });
  assert.deepEqual(args, [null, false]);
});

test("the staging website's own address is allowed (Nov 2026)", () => {
  assert.ok(originAllowed("https://staging.thetechfestival.com", env));
  assert.ok(!originAllowed("https://staging.thetechfestival.com.evil.com", env));
});
