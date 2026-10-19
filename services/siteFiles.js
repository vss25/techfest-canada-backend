/* =========================================================
   Large site files: the website's home page video and its
   brochure PDF (Admin › Site settings › Large site files).
   ---------------------------------------------------------
   They used to ship inside every website deploy (public/hero-bg.mp4
   26 MB, public/Brochure.pdf 15.6 MB), which filled Vercel's 10 GB
   deployment storage. Management uploads each once instead:
     1. POST /api/cms/upload-file?filename=… with the raw file
        (routes/cms.js uploadSiteFile; server.js mounts it before
        the JSON parsers) → the same bytes become a Sanity file
        asset on cdn.sanity.io → { assetId, url };
     2. the panel saves that url in the app content key below
        (PUT /api/console/app-content/:key, cleaned by cleanContent
        in services/adminHelpers.js with cleanSiteFileUrl).
   The website reads the keys from GET /api/app/content and uses its
   own copies while they're empty; brochure emails link the uploaded
   PDF when there is one (routes/brochure.js). Pure, unit-tested in
   test/site-files.test.js.
========================================================= */

export const SITE_FILE_MAX_BYTES = 40 * 1024 * 1024;
export const SITE_FILE_TOO_BIG = "Files must be 40 MB or smaller.";

/** What may be uploaded: Content-Type → file extension. */
export const SITE_FILE_TYPES = Object.freeze({ "video/mp4": "mp4", "application/pdf": "pdf" });

/** The app content keys that hold the uploaded files' URLs → the extension each one takes. */
export const SITE_FILE_KEYS = Object.freeze({ "site.hero_video_url": "mp4", "site.brochure_url": "pdf" });

export const BROCHURE_URL_KEY = "site.brochure_url";

// MP4 / ISO base media "ftyp" brands browsers play. QuickTime (.mov, brand "qt  ") is refused.
const MP4_BRANDS = /^(isom|iso[2-9]|mp41|mp42|avc1|M4V |M4VP|MSNV|dash|mmp4|3gp[4-6])$/;

/** What the bytes are, from the file itself (never from what the sender claimed): a MIME type or "". */
export function sniffSiteFile(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return "";
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (buf.subarray(4, 8).toString("latin1") === "ftyp" && MP4_BRANDS.test(buf.subarray(8, 12).toString("latin1"))) return "video/mp4";
  return "";
}

/** "Hero video (final).MP4" → "Hero_video_final.mp4": safe characters, the extension of the real type. */
export function siteFileName(name, ext) {
  const base = String(name || "").trim().replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/[^\w.-]+/g, "_").replace(/_{2,}/g, "_").replace(/^[._-]+|[._-]+$/g, "").slice(0, 80);
  return `${base || "site-file"}.${ext}`;
}

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;   // like Finder shows it

/**
 * Checks an upload before it goes to Sanity.
 * → { type, ext, filename, bytes } or { status, error } (415 wrong type, 413 too big, 400 empty).
 */
export function checkSiteFile({ body, contentType, filename } = {}) {
  const declared = String(contentType || "").split(";")[0].trim().toLowerCase();
  const ext = SITE_FILE_TYPES[declared];
  if (!ext) return { status: 415, error: "Upload an MP4 video or a PDF." };
  if (!Buffer.isBuffer(body) || !body.length) return { status: 400, error: "The file is empty." };
  if (body.length > SITE_FILE_MAX_BYTES) return { status: 413, error: SITE_FILE_TOO_BIG };
  if (sniffSiteFile(body) !== declared) {
    return { status: 415, error: ext === "mp4" ? "That file isn't an MP4 video." : "That file isn't a PDF." };
  }
  return { type: declared, ext, filename: siteFileName(filename, ext), bytes: body.length };
}

/** Audit line for an upload: "hero-bg.mp4 · video/mp4 · 26.0 MB". */
export const siteFileAuditDetail = (c) => `${c.filename} · ${c.type} · ${mb(c.bytes)}`;

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A URL saved in one of SITE_FILE_KEYS: "" (use the website's own copy), or a file on this
 * project's Sanity CDN with the key's extension (what the upload returns). Anything else → null,
 * so a typo or a link to another site never reaches the home page or the brochure emails.
 */
export function cleanSiteFileUrl(key, value, env = process.env) {
  const ext = SITE_FILE_KEYS[key];
  if (!ext) return null;
  const v = String(value ?? "").trim();
  if (!v) return "";
  const project = esc(env?.SANITY_PROJECT_ID || "021qtoci");
  const dataset = esc(env?.SANITY_DATASET || "production");
  const rx = new RegExp(`^https://cdn\\.sanity\\.io/files/${project}/${dataset}/[A-Za-z0-9_-]{8,128}\\.${ext}$`);
  return rx.test(v) ? v : null;
}

/** The URL saved in `key` (AppContent row), or "" when none or not valid. Never throws. */
export async function savedSiteFileUrl(key, { AppContent, env = process.env } = {}) {
  try {
    const row = await AppContent.findOne({ key }).lean();
    return cleanSiteFileUrl(key, row?.value, env) || "";
  } catch {
    return "";
  }
}
