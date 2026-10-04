import express from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { AdminAudit } from "../models/Admin.js";
import { cmsFieldsFor, CMS_TYPES, toSanityPatch } from "../services/cmsSchema.js";

/* =========================================================
   /api/cms — edit the website's Sanity content (speakers,
   partners, sponsors, marquee, home sponsors, site settings)
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

function needToken(res) {
  if (token()) return false;
  res.status(503).json({ error: "Editing isn't switched on yet: add SANITY_WRITE_TOKEN on Render (see README)." });
  return true;
}

async function audit(req, action, type, id, detail = "") {
  await AdminAudit.create({ adminId: req.user._id, adminName: req.user.name, action, targetType: `cms:${type}`,
                            targetId: String(id || ""), detail: String(detail).slice(0, 500) }).catch(() => {});
}

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

router.get("/:type", async (req, res) => {
  const { type } = req.params;
  if (!CMS_TYPES.includes(type)) return res.status(404).json({ error: "Unknown content type" });
  try {
    const out = await query(`*[_type == $type && !(_id in path("drafts.**"))] | order(coalesce(order, 9999) asc, name asc) {
      ..., "imageUrl": image.asset->url, "logoUrl": logo.asset->url }`, { type });
    res.json(out.result || []);
  } catch (err) { fail(res, err); }
});

router.post("/:type", async (req, res) => {
  const { type } = req.params;
  if (!CMS_TYPES.includes(type)) return res.status(404).json({ error: "Unknown content type" });
  if (needToken(res)) return;
  const { set, error } = toSanityPatch(type, req.body || {}, { creating: true });
  if (error) return res.status(400).json({ error });
  try {
    const out = await mutate([{ create: { _type: type, ...set } }]);
    const doc = out.results?.[0]?.document;
    await audit(req, "cms_create", type, doc?._id, set.name || "");
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
    const out = await mutate([{ patch }]);
    await audit(req, "cms_edit", type, id, Object.keys(set).concat(unset).join(", "));
    res.json(out.results?.[0]?.document || { _id: id });
  } catch (err) { fail(res, err); }
});

router.delete("/:type/:id", async (req, res) => {
  const { type, id } = req.params;
  if (!CMS_TYPES.includes(type)) return res.status(404).json({ error: "Unknown content type" });
  if (needToken(res)) return;
  try {
    await mutate([{ delete: { id } }, { delete: { id: `drafts.${id}` } }]);
    await audit(req, "cms_delete", type, id);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

export { cmsFieldsFor };
export default router;
