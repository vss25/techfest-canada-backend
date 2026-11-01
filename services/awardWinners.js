import crypto from "node:crypto";

/* =========================================================
   Catalyst Awards winners (Oct 31 2026)
   ---------------------------------------------------------
   The organiser: "update the page to say results are out and here
   are the winners … award name and company … on click the details
   of the award, TTFC, the date it was presented, to who … download
   in PDF or JPG … share on LinkedIn with the TTFC page tagged".

   The winners are the nominations staff marked "winner" (Admin ›
   Catalyst Awards › Nominations). Admin › Catalyst Awards › Winners
   can tidy what the website shows for each (models/Nomination.js
   `award`): the award's name, the company, who it was presented to,
   the date, a line about why, the order, or hide one. Empty = the
   defaults below. site.award_winners off = no winners anywhere.

   Public: never an email, a phone, the nominator or the statement.
========================================================= */

export const WINNERS_KEY = "site.award_winners";
/** Day 1, the Catalyst Awards Gala Night (Toronto). */
export const AWARDS_NIGHT = "2026-10-26";
export const EVENT_NAME = "The Tech Festival Canada 2026";
export const VENUE = "The Westin Harbour Castle, Toronto";

/* The website's award names (src/pages/Awards.jsx PILLARS, SECTORS, SPECIAL_AWARDS) for the canonical
   pillars and sectors nominations store (services/nominations.js). */
export const PILLAR_NAMES = Object.freeze({
  "AI & Machine Learning": "Artificial Intelligence",
  "Quantum Computing": "Quantum Computing",
  "Cybersecurity & Digital Trust": "Cybersecurity",
  "Robotics & Automation": "Robotics",
  "CleanTech & Sustainability": "CleanTech & Sustainability",
});
export const SECTOR_NAMES = Object.freeze({
  "Financial Services & Banking": "Banking, Financial Services & Insurance",
  "Healthcare & Life Sciences": "Healthcare & Life Sciences",
  "Energy & Critical Infrastructure": "Energy & Utilities",
  "Manufacturing, Supply Chain & Mobility": "Manufacturing, Supply Chain & Infrastructure",
  "Public Sector, Defence & Security": "Defence, National Security & Public Safety",
});
export const SPECIAL_NAMES = Object.freeze({
  lifetime: "The Catalyst Lifetime Achievement Award",
  rising: "The Catalyst Rising Innovator Award",
  crossborder: "The Catalyst Cross-Border Impact Award",
});

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const line = (v, max) => str(v).replace(/\s+/g, " ").trim().slice(0, max);
const same = (a, b) => line(a, 300).toLowerCase() === line(b, 300).toLowerCase();

/** "The Catalyst Award for Artificial Intelligence in Healthcare & Life Sciences" / "The Catalyst Rising Innovator Award". */
export function defaultAwardTitle(n = {}) {
  if (n.categoryType === "special") return SPECIAL_NAMES[n.specialAward] || "The Catalyst Special Recognition Award";
  const p = PILLAR_NAMES[n.pillar] || line(n.pillar, 80) || "Technology";
  const s = SECTOR_NAMES[n.sector] || line(n.sector, 80);
  return `The Catalyst Award for ${p}${s ? ` in ${s}` : ""}`;
}

/** The pillar and sector as the website names them ("" for a special award). */
export function awardTags(n = {}) {
  if (n.categoryType === "special") return { pillar: "", sector: "", special: true };
  return { pillar: PILLAR_NAMES[n.pillar] || line(n.pillar, 80), sector: SECTOR_NAMES[n.sector] || line(n.sector, 80), special: false };
}

/** The company: the nominee's organisation, else the nominee. */
export function defaultCompany(n = {}) {
  return line(n.nomineeOrganisation, 160) || line(n.nomineeName, 160);
}

/** Who it was presented to: an individual (or a project) by name, else the company. */
export function defaultPresentedTo(n = {}) {
  return line(n.nomineeName, 160) || defaultCompany(n);
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (s) => ISO_DAY.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`)) && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;

/** What the website shows for a winner (the overrides, else the defaults). */
export function winnerView(n = {}) {
  const a = n.award || {};
  const company = line(a.company, 160) || defaultCompany(n);
  const presentedTo = line(a.presentedTo, 160) || defaultPresentedTo(n);
  return {
    id: String(n._id || n.id || ""),
    award: line(a.title, 200) || defaultAwardTitle(n),
    company,
    presentedTo,
    // The company only when it isn't the same as who it was presented to.
    showCompany: !same(company, presentedTo),
    presentedOn: validDay(str(a.presentedOn)) ? a.presentedOn : AWARDS_NIGHT,
    citation: line(a.citation, 400),
    ...awardTags(n),
    individual: n.nomineeType === "Individual",
    website: publicWebsite(n.nomineeWebsite),
    order: Number.isFinite(a.order) ? a.order : 0,
  };
}

/** The nominee's website as a safe https link ("" when it isn't one). */
export function publicWebsite(raw) {
  const s = line(raw, 300);
  if (!s) return "";
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".") || u.username || u.password) return "";
    u.protocol = "https:";
    return u.toString();
  } catch {
    return "";
  }
}

/** Winners in the website's order: the admin's order (lowest first), then special awards last, then by award name. */
export function sortWinners(list = []) {
  return [...list].sort((a, b) => (a.order || 0) - (b.order || 0)
    || Number(a.special) - Number(b.special)
    || a.award.localeCompare(b.award)
    || a.presentedTo.localeCompare(b.presentedTo));
}

/** The public list: winners that aren't hidden. */
export function publicWinners(noms = []) {
  return sortWinners(noms.filter((n) => n?.status === "winner" && !n.award?.hidden).map(winnerView));
}

/** Admin › Winners: what shows, what was set and what the defaults are. */
export function winnerAdminRow(n = {}) {
  const a = n.award || {};
  return {
    ...winnerView(n),
    hidden: !!a.hidden,
    set: {
      title: str(a.title), company: str(a.company), presentedTo: str(a.presentedTo),
      presentedOn: str(a.presentedOn), citation: str(a.citation), order: Number.isFinite(a.order) ? a.order : 0,
    },
    defaults: { title: defaultAwardTitle(n), company: defaultCompany(n), presentedTo: defaultPresentedTo(n), presentedOn: AWARDS_NIGHT },
    nominee: { name: line(n.nomineeName, 160), type: str(n.nomineeType), organisation: line(n.nomineeOrganisation, 160) },
    category: n.categoryType === "special" ? (SPECIAL_NAMES[n.specialAward] || "Special") : `${str(n.pillar)} × ${str(n.sector)}`,
    updatedBy: str(a.updatedBy),
    updatedAt: a.updatedAt || null,
  };
}

const AWARD_TEXT = { title: 200, company: 160, presentedTo: 160, citation: 400 };

/**
 * PATCH /api/console/nominations/:id/award { title?, company?, presentedTo?, presentedOn?, citation?, order?, hidden? }
 * → { ok, set } | { ok: false, error }. Text "" = back to the default.
 */
export function cleanAwardPatch(body = {}) {
  const b = body && typeof body === "object" ? body : {};
  const set = {};
  for (const [k, max] of Object.entries(AWARD_TEXT)) {
    if (!(k in b)) continue;
    if (b[k] !== null && typeof b[k] !== "string") return { ok: false, error: `${k} must be text.` };
    const v = line(b[k], max + 1);
    if (v.length > max) return { ok: false, error: `${k} is too long (${max} characters at most).` };
    set[k] = v;
  }
  if ("presentedOn" in b) {
    const v = str(b.presentedOn).trim();
    if (v && !validDay(v)) return { ok: false, error: "presentedOn must be a date (YYYY-MM-DD)." };
    set.presentedOn = v;
  }
  if ("order" in b) {
    const v = Number(b.order);
    if (!Number.isInteger(v) || v < -999 || v > 999) return { ok: false, error: "order must be a whole number from -999 to 999." };
    set.order = v;
  }
  if ("hidden" in b) {
    if (typeof b.hidden !== "boolean") return { ok: false, error: "hidden must be true or false." };
    set.hidden = b.hidden;
  }
  if (!Object.keys(set).length) return { ok: false, error: "Nothing to change." };
  return { ok: true, set };
}

/* ---------- "Post to LinkedIn" from a winner's page ----------
   The certificate (a JPEG or PNG the page draws) and the text wait here while they approve posting on LinkedIn
   (models/AwardPost.js, 30 minutes). Its own state prefix and cookie, so the attending and app-share flows on the
   same redirect URI are untouched. The state carries the winner's id ("ttfc-awd.<random>.<id>"), so every way back,
   a lost draft included, lands on that winner's page with the message.
   Sized for what the page sends (Oct 31 2026 review): one certificate JPEG is about 0.3 MB, so 2 MB at most, 20
   drafts per address per 15 minutes, and at most AWARD_DRAFTS_MAX waiting at once for everyone together. */

export const AWARD_STATE_PREFIX = "ttfc-awd.";
export const AWARD_COOKIE = "ttfc_awd_li";
export const AWARD_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const AWARD_DRAFTS_PER_IP = 20;
export const AWARD_DRAFTS_MAX = 150;

export const isWinnerId = (s) => typeof s === "string" && /^[a-f0-9]{24}$/i.test(s);
export const newAwardState = (winnerId = "") =>
  `${AWARD_STATE_PREFIX}${crypto.randomBytes(16).toString("hex")}${isWinnerId(winnerId) ? `.${winnerId.toLowerCase()}` : ""}`;
export const isAwardState = (s) => typeof s === "string" && /^ttfc-awd\.[0-9a-f]{32}(\.[a-f0-9]{24})?$/.test(s);
/** The winner's id a state was made for ("" when it has none). */
export const winnerIdOfState = (s) => (isAwardState(s) ? s.split(".")[2] || "" : "");

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/** A "data:image/jpeg|png;base64,…" URL → its bytes, or null unless it really is one of those, of a sane size. */
export function certificateFromDataUrl(raw) {
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(typeof raw === "string" ? raw : "");
  if (!m || m[2].length > Math.ceil(AWARD_IMAGE_MAX_BYTES / 3) * 4) return null;
  const buf = Buffer.from(m[2], "base64");
  if (buf.length < 64 || buf.length > AWARD_IMAGE_MAX_BYTES) return null;
  const ok = m[1] === "png" ? buf.subarray(0, 8).equals(PNG_MAGIC) : buf.subarray(0, 3).equals(JPEG_MAGIC);
  return ok ? buf : null;
}

/** Back to the winner's page: /awards/winners/<id>#posted=1&post=<URL>, or #post_error=<code> (/awards without an id). */
export function awardReturnUrl(base, { id = "", post = "", error = "" } = {}) {
  const q = new URLSearchParams();
  if (error) q.set("post_error", error);
  else {
    q.set("posted", "1");
    if (/^https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:(share|ugcPost):\d+\/$/.test(post)) q.set("post", post);
  }
  const path = isWinnerId(id) ? `/awards/winners/${id.toLowerCase()}` : "/awards";
  return `${String(base).replace(/\/+$/, "")}${path}#${q.toString()}`;
}

/** The image's description on LinkedIn (for screen readers). */
export function certificateAltText(w = {}) {
  const who = w.showCompany ? `${w.presentedTo}, ${w.company}` : w.presentedTo;
  return `${w.award}, presented to ${who} at ${EVENT_NAME}, ${VENUE}`.slice(0, 300);
}
