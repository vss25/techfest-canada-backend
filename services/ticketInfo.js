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
  supportEmail: "info@thetechfestival.com",
  phone: "+1 647 946 4643",
  tollFree: "+1 844 TTFC 001",
  mapsUrl: "https://maps.google.com/?q=The+Westin+Harbour+Castle,+1+Harbour+Square,+Toronto",
};

export const APP_COMING_SOON = {
  title: "TTFC mobile app — coming soon to the App Store",
  body: "Your agenda, your pass, networking and chat with other delegates — all in one place.",
};

const BASE = ["2x Day Conference Access", "Expo Floor Access", "Networking Breaks"];

/** What each pass includes (same wording and order as the website). */
export const PASS_INCLUSIONS = {
  connect: [...BASE],
  influence: ["2x Day Conference Access", "2x Luncheons", "Expo Floor Access", "Networking Breaks"],
  power: [
    "2x Day Conference Access", "2x CxO Breakfasts", "2x Luncheons",
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

export const isBoothId = (ticketId) => /^BOOTH-/i.test(String(ticketId || ""));

export function tierKey(tier) {
  return String(tier || "").trim().toLowerCase();
}

/** Inclusions for a tier; unknown/retired tiers get the core conference access. */
export function inclusionsFor(tier) {
  return [...(PASS_INCLUSIONS[tierKey(tier)] || BASE)];
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

export const hasLounge = (tier) => inclusionsFor(tier).some((f) => /lounge/i.test(f));

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
