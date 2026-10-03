import axios from "axios";

/* =========================================================
   DeepCleer text moderation (docs.deepcleer.com/docs/text-moderation)
   =========================================================
   POST {DEEPCLEER_ENDPOINT}  (default: US-East /text/v4)
   {
     accessKey, appId, eventId, type: "TEXTRISK", acceptLang: "en",
     data: { text, tokenId, lang, dataId, relateText }
   }
   → { code: 1100, riskLevel: "PASS" | "REVIEW" | "REJECT", riskLabel1, riskDescription, allLabels[] }

   Pricing agreed Sept 23: ~$0.35 per 1,000 messages.
========================================================= */

export const DEFAULT_ENDPOINT = "http://api-text-fjny.fengkongcloud.com/text/v4";

export function isConfigured() {
  return Boolean(process.env.DEEPCLEER_ACCESS_KEY);
}

/** Pure: DeepCleer response → the app's verdict. Exported for tests. */
export function toVerdict(data, { holdOnReview = true } = {}) {
  if (!data || data.code !== 1100) {
    return { flagged: false, reason: null, riskLevel: "UNKNOWN", labels: [], ok: false, code: data?.code };
  }
  const level = String(data.riskLevel || "PASS").toUpperCase();
  const labels = [data.riskLabel1, data.riskLabel2, data.riskLabel3]
    .filter((l) => l && l !== "normal");
  const flagged = level === "REJECT" || (holdOnReview && level === "REVIEW");
  return {
    flagged,
    reason: flagged ? (data.riskDescription || labels.join(", ") || level.toLowerCase()) : null,
    riskLevel: level,
    labels,
    ok: true,
  };
}

/**
 * Checks one piece of text. Throws when not configured so callers can
 * respond 503 and let the client fall back.
 */
export async function moderateText({ text, userId = "anonymous", context = "event-app", lang = "en" }) {
  if (!isConfigured()) throw Object.assign(new Error("DeepCleer not configured"), { code: "NOT_CONFIGURED" });
  const body = {
    accessKey: process.env.DEEPCLEER_ACCESS_KEY,
    appId: process.env.DEEPCLEER_APP_ID || "default",
    eventId: process.env.DEEPCLEER_EVENT_ID || "text",
    type: process.env.DEEPCLEER_TYPE || "TEXTRISK",
    acceptLang: "en",
    data: {
      text: String(text).slice(0, 10000),
      tokenId: String(userId).slice(0, 64),
      lang,
      dataId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      relateText: String(context).slice(0, 128),
    },
  };
  const res = await axios.post(process.env.DEEPCLEER_ENDPOINT || DEFAULT_ENDPOINT, body, {
    timeout: Number(process.env.DEEPCLEER_TIMEOUT_MS || 2500),
    headers: { "Content-Type": "application/json" },
  });
  return toVerdict(res.data, { holdOnReview: process.env.DEEPCLEER_HOLD_ON_REVIEW !== "false" });
}
