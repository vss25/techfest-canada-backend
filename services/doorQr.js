/* =========================================================
   The door QR: one text for a ticket, everywhere (Oct 24 2026).
   The organiser: "I need one QR code everywhere. The one that have
   gone out in the email should be code elsewhere too."
   Pass emails (issued, speaker, exhibitor, awards), the purchase
   email's QR image (GET /api/wallet/qr), the PDF ticket, Apple
   Wallet and the apps (iOS, Android, the web app) all encode
   "TECHFEST:<ticketId>", the ticket ID as stored (12 lower-case
   hex). Before this the PDF ticket and the purchase email's image
   held the bare ID; the door scanner (routes/checkin.js) still
   accepts the bare ID, any case and stray spaces, so every QR code
   already sent or saved keeps working.
   Pure; test/door-qr.test.js
========================================================= */

export const DOOR_QR_PREFIX = "TECHFEST:";

/** "TECHFEST:A1B2C3D4E5F6 " / "a1b2 c3d4 e5f6" → "a1b2c3d4e5f6" (the stored form). */
export function cleanTicketId(raw) {
  return String(raw || "")
    .trim()
    .replace(/^TECHFEST:/i, "")
    .replace(/\s+/g, "")
    .toLowerCase()
    .slice(0, 64);
}

/** The text inside every door QR for a ticket: "TECHFEST:<ticketId>". */
export const doorQrText = (ticketId) => `${DOOR_QR_PREFIX}${cleanTicketId(ticketId)}`;
