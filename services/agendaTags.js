/* =========================================================
   Admin › Agenda › pillars and sectors staff add themselves (Nov 26 2026). The owner: "I want the ability to
   add a sector or a pillar as well, if I need to add a custom sector or a pillar."

   The built-in pillars and sectors live on the website (src/data/sessionFormats.js) with their keys and colours.
   This is the list of EXTRA ones: plain names ("Space Tech"). A session stores a built-in by its key and an
   extra by its name (cmsSchema session.pillars / session.sectors). Saved in AdminSetting under KEY (staff
   config, nothing public or private in it). Removing a name from the list never changes a session: each session
   keeps what it was saved with. Pure: routes/agendaTags.js does the reading and writing.
========================================================= */

export const KEY = "agenda.session_tags";
export const MAX_TAGS = 40;
export const MAX_NAME = 40;   // the same limit as a session's own entries (cmsSchema "tags")

const clean = (v) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();

function cleanList(input, what) {
  if (input === undefined) return { value: [] };
  if (!Array.isArray(input)) return { error: `Send the list of ${what}.` };
  const out = [];
  const seen = new Set();
  for (const row of input) {
    const name = clean(typeof row === "object" && row ? row.label ?? row.name : row);
    if (!name) continue;
    if (name.length > MAX_NAME) return { error: `"${name.slice(0, 30)}…" is too long: a name can be up to ${MAX_NAME} characters.` };
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  if (out.length > MAX_TAGS) return { error: `Up to ${MAX_TAGS} extra ${what}.` };
  return { value: out };
}

/** The editor's lists → { value: { pillars, sectors } } or { error }. Order is kept; blanks and repeats are dropped. */
export function cleanTags(input) {
  const p = cleanList(input?.pillars, "pillars");
  if (p.error) return { error: p.error };
  const s = cleanList(input?.sectors, "sectors");
  if (s.error) return { error: s.error };
  return { value: { pillars: p.value, sectors: s.value } };
}

/** What's saved (or nothing) → the lists to show. Damaged data reads as none. */
export function tagsFrom(saved) {
  const { value } = cleanTags(saved && typeof saved === "object" ? saved : {});
  return value || { pillars: [], sectors: [] };
}

/** A plain-words summary of a change, for the activity log. */
export function changeSummary(before, after) {
  const part = (what, a, b) => {
    const added = b.filter((x) => !a.includes(x)), removed = a.filter((x) => !b.includes(x));
    return [added.length ? `${what} added: ${added.join(", ")}` : "", removed.length ? `${what} removed: ${removed.join(", ")}` : ""].filter(Boolean);
  };
  const bits = [...part("Pillars", before.pillars, after.pillars), ...part("Sectors", before.sectors, after.sectors)];
  return bits.length ? bits.join("; ") : "Pillars and sectors: no change";
}
