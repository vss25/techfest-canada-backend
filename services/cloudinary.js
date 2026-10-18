import crypto from "node:crypto";

/* =========================================================
   Feed photos and videos on Cloudinary (direct uploads).
   The apps ask us for a signed upload, send the file straight
   to Cloudinary (big videos never pass through Render), then
   create the post with the returned URLs, which we validate.
   Videos are capped at 30 s twice: the apps refuse longer
   clips, and the signed upload carries an incoming trim (du_30)
   the client can't change.
   Env: CLOUDINARY_URL (the one line Cloudinary shows), or
   CLOUDINARY_CLOUD_NAME + CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET.
   Unset → media is off and the apps keep the single inline photo.
========================================================= */

export const MAX_ITEMS = 6;
export const MAX_VIDEO_SECONDS = 30;
const FOLDER = "ttfc/posts";

/** The single line Cloudinary shows: cloudinary://<api_key>:<api_secret>@<cloud_name>. Pure. */
export function parseCloudinaryUrl(raw) {
  const m = /^cloudinary:\/\/([^:@\s]+):([^@\s]+)@([a-z0-9_-]+)\s*$/i.exec(String(raw || "").trim().replace(/^CLOUDINARY_URL=/, ""));
  return m ? { apiKey: m[1], apiSecret: m[2], cloudName: m[3] } : null;
}

export function config(env = process.env) {
  // Either the three separate variables or the one CLOUDINARY_URL line.
  const fromUrl = parseCloudinaryUrl(env.CLOUDINARY_URL) || {};
  const cloudName = env.CLOUDINARY_CLOUD_NAME || fromUrl.cloudName || "";
  const apiKey = env.CLOUDINARY_API_KEY || fromUrl.apiKey || "";
  const apiSecret = env.CLOUDINARY_API_SECRET || fromUrl.apiSecret || "";
  return { cloudName, apiKey, apiSecret, enabled: !!(cloudName && apiKey && apiSecret) };
}

/** Cloudinary's signature: sha1 of the sorted "k=v&k=v" params + the API secret. Pure. */
export function sign(params, apiSecret) {
  const base = Object.keys(params).filter((k) => params[k] !== undefined && params[k] !== "")
    .sort().map((k) => `${k}=${params[k]}`).join("&");
  return crypto.createHash("sha1").update(base + apiSecret).digest("hex");
}

/** Signed parameters for one direct upload. `type`: "image" | "video". */
export function signUpload({ type, userId, now = Date.now(), env = process.env }) {
  const c = config(env);
  if (!c.enabled) return null;
  const resourceType = type === "video" ? "video" : "image";
  const params = {
    folder: `${FOLDER}/${String(userId).replace(/[^a-zA-Z0-9_-]/g, "")}`,
    timestamp: Math.floor(now / 1000),
    // Incoming trim: whatever is sent, Cloudinary stores at most 30 s.
    ...(resourceType === "video" ? { transformation: `du_${MAX_VIDEO_SECONDS}` } : {}),
  };
  return {
    cloudName: c.cloudName,
    apiKey: c.apiKey,
    resourceType,
    uploadUrl: `https://api.cloudinary.com/v1_1/${c.cloudName}/${resourceType}/upload`,
    params: { ...params, signature: sign(params, c.apiSecret) },
    maxVideoSeconds: MAX_VIDEO_SECONDS,
  };
}

/**
 * Validates the media list a client sends with a post: only our own Cloudinary
 * uploads, image/video, videos ≤ 30 s, at most six. Pure.
 */
export function cleanMedia(list, cloudName) {
  if (!Array.isArray(list) || !cloudName) return [];
  const prefix = `https://res.cloudinary.com/${cloudName}/`;
  const out = [];
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    const type = m.type === "video" ? "video" : m.type === "image" ? "image" : null;
    const url = typeof m.url === "string" ? m.url.trim() : "";
    if (!type || !url.startsWith(prefix) || !url.includes(`/${type}/upload/`) || !url.includes(`/${FOLDER}/`)) continue;
    const duration = Number(m.duration) || 0;
    if (type === "video" && duration > MAX_VIDEO_SECONDS + 0.5) continue;
    out.push({
      type, url,
      publicId: String(m.publicId || "").slice(0, 300),
      width: Math.max(0, Math.round(Number(m.width) || 0)),
      height: Math.max(0, Math.round(Number(m.height) || 0)),
      duration: type === "video" ? Math.min(duration, MAX_VIDEO_SECONDS) : 0,
    });
    if (out.length === MAX_ITEMS) break;
  }
  return out;
}

/** Inserts delivery transformations after "/upload/". Pure. */
function withTransform(url, t) {
  return url.replace("/upload/", `/upload/${t}/`);
}

/** What the apps play/show: sized, auto format/quality; videos get a poster frame. Pure. */
export function deliveryMedia(m) {
  if (m.type === "video") {
    const mp4 = withTransform(m.url, `du_${MAX_VIDEO_SECONDS},q_auto,vc_auto,w_720,c_limit`).replace(/\.[a-z0-9]+$/i, ".mp4");
    const poster = withTransform(m.url, "so_0,q_auto,w_720,c_limit").replace(/\.[a-z0-9]+$/i, ".jpg");
    return { type: "video", url: mp4, posterUrl: poster, width: m.width || 0, height: m.height || 0, duration: m.duration || 0 };
  }
  return { type: "image", url: withTransform(m.url, "f_auto,q_auto,w_1080,c_limit"), posterUrl: "", width: m.width || 0, height: m.height || 0, duration: 0 };
}
