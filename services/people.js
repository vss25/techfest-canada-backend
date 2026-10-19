/* =========================================================
   People directory (Admin → People): one row per person, across
   every kind of record we keep about people.
   ---------------------------------------------------------
   Sources (routes/people.js loads them, nothing here touches the
   database, and listing never creates anything):
     - User: app and website accounts, their tickets, person types
       and staff / volunteer roles
     - Attendee: guest purchases, complimentary passes (COMP),
       Speaker Passes (SPEAKER), issued passes (ISSUED) and exhibitor
       passes (EXHIBITOR, Connect Passes)
     - Rsvp: the website /rsvp answers and staff-entered RSVPs
     - Sanity `speaker` docs (the public speaker list)
     - Company: each company's default logo
     - Stripe refunds (when STRIPE_SECRET_KEY is set), for "refunded"

   How they're joined, in order (the same keys services/rsvp.js uses):
     1. An account is a person. Its tickets are its passes; the
        guest record of a claimed ticket (same ticket ID, or
        claimedBy) joins it.
     2. A guest pass whose email is an account's joins that account
        when the names agree (or the pass carries no real name):
        buyers who bought passes for colleagues share an email, and
        a staff member's email can be on a speaker's pass.
     3. Other guest passes with the same name join each other when
        their emails agree or one has none; else a person each.
     4. A speaker joins the person holding their speaker's pass
        (speakerId), else the one person with their name, else is
        a person of their own.
     5. An RSVP joins the person holding its ticket ("t:" key or a
        verified ticket ID), else the one person with its name key,
        else is a person of its own. Possible duplicates
        (`duplicateOf`) are listed with the person but don't set
        their RSVP status.
   Names are compared by personNameKey / fullNameMatches (accents,
   honorifics, middle names and nicknames ignored).

   Ids for links: "u-<userId>", "a-<attendeeId>", "s-<speakerId>",
   "r-<rsvpId>". Every record a person is made of is an alias, so a
   link keeps working when a guest pass is later claimed by an
   account (the profile answers with the person's current id).

   Passes (Oct 19 2026): the four on sale (Connect, Influence, Power,
   Apex) and the internal Speaker Pass (tier "speaker", never sold or
   listed; holding one makes someone a speaker). "All Access" is the
   Power Pass; an exhibitor pass is a Connect Pass, named so.

   Filters (Oct 19 2026, the organiser's list): Attendee Type (the six
   types), Pass Type (Connect, Influence, Power, Apex, and the internal
   Speaker Pass, "Speaker (internal)"), Ticket Value
   After Payment (below / above 100 CAD), RSVP Status (Confirmed by
   Individual / by Staff / Unconfirmed), Is Exhibitor?, RSVP Email
   Sent? and VIP?. Each is worked out below (ticketValue, rsvpEmail,
   the VIP flag); none of them guesses.
   Pure; unit-tested in test/people.test.js.
========================================================= */

import {
  effectiveTypes, autoTypes, holdsPass, storedTypes, exhibitorIndex, passKind, isExhibitorPass, isSpeakerPass, isVip, isVipPass, legacyVip,
  PERSON_TYPES, EXHIBITOR_PROMO, TYPE_LABELS,
} from "./teamRoles.js";
import { normalizeTicketId, guestName, guestWork } from "./ticketAccess.js";
import {
  personNameKey, fullNameMatches, tierFromTicketType, TIER_LABELS, RSVP_OPTIONS, DAYS, TIERS, optionLabel, extraOptionsFor, EXTRA_OPTION_KEYS, extraForOption,
} from "./rsvp.js";
import { csvCell } from "./brochureDownloads.js";
import { companyKey, companyDTO, domainOfUrl } from "./companies.js";
import { rsvpStatusOf, splitName, RSVP_STATUS_LABELS } from "./rsvpStaff.js";
import { workDomain } from "./attendeeDetails.js";
import { cxoOverride } from "./cxoBreakfast.js";
import { EXTRAS, EXTRA_KEYS, autoExtras, effectiveExtras, extrasOverride, extrasView } from "./passExtras.js";
import { rsvpIndex, hasRsvp } from "./rsvpReminder.js";
import { usableEmail } from "./attendingCampaign.js";

/* ---------- Pass status ---------- */
export const PASS_STATUSES = ["paid", "complimentary", "issued", "pending", "refunded", "none"];
export const PASS_STATUS_LABELS = {
  paid: "Paid",
  complimentary: "Complimentary",
  issued: "Issued, not claimed",
  pending: "Pending",
  refunded: "Refunded",
  none: "No pass",
};
export const RSVP_STATUSES = ["attendee", "staff", "none"];
export { RSVP_STATUS_LABELS };

/* ---------- Ticket value after payment ----------
   What was paid for the pass in CAD: the Stripe Checkout Session's subtotal after
   promo codes, before HST, less any refund (the same "revenue" as the Analytics
   page, services/stripeSales.js), plus paid upgrades of that ticket. A pass paid
   outside Stripe (invoice, bank transfer) shows the amount management typed
   (`manualValue`, "manual"); a Stripe-paid pass always shows Stripe's. Other
   staff-made passes (COMP, issued, exhibitor, speakers') and $0 checkouts (a 100%
   code) are 0. A bought ticket we can't find in Stripe (no session ID, or Stripe
   not read) has no value: it matches neither band. Exactly 100.00 is "above". */
export const VALUE_LINE = 100;
export const VALUE_BANDS = ["below", "above"];
export const VALUE_BAND_LABELS = { below: "Below 100 CAD", above: "Above 100 CAD", unknown: "Not known", none: "No pass" };
export const VALUE_SOURCE_LABELS = { stripe: "Stripe", manual: "Manual (paid outside Stripe)", staff: "Staff-made pass", unknown: "Not known" };
export const valueBand = (v) => (v === null || v === undefined ? "unknown" : v >= VALUE_LINE ? "above" : "below");

/* ---------- RSVP email sent ----------
   "Yes" when an email with their RSVP link went to them, from these records:
     - their speaker's pass email (Attendee.passEmailSentAt; it has had the RSVP
       button since 2026-10-12 02:16 UTC, so earlier sends count only when
       passEmailRsvp says so) and the speaker nudges (speakerNudgedAt);
     - their issued or exhibitor pass email, when it had the RSVP button
       (passEmailRsvp from Oct 19 2026; older sends: the pass's RSVP setting);
     - an RSVP reminder (Marketing › RSVP reminders, or the People page) to
       one of their email addresses (CampaignSend "rsvp-reminder-2026").
   Bulk campaigns (Marketing › Campaigns) aren't counted: their records are
   made before sending and don't show an email went. The purchase email and
   the "I'm attending" email have no RSVP link. Staff can mark it Yes or No
   by hand for an email sent outside the admin panel (User.rsvpEmailMark on an
   account, Attendee.rsvpEmailMark on a pass-only person); that mark wins. */
export const SPEAKER_RSVP_LINK_FROM = new Date("2026-10-12T02:16:04Z");
const ISSUED_PROMOS = new Set(["ISSUED", "EXHIBITOR"]);

const STAFF_PROMOS = new Set(["COMP", "ISSUED", "EXHIBITOR", "SPEAKER"]);
const EMAILED_PROMOS = new Set(["ISSUED", "EXHIBITOR", "SPEAKER"]); // passes the admin panel emails out
/** A Speaker Pass staff made (Admin › Speaker passes, Issue passes): one bought through checkout and changed to
    the Speaker Pass by management keeps its Stripe payment, so it stays "paid" with its Stripe value. */
const staffSpeakerPass = (t) => isSpeakerPass(t) && !t?.stripeSessionId;
const PLACEHOLDER = /@ticket\.thetechfestival\.com$/i;
const isBooth = (id) => /^BOOTH-/i.test(String(id || ""));
const realEmail = (e) => {
  const s = String(e || "").trim().toLowerCase();
  return s && !PLACEHOLDER.test(s) ? s : "";
};
const TIER_RANK = { speaker: 5, apex: 4, power: 3, influence: 2, connect: 1 };
const STATUS_RANK = { paid: 0, complimentary: 0, issued: 1, pending: 2, refunded: 3 };
const ms = (d) => {
  const n = d ? new Date(d).getTime() : 0;
  return Number.isFinite(n) ? n : 0;
};

/**
 * One ticket's status (staff view):
 *   refunded       Stripe shows the whole payment refunded (only when Stripe could be read)
 *   complimentary  staff-made (COMP, ISSUED, EXHIBITOR, a speaker's pass) and claimed in the app or checked in
 *   pending        staff-made pass we email out (speaker's, issued, exhibitor) whose email hasn't been sent
 *   issued         staff-made, sent or handed out, not claimed in the app yet
 *   paid           bought through the website checkout (a promo code may have lowered the price)
 * `refunds`: Map(Stripe Checkout Session id → { total, refunded }) or null.
 */
export function passStatus(t, refunds = null) {
  const promo = String(t?.promoCode || "").toUpperCase();
  const speakerPass = staffSpeakerPass(t);
  const r = t?.stripeSessionId && refunds ? refunds.get(t.stripeSessionId) : null;
  if (r && r.total > 0 && r.refunded >= r.total) return "refunded";
  if (STAFF_PROMOS.has(promo) || speakerPass) {
    if (t.claimed || t.checkedIn) return "complimentary";
    if ((EMAILED_PROMOS.has(promo) || speakerPass) && !t.passEmailSentAt) return "pending";
    return "issued";
  }
  return "paid";
}

/** The pass a ticket is, by its tier: "Connect Pass" … "Apex Pass", or "Speaker Pass" (internal). Never a printed label. */
const passLabel = (type) => TIER_LABELS[tierFromTicketType(type)] || "Pass";
const RETIRED_LABEL = /^\s*(all[- ]access|exhibitor)\s+pass\s*$/i;
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** A user ticket and / or the guest record of the same ticket → one pass record. */
function ticketRecord({ user = null, t = null, a = null }) {
  const override = cxoOverride(t, a);
  const ticketId = String(t?.ticketId || a?.ticketId || "");
  const type = String(t?.type || a?.ticketType || "");
  const promoCode = String(t?.promoCode || a?.promoCode || "");
  const manualValue = num(t?.manualValue) ?? num(a?.manualValue);
  const manualFrom = num(t?.manualValue) !== undefined ? t : a;
  return {
    ticketId,
    norm: normalizeTicketId(ticketId),
    type,
    tier: tierFromTicketType(type),
    label: passLabel(type),
    // The name staff printed on an issued pass, if any (the pass itself is still one of the four); the retired names never.
    printedLabel: RETIRED_LABEL.test(String(a?.issuedPass?.label || "")) ? "" : String(a?.issuedPass?.label || "").trim().slice(0, 60),
    manualValue,
    manualValueNote: manualValue !== undefined ? String(manualFrom?.manualValueNote || "") : "",
    manualValueBy: manualValue !== undefined ? String(manualFrom?.manualValueBy || "") : "",
    manualValueAt: manualValue !== undefined ? manualFrom?.manualValueAt || null : null,
    promoCode,
    stripeSessionId: String(t?.stripeSessionId || a?.stripeSessionId || ""),
    purchaseDate: t?.purchaseDate || a?.purchaseDate || null,
    checkedIn: !!(t?.checkedIn || a?.checkedIn),
    hidden: !!(t?.hiddenByStaff || a?.hiddenByStaff || a?.syncDuplicate),
    claimed: !!t || !!a?.claimedBy,
    passEmailSentAt: a?.passEmailSentAt || null,
    upgradedFrom: String(t?.upgradedFrom || ""),
    phone: String((t?.details || a?.details)?.phone || "").trim(),
    attendeeId: a ? String(a._id) : "",
    source: t ? "account" : "guest",
    // The Tickets page's row key (routes/console.js /tickets)
    key: t && user ? `u:${user._id}:${ticketId}` : `g:${ticketId}`,
    speakerId: String(a?.speakerId || ""),
    exhibitorPass: promoCode.toUpperCase() === EXHIBITOR_PROMO,
    booth: String(a?.issuedPass?.booth?.booth || "").slice(0, 20),
    details: t?.details || a?.details || null,
    // "CxO Breakfast included": staff's switch on this pass (true / false), undefined = automatic.
    cxoOverride: override,
    // Every pass extra staff switched on this pass (services/passExtras.js): { cxo?, lunch?, gala?, awards? }.
    extrasOverride: extrasOverride(t, a),
    onAccount: !!t,
    hasAttendee: !!a,
  };
}

/** Stripe's paid sessions → refunds, and what each ticket was paid (CAD, after promo codes and refunds,
    before HST: `revenue`, services/stripeSales.js), $0 sessions and paid upgrades by ticket. */
export function stripeMaps({ rows = [], free = [] } = {}) {
  const refunds = new Map();
  const paid = new Map();
  const upgrades = new Map();
  for (const r of rows) {
    refunds.set(r.id, { total: r.total, refunded: r.refunded });
    if (r.category === "tickets") paid.set(r.id, r.revenue);
    if (r.category === "upgrades" && r.upgradeFrom) {
      const k = normalizeTicketId(r.upgradeFrom);
      upgrades.set(k, Math.round(((upgrades.get(k) || 0) + r.revenue) * 100) / 100);
    }
  }
  return { refunds, values: { paid, free: new Set(free), upgrades } };
}

/** Value paid for one pass (see VALUE_LINE above). `stripe`: { paid: Map(session → CAD), free: Set(session),
    upgrades: Map(ticket → CAD), shared: Map(session → tickets on it) } or null when Stripe wasn't read. */
export function ticketValue(t, stripe = null) {
  const promo = String(t?.promoCode || "").toUpperCase();
  // Paid outside Stripe: what management typed. (A pass with a Stripe session always takes Stripe's value.)
  if (!t?.stripeSessionId && num(t?.manualValue) !== undefined) return Math.round(t.manualValue * 100) / 100;
  if (STAFF_PROMOS.has(promo) || staffSpeakerPass(t)) return 0;
  if (!stripe || !t?.stripeSessionId) return null;
  const extra = stripe.upgrades?.get(t.norm || normalizeTicketId(t.ticketId)) || 0;
  const share = Math.max(1, stripe.shared?.get(t.stripeSessionId) || 1);
  if (stripe.paid?.has(t.stripeSessionId)) return Math.round((stripe.paid.get(t.stripeSessionId) / share + extra) * 100) / 100;
  if (stripe.free?.has(t.stripeSessionId)) return Math.round(extra * 100) / 100;
  return null;
}

/** Where a pass's value comes from: "stripe" (computed), "manual" (typed by management, paid outside Stripe),
    "staff" (a staff-made pass: 0) or "unknown". */
export function valueSource(t) {
  if (t?.stripeSessionId) return "stripe";
  if (num(t?.manualValue) !== undefined) return "manual";
  if (STAFF_PROMOS.has(String(t?.promoCode || "").toUpperCase()) || isSpeakerPass(t)) return "staff";
  return "unknown";
}

/** The pass to show for a person: usable before refunded, then the biggest pass, then the newest. */
export function primaryPass(tickets) {
  return [...(tickets || [])].filter((t) => !t.hidden).sort((x, y) =>
    (STATUS_RANK[x.status] ?? 9) - (STATUS_RANK[y.status] ?? 9)
    || (TIER_RANK[y.tier] || 0) - (TIER_RANK[x.tier] || 0)
    || ms(y.purchaseDate) - ms(x.purchaseDate))[0] || null;
}

/* ---------- Names ---------- */
const nameKeyOf = (n) => (n && typeof n === "object" ? personNameKey(n.firstName, n.lastName) : personNameKey(n, ""));
const asParts = (n) => (n && typeof n === "object" ? { firstName: n.firstName || "", lastName: n.lastName || "" } : splitName(n));

/** Do two names (strings or { firstName, lastName }) name the same person? */
export function namesMatch(a, b) {
  const ka = nameKeyOf(a);
  const kb = nameKeyOf(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const pa = asParts(a);
  const pb = asParts(b);
  return fullNameMatches(a, pb.firstName, pb.lastName) || fullNameMatches(b, pa.firstName, pa.lastName);
}

/** Who a guest pass is for: the name given at checkout, else the stored name when it's a real one
    (the stored name can be the buyer's, like services/rsvp.js ticketPersonNames). */
function passNames(a) {
  const d = a?.details || {};
  if (d.firstName || d.lastName) return [{ firstName: String(d.firstName || ""), lastName: String(d.lastName || "") }];
  const g = guestName(a);
  return g.real ? [g.name] : [];
}

/* ---------- The join ---------- */

/**
 * @param {object} o
 * @param {Array} o.users       User docs (lean)
 * @param {Array} o.attendees   Attendee docs (lean)
 * @param {Array} o.rsvps       listed RSVPs (not bots, not merged)
 * @param {Array} [o.speakers]  Sanity speakers [{ _id, name, title, company, linkedin, imageUrl }]
 * @param {Array} [o.companies] Company docs
 * @param {Map}   [o.refunds]   Stripe session id → { total, refunded }
 * @param {object} [o.stripe]   ticket values from Stripe: { paid: Map(session → CAD before HST, after promo and refunds),
 *                              free: Set($0 sessions), upgrades: Map(normalised ticket ID → CAD) }; null = not read
 * @param {Array} [o.reminders] RSVP reminder sends [{ email, sentAt }] (CampaignSend "rsvp-reminder-2026")
 * @returns {{ people: object[], byId: Map<string, object> }}  internal person records (see personRow / personDetail)
 */
export function buildPeople({ users = [], attendees = [], rsvps = [], speakers = [], companies = [], refunds = null, stripe = null, reminders = [] } = {}) {
  const people = [];
  const alias = new Map();
  const byTicket = new Map();
  const byEmail = new Map();
  const byName = new Map();

  const newPerson = (id, kind) => {
    const p = { id, kind, user: null, attendees: [], tickets: new Map(), speaker: null, rsvps: [], dupRsvps: [], boothOrders: [], nameKeys: new Set(), emails: new Set() };
    people.push(p);
    alias.set(id, p);
    return p;
  };
  const addName = (p, n) => {
    const k = nameKeyOf(n);
    if (!k) return;
    p.nameKeys.add(k);
    if (!byName.has(k)) byName.set(k, new Set());
    byName.get(k).add(p);
  };
  const addEmail = (p, e) => {
    const s = realEmail(e);
    if (!s) return;
    p.emails.add(s);
    if (!byEmail.has(s)) byEmail.set(s, []);
    if (!byEmail.get(s).includes(p)) byEmail.get(s).push(p);
  };

  const attByTicket = new Map();
  for (const a of attendees) if (a?.ticketId) attByTicket.set(normalizeTicketId(a.ticketId), a);
  const used = new Set();

  const attach = (p, { a = null, t = null } = {}) => {
    const ticketId = t?.ticketId || a?.ticketId;
    if (!ticketId) return;
    const norm = normalizeTicketId(ticketId);
    if (a && !used.has(String(a._id))) {
      used.add(String(a._id));
      p.attendees.push(a);
      alias.set(`a-${a._id}`, p);
      if (p.kind !== "account") { for (const n of passNames(a)) addName(p, n); addEmail(p, a.email); }
    }
    const prev = p.tickets.get(norm);
    if (!prev || (t && prev.source !== "account")) p.tickets.set(norm, ticketRecord({ user: p.user, t, a: a || attByTicket.get(norm) || null }));
    byTicket.set(norm, p);
  };

  // 1. Accounts and their tickets.
  for (const u of users) {
    if (!u?._id) continue;
    const p = newPerson(`u-${u._id}`, "account");
    p.user = u;
    addName(p, u.name);
    addEmail(p, u.email);
    for (const t of u.tickets || []) {
      if (!t?.ticketId) continue;
      if (isBooth(t.ticketId)) { p.boothOrders.push(String(t.ticketId)); continue; }
      attach(p, { t, a: attByTicket.get(normalizeTicketId(t.ticketId)) || null });
    }
  }
  const accountOf = new Map(people.map((p) => [String(p.user._id), p]));

  // 2–3. Guest passes, oldest first so a person's id stays the same.
  const guests = attendees
    .filter((a) => a?.ticketId && !used.has(String(a._id)) && !isBooth(a.ticketId))
    .sort((x, y) => ms(x.purchaseDate || x.createdAt) - ms(y.purchaseDate || y.createdAt) || String(x._id).localeCompare(String(y._id)));
  for (const a of guests) {
    if (used.has(String(a._id))) continue;
    const claimer = a.claimedBy ? accountOf.get(String(a.claimedBy)) : null;
    if (claimer) { attach(claimer, { a }); continue; }
    // Test and duplicate passes staff hid stay out, unless an account holds them (above).
    if (a.hiddenByStaff || a.syncDuplicate) continue;
    const names = passNames(a);
    const email = realEmail(a.email);
    const account = email
      ? (byEmail.get(email) || []).find((p) => p.kind === "account" && (!names.length || names.some((n) => namesMatch(n, p.user.name))))
      : null;
    if (account) { attach(account, { a }); continue; }
    let twin = null;
    for (const n of names) {
      for (const p of byName.get(nameKeyOf(n)) || []) {
        if (p.kind !== "pass") continue;
        if (!email || !p.emails.size || p.emails.has(email)) { twin = p; break; }
      }
      if (twin) break;
    }
    attach(twin || newPerson(`a-${a._id}`, "pass"), { a });
  }

  // 4. Speakers on the website.
  const bySpeakerId = new Map();
  for (const p of people) for (const a of p.attendees) if (a.speakerId) bySpeakerId.set(String(a.speakerId), p);
  for (const s of speakers || []) {
    if (!s?._id || !s.name) continue;
    let p = bySpeakerId.get(String(s._id)) || null;
    if (!p) {
      const cands = [...(byName.get(nameKeyOf(s.name)) || [])].filter((x) => !x.speaker);
      if (cands.length === 1) p = cands[0];
    }
    if (!p) { p = newPerson(`s-${s._id}`, "speaker"); addName(p, s.name); }
    if (!p.speaker) p.speaker = s;
    alias.set(`s-${s._id}`, p);
  }

  // 5. RSVPs: the listed ones first, then possible duplicates (which join the person of the RSVP they repeat).
  const ordered = [...rsvps].sort((x, y) => (!!x.duplicateOf - !!y.duplicateOf) || ms(x.createdAt) - ms(y.createdAt));
  for (const r of ordered) {
    if (!r?._id) continue;
    let p = null;
    const key = String(r.key || "");
    if (key.startsWith("t:")) p = byTicket.get(key.slice(2)) || null;
    if (!p && r.ticketVerified && r.ticketId) p = byTicket.get(normalizeTicketId(r.ticketId)) || null;
    if (!p && r.duplicateOf) p = alias.get(`r-${r.duplicateOf}`) || null;
    if (!p) {
      const nk = r.nameKey || personNameKey(r.firstName, r.lastName);
      const cands = byName.get(nk);
      if (cands && cands.size === 1) p = [...cands][0];
    }
    if (!p) {
      p = newPerson(`r-${r._id}`, "rsvp");
      addName(p, { firstName: r.firstName, lastName: r.lastName });
      addEmail(p, r.email);
    }
    (r.duplicateOf ? p.dupRsvps : p.rsvps).push(r);
    alias.set(`r-${r._id}`, p);
  }

  const companiesByKey = new Map((companies || []).filter((c) => c?.nameKey).map((c) => [c.nameKey, c]));
  // The same passes services/exhibitorCache.js loadExhibitors gives the apps.
  const exIdx = exhibitorIndex(attendees.filter(isExhibitorPass));
  // Tickets per Stripe session (one session is one ticket, but never count a payment twice).
  const shared = new Map();
  for (const p of people) for (const t of p.tickets.values()) if (t.stripeSessionId) shared.set(t.stripeSessionId, (shared.get(t.stripeSessionId) || 0) + 1);
  const remindedAt = new Map();
  for (const r of reminders || []) {
    const e = realEmail(r?.email);
    const at = r?.sentAt ? new Date(r.sentAt) : null;
    if (e && at && (!remindedAt.has(e) || remindedAt.get(e) < at)) remindedAt.set(e, at);
  }
  const ctx = { companiesByKey, refunds, exIdx, stripe: stripe ? { ...stripe, shared } : null, remindedAt };
  for (const p of people) Object.assign(p, summarize(p, ctx));
  return { people, byId: alias };
}

/* ---------- One person's facts ---------- */

function typesOf(p, exIdx) {
  const u = p.user;
  const off = new Set(storedTypes(u?.typesOff));
  const stored = new Set(storedTypes(u?.types));
  const on = new Set(u ? effectiveTypes(u, { exhibitor: exIdx.boothFor(u) !== null }) : []);
  // Unclaimed passes found for them, and the speaker list.
  for (const a of p.attendees) { const k = passKind(a); if (k && !off.has(k)) on.add(k); }
  if (p.speaker && !off.has("speaker")) on.add("speaker");
  // Attendee is automatic only for pass holders with no other type.
  if (on.has("attendee") && !stored.has("attendee") && [...on].some((t) => t !== "attendee")) on.delete("attendee");
  const holds = [...p.tickets.values()].some((t) => !t.hidden);
  if (!on.size && holds && !off.has("attendee")) on.add("attendee");
  return PERSON_TYPES.filter((t) => on.has(t));
}

const fold = (s) => String(s || "").normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();

/** VIP? An account: User.vip when staff set it, else a pass of theirs marked VIP; a pass-only person: any of their passes. */
function vipOf(p) {
  const passVip = p.attendees.some(isVipPass);
  if (p.user) {
    const vip = isVip(p.user, { vipPass: passVip });
    return { vip, vipFrom: !vip ? "" : typeof p.user.vip === "boolean" || legacyVip(p.user) ? "account" : "pass" };
  }
  return { vip: passVip, vipFrom: passVip ? "pass" : "" };
}

/** Staff's own "RSVP email sent" mark: the account's (User.rsvpEmailMark), else the newest on their passes. → { value, by, at } | null */
export function rsvpEmailMarkOf(p) {
  if (p.user && typeof p.user.rsvpEmailMark === "boolean") {
    return { value: p.user.rsvpEmailMark, by: String(p.user.rsvpEmailMarkBy || ""), at: p.user.rsvpEmailMarkAt || null };
  }
  if (p.user) return null;
  const marked = p.attendees.filter((a) => typeof a.rsvpEmailMark === "boolean").sort((x, y) => ms(y.rsvpEmailMarkAt) - ms(x.rsvpEmailMarkAt))[0];
  return marked ? { value: marked.rsvpEmailMark, by: String(marked.rsvpEmailMarkBy || ""), at: marked.rsvpEmailMarkAt || null } : null;
}

/** Did an email with their RSVP link go to them? → { sent, at, via: ["Speaker's pass email", …], mark, auto }
    (see SPEAKER_RSVP_LINK_FROM). `mark`: staff's Yes / No (it wins), `auto`: what our send records say. */
function rsvpEmailOf(p, remindedAt) {
  const hits = [];
  const add = (at, via) => { if (at) hits.push({ at: new Date(at), via }); };
  for (const a of p.attendees) {
    const promo = String(a.promoCode || "").toUpperCase();
    const speakerPass = promo === "SPEAKER" || String(a.ticketType || "").toLowerCase() === "speaker";
    if (a.passEmailSentAt) {
      const sentAt = new Date(a.passEmailSentAt);
      const hadButton = typeof a.passEmailRsvp === "boolean" ? a.passEmailRsvp
        : speakerPass ? sentAt >= SPEAKER_RSVP_LINK_FROM
          : ISSUED_PROMOS.has(promo) ? a.issuedPass?.rsvp !== false : false;
      if (hadButton) add(sentAt, speakerPass ? "Speaker Pass email" : promo === "EXHIBITOR" ? "Exhibitor's pass email" : "Pass email");
    }
    if (speakerPass && a.speakerNudgedAt) add(a.speakerNudgedAt, "Speaker reminder");
  }
  for (const e of new Set([...p.emails, ...(p.user ? [realEmail(p.user.email)] : [])].filter(Boolean))) {
    if (remindedAt?.has(e)) add(remindedAt.get(e), "RSVP reminder");
  }
  hits.sort((x, y) => y.at - x.at);
  const auto = { sent: hits.length > 0, at: hits[0]?.at || null, via: [...new Set(hits.map((h) => h.via))] };
  const mark = rsvpEmailMarkOf(p);
  if (!mark) return { ...auto, mark: null, auto };
  if (!mark.value) return { sent: false, at: null, via: [], mark, auto };
  return { sent: true, at: mark.at || auto.at, via: ["Marked by staff", ...auto.via], mark, auto };
}

function summarize(p, { companiesByKey, refunds, exIdx, stripe, remindedAt }) {
  const u = p.user;
  const tickets = [...p.tickets.values()].map((t) => ({ ...t, status: passStatus(t, refunds), value: ticketValue(t, stripe) }));
  const primary = primaryPass(tickets);
  const att = (primary?.attendeeId && p.attendees.find((a) => String(a._id) === primary.attendeeId)) || p.attendees[0] || null;
  const details = primary?.details || att?.details || {};
  const rsvp = [...p.rsvps].sort((x, y) => ms(y.updatedAt) - ms(x.updatedAt))[0] || null;
  const s = p.speaker;

  let name = String(u?.name || "").trim();
  let parts = splitName(name);
  if (!name && att) {
    const d = att.details || {};
    if (d.firstName || d.lastName) parts = { firstName: String(d.firstName || ""), lastName: String(d.lastName || "") };
    const g = guestName(att);
    name = g.real ? g.name : [parts.firstName, parts.lastName].filter(Boolean).join(" ") || g.name;
    if (!(d.firstName || d.lastName)) parts = splitName(name);
  }
  if (!name && s) { name = String(s.name || "").trim(); parts = splitName(name); }
  if (!name && rsvp) { name = rsvp.name || [rsvp.firstName, rsvp.lastName].filter(Boolean).join(" "); parts = { firstName: rsvp.firstName || "", lastName: rsvp.lastName || "" }; }

  const work = (d) => guestWork(d);
  const fromPasses = (pick) => {
    for (const d of [details, ...p.attendees.map((a) => a.details)]) { const v = pick(d || {}); if (v) return v; }
    return "";
  };
  const company = (u?.organization || "").trim() || fromPasses((d) => work(d).organization) || (s?.company || "").trim();
  const jobTitle = (u?.jobTitle || "").trim() || fromPasses((d) => work(d).jobTitle) || (s?.title || "").trim();
  const linkedinUrl = (u?.linkedinUrl || "").trim() || fromPasses((d) => String(d.linkedin || "").trim()) || String(s?.linkedin || "").trim();
  const email = realEmail(u?.email) || [...p.emails][0] || realEmail(rsvp?.email) || "";

  const types = typesOf(p, exIdx);
  // Pass extras per pass (CxO Breakfasts, luncheons, Gala, Awards): staff's switch, else automatic (the pass's
  // rules; the CxO Breakfasts also for a speaker-type person). `cxo` / `cxoAuto`: the CxO Breakfasts on their own.
  for (const t of tickets) {
    t.extrasAuto = autoExtras(t.type, types);
    t.extras = effectiveExtras({ ticketType: t.type, types, override: t.extrasOverride });
    t.cxoAuto = t.extrasAuto.cxo;
    t.cxo = t.extras.cxo;
  }
  const phone = fromPasses((d) => String(d.phone || "").trim());
  const exhibitorAuto = u ? exIdx.boothFor(u) !== null : false;
  // Exhibitor yes / no is what the apps use: the exhibitor type, from staff or from an exhibitor pass,
  // unless staff switched it off (typesOff on an account, Attendee.exhibitor false on a pass).
  const exhibitor = types.includes("exhibitor");
  const exhibitorPass = p.attendees.some((a) => String(a.promoCode || "").toUpperCase() === EXHIBITOR_PROMO);
  const cKey = companyKey(company);
  const companyDoc = cKey ? companiesByKey.get(cKey) || null : null;
  const override = (u?.companyLogoUrl || "").trim() || (p.attendees.find((a) => a.companyLogoUrl)?.companyLogoUrl || "").trim();
  const photoUrl = u?.avatarVersion ? `/api/files/avatar/${u._id}?v=${u.avatarVersion}` : s?.imageUrl || "";

  return {
    name: name || "No name",
    firstName: parts.firstName || "",
    lastName: parts.lastName || "",
    email,
    company,
    jobTitle,
    linkedinUrl,
    phone,
    types,
    // An account's types as stored and as they come automatically (the App › People editor's view).
    autoTypes: u ? autoTypes(u, { exhibitor: exhibitorAuto }) : [],
    holdsPass: u ? holdsPass(u, { exhibitor: exhibitorAuto }) : tickets.some((t) => !t.hidden),
    exhibitor,
    exhibitorPass,
    companyKey: cKey,
    companyDoc,
    logoUrl: override || companyDoc?.logoUrl || "",
    logoFrom: override ? "person" : companyDoc?.logoUrl ? "company" : "",
    passList: tickets,
    primary,
    rsvp,
    photoUrl,
    ...vipOf(p),
    rsvpEmail: rsvpEmailOf(p, remindedAt),
    search: fold([name, email, company, jobTitle, s?.name, ...tickets.map((t) => t.ticketId), ...p.emails].filter(Boolean).join(" ")),
  };
}

/* ---------- What the admin panel gets ---------- */

/* `label` / `tierLabel`: the pass by its tier ("Connect Pass" … "Apex Pass", "Speaker Pass" for the internal one).
   `valueSource`: stripe | manual | staff | unknown. */
const passOut = (t) => (t ? {
  ticketId: t.ticketId, label: t.label, tier: t.tier, tierLabel: TIER_LABELS[t.tier] || "", status: t.status,
  statusLabel: PASS_STATUS_LABELS[t.status] || t.status, key: t.key, source: t.source,
  // "CxO Breakfast included" for this pass: the effective value, staff's switch (null = automatic) and the automatic value.
  cxoBreakfast: !!t.cxo, cxoOverride: typeof t.cxoOverride === "boolean" ? t.cxoOverride : null, cxoAuto: !!t.cxoAuto,
  // Every pass extra, the same way: { <cxo|lunch|gala|awards>: { override: true | false | null, auto, included } }.
  extras: extrasView(t.extrasOverride || {}, t.extrasAuto || {}, t.extras || {}),
  valueBand: valueBand(t.value), valueSource: valueSource(t),
} : null);

/** The person's ticket value band: "below" | "above" | "unknown" (a pass we can't price) | "none" (no pass). */
const bandOf = (p) => (p.primary ? valueBand(p.primary.value) : "none");

/** A row of the directory. */
export function personRow(p) {
  const r = rsvpStatusOf(p.rsvp);
  return {
    id: p.id,
    kind: p.kind,
    name: p.name,
    email: p.email,
    types: p.types,
    company: p.company,
    jobTitle: p.jobTitle,
    logoUrl: p.logoUrl,
    logoFrom: p.logoFrom,
    pass: passOut(p.primary),
    passStatus: p.primary?.status || "none",
    passStatusLabel: PASS_STATUS_LABELS[p.primary?.status || "none"],
    passCount: p.passList.filter((t) => !t.hidden).length,
    rsvp: { ...r, id: p.rsvp ? String(p.rsvp._id) : "" },
    rsvpDuplicates: p.dupRsvps.length,
    rsvpEmail: {
      sent: p.rsvpEmail.sent, at: p.rsvpEmail.at, via: p.rsvpEmail.via,
      // Staff's Yes / No mark (null = from our send records) and what the records say on their own.
      mark: p.rsvpEmail.mark ? p.rsvpEmail.mark.value : null, markedBy: p.rsvpEmail.mark?.by || "", markedAt: p.rsvpEmail.mark?.at || null,
      auto: { sent: p.rsvpEmail.auto.sent, at: p.rsvpEmail.auto.at },
    },
    valueBand: bandOf(p),
    valueBandLabel: VALUE_BAND_LABELS[bandOf(p)],
    cxoBreakfast: p.primary ? !!p.primary.cxo : null,
    vip: p.vip,
    vipFrom: p.vipFrom,
    exhibitor: p.exhibitor,
    exhibitorPass: p.exhibitorPass,
    linkedinUrl: p.linkedinUrl,
    hasAccount: !!p.user,
    userId: p.user ? String(p.user._id) : "",
    photoUrl: p.photoUrl,
    suggestedDomain: suggestDomain(p),
  };
}

const yesNo = (v, want) => (want === "yes" ? !!v : want === "no" ? !v : true);

/** ?q= name, email, company, job title or ticket ID; ?type= a person type; ?pass= connect | influence | power | apex | speaker;
    ?value= below | above (ticket value after payment, VALUE_LINE CAD); ?rsvp= attendee | staff | none (any = attendee or staff);
    ?exhibitor= yes | no; ?rsvpEmail= yes | no; ?vip= yes | no; ?status= a pass status (no longer in the toolbar). */
export function filterPeople(people, query = {}) {
  const q = fold(String(query.q || "").trim()).slice(0, 100);
  const type = String(query.type || "").toLowerCase();
  const pass = String(query.pass || "").toLowerCase();
  const status = String(query.status || "").toLowerCase();
  const rsvp = String(query.rsvp || "").toLowerCase();
  const value = String(query.value || "").toLowerCase();
  const flags = { exhibitor: String(query.exhibitor || "").toLowerCase(), rsvpEmail: String(query.rsvpEmail || "").toLowerCase(), vip: String(query.vip || "").toLowerCase() };
  const words = q ? q.split(/\s+/).filter(Boolean) : [];
  return people.filter((p) => {
    if (words.length && !words.every((w) => p.search.includes(w))) return false;
    if (type === "none" ? p.types.length : PERSON_TYPES.includes(type) && !p.types.includes(type)) return false;
    if (TIERS.includes(pass) && p.primary?.tier !== pass) return false;
    if (VALUE_BANDS.includes(value) && bandOf(p) !== value) return false;
    if (PASS_STATUSES.includes(status) && (p.primary?.status || "none") !== status) return false;
    const rs = rsvpStatusOf(p.rsvp).status;
    if (rsvp === "any" ? rs === "none" : RSVP_STATUSES.includes(rsvp) && rs !== rsvp) return false;
    if (!yesNo(p.exhibitor, flags.exhibitor) || !yesNo(p.rsvpEmail.sent, flags.rsvpEmail) || !yesNo(p.vip, flags.vip)) return false;
    return true;
  });
}

export const SORTS = ["name", "company", "type", "pass", "status", "value", "rsvp", "rsvpEmail", "exhibitor", "vip"];
const cmpText = (a, b) => String(a || "").localeCompare(String(b || ""), "en", { sensitivity: "base" });

/** Sorted copy. Blanks go last whichever way; ties by name. */
export function sortPeople(people, sort = "name", dir = "asc") {
  const s = SORTS.includes(sort) ? sort : "name";
  const sign = dir === "desc" ? -1 : 1;
  const key = {
    name: (p) => p.name === "No name" ? "" : p.name,
    company: (p) => p.company,
    type: (p) => p.types.filter((t) => t !== "attendee").join(" ") || (p.types.includes("attendee") ? "~attendee" : ""),
    pass: (p) => (p.primary ? TIER_RANK[p.primary.tier] || 0 : null),
    status: (p) => (p.primary ? PASS_STATUSES.indexOf(p.primary.status) : null),
    rsvp: (p) => { const r = rsvpStatusOf(p.rsvp); return r.status === "none" ? null : ms(r.at); },
    value: (p) => (p.primary && p.primary.value !== null && p.primary.value !== undefined ? p.primary.value : null),
    rsvpEmail: (p) => (p.rsvpEmail.sent ? ms(p.rsvpEmail.at) : null),
    exhibitor: (p) => (p.exhibitor ? 0 : 1),
    vip: (p) => (p.vip ? 0 : 1),
  }[s];
  return [...people].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    const blankA = ka === null || ka === "";
    const blankB = kb === null || kb === "";
    if (blankA !== blankB) return blankA ? 1 : -1;
    const c = typeof ka === "number" && typeof kb === "number" ? ka - kb : cmpText(ka, kb);
    return (c * sign) || cmpText(a.name, b.name);
  });
}

/** Totals over everyone (not just the filtered view), for the page's chips. */
export function peopleCounts(people) {
  const byType = Object.fromEntries([...PERSON_TYPES, "none"].map((t) => [t, 0]));
  const byStatus = Object.fromEntries(PASS_STATUSES.map((s) => [s, 0]));
  const byRsvp = Object.fromEntries(RSVP_STATUSES.map((s) => [s, 0]));
  const byValue = { below: 0, above: 0, unknown: 0, none: 0 };
  let exhibitors = 0, vips = 0, rsvpEmailSent = 0, cxo = 0;
  const extras = Object.fromEntries(EXTRA_KEYS.map((x) => [x, 0]));
  for (const p of people) {
    if (!p.types.length) byType.none += 1;
    for (const t of p.types) byType[t] += 1;
    byStatus[p.primary?.status || "none"] += 1;
    byRsvp[rsvpStatusOf(p.rsvp).status] += 1;
    byValue[bandOf(p)] += 1;
    if (p.exhibitor) exhibitors += 1;
    if (p.vip) vips += 1;
    if (p.rsvpEmail.sent) rsvpEmailSent += 1;
    if (p.primary?.cxo) cxo += 1;
    for (const x of EXTRA_KEYS) if (p.primary?.extras?.[x]) extras[x] += 1;
  }
  return { total: people.length, byType, byStatus, byRsvp, byValue, exhibitors, vips, rsvpEmailSent, cxo, extras };
}

/**
 * Who is eligible for each pass extra (Leads › RSVPs headcounts): every pass (not hidden, not a booth) whose
 * extra is Yes, by staff's switch or automatically. → { byExtra: { cxo, lunch, gala, awards }, byOption:
 * { cxo_d1, cxo_d2, lunch_d1, lunch_d2, gala, awards }, passes } (`passes`: every pass counted).
 */
export function eligibleCounts(people = []) {
  const byExtra = Object.fromEntries(EXTRA_KEYS.map((x) => [x, 0]));
  let passes = 0;
  for (const p of people) {
    for (const t of p.passList || []) {
      if (t.hidden || isBooth(t.ticketId)) continue;
      passes += 1;
      for (const x of EXTRA_KEYS) if (t.extras?.[x]) byExtra[x] += 1;
    }
  }
  return { byExtra, byOption: Object.fromEntries(EXTRA_OPTION_KEYS.map((k) => [k, byExtra[extraForOption(k)]])), passes };
}
const DAY_LABEL = Object.fromEntries(DAYS.map((d) => [d.key, d.label]));
const GENERIC = /^(sessions|expo|breaks)_d\d$/; // what every pass includes on a day they come
const stamp = (t) => (t ? new Date(t).toISOString().replace("T", " ").slice(0, 16) : "");

export const PEOPLE_CSV_HEAD = [
  "Name", "Email", "Types", "VIP", "Company", "Job title", "Pass", "Ticket ID", "Pass status",
  "Ticket value after payment (CAD before HST)", "Ticket value", "Ticket value from", "CxO Breakfast",
  "Networking Luncheons", "Gala Dinner & Networking Reception", "Catalyst Awards Night", "Extras set by staff", "Passes",
  "RSVP", "RSVP set by", "RSVP updated (UTC)", "Days", "Special events", "Added by staff",
  "RSVP email sent", "RSVP email last sent (UTC)", "Exhibitor", "LinkedIn", "Company logo", "Profile",
];

/** "Gala Dinner & Networking Reception: Yes; Networking Luncheons: No": the extras staff switched on one pass. */
const extrasSetText = (t) => EXTRAS.filter((x) => typeof t.extrasOverride?.[x.key] === "boolean")
  .map((x) => `${x.label}: ${t.extrasOverride[x.key] ? "Yes" : "No"}`).join("; ");

/** Spreadsheet of the directory view (management, like the RSVP export: it holds emails). */
export function peopleCsv(people, { profileBase = "" } = {}) {
  const base = String(profileBase || "").replace(/\/+$/, "");
  const lines = people.map((p) => {
    const r = rsvpStatusOf(p.rsvp);
    const v = p.primary ? p.primary.value : null;
    return [
      p.name, p.email, p.types.map((t) => TYPE_LABELS[t] || t).join("; "), p.vip ? "Yes" : "No", p.company, p.jobTitle,
      p.primary?.label || "", p.primary?.ticketId || "", PASS_STATUS_LABELS[p.primary?.status || "none"],
      v === null || v === undefined ? "" : v.toFixed(2), VALUE_BAND_LABELS[bandOf(p)],
      p.primary ? VALUE_SOURCE_LABELS[valueSource(p.primary)] : "",
      p.primary ? (p.primary.cxo ? "Yes" : "No") : "",
      ...["lunch", "gala", "awards"].map((x) => (p.primary ? (p.primary.extras?.[x] ? "Yes" : "No") : "")),
      p.primary ? extrasSetText(p.primary) : "",
      p.passList.filter((t) => !t.hidden).length,
      RSVP_STATUS_LABELS[r.status], r.status === "staff" ? r.by : r.status === "attendee" ? "Attendee" : "", stamp(r.at),
      r.days.map((d) => DAY_LABEL[d] || d).join(" & "),
      specialEvents(p.rsvp).map((e) => optionLabel(e.key)).join("; "),
      (r.staffAdded || []).map(optionLabel).join("; "),
      p.rsvpEmail.sent ? "Yes" : "No", stamp(p.rsvpEmail.at),
      p.exhibitor ? "Yes" : "No", p.linkedinUrl, p.logoUrl, base ? `${base}/admin/people/${p.id}` : p.id,
    ].map(csvCell).join(",");
  });
  return "﻿" + [PEOPLE_CSV_HEAD.map(csvCell).join(","), ...lines].join("\n");
}

/* ---------- The profile ---------- */

const OPTION = Object.fromEntries(RSVP_OPTIONS.map((o) => [o.key, o]));

/** The special events in an RSVP (what's on top of the conference days), in the order they happen. */
export function specialEvents(rsvp) {
  if (!rsvp) return [];
  return RSVP_OPTIONS
    .filter((o) => o.kind === "experience" && !GENERIC.test(o.key) && (rsvp.options || []).includes(o.key))
    .map((o) => ({ key: o.key, label: OPTION[o.key].label, day: o.day ? DAY_LABEL[o.day] : "", time: o.time || "" }));
}

/**
 * Sessions saved in the app (SessionRegistration ids) against the agenda (Sanity `session` docs,
 * matched by `sessionId` then `_id`). `agenda`: the docs, or null when it couldn't be read.
 * → [{ id, found, title, day, time, endTime, stage, type }] by day and time; unknown ids last.
 */
export function agendaFor(sessionIds = [], agenda = null) {
  const index = new Map();
  for (const s of agenda || []) {
    for (const k of [s?.sessionId, s?._id]) if (typeof k === "string" && k && !index.has(k)) index.set(k, s);
  }
  const seen = new Set();
  const out = [];
  for (const id of sessionIds) {
    const k = String(id || "").trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const s = index.get(k);
    out.push(s ? {
      id: k, found: true, title: String(s.title || ""), day: Number(s.day) || null, time: s.time || "", endTime: s.endTime || "",
      stage: String(s.stage || ""), type: String(s.type || s.format || ""),
    } : { id: k, found: false, title: "", day: null, time: "", endTime: "", stage: "", type: "" });
  }
  return out.sort((a, b) => (a.found === b.found ? 0 : a.found ? -1 : 1) || (a.day || 9) - (b.day || 9) || String(a.time).localeCompare(String(b.time)));
}

/** A domain to start the logo search from: the company record's, a website partner's, then a work email's. */
export function suggestDomain(p, cmsLogos = []) {
  if (p.companyDoc?.domain) return p.companyDoc.domain;
  const cms = (cmsLogos || []).find((l) => l.url && companyKey(l.name) === p.companyKey);
  if (cms) return domainOfUrl(cms.url);
  for (const e of p.emails || []) { const d = workDomain(e); if (d) return d; }
  return p.email ? workDomain(p.email) : "";
}

/** What may be edited on a person, and where it's saved. `staffId`: who's asking (nobody deletes themselves). */
export function editInfo(p, { management = false, staffId = "" } = {}) {
  const where = p.user ? "account" : p.attendees.length ? "pass" : "none";
  const staffAccount = p.user?.role === "admin";
  const canEdit = where !== "none" && (!staffAccount || management);
  const self = !!staffId && !!p.user && String(p.user._id) === String(staffId);
  const hasPass = p.passList.some((t) => !t.hidden);
  return {
    where,
    canEdit,
    canEditEmail: canEdit && management,
    canEditPhone: canEdit && p.passList.length > 0,
    // Person types: an account's types (the App › People rules: staff / volunteer are management only);
    // a pass-only person's Speaker and Exhibitor (saved on their passes), the rest needs an account.
    canEditTypes: canEdit,
    typesWhere: where === "account" ? "account" : where === "pass" ? "passes" : "none",
    canEditExhibitor: canEdit,
    canEditVip: canEdit,
    canEditCxo: canEdit && hasPass,
    // The pass extras (CxO Breakfasts, luncheons, Gala, Awards) per pass: anyone who can edit them.
    canEditExtras: canEdit && hasPass,
    // Change a pass (the four, or the internal Speaker Pass), and the ticket value of a pass paid outside Stripe: management.
    canEditPass: canEdit && management && hasPass,
    canEditValue: canEdit && management && hasPass,
    canEditRsvpEmail: canEdit,
    canEditLogo: true,
    canEditRsvp: !!p.rsvp || hasPass || !!(p.name && p.name !== "No name"),
    // Delete person: management, never their own account (the last management account is checked on delete).
    canDelete: management && !self,
    deleteReason: !management ? "Only management can delete people." : self ? "You can't delete your own account." : "",
    reason: where === "none"
      ? "This person has no account or pass yet, so there's nowhere to save these. Their RSVP can still be set."
      : staffAccount && !management ? "Only management can change staff accounts." : "",
  };
}

/** Pass extras rules for this person's RSVP: their main pass's extras (staff's switches, else automatic; with
    no pass, the speaker type gives the CxO Breakfasts) and any extra already on their RSVPs (never taken away).
    → { cxo: true | false | undefined, extras: { cxo, lunch, gala, awards } | undefined, extra: [keys], speaker } */
export function rsvpRulesFor(p) {
  const cxo = p.primary ? !!p.primary.cxo : p.types.includes("speaker") ? true : undefined;
  const extras = p.primary ? { ...p.primary.extras } : cxo ? { cxo: true } : undefined;
  return { cxo, extras, extra: extraOptionsFor([...p.rsvps, ...p.dupRsvps]), speaker: p.types.includes("speaker") };
}

/** Everything for the profile page (the route adds the agenda, the RSVPs in full and the company).
    `management`: the amount paid for each pass (everyone else sees the band). */
export function personDetail(p, { management = false, cmsLogos = [], staffId = "" } = {}) {
  const rules = rsvpRulesFor(p);
  return {
    ...personRow(p),
    firstName: p.firstName,
    lastName: p.lastName,
    phone: p.phone || "",
    // The RSVP editor's rules: `extras` per pass extra true / false (null = by the pass picked), `keep`: extras on their RSVP.
    rsvpRules: { cxo: rules.cxo ?? null, extras: Object.fromEntries(EXTRA_KEYS.map((x) => [x, typeof rules.extras?.[x] === "boolean" ? rules.extras[x] : null])), keep: rules.extra },
    passes: p.passList.map((t) => ({
      ...passOut(t), hidden: t.hidden, checkedIn: t.checkedIn, purchaseDate: t.purchaseDate, promoCode: t.promoCode,
      claimed: t.claimed, booth: t.booth, exhibitorPass: t.exhibitorPass, printedLabel: t.printedLabel || "",
      hasStripe: !!t.stripeSessionId,
      ...(management ? {
        value: t.value ?? null,
        manualValue: t.manualValue ?? null, manualValueNote: t.manualValueNote || "", manualValueBy: t.manualValueBy || "", manualValueAt: t.manualValueAt || null,
      } : {}),
    })).sort((a, b) => (a.hidden - b.hidden) || ms(b.purchaseDate) - ms(a.purchaseDate)),
    boothOrders: p.boothOrders,
    speaker: p.speaker ? { id: String(p.speaker._id), name: String(p.speaker.name || "").trim(), title: String(p.speaker.title || "").trim(), company: String(p.speaker.company || "").trim() } : null,
    account: p.user ? {
      id: String(p.user._id), role: p.user.role || "user", lastActiveAt: p.user.lastActiveAt || null, createdAt: p.user.createdAt || null,
      // The App › People type editor's view: stored types, switched-off types, the automatic ones and whether they hold a pass.
      types: storedTypes(p.user.types), typesOff: storedTypes(p.user.typesOff), autoTypes: p.autoTypes || [], holdsPass: !!p.holdsPass,
    } : null,
    companyRecord: companyDTO(p.companyDoc),
    suggestedDomain: suggestDomain(p, cmsLogos),
    specialEvents: specialEvents(p.rsvp),
    edit: editInfo(p, { management, staffId }),
  };
}

/* ---------- "Send RSVP reminder" from the directory ----------
   The Marketing › RSVP reminders email (services/rsvpReminder.js), to the
   people in the current view who are Unconfirmed, have a usable email and
   a pass to RSVP with. Grouped by email like the reminders page: one email
   per address, a button per ticket still open. Everyone left out is listed
   with the reason. Pure; the route sends (routes/people.js). */
export const REMINDER_SKIP_LABELS = {
  confirmed: "Already confirmed",
  noPass: "No pass, so no RSVP link",
  ticketsDone: "Their tickets already have an RSVP",
  noEmail: "No email address",
  banned: "Account suspended",
  unsubscribed: "Unsubscribed from our emails",
  reminded: "Reminded in the last 20 hours",
  sending: "A reminder to them is still being sent",
};

/**
 * @param {Array} people    the filtered people (internal records)
 * @param {object} o
 * @param {Array}  o.rsvps      every listed RSVP (a ticket with one is never reminded)
 * @param {Iterable<string>} o.optedOut  emails with Subscription.subscribed false
 * @param {Array}  o.sends      CampaignSend rows of the reminder campaign ({ email, status, sentAt })
 * @param {number} o.cooldownMs a person reminded within this is skipped
 * @returns {{ targets: Array<{ email, firstName, lastName, name, tickets, people }>, skipped: Array<{ id, name, reason, label }>, counts: object }}
 */
export function planPeopleReminders(people = [], { rsvps = [], optedOut = [], sends = [], cooldownMs = 20 * 60 * 60 * 1000, now = Date.now() } = {}) {
  const index = rsvpIndex(rsvps);
  const out = new Set([...optedOut].map((e) => String(e || "").trim().toLowerCase()));
  const sendBy = new Map(sends.map((x) => [String(x.email || "").toLowerCase(), x]));
  const byEmail = new Map();
  const skipped = [];
  const skip = (p, reason) => skipped.push({ id: p.id, name: p.name, reason, label: REMINDER_SKIP_LABELS[reason] });
  let confirmed = 0;
  for (const p of people) {
    if (rsvpStatusOf(p.rsvp).status !== "none") { confirmed++; continue; }
    const passes = p.passList.filter((t) => !t.hidden && !isBooth(t.ticketId));
    if (!passes.length) { skip(p, "noPass"); continue; }
    const fallback = { firstName: p.firstName || splitName(p.name).firstName, lastName: p.lastName || splitName(p.name).lastName };
    const open = passes.map((t) => {
      const d = t.details || {};
      const holder = d.firstName || d.lastName ? { firstName: String(d.firstName || ""), lastName: String(d.lastName || "") } : fallback;
      return { ticketId: t.ticketId, ...holder, tier: t.tier };
    }).filter((t) => !hasRsvp(index, t));
    if (!open.length) { skip(p, "ticketsDone"); continue; }
    const email = usableEmail(p.email);
    if (!email) { skip(p, "noEmail"); continue; }
    if (p.user?.banned) { skip(p, "banned"); continue; }
    if (out.has(email)) { skip(p, "unsubscribed"); continue; }
    const s = sendBy.get(email);
    if (s?.status === "sending") { skip(p, "sending"); continue; }
    if (s?.status === "sent" && s.sentAt && now - new Date(s.sentAt).getTime() < cooldownMs) { skip(p, "reminded"); continue; }
    const have = byEmail.get(email);
    if (!have) {
      byEmail.set(email, { email, firstName: fallback.firstName, lastName: fallback.lastName, name: p.name, tickets: open, people: [{ id: p.id, name: p.name }] });
      continue;
    }
    for (const t of open) if (!have.tickets.some((x) => normalizeTicketId(x.ticketId) === normalizeTicketId(t.ticketId))) have.tickets.push(t);
    have.people.push({ id: p.id, name: p.name });
  }
  const targets = [...byEmail.values()];
  const skippedBy = {};
  for (const x of skipped) skippedBy[x.reason] = (skippedBy[x.reason] || 0) + 1;
  return {
    targets, skipped,
    counts: {
      matching: people.length, confirmed, unconfirmed: people.length - confirmed,
      emails: targets.length, people: targets.reduce((n, t) => n + t.people.length, 0), skipped: skipped.length, skippedBy,
    },
  };
}
