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
   (the address the email went to: the one to sign in with); in the
   swag kit fields, {kits}, {cutoff} and {announce} (the contest's
   settings, services/swagRules.js).

   The swag kit (Oct 22 2026, the organiser: "this is supposed to be an
   advertisement for the app … download the app, and then only you can
   get a chance to win"): while swag.enabled, the email carries a block
   right after the intro (the photo, swagHeadline, swagOnly, swagText,
   "No purchase necessary · Rules") and its subject is swagSubject.
   The store apps (Oct 22 2026, the organiser: "Prompt the users to
   download Android/iOS. Stop prompting people to install the web app
   any longer. However, let the web app be active."): the main call
   to action is "Get the TTFC app", why, and two official-style
   badges, Download on the App Store and Get it on Google Play (each
   with its switch in `options`; the App Store one only while the
   iPhone app's link is set; their words are the stores' own, not
   fields). The web app is a small line under them ("Rather not
   download anything? … Open the web app", the tracked link), or the
   big button when no badge shows.
   The "Add it to your home screen" steps are gone (their fields too:
   anything saved for them is ignored).
   Pure (no database), unit-tested in test/app-invite.test.js.
========================================================= */

import { cleanValue, compact, sameAsDefault, mergeCopy } from "./passEmailCopy.js";

export const TEMPLATE_KEY = "app-invite-email";
export const PLACEHOLDERS = Object.freeze(["{firstName}", "{email}", "{kits}", "{cutoff}", "{announce}"]);

/** Sections in the order the email shows them (the editor groups the fields by these). */
export const SECTIONS = Object.freeze([
  { key: "subject", title: "Subject and inbox preview" },
  { key: "header", title: "Header" },
  { key: "message", title: "Greeting and intro" },
  { key: "swag", title: "The swag kit (while the contest is on)" },
  { key: "features", title: "What's in the app" },
  { key: "stores", title: "Get the app: the App Store and Google Play badges" },
  { key: "webapp", title: "The web app link" },
  { key: "signin", title: "Signing in" },
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
  f("swagSubject", "swag", "Subject while the contest is on", "line", 200, { hint: "Replaces the subject while the swag kit contest is on." }),
  f("swagHeadline", "swag", "Headline", "line", 120),
  f("swagOnly", "swag", "Only app users can win", "line", 200, { hint: "Shown in bold: the key point." }),
  f("swagText", "swag", "How and when", "text", 400, { hint: "{kits}, {cutoff} and {announce} come from the contest's settings." }),
  f("featuresTitle", "features", "List title", "line", 80),
  f("features", "features", "What's in the app", "list", 8, { hint: "One line each. Add, remove, reorder or reword." }),
  f("storesTitle", "stores", "Heading", "line", 80, { hint: "Above the App Store and Google Play badges (their own words are the stores' official ones)." }),
  f("storesIntro", "stores", "Why", "line", 200),
  f("buttonNote", "stores", "Under the badges", "line", 200),
  f("webAppText", "webapp", "Web app line", "line", 200, { hint: "Small, under the badges, before the link." }),
  f("button", "webapp", "Web app link", "line", 40, { hint: "The link to the web app (thetechfestival.com/app). With both badges off, it's the big button." }),
  f("signIn", "signin", "Sign-in line", "text", 400, { hint: "{email} is the address this email went to." }),
  f("signOff", "signoff", "Sign-off", "text", 300),
  f("signature", "signoff", "Signed", "line", 120),
  f("footer", "signoff", "Footer", "text", 600),
]);
const BY_KEY = Object.fromEntries(FIELDS.map((x) => [x.key, x]));

/** The built-in wording (what the email says when nothing is changed). */
export const DEFAULT_COPY = Object.freeze({
  subject: "Your TTFC 2026 app is ready",
  preheader: "Your pass, the agenda, the venue map and live Q&A, all on your phone. Free on the App Store and Google Play.",
  eyebrow: "The Tech Festival Canada 2026",
  heading: "Your festival, in your pocket.",
  greeting: "Hi {firstName},",
  intro: "TTFC 2026 is almost here, and the TTFC app has everything you need for the two days. Download it free on the App Store or Google Play.",
  swagSubject: "Get the TTFC app — only app users can win the swag kit",
  swagHeadline: "Download the app to win the TTFC swag kit",
  swagOnly: "Only people using the TTFC app can win — download it, sign in and earn points.",
  swagText: "The top {kits} on the app's leaderboard win. Winners are announced at the end of Day 1 ({announce}).",
  featuresTitle: "What's in it",
  features: Object.freeze([
    "Your pass and check-in QR code",
    "The full agenda, with the sessions you save",
    "The venue map: every stage, room and booth",
    "Networking and chat with other attendees",
    "Live polls and Q&A during sessions",
  ]),
  storesTitle: "Get the TTFC app",
  storesIntro: "Your pass, the schedule, live polls and messages, all on your phone.",
  buttonNote: "Free on iPhone and Android.",
  webAppText: "Rather not download anything? Use TTFC in your phone's browser:",
  button: "Open the web app",
  signIn: "Sign in with this email: {email}. We'll send you a sign-in link and a 6-digit code.",
  signOff: "We can't wait to see you in Toronto. Questions? Just reply to this email.",
  signature: "The Tech Festival Canada team",
  footer: "You're getting this because you're part of TTFC 2026.", // the "Unsubscribe from TTFC emails" link always follows (services/unsubscribe.js)
});

/** The store badges, each with its own on / off (both off: the web app link is the big button). */
export const OPTIONS = Object.freeze([
  Object.freeze({ key: "appStore", label: "App Store badge", hint: "\"Download on the App Store\": the iPhone app. Only shows while the App Store link is set." }),
  Object.freeze({ key: "play", label: "Google Play badge", hint: "\"Get it on Google Play\": the Android app." }),
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

/** {firstName}, {email} (and {kits}, {cutoff}, {announce} when given) → values, in one pass. `firstName` missing → "there". */
export function fillInvite(text, { firstName = "", email = "", kits = "", cutoff = "", announce = "" } = {}) {
  const v = { kits: String(kits || ""), cutoff, announce };
  return String(text ?? "").replace(/\{(firstName|email|kits|cutoff|announce)\}/g, (m, k) =>
    (k === "firstName" ? firstName || "there" : k === "email" ? email || m : v[k] || m));
}

export const fieldInfo = (key) => BY_KEY[key] || null;
