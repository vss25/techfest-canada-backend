/* =========================================================
   What goes on a buyer's ticket (PDF + confirmation email)
   ---------------------------------------------------------
   Event facts, per-pass inclusions and "know before you go"
   tips in one place so the PDF and the email never disagree.
   Pure, unit-tested (test/ticket-email-wallet.test.js).

   Inclusions mirror PASS_META in the website's Tickets page
   (techfest-canada-frontend/src/pages/Tickets.jsx) — keep the
   two in step when a pass changes.
========================================================= */

import { passName } from "./ticketAccess.js";

export const EVENT = {
  name: "The Tech Festival Canada 2026",
  shortName: "TTFC 2026",
  dates: "October 26–27, 2026",
  datesShort: "26–27 OCT 2026",
  venue: "The Westin Harbour Castle",
  address: "1 Harbour Square, Toronto, ON M5J 1A6",
  city: "Toronto, Ontario",
  doors: "Registration opens 8:00 AM on Oct 26 and 8:30 AM on Oct 27.",
  website: "https://www.thetechfestival.com",
  websiteLabel: "thetechfestival.com",
  supportEmail: "enquire@thetechfestival.com",
  phone: "+1 647 946 4643",
  tollFree: "+1 844 TTFC 001",
  mapsUrl: "https://maps.google.com/?q=The+Westin+Harbour+Castle,+1+Harbour+Square,+Toronto",
};

export const APP_COMING_SOON = {
  title: "TTFC mobile app — coming soon to the App Store",
  body: "Your agenda, your pass, networking and chat with other delegates — all in one place.",
};

const BASE = ["2x Day Conference Access", "Expo Floor Access", "Networking Breaks"];
/** The CxO Breakfasts line. Apex and Speaker Passes include them (and speakers on any pass); Power doesn't since Oct 19 2026.
    A single pass can have them switched on or off by staff (services/cxoBreakfast.js). */
export const CXO_INCLUSION = "2x CxO Breakfasts";

/** What each pass includes (same wording and order as the website). */
export const PASS_INCLUSIONS = {
  connect: [...BASE],
  influence: ["2x Day Conference Access", "2x Luncheons", "Expo Floor Access", "Networking Breaks"],
  power: [
    "2x Day Conference Access", "2x Luncheons",
    "1x Gala Dinner & Networking Reception", "1x Awards Night", "Expo Floor Access", "Networking Breaks",
  ],
  apex: [
    "2x Pre-Matched Business Meetings", "Preferential Seating", "Private Scotch & Cocktail Lounge (19+)",
    "2x Day Conference Access", "2x CxO Breakfasts", "2x Luncheons",
    "1x Gala Dinner & Networking Reception", "1x Awards Night", "Expo Floor Access", "Networking Breaks",
  ],
};
// Retired tier keys that still exist on old tickets.
PASS_INCLUSIONS.vip = PASS_INCLUSIONS.apex;
/** The VIP Lounge speakers get (not the Apex Scotch & Cocktail Lounge). */
export const VIP_LOUNGE_INCLUSION = "VIP Lounge Access (both days)";
// Speaker Pass (internal, staff-issued, never sold or listed, Oct 19 2026): the Power Pass, plus both CxO
// Breakfasts and the VIP Lounge. None of the Apex extras (meetings, preferential seating, the Scotch lounge).
PASS_INCLUSIONS.speaker = [
  "2x Day Conference Access", CXO_INCLUSION, "2x Luncheons",
  "1x Gala Dinner & Networking Reception", "1x Awards Night", VIP_LOUNGE_INCLUSION, "Expo Floor Access", "Networking Breaks",
];

/* The tagline and the paragraph each pass card carries on the website
   (Tickets.jsx PASS_META). Repeated in the confirmation email so the
   buyer reads the same promise they bought on.

   Connect is deliberately absent — it is sold out and its copy is not
   on the live card, and taglineFor/blurbFor return "" for anything
   missing rather than inventing wording. */
export const PASS_TAGLINE = {
  influence: "A fuller event experience beyond the conference floor.",
  power: "The ultimate all-access experience.",
  apex: "Everything, plus the meetings you actually came for.",
};

export const PASS_BLURB = {
  influence: "Built for decision makers, growth leaders, investors, and professionals who want premium daytime access with elevated networking moments — creating space for higher-value conversations and stronger business connections.",
  power: "Built for senior executives, VIP guests, speakers, and leaders who want to experience The Tech Festival Canada at the highest level. With access to every major element of the event, this pass offers the most complete and elevated way to engage with the festival.",
  apex: "Our highest tier. Everything in the Power Pass, plus two business meetings matched for you in advance against your objectives, preferential seating at every keynote and panel, and entry to our private Scotch & cocktail lounge. Built for those who measure an event by the deals it starts.",
};

/** Website tagline for a tier, "" when there isn't one. */
export const taglineFor = (tier) => PASS_TAGLINE[tierKey(tier)] || "";
/** Website description paragraph for a tier, "" when there isn't one. */
export const blurbFor = (tier) => PASS_BLURB[tierKey(tier)] || "";

export const isBoothId = (ticketId) => /^BOOTH-/i.test(String(ticketId || ""));

/** A tier as a key; the text "All Access" is the Power Pass (Oct 19 2026: "All Access Pass = Power Pass only"). */
export function tierKey(tier) {
  const k = String(tier || "").trim().toLowerCase();
  return /^all[- ]?access( pass)?$/.test(k) ? "power" : k;
}

/**
 * Inclusions for a tier; unknown/retired tiers get the core conference access.
 * `cxoBreakfast` (one ticket's effective "CxO Breakfast included", services/cxoBreakfast.js):
 * true adds "2x CxO Breakfasts" (after the conference days), false takes it out; undefined = the tier's own list.
 */
export function inclusionsFor(tier, { cxoBreakfast } = {}) {
  const list = [...(PASS_INCLUSIONS[tierKey(tier)] || BASE)];
  if (typeof cxoBreakfast !== "boolean") return list;
  const without = list.filter((f) => f !== CXO_INCLUSION);
  if (!cxoBreakfast) return without;
  const at = without.indexOf("2x Day Conference Access");
  without.splice(at >= 0 ? at + 1 : 0, 0, CXO_INCLUSION);
  return without;
}

/** "Apex Pass", "Exhibition Booth — Gold" for booth confirmations. */
export function displayPassName(tier, ticketId) {
  const k = tierKey(tier);
  if (isBoothId(ticketId) || k.startsWith("booth-")) {
    const size = k.replace(/^booth-/, "");
    return `Exhibition Booth${size ? ` — ${size.charAt(0).toUpperCase()}${size.slice(1)}` : ""}`;
  }
  return passName(k) || "Delegate Pass";
}

/** The 19+ Private Scotch & Cocktail Lounge (Apex). The speakers' VIP Lounge isn't it. */
export const hasLounge = (tier) => inclusionsFor(tier).some((f) => /scotch/i.test(f));

/** Practical tips printed on the PDF and in the email. */
export function knowBeforeYouGo(tier) {
  return [
    "Bring a government-issued photo ID that matches the name on this pass.",
    "Show the QR code on your phone or a printed copy at registration.",
    ...(hasLounge(tier) ? ["The Private Scotch & Cocktail Lounge is 19+ — photo ID will be checked at the door."] : []),
    EVENT.doors,
    `Venue: ${EVENT.venue}, ${EVENT.address}.`,
  ];
}

/** First name for the greeting: details.firstName, else the first word of the name. */
export function firstNameFor({ firstName, name } = {}) {
  const clean = (v) => (typeof v === "string" ? v.trim() : "");
  const f = clean(firstName);
  if (f) return f;
  const n = clean(name);
  if (!n || n.toLowerCase() === "guest") return "";
  return n.split(/\s+/)[0];
}

/** Tips for the email (venue and doors already appear in its event-details block). */
export function emailTips(tier) {
  return knowBeforeYouGo(tier).filter((t) => t !== EVENT.doors && !t.startsWith("Venue:"));
}

/** Google Calendar "add event" link — all-day Oct 26–27 (end date is exclusive). */
export function googleCalendarUrl() {
  const q = new URLSearchParams({
    action: "TEMPLATE",
    text: EVENT.name,
    dates: "20261026/20261028",
    ctz: "America/Toronto",
    location: `${EVENT.venue}, ${EVENT.address}`,
    details: `${EVENT.doors}\nBring photo ID and your ticket QR code.\n${EVENT.website}`,
  });
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

export function escapeHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
