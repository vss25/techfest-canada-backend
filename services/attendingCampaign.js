/* =========================================================
   "I'm attending" campaign (TTFC 2026): pure parts, unit-tested
   (test/attending-campaign.test.js)
   ---------------------------------------------------------
   One email to every ticket holder, "Show the world you're
   attending". Its button opens the website's ghost page
     https://www.thetechfestival.com/attending#fn=…&ln=…&title=…&co=…
   where they make a branded "I'm attending" image in the browser
   and post it to LinkedIn. The fragment never reaches a server.

   Recipients (planRecipients): one per unique email across
   account tickets (User.tickets) and guest tickets (Attendee),
   Speaker Passes included once staff have added the speaker's
   email. Left out: tickets staff hid (test / duplicate), booths,
   placeholder addresses (<id>@ticket.thetechfestival.com, made
   by ticket sign-in for guests without an email), passes with no
   email, banned accounts and anyone who unsubscribed
   (Subscription.subscribed = false).

   Why not the Campaign system (routes/campaigns.js)? It sends a
   saved Audience (a static, imported contact list) once, with
   raw {{token}} replacement: the personal link needs each value
   URL-encoded (and its "/title" shortcut would rewrite
   "&title=" inside the link), the list would go stale as tickets
   sell, and a launch that stops half way can't be resumed
   without emailing everyone again. Here recipients are read live
   from tickets and every send is recorded per email
   (models/CampaignSend.js), so re-running never double-sends.

   The LinkedIn photo (option a on the page): the website already
   has a LinkedIn app with "Sign In with LinkedIn using OpenID
   Connect" (LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET /
   LINKEDIN_REDIRECT_URI, used by routes/auth.js). The attending
   flow reuses its registered redirect URI and tells its own
   callbacks apart by the state prefix below.
========================================================= */

import crypto from "crypto";
import { EVENT, firstNameFor, isBoothId } from "./ticketInfo.js";

export const CAMPAIGN_KEY = "attending-2026";
export const ATTENDING_URL = `${EVENT.website}/attending`;
export const PLACEHOLDER_DOMAIN = "ticket.thetechfestival.com";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const clean = (v, max = 120) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** The address made up for guests who sign in without one (routes/ticketAuth.js). */
export function isPlaceholderEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  return e.endsWith(`@${PLACEHOLDER_DOMAIN}`) || e.endsWith(`.${PLACEHOLDER_DOMAIN}`);
}

/** Lower-cased email we can write to, or "" (missing, malformed or a placeholder). */
export function usableEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || e.length > 254 || !EMAIL.test(e) || isPlaceholderEmail(e)) return "";
  return e;
}

const isGuestName = (n) => !n || /^guest$/i.test(n);

/** "Jane Q. Doe" → { firstName: "Jane Q.", lastName: "Doe" }; "Guest" → empty. */
export function splitName(name) {
  const n = clean(name);
  if (isGuestName(n)) return { firstName: "", lastName: "" };
  const words = n.split(" ");
  if (words.length === 1) return { firstName: words[0], lastName: "" };
  return { firstName: words.slice(0, -1).join(" "), lastName: words[words.length - 1] };
}

/** Name, title and company for one ticket: checkout details first, then the account profile, then the name. */
export function personFrom({ name = "", details = null, profile = null } = {}) {
  const fromName = splitName(name);
  const firstName = clean(details?.firstName, 60) || fromName.firstName;
  const lastName = clean(details?.lastName, 60) || fromName.lastName;
  return {
    firstName,
    lastName,
    title: clean(details?.jobTitle, 100) || clean(profile?.jobTitle, 100),
    company: clean(details?.organisation, 100) || clean(profile?.organization, 100),
  };
}

/** The first name for "Hi …" and the subject ("" when we don't know it). */
export function greetingName(r) {
  return firstNameFor({ firstName: clean(r?.firstName).split(" ")[0], name: [r?.firstName, r?.lastName].filter(Boolean).join(" ") });
}

/**
 * Everyone to email, one per address.
 * @param {object} p
 * @param {Array} p.users   User docs with tickets (name, email, jobTitle, organization, banned, tickets[])
 * @param {Array} p.guests  Attendee docs (name, email, ticketId, ticketType, details, hiddenByStaff, purchaseDate)
 * @param {Iterable<string>} [p.optedOut]  emails that unsubscribed
 * @returns {{ recipients: Array, skipped: Record<string, number> }}
 */
export function planRecipients({ users = [], guests = [], optedOut = [] } = {}) {
  const out = new Set([...optedOut].map((e) => String(e || "").trim().toLowerCase()));
  const skipped = { hidden: 0, booth: 0, noEmail: 0, placeholder: 0, invalidEmail: 0, banned: 0, unsubscribed: 0, duplicate: 0 };
  const candidates = [];
  const onAccounts = new Set();

  for (const u of users) {
    for (const t of u?.tickets || []) {
      if (t?.ticketId) onAccounts.add(t.ticketId);
    }
  }
  const consider = ({ email, name, details, profile, tier, ticketId, purchaseDate, hidden, banned, source }) => {
    if (isBoothId(ticketId) || /^booth/i.test(String(tier || ""))) { skipped.booth++; return; }
    if (hidden) { skipped.hidden++; return; }
    const raw = String(email || "").trim().toLowerCase();
    if (!raw) { skipped.noEmail++; return; }
    if (isPlaceholderEmail(raw)) { skipped.placeholder++; return; }
    const e = usableEmail(raw);
    if (!e) { skipped.invalidEmail++; return; }
    if (banned) { skipped.banned++; return; }
    if (out.has(e)) { skipped.unsubscribed++; return; }
    candidates.push({ email: e, name, details, profile, tier: String(tier || "").toLowerCase(), purchaseDate, source });
  };

  for (const u of users) {
    for (const t of u?.tickets || []) {
      if (!t?.ticketId) continue;
      consider({
        email: u.email, name: u.name, details: t.details, profile: u, tier: t.type, ticketId: t.ticketId,
        purchaseDate: t.purchaseDate, hidden: !!t.hiddenByStaff, banned: !!u.banned, source: "account",
      });
    }
  }
  for (const g of guests) {
    if (!g?.ticketId || onAccounts.has(g.ticketId)) continue;
    consider({
      email: g.email, name: g.name, details: g.details, profile: null, tier: g.ticketType, ticketId: g.ticketId,
      purchaseDate: g.purchaseDate, hidden: !!g.hiddenByStaff, banned: false,
      source: String(g.ticketType || "").toLowerCase() === "speaker" ? "speaker" : "guest",
    });
  }

  // One per email: the newest ticket's details, gaps filled from their other tickets.
  candidates.sort((a, b) => new Date(b.purchaseDate || 0) - new Date(a.purchaseDate || 0));
  const byEmail = new Map();
  for (const c of candidates) {
    const p = personFrom(c);
    const have = byEmail.get(c.email);
    if (!have) {
      byEmail.set(c.email, { email: c.email, ...p, tiers: [c.tier].filter(Boolean), sources: [c.source] });
      continue;
    }
    skipped.duplicate++;
    for (const k of ["title", "company"]) if (!have[k] && p[k]) have[k] = p[k];
    if (!have.firstName && !have.lastName && (p.firstName || p.lastName)) { have.firstName = p.firstName; have.lastName = p.lastName; }
    if (c.tier && !have.tiers.includes(c.tier)) have.tiers.push(c.tier);
    if (!have.sources.includes(c.source)) have.sources.push(c.source);
  }
  const recipients = [...byEmail.values()].map((r) => ({ ...r, name: [r.firstName, r.lastName].filter(Boolean).join(" ") }))
    .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email, "en", { sensitivity: "base" }));
  return { recipients, skipped };
}

/** The personal page link: values in the fragment (#fn=…&ln=…&title=…&co=…), empty ones left out. */
export function attendingLink({ firstName = "", lastName = "", title = "", company = "" } = {}, base = ATTENDING_URL) {
  const q = new URLSearchParams();
  for (const [k, v] of [["fn", firstName], ["ln", lastName], ["title", title], ["co", company]]) {
    const c = clean(v, 100);
    if (c) q.set(k, c);
  }
  const frag = q.toString().replace(/\+/g, "%20"); // %20 reads the same everywhere ("+" can survive as a plus)
  return frag ? `${base}#${frag}` : base;
}

/** A made-up attendee for previews and test sends (never a real person). */
export const SAMPLE_RECIPIENT = Object.freeze({
  email: "", firstName: "Jane", lastName: "Doe", title: "Chief AI Officer", company: "Example Corp", name: "Jane Doe",
});

/* ---------- send records (models/CampaignSend.js) ---------- */

/** Recipient rows with their send status: "sent", "failed", "sending" (unconfirmed) or "pending". */
export function withSendStatus(recipients = [], sends = []) {
  const byEmail = new Map(sends.map((s) => [String(s.email || "").toLowerCase(), s]));
  return recipients.map((r) => {
    const s = byEmail.get(r.email);
    return {
      ...r,
      status: s?.status || "pending",
      sentAt: s?.sentAt || null,
      error: s?.status === "failed" ? String(s.error || "") : "",
      attempts: Number(s?.attempts) || 0,
    };
  });
}

export function sendCounts(rows = []) {
  const c = { recipients: rows.length, sent: 0, failed: 0, sending: 0, pending: 0 };
  for (const r of rows) c[r.status in c ? r.status : "pending"]++;
  return c;
}

/* ---------- LinkedIn sign-in for the photo ---------- */

export const LI_STATE_PREFIX = "ttfc-att.";
export const LI_COOKIE = "ttfc_att_li";
export const LI_SCOPE = "openid profile";

export const linkedinConfigured = (env = process.env) =>
  !!(env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET && env.LINKEDIN_REDIRECT_URI);

export const newLinkedinState = () => `${LI_STATE_PREFIX}${crypto.randomBytes(16).toString("hex")}`;
export const isAttendingState = (s) => typeof s === "string" && s.startsWith(LI_STATE_PREFIX) && s.length <= 80;

export function linkedinAuthUrl({ clientId, redirectUri, state }) {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: LI_SCOPE, state });
  return `https://www.linkedin.com/oauth/v2/authorization?${q.toString()}`;
}

/** One cookie's value from a Cookie header ("" if absent). */
export function readCookie(header, name) {
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ""; }
    }
  }
  return "";
}

/** The state LinkedIn sent back is the one we set in this browser's cookie (stops forged callbacks). */
export function statesMatch(state, cookie) {
  if (!isAttendingState(state) || !cookie) return false;
  const a = Buffer.from(String(state)), b = Buffer.from(String(cookie));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** LinkedIn profile pictures only (media.licdn.com and its media-expN mirrors), https, no tricks. */
export function licdnPhotoUrl(raw) {
  if (typeof raw !== "string" || raw.length > 2048) return "";
  let u;
  try { u = new URL(raw); } catch { return ""; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return "";
  if (!/^media(-exp\d+)?\.licdn\.com$/i.test(u.hostname)) return "";
  return u.toString();
}

/** Where the attending page picks up after LinkedIn: #li=1&fn=&ln=&pic= or #li_error=<code>. */
export function attendingReturnUrl(base, { firstName = "", lastName = "", picture = "", error = "" } = {}) {
  const q = new URLSearchParams();
  if (error) q.set("li_error", error);
  else {
    q.set("li", "1");
    if (clean(firstName, 60)) q.set("fn", clean(firstName, 60));
    if (clean(lastName, 60)) q.set("ln", clean(lastName, 60));
    const pic = licdnPhotoUrl(picture);
    if (pic) q.set("pic", pic);
  }
  return `${String(base).replace(/\/+$/, "")}/attending#${q.toString().replace(/\+/g, "%20")}`;
}

export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const PHOTO_TYPES = /^image\/(jpeg|png|webp|gif)$/i;
