/* =========================================================
   People directory (Admin → People): one row per person, across
   every kind of record we keep about people.
   ---------------------------------------------------------
   Sources (routes/people.js loads them, nothing here touches the
   database, and listing never creates anything):
     - User: app and website accounts, their tickets, person types
       and staff / volunteer roles
     - Attendee: guest purchases, complimentary passes (COMP),
       Speaker Passes (SPEAKER), issued passes (ISSUED) and
       exhibitor passes (EXHIBITOR)
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
        a staff member's email can be on a Speaker Pass.
     3. Other guest passes with the same name join each other when
        their emails agree or one has none; else a person each.
     4. A speaker joins the person holding their Speaker Pass
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
   Pure; unit-tested in test/people.test.js.
========================================================= */

import { effectiveTypes, storedTypes, exhibitorIndex, passKind, PERSON_TYPES, EXHIBITOR_PROMO } from "./teamRoles.js";
import { normalizeTicketId, guestName, guestWork, passName } from "./ticketAccess.js";
import { personNameKey, fullNameMatches, tierFromTicketType, TIER_LABELS, RSVP_OPTIONS, DAYS, optionLabel } from "./rsvp.js";
import { csvCell } from "./brochureDownloads.js";
import { companyKey, companyDTO, domainOfUrl } from "./companies.js";
import { rsvpStatusOf, splitName } from "./rsvpStaff.js";
import { workDomain } from "./attendeeDetails.js";

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
export const RSVP_STATUSES = ["none", "attendee", "staff"];
export const RSVP_STATUS_LABELS = { none: "Not yet", attendee: "RSVP'd by attendee", staff: "Set by staff" };

const STAFF_PROMOS = new Set(["COMP", "ISSUED", "EXHIBITOR", "SPEAKER"]);
const EMAILED_PROMOS = new Set(["ISSUED", "EXHIBITOR", "SPEAKER"]); // passes the admin panel emails out
const EXHIBITOR_PASS_LABEL = "Exhibitor Pass";
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
 *   complimentary  staff-made (COMP, ISSUED, EXHIBITOR, Speaker Pass) and claimed in the app or checked in
 *   pending        staff-made pass we email out (Speaker, issued, exhibitor) whose email hasn't been sent
 *   issued         staff-made, sent or handed out, not claimed in the app yet
 *   paid           bought through the website checkout (a promo code may have lowered the price)
 * `refunds`: Map(Stripe Checkout Session id → { total, refunded }) or null.
 */
export function passStatus(t, refunds = null) {
  const promo = String(t?.promoCode || "").toUpperCase();
  const speakerPass = String(t?.type || "").toLowerCase() === "speaker";
  const r = t?.stripeSessionId && refunds ? refunds.get(t.stripeSessionId) : null;
  if (r && r.total > 0 && r.refunded >= r.total) return "refunded";
  if (STAFF_PROMOS.has(promo) || speakerPass) {
    if (t.claimed || t.checkedIn) return "complimentary";
    if ((EMAILED_PROMOS.has(promo) || speakerPass) && !t.passEmailSentAt) return "pending";
    return "issued";
  }
  return "paid";
}

/** The pass a ticket is, as staff call it: "Power Pass", "Speaker Pass", "Exhibitor Pass", an issued pass's own label. */
function passLabel(type, promo, issuedLabel) {
  if (String(promo || "").toUpperCase() === EXHIBITOR_PROMO) return EXHIBITOR_PASS_LABEL;
  if (issuedLabel) return String(issuedLabel).slice(0, 60);
  return passName(type) || "Pass";
}

/** A user ticket and / or the guest record of the same ticket → one pass record. */
function ticketRecord({ user = null, t = null, a = null }) {
  const ticketId = String(t?.ticketId || a?.ticketId || "");
  const type = String(t?.type || a?.ticketType || "");
  const promoCode = String(t?.promoCode || a?.promoCode || "");
  return {
    ticketId,
    norm: normalizeTicketId(ticketId),
    type,
    tier: tierFromTicketType(type),
    label: passLabel(type, promoCode, a?.issuedPass?.label),
    promoCode,
    stripeSessionId: String(t?.stripeSessionId || a?.stripeSessionId || ""),
    purchaseDate: t?.purchaseDate || a?.purchaseDate || null,
    checkedIn: !!(t?.checkedIn || a?.checkedIn),
    hidden: !!(t?.hiddenByStaff || a?.hiddenByStaff || a?.syncDuplicate),
    claimed: !!t || !!a?.claimedBy,
    passEmailSentAt: a?.passEmailSentAt || null,
    attendeeId: a ? String(a._id) : "",
    source: t ? "account" : "guest",
    // The Tickets page's row key (routes/console.js /tickets)
    key: t && user ? `u:${user._id}:${ticketId}` : `g:${ticketId}`,
    speakerId: String(a?.speakerId || ""),
    exhibitorPass: promoCode.toUpperCase() === EXHIBITOR_PROMO,
    booth: String(a?.issuedPass?.booth?.booth || "").slice(0, 20),
    details: t?.details || a?.details || null,
  };
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
 * @returns {{ people: object[], byId: Map<string, object> }}  internal person records (see personRow / personDetail)
 */
export function buildPeople({ users = [], attendees = [], rsvps = [], speakers = [], companies = [], refunds = null } = {}) {
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
  const exIdx = exhibitorIndex(attendees.filter((a) => String(a?.promoCode || "").toUpperCase() === EXHIBITOR_PROMO || a?.exhibitor === true));
  const ctx = { companiesByKey, refunds, exIdx };
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

function summarize(p, { companiesByKey, refunds, exIdx }) {
  const u = p.user;
  const tickets = [...p.tickets.values()].map((t) => ({ ...t, status: passStatus(t, refunds) }));
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
  const exhibitor = (u ? storedTypes(u.types).includes("exhibitor") : false) || p.attendees.some((a) => a.exhibitor === true);
  const exhibitorPass = tickets.some((t) => !t.hidden && t.exhibitorPass);
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
    types,
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
    search: fold([name, email, company, jobTitle, s?.name, ...tickets.map((t) => t.ticketId), ...p.emails].filter(Boolean).join(" ")),
  };
}

/* ---------- What the admin panel gets ---------- */

const passOut = (t) => (t ? {
  ticketId: t.ticketId, label: t.label, tier: t.tier, tierLabel: TIER_LABELS[t.tier] || "", status: t.status,
  statusLabel: PASS_STATUS_LABELS[t.status] || t.status, key: t.key, source: t.source,
} : null);

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
    exhibitor: p.exhibitor,
    exhibitorPass: p.exhibitorPass,
    linkedinUrl: p.linkedinUrl,
    hasAccount: !!p.user,
    userId: p.user ? String(p.user._id) : "",
    photoUrl: p.photoUrl,
    suggestedDomain: suggestDomain(p),
  };
}

/** ?q= name, email, company, job title or ticket ID; ?type= a person type or "none"; ?pass= a pass (tier) or "none";
    ?status= a pass status; ?rsvp= none | attendee | staff | any; ?exhibitor= yes | no. */
export function filterPeople(people, query = {}) {
  const q = fold(String(query.q || "").trim()).slice(0, 100);
  const type = String(query.type || "").toLowerCase();
  const pass = String(query.pass || "").toLowerCase();
  const status = String(query.status || "").toLowerCase();
  const rsvp = String(query.rsvp || "").toLowerCase();
  const ex = String(query.exhibitor || "").toLowerCase();
  const words = q ? q.split(/\s+/).filter(Boolean) : [];
  return people.filter((p) => {
    if (words.length && !words.every((w) => p.search.includes(w))) return false;
    if (type === "none" ? p.types.length : PERSON_TYPES.includes(type) && !p.types.includes(type)) return false;
    if (pass === "none" ? !!p.primary : TIER_RANK[pass] && p.primary?.tier !== pass) return false;
    if (PASS_STATUSES.includes(status) && (p.primary?.status || "none") !== status) return false;
    const rs = rsvpStatusOf(p.rsvp).status;
    if (rsvp === "any" ? rs === "none" : RSVP_STATUSES.includes(rsvp) && rs !== rsvp) return false;
    if (ex === "yes" && !p.exhibitor) return false;
    if (ex === "no" && p.exhibitor) return false;
    return true;
  });
}

export const SORTS = ["name", "company", "type", "pass", "status", "rsvp", "exhibitor"];
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
    exhibitor: (p) => (p.exhibitor ? 0 : 1),
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
  let exhibitors = 0;
  for (const p of people) {
    if (!p.types.length) byType.none += 1;
    for (const t of p.types) byType[t] += 1;
    byStatus[p.primary?.status || "none"] += 1;
    byRsvp[rsvpStatusOf(p.rsvp).status] += 1;
    if (p.exhibitor) exhibitors += 1;
  }
  return { total: people.length, byType, byStatus, byRsvp, exhibitors };
}

const TYPE_LABELS = { attendee: "Attendee", speaker: "Speaker", exhibitor: "Exhibitor", vip: "VIP", staff: "Staff", vendor: "Vendor", volunteer: "Volunteer" };
const DAY_LABEL = Object.fromEntries(DAYS.map((d) => [d.key, d.label]));
const GENERIC = /^(sessions|expo|breaks)_d\d$/; // what every pass includes on a day they come
const stamp = (t) => (t ? new Date(t).toISOString().replace("T", " ").slice(0, 16) : "");

export const PEOPLE_CSV_HEAD = [
  "Name", "Email", "Types", "Company", "Job title", "Pass", "Ticket ID", "Pass status", "Passes",
  "RSVP", "RSVP set by", "RSVP updated (UTC)", "Days", "Special events", "Exhibitor", "LinkedIn", "Company logo", "Profile",
];

/** Spreadsheet of the directory view (management, like the RSVP export: it holds emails). */
export function peopleCsv(people, { profileBase = "" } = {}) {
  const base = String(profileBase || "").replace(/\/+$/, "");
  const lines = people.map((p) => {
    const r = rsvpStatusOf(p.rsvp);
    return [
      p.name, p.email, p.types.map((t) => TYPE_LABELS[t] || t).join("; "), p.company, p.jobTitle,
      p.primary?.label || "", p.primary?.ticketId || "", PASS_STATUS_LABELS[p.primary?.status || "none"],
      p.passList.filter((t) => !t.hidden).length,
      RSVP_STATUS_LABELS[r.status], r.status === "staff" ? r.by : r.status === "attendee" ? "Attendee" : "", stamp(r.at),
      r.days.map((d) => DAY_LABEL[d] || d).join(" & "),
      specialEvents(p.rsvp).map((e) => optionLabel(e.key)).join("; "),
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

/** What may be edited on a person, and where it's saved. */
export function editInfo(p, { management = false } = {}) {
  const where = p.user ? "account" : p.attendees.length ? "pass" : "none";
  const staffAccount = p.user?.role === "admin";
  const canEdit = where !== "none" && (!staffAccount || management);
  return {
    where,
    canEdit,
    canEditEmail: canEdit && management,
    canEditExhibitor: canEdit,
    canEditLogo: true,
    canEditRsvp: !!p.rsvp || p.passList.some((t) => !t.hidden) || !!(p.name && p.name !== "No name"),
    reason: where === "none"
      ? "This person has no account or pass yet, so there's nowhere to save these. Their RSVP can still be set."
      : staffAccount && !management ? "Only management can change staff accounts." : "",
  };
}

/** Everything for the profile page (the route adds the agenda, the RSVPs in full and the company). */
export function personDetail(p, { management = false, cmsLogos = [] } = {}) {
  return {
    ...personRow(p),
    firstName: p.firstName,
    lastName: p.lastName,
    passes: p.passList.map((t) => ({
      ...passOut(t), hidden: t.hidden, checkedIn: t.checkedIn, purchaseDate: t.purchaseDate, promoCode: t.promoCode,
      claimed: t.claimed, booth: t.booth, exhibitorPass: t.exhibitorPass,
    })).sort((a, b) => (a.hidden - b.hidden) || ms(b.purchaseDate) - ms(a.purchaseDate)),
    boothOrders: p.boothOrders,
    speaker: p.speaker ? { id: String(p.speaker._id), name: String(p.speaker.name || "").trim(), title: String(p.speaker.title || "").trim(), company: String(p.speaker.company || "").trim() } : null,
    account: p.user ? {
      id: String(p.user._id), role: p.user.role || "user", lastActiveAt: p.user.lastActiveAt || null, createdAt: p.user.createdAt || null,
      types: storedTypes(p.user.types), typesOff: storedTypes(p.user.typesOff),
    } : null,
    companyRecord: companyDTO(p.companyDoc),
    suggestedDomain: suggestDomain(p, cmsLogos),
    specialEvents: specialEvents(p.rsvp),
    edit: editInfo(p, { management }),
  };
}
