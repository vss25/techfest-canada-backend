/* =========================================================
   Brochure downloads (website /brochures page)
   ---------------------------------------------------------
   Pure helpers so they can be unit-tested
   (test/brochure-downloads.test.js): the brochure catalogue,
   input validation, the "don't email the same brochure twice
   in 10 minutes" window, the attach-or-link decision and the
   staff CSV. routes/brochure.js saves and emails; routes/console.js
   lists them for Admin → Brochure downloads.

   Where the PDF comes from: it lives only in the website's
   public/ folder (served by Vercel at thetechfestival.com/Brochure.pdf).
   The email always carries that link, so it can never point at a
   stale copy. The file is attached as well only when it is small
   enough to land in a company inbox (see DEFAULT_ATTACH_MAX_BYTES).
========================================================= */

import { EVENT } from "./ticketInfo.js";

/* What the website offers. Keep in step with src/pages/Brochures.jsx
   in techfest-canada-frontend (it sends `brochure: "sponsorship"`). */
export const BROCHURES = {
  sponsorship: {
    id: "sponsorship",
    title: "TTFC 2026 Sponsorship Brochure",
    path: "/Brochure.pdf",
    filename: "TechFestivalCanada_2026_Brochure.pdf",
    pages: 14,
  },
};
export const DEFAULT_BROCHURE = "sponsorship";

export const SALES_INBOX = "sales@thetechfestival.com";

// Same person + same brochure inside this window → saved, but not emailed again.
export const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

/* Resend accepts 40 MB, but base64 adds a third and many company mail
   servers refuse anything over 10–20 MB, so a big PDF is linked instead
   of attached. BROCHURE_ATTACH_MAX_MB overrides (0 = always link). */
export const DEFAULT_ATTACH_MAX_BYTES = 7 * 1024 * 1024;

export const MAX_LENGTH = {
  firstName: 80, lastName: 80, company: 160, jobTitle: 120, industry: 80, email: 254, phone: 40,
};

const LABELS = {
  firstName: "First name", lastName: "Last name", company: "Company", jobTitle: "Job title",
  industry: "Industry", email: "Email", phone: "Phone",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Names and companies are put into emails, so links there are spam.
const LINKISH_RE = /(https?:\/\/|www\.|<|>)/i;

/** Trim, drop control characters and squeeze runs of whitespace. */
export function cleanText(v) {
  if (v == null) return "";
  if (typeof v !== "string" && typeof v !== "number") return "";
  return String(v).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Only bots fill the off-screen `_hp` input on the form. */
export function isHoneypotFilled(body) {
  return cleanText(body?._hp) !== "";
}

/** "/brochures?utm=x#y" → "/brochures". Anything that isn't a site path → "". */
export function cleanPage(v) {
  const s = cleanText(v);
  if (!s.startsWith("/") || s.startsWith("//")) return "";
  return s.split(/[?#]/)[0].slice(0, 200);
}

/** Only http(s) referrers, without the query string (it can carry tokens). */
export function cleanReferrer(v) {
  const s = cleanText(v);
  if (!s) return "";
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return `${u.origin}${u.pathname}`.slice(0, 500);
  } catch {
    return "";
  }
}

/**
 * Check what the brochure form sent.
 * @returns {{ ok: true, value: object } | { ok: false, error: string, field: string }}
 */
export function validateBrochureRequest(body) {
  const b = body && typeof body === "object" ? body : {};
  const v = {};
  for (const k of Object.keys(MAX_LENGTH)) v[k] = cleanText(b[k]);
  v.email = v.email.toLowerCase();

  const fail = (field, error) => ({ ok: false, field, error });

  if (!v.firstName) return fail("firstName", "First name is required");
  if (!v.lastName) return fail("lastName", "Last name is required");
  if (!v.email) return fail("email", "Email is required");
  for (const k of Object.keys(MAX_LENGTH)) {
    if (v[k].length > MAX_LENGTH[k]) return fail(k, `${LABELS[k]} is too long`);
  }
  if (!EMAIL_RE.test(v.email)) return fail("email", "Enter a valid email address");
  for (const k of ["firstName", "lastName", "company", "jobTitle", "industry"]) {
    if (LINKISH_RE.test(v[k])) return fail(k, `${LABELS[k]} can't contain links`);
  }
  // Phone is free text (people write "mobile", "ext 4"…) as long as it has digits and no links.
  if (v.phone && (!/\d/.test(v.phone) || LINKISH_RE.test(v.phone))) return fail("phone", "Enter a valid phone number");

  const brochure = cleanText(b.brochure) || DEFAULT_BROCHURE;
  if (!Object.prototype.hasOwnProperty.call(BROCHURES, brochure)) return fail("brochure", "Unknown brochure");

  return {
    ok: true,
    value: { ...v, brochure, page: cleanPage(b.page), referrer: cleanReferrer(b.referrer) },
  };
}

/** Start of the "already emailed" window. */
/* ---------- Bot sign-ups ----------
   A form-filling bot (Oct 2026) puts random mixed-case strings in every text
   field ("sBjcqBNbVdtgTqNpaFfxDebP") next to a real, scraped email address.
   Emailing those addresses would spam real people, so such rows are saved as
   spam, never emailed and hidden from the admin list by default. */
const BOT_FIELDS = ["firstName", "lastName", "company", "jobTitle"];
export const MIN_FILL_MS = 2500; // nobody types name + email + company this fast

/** "sBjcqBNbVdtg" → true. Real names and brands ("McDonald", "LinkedIn", "YouTubeShorts", "IBM") → false. */
export function isRandomToken(word) {
  const w = String(word || "");
  if (w.length < 10) return false;
  const lowerToUpper = (w.match(/[a-z][A-Z]/g) || []).length;
  return lowerToUpper >= 3;
}

/** Why this submission looks like a bot, or "" when it looks human. */
export function botReason(v, body = {}) {
  for (const k of BOT_FIELDS) {
    if (String(v[k] || "").split(/\s+/).some(isRandomToken)) return `random text in ${k}`;
  }
  const elapsed = Number(body.elapsedMs);
  if (body.elapsedMs !== undefined && body.elapsedMs !== "" && Number.isFinite(elapsed) && elapsed >= 0 && elapsed < MIN_FILL_MS) {
    return "form filled too fast";
  }
  return "";
}

export function dedupeSince(now = Date.now()) {
  return new Date(now - DEDUPE_WINDOW_MS);
}

/** Public website the PDF is served from (BROCHURE_BASE_URL overrides, e.g. a preview deploy). */
export function websiteBase(env = process.env) {
  const raw = cleanText(env?.BROCHURE_BASE_URL) || EVENT.website;
  return raw.replace(/\/+$/, "");
}

export function brochureUrl(brochure, base = EVENT.website) {
  return `${String(base).replace(/\/+$/, "")}${brochure.path}`;
}

export function salesInbox(env = process.env) {
  const list = cleanText(env?.BROCHURE_SALES_INBOX || "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : [SALES_INBOX];
}

export function attachMaxBytes(env = process.env) {
  const raw = env?.BROCHURE_ATTACH_MAX_MB;
  if (raw == null || String(raw).trim() === "") return DEFAULT_ATTACH_MAX_BYTES;
  const mb = Number(raw);
  if (!Number.isFinite(mb) || mb < 0) return DEFAULT_ATTACH_MAX_BYTES;
  return Math.min(mb, 25) * 1024 * 1024; // never past what inboxes take
}

export function shouldAttach(bytes, maxBytes = DEFAULT_ATTACH_MAX_BYTES) {
  const n = Number(bytes);
  return Number.isFinite(n) && n > 0 && maxBytes > 0 && n <= maxBytes;
}

/**
 * Fetch the PDF from the website for attaching, or null to send the link only
 * (too big, unknown size, not a PDF, slow or unreachable). Never throws.
 * HEAD first so an oversized file is never downloaded into memory.
 */
export async function loadAttachment(brochure, { base = EVENT.website, maxBytes = DEFAULT_ATTACH_MAX_BYTES, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  if (!brochure || !(maxBytes > 0) || typeof fetchImpl !== "function") return null;
  const url = brochureUrl(brochure, base);
  try {
    const head = await fetchImpl(url, { method: "HEAD", signal: AbortSignal.timeout(timeoutMs) });
    if (!head.ok || !shouldAttach(head.headers.get("content-length"), maxBytes)) return null;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const content = Buffer.from(await res.arrayBuffer());
    if (!shouldAttach(content.length, maxBytes) || content.subarray(0, 5).toString("latin1") !== "%PDF-") return null;
    return { filename: brochure.filename, content };
  } catch {
    return null;
  }
}

/** Search box in Admin → Brochure downloads (name, email, company, job title, phone). */
export function downloadsFilter(q) {
  const s = cleanText(q).slice(0, 100);
  if (!s) return {};
  const rx = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const or = ["firstName", "lastName", "email", "company", "jobTitle", "phone", "industry"].map((k) => ({ [k]: rx }));
  // "Jane Doe" → first + last name
  const parts = s.split(" ");
  if (parts.length > 1) {
    const esc = (p) => new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    or.push({ firstName: esc(parts[0]), lastName: esc(parts.slice(1).join(" ")) });
  }
  return { $or: or };
}

/** What the admin table gets for one saved download. */
export function downloadRow(d) {
  const brochure = BROCHURES[d.brochure || DEFAULT_BROCHURE];
  return {
    id: String(d._id),
    name: [d.firstName, d.lastName].filter(Boolean).join(" "),
    firstName: d.firstName || "", lastName: d.lastName || "",
    email: d.email || "", company: d.company || "", jobTitle: d.jobTitle || "",
    industry: d.industry || "", phone: d.phone || "",
    brochure: d.brochure || DEFAULT_BROCHURE,
    brochureTitle: brochure?.title || d.brochure || "",
    page: d.page || "", referrer: d.referrer || "",
    // Saved before emailing existed → "legacy"
    emailStatus: d.emailStatus || "legacy",
    spam: !!d.spam,
    delivery: d.delivery || "",
    salesNotified: !!d.salesNotified,
    createdAt: d.createdAt,
  };
}

/* One CSV cell. Leading = + - @ are neutralised so a name can't run as a
   spreadsheet formula when staff open the file. */
export function csvCell(v) {
  let s = typeof v === "boolean" ? (v ? "Yes" : "No") : String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_HEAD = [
  "Downloaded (UTC)", "First name", "Last name", "Email", "Company", "Job title", "Industry", "Phone",
  "Brochure", "Page", "Referrer", "Brochure email", "Sales notified",
];

const STATUS_LABEL = {
  sent: "Sent", sending: "Sending", failed: "Failed", duplicate: "Skipped (sent in last 10 min)", legacy: "Not emailed (before Oct 2026)",
};

export function downloadsCsv(rows) {
  const lines = rows.map((d) => {
    const r = downloadRow(d);
    const status = r.emailStatus === "sent" && r.delivery ? `Sent (${r.delivery === "attached" ? "PDF attached" : "link"})` : STATUS_LABEL[r.emailStatus] || r.emailStatus;
    return [
      r.createdAt ? new Date(r.createdAt).toISOString().replace("T", " ").slice(0, 19) : "",
      r.firstName, r.lastName, r.email, r.company, r.jobTitle, r.industry, r.phone,
      r.brochureTitle, r.page, r.referrer, status, r.salesNotified,
    ].map(csvCell).join(",");
  });
  return "﻿" + [CSV_HEAD.map(csvCell).join(","), ...lines].join("\n");
}
