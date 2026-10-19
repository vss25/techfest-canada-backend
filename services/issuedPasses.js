/* =========================================================
   Issued passes: a pass for anyone, staff-made
   ---------------------------------------------------------
   Admin → Tickets & attendees → Issue passes. Like the Speaker
   Pass, but staff choose the person, the pass (Connect, Influence,
   Power, Apex or the internal Speaker Pass), the name printed on it,
   whether the email has an RSVP button, and its wording. Stored as
   an Attendee (promo code ISSUED) with a new ticket ID, so the pass
   works everywhere a ticket does: app sign-in (last name + ticket
   ID), the RSVP page, Apple Wallet and the check-in QR.
   The email is the Speaker Pass email with this pass's variant
   (services/speakerPassEmail.js). Pure parts here; routes in
   routes/issuedPasses.js.
========================================================= */

import crypto from "crypto";
import { EVENT } from "./ticketInfo.js";
import { cleanCopy } from "./speakerPassEmail.js";
import { passRecipients, passStatus, validateSpeakerEmails } from "./speakerPasses.js";
import { effectiveCxo, cleanCxoSwitch } from "./cxoBreakfast.js";
import { tierKey } from "./ticketInfo.js";

export const ISSUED_PROMO = "ISSUED";

const CONF = [
  ["2× Day Conference Access", "Every keynote, panel and stage, both days"],
  ["Expo Floor Access", "The full exhibition, both days"],
  ["Networking Breaks", "Coffee and conversations between sessions"],
];
const LUNCH = [["2× Luncheons", "The networking lunch on both days"]];
// Apex and Speaker Passes include them; Power doesn't since Oct 19 2026. Staff can switch them
// on (or off) for one pass with "CxO Breakfast included" (Attendee.cxoBreakfast, services/cxoBreakfast.js).
export const CXO = Object.freeze(["2× CxO Breakfasts", "Senior-leader breakfasts, both mornings"]);
const POWER = [
  ["1× Gala Dinner & Networking Reception", "Day 2 evening"],
  ["1× Catalyst Awards Night", "Day 1 evening"],
];
const APEX = [
  ["2× Pre-Matched Business Meetings", "Matched in advance to your objectives"],
  ["Preferential Seating", "At every keynote, panel and dinner"],
  ["Private Scotch & Cocktail Lounge (19+)", "Our private lounge, both days"],
];

/** The VIP Lounge speakers get (not the Apex Scotch & Cocktail Lounge). */
export const VIP_LOUNGE = Object.freeze(["VIP Lounge Access (both days)", "A quiet space to prepare and connect"]);

/** The passes staff can issue, with the website's inclusions (thetechfestival.com/tickets), and the internal
    Speaker Pass (Oct 19 2026: Power + both CxO Breakfasts + the VIP Lounge; none of the Apex extras). Access lines:
    "All Access" is the Power Pass's alone ("All Access Pass = Power Pass only").
    `rsvpReason` is the pass as sold; `rsvpReasonCxo` / `rsvpReasonNoCxo` the same pass with
    the CxO Breakfasts switched on / off for one person (issuedVariant). */
export const ISSUE_TIERS = Object.freeze({
  connect: { label: "Connect Pass", access: "Conference & Expo", includes: CONF,
    rsvpReason: "Let us know which days you're coming, so we can plan.",
    rsvpReasonCxo: "RSVP for the CxO breakfasts, so we can save your seat and plan catering." },
  influence: { label: "Influence Pass", access: "Conference, Expo & Luncheons", includes: [...CONF, ...LUNCH],
    rsvpReason: "RSVP for the luncheons, so we can save your seat and plan catering.",
    rsvpReasonCxo: "RSVP for the CxO breakfasts and luncheons, so we can save your seat and plan catering." },
  power: { label: "Power Pass", access: "All Access", includes: [...POWER, ...LUNCH, ...CONF],
    rsvpReason: "RSVP for the luncheons, the Gala Dinner and the Catalyst Awards Night, so we can save your seat and plan catering.",
    rsvpReasonCxo: "RSVP for the CxO breakfasts, luncheons, the Gala Dinner and the Catalyst Awards Night, so we can save your seat and plan catering." },
  apex: { label: "Apex Pass", access: "Power + Apex extras", includes: [...APEX, CXO, ...POWER, ...LUNCH, ...CONF],
    rsvpReason: "RSVP for the CxO breakfasts, luncheons, the Gala Dinner, the Catalyst Awards Night and your business meetings, so we can save your seat.",
    rsvpReasonNoCxo: "RSVP for the luncheons, the Gala Dinner, the Catalyst Awards Night and your business meetings, so we can save your seat." },
  speaker: { label: "Speaker Pass", access: "Power + CxO Breakfasts & VIP Lounge", includes: [CXO, ...POWER, ...LUNCH, VIP_LOUNGE, ...CONF],
    rsvpReason: "RSVP for the CxO breakfasts, luncheons, the Gala Dinner and the Catalyst Awards Night, so we can save your seat and plan catering.",
    rsvpReasonNoCxo: "RSVP for the luncheons, the Gala Dinner and the Catalyst Awards Night, so we can save your seat and plan catering." },
});
export const ISSUE_TIER_KEYS = Object.keys(ISSUE_TIERS);

/** A tier's inclusions with the CxO Breakfasts on or off (after the Apex extras, before the rest). */
export function includesWithCxo(includes = [], cxo = false) {
  const rest = includes.filter((row) => row[0] !== CXO[0]);
  if (!cxo) return rest;
  const at = rest.findIndex((row) => !APEX.some((x) => x[0] === row[0]));
  rest.splice(at < 0 ? rest.length : at, 0, CXO);
  return rest;
}

/** The built-in wording for a pass ({firstName} / {fullName} are filled in per person). */
export function defaultIssuedCopy(label) {
  return {
    subject: `{firstName}, your ${label} for TTFC 2026`,
    headline: "We're delighted to welcome you to TTFC 2026.",
    message: `Your personal ${label} for The Tech Festival Canada is below. We look forward to seeing you in Toronto on ${EVENT.dates}: show the QR code at registration to check in.`,
  };
}

const clean = (v, max = 120) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Checks a create / edit body. `partial` (edits) only checks what's there.
 * Fields: name, email ("a@x, b@y"), tier, title, company, label, rsvp, subject, headline, message.
 * → { ok: true, value } | { ok: false, error }
 */
export function validateIssuedPass(body = {}, { partial = false } = {}) {
  const value = {};
  if (!partial || "name" in body) {
    const name = clean(body.name);
    if (name.split(" ").length < 2) return { ok: false, error: "Enter a first and last name (the app sign-in uses the last name)." };
    value.name = name;
  }
  if (!partial || "email" in body) {
    const check = validateSpeakerEmails(body.email ?? "");
    if (!check.ok) return { ok: false, error: check.error };
    value.emails = check.list;
  }
  if (!partial || "tier" in body) {
    const tier = clean(body.tier, 20).toLowerCase();
    if (!ISSUE_TIERS[tier]) return { ok: false, error: `Pass must be one of: ${ISSUE_TIER_KEYS.join(", ")}.` };
    value.tier = tier;
  }
  if ("title" in body) value.title = clean(body.title, 120);
  if ("company" in body) value.company = clean(body.company, 160);
  // "All Access Pass" and "Exhibitor Pass" are never printed (Oct 19 2026): the tier's own name is.
  if ("label" in body) value.label = printedLabel(clean(body.label, 40));
  if ("rsvp" in body) value.rsvp = body.rsvp !== false;
  // "CxO Breakfast included": true / false, or null = automatic (Apex and Speaker Passes).
  if ("cxoBreakfast" in body) {
    const c = cleanCxoSwitch(body.cxoBreakfast);
    if (c === undefined) return { ok: false, error: "CxO Breakfast must be Yes, No or automatic." };
    value.cxoBreakfast = c;
  }
  // Exhibitor passes: the booth they're on (filled into the Exhibitor Manual).
  if (["booth", "zone", "passes"].some((k) => k in body)) {
    value.booth = {};
    if ("booth" in body) value.booth.booth = clean(body.booth, 20);
    if ("zone" in body) value.booth.zone = clean(body.zone, 60);
    if ("passes" in body) value.booth.passes = clean(body.passes, 20);
  }
  const copy = cleanCopy(body);
  if (Object.keys(copy).length) value.copy = copy;
  return { ok: true, value };
}

export const newIssuedTicketId = () => crypto.randomBytes(6).toString("hex");

/** The Attendee document for a new issued pass (`promo`: ISSUED, or EXHIBITOR for exhibitor passes). */
export function issuedPassDoc(v, { ticketId = newIssuedTicketId(), by = "", now = new Date(), promo = ISSUED_PROMO } = {}) {
  const words = v.name.split(" ");
  return {
    name: v.name,
    email: v.emails[0] || "",
    alsoTo: v.emails.slice(1),
    ticketType: v.tier,
    promoCode: promo,
    ticketId,
    purchaseDate: now,
    details: {
      firstName: words.slice(0, -1).join(" "), lastName: words[words.length - 1],
      ...(v.title ? { jobTitle: v.title } : {}), ...(v.company ? { organisation: v.company } : {}),
    },
    issuedPass: {
      label: v.label || "", rsvp: v.rsvp !== false, copy: v.copy || {}, issuedBy: by, issuedAt: now,
      ...(v.booth ? { booth: { booth: "", zone: "", passes: "", ...v.booth } } : {}),
    },
    ...(typeof v.cxoBreakfast === "boolean" ? { cxoBreakfast: v.cxoBreakfast } : {}),
  };
}

/** The $set for an edit (only the fields in `v`). */
export function issuedPassUpdate(v, before) {
  const set = {};
  if (v.name) {
    const words = v.name.split(" ");
    set.name = v.name;
    set["details.firstName"] = words.slice(0, -1).join(" ");
    set["details.lastName"] = words[words.length - 1];
  }
  if (v.emails) { set.email = v.emails[0] || ""; set.alsoTo = v.emails.slice(1); }
  if (v.tier) set.ticketType = v.tier;
  if ("title" in v) set["details.jobTitle"] = v.title;
  if ("company" in v) set["details.organisation"] = v.company;
  if ("label" in v) set["issuedPass.label"] = v.label;
  if ("rsvp" in v) set["issuedPass.rsvp"] = v.rsvp;
  if ("cxoBreakfast" in v) set.cxoBreakfast = v.cxoBreakfast; // null = automatic (the route $unsets it)
  if (v.copy) set["issuedPass.copy"] = { ...(before?.issuedPass?.copy || {}), ...v.copy };
  if (v.booth) set["issuedPass.booth"] = { booth: "", zone: "", passes: "", ...(before?.issuedPass?.booth || {}), ...v.booth };
  return set;
}

/**
 * The email settings for a pass: label, access, includes, RSVP, built-in wording.
 * `copyFor(label)`: the default wording (exhibitor passes have their own).
 */
/** Names never printed on a pass: "All Access Pass" is the Power Pass, "Exhibitor Pass" the Connect Pass. */
export const RETIRED_LABELS = Object.freeze(["All Access Pass", "Exhibitor Pass"]);
export const printedLabel = (label) => {
  const l = String(label || "").trim();
  return RETIRED_LABELS.some((x) => x.toLowerCase() === l.toLowerCase()) ? "" : l;
};

export function issuedVariant(a, { copyFor = defaultIssuedCopy } = {}) {
  const t = tierKey(a?.ticketType);
  const key = ISSUE_TIERS[t] ? t : "influence";
  const tier = ISSUE_TIERS[key];
  const label = printedLabel(a?.issuedPass?.label) || tier.label;
  // The pass's CxO Breakfasts: staff's switch on this pass, else the pass's own rule (Apex, Speaker Pass).
  const cxo = effectiveCxo({ ticketType: key, override: a?.cxoBreakfast });
  const asSold = effectiveCxo({ ticketType: key });
  const rsvpReason = cxo === asSold ? tier.rsvpReason : (cxo ? tier.rsvpReasonCxo : tier.rsvpReasonNoCxo) || tier.rsvpReason;
  return { label, access: tier.access, includes: includesWithCxo(tier.includes, cxo), rsvp: a?.issuedPass?.rsvp !== false, rsvpReason, ...copyFor(label) };
}

/** One row for Admin → Issue passes. */
export function issuedPassRow(a) {
  const key = tierKey(a.ticketType);
  return {
    id: String(a._id),
    name: a.name || "",
    title: a.details?.jobTitle || "",
    company: a.details?.organisation || "",
    tier: key,
    tierLabel: ISSUE_TIERS[key]?.label || key,
    label: printedLabel(a.issuedPass?.label),
    rsvp: a.issuedPass?.rsvp !== false,
    // "CxO Breakfast included": true / false = staff's switch, null = automatic; cxoEffective = what the pass gets.
    cxoBreakfast: typeof a.cxoBreakfast === "boolean" ? a.cxoBreakfast : null,
    cxoEffective: effectiveCxo({ ticketType: key, override: a.cxoBreakfast }),
    copy: a.issuedPass?.copy || {},
    ticketId: a.ticketId,
    email: a.email || "",
    emails: passRecipients(a),
    status: passStatus(a),
    emailSentAt: a.passEmailSentAt || null,
    emailSentTo: a.passEmailSentTo || "",
    sentCount: Number(a.passEmailSentCount) || 0,
    issuedBy: a.issuedPass?.issuedBy || "",
    issuedAt: a.issuedPass?.issuedAt || a.purchaseDate || null,
    claimed: !!a.claimedBy,
    checkedIn: !!a.checkedIn,
    booth: a.issuedPass?.booth || null,
  };
}

/** The pass shape the email builder takes (name, title, company, ticketId). */
export const issuedPassForEmail = (a) => ({
  name: a.name, title: a.details?.jobTitle || "", company: a.details?.organisation || "", ticketId: a.ticketId,
});
