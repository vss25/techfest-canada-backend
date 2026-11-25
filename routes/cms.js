import { videoInfo } from "../services/videoLinks.js";
import express from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { AdminAudit } from "../models/Admin.js";
import { requireManagement } from "../middleware/adminAuth.js";
import { draftId, publishedId, publishedFromDraft, previewQueryError, eventKeyFor, eventConfigFields } from "../services/cmsDrafts.js";
import EventConfig from "../models/EventConfig.js";
import { cmsFieldsFor, CMS_TYPES, missingRequired, toSanityPatch, sessionDoc, auditCreateDetail, auditEditDetail } from "../services/cmsSchema.js";
import { planShift, readShift, shiftSummary } from "../services/agendaShift.js";
import CmsChange from "../models/CmsChange.js";
import { applyPatch, changeTitle, changedFields, cleanDoc, newDocId, overlayChanges, pickIds, publishOrder, strongRefs, weakRefs, withAssetUrls, TYPE_LABELS } from "../services/cmsWorkflow.js";
import { publishingState, refuseWhilePaused, setPublishingPaused } from "../services/cmsPublishing.js";
import { SITE_FILE_MAX_BYTES, SITE_FILE_TOO_BIG, SITE_FILE_TYPES, checkSiteFile, siteFileAuditDetail } from "../services/siteFiles.js";

/* =========================================================
   /api/cms — edit the website's Sanity content (speakers,
   partners (incl. sponsors = the "featured" row), the alumni
   strip, marquee, home sponsors, site settings)
   from the admin panel. The website and the iOS app both read
   Sanity directly. Since Nov 2026 the panel's edits go save →
   staging → publish (see "The admin-first workflow" below); a
   published change shows up on both within a minute, no deploy.

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
  if (await refuseWhilePaused(res)) return;
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


const LIST_FIELDS = `..., "imageUrl": image.asset->url, "imageOriginalUrl": imageOriginal.asset->url, "logoUrl": logo.asset->url, "heroImageUrl": heroImage.asset->url, "citySkylineUrl": citySkyline.asset->url,
      "imageDims": image.asset->metadata.dimensions, "logoDims": logo.asset->metadata.dimensions`;

/* =========================================================
   The admin-first workflow (Nov 2026): save → send to staging → publish to live.
   • Save (?draft=1, any staff): the edited document is kept in MongoDB (CmsChange.wip).
     Nothing on the website or on staging changes.
   • Send to staging (any staff): it becomes the Sanity draft (drafts.<id>), which the
     staging site shows to signed-in staff (POST /api/cms/preview, previewDrafts).
   • Publish to live (any staff; management only until Nov 17 2026): the draft becomes the
     published document. Only what's on staging can be published, so what goes live is what was reviewed.
   The live site only ever reads published documents.
========================================================= */

const OLDER_ONLY = "This item only exists as an older draft made outside the admin. Throw it away from Changes, or add it again.";
const isStaged = (row) => !!row?.stagedAt;
const who = (req) => ({ id: String(req.user?._id || ""), name: String(req.user?.name || "") });
const validId = (id) => /^[A-Za-z0-9._-]{1,128}$/.test(String(id || "")) && !String(id).startsWith("drafts.");

/** Published, staged (Sanity draft) and work in progress for one document; null (and 404 sent)
    unless at least one exists with this type. */
async function loadState(res, type, id) {
  if (!validId(id)) { res.status(404).json({ error: "Not found" }); return null; }
  const out = await query(`{ "published": *[_id == $id][0], "draft": *[_id == $d][0] }`, { id, d: draftId(id) });
  const published = out?.result?.published || null;
  const draft = out?.result?.draft || null;
  const change = await CmsChange.findOne({ docId: id }).lean();
  const wip = change?.wip || null;
  const bad = [published, draft, wip].some((d) => d && d._type !== type);
  if (bad || (!published && !draft && !wip)) { res.status(404).json({ error: "Not found" }); return null; }
  // A Sanity draft is "on staging" only when it was sent there from the admin (CmsChange.stagedAt).
  // Any other draft (left in Sanity Studio, or by a script) is `older`: never shown as staged,
  // never published by the workflow, only thrown away (Nov 17 2026: 30 such drafts existed).
  const staged = draft && change?.stagedAt ? draft : null;
  const older = draft && !change?.stagedAt ? draft : null;
  return { published, draft: staged, older, change, wip };
}

/* Saved drafts may lack required fields (autosave keeps whatever was typed); they go to
   staging only once complete. "Speaker “Ada”: add photo and job title first." */
const incompleteNote = (r, missing) => `${TYPE_LABELS[r.type] || r.type} “${changeTitle(r.type, r.wip) || "Untitled"}”: add ${missing.join(", ").replace(/, ([^,]*)$/, " and $1")} first.`;

/** Write work in progress for these CmsChange rows to Sanity as drafts, in one transaction. */
async function stageRows(req, rows) {
  if (!rows.length) return [];
  await mutate(rows.map((r) => ({ createOrReplace: { ...weakRefs(r.wip), _id: draftId(r.docId), _type: r.type } })));
  const now = new Date();
  await CmsChange.updateMany({ docId: { $in: rows.map((r) => r.docId) } }, { $set: { wip: null, stagedAt: now, stagedBy: who(req) }, $unset: { wipAt: 1, wipBy: 1 } });
  for (const r of rows) await audit(req, "cms_stage", r.type, r.docId, changeTitle(r.type, r.wip));
  return rows.map((r) => r.docId);
}

/** Publish these staged documents (Sanity drafts) in one transaction. */
async function publishDrafts(req, drafts) {
  if (!drafts.length) return [];
  const docs = publishOrder(drafts.map(publishedFromDraft).filter(Boolean));
  const ids = docs.map((d) => d._id);
  const refs = new Set();
  JSON.stringify(docs, (k, v) => { if (k === "_ref" && typeof v === "string" && !/^(image|file)-/.test(v)) refs.add(v); return v; });
  const live = refs.size ? (await query(`*[_id in $ids]._id`, { ids: [...refs] })).result || [] : [];
  const exists = new Set([...live, ...ids]);
  const mutations = [];
  for (const d of docs) mutations.push({ createOrReplace: strongRefs(d, (r) => exists.has(r)) }, { delete: { id: draftId(d._id) } });
  await mutate(mutations);
  for (const d of docs) {
    if (d._type === "event" && d.eventKey?.current) {
      await EventConfig.updateOne({ eventKey: d.eventKey.current }, {
        $setOnInsert: { eventKey: d.eventKey.current, status: "announced" },
        $set: eventConfigFields(d),
      }, { upsert: true });
    }
  }
  // Rows with newer unsent work stay (only their staging marks go); the rest are done.
  await CmsChange.updateMany({ docId: { $in: ids }, wip: { $ne: null } }, { $unset: { stagedAt: 1, stagedBy: 1 } });
  await CmsChange.deleteMany({ docId: { $in: ids }, wip: null });
  for (const d of docs) await audit(req, "cms_publish", d._type, d._id, changeTitle(d._type, d));
  return docs;
}

/* The publishing switch (services/cmsPublishing.js): GET for any staff, PUT management only. */
router.get("/publishing", async (req, res) => {
  try { res.json(await publishingState()); } catch (err) { fail(res, err); }
});
router.put("/publishing", requireManagement, async (req, res) => {
  if (typeof req.body?.paused !== "boolean") return res.status(400).json({ error: "paused must be true or false" });
  try {
    const by = req.user?.name || req.user?.email || "";
    const state = await setPublishingPaused(req.body.paused, by);
    await audit(req, req.body.paused ? "cms_publishing_paused" : "cms_publishing_on", "settings", "publishing",
      req.body.paused ? "publishing to the live website paused" : "publishing to the live website turned on");
    res.json(state);
  } catch (err) { fail(res, err); }
});

/* Everything on its way to the website: Admin › Website content › Changes.
   → { items: [{ id, type, typeLabel, title, unsent, staged, isNew, fields, stagedFields, wipAt, wipBy, stagedAt, stagedBy }],
       older: [{ id, type, typeLabel, title, isNew, fields, updatedAt }] (Sanity drafts not sent from the admin),
       counts: { unsent, staged, older }, canPublish } */
router.get("/changes", async (req, res) => {
  try {
    const rows = await CmsChange.find({}).lean();
    const out = await query(`*[_id in path("drafts.**") && _type in $types]`, { types: CMS_TYPES });
    const drafts = new Map((out.result || []).map((d) => [publishedId(d._id), d]));
    const ids = [...new Set([...drafts.keys(), ...rows.filter((r) => r.wip).map((r) => r.docId)])];
    const pub = ids.length ? (await query(`*[_id in $ids]`, { ids })).result || [] : [];
    const live = new Map(pub.map((d) => [d._id, d]));
    const rowOf = new Map(rows.map((r) => [r.docId, r]));
    const older = [];
    const items = ids.map((id) => {
      const r = rowOf.get(id), raw = drafts.get(id), p = live.get(id) || null;
      const wip = r?.wip || null;
      const d = isStaged(r) ? raw : null;
      if (raw && !d) {
        older.push({ id, type: raw._type, typeLabel: TYPE_LABELS[raw._type] || raw._type, title: changeTitle(raw._type, raw),
          isNew: !p, fields: changedFields(raw, p), updatedAt: raw._updatedAt || null });
      }
      if (!wip && !d) return null;
      const type = (wip || d || p)._type;
      return {
        id, type, typeLabel: TYPE_LABELS[type] || type, title: changeTitle(type, wip || d || p),
        unsent: !!wip, staged: !!d, isNew: !p,
        fields: wip ? changedFields(wip, d || p) : [],
        stagedFields: d ? changedFields(d, p) : [],
        wipAt: wip ? r.wipAt || null : null, wipBy: wip ? r.wipBy?.name || "" : "",
        stagedAt: d ? r?.stagedAt || d._updatedAt || null : null, stagedBy: d ? r?.stagedBy?.name || "" : "",
        missing: wip ? missingRequired(type, wip) : [], // still to add before it can go to staging
      };
    }).filter(Boolean).sort((a, b) => String(b.wipAt || b.stagedAt || "").localeCompare(String(a.wipAt || a.stagedAt || "")));
    const { paused } = await publishingState();
    res.json({
      items,
      older: older.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))),
      counts: { unsent: items.filter((i) => i.unsent).length, staged: items.filter((i) => i.staged).length, older: older.length },
      canPublish: !paused,
      publishingPaused: paused,
    });
  } catch (err) { fail(res, err); }
});

/* Send saved changes to staging (any staff). Body { ids? }: every unsent change when missing. */
router.post("/changes/stage", async (req, res) => {
  if (needToken(res)) return;
  try {
    const rows = (await CmsChange.find({ wip: { $ne: null } }).lean()).filter((r) => CMS_TYPES.includes(r.type));
    const pick = pickIds(rows.map((r) => r.docId), req.body?.ids);
    if (pick.error) return res.status(400).json({ error: pick.error });
    if (!pick.ids.length) return res.status(409).json({ error: "There are no saved changes to send to staging." });
    const want = new Set(pick.ids);
    const chosen = rows.filter((r) => want.has(r.docId));
    const skipped = chosen.map((r) => ({ id: r.docId, missing: missingRequired(r.type, r.wip), note: "" }))
      .filter((x) => x.missing.length).map((x) => ({ ...x, note: incompleteNote(chosen.find((r) => r.docId === x.id), x.missing) }));
    const skip = new Set(skipped.map((x) => x.id));
    if (skipped.length === chosen.length) return res.status(409).json({ error: skipped[0].note, skipped });
    const staged = await stageRows(req, chosen.filter((r) => !skip.has(r.docId)));
    res.json({ ok: true, staged, skipped });
  } catch (err) { fail(res, err); }
});

/* Publish what's on staging to the live site (any staff, since Nov 17 2026: "Allow staff to publish to prod from staging"). Body { ids? }: everything on staging when missing. */
router.post("/changes/publish", async (req, res) => {
  if (needToken(res)) return;
  if (await refuseWhilePaused(res)) return;
  try {
    const out = await query(`*[_id in path("drafts.**") && _type in $types]`, { types: CMS_TYPES });
    const stagedIds = new Set((await CmsChange.find({ stagedAt: { $exists: true } }, { docId: 1 }).lean()).map((r) => r.docId));
    const drafts = (out.result || []).filter((d) => stagedIds.has(publishedId(d._id)));
    const pick = pickIds(drafts.map((d) => publishedId(d._id)), req.body?.ids);
    if (pick.error) return res.status(400).json({ error: pick.error });
    if (!pick.ids.length) return res.status(409).json({ error: "Nothing is on staging waiting to be published." });
    const want = new Set(pick.ids);
    const docs = await publishDrafts(req, drafts.filter((d) => want.has(publishedId(d._id))));
    res.json({ ok: true, published: docs.map((d) => d._id) });
  } catch (err) { fail(res, err); }
});

/* ?drafts=1 (the editors): each row is its newest content (unsent > staged > live), with
   hasDraft (unsent changes), staged and unpublished. Without it: the live documents only. */
/* A YouTube / Vimeo link → { provider, videoId, url, title, thumbnailUrl } for the Videos editor
   (Nov 18 2026). Asks the provider's public oEmbed for the title and picture; 400 when it isn't one. */
router.get("/video-info", async (req, res) => {
  const info = await videoInfo(String(req.query.url || "").slice(0, 500));
  if (!info) return res.status(400).json({ error: "Paste a YouTube or Vimeo link" });
  res.json(info);
});

router.get("/:type", async (req, res) => {
  const { type } = req.params;
  if (!CMS_TYPES.includes(type)) return res.status(404).json({ error: "Unknown content type" });
  try {
    const order = type === "session" ? "order(day asc, time asc)"
      : type === "event" ? "order(year asc, startDate asc)"
      : type === "video" ? "order(coalesce(order, 9999) asc, recordedOn desc, title asc)" : "order(coalesce(order, 9999) asc, name asc)";
    const out = await query(`*[_type == $type && !(_id in path("drafts.**"))] | ${order} { ${LIST_FIELDS} }`, { type });
    if (req.query.drafts !== "1") return res.json(out.result || []);
    const drafts = await query(`*[_type == $type && _id in path("drafts.**")] { ${LIST_FIELDS} }`, { type });
    const rows = await CmsChange.find({ type }).lean();
    const stagedIds = new Set(rows.filter(isStaged).map((r) => r.docId));
    const wips = rows.filter((w) => w.wip).map((w) => ({ docId: w.docId, wip: withAssetUrls(w.wip, PROJECT, DATASET) }));
    res.json(overlayChanges(out.result || [], (drafts.result || []).filter((d) => stagedIds.has(publishedId(d._id))), wips));
  } catch (err) { fail(res, err); }
});

// Types with one document whose id is the type's name, and the types that are never created straight to live.
const ONE_DOC = { homePage: "The home page", siteCopy: "The website text & media list" };
const ALWAYS_DRAFT = ["event", ...Object.keys(ONE_DOC)];

/* Create. ?draft=1 (the panel), and always for events and the home page: saved as unsent work,
   on no website until it's sent to staging and published. Without it the document goes
   straight to the live site, management only. */
router.post("/:type", async (req, res, next) => {
  const live = req.query.draft !== "1" && !ALWAYS_DRAFT.includes(req.params.type);
  return live ? requireManagement(req, res, next) : next();
}, async (req, res) => {
  const { type } = req.params;
  if (!CMS_TYPES.includes(type)) return res.status(404).json({ error: "Unknown content type" });
  if (needToken(res)) return;
  const { set, error } = toSanityPatch(type, req.body || {}, { creating: true, draft: req.query.draft === "1" });
  if (error) return res.status(400).json({ error });
  try {
    if (!(req.query.draft === "1" || ALWAYS_DRAFT.includes(type)) && await refuseWhilePaused(res)) return;
    if (req.query.draft === "1" || ALWAYS_DRAFT.includes(type)) {
      let id, extra = {};
      if (type === "event") {
        const key = eventKeyFor(set);
        if (!key) return res.status(400).json({ error: "An event needs a city, a year and a type" });
        id = `event-${key}`;
        extra = { eventKey: { _type: "slug", current: key } };
        const taken = await query(`count(*[_id in [$id, $d] || eventKey.current == $key])`, { id, d: draftId(id), key });
        if (taken?.result || await CmsChange.exists({ docId: id })) return res.status(409).json({ error: "There is already an event for that city, year and type." });
      } else if (ONE_DOC[type]) {
        id = type;
        const taken = await query(`count(*[_id in [$id, $d]])`, { id, d: draftId(id) });
        if (taken?.result || await CmsChange.exists({ docId: id })) return res.status(409).json({ error: `${ONE_DOC[type]} already exists. Edit it instead.` });
      } else {
        id = newDocId(type);
      }
      const doc = { _id: id, _type: type, ...extra, ...set };
      await CmsChange.create({ docId: id, type, wip: doc, wipAt: new Date(), wipBy: who(req) });
      await audit(req, "cms_create", type, id, `${auditCreateDetail(set)} (saved, not sent)`);
      return res.status(201).json({ ...withAssetUrls(doc, PROJECT, DATASET), hasDraft: true, staged: false, unpublished: true });
    }
    const out = await mutate([{ create: { _type: type, ...set } }]);
    const doc = out.results?.[0]?.document;
    await audit(req, "cms_create", type, doc?._id, auditCreateDetail(set));
    res.status(201).json(doc);
  } catch (err) { fail(res, err); }
});

/* Edit. ?draft=1 (the panel): saved as unsent work on top of the newest version (unsent >
   staged > live). Without it the live document changes at once: the agenda's event-day
   switches and any older caller. */
router.patch("/:type/:id", async (req, res) => {
  const { type, id } = req.params;
  if (!CMS_TYPES.includes(type)) return res.status(404).json({ error: "Unknown content type" });
  if (needToken(res)) return;
  const { set, unset, error } = toSanityPatch(type, req.body || {}, { creating: false, draft: req.query.draft === "1" });
  if (error) return res.status(400).json({ error });
  if (!Object.keys(set).length && !unset.length) return res.status(400).json({ error: "Nothing to change" });
  try {
    if (req.query.draft === "1") {
      const st = await loadState(res, type, id);
      if (!st) return;
      if (!st.wip && !st.draft && !st.published) return res.status(409).json({ error: OLDER_ONLY });
      const base = cleanDoc(st.wip || st.draft || st.published);
      const doc = applyPatch({ ...base, _id: id, _type: type }, set, unset);
      await CmsChange.updateOne({ docId: id }, { $set: { type, wip: doc, wipAt: new Date(), wipBy: who(req) }, $setOnInsert: { docId: id } }, { upsert: true });
      await audit(req, "cms_draft", type, id, auditEditDetail(set, unset));
      return res.json({ ...withAssetUrls(doc, PROJECT, DATASET), hasDraft: true, staged: !!st.draft, unpublished: !st.published });
    }
    if (await refuseWhilePaused(res)) return;
    if (!(await sameType(res, type, id))) return;
    const patch = { id };
    if (Object.keys(set).length) patch.set = set;
    if (unset.length) patch.unset = unset;
    const out = await mutate([{ patch }]);
    await audit(req, "cms_edit", type, id, auditEditDetail(set, unset));
    res.json(out.results?.[0]?.document || { _id: id });
  } catch (err) { fail(res, err); }
});

/* Delete from the website, staging and unsent work. Events: management only. */
router.delete("/:type/:id", (req, res, next) => (req.params.type === "event" ? requireManagement(req, res, next) : next()), async (req, res) => {
  const { type, id } = req.params;
  if (!CMS_TYPES.includes(type)) return res.status(404).json({ error: "Unknown content type" });
  if (needToken(res)) return;
  try {
    const st = await loadState(res, type, id);
    if (!st) return;
    if (st.published && await refuseWhilePaused(res)) return;
    await mutate([{ delete: { id } }, { delete: { id: draftId(id) } }]);
    await CmsChange.deleteOne({ docId: id });
    await audit(req, "cms_delete", type, id);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/* Send one document's saved changes to staging (any staff). */
router.post("/:type/:id/stage", async (req, res) => {
  const { type, id } = req.params;
  if (!CMS_TYPES.includes(type)) return res.status(404).json({ error: "Unknown content type" });
  if (needToken(res)) return;
  try {
    const st = await loadState(res, type, id);
    if (!st) return;
    if (!st.wip) return res.status(409).json({ error: "There are no saved changes to send to staging." });
    const missing = missingRequired(type, st.wip);
    if (missing.length) return res.status(409).json({ error: incompleteNote({ type, wip: st.wip }, missing), missing });
    await stageRows(req, [{ ...st.change, type }]);
    res.json({ ...withAssetUrls(st.wip, PROJECT, DATASET), _id: id, hasDraft: false, staged: true, unpublished: !st.published });
  } catch (err) { fail(res, err); }
});

/* Publish one document's staged version (any staff). Unsent changes aren't published:
   they go to staging first, so what goes live is what was reviewed. */
router.post("/:type/:id/publish", async (req, res) => {
  const { type, id } = req.params;
  if (!CMS_TYPES.includes(type)) return res.status(404).json({ error: "Unknown content type" });
  if (needToken(res)) return;
  if (await refuseWhilePaused(res)) return;
  try {
    const st = await loadState(res, type, id);
    if (!st) return;
    if (!st.draft) {
      return res.status(409).json({ error: st.wip ? "Send these changes to staging and check them there before publishing."
        : st.older ? "This is an older draft made outside the admin, so it can't be published from here. Edit the item and send it to staging instead."
          : "Nothing is on staging waiting to be published." });
    }
    const [doc] = await publishDrafts(req, [st.draft]);
    const row = st.wip ? { ...withAssetUrls(st.wip, PROJECT, DATASET), hasDraft: true } : { ...doc, hasDraft: false };
    res.json({ ...row, _id: id, staged: false, unpublished: false });
  } catch (err) { fail(res, err); }
});

/* Throw away changes. ?which=unsent (saved work in progress) | staged (the staging version) |
   all; default: the unsent work if there is any, else the staging version. A document that was
   never published and has nothing left is gone: { deleted: true }. */
router.delete("/:type/:id/draft", async (req, res) => {
  const { type, id } = req.params;
  if (!CMS_TYPES.includes(type)) return res.status(404).json({ error: "Unknown content type" });
  if (needToken(res)) return;
  const which = req.query.which || "";
  if (which && !["unsent", "staged", "older", "all"].includes(which)) return res.status(400).json({ error: "which must be unsent, staged, older or all" });
  try {
    const st = await loadState(res, type, id);
    if (!st) return;
    const dropWip = which === "unsent" || which === "all" || (!which && !!st.wip);
    const dropStaged = which === "staged" || which === "all" || (!which && !st.wip && !!st.draft);
    const dropOlder = which === "older" || which === "all" || (!which && !st.wip && !st.draft && !!st.older);
    if ((dropStaged && st.draft) || (dropOlder && st.older)) await mutate([{ delete: { id: draftId(id) } }]);
    if (dropWip) await CmsChange.updateOne({ docId: id }, { $set: { wip: null }, $unset: { wipAt: 1, wipBy: 1 } });
    if (dropStaged) await CmsChange.updateOne({ docId: id }, { $unset: { stagedAt: 1, stagedBy: 1 } });
    await CmsChange.deleteOne({ docId: id, wip: null, stagedAt: { $exists: false } });
    await audit(req, "cms_discard_draft", type, id, [dropWip && "unsent", dropStaged && "staged", dropOlder && st.older && "older draft"].filter(Boolean).join(" and "));
    const left = (dropWip ? null : st.wip) || (dropStaged ? null : st.draft) || st.published;
    res.json({ ok: true, deleted: !left, row: left ? { ...(left === st.wip ? withAssetUrls(st.wip, PROJECT, DATASET) : left), _id: id,
      hasDraft: left === st.wip, staged: !dropStaged && !!st.draft, unpublished: !st.published } : null });
  } catch (err) { fail(res, err); }
});

export { cmsFieldsFor };
export default router;
