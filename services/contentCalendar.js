/* Content calendar items (Nov 20 2026): the plan for the month beyond TTFC's own social posts —
   anything staff plan (a LinkedIn post, an email, a partner's post about us), added by hand or
   from an uploaded spreadsheet, with the day it was planned for and the day it actually happened
   ("planned vs executed"). A partner's post or email is marked done by hand with its date and
   link. Pure rules; routes/contentCalendar.js has the API. Private: MongoDB only. */

export const CHANNELS = ["LinkedIn", "Instagram", "X", "Email", "Website", "Other"];
const CHANNEL_WORDS = { linkedin: "LinkedIn", li: "LinkedIn", instagram: "Instagram", ig: "Instagram", insta: "Instagram", x: "X", twitter: "X",
  email: "Email", newsletter: "Email", "e-mail": "Email", mail: "Email", website: "Website", web: "Website", blog: "Website" };
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const str = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const pad = (n) => String(n).padStart(2, "0");
const real = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : ""; };

/**
 * A date as people type it in a spreadsheet → "YYYY-MM-DD", or "" when it can't be read:
 * 2026-11-23, 23/11/2026 is NOT guessed (month first, as in Canada's Excel default: 11/23/2026),
 * "Nov 23 2026", "23 Nov 2026", "November 23" (the year given as `year`), an Excel day number, a Date.
 */
export function parseDay(v, { year = new Date().getFullYear() } = {}) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return real(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  if (typeof v === "number" && v > 20000 && v < 80000) { const t = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000); return real(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); }
  const s = str(v, 40);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return real(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
  if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return +m[1] > 12 ? real(y, +m[2], +m[1]) : real(y, +m[1], +m[2]); }
  m = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? ?(\d{4})?$/.exec(s) || null;
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return real(+(m[3] || year), MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
  m = /^(\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]{3,9})\.?,? ?(\d{4})?$/.exec(s);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) return real(+(m[3] || year), MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]);
  return "";
}

export function cleanChannel(v) {
  const s = str(v, 40);
  if (!s) return "Other";
  const first = s.split(/[,/&+]| and /i)[0].trim().toLowerCase();
  return CHANNEL_WORDS[first] || CHANNELS.find((c) => c.toLowerCase() === first) || "Other";
}

/** The fields a request may set → { set, error }; only keys present are returned. */
export function cleanItem(body = {}, { creating = false } = {}) {
  const set = {};
  if (creating || "title" in body) { set.title = str(body.title, 200); if (!set.title) return { set, error: "Give it a short title." }; }
  if (creating || "date" in body) { set.date = parseDay(body.date); if (!set.date) return { set, error: "The planned date must be a real date, like 2026-11-23." }; }
  if ("channel" in body) set.channel = cleanChannel(body.channel);
  if ("by" in body) set.by = str(body.by, 120);              // who posts or sends it: "" = TTFC, else the partner's name
  if ("ownerName" in body) set.ownerName = str(body.ownerName, 120);
  if ("notes" in body) set.notes = String(body.notes ?? "").trim().slice(0, 1000);
  if ("eventKey" in body) set.eventKey = str(body.eventKey, 80).toLowerCase().replace(/[^a-z0-9-]/g, "");
  if ("doneDate" in body) {
    if (body.doneDate === null || body.doneDate === "") set.doneDate = "";
    else { set.doneDate = parseDay(body.doneDate); if (!set.doneDate) return { set, error: "The done date must be a real date." }; }
  }
  if ("doneUrl" in body) {
    const u = str(body.doneUrl, 500);
    if (u && !/^https?:\/\/[^\s]+\.[^\s]+/i.test(u)) return { set, error: "The link must start with http:// or https://" };
    set.doneUrl = u;
  }
  return { set, error: null };
}

const HEADERS = {
  date: ["date", "planned date", "planned", "day", "when", "publish date", "post date", "due", "due date"],
  title: ["title", "post", "content", "item", "what", "topic", "description", "subject", "name"],
  channel: ["channel", "channels", "platform", "where", "type", "medium"],
  by: ["by", "who", "partner", "who posts", "from", "posted by", "company"],
  ownerName: ["owner", "assigned to", "responsible", "staff", "lead"],
  notes: ["notes", "note", "comments", "details", "copy"],
  doneDate: ["done", "done date", "went out", "actual", "actual date", "posted", "posted on", "sent", "executed"],
  doneUrl: ["link", "url", "post link", "proof"],
};
/** Which column is which, from the header row (unknown columns are ignored). */
export function mapHeaders(row = []) {
  const out = {};
  row.forEach((cell, i) => {
    const h = str(cell, 60).toLowerCase().replace(/[^a-z ]/g, "").trim();
    for (const [field, names] of Object.entries(HEADERS)) if (!(field in out) && names.includes(h)) out[field] = i;
  });
  return out;
}

/**
 * Spreadsheet rows (the first is the header) → { items, skipped: [{ row, why }], error }.
 * Needs a date column and a title column; rows with neither are blank lines and ignored.
 */
export function rowsToItems(rows = [], { year } = {}) {
  if (!Array.isArray(rows) || rows.length < 2) return { items: [], skipped: [], error: "The sheet needs a header row and at least one row under it." };
  const cols = mapHeaders(rows[0]);
  if (!("date" in cols) || !("title" in cols)) return { items: [], skipped: [], error: "The first row must name a Date column and a Title column. Other columns it understands: Channel, By (who posts), Owner, Notes, Done date, Link." };
  const items = [], skipped = [];
  rows.slice(1, 1001).forEach((r, i) => {
    const get = (f) => (f in cols ? r[cols[f]] : undefined);
    if (!str(get("date"), 40) && !str(get("title"), 10)) return;
    const body = { title: get("title"), date: parseDay(get("date"), { year }) };
    for (const f of ["channel", "by", "ownerName", "notes", "doneUrl"]) if (str(get(f), 10)) body[f] = get(f);
    if (str(get("doneDate"), 40)) body.doneDate = parseDay(get("doneDate"), { year });
    const { set, error } = cleanItem(body, { creating: true });
    if (error) skipped.push({ row: i + 2, why: error }); else items.push({ channel: "Other", by: "", ...set });
  });
  return { items, skipped, error: items.length || skipped.length ? null : "No rows with a date and a title were found." };
}

/** planned (still ahead) | done (on or before its day) | late (done after its day) | missed (its day passed, not done). */
export function itemStatus(it, today) {
  if (it.doneDate) return it.doneDate <= it.date ? "done" : "late";
  return it.date < today ? "missed" : "planned";
}

export function planVsActual(items, today) {
  const k = { planned: items.length, done: 0, late: 0, missed: 0, ahead: 0 };
  for (const it of items) { const s = itemStatus(it, today); if (s === "planned") k.ahead++; else k[s]++; }
  return k;
}

export function itemDTO(it, today) {
  return { id: String(it._id), title: it.title, date: it.date, channel: it.channel || "Other", by: it.by || "", ownerName: it.ownerName || "",
    notes: it.notes || "", eventKey: it.eventKey || "", doneDate: it.doneDate || "", doneUrl: it.doneUrl || "", doneByName: it.doneByName || "",
    source: it.source || "manual", status: itemStatus(it, today) };
}
