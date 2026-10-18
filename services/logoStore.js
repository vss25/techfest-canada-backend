/* =========================================================
   Where a company logo picked in Admin → People is kept.
   We never hotlink: the picked image is fetched (services/
   logoFetch.js safeFetch) or uploaded, checked, and re-hosted:
     1. Cloudinary, when CLOUDINARY_CLOUD_NAME / _API_KEY /
        _API_SECRET are set (the feed media setup, services/
        cloudinary.js), folder ttfc/logos;
     2. otherwise Sanity assets (SANITY_WRITE_TOKEN, the same
        project and dataset as /api/cms uploads);
     3. otherwise our own database (CompanyLogo), served at
        GET /api/files/company-logo/:id, so it still works on a
        server with neither (and on a local copy).
   Files are named after the company and the image's hash, so
   saving the same image twice stores it once.
========================================================= */

import { createHash } from "node:crypto";
import { config as cloudinaryConfig, sign } from "./cloudinary.js";
import { sniffImage, icoLargestPng, MAX_BYTES } from "./logoFetch.js";

export const LOGO_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/x-icon"];
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/x-icon": "ico" };

/** "cloudinary" | "sanity" | "database": the first one that's configured. */
export function chooseStore(env = process.env) {
  if (cloudinaryConfig(env).enabled) return "cloudinary";
  if (env.SANITY_WRITE_TOKEN) return "sanity";
  return "database";
}

/**
 * Bytes about to be stored → { buffer, type, ext, width, height, sha } or { error }.
 * The type comes from the bytes, never from what the sender claimed. An .ico that carries
 * a PNG (most modern favicons) is stored as that PNG.
 */
export function prepareLogo(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!b.length) return { error: "That image is empty." };
  if (b.length > MAX_BYTES) return { error: "Logos must be 2 MB or smaller." };
  let img = sniffImage(b);
  let out = b;
  if (img?.type === "image/x-icon") {
    const png = icoLargestPng(b);
    if (png) { out = Buffer.from(png); img = sniffImage(out); }
  }
  if (!img || !LOGO_TYPES.includes(img.type)) return { error: "That isn't a PNG, JPEG, GIF, WebP, SVG or ICO image." };
  return { buffer: out, type: img.type, ext: EXT[img.type], width: img.width, height: img.height, sha: createHash("sha256").update(out).digest("hex") };
}

/** "Dell Technologies" + hash → "dell-technologies-1a2b3c4d" (file names and Cloudinary ids). */
export function logoSlug(name, sha) {
  const base = String(name || "company").toLowerCase().normalize("NFKD").replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "company";
  return `${base}-${String(sha || "").slice(0, 10)}`;
}

/** A data: URL from the admin panel's file upload → Buffer, or null. */
export function decodeLogoDataUrl(data) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(data || ""));
  if (!m) return null;
  return Buffer.from(m[2].replace(/\s+/g, ""), "base64");
}

const SANITY_PROJECT = (env) => env.SANITY_PROJECT_ID || "021qtoci";
const SANITY_DATASET = (env) => env.SANITY_DATASET || "production";

/**
 * Store a prepared logo (prepareLogo output) → { url, store, ref }.
 * @param {object} o
 * @param {object} o.logo        prepareLogo() result
 * @param {string} o.name        company name, for the file name
 * @param {object} [o.env]
 * @param {Function} [o.fetchImpl]
 * @param {(logo) => Promise<string>} o.saveToDb   stores in CompanyLogo, returns its id
 * @param {string} o.apiBase     "https://techfest-canada-backend.onrender.com" (for database-stored logos)
 */
export async function storeLogo({ logo, name, env = process.env, fetchImpl = globalThis.fetch, saveToDb, apiBase = "" }) {
  const store = chooseStore(env);
  const slug = logoSlug(name, logo.sha);

  if (store === "cloudinary") {
    const c = cloudinaryConfig(env);
    const params = { folder: "ttfc/logos", public_id: slug, overwrite: "false", timestamp: Math.floor(Date.now() / 1000) };
    const form = new URLSearchParams({
      ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
      api_key: c.apiKey,
      signature: sign(params, c.apiSecret),
      file: `data:${logo.type};base64,${logo.buffer.toString("base64")}`,
    });
    const r = await fetchImpl(`https://api.cloudinary.com/v1_1/${c.cloudName}/image/upload`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString(),
      signal: AbortSignal.timeout(20000),
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok || !json.secure_url) throw new Error(`Cloudinary didn't take the logo: ${json?.error?.message || r.status}`);
    return { url: json.secure_url, store, ref: String(json.public_id || "") };
  }

  if (store === "sanity") {
    // Sanity's image pipeline doesn't read .ico files: those go up as plain files (still served from its CDN).
    const kind = logo.type === "image/x-icon" ? "files" : "images";
    const url = `https://${SANITY_PROJECT(env)}.api.sanity.io/v2021-10-21/assets/${kind}/${SANITY_DATASET(env)}?filename=${encodeURIComponent(`${slug}.${logo.ext}`)}`;
    const r = await fetchImpl(url, {
      method: "POST", headers: { Authorization: `Bearer ${env.SANITY_WRITE_TOKEN}`, "Content-Type": logo.type }, body: logo.buffer,
      signal: AbortSignal.timeout(20000),
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok || !json?.document?.url) throw new Error(`Sanity didn't take the logo: ${json?.error?.description || json?.message || r.status}`);
    return { url: json.document.url, store, ref: String(json.document._id || "") };
  }

  const id = await saveToDb(logo);
  return { url: `${String(apiBase).replace(/\/+$/, "")}/api/files/company-logo/${id}`, store, ref: String(id) };
}
