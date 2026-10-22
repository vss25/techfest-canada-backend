import test from "node:test";
import assert from "node:assert/strict";
import {
  isMealOrBreak, sessionTimes, dueSessions, groupName, groupDescription, welcomeMessage, appSessionId, sessionIds, groupFields,
  LEAD_MIN, NAME_MAX, DEFAULT_ROOM,
} from "../services/sessionGroups.js";

/* Session chats (Oct 21 2026): made 30 min before each agenda session, never for meals or breaks. The pure parts;
   the job, registrations and the race between servers are in session-groups-db.test.js. Toronto is UTC-4 on
   26-27 Oct 2026. Fictional sessions. */

const s = (extra = {}) => ({ _id: "session-d1-06", sessionId: "d1-06", day: 1, time: "10:00", endTime: "10:45", title: "Quantum in the Enterprise",
  type: "Panel", format: "panel", stage: "Harbour Ballroom", ...extra });
const at = (iso) => new Date(iso);

test("meals and breaks: no chat; real sessions get one", () => {
  for (const title of ["CxO Breakfast", "Networking Lunch", "Leaders' Luncheon", "Gala Dinner", "Networking Reception and Gala Dinner", "Sunday Brunch",
    "Coffee Break", "Networking Break", "Arrival, registration and badge pick-up", "BREAKFAST"]) {
    assert.equal(isMealOrBreak(s({ title })), true, title);
  }
  assert.equal(isMealOrBreak(s({ type: "Lunch" })), true);
  assert.equal(isMealOrBreak(s({ isBreak: true })), true);
  assert.equal(isMealOrBreak(s({ format: "break" })), true);
  for (const title of ["Quantum in the Enterprise", "Breakout: AI in Healthcare", "Break-out session: Cyber", "Breakthroughs in Robotics",
    "Catalyst Awards Gala", "Opening Keynote", "Speed Networking"]) {
    assert.equal(isMealOrBreak(s({ title, type: "Panel" })), false, title);
  }
  assert.equal(isMealOrBreak(null), true);
});

test("times: Toronto (UTC-4) on the festival days; a missing or earlier end is an hour", () => {
  const t = sessionTimes(s());
  assert.equal(t.startsAt.toISOString(), "2026-10-26T14:00:00.000Z");
  assert.equal(t.endsAt.toISOString(), "2026-10-26T14:45:00.000Z");
  assert.equal(sessionTimes(s({ day: 2, time: "16:30", endTime: "" })).endsAt.toISOString(), "2026-10-27T21:30:00.000Z");
  assert.equal(sessionTimes(s({ endTime: "09:00" })).endsAt.toISOString(), "2026-10-26T15:00:00.000Z");
  assert.equal(sessionTimes(s({ day: 3 })), null);
  assert.equal(sessionTimes(s({ time: "9am" })), null);
});

test("due: from 30 minutes before the start until the end; meals, bad times and duplicates left out", () => {
  const list = [s(), s({ _id: "x2", sessionId: "d1-07", title: "Networking Lunch", time: "10:00" }), s({ _id: "x3", sessionId: "", title: "Cyber Now", time: "11:00", endTime: "11:30" }),
    s(), s({ _id: "x4", sessionId: "d1-09", day: 9 })];
  const ids = (now) => dueSessions(list, at(now)).map((d) => d.id);
  assert.deepEqual(ids("2026-10-26T13:29:59Z"), []);                     // 30 min and a second before
  assert.deepEqual(ids("2026-10-26T13:30:00Z"), ["d1-06"]);              // exactly 30 min before
  assert.deepEqual(ids("2026-10-26T14:44:59Z"), ["d1-06", "x3"]);        // still on; the next one is within 30 min
  assert.deepEqual(ids("2026-10-26T14:45:00Z"), ["x3"]);                 // ended: never made after the end
  assert.deepEqual(ids("2026-10-26T15:30:00Z"), []);
  const [d] = dueSessions([s()], at("2026-10-26T13:40:00Z"));
  assert.equal(d.startsAt.toISOString(), "2026-10-26T14:00:00.000Z");
  assert.equal(LEAD_MIN, 30);
});

test("group fields: the title (at most 60 characters), the day, time and room; the welcome line", () => {
  assert.equal(groupName("Quantum in the Enterprise"), "Quantum in the Enterprise");
  const long = groupName("The Future of Sovereign Compute: Canada's Path to Quantum-Safe Infrastructure Across Critical Sectors");
  assert.ok(long.length <= NAME_MAX, long);
  assert.ok(long.endsWith("…"));
  assert.equal(groupDescription(s()), "Session chat · Mon 26 Oct 10:00 AM · Harbour Ballroom");
  assert.equal(groupDescription(s({ day: 2, time: "14:05", stage: "" })), `Session chat · Tue 27 Oct 2:05 PM · ${DEFAULT_ROOM}`);
  assert.equal(welcomeMessage(s()), "Welcome to the Quantum in the Enterprise chat. It starts at 10:00 AM in Harbour Ballroom.");
  assert.equal(welcomeMessage(s({ title: "Closing Remarks." })), "Welcome to the Closing Remarks chat. It starts at 10:00 AM in Harbour Ballroom.");
  assert.equal(appSessionId(s()), "d1-06");
  assert.equal(appSessionId(s({ sessionId: " " })), "session-d1-06");
  assert.deepEqual(sessionIds(s()), ["d1-06", "session-d1-06"]);
  const f = groupFields(s());
  assert.deepEqual([f.name, f.sessionDocId, f.sessionStartsAt.toISOString()], ["Quantum in the Enterprise", "session-d1-06", "2026-10-26T14:00:00.000Z"]);
});
