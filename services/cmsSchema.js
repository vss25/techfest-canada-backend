/* Field rules for the Sanity types the admin panel edits — mirrors
   techfest-canada/schemaTypes in the website repo. Pure, unit-tested. */

const str = (max) => ({ kind: "string", max });
const url = { kind: "url" };
const num = { kind: "number" };
const bool = { kind: "boolean" };
const img = { kind: "image" };
const oneOf = (...values) => ({ kind: "enum", values });

const LOGO_TYPE = { name: { ...str(100), required: true }, logo: { ...img, required: true }, url, order: num, active: bool };

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
    url, order: num, active: bool,
  },
  sponsor: LOGO_TYPE,
  sponsorMarquee: LOGO_TYPE,
  homeSponsor: LOGO_TYPE,
  siteSettings: { attendeesCarouselEnabled: bool, speakersEnabled: bool },
};

export const CMS_TYPES = Object.keys(CMS_FIELDS);
export const cmsFieldsFor = (type) => CMS_FIELDS[type] || null;

/** Body → { set, unset, error }. Images arrive as asset ids (`image: "image-abc…-png"`). */
export function toSanityPatch(type, body, { creating }) {
  const fields = CMS_FIELDS[type];
  if (!fields) return { set: {}, unset: [], error: "Unknown content type" };
  const set = {};
  const unset = [];
  for (const [key, rule] of Object.entries(fields)) {
    if (!(key in body)) continue;
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
        set[key] = n; break;
      }
      case "boolean": set[key] = v === true || v === "true"; break;
      case "enum":
        if (!rule.values.includes(v)) return { set, unset, error: `${key} must be one of: ${rule.values.join(", ")}` };
        set[key] = v; break;
      case "image": {
        const id = String(v);
        if (!/^image-[A-Za-z0-9]+-\d+x\d+-[a-z0-9]+$/.test(id)) return { set, unset, error: `${key}: upload the image first` };
        set[key] = { _type: "image", asset: { _type: "reference", _ref: id } }; break;
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
