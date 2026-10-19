/* =========================================================
   The pass emails' saved wording (EmailTemplate rows)
   ---------------------------------------------------------
   One row per email (services/passEmailCopy.js TEMPLATE_KEYS):
   subject, headline and message in their own columns, every other
   field in `fields` (per pass type in fields.tiers). Read by the
   admin routes and by sendTicketEmail (services/emailService.js).
========================================================= */

import EmailTemplate from "../models/EmailTemplate.js";
import { TEMPLATE_KEYS, changedFields, templateCopy, templateSet } from "./passEmailCopy.js";

/**
 * One email's saved wording → { copy, cc, updatedAt, updatedBy } (copy: every field set, with `tiers`).
 * Never throws: when the database can't be read the email goes out with the built-in text
 * (a buyer always gets their ticket), and `error` says why.
 */
export async function loadTemplate(email) {
  try {
    const t = await EmailTemplate.findOne({ key: TEMPLATE_KEYS[email] }).lean();
    return { copy: templateCopy(t, email), cc: Array.isArray(t?.cc) ? t.cc : null, updatedAt: t?.updatedAt || null, updatedBy: t?.updatedBy || "" };
  } catch (err) {
    return { copy: {}, cc: null, updatedAt: null, updatedBy: "", error: String(err?.message || err) };
  }
}

/**
 * Saves cleaned fields (services/passEmailCopy.js cleanFields) as the whole template: anything not
 * in `clean` goes back to the built-in text. `extra`: other columns ($set as they are, e.g. cc).
 * → { before, after, changed: ["preheader", "includes (power)", …] }
 */
export async function saveTemplate(email, clean, { by = "", extra = {} } = {}) {
  const key = TEMPLATE_KEYS[email];
  const before = templateCopy(await EmailTemplate.findOne({ key }).lean(), email);
  const t = await EmailTemplate.findOneAndUpdate({ key }, { $set: { ...templateSet(clean, by), ...extra } }, { upsert: true, new: true }).lean();
  const after = templateCopy(t, email);
  return { before, after, changed: changedFields(before, after), row: t };
}
