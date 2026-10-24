/* =========================================================
   The volunteer panel: a person's free text, made safe
   ---------------------------------------------------------
   Names, companies, job titles, a pass's printed name, the booth
   and the RSVP's "Other" dietary text are typed by buyers and by
   staff, and can hold contact details: a buyer who typed their
   email as their name, a staff account added without a name
   (POST /api/console/staff names it after the part of the email
   before the @), a phone number in a dietary note, a LinkedIn
   address in the job title, a coupon code in an issued pass's
   printed name. Everything a volunteer gets of that text goes
   through here: the list rows and the profile
   (services/volunteerPanel.js) and the search box's People results
   (services/adminSearch.js peopleItems, volunteer).

   - A field that IS one of the person's emails, the part before
     the @ of one of them, one of their ticket IDs, Stripe sessions
     or coupon codes, a code on the directory's list, or the name in
     their LinkedIn address → "" (a name → "No name").
   - Inside a field, replaced by [hidden]:
       links: anything with a scheme (https://…), www.…, and a host
         with a path (linkedin.com/in/…, lnkd.in/…): a LinkedIn or any
         other profile address ("Acme.com" on its own stays);
       emails: a word with an @ in it and something after it, and
         one written out ("x [at] y [dot] com", "x.y at example.com",
         "x @ example.com"); "CEO @ Acme" stays;
       Stripe IDs: a known prefix (cs_ Checkout sessions, pi_, ch_,
         cus_, in_, …), then test_ / live_, or a digit, or 14+
         characters ("in_person" stays);
       coupon codes: the directory's (the Promo list, `codes`) and
         the ones on their own passes, as whole words in any case,
         never the internal markers COMP, ISSUED, EXHIBITOR, SPEAKER;
       runs of 7 or more digits (phone numbers, also with spaces,
         dots, dashes, slashes or brackets between), 12-character hex
         words with a digit (ticket IDs), BOOTH-… order IDs, their own
         ticket IDs and Stripe sessions, and the part before the @ of
         their emails and the name in their LinkedIn address when it
         looks like a handle (a . _ + - or a digit in it, 4+
         characters).
   - A name keeps only what's left ("Yara (yara@example.com)" →
     "Yara"); "No name" when nothing is. Other fields keep [hidden]
     where something was taken out, "" when nothing else is left.
   - Photo and logo addresses with an @, one of their ticket IDs, a
     Stripe ID or a LinkedIn profile in them → "".
   - The volunteer's word search (volunteerSearch, peopleItems) and
     the name / company sorts read the safe text only, so a word or
     the order of the list never gives away what was hidden.
   - Never throws (Oct 23 2026: a hyphen in one person's email once
     made an invalid pattern, and the list answered 500 to every
     volunteer). Patterns built from a person's data escape only what
     the u flag allows to be escaped; if anything still goes wrong
     for one person, only their fields fail, closed: a text →
     [hidden], a name → "No name", an address → "". The log line
     names the helper, never the text or the pattern.
   Staff and management never come through here. Pure, unit-tested
   in test/volunteer-panel.test.js.
========================================================= */

import { normalizeTicketId } from "./ticketAccess.js";
import { STAFF_MARKERS, cleanCode } from "./promoCodes.js";

export const MASK = "[hidden]";
export const NO_NAME = "No name";

const fold = (s) => String(s ?? "").normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().trim();
/**
 * A literal inside a pattern with the u flag: only the syntax characters (and "/") are escaped. Under the u flag
 * any other escape ("\-", "\'", "\@") is a SyntaxError, and "-" needs none outside a character class.
 */
export const escapeRx = (s) => String(s).replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

// Zero-width and control characters out (so "yara" + a zero-width space + "@example.com" is still one word), then the
// compatibility forms folded (the fullwidth at sign to "@", fullwidth digits to digits).
// The ranges: zero-width spaces and joiners, bidi marks, word joiners, the BOM, the control characters.
const INVISIBLE_RANGES = [[0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0xfeff, 0xfeff], [0x0, 0x8], [0xb, 0xc], [0xe, 0x1f], [0x7f, 0x7f]];
const hex4 = (n) => n.toString(16).padStart(4, "0");
const INVISIBLE = new RegExp(`[${INVISIBLE_RANGES.map(([a, b]) => `\\u${hex4(a)}-\\u${hex4(b)}`).join("")}]`, "gu");
const clean = (v) => String(v ?? "").replace(INVISIBLE, "").normalize("NFKC").replace(/\s+/g, " ").trim();
/** A secret as it may be typed: with its accents (lower case) and without them. */
const variants = (s) => [...new Set([clean(s).toLowerCase(), fold(clean(s))])].filter(Boolean);

/* What is taken out while masking is first replaced by a NUL, which clean() has already removed from the text (it
   can't be typed); every run of them, with separators between, becomes one MASK at the end. */
const CUT = "\u0000";

/** Links: a scheme (https://, ftp://), www.…, or a host with a path (linkedin.com/in/…, lnkd.in/x). */
const SCHEME_URL = /(?<![\p{L}\p{N}])[a-z][a-z0-9+.-]{1,15}:\/\/\S*/giu;
const WWW_URL = /(?<![\p{L}\p{N}.-])www\.\S+/giu;
const HOST_PATH = /(?<![\p{L}\p{N}@._-])[\p{L}\p{N}][\p{L}\p{N}-]{1,62}(?:\.[\p{L}\p{N}-]{1,63})*\.\p{L}{2,24}(?::\d{1,5})?\/\S*/giu;
/** Emails written out: "x [at] y.com", "x(at)y(dot)com", "x.y at example.com" (a handle on the left), "x @ y.com". */
const AT_BRACKET = /[^\s[({<]*\s*[[({<]\s*at\s*[\])}>]\s*[^\s[\](){}<>]*(?:\s*[[({<]\s*dot\s*[\])}>]\s*[^\s[\](){}<>]*)*/giu;
const AT_WORD = /(?<![\p{L}\p{N}._%+-])(?=[\p{L}\p{N}._%+-]*[._%+\p{Nd}])[\p{L}\p{N}._%+-]+\s+at\s+(?:[\p{L}\p{N}-]+\.)+\p{L}{2,24}/giu;
const AT_SPACED = /(?<!\S)[^\s@]+\s+@\s+(?:[\p{L}\p{N}-]+\.)+\p{L}{2,24}/gu;
/** Email-shaped: a word with an @ inside and something after it ("CEO @ Acme" stays). */
const EMAILISH = /[^\s@]*@[^\s@]+/gu;
/** Stripe IDs: Checkout sessions (cs_), payments (pi_, ch_, py_), customers, invoices, refunds, … */
const STRIPE_PREFIX = "cs|pi|ch|py|re|in|ii|il|cus|pm|src|seti|si|sub|tok|txn|card|ba|po|tr|evt|acct|price|prod|cn|dp|du|pyr|ipi|promo|coupon|plink|bpc|qt|sess|whsec|sk|pk|rk";
const STRIPE_SRC = `(?<![\\p{L}\\p{N}_])(?:${STRIPE_PREFIX})_(?:(?:test|live)_[A-Za-z0-9]{4,}|(?=[A-Za-z0-9]*\\d)[A-Za-z0-9]{8,}|[A-Za-z0-9]{14,})(?![\\p{L}\\p{N}])`;
const STRIPE_ID = new RegExp(STRIPE_SRC, "giu");
const HAS_STRIPE_ID = new RegExp(STRIPE_SRC, "iu");
/** 7+ digits in a row, or with up to 3 of space . - / ( ) + between them: phone numbers. */
const DIGITS = /\+?\p{Nd}(?:[\s().\-/+]{0,3}\p{Nd}){6,}/gu;
/** Ticket IDs are 12 hex characters (with a digit); booth orders BOOTH-…. */
const HEX_ID = /(?<![\p{L}\p{N}])(?=[0-9a-f]{0,11}[0-9])[0-9a-f]{12}(?![\p{L}\p{N}])/giu;
const BOOTH_ID = /(?<![\p{L}\p{N}])BOOTH-[\p{L}\p{N}-]+/giu;
/** The name in a LinkedIn address: linkedin.com/in/<name>, /pub/<name>. */
const LINKEDIN_NAME = /linkedin\.com\/(?:in|pub)\/([^/?#\s]+)/i;
const LINKEDIN_PROFILE = /linkedin\.com\/(?:in|pub)\//i;
/** A handle: 4+ characters with a . _ + - or a digit in it (a one-word name like "priya" isn't masked inside text). */
const handleLike = (s) => s.length >= 4 && /[._+\-\p{Nd}]/u.test(s);

/* A failure is reported without the text or the pattern (both can hold the person's email or ticket IDs), at most
   once a minute. */
let lastReport = 0;
function report(where, err) {
  const now = Date.now();
  if (now - lastReport < 60 * 1000) return;
  lastReport = now;
  console.error(`VOLUNTEER SAFE TEXT: ${where} failed closed (${err?.name || "Error"})`);
}
function failClosed(where, fallback, fn) {
  try { return fn(); } catch (err) { report(where, err); return fallback; }
}

/** One pattern for these literals (longest first; the u and i flags fold the case); null for none. */
function literalRx(list, { words = false } = {}) {
  const items = [...new Set(list)].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!items.length) return null;
  const body = items.map(escapeRx).join("|");
  return new RegExp(words ? `(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])` : `(?:${body})`, "giu");
}

/** A coupon code worth masking: not an internal marker, 3+ characters (or 2 with a digit). */
const maskableCode = (c) => !!c && !STAFF_MARKERS[c] && (c.length >= 3 || (c.length === 2 && /\d/.test(c)));
const codeList = (codes) => [...new Set([...(codes instanceof Set || Array.isArray(codes) ? codes : [])]
  .filter((c) => typeof c === "string").map(cleanCode).filter(maskableCode))];

/* The directory's codes, made into a pattern once per list (the directory keeps the same array for its 20 s). */
const codesCache = new WeakMap();
const NO_CODES = Object.freeze({ whole: [], rx: null });
function directoryCodes(codes) {
  if (!codes || typeof codes !== "object") return NO_CODES;
  if (codesCache.has(codes)) return codesCache.get(codes);
  const list = codeList(codes);
  const out = { whole: list.flatMap(variants), rx: literalRx(list.flatMap(variants), { words: true }) };
  codesCache.set(codes, out);
  return out;
}

/** The codes on a person's own passes (an account's tickets, its pass rows, booth orders included). */
function ownCodes(p) {
  const out = [];
  for (const t of p?.passList || []) {
    out.push(t?.promoCode);
    if (t?.code?.kind === "code") out.push(t.code.code);
    for (const s of t?.codeSources || []) out.push(s?.promoCode);
  }
  for (const t of p?.user?.tickets || []) out.push(t?.promoCode);
  for (const a of p?.attendees || []) out.push(a?.promoCode);
  return codeList(out);
}

/** The name in each LinkedIn address we hold for them. */
function linkedinNames(p) {
  const urls = [p?.linkedinUrl, p?.user?.linkedinUrl, p?.speaker?.linkedin,
    ...(p?.passList || []).map((t) => t?.details?.linkedin), ...(p?.attendees || []).map((a) => a?.details?.linkedin)];
  const out = [];
  for (const u of urls) {
    const m = LINKEDIN_NAME.exec(String(u ?? ""));
    if (!m) continue;
    let name = m[1];
    try { name = decodeURIComponent(name); } catch { /* as written */ }
    out.push(...variants(name).filter((v) => v.length >= 3));
  }
  return out;
}

const secretsCache = new WeakMap();
const BROKEN = Object.freeze({ emails: new Set(), locals: new Set(), tickets: new Set(), whole: new Set(), patterns: [], broken: true });

/**
 * What a person's text is checked against: { emails, locals, tickets, whole, patterns, broken }. Every email we hold
 * for them (account, passes, RSVPs, the directory's), the part before each @, their ticket IDs and booth orders,
 * their Stripe sessions, their coupon codes and the directory's (`codes`), the name in their LinkedIn address.
 * Kept per person object (the directory's records live 20 s) and list of codes. Never throws: `broken` when
 * something couldn't be read or made, and then every field of theirs fails closed.
 */
export function secretsOf(p, codes = null) {
  const keep = p && typeof p === "object";
  const cached = keep ? secretsCache.get(p) : null;
  if (cached && cached.codes === codes) return cached.out;
  let out;
  try {
    const emails = new Set();
    const addEmail = (e) => { for (const v of variants(e)) if (v.includes("@")) emails.add(v); };
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
    for (const t of p?.user?.tickets || []) addTicket(t?.ticketId);
    for (const b of p?.boothOrders || []) addTicket(b);
    const sessions = new Set();
    for (const t of p?.passList || []) {
      for (const s of [t?.stripeSessionId, ...(t?.codeSources || []).map((x) => x?.stripeSessionId)]) {
        const v = String(s ?? "").trim().toLowerCase();
        if (v.length >= 6) sessions.add(v);
      }
    }
    const own = ownCodes(p).flatMap(variants);
    const dir = directoryCodes(codes);
    const li = linkedinNames(p);
    const handles = [...locals, ...li].filter(handleLike);
    out = {
      emails, locals, tickets, broken: false,
      // A whole field that is one of these is a secret (case and accents ignored).
      whole: new Set([...emails, ...locals, ...tickets, ...sessions, ...own, ...dir.whole, ...li].map(fold)),
      patterns: [literalRx([...tickets, ...sessions]), literalRx(own, { words: true }), dir.rx, literalRx(handles, { words: true })].filter(Boolean),
    };
  } catch (err) {
    report("secretsOf", err);
    out = BROKEN;
  }
  if (keep) secretsCache.set(p, { codes, out });
  return out;
}

const hasText = (s) => /[\p{L}\p{N}]/u.test(String(s).split(MASK).join(""));

/** Is this whole field one of the person's secrets (an email, the part before an @, a ticket ID, a code, …)? */
function isSecret(s, sec) {
  const f = fold(s).replace(/^[\s"'<([{]+|[\s"'>)\]}.,;:]+$/g, "");
  if (!f) return false;
  return sec.whole.has(f) || sec.tickets.has(normalizeTicketId(f));
}

/** The text with everything sensitive replaced by MASK (not trimmed to a length yet). */
function masked(s, sec) {
  let out = s
    .replace(SCHEME_URL, CUT).replace(WWW_URL, CUT).replace(HOST_PATH, CUT)
    .replace(AT_BRACKET, CUT).replace(AT_WORD, CUT).replace(AT_SPACED, CUT)
    .replace(EMAILISH, CUT);
  for (const rx of sec.patterns) out = out.replace(rx, CUT);
  out = out.replace(STRIPE_ID, CUT).replace(BOOTH_ID, CUT).replace(HEX_ID, CUT).replace(DIGITS, CUT);
  // A run of cuts, with separators between → one MASK.
  return out.replace(/\u0000(?:[\s,;/|.·-]*\u0000)*/g, MASK).replace(/\s+/g, " ").trim();
}

function textOf(value, p, max, codes) {
  const s = clean(String(value ?? "").slice(0, 2000));
  if (!s) return "";
  const sec = secretsOf(p, codes);
  if (sec.broken) return MASK;
  if (isSecret(s, sec)) return "";
  const out = masked(s, sec);
  if (!hasText(out)) return "";
  if (out.length <= max) return out;
  // Never cut a mask in half.
  const cut = out.slice(0, max);
  const open = cut.lastIndexOf("[");
  return (open > -1 && !cut.slice(open).includes("]") ? cut.slice(0, open) : cut).trim();
}

function nameOf(p, max, codes) {
  const raw = clean(String(p?.name ?? "").slice(0, 2000));
  if (!raw || raw === NO_NAME) return NO_NAME;
  const sec = secretsOf(p, codes);
  if (sec.broken || isSecret(raw, sec)) return NO_NAME;
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

function urlOf(value, p, max, codes) {
  const s = String(value ?? "").trim();
  if (!s || s.length > max) return "";
  if (s.includes("@") || /%40/i.test(s) || LINKEDIN_PROFILE.test(s) || HAS_STRIPE_ID.test(s)) return "";
  const sec = secretsOf(p, codes);
  if (sec.broken) return "";
  const low = s.toLowerCase();
  for (const t of sec.tickets) if (low.includes(t)) return "";
  return s;
}

const plain = (s) => s.split(MASK).join(" ").replace(/\s+/g, " ").trim();

/**
 * The safe text with one directory's coupon codes (`codes`: routes/people.js directory().promoCodes; the codes on a
 * person's own passes are always masked): { name, text, url, searchText, searchFields }. None of them ever throws.
 */
export function volunteerText({ codes = null } = {}) {
  const name = (p, max = 200) => failClosed("name", NO_NAME, () => nameOf(p, max, codes));
  const text = (value, p, max = 200) => failClosed("text", MASK, () => textOf(value, p, max, codes));
  const url = (value, p, max = 500) => failClosed("url", "", () => urlOf(value, p, max, codes));
  // What the word search may match: the safe name (not "No name"), company, job title, speaker name.
  const searchText = (p) => failClosed("searchText", "", () => {
    const n = name(p);
    return plain([n === NO_NAME ? "" : n, text(p?.company, p), text(p?.jobTitle, p), text(p?.speaker?.name, p)].join(" "));
  });
  // [[text, weight], …] for services/adminSearch.js matchScore: the same safe fields.
  const searchFields = (p) => failClosed("searchFields", [["", 10], ["", 5], ["", 4]], () => {
    const n = name(p);
    return [[n === NO_NAME ? "" : n, 10], [plain(text(p?.company, p)), 5], [plain(text(p?.jobTitle, p)), 4]];
  });
  return { name, text, url, searchText, searchFields };
}

/* Without a directory's code list (the person's own codes are still masked). */
const own = volunteerText();

/**
 * Free text about a person, as a volunteer may see it: "" when the field is a secret of theirs or nothing but
 * hidden parts is left, else the text with MASK where something was taken out, at most `max` characters.
 */
export const safeText = (value, p, max = 200) => own.text(value, p, max);
/** A person's name as a volunteer sees it: what's left after taking out anything sensitive, else "No name". */
export const safeName = (p, max = 200) => own.name(p, max);
/** A photo or logo address: "" when it carries an @, one of their ticket IDs, a Stripe ID or a LinkedIn profile. */
export const safeUrl = (value, p, max = 500) => own.url(value, p, max);
/** The text a volunteer's word search may match: the safe name (not "No name"), company, job title, speaker name. */
export const safeSearchText = (p) => own.searchText(p);
/** [[text, weight], …] for services/adminSearch.js matchScore: the same safe fields, for the volunteer's search box. */
export const safeSearchFields = (p) => own.searchFields(p);
