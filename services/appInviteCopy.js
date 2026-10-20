/* =========================================================
   The app invite email's wording, editable in the admin panel
   ---------------------------------------------------------
   Oct 20 2026, the organiser: "send emails to all people
   associated with the event to download the web app … allow
   customization as usual". Every piece of text in the email
   (services/appInviteEmail.js) is a field here, like the pass
   emails (services/passEmailCopy.js, whose cleaning this reuses):
   staff's value, else the built-in text below. Stored as one
   EmailTemplate row (key "app-invite-email"): the subject in its
   own column, every other field and the on / off switches
   (`options`) in `fields`. Saving is management only.

   Plain text only: it's HTML-escaped where it's shown, line breaks
   are kept in the multi-line fields. Placeholders filled in for each
   person: {firstName} ("there" when we don't know it) and {email}
   (the address the email went to: the one to sign in with).
   Pure (no database), unit-tested in test/app-invite.test.js.
========================================================= */

import { cleanValue, compact, sameAsDefault, mergeCopy } from "./passEmailCopy.js";

export const TEMPLATE_KEY = "app-invite-email";
export const PLACEHOLDERS = Object.freeze(["{firstName}", "{email}"]);

/** Sections in the order the email shows them (the editor groups the fields by these). */
export const SECTIONS = Object.freeze([
  { key: "subject", title: "Subject and inbox preview" },
  { key: "header", title: "Header" },
  { key: "message", title: "Greeting and intro" },
  { key: "features", title: "What's in the app" },
  { key: "button", title: "The button" },
  { key: "homescreen", title: "Add it to your home screen" },
  { key: "signin", title: "Signing in" },
  { key: "stores", title: "App store lines" },
  { key: "signoff", title: "Sign-off and footer" },
]);

const f = (key, section, label, type, max, extra = {}) => Object.freeze({ key, section, label, type, max, ...extra });

export const FIELDS = Object.freeze([
  f("subject", "subject", "Subject", "line", 200),
  f("preheader", "subject", "Inbox preview text", "line", 300, { hint: "The grey line most inboxes show after the subject." }),
  f("eyebrow", "header", "Top line", "line", 120),
  f("heading", "header", "Heading", "line", 160),
  f("greeting", "message", "Greeting", "line", 120, { hint: "{firstName} becomes \"there\" when we don't know their name." }),
  f("intro", "message", "Intro", "text", 1200, { hint: "A blank line starts a new paragraph." }),
  f("featuresTitle", "features", "List title", "line", 80),
  f("features", "features", "What's in the app", "list", 8, { hint: "One line each. Add, remove, reorder or reword." }),
  f("button", "button", "Button", "line", 40),
  f("buttonNote", "button", "Under the button", "line", 200),
  f("homeTitle", "homescreen", "Section title", "line", 80),
  f("homeIntro", "homescreen", "Intro", "text", 400),
  f("iphoneTitle", "homescreen", "iPhone: title", "line", 60),
  f("iphoneSteps", "homescreen", "iPhone: steps", "list", 4),
  f("androidTitle", "homescreen", "Android: title", "line", 60),
  f("androidSteps", "homescreen", "Android: steps", "list", 4),
  f("signIn", "signin", "Sign-in line", "text", 400, { hint: "{email} is the address this email went to." }),
  f("playText", "stores", "Google Play line", "line", 160, { hint: "Shown when \"Google Play line\" is on." }),
  f("playLink", "stores", "Google Play link text", "line", 60),
  f("appStoreText", "stores", "App Store line", "line", 160, { hint: "Shown when \"App Store line\" is on and the iPhone app is live (its App Store link is set)." }),
  f("appStoreLink", "stores", "App Store link text", "line", 60),
  f("signOff", "signoff", "Sign-off", "text", 300),
  f("signature", "signoff", "Signed", "line", 120),
  f("footer", "signoff", "Footer", "text", 600),
]);
const BY_KEY = Object.fromEntries(FIELDS.map((x) => [x.key, x]));

/** The built-in wording (what the email says when nothing is changed). */
export const DEFAULT_COPY = Object.freeze({
  subject: "Your TTFC 2026 app is ready",
  preheader: "Your pass, the agenda, the venue map and live Q&A, all on your phone. Nothing to download from an app store.",
  eyebrow: "The Tech Festival Canada 2026",
  heading: "Your festival, in your pocket.",
  greeting: "Hi {firstName},",
  intro: "TTFC 2026 is almost here, and the TTFC web app has everything you need for the two days. It opens right in your phone's browser, so there's nothing to download.",
  featuresTitle: "What's in it",
  features: Object.freeze([
    "Your pass and check-in QR code",
    "The full agenda, with the sessions you save",
    "The venue map: every stage, room and booth",
    "Networking and chat with other attendees",
    "Live polls and Q&A during sessions",
  ]),
  button: "Open the TTFC app",
  buttonNote: "Works on iPhone and Android.",
  homeTitle: "Add it to your home screen",
  homeIntro: "It then opens like any other app, full screen.",
  iphoneTitle: "iPhone",
  iphoneSteps: Object.freeze([
    "Open the link in Safari.",
    "Tap Share (the square with an arrow).",
    "Tap Add to Home Screen, then Add.",
  ]),
  androidTitle: "Android",
  androidSteps: Object.freeze([
    "Open the link in Chrome.",
    "Tap the ⋮ menu at the top right.",
    "Tap Install app (or Add to Home screen).",
  ]),
  signIn: "Sign in with this email: {email}. We'll send you a sign-in link and a 6-digit code.",
  playText: "Prefer the Android app?",
  playLink: "Get it on Google Play",
  appStoreText: "Prefer the iPhone app?",
  appStoreLink: "Download on the App Store",
  signOff: "We can't wait to see you in Toronto. Questions? Just reply to this email.",
  signature: "The Tech Festival Canada team",
  footer: "You're getting this because you're part of TTFC 2026. Prefer not to get emails like this? Reply with \"unsubscribe\".",
});

/** The optional lines, each with its own on / off. */
export const OPTIONS = Object.freeze([
  Object.freeze({ key: "play", label: "Google Play line", hint: "\"Prefer the Android app? Get it on Google Play.\"" }),
  Object.freeze({ key: "appStore", label: "App Store line", hint: "Only shows once the iPhone app is on the App Store (its link is set)." }),
]);
export const DEFAULT_OPTIONS = Object.freeze({ play: true, appStore: true });

/** The fields in `raw` that are editable, cleaned ("" / [] = the built-in text). Unknown keys are ignored. */
export function cleanCopy(raw = {}) {
  const out = {};
  for (const d of FIELDS) {
    if (raw?.[d.key] === undefined || raw?.[d.key] === null) continue;
    out[d.key] = cleanValue(d, raw[d.key]);
  }
  return out;
}

/** The on / off switches in `raw` (only true / false; anything else is left out). */
export function cleanOptions(raw = {}) {
  const out = {};
  for (const o of OPTIONS) if (typeof raw?.[o.key] === "boolean") out[o.key] = raw[o.key];
  return out;
}

/** Staff's wording to store: cleaned, with anything equal to the built-in text dropped (it keeps following it). */
export function wordingToSave(raw = {}) {
  return compact(sameAsDefault(cleanCopy(raw), [DEFAULT_COPY]));
}

/** EmailTemplate row → { copy: the fields staff set, options: every switch (defaults filled in) }. */
export function templateCopy(row) {
  if (!row) return { copy: {}, options: { ...DEFAULT_OPTIONS } };
  const fields = row.fields && typeof row.fields === "object" ? row.fields : {};
  const { options = {}, ...rest } = fields;
  return {
    copy: compact(cleanCopy({ ...rest, ...(row.subject ? { subject: row.subject } : {}) })),
    options: { ...DEFAULT_OPTIONS, ...cleanOptions(options) },
  };
}

/** The $set for the EmailTemplate row from what staff saved. */
export function templateSet(copy = {}, options = {}, by = "") {
  const { subject = "", ...rest } = compact(copy);
  return { subject, headline: "", message: "", fields: { ...rest, options: { ...DEFAULT_OPTIONS, ...cleanOptions(options) } }, updatedBy: by };
}

/** Every field's text for an email: staff's (or a draft's) value, else the built-in one. */
export const effectiveCopy = (...layers) => mergeCopy(...layers, DEFAULT_COPY);

/** "subject, features, options.play" — what changed between two saves (for the audit log). */
export function changedWording(before = {}, after = {}) {
  const out = [];
  const same = (x, y) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
  for (const d of FIELDS) if (!same(before.copy?.[d.key], after.copy?.[d.key])) out.push(after.copy?.[d.key] === undefined ? `${d.key} reset` : d.key);
  for (const o of OPTIONS) if (!same(before.options?.[o.key], after.options?.[o.key])) out.push(`${o.key} ${after.options?.[o.key] ? "on" : "off"}`);
  return out;
}

/** {firstName} and {email} → values, in one pass. `firstName` missing → "there". */
export function fillInvite(text, { firstName = "", email = "" } = {}) {
  return String(text ?? "").replace(/\{(firstName|email)\}/g, (m, k) => (k === "firstName" ? firstName || "there" : email || m));
}

export const fieldInfo = (key) => BY_KEY[key] || null;
