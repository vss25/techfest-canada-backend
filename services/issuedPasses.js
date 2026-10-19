/* =========================================================
   Issued passes: a pass for anyone, staff-made
   ---------------------------------------------------------
   Admin → Tickets & attendees → Issue passes. Like a speaker's
   pass, but staff choose the person, the pass (one of the four:
   Connect, Influence, Power or Apex; "Speaker / All Access" went on
   Oct 19 2026, those passes are Power Passes marked as a speaker's,
   services/fourPasses.js), the name printed on it, whether the email
   has an RSVP button, and its wording. Stored as an Attendee (promo
   code ISSUED) with a new ticket ID, so the pass works everywhere a
   ticket does: app sign-in (last name + ticket ID), the RSVP page,
   Apple Wallet and the check-in QR.
   The email is the speakers' pass email with this pass's variant
   (services/speakerPassEmail.js). Pure parts here; routes in
   routes/issuedPasses.js.
========================================================= */

import crypto from "crypto";
import { EVENT } from "./ticketInfo.js";
import { cleanCopy } from "./speakerPassEmail.js";
import { passRecipients, passStatus, validateSpeakerEmails } from "./speakerPasses.js";
import { effectiveCxo, cleanCxoSwitch } from "./cxoBreakfast.js";
import { isSpeakerPass } from "./teamRoles.js";
import { tierKey } from "./ticketInfo.js";

export const ISSUED_PROMO = "ISSUED";

const CONF = [
  ["2× Day Conference Access", "Every keynote, panel and stage, both days"],
  ["Expo Floor Access", "The full exhibition, both days"],
  ["Networking Breaks", "Coffee and conversations between sessions"],
];
const LUNCH = [["2× Luncheons", "The networking lunch on both days"]];
// Apex includes them, and a speaker's pass; Power doesn't since Oct 19 2026. Staff can switch them
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

/** The passes staff can issue, with the website's inclusions (thetechfestival.com/tickets).
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
  apex: { label: "Apex Pass", access: "All Access + Apex", includes: [...APEX, CXO, ...POWER, ...LUNCH, ...CONF],
    rsvpReason: "RSVP for the CxO breakfasts, luncheons, the Gala Dinner, the Catalyst Awards Night and your business meetings, so we can save your seat.",
    rsvpReasonNoCxo: "RSVP for the luncheons, the Gala Dinner, the Catalyst Awards Night and your business meetings, so we can save your seat." },
});
export const ISSUE_TIER_KEYS = Object.keys(ISSUE_TIERS);
/** What a speaker gets on top of their pass (the old "Speaker / All Access" pass listed it). */
export const SPEAKER_LOUNGE = Object.freeze(["The VIP Lounge", "A quiet space to prepare and connect"]);

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
  // The retired pass names ("Speaker Pass", "All Access Pass", "Exhibitor Pass") are never printed: the tier's name is.
  if ("label" in body) value.label = printedLabel(clean(body.label, 40));
  if ("rsvp" in body) value.rsvp = body.rsvp !== false;
  // "CxO Breakfast included": true / false, or null = automatic (Apex, and speakers).
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
/** The name printed on a pass: staff's own label, never one of the retired pass names. */
export const RETIRED_LABELS = Object.freeze(["Speaker Pass", "All Access Pass", "Exhibitor Pass"]);
export const printedLabel = (label) => {
  const l = String(label || "").trim();
  return RETIRED_LABELS.some((x) => x.toLowerCase() === l.toLowerCase()) ? "" : l;
};

export function issuedVariant(a, { copyFor = defaultIssuedCopy } = {}) {
  const t = tierKey(a?.ticketType);
  const key = ISSUE_TIERS[t] ? t : "influence";
  const tier = ISSUE_TIERS[key];
  const label = printedLabel(a?.issuedPass?.label) || tier.label;
  // A speaker's pass (a Power Pass since Oct 19 2026): the CxO Breakfasts and the VIP Lounge come with being a speaker.
  const speaker = isSpeakerPass(a);
  // The pass's CxO Breakfasts: staff's switch on this pass, else the pass's own rule (Apex, a speaker's pass).
  const cxo = effectiveCxo({ ticketType: key, override: a?.cxoBreakfast, speakerPass: speaker });
  const asSold = effectiveCxo({ ticketType: key, speakerPass: speaker });
  const rsvpReason = cxo === asSold && !speaker ? tier.rsvpReason
    : cxo ? tier.rsvpReasonCxo || tier.rsvpReason : tier.rsvpReasonNoCxo || tier.rsvpReason;
  const includes = includesWithCxo(tier.includes, cxo);
  if (speaker) includes.splice(Math.max(0, includes.findIndex((row) => CONF.some((x) => x[0] === row[0]))), 0, SPEAKER_LOUNGE);
  return {
    label, access: speaker ? `${tier.access} · Speaker` : tier.access, includes, rsvp: a?.issuedPass?.rsvp !== false, rsvpReason, ...copyFor(label),
  };
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
    // A speaker's pass (the old "Speaker / All Access" passes, now Power): the holder is a speaker.
    speaker: isSpeakerPass(a),
    // "CxO Breakfast included": true / false = staff's switch, null = automatic; cxoEffective = what the pass gets.
    cxoBreakfast: typeof a.cxoBreakfast === "boolean" ? a.cxoBreakfast : null,
    cxoEffective: effectiveCxo({ ticketType: key, override: a.cxoBreakfast, speakerPass: isSpeakerPass(a) }),
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
