/* =========================================================
   The jury emails' wording, editable in the admin panel (Oct 2026)
   ---------------------------------------------------------
   Two emails to Catalyst Awards jurors, sent only when management
   clicks (Admin › Catalyst Awards › Jury): the invite ("Send
   invite") and the reminder ("Send reminder"). Every piece of text
   is a field here, like the app invite (services/appInviteCopy.js,
   whose pattern and cleaning this reuses): staff's value, else the
   built-in text below. One EmailTemplate row per email
   ("jury-invite", "jury-reminder"): the subject in its own column,
   the other fields in `fields`. Saving is management only.

   Plain text only: HTML-escaped where it's shown, line breaks kept
   in the multi-line fields. Placeholders, filled in per juror:
     {firstName}  {name}  {email} (the address to sign in with)
     {assigned}   "12 nominations" / "1 nomination" / "no nominations yet"
     {submitted}  "8"
     {remaining}  "4 nominations" / "1 nomination"
     {deadline}   "Sunday, October 25, 11:59 PM ET" ("the deadline" when none is set)
   Pure (no database), unit-tested in test/jury.test.js.
========================================================= */

import { cleanValue, compact, sameAsDefault, mergeCopy } from "./passEmailCopy.js";

export const KINDS = Object.freeze(["invite", "reminder"]);
export const TEMPLATE_KEYS = Object.freeze({ invite: "jury-invite", reminder: "jury-reminder" });
export const PLACEHOLDERS = Object.freeze(["{firstName}", "{name}", "{email}", "{assigned}", "{submitted}", "{remaining}", "{deadline}"]);

export const SECTIONS = Object.freeze([
  { key: "subject", title: "Subject and inbox preview" },
  { key: "header", title: "Header" },
  { key: "message", title: "Greeting and message" },
  { key: "steps", title: "How it works" },
  { key: "button", title: "The button and signing in" },
  { key: "signoff", title: "Sign-off and footer" },
]);

const f = (key, section, label, type, max, extra = {}) => Object.freeze({ key, section, label, type, max, ...extra });

const COMMON = [
  f("subject", "subject", "Subject", "line", 200),
  f("preheader", "subject", "Inbox preview text", "line", 300, { hint: "The grey line most inboxes show after the subject." }),
  f("eyebrow", "header", "Top line", "line", 120),
  f("heading", "header", "Heading", "line", 160),
  f("greeting", "message", "Greeting", "line", 120),
  f("intro", "message", "Message", "text", 1500, { hint: "A blank line starts a new paragraph." }),
];
const TAIL = [
  f("button", "button", "Button", "line", 40),
  f("signIn", "button", "How to sign in", "text", 500, { hint: "{email} is the address this email went to." }),
  f("deadlineLine", "button", "Deadline line", "line", 200, { hint: "Left out when no deadline is set." }),
  f("signOff", "signoff", "Sign-off", "text", 600),
  f("signature", "signoff", "Signed", "line", 120),
  f("footer", "signoff", "Footer", "text", 400),
];

export const FIELDS = Object.freeze({
  invite: Object.freeze([
    ...COMMON,
    f("stepsTitle", "steps", "List title", "line", 80),
    f("steps", "steps", "Steps", "list", 6, { hint: "One line each. Add, remove, reorder or reword." }),
    ...TAIL,
  ]),
  reminder: Object.freeze([...COMMON, ...TAIL]),
});

const SIGN_IN = "Sign in with {email}. Ask for a one-time 6-digit code by email on the sign-in page.";
const SIGNATURE = "The Catalyst Awards team, The Tech Festival Canada";
const FOOTER = "You're getting this because you're on the Catalyst Awards jury for TTFC 2026.";

export const DEFAULT_COPY = Object.freeze({
  invite: Object.freeze({
    subject: "You're on the Catalyst Awards jury",
    preheader: "Your nominations are ready to review. About 5 minutes each, by {deadline}.",
    eyebrow: "The Catalyst Awards · TTFC 2026",
    heading: "Welcome to the jury",
    greeting: "Hi {firstName},",
    intro: "Thank you for joining the jury for the Catalyst Awards at The Tech Festival Canada 2026. The winners are announced on the evening of October 26 in Toronto.\n\nIn the jury portal you'll find {assigned} to review.",
    stepsTitle: "How it works",
    steps: Object.freeze([
      "Read each nomination: the nominee, their category and their statements.",
      "Score five criteria from 1 to 5. Tap a criterion to see what 1, 3 and 5 mean. It takes about 5 minutes.",
      "Your scores save as a draft as you go. Submit each assessment when you're happy with it.",
      "You can edit a submitted assessment until the deadline.",
    ]),
    button: "Open the jury portal",
    signIn: SIGN_IN,
    deadlineLine: "Please submit your assessments by {deadline}.",
    signOff: "If a nomination involves you or your organisation, tap \"Declare a conflict of interest\" on it and we'll reassign it. Questions? Just reply to this email.",
    signature: SIGNATURE,
    footer: FOOTER,
  }),
  reminder: Object.freeze({
    subject: "Reminder: {remaining} left to review",
    preheader: "Please submit your Catalyst Awards assessments by {deadline}.",
    eyebrow: "The Catalyst Awards · TTFC 2026",
    heading: "A quick reminder",
    greeting: "Hi {firstName},",
    intro: "You've submitted {submitted} of {assigned} so far. Still to review: {remaining}. Each one takes about 5 minutes, and your drafts are saved.",
    button: "Continue reviewing",
    signIn: SIGN_IN,
    deadlineLine: "The jury portal closes on {deadline}.",
    signOff: "Thank you for giving your time to the Catalyst Awards. Questions? Just reply to this email.",
    signature: SIGNATURE,
    footer: FOOTER,
  }),
});

export const kindOf = (k) => (KINDS.includes(k) ? k : null);

/** The editable fields in `raw`, cleaned ("" / [] = the built-in text). Unknown keys are ignored. */
export function cleanCopy(kind, raw = {}) {
  const out = {};
  for (const d of FIELDS[kind] || []) {
    if (raw?.[d.key] === undefined || raw?.[d.key] === null) continue;
    out[d.key] = cleanValue(d, raw[d.key]);
  }
  return out;
}

/** Staff's wording to store: cleaned, anything equal to the built-in text dropped (it keeps following it). */
export const wordingToSave = (kind, raw = {}) => compact(sameAsDefault(cleanCopy(kind, raw), [DEFAULT_COPY[kind]]));

/** EmailTemplate row → the fields staff set. */
export function templateCopy(kind, row) {
  if (!row) return {};
  const fields = row.fields && typeof row.fields === "object" ? row.fields : {};
  return compact(cleanCopy(kind, { ...fields, ...(row.subject ? { subject: row.subject } : {}) }));
}

/** The $set for the EmailTemplate row. */
export function templateSet(copy = {}, by = "") {
  const { subject = "", ...rest } = compact(copy);
  return { subject, headline: "", message: "", fields: rest, updatedBy: by };
}

/** Every field's text: staff's (or a draft's) value, else the built-in one. */
export const effectiveCopy = (kind, ...layers) => mergeCopy(...layers, DEFAULT_COPY[kind]);

/** Which fields changed between two saves (for the audit log). */
export function changedWording(kind, before = {}, after = {}) {
  const same = (x, y) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
  return (FIELDS[kind] || []).filter((d) => !same(before[d.key], after[d.key])).map((d) => (after[d.key] === undefined ? `${d.key} reset` : d.key));
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The placeholder values for a juror. `progress`: services/jury.js progressOf; `deadlineText`: formatDeadline. */
export function varsFor(juror = {}, progress = {}, deadlineText = "") {
  const assigned = Number(progress.assigned) || 0;
  const submitted = Number(progress.submitted) || 0;
  const remaining = Math.max(0, Number(progress.remaining ?? assigned - submitted) || 0);
  return {
    firstName: String(juror.name || "").trim().split(/\s+/)[0] || "",
    name: String(juror.name || "").trim(),
    email: String(juror.email || "").trim(),
    assigned: assigned ? plural(assigned, "nomination") : "no nominations yet",
    submitted: String(submitted),
    remaining: plural(remaining, "nomination"),
    deadline: deadlineText || "the deadline",
    hasDeadline: !!deadlineText,
  };
}

/** Placeholders → values, in one pass. {firstName} missing → "there". */
export function fill(text, vars = {}) {
  return String(text ?? "").replace(/\{(firstName|name|email|assigned|submitted|remaining|deadline)\}/g, (m, k) => {
    if (k === "firstName") return vars.firstName || "there";
    return vars[k] !== undefined && vars[k] !== "" ? String(vars[k]) : m;
  });
}

/** A made-up juror for previews. */
export const SAMPLE_JUROR = Object.freeze({ name: "Jordan Example", email: "jordan.example@example.com" });
export const SAMPLE_PROGRESS = Object.freeze({ assigned: 12, submitted: 8, remaining: 4 });
