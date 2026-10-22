/* =========================================================
   "What you missed" emails: when one is due (Oct 22 2026). Pure.
   ---------------------------------------------------------
   The organiser: "The email summary should go out after 3 hours of
   the first activity. And at 5 pm also. If the 3 hours update happens
   in the next 1 hour of 5 pm, skip the email notification."
   In Toronto time (America/Toronto), for one person:
     • 3-hour digest: 3 h after their oldest missed item not emailed
       yet (`pendingSince`);
     • 5 PM digest: every day at 5:00 PM while anything is waiting;
     • a 3-hour digest due 4:00–5:00 PM waits for the 5 PM one;
     • quiet hours (an added default): nothing 9 PM–8 AM; one due then
       goes at 8 AM;
     • never two within 60 minutes (the later one waits), at most 3 a
       day (the rest wait for 8 AM the next day).
   services/digest.js runs every minute and sends the ones whose time
   has come; what goes in them is worked out again at that moment.
========================================================= */

export const TZ = "America/Toronto";
export const DELAY_MS = 3 * 3_600_000;
export const MIN_GAP_MS = 60 * 60_000;
export const MAX_PER_DAY = 3;
export const FIVE_PM = 17;
export const QUIET_FROM = 21;
export const QUIET_TO = 8;

const FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});

/** A Date → its Toronto wall clock { y, mo, d, h, mi }. */
export function torontoParts(date) {
  const p = Object.fromEntries(FMT.formatToParts(new Date(date)).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]));
  return { y: p.year, mo: p.month, d: p.day, h: p.hour % 24, mi: p.minute };
}

/** "YYYY-MM-DD" of a moment in Toronto. */
export function dayKey(date) {
  const p = torontoParts(date);
  return `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** "YYYY-MM-DDTHH:MM" in Toronto: names a digest's slot (one email per person per slot). */
export function slotKey(date) {
  const p = torontoParts(date);
  return `${dayKey(date)}T${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`;
}

/** The moment a Toronto wall-clock time happens (DST handled). */
export function torontoAt(y, mo, d, h, mi = 0) {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = torontoParts(guess);
    const diff = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - want;
    if (!diff) break;
    guess -= diff;
  }
  return new Date(guess);
}

const plusDays = (p, n) => {
  const t = new Date(Date.UTC(p.y, p.mo - 1, p.d + n));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const at = (p, h) => torontoAt(p.y, p.mo, p.d, h);

/** 9 PM – 8 AM in Toronto. */
export const inQuietHours = (date) => {
  const h = torontoParts(date).h;
  return h >= QUIET_FROM || h < QUIET_TO;
};

/** The end of the quiet hours a moment falls in (8 AM), or the moment itself outside them. */
export function afterQuietHours(date) {
  const p = torontoParts(date);
  if (p.h >= QUIET_FROM) return at(plusDays(p, 1), QUIET_TO);
  if (p.h < QUIET_TO) return at(p, QUIET_TO);
  return new Date(date);
}

/** The first 5 PM at or after `date`. */
export function next5pm(date) {
  const p = torontoParts(date);
  const today = at(p, FIVE_PM);
  return new Date(date) <= today ? today : at(plusDays(p, 1), FIVE_PM);
}

/** 8 AM the day after `date`. */
const nextMorning = (date) => at(plusDays(torontoParts(date), 1), QUIET_TO);

/**
 * When this person's next digest is due, from their digest state ({ pendingSince, lastSentAt, sentDay, sentToday },
 * models/DigestState.js) → { at: Date, slot: "3h" | "5pm" | "later" } (`at` may be in the past: due now), or null
 * when nothing is waiting.
 */
export function nextDigest({ pendingSince, lastSentAt = null, sentDay = "", sentToday = 0 } = {}) {
  if (!pendingSince) return null;
  const since = new Date(pendingSince);
  if (Number.isNaN(since.getTime())) return null;

  let three = new Date(since.getTime() + DELAY_MS);
  let threeSlot = "3h";
  if (torontoParts(three).h === FIVE_PM - 1) { three = next5pm(three); threeSlot = "5pm"; }   // 4–5 PM: the 5 PM one covers it
  else if (inQuietHours(three)) three = afterQuietHours(three);
  const five = next5pm(since);
  let when = three < five ? three : five;
  let slot = three < five ? threeSlot : "5pm";

  const last = lastSentAt ? new Date(lastSentAt) : null;
  for (let i = 0; i < 8; i++) {
    let moved = false;
    if (last && when.getTime() < last.getTime() + MIN_GAP_MS) { when = new Date(last.getTime() + MIN_GAP_MS); slot = "later"; moved = true; }
    if (inQuietHours(when)) { when = afterQuietHours(when); moved = true; }
    if (slot !== "5pm" && torontoParts(when).h === FIVE_PM - 1) { when = next5pm(when); slot = "5pm"; moved = true; }
    if (sentDay && sentDay === dayKey(when) && Number(sentToday) >= MAX_PER_DAY) { when = nextMorning(when); slot = "later"; moved = true; }
    if (!moved) break;
  }
  return { at: when, slot };
}

/** Is it due at `now`? */
export const isDue = (state, now = new Date()) => {
  const n = nextDigest(state);
  return !!n && n.at.getTime() <= new Date(now).getTime();
};

/** The digest state after a send at `now` (for the update). */
export function afterSend(state = {}, now = new Date()) {
  const day = dayKey(now);
  return { lastSentAt: new Date(now), emailedUntil: new Date(now), sentDay: day, sentToday: state.sentDay === day ? Number(state.sentToday || 0) + 1 : 1 };
}
