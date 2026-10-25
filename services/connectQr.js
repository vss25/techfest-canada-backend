/* =========================================================
   The apps' networking QR at the door (Oct 24 2026)
   ---------------------------------------------------------
   Staff scanned attendees' "My QR" (the Connect code the apps and the
   web app show in Network) at the check-in page and got "No TTFC
   ticket has this ID". The Connect code, byte-identical in iOS
   (QRPayload.swift), Android (QRPayload.kt) and the web app
   (src/app/lib/qr.js):
     TTFC2026|C|<name>|<title>|<org>|<linkedIn>|<email>|<userId>|<check>
   fields percent-escaped; codes made before Oct 2026 have 8 parts (no
   userId); <check> = FNV-1a (32-bit) over the other fields joined by
   "|" plus a fixed salt, low 24 bits as 6 hex: a hand-edited code is
   refused. The door (routes/checkin.js) and the desk's look-up
   (routes/checkinDesk.js POST /lookup) turn it into the account's pass
   (routes/people.js checkinPassOf); "TECHFEST:<ticketId>" codes never
   come here.
   Pure; test/connect-qr.test.js
========================================================= */

export const CONNECT_QR_TAG = "TTFC2026";
const SALT = "ttfc-2026-westin";
const OBJECT_ID = /^[a-f0-9]{24}$/i;

/** Is this text one of the apps' own codes ("TTFC2026|…": a Connect code, or the old demo ticket)? */
export const isAppQr = (raw) => String(raw ?? "").trim().startsWith(`${CONNECT_QR_TAG}|`);

/** The apps' check digit: FNV-1a (32-bit) over the fields joined by "|" + the salt, low 24 bits, 6 lower-case hex. */
export function connectCheck(fields) {
  let h = 2166136261 >>> 0;
  for (const b of new TextEncoder().encode(fields.join("|") + SALT)) {
    h ^= b;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h & 0xffffff).toString(16).padStart(6, "0");
}

/** Percent-decoding as the apps do it (iOS `removingPercentEncoding ?? s`): the text unchanged when it isn't valid. */
const unesc = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

/**
 * An app QR → what the door needs from it.
 *   null                                   not an app code (a door QR, a bare ticket ID, anything else)
 *   { ok: false }                          an app code that isn't a well-formed Connect code, or whose check digit
 *                                          doesn't match (hand-edited, mis-read)
 *   { ok: true, userId, email, legacy }    a Connect code: userId (24 hex, "" when it has none or it isn't one),
 *                                          email (lower case, "" when none), legacy = the 8-part form (no userId)
 */
export function parseConnectQr(raw) {
  const text = String(raw ?? "").trim();
  if (!isAppQr(text)) return null;
  const parts = text.split("|");
  if (parts.length < 3 || parts[0] !== CONNECT_QR_TAG) return { ok: false };
  if (parts[parts.length - 1] !== connectCheck(parts.slice(0, -1))) return { ok: false };
  if (parts[1] !== "C" || (parts.length !== 8 && parts.length !== 9)) return { ok: false };
  const id = parts.length === 9 ? unesc(parts[7]).trim() : "";
  return {
    ok: true,
    userId: OBJECT_ID.test(id) ? id.toLowerCase() : "",
    email: unesc(parts[6]).trim().toLowerCase(),
    legacy: parts.length === 8,
  };
}

/** The answers for a Connect code that can't be checked in (`code` is what a scanner switches on). Never an email. */
export const CONNECT_SCAN_ERRORS = Object.freeze({
  // A Connect code from before userIds with no email in it: nothing to find them by.
  networking_qr: Object.freeze({
    status: 404, code: "networking_qr",
    message: "That's their networking QR. Ask for the entry pass QR (app › Pass, or the email/PDF).",
  }),
  // A Connect code whose check digit doesn't match, or another app code (the old demo ticket).
  bad_qr: Object.freeze({
    status: 404, code: "bad_qr",
    message: "That QR code isn't valid. Ask for the entry pass QR (app › Pass, or the email/PDF).",
  }),
  // Their networking QR, but no account, or no pass that counts (none, hidden by staff, refunded).
  no_pass: Object.freeze({
    status: 404, code: "no_pass",
    message: "That's their networking QR, and there's no TTFC pass on their account. Send them to the registration desk.",
  }),
});

/** The body of a refused Connect scan, shaped like the door's other refusals ("invalid": no card). */
export const connectRefusal = (key) => {
  const e = CONNECT_SCAN_ERRORS[key] || CONNECT_SCAN_ERRORS.bad_qr;
  return { status: "invalid", code: e.code, message: e.message, error: e.message };
};

/** What the door says when it checked in one of several passes: which one, and why. "" for one pass. */
export function connectPassNote({ count = 1, passName = "" } = {}) {
  if (!(count > 1)) return "";
  const name = String(passName || "").trim() || "main pass";
  return `Networking QR: they hold ${count} passes, so their ${name} (the one their People profile shows first) was used.`;
}
