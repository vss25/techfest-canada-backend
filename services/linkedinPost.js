import axios from "axios";

/* =========================================================
   Posting the "I'm attending" image to someone's LinkedIn
   ---------------------------------------------------------
   For the website's /attending page on a computer: the person
   approves "post on your behalf" on LinkedIn, then we upload the
   image (Images API: initializeUpload, then PUT the PNG) and create
   the post with their text (Posts API), so the image is attached
   with no download. Needs the LinkedIn app's "Share on LinkedIn"
   product (scope w_member_social).

   LinkedIn retires API versions after about a year and answers 426
   for a retired one, so we try the next version in the list.
   LINKEDIN_API_VERSION (YYYYMM), when set, goes first.
========================================================= */

export const API_VERSIONS = ["202609", "202606", "202603", "202512"];
const API = "https://api.linkedin.com/rest";

export function apiVersions(env = process.env) {
  const own = /^\d{6}$/.test(String(env.LINKEDIN_API_VERSION || "")) ? [env.LINKEDIN_API_VERSION] : [];
  return [...new Set([...own, ...API_VERSIONS])];
}

/**
 * LinkedIn's "little text" for post commentary: its reserved characters
 * are escaped (unescaped, LinkedIn cuts the post short), and a #Tag at
 * the start of a word stays a hashtag.
 */
export function littleText(text) {
  return String(text || "").replace(/(?<=^|\s)#([\p{L}\p{N}]+)|[\\|{}@[\]()<>#*_~]/gu,
    (m, tag) => (tag ? `{hashtag|\\#|${tag}}` : `\\${m}`));
}

const isRetiredVersion = (err) => err?.response?.status === 426
  || /VERSION/.test(String(err?.response?.data?.code || ""));

/** Uploads the PNG and publishes the post. Returns { urn, url }. Throws LinkedIn's error otherwise. */
export async function postImageToLinkedin({ accessToken, personId, png, text, title = "I'm attending TTFC 2026", altText = "", http = axios, versions = apiVersions(), wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!accessToken || !personId || !png?.length) throw new Error("Missing token, member or image");
  const author = `urn:li:person:${personId}`;
  let lastErr;
  for (const version of versions) {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "LinkedIn-Version": version,
      "X-Restli-Protocol-Version": "2.0.0",
      "Content-Type": "application/json",
    };
    try {
      const init = await http.post(`${API}/images?action=initializeUpload`, { initializeUploadRequest: { owner: author } }, { headers, timeout: 15000 });
      const { uploadUrl, image } = init.data?.value || {};
      if (!uploadUrl || !image) throw new Error("LinkedIn didn't give an upload address");
      await http.put(uploadUrl, png, {
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/octet-stream" },
        timeout: 30000, maxBodyLength: Infinity, maxContentLength: Infinity,
      });
      const body = {
        author,
        commentary: littleText(text),
        visibility: "PUBLIC",
        distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
        content: { media: { title, id: image, ...(altText ? { altText } : {}) } },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      };
      let post;
      try {
        post = await http.post(`${API}/posts`, body, { headers, timeout: 15000 });
      } catch (err) {
        // A just-uploaded image can still be processing: one more try shortly after.
        const s = err?.response?.status;
        if (s !== 400 && s !== 422 && !(s >= 500)) throw err;
        await wait(2500);
        post = await http.post(`${API}/posts`, body, { headers, timeout: 15000 });
      }
      const urn = String(post.headers?.["x-restli-id"] || post.headers?.["x-linkedin-id"] || post.data?.id || "");
      return { urn, url: /^urn:li:(share|ugcPost):\d+$/.test(urn) ? `https://www.linkedin.com/feed/update/${urn}/` : "" };
    } catch (err) {
      lastErr = err;
      if (!isRetiredVersion(err)) throw err;
    }
  }
  throw lastErr;
}
