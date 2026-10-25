/* =========================================================
   Pass extras: the meals and events staff can add to (or take
   off) one pass (Oct 19 2026, the organiser: "the ability to add
   meals/breakfast/etc. as an admin")
   ---------------------------------------------------------
   Four extras, each Automatic / Yes / No per pass:
     cxo     CxO Breakfasts (cxo_d1, cxo_d2)
     lunch   Networking Luncheons (lunch_d1, lunch_d2)
     gala    Gala Dinner & Networking Reception (gala)
     awards  Catalyst Awards Night (awards)
   Automatic follows the pass rules (services/rsvp.js RSVP_OPTIONS
   `tiers`): Influence and up get the luncheons; Power, Apex and the
   internal Speaker Pass get the Gala and the Awards; the CxO
   Breakfasts go with Apex, the Speaker Pass and anyone of the
   speaker type, and (Oct 20 2026, the organiser: "Media will be a
   power pass with breakfast included by default, VIP will be power
   pass with breakfast included by default") any VIP (the yes / no
   flag, services/teamRoles.js isVip), whatever their pass.
   Media = Yes (Oct 23 2026, the organiser: "Media has privilege of
   power pass with breakfast"): the media type (an account's type, or
   a pass staff marked Media, Attendee.media) gets everything a Power
   Pass gets plus the CxO Breakfasts, on any pass: CxO Breakfasts,
   Networking Luncheons, Gala Dinner and Catalyst Awards Night
   (personExtras). This file is the only place that rule lives:
   the RSVP page, the door card, People and the headcounts, the
   event summary, pass emails and the apps' `inclusions` all read
   autoExtras / effectiveExtras. Booths get none.
   Staff's switch is stored on the ticket record, true / false
   (unset = automatic), in one field per extra: `cxoBreakfast` (the
   existing "CxO Breakfast included", unchanged), `luncheons`,
   `galaDinner`, `awardsNight`. On Attendee rows (guest / issued /
   speaker / exhibitor passes) and on User.tickets[] (passes bought
   on an account, which have no Attendee row); both are written
   together when both exist, and the account's wins when they
   disagree (extrasOverride).
   When an extra is Yes the RSVP page offers it, the ticket (email,
   PDF, pass emails, the apps' `inclusions`) lists it and the admin
   counts the pass as eligible. When it's No it's no longer offered,
   but an RSVP that already has it keeps it (services/rsvp.js
   extraOptionsFor): we never change an RSVP the attendee made.
   Pure, unit-tested (test/pass-extras.test.js).
========================================================= */

import { tierFromTicketType, RSVP_OPTIONS, EXTRA_OPTIONS, EXTRA_KEYS } from "./rsvp.js";
import { normalizeTicketId } from "./ticketAccess.js";
import { inclusionsFor } from "./ticketInfo.js";

export { EXTRA_KEYS, EXTRA_OPTIONS };

/** The extras, in the order the admin panel lists them. `field`: where staff's switch is stored. */
export const EXTRAS = Object.freeze([
  Object.freeze({ key: "cxo", field: "cxoBreakfast", label: "CxO Breakfasts", short: "CxO", auto: "Apex and Speaker Passes, and speakers, VIPs and Media on any pass" }),
  Object.freeze({ key: "lunch", field: "luncheons", label: "Networking Luncheons", short: "Luncheons", auto: "Influence, Power, Apex and Speaker Passes, and Media on any pass" }),
  Object.freeze({ key: "gala", field: "galaDinner", label: "Gala Dinner & Networking Reception", short: "Gala", auto: "Power, Apex and Speaker Passes, and Media on any pass" }),
  Object.freeze({ key: "awards", field: "awardsNight", label: "Catalyst Awards Night", short: "Awards", auto: "Power, Apex and Speaker Passes, and Media on any pass" }),
]);
const BY_KEY = Object.fromEntries(EXTRAS.map((x) => [x.key, x]));
export const extraInfo = (key) => BY_KEY[key] || null;
/** The stored fields, e.g. for a Mongo `select`. */
export const EXTRA_FIELDS = Object.freeze(EXTRAS.map((x) => x.field));
export const EXTRA_SELECT = EXTRA_FIELDS.join(" ");

// Who gets each one automatically: the tiers of its RSVP options (one source: services/rsvp.js).
const AUTO_TIERS = Object.fromEntries(EXTRA_KEYS.map((x) => [x, RSVP_OPTIONS.find((o) => o.key === EXTRA_OPTIONS[x][0]).tiers]));

const isBoothType = (type) => /^booth/i.test(String(type || ""));

/** Staff's switches on a pass: per extra the first true / false among the records (the account's ticket first). */
export function extrasOverride(...records) {
  const out = {};
  for (const x of EXTRAS) {
    for (const r of records) if (typeof r?.[x.field] === "boolean") { out[x.key] = r[x.field]; break; }
  }
  return out;
}

/** Media = Yes: the media type (an account's, or a pass staff marked Media, which callers put in `types`). */
export const mediaPerson = (types = []) => Array.isArray(types) && types.includes("media");

/** The people who get the CxO Breakfasts on any pass: the speaker or media type, or a VIP (`vip`: the flag). */
export const cxoPerson = (types = [], vip = false) => !!vip || mediaPerson(types) || (Array.isArray(types) && types.includes("speaker"));

/**
 * What the person gets on any pass, whatever its tier (Automatic; staff's switches still win):
 *   the CxO Breakfasts: the speaker type, a VIP (`vip`: the flag) and Media;
 *   the luncheons, the Gala Dinner and the Awards Night: Media (a Power Pass's extras, Oct 23 2026).
 * → { cxo, lunch, gala, awards } (true / false). With no pass at all it's what staff can RSVP them to.
 */
export function personExtras(types = [], { vip = false } = {}) {
  const media = mediaPerson(types);
  const cxo = cxoPerson(types, vip);
  return Object.fromEntries(EXTRA_KEYS.map((x) => [x, x === "cxo" ? cxo : media]));
}

/** Automatic, per extra: the pass's own rule, or the person's (personExtras: speakers, VIPs and Media).
    `vip`: the person's VIP flag. Booths never. */
export function autoExtras(ticketType, types = [], { vip = false } = {}) {
  const booth = isBoothType(ticketType);
  const tier = tierFromTicketType(ticketType);
  const person = personExtras(types, { vip });
  return Object.fromEntries(EXTRA_KEYS.map((x) => [x, !booth && (AUTO_TIERS[x].includes(tier) || person[x])]));
}

/** Effective, per extra: staff's switch when it's set, else automatic. `override`: extrasOverride's shape;
    `types`: the holder's person types (Media: all four automatic); `vip`: the holder is a VIP (their CxO Breakfasts are automatic). */
export function effectiveExtras({ ticketType = "", types = [], vip = false, override = {} } = {}) {
  const auto = autoExtras(ticketType, types, { vip });
  return Object.fromEntries(EXTRA_KEYS.map((x) => [x, typeof override?.[x] === "boolean" ? override[x] : auto[x]]));
}

/** One switch from a request → true | false | null (automatic), or undefined when it isn't one of those. */
export function cleanExtraSwitch(v) {
  if (v === true || v === false || v === null) return v;
  if (v === "auto" || v === "automatic" || v === "") return null;
  return undefined;
}

/**
 * The switches in a request body: `extras: { cxo?, lunch?, gala?, awards? }` (each true / false / null =
 * automatic) and the older `cxoBreakfast` (the CxO Breakfasts; `extras.cxo` wins when both are sent).
 * → { ok: true, value: { <key>: true | false | null } } (only the ones sent) | { ok: false, error, field }
 */
export function cleanExtras(body = {}) {
  const value = {};
  const b = body && typeof body === "object" ? body : {};
  if (b.cxoBreakfast !== undefined) {
    const c = cleanExtraSwitch(b.cxoBreakfast);
    if (c === undefined) return { ok: false, field: "cxoBreakfast", error: "CxO Breakfasts must be Yes, No or automatic" };
    value.cxo = c;
  }
  if (b.extras !== undefined) {
    if (!b.extras || typeof b.extras !== "object" || Array.isArray(b.extras)) return { ok: false, field: "extras", error: "Extras must be a list of Yes, No or automatic" };
    for (const [k, raw] of Object.entries(b.extras)) {
      if (!BY_KEY[k]) return { ok: false, field: "extras", error: `Unknown extra "${String(k).slice(0, 30)}"` };
      const c = cleanExtraSwitch(raw);
      if (c === undefined) return { ok: false, field: `extras.${k}`, error: `${BY_KEY[k].label} must be Yes, No or automatic` };
      value[k] = c;
    }
  }
  return { ok: true, value };
}

/** Cleaned switches → the stored fields: { set: { field: bool }, unset: { field: 1 } } (null = back to automatic). */
export function extrasWrite(value = {}) {
  const set = {};
  const unset = {};
  for (const [k, v] of Object.entries(value)) {
    const f = BY_KEY[k]?.field;
    if (!f) continue;
    if (v === null) unset[f] = 1; else if (typeof v === "boolean") set[f] = v;
  }
  return { set, unset };
}

/** "Yes" / "No" / "automatic (Yes)" for audit lines. */
export const extraLabel = (override, effective) => (typeof override === "boolean" ? (override ? "Yes" : "No") : `automatic (${effective ? "Yes" : "No"})`);

/**
 * The admin panel's view of one pass's extras: { <key>: { override: true | false | null, auto, included } }.
 * `override`: extrasOverride's shape; `auto` / `effective`: autoExtras / effectiveExtras.
 */
export function extrasView(override = {}, auto = {}, effective = {}) {
  return Object.fromEntries(EXTRA_KEYS.map((x) => [x, {
    override: typeof override[x] === "boolean" ? override[x] : null, auto: !!auto[x], included: !!effective[x],
  }]));
}

/** What the admin panel lists: [{ key, label, short, auto }] (the rule Automatic follows). */
export const extrasMeta = () => EXTRAS.map(({ key, label, short, auto }) => ({ key, label, short, auto }));

/** "2x Luncheons" → "2× Luncheons": the apps' and the website's wording. */
export const timesWording = (line) => String(line || "").replace(/^(\d+)x\s/, "$1× ");

/**
 * The signed-in person's tickets (GET /api/auth/me) with, on each:
 *   cxoBreakfast  true | false: its CxO Breakfasts (the older contract, kept)
 *   inclusions    everything it includes, the extras switched on or off for this pass, in the website's
 *                 wording ("2× Luncheons", "1× Gala Dinner & Networking Reception", "1× Awards Night",
 *                 "2× CxO Breakfasts", plus the rest of the pass's list); [] for a booth
 *   extras        { cxo, lunch, gala, awards } true / false: the same four as effectiveExtras decides them
 *                 (staff's switch, else the pass and person rules), so the apps can show them without
 *                 reading the wording (Oct 24 2026: chips per day on the person's own Profile and pass;
 *                 cxo and lunch are both days, awards Day 1's evening, gala Day 2's). All false for a booth.
 *                 Older app builds ignore it.
 * `types`: their effective person types; `vip`: they're a VIP (services/teamRoles.js isVip); `attendees`: Attendee
 * rows for those ticket IDs (ticketId + the extra fields), whose switches apply where the account's ticket has
 * none. Staff's switches and the manual ticket value stay out. `type` is as stored: connect | influence | power |
 * apex | speaker, or a booth.
 */
export function ticketsWithExtras(tickets = [], { types = [], vip = false, attendees = [] } = {}) {
  const byTicket = new Map();
  for (const a of attendees || []) if (a?.ticketId) byTicket.set(normalizeTicketId(a.ticketId), a);
  return (Array.isArray(tickets) ? tickets : []).map((t) => {
    const { manualValue, manualValueNote, manualValueBy, manualValueAt, ...rest } = t || {}; // eslint-disable-line no-unused-vars
    for (const f of EXTRA_FIELDS) delete rest[f];
    const booth = /^BOOTH-/i.test(String(t?.ticketId || "")) || isBoothType(t?.type);
    const extras = effectiveExtras({ ticketType: t?.type, types, vip, override: extrasOverride(t, byTicket.get(normalizeTicketId(t?.ticketId))) });
    return {
      ...rest,
      cxoBreakfast: !booth && extras.cxo,
      inclusions: booth ? [] : inclusionsFor(t?.type, { extras }).map(timesWording),
      extras: Object.fromEntries(EXTRA_KEYS.map((x) => [x, !booth && !!extras[x]])),
    };
  });
}
