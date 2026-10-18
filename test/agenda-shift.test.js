import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import {
  DEFAULT_STAGE, LATEST_MINUTE, fromMinutes, planShift, readShift, sameStage, shiftSummary, stageOf, toMinutes,
} from "../services/agendaShift.js";
import { AdminAudit } from "../models/Admin.js";
import User from "../models/User.js";
import cmsRouter from "../routes/cms.js";

/* ---------- helpers ---------- */
const S = (id, day, time, endTime, extra = {}) => ({ _id: id, _rev: `r-${id}`, title: id.toUpperCase(), day, time, endTime, ...extra });

/** Apply a plan's patches to a copy of the sessions, the way Sanity would. */
const apply = (sessions, plan) => sessions.map((s) => {
  const c = plan.changes.find((x) => x._id === s._id);
  return c ? { ...s, ...c.set } : s;
});
const times = (sessions) => Object.fromEntries(sessions.map((s) => [s._id, `${s.time ?? ""}-${s.endTime ?? ""}`]));
const ids = (plan) => plan.changes.map((c) => c._id);

const DAY1 = [
  S("open", 1, "09:00", "09:15"),
  S("keynote", 1, "09:15", "09:45"),                                   // the one running late
  S("fireside", 1, "09:45", "10:15"),                                  // back to back
  S("break", 1, "10:15", "10:30", { isBreak: true }),
  S("panel", 1, "10:30", "11:15", { stage: "  " }),                    // blank stage = default stage
  S("pillar1", 1, "10:00", "10:30", { stage: "Pillar Stage 1" }),
  S("pillar2", 1, "11:00", "11:30", { stage: "Pillar Stage 1" }),
  S("notime", 1, "", "", {}),
  S("d2", 2, "10:00", "10:30"),
];

/* ---------- small parts ---------- */
test("times parse and format as HH:mm", () => {
  assert.equal(toMinutes("09:30"), 570);
  assert.equal(toMinutes("9:05"), 545);
  assert.equal(toMinutes("00:00"), 0);
  assert.equal(toMinutes("23:59"), 1439);
  for (const bad of ["", null, undefined, "24:00", "9:5", "12:60", "noon", "10:30:00"]) assert.equal(toMinutes(bad), null, String(bad));
  assert.equal(fromMinutes(545), "09:05");
  assert.equal(fromMinutes(LATEST_MINUTE), "23:55");
});

test("stages: empty means the apps' default stage, compared loosely", () => {
  assert.equal(stageOf(""), DEFAULT_STAGE);
  assert.equal(stageOf(undefined), DEFAULT_STAGE);
  assert.equal(stageOf("  Pillar  Stage 1 "), "Pillar Stage 1");
  assert.ok(sameStage("", "Centre Stage · Harbour Ballroom"));
  assert.ok(sameStage(null, "  centre stage ·  harbour ballroom"));
  assert.ok(!sameStage("", "Pillar Stage 1"));
});

test("minutes must be a whole, non-zero multiple of 5 within ±60; scope stage or day", () => {
  for (const ok of [5, -5, 10, 30, 60, -60, "15", " -10 "]) assert.equal(readShift({ minutes: ok }).error, undefined, String(ok));
  for (const bad of [0, 3, 7, -12, 65, -65, 2.5, "", "ten", null, undefined, true, [5], NaN, Infinity]) {
    assert.match(readShift({ minutes: bad }).error, /between -60 and \+60 minutes, in steps of 5/, String(bad));
  }
  assert.equal(readShift({ minutes: 5 }).scope, "stage");
  assert.equal(readShift({ minutes: 5, scope: null }).scope, "stage");
  assert.equal(readShift({ minutes: 5, scope: "day" }).scope, "day");
  assert.match(readShift({ minutes: 5, scope: "week" }).error, /stage.*day/);
  assert.equal(readShift({ minutes: "10" }).minutes, 10);
});

/* ---------- planShift ---------- */
test("stage scope: the late session's end moves, its start stays; later sessions on the same stage move both times", () => {
  const plan = planShift(DAY1, "keynote", 10, "stage");
  assert.equal(plan.error, undefined);
  assert.deepEqual(ids(plan), ["keynote", "fireside", "break", "panel"]);
  assert.deepEqual(plan.changes[0].set, { endTime: "09:55" });
  assert.equal(plan.changes[0].time, "09:15");
  assert.deepEqual(plan.changes[1].set, { time: "09:55", endTime: "10:25" });      // back to back: starts at the old end, so it moves
  assert.deepEqual(plan.changes[1].from, { time: "09:45", endTime: "10:15" });
  assert.equal(plan.changes[1]._rev, "r-fireside");
  const after = times(apply(DAY1, plan));
  assert.equal(after.open, "09:00-09:15");                                          // before it: untouched
  assert.equal(after.break, "10:25-10:40");                                         // breaks move too
  assert.equal(after.panel, "10:40-11:25");                                         // blank stage = same (default) stage
  assert.equal(after.pillar1, "10:00-10:30");                                       // other stage: untouched
  assert.equal(after.pillar2, "11:00-11:30");
  assert.equal(after.d2, "10:00-10:30");                                            // other day: untouched
  assert.equal(after.notime, "-");                                                  // no time: ignored
  assert.equal(plan.day, 1);
  assert.equal(plan.stage, DEFAULT_STAGE);
});

test("day scope moves every stage that day, but only sessions starting at or after the original end", () => {
  const plan = planShift(DAY1, "keynote", 15, "day");
  assert.deepEqual(ids(plan), ["keynote", "fireside", "pillar1", "break", "panel", "pillar2"]);
  const after = times(apply(DAY1, plan));
  assert.equal(after.pillar1, "10:15-10:45");
  assert.equal(after.pillar2, "11:15-11:45");
  assert.equal(after.open, "09:00-09:15");
  assert.equal(after.d2, "10:00-10:30");
});

test("a session that starts before the late one ends (overlap) is not moved", () => {
  const xs = [S("a", 1, "10:00", "10:30"), S("overlap", 1, "10:20", "10:50"), S("b", 1, "10:30", "11:00")];
  assert.deepEqual(ids(planShift(xs, "a", 5)), ["a", "b"]);
});

test("the session on a named stage only moves its own stage", () => {
  const plan = planShift(DAY1, "pillar1", 5, "stage");
  assert.deepEqual(ids(plan), ["pillar1", "pillar2"]);
  assert.equal(plan.stage, "Pillar Stage 1");
});

test("missing stage on the late session matches the default stage, named or blank", () => {
  const xs = [
    S("a", 1, "09:00", "09:30"),                                                    // no stage at all
    S("named", 1, "09:30", "10:00", { stage: DEFAULT_STAGE }),
    S("blank", 1, "10:00", "10:30", { stage: "" }),
    S("other", 1, "09:30", "10:00", { stage: "Pillar Stage 2" }),
  ];
  assert.deepEqual(ids(planShift(xs, "a", 10)), ["a", "named", "blank"]);
  assert.deepEqual(ids(planShift(xs, "named", 10)), ["named", "blank"]);
});

test("negative shifts: pulling earlier works until the late session would end at or before its start", () => {
  const xs = [S("short", 1, "10:00", "10:10"), S("next", 1, "10:10", "10:40")];
  const ok = planShift(xs, "short", -5);
  assert.deepEqual(times(apply(xs, ok)), { short: "10:00-10:05", next: "10:05-10:35" });
  const bad = planShift(xs, "short", -10);
  assert.equal(bad.status, 400);
  assert.match(bad.error, /"SHORT" would end at or before its start \(10:00\)/);
  assert.match(planShift(xs, "short", -15).error, /at or before its start/);
});

test("midnight: nothing may run past 23:55 or start before 00:00", () => {
  const late = [S("gala", 1, "22:00", "23:30"), S("after", 1, "23:30", "23:50")];
  assert.deepEqual(times(apply(late, planShift(late, "gala", 5))), { gala: "22:00-23:35", after: "23:35-23:55" });   // 23:55 itself is fine
  const past = planShift(late, "gala", 10);
  assert.equal(past.status, 400);
  assert.match(past.error, /"AFTER" would run past 23:55/);
  const alone = [S("end", 1, "23:00", "23:50")];
  assert.equal(planShift(alone, "end", 5).changes[0].endTime, "23:55");
  assert.match(planShift(alone, "end", 10).error, /"END" would run past 23:55/);
  const noEnd = [S("a", 1, "23:00", "23:30"), S("b", 1, "23:50", "")];
  assert.match(planShift(noEnd, "a", 10).error, /"B" would run past 23:55/);              // start alone past 23:55

  // Early morning: later sessions start at or after the late one's end, so while it keeps a length they stay after 00:00.
  const early = [S("first", 1, "00:00", "00:20"), S("second", 1, "00:20", "00:30")];
  assert.deepEqual(times(apply(early, planShift(early, "first", -15))), { first: "00:00-00:05", second: "00:05-00:15" });
  assert.match(planShift(early, "first", -20).error, /at or before its start \(00:00\)/);
});

test("sessions without a start time are ignored; the late session needs both times", () => {
  const xs = [S("a", 1, "10:00", "10:30"), S("b", 1, "", "11:00"), S("c", 1, null, null), S("d", 1, "11:00", "")];
  const plan = planShift(xs, "a", 5);
  assert.deepEqual(ids(plan), ["a", "d"]);
  assert.deepEqual(plan.changes[1].set, { time: "11:05" });                           // no end time: only the start moves
  assert.equal(plan.changes[1].endTime, "");
  assert.match(planShift(xs, "b", 5).error, /"B" has no start time/);
  assert.match(planShift(xs, "d", 5).error, /"D" has no end time/);
  assert.equal(planShift(xs, "b", 5).status, 400);
});

test("unknown session → 404; bad minutes or scope → 400", () => {
  assert.equal(planShift(DAY1, "nope", 5).status, 404);
  assert.equal(planShift(DAY1, "keynote", 7).status, 400);
  assert.equal(planShift(DAY1, "keynote", 5, "week").status, 400);
  assert.equal(planShift(null, "keynote", 5).status, 404);
});

test("times like 9:05 come back as 09:05", () => {
  const xs = [S("a", 1, "9:00", "9:30"), S("b", 1, "9:30", "9:55")];
  const plan = planShift(xs, "a", 10);
  assert.deepEqual(plan.changes.map((c) => c.set), [{ endTime: "09:40" }, { time: "09:40", endTime: "10:05" }]);
});

test("undo (same id and scope, opposite minutes) puts every time back, for later and earlier shifts", () => {
  for (const scope of ["stage", "day"]) {
    for (const m of [5, 10, 30, 60, -5, -10, -15]) {
      const first = planShift(DAY1, "keynote", m, scope);
      assert.equal(first.error, undefined, `${scope} ${m}`);
      const shifted = apply(DAY1, first);
      const only = ids(first).slice(1);
      const back = planShift(shifted, "keynote", -m, scope, { only });
      assert.equal(back.error, undefined, `undo ${scope} ${m}`);
      assert.deepEqual(ids(back), ids(first), `${scope} ${m}`);
      assert.deepEqual(times(apply(shifted, back)), times(DAY1), `${scope} ${m}`);
    }
  }
});

test("why undo sends `only`: a negative day shift can pull sessions past a parallel one", () => {
  const xs = [
    S("x", 1, "10:00", "10:30"),
    S("parallel", 1, "10:25", "10:55", { stage: "Room B" }),                        // starts before x ends: stays put
    S("next", 1, "10:30", "11:00", { stage: "Room B" }),
  ];
  const first = planShift(xs, "x", -10, "day");
  assert.deepEqual(ids(first), ["x", "next"]);
  const shifted = apply(xs, first);                                                // x ends 10:20, next starts 10:20
  const naive = planShift(shifted, "x", 10, "day");                                // would also catch "parallel" (10:25 ≥ 10:20)
  assert.deepEqual(ids(naive), ["x", "next", "parallel"]);
  const back = planShift(shifted, "x", 10, "day", { only: ids(first).slice(1) });
  assert.deepEqual(times(apply(shifted, back)), times(xs));
  // `only` can only narrow the rule, never move a session that isn't after the late one
  assert.deepEqual(ids(planShift(xs, "x", 5, "day", { only: ["parallel", "next"] })), ["x", "next"]);
  assert.deepEqual(ids(planShift(xs, "x", 5, "day", { only: [] })), ["x"]);
});

test("audit summary", () => {
  assert.equal(shiftSummary(planShift(DAY1, "keynote", 10)), `"KEYNOTE" +10 min, ${DEFAULT_STAGE}, 4 sessions`);
  assert.equal(shiftSummary(planShift(DAY1, "keynote", -5, "day")), `"KEYNOTE" -5 min, all stages on Day 1, 6 sessions`);
  assert.equal(shiftSummary(planShift([S("solo", 2, "10:00", "10:30")], "solo", 5)), `"SOLO" +5 min, ${DEFAULT_STAGE}, 1 session`);
});

/* ---------- route: POST /api/cms/session/shift (Sanity mocked) ---------- */
process.env.JWT_SECRET = "test-secret";
process.env.SANITY_WRITE_TOKEN = "test-token-not-real";
const realFetch = globalThis.fetch;
let docs = [];
let calls = [];
let mutateReply = null;                                       // null → 200 OK; or { status, body }
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(String(input));
  if (u.hostname === "127.0.0.1") return realFetch(input, init);
  if (!u.hostname.endsWith(".api.sanity.io")) throw new Error(`Unexpected network call in test: ${u.hostname}`);
  calls.push({ path: u.pathname, query: u.searchParams.get("query"), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.Authorization });
  if (u.pathname.includes("/data/query/")) return new Response(JSON.stringify({ result: docs }), { status: 200 });
  if (u.pathname.includes("/data/mutate/")) {
    if (mutateReply) return new Response(JSON.stringify(mutateReply.body), { status: mutateReply.status });
    return new Response(JSON.stringify({ transactionId: "t1", results: [] }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
};
const audits = [];
AdminAudit.create = async (doc) => { audits.push(doc); return doc; };
let currentUser = { _id: "u1", name: "Nicole", role: "admin", staffRole: "staff", email: "nicole@thetechfestival.com" };
User.findById = async () => currentUser;

const app = express();
app.use(express.json());
app.use("/api/cms", cmsRouter);
const server = app.listen(0);
after(() => { server.close(); globalThis.fetch = realFetch; });
const auth = { Authorization: `Bearer ${jwt.sign({ id: "u1" }, "test-secret")}`, "Content-Type": "application/json" };
const shift = (body, headers = auth) =>
  realFetch(`http://127.0.0.1:${server.address().port}/api/cms/session/shift`, { method: "POST", headers, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
const mutations = () => calls.filter((c) => c.path.includes("/data/mutate/"));

beforeEach(() => {
  docs = DAY1.map((d) => ({ ...d }));
  calls = []; audits.length = 0; mutateReply = null;
  currentUser = { _id: "u1", name: "Nicole", role: "admin", staffRole: "staff", email: "nicole@thetechfestival.com" };
});

test("route: staff (not just management) can shift; one transaction with revision checks; one audit entry", async () => {
  const r = await shift({ id: "keynote", minutes: 10 });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.scope, "stage");
  assert.equal(r.body.minutes, 10);
  assert.deepEqual(r.body.moved, [
    { _id: "keynote", title: "KEYNOTE", time: "09:15", endTime: "09:55" },
    { _id: "fireside", title: "FIRESIDE", time: "09:55", endTime: "10:25" },
    { _id: "break", title: "BREAK", time: "10:25", endTime: "10:40" },
    { _id: "panel", title: "PANEL", time: "10:40", endTime: "11:25" },
  ]);
  const m = mutations();
  assert.equal(m.length, 1, "exactly one mutate call (one transaction)");
  assert.equal(m[0].method, "POST");
  assert.equal(m[0].auth, "Bearer test-token-not-real");
  assert.deepEqual(m[0].body.mutations, [
    { patch: { id: "keynote", ifRevisionID: "r-keynote", set: { endTime: "09:55" } } },
    { patch: { id: "fireside", ifRevisionID: "r-fireside", set: { time: "09:55", endTime: "10:25" } } },
    { patch: { id: "break", ifRevisionID: "r-break", set: { time: "10:25", endTime: "10:40" } } },
    { patch: { id: "panel", ifRevisionID: "r-panel", set: { time: "10:40", endTime: "11:25" } } },
  ]);
  const q = calls.find((c) => c.path.includes("/data/query/"));
  assert.match(q.query, /_type == "session"/);
  assert.match(q.query, /drafts/);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "cms_agenda_shift");
  assert.equal(audits[0].targetType, "cms:session");
  assert.equal(audits[0].targetId, "keynote");
  assert.equal(audits[0].adminName, "Nicole");
  assert.equal(audits[0].detail, `"KEYNOTE" +10 min, ${DEFAULT_STAGE}, 4 sessions`);
});

test("route: day scope and undo with only", async () => {
  const r = await shift({ id: "keynote", minutes: -10, scope: "day" });
  assert.equal(r.status, 200);
  assert.equal(r.body.moved.length, 6);
  const moved = r.body.moved.map((x) => x._id);
  docs = apply(docs, { changes: r.body.moved.map((x) => ({ _id: x._id, set: { time: x.time, endTime: x.endTime } })) });
  calls = [];
  const u = await shift({ id: "keynote", minutes: 10, scope: "day", only: moved.slice(1) });
  assert.equal(u.status, 200);
  assert.deepEqual(u.body.moved.map((x) => x._id), moved);
  docs = apply(docs, { changes: u.body.moved.map((x) => ({ _id: x._id, set: { time: x.time, endTime: x.endTime } })) });
  assert.deepEqual(times(docs), times(DAY1));
});

test("route: bad input is refused before Sanity is touched", async () => {
  for (const body of [{ minutes: 10 }, { id: "", minutes: 10 }, { id: 5, minutes: 10 }, { id: "keynote", minutes: 7 },
    { id: "keynote", minutes: 0 }, { id: "keynote", minutes: 90 }, { id: "keynote", minutes: 10, scope: "all" },
    { id: "keynote", minutes: 10, only: "fireside" }, { id: "keynote", minutes: 10, only: [1, 2] }]) {
    const r = await shift(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok(r.body.error);
  }
  assert.equal(calls.length, 0);
  assert.equal(audits.length, 0);
});

test("route: impossible shifts and unknown sessions don't write anything", async () => {
  docs.push(S("late", 1, "23:00", "23:50"));
  let r = await shift({ id: "late", minutes: 10 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /"LATE" would run past 23:55/);
  r = await shift({ id: "open", minutes: -15 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /at or before its start/);
  r = await shift({ id: "drafts.keynote", minutes: 10 });
  assert.equal(r.status, 404);
  assert.equal(mutations().length, 0);
  assert.equal(audits.length, 0);
});

test("route: an edit in between (revision conflict) fails the whole shift with a readable message", async () => {
  mutateReply = { status: 409, body: { error: { description: 'Document "fireside" has unexpected revision ID', type: "mutationError" } } };
  const r = await shift({ id: "keynote", minutes: 5 });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /changed while you were shifting it. Nothing was moved/);
  assert.equal(audits.length, 0);
});

test("route: needs a staff sign-in and the Sanity token", async () => {
  let r = await shift({ id: "keynote", minutes: 5 }, { "Content-Type": "application/json" });
  assert.equal(r.status, 401);
  currentUser = { _id: "u2", role: "user" };
  r = await shift({ id: "keynote", minutes: 5 });
  assert.equal(r.status, 403);
  currentUser = { _id: "u1", name: "Nicole", role: "admin", staffRole: "staff" };
  const saved = process.env.SANITY_WRITE_TOKEN;
  delete process.env.SANITY_WRITE_TOKEN;
  try {
    r = await shift({ id: "keynote", minutes: 5 });
    assert.equal(r.status, 503);
  } finally { process.env.SANITY_WRITE_TOKEN = saved; }
  assert.equal(calls.length, 0);
});
