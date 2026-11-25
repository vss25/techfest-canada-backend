import { parseVideoUrl } from "./videoLinks.js";
/* Field rules for the Sanity types the admin panel edits — mirrors
   techfest-canada/schemaTypes in the website repo. Pure, unit-tested. */

const str = (max) => ({ kind: "string", max });
const url = { kind: "url" };
const num = { kind: "number" };
const bool = { kind: "boolean" };
const img = { kind: "image" };
const oneOf = (...values) => ({ kind: "enum", values });

const time = { kind: "time" };
const people = { kind: "people" };
const person = { kind: "person" };
const scale = { kind: "number", min: 30, max: 250 };   // logo size, % of the default
const stats = { kind: "stats" };                        // About page numbers: [{ value, suffix?, label, iconName? }]
const date = { kind: "date" };                          // "YYYY-MM-DD"
const images = { kind: "images" };                      // photo gallery: [image] (asset ids), at most 24
const refs = { kind: "refs" };                          // event ids → [{ _type: "reference", _ref }]
const ref = { kind: "ref" };                            // one document id → { _type: "reference", _ref }
const eventRows = { kind: "eventRows" };                // a partner's Partners page row for each event: [{ event, row }]
const facts = { kind: "facts" };                        // [{ label, value }] — "What we know so far"
const steps = { kind: "steps" };                        // [{ label, when?, done? }] — "Coming next"
const video = { kind: "video" };                        // a YouTube / Vimeo link (services/videoLinks.js); sets provider + videoId too

const LOGO_TYPE = { name: { ...str(100), required: true }, logo: { ...img, required: true }, url, order: num, active: bool, logoScale: scale };

/* Where a partner shows: the website and the apps each have their own switch on
   the same record. Missing = shown; `active` stays the master switch (off = hidden
   everywhere). New partners get both switches on. */
const shown = { ...bool, default: true };
export const SPONSOR_DESCRIPTION_MAX = 600;

/** The shade over an event's hero photo or video (website src/lib/heroShade.js; "default" = the usual fade). */
export const HERO_SHADES = ["default", "light", "strong", "brand", "none"];

/** Per-session live polls / audience Q&A switch (services/sessionLive.js has the rule). */
export const LIVE_MODES = ["auto", "on", "off"];
const liveMode = { ...oneOf(...LIVE_MODES), default: "auto" };

export const SESSION_FORMATS = ["opening", "keynote", "fireside", "panel", "briefing", "provocation", "dialogue", "networking", "break", "awards", "closing", "Performance"];

export const PARTNER_ROWS = ["featured", "ai", "quantum", "cyber", "robotics", "cleantech",
  "health", "bfsi", "supply", "defence", "energy", "ecosystem"];

export const CMS_FIELDS = {
  speaker: {
    name: { ...str(120), required: true },
    title: { ...str(160), required: true },
    company: { ...str(160), required: true },
    bio: str(2000),
    image: { ...img, required: true },
    // Nov 19 2026: the photo as uploaded, kept so the admin's photo studio can redo the speaker photo.
    imageOriginal: img,
    order: { ...num, required: true },
    rowPosition: num,
    featured: bool,
    speakerType: oneOf("speaker", "keynote", "panelist", "moderator"),
    techPillar: oneOf("ai", "cybersecurity", "cloud-data", "emerging-tech"),
    sector: oneOf("healthcare-life-sci", "manufacturing-supply", "government", "financial-services", "energy", "media"),
    linkedin: url, twitter: url, github: url, website: url,
    events: refs,                             // which events this speaker appears on (empty = every event)
  },
  partner: {
    name: { ...str(120), required: true },
    category: { ...oneOf("partnersAndSupporters", "governmentPartners", "industryAssociates", "academicResearchInstitutions",
      "corporateEnterprisePartners", "startupEcosystemPartners", "internationalTradeBodies", "other"), required: true },
    logo: { ...img, required: true },
    url, order: num, active: bool, logoScale: scale,
    // Partners page row (website src/data/partnerMatrix.js): paid partners, 5 tech pillars, 5 applied sectors, ecosystem
    matrixGroup: oneOf(...PARTNER_ROWS),
    // Nov 18 2026: a partner can sit in a different row for each event (Featured in Vancouver,
    // AI in Toronto). An event without its own row uses matrixGroup.
    events: refs,                             // which events it shows on (empty = every event)
    eventRows,
    // Sponsors = partners in the "featured" row (paid partners). The apps show this on
    // their Sponsors cards; the website as a tooltip on the logo.
    description: str(SPONSOR_DESCRIPTION_MAX),
    showOnWebsite: shown,
    showInApp: shown,
  },
  sponsor: LOGO_TYPE,
  sponsorMarquee: LOGO_TYPE,
  homeSponsor: LOGO_TYPE,
  // partnersShowCurrentYear (Nov 18 2026): the Partners page opens on the most recently completed
  // year's partners; on = it opens on the current year's instead.
  siteSettings: { attendeesCarouselEnabled: bool, speakersEnabled: bool, partnersShowCurrentYear: bool },
  // The About page (website src/components/AboutUs.tsx): only its numbers are edited here; other fields are left as they are.
  aboutContent: { stats },
  // One agenda slot. Mirrors the website's src/data/agenda.js shape.
  session: {
    sessionId: str(40),                       // stable id used by the app ("d1-06")
    day: { ...oneOf(1, 2), required: true },
    time: { ...time, required: true },        // "HH:MM", 24-hour, Toronto time
    endTime: { ...time, required: true },
    title: { ...str(200), required: true },
    type: str(60),                            // label shown on the card, e.g. "Fireside Chat"
    format: oneOf(...SESSION_FORMATS),        // drives the colour/style
    featured: bool,
    isBreak: bool,
    pillar: oneOf("ai", "quantum", "cybersecurity", "robotics", "climate"),   // "climate" is the stored key for Clean Tech (renamed Nov 25 2026; key kept so saved sessions still match)
    sector: oneOf("fintech", "healthcare", "energy", "manufacturing", "public", "startups"),
    speakers: people,                         // [{ name, org?, tentative? }]
    moderator: person,                        // { name, org? }
    stage: str(80),
    description: str(1500),
    // "auto" (on when there's a moderator, never keynotes or breaks) | "on" | "off"; missing = "auto"
    polls: liveMode,
    qa: liveMode,
    events: refs,                             // which events this session belongs to (empty = every event)
  },
  // One TTFC event's public page (website src/lib/events.js + src/redesign). Edited as a draft,
  // previewed on the website, then published (routes/cms.js: ?draft=1, /publish).
  event: {
    name: { ...str(120), required: true },
    city: { ...str(60), required: true },
    type: { ...oneOf("briefing", "main-event"), required: true },
    year: { ...num, required: true },
    startDate: date,
    endDate: date,
    statusNote: str(120),                     // "February 2027 · One day" while the day isn't fixed
    venueName: str(160),
    venueAddress: str(300),
    description: str(3000),
    heroImage: img,                           // the previous design's top photo (still read by the old pages)
    citySkyline: img,                         // "City photo" on the approved design (redesign step 2)
    heroVideoUrl: url,
    heroShade: { ...oneOf(...HERO_SHADES), default: "default" },   // the shade over the hero photo / video (Nov 25 2026)
    heroMedia: oneOf("photo", "video"),       // what the top of the page shows, on phones and computers (unset: the video when there is one)
    heroFocus: { kind: "number", min: 0, max: 100 },  // framing: 0 = show the top, 100 = the bottom (unset: the design's own)
    heroHeight: oneOf("standard", "tall", "full"),   // how tall the top of the page is (unset: standard)
    photoCredit: str(200),                    // shown on the photo, e.g. "Photo: Kyle Pearce, CC BY-SA 2.0"
    theme: str(120),                          // "Energy & Critical Infrastructure"
    tagline: str(240),                        // one line under the event name
    formatLine: str(120),                     // "One day · 8 sessions"
    audience: str(160),                       // "150 senior delegates"
    pageMode: { ...oneOf("auto", "coming-soon", "full"), default: "auto" },
    knownSoFar: facts,
    comingNext: steps,
    notifyHeading: str(120),
    showReport: { ...bool, default: true },   // the Toronto 2026 post-show report card
    gallery: images,                          // photo strip on the event page (redesign step 2)
    // Until this event has its own speakers / partners, the page shows another event's (Nov 22 2026, the owner):
    // which event, which people or logos (empty = featured first), and the note above them. Empty = Toronto 2026.
    standInSpeakersFrom: ref,
    standInSpeakers: refs,
    standInSpeakersHeading: str(120),
    standInSpeakersText: str(500),
    standInPartnersFrom: ref,
    standInPartners: refs,
    standInPartnersHeading: str(120),
    standInPartnersText: str(500),
  },
  // A YouTube or Vimeo video shown on the website (Nov 18 2026). Only the link is stored; the
  // provider streams it. Where it shows: the home page, the Media page, chosen events, chosen speakers.
  video: {
    title: { ...str(160), required: true },
    url: { ...video, required: true },
    provider: oneOf("youtube", "vimeo"),      // set from the link
    videoId: str(40),                         // set from the link
    thumbnailUrl: url,
    description: str(500),
    recordedOn: date,
    showOnHome: bool,
    showOnMedia: { ...bool, default: true },
    events: refs,                             // event pages it shows on
    speakers: refs,                           // speakers' talks
    order: num,
    active: { ...bool, default: true },
  },
  // The home page (redesign step 2): one document, id "homePage". Edited as a draft, previewed, then published.
  homePage: {
    heroEyebrow: str(120),
    heroHeadline: str(160),
    heroText: str(400),
    heroImage: img,
    heroVideoUrl: url,
    primaryCtaLabel: str(40),
    primaryCtaUrl: str(300),
    secondaryCtaLabel: str(40),
    secondaryCtaUrl: str(300),
    eventsHeading: str(120),
    eventsText: str(300),
    highlightsHeading: str(120),
    highlightsText: str(600),
    stats,                                    // [{ value, suffix?, label }], at most 8
    highlightPhotos: images,
    recapVideoUrl: url,
    reportTitle: str(120),
    reportText: str(300),
    reportUrl: str(300),
    partnersHeading: str(120),
    partnerCtaHeading: str(120),
    partnerCtaText: str(300),
  },
};

export const CMS_TYPES = Object.keys(CMS_FIELDS);

/* Audit log detail. Most fields are listed by name; these also show their value
   ("showInApp=false", "polls=off"), and a cleared one shows what it falls back to. */
const AUDIT_VALUE_FIELDS = { polls: "auto", qa: "auto", showOnWebsite: "true", showInApp: "true" };
const auditValue = (k, set, unset) => (unset.includes(k) ? AUDIT_VALUE_FIELDS[k] : set[k]);

/** Edit: "name, showInApp=false, polls=auto". Pure. */
export function auditEditDetail(set = {}, unset = []) {
  return Object.keys(set).concat(unset)
    .map((k) => (k in AUDIT_VALUE_FIELDS ? `${k}=${auditValue(k, set, unset)}` : k)).join(", ");
}

/** Create: "IBM · showOnWebsite=true, showInApp=true". Pure. */
export function auditCreateDetail(set = {}) {
  const values = Object.keys(AUDIT_VALUE_FIELDS).filter((k) => set[k] !== undefined).map((k) => `${k}=${set[k]}`).join(", ");
  return [set.name || set.title || "", values].filter(Boolean).join(" · ");
}
export const cmsFieldsFor = (type) => CMS_FIELDS[type] || null;

const keyFor = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 10);

/** { name, org?, tentative? } with trimmed strings, or null when there's no name. Pure. */
export function cleanPerson(p) {
  if (!p || typeof p !== "object") return null;
  const name = String(p.name || "").trim().slice(0, 120);
  if (!name) return null;
  const out = { name };
  const org = String(p.org || "").trim().slice(0, 160);
  if (org) out.org = org;
  if (p.tentative === true) out.tentative = true;
  return out;
}

/** One About page number → { _key, value, suffix?, label, iconName? }, or null without a label. Pure. */
export function cleanStat(s, i = 0) {
  if (!s || typeof s !== "object") return null;
  const label = String(s.label || "").trim().slice(0, 60);
  const value = Number(s.value);
  if (!label || !Number.isFinite(value) || value < 0) return null;
  const out = { _key: /^[A-Za-z0-9_-]{1,40}$/.test(String(s._key || "")) ? String(s._key) : `s${i}${keyFor(label)}`, value, label };
  const suffix = String(s.suffix || "").trim().slice(0, 4);
  if (suffix) out.suffix = suffix;
  const icon = String(s.iconName || "").trim();
  if (/^[a-z][a-z0-9-]{0,29}$/.test(icon)) out.iconName = icon;
  return out;
}

/** Crop/hotspot box: all listed keys numbers 0..1 → object; missing → null; invalid → false. */
function cleanBox(b, keys) {
  if (!b) return null;
  const out = {};
  for (const k of keys) {
    const n = Number(b[k]);
    if (!Number.isFinite(n) || n < 0 || n > 1) return false;
    out[k] = Math.round(n * 10000) / 10000;
  }
  return out;
}

/** Website/app session → Sanity document fields (for the one-time import). Pure. */
export function sessionDoc(s) {
  const { set, error } = toSanityPatch("session", {
    sessionId: s.id, day: s.day, time: s.time, endTime: s.endTime, title: s.title, type: s.type,
    format: SESSION_FORMATS.includes(s.format) ? s.format : undefined, featured: !!s.featured, isBreak: !!s.isBreak,
    pillar: s.pillar, sector: s.sector, speakers: s.speakers || [], moderator: s.moderator, stage: s.stage, description: s.description,
    polls: LIVE_MODES.includes(s.polls) ? s.polls : undefined, qa: LIVE_MODES.includes(s.qa) ? s.qa : undefined,
  }, { creating: true });
  const id = String(s.id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60) || String(Date.now());
  return error ? { error } : { doc: { _id: `session-${id}`, _type: "session", ...set } };
}

const keyFor2 = (s, i) => `k${i}${String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12)}`;

/** [{label, value}] for "What we know so far": both required, at most 8. Pure. */
export function cleanFacts(v) {
  if (!Array.isArray(v)) return { error: "must be a list" };
  if (v.length > 8) return { error: "at most 8 rows" };
  const rows = [];
  for (const [i, f] of v.entries()) {
    const label = String(f?.label || "").trim().slice(0, 60);
    const value = String(f?.value || "").trim().slice(0, 160);
    if (!label && !value) continue;
    if (!label || !value) return { error: "every row needs a label and a value" };
    rows.push({ _key: keyFor2(label, i), label, value });
  }
  return { rows };
}

/** [{label, when?, done?}] for "Coming next": label required, at most 8. Pure. */
export function cleanSteps(v) {
  if (!Array.isArray(v)) return { error: "must be a list" };
  if (v.length > 8) return { error: "at most 8 steps" };
  const rows = [];
  for (const [i, st] of v.entries()) {
    const label = String(st?.label || "").trim().slice(0, 120);
    if (!label) continue;
    const row = { _key: keyFor2(label, i), label };
    const when = String(st?.when || "").trim().slice(0, 60);
    if (when) row.when = when;
    if (st?.done === true) row.done = true;
    rows.push(row);
  }
  return { rows };
}

/** Body → { set, unset, error }. Images arrive as asset ids (`image: "image-abc…-png"`).
    `draft: true` (the panel's saves, autosave included, Nov 18 2026): required fields may be
    empty or missing; they're checked when the item is sent to staging (missingRequired). */
export function toSanityPatch(type, body, { creating, draft = false }) {
  const fields = CMS_FIELDS[type];
  if (!fields) return { set: {}, unset: [], error: "Unknown content type" };
  const set = {};
  const unset = [];
  for (const [key, rule] of Object.entries(fields)) {
    if (!(key in body) || body[key] === undefined) continue;
    const v = body[key];
    if (v === null || v === "") {
      if (rule.required && !draft) return { set, unset, error: `${key} is required` };
      unset.push(key); continue;
    }
    switch (rule.kind) {
      case "string": set[key] = String(v).trim().slice(0, rule.max); break;
      case "video": {
        const parsed = parseVideoUrl(v);
        if (!parsed) return { set, unset, error: "Paste a YouTube or Vimeo link" };
        set[key] = parsed.url;
        set.provider = parsed.provider;
        set.videoId = parsed.videoId;
        break;
      }
      case "url": {
        let u = String(v).trim();
        if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
        try { new URL(u); } catch { return { set, unset, error: `${key} isn't a valid link` }; }
        set[key] = u.slice(0, 500); break;
      }
      case "number": {
        const n = Number(v);
        if (!Number.isFinite(n)) return { set, unset, error: `${key} must be a number` };
        if (rule.min !== undefined && (n < rule.min || n > rule.max)) return { set, unset, error: `${key} must be between ${rule.min} and ${rule.max}` };
        set[key] = n; break;
      }
      case "time": {
        const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(v).trim());
        if (!m) return { set, unset, error: `${key} must be a time like 09:30` };
        set[key] = `${m[1].padStart(2, "0")}:${m[2]}`; break;
      }
      case "person": {
        const p = cleanPerson(v);
        if (!p) { unset.push(key); break; }
        set[key] = p; break;
      }
      case "people": {
        if (!Array.isArray(v)) return { set, unset, error: `${key} must be a list` };
        set[key] = v.map(cleanPerson).filter(Boolean).slice(0, 20).map((p, i) => ({ _key: `p${i}${keyFor(p.name)}`, ...p }));
        break;
      }
      case "stats": {
        if (!Array.isArray(v)) return { set, unset, error: `${key} must be a list` };
        if (v.length > 8) return { set, unset, error: `${key}: at most 8 numbers` };
        const rows = v.map(cleanStat);
        if (rows.some((r) => !r)) return { set, unset, error: `${key}: every number needs a value and a label` };
        set[key] = rows; break;
      }
      case "boolean": set[key] = v === true || v === "true"; break;
      case "images": {
        if (!Array.isArray(v)) return { set, unset, error: `${key} must be a list` };
        if (v.length > 24) return { set, unset, error: `${key}: at most 24 photos` };
        const out = [];
        for (const [i, item] of v.entries()) {
          const id = typeof item === "object" ? String(item?.asset?._ref || item?.asset || "") : String(item || "");
          if (!/^image-[A-Za-z0-9]+-\d+x\d+-[a-z0-9]+$/.test(id)) return { set, unset, error: `${key}: upload each photo first` };
          const alt = typeof item === "object" ? String(item.alt || "").trim().slice(0, 200) : "";
          out.push({ _key: `g${i}${id.slice(6, 14)}`, _type: "image", asset: { _type: "reference", _ref: id }, ...(alt ? { alt } : {}) });
        }
        if (!out.length) { unset.push(key); break; }
        set[key] = out; break;
      }
      case "date": {
        const d = String(v).trim();
        const real = /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(new Date(`${d}T12:00:00Z`).getTime())
          && new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) === d;
        if (!real) return { set, unset, error: `${key} must be a date like 2027-02-18` };
        set[key] = d; break;
      }
      case "refs": {
        if (!Array.isArray(v)) return { set, unset, error: `${key} must be a list` };
        const ids = [...new Set(v.map((x) => String(x || "").trim()).filter(Boolean))];
        if (ids.some((x) => !/^[A-Za-z0-9._-]{1,128}$/.test(x) || x.startsWith("drafts."))) return { set, unset, error: `${key}: unknown event` };
        if (!ids.length) { unset.push(key); break; }
        set[key] = ids.slice(0, 20).map((x, i) => ({ _key: `e${i}${x.replace(/[^A-Za-z0-9]/g, "").slice(-10)}`, _type: "reference", _ref: x }));
        break;
      }
      case "ref": {
        const id = String((typeof v === "object" ? v?._ref : v) || "").trim();
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(id) || id.startsWith("drafts.")) return { set, unset, error: `${key}: unknown item` };
        set[key] = { _type: "reference", _ref: id };
        break;
      }
      case "eventRows": {
        if (!Array.isArray(v)) return { set, unset, error: `${key} must be a list` };
        const seen = new Map();
        for (const item of v) {
          const ev = String(item?.event?._ref || item?.event || "").trim();
          const row = String(item?.row || "").trim();
          if (!ev && !row) continue;
          if (!/^[A-Za-z0-9._-]{1,128}$/.test(ev) || ev.startsWith("drafts.")) return { set, unset, error: `${key}: unknown event` };
          if (!PARTNER_ROWS.includes(row)) return { set, unset, error: `${key}: unknown row` };
          seen.set(ev, row);
        }
        if (!seen.size) { unset.push(key); break; }
        set[key] = [...seen].slice(0, 20).map(([ev, row], i) => ({ _key: `r${i}${ev.replace(/[^A-Za-z0-9]/g, "").slice(-10)}`, event: { _type: "reference", _ref: ev }, row }));
        break;
      }
      case "facts":
      case "steps": {
        const out = rule.kind === "facts" ? cleanFacts(v) : cleanSteps(v);
        if (out.error) return { set, unset, error: `${key}: ${out.error}` };
        if (!out.rows.length) { unset.push(key); break; }
        set[key] = out.rows; break;
      }
      case "enum": {
        const val = rule.values.includes(v) ? v : rule.values.find((x) => String(x) === String(v));
        if (val === undefined) return { set, unset, error: `${key} must be one of: ${rule.values.join(", ")}` };
        set[key] = val; break;
      }
      case "image": {
        // Either an asset id ("image-…") or { asset, crop?, hotspot? } from the framing tool.
        const id = typeof v === "object" ? String(v.asset || "") : String(v);
        if (!/^image-[A-Za-z0-9]+-\d+x\d+-[a-z0-9]+$/.test(id)) return { set, unset, error: `${key}: upload the image first` };
        const out = { _type: "image", asset: { _type: "reference", _ref: id } };
        if (typeof v === "object") {
          const crop = cleanBox(v.crop, ["top", "bottom", "left", "right"]);
          const hotspot = cleanBox(v.hotspot, ["x", "y", "width", "height"]);
          if (crop === false || hotspot === false) return { set, unset, error: `${key}: framing values must be between 0 and 1` };
          if (crop) out.crop = { _type: "sanity.imageCrop", ...crop };
          if (hotspot) out.hotspot = { _type: "sanity.imageHotspot", ...hotspot };
        }
        set[key] = out; break;
      }
      default: break;
    }
  }
  // A video's provider and id always come from its link, whatever else was sent.
  if (fields.url?.kind === "video" && set.url) {
    const parsed = parseVideoUrl(set.url);
    Object.assign(set, { provider: parsed.provider, videoId: parsed.videoId });
    for (const k of ["provider", "videoId"]) { const i = unset.indexOf(k); if (i >= 0) unset.splice(i, 1); }
  }
  if (creating) {
    for (const [key, rule] of Object.entries(fields)) {
      if (rule.required && !draft && set[key] === undefined) return { set, unset, error: `${key} is required` };
    }
    if ("active" in fields && set.active === undefined) set.active = true;
    for (const [key, rule] of Object.entries(fields)) {
      if (rule.default !== undefined && set[key] === undefined) set[key] = rule.default;
    }
  }
  return { set, unset, error: null };
}

/* The required fields a saved document still lacks, in words ("photo", "job title"), so
   "Send to staging" can say what to add. Pure. */
const REQUIRED_WORDS = { image: "photo", logo: "logo", title: "title", endTime: "end time", time: "start time", url: "link", order: "order number", day: "day", company: "company", name: "name", city: "city", type: "type", year: "year", category: "category" };
const REQUIRED_WORDS_BY_TYPE = { speaker: { title: "job title", name: "full name" } };
export function missingRequired(type, doc = {}) {
  const fields = CMS_FIELDS[type];
  if (!fields) return [];
  const out = [];
  for (const [key, rule] of Object.entries(fields)) {
    if (!rule.required) continue;
    const v = doc?.[key];
    const empty = rule.kind === "image" ? !(v?.asset?._ref || (typeof v === "string" && v))
      : v === undefined || v === null || (typeof v === "string" && !v.trim());
    if (empty) out.push(REQUIRED_WORDS_BY_TYPE[type]?.[key] || REQUIRED_WORDS[key] || key);
  }
  return out;
}
