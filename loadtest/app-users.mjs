#!/usr/bin/env node
/* =========================================================
   Event-day load test: N people using the TTFC app (Oct 22 2026)
   ---------------------------------------------------------
   Plays what the apps send to the API, measured from the iOS app
   (the busiest client; Android and the web app send less):
     - the 30 s refresh on every screen: notifications, connections,
       the chat list, every chat in full, the feed (60), groups and
       every joined group's messages (T chats, G groups);
     - Home extras (points, organisations, activity), the 12 post
       checks once the feed is full (each person at most every
       10 min, and after a relaunch);
     - an open 1:1 chat (every 5 s), an open group chat (every 6 s,
       "is typing" every 2.5 s), a live session room (questions and
       poll results every 6 s, status and content every 30 s);
     - a cold launch (about 20 + T + G requests at once) and coming
       back to the app (about 18).
   It only READS: no posts, messages, likes, votes, joins or
   analytics. Reading marks the test account's own chats delivered
   or read, as opening the app would.

   Phases (plan "full", about 16 minutes):
     warm-up       10% of the users on Home, 1 min
     burst-open    everyone launches the app within 5 s, Home, 2 min
     steady        60% Home, 20% in a 1:1 chat, 20% in a group chat, 8 min
     live-room     70% in a live session room, 30% Home, 4 min
     burst-return  everyone comes back to the app within 5 s, 1 min
   Plan "smoke": 10% of the users on Home for 1 min (try this first).

   Safety: nothing runs without --go. It stops by itself if, over
   the last 30 s, more than 25% of requests fail or the slowest 5%
   take over 15 s, and on Ctrl-C; either way it prints the report.

   Run `node loadtest/app-users.mjs --help` for how to use it.
========================================================= */

import fs from "node:fs";
import { performance } from "node:perf_hooks";

const HELP = `
Event-day load test for the TTFC API (read-only).

  node loadtest/app-users.mjs --target <API origin> (--ticket <ticketId>:<LastName> | --token <app token> | --tokens-file <file>) [options] --go

  --target URL         The API, e.g. https://techfest-canada-backend.onrender.com (no /api).
  --ticket ID:LAST     Sign in a test pass with its ticket ID and last name (repeatable). The usual way:
                       Admin › Give a pass, name "Load Test", an email you own; then --ticket <its ticket ID>:Test
  --token JWT          An app sign-in token instead (repeatable). --tokens-file: one per line.
  --users N            Simulated people (default 100). They share the test accounts.
  --plan full|smoke    Default full (about 16 min). Start with smoke.
  --scale X            Multiply every phase's length (e.g. 0.5 for a quicker run).
  --session ID         A real agenda session's id for the live room (else a made-up one; the route is the same).
  --poll ID            That session's poll id (default "poll-1").
  --out FILE           Where to write the JSON report (default loadtest-report-<time>.json).
  --go                 Actually run. Without it, prints the plan and stops.

Make the test account like a real one for a fairer load: in the app, open a few chats and
join 2–3 groups with it. Without chats it reads empty chats with people from the directory;
without groups the group-chat screen has no group messages to read (the report says so).
Afterwards delete the test person in Admin › People (Delete person).
`;

/* ---------------- arguments ---------------- */

function parseArgs(argv) {
  const a = { tickets: [], tokens: [], users: 100, plan: "full", scale: 1, session: "loadtest-session", poll: "poll-1", go: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { const x = argv[++i]; if (x === undefined) throw new Error(`${k} needs a value`); return x; };
    if (k === "--help" || k === "-h") a.help = true;
    else if (k === "--target") a.target = v().replace(/\/+$/, "");
    else if (k === "--ticket") a.tickets.push(v());
    else if (k === "--token") a.tokens.push(v());
    else if (k === "--tokens-file") a.tokens.push(...fs.readFileSync(v(), "utf8").split(/\s+/).filter(Boolean));
    else if (k === "--users") a.users = Math.max(1, Math.round(Number(v())));
    else if (k === "--plan") a.plan = v();
    else if (k === "--scale") a.scale = Number(v());
    else if (k === "--session") a.session = v();
    else if (k === "--poll") a.poll = v();
    else if (k === "--out") a.out = v();
    else if (k === "--go") a.go = true;
    else throw new Error(`Unknown option ${k} (see --help)`);
  }
  return a;
}

/* ---------------- plans ---------------- */

const PLANS = {
  smoke: [
    { name: "smoke", seconds: 60, share: 0.1, mix: { home: 1 }, start: "launch", within: 10 },
  ],
  full: [
    { name: "warm-up", seconds: 60, share: 0.1, mix: { home: 1 }, start: "launch", within: 10 },
    { name: "burst-open", seconds: 120, share: 1, mix: { home: 1 }, start: "launch", within: 5 },
    { name: "steady", seconds: 480, share: 1, mix: { home: 0.6, dm: 0.2, group: 0.2 } },
    { name: "live-room", seconds: 240, share: 1, mix: { live: 0.7, home: 0.3 } },
    { name: "burst-return", seconds: 60, share: 1, mix: { home: 1 }, start: "resume", within: 5 },
  ],
};

const T_TARGET = 5;   // chats per person
const G_TARGET = 6;   // groups per person
const TIMEOUT_MS = 20_000; // the iOS app's request timeout
const UA = "ttfc-loadtest/1 (read-only)";

/* ---------------- recording ---------------- */

const samples = []; // { t, phase, route, ms, status, kind }
let phaseName = "setup";
let inFlight = 0;

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** ok | 4xx | 5xx | 429 | edge (Render's Cloudflare, not our app) | timeout | network */
function classify(status, contentType, text) {
  if (status < 400) return "ok";
  if (/text\/html/.test(contentType || "") && /cloudflare|cf-ray|attention required/i.test(text)) return "edge";
  if (status === 429) return "429";
  return status >= 500 ? "5xx" : "4xx";
}
const BAD = new Set(["5xx", "429", "edge", "timeout", "network"]);

function makeClient(base) {
  return async function hit(token, route, path, { method = "GET", body, json = false } = {}) {
    const t0 = performance.now();
    let status = 0;
    let kind = "ok";
    let data = null;
    inFlight += 1;
    try {
      const r = await fetch(base + path, {
        method,
        headers: {
          "user-agent": UA,
          accept: "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      status = r.status;
      const text = await r.text();
      kind = classify(status, r.headers.get("content-type"), text);
      if (json && kind === "ok") { try { data = JSON.parse(text); } catch { data = null; } }
      if (json && kind !== "ok") { try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; } }
    } catch (err) {
      kind = err?.name === "TimeoutError" ? "timeout" : "network";
    } finally {
      inFlight -= 1;
    }
    samples.push({ t: Date.now(), phase: phaseName, route, ms: performance.now() - t0, status, kind });
    return { status, kind, data };
  };
}

/* ---------------- one simulated person ---------------- */

const rand = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Person {
  constructor(i, account, ctx) {
    this.i = i;
    this.acc = account;
    this.ctx = ctx;
    this.screen = null;
    this.gen = 0;
    this.bundles = 0;
    this.checkedAt = 0; // the post checks: each post is trusted for 10 min, forgotten on a relaunch
    this.since = new Date(Date.now() - 3600_000).toISOString();
  }

  get(route, path) { return this.ctx.hit(this.acc.token, route, path); }

  peers() { return this.acc.peers.slice(0, T_TARGET); }
  groups() { return this.acc.groups.slice(0, G_TARGET); }

  /** The 30 s refresh (iOS backgroundPoll): one after another, every chat and every group in full. */
  async bundle() {
    if (this.bundles >= 3) return; // the app has no guard; the test caps at 3 overlapping so it can't run away
    this.bundles += 1;
    try {
      await this.get("GET /social/notifications", `/api/social/notifications?since=${encodeURIComponent(this.since)}`);
      await this.get("GET /social/connections", "/api/social/connections");
      await this.get("GET /social/messages", "/api/social/messages");
      for (const p of this.peers()) await this.get("GET /social/messages/:peer", `/api/social/messages/${p}`);
      const feed = await this.ctx.hit(this.acc.token, "GET /social/feed", "/api/social/feed?limit=60", { json: true });
      await this.get("GET /community/groups", "/api/community/groups");
      for (const g of this.groups()) await this.get("GET /community/groups/:id/messages", `/api/community/groups/${g}/messages`);
      // Once the feed is full, the iOS app checks up to 12 posts that left the newest 60, in parallel, each at most
      // every 10 minutes (and again after a relaunch).
      if (Array.isArray(feed.data) && feed.data.length >= 60 && Date.now() - this.checkedAt > 600_000) {
        this.checkedAt = Date.now();
        await Promise.all(feed.data.slice(-12).map((p) => this.get("GET /social/feed/:id", `/api/social/feed/${p.id}`)));
      }
    } finally {
      this.bundles -= 1;
    }
  }

  /** Opening the app from cold: the bootstrap, Home and the refresh, much of it at once. */
  async launch() {
    this.checkedAt = 0;
    await Promise.all([
      this.get("GET /auth/me", "/api/auth/me"),
      this.get("GET /status", "/api/status"),
      this.get("GET /app/content", "/api/app/content"),
    ]);
    await Promise.all([
      this.get("GET /social/me", "/api/social/me"),
      this.get("GET /social/points/me", "/api/social/points/me"),
      this.get("GET /social/feed", "/api/social/feed?limit=60"),
      this.get("GET /social/connections", "/api/social/connections"),
      this.get("GET /social/sessions/registrations", "/api/social/sessions/registrations"),
      this.get("GET /community/discussions", "/api/community/discussions"),
      this.get("GET /community/groups", "/api/community/groups"),
      this.get("GET /social/contact-card", "/api/social/contact-card"),
      this.get("GET /social/media/config", "/api/social/media/config"),
      this.bundle(),
    ]);
    await Promise.all([
      this.get("GET /social/activity/unread", "/api/social/activity/unread"),
      this.get("GET /social/feed", "/api/social/feed?limit=60"),
      this.get("GET /social/attendees", "/api/social/attendees"),
      this.get("GET /app/organisations", "/api/app/organisations"),
    ]);
  }

  /** Coming back to the app: status, content, points and the refresh. */
  async resume() {
    await Promise.all([
      this.get("GET /status", "/api/status"),
      this.get("GET /app/content", "/api/app/content"),
      this.get("GET /social/points/me", "/api/social/points/me"),
    ]);
    await this.bundle();
  }

  /** Runs `fn` every `ms` (first one at a random point in the first period) until the screen changes. */
  every(ms, fn) {
    const gen = this.gen;
    const loop = async () => {
      await sleep(rand(0, ms));
      while (this.gen === gen && !this.ctx.stopped) {
        fn().catch(() => {});
        await sleep(ms);
      }
    };
    loop();
  }

  setScreen(screen) {
    this.gen += 1;
    this.screen = screen;
    if (!screen) return; // in the background: iOS sends next to nothing
    this.every(30_000, () => this.bundle());
    if (screen === "home") {
      this.every(60_000, () => this.get("GET /social/points/me", "/api/social/points/me"));
      this.every(120_000, () => this.get("GET /app/organisations", "/api/app/organisations"));
      this.every(120_000, () => this.get("GET /social/activity/unread", "/api/social/activity/unread"));
    } else if (screen === "dm") {
      const peer = this.peers()[this.i % Math.max(1, this.peers().length)];
      if (peer) this.every(5_000, () => this.get("GET /social/messages/:peer", `/api/social/messages/${peer}`));
    } else if (screen === "group") {
      const g = this.groups()[this.i % Math.max(1, this.groups().length)];
      const id = g || this.ctx.anyGroup || "000000000000000000000000";
      if (g) this.every(6_000, () => this.get("GET /community/groups/:id/messages", `/api/community/groups/${g}/messages`));
      this.every(2_500, () => this.get("GET /community/typing", `/api/community/typing?scope=group&id=${id}`));
    } else if (screen === "live") {
      const s = encodeURIComponent(this.ctx.session);
      const p = encodeURIComponent(this.ctx.poll);
      this.every(6_000, async () => {
        await Promise.all([
          this.get("GET /social/sessions/:id/questions", `/api/social/sessions/${s}/questions`),
          this.get("GET /social/sessions/:id/polls/:pid/results", `/api/social/sessions/${s}/polls/${p}/results`),
        ]);
      });
      this.every(30_000, async () => {
        await Promise.all([this.get("GET /status", "/api/status"), this.get("GET /app/content", "/api/app/content")]);
      });
    }
  }
}

/* ---------------- setup ---------------- */

async function signIn(hit, spec) {
  const m = /^([^:]+):(.+)$/.exec(spec);
  if (!m) throw new Error(`--ticket wants <ticketId>:<LastName>, got "${spec}"`);
  const r = await hit("", "POST /auth/ticket-login", "/api/auth/ticket-login", { method: "POST", body: { ticketId: m[1], lastName: m[2] }, json: true });
  if (r.kind !== "ok" || !r.data?.token) throw new Error(`Ticket sign-in failed for ${m[1]} (${r.status}): ${r.data?.error || r.kind}`);
  return r.data.token;
}

async function discover(hit, token) {
  const me = await hit(token, "GET /social/me", "/api/social/me", { json: true });
  if (me.status === 401 || me.status === 403) throw new Error(`A token was refused (${me.status}): sign in again.`);
  if (me.kind !== "ok") throw new Error(`The server didn't answer /api/social/me (${me.status || me.kind}).`);
  const myId = String(me.data?.id || me.data?._id || "");
  const [threads, groups, people] = await Promise.all([
    hit(token, "GET /social/messages", "/api/social/messages", { json: true }),
    hit(token, "GET /community/groups", "/api/community/groups", { json: true }),
    hit(token, "GET /social/attendees", "/api/social/attendees", { json: true }),
  ]);
  const peers = (Array.isArray(threads.data) ? threads.data : []).map((t) => String(t.user?.id || "")).filter(Boolean);
  const realChats = peers.length;
  // Too few chats: read (empty) chats with people from the directory; the query is the same.
  for (const p of Array.isArray(people.data) ? people.data : []) {
    if (peers.length >= T_TARGET) break;
    const id = String(p.id || "");
    if (p.onApp && /^[0-9a-f]{24}$/.test(id) && id !== myId && !peers.includes(id)) peers.push(id);
  }
  const list = Array.isArray(groups.data) ? groups.data : [];
  return {
    token,
    name: me.data?.name || "test account",
    peers,
    realChats,
    groups: list.filter((g) => g.joined).map((g) => String(g.id)),
    anyGroup: list[0] ? String(list[0].id) : "",
  };
}

/* ---------------- the estimate printed with the plan ---------------- */

function perMinute(screen, T, G) {
  const bundle = 2 * (5 + T + G);
  return bundle + ({ home: 2, dm: 12, group: (G ? 10 : 0) + 24, live: 24 }[screen] || 0);
}

function describe(plan, users, scale, T, G) {
  const lines = [];
  let total = 0;
  for (const ph of plan) {
    const n = Math.round(users * ph.share);
    const secs = Math.round(ph.seconds * scale);
    total += secs;
    const rpm = Object.entries(ph.mix).reduce((s, [scr, f]) => s + n * f * perMinute(scr, T, G), 0);
    const mix = Object.entries(ph.mix).map(([k, f]) => `${Math.round(f * 100)}% ${k}`).join(", ");
    const start = ph.start ? `, ${n} ${ph.start === "launch" ? "launch the app" : "come back to it"} within ${ph.within} s` : "";
    lines.push(`  ${ph.name.padEnd(13)} ${String(secs).padStart(4)} s  ${String(n).padStart(4)} people (${mix})${start}  ≈ ${Math.round(rpm / 60)} req/s`);
  }
  lines.push(`  total ${Math.round(total / 60)} min`);
  return lines.join("\n");
}

/* ---------------- report ---------------- */

function summarize(rows) {
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  const kinds = {};
  for (const r of rows) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
  const bad = rows.filter((r) => BAD.has(r.kind)).length;
  return { requests: rows.length, p50: pct(ms, 50), p95: pct(ms, 95), p99: pct(ms, 99), max: ms.at(-1) || 0, kinds, badRate: rows.length ? bad / rows.length : 0 };
}

const fmtMs = (x) => (x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`);
const fmtKinds = (k) => Object.entries(k).filter(([n]) => n !== "ok").map(([n, c]) => `${c} ${n}`).join(", ") || "none";

function report(phaseTimes, setup, args) {
  const out = { target: args.target, users: args.users, plan: args.plan, startedAt: phaseTimes[0]?.start, setup, phases: [], routes: [] };
  console.log("\n================ REPORT ================");
  console.log(`${"phase".padEnd(14)}${"req".padStart(7)}${"req/s".padStart(8)}${"p50".padStart(9)}${"p95".padStart(9)}${"p99".padStart(9)}${"max".padStart(9)}  failed`);
  for (const ph of phaseTimes) {
    const rows = samples.filter((s) => s.phase === ph.name);
    if (!rows.length) continue;
    const s = summarize(rows);
    const secs = Math.max(1, ((ph.end || Date.now()) - ph.start) / 1000);
    out.phases.push({ name: ph.name, seconds: Math.round(secs), rps: +(s.requests / secs).toFixed(1), ...s });
    console.log(`${ph.name.padEnd(14)}${String(s.requests).padStart(7)}${(s.requests / secs).toFixed(1).padStart(8)}${fmtMs(s.p50).padStart(9)}${fmtMs(s.p95).padStart(9)}${fmtMs(s.p99).padStart(9)}${fmtMs(s.max).padStart(9)}  ${(s.badRate * 100).toFixed(1)}% (${fmtKinds(s.kinds)})`);
  }
  const byRoute = new Map();
  for (const r of samples) { if (r.phase === "setup") continue; if (!byRoute.has(r.route)) byRoute.set(r.route, []); byRoute.get(r.route).push(r); }
  const routes = [...byRoute.entries()].map(([route, rows]) => ({ route, ...summarize(rows) })).sort((a, b) => b.p95 - a.p95);
  out.routes = routes;
  console.log(`\n${"slowest routes (by p95)".padEnd(46)}${"req".padStart(7)}${"p50".padStart(9)}${"p95".padStart(9)}${"max".padStart(9)}  not ok`);
  for (const r of routes.slice(0, 12)) {
    console.log(`${r.route.padEnd(46)}${String(r.requests).padStart(7)}${fmtMs(r.p50).padStart(9)}${fmtMs(r.p95).padStart(9)}${fmtMs(r.max).padStart(9)}  ${fmtKinds(r.kinds)}`);
  }
  const all = summarize(samples.filter((s) => s.phase !== "setup"));
  const verdict = all.badRate > 0.05 || all.p95 > 3000 ? "NOT READY: people would see errors or long waits."
    : all.badRate > 0.01 || all.p95 > 1500 ? "BORDERLINE: it works but feels slow at peaks. Upgrade the server or database and run it again."
      : "GOOD: quick and error-free at this load.";
  out.overall = all;
  out.verdict = verdict;
  console.log(`\nOverall: ${all.requests} requests, p95 ${fmtMs(all.p95)}, ${(all.badRate * 100).toFixed(1)}% failed (${fmtKinds(all.kinds)})`);
  console.log(`Verdict: ${verdict}`);
  console.log("  (good: p95 under 1.5 s and under 1% failed; \"edge\" = Render's Cloudflare refused it, not the app)");
  return out;
}

/* ---------------- main ---------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }
  if (!args.target) throw new Error("--target is required (see --help)");
  const url = new URL(args.target);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Use https (or localhost).");
  const plan = PLANS[args.plan];
  if (!plan) throw new Error(`--plan is full or smoke, not "${args.plan}"`);
  if (!(args.scale > 0)) throw new Error("--scale must be above 0");
  if (!args.tickets.length && !args.tokens.length) throw new Error("Give --ticket <ticketId>:<LastName> or --token (see --help)");

  console.log(`Target ${url.origin} · ${args.users} people · plan ${args.plan}${args.scale !== 1 ? ` ×${args.scale}` : ""}`);
  if (!args.go) {
    console.log(`\nPlan (estimated with ${T_TARGET} chats and ${G_TARGET} groups a person):\n${describe(plan, args.users, args.scale, T_TARGET, G_TARGET)}`);
    console.log("\nNothing was sent. Add --go to run it.");
    return;
  }

  const ctx = { hit: makeClient(url.origin), stopped: false, session: args.session, poll: args.poll, anyGroup: "" };
  const tokens = [...args.tokens];
  for (const t of args.tickets) tokens.push(await signIn(ctx.hit, t));
  const accounts = [];
  for (const t of tokens) accounts.push(await discover(ctx.hit, t));
  ctx.anyGroup = accounts.find((a) => a.anyGroup)?.anyGroup || "";
  const T = Math.min(T_TARGET, Math.min(...accounts.map((a) => a.peers.length)));
  const G = Math.min(G_TARGET, Math.min(...accounts.map((a) => a.groups.length)));
  const setup = accounts.map((a) => ({ name: a.name, chats: a.realChats, peersUsed: a.peers.length, groups: a.groups.length }));
  for (const a of setup) console.log(`Account "${a.name}": ${a.chats} chats (reading ${a.peersUsed}), ${a.groups} joined groups`);
  if (!G) console.log("  No joined groups: the refresh and the group-chat screen read no group messages, so the load is lower than on the day.");
  console.log(`\nPlan (with ${T} chats and ${G} groups a person):\n${describe(plan, args.users, args.scale, T, G)}\n`);

  const people = Array.from({ length: args.users }, (_, i) => new Person(i, accounts[i % accounts.length], ctx));
  const phaseTimes = [];
  let aborted = "";

  const stopAll = (why) => {
    if (ctx.stopped) return;
    aborted = why;
    ctx.stopped = true;
    for (const p of people) p.setScreen(null);
  };
  process.once("SIGINT", () => stopAll("stopped with Ctrl-C"));

  // Progress every 10 s; the safety stop looks at the last 30 s.
  const tick = setInterval(() => {
    const now = Date.now();
    const last10 = samples.filter((s) => s.t > now - 10_000);
    const last30 = samples.filter((s) => s.t > now - 30_000);
    const s10 = summarize(last10);
    const s30 = summarize(last30);
    console.log(`[${new Date().toLocaleTimeString()}] ${phaseName.padEnd(12)} ${(last10.length / 10).toFixed(1).padStart(6)} req/s  p95 ${fmtMs(s10.p95).padStart(7)}  failed ${(s10.badRate * 100).toFixed(1).padStart(5)}%  in flight ${inFlight}`);
    if (last30.length >= 50 && s30.badRate > 0.25) stopAll(`over 25% of requests failed in the last 30 s (${fmtKinds(s30.kinds)})`);
    else if (last30.length >= 50 && s30.p95 > 15_000) stopAll("the slowest 5% took over 15 s in the last 30 s");
    if (last30.some((s) => s.status === 401)) stopAll("a token stopped working (401)");
  }, 10_000);

  const t0 = Date.now();
  for (const ph of plan) {
    if (ctx.stopped) break;
    phaseName = ph.name;
    const rec = { name: ph.name, start: Date.now(), end: 0 };
    phaseTimes.push(rec);
    const n = Math.round(args.users * ph.share);
    const screens = [];
    for (const [screen, f] of Object.entries(ph.mix)) for (let k = 0; k < Math.round(n * f); k++) screens.push(screen);
    while (screens.length < n) screens.push("home");
    people.forEach((p, i) => {
      if (i >= n) { p.setScreen(null); return; }
      p.setScreen(screens[i]);
      if (ph.start) setTimeout(() => { if (!ctx.stopped) (ph.start === "launch" ? p.launch() : p.resume()).catch(() => {}); }, rand(0, ph.within * 1000));
    });
    const until = Date.now() + ph.seconds * args.scale * 1000;
    while (Date.now() < until && !ctx.stopped) await sleep(250);
    rec.end = Date.now();
  }
  stopAll(aborted);
  clearInterval(tick);
  // Let requests already sent finish (at most the timeout).
  for (let w = 0; inFlight > 0 && w < TIMEOUT_MS / 250; w++) await sleep(250);
  if (aborted) console.log(`\nSTOPPED EARLY: ${aborted}`);
  console.log(`Ran ${Math.round((Date.now() - t0) / 1000)} s.`);
  const out = report(phaseTimes, setup, args);
  out.stoppedEarly = aborted || null;
  const file = args.out || `loadtest-report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`Report saved to ${file}`);
}

main().catch((err) => { console.error(`\n${err.message}`); process.exitCode = 1; });
