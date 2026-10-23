/* =========================================================
   Every word of the pass emails, editable in the admin panel
   ---------------------------------------------------------
   Oct 19 2026, the organiser: staff can change every piece of
   visible text in the four pass emails, including the pass names
   shown in them:
     speaker    Admin › Speaker passes   (services/passEmail.js)
     issued     Admin › Issue passes     (the same builder)
     exhibitor  Admin › Exhibitor passes (the same builder)
     purchase   the website purchase confirmation (services/ticketEmail.js,
                sent by sendTicketEmail in services/emailService.js)

   Two levels, the same storage as before (no second system):
     - the email template, an EmailTemplate row per email ("speaker-pass",
       "issued-pass", "exhibitor-pass", "purchase-email"): subject,
       headline and message where they always were, every other field in
       `fields`. The issued, exhibitor and purchase templates cover every
       pass type, so the fields that depend on the pass (its name, what
       it includes, the access line, the RSVP reason; the purchase email's
       tagline, paragraph and tips) are kept per pass type in
       `fields.tiers.<connect|influence|power|apex|speaker>`;
     - one pass (one person): Attendee.issuedPass.copy, the per-pass
       wording issued and exhibitor passes already had (speakers' passes
       use it too now), with the pass name in Attendee.issuedPass.label
       ("Name on the pass"). The purchase email goes out the moment
       someone buys, so it has the template level only.
   One pass's value beats the template's, which beats the built-in text.
   An empty field (or an empty list) means "the level below".

   Everything here is plain text: it's HTML-escaped where it's shown,
   line breaks are kept in the multi-line fields (a blank line starts a
   paragraph in the message), and nothing staff type is ever HTML.
   Placeholders filled in for each person: {firstName}, {fullName}
   ({name} is the same), {passName} and {ticketId}; the speakers' run of
   show also has {sessions} ("session" or "sessions").
   Pure (no database), unit-tested in test/pass-email-copy.test.js.
========================================================= */

import { escapeHtml as esc } from "./ticketInfo.js";

export const TEMPLATE_KEYS = Object.freeze({
  speaker: "speaker-pass", issued: "issued-pass", exhibitor: "exhibitor-pass", purchase: "purchase-email",
});
/** Pass types a template can word separately. "speaker": the internal Speaker Pass (staff-made, never sold). */
export const TIERS = Object.freeze(["connect", "influence", "power", "apex", "speaker"]);

/** Sections in the order the email shows them (the admin editor groups the fields by these). */
export const SECTIONS = Object.freeze([
  { key: "subject", title: "Subject and inbox preview" },
  { key: "header", title: "Header" },
  { key: "greeting", title: "Greeting and message" },
  { key: "pass", title: "The pass" },
  { key: "includes", title: "What the pass includes" },
  { key: "dayplan", title: "Run of show and day plan" },
  { key: "rsvp", title: "RSVP" },
  { key: "details", title: "Event details" },
  { key: "tips", title: "Know before you go" },
  { key: "app", title: "The app" },
  { key: "footer", title: "Contact and footer" },
]);

/* Field types: "line" (one line), "text" (line breaks kept), "pairs" (a list of
   [heading, detail] rows), "list" (a list of lines).
   `tier`: kept per pass type in the templates that cover all four passes.
   `only`: the emails that have it. `booth`: the purchase template's field also
   applies to booth confirmations (the rest of the purchase email is about the pass). */
const f = (key, section, label, type, max, extra = {}) => Object.freeze({ key, section, label, type, max, ...extra });

const PASS_FIELDS = [
  f("subject", "subject", "Subject", "line", 200),
  f("preheader", "subject", "Inbox preview text", "line", 300, { hint: "The grey line most inboxes show after the subject." }),
  f("eyebrow", "header", "Top line", "line", 120),
  f("contactNotice", "header", "Note when it goes to their contact", "text", 500, { only: ["speaker"], hint: "Shown when the address on the pass belongs to their assistant or office." }),
  f("greeting", "greeting", "Greeting", "line", 120),
  f("headline", "greeting", "Headline", "line", 200),
  f("message", "greeting", "Message", "text", 3000, { hint: "A blank line starts a new paragraph." }),
  f("passName", "pass", "Pass name", "line", 40, { tier: true, hint: "On the badge and in the headings, e.g. Power Pass · Speaker. The built-in name is the pass type." }),
  f("presentedTo", "pass", "Above their name", "line", 60),
  f("labelDates", "pass", "Dates label", "line", 40),
  f("datesText", "pass", "Dates", "line", 80),
  f("labelVenue", "pass", "Venue label", "line", 40),
  f("venueName", "pass", "Venue", "line", 120),
  f("venueCity", "pass", "City", "line", 80),
  f("labelTicketId", "pass", "Ticket ID label", "line", 40),
  f("labelAccess", "pass", "Access label", "line", 40),
  f("access", "pass", "Access", "line", 120, { tier: true }),
  f("qrCaption", "pass", "Under the QR code", "line", 80),
  f("cardFooter", "pass", "Bottom line of the pass", "line", 120),
  f("qrTextNote", "pass", "QR line in the plain-text version", "line", 200),
  f("includesTitle", "includes", "Section title", "line", 80),
  f("includes", "includes", "What's included", "pairs", 20, { tier: true, hint: "Add, remove, reorder or reword. Empty = the pass's own list (with its meals and events switched on or off for that pass)." }),
  f("rosTitle", "dayplan", "Sessions title", "line", 80, { only: ["speaker"] }),
  f("rosStage", "dayplan", "Stage", "line", 120, { only: ["speaker"] }),
  f("rosMicUp", "dayplan", "Mic fitting reminder", "text", 300, { only: ["speaker"], hint: "Their mic-fitting times are added after it." }),
  f("rosDaysTitle", "dayplan", "Day plan title", "line", 80, { only: ["speaker"] }),
  f("rosDaysIntro", "dayplan", "Day plan intro", "text", 400, { only: ["speaker"] }),
  f("rosRegTitle", "dayplan", "Registration", "line", 120, { only: ["speaker"] }),
  f("rosRegWhere", "dayplan", "Registration: where", "line", 120, { only: ["speaker"] }),
  f("rosRegNote", "dayplan", "Registration: note", "line", 300, { only: ["speaker"] }),
  f("rosBreakfastTitle", "dayplan", "CxO Breakfast", "line", 120, { only: ["speaker"] }),
  f("rosBreakfastWhere", "dayplan", "CxO Breakfast: where", "line", 120, { only: ["speaker"] }),
  f("rosBreakfastNote", "dayplan", "CxO Breakfast: note", "line", 300, { only: ["speaker"] }),
  f("rosLunchTitle", "dayplan", "Lunch", "line", 120, { only: ["speaker"] }),
  f("rosLunchWhere", "dayplan", "Lunch: where", "line", 120, { only: ["speaker"] }),
  f("rosLunchNote", "dayplan", "Lunch: note", "line", 300, { only: ["speaker"] }),
  f("rosEvening1Title", "dayplan", "Day 1 evening", "line", 120, { only: ["speaker"] }),
  f("rosEvening1Where", "dayplan", "Day 1 evening: where", "line", 120, { only: ["speaker"] }),
  f("rosEvening1Note", "dayplan", "Day 1 evening: note", "line", 300, { only: ["speaker"] }),
  f("rosEvening2Title", "dayplan", "Day 2 evening", "line", 120, { only: ["speaker"] }),
  f("rosEvening2Where", "dayplan", "Day 2 evening: where", "line", 120, { only: ["speaker"] }),
  f("rosEvening2Note", "dayplan", "Day 2 evening: note", "line", 300, { only: ["speaker"] }),
  f("rosMicFittingTitle", "dayplan", "Mic fitting (in the day plan)", "line", 120, { only: ["speaker"] }),
  f("rosMicFittingWhere", "dayplan", "Mic fitting: where", "line", 120, { only: ["speaker"] }),
  f("rosMicFittingNote", "dayplan", "Mic fitting: note", "line", 300, { only: ["speaker"] }),
  f("rosMedia", "dayplan", "Media note", "text", 600, { only: ["speaker"] }),
  f("rsvpTitle", "rsvp", "Section title", "line", 80),
  f("rsvpText", "rsvp", "Why to RSVP", "text", 600, { tier: true }),
  f("rsvpButton", "rsvp", "Button", "line", 40),
  f("rsvpNote", "rsvp", "Under the button", "line", 200),
  f("contactTitle", "footer", "Contact box title", "line", 120),
  f("contactText", "footer", "Contact box text", "text", 600, { hint: "Email addresses become links." }),
  f("signoff", "footer", "Sign-off", "line", 120),
  f("signature", "footer", "Signed", "line", 120),
  f("footer", "footer", "Footer", "text", 400),
  f("footerNote", "footer", "Footer note", "text", 300),
];

const PURCHASE_FIELDS = [
  f("subject", "subject", "Subject", "line", 200),
  f("preheader", "subject", "Inbox preview text", "line", 300, { hint: "The grey line most inboxes show after the subject." }),
  f("headerLabel", "header", "Header label", "line", 40, { booth: true }),
  f("headerVenue", "header", "Header venue", "line", 120, { booth: true }),
  f("headerAddress", "header", "Header address", "line", 160, { booth: true }),
  f("headline", "greeting", "Headline", "line", 200),
  f("message", "greeting", "Intro", "text", 2000, { hint: "{passName} shows in bold." }),
  f("passName", "pass", "Pass name", "line", 40, { tier: true, hint: "On the pass, in the subject and the headings. The built-in name is the pass type." }),
  f("labelAttendee", "pass", "Name label", "line", 40),
  f("labelTicketId", "pass", "Ticket ID label", "line", 40),
  f("cardLine", "pass", "Dates and venue line", "line", 160),
  f("qrCaption", "pass", "Under the QR code", "line", 80),
  f("walletCaption", "pass", "Under the Apple Wallet button", "text", 300),
  f("attachTitle", "pass", "Attachment title", "line", 120),
  f("attachCaption", "pass", "Attachment caption", "text", 300),
  f("includesTitle", "includes", "Section title", "line", 80),
  f("tagline", "includes", "Tagline", "line", 200, { tier: true }),
  f("blurb", "includes", "Paragraph", "text", 1200, { tier: true }),
  f("includes", "includes", "What's included", "list", 20, { tier: true, hint: "Add, remove, reorder or reword. Empty = the pass's own list (with its meals and events switched on or off for that pass)." }),
  f("detailsTitle", "details", "Section title", "line", 80, { booth: true }),
  f("labelWhen", "details", "When label", "line", 40, { booth: true }),
  f("whenText", "details", "When", "line", 160, { booth: true }),
  f("labelWhere", "details", "Where label", "line", 40, { booth: true }),
  f("whereVenue", "details", "Venue", "line", 120, { booth: true }),
  f("whereAddress", "details", "Address", "line", 160, { booth: true }),
  f("mapsLink", "details", "Maps link", "line", 60, { booth: true }),
  f("labelDoors", "details", "Doors label", "line", 40, { booth: true }),
  f("doorsText", "details", "Doors", "text", 300, { booth: true }),
  f("calendarButton", "details", "Calendar button", "line", 60, { booth: true }),
  f("tipsTitle", "tips", "Section title", "line", 80),
  f("tips", "tips", "Tips", "list", 12, { tier: true, hint: "Add, remove, reorder or reword. Empty = the built-in tips." }),
  f("appEyebrow", "app", "Label", "line", 80, { booth: true }),
  f("appTitle", "app", "Title", "line", 120, { booth: true }),
  f("appBody", "app", "Text", "text", 400, { booth: true }),
  f("appStoreButton", "app", "App Store button", "line", 40, { booth: true, hint: "Opens the iPhone app on the App Store." }),
  f("playButton", "app", "Google Play button", "line", 40, { booth: true, hint: "Opens the Android app on Google Play." }),
  f("helpTitle", "footer", "Help title", "line", 80, { booth: true }),
  f("helpText", "footer", "Help text", "text", 600, { booth: true, hint: "Email addresses become links; {ticketId} shows in the ticket style." }),
  f("contactLine", "footer", "Website and phone line", "text", 300, { booth: true }),
  f("footerNote", "footer", "Footer note", "text", 400, { booth: true }),
];

/** The fields of one email ("speaker" | "issued" | "exhibitor" | "purchase"). `tier` is only
    true in the templates that cover all four passes (not the speakers' email or one pass).
    level "pass" (one person's wording) leaves out the pass name: that's the pass's own
    "Name on the pass" (Attendee.issuedPass.label), edited next to it. */
export function fieldsFor(email, { level = "template" } = {}) {
  const list = email === "purchase" ? PURCHASE_FIELDS : PASS_FIELDS.filter((x) => !x.only || x.only.includes(email));
  const perTier = level === "template" && email !== "speaker";
  return list
    .filter((x) => level !== "pass" || x.key !== "passName")
    .map((x) => (x.tier && !perTier ? { ...x, tier: false } : x));
}
const keysFor = (email) => new Set(fieldsFor(email).map((x) => x.key));

/** Placeholders staff can use, for the editor's hint. */
export const PLACEHOLDERS = Object.freeze({
  pass: ["{firstName}", "{fullName}", "{passName}", "{ticketId}"],
  speaker: ["{firstName}", "{fullName}", "{passName}", "{ticketId}", "{sessions}"],
  purchase: ["{firstName}", "{fullName}", "{passName}", "{ticketId}"],
});

/* ---------- cleaning ---------- */

const noControls = (s) => String(s ?? "").replace(/\r\n?/g, "\n").replace(/[^\P{Cc}\n]/gu, "");
const oneLine = (s, max) => noControls(s).replace(/\s+/g, " ").trim().slice(0, max);
const manyLines = (s, max) => noControls(s).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);

/** One field's value from a request → the stored shape ("" / [] = not set). */
export function cleanValue(def, raw) {
  if (def.type === "pairs") {
    if (!Array.isArray(raw)) return [];
    const str = (v) => (typeof v === "string" ? v : "");
    return raw.slice(0, def.max).map((row) => {
      const [head, sub] = Array.isArray(row) ? row : typeof row === "string" ? [row, ""] : [row?.head, row?.sub];
      return [oneLine(str(head), 120), oneLine(str(sub), 200)];
    }).filter(([head]) => head);
  }
  if (def.type === "list") {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, def.max).map((row) => oneLine(typeof row === "string" ? row : "", 300)).filter(Boolean);
  }
  return def.type === "text" ? manyLines(raw, def.max) : oneLine(raw, def.max);
}

/**
 * The editable fields in `raw` (anything else is ignored), cleaned. Only keys present in `raw`
 * come back, so a PATCH changes just those; "" / [] mean "back to the level below".
 * `tiers: true` also reads raw.tiers.<tier>.<field> for the per-pass-type fields.
 */
export function cleanFields(raw = {}, email = "speaker", { tiers = false, level = "template" } = {}) {
  const out = {};
  const defs = fieldsFor(email, { level });
  for (const d of defs) {
    if (d.tier && tiers) continue;
    if (raw?.[d.key] === undefined || raw?.[d.key] === null) continue;
    out[d.key] = cleanValue(d, raw[d.key]);
  }
  if (tiers && raw?.tiers && typeof raw.tiers === "object") {
    const t = {};
    for (const tier of TIERS) {
      const src = raw.tiers[tier];
      if (!src || typeof src !== "object") continue;
      const one = {};
      for (const d of defs.filter((x) => x.tier)) {
        if (src[d.key] === undefined || src[d.key] === null) continue;
        one[d.key] = cleanValue(d, src[d.key]);
      }
      t[tier] = one;
    }
    out.tiers = t;
  }
  return out;
}

const isSet = (v) => (Array.isArray(v) ? v.length > 0 : typeof v === "string" ? v.length > 0 : false);

/** Only the set values (what's stored and what's sent to the builders). */
export function compact(copy = {}) {
  const out = {};
  for (const [k, v] of Object.entries(copy || {})) {
    if (k === "tiers") continue;
    if (isSet(v)) out[k] = v;
  }
  if (copy?.tiers && typeof copy.tiers === "object") {
    const tiers = {};
    for (const tier of TIERS) {
      const one = compact(copy.tiers[tier] || {});
      if (Object.keys(one).length) tiers[tier] = one;
    }
    if (Object.keys(tiers).length) out.tiers = tiers;
  }
  return out;
}

/**
 * Fields staff "changed" to exactly a built-in value are no change ("" / []), so they keep following the
 * pass's own rules (e.g. a list that matches the pass's built-in one still gets the CxO Breakfast rule).
 * `defaults`: the built-in values to compare with (several sets: any match counts); `tierDefaults`:
 * { power: {...} } for the per-pass-type fields in `clean.tiers`.
 */
export function sameAsDefault(clean = {}, defaults = [], { tierDefaults = {} } = {}) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const drop = (obj, sets) => {
    const out = { ...obj };
    for (const [k, v] of Object.entries(out)) {
      if (k === "tiers" || !isSet(v)) continue;
      if (sets.some((d) => d && d[k] !== undefined && same(d[k], v))) out[k] = Array.isArray(v) ? [] : "";
    }
    return out;
  };
  const out = drop(clean, defaults);
  if (clean.tiers) {
    out.tiers = {};
    for (const [tier, one] of Object.entries(clean.tiers)) out.tiers[tier] = drop(one, [tierDefaults[tier]]);
  }
  return out;
}

/** Layers, highest first → for each field the first one that's set. */
export function mergeCopy(...layers) {
  const out = {};
  for (const layer of layers.slice().reverse()) Object.assign(out, compact(layer || {}));
  delete out.tiers;
  return out;
}

/* ---------- the template row (models/EmailTemplate.js) ---------- */

/** EmailTemplate row → { ...every field set on it, tiers? } (subject, headline and message from their own columns). */
export function templateCopy(t, email = "speaker") {
  if (!t) return {};
  const keys = keysFor(email);
  const fields = t.fields && typeof t.fields === "object" ? t.fields : {};
  const out = {};
  for (const [k, v] of Object.entries(fields)) if (k !== "tiers" && keys.has(k) && isSet(v)) out[k] = v;
  for (const k of ["subject", "headline", "message"]) if (isSet(t[k])) out[k] = t[k];
  if (fields.tiers && email !== "speaker") {
    const tiers = compact({ tiers: fields.tiers }).tiers;
    if (tiers) out.tiers = tiers;
  }
  return out;
}

/** The template's fields for one pass type (the generic ones + that type's), for the builders. */
export function templateFor(copy = {}, tier = "") {
  const key = tierFor(tier);
  return mergeCopy(copy?.tiers?.[key] || {}, copy);
}

/* ---------- a template's list for a pass type, with this pass's own rules ---------- */

const headOf = (row) => (Array.isArray(row) ? row[0] : row);
// Rows that are "the same thing" whatever the wording: the pass extras (CxO Breakfasts, luncheons, the Gala
// Dinner, the Awards Night: services/passExtras.js), the VIP Lounge, else the same heading.
const family = (row) => {
  const h = String(headOf(row) || "").toLowerCase();
  return /cxo breakfast/.test(h) ? "cxo" : /vip lounge/.test(h) ? "lounge" : /lunch/.test(h) ? "lunch"
    : /\bgala\b/.test(h) ? "gala" : /\bawards?\b/.test(h) ? "awards" : `=${h.trim()}`;
};
/** The pass extra a row of a pass's list is ("cxo" | "lunch" | "gala" | "awards"), else "". */
export const extraOfRow = (row) => { const f = family(row); return ["cxo", "lunch", "gala", "awards"].includes(f) ? f : ""; };

/**
 * A template's list for a pass type, with what this pass changes on top of its type's list carried
 * over: rows the pass gained (a pass extra switched on for one person: the CxO Breakfasts, the luncheons,
 * the Gala Dinner, the Awards Night) are added after the row they follow, rows it lost (switched off)
 * are taken out. `base`: the type's built-in list; `own`:
 * this pass's built-in list. Works for [heading, detail] rows and plain lines.
 */
export function carryPassRules(list = [], base = [], own = []) {
  const inList = (rows, row) => rows.some((r) => family(r) === family(row));
  const lost = base.filter((r) => !inList(own, r));
  const out = list.filter((r) => !inList(lost, r)).map((r) => (Array.isArray(r) ? [...r] : r));
  own.forEach((row, i) => {
    if (inList(base, row) || inList(out, row)) return;
    const prev = own[i - 1];
    const at = prev ? out.findIndex((r) => family(r) === family(prev)) : -1;
    out.splice(prev ? (at >= 0 ? at + 1 : out.length) : 0, 0, Array.isArray(row) ? [...row] : row);
  });
  return out;
}

/** A ticket type → the template's tier key (the retired "vip" type reads as Apex). */
export function tierFor(tier) {
  const k = String(tier || "").trim().toLowerCase();
  return k === "vip" ? "apex" : k;
}

/** The $set for an EmailTemplate from cleaned fields: subject / headline / message in their columns, the rest in `fields`. */
export function templateSet(clean = {}, by = "") {
  const c = compact(clean);
  const { subject = "", headline = "", message = "", ...rest } = c;
  return { subject, headline, message, fields: rest, updatedBy: by };
}

/** "preheader, includes (Power)" — which fields differ between two copies (for the audit log). */
export function changedFields(before = {}, after = {}) {
  const a = compact(before);
  const b = compact(after);
  const out = [];
  const same = (x, y) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k === "tiers") continue;
    if (!same(a[k], b[k])) out.push(b[k] === undefined ? `${k} reset` : k);
  }
  for (const tier of TIERS) {
    const x = a.tiers?.[tier] || {};
    const y = b.tiers?.[tier] || {};
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (!same(x[k], y[k])) out.push(`${k}${y[k] === undefined ? " reset" : ""} (${tier})`);
    }
  }
  return out;
}

/* ---------- filling in and rendering ---------- */

const PLACEHOLDER = /\{(firstName|fullName|name|passName|ticketId|sessions)\}/g;

/** Placeholders → values, in one pass (a name that contains "{fullName}" isn't filled again). */
export function fillText(text, vars = {}) {
  return String(text ?? "").replace(PLACEHOLDER, (m, k) => {
    const v = k === "name" ? vars.fullName : vars[k];
    return v === undefined || v === null ? m : String(v);
  });
}

const EMAIL = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/**
 * Staff text → HTML: escaped, placeholders filled (escaped too), line breaks → <br>.
 * `wrap`: { passName: (escapedValue) => html } styles a placeholder's value (e.g. bold);
 * `links`: email addresses become mailto links with this style.
 */
export function textHtml(text, vars = {}, { wrap = {}, links = "" } = {}) {
  let html = esc(String(text ?? "")).replace(PLACEHOLDER, (m, k) => {
    const key = k === "name" ? "fullName" : k;
    const v = vars[key];
    if (v === undefined || v === null) return m;
    const e = esc(v);
    return wrap[key] ? wrap[key](e) : e;
  });
  if (links) html = html.replace(EMAIL, (addr) => `<a href="mailto:${addr}" style="${links}">${addr}</a>`);
  return html.replace(/\n/g, "<br>");
}
