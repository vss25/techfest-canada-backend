/* The admin-first content workflow (Nov 2026): save → send to staging → publish to live.
   See models/CmsChange.js for the three states and routes/cms.js for the endpoints.
   Pure helpers, unit-tested in test/cms-workflow.test.js. */

import { randomBytes } from "node:crypto";
import { publishedId } from "./cmsDrafts.js";

const SYSTEM = ["_rev", "_createdAt", "_updatedAt"];

/** A document without Sanity's system fields and with its published id. */
export function cleanDoc(doc) {
  if (!doc || typeof doc !== "object") return null;
  const out = JSON.parse(JSON.stringify(doc));
  for (const k of SYSTEM) delete out[k];
  for (const k of Object.keys(out)) if (/Url$|Dims$/.test(k) || k === "hasDraft" || k === "unpublished" || k === "staged") delete out[k];
  if (out._id) out._id = publishedId(out._id);
  return out;
}

/** toSanityPatch's { set, unset } applied to a document (top-level keys only, as it produces). */
export function applyPatch(doc, set = {}, unset = []) {
  const out = { ...(doc || {}) };
  for (const [k, v] of Object.entries(set)) out[k] = v;
  for (const k of unset) delete out[k];
  return out;
}

/** A fresh id for a new document of a type that has no natural id ("speaker-k3x9q2m4a7"). */
export function newDocId(type) {
  return `${String(type).replace(/[^A-Za-z]/g, "").slice(0, 20)}-${randomBytes(6).toString("hex")}`;
}

/* Sanity asset ids → CDN addresses, the same as the list query's "imageUrl": image.asset->url,
   so work in progress (kept in MongoDB, where `->` can't be followed) looks the same in the panel. */
const IMG = /^image-([a-f0-9]+)-(\d+)x(\d+)-([a-z0-9]+)$/i;
const FILE = /^file-([a-f0-9]+)-([a-z0-9]+)$/i;

export function assetUrl(ref, project, dataset) {
  const s = String(ref || "");
  let m = IMG.exec(s);
  if (m) return `https://cdn.sanity.io/images/${project}/${dataset}/${m[1]}-${m[2]}x${m[3]}.${m[4]}`;
  m = FILE.exec(s);
  if (m) return `https://cdn.sanity.io/files/${project}/${dataset}/${m[1]}.${m[2]}`;
  return "";
}

export function assetDims(ref) {
  const m = IMG.exec(String(ref || ""));
  if (!m) return null;
  const width = Number(m[2]), height = Number(m[3]);
  return { width, height, aspectRatio: height ? width / height : 1 };
}

const IMAGE_FIELDS = { image: "imageUrl", logo: "logoUrl", heroImage: "heroImageUrl", citySkyline: "citySkylineUrl" };

/** A work-in-progress document with the list query's computed fields filled in. */
export function withAssetUrls(doc, project, dataset) {
  if (!doc) return doc;
  const out = { ...doc };
  for (const [field, urlKey] of Object.entries(IMAGE_FIELDS)) {
    const ref = doc[field]?.asset?._ref;
    out[urlKey] = ref ? assetUrl(ref, project, dataset) || null : null;
  }
  out.imageDims = assetDims(doc.image?.asset?._ref);
  out.logoDims = assetDims(doc.logo?.asset?._ref);
  return out;
}

const isAssetRef = (ref) => /^(image|file)-/.test(String(ref || ""));

/** References to other documents made weak, so a staged speaker can point at an event
    that is itself only on staging (Sanity refuses strong references to missing documents). */
export function weakRefs(value) {
  if (Array.isArray(value)) return value.map(weakRefs);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = weakRefs(v);
  if (out._type === "reference" && out._ref && !isAssetRef(out._ref)) out._weak = true;
  return out;
}

/** On publish: references made strong again where the target will exist (`exists(id)`),
    left weak where it won't (a speaker published before its event). */
export function strongRefs(value, exists) {
  if (Array.isArray(value)) return value.map((v) => strongRefs(v, exists));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = strongRefs(v, exists);
  if (out._type === "reference" && out._weak && exists(out._ref)) delete out._weak;
  return out;
}

/** What a change is called in the Changes list. */
export function changeTitle(type, doc = {}) {
  if (type === "homePage") return "Home page";
  if (type === "siteSettings") return "Site settings";
  if (type === "aboutContent") return "About page numbers";
  return String(doc.name || doc.title || doc.heroHeadline || doc.city || doc._id || "Untitled").slice(0, 160);
}

export const TYPE_LABELS = {
  speaker: "Speaker", partner: "Partner", sponsor: "Alumni logo", sponsorMarquee: "Marquee logo", homeSponsor: "Home page logo",
  siteSettings: "Site settings", aboutContent: "About page", session: "Agenda session", event: "Event page", homePage: "Home page",
  faq: "FAQ", exhibitor: "Exhibitor", video: "Video",
};

/**
 * One row per document for the editors (GET /api/cms/:type?drafts=1): the newest content
 * (work in progress > staged > live) with
 *   hasDraft    unsent work in progress (saved, not on staging yet)
 *   staged      on staging, not live yet
 *   unpublished not on the live site at all
 * `wips` are CmsChange rows ({ docId, wip }) whose wip has this type.
 */
export function overlayChanges(published = [], staged = [], wips = []) {
  const stagedBy = new Map(staged.map((d) => [publishedId(d._id), d]));
  const wipBy = new Map(wips.filter((w) => w.wip).map((w) => [w.docId, w.wip]));
  const row = (id, live) => {
    const s = stagedBy.get(id);
    const w = wipBy.get(id);
    const content = w || s || live;
    return { ...content, _id: id, hasDraft: !!w, staged: !!s, unpublished: !live };
  };
  const rows = published.map((p) => row(p._id, p));
  const seen = new Set(published.map((p) => p._id));
  for (const id of [...stagedBy.keys(), ...wipBy.keys()]) {
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push(row(id, null));
  }
  return rows;
}

/** The ids a "send to staging" / "publish" request names: every one when `ids` is missing. */
export function pickIds(all, ids) {
  if (ids === undefined || ids === null) return { ids: all };
  if (!Array.isArray(ids) || ids.length > 500 || !ids.every((x) => typeof x === "string")) return { error: "ids must be a list of document ids" };
  const want = new Set(ids);
  return { ids: all.filter((id) => want.has(id)) };
}

/** Publishing order: events and the home page first, so references to them can be strong. */
export function publishOrder(docs) {
  const rank = (d) => (d._type === "event" ? 0 : d._type === "homePage" ? 1 : 2);
  return [...docs].sort((a, b) => rank(a) - rank(b));
}

/** The field names that differ between two versions of a document ("name, bio, image"). */
export function changedFields(next, prev) {
  const a = cleanDoc(next) || {}, b = cleanDoc(prev) || {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => !k.startsWith("_") && JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)).sort();
}
