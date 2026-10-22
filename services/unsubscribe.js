import crypto from "crypto";
import { apiBaseUrl } from "./walletLink.js";
import { trackSecret } from "./trackToken.js";

/* =========================================================
   Unsubscribing from TTFC's bulk emails (Oct 22 2026)
   ---------------------------------------------------------
   The organiser: "make sure people who have unsubscribed don't get
   the emails". Until now the campaign emails said "Reply with
   'unsubscribe'" and their List-Unsubscribe header was a mailto to
   enquire@ / marcom@, so every request was an email someone had to
   read, and nothing recorded it. Now:

   One list for every bulk email: Subscription rows with
   `subscribed: false` (the newsletter model the senders already
   read). recordUnsubscribe() upserts the row, so anyone can be on
   it, not only newsletter sign-ups. Every bulk sender leaves those
   addresses out when it plans (app invite, "I'm attending" campaign
   and nudges, RSVP reminders, People sends) and checks again just
   before each email (services/rsvpReminder.js campaignSendStore,
   routes/attendingCampaign.js, services/digest.js), so an
   unsubscribe that lands while a send is running still counts. Passes, tickets, sign-in codes
   and receipts are not bulk email and still go.

   Each real send carries a personal link and the mail apps'
   one-click headers (RFC 8058):
     List-Unsubscribe: <https://<api>/api/unsubscribe?t=<token>>, <mailto:<reply-to>?subject=unsubscribe>
     List-Unsubscribe-Post: List-Unsubscribe=One-Click
   token = base64url(email) + "." + the first 16 bytes of
   HMAC-SHA256("ttfc-unsub:v1:" + body), base64url, with
   TRACKING_SECRET, else JWT_SECRET (no secret → mailto only, like
   before). The purpose prefix keeps it from matching a tracking or
   wallet signature made with the same key. Tokens don't expire: an
   old email's link must keep working. Previews and [Test] sends get
   PREVIEW_URL (a page that changes nothing). Routes: routes/unsubscribe.js
   (public) and routes/unsubscribes.js (Admin › Unsubscribed emails).
========================================================= */

const PURPOSE = "ttfc-unsub:v1";
const SIG_BYTES = 16; // 22 base64url characters
const EMAIL = /^[^\s@<>"',;:()[\]]+@[^\s@<>"',;:()[\]]+\.[^\s@<>"',;:()[\]]+$/;
const SHAPE = /^([A-Za-z0-9_-]{6,360})\.([A-Za-z0-9_-]{22})$/;

/** How someone ended up on the list (Subscription.unsubscribeSource). */
export const SOURCES = Object.freeze({
  link: "Clicked Unsubscribe in an email",
  "one-click": "Used their mail app's Unsubscribe button",
  staff: "Added by staff",
  website: "Unsubscribed on the website",
  "campaign-link": "Unsubscribe link in an older campaign",
});

/** A tidy lower-case address, or "" when it isn't one. */
export function cleanEmail(e) {
  const s = String(e ?? "").trim().toLowerCase().replace(/^mailto:/, "");
  return s && s.length <= 254 && EMAIL.test(s) ? s : "";
}

const mac = (body, secret) => crypto.createHmac("sha256", secret).update(`${PURPOSE}:${body}`).digest().subarray(0, SIG_BYTES).toString("base64url");

/** "<base64url email>.<sig>", or "" (no secret, or not an address). */
export function signUnsubscribe(email, secret = trackSecret()) {
  const e = cleanEmail(email);
  if (!secret || !e) return "";
  const body = Buffer.from(e).toString("base64url");
  return `${body}.${mac(body, secret)}`;
}

/** The address a token is for, or "" (not ours, or not a token). Never throws. */
export function verifyUnsubscribe(token, secret = trackSecret()) {
  const m = SHAPE.exec(String(token ?? "").trim());
  if (!secret || !m) return "";
  const want = Buffer.from(mac(m[1], secret));
  const got = Buffer.from(m[2]);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return "";
  try { return cleanEmail(Buffer.from(m[1], "base64url").toString("utf8")); } catch { return ""; }
}

/** The page previews and test sends link to: it says so and changes nothing. */
export const previewUnsubscribeUrl = (base = apiBaseUrl()) => `${base}/api/unsubscribe/preview`;

/** This address's personal link ("" without a secret or an address). */
export function unsubscribeUrl(email, { base = apiBaseUrl(), secret = trackSecret() } = {}) {
  const t = signUnsubscribe(email, secret);
  return t ? `${base}/api/unsubscribe?t=${t}` : "";
}

/**
 * The headers a send carries. With a personal link: the https link first (mail apps use it for their own Unsubscribe
 * button, POSTing "List-Unsubscribe=One-Click"), the mailto second for apps that only do mailto. Without one (no
 * secret, a preview or a test send): the mailto alone, as before.
 */
export function unsubscribeHeaders(link = "", { mailto = "" } = {}) {
  const parts = [];
  if (/^https:\/\//.test(link)) parts.push(`<${link}>`);
  if (mailto) parts.push(`<mailto:${mailto}?subject=unsubscribe>`);
  if (!parts.length) return {};
  return {
    "List-Unsubscribe": parts.join(", "),
    ...(/^https:\/\//.test(link) ? { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : {}),
  };
}

/**
 * The link and headers for one email. `real`: a real send to `to` (else the preview page and the mailto only).
 * @returns {{ url: string, headers: object }}
 */
export function unsubscribeFor(to, { real = false, mailto = "", base = apiBaseUrl(), secret = trackSecret() } = {}) {
  const url = real ? unsubscribeUrl(to, { base, secret }) : "";
  return { url: url || previewUnsubscribeUrl(base), headers: unsubscribeHeaders(url, { mailto }) };
}

/** "j•••@example.com": enough for someone to recognise their own address on the page. */
export function maskEmail(email) {
  const e = cleanEmail(email);
  if (!e) return "";
  const [user, domain] = e.split("@");
  return `${user.slice(0, 1)}${"•".repeat(Math.min(Math.max(user.length - 1, 1), 6))}@${domain}`;
}

/**
 * Addresses pasted by staff (one per line, commas, "Name <a@b.c>", a whole forwarded email…). Pure.
 * @returns {{ emails: string[], invalid: string[] }} unique valid addresses in the order given; pieces with an @ that
 *   aren't addresses (at most 50)
 */
export function parseEmailList(input) {
  const text = Array.isArray(input) ? input.join("\n") : String(input ?? "");
  const emails = [];
  const invalid = [];
  const seen = new Set();
  for (const raw of text.slice(0, 200_000).split(/[\s,;<>()[\]"']+/)) {
    const piece = raw.replace(/^mailto:/i, "").replace(/[.:]+$/, "");
    if (!piece.includes("@")) continue;
    const e = cleanEmail(piece);
    if (!e) { if (invalid.length < 50) invalid.push(piece.slice(0, 100)); continue; }
    if (!seen.has(e)) { seen.add(e); emails.push(e); }
  }
  return { emails, invalid };
}

/* ---------------- the list (Subscription rows) ---------------- */

/**
 * Puts one address on the list (creates the row when there's none). Idempotent: an address already on it keeps its
 * first date and source. → { email, added } (added: false when it was already there), or null for a bad address.
 */
export async function recordUnsubscribe(Subscription, email, { source = "link", by = "", now = new Date() } = {}) {
  const e = cleanEmail(email);
  if (!e) return null;
  const src = Object.hasOwn(SOURCES, source) ? source : "link";
  const who = String(by || "").slice(0, 200);
  // One atomic upsert keyed on the address (an update pipeline): someone already off keeps their first date, source
  // and who added them; anyone else (or a new address) gets these. The row before tells us which it was.
  const already = { $eq: ["$subscribed", false] };
  const keep = (field, value) => ({ $cond: [already, { $ifNull: [`$${field}`, value] }, value] });
  const run = () => Subscription.findOneAndUpdate(
    { email: e },
    [{ $set: {
      email: e,
      subscribed: false,
      unsubscribedAt: keep("unsubscribedAt", now),
      unsubscribeSource: keep("unsubscribeSource", src),
      unsubscribedBy: keep("unsubscribedBy", who),
      source: { $ifNull: ["$source", "unsubscribe"] },
      createdAt: { $ifNull: ["$createdAt", now] },
      updatedAt: now,
    } }],
    { upsert: true, new: false, lean: true, timestamps: false, updatePipeline: true },
  );
  let before;
  try {
    before = await run();
  } catch (err) {
    if (err?.code !== 11000) throw err;
    before = await run(); // two upserts for a new address at once: the second finds the first's row
  }
  return { email: e, added: !before || before.subscribed !== false };
}

/** Takes an address off the list (staff, at the person's request). → true when it was on it. */
export async function resubscribe(Subscription, email, { by = "" } = {}) {
  const e = cleanEmail(email);
  if (!e) return false;
  const r = await Subscription.updateOne({ email: e, subscribed: false }, { $set: { subscribed: true, resubscribedAt: new Date(), resubscribedBy: String(by || "").slice(0, 200) } });
  return r.modifiedCount > 0;
}

/** Is this address on the list? (false for a bad address). */
export async function isUnsubscribed(Subscription, email) {
  const e = cleanEmail(email);
  return !!e && !!(await Subscription.exists({ email: e, subscribed: false }));
}
