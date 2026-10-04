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

const LOGO_TYPE = { name: { ...str(100), required: true }, logo: { ...img, required: true }, url, order: num, active: bool, logoScale: scale };

export const SESSION_FORMATS = ["opening", "keynote", "fireside", "panel", "briefing", "provocation", "dialogue", "networking", "break", "awards", "closing", "Performance"];

export const CMS_FIELDS = {
  speaker: {
    name: { ...str(120), required: true },
    title: { ...str(160), required: true },
    company: { ...str(160), required: true },
    bio: str(2000),
    image: { ...img, required: true },
    order: { ...num, required: true },
    rowPosition: num,
    featured: bool,
    speakerType: oneOf("speaker", "keynote", "panelist", "moderator"),
    techPillar: oneOf("ai", "cybersecurity", "cloud-data", "emerging-tech"),
    sector: oneOf("healthcare-life-sci", "manufacturing-supply", "government", "financial-services", "energy", "media"),
    linkedin: url, twitter: url, github: url, website: url,
  },
  partner: {
    name: { ...str(120), required: true },
    category: { ...oneOf("partnersAndSupporters", "governmentPartners", "industryAssociates", "academicResearchInstitutions",
      "corporateEnterprisePartners", "startupEcosystemPartners", "internationalTradeBodies", "other"), required: true },
    logo: { ...img, required: true },
    url, order: num, active: bool, logoScale: scale,
  },
  sponsor: LOGO_TYPE,
  sponsorMarquee: LOGO_TYPE,
  homeSponsor: LOGO_TYPE,
  siteSettings: { attendeesCarouselEnabled: bool, speakersEnabled: bool },
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
    pillar: oneOf("ai", "quantum", "cybersecurity", "robotics", "climate"),
    sector: oneOf("fintech", "healthcare", "energy", "manufacturing", "public", "startups"),
    speakers: people,                         // [{ name, org?, tentative? }]
    moderator: person,                        // { name, org? }
    stage: str(80),
    description: str(1500),
  },
};

export const CMS_TYPES = Object.keys(CMS_FIELDS);
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
  }, { creating: true });
  const id = String(s.id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60) || String(Date.now());
  return error ? { error } : { doc: { _id: `session-${id}`, _type: "session", ...set } };
}

/** Body → { set, unset, error }. Images arrive as asset ids (`image: "image-abc…-png"`). */
export function toSanityPatch(type, body, { creating }) {
  const fields = CMS_FIELDS[type];
  if (!fields) return { set: {}, unset: [], error: "Unknown content type" };
  const set = {};
  const unset = [];
  for (const [key, rule] of Object.entries(fields)) {
    if (!(key in body) || body[key] === undefined) continue;
    const v = body[key];
    if (v === null || v === "") {
      if (rule.required) return { set, unset, error: `${key} is required` };
      unset.push(key); continue;
    }
    switch (rule.kind) {
      case "string": set[key] = String(v).trim().slice(0, rule.max); break;
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
      case "boolean": set[key] = v === true || v === "true"; break;
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
  if (creating) {
    for (const [key, rule] of Object.entries(fields)) {
      if (rule.required && set[key] === undefined) return { set, unset, error: `${key} is required` };
    }
    if ("active" in fields && set.active === undefined) set.active = true;
  }
  return { set, unset, error: null };
}
