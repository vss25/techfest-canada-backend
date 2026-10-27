/* =========================================================
   "Stay updated": the TTFC 2027 waitlist (Oct 23 2026). Pure.
   ---------------------------------------------------------
   The organiser: "thetechfestival.com/stay-updated — Stay-updated
   to have preview of 2027 events and an bar to add the email and
   join the waitlist to attend. Also tickmark on sponsorship,
   exhibitor or delegation interest. Once the person enters the
   email and phone number, their details should be sent to
   enquire@thetechfestival.com with appropriate email subject. The
   person should be told as thank you for your interest. someone
   will reach out." Then: "Send an email to who sign ups as well.
   It should go from enquire@thetechfestival.com too."
   Oct 24 2026: "On the waitlist page form, also add name and company
   name. For people who use this in the app, we should have the
   details prefilled since those details are required to be on the
   app"; then, the same day: "Please only keep email mandatory in
   the stay updated form." So only the email is required; a name,
   company or phone that is given must be right.

   Here: what the form may send (validateSignup), the page's and the
   confirmation email's wording (STAY_DEFAULTS: app content keys,
   editable in Admin › Sales & emails › 2027 waitlist › Wording and
   served by GET /api/app/content; the 2027 journey, stay.journey,
   is checked by services/stayJourney.js), the team's email
   (buildWaitlistAlert, a staff alert: never the "Get the TTFC app"
   block), when the person may get their confirmation again
   (confirmDue: at most once a day per address) and the admin list's
   rows, filter and CSV. The request handler is
   services/waitlistHandler.js, the confirmation email
   services/waitlistEmail.js, the routes routes/stayUpdated.js.
   Unit tests: test/waitlist.test.js; with a database:
   test/waitlist-db.test.js.
========================================================= */

import crypto from "crypto";
import { cleanText, csvCell } from "./brochureDownloads.js";
import { cleanEmail } from "./unsubscribe.js";
import { escapeHtml as esc } from "./ticketInfo.js";
import { trackSecret } from "./trackToken.js";
import { DEFAULT_JOURNEY_JSON, JOURNEY_KEY } from "./stayJourney.js";

/** What can be ticked (stored values, in this order). "delegate" (Oct 27 2026, the organiser: "Provide the ability to
    share interest like delegate, exhibitor, and sponsor"): coming to TTFC 2027 as a delegate, first; "delegation" is
    bringing a group. */
export const INTERESTS = Object.freeze(["delegate", "exhibitor", "sponsorship", "delegation"]);
/** Staff's words (the team email's subject, the admin list, the CSV). The page's and the person's email's words are
    the stay.interest_<value> keys. */
export const INTEREST_LABEL = Object.freeze({ delegate: "Delegate", exhibitor: "Exhibitor", sponsorship: "Sponsorship", delegation: "Delegation" });
/** Where a sign-up came from. */
export const SOURCES = Object.freeze(["website", "webapp", "ios", "android", "programme"]);
/* "programme": the sign-up form at the bottom of the website's /programme page (Oct 24 2026). */
export const SOURCE_LABEL = Object.freeze({ website: "Website", webapp: "Web app", ios: "iOS app", android: "Android app", programme: "Website programme page" });

/** The team's inbox (WAITLIST_INBOX overrides, comma-separate for several). */
export const WAITLIST_INBOX = "enquire@thetechfestival.com";
export const PAGE_URL = "https://www.thetechfestival.com/stay-updated";
/** The person's confirmation goes again only when the last one is at least this old. */
export const CONFIRM_EVERY_MS = 24 * 60 * 60 * 1000;
export const PHONE_DIGITS = Object.freeze({ min: 7, max: 20 });
export const MAX_EMAIL = 254;
export const MAX_PHONE = 40;
/** The person's name (Oct 24 2026): 2–80 characters, letters (any language, accents) with spaces, hyphens, apostrophes
    and dots. */
export const NAME_LENGTH = Object.freeze({ min: 2, max: 80 });
/** Their company or organisation: up to 120 characters. */
export const MAX_COMPANY = 120;
/** Earlier names / companies kept on a row when a repeat sign-up gives a new one (newest last). */
export const MAX_EARLIER = 5;

/* ---------- the wording (app content keys) ----------
   Plain text. Empty = the default here. Mirrored in the website's src/lib/stayUpdated.js for when the API can't be
   reached. The facts are the organiser's (Oct 23 2026): five one-day briefings (February Vancouver, April Montreal,
   June Calgary and Toronto, September Ottawa), each on one technology pillar and one sector, then the festival in
   Toronto, two days in November 2027; dates to be announced for every event; no attendee count on 2027 material.
   The journey itself is stay.journey (services/stayJourney.js: a JSON list of stops, edited in Admin › Sales &
   emails › 2027 waitlist › 2027 journey). The 5 × 5 programme and "What to expect" were taken off the page the same
   day (their keys are gone; saved values for them are ignored). */
export const STAY_DEFAULTS = Object.freeze({
  "stay.seo_title": "Stay updated: TTFC 2027 in Toronto | The Tech Festival Canada",
  "stay.seo_description": "TTFC 2027 across Canada: one-day briefings in Vancouver, Montreal, Calgary, Toronto and Ottawa, then two days in Toronto in November 2027. Join the waitlist.",
  "stay.eyebrow": "Stay updated",
  "stay.hero_title": "TTFC 2027 · Toronto · November 2027",
  "stay.hero_intro": "TTFC 2027 travels across Canada: five focused one-day briefings in Vancouver, Montreal, Calgary, Toronto and Ottawa, then The Tech Festival Canada, two days in Toronto in November 2027. Dates to be announced for every event. Join the waitlist and our team will keep you posted.",
  "stay.journey_title": "TTFC 2027 across Canada",
  "stay.journey_intro": "Five focused one-day briefings, each on one technology pillar and one sector, lead to two days in Toronto in November 2027. Dates to be announced for every event.",
  [JOURNEY_KEY]: DEFAULT_JOURNEY_JSON,
  "stay.form_title": "Join the TTFC 2027 waitlist",
  "stay.form_intro": "Only your email is needed; your name, company and phone number help our team reach out. Tick anything else you'd like to talk to us about.",
  "stay.field_name": "Your name",
  "stay.field_company": "Company or organisation",
  "stay.field_email": "Email",
  "stay.field_phone": "Phone",
  "stay.interests_label": "I'm interested in (optional)",
  "stay.interest_delegate": "Attending as a delegate",
  "stay.interest_exhibitor": "Exhibiting",
  "stay.interest_sponsorship": "Sponsorship",
  "stay.interest_delegation": "Bringing a delegation",
  "stay.consent": "By joining, you agree The Tech Festival Canada can contact you about TTFC 2027.",
  "stay.button": "Join the waitlist",
  "stay.thanks_title": "You're on the TTFC 2027 waitlist",
  "stay.thanks": "Thank you for your interest. Someone from our team will reach out.",
  "stay.email_subject": "You're on the TTFC 2027 waitlist",
  "stay.email_heading": "You're on the TTFC 2027 waitlist.",
  "stay.email_intro": "Thank you for your interest in TTFC 2027: one-day briefings in Vancouver, Montreal, Calgary, Toronto and Ottawa, then The Tech Festival Canada, two days in Toronto in November 2027. Dates to be announced for every event.",
  "stay.email_next": "Someone from our team will reach out.",
  "stay.email_button": "See what's coming in 2027",
});
export const STAY_KEYS = Object.freeze(Object.keys(STAY_DEFAULTS));
export const DEFAULT_MESSAGE = STAY_DEFAULTS["stay.thanks"];

/** Saved values over the defaults (an empty or missing value = the default). `rows`: [{ key, value }]. */
export function stayCopy(rows = []) {
  const out = { ...STAY_DEFAULTS };
  for (const r of rows || []) {
    if (!r || !Object.hasOwn(STAY_DEFAULTS, r.key)) continue;
    const v = typeof r.value === "string" ? r.value.trim() : "";
    if (v) out[r.key] = v;
  }
  return out;
}

/* ---------- what the form sends ---------- */

/** "+1 (416) 555-0100" → "14165550100"; null when anything but + spaces dashes parens and digits is in it. */
export function phoneDigits(v) {
  const s = String(v ?? "").trim();
  if (!s || s.length > MAX_PHONE) return null;
  const digits = s.replace(/[+\s\-()]/g, "");
  return /^\d+$/.test(digits) ? digits : null;
}

/** Known interests, de-duplicated, in INTERESTS order (anything else is dropped). */
export function cleanInterests(v) {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  const want = new Set(list.map((x) => String(x ?? "").trim().toLowerCase()));
  return INTERESTS.filter((k) => want.has(k));
}

export const cleanSource = (v) => {
  const s = String(v ?? "").trim().toLowerCase();
  return SOURCES.includes(s) ? s : "website";
};

/** Only bots fill the hidden `_hp` field. */
export const isHoneypotFilled = (body) => cleanText(body?._hp) !== "";

/* The person's name: letters in any language (with their accents), spaces, hyphens, apostrophes (' and ’) and dots;
   at least one letter. The website mirrors these rules and words in src/lib/stayUpdated.js. */
const NAME_CHARS = /^[\p{L}\p{M} .'’‐-]+$/u;
const HAS_LETTER = /\p{L}/u;

/** The form's problems in plain words (the website shows the same ones before sending). Only the email is required:
    these are for a name, company or phone that was given but isn't right. */
export const ERRORS = Object.freeze({
  nameLength: "Enter your name in 2 to 80 characters, or leave it empty.",
  nameBad: "Use letters for your name, with spaces, hyphens, apostrophes or dots if you like.",
  companyLong: "Keep your company or organisation to 120 characters.",
  phoneBad: "That phone number doesn't look right. Use digits, with + ( ) - or spaces if you like.",
});

/** "  Priya   Raman " → "Priya Raman" (control characters out, spaces tidied). */
export const cleanName = (v) => cleanText(v);

/** null when the name is fine or empty (it's optional), else the problem in plain words. */
export function nameProblem(name) {
  const n = cleanName(name);
  if (!n) return null;
  if (n.length < NAME_LENGTH.min || n.length > NAME_LENGTH.max) return ERRORS.nameLength;
  if (!NAME_CHARS.test(n) || !HAS_LETTER.test(n)) return ERRORS.nameBad;
  return null;
}

/** null when the company is fine or empty (it's optional), else the problem in plain words. */
export function companyProblem(company) {
  return cleanText(company).length > MAX_COMPANY ? ERRORS.companyLong : null;
}

const TITLES = new Set(["mr", "mrs", "ms", "miss", "mx", "dr", "prof", "sir", "dame"]);

/**
 * The first name to greet them by: "Priya Raman" → "Priya", "Dr. Maya Singh" → "Maya", "Dr. Singh" → "Dr. Singh",
 * "J. Smith" → "J. Smith" (an initial alone isn't a name), "priya" → "Priya". "" when there's no name.
 */
export function firstNameOf(name) {
  const n = cleanName(name);
  if (!n) return "";
  let words = n.split(" ");
  if (words.length > 2 && TITLES.has(words[0].replace(/\.$/, "").toLowerCase())) words = words.slice(1);
  else if (words.length === 2 && TITLES.has(words[0].replace(/\.$/, "").toLowerCase())) return n;
  const first = words[0];
  if ((first.match(/\p{L}/gu) || []).length < 2) return n;
  return first === first.toLowerCase() ? first.charAt(0).toUpperCase() + first.slice(1) : first;
}

/**
 * Checks what the form sent. Only the email is required (the organiser, Oct 24 2026: "Please only keep email mandatory
 * in the stay updated form."), from every source; a name (2–80 characters: letters, spaces, - ' ’ .), company (≤ 120)
 * or phone (7–20 digits once + spaces dashes parens are out) that is given must be right. Empty or missing = "".
 * Errors are in plain words, for the page to show next to the field, in the form's order (name, company, email, phone).
 * @returns {{ ok: true, value: { name, company, email, phone, phoneDigits, interests, source, consent: true } }
 *   | { ok: false, field, error }}
 */
export function validateSignup(body) {
  const b = body && typeof body === "object" ? body : {};
  const fail = (field, error) => ({ ok: false, field, error });
  const name = cleanName(b.name);
  const nameIssue = nameProblem(name);
  if (nameIssue) return fail("name", nameIssue);
  const company = cleanText(b.company);
  const companyIssue = companyProblem(company);
  if (companyIssue) return fail("company", companyIssue);
  const rawEmail = cleanText(b.email);
  if (!rawEmail) return fail("email", "Enter your email address.");
  const email = rawEmail.length <= MAX_EMAIL ? cleanEmail(rawEmail) : "";
  if (!email || !/\.[^.@]{2,}$/.test(email)) return fail("email", "That email address doesn't look right. Check it and try again.");
  const phone = cleanText(b.phone);
  const digits = phone ? phoneDigits(phone) : "";
  if (phone && (digits === null || digits.length < PHONE_DIGITS.min || digits.length > PHONE_DIGITS.max)) return fail("phone", ERRORS.phoneBad);
  if (b.consent !== true && b.consent !== "true") return fail("consent", "Please agree that we can contact you about TTFC 2027.");
  return { ok: true, value: { name, company, email, phone, phoneDigits: digits, interests: cleanInterests(b.interests), source: cleanSource(b.source), consent: true } };
}

/** HMAC of the address with the tracking secret (the same address always gives the same value; it can't be read back). */
export function ipHash(ip, secret = trackSecret()) {
  const s = String(ip ?? "").trim();
  if (!s) return "";
  return crypto.createHmac("sha256", secret || "ttfc-waitlist").update(`ttfc-waitlist-ip:v1:${s}`).digest("hex").slice(0, 32);
}

/** The first 160 characters of the browser's user agent. */
export const shortUserAgent = (ua) => cleanText(ua).slice(0, 160);

/** WAITLIST_INBOX (comma-separated), else enquire@. */
export function waitlistInbox(env = process.env) {
  const list = String(env?.WAITLIST_INBOX || "").split(",").map((x) => cleanEmail(x)).filter(Boolean);
  return list.length ? list : [WAITLIST_INBOX];
}

/** May the person get "You're on the TTFC 2027 waitlist" now? First sign-up, or the last one 24 hours ago or more. */
export function confirmDue(row, now = new Date()) {
  const last = row?.confirmedAt ? new Date(row.confirmedAt).getTime() : 0;
  return !last || new Date(now).getTime() - last >= CONFIRM_EVERY_MS;
}

/** What a repeat sign-up keeps of the name / company it replaces: the one before, when it's a different one and the
    row has room (MAX_EARLIER). → { earlierNames?, earlierCompanies? } for $addToSet. */
export function earlierUpdate(before, v) {
  const out = {};
  for (const [field, list] of [["name", "earlierNames"], ["company", "earlierCompanies"]]) {
    const was = String(before?.[field] || "").trim();
    const now = String(v?.[field] || "").trim();
    if (!was || !now || was.toLowerCase() === now.toLowerCase()) continue;
    if ((before?.[list] || []).length >= MAX_EARLIER) continue;
    out[list] = was;
  }
  return out;
}

/* ---------- the team's email (a staff alert) ---------- */

const torontoTime = (d) => new Date(d || Date.now()).toLocaleString("en-CA", {
  timeZone: "America/Toronto", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});

/** "+1 (416) 555-0100" → "tel:+14165550100". */
export const telHref = (phone) => {
  const d = phoneDigits(phone);
  return d ? `tel:${String(phone).trim().startsWith("+") ? "+" : ""}${d}` : "";
};

/** "Exhibitor + Sponsorship interest", or "Attending" with nothing ticked. */
export function interestSummary(interests) {
  const list = cleanInterests(interests);
  return list.length ? `${list.map((k) => INTEREST_LABEL[k]).join(" + ")} interest` : "Attending";
}

/** "Priya Raman (Acme Inc.)", "Priya Raman", "Acme Inc." or "" (neither given). */
export function whoLine({ name, company } = {}) {
  const n = cleanName(name);
  const c = cleanText(company);
  return n && c ? `${n} (${c})` : n || c;
}

/** Earlier values that aren't the current one (a repeat sign-up that changed it), newest last. */
export const earlierOf = (list, current) => {
  const now = cleanText(current).toLowerCase();
  return [...new Set((Array.isArray(list) ? list : []).map((x) => cleanText(x)).filter((x) => x && x.toLowerCase() !== now))];
};

/**
 * "TTFC 2027 waitlist: Exhibitor + Sponsorship interest – Jane Doe (Acme Inc.) – jane@acme.com",
 * "TTFC 2027 waitlist: Attending – …" (no name or company given: just the email); a repeat sign-up ends "(updated)".
 */
export function alertSubject({ email, interests, updated = false, name = "", company = "" }) {
  const who = whoLine({ name, company });
  return `TTFC 2027 waitlist: ${interestSummary(interests)} – ${who ? `${who} – ` : ""}${email}${updated ? " (updated)" : ""}`.slice(0, 200);
}

/**
 * The email to the team for one sign-up (the saved row). `updated`: the address had signed up before.
 * Name and company first ("Not given" when left empty: only the email is required; a repeat that changed them shows
 * the earlier ones too); the phone the same. Every value is escaped; the phone is a tel: link; times are Toronto's. Reply-to is the person.
 * No "Get the TTFC app" block: it's a staff alert.
 * @returns {{ subject, html, text, replyTo }}
 */
export function buildWaitlistAlert(row, { updated = false, now = new Date(), adminUrl = "" } = {}) {
  const email = cleanEmail(row?.email) || cleanText(row?.email);
  const name = cleanName(row?.name);
  const company = cleanText(row?.company);
  const interests = cleanInterests(row?.interests);
  const last = cleanInterests(row?.lastInterests);
  const subject = alertSubject({ email, interests, updated, name, company });
  const tel = telHref(row?.phone);
  const interestText = interests.length ? interests.map((k) => INTEREST_LABEL[k]).join(", ") : "Attending (nothing ticked)";
  const sources = [...new Set([...(row?.sources || []), row?.source].filter((s) => SOURCES.includes(s)))];
  const source = SOURCE_LABEL[row?.source] || "Website";
  const earlierNames = updated ? earlierOf(row?.earlierNames, name) : [];
  const earlierCompanies = updated ? earlierOf(row?.earlierCompanies, company) : [];
  const who = whoLine({ name, company });
  const rows = [
    ["Name", name || "Not given"],
    ...(earlierNames.length ? [["Earlier name", earlierNames.join(", ")]] : []),
    ["Company or organisation", company || "Not given"],
    ...(earlierCompanies.length ? [["Earlier company", earlierCompanies.join(", ")]] : []),
    ["Email", email, `<a href="mailto:${esc(email)}" style="color:#7a3fd1;">${esc(email)}</a>`],
    ["Phone", cleanText(row?.phone) || "Not given", tel ? `<a href="${esc(tel)}" style="color:#7a3fd1;">${esc(cleanText(row?.phone))}</a>` : undefined],
    ["Interested in", interestText],
    ...(updated && last.join() !== interests.join() ? [["Ticked this time", last.length ? last.map((k) => INTEREST_LABEL[k]).join(", ") : "Nothing"]] : []),
    ["Signed up from", sources.length > 1 ? `${source} (also: ${sources.filter((s) => s !== row?.source).map((s) => SOURCE_LABEL[s]).join(", ")})` : source],
    ["Time", `${torontoTime(row?.lastSubmittedAt || now)} (Toronto)`],
    ...(updated ? [["First signed up", `${torontoTime(row?.createdAt)} (Toronto)`], ["Sign-ups from this address", String(row?.count || 2)]] : []),
    ["Agreed to be contacted", "Yes, about TTFC 2027"],
  ];
  const adminLink = /^https?:\/\//.test(adminUrl) ? adminUrl : "";

  const tr = ([label, value, htmlValue]) => `<tr>
      <td valign="top" style="padding:10px 14px;border-bottom:1px solid #ece6f7;font:600 13px/1.4 Arial,Helvetica,sans-serif;color:#5b4b7a;width:170px;">${esc(label)}</td>
      <td valign="top" style="padding:10px 14px;border-bottom:1px solid #ece6f7;font:14px/1.5 Arial,Helvetica,sans-serif;color:#1a1033;word-break:break-word;">${htmlValue ?? esc(value)}</td>
    </tr>`;

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f1fa;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f1fa;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;background:#ffffff;border-radius:14px;overflow:hidden;">
  <tr><td style="background:#0d0520;padding:20px 24px;">
    <div style="font:800 12px/1.2 Arial,Helvetica,sans-serif;letter-spacing:2px;color:#f5a623;text-transform:uppercase;">TTFC 2027 waitlist${updated ? " · updated" : " · new sign-up"}</div>
    <div style="font:700 20px/1.3 Arial,Helvetica,sans-serif;color:#ffffff;margin-top:6px;">${esc(interestSummary(interests))}</div>${who ? `
    <div style="font:15px/1.4 Arial,Helvetica,sans-serif;color:#d9ccf2;margin-top:4px;">${esc(who)}</div>` : ""}
  </td></tr>
  <tr><td style="padding:8px 10px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${rows.map(tr).join("\n      ")}
    </table>
  </td></tr>
  <tr><td style="padding:16px 24px 6px;font:13px/1.5 Arial,Helvetica,sans-serif;color:#5b4b7a;">Reply to this email to answer them directly.</td></tr>
  <tr><td style="padding:12px 24px 22px;font:12px/1.5 Arial,Helvetica,sans-serif;color:#8a7fa3;border-top:1px solid #ece6f7;">
    Saved in the TTFC admin panel under Sales &amp; emails → 2027 waitlist${adminLink ? ` (<a href="${esc(adminLink)}" style="color:#7a3fd1;">open</a>)` : ""}.
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = [
    `TTFC 2027 waitlist${updated ? " (updated)" : ""}: ${interestSummary(interests)}${who ? ` – ${who}` : ""}`,
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
    "",
    "Reply to this email to answer them directly.",
    "Saved in the TTFC admin panel under Sales & emails → 2027 waitlist.",
  ].join("\n");

  return { subject, html, text, replyTo: cleanEmail(email) };
}

/* ---------- the admin list ---------- */

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Mongo filter for the admin list: ?q= part of the email, name, company or phone, ?interest= delegate | exhibitor |
    sponsorship | delegation | attending (nothing ticked), ?source=. */
export function waitlistFilter({ q, interest, source } = {}) {
  const f = {};
  const text = cleanText(q).slice(0, 100);
  if (text) {
    const digits = text.replace(/\D/g, "");
    const re = escRe(text.toLowerCase());
    f.$or = [
      { email: { $regex: re, $options: "i" } },
      { name: { $regex: re, $options: "i" } },
      { company: { $regex: re, $options: "i" } },
      ...(digits.length >= 3 ? [{ phoneDigits: { $regex: escRe(digits) } }] : []),
    ];
  }
  const i = String(interest ?? "").trim().toLowerCase();
  if (INTERESTS.includes(i)) f.interests = i;
  else if (i === "attending") f.interests = { $size: 0 };
  const s = String(source ?? "").trim().toLowerCase();
  if (SOURCES.includes(s)) f.sources = s;
  return f;
}

/** One row for the admin list. */
export function waitlistRow(d) {
  return {
    id: String(d._id ?? ""),
    name: d.name || "",
    company: d.company || "",
    earlierNames: earlierOf(d.earlierNames, d.name),
    earlierCompanies: earlierOf(d.earlierCompanies, d.company),
    email: d.email || "",
    phone: d.phone || "",
    tel: telHref(d.phone),
    interests: cleanInterests(d.interests),
    interestLabels: cleanInterests(d.interests).map((k) => INTEREST_LABEL[k]),
    source: d.source || "website",
    sources: (d.sources || []).filter((s) => SOURCES.includes(s)),
    count: d.count || 1,
    createdAt: d.createdAt || null,
    lastSubmittedAt: d.lastSubmittedAt || d.createdAt || null,
    alertStatus: d.alertStatus || "",
    confirmStatus: d.confirmStatus || "",
    confirmedAt: d.confirmedAt || null,
  };
}

/** { total, attending, delegate, exhibitor, sponsorship, delegation, website, webapp, ios, android, programme } from
    two $group results. */
export function waitlistCounts({ total = 0, byInterest = [], attending = 0, bySource = [] } = {}) {
  const out = { total, attending, ...Object.fromEntries(INTERESTS.map((k) => [k, 0])), ...Object.fromEntries(SOURCES.map((k) => [k, 0])) };
  for (const g of byInterest) if (INTERESTS.includes(g._id)) out[g._id] = g.n;
  for (const g of bySource) if (SOURCES.includes(g._id)) out[g._id] = g.n;
  return out;
}

/** One yes / no column per interest, in INTERESTS order (Delegate, Exhibitor, Sponsorship, Delegation). */
export const CSV_HEAD = [
  "Signed up (Toronto)", "Last sign-up (Toronto)", "Name", "Company", "Email", "Phone", ...INTERESTS.map((k) => INTEREST_LABEL[k]), "Interested in",
  "Signed up from", "Sign-ups", "Team emailed", "Confirmation email",
];

const csvTime = (d) => (d ? torontoTime(d) : "");

export function waitlistCsv(rows) {
  const lines = rows.map((d) => {
    const r = waitlistRow(d);
    return [
      csvTime(r.createdAt), csvTime(r.lastSubmittedAt), r.name, r.company, r.email, r.phone,
      ...INTERESTS.map((k) => r.interests.includes(k)),
      r.interestLabels.join(", ") || "Attending",
      [...new Set([r.source, ...r.sources])].map((s) => SOURCE_LABEL[s] || s).join(", "),
      r.count, r.alertStatus || "", r.confirmStatus || "",
    ].map(csvCell).join(",");
  });
  return "﻿" + [CSV_HEAD.map(csvCell).join(","), ...lines].join("\n");
}
