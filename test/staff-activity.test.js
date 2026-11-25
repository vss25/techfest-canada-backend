/* Staff activity (Settings › Staff activity): the pure rules in services/staffActivity.js. No database. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  creditFor, isPanelEdit, localParts, rangeOf, sessionStatus, summarize, validTz, IDLE_SECONDS, CREDIT_CAP_SECONDS,
} from "../services/staffActivity.js";

const T = (s) => new Date(s);

test("creditFor: the gap, capped at 2 minutes; past 15 idle minutes nothing (a new session)", () => {
  assert.equal(creditFor(T("2026-11-24T14:00:00Z"), T("2026-11-24T14:01:00Z")), 60);
  assert.equal(creditFor(T("2026-11-24T14:00:00Z"), T("2026-11-24T14:10:00Z")), CREDIT_CAP_SECONDS);
  assert.equal(creditFor(T("2026-11-24T14:00:00Z"), new Date(T("2026-11-24T14:00:00Z").getTime() + IDLE_SECONDS * 1000)), CREDIT_CAP_SECONDS);
  assert.equal(creditFor(T("2026-11-24T14:00:00Z"), T("2026-11-24T14:15:01Z")), null);
  assert.equal(creditFor(T("2026-11-24T14:00:10Z"), T("2026-11-24T14:00:00Z")), 0, "clock skew never goes negative");
  assert.equal(creditFor("nonsense", T("2026-11-24T14:00:00Z")), null);
});

test("isPanelEdit: successful staff-panel writes from a browser, not searches, previews or pings", () => {
  const req = (method, url, extra = {}) => ({ method, originalUrl: url, staffPanel: true, headers: { origin: "https://www.thetechfestival.com" }, ...extra });
  assert.equal(isPanelEdit(req("PATCH", "/api/console/people/u-1"), 200), true);
  assert.equal(isPanelEdit(req("DELETE", "/api/console/commitments/1"), 204), true);
  assert.equal(isPanelEdit(req("POST", "/api/cms/speaker?draft=1"), 201), true);
  assert.equal(isPanelEdit(req("GET", "/api/console/people"), 200), false, "reads");
  assert.equal(isPanelEdit(req("PATCH", "/api/console/people/u-1"), 409), false, "refused");
  assert.equal(isPanelEdit(req("POST", "/api/console/search"), 200), false, "search");
  assert.equal(isPanelEdit(req("POST", "/api/console/purchase-email/preview"), 200), false, "preview");
  assert.equal(isPanelEdit(req("POST", "/api/admin/staff-activity/ping"), 204), false, "our ping");
  assert.equal(isPanelEdit(req("PATCH", "/api/x", { staffPanel: false }), 200), false, "not a requireAdmin route");
  assert.equal(isPanelEdit(req("PATCH", "/api/x", { headers: {} }), 200), false, "native app (no Origin)");
});

test("localParts: the local day and hour (Toronto, DST aware)", () => {
  assert.deepEqual(localParts(T("2026-11-24T03:30:00Z"), "America/Toronto"), { date: "2026-11-23", hour: 22 });
  assert.deepEqual(localParts(T("2026-07-01T04:00:00Z"), "America/Toronto"), { date: "2026-07-01", hour: 0 });
  assert.deepEqual(localParts(T("2026-11-24T08:00:00Z"), "America/Vancouver"), { date: "2026-11-24", hour: 0 });
  assert.equal(validTz("America/Toronto"), true);
  assert.equal(validTz("Mars/Olympus"), false);
});

test("rangeOf: last 7 days by default, at most 31, YYYY-MM-DD only", () => {
  const now = T("2026-11-24T15:00:00Z");
  const r = rangeOf({ tz: "America/Toronto", now });
  assert.equal(r.to, "2026-11-24");
  assert.equal(r.from, "2026-11-18");
  assert.ok(r.start < T("2026-11-18T05:00:00Z") && r.end > T("2026-11-25T05:00:00Z"));
  assert.equal(rangeOf({ from: "2026-11-01", to: "2026-11-30", tz: "UTC", now }).from, "2026-11-01");
  assert.match(rangeOf({ from: "2026-10-01", to: "2026-11-30", tz: "UTC", now }).error, /31/);
  assert.match(rangeOf({ from: "2026-11-30", to: "2026-11-01", tz: "UTC", now }).error, /before/);
  assert.match(rangeOf({ from: "nov 1", tz: "UTC", now }).error, /YYYY-MM-DD/);
});

test("sessionStatus: active, idle once 15 minutes pass, signout", () => {
  const now = T("2026-11-24T15:00:00Z");
  assert.equal(sessionStatus({ lastSeenAt: T("2026-11-24T14:50:00Z") }, now), "active");
  assert.equal(sessionStatus({ lastSeenAt: T("2026-11-24T14:40:00Z") }, now), "idle");
  assert.equal(sessionStatus({ endedAt: now, endReason: "signout", lastSeenAt: now }, now), "signout");
});

test("summarize: sessions on their local start day, time / pages / edits per day and per hour, everyone listed", () => {
  const ana = { _id: "a1", name: "Ana Admin", email: "ana@example.com" };
  const ben = { _id: "b1", name: "Ben Busy", email: "ben@example.com" };
  const cal = { _id: "c1", name: "Cal Quiet", email: "cal@example.com" };
  const sessions = [
    { _id: "s1", userId: "a1", startedAt: T("2026-11-23T14:00:00Z"), lastSeenAt: T("2026-11-23T15:30:00Z"), endedAt: T("2026-11-23T15:30:00Z"), endReason: "signout", via: "sign-in", activeSeconds: 3000, pageViews: 12, edits: 3 },
    { _id: "s2", userId: "a1", startedAt: T("2026-11-24T02:00:00Z"), lastSeenAt: T("2026-11-24T02:20:00Z"), endedAt: null, activeSeconds: 600, pageViews: 2, edits: 0 }, // 9 PM Nov 23 Toronto
    { _id: "s3", userId: "b1", startedAt: T("2026-11-24T13:00:00Z"), lastSeenAt: T("2026-11-24T14:59:00Z"), endedAt: null, activeSeconds: 6000, pageViews: 40, edits: 9 },
    { _id: "old", userId: "b1", startedAt: T("2026-11-01T13:00:00Z"), lastSeenAt: T("2026-11-01T13:10:00Z"), endedAt: null, activeSeconds: 600 },
  ];
  const hours = [
    { userId: "a1", hour: T("2026-11-23T14:00:00Z"), pageViews: 8, edits: 2, activeSeconds: 2000 },
    { userId: "a1", hour: T("2026-11-23T15:00:00Z"), pageViews: 4, edits: 1, activeSeconds: 1000 },
    { userId: "a1", hour: T("2026-11-24T02:00:00Z"), pageViews: 2, edits: 0, activeSeconds: 600 },
    { userId: "b1", hour: T("2026-11-24T13:00:00Z"), pageViews: 25, edits: 4, activeSeconds: 3500 },
    { userId: "b1", hour: T("2026-11-24T14:00:00Z"), pageViews: 15, edits: 5, activeSeconds: 2500 },
  ];
  const staff = summarize({ users: [cal, ana, ben], sessions, hours, tz: "America/Toronto", from: "2026-11-18", to: "2026-11-24", now: T("2026-11-24T15:00:00Z") });
  assert.deepEqual(staff.map((s) => s.name), ["Ben Busy", "Ana Admin", "Cal Quiet"], "most time first; people with none still listed");

  const a = staff[1];
  assert.equal(a.days.length, 1, "both of Ana's sessions are Nov 23 in Toronto");
  assert.equal(a.days[0].date, "2026-11-23");
  assert.equal(a.days[0].sessions.length, 2);
  assert.deepEqual(a.days[0].sessions.map((s) => s.status), ["signout", "idle"]);
  assert.equal(String(a.days[0].sessions[1].endedAt), String(T("2026-11-24T02:20:00Z")), "idle session ends at its last activity");
  assert.equal(a.days[0].activeSeconds, 3600);
  assert.deepEqual(a.days[0].hours.map((h) => h.hour), [9, 10, 21]);
  assert.deepEqual(a.totals, { activeSeconds: 3600, pageViews: 14, edits: 3, sessions: 2 });

  const b = staff[0];
  assert.equal(b.days[0].sessions[0].status, "active");
  assert.equal(b.totals.sessions, 1, "the Nov 1 session is outside the range");
  assert.deepEqual(b.days[0].hours, [{ hour: 8, activeSeconds: 3500, pageViews: 25, edits: 4 }, { hour: 9, activeSeconds: 2500, pageViews: 15, edits: 5 }]);
  assert.deepEqual(staff[2].days, []);
  assert.equal(staff[2].lastSeenAt, null);
});
