/* Web app (the website's installable PWA at /app/) installs and launches for
   GET /api/console/pwa. Built from AppEvent rows with platform "web" and the
   pwa_* names below; props carry os (ios | android | desktop | other),
   browser and displayMode, and pwa_install_click has outcome accepted |
   dismissed. Days are America/Toronto.

   Three small aggregations (the first two use the { platform, name, at }
   index, the third the deviceId index); everything else is pure and
   unit-tested. Models are passed in so tests can stub them. */

export const PWA_EVENTS = Object.freeze([
  "pwa_prompt_shown", "pwa_prompt_dismissed", "pwa_guide_open", "pwa_guide_step",
  "pwa_install_click", "pwa_installed", "pwa_launch", "pwa_signed_in",
]);
export const PWA_OS = Object.freeze(["ios", "android", "desktop", "other"]);
export const TZ = "America/Toronto";
export const MAX_PEOPLE = 1000;
const COUNT_EVENTS = ["pwa_prompt_shown", "pwa_guide_open", "pwa_install_click", "pwa_launch"];   // what totals/byDay count
const PERSON_EVENTS = ["pwa_installed", "pwa_launch", "pwa_signed_in"];

/** ?days= → 1…120, default 30. */
export function clampDays(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || v === "" || v == null) return 30;
  return Math.min(120, Math.max(1, n));
}

export const normOs = (v) => {
  const s = String(v ?? "").trim().toLowerCase();
  return PWA_OS.includes(s) ? s : "other";
};

/* ---------- Toronto days ---------- */

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});
function torontoParts(t) {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
const pad = (n) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" of an instant in Toronto. */
export function torontoDay(t) {
  const p = torontoParts(t);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** Toronto wall clock minus UTC, in ms (-4 h in summer, -5 h in winter). */
function offsetMs(t) {
  const p = torontoParts(t);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000;
}

/** The instant a Toronto day starts. */
export function torontoMidnight(day) {
  const [y, m, d] = day.split("-").map(Number);
  const utc = Date.UTC(y, m - 1, d);
  let t = utc - offsetMs(utc);
  t = utc - offsetMs(t);
  return new Date(t);
}

export function shiftDay(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The last `days` Toronto days, today included: { since, dayKeys }. */
export function pwaWindow(days, now = new Date()) {
  const today = torontoDay(now.getTime());
  const first = shiftDay(today, -(days - 1));
  const dayKeys = Array.from({ length: days }, (_, i) => shiftDay(first, i));
  return { since: torontoMidnight(first), dayKeys };
}

/* ---------- pipelines ---------- */

const DAY = { $dateToString: { format: "%Y-%m-%d", date: "$at", timezone: TZ } };
const is = (name) => ({ $eq: ["$name", name] });

export function pwaMatch(since, names = PWA_EVENTS) {
  return { platform: "web", name: { $in: [...names] }, at: { $gte: since } };
}

/** counts: one row per name × Toronto day (× accepted for install clicks).
    devices: one row per deviceId × userId over installs, launches and sign-ins. */
export function pwaPipelines(since) {
  return {
    counts: [
      { $match: pwaMatch(since, COUNT_EVENTS) },
      { $group: { _id: { name: "$name", day: DAY, accepted: { $eq: ["$props.outcome", "accepted"] } }, n: { $sum: 1 } } },
    ],
    devices: [
      { $match: pwaMatch(since, PERSON_EVENTS) },
      { $group: {
        _id: { d: "$deviceId", u: "$userId" },
        installedAt: { $min: { $cond: [is("pwa_installed"), "$at", null] } },
        installDays: { $addToSet: { $cond: [is("pwa_installed"), DAY, null] } },
        launches: { $sum: { $cond: [is("pwa_launch"), 1, 0] } },
        lastLaunchAt: { $max: { $cond: [is("pwa_launch"), "$at", null] } },
        last: { $max: { at: "$at", os: "$props.os" } },   // the newest event, with its os
      } },
    ],
  };
}

/** Everyone who used these devices signed in, on any event at any time.
    Run with TIES_OPTIONS: the deviceId index, never a scan of every signed-in event. */
export function tiesPipeline(deviceIds) {
  return [
    { $match: { deviceId: { $in: [...deviceIds] }, userId: { $ne: null } } },
    { $group: { _id: { d: "$deviceId", u: "$userId" } } },
  ];
}
export const TIES_OPTIONS = Object.freeze({ hint: { deviceId: 1 } });

const ms = (d) => (d ? new Date(d).getTime() : NaN);
const minDate = (a, b) => (!a ? b || null : !b ? a : ms(b) < ms(a) ? b : a);
const maxDate = (a, b) => (!a ? b || null : !b ? a : ms(b) > ms(a) ? b : a);
const newer = (a, b) => (!a?.at ? b || null : !b?.at ? a : ms(b.at) > ms(a.at) ? b : a);
const str = (v) => (v == null ? "" : String(v));

/** Devices with an install or a launch in the window (the ones to tie to people). */
export function installLaunchDeviceIds(deviceRows = []) {
  const ids = new Set();
  for (const r of deviceRows) {
    const d = str(r._id?.d);
    if (d && (r.installedAt || r.launches > 0)) ids.add(d);
  }
  return [...ids];
}

function blank() {
  return { installedAt: null, installDays: new Set(), launches: 0, lastLaunchAt: null, last: null };
}
function absorb(s, r) {
  s.installedAt = minDate(s.installedAt, r.installedAt);
  for (const day of r.installDays || []) if (day) s.installDays.add(day);
  s.launches += Number(r.launches) || 0;
  s.lastLaunchAt = maxDate(s.lastLaunchAt, r.lastLaunchAt);
  s.last = newer(s.last, r.last);
}

/** The whole response except names and emails (see withNames). */
export function rollupPwa({ counts = [], devices = [], ties = [], dayKeys = [] } = {}) {
  const totals = { promptsShown: 0, guideOpens: 0, installClicks: 0, installs: 0, launches: 0,
                   installDevices: 0, launchDevices: 0, signedInPeople: 0 };
  const days = new Map(dayKeys.map((day) => [day, { day, prompts: 0, installs: 0, launches: 0 }]));
  const platform = new Map(PWA_OS.map((os) => [os, { os, installs: 0, launches: 0 }]));

  for (const r of counts) {
    const name = r._id?.name, n = Number(r.n) || 0, row = days.get(r._id?.day);
    if (name === "pwa_prompt_shown") { totals.promptsShown += n; if (row) row.prompts += n; }
    else if (name === "pwa_guide_open") totals.guideOpens += n;
    else if (name === "pwa_install_click" && r._id?.accepted) totals.installClicks += n;
    else if (name === "pwa_launch") { totals.launches += n; if (row) row.launches += n; }
  }

  // Per device (rows without a deviceId are kept per person instead).
  const dev = new Map(), loose = new Map(), people = new Map();
  const person = (u) => {
    if (!people.has(u)) people.set(u, { devices: new Set(), stats: blank() });
    return people.get(u);
  };
  for (const r of devices) {
    const d = str(r._id?.d), u = str(r._id?.u);
    platform.get(normOs(r.last?.os)).launches += Number(r.launches) || 0;
    if (d) { if (!dev.has(d)) dev.set(d, blank()); absorb(dev.get(d), r); }
    else if (u) { if (!loose.has(u)) loose.set(u, blank()); absorb(loose.get(u), r); }
    if (u) person(u).stats.last = newer(person(u).stats.last, r.last);   // os of a sign-in-only person
  }
  const installed = new Map([...dev].filter(([, s]) => s.installedAt || s.launches > 0));

  // A device belongs to everyone seen signed in on it.
  const tied = new Set();
  const tie = (d, u) => { if (d && u && installed.has(d)) { person(u).devices.add(d); tied.add(d); } };
  for (const r of devices) tie(str(r._id?.d), str(r._id?.u));
  for (const r of ties) tie(str(r._id?.d), str(r._id?.u));

  for (const [, s] of installed) {
    totals.installDevices += 1;
    if (s.launches > 0) totals.launchDevices += 1;
    if (s.installedAt) { totals.installs += 1; platform.get(normOs(s.last?.os)).installs += 1; }
    for (const day of s.installDays) { const row = days.get(day); if (row) row.installs += 1; }
  }

  const rows = [];
  for (const [u, p] of people) {
    const s = p.stats;
    for (const d of p.devices) absorb(s, { ...installed.get(d), installDays: [] });
    if (loose.has(u)) absorb(s, { ...loose.get(u), installDays: [] });
    rows.push({ userId: u, os: normOs(s.last?.os), firstInstallAt: s.installedAt, lastLaunchAt: s.lastLaunchAt,
                launches: s.launches, _seen: ms(s.last?.at) || 0 });
  }
  const byNewest = (a, b) => (ms(b) || 0) - (ms(a) || 0);
  rows.sort((a, b) => byNewest(a.lastLaunchAt, b.lastLaunchAt) || byNewest(a.firstInstallAt, b.firstInstallAt)
                      || b._seen - a._seen || (a.userId < b.userId ? -1 : 1));
  totals.signedInPeople = rows.length;

  return {
    totals,
    byPlatform: [...platform.values()],
    byDay: [...days.values()],
    people: rows.slice(0, MAX_PEOPLE).map(({ _seen, ...r }) => r),
    anonymousDevices: [...installed.keys()].filter((d) => !tied.has(d)).length,
  };
}

/** Adds name + email from User rows ({ _id, name, email }). */
export function withNames(people, users = []) {
  const byId = new Map(users.map((x) => [String(x._id), x]));
  return people.map((p) => {
    const x = byId.get(p.userId);
    return { userId: p.userId, name: x?.name || "Deleted user", email: x?.email || "", os: p.os,
             firstInstallAt: p.firstInstallAt || null, lastLaunchAt: p.lastLaunchAt || null, launches: p.launches };
  });
}

/** Runs the aggregations. models = { AppEvent, User }. */
export async function loadPwaStats({ AppEvent, User }, { days = 30, now = new Date() } = {}) {
  const { since, dayKeys } = pwaWindow(clampDays(days), now);
  const p = pwaPipelines(since);
  const [counts, devices] = await Promise.all([AppEvent.aggregate(p.counts), AppEvent.aggregate(p.devices)]);
  const ids = installLaunchDeviceIds(devices);
  // Without the deviceId index (never expected) the hint fails: run it unhinted rather than fail the page.
  const ties = ids.length
    ? await AppEvent.aggregate(tiesPipeline(ids), { ...TIES_OPTIONS }).catch(() => AppEvent.aggregate(tiesPipeline(ids)))
    : [];
  const out = rollupPwa({ counts, devices, ties, dayKeys });
  const users = out.people.length
    ? await User.find({ _id: { $in: out.people.map((x) => x.userId) } }).select("name email").lean()
    : [];
  return { ...out, people: withNames(out.people, users) };
}

/** loadPwaStats kept for a minute per `days` (one run at a time); refresh skips the copy. */
export function makePwaStatsCache({ ttlMs = 60_000, load = loadPwaStats } = {}) {
  const cache = new Map();
  return async function stats(models, { days = 30, refresh = false } = {}) {
    const key = clampDays(days);
    const hit = cache.get(key);
    if (!refresh && hit?.data && Date.now() - hit.at < ttlMs) return hit.data;
    if (hit?.pending) return hit.pending;
    const pending = load(models, { days: key })
      .then((data) => { cache.set(key, { at: Date.now(), data }); return data; })
      .catch((err) => { cache.delete(key); throw err; });
    cache.set(key, { ...hit, pending });
    return pending;
  };
}

export const pwaStats = makePwaStatsCache();
