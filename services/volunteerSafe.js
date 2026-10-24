/* =========================================================
   The volunteer panel: a person's free text, made safe
   ---------------------------------------------------------
   Names, companies, job titles, a pass's printed name, the booth
   and the RSVP's "Other" dietary text are typed by buyers and by
   staff, and can hold contact details: a buyer who typed their
   email as their name, a staff account added without a name
   (POST /api/console/staff names it after the part of the email
   before the @), a phone number in a dietary note. Everything a
   volunteer gets of that text goes through here: the list rows and
   the profile (services/volunteerPanel.js) and the search box's
   People results (services/adminSearch.js peopleItems, volunteer).

   - A field that IS one of the person's emails, the part before
     the @ of one of them, or one of their ticket IDs → "" (a name →
     "No name").
   - Inside a field, replaced by [hidden]: anything email-shaped (a
     word with an @ in it and something after it), runs of 7 or more
     digits (phone numbers, also with spaces, dots, dashes, slashes or
     brackets between), 12-character hex words with a digit (ticket
     IDs), BOOTH-… order IDs, the person's own ticket IDs, and the
     part before the @ of their emails when it looks like a handle
     (a . _ + - or a digit in it, 4+ characters).
   - A name keeps only what's left ("Yara (yara@example.com)" →
     "Yara"); "No name" when nothing is. Other fields keep [hidden]
     where something was taken out, "" when nothing else is left.
   - Photo and logo addresses with an @ or one of their ticket IDs
     in them → "".
   - The volunteer's word search (volunteerSearch, peopleItems) and
     the name / company sorts read the safe text only, so a word or
     the order of the list never gives away what was hidden.
   Staff and management never come through here. Pure, unit-tested
   in test/volunteer-panel.test.js.
========================================================= */

import { normalizeTicketId } from "./ticketAccess.js";

export const MASK = "[hidden]";
export const NO_NAME = "No name";

const fold = (s) => String(s ?? "").normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().trim();
const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

// Zero-width and control characters out (so "yara" + a zero-width space + "@example.com" is still one word), then the
// compatibility forms folded (the fullwidth at sign to "@", fullwidth digits to digits).
// The ranges: zero-width spaces and joiners, bidi marks, word joiners, the BOM, the control characters.
const INVISIBLE_RANGES = [[0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0xfeff, 0xfeff], [0x0, 0x8], [0xb, 0xc], [0xe, 0x1f], [0x7f, 0x7f]];
const hex4 = (n) => n.toString(16).padStart(4, "0");
const INVISIBLE = new RegExp(`[${INVISIBLE_RANGES.map(([a, b]) => `\\u${hex4(a)}-\\u${hex4(b)}`).join("")}]`, "gu");
const clean = (v) => String(v ?? "").replace(INVISIBLE, "").normalize("NFKC").replace(/\s+/g, " ").trim();

/** Email-shaped: a word with an @ inside and something after it ("CEO @ Acme" stays). */
const EMAILISH = /[^\s@]*@[^\s@]+/gu;
/** 7+ digits in a row, or with up to 3 of space . - / ( ) + between them: phone numbers. */
const DIGITS = /\+?\p{Nd}(?:[\s().\-/+]{0,3}\p{Nd}){6,}/gu;
/** Ticket IDs are 12 hex characters (with a digit); booth orders BOOTH-…. */
const HEX_ID = /(?<![\p{L}\p{N}])(?=[0-9a-f]{0,11}[0-9])[0-9a-f]{12}(?![\p{L}\p{N}])/giu;
const BOOTH_ID = /(?<![\p{L}\p{N}])BOOTH-[\p{L}\p{N}-]+/giu;

const secretsCache = new WeakMap();

/**
 * What a person's text is checked against: { emails, locals, tickets, handleRx, ticketRx }. Every email we hold for
 * them (account, passes, RSVPs, the directory's), the part before each @, their ticket IDs and booth orders.
 * Kept per person object (the directory's records live 20 s).
 */
export function secretsOf(p) {
  if (p && typeof p === "object" && secretsCache.has(p)) return secretsCache.get(p);
  const emails = new Set();
  const addEmail = (e) => { const v = fold(clean(e)); if (v.includes("@")) emails.add(v); };
  addEmail(p?.email);
  addEmail(p?.user?.email);
  for (const e of p?.emails || []) addEmail(e);
  for (const a of p?.attendees || []) addEmail(a?.email);
  for (const r of [...(p?.rsvps || []), ...(p?.dupRsvps || []), p?.rsvp]) addEmail(r?.email);
  const locals = new Set([...emails].map((e) => e.slice(0, e.lastIndexOf("@"))).filter((l) => l.length >= 2));
  const tickets = new Set();
  const addTicket = (id) => { const n = normalizeTicketId(id); if (n.length >= 4) tickets.add(n); };
  for (const t of p?.passList || []) addTicket(t?.ticketId);
  for (const id of p?.tickets instanceof Map ? p.tickets.keys() : []) addTicket(id);
  for (const b of p?.boothOrders || []) addTicket(b);
  const handles = [...locals].filter((l) => l.length >= 4 && /[._+\-\d]/.test(l)).sort((a, b) => b.length - a.length);
  const out = {
    emails, locals, tickets,
    handleRx: handles.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${handles.map(escapeRx).join("|")})(?![\\p{L}\\p{N}])`, "giu") : null,
    ticketRx: tickets.size ? new RegExp([...tickets].sort((a, b) => b.length - a.length).map(escapeRx).join("|"), "giu") : null,
  };
  if (p && typeof p === "object") secretsCache.set(p, out);
  return out;
}

const hasText = (s) => /[\p{L}\p{N}]/u.test(String(s).split(MASK).join(""));

/** Is this whole field one of the person's emails, the part before an @, or a ticket ID of theirs? */
function isSecret(s, sec) {
  const f = fold(s).replace(/^[\s"'<([{]+|[\s"'>)\]}.,;:]+$/g, "");
  if (!f) return false;
  return sec.emails.has(f) || sec.locals.has(f) || sec.tickets.has(normalizeTicketId(f));
}

/** The text with everything sensitive replaced by MASK (not trimmed to a length yet). */
function masked(s, sec) {
  let out = s.replace(EMAILISH, MASK);
  if (sec.ticketRx) out = out.replace(sec.ticketRx, MASK);
  if (sec.handleRx) out = out.replace(sec.handleRx, MASK);
  out = out.replace(BOOTH_ID, MASK).replace(HEX_ID, MASK).replace(DIGITS, MASK);
  // "[hidden] [hidden]" → one.
  return out.replace(/\[hidden\](?:[\s,;/|.-]*\[hidden\])+/g, MASK).replace(/\s+/g, " ").trim();
}

/**
 * Free text about a person, as a volunteer may see it: "" when the field is a secret of theirs or nothing but
 * hidden parts is left, else the text with MASK where something was taken out, at most `max` characters.
 */
export function safeText(value, p, max = 200) {
  const s = clean(String(value ?? "").slice(0, 2000));
  if (!s) return "";
  const sec = secretsOf(p);
  if (isSecret(s, sec)) return "";
  const out = masked(s, sec);
  if (!hasText(out)) return "";
  if (out.length <= max) return out;
  // Never cut a mask in half.
  const cut = out.slice(0, max);
  const open = cut.lastIndexOf("[");
  return (open > -1 && !cut.slice(open).includes("]") ? cut.slice(0, open) : cut).trim();
}

/** A person's name as a volunteer sees it: what's left after taking out anything sensitive, else "No name". */
export function safeName(p, max = 200) {
  const raw = clean(String(p?.name ?? "").slice(0, 2000));
  if (!raw || raw === NO_NAME) return NO_NAME;
  const sec = secretsOf(p);
  if (isSecret(raw, sec)) return NO_NAME;
  const out = masked(raw, sec)
    .split(MASK).join(" ")
    // Brackets and separators left empty: "Yara ( )" → "Yara", "Yara - " → "Yara".
    .replace(/[([{<]\s*[)\]}>]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:|/·.\-–—]+|[\s,;:|/·\-–—]+$/g, "")
    .trim()
    .slice(0, max)
    .trim();
  return hasText(out) ? out : NO_NAME;
}

/** A photo or logo address: "" when it carries an @ or one of their ticket IDs. */
export function safeUrl(value, p, max = 500) {
  const s = String(value ?? "").trim();
  if (!s || s.length > max) return "";
  if (s.includes("@") || /%40/i.test(s)) return "";
  const { tickets } = secretsOf(p);
  const low = s.toLowerCase();
  for (const t of tickets) if (low.includes(t)) return "";
  return s;
}

/** The text a volunteer's word search may match: the safe name (not "No name"), company, job title, speaker name. */
export function safeSearchText(p) {
  const name = safeName(p);
  return [name === NO_NAME ? "" : name, safeText(p?.company, p), safeText(p?.jobTitle, p), safeText(p?.speaker?.name, p)]
    .map((s) => s.split(MASK).join(" "))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** [[text, weight], …] for services/adminSearch.js matchScore: the same safe fields, for the volunteer's search box. */
export function safeSearchFields(p) {
  const name = safeName(p);
  const plain = (s) => s.split(MASK).join(" ").trim();
  return [[name === NO_NAME ? "" : name, 10], [plain(safeText(p?.company, p)), 5], [plain(safeText(p?.jobTitle, p)), 4]];
}
