import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays, cleanCommitment, cleanFlag, commitmentDTO, dueState, flagEmail, reminderEmail, reminderFor, sortForList, torontoDay,
} from "../services/commitments.js";

const T = "2026-11-20"; // a Friday

test("today is the Toronto day; days add across months", () => {
  assert.equal(torontoDay(new Date("2026-11-21T03:30:00Z")), "2026-11-20");
  assert.equal(addDays("2026-11-28", 7), "2026-12-05");
});

test("cleaning: a title is needed, dates are real days, areas from the list, only sent keys change", () => {
  assert.match(cleanCommitment({}, { creating: true }).error, /what needs doing/i);
  assert.match(cleanCommitment({ title: "x", dueDate: "2026-02-30" }).error, /date/);
  assert.match(cleanCommitment({ area: "finance" }).error, /area/);
  const ok = cleanCommitment({ title: "  Send   the MOU ", dueDate: "2026-12-01", area: "partners", eventKey: "TTFC-2027 Van!", about: "Northline" });
  assert.deepEqual(ok.set, { title: "Send the MOU", dueDate: "2026-12-01", area: "partners", eventKey: "ttfc-2027van", about: "Northline" });
  assert.deepEqual(cleanCommitment({ notes: "a\r\nb" }).set, { notes: "a\nb" });
  assert.match(cleanFlag({ note: " " }).error, /what's wrong/);
  assert.equal(cleanFlag({ note: "Venue deposit unpaid", severity: "nope" }).flag.severity, "at_risk");
});

test("where a task stands, and the list order: flags, overdue, today, soon, later, no date, done", () => {
  const mk = (id, o) => ({ _id: id, title: id, status: "open", dueDate: "", ...o });
  const list = [
    mk("done", { status: "done", dueDate: "2026-11-01", doneAt: "2026-11-02" }), mk("someday"), mk("later", { dueDate: "2026-12-25" }),
    mk("soon", { dueDate: "2026-11-27" }), mk("today", { dueDate: T }), mk("overdue", { dueDate: "2026-11-19" }),
    mk("flagged", { dueDate: "2026-12-30", flag: { open: true } }),
  ];
  assert.deepEqual(sortForList(list, T).map((c) => c._id), ["flagged", "overdue", "today", "soon", "later", "someday", "done"]);
  for (const c of list) assert.equal(dueState(c, T), c._id);
  assert.equal(dueState(mk("x", { dueDate: "2026-11-28" }), T), "later"); // 8 days out
});

test("reminders: a week before, the day before, the day, the first day overdue, then Mondays; never done or ownerless", () => {
  const c = (dueDate, o = {}) => ({ status: "open", ownerId: "u1", dueDate, ...o });
  assert.equal(reminderFor(c("2026-11-27"), T), "week");
  assert.equal(reminderFor(c("2026-11-21"), T), "tomorrow");
  assert.equal(reminderFor(c(T), T), "today");
  assert.equal(reminderFor(c("2026-11-19"), T), "overdue");
  assert.equal(reminderFor(c("2026-11-10"), T), null);              // long overdue, a Friday: quiet
  assert.equal(reminderFor(c("2026-11-10"), "2026-11-23"), "overdue"); // Monday
  assert.equal(reminderFor(c("2026-11-25"), T), null);
  assert.equal(reminderFor(c(T, { status: "done" }), T), null);
  assert.equal(reminderFor(c(T, { ownerId: null }), T), null);
});

test("emails escape what people typed and lead with what's overdue", () => {
  const r = reminderEmail("Lubna Khan", [
    { kind: "week", title: "Book AV", dueDate: "2026-11-27" }, { kind: "overdue", title: "<b>Pay deposit</b>", dueDate: "2026-11-19", about: "Venue & co" },
  ], "https://x.test/admin/work");
  assert.equal(r.subject, "1 overdue task on your TTFC list");
  assert.ok(r.html.includes("Hi Lubna") && r.html.includes("&lt;b&gt;Pay deposit&lt;/b&gt;") && r.html.includes("Venue &amp; co"));
  assert.ok(r.html.indexOf("Overdue") < r.html.indexOf("Due in a week"));
  const f = flagEmail({ title: "Venue", flag: { severity: "blocked", note: "<script>", raisedByName: "Sam" } }, "https://x.test");
  assert.ok(f.subject.startsWith("Flag raised (blocked)") && f.html.includes("&lt;script&gt;") && !f.html.includes("<script>"));
});

test("what the panel gets: ids as text, no flag until one is raised", () => {
  const d = commitmentDTO({ _id: "abc", title: "T", status: "open", dueDate: T, ownerId: "o1", flag: { open: false } }, T);
  assert.equal(d.state, "today"); assert.equal(d.flag, null); assert.equal(d.ownerId, "o1");
});
