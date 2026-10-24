/* =========================================================
   App logos as raster images (Oct 24 2026)
   ---------------------------------------------------------
   The organiser: "is the logo update done" (some organisations
   showed a letter instead of their logo in the apps).

   The native apps draw a logo with code that can't decode SVG
   or ICO (iOS UIImage, Android Coil without an SVG decoder), so
   an organisation whose stored logo is an .svg or .ico got the
   monogram tile. Nothing stored changes: the apps' payload gets
   a PNG rendering of the same file from the image CDN it's on.

     Cloudinary  …/image/upload/<rest>.svg → …/image/upload/f_png,w_512,h_512,c_fit/<rest>.png
                 (a vector: drawn at up to 512 px, so a logo saved
                 at 28 × 27 px comes out crisp, not tiny)
                 …/image/upload/<rest>.ico → …/image/upload/f_png,w_512,h_512,c_limit/<rest>.png
                 (a bitmap: never enlarged)
     Sanity      cdn.sanity.io/images/…svg → same URL ?fm=png&w=512&h=512&fit=clip
                 (the apps add ?h=160&fit=max&fm=png to a Sanity
                 link without a query, which keeps a small SVG at
                 its own size; a link with a query is used as it is)
     Anything else (PNG, JPG, WebP, GIF, another host, a logo kept
     in our database at /api/files/company-logo/:id, "") is
     returned unchanged.

   Pure: no I/O. Used by services/organisations.js
   organisationsPayload (GET /api/app/organisations), which also
   sends the stored URL as `logoOriginal` for the website.
========================================================= */

const CLOUDINARY_HOST = "res.cloudinary.com";
const SANITY_HOST = "cdn.sanity.io";

/** The Cloudinary transformation for each kind we convert. */
export const CLOUDINARY_PNG = Object.freeze({
  svg: "f_png,w_512,h_512,c_fit",
  ico: "f_png,w_512,h_512,c_limit",
});
/** Sanity image-pipeline parameters for an SVG. */
export const SANITY_PNG = Object.freeze({ fm: "png", w: "512", h: "512", fit: "clip" });

/** "svg" | "ico" | "" from a URL's path (query and fragment ignored, any case). */
export function vectorOrIconKind(pathname) {
  const m = /\.(svg|ico)$/i.exec(String(pathname || ""));
  return m ? m[1].toLowerCase() : "";
}

/** A logo URL as the native apps can draw it (see above); "" for anything that isn't a string. */
export function appLogoUrl(url) {
  if (typeof url !== "string") return "";
  const raw = url.trim();
  if (!raw) return "";
  let u;
  try { u = new URL(raw); } catch { return raw; }
  if (u.protocol !== "https:") return raw;
  const kind = vectorOrIconKind(u.pathname);
  if (!kind) return raw;

  if (u.hostname === CLOUDINARY_HOST) {
    const at = u.pathname.indexOf("/image/upload/");
    if (at < 0) return raw;                                   // fetch / private / authenticated delivery: left alone
    const head = u.pathname.slice(0, at + "/image/upload/".length);
    const rest = u.pathname.slice(head.length);
    if (rest.startsWith(`${CLOUDINARY_PNG[kind]}/`)) return raw;      // already converted
    u.pathname = `${head}${CLOUDINARY_PNG[kind]}/${rest.replace(/\.(svg|ico)$/i, ".png")}`;
    return u.toString();
  }

  if (u.hostname === SANITY_HOST && kind === "svg" && u.pathname.startsWith("/images/")) {
    for (const [k, v] of Object.entries(SANITY_PNG)) u.searchParams.set(k, v);
    return u.toString();
  }
  return raw;
}
