/* The free Muse bridge for LinkedIn profile posts (routes/museLinkedinBridge.js), the parts that need no
   database: when the bridge counts as on, which writer the panel is offered, the delivery checks Muse's
   drafts go through again on the server (https-only sources that really open, no em-dashes, LinkedIn's
   length limit, different from colleagues, same story = duplicate, removed means removed), the rate
   limiter, and the SSRF-safe fetcher the bridge must use for every source link (private, loopback and
   link-local addresses refused, redirects to them refused). Nothing here touches the network: the fetcher
   is stubbed or driven through a fake transport, exactly like test/logo-fetch.test.js. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { safeFetch } from "../services/logoFetch.js";
import { makeRateLimiter, museDeps, processImport, verifySource } from "../routes/museLinkedinBridge.js";
import { lipDeps, museBridgeEnabled, writingVia } from "../routes/linkedinProfilePosts.js";

const env = (patch) => {
  const saved = {};
  for (const k of Object.keys(patch)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
};

/* ---------- when the bridge is on, and who writes ---------- */

test("the bridge is on only with the flag AND a key; the writer is anthropic, else muse, else nobody", () => {
  const realClaude = lipDeps.claude;
  lipDeps.claude = () => null;
  try {
    let undo = env({ MUSE_BRIDGE_ENABLED: undefined, MUSE_BRIDGE_KEY: undefined });
    assert.equal(museBridgeEnabled(), false);
    assert.equal(writingVia(), null);
    undo();
    undo = env({ MUSE_BRIDGE_ENABLED: "true", MUSE_BRIDGE_KEY: undefined });
    assert.equal(museBridgeEnabled(), false);
    assert.equal(writingVia(), null);
    undo();
    undo = env({ MUSE_BRIDGE_ENABLED: "false", MUSE_BRIDGE_KEY: "k" });
    assert.equal(museBridgeEnabled(), false);
    undo();
    undo = env({ MUSE_BRIDGE_ENABLED: "true", MUSE_BRIDGE_KEY: "k" });
    assert.equal(museBridgeEnabled(), true);
    assert.equal(writingVia(), "muse");
    undo();
    // An Anthropic key always wins: the bridge is only the free fallback.
    lipDeps.claude = () => ({ fake: true });
    undo = env({ MUSE_BRIDGE_ENABLED: "true", MUSE_BRIDGE_KEY: "k" });
    assert.equal(writingVia(), "anthropic");
    undo();
  } finally { lipDeps.claude = realClaude; }
});

/* ---------- sources: https only, and really opened ---------- */

const loads = (good) => {
  const calls = [];
  const fn = async (url) => { calls.push(url); if (good.has(url)) return { status: 200, contentType: "text/html" }; throw new Error("didn't load"); };
  fn.calls = calls;
  return fn;
};

test("verifySource: an http link is dropped without being opened; https is opened; a failed open is dropped", async () => {
  const fetchPage = loads(new Set(["https://www.canada.ca/news/a.html"]));
  assert.equal(await verifySource({ url: "http://www.canada.ca/news/a.html", title: "A" }, fetchPage), null);
  assert.deepEqual(fetchPage.calls, []);   // never opened at all
  const ok = await verifySource({ url: "https://www.canada.ca/news/a.html", title: "A — big news", supports: "the fact" }, fetchPage);
  assert.equal(ok.url, "https://www.canada.ca/news/a.html");
  assert.equal(ok.title, "A, big news");   // the em-dash is taken out here too
  assert.equal(await verifySource({ url: "https://www.canada.ca/news/gone.html" }, fetchPage), null);
});

/* ---------- the delivery checks ---------- */

const BODY_A = "Ottawa just put new money behind quantum research, and the timing matters for Canadian labs that have led on the science for years and now need the companies to stay here.";
const BODY_B = "The Canada and EU digital trade pact is a quiet but real shift for Canadian software companies selling into Europe, and it changes how they plan their next year of growth.";
const COLLEAGUE = "Canada's new sovereign AI compute fund puts two billion dollars into data centres across the country this year, and it changes who can train models here.";
const REMOVED = "British Columbia's ports are moving record volumes of Canadian energy this quarter, and the terminals are hiring across the coast.";

const good = (over = {}) => ({
  headline: "Quantum funding", topic: "pillars", eventKey: "van-2027", body: BODY_A, hashtags: ["Quantum", "#Canada"],
  sources: [{ url: "https://www.canada.ca/news/a.html", title: "Canada backs quantum", supports: "the funding" }],
  check: { verdict: "passed", notes: "Checked." }, ...over,
});
const fetchOk = loads(new Set(["https://www.canada.ca/news/a.html", "https://www.reuters.com/world/trade.html", "https://ised-isde.canada.ca/site/ai-compute/en", "https://ised-isde.canada.ca/site/ai-compute/en?utm_source=newsletter", "https://www.canada.ca/news/old.html"]));

test("processImport: a good draft is kept, its em-dashes taken out, its hashtags cleaned", async () => {
  const { kept, dropped } = await processImport({
    drafts: [good({ body: `${BODY_A} Labs — and their partners — welcome it.`, hashtags: ["Quantum!", "##Canada", ""] })],
    others: [], dismissed: [], fetchPage: fetchOk,
  });
  assert.equal(dropped.length, 0);
  assert.equal(kept.length, 1);
  assert.doesNotMatch(kept[0].body, /[—–]/);
  assert.deepEqual(kept[0].hashtags, ["#Quantum", "#Canada"]);
  assert.equal(kept[0].sources[0].url, "https://www.canada.ca/news/a.html");
});

test("processImport: too long for LinkedIn, and a draft with no opening source, are dropped", async () => {
  const { kept, dropped } = await processImport({
    drafts: [
      good({ headline: "Too long", body: "word ".repeat(700) }),
      good({ headline: "No source", sources: [{ url: "https://www.canada.ca/news/gone.html", title: "Gone" }] }),
      good({ headline: "Http only", sources: [{ url: "http://www.canada.ca/news/a.html", title: "A" }] }),
    ],
    others: [], dismissed: [], fetchPage: fetchOk,
  });
  assert.equal(kept.length, 0);
  assert.deepEqual(dropped.map((d) => [d.headline, d.why]), [
    ["Too long", "too long for LinkedIn"],
    ["No source", "no source could be opened"],
    ["Http only", "no source could be opened"],
  ]);
});

test("processImport: too close to a colleague's post is dropped, even with its own source", async () => {
  const { kept, dropped } = await processImport({
    drafts: [good({ headline: "Near copy", body: `${COLLEAGUE} More soon.`, sources: [{ url: "https://www.reuters.com/world/trade.html", title: "Reuters" }] })],
    others: [{ body: COLLEAGUE, sources: [{ url: "https://ised-isde.canada.ca/site/ai-compute/en" }] }],
    dismissed: [], fetchPage: fetchOk,
  });
  assert.equal(kept.length, 0);
  assert.deepEqual(dropped, [{ headline: "Near copy", why: "too close to another post" }]);
});

test("processImport: the same story as a colleague (same lead source) is dropped, however different the words", async () => {
  const { kept, dropped } = await processImport({
    drafts: [good({ headline: "Same story", body: BODY_B, sources: [{ url: "https://ised-isde.canada.ca/site/ai-compute/en?utm_source=newsletter", title: "AI Compute Access Fund" }] })],
    others: [{ body: COLLEAGUE, sources: [{ url: "https://ised-isde.canada.ca/site/ai-compute/en", title: "AI Compute Access Fund" }] }],
    dismissed: [], fetchPage: fetchOk,
  });
  assert.equal(kept.length, 0);
  assert.deepEqual(dropped, [{ headline: "Same story", why: "same story as a colleague's recent post" }]);
});

test("processImport: the same story twice in one delivery keeps only the first", async () => {
  const { kept, dropped } = await processImport({
    drafts: [good(), good({ headline: "Same story again", body: BODY_B })],
    others: [], dismissed: [], fetchPage: fetchOk,
  });
  assert.equal(kept.length, 1);
  assert.deepEqual(dropped, [{ headline: "Same story again", why: "same story as another draft in this delivery" }]);
});

test("processImport: removed means removed — too close to, or the same lead source as, the owner's own removed draft", async () => {
  const dismissed = [{ body: REMOVED, sources: [{ url: "https://www.canada.ca/news/old.html", title: "Old" }] }];
  const near = await processImport({
    drafts: [good({ headline: "Near the removed one", body: `${REMOVED} Again.`, sources: [{ url: "https://www.reuters.com/world/trade.html", title: "Reuters" }] })],
    others: [], dismissed, fetchPage: fetchOk,
  });
  assert.deepEqual(near.dropped, [{ headline: "Near the removed one", why: "too close to a post you removed" }]);
  const sameSource = await processImport({
    drafts: [good({ headline: "New words, removed story", body: BODY_B, sources: [{ url: "https://www.canada.ca/news/old.html", title: "Old" }] })],
    others: [], dismissed, fetchPage: fetchOk,
  });
  assert.deepEqual(sameSource.dropped, [{ headline: "New words, removed story", why: "same story as a post you removed" }]);
});

/* ---------- the rate limiter ---------- */

test("the rate limiter lets the limit through, then answers 429, and frees up after the window", () => {
  let t = 1_000_000;
  const limiter = makeRateLimiter({ limit: 3, windowMs: 60_000, now: () => t });
  const run = () => {
    let status = 0, passed = false;
    limiter({ ip: "203.0.113.7", socket: {} }, { status: (s) => ({ json: () => { status = s; } }) }, () => { passed = true; });
    return { status, passed };
  };
  assert.deepEqual([run().passed, run().passed, run().passed], [true, true, true]);
  const blocked = run();
  assert.equal(blocked.passed, false);
  assert.equal(blocked.status, 429);
  t += 61_000;
  assert.equal(run().passed, true);
});

/* ---------- the fetcher the bridge uses (safeFetch), through a fake transport ---------- */

function transport(routes) {
  const mod = {
    request(url, opts) {
      const req = new EventEmitter();
      req.destroy = (err) => { if (err) req.emit("error", err); };
      req.end = () => setImmediate(() => {
        const r = routes[url.href];
        if (!r) return req.emit("error", Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
        const res = Readable.from([Buffer.from(r.body || "<html>ok</html>")]);
        res.statusCode = r.status || 200;
        res.headers = { ...(r.type ? { "content-type": r.type } : { "content-type": "text/html" }), ...(r.location ? { location: r.location } : {}) };
        req.emit("response", res);
        return undefined;
      });
      return req;
    },
  };
  return { "https:": mod, "http:": mod };
}

test("the bridge's fetcher refuses private, loopback and link-local links, and redirects that land there", async () => {
  // Literal private addresses are refused before any connection (the cloud metadata address included).
  await assert.rejects(museDeps.fetchPage("https://127.0.0.1/admin"), (e) => e.code === "EURL");
  await assert.rejects(museDeps.fetchPage("https://169.254.169.254/latest/meta-data"), (e) => e.code === "EURL");
  await assert.rejects(museDeps.fetchPage("https://[::1]/"), (e) => e.code === "EURL");
  // A public page that redirects to a private address is refused at the redirect.
  const t = transport({
    "https://news.example.org/story": { status: 302, location: "http://127.0.0.1/admin" },
    "https://news.example.org/real": { status: 200, type: "text/html", body: "<html>the story</html>" },
  });
  await assert.rejects(safeFetch("https://news.example.org/story", { kind: "html", transport: t }), (e) => e.code === "EURL");
  const page = await safeFetch("https://news.example.org/real", { kind: "html", transport: t });
  assert.equal(page.status, 200);
  assert.equal(page.contentType, "text/html");
});

test("the bridge opens links only through safeFetch: no raw fetch, axios or http in its source", () => {
  const src = fs.readFileSync(new URL("../routes/museLinkedinBridge.js", import.meta.url), "utf8");
  assert.match(src, /from "\.\.\/services\/logoFetch\.js"/);
  assert.equal(/\baxios\b/.test(src), false);
  assert.equal(/globalThis\.fetch|\bundici\b|https?\.request|from "node:https?"/.test(src), false);
});
