import { test } from "node:test";
import assert from "node:assert/strict";
import { eventPlatform, EVENT_PLATFORMS, cleanEvent, cleanContent, CONTENT_KEYS } from "../services/adminHelpers.js";
import {
  PWA_EVENTS, PWA_OS, MAX_PEOPLE, clampDays, normOs, torontoDay, torontoMidnight, shiftDay, pwaWindow,
  pwaMatch, pwaPipelines, tiesPipeline, TIES_OPTIONS, installLaunchDeviceIds, rollupPwa, withNames, loadPwaStats, makePwaStatsCache,
} from "../services/pwaStats.js";

/* ---------- POST /api/app/events platform ---------- */

test("eventPlatform takes ios / android / web and falls back to ios", () => {
  assert.deepEqual([...EVENT_PLATFORMS], ["ios", "android", "web"]);
  assert.equal(eventPlatform({ platform: "web" }), "web");
  assert.equal(eventPlatform({ platform: "android" }), "android");
  assert.equal(eventPlatform({ platform: "ios" }), "ios");
  assert.equal(eventPlatform({ platform: " Web " }), "web");
  assert.equal(eventPlatform({ platform: "windows" }), "ios");
  assert.equal(eventPlatform({ platform: { $ne: 1 } }), "ios");
  assert.equal(eventPlatform({}), "ios");
  assert.equal(eventPlatform(undefined), "ios");
  assert.equal(eventPlatform({ appVersion: "1.0 (12)" }), "ios");   // iOS Analytics.swift
});

test("eventPlatform: Android builds that only say so in appVersion land as android", () => {
  // Android Analytics.kt: "${VERSION_NAME} (${VERSION_CODE}) android", no platform field.
  assert.equal(eventPlatform({ appVersion: "1.0.1 (3) android" }), "android");
  assert.equal(eventPlatform({ appVersion: "1.10.0 (120) Android" }), "android");
  assert.equal(eventPlatform({ appVersion: "androidish" }), "ios");
  // An explicit platform wins.
  assert.equal(eventPlatform({ platform: "web", appVersion: "1.0.1 (3) android" }), "web");
});

test("cleanEvent keeps the PWA props the console reads", () => {
  const now = Date.parse("2026-10-18T12:00:00Z");
  const e = cleanEvent({ name: "pwa_install_click", props: { os: "android", browser: "chrome", displayMode: "browser", outcome: "accepted" },
                         at: "2026-10-18T11:00:00Z" }, now);
  assert.deepEqual(e.props, { os: "android", browser: "chrome", displayMode: "browser", outcome: "accepted" });
  for (const name of PWA_EVENTS) assert.equal(cleanEvent({ name, at: now }, now)?.name, name);
});

test("flag.pwaPrompt: the website's install prompt switch, off until staff turn it on", () => {
  assert.equal(CONTENT_KEYS["flag.pwaPrompt"], false);
  assert.deepEqual(cleanContent("flag.pwaPrompt", true), ["flag.pwaPrompt", true]);
  assert.deepEqual(cleanContent("flag.pwaPrompt", "true"), ["flag.pwaPrompt", true]);
  assert.deepEqual(cleanContent("flag.pwaPrompt", "yes"), ["flag.pwaPrompt", false]);
});

/* ---------- window + Toronto days ---------- */

test("clampDays: 1…120, default 30", () => {
  assert.equal(clampDays(undefined), 30);
  assert.equal(clampDays(""), 30);
  assert.equal(clampDays("abc"), 30);
  assert.equal(clampDays("7"), 7);
  assert.equal(clampDays("7.9"), 7);
  assert.equal(clampDays("0"), 1);
  assert.equal(clampDays("-5"), 1);
  assert.equal(clampDays("500"), 120);
});

test("normOs keeps the four buckets", () => {
  assert.equal(normOs("iOS"), "ios");
  assert.equal(normOs("desktop"), "desktop");
  assert.equal(normOs("windows"), "other");
  assert.equal(normOs(undefined), "other");
  assert.deepEqual([...PWA_OS], ["ios", "android", "desktop", "other"]);
});

test("Toronto days and midnights, across the November DST change", () => {
  assert.equal(torontoDay(Date.parse("2026-10-18T03:59:00Z")), "2026-10-17");
  assert.equal(torontoDay(Date.parse("2026-10-18T04:00:00Z")), "2026-10-18");
  assert.equal(torontoMidnight("2026-10-18").toISOString(), "2026-10-18T04:00:00.000Z");   // EDT
  assert.equal(torontoMidnight("2026-11-01").toISOString(), "2026-11-01T04:00:00.000Z");   // DST ends at 2 am
  assert.equal(torontoMidnight("2026-11-02").toISOString(), "2026-11-02T05:00:00.000Z");   // EST
  assert.equal(torontoMidnight("2026-03-08").toISOString(), "2026-03-08T05:00:00.000Z");   // DST starts at 2 am
  assert.equal(shiftDay("2026-10-31", 1), "2026-11-01");
  assert.equal(shiftDay("2026-03-01", -1), "2026-02-28");
});

test("pwaWindow: `days` Toronto days ending today", () => {
  const now = new Date("2026-11-02T03:00:00Z");   // Nov 1, 10 pm in Toronto
  const w = pwaWindow(3, now);
  assert.deepEqual(w.dayKeys, ["2026-10-30", "2026-10-31", "2026-11-01"]);
  assert.equal(w.since.toISOString(), "2026-10-30T04:00:00.000Z");
  assert.equal(pwaWindow(1, now).dayKeys.length, 1);
  assert.equal(pwaWindow(120, now).dayKeys.length, 120);
});

/* ---------- pipelines ---------- */

test("pipelines match web pwa_* events from the window (index platform, name, at)", () => {
  const since = new Date("2026-10-01T04:00:00Z");
  assert.deepEqual(pwaMatch(since, ["pwa_launch"]), { platform: "web", name: { $in: ["pwa_launch"] }, at: { $gte: since } });
  const p = pwaPipelines(since);
  const cm = p.counts[0].$match, dm = p.devices[0].$match;
  assert.equal(cm.platform, "web");
  assert.equal(dm.platform, "web");
  assert.deepEqual(Object.keys(cm), ["platform", "name", "at"]);
  assert.ok(cm.name.$in.every((n) => PWA_EVENTS.includes(n)));
  assert.deepEqual(dm.name.$in, ["pwa_installed", "pwa_launch", "pwa_signed_in"]);
  assert.equal(cm.at.$gte, since);
  assert.equal(p.counts[1].$group._id.day.$dateToString.timezone, "America/Toronto");
  assert.deepEqual(p.devices[1].$group._id, { d: "$deviceId", u: "$userId" });
  assert.deepEqual(tiesPipeline(["a", "b"])[0], { $match: { deviceId: { $in: ["a", "b"] }, userId: { $ne: null } } });
  assert.deepEqual(TIES_OPTIONS, { hint: { deviceId: 1 } });   // never the userId index
});

/* ---------- rollup ---------- */

const D = (s) => new Date(s);
const U1 = "64a000000000000000000001", U2 = "64a000000000000000000002", U3 = "64a000000000000000000003", U4 = "64a000000000000000000004";
const dayKeys = ["2026-10-16", "2026-10-17", "2026-10-18"];

const counts = [
  { _id: { name: "pwa_prompt_shown", day: "2026-10-16", accepted: false }, n: 4 },
  { _id: { name: "pwa_prompt_shown", day: "2026-10-18", accepted: false }, n: 1 },
  { _id: { name: "pwa_guide_open", day: "2026-10-17", accepted: false }, n: 2 },
  { _id: { name: "pwa_install_click", day: "2026-10-16", accepted: true }, n: 2 },
  { _id: { name: "pwa_install_click", day: "2026-10-16", accepted: false }, n: 3 },   // dismissed
  { _id: { name: "pwa_launch", day: "2026-10-16", accepted: false }, n: 1 },
  { _id: { name: "pwa_launch", day: "2026-10-17", accepted: false }, n: 4 },
  { _id: { name: "pwa_launch", day: "2026-10-18", accepted: false }, n: 3 },
];
const devices = [
  // A: Android, installed signed out on the 16th, launched signed out on the 16th and 17th, then once as U1.
  { _id: { d: "A", u: null }, installedAt: D("2026-10-16T15:00:00Z"), installDays: ["2026-10-16", null], launches: 2,
    lastLaunchAt: D("2026-10-17T15:00:00Z"), last: { at: D("2026-10-17T15:00:00Z"), os: "android" } },
  { _id: { d: "A", u: U1 }, installedAt: null, installDays: [null], launches: 1,
    lastLaunchAt: D("2026-10-18T15:00:00Z"), last: { at: D("2026-10-18T15:05:00Z"), os: "android" } },
  // B: desktop, installed signed out on the 16th; its person only shows up on another event (ties).
  { _id: { d: "B", u: null }, installedAt: D("2026-10-16T18:00:00Z"), installDays: ["2026-10-16"], launches: 1,
    lastLaunchAt: D("2026-10-17T18:00:00Z"), last: { at: D("2026-10-17T18:00:00Z"), os: "desktop" } },
  // C: an iPhone (no install event on iOS), launched twice, never signed in.
  { _id: { d: "C", u: null }, installedAt: null, installDays: [null], launches: 2,
    lastLaunchAt: D("2026-10-18T12:00:00Z"), last: { at: D("2026-10-18T12:00:00Z"), os: "ios" } },
  // E: U3 signed in in a browser tab that never installed or launched the app.
  { _id: { d: "E", u: U3 }, installedAt: null, installDays: [null], launches: 0, lastLaunchAt: null,
    last: { at: D("2026-10-18T09:00:00Z"), os: "ios" } },
  // No deviceId: one launch by U4, one anonymous launch from an unknown browser.
  { _id: { d: "", u: U4 }, installedAt: null, installDays: [null], launches: 1, lastLaunchAt: D("2026-10-17T10:00:00Z"),
    last: { at: D("2026-10-17T10:00:00Z"), os: "android" } },
  { _id: { d: "", u: null }, installedAt: null, installDays: [null], launches: 1, lastLaunchAt: D("2026-10-17T11:00:00Z"),
    last: { at: D("2026-10-17T11:00:00Z"), os: "weird" } },
];
const ties = [{ _id: { d: "A", u: U1 } }, { _id: { d: "B", u: U2 } }];

test("installLaunchDeviceIds: devices with an install or a launch, never the blank one", () => {
  assert.deepEqual(installLaunchDeviceIds(devices).sort(), ["A", "B", "C"]);
  assert.deepEqual(installLaunchDeviceIds([]), []);
});

test("rollupPwa: totals, platforms, days, people and anonymous devices", () => {
  const r = rollupPwa({ counts, devices, ties, dayKeys });
  assert.deepEqual(Object.keys(r), ["totals", "byPlatform", "byDay", "people", "anonymousDevices"]);
  assert.deepEqual(r.totals, {
    promptsShown: 5, guideOpens: 2, installClicks: 2,
    installs: 2,          // A and B fired pwa_installed
    launches: 8,          // every pwa_launch event
    installDevices: 3,    // A, B and the iPhone C (launched)
    launchDevices: 3,
    signedInPeople: 4,    // U1 (on A), U2 (tied to B), U3 (signed in), U4 (launch, no device)
  });
  assert.deepEqual(r.byPlatform, [
    { os: "ios", installs: 0, launches: 2 },
    { os: "android", installs: 1, launches: 4 },
    { os: "desktop", installs: 1, launches: 1 },
    { os: "other", installs: 0, launches: 1 },
  ]);
  assert.equal(r.byPlatform.reduce((n, x) => n + x.launches, 0), r.totals.launches);
  assert.deepEqual(r.byDay, [
    { day: "2026-10-16", prompts: 4, installs: 2, launches: 1 },
    { day: "2026-10-17", prompts: 0, installs: 0, launches: 4 },
    { day: "2026-10-18", prompts: 1, installs: 0, launches: 3 },
  ]);
  assert.equal(r.anonymousDevices, 1);   // C
  // Newest launch first; people who never launched last.
  assert.deepEqual(r.people.map((p) => p.userId), [U1, U2, U4, U3]);
  const [p1, p2, p4, p3] = r.people;
  // U1 gets all of device A, including the launches from before signing in.
  assert.deepEqual(p1, { userId: U1, os: "android", firstInstallAt: D("2026-10-16T15:00:00Z"),
                         lastLaunchAt: D("2026-10-18T15:00:00Z"), launches: 3 });
  assert.deepEqual(p2, { userId: U2, os: "desktop", firstInstallAt: D("2026-10-16T18:00:00Z"),
                         lastLaunchAt: D("2026-10-17T18:00:00Z"), launches: 1 });
  assert.deepEqual(p4, { userId: U4, os: "android", firstInstallAt: null, lastLaunchAt: D("2026-10-17T10:00:00Z"), launches: 1 });
  assert.deepEqual(p3, { userId: U3, os: "ios", firstInstallAt: null, lastLaunchAt: null, launches: 0 });
});

test("rollupPwa: a shared device counts for everyone who signed in on it; ties alone are enough", () => {
  const r = rollupPwa({ devices: devices.slice(0, 3), ties: [...ties, { _id: { d: "A", u: U3 } }], dayKeys });
  assert.deepEqual(r.people.map((p) => [p.userId, p.launches]), [[U1, 3], [U3, 3], [U2, 1]]);
  assert.equal(r.anonymousDevices, 0);
  // Ties to devices outside the window's installs/launches are ignored.
  const none = rollupPwa({ devices: [], ties: [{ _id: { d: "Z", u: U1 } }], dayKeys });
  assert.equal(none.totals.signedInPeople, 0);
  assert.deepEqual(none.people, []);
});

test("rollupPwa: empty input, and days outside the window are dropped", () => {
  const r = rollupPwa({ dayKeys });
  assert.deepEqual(r.totals, { promptsShown: 0, guideOpens: 0, installClicks: 0, installs: 0, launches: 0,
                               installDevices: 0, launchDevices: 0, signedInPeople: 0 });
  assert.equal(r.byDay.length, 3);
  assert.equal(r.byPlatform.length, 4);
  assert.equal(r.anonymousDevices, 0);
  const late = rollupPwa({ counts: [{ _id: { name: "pwa_launch", day: "2026-09-01" }, n: 5 }], dayKeys });
  assert.equal(late.totals.launches, 5);
  assert.ok(late.byDay.every((d) => d.launches === 0));
});

test("rollupPwa: at most 1000 people, but signedInPeople counts them all", () => {
  const rows = Array.from({ length: MAX_PEOPLE + 5 }, (_, i) => ({
    _id: { d: "", u: `u${String(i).padStart(5, "0")}` }, launches: 1,
    lastLaunchAt: new Date(Date.parse("2026-10-18T00:00:00Z") + i * 1000), last: { at: new Date(0), os: "ios" },
  }));
  const r = rollupPwa({ devices: rows, dayKeys });
  assert.equal(r.totals.signedInPeople, MAX_PEOPLE + 5);
  assert.equal(r.people.length, MAX_PEOPLE);
  assert.equal(r.people[0].userId, `u${String(MAX_PEOPLE + 4).padStart(5, "0")}`);   // newest launch first
});

test("withNames adds name + email, Deleted user when the account is gone", () => {
  const out = withNames([{ userId: U1, os: "ios", firstInstallAt: null, lastLaunchAt: null, launches: 0 },
                         { userId: U2, os: "android", firstInstallAt: undefined, lastLaunchAt: null, launches: 2 }],
                        [{ _id: { toString: () => U1 }, name: "Ada Lovelace", email: "ada@example.com" }]);
  assert.deepEqual(out, [
    { userId: U1, name: "Ada Lovelace", email: "ada@example.com", os: "ios", firstInstallAt: null, lastLaunchAt: null, launches: 0 },
    { userId: U2, name: "Deleted user", email: "", os: "android", firstInstallAt: null, lastLaunchAt: null, launches: 2 },
  ]);
});

/* ---------- loader with stubbed models ---------- */

function stubModels({ users = [] } = {}) {
  const calls = { aggregate: [], find: [] };
  const AppEvent = {
    async aggregate(pipeline, options) {
      calls.aggregate.push(pipeline);
      calls.options = [...(calls.options || []), options];
      const m = pipeline[0].$match;
      if (m.deviceId) return ties;
      if (m.name.$in.includes("pwa_signed_in")) return devices;
      return counts;
    },
  };
  const User = {
    find(q) {
      calls.find.push(q);
      return { select(f) { calls.select = f; return { lean: async () => users }; } };
    },
  };
  return { AppEvent, User, calls };
}

test("loadPwaStats runs three aggregations and one User lookup, and returns the exact shape", async () => {
  const { AppEvent, User, calls } = stubModels({ users: [{ _id: U1, name: "Ada", email: "ada@example.com" }] });
  const r = await loadPwaStats({ AppEvent, User }, { days: 3, now: new Date("2026-10-18T16:00:00Z") });
  assert.equal(calls.aggregate.length, 3);
  assert.equal(calls.aggregate[0][0].$match.at.$gte.toISOString(), "2026-10-16T04:00:00.000Z");
  assert.deepEqual(calls.aggregate[2][0].$match.deviceId.$in.sort(), ["A", "B", "C"]);
  assert.deepEqual(calls.options, [undefined, undefined, { hint: { deviceId: 1 } }]);
  assert.deepEqual(calls.find[0]._id.$in, [U1, U2, U4, U3]);
  assert.equal(calls.select, "name email");
  assert.deepEqual(Object.keys(r), ["totals", "byPlatform", "byDay", "people", "anonymousDevices"]);
  assert.deepEqual(r.byDay.map((d) => d.day), dayKeys);
  assert.deepEqual(Object.keys(r.people[0]), ["userId", "name", "email", "os", "firstInstallAt", "lastLaunchAt", "launches"]);
  assert.equal(r.people[0].name, "Ada");
  assert.equal(r.people[1].name, "Deleted user");
});

test("loadPwaStats runs the device ties unhinted if the hint is refused", async () => {
  const opts = [];
  const AppEvent = {
    async aggregate(pipeline, options) {
      const m = pipeline[0].$match;
      if (m.deviceId) { opts.push(options); if (options?.hint) throw new Error("bad hint"); return ties; }
      return m.name.$in.includes("pwa_signed_in") ? devices : counts;
    },
  };
  const User = { find: () => ({ select: () => ({ lean: async () => [] }) }) };
  const r = await loadPwaStats({ AppEvent, User }, { days: 3, now: new Date("2026-10-18T16:00:00Z") });
  assert.deepEqual(opts, [{ hint: { deviceId: 1 } }, undefined]);
  assert.equal(r.totals.signedInPeople, 4);
});

test("loadPwaStats skips the ties and User lookups when nothing was installed", async () => {
  const calls = [];
  const AppEvent = { async aggregate(p) { calls.push(p); return []; } };
  const User = { find() { throw new Error("must not look up users"); } };
  const r = await loadPwaStats({ AppEvent, User }, { days: 30 });
  assert.equal(calls.length, 2);
  assert.equal(r.byDay.length, 30);
  assert.deepEqual(r.people, []);
  assert.equal(r.totals.installs, 0);
});

test("makePwaStatsCache keeps a copy per days value, shares a run, refresh skips it", async () => {
  let runs = 0;
  const load = async (models, { days }) => { runs += 1; await new Promise((r) => setImmediate(r)); return { days, run: runs }; };
  const stats = makePwaStatsCache({ load, ttlMs: 60_000 });
  const [a, b] = await Promise.all([stats({}, { days: 30 }), stats({}, { days: "30" })]);
  assert.equal(runs, 1);
  assert.equal(a, b);
  assert.equal((await stats({}, { days: 30 })).run, 1);
  assert.equal((await stats({}, { days: 7 })).days, 7);
  assert.equal(runs, 2);
  assert.equal((await stats({}, { days: 30, refresh: true })).run, 3);
  const failing = makePwaStatsCache({ load: async () => { throw new Error("down"); } });
  await assert.rejects(failing({}, { days: 30 }), /down/);
  await assert.rejects(failing({}, { days: 30 }), /down/);   // errors aren't cached
});
