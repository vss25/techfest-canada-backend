/* =========================================================
   The volunteer panel (Oct 23 2026): People, look-up only
   ---------------------------------------------------------
   The organiser: "volunteer should only be able to access people
   details. Don't give the access for financials, tickets sold,
   website permissions, marketing campaigns, tickets inventory,
   coupon code, etc. in backend panel. Remember these are students
   who are going to assist with running the event." and
   "definitely, no access to kill switch".

   Who: accounts with role "volunteer" signed in with their password
   (middleware/adminAuth.js requirePanel). An attendee's account that
   only carries the volunteer person type never gets the panel.

   What they reach (everything else answers 403 volunteer_forbidden):
     GET  /api/auth/me            who they are (as before)
     GET  /api/console/me         { staffRole: "volunteer", panelRole: "volunteer" }
     GET  /api/console/people     the list, 50 a page, in volunteerRow's form
     GET  /api/console/people/:id one person, in volunteerProfile's form
     GET|POST /api/console/search the People group only (services/adminSearch.js)
   No writes anywhere, no CSV, no bulk sends, no logo picker.

   What they see about a person, built here from the directory's
   records (services/people.js buildPeople), field by field, so nothing
   new ever leaks by being added to the staff rows: name, job title,
   company, photo, logo, person types, VIP / Media / Exhibitor, the
   door colour, each pass's type, whether it is Pending, its
   inclusions (CxO Breakfasts, Luncheons, Gala, Awards Night: yes / no),
   check-in (and when), booth; the RSVP's status, days, special events
   and meals, dietary needs and whether accessibility needs were given
   (not what they are); their speaking sessions on the agenda.
   Never: email, phone, LinkedIn, contact card, ticket IDs, QR, pass
   keys, ticket value, price, payment status, Stripe, coupon codes,
   manual values, email engagement, sends, RSVP-email flags, "I'm
   attending", staff notes, hide-from-app, audit, account settings.
   The free text in it (name, company, job title, a pass's printed
   name, the booth, the dietary "Other", the photo / logo addresses)
   goes through services/volunteerSafe.js: an email, phone number or
   ticket ID typed into it is [hidden], and a name that is one of their
   emails (or the part before the @, like a staff account added without
   a name) shows as "No name".

   Search (?q= on the list, and the search box): words match the safe
   name, company and job title only; an exact email or an exact ticket ID
   finds the person, and nothing in the answer repeats it. Filters:
   person type, pass, RSVP status, exhibitor, VIP, Media; the
   financial and marketing ones (ticket value, pass status, RSVP email
   sent, I'm attending, engagement, hidden from app) are ignored, and
   so are their sorts. Reads are rate limited per account
   (VOLUNTEER_READS) and never force a fresh directory build. Pure,
   unit-tested in test/volunteer-panel.test.js.
========================================================= */

import { parseQuery } from "./adminSearch.js";
import { filterPeople, sortPeople, specialEvents } from "./people.js";
import { normalizeTicketId } from "./ticketAccess.js";
import { DAYS, DIETARY, TIER_LABELS } from "./rsvp.js";
import { rsvpStatusOf } from "./rsvpStaff.js";
import { PERSON_TYPES } from "./teamRoles.js";
import { EXTRAS, EXTRA_KEYS } from "./passExtras.js";
import { personBand } from "./checkinCard.js";
import { agendaRunOfShow } from "./speakerWebsite.js";
import { safeName, safeSearchText, safeText, safeUrl } from "./volunteerSafe.js";

/** People list and profile reads per volunteer account. */
export const VOLUNTEER_READS = Object.freeze({ max: 120, windowMs: 60 * 1000 });
export const VOLUNTEER_RATE_LIMITED = "That's a lot of look-ups. Wait a minute and try again.";
export const VOLUNTEER_BANNER = "Volunteer view: look-up only";

/** The list's filters a volunteer may use (with these values only for `rsvp`). */
export const VOLUNTEER_FILTERS = Object.freeze(["type", "pass", "rsvp", "exhibitor", "vip", "media"]);
const RSVP_VALUES = new Set(["attendee", "staff", "none", "any"]);
const YES_NO = new Set(["yes", "no"]);
export const VOLUNTEER_SORTS = Object.freeze(["name", "company", "type", "pass", "rsvp", "exhibitor", "vip"]);

/** A person's id in a link: u-, a-, s-, r- (and t-<ticket ID>, which only finds the holder). */
export const PERSON_ID = /^[usart]-[^/\s]{1,78}$/;

const str = (v, max = 200) => String(v ?? "").trim().slice(0, max);
const fold = (s) => String(s || "").normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
const PLACEHOLDER = /@ticket\.thetechfestival\.com$/i;
const realEmail = (v) => { const e = String(v ?? "").trim().toLowerCase(); return e && !PLACEHOLDER.test(e) ? e : ""; };
const isBooth = (id) => /^BOOTH-/i.test(String(id || ""));
const DAY_LABEL = Object.fromEntries(DAYS.map((d) => [d.key, d.label]));
const DIET_LABEL = Object.fromEntries(DIETARY.map((d) => [d.key, d.label]));
const ms = (d) => { const n = d ? new Date(d).getTime() : 0; return Number.isFinite(n) ? n : 0; };
const iso = (d) => (d && Number.isFinite(new Date(d).getTime()) ? new Date(d).toISOString() : null);

/**
 * The list's query, as a volunteer may use it → { q, filters, sort, dir, page }. Only VOLUNTEER_FILTERS with known
 * values are kept; ?value=, ?status=, ?rsvpEmail=, ?attending=, ?appHidden=, ?rsvp=form and their sorts are dropped.
 */
export function volunteerQuery(query = {}) {
  const pick = (k) => (typeof query?.[k] === "string" ? query[k].trim().toLowerCase().slice(0, 40) : "");
  const filters = {};
  for (const k of VOLUNTEER_FILTERS) {
    const v = pick(k);
    if (!v) continue;
    if (k === "rsvp" && !RSVP_VALUES.has(v)) continue;
    if (["exhibitor", "vip", "media"].includes(k) && !YES_NO.has(v)) continue;
    filters[k] = v;
  }
  const sort = VOLUNTEER_SORTS.includes(query?.sort) ? query.sort : "name";
  const dir = query?.dir === "desc" ? "desc" : "asc";
  const page = Math.max(0, Math.min(10000, Math.floor(Number(query?.page) || 0)));
  const q = typeof query?.q === "string" ? query.q : "";
  return { q, filters, sort, dir, page };
}

const personEmails = (p) => new Set([realEmail(p.email), realEmail(p.user?.email), ...[...(p.emails || [])].map(realEmail)].filter(Boolean));
const holdsTicket = (p, norm) => (p.passList || []).some((t) => t.norm === norm || normalizeTicketId(t.ticketId) === norm)
  || (p.boothOrders || []).some((b) => normalizeTicketId(b) === norm);

/**
 * The people a volunteer's search finds. Words: every word in the name, company, job title (or website speaker
 * name), accents and case ignored, never the email, a ticket ID or a coupon code. An email address: exactly that
 * email. A ticket ID: exactly that ticket (and names with those characters, like any word).
 */
export function volunteerSearch(people = [], q = "") {
  const pq = parseQuery(q);
  if (!pq.text) return people;
  if (pq.email) return people.filter((p) => personEmails(p).has(pq.email));
  const words = fold(pq.text).split(/\s+/).filter(Boolean);
  return people.filter((p) => {
    if (pq.ticket && holdsTicket(p, pq.ticket)) return true;
    // The safe text only (services/volunteerSafe.js): an email typed as a name, or a part of one, never matches.
    const hay = fold(safeSearchText(p));
    return words.every((w) => hay.includes(w));
  });
}

/* Sorting reads the safe name and company too (the list's order never hints at a hidden name): each person is
   sorted as a view of itself with those two replaced, then given back. */
const SELF = Symbol("person");
const sortView = (p) => Object.assign(Object.create(p), { [SELF]: p, name: safeName(p), company: safeText(p.company, p) });

/** The list as a volunteer gets it: their search, the allowed filters and sorts (services/people.js does the rest). */
export function volunteerList(people = [], query = {}) {
  const v = volunteerQuery(query);
  const found = filterPeople(volunteerSearch(people, v.q), v.filters);
  return { ...v, list: sortPeople(found.map(sortView), v.sort, v.dir).map((x) => x[SELF]) };
}

/** The passes a volunteer sees: not hidden by staff, not booth orders. */
const visiblePasses = (p) => (p.passList || []).filter((t) => !t.hidden && !isBooth(t.ticketId));

/** One pass of person `p`, safe: its type, Pending or not, its inclusions, check-in and booth. No ticket ID, key, code
    or value; the texts staff typed go through services/volunteerSafe.js. */
export function volunteerPass(t, p = null) {
  if (!t) return null;
  return {
    label: safeText(t.label, p, 60),
    tier: str(t.tier, 20),
    tierLabel: TIER_LABELS[t.tier] || "",
    // The name staff printed on an issued pass ("Startup Pass"), if any.
    printedLabel: safeText(t.printedLabel, p, 60),
    pending: t.status === "pending",
    // Effective yes / no for each (staff's switch, else automatic): CxO Breakfasts, Networking Luncheons, Gala, Awards.
    extras: Object.fromEntries(EXTRA_KEYS.map((x) => [x, !!t.extras?.[x]])),
    checkedIn: !!t.checkedIn,
    checkedInAt: iso(t.checkedInAt),
    booth: safeText(t.booth, p, 20),
    exhibitorPass: !!t.exhibitorPass,
  };
}

/** Labels for the extras, in order, for the panel: [{ key, label }]. */
export const VOLUNTEER_EXTRAS = Object.freeze(EXTRAS.map((x) => Object.freeze({ key: x.key, label: x.label })));

function checkInOf(p) {
  const passes = visiblePasses(p);
  const times = passes.map((t) => ms(t.checkedInAt)).filter(Boolean);
  return { checkedIn: passes.some((t) => t.checkedIn), checkedInAt: times.length ? new Date(Math.min(...times)).toISOString() : null };
}

const typesOf = (p) => (p.types || []).filter((t) => PERSON_TYPES.includes(t));
const bandOf = (p) => (p.primary
  ? personBand({ vip: !!p.vip, types: typesOf(p), passes: visiblePasses(p).map((t) => ({ ticketId: t.ticketId, type: t.type, promoCode: t.promoCode })), passName: p.primary.label })
  : null);
const safeBand = (b, p) => (b ? { key: str(b.key, 20), label: safeText(b.label, p, 60), bg: str(b.bg, 20), text: str(b.text, 20), passName: safeText(b.passName, p, 60) } : null);

/** The RSVP, short (the list): { status, label, days, dayLabels }. */
function rsvpShort(p) {
  const r = rsvpStatusOf(p.rsvp);
  const days = (r.days || []).filter((d) => DAY_LABEL[d]);
  return { status: r.status, label: r.label, days, dayLabels: days.map((d) => DAY_LABEL[d]) };
}

/** A row of the volunteer's list. Name, job title, company, booth and the photo / logo addresses: safe
    (services/volunteerSafe.js: no email, phone number or ticket ID typed into them, "No name" for a name that is one). */
export function volunteerRow(p) {
  const booth = safeText(visiblePasses(p).map((t) => t.booth).find(Boolean) || "", p, 20);
  return {
    id: p.id,
    name: safeName(p),
    jobTitle: safeText(p.jobTitle, p),
    company: safeText(p.company, p),
    photoUrl: safeUrl(p.photoUrl, p),
    logoUrl: safeUrl(p.logoUrl, p),
    types: typesOf(p),
    vip: !!p.vip,
    media: typesOf(p).includes("media"),
    exhibitor: !!p.exhibitor,
    speaker: typesOf(p).includes("speaker"),
    band: safeBand(bandOf(p), p),
    pass: volunteerPass(p.primary && !isBooth(p.primary.ticketId) ? p.primary : null, p),
    passCount: visiblePasses(p).length,
    rsvp: rsvpShort(p),
    ...checkInOf(p),
    booth,
  };
}

/** Their sessions on the agenda (speaker, panellist or moderator), matched by name like the Speaker Pass's run of show. */
export function speakingSessions(p, sessions = null) {
  if (!sessions || !(p.types || []).includes("speaker")) return [];
  const rs = agendaRunOfShow(p.speaker?.name || p.name, sessions);
  return (rs?.sessions || []).map((s) => ({
    day: Number(s.day) || null, start: str(s.start, 5), end: str(s.end, 5), title: str(s.title, 200), format: str(s.format, 40), role: str(s.role, 40),
  }));
}

/** One person's profile as a volunteer gets it (GET /api/console/people/:id). `sessions`: the agenda, or null. */
export function volunteerProfile(p, { sessions = null } = {}) {
  const r = p.rsvp || null;
  const s = rsvpStatusOf(r);
  const days = (s.days || []).filter((d) => DAY_LABEL[d]);
  const dietary = (Array.isArray(r?.dietary) ? r.dietary : []).filter((k) => k !== "none" && DIET_LABEL[k]);
  return {
    ...volunteerRow(p),
    passes: visiblePasses(p)
      .sort((a, b) => ms(b.purchaseDate) - ms(a.purchaseDate))
      .map((t) => volunteerPass(t, p)),
    rsvp: {
      status: s.status,
      label: s.label,
      days,
      dayLabels: days.map((d) => DAY_LABEL[d]),
      // Special events and meals they chose: CxO Breakfasts, Luncheons, Awards Night, Gala, meetings, the lounge.
      events: specialEvents(r).map((e) => ({ key: e.key, label: str(e.label, 80), day: str(e.day, 40), time: str(e.time, 20) })),
      // For catering.
      dietary: dietary.map((k) => ({ key: k, label: DIET_LABEL[k] })),
      dietaryOther: safeText(r?.dietaryOther, p, 200),
      // Whether they told us about accessibility needs (staff hold the details).
      accessibility: !!str(r?.accessibility),
    },
    sessions: speakingSessions(p, sessions),
  };
}

/** Totals for the volunteer's chips: people by type, RSVP status, exhibitors, VIPs, Media, checked in. */
export function volunteerCounts(people = []) {
  const byType = Object.fromEntries([...PERSON_TYPES, "none"].map((t) => [t, 0]));
  const byRsvp = { attendee: 0, staff: 0, none: 0 };
  let exhibitors = 0, vips = 0, media = 0, checkedIn = 0;
  for (const p of people) {
    const types = typesOf(p);
    if (!types.length) byType.none += 1;
    for (const t of types) byType[t] += 1;
    const st = rsvpStatusOf(p.rsvp).status;
    if (st in byRsvp) byRsvp[st] += 1;
    if (p.exhibitor) exhibitors += 1;
    if (p.vip) vips += 1;
    if (types.includes("media")) media += 1;
    if (visiblePasses(p).some((t) => t.checkedIn)) checkedIn += 1;
  }
  return { total: people.length, byType, byRsvp, exhibitors, vips, media, checkedIn };
}

/** What the panel needs to label things. */
export const volunteerMeta = () => ({ banner: VOLUNTEER_BANNER, extras: VOLUNTEER_EXTRAS, filters: VOLUNTEER_FILTERS, sorts: VOLUNTEER_SORTS });
