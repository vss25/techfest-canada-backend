/* =========================================================
   Staff-entered RSVPs (Admin → People → profile → RSVP)
   ---------------------------------------------------------
   Who wins, in order:
     1. The attendee's own RSVP from /rsvp. It always replaces
        staff's answers (services/rsvpHandler.js: the same ticket,
        the edit token, or a staff-made name-only row for the same
        name when they come with their verified ticket), and in a
        staff merge of two rows its answers are kept over staff's
        (services/rsvp.js planRsvpMerge).
     2. Staff. Staff can enter an RSVP for anyone without one, and
        change one staff entered. An RSVP the attendee sent is only
        changed with an explicit override (`override: true`, else
        409 "attendee_rsvp"); `basedOn` (the updatedAt staff saw)
        refuses a save over a change made since (409 "changed").
   The pass's limits still apply (checkOptions: only what the pass
   includes on the chosen days); `allowOutsidePass: true` lets
   staff include more, saved with passLimitOverride and returned as
   a warning. Staff changes never email anyone; routes/people.js
   writes them to the audit log. Pure, unit-tested
   (test/rsvp-staff.test.js).
========================================================= */

import { cleanText } from "./brochureDownloads.js";
import { normalizeTicketId } from "./ticketAccess.js";
import {
  DAY_KEYS, OPTION_KEYS, EXPERIENCE_KEYS, DIETARY, DIETARY_KEYS, MAX_LENGTH, TIERS, TIER_LABELS,
  checkOptions, optionLabel, personNameKey, tierFromTicketType,
} from "./rsvp.js";

/** "attendee" | "staff": rows saved before `source` existed are the attendee's. */
export const rsvpSource = (r) => (r?.source === "staff" ? "staff" : "attendee");

const DIET_LABEL = Object.fromEntries(DIETARY.map((d) => [d.key, d.label]));

function cleanLong(v, max) {
  if (typeof v !== "string") return "";
  return v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}

/**
 * Staff's answers → { ok: true, value: { days, options, dietary, dietaryOther, accessibility } } | { ok: false, error, field }.
 * The same rules as the public form (services/rsvp.js validateRsvp) for what can be chosen.
 */
export function cleanStaffAnswers(body) {
  const b = body && typeof body === "object" ? body : {};
  const fail = (field, error) => ({ ok: false, field, error });
  const rawDays = Array.isArray(b.days) ? b.days : [];
  if (rawDays.some((d) => !DAY_KEYS.includes(d))) return fail("days", "Unknown day");
  const days = DAY_KEYS.filter((k) => rawDays.includes(k));
  if (!days.length) return fail("days", "Choose at least one day");
  if (b.options != null && !Array.isArray(b.options)) return fail("options", "Options must be a list");
  const options = [...new Set((b.options || []).map((o) => cleanText(o)).filter(Boolean))].filter((k) => !DAY_KEYS.includes(k));
  if (options.some((o) => !OPTION_KEYS.includes(o))) return fail("options", "Unknown option");
  if (b.dietary != null && !Array.isArray(b.dietary)) return fail("dietary", "Dietary needs must be a list");
  const rawDiet = (b.dietary || []).map((d) => cleanText(d));
  if (rawDiet.some((d) => !DIETARY_KEYS.includes(d))) return fail("dietary", "Unknown dietary option");
  let dietary = DIETARY_KEYS.filter((k) => rawDiet.includes(k));
  if (dietary.length > 1) dietary = dietary.filter((k) => k !== "none");
  let dietaryOther = dietary.includes("other") ? cleanText(b.dietaryOther) : "";
  if (dietaryOther.length > MAX_LENGTH.dietaryOther) return fail("dietaryOther", "Dietary note is too long");
  if (dietary.includes("other") && !dietaryOther) return fail("dietaryOther", "Say what the dietary need is");
  const accessibility = cleanLong(b.accessibility, MAX_LENGTH.accessibility + 1);
  if (accessibility.length > MAX_LENGTH.accessibility) return fail("accessibility", "Accessibility note is too long");
  dietaryOther = dietaryOther.slice(0, MAX_LENGTH.dietaryOther);
  return { ok: true, value: { days, options: EXPERIENCE_KEYS.filter((k) => options.includes(k)), dietary, dietaryOther, accessibility } };
}

/** "Jane Q. Doe" → { firstName: "Jane Q.", lastName: "Doe" }; one word → first name only. */
export function splitName(full) {
  const words = String(full || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length < 2) return { firstName: words[0] || "", lastName: "" };
  return { firstName: words.slice(0, -1).join(" "), lastName: words[words.length - 1] };
}

const summary = (v) => [
  v.days.map((d) => (d === "day1" ? "Day 1" : "Day 2")).join(" & "),
  v.options.length ? v.options.map(optionLabel).join(", ") : "no special events",
  v.dietary.length ? `dietary: ${v.dietary.map((k) => DIET_LABEL[k] || k).join(", ")}` : "",
].filter(Boolean).join("; ");

/**
 * Plan a staff RSVP save.
 * @param {object} o
 * @param {object|null} o.existing   the person's current (listed, not a possible duplicate) RSVP, or null
 * @param {object} o.person          { name, firstName?, lastName?, email, pass: { ticketId, type } | null }
 * @param {object} o.body            { days, options, dietary, dietaryOther, accessibility, tier?, override?, allowOutsidePass?, basedOn? }
 * @param {object} o.staff           { id, name }
 * @param {Date}   [o.now]
 * @returns {{ status: number, error: string, code: string, field?: string, invalid?: string[] }
 *          | { create: boolean, id?: string, doc?: object, set?: object, warning: string, audit: { action, detail } }}
 */
export function planStaffRsvp({ existing = null, person = {}, body = {}, staff = {}, now = new Date() }) {
  const answers = cleanStaffAnswers(body);
  if (!answers.ok) return { status: 400, error: answers.error, field: answers.field, code: "invalid" };
  const v = answers.value;
  const who = cleanText(staff.name).slice(0, 120) || "Staff";
  const name = cleanText(person.name).slice(0, 160) || [person.firstName, person.lastName].filter(Boolean).join(" ");

  if (existing) {
    if (existing.spam || existing.mergedInto) return { status: 404, error: "RSVP not found", code: "missing" };
    if (body.basedOn && existing.updatedAt && new Date(body.basedOn).getTime() !== new Date(existing.updatedAt).getTime()) {
      return { status: 409, code: "changed", error: "This RSVP changed since you opened it. Reload to see the latest answers." };
    }
    const fromAttendee = rsvpSource(existing) === "attendee";
    if (fromAttendee && body.override !== true) {
      return { status: 409, code: "attendee_rsvp", error: "The attendee entered this RSVP themselves. Confirm that you want to override it." };
    }
  }

  // The pass: the ticket's when there is one (verified), else what staff choose.
  let tier;
  let tierVerified;
  if (existing) {
    tier = existing.tier;
    tierVerified = !!existing.tierVerified;
    const picked = cleanText(body.tier).toLowerCase();
    if (!tierVerified && picked && TIERS.includes(picked)) tier = picked;
    if (!TIERS.includes(tier)) return { status: 400, error: "Choose their pass", field: "tier", code: "invalid" };
  } else if (person.pass?.ticketId) {
    tier = tierFromTicketType(person.pass.type);
    tierVerified = true;
  } else {
    tier = cleanText(body.tier).toLowerCase();
    tierVerified = false;
    if (!TIERS.includes(tier)) return { status: 400, error: "Choose their pass", field: "tier", code: "invalid" };
  }

  // What the pass includes on those days; staff may go past it only on purpose.
  const check = checkOptions(tier, v.days, v.options);
  let options = check.ok ? check.options : v.options;
  let warning = "";
  if (!check.ok) {
    if (body.allowOutsidePass !== true) {
      return { status: 400, code: "outside_pass", field: "options", invalid: check.invalid, error: check.error };
    }
    options = v.options;
    warning = `Includes what the ${TIER_LABELS[tier] || "pass"} doesn't cover on those days: ${check.invalid.map(optionLabel).join(", ")}.`;
  }

  const staffFields = {
    days: v.days, options, dietary: v.dietary, dietaryOther: v.dietaryOther, accessibility: v.accessibility,
    source: "staff", staffUpdatedBy: who, staffUpdatedById: String(staff.id || ""), staffUpdatedAt: now,
    passLimitOverride: !check.ok,
  };

  if (existing) {
    const overriding = rsvpSource(existing) === "attendee";
    const set = { ...staffFields, staffOverride: overriding || !!existing.staffOverride };
    if (tier !== existing.tier) set.tier = tier; // only ever an unverified pass (a ticket's pass can't be changed here)
    return {
      create: false, id: String(existing._id), set, warning,
      audit: {
        action: overriding ? "rsvp_staff_override" : "rsvp_staff_edit",
        detail: `${name || "RSVP"}${overriding ? " (overrode the attendee's RSVP)" : ""}: ${summary({ ...v, options })}${warning ? " · outside the pass" : ""}`,
      },
    };
  }

  // A new RSVP, keyed the way /rsvp would key it, so the attendee's own RSVP finds and replaces it.
  const split = person.firstName || person.lastName ? { firstName: person.firstName || "", lastName: person.lastName || "" } : splitName(name);
  const firstName = cleanText(split.firstName).slice(0, MAX_LENGTH.firstName);
  const lastName = cleanText(split.lastName).slice(0, MAX_LENGTH.lastName);
  const nameKey = personNameKey(firstName, lastName);
  const ticketId = person.pass?.ticketId ? String(person.pass.ticketId) : "";
  if (!ticketId && !nameKey) return { status: 400, code: "invalid", error: "This person needs a name before they can have an RSVP." };
  const key = ticketId ? `t:${normalizeTicketId(ticketId)}` : `n:${nameKey}`;
  const doc = {
    key, firstName, lastName, name: [firstName, lastName].filter(Boolean).join(" ") || name, nameKey,
    email: cleanText(person.email).toLowerCase().slice(0, MAX_LENGTH.email),
    ticketId, ticketVerified: !!ticketId,
    kind: ticketId ? (tier === "speaker" ? "speaker" : "ticket") : "none",
    tier, tierVerified, chosenTier: "", detectedTier: "", matchedSpeaker: "",
    page: "admin", userAgent: "", submissions: 0, spam: false, spamReason: "",
    ...staffFields, staffOverride: false,
  };
  return {
    create: true, doc, warning,
    audit: { action: "rsvp_staff_create", detail: `${doc.name || "RSVP"}: ${summary({ ...v, options })}${warning ? " · outside the pass" : ""}` },
  };
}

/** How the directory and profile describe an RSVP: { status: "none" | "attendee" | "staff", at, by, days, ... }. */
export function rsvpStatusOf(r) {
  if (!r) return { status: "none", label: "Not yet", at: null, by: "", days: [], options: [] };
  const src = rsvpSource(r);
  const at = src === "staff" ? r.staffUpdatedAt || r.updatedAt : r.attendeeSubmittedAt || r.updatedAt || r.createdAt;
  return {
    status: src,
    label: src === "staff" ? "Set by staff" : "RSVP'd by attendee",
    at: at || null,
    by: src === "staff" ? r.staffUpdatedBy || "" : "",
    days: r.days || [],
    options: r.options || [],
    passLimitOverride: src === "staff" && !!r.passLimitOverride,
    staffOverride: !!r.staffOverride,
  };
}
