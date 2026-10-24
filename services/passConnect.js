import { holderIsAccount } from "./checkinCard.js";
import { cleanTicketId } from "./doorQr.js";

/* =========================================================
   Connect by pass (C-PASS, Oct 24 2026), the pure parts
   ---------------------------------------------------------
   The organiser: "one QR for everything", and "for staff it
   should default to checkin and for other attendees it should be
   share contact". Scanning someone's ENTRY QR (the door QR,
   "TECHFEST:<ticketId>", services/doorQr.js) in the apps' or the
   web app's Network › Scan connects you with the pass holder in
   person, exactly like their Connect QR: POST
   /api/social/connections/by-pass { ticketId, share? }
   (routes/social.js; the holder: services/passHolder.js).
   Here: the answers, the forms a scanned code can take, which
   account holds a ticket, and which passes don't count. No cap on
   scans (the organiser, Oct 24 2026: "Don't keep a cap on scan");
   instead the apps tell people that what they allow to share also
   goes to anyone who scans the QR code on their pass.
========================================================= */

/** The answers the apps show (`code` is what they switch on). */
export const PASS_CONNECT_ERRORS = Object.freeze({
  not_found: Object.freeze({ status: 404, code: "not_found", error: "That isn't a TTFC pass we know." }),
  not_on_app: Object.freeze({ status: 409, code: "not_on_app", error: "They haven't joined the TTFC app yet. You can connect once they sign in." }),
  self: Object.freeze({ status: 400, code: "self", error: "That's your own pass." }),
});

/** The push the person scanned gets (routes/social.js sends it with kind "conn", their Network tab). */
export const passConnectPush = (scannerName) => ({
  title: `${String(scannerName || "").trim() || "Someone"} connected with you`,
  body: "Scanned your TTFC pass",
});

/** The in-app notification row (models/AppNotification.js kind "conn") for the person scanned: the push's words. */
export const passConnectNotification = ({ toUserId, scanner, connectionId }) => ({
  userId: toUserId,
  ...passConnectPush(scanner?.name),
  link: "ttfc://tab/network",
  kind: "conn",
  batchId: `conn:${connectionId}`,
  sentBy: scanner?._id,
  sentByName: String(scanner?.name || "").trim(),
});

/** `raw` (any QR form) → { typed: the stored form ("" when it can't be a ticket), variants: the forms to look up }. */
export function passVariants(raw) {
  const text = String(raw ?? "").trim().replace(/^TECHFEST:/i, "").trim();
  const typed = cleanTicketId(text);
  // Ticket IDs are letters, digits and dashes (12 hex since 2026); anything else (a connect QR, a URL) is no pass.
  if (typed.length < 6 || !/^[a-z0-9-]+$/.test(typed)) return { typed: "", variants: [] };
  return { typed, variants: [...new Set([typed, typed.toUpperCase(), text])].filter(Boolean) };
}

/**
 * Which of the accounts holding this ticket (User.tickets) is the pass holder: claimed by them, or the name on the
 * ticket (the checkout form's, else the pass record's) agrees with theirs (holderIsAccount). → { account, ticket }
 * (account null: the ticket names someone else on every account; ticket: that account's entry, else the first).
 */
export function pickHolder({ holders = [], typed = "", attendee = null } = {}) {
  let first = null;
  for (const h of holders || []) {
    const ticket = (h?.tickets || []).find((t) => cleanTicketId(t?.ticketId) === typed) || null;
    if (!ticket) continue;
    first ||= ticket;
    if (holderIsAccount({ account: h, ticket, attendee })) return { account: h, ticket };
  }
  return { account: null, ticket: first };
}

/** A Checkout Session Stripe shows fully refunded, from cached session rows ({ id, total, refunded }). */
export function sessionRefunded(sessionId, rows) {
  if (!sessionId || !Array.isArray(rows)) return false;
  const r = rows.find((x) => x?.id === sessionId);
  return !!r && r.total > 0 && r.refunded >= r.total;
}

/** A pass that doesn't count for connecting (answered like an unknown one): hidden by staff (on the account's ticket
    or its pass record), a Stripe-sync duplicate, or its payment fully refunded. */
export function passIsOut({ ticket = null, attendee = null, stripeRows = null } = {}) {
  if (ticket?.hiddenByStaff || attendee?.hiddenByStaff || attendee?.syncDuplicate) return true;
  return sessionRefunded(ticket?.stripeSessionId, stripeRows) || sessionRefunded(attendee?.stripeSessionId, stripeRows);
}
