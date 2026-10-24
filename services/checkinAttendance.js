import CheckinMark from "../models/CheckinMark.js";
import CheckinEvent from "../models/CheckinEvent.js";
import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import { DAYS } from "./rsvp.js";
import { SUMMARY_MEALS, summaryFacts, torontoDate } from "./eventSummary.js";
import { deskTier, isPersonSubject, noPassPerson, unknownKeyOf, unknownRows } from "./checkinDesk.js";
import { normalizeTicketId } from "./ticketAccess.js";
import { deskNow } from "./checkinDeskLog.js";

/* =========================================================
   TTFC Check-in: attendance by day (contract C10, Oct 23 2026)
   ---------------------------------------------------------
   The organiser: "ability to count the checkins for breakfast, lunch,
   dinner and over each day". From the desk app's marks
   (models/CheckinMark.js), for Day 1 and Day 2:
     - each person once per point and day: a mark is a pass's (or an
       ISSUE PASS person's, "person:<id>"), and a person's passes count
       once (the People directory joins them: a speaker's Speaker Pass
       and Power Pass are one person);
     - practice marks (a day that isn't Day 1 / Day 2, contract C6) never
       count; overrides ("Admit anyway", a late sync outside the hours)
       count, and are also counted on their own;
     - Arrived = arrived in the lobby or checked in at the pass desk (a
       check-in marks arrived too); Checked in = the pass desk;
       passesCollectedToDate = people with a counting pass collected
       (the ticket's checkedIn, the QR scanner's field) by the end of
       that day (or with no time recorded); one collected before Day 1
       (a rehearsal door scan) only once they're checked in on an
       event day;
     - each meal (CxO Breakfast, Networking Luncheon, the evening: the
       Catalyst Awards Night on Day 1, the Gala Dinner & Networking
       Reception on Day 2): admitted, and the Event summary's own
       entitled and RSVP'd (services/eventSummary.js: an extra any
       counting pass includes; the option on their RSVP; each person
       once), admitted of the RSVP'd and its %, no-shows (RSVP'd, not
       admitted), overrides, admitted without an RSVP for it;
     - byPass: the desk's colour groups, each person in one (VIP > Media
       > Speaker > their pass), so Media and VIP aren't counted twice;
       people with no pass on file are in issuePass instead: `arrived` =
       came through as ISSUE PASS (marked on their no-pass key), `issued`
       = of those, checked in at the pass desk (their pass handed over,
       on the no-pass row or on a pass given since), `arrivedNoPass` =
       arrived and still without a pass (so the groups' arrived plus
       arrivedNoPass is the day's arrived; someone given a pass since is
       in their pass's group, and still in issuePass.arrived);
     - noDetails: the lobby's NO DETAILS FOUND cards (contract C8, never
       in any other count): recorded, and how the pass desk closed them.
   attendanceFrom() is pure (test/checkin-attendance.test.js);
   loadAttendance(directory) reads the marks, the collected tickets and
   the cards. Served by GET /api/console/summary (`attendance`) and the
   desk app's GET /api/checkin/desk/counts (staff). Never writes.
========================================================= */

/** The desk's colour groups (website src/checkin/lib/passColors.js GROUPS), in its order. */
export const ATTENDANCE_GROUPS = Object.freeze(["vip", "media", "speaker", "connect", "influence", "power", "apex", "other"]);
export const ATTENDANCE_GROUP_LABELS = Object.freeze({
  vip: "VIP", media: "Media", speaker: "Speaker", connect: "Connect Pass", influence: "Influence Pass", power: "Power Pass", apex: "Apex Pass", other: "Other pass",
});
/** The points that count, and each day's meals: the marks' point, and the Event summary's meal (its RSVP option and pass extra). */
export const ATTENDANCE_POINTS = Object.freeze(["arrived", "checked_in", "cxo", "lunch", "evening"]);
const MEALS_OF_DAY = Object.freeze({
  day1: { cxo: "cxo_d1", lunch: "lunch_d1", dinner: "awards" },
  day2: { cxo: "cxo_d2", lunch: "lunch_d2", dinner: "gala" },
});
const MEAL_POINT = Object.freeze({ cxo: "cxo", lunch: "lunch", dinner: "evening" });
const MEAL_LABELS = Object.freeze({
  cxo_d1: "CxO Breakfast", cxo_d2: "CxO Breakfast", lunch_d1: "Networking Luncheon", lunch_d2: "Networking Luncheon",
  awards: "Catalyst Awards Night", gala: "Gala Dinner & Networking Reception",
});
const QUIET = { log: { warn() {} } };
const pct = (n, of) => (of > 0 ? Math.round((n * 100) / of) : null);
const ms = (d) => { const n = d ? new Date(d).getTime() : NaN; return Number.isFinite(n) ? n : NaN; };
const iso = (d) => (Number.isFinite(ms(d)) ? new Date(ms(d)).toISOString() : null);

/* Per directory copy: each person's group, counting passes, entitlements and RSVP'd meals (the Event summary's facts). */
const bases = new WeakMap();
function baseOf(people) {
  if (bases.has(people)) return bases.get(people);
  const info = new Map();
  const entitled = Object.fromEntries(SUMMARY_MEALS.map((m) => [m.key, new Set()]));
  const rsvpd = Object.fromEntries(SUMMARY_MEALS.map((m) => [m.key, new Set()]));
  const holders = Object.fromEntries(ATTENDANCE_GROUPS.map((g) => [g, 0]));
  let noPassPeople = 0;
  for (const p of people || []) {
    const f = summaryFacts(p);
    if (f) {
      const types = new Set(p.types || []);
      const tier = deskTier(f.main.type, QUIET).tier;
      const group = p.vip ? "vip" : types.has("media") ? "media" : types.has("speaker") || tier === "speaker" ? "speaker" : ATTENDANCE_GROUPS.includes(tier) ? tier : "other";
      info.set(p, { group, noPass: false, norms: new Set(f.passes.map((t) => t.norm || normalizeTicketId(t.ticketId))) });
      holders[group] += 1;
      for (const m of SUMMARY_MEALS) {
        if (f.entitled(m.extra)) entitled[m.key].add(p);
        if (f.options.has(m.key)) rsvpd[m.key].add(p);
      }
    } else if (noPassPerson(p)) {
      info.set(p, { group: null, noPass: true, norms: new Set() });
      noPassPeople += 1;
    }
  }
  const out = { info, entitled, rsvpd, holders, noPassPeople };
  if (people && typeof people === "object") bases.set(people, out);
  return out;
}

/**
 * Attendance by day. Pure.
 *   people, byId  the People directory (routes/people.js directory(): people, and id → person incl. "t-<ticket>")
 *   marks         CheckinMark rows ({ subject, day, point, at, override, practice })
 *   collected     the collected tickets: [{ norm (normalized ticket ID), at }]
 *   cards         NO DETAILS FOUND cards (services/checkinDesk.js unknownRows)
 * → { days: [{ day, date, label, long, arrived, checkedIn, passesCollectedToDate, meals: { cxo, lunch, dinner },
 *     byPass: { <group>: { label, people, arrived, checkedIn, cxo, lunch, dinner } }, issuePass: { people, arrived,
 *     issued, arrivedNoPass }, noDetails: { recorded, open, sentToHelp, passIssued, left, linked }, unmatched }], overall, groups,
 *     builtAt, peopleAt }
 */
export function attendanceFrom({ people = [], byId = new Map(), marks = [], collected = [], cards = [], peopleAt = null, now = new Date() } = {}) {
  const base = baseOf(people);
  // Whose mark: the directory's person (a pass's "t-<ticket ID>", an ISSUE PASS person's own id), else the subject itself.
  const personOf = (subject) => {
    const s = String(subject || "");
    if (!s || s.startsWith("booth:") || s.startsWith("u:")) return null;
    if (isPersonSubject(s)) return byId.get(s.slice("person:".length)) || s;
    return byId.get(`t-${s}`) || s;
  };
  const groupOf = (who) => {
    if (typeof who === "string") return "other";
    const inf = base.info.get(who);
    if (inf?.noPass) return null;
    return inf?.group || "other";
  };
  const anyDay = { arrived: new Set(), checkedIn: new Set() };
  const arrivedByDay = [];
  const checkedInSoFar = new Set(); // checked in on this day or an earlier event day (DAYS is in order)

  const days = DAYS.map((d) => {
    const pts = Object.fromEntries(ATTENDANCE_POINTS.map((k) => [k, new Map()]));
    const issue = new Set();
    const unmatched = new Set();
    for (const m of marks || []) {
      if (m?.day !== d.date || !m.at || m.practice) continue;
      const map = pts[m.point];
      if (!map) continue;
      const who = personOf(m.subject);
      if (!who) continue;
      if (typeof who === "string") unmatched.add(who);
      const have = map.get(who);
      if (!have || ms(m.at) < ms(have.at)) map.set(who, m);
      if (isPersonSubject(m.subject) && (m.point === "arrived" || m.point === "checked_in")) issue.add(who);
    }
    const arrived = new Set([...pts.arrived.keys(), ...pts.checked_in.keys()]);
    const checkedIn = new Set(pts.checked_in.keys());
    for (const w of arrived) anyDay.arrived.add(w);
    for (const w of checkedIn) anyDay.checkedIn.add(w);
    arrivedByDay.push(arrived);

    const meals = {};
    for (const [slot, option] of Object.entries(MEALS_OF_DAY[d.key])) {
      const admitted = pts[MEAL_POINT[slot]];
      const ent = base.entitled[option] || new Set();
      const rs = base.rsvpd[option] || new Set();
      let ofRsvpd = 0;
      let overrides = 0;
      let notEntitled = 0;
      for (const [who, m] of admitted) {
        if (rs.has(who)) ofRsvpd += 1;
        if (m.override) overrides += 1;
        if (!ent.has(who)) notEntitled += 1;
      }
      meals[slot] = {
        key: option, label: MEAL_LABELS[option], admitted: admitted.size, entitled: ent.size, rsvpd: rs.size, admittedOfRsvpd: ofRsvpd,
        pctOfRsvpd: pct(ofRsvpd, rs.size), noShows: rs.size - ofRsvpd, overrides, notRsvpdAdmitted: admitted.size - ofRsvpd, notEntitledAdmitted: notEntitled,
      };
    }

    const byPass = Object.fromEntries(ATTENDANCE_GROUPS.map((g) => [g, { label: ATTENDANCE_GROUP_LABELS[g], people: base.holders[g], arrived: 0, checkedIn: 0, cxo: 0, lunch: 0, dinner: 0 }]));
    const addAll = (set, field) => { for (const w of set) { const g = groupOf(w); if (g) byPass[g][field] += 1; } };
    addAll(arrived, "arrived");
    addAll(checkedIn, "checkedIn");
    addAll(pts.cxo.keys(), "cxo");
    addAll(pts.lunch.keys(), "lunch");
    addAll(pts.evening.keys(), "dinner");

    for (const w of checkedIn) checkedInSoFar.add(w);
    const passes = new Set();
    for (const c of collected || []) {
      const date = c?.at ? torontoDate(c.at) : "";
      if (date && date > d.date) continue;
      const p = byId.get(`t-${c?.norm}`);
      const inf = p && base.info.get(p);
      if (!inf || inf.noPass || !inf.norms.has(c.norm)) continue;
      // Collected before Day 1: a rehearsal door scan (the door keeps the first scan's time), not a pass handed over;
      // it counts once they're checked in on an event day, never before (someone scanned at a rehearsal who never came).
      if (date && date < DAYS[0].date && !checkedInSoFar.has(p)) continue;
      passes.add(p);
    }

    const dayCards = (cards || []).filter((u) => u?.day === d.date && !u.practice);
    const count = (st) => dayCards.filter((u) => u.status === st).length;
    return {
      day: d.key, date: d.date, label: d.label, long: d.long,
      arrived: arrived.size, checkedIn: checkedIn.size, passesCollectedToDate: passes.size,
      meals, byPass,
      issuePass: {
        people: base.noPassPeople, arrived: issue.size, issued: [...issue].filter((w) => checkedIn.has(w)).length,
        arrivedNoPass: [...arrived].filter((w) => groupOf(w) === null).length,
      },
      noDetails: { recorded: dayCards.length, open: count("open"), sentToHelp: count("sent_to_help"), passIssued: count("pass_issued"), left: count("left"), linked: count("linked") },
      // Marks whose pass or person isn't in the directory any more (deleted since): counted, under "other".
      unmatched: unmatched.size,
    };
  });
  const both = [...(arrivedByDay[0] || [])].filter((w) => arrivedByDay[1]?.has(w)).length;
  return {
    days,
    overall: { arrived: anyDay.arrived.size, checkedIn: anyDay.checkedIn.size, bothDays: both },
    groups: ATTENDANCE_GROUPS.map((key) => ({ key, label: ATTENDANCE_GROUP_LABELS[key] })),
    practiceExcluded: true,
    builtAt: iso(now),
    peopleAt: iso(peopleAt),
  };
}

/**
 * Attendance now, for a directory copy (routes/people.js directory(), or the desk index's): the desk's marks for Day 1
 * and Day 2 (practice marks left out), every collected ticket, and the NO DETAILS FOUND cards, read now.
 */
export async function loadAttendance(dir, { now = deskNow() } = {}) {
  const dates = DAYS.map((d) => d.date);
  const [marks, attendees, users, arrivals] = await Promise.all([
    CheckinMark.find({ day: { $in: dates }, point: { $in: ATTENDANCE_POINTS }, at: { $ne: null }, practice: { $ne: true } }).select("subject day point at override practice").lean(),
    Attendee.find({ checkedIn: true }).select("ticketId checkedInAt").lean(),
    User.aggregate([
      { $match: { "tickets.checkedIn": true } }, { $unwind: "$tickets" }, { $match: { "tickets.checkedIn": true } },
      { $project: { _id: 0, ticketId: "$tickets.ticketId", at: "$tickets.checkedInAt" } },
    ]),
    CheckinEvent.find({ kind: "unknown_arrival", day: { $in: dates } }).sort({ seq: 1 }).limit(3000).lean(),
  ]);
  const after = arrivals.length
    ? await CheckinEvent.find({ kind: { $in: ["undo", "unknown_done", "unknown_link"] }, subject: { $in: arrivals.map((e) => unknownKeyOf(e.clientId)) } }).sort({ seq: 1 }).lean()
    : [];
  const collected = [
    ...attendees.map((a) => ({ norm: normalizeTicketId(a.ticketId), at: a.checkedInAt || null })),
    ...users.map((u) => ({ norm: normalizeTicketId(u.ticketId), at: u.at || null })),
  ];
  return attendanceFrom({
    people: dir?.people || [], byId: dir?.byId || new Map(), marks, collected, cards: unknownRows(arrivals, after), peopleAt: dir?.builtAt || null, now,
  });
}
