/* =========================================================
   The "Win the swag kit" email's wording (Oct 22 2026), editable in
   Admin › Website & app › App invite email › "Win the swag kit",
   like the app invite's (services/appInviteCopy.js, whose cleaning
   this reuses): staff's value, else the built-in text below. Stored
   as one EmailTemplate row (key "app-swag-email"). Plain text only.
   Placeholders: {firstName} ("there" when we don't know it), {email}
   (the address it went to: the one to sign in with), {kits} and
   {cutoff} (the contest's settings, services/swagRules.js).
   Pure, unit-tested in test/swag.test.js.
========================================================= */

import { cleanValue, compact, sameAsDefault, mergeCopy } from "./passEmailCopy.js";
import { DEFAULT_COPY as INVITE_COPY } from "./appInviteCopy.js";

export const TEMPLATE_KEY = "app-swag-email";
export const PLACEHOLDERS = Object.freeze(["{firstName}", "{email}", "{kits}", "{cutoff}"]);

export const SECTIONS = Object.freeze([
  { key: "subject", title: "Subject and inbox preview" },
  { key: "header", title: "Header" },
  { key: "message", title: "Greeting, the app and how to win" },
  { key: "button", title: "The button" },
  { key: "homescreen", title: "Add it to your home screen" },
  { key: "rules", title: "Rules line" },
  { key: "signoff", title: "Sign-off and footer" },
]);

const f = (key, section, label, type, max, extra = {}) => Object.freeze({ key, section, label, type, max, ...extra });

export const FIELDS = Object.freeze([
  f("subject", "subject", "Subject", "line", 200),
  f("preheader", "subject", "Inbox preview text", "line", 300, { hint: "The grey line most inboxes show after the subject." }),
  f("eyebrow", "header", "Top line", "line", 120),
  f("heading", "header", "Heading", "line", 160),
  f("imageAlt", "header", "Photo description", "line", 200, { hint: "Read out by screen readers and shown when images are off." }),
  f("greeting", "message", "Greeting", "line", 120, { hint: "{firstName} becomes \"there\" when we don't know their name." }),
  f("intro", "message", "What the app does", "text", 600),
  f("winTitle", "message", "How to win: title", "line", 80),
  f("winLine", "message", "How to win", "text", 400, { hint: "{kits} and {cutoff} come from the contest's settings." }),
  f("button", "button", "Button", "line", 40),
  f("buttonNote", "button", "Under the button", "line", 200),
  f("homeTitle", "homescreen", "Section title", "line", 80),
  f("iphoneTitle", "homescreen", "iPhone: title", "line", 60),
  f("iphoneSteps", "homescreen", "iPhone: steps", "list", 4),
  f("androidTitle", "homescreen", "Android: title", "line", 60),
  f("androidSteps", "homescreen", "Android: steps", "list", 4),
  f("signIn", "homescreen", "Sign-in line", "text", 400, { hint: "{email} is the address this email went to." }),
  f("rulesText", "rules", "Rules line", "line", 200),
  f("rulesLink", "rules", "Rules link text", "line", 60),
  f("signOff", "signoff", "Sign-off", "text", 300),
  f("signature", "signoff", "Signed", "line", 120),
  f("footer", "signoff", "Footer", "text", 600),
]);
const BY_KEY = Object.fromEntries(FIELDS.map((x) => [x.key, x]));

/** The built-in wording. The home-screen steps are the app invite's (the install page says the same). */
export const DEFAULT_COPY = Object.freeze({
  subject: "Get the TTFC app — and you could win the swag kit",
  preheader: "Top earners on the app leaderboard win a TTFC swag kit",
  eyebrow: "The Tech Festival Canada 2026",
  heading: "Get the app. Win the swag kit.",
  imageAlt: "TTFC swag kit: backpack, bottle, mug, notebook, umbrella and more",
  greeting: "Hi {firstName},",
  intro: "Your pass, the agenda, the venue map, networking and live Q&A are all in the TTFC app. It opens in your phone's browser, so there's nothing to download from an app store.",
  winTitle: "How to win",
  winLine: "Earn points by connecting, saving sessions and posting — the top {kits} at {cutoff} win a TTFC swag kit.",
  button: "Get the app",
  buttonNote: "Works on iPhone and Android.",
  homeTitle: "Add it to your home screen",
  iphoneTitle: INVITE_COPY.iphoneTitle,
  iphoneSteps: INVITE_COPY.iphoneSteps,
  androidTitle: INVITE_COPY.androidTitle,
  androidSteps: INVITE_COPY.androidSteps,
  signIn: "Sign in with this email: {email}. We'll send you a sign-in link and a 6-digit code.",
  rulesText: "No purchase necessary.",
  rulesLink: "Read the rules",
  signOff: "See you in Toronto. Questions? Just reply to this email.",
  signature: "The Tech Festival Canada team",
  footer: INVITE_COPY.footer,
});

/** The fields in `raw` that are editable, cleaned ("" / [] = the built-in text). Unknown keys are ignored. */
export function cleanCopy(raw = {}) {
  const out = {};
  for (const d of FIELDS) {
    if (raw?.[d.key] === undefined || raw?.[d.key] === null) continue;
    out[d.key] = cleanValue(d, raw[d.key]);
  }
  return out;
}

/** Staff's wording to store: cleaned, with anything equal to the built-in text dropped (it keeps following it). */
export const wordingToSave = (raw = {}) => compact(sameAsDefault(cleanCopy(raw), [DEFAULT_COPY]));

/** EmailTemplate row → { copy } (the fields staff set). */
export function templateCopy(row) {
  if (!row) return { copy: {} };
  const fields = row.fields && typeof row.fields === "object" ? row.fields : {};
  return { copy: compact(cleanCopy({ ...fields, ...(row.subject ? { subject: row.subject } : {}) })) };
}

/** The $set for the EmailTemplate row from what staff saved. */
export function templateSet(copy = {}, by = "") {
  const { subject = "", ...rest } = compact(copy);
  return { subject, headline: "", message: "", fields: rest, updatedBy: by };
}

/** Every field's text for an email: staff's (or a draft's) value, else the built-in one. */
export const effectiveCopy = (...layers) => mergeCopy(...layers, DEFAULT_COPY);

/** "subject, winLine" — what changed between two saves (for the audit log). */
export function changedWording(before = {}, after = {}) {
  const same = (x, y) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
  return FIELDS.filter((d) => !same(before.copy?.[d.key], after.copy?.[d.key])).map((d) => (after.copy?.[d.key] === undefined ? `${d.key} reset` : d.key));
}

/** {firstName}, {email}, {kits}, {cutoff} → values, in one pass. */
export function fillSwagInvite(text, { firstName = "", email = "", kits = "", cutoff = "" } = {}) {
  return String(text ?? "").replace(/\{(firstName|email|kits|cutoff)\}/g, (m, k) =>
    (k === "firstName" ? firstName || "there" : k === "email" ? email || m : k === "kits" ? String(kits || m) : cutoff || m));
}

export const fieldInfo = (key) => BY_KEY[key] || null;
