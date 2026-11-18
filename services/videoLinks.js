/* =========================================================
   YouTube and Vimeo links (Nov 18 2026: "Add ability to add our videos on YouTube or Vimeo so
   that we can show the videos on our website but it doesn't need to increase my operational /
   hosting cost"). We store only the link: YouTube or Vimeo streams the video, so it costs
   nothing to host. The website shows the thumbnail and loads the player only on play.
========================================================= */

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/** Any YouTube / Vimeo link → { provider, videoId, url (canonical) }, else null. */
export function parseVideoUrl(input) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(String(input || "").trim()) ? String(input).trim() : `https://${String(input || "").trim()}`); } catch { return null; }
  const host = u.hostname.replace(/^www\.|^m\./, "").toLowerCase();
  let id = "";
  if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com" || host === "music.youtube.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v") || "";
    else { const m = /^\/(embed|shorts|live|v)\/([^/?#]+)/.exec(u.pathname); if (m) id = m[2]; }
  }
  if (id && YT_ID.test(id)) return { provider: "youtube", videoId: id, url: `https://www.youtube.com/watch?v=${id}` };
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const m = /\/(?:video\/)?(\d{5,12})(?:\/([0-9a-f]{6,20}))?/.exec(u.pathname);
    if (m) {
      const hash = m[2] || u.searchParams.get("h") || "";   // unlisted videos carry a hash
      return { provider: "vimeo", videoId: hash ? `${m[1]}:${hash}` : m[1], url: `https://vimeo.com/${m[1]}${hash ? `/${hash}` : ""}` };
    }
  }
  return null;
}

/** The provider's public preview picture we can show without asking anyone (YouTube only; Vimeo needs oEmbed). */
export const youtubeThumb = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

const SAFE_THUMB = /^https:\/\/(i\.ytimg\.com|i\.vimeocdn\.com)\//;

/** Title and thumbnail from the provider's public oEmbed (no key). Never throws. */
export async function videoInfo(input, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const v = parseVideoUrl(input);
  if (!v) return null;
  const endpoint = v.provider === "youtube"
    ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(v.url)}`
    : `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(v.url)}`;
  let title = "", thumbnailUrl = v.provider === "youtube" ? youtubeThumb(v.videoId) : "", found = false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetchImpl(endpoint, { signal: ctrl.signal, redirect: "error" });
    clearTimeout(t);
    if (res.ok) {
      const j = await res.json();
      found = true;
      title = String(j.title || "").slice(0, 160);
      if (SAFE_THUMB.test(String(j.thumbnail_url || ""))) thumbnailUrl = j.thumbnail_url;
    }
  } catch { /* offline or private: the link still works */ }
  return { ...v, title, thumbnailUrl, found };
}
