/* TTFC Check-in desk: event days and station windows (services/checkinDeskTime.js). Today in Toronto (Day 1 = Mon Oct 26,
   Day 2 = Tue Oct 27, anything else before / after, never a silent Day 1), the windows from the live agenda (± buffers,
   the Awards Evening's 3 h after), the fallback when the agenda can't be read or a session is missing, staff's buffers
   and hand-set windows, the boundaries (open at the opening minute, closed at the closing minute) and each station's
   header line. Pure. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STATIONS, STATION_KEYS, MEAL_ITEMS, FALLBACK_AGENDA, DEFAULT_BUFFERS, agendaTimes, cleanSettings, eventDayInfo, fmtClock, fmtRange, mealItem,
  resolveWindows, stationEnabled, stationState, torontoParts, windowDetail,
} from "../services/checkinDeskTime.js";

/** Toronto wall time on a date → Date (EDT, UTC−4, until Nov 1 2026). */
const T = (date, hhmm) => new Date(`${date}T${hhmm}:00-04:00`);
const D1 = "2026-10-26";
const D2 = "2026-10-27";

// The agenda as the website's /agenda showed it on Oct 23 2026 (Sanity "session" docs), plus talks around them.
const AGENDA = [
  { day: 1, time: "07:55", endTime: "08:55", title: "CxO Breakfast", type: "Break", format: "networking", isBreak: true, stage: "Pier 5" },
  { day: 1, time: "08:55", endTime: "09:00", title: "Opening Remarks + Land Acknowledgement", format: "opening" },
  { day: 1, time: "12:35", endTime: "13:20", title: "Networking Lunch", type: "Lunch Break", format: "networking", isBreak: true },
  { day: 1, time: "13:30", endTime: "14:00", title: "When Software Starts Talking to Software", format: "panel" },
  { day: 1, time: "17:30", endTime: "18:30", title: "Awards Evening", type: "Awards", format: "awards", isBreak: true },
  { day: 2, time: "07:55", endTime: "08:55", title: "CxO Breakfast", format: "networking", isBreak: true },
  { day: 2, time: "12:00", endTime: "12:45", title: "Lunch", type: "Lunch Break", format: "networking", isBreak: true },
  { day: 2, time: "17:30", endTime: "19:30", title: "Gala Dinner", type: "Gala", format: "awards", isBreak: true },
];

test("today in Toronto: Day 1, Day 2, before and after; midnight is Toronto's, not UTC's", () => {
  assert.deepEqual(pick(eventDayInfo(T(D1, "00:00"))), { date: D1, eventDay: "day1", phase: "event", label: "Day 1" });
  assert.deepEqual(pick(eventDayInfo(T(D1, "23:59"))), { date: D1, eventDay: "day1", phase: "event", label: "Day 1" });
  assert.deepEqual(pick(eventDayInfo(T(D2, "00:00"))), { date: D2, eventDay: "day2", phase: "event", label: "Day 2" });
  assert.deepEqual(pick(eventDayInfo(T("2026-10-25", "23:59"))), { date: "2026-10-25", eventDay: null, phase: "before", label: "Before the event" });
  assert.deepEqual(pick(eventDayInfo(T("2026-10-28", "00:00"))), { date: "2026-10-28", eventDay: null, phase: "after", label: "After the event" });
  // 11:30 PM on Oct 26 in Toronto is already Oct 27 in UTC: still Day 1.
  assert.equal(eventDayInfo(new Date("2026-10-27T03:30:00Z")).eventDay, "day1");
  assert.equal(eventDayInfo(new Date("2026-10-27T04:00:00Z")).eventDay, "day2");
  assert.deepEqual(torontoParts(T(D1, "07:25")), { date: D1, minutes: 7 * 60 + 25 });
});
function pick(i) { return { date: i.date, eventDay: i.eventDay, phase: i.phase, label: i.label }; }

test("the stations and what the meal ones admit to on each day", () => {
  assert.deepEqual(STATION_KEYS, ["lobby", "desk", "breakfast", "lunch", "evening", "media", "av", "exhibitor"]);
  assert.equal(STATIONS.find((s) => s.key === "evening").removable, true);
  assert.deepEqual(MEAL_ITEMS.breakfast.day1, { key: "cxo_d1", extra: "cxo", label: "CxO Breakfast", short: "breakfast" });
  assert.equal(mealItem("breakfast", "day2").key, "cxo_d2");
  assert.equal(mealItem("lunch", "day1").key, "lunch_d1");
  assert.equal(mealItem("lunch", "day2").key, "lunch_d2");
  assert.deepEqual([mealItem("evening", "day1").key, mealItem("evening", "day1").extra], ["awards", "awards"]);
  assert.deepEqual([mealItem("evening", "day2").key, mealItem("evening", "day2").extra], ["gala", "gala"]);
  assert.equal(mealItem("evening", null), null, "no event today: nothing to admit to");
  assert.equal(mealItem("lobby", "day1"), null);
});

test("agenda matching: the website's sessions by title (and the evening by its awards format)", () => {
  const a = agendaTimes(AGENDA);
  assert.deepEqual(a.breakfast, { day1: { start: "07:55", end: "08:55", title: "CxO Breakfast" }, day2: { start: "07:55", end: "08:55", title: "CxO Breakfast" } });
  assert.deepEqual(a.lunch, { day1: { start: "12:35", end: "13:20", title: "Networking Lunch" }, day2: { start: "12:00", end: "12:45", title: "Lunch" } });
  assert.deepEqual(a.evening, { day1: { start: "17:30", end: "18:30", title: "Awards Evening" }, day2: { start: "17:30", end: "19:30", title: "Gala Dinner" } });
  // The agenda moves lunch on Day 2: the station follows.
  const moved = agendaTimes(AGENDA.map((s) => (s.title === "Lunch" ? { ...s, time: "12:20", endTime: "13:05" } : s)));
  assert.deepEqual(moved.lunch.day2, { start: "12:20", end: "13:05", title: "Lunch" });
  // Day as a string or a date; a session without an end gets an hour; a renamed evening still matches by its format.
  const odd = agendaTimes([
    { day: "2026-10-26", time: "17:45", title: "Catalyst Celebration", format: "awards" },
    { day: "2", time: "07:50", endTime: "", title: "Executive CxO breakfast" },
    { day: "3", time: "08:00", endTime: "09:00", title: "CxO Breakfast" },
    { day: 1, time: "lunch", endTime: "13:00", title: "Lunch" },
  ]);
  assert.deepEqual(odd.evening.day1, { start: "17:45", end: "18:45", title: "Catalyst Celebration" });
  assert.deepEqual(odd.breakfast.day2, { start: "07:50", end: "08:50", title: "Executive CxO breakfast" });
  assert.equal(odd.breakfast.day1, undefined);
  assert.equal(odd.lunch.day1, undefined);
  // "Lunches" in a talk's title isn't lunch; "Luncheon" is; a break beats a talk with the word in its title.
  assert.equal(agendaTimes([{ day: 1, time: "10:00", endTime: "10:30", title: "Free lunches? AI economics" }]).lunch.day1, undefined);
  const both = agendaTimes([{ day: 1, time: "11:00", endTime: "11:30", title: "Lunch & Learn: Quantum", format: "panel" },
    { day: 1, time: "12:35", endTime: "13:20", title: "Networking Lunch", isBreak: true }]);
  assert.deepEqual(both.lunch.day1, { start: "12:35", end: "13:20", title: "Networking Lunch" });
  assert.equal(agendaTimes([{ day: 1, time: "12:00", endTime: "13:00", title: "Networking Luncheon" }]).lunch.day1.start, "12:00");
  assert.deepEqual(agendaTimes(null), { breakfast: {}, lunch: {}, evening: {} });
});

test("windows: session ± 30 min from the agenda, the Awards Evening 3 h after, the rest by default", () => {
  const w = resolveWindows({ agenda: agendaTimes(AGENDA) });
  assert.deepEqual(w.breakfast.day1, { open: "07:25", close: "09:25", source: "agenda", session: { start: "07:55", end: "08:55", title: "CxO Breakfast" }, buffers: { before: 30, after: 30 } });
  assert.deepEqual([w.lunch.day1.open, w.lunch.day1.close], ["12:05", "13:50"]);
  assert.deepEqual([w.lunch.day2.open, w.lunch.day2.close], ["11:30", "13:15"]);
  assert.deepEqual([w.evening.day1.open, w.evening.day1.close], ["17:00", "21:30"]);
  assert.deepEqual([w.evening.day2.open, w.evening.day2.close], ["17:00", "20:00"]);
  assert.deepEqual(w.lobby.day1, { open: "07:00", close: "23:00", source: "default" });
  assert.deepEqual(w.desk.day2, { open: "07:00", close: "23:00", source: "default" });
  for (const s of ["media", "av", "exhibitor"]) for (const d of ["day1", "day2"]) assert.equal(w[s][d].source, "default", `${s} ${d}`);
  assert.equal(DEFAULT_BUFFERS.evening.day1.after, 180);
});

test("fallback: the agenda can't be read, or a session isn't on it → the Oct 23 times", () => {
  const none = resolveWindows({ agenda: null });
  assert.equal(none.breakfast.day1.source, "fallback");
  assert.deepEqual(none.breakfast.day1.session, FALLBACK_AGENDA.breakfast.day1);
  assert.deepEqual([none.lunch.day1.open, none.lunch.day1.close], ["12:05", "13:50"]);
  assert.deepEqual([none.evening.day2.open, none.evening.day2.close], ["17:00", "20:00"]);
  // Only Day 2's Gala missing from the agenda: that one falls back, the rest follow the agenda.
  const partial = resolveWindows({ agenda: agendaTimes(AGENDA.filter((s) => s.title !== "Gala Dinner")) });
  assert.equal(partial.evening.day2.source, "fallback");
  assert.equal(partial.evening.day1.source, "agenda");
  assert.equal(partial.breakfast.day2.source, "agenda");
});

test("staff: buffers per station and day, a window set by hand wins, a day can be closed, the evening switched off", () => {
  const c = cleanSettings({
    buffers: { evening: { day1: { after: 240 } }, breakfast: { day2: { before: 45, after: 15 } } },
    windows: { lunch: { day1: { open: "11:45", close: "14:30" } }, exhibitor: { day2: null } },
    stations: { evening: false },
  });
  assert.equal(c.ok, true, c.error);
  const w = resolveWindows({ settings: c.value, agenda: agendaTimes(AGENDA) });
  assert.equal(w.evening.day1.close, "22:30");
  assert.deepEqual([w.breakfast.day2.open, w.breakfast.day2.close], ["07:10", "09:10"]);
  assert.deepEqual(w.lunch.day1, { open: "11:45", close: "14:30", source: "staff" });
  assert.equal(w.exhibitor.day2, null);
  assert.equal(stationEnabled("evening", c.value), false);
  assert.equal(stationEnabled("evening", {}), true);
  assert.equal(stationEnabled("lobby", c.value), true);
  // Refused: a closing time before the opening, minutes out of range, unknown stations and days, buffers on a desk.
  assert.equal(cleanSettings({ windows: { lunch: { day1: { open: "14:00", close: "12:00" } } } }).ok, false);
  assert.equal(cleanSettings({ windows: { lunch: { day1: { open: "7:00", close: "12:00" } } } }).ok, false);
  assert.equal(cleanSettings({ buffers: { lunch: { day1: { before: 241 } } } }).ok, false);
  assert.equal(cleanSettings({ buffers: { lunch: { day1: { before: 1.5 } } } }).ok, false);
  assert.equal(cleanSettings({ buffers: { lobby: { day1: { before: 10 } } } }).ok, false);
  assert.equal(cleanSettings({ windows: { bar: { day1: null } } }).ok, false);
  assert.equal(cleanSettings({ windows: { lunch: { day3: null } } }).ok, false);
  assert.deepEqual(cleanSettings(null).value, { windows: {}, buffers: {}, stations: {} });
});

test("boundaries: open at the opening minute, closed at the closing minute", () => {
  const w = resolveWindows({ agenda: agendaTimes(AGENDA) });
  const at = (date, hhmm) => stationState({ station: "breakfast", at: T(date, hhmm), windows: w });
  assert.equal(at(D1, "07:24").code, "later");
  assert.equal(at(D1, "07:25").code, "open");
  assert.equal(at(D1, "09:24").code, "open");
  assert.equal(at(D1, "09:25").code, "closed");
  const lobby = (hhmm) => stationState({ station: "lobby", at: T(D2, hhmm), windows: w }).code;
  assert.deepEqual([lobby("06:59"), lobby("07:00"), lobby("22:59"), lobby("23:00")], ["later", "open", "open", "closed"]);
  // Seconds inside the closing minute are already closed.
  assert.equal(stationState({ station: "breakfast", at: new Date(T(D1, "09:24").getTime() + 59 * 1000), windows: w }).code, "open");
});

test("each station's header: what's on now, when it opens, what's next, where the times come from", () => {
  const w = resolveWindows({ agenda: agendaTimes(AGENDA) });
  const s = (station, date, hhmm) => stationState({ station, at: T(date, hhmm), windows: w });
  assert.equal(s("breakfast", D1, "08:00").text, "Day 1 · CxO Breakfast · open until 9:25 AM");
  assert.equal(s("breakfast", D1, "08:00").detail, "CxO Breakfast 7:55–8:55 AM (agenda) · doors 7:25–9:25 AM");
  assert.equal(s("lunch", D1, "10:00").text, "Day 1 · Networking Luncheon · opens at 12:05 PM");
  assert.equal(s("lunch", D1, "10:00").detail, "Networking Lunch 12:35–1:20 PM (agenda) · doors 12:05–1:50 PM");
  assert.equal(s("breakfast", D1, "10:00").text, "Day 1 · CxO Breakfast · closed: next is Day 2 breakfast, 7:25 AM");
  assert.equal(s("evening", D1, "19:00").text, "Day 1 · Catalyst Awards Night · open until 9:30 PM");
  assert.equal(s("evening", D2, "18:00").text, "Day 2 · Gala Dinner · open until 8:00 PM");
  assert.equal(s("breakfast", D2, "10:00").text, "Day 2 · CxO Breakfast · closed");
  assert.equal(s("lobby", D1, "09:00").detail, "Open 7:00–11:00 PM (default hours)".replace("7:00–", "7:00 AM–"));
  // Before and after the event: said in words, never a silent Day 1.
  const early = s("breakfast", "2026-10-23", "17:00");
  assert.equal(early.code, "before");
  assert.equal(early.eventDay, null);
  assert.equal(early.text, "Before the event · Day 1 is Mon Oct 26 · breakfast opens 7:25 AM");
  assert.equal(s("lobby", "2026-10-25", "09:00").text, "Before the event · Day 1 is Mon Oct 26 · lobby opens 7:00 AM");
  assert.equal(s("lunch", "2026-10-28", "12:30").text, "TTFC 2026 is over: no event today");
  assert.equal(s("lunch", "2026-10-28", "12:30").code, "after");
  // A station staff closed for the day.
  const closed = resolveWindows({ settings: cleanSettings({ windows: { exhibitor: { day2: null } } }).value });
  assert.equal(stationState({ station: "exhibitor", at: T(D2, "09:00"), windows: closed }).text, "Day 2 · Exhibitor desk · closed today");
  assert.equal(windowDetail({ open: "11:45", close: "14:30", source: "staff" }), "Open 11:45 AM–2:30 PM (set by staff)");
  assert.equal(windowDetail(resolveWindows({ agenda: null }).breakfast.day1), "CxO Breakfast 7:55–8:55 AM (agenda as of Oct 23) · doors 7:25–9:25 AM");
});

test("times read the Toronto way", () => {
  assert.deepEqual(["00:05", "07:30", "12:00", "12:45", "22:30"].map(fmtClock), ["12:05 AM", "7:30 AM", "12:00 PM", "12:45 PM", "10:30 PM"]);
  assert.equal(fmtRange("07:55", "08:55"), "7:55–8:55 AM");
  assert.equal(fmtRange("11:30", "13:15"), "11:30 AM–1:15 PM");
  assert.equal(fmtClock("7:30"), "");
});
