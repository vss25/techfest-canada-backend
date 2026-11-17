/* Drafts for the admin panel's website editing (Nov 2026, redesign step 1).
   Staff save changes to a Sanity draft (`drafts.<id>`), look at them on the
   website in preview mode, then publish. The live site reads only published
   documents (the API CDN without a token never returns drafts), so a draft
   is invisible to visitors until it is published. Pure helpers. */

export const DRAFT_PREFIX = "drafts.";
export const draftId = (id) => `${DRAFT_PREFIX}${id}`;
export const isDraftId = (id) => String(id || "").startsWith(DRAFT_PREFIX);
export const publishedId = (id) => (isDraftId(id) ? String(id).slice(DRAFT_PREFIX.length) : String(id || ""));

const SYSTEM = ["_rev", "_createdAt", "_updatedAt"];
const strip = (doc) => {
  const out = { ...doc };
  for (const k of SYSTEM) delete out[k];
  return out;
};

/** The body a new draft starts from: the published document under the draft id. */
export function draftFromPublished(doc) {
  if (!doc || !doc._id || !doc._type) return null;
  return { ...strip(doc), _id: draftId(publishedId(doc._id)) };
}

/** The published document a draft becomes on publish. */
export function publishedFromDraft(draft) {
  if (!draft || !draft._id || !draft._type) return null;
  return { ...strip(draft), _id: publishedId(draft._id) };
}

/** Published list + drafts → one row per document, the draft's content where there is
    one, with `hasDraft` set and `_id` always the published id. Drafts with no published
    document are included too, marked `unpublished`. */
export function overlayDrafts(published = [], drafts = []) {
  const byId = new Map(drafts.map((d) => [publishedId(d._id), d]));
  const rows = published.map((p) => {
    const d = byId.get(p._id);
    if (!d) return { ...p, hasDraft: false };
    byId.delete(p._id);
    return { ...d, _id: p._id, hasDraft: true };
  });
  for (const [id, d] of byId) rows.push({ ...d, _id: id, hasDraft: true, unpublished: true });
  return rows;
}

/** The eventKey a new event gets, in the existing style: "ttfc-2027-vancouver-briefing",
    "ttfc-2027-toronto-main". null without a city, a year and a type. */
export function eventKeyFor({ city, year, type } = {}) {
  const c = String(city || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const y = Number(year);
  if (!c || !Number.isInteger(y) || y < 2000 || y > 2100) return null;
  if (type !== "briefing" && type !== "main-event") return null;
  return `ttfc-${y}-${c}-${type === "main-event" ? "main" : "briefing"}`;
}

/** The fields of an event's server record (EventConfig) that follow its public page. */
export function eventConfigFields(doc = {}) {
  const out = {};
  if (doc.name) out.name = String(doc.name);
  if (doc.city) out.city = String(doc.city);
  if (doc.type === "briefing" || doc.type === "main-event") out.type = doc.type;
  if (Number.isInteger(Number(doc.year))) out.year = Number(doc.year);
  if (doc.startDate) out.startDate = new Date(`${doc.startDate}T12:00:00Z`);
  if (doc.endDate) out.endDate = new Date(`${doc.endDate}T12:00:00Z`);
  return out;
}

/* Preview queries: the website in preview mode sends its own read queries here
   (POST /api/cms/preview) and gets drafts layered over published content.
   Read-only by construction (Sanity's query endpoint cannot write); the size
   caps keep it to page-sized queries. */
export const PREVIEW_MAX_QUERY = 12000;
export function previewQueryError(body) {
  const q = body?.query;
  if (typeof q !== "string" || !q.trim()) return "Send a query";
  if (q.length > PREVIEW_MAX_QUERY) return "Query too long";
  const params = body?.params;
  if (params !== undefined && (typeof params !== "object" || Array.isArray(params) || params === null)) return "params must be an object";
  if (params && JSON.stringify(params).length > 4000) return "params too long";
  return null;
}
