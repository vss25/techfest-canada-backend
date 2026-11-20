import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanChannel, cleanItem, itemStatus, mapHeaders, parseDay, planVsActual, rowsToItems } from "../services/contentCalendar.js";

test("dates as people type them in a sheet", () => {
  assert.equal(parseDay("2026-11-23"), "2026-11-23");
  assert.equal(parseDay("11/23/2026"), "2026-11-23");   // month first
  assert.equal(parseDay("23/11/2026"), "2026-11-23");   // a day over 12 can only be day first
  assert.equal(parseDay("Nov 23, 2026"), "2026-11-23");
  assert.equal(parseDay("23 November 2026"), "2026-11-23");
  assert.equal(parseDay("December 1", { year: 2026 }), "2026-12-01");
  assert.equal(parseDay(46349), "2026-11-23");          // Excel's day number
  assert.equal(parseDay(new Date("2026-11-23T00:00:00Z")), "2026-11-23");
  assert.equal(parseDay("2026-02-30"), ""); assert.equal(parseDay("soon"), ""); assert.equal(parseDay(""), "");
});

test("channels from loose words; items need a title and a real date; links must be links", () => {
  assert.equal(cleanChannel("linkedin, instagram"), "LinkedIn"); assert.equal(cleanChannel("Newsletter"), "Email"); assert.equal(cleanChannel("TikTok"), "Other");
  assert.match(cleanItem({ date: "2026-11-23" }, { creating: true }).error, /title/);
  assert.match(cleanItem({ title: "x", date: "nope" }, { creating: true }).error, /date/);
  assert.match(cleanItem({ doneUrl: "javascript:alert(1)" }).error, /link/);
  assert.deepEqual(cleanItem({ doneDate: "" }).set, { doneDate: "" });
  assert.deepEqual(cleanItem({ doneDate: "Nov 24 2026", doneUrl: "https://linkedin.com/posts/x" }).set, { doneDate: "2026-11-24", doneUrl: "https://linkedin.com/posts/x" });
});

test("a sheet becomes items: headers by name, blank lines ignored, bad rows reported with their row number", () => {
  assert.deepEqual(mapHeaders(["Planned date", "Post", "Platform", "Partner", "Random"]), { date: 0, title: 1, channel: 2, by: 3 });
  const out = rowsToItems([
    ["Date", "Title", "Channel", "By", "Done date", "Link"],
    ["2026-11-23", "Vancouver tickets on sale", "LinkedIn", "", "", ""],
    ["", "", "", "", "", ""],
    ["Nov 25 2026", "Partner announcement", "linkedin", "Fraser Basin Hydro", "Nov 26 2026", "https://linkedin.com/posts/y"],
    ["someday", "No date", "X", "", "", ""],
  ]);
  assert.equal(out.error, null);
  assert.equal(out.items.length, 2);
  assert.deepEqual(out.items[1], { channel: "LinkedIn", by: "Fraser Basin Hydro", title: "Partner announcement", date: "2026-11-25", doneDate: "2026-11-26", doneUrl: "https://linkedin.com/posts/y" });
  assert.deepEqual(out.skipped.map((s) => s.row), [5]);
  assert.match(rowsToItems([["When it happens", "Stuff"], ["a", "b"]]).error, /Date column/);
  assert.match(rowsToItems([["Date", "Title"]]).error, /header row/);
});

test("planned vs executed", () => {
  const T = "2026-11-24";
  assert.equal(itemStatus({ date: "2026-11-23", doneDate: "2026-11-23" }, T), "done");
  assert.equal(itemStatus({ date: "2026-11-23", doneDate: "2026-11-25" }, T), "late");
  assert.equal(itemStatus({ date: "2026-11-23", doneDate: "" }, T), "missed");
  assert.equal(itemStatus({ date: T, doneDate: "" }, T), "planned");
  assert.deepEqual(planVsActual([{ date: "2026-11-23", doneDate: "2026-11-23" }, { date: "2026-11-20" }, { date: "2026-11-30" }], T), { planned: 3, done: 1, late: 0, missed: 1, ahead: 1 });
});
