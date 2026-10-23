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

   Here: what the form may send (validateSignup), the page's and the
   confirmation email's wording (STAY_DEFAULTS: app content keys,
   editable in Admin › Sales & emails › 2027 waitlist › Wording and
   served by GET /api/app/content), the team's email
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

/** What can be ticked (stored values, in this order). */
export const INTERESTS = Object.freeze(["sponsorship", "exhibitor", "delegation"]);
/** Staff's words (the team email's subject, the admin list, the CSV). */
export const INTEREST_LABEL = Object.freeze({ sponsorship: "Sponsorship", exhibitor: "Exhibitor", delegation: "Delegation" });
/** Where a sign-up came from. */
export const SOURCES = Object.freeze(["website", "webapp", "ios", "android"]);
export const SOURCE_LABEL = Object.freeze({ website: "Website", webapp: "Web app", ios: "iOS app", android: "Android app" });

/** The team's inbox (WAITLIST_INBOX overrides, comma-separate for several). */
export const WAITLIST_INBOX = "enquire@thetechfestival.com";
export const PAGE_URL = "https://www.thetechfestival.com/stay-updated";
/** The person's confirmation goes again only when the last one is at least this old. */
export const CONFIRM_EVERY_MS = 24 * 60 * 60 * 1000;
export const PHONE_DIGITS = Object.freeze({ min: 7, max: 20 });
export const MAX_EMAIL = 254;
export const MAX_PHONE = 40;

/* ---------- the wording (app content keys) ----------
   Plain text. Empty = the default here. Lists: one item per line; "What to expect": one item per paragraph (a blank
   line between items), its first line the title. Mirrored in the website's src/lib/stayUpdated.js for when the API
   can't be reached. The facts are the organiser's (Oct 23 2026): Toronto, dates to be announced, the 5 × 5
   framework, and only things true of TTFC 2026; the attendee count is always "1000+ attendees across 2 days". */
export const STAY_DEFAULTS = Object.freeze({
  "stay.seo_title": "Stay updated: TTFC 2027 in Toronto | The Tech Festival Canada",
  "stay.seo_description": "TTFC 2027 is coming to Toronto. Dates to be announced. Join the waitlist to hear about attending, sponsorship, exhibiting and delegations.",
  "stay.eyebrow": "Stay updated",
  "stay.hero_title": "TTFC 2027 · Toronto · Dates to be announced",
  "stay.hero_intro": "The Tech Festival Canada is coming back to Toronto. Dates are still to be announced. Join the waitlist and our team will keep you posted on TTFC 2027.",
  "stay.stat": "1000+ attendees across 2 days",
  "stay.program_title": "The 5 × 5 programme",
  "stay.program_intro": "TTFC is built around five technology pillars and the sectors adopting them. Every keynote, panel and award sits where the two meet.",
  "stay.pillars_title": "Five technology pillars",
  "stay.pillars": [
    "AI & Machine Learning",
    "Quantum Computing",
    "Cybersecurity & Digital Trust",
    "Robotics & Automation",
    "CleanTech & Sustainability",
  ].join("\n"),
  "stay.sectors_title": "Five applied sectors",
  "stay.sectors": [
    "Financial Services & Banking",
    "Healthcare & Life Sciences",
    "Energy & Critical Infrastructure",
    "Manufacturing, Supply Chain & Mobility",
    "Public Sector, National Defence & Security",
  ].join("\n"),
  "stay.expect_title": "What to expect",
  "stay.expect": [
    "Keynotes and executive panels\nLeaders from government, industry and research on the main stage, with fireside chats and panels across every sector.",
    "Catalyst Awards\nAn awards night celebrating the innovators, builders and leaders delivering real impact in frontier tech.",
    "The Expo\nCompanies from Canada and around the world showing what they build, with demos and conversations with the people behind them.",
    "CxO Breakfast\nAn invitation-only breakfast for CxOs and senior leaders: strategic conversations in a smaller setting.",
    "Gala Dinner and networking\nAn evening with speakers, exhibitors, partners and senior attendees, with networking luncheons and breaks during the days.",
    "Business meetings\nMeetings matched in advance between solution providers and the decision makers who need them.",
  ].join("\n\n"),
  "stay.form_title": "Join the TTFC 2027 waitlist",
  "stay.form_intro": "Leave your email and phone number. Tick anything else you'd like to talk to us about.",
  "stay.field_email": "Email",
  "stay.field_phone": "Phone",
  "stay.interests_label": "I'm also interested in (optional)",
  "stay.interest_sponsorship": "Sponsorship",
  "stay.interest_exhibitor": "Exhibiting",
  "stay.interest_delegation": "Bringing a delegation",
  "stay.consent": "By joining, you agree The Tech Festival Canada can contact you about TTFC 2027.",
  "stay.button": "Join the waitlist",
  "stay.thanks_title": "You're on the TTFC 2027 waitlist",
  "stay.thanks": "Thank you for your interest. Someone from our team will reach out.",
  "stay.email_subject": "You're on the TTFC 2027 waitlist",
  "stay.email_heading": "You're on the TTFC 2027 waitlist.",
  "stay.email_intro": "Thank you for your interest in TTFC 2027 in Toronto. Dates are to be announced.",
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

/**
 * Checks what the form sent. Errors are in plain words, for the page to show next to the field.
 * @returns {{ ok: true, value: { email, phone, phoneDigits, interests, source, consent: true } } | { ok: false, field, error }}
 */
export function validateSignup(body) {
  const b = body && typeof body === "object" ? body : {};
  const fail = (field, error) => ({ ok: false, field, error });
  const rawEmail = cleanText(b.email);
  if (!rawEmail) return fail("email", "Enter your email address.");
  const email = rawEmail.length <= MAX_EMAIL ? cleanEmail(rawEmail) : "";
  if (!email || !/\.[^.@]{2,}$/.test(email)) return fail("email", "That email address doesn't look right. Check it and try again.");
  const phone = cleanText(b.phone);
  if (!phone) return fail("phone", "Enter your phone number.");
  const digits = phoneDigits(phone);
  if (digits === null || digits.length < PHONE_DIGITS.min || digits.length > PHONE_DIGITS.max) {
    return fail("phone", "That phone number doesn't look right. Use digits, with + ( ) - or spaces if you like.");
  }
  if (b.consent !== true && b.consent !== "true") return fail("consent", "Please agree that we can contact you about TTFC 2027.");
  return { ok: true, value: { email, phone, phoneDigits: digits, interests: cleanInterests(b.interests), source: cleanSource(b.source), consent: true } };
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

/* ---------- the team's email (a staff alert) ---------- */

const torontoTime = (d) => new Date(d || Date.now()).toLocaleString("en-CA", {
  timeZone: "America/Toronto", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});

/** "+1 (416) 555-0100" → "tel:+14165550100". */
export const telHref = (phone) => {
  const d = phoneDigits(phone);
  return d ? `tel:${String(phone).trim().startsWith("+") ? "+" : ""}${d}` : "";
};

/** "Sponsorship + Exhibitor interest", or "Attending" with nothing ticked. */
export function interestSummary(interests) {
  const list = cleanInterests(interests);
  return list.length ? `${list.map((k) => INTEREST_LABEL[k]).join(" + ")} interest` : "Attending";
}

/**
 * "TTFC 2027 waitlist: Sponsorship + Exhibitor interest – jane@acme.com", "TTFC 2027 waitlist: Attending – …";
 * a repeat sign-up ends "(updated)".
 */
export function alertSubject({ email, interests, updated = false }) {
  return `TTFC 2027 waitlist: ${interestSummary(interests)} – ${email}${updated ? " (updated)" : ""}`.slice(0, 200);
}

/**
 * The email to the team for one sign-up (the saved row). `updated`: the address had signed up before.
 * Every value is escaped; the phone is a tel: link; times are Toronto's. Reply-to is the person.
 * No "Get the TTFC app" block: it's a staff alert.
 * @returns {{ subject, html, text, replyTo }}
 */
export function buildWaitlistAlert(row, { updated = false, now = new Date(), adminUrl = "" } = {}) {
  const email = cleanEmail(row?.email) || cleanText(row?.email);
  const interests = cleanInterests(row?.interests);
  const last = cleanInterests(row?.lastInterests);
  const subject = alertSubject({ email, interests, updated });
  const tel = telHref(row?.phone);
  const interestText = interests.length ? interests.map((k) => INTEREST_LABEL[k]).join(", ") : "Attending (nothing ticked)";
  const sources = [...new Set([...(row?.sources || []), row?.source].filter((s) => SOURCES.includes(s)))];
  const source = SOURCE_LABEL[row?.source] || "Website";
  const rows = [
    ["Email", email, `<a href="mailto:${esc(email)}" style="color:#7a3fd1;">${esc(email)}</a>`],
    ["Phone", cleanText(row?.phone), tel ? `<a href="${esc(tel)}" style="color:#7a3fd1;">${esc(cleanText(row?.phone))}</a>` : esc(cleanText(row?.phone))],
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
    <div style="font:700 20px/1.3 Arial,Helvetica,sans-serif;color:#ffffff;margin-top:6px;">${esc(interestSummary(interests))}</div>
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
    `TTFC 2027 waitlist${updated ? " (updated)" : ""}: ${interestSummary(interests)}`,
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

/** Mongo filter for the admin list: ?q= part of the email or phone, ?interest= sponsorship | exhibitor | delegation |
    attending (nothing ticked), ?source=. */
export function waitlistFilter({ q, interest, source } = {}) {
  const f = {};
  const text = cleanText(q).slice(0, 100);
  if (text) {
    const digits = text.replace(/\D/g, "");
    f.$or = [{ email: { $regex: escRe(text.toLowerCase()), $options: "i" } }, ...(digits.length >= 3 ? [{ phoneDigits: { $regex: escRe(digits) } }] : [])];
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

/** { total, attending, sponsorship, exhibitor, delegation, website, webapp, ios, android } from two $group results. */
export function waitlistCounts({ total = 0, byInterest = [], attending = 0, bySource = [] } = {}) {
  const out = { total, attending, ...Object.fromEntries(INTERESTS.map((k) => [k, 0])), ...Object.fromEntries(SOURCES.map((k) => [k, 0])) };
  for (const g of byInterest) if (INTERESTS.includes(g._id)) out[g._id] = g.n;
  for (const g of bySource) if (SOURCES.includes(g._id)) out[g._id] = g.n;
  return out;
}

export const CSV_HEAD = [
  "Signed up (Toronto)", "Last sign-up (Toronto)", "Email", "Phone", "Sponsorship", "Exhibitor", "Delegation", "Interested in",
  "Signed up from", "Sign-ups", "Team emailed", "Confirmation email",
];

const csvTime = (d) => (d ? torontoTime(d) : "");

export function waitlistCsv(rows) {
  const lines = rows.map((d) => {
    const r = waitlistRow(d);
    return [
      csvTime(r.createdAt), csvTime(r.lastSubmittedAt), r.email, r.phone,
      r.interests.includes("sponsorship"), r.interests.includes("exhibitor"), r.interests.includes("delegation"),
      r.interestLabels.join(", ") || "Attending",
      [...new Set([r.source, ...r.sources])].map((s) => SOURCE_LABEL[s] || s).join(", "),
      r.count, r.alertStatus || "", r.confirmStatus || "",
    ].map(csvCell).join(",");
  });
  return "﻿" + [CSV_HEAD.map(csvCell).join(","), ...lines].join("\n");
}
