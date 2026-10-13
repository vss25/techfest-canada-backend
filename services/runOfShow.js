/* =========================================================
   Speaker run of show: data, day plan and calendar invites
   ---------------------------------------------------------
   Each Speaker Pass can carry `runOfShow` (set by staff from the
   speaker sheet, PATCH /api/console/speaker-passes/:id):
     { sessions: [{ day: 1|2, start: "09:30", end: "10:00", title,
                    format: "Panel", role: "Panellist",
                    lineup: [{ name, role, org }] }] }
   The Speaker Pass email (services/speakerPassEmail.js) turns it into
   "Your session" + "Your days, hour by hour"; speakerInvites.js sends
   one calendar invite per session. Speakers are asked to be in the
   VIP Lounge ARRIVE_EARLY_MIN minutes before each session for mic
   fitting, and the invite starts then.
   All times are Toronto local (EDT, UTC-4, on 26-27 Oct 2026).
========================================================= */

export const ARRIVE_EARLY_MIN = 30;
export const STAGE = "Main Stage, Harbour Ballroom";
export const LOUNGE = "VIP Lounge";
export const UTC_OFFSET = "-04:00"; // EDT until 1 Nov 2026

export const DAYS = {
  1: { date: "2026-10-26", long: "Monday 26 October 2026", short: "Mon 26 Oct" },
  2: { date: "2026-10-27", long: "Tuesday 27 October 2026", short: "Tue 27 Oct" },
};

const REGISTRATION = {
  start: "07:45", from: true, title: "Arrival, registration and badge pick-up", where: "Registration, Harbour Ballroom Foyer",
  note: "Collect your speaker badge here. Ask for Lubna or the speaker desk if you can't find your name.",
};
/** The fixed events on each day (the speaker run of show, 11 Oct). */
export const ANCHORS = {
  1: [
    REGISTRATION,
    { start: "08:00", end: "09:00", title: "CxO Breakfast", where: "Pier 4 and 5", note: "A small, senior breakfast for executives." },
    { start: "12:35", end: "13:20", title: "Networking Lunch", where: "Harbour Foyer", note: "The whole festival in one room." },
    { start: "17:30", end: "18:25", title: "Catalyst Awards Gala", where: "Harbour Ballroom", note: "Celebrating leadership in frontier technology." },
  ],
  2: [
    REGISTRATION,
    { start: "08:00", end: "09:00", title: "CxO Breakfast", where: "Pier 4 and 5", note: "A small, senior breakfast for executives." },
    { start: "12:00", end: "12:45", title: "Networking Lunch", where: "Harbour Foyer", note: "The whole festival in one room." },
    { start: "17:30", end: "19:30", title: "Networking Reception and Gala Dinner", where: "Harbour Foyer", note: "Reception and gala dinner to close the festival." },
  ],
};

const clean = (v, max = 200) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** "09:30" → "9:30 AM". */
export function fmtTime(hhmm) {
  if (!HHMM.test(String(hhmm || ""))) return "";
  const m = toMin(hhmm);
  const h = Math.floor(m / 60) % 12 || 12;
  return `${h}:${String(m % 60).padStart(2, "0")} ${m >= 720 ? "PM" : "AM"}`;
}

export const arriveAt = (start) => fromMin(Math.max(0, toMin(start) - ARRIVE_EARLY_MIN));
export const minutesBetween = (a, b) => toMin(b) - toMin(a);

/**
 * Whether a session needs its own mic fitting: not when the speaker is still on (or just off)
 * stage from an earlier session that day, ending less than ARRIVE_EARLY_MIN before it starts.
 */
export function needsMicUp(sessions = [], s) {
  return !sessions.some((o) => o !== s && o.day === s.day && toMin(o.start) < toMin(s.start)
    && toMin(s.start) - toMin(o.end) < ARRIVE_EARLY_MIN);
}

/** The Date for a day + local "HH:MM". */
export const localDate = (day, hhmm) => new Date(`${DAYS[day].date}T${hhmm}:00${UTC_OFFSET}`);

/**
 * Checks and tidies a run of show from the admin (null clears it).
 * → { ok: true, value } | { ok: false, error }
 */
export function validateRunOfShow(raw) {
  if (raw === null) return { ok: true, value: null };
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.sessions)) return { ok: false, error: "runOfShow needs a sessions list." };
  if (raw.sessions.length > 10) return { ok: false, error: "That's more than 10 sessions." };
  const sessions = [];
  for (const s of raw.sessions) {
    const day = Number(s?.day);
    const start = clean(s?.start, 5);
    const end = clean(s?.end, 5);
    const title = clean(s?.title, 200);
    if (!DAYS[day] || !HHMM.test(start) || !HHMM.test(end) || toMin(end) <= toMin(start) || !title) {
      return { ok: false, error: `A session needs a day (1 or 2), a start and end time (HH:MM) and a title${title ? `: ${title}` : ""}.` };
    }
    const lineup = (Array.isArray(s?.lineup) ? s.lineup : []).slice(0, 12)
      .map((p) => ({ name: clean(p?.name, 120), role: clean(p?.role, 40), org: clean(p?.org, 160) })).filter((p) => p.name);
    sessions.push({ day, start, end, title, format: clean(s?.format, 40), role: clean(s?.role, 40), lineup });
  }
  sessions.sort((a, b) => a.day - b.day || toMin(a.start) - toMin(b.start));
  return { ok: true, value: { sessions } };
}

/** "own" (the speaker), "handler" (an assistant or office), "team" (TTFC) or "" (not set). */
export function validateContact(raw) {
  const type = clean(raw, 20).toLowerCase();
  return ["", "own", "handler", "team"].includes(type) ? { ok: true, value: type } : { ok: false, error: "Contact must be own, handler or team." };
}

/**
 * Each day's plan, hour by hour: the fixed events, plus for each session the VIP Lounge
 * mic fitting (ARRIVE_EARLY_MIN before) and the session itself, in time order.
 * → [{ day, long, items: [{ start, end?, from?, title, where, note?, kind: "anchor"|"micup"|"session" }] }]
 */
export function dayPlans(runOfShow, days = [1, 2]) {
  const sessions = runOfShow?.sessions || [];
  return days.map((day) => {
    const items = ANCHORS[day].map((a) => ({ ...a, kind: "anchor" }));
    for (const s of sessions.filter((x) => x.day === day)) {
      if (needsMicUp(sessions, s)) {
        items.push({ start: arriveAt(s.start), title: "Mic fitting in the VIP Lounge", where: LOUNGE, kind: "micup",
          note: `Please be here at least ${ARRIVE_EARLY_MIN} minutes before your session.` });
      }
      items.push({ start: s.start, end: s.end, title: `${s.format ? `${s.format}: ` : ""}${s.title}`, where: STAGE, kind: "session",
        note: `${minutesBetween(s.start, s.end)} minutes${s.role ? `, you're the ${s.role.toLowerCase()}` : ""}.` });
    }
    const order = { anchor: 1, micup: 0, session: 2 };
    items.sort((a, b) => toMin(a.start) - toMin(b.start) || order[a.kind] - order[b.kind]);
    return { day, long: DAYS[day].long, items };
  });
}

/* ---------- calendar invites (.ics, METHOD:REQUEST) ---------- */

const icsText = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icsUtc = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

/** Folds a content line at 75 octets (RFC 5545), never splitting a UTF-8 character. */
export function foldLine(line) {
  const out = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ""; bytes = 0; }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

export const inviteUid = (ticketId, s) => `ttfc26-${String(ticketId || "x").toLowerCase()}-d${s.day}-${s.start.replace(":", "")}@thetechfestival.com`;

/**
 * The invite for one session: from the mic fitting (ARRIVE_EARLY_MIN early) to the session's end.
 * Organizer = `organizer` (replies go there); the recipient is the attendee.
 */
export function sessionInviteIcs({ ticketId, name, session: s, to, organizer, sequence = 0, now = new Date(), micUp = true }) {
  const arrive = micUp ? arriveAt(s.start) : s.start;
  const others = (s.lineup || []).filter((p) => p.name !== name).map((p) => `${p.role ? `${p.role}: ` : ""}${p.name}${p.org ? ` (${p.org})` : ""}`);
  const description = [
    micUp ? `${fmtTime(arrive)}: mic fitting in the ${LOUNGE}. Please be there at least ${ARRIVE_EARLY_MIN} minutes before your session.` : "",
    `${fmtTime(s.start)} to ${fmtTime(s.end)}: ${s.format ? `${s.format}, ` : ""}${s.title}, ${STAGE}.`,
    others.length ? `On stage with you: ${others.join("; ")}.` : "",
    "",
    "The Westin Harbour Castle, 1 Harbour Square, Toronto (Convention Level).",
    "Questions: Lubna Soni, lubna@thetechfestival.com, +1 416 717 3020.",
  ].filter((l, i, a) => l || (i > 0 && a[i - 1])).join("\n");
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//The Tech Festival Canada//Speaker invites//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${inviteUid(ticketId, s)}`,
    `DTSTAMP:${icsUtc(now)}`,
    `DTSTART:${icsUtc(localDate(s.day, arrive))}`,
    `DTEND:${icsUtc(localDate(s.day, s.end))}`,
    `SUMMARY:${icsText(`TTFC 2026: ${s.title} (you're speaking)`)}`,
    `LOCATION:${icsText(`The Westin Harbour Castle, 1 Harbour Square, Toronto (${micUp ? `${LOUNGE}, then ` : ""}${STAGE})`)}`,
    `DESCRIPTION:${icsText(description)}`,
    `ORGANIZER;CN=${icsText(organizer.name)}:mailto:${organizer.email}`,
    `ATTENDEE;CN=${icsText(name)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${to}`,
    `SEQUENCE:${Math.max(0, Number(sequence) || 0)}`,
    "STATUS:CONFIRMED",
    "TRANSP:OPAQUE",
    "BEGIN:VALARM",
    "TRIGGER:-PT60M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsText(micUp ? `Mic fitting in the ${LOUNGE} at ${fmtTime(arrive)}` : `${s.title} at ${fmtTime(s.start)}`)}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
