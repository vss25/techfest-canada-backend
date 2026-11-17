import express from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { AdminAudit } from "../models/Admin.js";
import { requireManagement } from "../middleware/adminAuth.js";
import { draftId, draftFromPublished, publishedFromDraft, overlayDrafts, previewQueryError, eventKeyFor, eventConfigFields } from "../services/cmsDrafts.js";
import EventConfig from "../models/EventConfig.js";
import { cmsFieldsFor, CMS_TYPES, toSanityPatch, sessionDoc, auditCreateDetail, auditEditDetail } from "../services/cmsSchema.js";
import { planShift, readShift, shiftSummary } from "../services/agendaShift.js";
import { SITE_FILE_MAX_BYTES, SITE_FILE_TOO_BIG, SITE_FILE_TYPES, checkSiteFile, siteFileAuditDetail } from "../services/siteFiles.js";

/* =========================================================
   /api/cms — edit the website's Sanity content (speakers,
   partners (incl. sponsors = the "featured" row), the alumni
   strip, marquee, home sponsors, site settings)
   from the admin panel. The website and the iOS app both read
   Sanity directly, so a change here shows up on both within a
   minute, with no deploy.

   Needs SANITY_WRITE_TOKEN on the server (sanity.io/manage →
   project 021qtoci → API → Tokens → "Editor"). Without it the
   list endpoints still work (read-only) and writes return 503.
========================================================= */

const router = express.Router();
router.use(requireAdmin);

const PROJECT = process.env.SANITY_PROJECT_ID || "021qtoci";
const DATASET = process.env.SANITY_DATASET || "production";
const API = `https://${PROJECT}.api.sanity.io/v2021-10-21`;
const token = () => process.env.SANITY_WRITE_TOKEN || "";

async function sanity(path, init = {}) {
  const headers = { ...(init.headers || {}) };
  if (token()) headers.Authorization = `Bearer ${token()}`;
  const r = await fetch(`${API}${path}`, { ...init, headers });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  if (!r.ok) {
    const msg = json?.error?.description || json?.message || text.slice(0, 200) || `Sanity ${r.status}`;
    const err = new Error(msg); err.status = r.status; throw err;
  }
  return json;
}

const query = (groq, params = {}) => {
  const qs = new URLSearchParams({ query: groq });
  for (const [k, v] of Object.entries(params)) qs.set(`$${k}`, JSON.stringify(v));
  return sanity(`/data/query/${DATASET}?${qs}`);
};
const mutate = (mutations) => sanity(`/data/mutate/${DATASET}?returnIds=true&returnDocuments=true&visibility=sync`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mutations }),
});

/* The document must exist and be of the type in the address (Nov 2026):
   PATCH / DELETE /api/cms/speaker/<id> used to change or delete ANY document
   by id, events and FAQs included. Answers 404 and returns false otherwise. */
async function sameType(res, type, id) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(String(id || "")) || String(id).startsWith("drafts.")) {
    res.status(404).json({ error: "Not found" });
    return false;
  }
  const out = await query(`*[_id == $id][0]._type`, { id });
  if (out?.result !== type) {
    res.status(404).json({ error: "Not found" });
    return false;
  }
  return true;
}

/* The published document and its draft, either of which may be missing (an event created
   as a draft has no published one yet). 404 unless at least one exists with this type. */
async function docAndDraft(res, type, id) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(String(id || "")) || String(id).startsWith("drafts.")) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  const out = await query(`{ "published": *[_id == $id][0], "draft": *[_id == $d][0] }`, { id, d: draftId(id) });
  const published = out?.result?.published || null;
  const draft = out?.result?.draft || null;
  if ((published && published._type !== type) || (draft && draft._type !== type) || (!published && !draft)) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  return { published, draft };
}

function needToken(res) {
  if (token()) return false;
  res.status(503).json({ error: "Editing isn't switched on yet: add SANITY_WRITE_TOKEN on Render (see README)." });
  return true;
}

async function audit(req, action, type, id, detail = "") {
  await AdminAudit.create({ adminId: req.user._id, adminName: req.user.name, action, targetType: `cms:${type}`,
                            targetId: String(id || ""), detail: String(detail).slice(0, 500) }).catch(() => {});
}

/* Audit detail: field names, plus the value for the session live switches and the
   partner website/app switches ("polls=off", "showInApp=false"); see services/cmsSchema.js. */

const fail = (res, err) => res.status(err.status && err.status < 500 ? err.status : 502).json({ error: err.message || "Sanity error" });

router.get("/status", (req, res) => {
  res.json({ configured: !!token(), project: PROJECT, dataset: DATASET, types: CMS_TYPES });
});

/* Upload a photo or logo → Sanity asset. Body: { data: "data:image/png;base64,…", filename } */
router.post("/upload", async (req, res) => {
  if (needToken(res)) return;
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(String(req.body?.data || ""));
  if (!m) return res.status(400).json({ error: "Send an image as a data URL" });
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 6 * 1024 * 1024) return res.status(413).json({ error: "Image must be under 6 MB" });
  const filename = String(req.body?.filename || "upload").replace(/[^\w.-]+/g, "_").slice(0, 80);
  try {
    const out = await sanity(`/assets/images/${DATASET}?filename=${encodeURIComponent(filename)}`, {
      method: "POST", headers: { "Content-Type": m[1] }, body: buf,
    });
    await audit(req, "cms_upload", "asset", out.document?._id, filename);
    res.status(201).json({ assetId: out.document?._id, url: out.document?.url });
  } catch (err) { fail(res, err); }
});

/* Large site files (Admin › Site settings › Large site files): the home page video or the
   brochure PDF, sent as the raw file (Content-Type video/mp4 or application/pdf, up to 40 MB)
   and stored unchanged as a Sanity file asset on cdn.sanity.io. Management only. Mounted in
   server.js before the JSON parsers (they'd refuse 40 MB), after requireManagementAdmin, so the
   body is only read for management. The panel then saves `url` in site.hero_video_url or
   site.brochure_url (services/siteFiles.js).
   POST /api/cms/upload-file?filename=hero-bg.mp4 → 201 { assetId, url } */
const rawSiteFile = express.raw({ type: Object.keys(SITE_FILE_TYPES), limit: SITE_FILE_MAX_BYTES });

export function siteFileBody(req, res, next) {
  rawSiteFile(req, res, (err) => {
    if (!err) return next();
    if (err.type === "entity.too.large") return res.status(413).json({ error: SITE_FILE_TOO_BIG });
    res.status(err.status && err.status < 500 ? err.status : 400).json({ error: "Couldn't read the file. Try again." });
  });
}

export async function uploadSiteFile(req, res) {
  if (needToken(res)) return;
  const check = checkSiteFile({ body: req.body, contentType: req.headers["content-type"], filename: req.query?.filename });
  if (check.error) return res.status(check.status).json({ error: check.error });
  try {
    const out = await sanity(`/assets/files/${DATASET}?filename=${encodeURIComponent(check.filename)}`, {
      method: "POST", headers: { "Content-Type": check.type }, body: req.body, signal: AbortSignal.timeout(180000),
    });
    const assetId = out?.document?._id;
    const url = out?.document?.url;
    if (!assetId || !url) return res.status(502).json({ error: "Sanity didn't send back the file's address. Try again." });
    await audit(req, "cms_upload_file", "asset", assetId, siteFileAuditDetail(check));
    res.status(201).json({ assetId, url });
  } catch (err) { fail(res, err); }
}

/* One-time import of the agenda that's currently hardcoded on the website.
   Body: { sessions: [...] } in the website's agenda.js shape. Never overwrites:
   sessions that already exist in Sanity (same id) are left as they are. */
router.post("/session/import", async (req, res) => {
  if (needToken(res)) return;
  const list = Array.isArray(req.body?.sessions) ? req.body.sessions.slice(0, 300) : [];
  if (!list.length) return res.status(400).json({ error: "No sessions sent" });
  const docs = [], errors = [];
  for (const s of list) {
    const r = sessionDoc(s);
    if (r.error) errors.push(`${s.id || s.title}: ${r.error}`); else docs.push(r.doc);
  }
  if (!docs.length) return res.status(400).json({ error: "Nothing valid to import", errors });
  try {
    await mutate(docs.map((d) => ({ createIfNotExists: d })));
    await audit(req, "cms_import", "session", "", `${docs.length} sessions`);
    res.status(201).json({ imported: docs.length, skipped: errors });
  } catch (err) { fail(res, err); }
});

/* "Running late": shift agenda times in one step on event day.
   Body { id, minutes, scope?: "stage" | "day", only? }. The session `id` keeps its
   start and its end moves by `minutes`; every session after it in scope moves both
   times (rules in services/agendaShift.js). All patches go in one transaction, each
   pinned to the revision we just read, so it's all or nothing and an edit made in
   between fails the whole shift instead of mixing old and new times.
   Undo = the same call with -minutes and `only` = the ids it moved (minus `id`).
   → { ok, minutes, scope, moved: [{ _id, title, time, endTime }] } (the session `id` first). */
router.post("/session/shift", async (req, res) => {
  if (needToken(res)) return;
  const body = req.body || {};
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id || id.length > 200) return res.status(400).json({ error: "Say which session is running late." });
  const { minutes, scope, error } = readShift(body);
  if (error) return res.status(400).json({ error });
  let only;
  if (body.only !== undefined && body.only !== null) {
    if (!Array.isArray(body.only) || body.only.length > 300 || !body.only.every((x) => typeof x === "string")) {
      return res.status(400).json({ error: "only must be a list of session ids." });
    }
    only = body.only;
  }
  try {
    const out = await query(`*[_type == "session" && !(_id in path("drafts.**"))]{ _id, _rev, title, day, time, endTime, stage, isBreak }`);
    const plan = planShift(out.result || [], id, minutes, scope, { only });
    if (plan.error) return res.status(plan.status || 400).json({ error: plan.error });
    await mutate(plan.changes.map((c) => ({ patch: { id: c._id, ...(c._rev ? { ifRevisionID: c._rev } : {}), set: c.set } })));
    await audit(req, "cms_agenda_shift", "session", id, shiftSummary(plan));
    res.json({
      ok: true, minutes, scope,
      moved: plan.changes.map(({ _id, title, time, endTime }) => ({ _id, title, time, endTime })),
    });
  } catch (err) {
    if (err.status === 409) {
      return res.status(409).json({ error: "The agenda changed while you were shifting it. Nothing was moved. Refresh and try again." });
    }
    fail(res, err);
  }
});

/* Website preview (redesign step 1): the site in preview mode (?preview=1, staff signed in)
   sends its own read queries here and sees drafts layered over published content.
   Read-only: Sanity's query endpoint cannot write. */
router.post("/preview", async (req, res) => {
  const bad = previewQueryError(req.body);
  if (bad) return res.status(400).json({ error: bad });
  if (needToken(res)) return;
  try {
    const qs = new URLSearchParams({ query: req.body.query, perspective: "previewDrafts" });
    for (const [k, v] of Object.entries(req.body.params || {})) qs.set(`$${k}`, JSON.stringify(v));
    const r = await fetch(`https://${PROJECT}.api.sanity.io/v2024-01-01/data/query/${DATASET}?${qs}`, {
      headers: { Authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(20000),
    });
    const json = await r.json().catch(() => null);
    if (!r.ok) return res.status(502).json({ error: json?.error?.description || `Sanity ${r.status}` });
    res.json({ result: json?.result ?? null });
  } catch (err) { fail(res, err); }
});

const LIST_FIELDS = `..., "imageUrl": image.asset->url, "logoUrl": logo.asset->url, "heroImageUrl": heroImage.asset->url,
      "imageDims": image.asset->metadata.dimensions, "logoDims": logo.asset->metadata.dimensions`;

/* ?drafts=1 (the event editor): each row is the draft's content where there is one, with hasDraft. */
router.get("/:type", async (req, res) => {
  const { type } = req.params;
  if (!CMS_TYPES.includes(type)) return res.status(404).json({ error: "Unknown content type" });
  try {
    const order = type === "session" ? "order(day asc, time asc)"
      : type === "event" ? "order(year asc, startDate asc)" : "order(coalesce(order, 9999) asc, name asc)";
    const out = await query(`*[_type == $type && !(_id in path("drafts.**"))] | ${order} { ${LIST_FIELDS} }`, { type });
    if (req.query.drafts !== "1") return res.json(out.result || []);
    const drafts = await query(`*[_type == $type && _id in path("drafts.**")] { ${LIST_FIELDS} }`, { type });
    res.json(overlayDrafts(out.result || [], drafts.result || []));
  } catch (err) { fail(res, err); }
});

/* Events are created as drafts (redesign step 1): staff see them in preview, and they go
   on the website only when a manager publishes them (which also makes the event's server
   record, models/EventConfig.js). Every other type is created live, as before. */
router.post("/:type", async (req, res) => {
  const { type } = req.params;
  if (!CMS_TYPES.includes(type)) return res.status(404).json({ error: "Unknown content type" });
  if (needToken(res)) return;
  const { set, error } = toSanityPatch(type, req.body || {}, { creating: true });
  if (error) return res.status(400).json({ error });
  try {
    if (type === "event") {
      const key = eventKeyFor(set);
      if (!key) return res.status(400).json({ error: "An event needs a city, a year and a type" });
      const id = `event-${key}`;
      const taken = await query(`count(*[_id in [$id, $d] || eventKey.current == $key])`, { id, d: draftId(id), key });
      if (taken?.result) return res.status(409).json({ error: "There is already an event for that city, year and type." });
      const out = await mutate([{ create: { _id: draftId(id), _type: "event", eventKey: { _type: "slug", current: key }, ...set } }]);
      await audit(req, "cms_create", type, id, `${auditCreateDetail(set)} (draft)`);
      return res.status(201).json({ ...(out.results?.[0]?.document || {}), _id: id, hasDraft: true, unpublished: true });
    }
    const out = await mutate([{ create: { _type: type, ...set } }]);
    const doc = out.results?.[0]?.document;
    await audit(req, "cms_create", type, doc?._id, auditCreateDetail(set));
    res.status(201).json(doc);
  } catch (err) { fail(res, err); }
});

router.patch("/:type/:id", async (req, res) => {
  const { type, id } = req.params;
  if (!CMS_TYPES.includes(type)) return res.status(404).json({ error: "Unknown content type" });
  if (needToken(res)) return;
  const { set, unset, error } = toSanityPatch(type, req.body || {}, { creating: false });
  if (error) return res.status(400).json({ error });
  const patch = { id };
  if (Object.keys(set).length) patch.set = set;
  if (unset.length) patch.unset = unset;
  if (!patch.set && !patch.unset) return res.status(400).json({ error: "Nothing to change" });
  try {
    if (req.query.draft === "1") {
      // Save to the draft, starting it from the published document if there isn't one yet.
      const found = await docAndDraft(res, type, id);
      if (!found) return;
      const base = found.draft ? null : draftFromPublished(found.published);
      const mutations = base ? [{ createIfNotExists: base }] : [];
      mutations.push({ patch: { ...patch, id: draftId(id) } });
      const out = await mutate(mutations);
      await audit(req, "cms_draft", type, id, auditEditDetail(set, unset));
      const doc = out.results?.[mutations.length - 1]?.document || {};
      return res.json({ ...doc, _id: id, hasDraft: true, unpublished: !found.published });
    }
    if (!(await sameType(res, type, id))) return;
    const out = await mutate([{ patch }]);
    await audit(req, "cms_edit", type, id, auditEditDetail(set, unset));
    res.json(out.results?.[0]?.document || { _id: id });
  } catch (err) { fail(res, err); }
});

/* Deleting an event takes it off the website for good: management only. */
router.delete("/:type/:id", (req, res, next) => (req.params.type === "event" ? requireManagement(req, res, next) : next()), async (req, res) => {
  const { type, id } = req.params;
  if (!CMS_TYPES.includes(type)) return res.status(404).json({ error: "Unknown content type" });
  if (needToken(res)) return;
  try {
    if (!(await docAndDraft(res, type, id))) return;
    await mutate([{ delete: { id } }, { delete: { id: draftId(id) } }]);
    await audit(req, "cms_delete", type, id);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/* Publish a draft: management only (staff save drafts and preview them; a manager puts
   them live). The published document becomes the draft's content, then the draft goes.
   A newly published event also gets its server record (EventConfig, status "announced"). */
router.post("/:type/:id/publish", requireManagement, async (req, res) => {
  const { type, id } = req.params;
  if (!CMS_TYPES.includes(type)) return res.status(404).json({ error: "Unknown content type" });
  if (needToken(res)) return;
  try {
    const found = await docAndDraft(res, type, id);
    if (!found) return;
    const doc = publishedFromDraft(found.draft);
    if (!doc) return res.status(409).json({ error: "There are no unpublished changes to publish." });
    const out = await mutate([{ createOrReplace: doc }, { delete: { id: draftId(id) } }]);
    if (type === "event" && doc.eventKey?.current) {
      await EventConfig.updateOne({ eventKey: doc.eventKey.current }, {
        $setOnInsert: { eventKey: doc.eventKey.current, status: "announced" },
        $set: eventConfigFields(doc),
      }, { upsert: true });
    }
    await audit(req, "cms_publish", type, id, found.published ? "" : "first publish");
    res.json({ ...(out.results?.[0]?.document || doc), hasDraft: false, unpublished: false });
  } catch (err) { fail(res, err); }
});

/* Throw away unpublished changes (for a never-published event: the event itself). */
router.delete("/:type/:id/draft", async (req, res) => {
  const { type, id } = req.params;
  if (!CMS_TYPES.includes(type)) return res.status(404).json({ error: "Unknown content type" });
  if (needToken(res)) return;
  try {
    const found = await docAndDraft(res, type, id);
    if (!found) return;
    await mutate([{ delete: { id: draftId(id) } }]);
    await audit(req, "cms_discard_draft", type, id);
    res.json({ ok: true, deleted: !found.published });
  } catch (err) { fail(res, err); }
});

export { cmsFieldsFor };
export default router;
