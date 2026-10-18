/* =========================================================
   "Running late": move agenda times in one step (Admin → Agenda
   → clock button on a session). Pure, unit-tested. The website's
   admin panel previews with a copy of these rules
   (src/admin/cms/agendaShift.js); this one is authoritative.

   The session that is running long keeps its start; its end moves
   by `minutes`. Every session after it in scope (starting at or after
   its ORIGINAL end) moves both its start and end by `minutes`. Breaks
   move like anything else. Sessions with no start time are left alone.

   Scope "stage" (default): same day, same stage. An empty stage is
   the default stage the apps show. Scope "day": every stage that day.

   Undo is the same shift with -minutes and `only` = the ids the first
   shift moved. Without `only` a negative shift isn't always reversible:
   a session on another stage that starts inside the pulled-back gap
   would get caught by the reverse shift.
========================================================= */

export const DEFAULT_STAGE = "Centre Stage · Harbour Ballroom";   // what the iOS/Android apps show for an empty stage
export const SHIFT_SCOPES = ["stage", "day"];
export const MAX_SHIFT_MINUTES = 60;
export const SHIFT_STEP = 5;
export const LATEST_MINUTE = 23 * 60 + 55;                         // 23:55

/** Stage as the apps show it: trimmed, empty → the default stage. */
export const stageOf = (stage) => String(stage ?? "").replace(/\s+/g, " ").trim() || DEFAULT_STAGE;
export const sameStage = (a, b) => stageOf(a).toLowerCase() === stageOf(b).toLowerCase();

/** "09:30" / "9:30" → 570; anything else → null. */
export function toMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? h * 60 + min : null;
}

/** 570 → "09:30". */
export const fromMinutes = (n) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

/** Request values → { minutes, scope } or { error }. Minutes: whole number, ±5…±60 in steps of 5. Scope defaults to "stage". */
export function readShift({ minutes, scope } = {}) {
  const n = typeof minutes === "number" ? minutes
    : typeof minutes === "string" && minutes.trim() ? Number(minutes.trim()) : NaN;
  if (!Number.isInteger(n) || n === 0 || Math.abs(n) > MAX_SHIFT_MINUTES || n % SHIFT_STEP !== 0) {
    return { error: `Pick a shift between -${MAX_SHIFT_MINUTES} and +${MAX_SHIFT_MINUTES} minutes, in steps of ${SHIFT_STEP}.` };
  }
  const s = scope === undefined || scope === null || scope === "" ? "stage" : scope;
  if (!SHIFT_SCOPES.includes(s)) return { error: 'Scope must be "stage" or "day".' };
  return { minutes: n, scope: s };
}

const quoted = (s) => `"${String(s?.title || "Untitled session").trim()}"`;

/**
 * Plan a shift. Returns { anchor, changes, minutes, scope, day, stage } or { error, status }.
 * `changes[0]` is the session running late (end only); the rest are the sessions after it,
 * in time order. Each change: { _id, _rev, title, from: { time, endTime }, time, endTime, set }
 * where `set` is the Sanity patch (only the fields that change).
 * `only` (optional list of _ids) narrows the sessions after it to those ids; used by Undo.
 */
export function planShift(sessions, id, minutes, scope = "stage", { only } = {}) {
  const checked = readShift({ minutes, scope });
  if (checked.error) return { error: checked.error, status: 400 };
  const m = checked.minutes;
  const list = (Array.isArray(sessions) ? sessions : []).filter((s) => s && typeof s === "object");

  const a = list.find((s) => s._id === id);
  if (!a) return { error: "That session isn't in the agenda any more. Refresh and try again.", status: 404 };
  const start = toMinutes(a.time);
  const end = toMinutes(a.endTime);
  if (start === null) return { error: `${quoted(a)} has no start time, so there's nothing to shift from.`, status: 400 };
  if (end === null) return { error: `${quoted(a)} has no end time. Add one first.`, status: 400 };

  const newEnd = end + m;
  if (newEnd <= start) {
    return { error: `${quoted(a)} would end at or before its start (${fromMinutes(start)}). Pick a smaller shift.`, status: 400 };
  }
  if (newEnd > LATEST_MINUTE) return { error: `${quoted(a)} would run past 23:55. Pick a smaller shift.`, status: 400 };

  const keep = Array.isArray(only) ? new Set(only.map(String)) : null;
  const followers = list
    .filter((s) => s._id !== a._id
      && Number(s.day) === Number(a.day)
      && (checked.scope === "day" || sameStage(s.stage, a.stage))
      && toMinutes(s.time) !== null && toMinutes(s.time) >= end
      && (!keep || keep.has(String(s._id))))
    .sort((x, y) => (toMinutes(x.time) - toMinutes(y.time)) || String(x.title || "").localeCompare(String(y.title || "")));

  const anchor = {
    _id: a._id, _rev: a._rev, title: a.title || "",
    from: { time: a.time, endTime: a.endTime },
    time: fromMinutes(start), endTime: fromMinutes(newEnd),
    set: { endTime: fromMinutes(newEnd) },
  };
  const changes = [anchor];

  for (const s of followers) {
    const s0 = toMinutes(s.time);
    const e0 = toMinutes(s.endTime);
    const s1 = s0 + m;
    const e1 = e0 === null ? null : e0 + m;
    if (s1 < 0) return { error: `${quoted(s)} would start before 00:00. Pick a smaller shift.`, status: 400 };
    if (s1 > LATEST_MINUTE || (e1 !== null && e1 > LATEST_MINUTE)) {
      return { error: `${quoted(s)} would run past 23:55. Pick a smaller shift.`, status: 400 };
    }
    // Later sessions keep their length, so only the session running late can end up ending before it starts.
    const set = { time: fromMinutes(s1) };
    if (e1 !== null) set.endTime = fromMinutes(e1);
    changes.push({
      _id: s._id, _rev: s._rev, title: s.title || "",
      from: { time: s.time, endTime: s.endTime },
      time: set.time, endTime: e1 === null ? s.endTime : set.endTime,
      set,
    });
  }

  return { anchor, changes, minutes: m, scope: checked.scope, day: Number(a.day), stage: stageOf(a.stage) };
}

/** One line for the audit log: "Opening remarks" +10 min, Centre Stage · Harbour Ballroom, 6 sessions */
export function shiftSummary(plan) {
  const where = plan.scope === "day" ? `all stages on Day ${plan.day}` : plan.stage;
  const n = plan.changes.length;
  return `${quoted(plan.anchor)} ${plan.minutes > 0 ? "+" : ""}${plan.minutes} min, ${where}, ${n} session${n === 1 ? "" : "s"}`;
}
