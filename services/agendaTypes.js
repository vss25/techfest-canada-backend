import { SESSION_FORMATS } from "./cmsSchema.js";

/* =========================================================
   Admin › Agenda › session types (Nov 25 2026): the list in the agenda's "Session type" dropdown, which staff
   add to and edit themselves. The owner: "a few more categories … like case studies, roundtables, reception,
   closing remarks … As an admin or as a super admin, I want to be able to create these different drop down
   options and edit them as and when I need."

   A type = { label, format }: the label is what the website shows on the session ("Case Study"), the format is
   one of the fixed colour styles (cmsSchema SESSION_FORMATS) the agenda pages already know. Picking a type in the
   session editor sets both. Saved in AdminSetting under KEY (staff config, nothing public or private in it);
   unset = DEFAULT_TYPES. Pure: routes/agendaTypes.js does the reading and writing.
========================================================= */

export const KEY = "agenda.session_types";
export const MAX_TYPES = 60;
export const MAX_LABEL = 60;   // the session's own "type" field allows 60 (cmsSchema)

export const DEFAULT_TYPES = [
  { label: "Opening Remarks", format: "opening" },
  { label: "Keynote", format: "keynote" },
  { label: "Fireside Chat", format: "fireside" },
  { label: "Panel Session", format: "panel" },
  { label: "Boardroom Briefing", format: "briefing" },
  { label: "Provocation", format: "provocation" },
  { label: "Leadership Dialogue", format: "dialogue" },
  { label: "Case Study", format: "briefing" },
  { label: "Roundtable", format: "dialogue" },
  { label: "Workshop", format: "briefing" },
  { label: "Networking", format: "networking" },
  { label: "Break", format: "break" },
  { label: "Lunch Break", format: "break" },
  { label: "Reception", format: "networking" },
  { label: "Awards", format: "awards" },
  { label: "Gala", format: "awards" },
  { label: "Performance", format: "Performance" },
  { label: "Closing Remarks", format: "closing" },
];

const clean = (v) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();

/** The editor's list → { value } or { error }. Order is kept; blank rows are dropped. */
export function cleanTypes(input) {
  if (!Array.isArray(input)) return { error: "Send the list of session types." };
  const out = [];
  const seen = new Set();
  for (const row of input) {
    const label = clean(row?.label);
    if (!label) continue;
    if (label.length > MAX_LABEL) return { error: `"${label.slice(0, 30)}…" is too long: a type can be up to ${MAX_LABEL} characters.` };
    const k = label.toLowerCase();
    if (seen.has(k)) return { error: `"${label}" is in the list twice.` };
    seen.add(k);
    const format = SESSION_FORMATS.includes(row?.format) ? row.format : "keynote";
    out.push({ label, format });
  }
  if (!out.length) return { error: "Keep at least one session type." };
  if (out.length > MAX_TYPES) return { error: `Up to ${MAX_TYPES} session types.` };
  return { value: out };
}

/** What's saved (or nothing) → the list to show. A damaged row falls back to the defaults. */
export function typesFrom(saved) {
  if (!Array.isArray(saved)) return DEFAULT_TYPES;
  const { value } = cleanTypes(saved);
  return value || DEFAULT_TYPES;
}

/** A plain-words summary of a change, for the activity log. */
export function changeSummary(before, after) {
  const b = new Map(before.map((t) => [t.label.toLowerCase(), t]));
  const a = new Map(after.map((t) => [t.label.toLowerCase(), t]));
  const added = after.filter((t) => !b.has(t.label.toLowerCase())).map((t) => t.label);
  const removed = before.filter((t) => !a.has(t.label.toLowerCase())).map((t) => t.label);
  const restyled = after.filter((t) => b.has(t.label.toLowerCase()) && b.get(t.label.toLowerCase()).format !== t.format).map((t) => t.label);
  const parts = [];
  if (added.length) parts.push(`added ${added.join(", ")}`);
  if (removed.length) parts.push(`removed ${removed.join(", ")}`);
  if (restyled.length) parts.push(`changed the colour of ${restyled.join(", ")}`);
  if (!parts.length) parts.push("reordered the list");
  return `Session types: ${parts.join("; ")}`;
}
