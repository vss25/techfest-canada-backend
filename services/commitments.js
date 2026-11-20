/* Commitments (Nov 20 2026): "every promise is a tracked item with an owner and a due date",
   so staff can see who is doing what without asking, are reminded before things are due, and
   can raise a flag when something is wrong. The pure rules; routes/commitments.js has the API.
   In the panel they are called tasks (Home › My work). Private: MongoDB only. */

export const AREAS = [
  { key: "partners", label: "Partners" },
  { key: "speakers", label: "Speakers" },
  { key: "marketing", label: "Marketing" },
  { key: "sales", label: "Sales" },
  { key: "vendors", label: "Vendors & operations" },
  { key: "other", label: "Other" },
];
const AREA_KEYS = AREAS.map((a) => a.key);
export const SEVERITIES = [
  { key: "blocked", label: "Blocked: it can't move until someone helps" },
  { key: "at_risk", label: "At risk: it may be late or go wrong" },
];
const SEVERITY_KEYS = SEVERITIES.map((s) => s.key);

const str = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const text = (v, max) => String(v ?? "").replace(/\r/g, "").trim().slice(0, max);
const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(new Date(`${d}T12:00:00Z`).getTime())
  && new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) === d;

/** Today's date in Toronto ("YYYY-MM-DD"): due dates are whole days in the team's own time. */
export function torontoDay(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
export function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000);

/**
 * The fields a request may set → { set, error }. Only keys present in the body are returned,
 * so a PATCH changes just what was sent. `creating` requires a title.
 */
export function cleanCommitment(body = {}, { creating = false } = {}) {
  const set = {};
  if (creating || "title" in body) {
    set.title = str(body.title, 200);
    if (!set.title) return { set, error: "Say what needs doing." };
  }
  if ("notes" in body) set.notes = text(body.notes, 2000);
  if ("dueDate" in body) {
    const d = str(body.dueDate, 10);
    if (d && !isDay(d)) return { set, error: "The date must look like 2027-02-03." };
    set.dueDate = d;
  }
  if ("area" in body) {
    const a = str(body.area, 20);
    if (a && !AREA_KEYS.includes(a)) return { set, error: "Unknown area." };
    set.area = a || "other";
  }
  if ("eventKey" in body) set.eventKey = str(body.eventKey, 80).toLowerCase().replace(/[^a-z0-9-]/g, "");
  if ("about" in body) set.about = str(body.about, 160);
  if ("ownerId" in body) set.ownerId = str(body.ownerId, 24); // checked against staff accounts by the route
  return { set, error: null };
}

export function cleanFlag(body = {}) {
  const note = text(body.note, 1000);
  if (!note) return { error: "Say what's wrong, in a sentence." };
  const severity = SEVERITY_KEYS.includes(body.severity) ? body.severity : "at_risk";
  return { flag: { note, severity }, error: null };
}

/** Where a task stands today: done | flagged | overdue | today | soon (within 7 days) | later | someday (no date). */
export function dueState(c, today = torontoDay()) {
  if (c.status === "done") return "done";
  if (c.flag?.open) return "flagged";
  if (!c.dueDate) return "someday";
  const n = daysBetween(today, c.dueDate);
  if (n < 0) return "overdue";
  if (n === 0) return "today";
  return n <= 7 ? "soon" : "later";
}

const ORDER = { flagged: 0, overdue: 1, today: 2, soon: 3, later: 4, someday: 5, done: 6 };
/** Flags first, then overdue, then by due date; done last (newest first). */
export function sortForList(list, today = torontoDay()) {
  return [...list].sort((a, b) => {
    const sa = ORDER[dueState(a, today)], sb = ORDER[dueState(b, today)];
    if (sa !== sb) return sa - sb;
    if (a.status === "done") return String(b.doneAt || "").localeCompare(String(a.doneAt || ""));
    return String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999")) || String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
  });
}

/**
 * Which reminder a task gets this morning, or null: a week before, the day before, on the day,
 * the first day it is overdue, and then every Monday while it stays overdue. Worked out from
 * the dates alone, so nothing is stored per task and a missed morning never doubles up.
 */
export function reminderFor(c, today = torontoDay()) {
  if (c.status === "done" || !c.dueDate || !c.ownerId) return null;
  const n = daysBetween(today, c.dueDate);
  if (n === 7) return "week";
  if (n === 1) return "tomorrow";
  if (n === 0) return "today";
  if (n === -1) return "overdue";
  if (n < -1 && new Date(`${today}T12:00:00Z`).getUTCDay() === 1) return "overdue";
  return null;
}

const iso = (d) => (d ? new Date(d).toISOString() : null);
export function commitmentDTO(c, today = torontoDay()) {
  return {
    id: String(c._id), title: c.title, notes: c.notes || "", dueDate: c.dueDate || "", area: c.area || "other",
    eventKey: c.eventKey || "", about: c.about || "",
    ownerId: c.ownerId ? String(c.ownerId) : "", ownerName: c.ownerName || "",
    status: c.status === "done" ? "done" : "open", state: dueState(c, today),
    doneAt: iso(c.doneAt), doneByName: c.doneByName || "",
    flag: c.flag?.raisedAt ? {
      open: !!c.flag.open, severity: c.flag.severity || "at_risk", note: c.flag.note || "",
      raisedByName: c.flag.raisedByName || "", raisedAt: iso(c.flag.raisedAt),
      resolvedByName: c.flag.resolvedByName || "", resolvedAt: iso(c.flag.resolvedAt), resolution: c.flag.resolution || "",
    } : null,
    source: c.source || "manual", createdByName: c.createdByName || "", createdAt: iso(c.createdAt), updatedAt: iso(c.updatedAt),
  };
}

/* ---------------- Emails (plain, every value escaped) ---------------- */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const prettyDay = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }) : "no date");
const shell = (heading, bodyHtml, link) => `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:#151035;max-width:560px">
<h2 style="font-size:18px;margin:0 0 12px">${esc(heading)}</h2>${bodyHtml}
<p style="margin:20px 0 0"><a href="${esc(link)}" style="display:inline-block;background:#D6308C;color:#fff;text-decoration:none;font-weight:bold;padding:10px 16px;border-radius:8px">Open My work</a></p>
<p style="font-size:12px;color:#6B6688;margin:16px 0 0">Sent by the TTFC admin panel.</p></div>`;

const REMINDER_HEAD = { overdue: "Overdue", today: "Due today", tomorrow: "Due tomorrow", week: "Due in a week" };
/** One morning email for one owner: their tasks that hit a reminder today, most urgent first. */
export function reminderEmail(ownerName, items, link) {
  const groups = ["overdue", "today", "tomorrow", "week"].map((k) => [k, items.filter((i) => i.kind === k)]).filter(([, l]) => l.length);
  const html = groups.map(([k, l]) => `<p style="margin:14px 0 4px;font-weight:bold;color:${k === "overdue" ? "#B91C1C" : "#151035"}">${REMINDER_HEAD[k]}</p><ul style="margin:0;padding-left:18px">${
    l.map((i) => `<li>${esc(i.title)}${i.about ? ` <span style="color:#6B6688">(${esc(i.about)})</span>` : ""} · ${esc(prettyDay(i.dueDate))}</li>`).join("")}</ul>`).join("");
  const n = items.length;
  const overdue = items.filter((i) => i.kind === "overdue").length;
  const subject = overdue ? `${overdue} overdue ${overdue === 1 ? "task" : "tasks"} on your TTFC list` : `${n} TTFC ${n === 1 ? "task is" : "tasks are"} coming up`;
  const textBody = groups.map(([k, l]) => `${REMINDER_HEAD[k]}:\n${l.map((i) => `- ${i.title} (${prettyDay(i.dueDate)})`).join("\n")}`).join("\n\n") + `\n\n${link}`;
  return { subject, html: shell(`Hi ${String(ownerName || "there").split(" ")[0]}, here's what needs you`, html, link), text: textBody };
}

export function flagEmail(c, link) {
  const sev = c.flag?.severity === "blocked" ? "Blocked" : "At risk";
  const html = `<p style="margin:0 0 8px"><strong>${esc(sev)}:</strong> ${esc(c.title)}</p>
<p style="margin:0 0 8px;white-space:pre-wrap">${esc(c.flag?.note)}</p>
<p style="margin:0;color:#6B6688">Raised by ${esc(c.flag?.raisedByName)}${c.ownerName ? ` · owner: ${esc(c.ownerName)}` : " · no owner yet"}${c.dueDate ? ` · due ${esc(prettyDay(c.dueDate))}` : ""}</p>`;
  return { subject: `Flag raised (${sev.toLowerCase()}): ${c.title}`.slice(0, 150), html: shell("Someone raised a flag", html, link),
    text: `${sev}: ${c.title}\n\n${c.flag?.note}\n\nRaised by ${c.flag?.raisedByName}\n\n${link}` };
}

export function assignedEmail(c, byName, link) {
  const html = `<p style="margin:0 0 8px">${esc(byName)} gave you a task:</p><p style="margin:0 0 8px"><strong>${esc(c.title)}</strong></p>
<p style="margin:0;color:#6B6688">${c.dueDate ? `Due ${esc(prettyDay(c.dueDate))}` : "No due date"}${c.about ? ` · ${esc(c.about)}` : ""}</p>${c.notes ? `<p style="margin:8px 0 0;white-space:pre-wrap">${esc(c.notes)}</p>` : ""}`;
  return { subject: `New task for you: ${c.title}`.slice(0, 150), html: shell("You have a new task", html, link),
    text: `${byName} gave you a task: ${c.title}${c.dueDate ? ` (due ${prettyDay(c.dueDate)})` : ""}\n\n${link}` };
}
