import { inEvent, LEGACY_EVENT_KEY } from "./people.js";

/* Past participants (Nov 20 2026, the owner: "don't show old partners, exhibitors or buyers in the
   sales section as something sold to them for the current event; show that these people were
   previously participating … and if you'd like to connect with them again"). For the event chosen
   in the admin: everyone and every organisation that took part in an EARLIER event and isn't part
   of this one yet, with what they were, so sales can reach out again. Pure; routes/salesEvent.js. */

export const ROLES = ["Sponsor", "Partner", "Exhibitor", "Speaker", "Media", "Delegate"];
export const OUTREACH = [
  { key: "contacted", label: "We reached out" },
  { key: "interested", label: "Interested in this event" },
  { key: "not_now", label: "Not this time" },
];
const OUTREACH_KEYS = OUTREACH.map((o) => o.key);
export const cleanOutreach = (v) => (OUTREACH_KEYS.includes(v) ? v : null);

const str = (v, max) => String(v ?? "").trim().slice(0, max);

/** What someone was: one role, the most specific. */
export function roleOf(p) {
  const types = p.types || [];
  if (p.exhibitor || types.includes("exhibitor")) return "Exhibitor";
  if (types.includes("speaker")) return "Speaker";
  if (types.includes("media")) return "Media";
  return "Delegate";
}

/** People with a pass for another event and none for this one (staff and volunteers are not sales contacts). */
export function pastPeople(people, eventKey) {
  const out = [];
  if (eventKey === LEGACY_EVENT_KEY) return out;   // the first event: nobody took part in an earlier one
  for (const p of people || []) {
    const passes = (p.passList || []).filter((t) => !t.hidden);
    if (!passes.length || inEvent(p, eventKey)) continue;
    const types = p.types || [];
    if (types.includes("staff") || types.includes("volunteer")) continue;
    const events = [...new Set(passes.map((t) => t.eventKey || LEGACY_EVENT_KEY))];
    out.push({ kind: "person", key: String(p.id), name: str(p.name, 160), company: str(p.company, 160), jobTitle: str(p.jobTitle, 160),
      email: str(p.email, 200), role: roleOf(p), was: str(p.primary?.label, 60), events });
  }
  return out.sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || a.name.localeCompare(b.name));
}

/** Website partners linked to other events and not to this one: Sponsor = the paid (featured) row. */
export function pastOrgs(partners, eventDocId) {
  const out = [];
  if (eventDocId === `event-${LEGACY_EVENT_KEY}`) return out;
  for (const p of partners || []) {
    const events = (p.events || []).filter(Boolean);
    if (!p?.name || !events.length || events.includes(eventDocId)) continue;
    out.push({ kind: "org", key: String(p._id), name: str(p.name, 160), company: "", jobTitle: "", email: "", website: str(p.url, 300),
      role: p.matrixGroup === "featured" ? "Sponsor" : "Partner", was: p.matrixGroup === "featured" ? "Featured partner" : "Partner",
      events: events.map((id) => String(id).replace(/^event-/, "")) });
  }
  return out.sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || a.name.localeCompare(b.name));
}

/** Rows with their outreach for this event attached, and the counts for the page's tiles. */
export function withOutreach(rows, outreach) {
  const by = new Map((outreach || []).map((o) => [`${o.kind}:${o.key}`, o]));
  const list = rows.map((r) => {
    const o = by.get(`${r.kind}:${r.key}`);
    return { ...r, outreach: o ? { id: String(o._id), status: o.status, byName: o.byName || "", at: o.at ? new Date(o.at).toISOString() : null, note: o.note || "" } : null };
  });
  const counts = { total: list.length, notContacted: list.filter((r) => !r.outreach).length, byRole: {}, byStatus: {} };
  for (const r of list) { counts.byRole[r.role] = (counts.byRole[r.role] || 0) + 1; if (r.outreach) counts.byStatus[r.outreach.status] = (counts.byStatus[r.outreach.status] || 0) + 1; }
  return { list, counts };
}
