/* =========================================================
   Exhibitor passes (Admin → Marketing → Exhibitor passes)
   ---------------------------------------------------------
   An issued pass (services/issuedPasses.js) for someone on an
   exhibitor's booth, stored under promo code EXHIBITOR: a Connect
   Pass (Oct 19 2026: the passes are strictly four, so it's named
   "Connect Pass", not "Exhibitor Pass"; being an exhibitor is their
   type, "Is Exhibitor? Yes"). The same pass email, with the
   Exhibitor Manual & return form attached as a PDF
   (services/exhibitorManual.js) filled in with their booth.
   Staff can change the email's default wording ("exhibitor-pass"
   EmailTemplate), each pass's wording, and every word of the
   manual ("exhibitor-manual" EmailTemplate content).
========================================================= */

import { EVENT } from "./ticketInfo.js";
import { cleanBooth } from "./exhibitorManual.js";

export const EXHIBITOR_PROMO = "EXHIBITOR";
export const EXHIBITOR_TEMPLATE_KEY = "exhibitor-pass";
export const MANUAL_TEMPLATE_KEY = "exhibitor-manual";
export const EXHIBITOR_TIER = "connect";
/** The pass's name: the tier's ("Connect Pass"). Nothing is stored on the pass, so a tier change renames it. */
export const EXHIBITOR_LABEL = "Connect Pass";

/** The built-in wording: the issued pass email, plus a line about the attached manual. */
export function defaultExhibitorCopy(label = EXHIBITOR_LABEL) {
  return {
    subject: `{firstName}, your ${label} for TTFC 2026`,
    headline: "We're delighted to welcome you to TTFC 2026.",
    message: `Your personal ${label} for The Tech Festival Canada is below. We look forward to seeing you in Toronto on ${EVENT.dates}: show the QR code at registration to check in.\n\nYour Exhibitor Manual is attached: move-in times, what your booth includes, how to order extras and the return form. Please send the form back by Friday 16 October so we can print your booth sign and badges.`,
  };
}

/** Defaults with staff's saved wording (EmailTemplate "exhibitor-pass") over them; empty fields keep the default. */
export function exhibitorCopyFor(template = null) {
  return (label) => {
    const d = defaultExhibitorCopy(label);
    return {
      subject: template?.subject || d.subject,
      headline: template?.headline || d.headline,
      message: template?.message || d.message,
    };
  };
}

/** The manual's per-exhibitor fields for a pass: company, booth, zone, passes, and the holder as badge 1. */
export function exhibitorBooth(a = {}) {
  const b = a.issuedPass?.booth || {};
  return cleanBooth({
    company: a.details?.organisation || "", booth: b.booth, zone: b.zone, passes: b.passes,
    holder: { name: a.name, title: a.details?.jobTitle || "", email: a.email },
  });
}
