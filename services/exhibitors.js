/* =========================================================
   The public exhibitor list (Oct 24 2026)
   ---------------------------------------------------------
   The organiser: "Create a thetechfestival.com/programme page.
   This is summary of agenda, clickable view of speakers,
   exhibitors, breakfast, lunch, catalyst awards, gala dinner
   time." The website's /programme page (and anyone else) reads
   GET /api/app/exhibitors (routes/appExhibitors.js), no sign-in:

     { updatedAt, zones: [Zone], exhibitors: [Exhibitor] }
     Zone      = { key: "A" | "B", name: "Zone A", area: "Harbour Ballroom Foyer", booths: "1–15" }
     Exhibitor = { key, name, booth, booths: [string], zone: "A" | "B" | "", logo, website }

   Where it comes from: the exhibitor passes (Admin › Marketing ›
   Exhibitor passes: Attendee rows with promo EXHIBITOR, or a pass
   staff set to Exhibitor = Yes; staff's No wins) that have a booth
   number (issuedPass.booth.booth). Left out: passes staff hid
   (hiddenByStaff, test / duplicate tickets), sync duplicates,
   people hidden from the app, a company name that isn't one
   (isJunkOrgName: blank, n/a, an email…, or anything holding a
   link, a phone number or a ticket ID), and organisations staff
   hid in Admin › Attending organisations.

   One entry per organisation (the organisations list's key, after
   its aliases, services/organisations.js): its name, logo and
   website are the organisations list's (the website's partner
   logo, else the Company record, else the automatic search), else
   the pass's company as typed, a logo staff set on the pass
   (companyLogoUrl, https only) and no website. Every booth it has
   is listed (booths "07" and "7" are one). Zone: what staff typed
   on the pass ("Zone A - Harbour Ballroom Foyer"), else the booth
   number (1–15 Zone A, 16–25 Zone B, the Exhibitor Manual's
   plan), else "" (shown apart). Sorted by booth number, then name.

   Only the company, its booths, zone, logo and website leave the
   server: never a person's name, email, phone or job title, how
   many passes a booth has, prices, codes or anything about an
   order. Built at most once a minute per server (the last good
   list kept when a read fails); Cache-Control public, 120 s.
   Pure parts unit-tested (test/exhibitors.test.js); the route in
   test/exhibitors-db.test.js.
========================================================= */

import Attendee from "../models/Attendee.js";
import { isExhibitorPass } from "./teamRoles.js";
import { guestWork } from "./ticketAccess.js";
import { companyKey } from "./companies.js";
import { hiddenState, isHiddenGuest, shadowFor } from "./appHide.js";
import { organisations, orgKeyOf, httpsUrl, isJunkOrgName, BUILTIN_ALIASES } from "./organisations.js";

/** The two exhibition zones (the Exhibitor Manual: Zone A booths 01-15, Zone B booths 16-25). */
export const ZONES = Object.freeze([
  Object.freeze({ key: "A", name: "Zone A", area: "Harbour Ballroom Foyer", from: 1, to: 15 }),
  Object.freeze({ key: "B", name: "Zone B", area: "Pier 4 & 5 Foyer", from: 16, to: 25 }),
]);
/** The zones as the payload carries them. */
export const PUBLIC_ZONES = Object.freeze(ZONES.map((z) => Object.freeze({ key: z.key, name: z.name, area: z.area, booths: `${z.from}–${z.to}` })));

/** The fields of one exhibitor in the payload, in this order (nothing else is ever sent). */
export const EXHIBITOR_FIELDS = Object.freeze(["key", "name", "booth", "booths", "zone", "logo", "website"]);

const line = (v, max = 160) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** A booth number as staff typed it → its display form: "07" → "7", "Booth 12" → "12", "#3a" → "3A", "Lounge" as is; "" for none. */
export function cleanBoothNo(raw) {
  let s = line(raw, 20).replace(/^(booth|stand)\s*(no\.?|number)?\s*/i, "").replace(/^#\s*/, "").trim();
  if (!s) return "";
  if (/^\d+$/.test(s)) return String(Number(s));
  if (/^\d+\s*[a-z]$/i.test(s)) return `${Number(/^\d+/.exec(s)[0])}${s.slice(-1).toUpperCase()}`;
  return s;
}

/** The first number in a booth ("12A" → 12), NaN when there's none. */
export const boothNumber = (b) => {
  const m = /\d+/.exec(String(b ?? ""));
  return m ? Number(m[0]) : NaN;
};

/** "A" | "B" | "": the zone staff typed, else the booth number's. */
export function zoneOf(zoneText, booth) {
  const z = String(zoneText ?? "").toLowerCase();
  if (/\bzone\s*a\b/.test(z) || /harbour/.test(z)) return "A";
  if (/\bzone\s*b\b/.test(z) || /\bpier/.test(z)) return "B";
  const n = boothNumber(booth);
  for (const zone of ZONES) if (n >= zone.from && n <= zone.to) return zone.key;
  return "";
}

// Text that is never shown publicly as a company name: a link, an email (isJunkOrgName), a phone number, a ticket ID.
const LINK = /[a-z][a-z0-9+.-]{1,15}:\/\/|(^|\s)www\.|\.[a-z]{2,24}\/\S/i;
const PHONE = /\+?\d(?:[\s().\-/+]{0,3}\d){6,}/;
const TICKET = /(?<![a-z0-9])(?=[0-9a-f]{0,11}[0-9])[0-9a-f]{12}(?![a-z0-9])|BOOTH-/i;
/** Can this company name go on the public page? */
export const showableName = (name, personName = "") => {
  const n = line(name);
  return !!n && !isJunkOrgName(n, personName) && !LINK.test(n) && !PHONE.test(n) && !TICKET.test(n);
};

function bestSpelling(votes) {
  let best = "";
  let bestN = 0;
  for (const [name, n] of votes) {
    if (n > bestN || (n === bestN && name.localeCompare(best) < 0)) { best = name; bestN = n; }
  }
  return best;
}

const byBooth = (a, b) => {
  const na = boothNumber(a);
  const nb = boothNumber(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  if (Number.isFinite(na) !== Number.isFinite(nb)) return Number.isFinite(na) ? -1 : 1;
  return String(a).localeCompare(String(b), "en", { numeric: true });
};

/**
 * The list, from what loadInputs() read (pure).
 *   passes   Attendee rows: { _id, name, email, claimedBy, promoCode, exhibitor, hiddenByStaff, syncDuplicate,
 *            companyLogoUrl, issuedPass: { booth: { booth, zone } }, details: { organisation | organization | company } }
 *   orgs     the organisations list's rows (services/organisations.js `rows`: hidden ones too, with hiddenBy)
 *   aliases  the organisations list's aliases in force
 *   hidden   hiddenState() (people hidden from the app), or null
 * → [Exhibitor] (EXHIBITOR_FIELDS only)
 */
export function buildExhibitors({ passes = [], orgs = [], aliases = BUILTIN_ALIASES, hidden = null } = {}) {
  const shadow = hidden ? shadowFor(hidden, {}) : null;
  const orgOf = new Map((orgs || []).filter((o) => o?.key).map((o) => [o.key, o]));
  const byKey = new Map();
  for (const a of passes || []) {
    if (!a || a.hiddenByStaff || a.syncDuplicate || !isExhibitorPass(a)) continue;
    const booth = cleanBoothNo(a.issuedPass?.booth?.booth);
    if (!booth) continue;
    if (shadow && (isHiddenGuest(a, shadow) || (a.claimedBy && shadow.ids.has(String(a.claimedBy))))) continue;
    const company = line(guestWork(a.details).organization);
    if (!showableName(company, a.name)) continue;
    const key = orgKeyOf(company, aliases, a.name) || companyKey(company);
    if (!key) continue;
    const org = orgOf.get(key) || null;
    if (org?.hiddenBy === "staff") continue;
    if (!byKey.has(key)) byKey.set(key, { key, org, votes: new Map(), booths: new Map(), passLogo: "" });
    const e = byKey.get(key);
    e.votes.set(company, (e.votes.get(company) || 0) + 1);
    // cleanBoothNo made "07" and "7" the same; a zone staff typed on any of the booth's passes counts.
    if (!e.booths.get(booth)) e.booths.set(booth, zoneOf(a.issuedPass?.booth?.zone, booth));
    if (!e.passLogo && httpsUrl(a.companyLogoUrl)) e.passLogo = httpsUrl(a.companyLogoUrl);
  }
  const out = [];
  for (const e of byKey.values()) {
    const booths = [...e.booths.keys()].sort(byBooth);
    const name = (e.org && showableName(e.org.name) ? line(e.org.name) : "") || bestSpelling(e.votes);
    out.push({
      key: e.key,
      name,
      booth: booths.join(" & "),
      booths,
      zone: e.booths.get(booths[0]) || "",
      logo: httpsUrl(e.org?.logo) || e.passLogo || "",
      website: /^https?:\/\//i.test(String(e.org?.website || "")) ? String(e.org.website) : "",
    });
  }
  out.sort((a, b) => byBooth(a.booths[0], b.booths[0]) || a.name.localeCompare(b.name));
  return out.map((x) => Object.fromEntries(EXHIBITOR_FIELDS.map((k) => [k, x[k]])));
}

/* ================= reading the sources ================= */

// Only what the rules need: never phone, job title, price, order or Stripe fields. The name and email are read for
// the junk-name and hidden-person checks only and never leave the server.
export const PASS_SELECT = "name email claimedBy promoCode exhibitor hiddenByStaff syncDuplicate companyLogoUrl "
  + "issuedPass.booth.booth issuedPass.booth.zone details.organisation details.organization details.company";

async function loadInputs() {
  const [passes, list, hidden] = await Promise.all([
    Attendee.find({ "issuedPass.booth.booth": { $exists: true, $nin: ["", null] }, hiddenByStaff: { $ne: true }, syncDuplicate: { $ne: true } })
      .select(PASS_SELECT).lean(),
    // No logos or websites rather than no list when the organisations list can't be built.
    organisations().catch((err) => { console.error("EXHIBITORS: organisations unavailable:", err?.message || err); return null; }),
    hiddenState(),
  ]);
  return { passes, orgs: list?.rows || [], aliases: list?.aliases || BUILTIN_ALIASES, hidden };
}

/* ================= the memo (≤ 60 s) ================= */

const TTL_MS = 60_000;
let memo = { at: 0, value: null, pending: null, gen: 0 };

/** The public payload: { updatedAt, zones, exhibitors }. */
export async function exhibitorsPayload({ fresh = false } = {}) {
  if (!fresh && memo.value && Date.now() - memo.at < TTL_MS) return memo.value;
  if (memo.pending) return memo.pending;
  const gen = memo.gen;
  const pending = loadInputs().then((inputs) => {
    const value = { updatedAt: new Date().toISOString(), zones: PUBLIC_ZONES, exhibitors: buildExhibitors(inputs) };
    if (memo.gen === gen) memo = { at: Date.now(), value, pending: null, gen };
    return value;
  }).catch((err) => {
    if (memo.pending === pending) memo.pending = null;
    if (memo.value) { console.error("EXHIBITORS ERROR (kept the last list):", err?.message || err); return memo.value; }
    throw err;
  });
  memo.pending = pending;
  return pending;
}

/** The next read rebuilds (tests; a staff change on this server if one ever needs it at once). */
export function forgetExhibitors() {
  memo = { at: 0, value: null, pending: null, gen: memo.gen + 1 };
}
