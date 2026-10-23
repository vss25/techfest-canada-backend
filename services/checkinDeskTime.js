import { DAYS } from "./rsvp.js";

/* =========================================================
   TTFC Check-in: event days, stations and their opening windows
   ---------------------------------------------------------
   The organiser (Oct 23 2026): "Also pick a station as breakfast,
   media query queue, av station, exhibitor, lunch. Remember check in
   should be time appropriate."

   Today is always worked out in Toronto time: Mon Oct 26 is Day 1,
   Tue Oct 27 is Day 2 (services/rsvp.js DAYS). Any other date is
   "before" or "after" the event and says so: nothing silently counts
   as Day 1. Every mark is stored against today's date, so each day's
   statuses start empty.

   Each station has an opening window per event day (Toronto "HH:MM",
   open <= now < close). The organiser: "pick it from agenda page".
     - CxO Breakfast, Lunch and the evening event (Awards Night on Day 1,
       the Gala on Day 2) follow the live agenda, the same Sanity
       sessions the website's /agenda page shows (matched by title:
       "CxO Breakfast", "Networking Lunch" / "Lunch", "Awards Evening",
       "Gala Dinner"; the evening also by its "awards" format): doors
       open `before` minutes before the session starts and close `after`
       minutes after it ends (30 and 30; the Awards Evening is listed as
       an hour, short for a dinner, so its `after` is 180). If the agenda
       moves a session, the station follows. When the agenda can't be
       read or a session isn't on it, the agenda's times on Oct 23 2026
       are used (FALLBACK_AGENDA).
     - The Lobby and the Pass desk open at 7:00 (the earliest agenda item
       is the 7:55 breakfast); the media, AV and exhibitor desks have
       day-long defaults (DEFAULT_WINDOWS).
     - Staff can change the buffers, or set any station's window by hand
       (or close it for a day), in Admin › Event day › Check-in › Desk
       settings (AppContent `checkin.windows`, PUT
       /api/checkin-desk/settings). A window set by hand wins.
   Every station's header says where its times come from: "CxO Breakfast
   7:55–8:55 AM (agenda) · doors 7:25–9:25 AM". Outside the window a tap
   needs a deliberate second tap ("Admit anyway"), stored as an override
   and audited.

   The evening entry station (Awards Night on Day 1, the Gala on Day 2)
   can be switched off by staff in the same settings
   (`stations.evening: false`): the organiser asked for it to be easy
   to remove.

   Pure; tested in test/checkin-desk-time.test.js.
========================================================= */

export const DESK_TZ = "America/Toronto";
export const EVENT_DAY_KEYS = DAYS.map((d) => d.key); // ["day1", "day2"]
const DAY_BY_DATE = Object.fromEntries(DAYS.map((d) => [d.date, d.key]));
const DATE_BY_DAY = Object.fromEntries(DAYS.map((d) => [d.key, d.date]));
export const DAY_LABELS = Object.freeze({ day1: "Day 1", day2: "Day 2" });
export const DAY_SHORT = Object.freeze({ day1: "Mon Oct 26", day2: "Tue Oct 27" });

/** The stations, in the picker's order. `point`: what its big button records. `meal`: admits to a meal or event. */
export const STATIONS = Object.freeze([
  { key: "lobby", label: "Lobby", sub: "Arrivals", point: "arrived" },
  { key: "desk", label: "Floor 1", sub: "Pass desk", point: "checked_in" },
  { key: "breakfast", label: "CxO Breakfast", sub: "Breakfast entry", point: "cxo", meal: true },
  { key: "lunch", label: "Lunch", sub: "Networking Luncheon", point: "lunch", meal: true },
  { key: "evening", label: "Evening entry", sub: "Awards Night (Day 1) · Gala (Day 2)", point: "evening", meal: true, removable: true },
  { key: "media", label: "Media desk", sub: "Media check-in and queries", point: "media" },
  { key: "av", label: "AV station", sub: "Speakers' slides and mics", point: "av" },
  { key: "exhibitor", label: "Exhibitor desk", sub: "Exhibitors and booths", point: "exhibitor" },
].map((s) => Object.freeze(s)));
export const STATION_KEYS = STATIONS.map((s) => s.key);
export const STATION_BY_KEY = Object.freeze(Object.fromEntries(STATIONS.map((s) => [s.key, s])));
/** Where else an action can come from (never picked on the iPad). */
export const OTHER_STATIONS = Object.freeze(["scanner", "admin"]);
export const STATION_LABELS = Object.freeze({
  ...Object.fromEntries(STATIONS.map((s) => [s.key, s.key === "desk" ? "Pass desk" : s.label])), scanner: "QR scan", admin: "Admin",
});

/** What a meal / evening station admits to on each event day: the RSVP option and the pass extra (services/passExtras.js). */
export const MEAL_ITEMS = Object.freeze({
  breakfast: Object.freeze({
    day1: Object.freeze({ key: "cxo_d1", extra: "cxo", label: "CxO Breakfast", short: "breakfast" }),
    day2: Object.freeze({ key: "cxo_d2", extra: "cxo", label: "CxO Breakfast", short: "breakfast" }),
  }),
  lunch: Object.freeze({
    day1: Object.freeze({ key: "lunch_d1", extra: "lunch", label: "Networking Luncheon", short: "lunch" }),
    day2: Object.freeze({ key: "lunch_d2", extra: "lunch", label: "Networking Luncheon", short: "lunch" }),
  }),
  evening: Object.freeze({
    day1: Object.freeze({ key: "awards", extra: "awards", label: "Catalyst Awards Night", short: "Awards Night" }),
    day2: Object.freeze({ key: "gala", extra: "gala", label: "Gala Dinner", short: "Gala" }),
  }),
});
/** The point a meal station marks → its station. */
export const MEAL_POINTS = Object.freeze({ cxo: "breakfast", lunch: "lunch", evening: "evening" });

/** The stations that follow the agenda, and the agenda's times as the website showed them on Oct 23 2026 (used when the
    agenda can't be read or a session isn't found). */
export const AGENDA_STATIONS = Object.freeze(["breakfast", "lunch", "evening"]);
export const FALLBACK_AGENDA = Object.freeze({
  breakfast: { day1: { start: "07:55", end: "08:55", title: "CxO Breakfast" }, day2: { start: "07:55", end: "08:55", title: "CxO Breakfast" } },
  lunch: { day1: { start: "12:35", end: "13:20", title: "Networking Lunch" }, day2: { start: "12:00", end: "12:45", title: "Lunch" } },
  evening: { day1: { start: "17:30", end: "18:30", title: "Awards Evening" }, day2: { start: "17:30", end: "19:30", title: "Gala Dinner" } },
});
/** Minutes the doors open before the session and close after it. The Awards Evening's hour is short for a dinner. */
export const DEFAULT_BUFFERS = Object.freeze({
  breakfast: { day1: { before: 30, after: 30 }, day2: { before: 30, after: 30 } },
  lunch: { day1: { before: 30, after: 30 }, day2: { before: 30, after: 30 } },
  evening: { day1: { before: 30, after: 180 }, day2: { before: 30, after: 30 } },
});
export const BUFFER_MAX = Object.freeze({ before: 240, after: 360 });
/** The stations that don't follow the agenda (Toronto). */
export const DEFAULT_WINDOWS = Object.freeze({
  lobby: { day1: { open: "07:00", close: "23:00" }, day2: { open: "07:00", close: "23:00" } },
  desk: { day1: { open: "07:00", close: "23:00" }, day2: { open: "07:00", close: "23:00" } },
  media: { day1: { open: "07:00", close: "18:30" }, day2: { open: "07:00", close: "18:30" } },
  av: { day1: { open: "07:00", close: "18:30" }, day2: { open: "07:00", close: "18:30" } },
  exhibitor: { day1: { open: "06:30", close: "18:00" }, day2: { open: "07:00", close: "18:00" } },
});

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isHHMM = (v) => HHMM.test(String(v || ""));
export const toMin = (hhmm) => Number(String(hhmm).slice(0, 2)) * 60 + Number(String(hhmm).slice(3, 5));
export const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** "07:30" → "7:30 AM", "12:00" → "12:00 PM", "22:30" → "10:30 PM". */
export function fmtClock(hhmm) {
  if (!isHHMM(hhmm)) return "";
  const m = toMin(hhmm);
  const h = Math.floor(m / 60) % 12 || 12;
  return `${h}:${String(m % 60).padStart(2, "0")} ${m >= 720 ? "PM" : "AM"}`;
}

const partsFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: DESK_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
/** A moment in Toronto: { date: "2026-10-26", minutes: 0–1439 }. */
export function torontoParts(at = new Date()) {
  const d = at instanceof Date ? at : new Date(at);
  const p = Object.fromEntries(partsFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

/**
 * Which event day a moment is (Toronto): { date, eventDay: "day1" | "day2" | null, phase: "before" | "event" | "after",
 * label }. Before Oct 26 is "before", after Oct 27 "after"; no date is ever Day 1 by default.
 */
export function eventDayInfo(at = new Date()) {
  const { date, minutes } = torontoParts(at);
  const eventDay = DAY_BY_DATE[date] || null;
  const first = DAYS[0].date;
  const last = DAYS[DAYS.length - 1].date;
  const phase = eventDay ? "event" : date < first ? "before" : date > last ? "after" : "between";
  const label = eventDay ? DAY_LABELS[eventDay] : phase === "before" ? "Before the event" : phase === "after" ? "After the event" : "Between event days";
  return { date, minutes, eventDay, phase, label };
}

/** The meal / evening item a station admits to on an event day, or null (not a meal station, or not an event day). */
export const mealItem = (station, eventDay) => (eventDay && MEAL_ITEMS[station]?.[eventDay]) || null;

/* ---------- Windows: staff's, the agenda's, the defaults ---------- */

const cleanWindow = (w) => {
  if (w === null) return null;
  if (!w || !isHHMM(w.open) || !isHHMM(w.close) || toMin(w.close) <= toMin(w.open)) return undefined;
  return { open: w.open, close: w.close };
};

/**
 * Staff's settings as saved → { ok, value: { windows: { <station>: { day1?, day2? } }, stations: { evening: bool } }, error }.
 * A day's window is { open, close } (HH:MM, close after open) or null (closed); leaving a day out = not set by staff.
 */
export function cleanSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const windows = {};
  const inW = src.windows && typeof src.windows === "object" ? src.windows : {};
  for (const [station, days] of Object.entries(inW)) {
    if (!STATION_KEYS.includes(station)) return { ok: false, error: `Unknown station: ${station}` };
    if (!days || typeof days !== "object") continue;
    for (const [day, w] of Object.entries(days)) {
      if (!EVENT_DAY_KEYS.includes(day)) return { ok: false, error: `Unknown day: ${day}` };
      if (w === undefined) continue;
      const c = cleanWindow(w);
      if (c === undefined) return { ok: false, error: `${STATION_LABELS[station]}, ${DAY_LABELS[day]}: enter an opening and a closing time (HH:MM), closing after opening.` };
      (windows[station] ||= {})[day] = c;
    }
  }
  const buffers = {};
  const inB = src.buffers && typeof src.buffers === "object" ? src.buffers : {};
  for (const [station, days] of Object.entries(inB)) {
    if (!AGENDA_STATIONS.includes(station)) return { ok: false, error: `${STATION_LABELS[station] || station} doesn't follow the agenda.` };
    if (!days || typeof days !== "object") continue;
    for (const [day, b] of Object.entries(days)) {
      if (!EVENT_DAY_KEYS.includes(day)) return { ok: false, error: `Unknown day: ${day}` };
      if (b === undefined || b === null) continue;
      const out = {};
      for (const k of ["before", "after"]) {
        if (b[k] === undefined || b[k] === null || b[k] === "") continue;
        const n = Number(b[k]);
        if (!Number.isInteger(n) || n < 0 || n > BUFFER_MAX[k]) {
          return { ok: false, error: `${STATION_LABELS[station]}, ${DAY_LABELS[day]}: minutes ${k} must be a whole number from 0 to ${BUFFER_MAX[k]}.` };
        }
        out[k] = n;
      }
      if (Object.keys(out).length) (buffers[station] ||= {})[day] = out;
    }
  }
  const stations = {};
  if (src.stations && typeof src.stations === "object" && typeof src.stations.evening === "boolean") stations.evening = src.stations.evening;
  return { ok: true, value: { windows, buffers, stations } };
}

const MATCH = {
  breakfast: (t) => /breakfast/i.test(t),
  lunch: (t) => /\blunch(eon)?\b/i.test(t),
  evening: { day1: (t, f) => /award/i.test(t) || /^awards?$/i.test(f), day2: (t, f) => /gala/i.test(t) || /^awards?$/i.test(f) },
};
const dayKeyOf = (d) => {
  const s = String(d ?? "").trim().toLowerCase();
  if (s === "1" || s === "day1" || s === "day 1" || s === DATE_BY_DAY.day1) return "day1";
  if (s === "2" || s === "day2" || s === "day 2" || s === DATE_BY_DAY.day2) return "day2";
  return "";
};

/**
 * The agenda's sessions for the agenda stations (the website's Sanity "session" docs: day, time, endTime, title, format)
 * → { breakfast: { day1: { start, end, title } … }, lunch, evening }. The first matching session of each day, by time.
 * A session without a usable end gets an hour (the agenda lists the Awards Evening that way). Sessions the agenda marks
 * as breaks (isBreak, or a networking / awards format) are matched before talks.
 */
export function agendaTimes(sessions = []) {
  const out = { breakfast: {}, lunch: {}, evening: {} };
  const list = (Array.isArray(sessions) ? sessions : [])
    .map((s) => ({ s, day: dayKeyOf(s?.day), start: String(s?.time || "").slice(0, 5), end: String(s?.endTime || "").slice(0, 5) }))
    .filter((x) => x.day && isHHMM(x.start))
    .sort((a, b) => a.day.localeCompare(b.day) || toMin(a.start) - toMin(b.start));
  // Breaks first (the agenda marks meals and the evening as breaks), so a talk titled "Lunch & Learn" can't win.
  const isBreak = (s) => s?.isBreak === true || /^(networking|awards?|break|meal)$/i.test(String(s?.format || ""));
  list.sort((a, b) => (isBreak(b.s) ? 1 : 0) - (isBreak(a.s) ? 1 : 0));
  for (const { s, day, start, end: rawEnd } of list) {
    const end = isHHMM(rawEnd) && toMin(rawEnd) > toMin(start) ? rawEnd : fromMin(Math.min(24 * 60 - 1, toMin(start) + 60));
    const title = String(s?.title || "").trim();
    const format = String(s?.format || s?.type || "").trim();
    const take = (station) => { if (!out[station][day]) out[station][day] = { start, end, title: title.slice(0, 80) }; };
    if (MATCH.breakfast(title)) take("breakfast");
    else if (MATCH.lunch(title)) take("lunch");
    else if (MATCH.evening[day](title, format)) take("evening");
  }
  return out;
}

const clampMin = (m) => Math.max(0, Math.min(24 * 60 - 1, m));

/**
 * Every station's window per day, and where it came from:
 *   { <station>: { day1: { open, close, source: "staff" | "agenda" | "fallback" | "default", session?, buffers? } | null, … } }
 * `settings`: staff's (cleanSettings value); `agenda`: agendaTimes(sessions), or null when the agenda couldn't be read.
 */
export function resolveWindows({ settings = {}, agenda = null } = {}) {
  const out = {};
  for (const station of STATION_KEYS) {
    out[station] = {};
    for (const day of EVENT_DAY_KEYS) {
      const manual = settings?.windows?.[station];
      if (manual && day in manual) {
        out[station][day] = manual[day] ? { open: manual[day].open, close: manual[day].close, source: "staff" } : null;
        continue;
      }
      if (AGENDA_STATIONS.includes(station)) {
        const fromAgenda = agenda?.[station]?.[day] || null;
        const session = fromAgenda || FALLBACK_AGENDA[station][day];
        const buffers = { ...DEFAULT_BUFFERS[station][day], ...(settings?.buffers?.[station]?.[day] || {}) };
        out[station][day] = {
          open: fromMin(clampMin(toMin(session.start) - buffers.before)),
          close: fromMin(clampMin(toMin(session.end) + buffers.after)),
          source: fromAgenda ? "agenda" : "fallback",
          session: { start: session.start, end: session.end, title: session.title },
          buffers,
        };
        continue;
      }
      const def = DEFAULT_WINDOWS[station]?.[day] || null;
      out[station][day] = def ? { ...def, source: "default" } : null;
    }
  }
  return out;
}

/** "7:55–8:55 AM", "11:30 AM–12:30 PM". */
export function fmtRange(a, b) {
  if (!isHHMM(a) || !isHHMM(b)) return "";
  const [ta, tb] = [fmtClock(a), fmtClock(b)];
  const same = ta.slice(-2) === tb.slice(-2);
  return same ? `${ta.slice(0, -3)}–${tb}` : `${ta}–${tb}`;
}

const SOURCE_WORD = { agenda: "agenda", fallback: "agenda as of Oct 23", staff: "set by staff", default: "default hours" };
/** Where a window's times come from, for the station's header: "CxO Breakfast 7:55–8:55 AM (agenda) · doors 7:25–9:25 AM". */
export function windowDetail(w) {
  if (!w) return "Closed today";
  if (w.session && (w.source === "agenda" || w.source === "fallback")) {
    return `${w.session.title} ${fmtRange(w.session.start, w.session.end)} (${SOURCE_WORD[w.source]}) · doors ${fmtRange(w.open, w.close)}`;
  }
  return `Open ${fmtRange(w.open, w.close)} (${SOURCE_WORD[w.source] || "default hours"})`;
}

/** Is a station switched on (only the evening entry can be switched off)? */
export const stationEnabled = (station, settings = {}) => (station === "evening" ? settings?.stations?.evening !== false : STATION_KEYS.includes(station));

/** The label of what a station handles on a day ("CxO Breakfast", "Catalyst Awards Night", "Lobby"). */
const whatOn = (station, eventDay) => mealItem(station, eventDay)?.label || STATION_LABELS[station] || station;
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * Where a station is at a moment: today's event day, whether it's open, and the line its header shows.
 * → { date, eventDay, phase, dayLabel, station, item, open, window, opensAt, closesAt, next, text, code }
 *   code: "open" | "later" (opens later today) | "closed" (closed for today; next is another day) | "before" | "after"
 */
export function stationState({ station, at = new Date(), windows = resolveWindows() } = {}) {
  const info = eventDayInfo(at);
  const item = mealItem(station, info.eventDay);
  const w = info.eventDay ? windows?.[station]?.[info.eventDay] || null : null;
  const base = { date: info.date, eventDay: info.eventDay, phase: info.phase, dayLabel: info.label, station, item, window: w, detail: info.eventDay ? windowDetail(w) : "" };
  // The next event day (after today's date) on which this station opens.
  const nextAfter = () => {
    for (const d of EVENT_DAY_KEYS) {
      if (DATE_BY_DAY[d] <= info.date) continue;
      const nw = windows?.[station]?.[d];
      if (nw) return { eventDay: d, dayLabel: DAY_LABELS[d], dayShort: DAY_SHORT[d], open: nw.open, close: nw.close, item: mealItem(station, d) };
    }
    return null;
  };
  const nextText = (n) => (n ? `next is ${n.dayLabel} ${n.item ? n.item.short : lower(STATION_LABELS[station])}, ${fmtClock(n.open)}` : "");

  if (!info.eventDay) {
    const next = nextAfter();
    const text = info.phase === "after"
      ? "TTFC 2026 is over: no event today"
      : `${info.label} · ${next ? `${next.dayLabel} is ${next.dayShort} · ${next.item ? next.item.short : lower(STATION_LABELS[station])} opens ${fmtClock(next.open)}` : `Day 1 is ${DAY_SHORT.day1}`}`;
    return { ...base, open: false, opensAt: null, closesAt: null, next, text, code: info.phase === "after" ? "after" : "before" };
  }
  const label = `${info.label} · ${whatOn(station, info.eventDay)}`;
  if (!w) {
    const next = nextAfter();
    return { ...base, open: false, opensAt: null, closesAt: null, next, text: `${label} · closed today${next ? `: ${nextText(next)}` : ""}`, code: "closed" };
  }
  const now = info.minutes;
  if (now < toMin(w.open)) {
    return { ...base, open: false, opensAt: w.open, closesAt: w.close, next: null, text: `${label} · opens at ${fmtClock(w.open)}`, code: "later" };
  }
  if (now < toMin(w.close)) {
    return { ...base, open: true, opensAt: w.open, closesAt: w.close, next: null, text: `${label} · open until ${fmtClock(w.close)}`, code: "open" };
  }
  const next = nextAfter();
  return { ...base, open: false, opensAt: null, closesAt: null, next, text: `${label} · closed${next ? `: ${nextText(next)}` : ""}`, code: "closed" };
}
