/* =========================================================
   Event summary (Admin › RSVPs & meals › Event summary, Oct 23 2026)
   ---------------------------------------------------------
   The organiser: "Create an admin panel summary of registration,
   breakfast included, lunch, dinner, etc. pass types, day 1 and
   day 2". The headcounts at a glance, worked out from the People
   directory (services/people.js buildPeople: one record per person,
   each pass with its status and its extras from services/passExtras.js)
   so nothing here re-implements who is entitled to what.

   How it counts (the page says the same under "How this is counted"):
     - One row per person, in exactly one pass row (the rows add up to the
       total). Someone holding two passes counts once: under their Speaker
       Pass when they hold one, else under the pass the People list shows
       (primaryPass); they're listed in `multiPass`. Two people who share
       an email address (a buyer's colleague, a speaker's assistant) are
       two people: the directory only joins records whose names agree.
     - A pass counts unless staff hid it (Ticket records › hide, or a
       guest pass the directory leaves out) or Stripe shows it fully
       refunded. Booth orders aren't passes.
     - Pending passes (staff-made, not emailed yet) are counted and also
       shown on their own (`pending`: people none of whose passes can be
       used yet).
     - Exhibitor passes are Connect Passes, so they count under Connect.
     - Staff accounts and anyone else with no counting pass are left out.
     - RSVP'd = their RSVP (services/rsvpStaff.js rsvpStatusOf: sent by
       them or entered by staff; possible duplicates don't count). Day 1 /
       Day 2 = the days on it.
     - Entitled to a meal or event = one of their counting passes includes
       it (by the pass, or staff's switch in People). RSVP'd to it = it's
       on their RSVP; `outsidePass` = RSVP'd without being entitled (staff
       added it, or a pass change kept an earlier RSVP).
     - Dietary: what the people RSVP'd to that meal ticked.
     - Check-in: a pass is checked in once, on its first scan (routes/
       checkin.js stores `checkedInAt` then; a later scan answers "already
       checked in" and records nothing). So Day 1 / Day 2 here is the day
       of each person's FIRST scan, in Toronto time, not everyone in the
       room that day. Meals aren't scanned.
   Pure: the route (routes/eventSummary.js) gives it the directory.
   Unit-tested in test/event-summary.test.js.
========================================================= */

import { primaryPass } from "./people.js";
import { rsvpStatusOf } from "./rsvpStaff.js";
import { DAYS, DIETARY, EXTRA_KEYS, TIER_LABELS, extraForOption } from "./rsvp.js";

export const EVENT_TZ = "America/Toronto";

/** The pass rows, in the order the organiser's table had them. */
export const SUMMARY_TIERS = ["power", "speaker", "connect", "influence", "apex"];

/** The meals and events, in the organiser's order. `extra`: the pass extra that decides who is entitled. */
export const SUMMARY_MEALS = Object.freeze([
  { key: "cxo_d1", day: "day1", label: "CxO Breakfast · Day 1" },
  { key: "cxo_d2", day: "day2", label: "CxO Breakfast · Day 2" },
  { key: "lunch_d1", day: "day1", label: "Networking Luncheon · Day 1" },
  { key: "lunch_d2", day: "day2", label: "Networking Luncheon · Day 2" },
  { key: "awards", day: "day1", label: "Day 1 dinner: Catalyst Awards Night" },
  { key: "gala", day: "day2", label: "Day 2 dinner: Gala Dinner & Networking Reception" },
].map((m) => Object.freeze({ ...m, extra: extraForOption(m.key) })));

/** Dietary needs as the RSVP page lists them, without "None" (counted as `noNeeds`). */
export const SUMMARY_DIETARY = DIETARY.filter((d) => d.key !== "none").map((d) => ({ key: d.key, label: d.label }));
const DIET_KEYS = SUMMARY_DIETARY.map((d) => d.key);

const isBooth = (id) => /^BOOTH-/i.test(String(id || ""));
const pct = (n, of) => (of > 0 ? Math.round((n * 100) / of) : null);
const ms = (d) => { const n = d ? new Date(d).getTime() : NaN; return Number.isFinite(n) ? n : NaN; };

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: EVENT_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
/** "2026-10-26" for a moment, in Toronto; "" for no date. */
export function torontoDate(d) {
  const t = ms(d);
  return Number.isFinite(t) ? dayFmt.format(new Date(t)) : "";
}
const DAY_BY_DATE = Object.fromEntries(DAYS.map((d) => [d.date, d.key]));
/** The event day a moment falls on in Toronto ("day1" | "day2"), "other" for any other date, "" for no date. */
export function eventDayOf(d) {
  const date = torontoDate(d);
  return !date ? "" : DAY_BY_DATE[date] || "other";
}

/** The passes of a person that count: not hidden by staff, not fully refunded, not a booth. */
export const countingPasses = (p) => (p?.passList || []).filter((t) => !t.hidden && t.status !== "refunded" && !isBooth(t.ticketId));

/** The one pass a person is counted under: their Speaker Pass when they hold one (the organiser, Oct 23 2026:
    "not double counting the speakers and power passes": a speaker with a Power, Influence, Connect or Apex pass
    as well counts once, under Speaker), else the pass the People list shows (primaryPass: usable before
    pending, then the biggest pass, then the newest). */
export function mainPass(passes = []) {
  const speaker = primaryPass(passes.filter((t) => t.tier === "speaker"));
  return speaker || primaryPass(passes);
}

/** What a person is entitled to: an extra one of their counting passes includes (by the pass, or staff's switch in
    People). The one rule for "entitled": this page and the check-in desk (services/checkinDesk.js) both use it.
    → { cxo, lunch, gala, awards } */
export const entitledExtras = (passes = []) => Object.fromEntries(EXTRA_KEYS.map((k) => [k, (passes || []).some((t) => !!t.extras?.[k])]));

/** Why someone with passes isn't counted: "refunded" (every visible pass refunded), "hidden" (every pass hidden), "" otherwise. */
function leftOutWhy(p) {
  const all = (p?.passList || []).filter((t) => !isBooth(t.ticketId));
  if (!all.length) return "";
  const visible = all.filter((t) => !t.hidden);
  if (!visible.length) return "hidden";
  return visible.every((t) => t.status === "refunded") ? "refunded" : "";
}

const emptyLine = () => ({ people: 0, rsvpd: 0, notRsvpd: 0, day1: 0, day2: 0, bothDays: 0, pending: 0, pendingRsvpd: 0 });
function addTo(line, f) {
  line.people += 1;
  if (f.pending) line.pending += 1;
  if (!f.rsvpd) { line.notRsvpd += 1; return; }
  line.rsvpd += 1;
  if (f.pending) line.pendingRsvpd += 1;
  if (f.day1) line.day1 += 1;
  if (f.day2) line.day2 += 1;
  if (f.day1 && f.day2) line.bothDays += 1;
}
const withPct = (line) => ({ ...line, pct: pct(line.rsvpd, line.people) });

const emptyCheckin = () => ({ checkedIn: 0, day1: 0, day2: 0, otherDay: 0, noTime: 0, notRsvpd: 0 });
function addCheckin(line, c, rsvpd) {
  if (!c.checkedIn) return;
  line.checkedIn += 1;
  if (c.day === "day1") line.day1 += 1;
  else if (c.day === "day2") line.day2 += 1;
  else if (c.day === "other") line.otherDay += 1;
  else line.noTime += 1;
  if (!rsvpd) line.notRsvpd += 1;
}

/** A person's facts for the summary, or null when they have no counting pass. */
function factsOf(p) {
  const passes = countingPasses(p);
  if (!passes.length) return null;
  const main = mainPass(passes);
  const r = rsvpStatusOf(p.rsvp);
  const rsvpd = r.status !== "none";
  const days = new Set(rsvpd ? r.days : []);
  const options = new Set(rsvpd ? r.options : []);
  const dietary = rsvpd ? (Array.isArray(p.rsvp?.dietary) ? p.rsvp.dietary : []) : [];
  const scanned = passes.filter((t) => t.checkedIn);
  const times = scanned.map((t) => ms(t.checkedInAt)).filter(Number.isFinite);
  const first = times.length ? new Date(Math.min(...times)) : null;
  return {
    // Pending: none of their passes can be used yet (every one is a staff-made pass not emailed yet).
    passes, main, tier: main.tier, pending: passes.every((t) => t.status === "pending"), rsvpd,
    day1: days.has("day1"), day2: days.has("day2"), options, dietary,
    dietaryOther: rsvpd && dietary.includes("other") ? String(p.rsvp?.dietaryOther || "").trim().slice(0, 200) : "",
    entitled: (extra) => !!entitledExtras(passes)[extra],
    checkin: { checkedIn: scanned.length > 0, first, day: first ? eventDayOf(first) : "" },
    vip: !!p.vip, media: (p.types || []).includes("media"), exhibitorPass: !!main.exhibitorPass,
  };
}

/**
 * The whole page in one answer.
 * @param {object[]} people  the directory's person records (routes/people.js directory().people)
 * @param {object} [o]
 * @param {Date}   [o.builtAt]  when the directory was read
 * @param {string} [o.stripe]   "ok" | "slow" | "error" | "off": whether refunds could be checked
 * @param {boolean} [o.speakersLoaded]
 */
export function eventSummary(people = [], { builtAt = null, stripe = "ok", speakersLoaded = true } = {}) {
  const total = emptyLine();
  const byTier = Object.fromEntries(SUMMARY_TIERS.map((t) => [t, emptyLine()]));
  const otherTier = emptyLine(); // a pass type this table doesn't name (none today; kept so the total adds up)
  const marks = { vip: emptyLine(), media: emptyLine(), exhibitor: emptyLine() };
  const meals = SUMMARY_MEALS.map((m) => ({
    ...m, entitled: 0, entitledPending: 0, rsvpd: 0, outsidePass: 0, noNeeds: 0,
    dietary: Object.fromEntries(DIET_KEYS.map((k) => [k, 0])),
  }));
  const allRsvps = { rsvpd: 0, noNeeds: 0, dietary: Object.fromEntries(DIET_KEYS.map((k) => [k, 0])) };
  const checkin = emptyCheckin();
  const checkinByTier = Object.fromEntries(SUMMARY_TIERS.map((t) => [t, emptyCheckin()]));
  const otherNotes = [];
  const multiPass = [];
  const rsvpNoPass = [];
  const left = { refunded: 0, hidden: 0, staffNoPass: 0, rsvpNoPass: 0 };

  const countDiet = (bucket, dietary) => {
    const real = dietary.filter((k) => DIET_KEYS.includes(k));
    if (!real.length) bucket.noNeeds += 1;
    for (const k of real) bucket.dietary[k] += 1;
  };

  for (const p of people || []) {
    const f = factsOf(p);
    if (!f) {
      const why = leftOutWhy(p);
      if (why) left[why] += 1;
      if (p?.user?.role === "admin" && !why) left.staffNoPass += 1;
      if (rsvpStatusOf(p?.rsvp).status !== "none") {
        left.rsvpNoPass += 1;
        if (rsvpNoPass.length < 100) rsvpNoPass.push({ id: p.id, name: p.name || "No name", why: why || "none" });
      }
      continue;
    }
    addTo(total, f);
    addTo(byTier[f.tier] || otherTier, f);
    if (f.vip) addTo(marks.vip, f);
    if (f.media) addTo(marks.media, f);
    if (f.exhibitorPass) addTo(marks.exhibitor, f);
    addCheckin(checkin, f.checkin, f.rsvpd);
    if (checkinByTier[f.tier]) addCheckin(checkinByTier[f.tier], f.checkin, f.rsvpd);

    for (const m of meals) {
      const entitled = f.entitled(m.extra);
      if (entitled) {
        m.entitled += 1;
        if (f.pending) m.entitledPending += 1;
      }
      if (!f.options.has(m.key)) continue;
      m.rsvpd += 1;
      if (!entitled) m.outsidePass += 1;
      countDiet(m, f.dietary);
    }
    if (f.rsvpd) {
      allRsvps.rsvpd += 1;
      countDiet(allRsvps, f.dietary);
      if (f.dietaryOther && otherNotes.length < 300) {
        otherNotes.push({ id: p.id, name: p.name || "No name", note: f.dietaryOther, meals: SUMMARY_MEALS.filter((m) => f.options.has(m.key)).map((m) => m.key) });
      }
    }
    if (f.passes.length > 1) {
      multiPass.push({
        id: p.id, name: p.name || "No name", countedAs: TIER_LABELS[f.tier] || "Pass",
        // The pass the People list shows for them: the same, except a Speaker Pass not yet sent or claimed next to a paid pass.
        peopleShows: TIER_LABELS[primaryPass(f.passes)?.tier] || "Pass",
        passes: f.passes.map((t) => ({ ticketId: t.ticketId, label: t.label, tier: t.tier, status: t.status })),
      });
    }
  }

  const byName = (a, b) => String(a.name).localeCompare(String(b.name), "en", { sensitivity: "base" });
  const rows = SUMMARY_TIERS.map((tier) => ({ tier, label: TIER_LABELS[tier], ...withPct(byTier[tier]) }));
  if (otherTier.people) rows.push({ tier: "other", label: "Other pass", ...withPct(otherTier) });

  return {
    builtAt: builtAt ? new Date(builtAt).toISOString() : null,
    timeZone: EVENT_TZ,
    stripe,
    refundsChecked: stripe === "ok",
    speakersLoaded: !!speakersLoaded,
    days: DAYS.map(({ key, label, date, long }) => ({ key, label, date, long })),
    totals: { ...withPct(total), day1Pct: pct(total.day1, total.rsvpd), day2Pct: pct(total.day2, total.rsvpd) },
    passes: {
      rows,
      total: { tier: "total", label: "Total with a pass", ...withPct(total) },
      // Also counted in the rows above: the VIP flag, the media type, exhibitor passes (Connect Passes).
      marks: [
        { key: "vip", label: "VIP (flag)", ...withPct(marks.vip) },
        { key: "media", label: "Media", ...withPct(marks.media) },
        { key: "exhibitor", label: "Exhibitor passes (in Connect)", ...withPct(marks.exhibitor) },
      ],
    },
    meals: {
      rows: meals.map(({ extra, ...m }) => ({ ...m, extra, pct: pct(m.rsvpd, m.entitled) })),
      allRsvps: { label: "Everyone who RSVP'd", ...allRsvps },
      dietaryKeys: SUMMARY_DIETARY,
      otherNotes: otherNotes.sort(byName),
    },
    checkin: {
      ...checkin,
      byPass: SUMMARY_TIERS.map((tier) => ({ tier, label: TIER_LABELS[tier], people: byTier[tier].people, ...checkinByTier[tier] })),
      // What the records can and can't tell (see the header).
      firstScanOnly: true,
      mealScans: false,
    },
    multiPass: multiPass.sort(byName),
    leftOut: { ...left, rsvpNoPassPeople: rsvpNoPass.sort(byName) },
  };
}
