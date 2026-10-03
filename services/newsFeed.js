import axios from "axios";

/* =========================================================
   Daily company news from GDELT (api.gdeltproject.org, DOC 2.0)
   =========================================================
   Free, no key, and licensed for commercial use with attribution
   ("Source: GDELT Project"). GDELT asks for at most one request
   every 5 seconds per IP, so the intel route fetches companies
   sequentially once a day and caches the result — phones never
   call GDELT directly.
========================================================= */

const ENDPOINT = "https://api.gdeltproject.org/api/v2/doc/doc";
export const GDELT_SPACING_MS = 10000;   // documented 5 s; 10 s avoids 429s in practice

/** Disambiguating keywords for short / generic company names. */
const QUERY_HINTS = {
  "IBM": "IBM technology", "ADP": "ADP payroll", "BDC": "\"Business Development Bank of Canada\"",
  "DHL": "DHL logistics", "CBC": "\"CBC News\"", "KPMG": "KPMG", "NYU": "\"New York University\"",
  "LCBO": "LCBO", "Marsh": "\"Marsh McLennan\"", "Kraken": "Kraken crypto",
  "Amazon": "Amazon AWS", "Terranova Aerospace & Defense": "\"Terranova\" defense",
  "Ontario IESO": "IESO Ontario", "NEJM Group": "\"New England Journal of Medicine\"",
};

export function queryFor(company) {
  const clean = company.replace(/["]/g, "");
  // GDELT rejects quoted phrases shorter than ~4 characters.
  const base = QUERY_HINTS[company] || (clean.length < 5 ? clean : `"${clean}"`);
  return `${base} sourcelang:english`;
}

/** "20261002T143000Z" → "Oct 2" */
export function dateLabel(seendate, now = new Date()) {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(seendate || ""));
  if (!m) return "";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const opts = { month: "short", day: "numeric", timeZone: "UTC" };
  if (d.getUTCFullYear() !== now.getUTCFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("en-CA", opts).replace(".", "");
}

/** Pure: GDELT ArtList JSON → up to 3 de-duplicated updates. */
/** Words in a company name that a relevant headline must mention
 *  ("IBM Consulting" → ibm; "JPMorgan Chase & Co." → jpmorgan). */
export function nameKeys(company) {
  const words = String(company || "").toLowerCase().replace(/[^a-z0-9& ]/g, " ").split(/\s+/).filter(Boolean);
  const stop = new Set(["the", "of", "and", "&", "co", "inc", "group", "corporation", "technologies", "international", "canada"]);
  const keys = words.filter((w) => !stop.has(w) && w.length >= 2);
  return keys.length ? [keys[0]] : words.slice(0, 1);
}

export function toUpdates(json, max = 3, company = "") {
  const seen = new Set();
  const out = [];
  const keys = company ? nameKeys(company) : [];
  for (const a of json?.articles || []) {
    const title = String(a.title || "").replace(/\s+/g, " ").trim();
    if (!title || title.length < 20) continue;
    // Drop off-topic results (e.g. a philanthropy story under "Dell").
    if (keys.length && !keys.some((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(title))) continue;
    const key = title.toLowerCase().slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      headline: title.slice(0, 200),
      source: String(a.domain || "").replace(/^www\./, ""),
      dateLabel: dateLabel(a.seendate),
      url: a.url,
    });
    if (out.length >= max) break;
  }
  return out;
}

export async function fetchCompanyNews(company, { timespan = "7d", retry = true } = {}) {
  try {
    return await fetchOnce(company, timespan);
  } catch (err) {
    if (retry && err.response?.status === 429) {
      await new Promise((r) => setTimeout(r, 20000));
      return fetchOnce(company, timespan);
    }
    throw err;
  }
}

async function fetchOnce(company, timespan) {
  const res = await axios.get(ENDPOINT, {
    params: { query: queryFor(company), mode: "ArtList", maxrecords: 15, format: "json", timespan, sort: "DateDesc" },
    timeout: 20000,
    responseType: "text",
    transformResponse: (r) => r,
  });
  const body = String(res.data || "");
  if (!body.trim().startsWith("{")) throw new Error(`GDELT said: ${body.slice(0, 80)}`);   // rate-limit notice is plain text
  return toUpdates(JSON.parse(body), 3, company);
}
