/* =========================================================
   Marketing › Post templates (Nov 23 2026): blank designs staff upload, with the rules for where everything goes.
   Pure parts only; routes in routes/postTemplates.js, the drawing in the admin (src/admin/marketing/postArt.js).

   The owner: "how do I create/upload blank templates, how do I ensure that there are set guidelines such as if
   there is an individual speaker, then the image should be somewhere on the grid ideally with recommended
   centering, if there are 2 speaker panels, the spacing should be so and so … if there is logo/partnership
   alignment then the logo/content should be x characters long and the logo placement should be so and so."

   A template = one kind of post (keynote: one speaker, session: a panel, partner, event: a call to action) with a
   layout per channel: the blank artwork (a Sanity image: public marketing art, nothing private) and boxes, each a
   share (0…1) of the image: where the title, tag, date, venue, people, name, logo, event photo, link and TTFC logo
   go, with their rules (alignment, colours, sizes, lines, character limits; for people the gap, card style and
   how many per row; for images contain or cover). Draft until management marks it ready; only ready ones are
   offered when a post is created.
========================================================= */

export const KINDS = ["keynote", "session", "partner", "event"];
export const CHANNELS = ["linkedin", "x", "instagram"];
export const SIZES = { linkedin: { keynote: [1200, 1200], session: [1200, 995], partner: [1200, 1200], event: [1200, 1200] }, x: [1600, 900], instagram: [1080, 1350] };
export const sizeOf = (kind, channel) => (channel === "linkedin" ? SIZES.linkedin[kind] || [1200, 1200] : SIZES[channel]);

/** The boxes each kind can use. Text boxes carry text rules; image boxes carry fit; "people" carries the layout rules. */
export const BOXES = {
  keynote: ["tag", "title", "when", "venue", "people", "name", "role", "footer", "brand"],
  session: ["tag", "title", "when", "venue", "people", "footer", "brand"],
  partner: ["tag", "title", "when", "venue", "logo", "footer", "brand"],
  event: ["tag", "title", "when", "venue", "photo", "footer", "brand"],
};
export const TEXT_BOXES = ["tag", "title", "when", "venue", "name", "role", "footer"];
export const IMAGE_BOXES = ["logo", "photo", "brand"];

const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v || "")) ? String(v).toUpperCase() : d);
const num = (v, min, max, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const int = (v, min, max, d) => Math.round(num(v, min, max, d));
const pick = (v, list, d) => (list.includes(v) ? v : d);
const str = (v, max) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);

/** One box from the editor → a clean box (never throws; out-of-range values are clamped). */
export function cleanBox(key, b = {}) {
  const x = num(b.x, 0, 1, 0.05), y = num(b.y, 0, 1, 0.05);
  const out = {
    on: b.on !== false,
    x, y, w: num(b.w, 0.02, 1 - x, Math.min(0.5, 1 - x)), h: num(b.h, 0.02, 1 - y, Math.min(0.2, 1 - y)),
    align: pick(b.align, ["left", "center", "right"], "left"),
    valign: pick(b.valign, ["top", "middle", "bottom"], "top"),
  };
  if (TEXT_BOXES.includes(key)) Object.assign(out, {
    color: hex(b.color, "#141414"), accent: hex(b.accent, "#7B3B9E"),
    size: int(b.size, 8, 300, 40), minSize: int(b.minSize, 6, 300, 18),
    maxLines: int(b.maxLines, 1, 8, 2), maxChars: int(b.maxChars, 0, 500, 0),
    weight: pick(Number(b.weight), [400, 500, 600, 700], 600), italic: !!b.italic, upper: !!b.upper,
    twoTone: key === "title" ? b.twoTone !== false : false,
    fill: hex(b.fill, "") || "",      // a background behind the text (the grey tag), "" = none
  });
  if (out.minSize > out.size) out.minSize = out.size;
  if (key === "people") Object.assign(out, {
    card: pick(b.card, ["card", "cutout", "photo"], "card"), cardColor: hex(b.cardColor, "#6D3A97"),
    radius: num(b.radius, 0, 0.5, 0.14), gap: num(b.gap, 0, 0.3, 0.03), perRow: int(b.perRow, 1, 6, 6),
    labels: b.labels !== false, labelColor: hex(b.labelColor, "#141414"), nameColor: hex(b.nameColor, "#7B3B9E"),
    maxCard: num(b.maxCard, 0.1, 1, 0.3),    // the widest a card gets, as a share of the image width (one speaker stays this size, centred)
  });
  if (IMAGE_BOXES.includes(key)) Object.assign(out, {
    fit: pick(b.fit, ["contain", "cover"], key === "photo" ? "cover" : "contain"),
    card: hex(b.card, "") || "", radius: num(b.radius, 0, 0.5, 0.04),
    minPx: int(b.minPx, 0, 4000, key === "logo" ? 300 : 0),   // warn when the logo file is narrower than this
    variant: key === "brand" ? pick(b.variant, ["dark", "white"], "dark") : undefined,
  });
  return out;
}

/** A template from the editor → { value } or { error }. */
export function cleanTemplate(body = {}, prev = {}) {
  const kind = pick(body.kind ?? prev.kind, KINDS, "");
  if (!kind) return { error: "Pick what the template is for: a speaker, a panel, a partner or an event." };
  const name = str(body.name ?? prev.name, 80);
  if (!name) return { error: "Give the template a name." };
  const channels = {};
  for (const c of CHANNELS) {
    const src = body.channels?.[c] === undefined ? prev.channels?.[c] : body.channels[c];
    if (!src) { channels[c] = null; continue; }
    const bg = src.background || {};
    if (bg.url && !/^https:\/\/cdn\.sanity\.io\/images\//.test(String(bg.url))) return { error: "Blank designs are uploaded to the website's image library." };
    const boxes = {};
    for (const key of BOXES[kind]) if (src.boxes?.[key]) boxes[key] = cleanBox(key, src.boxes[key]);
    channels[c] = { background: bg.url ? { url: str(bg.url, 500), w: int(bg.w, 1, 10000, 0), h: int(bg.h, 1, 10000, 0) } : null, boxes };
  }
  const status = pick(body.status ?? prev.status, ["draft", "ready"], "draft");
  const value = { name, kind, status, channels, notes: str(body.notes ?? prev.notes, 500) };
  if (status === "ready") {
    const problems = readyProblems(value);
    if (problems.length) return { error: problems.join(" ") };
  }
  return { value };
}

/** What stops a template being offered when posts are made. */
export function readyProblems(t) {
  const out = [];
  if (!t.channels?.linkedin?.background) out.push("Upload the blank LinkedIn design first.");
  const main = { keynote: "people", session: "people", partner: "logo", event: "title" }[t.kind];
  for (const c of CHANNELS) {
    const ch = t.channels?.[c];
    if (!ch?.background) continue;
    if (!ch.boxes?.title?.on && t.kind !== "partner") out.push(`Place the title on the ${c === "x" ? "X" : c === "linkedin" ? "LinkedIn" : "Instagram"} design.`);
    if (main && !ch.boxes?.[main]?.on) out.push(`Place the ${main === "people" ? "photos" : main} on the ${c === "x" ? "X" : c === "linkedin" ? "LinkedIn" : "Instagram"} design.`);
  }
  return [...new Set(out)];
}
