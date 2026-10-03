import axios from "axios";

/* =========================================================
   Gemini "intel agent" — one company → { whatTheyDo, updates[] }
   =========================================================
   Uses the REST API with Google Search grounding so updates are real and
   dated. No SDK dependency. Model via GEMINI_MODEL (default gemini-2.5-flash).
========================================================= */

export function isConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

export function buildPrompt(company, today = new Date()) {
  const date = today.toISOString().slice(0, 10);
  return `You write short, factual company cards for the attendee app of The Tech Festival Canada 2026 (Toronto, Oct 26-27 2026). Today is ${date}.

Company: "${company}"

Using web search, return ONLY a JSON object (no markdown, no prose) with this exact shape:
{
  "whatTheyDo": "<one plain-English sentence, max 30 words, present tense, no marketing adjectives>",
  "updates": [
    { "headline": "<max 25 words, factual, past tense, one concrete fact>", "source": "<publication or company newsroom name, no URL>", "dateLabel": "<e.g. 'Sep 18' if within the last 90 days, else 'Aug 2026'>", "url": "<source url>" }
  ]
}
Rules: 2 to 3 updates from the last 6 months, most recent first; business/technology news only; no speculation; if you cannot find dated news, return an empty updates array. If the company name is ambiguous, prefer the organisation most likely to partner with a Canadian enterprise-technology conference.`;
}

/** Pure: pull the first JSON object out of a model reply. Exported for tests. */
export function parseCard(text) {
  if (!text) return null;
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  const updates = Array.isArray(obj.updates) ? obj.updates : [];
  return {
    whatTheyDo: String(obj.whatTheyDo || "").trim().slice(0, 240),
    updates: updates
      .filter((u) => u && u.headline)
      .slice(0, 3)
      .map((u) => ({
        headline: String(u.headline).trim().slice(0, 200),
        source: String(u.source || "").trim().slice(0, 80),
        dateLabel: String(u.dateLabel || "").trim().slice(0, 20),
        url: typeof u.url === "string" ? u.url.slice(0, 500) : undefined,
      })),
  };
}

export async function generateCard(company) {
  if (!isConfigured()) throw Object.assign(new Error("Gemini not configured"), { code: "NOT_CONFIGURED" });
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const res = await axios.post(url, {
    contents: [{ role: "user", parts: [{ text: buildPrompt(company) }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.2 },
  }, { timeout: Number(process.env.GEMINI_TIMEOUT_MS || 45000) });

  const text = res.data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  const card = parseCard(text);
  if (!card) throw new Error(`Gemini returned no JSON for ${company}`);
  return { ...card, model };
}
