import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/* =========================================================
   TTFC 2026 Exhibitor Manual & return form (PDF)
   ---------------------------------------------------------
   Attached to every exhibitor pass email (Admin → Marketing →
   Exhibitor passes). The layout is the marketing team's manual
   (A4, 4 pages: run of show, your booth, ordering extras and
   on-site rules, the return form); every word of it is in
   DEFAULT_MANUAL and staff can change any of it in the admin
   (saved as the "exhibitor-manual" EmailTemplate's content).
   Per exhibitor: company, booth, zone and passes fill page 1's
   allocation band and the booth sign; the pass holder is the first
   badge holder on the return form. The return form stays fillable
   (AcroForm fields), as in the original.

   Pure: buildExhibitorManual(manual, booth) → Promise<Buffer>.
   Unit-tested in test/exhibitor-manual.test.js.
========================================================= */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = process.env.TTFC_FONT_DIR || path.join(__dirname, "fonts");
const ASSET_DIR = path.join(__dirname, "..", "assets", "exhibitor");

/* ---------- the wording (every field is editable in the admin) ---------- */

export const DEFAULT_MANUAL = Object.freeze({
  header: {
    dates: "26-27 Oct 2026",
    venue: "The Westin Harbour Castle, Toronto",
    label: "Exhibitor manual",
    subtitle: "Move-in, run of show & return form",
  },
  title: { bold: "Exhibitor", light: "manual & run of show" },
  keyDates: [
    ["Move-in", "Sun 25 Oct, 6-10 pm"],
    ["Show days", "Mon 26 - Tue 27 Oct"],
    ["Teardown", "Tue 27 Oct, 7:30 pm"],
    ["Return form by", "Friday 16 October 2026"],
  ],
  allocation: {
    title: "Your booth allocation",
    labels: ["Exhibiting company", "Booth no.", "Zone / location", "Passes allotted"],
    note: "Completed by TTFC before this manual is sent to you. Zone A holds booths 01-15 (Harbour Ballroom Foyer); Zone B holds booths 16-25 (Pier 4 & 5 Foyer).",
  },
  runOfShow: {
    bold: "Run",
    light: "of show",
    columns: ["Time", "What happens"],
    days: [
      { title: "Sunday 25 October - Move-in & set-up", rows: [
        ["6:00 pm", "Booth possession begins. Exhibitor desk opens in your zone."],
        ["6:00 pm", "Collect your exhibitor badges. Badges are issued tonight, not on show morning."],
        ["6:00 - 10:00 pm", "Install marketing materials, dress your booth, test power and connectivity."],
        ["10:00 pm", "Move-in closes. Nothing may be installed after this time."],
      ] },
      { title: "Monday 26 October - Day 1", rows: [
        ["7:30 am", "Exhibition foyer opens to exhibitors for final checks before doors."],
        ["8:00 am", "Delegate registration opens. Exhibition floor live for the networking breakfast."],
        ["6:30 pm", "Exhibition floor closes for the day. Booths may be left dressed overnight."],
        ["Evening", "Catalyst Awards Gala Night."],
      ] },
      { title: "Tuesday 27 October - Day 2 & move-out", rows: [
        ["7:30 am", "Exhibition foyer opens to exhibitors."],
        ["8:00 am", "Exhibition floor opens to delegates."],
        ["7:30 pm", "Show closes. All your materials must be off the floor by this time."],
        ["7:30 pm onwards", "Contractors strike pipe and drape, tables, chairs and signage."],
      ] },
    ],
  },
  needs: {
    title: "What we need from you",
    items: [
      ["Your badge names", "Everyone holding one of your exhibitor passes, in Section 5A."],
      ["Your fascia wording", "The company name for your booth sign, letters only, in Section 5B."],
      ["Any extras you need", "Power, furniture or print, flagged in Section 5C so we can connect you."],
    ],
  },
  booth: {
    bold: "Your booth",
    light: "& what is included",
    intro: "Every booth is built and dressed by us before you arrive. This is what you will walk up to on Sunday evening.",
    sign: "Your company name",
    items: [
      ["Fascia sign", "Your company name in letters only. Tell us the exact wording in Section 5."],
      ["Pipe and drape", "8 ft back wall, 3 ft side rails. Nothing may be nailed, screwed or taped to it."],
      ["One 6 ft table", "Skirted and draped, ready to use."],
      ["Two chairs", ""],
      ["One wastebasket", ""],
      ["One standard power outlet", "Standard 15 A / 120 V duplex. Extra or specialised power is ordered separately."],
    ],
    height: "8 ft",
    width: "10 ft",
    caption: "Illustration, not to scale in every detail. Booth dimensions are confirmed in your allocation band on page 1.",
    notes: [
      ["What is not included", "Audio-visual equipment, screens, TV stands, lounge furniture, lead-retrieval scanners, additional lighting, internet hard lines and shipping or drayage. All of these are ordered through the vendors in Section 3."],
      ["Height limit", "Nothing in your booth may exceed the 8 ft back drape or encroach on the aisle. Zone B has an 8 ft 3 in ceiling, so pop-up banners and towers must fit within that."],
      ["Carpet & floor", "Both foyers are carpeted throughout. No additional floor covering is supplied or needed."],
      ["Internet", "Venue Wi-Fi covers the exhibition floor and is shared with 500+ delegates. If your demo depends on bandwidth, order a hard line rather than relying on the shared network."],
      ["Food & beverage", "Coffee bars, F&B stations and the delegate lounge sit inside both zones. Catering into your own booth is not permitted without prior arrangement."],
    ],
  },
  extras: {
    bold: "Ordering",
    light: "extras",
    intro: "Anything beyond the inclusions on page 2 is ordered directly from our appointed vendors, at your own cost.",
    vendors: [
      { title: "A. Electrical & extra power", vendor: "Encore Global",
        text: "Your booth comes with one standard outlet. Anything beyond that - additional outlets, higher amperage, 220 V, dedicated circuits, 24-hour power - is ordered from Encore Global, the appointed in-house vendor.",
        note: "Order deadline and the Encore order form will be sent with your booth confirmation." },
      { title: "B. Furniture & booth fittings", vendor: "GES",
        text: "TV stands, monitors, lounge seating, high-tops, counters, literature racks and additional tables are ordered from GES, our appointed furniture vendor.",
        note: "Tick furniture in Section 5C and we will send you the GES order form and deadline." },
      { title: "C. Printing & marketing materials", vendor: "Nisarg Media / 6ix Signs",
        text: "Banner printing, backdrops, pull-up stands, booth graphics, literature and giveaways. Two appointed vendors - Nisarg Media and 6ix Signs - so compare both for turnaround and price.",
        note: "Tick printing in Section 5C and we will introduce you to both vendors. Artwork deadlines are theirs, not ours." },
    ],
  },
  rules: {
    bold: "On site",
    light: "rules & essentials",
    items: [
      ["Badges", "Exhibitor badges are collected on Sunday 25 October from 6:00 pm at the exhibitor desk, not on show morning. Badges are named and non-transferable, and must be worn on the floor at all times. Lost badges are replaced at the registration desk on production of photo ID."],
      ["Staffing your booth", "Keep the booth staffed throughout show hours. An unstaffed booth during peak traffic reflects on the whole floor."],
      ["Deliveries", "The venue does not accept exhibitor shipments in advance without prior arrangement. Tell us in Section 5 if you are shipping anything in and we will confirm the loading dock window and labelling."],
      ["Aisles & fire safety", "Aisles are kept clear to the 8 ft minimum at all times. Nothing - cases, boxes, banners, cabling - may sit outside your booth footprint. Store empties behind your drape or with the exhibitor desk."],
      ["Noise & demonstrations", "Audio must stay within your own booth. If your demonstration involves sound, drones, robotics or anything above table height, clear it with us before move-in."],
      ["Security", "The foyers are locked overnight but are not individually guarded. Take laptops, phones, prototypes and anything else of value with you each evening."],
      ["Damage", "You are responsible for damage to venue property, drape and furniture in and around your booth."],
    ],
  },
  returnForm: {
    bold: "Return",
    light: "this form by 16 October 2026",
    intro: "We cannot print your fascia sign or produce your badges without this. One form per exhibiting company.",
    badges: {
      title: "A. Exhibitor badge holders",
      text: "List everyone who will hold one of your exhibitor passes. Names are printed exactly as typed and cannot be changed on site.",
      columns: ["Full name", "Job title", "Email", "Mobile"],
      rows: 4,
      note: "Allotted more than four passes under your contract? Email the extra names to sales@thetechfestival.com in the same format.",
    },
    fascia: {
      title: "B. Fascia sign wording",
      text: "Letters and spaces only - no logos, straplines, symbols or punctuation. Printed in uppercase.",
      fieldLabel: "Print exactly this on our booth sign",
      hint: "Maximum 30 characters including spaces",
      exampleLabel: "This is how it prints",
      example: "AtlasLink Markets",
      exampleHint: "Example only",
    },
    needs: {
      title: "C. Tell us what else you need",
      kicker: "Tick anything that applies - we will connect you with the right vendor",
      options: [
        "Extra or specialised power", "Additional furniture or a TV stand", "Printing or marketing materials",
        "Shipping materials to the venue", "Sound, drone or robotics demo", "Accessibility requirement",
      ],
      contactLabels: ["On-site contact during move-in", "Their mobile", "Expected move-in arrival", "Form completed by"],
      notesLabel: "Anything else we should know",
    },
    declaration: "By returning this form you confirm the badge names and fascia wording are correct, and that your team has read the move-in, aisle, security and move-out rules in this manual. Return it to sales@thetechfestival.com with the subject \"TTFC26 Exhibitor - [your company]\". Questions: +1 647 946 4643.",
    office: { title: "For office use only", labels: ["Received", "Booth confirmed", "Sign to print", "Badges issued", "Processed by"] },
  },
  contact: {
    tagline: "Meet | Build | Scale",
    site: "www.thetechfestival.com",
    dates: "26-27 October 2026",
    address: "The Westin Harbour Castle, 1 Harbour Square, Toronto M5J 1A6",
    lines: [
      ["Exhibitor desk - return your form here", "sales@thetechfestival.com"],
      ["Exhibitor desk", "+1 647 946 4643"],
      ["General support", "enquire@thetechfestival.com"],
    ],
  },
  footer: { label: "For Enquiries -", text: "sales@thetechfestival.com  |  www.thetechfestival.com" },
});

/* ---------- cleaning what staff send (same shape as the default, every value a string) ---------- */

const MAX_TEXT = 1200;
const ARRAY_MAX = 40;

/**
 * Staff's manual (any shape) → a complete manual: every key of DEFAULT_MANUAL, strings trimmed and
 * capped, lists capped at 40 entries, unknown keys dropped. Missing keys take the default; an empty
 * string is kept (staff can blank a line out). Lists replace the default list as a whole.
 */
export function cleanManual(raw, base = DEFAULT_MANUAL) {
  if (typeof base === "string") {
    if (typeof raw !== "string") return base;
    return raw.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim().slice(0, MAX_TEXT);
  }
  if (typeof base === "number") {
    const n = Math.round(Number(raw));
    return Number.isFinite(n) ? Math.min(12, Math.max(0, n)) : base;
  }
  if (Array.isArray(base)) {
    if (!Array.isArray(raw)) return base.map((v) => cleanManual(undefined, v));
    const sample = base[0];
    return raw.slice(0, ARRAY_MAX).map((v) => cleanManual(v, sample ?? ""));
  }
  const out = {};
  for (const k of Object.keys(base)) out[k] = cleanManual(raw && typeof raw === "object" ? raw[k] : undefined, base[k]);
  return out;
}

/** Per-exhibitor details for the PDF: { company, booth, zone, passes, holder: { name, title, email } }. */
export function cleanBooth(raw = {}) {
  const s = (v, max = 80) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  return {
    company: s(raw.company, 160), booth: s(raw.booth, 20), zone: s(raw.zone, 60), passes: s(raw.passes, 20),
    holder: { name: s(raw.holder?.name, 120), title: s(raw.holder?.title, 120), email: s(raw.holder?.email, 160) },
  };
}

/** File name for the attachment: "TTFC_2026_Exhibitor_Manual_Acme_Inc.pdf". */
export function manualFileName(company = "") {
  const slug = String(company).normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return `TTFC_2026_Exhibitor_Manual${slug ? `_${slug}` : ""}.pdf`;
}

/* ---------- drawing ---------- */

const PAGE = { w: 595.28, h: 841.89 };
const M = 41; // side margin
const W = PAGE.w - M * 2;
const TOP = 132; // content starts below the header
const BOTTOM = 770; // content ends above the footer
const COL = {
  ink: "#1b1530", body: "#3b3550", muted: "#6b6480", soft: "#8f86a8", label: "#7d70a3",
  purple: "#5a2a9c", purple2: "#6c35b8", pink: "#d6409a", lavender: "#f5f1fc", panel: "#f8f6fd",
  line: "#e4dcf3", hair: "#ece6f7", wall: "#3e2a5e", wallLine: "#4b3670",
};

const FONT_FILES = {
  light: "Poppins-Light.ttf", regular: "Poppins-Regular.ttf", medium: "Poppins-Medium.ttf",
  semibold: "Poppins-SemiBold.ttf", bold: "Poppins-Bold.ttf",
};
const FALLBACK = { light: "Helvetica", regular: "Helvetica", medium: "Helvetica", semibold: "Helvetica-Bold", bold: "Helvetica-Bold" };

function registerFonts(doc) {
  for (const [name, file] of Object.entries(FONT_FILES)) {
    const p = path.join(FONT_DIR, file);
    if (fs.existsSync(p)) doc.registerFont(name, p);
    else doc.registerFont(name, FALLBACK[name]);
  }
}

const upper = (s) => String(s || "").toUpperCase();
const asset = (f) => { const p = path.join(ASSET_DIR, f); return fs.existsSync(p) ? p : null; };

function gradient(doc, x, y, w) {
  return doc.linearGradient(x, y, x + w, y).stop(0, COL.purple).stop(0.55, "#8a2f9e").stop(1, COL.pink);
}

/** Letter-spaced small caps label. */
function label(doc, text, x, y, opts = {}) {
  const { size = 6.2, color = COL.label, font = "medium", spacing = 1.1, width, align = "left" } = opts;
  doc.font(font).fontSize(size).fillColor(color).text(upper(text), x, y, { characterSpacing: spacing, width, align, lineBreak: !!width });
}

function header(doc, m) {
  const logo = asset("logo.png");
  if (logo) doc.image(logo, M, 38, { height: 42 });
  doc.save().moveTo(M + 82, 24).lineTo(M + 82, 76).lineWidth(0.8).strokeColor("#c9b6ea").stroke().restore();
  doc.font("bold").fontSize(8.4).fillColor(COL.ink).text(m.header.dates, M + 96, 43, { lineBreak: false });
  doc.font("semibold").fontSize(8.4).fillColor(COL.purple).text(m.header.venue, M + 96, 56, { lineBreak: false });
  label(doc, m.header.label, M, 44, { width: W, align: "right", color: COL.pink, font: "bold", size: 6.6, spacing: 1.6 });
  doc.font("regular").fontSize(6.6).fillColor(COL.muted).text(m.header.subtitle, M, 57, { width: W, align: "right", lineBreak: false });
}

function footer(doc, m, n, total) {
  doc.save().moveTo(M, 785).lineTo(M + W, 785).lineWidth(0.6).strokeColor(COL.line).stroke().restore();
  doc.font("semibold").fontSize(7).fillColor(COL.purple).text(m.footer.label, M, 794, { continued: true, lineBreak: false })
    .font("regular").fillColor(COL.muted).text(`   ${m.footer.text}`, { lineBreak: false });
  doc.font("regular").fontSize(7).fillColor("#b39ad8").text(`Page ${n} of ${total}`, M, 794, { width: W, align: "right", lineBreak: false });
}

/** The gradient section bar: "1 | RUN OF SHOW". Returns the y below it. */
function sectionBar(doc, n, bold, light, y) {
  doc.save().roundedRect(M, y, W, 19, 9.5).fill(gradient(doc, M, y, W)).restore();
  doc.font("bold").fontSize(8.6).fillColor("#ffffff").text(String(n), M + 13, y + 5.2, { lineBreak: false });
  doc.save().moveTo(M + 27, y + 5).lineTo(M + 27, y + 14).lineWidth(0.6).strokeColor("#ffffff", 0.65).stroke().restore();
  doc.font("bold").fontSize(8.6).fillColor("#ffffff").text(upper(bold), M + 33, y + 5.2, { continued: true, lineBreak: false })
    .font("light").text(`  ${upper(light)}`, { lineBreak: false });
  return y + 19;
}

function panel(doc, x, y, w, h, { fill = COL.panel, stroke = COL.line, accent = false, radius = 8, dash = false } = {}) {
  doc.save();
  doc.roundedRect(x, y, w, h, radius).lineWidth(0.8);
  if (dash) doc.dash(3, { space: 2.5 });
  if (fill) doc.fillAndStroke(fill, stroke); else doc.strokeColor(stroke).stroke();
  doc.undash();
  if (accent) doc.roundedRect(x, y, 3.2, h, 1.6).fill(COL.purple);
  doc.restore();
}

/** A text box with a 0.8pt lavender border (optionally a fillable field). */
function inputBox(doc, name, x, y, w, h, { value = "", fixed = "", multiline = false, size = 7.5 } = {}) {
  doc.save().roundedRect(x, y, w, h, 2.5).lineWidth(0.7).fillAndStroke("#fbfaff", "#dccff2").restore();
  if (fixed) {
    doc.font("medium").fontSize(size).fillColor(COL.ink).text(fixed, x + 5, y + (h - size) / 2 - 1, { width: w - 10, height: h, ellipsis: true, lineBreak: false });
    return;
  }
  if (!name) return;
  const font = doc._font;
  doc.font("Helvetica");
  doc.formText(name, x + 1, y + 1, w - 2, h - 2, { value, fontSize: multiline ? 8 : Math.min(8.5, h - 6), multiline, align: "left" });
  doc._font = font;
}

/** Wraps `text` at `width` and returns its height (font already set). */
const heightOf = (doc, text, width, opts = {}) => (text ? doc.heightOfString(text, { width, ...opts }) : 0);

/* page 1 */

function pageOne(doc, m, booth) {
  let y = 92;
  doc.font("bold").fontSize(22).fillColor(COL.purple).text(upper(m.title.bold), M, y, { continued: true, lineBreak: false })
    .font("light").fillColor(COL.purple2).text(` ${upper(m.title.light)}`, { lineBreak: false });
  y += 30;
  doc.save().rect(M, y, 152, 2.6).fill(COL.purple).restore();
  doc.save().moveTo(M + 152, y + 1.6).lineTo(M + 341, y + 1.6).lineWidth(0.6).strokeColor("#c9b6ea").stroke().restore();

  // Key dates band
  y += 20;
  const kd = m.keyDates.filter(([a, b]) => a || b).slice(0, 6);
  panel(doc, M, y, W, 32, { fill: COL.lavender });
  const cw = W / Math.max(1, kd.length);
  kd.forEach(([lab, val], i) => {
    const x = M + i * cw;
    if (i) doc.save().moveTo(x, y + 7).lineTo(x, y + 25).lineWidth(0.6).strokeColor(COL.line).stroke().restore();
    label(doc, lab, x + 14, y + 8, { size: 5.6, spacing: 0.9, color: COL.label });
    doc.font("bold").fontSize(7.8).fillColor(COL.ink).text(val, x + 14, y + 16.5, { width: cw - 20, lineBreak: false, ellipsis: true });
  });

  // Allocation band (filled by TTFC)
  y += 54;
  panel(doc, M, y, W, 57, { fill: "#ffffff", stroke: "#cdb9ef", accent: true });
  label(doc, m.allocation.title, M + 16, y + 10, { size: 5.8, spacing: 1.2, color: COL.purple });
  const fields = [
    { x: M + 16, w: 178, v: booth.company, name: "alloc_company" },
    { x: M + 211, w: 63, v: booth.booth, name: "alloc_booth" },
    { x: M + 292, w: 93, v: booth.zone, name: "alloc_zone" },
    { x: M + 403, w: 81, v: booth.passes, name: "alloc_passes" },
  ];
  fields.forEach((f, i) => {
    doc.font("regular").fontSize(5.8).fillColor(COL.soft).text(m.allocation.labels[i] || "", f.x, y + 23, { width: f.w, lineBreak: false });
    inputBox(doc, f.v ? "" : f.name, f.x, y + 33, f.w, 15, { fixed: f.v });
  });
  y += 61;
  doc.font("regular").fontSize(6.1).fillColor(COL.muted).text(m.allocation.note, M, y, { width: W });
  y = doc.y + 18;

  // 1 Run of show
  y = sectionBar(doc, 1, m.runOfShow.bold, m.runOfShow.light, y) + 14;
  panel(doc, M, y, W, 15, { fill: COL.lavender, radius: 4 });
  label(doc, m.runOfShow.columns[0], M + 8, y + 5, { size: 5.4, spacing: 0.8, color: COL.label });
  label(doc, m.runOfShow.columns[1], M + 124, y + 5, { size: 5.4, spacing: 0.8, color: COL.label });
  y += 22;
  for (const day of m.runOfShow.days) {
    if (y > BOTTOM - 40) { doc.addPage(); y = TOP; }
    if (day.title) {
      doc.save().roundedRect(M, y, W, 14, 3).fill(gradient(doc, M, y, W)).restore();
      label(doc, day.title.replace(/ - /g, "  -  "), M + 9, y + 4.6, { size: 5.8, spacing: 1.1, color: "#ffffff", font: "bold" });
      y += 18;
    }
    for (const [time, what] of day.rows || []) {
      if (!time && !what) continue;
      doc.font("regular").fontSize(7.3);
      const h = Math.max(heightOf(doc, what, W - 132), 9) + 8;
      if (y + h > BOTTOM) { doc.addPage(); y = TOP; }
      doc.font("bold").fontSize(7.3).fillColor(COL.ink).text(time, M + 8, y + 4, { width: 110 });
      doc.font("regular").fontSize(7.3).fillColor(COL.body).text(what, M + 124, y + 4, { width: W - 132 });
      y += h;
      doc.save().moveTo(M, y).lineTo(M + W, y).lineWidth(0.5).strokeColor(COL.hair).stroke().restore();
    }
    y += 6;
  }

  // What we need from you
  const items = m.needs.items.filter(([a, b]) => a || b).slice(0, 4);
  if (items.length || m.needs.title) {
    const colW = (W - 32) / Math.max(1, items.length);
    doc.font("regular").fontSize(6.4);
    const textH = Math.max(0, ...items.map(([, t]) => heightOf(doc, t, colW - 14)));
    const boxH = 46 + textH;
    y += 8;
    if (y + boxH > BOTTOM) { doc.addPage(); y = TOP; }
    panel(doc, M, y, W, boxH, { fill: "#ffffff", stroke: "#e2d8f3", accent: true });
    label(doc, m.needs.title, M + 16, y + 11, { size: 6.4, spacing: 1.3, color: COL.purple, font: "bold" });
    items.forEach(([t, d], i) => {
      const x = M + 16 + i * colW;
      doc.save().circle(x + 5.5, y + 33, 5.5).fill(gradient(doc, x, y, 11)).restore();
      doc.font("bold").fontSize(6.2).fillColor("#ffffff").text(String(i + 1), x, y + 30.6, { width: 11, align: "center", lineBreak: false });
      doc.font("semibold").fontSize(7).fillColor(COL.ink).text(t, x + 16, y + 29.5, { width: colW - 20, lineBreak: false, ellipsis: true });
      doc.font("regular").fontSize(6.4).fillColor(COL.muted).text(d, x, y + 42, { width: colW - 14 });
    });
  }
}

/* page 2 */

function boothDrawing(doc, m, booth, x0, y0, w, h) {
  // Coordinates are laid out for a 300 x 260 box, then scaled into place.
  const s = Math.min(w / 300, h / 260);
  doc.save().translate(x0, y0).scale(s);
  // back wall
  doc.rect(24, 8, 276, 5).fill("#6f55a6");
  doc.rect(34, 13, 256, 217).fill(COL.wall);
  for (let x = 46; x < 290; x += 12.5) doc.save().moveTo(x, 13).lineTo(x, 230).lineWidth(0.6).strokeColor(COL.wallLine).stroke().restore();
  doc.rect(24, 142, 10, 88).fill("#2b1d44");
  doc.rect(290, 142, 10, 88).fill("#2b1d44");
  // fascia sign
  const sign = upper(booth.company || m.booth.sign).slice(0, 34);
  doc.font("bold").fontSize(6.4);
  const sw = Math.min(200, doc.widthOfString(sign, { characterSpacing: 1 }) + 18);
  doc.rect(162 - sw / 2, 31, sw, 15).lineWidth(0.8).fillAndStroke("#ffffff", "#8b6fc4");
  doc.fillColor(COL.purple).text(sign, 162 - sw / 2, 35.4, { width: sw, align: "center", characterSpacing: 1, lineBreak: false });
  // chairs, table, bin, outlet
  doc.roundedRect(107, 128, 34, 30, 3).fill("#8f7bb6");
  doc.roundedRect(184, 128, 34, 30, 3).fill("#8f7bb6");
  doc.rect(84, 158, 156, 6).fill("#c7b5e6");
  doc.rect(87, 164, 150, 66).fill("#ebe3f7");
  for (let x = 98; x < 236; x += 13) doc.save().moveTo(x, 166).lineTo(x, 230).lineWidth(0.5).strokeColor("#d4c6ec").stroke().restore();
  doc.polygon([248, 200], [266, 200], [263, 230], [251, 230]).fill("#9d8ec2");
  doc.rect(42, 186, 14, 20).lineWidth(0.6).fillAndStroke("#ffffff", "#c6b6e6");
  doc.circle(46.5, 193, 1.3).fill(COL.wall).circle(51.5, 193, 1.3).fill(COL.wall).circle(49, 199, 1.3).fill(COL.wall);
  // floor line + dimensions
  doc.save().moveTo(10, 230).lineTo(300, 230).lineWidth(0.6).strokeColor("#b9a8de").stroke().restore();
  doc.save().moveTo(12, 13).lineTo(12, 230).lineWidth(0.6).strokeColor("#b9a8de").stroke().restore();
  doc.save().moveTo(34, 248).lineTo(290, 248).lineWidth(0.6).strokeColor("#b9a8de").stroke().restore();
  for (const [ax, ay, bx, by] of [[8, 13, 16, 13], [8, 230, 16, 230], [34, 244, 34, 252], [290, 244, 290, 252]]) {
    doc.save().moveTo(ax, ay).lineTo(bx, by).lineWidth(0.6).strokeColor("#b9a8de").stroke().restore();
  }
  doc.rect(150, 243, 24, 10).fill(COL.panel);
  doc.font("regular").fontSize(5.6).fillColor(COL.soft).text(m.booth.width, 140, 245, { width: 44, align: "center", lineBreak: false });
  doc.rect(2, 115, 20, 10).fill(COL.panel);
  doc.font("regular").fontSize(5.6).fillColor(COL.soft).text(m.booth.height, -10, 117, { width: 44, align: "center", lineBreak: false });
  // numbered markers
  const dot = (n, x, y) => {
    doc.circle(x, y, 6).fill(COL.pink);
    doc.font("bold").fontSize(6).fillColor("#ffffff").text(String(n), x - 6, y - 2.6, { width: 12, align: "center", lineBreak: false });
  };
  dot(1, 162 - sw / 2 - 12, 38.5);
  dot(2, 268, 41);
  dot(3, 162, 142);
  dot(4, 124, 120);
  dot(5, 257, 188);
  dot(6, 49, 174);
  doc.restore();
}

function pageTwo(doc, m, booth) {
  let y = sectionBar(doc, 2, m.booth.bold, m.booth.light, TOP - 24) + 11;
  doc.font("regular").fontSize(6.8).fillColor(COL.body).text(m.booth.intro, M, y, { width: W });
  y = doc.y + 12;
  const boxH = 300;
  panel(doc, M, y, W, boxH, { fill: COL.panel, stroke: COL.line, radius: 10 });
  boothDrawing(doc, m, booth, M + 14, y + 26, 300, 262);
  // the list on the right
  let ly = y + 20;
  const lx = M + 334, lw = W - 348;
  m.booth.items.slice(0, 6).forEach(([t, d], i) => {
    doc.circle(lx + 5.5, ly + 4.6, 5.5).fill(COL.pink);
    doc.font("bold").fontSize(6).fillColor("#ffffff").text(String(i + 1), lx, ly + 2.1, { width: 11, align: "center", lineBreak: false });
    doc.font("semibold").fontSize(7.4).fillColor(COL.ink).text(t, lx + 18, ly + 0.6, { width: lw - 18 });
    let yy = doc.y + 1;
    if (d) { doc.font("regular").fontSize(6.3).fillColor(COL.muted).text(d, lx + 18, yy, { width: lw - 18 }); yy = doc.y; }
    ly = yy + 8;
  });
  doc.font("regular").fontSize(5.9).fillColor("#b3a6cf").text(m.booth.caption, M + 48, y + boxH - 16, { width: W - 60, lineBreak: false, ellipsis: true });
  y += boxH + 14;
  for (const [t, d] of m.booth.notes) {
    if (!t && !d) continue;
    doc.circle(M + 4, y + 4, 2).fill(COL.pink);
    doc.font("semibold").fontSize(7.2).fillColor(COL.purple).text(t, M + 12, y, { continued: true, width: W - 12 })
      .font("regular").fillColor(COL.body).text(`    ${d}`, { width: W - 12 });
    y = doc.y + 6;
  }
}

/* page 3 */

function pageThree(doc, m) {
  let y = sectionBar(doc, 3, m.extras.bold, m.extras.light, TOP - 24) + 11;
  doc.font("regular").fontSize(6.8).fillColor(COL.body).text(m.extras.intro, M, y, { width: W });
  y = doc.y + 14;
  for (const v of m.extras.vendors) {
    if (!v.title && !v.text) continue;
    doc.font("regular").fontSize(7);
    const th = heightOf(doc, v.text, W - 32);
    doc.fontSize(6.2);
    const nh = heightOf(doc, v.note, W - 32);
    const h = 30 + th + (v.note ? nh + 10 : 0) + 8;
    if (y + h > BOTTOM) { doc.addPage(); y = TOP; }
    panel(doc, M, y, W, h, { fill: COL.panel, radius: 8 });
    label(doc, v.title, M + 16, y + 13, { size: 6.2, spacing: 1.2, color: COL.purple, font: "bold" });
    label(doc, v.vendor, M, y + 13, { size: 6.2, spacing: 1.2, color: COL.purple, font: "bold", width: W - 16, align: "right" });
    doc.font("regular").fontSize(7).fillColor(COL.body).text(v.text, M + 16, y + 27, { width: W - 32 });
    if (v.note) doc.font("regular").fontSize(6.2).fillColor(COL.muted).text(v.note, M + 16, doc.y + 8, { width: W - 32 });
    y += h + 9;
  }
  y += 10;
  if (y > BOTTOM - 80) { doc.addPage(); y = TOP; }
  y = sectionBar(doc, 4, m.rules.bold, m.rules.light, y) + 12;
  for (const [t, d] of m.rules.items) {
    if (!t && !d) continue;
    doc.font("regular").fontSize(7.2);
    if (y + heightOf(doc, `${t}    ${d}`, W - 12) > BOTTOM) { doc.addPage(); y = TOP; }
    doc.circle(M + 4, y + 4, 2).fill(COL.pink);
    doc.font("semibold").fontSize(7.2).fillColor(COL.purple).text(t, M + 12, y, { continued: true, width: W - 12 })
      .font("regular").fillColor(COL.body).text(`    ${d}`, { width: W - 12 });
    y = doc.y + 6.5;
  }
}

/* page 4 */

function pageFour(doc, m, booth) {
  const r = m.returnForm;
  let y = sectionBar(doc, 5, r.bold, r.light, TOP - 24) + 12;
  doc.font("regular").fontSize(6.8).fillColor(COL.body).text(r.intro, M, y, { width: W });
  y = doc.y + 12;

  // A. Badge holders
  label(doc, r.badges.title, M, y, { size: 6.6, spacing: 1.3, color: COL.purple, font: "bold" });
  y += 11;
  doc.font("regular").fontSize(6.4).fillColor(COL.muted).text(r.badges.text, M, y, { width: W });
  y = doc.y + 12;
  panel(doc, M, y, W, 15, { fill: COL.lavender, radius: 4 });
  const cols = [{ x: M + 33, w: 128 }, { x: M + 168, w: 100 }, { x: M + 274, w: 142 }, { x: M + 422, w: 91 }];
  label(doc, "#", M + 8, y + 5, { size: 5.4, spacing: 0.8 });
  cols.forEach((c, i) => label(doc, r.badges.columns[i] || "", c.x + 4, y + 5, { size: 5.4, spacing: 0.8 }));
  y += 21;
  const keys = ["name", "title", "email", "mobile"];
  const rows = Math.min(12, Math.max(1, r.badges.rows || 4));
  for (let i = 1; i <= rows; i++) {
    doc.font("semibold").fontSize(7.4).fillColor(COL.purple).text(String(i), M + 9, y + 5, { lineBreak: false });
    cols.forEach((c, j) => inputBox(doc, `b${i}_${keys[j]}`, c.x, y, c.w, 17, { value: i === 1 ? booth.holder[keys[j]] || "" : "" }));
    y += 22;
  }
  doc.font("regular").fontSize(6.2).fillColor(COL.muted).text(r.badges.note, M, y, { width: W });
  y = doc.y + 18;

  // B. Fascia
  const f = r.fascia;
  panel(doc, M, y, W, 80, { fill: COL.panel, radius: 8 });
  label(doc, f.title, M + 14, y + 11, { size: 6.6, spacing: 1.3, color: COL.purple, font: "bold" });
  doc.font("regular").fontSize(6.4).fillColor(COL.muted).text(f.text, M + 14, y + 23, { width: W - 28, lineBreak: false, ellipsis: true });
  label(doc, f.fieldLabel, M + 14, y + 38, { size: 5.6, spacing: 1, color: COL.purple });
  label(doc, f.exampleLabel, M + 357, y + 38, { size: 5.6, spacing: 1, color: COL.purple });
  inputBox(doc, "fascia_text", M + 14, y + 48, 330, 20);
  const example = upper(booth.company || f.example);
  doc.save().rect(M + 357, y + 47, 142, 22).lineWidth(0.9).fillAndStroke("#ffffff", "#8b6fc4").restore();
  doc.font("bold").fontSize(7.4).fillColor(COL.purple).text(example, M + 357, y + 54.5, { width: 142, align: "center", characterSpacing: 0.8, lineBreak: false, ellipsis: true });
  doc.font("regular").fontSize(5.6).fillColor("#b3a6cf").text(f.hint, M + 14, y + 71, { lineBreak: false });
  doc.text(booth.company ? "Your company, as an example" : f.exampleHint, M + 357, y + 71, { lineBreak: false });
  y += 92;

  // C. What else
  const n = r.needs;
  label(doc, n.title, M, y, { size: 6.6, spacing: 1.3, color: COL.purple, font: "bold" });
  y += 19;
  label(doc, n.kicker, M, y, { size: 5.6, spacing: 1, color: COL.purple });
  y += 13;
  const boxes = ["power", "furniture", "printing", "shipping", "demo", "access"];
  n.options.slice(0, 6).forEach((opt, i) => {
    const cx = M + (i % 3) * 178, cy = y + Math.floor(i / 3) * 16;
    doc.save().rect(cx, cy, 9, 9).lineWidth(0.8).fillAndStroke("#ffffff", "#9d86cf").restore();
    const font = doc._font;
    doc.font("Helvetica");
    doc.formCheckbox(boxes[i], cx, cy, 9, 9, { borderColor: "#9d86cf", backgroundColor: "#ffffff" });
    doc._font = font;
    doc.font("regular").fontSize(7.2).fillColor(COL.body).text(opt, cx + 14, cy + 0.6, { width: 160, lineBreak: false, ellipsis: true });
  });
  y += Math.ceil(Math.min(6, n.options.length) / 3) * 16 + 10;
  const cf = [{ x: M, w: 148, k: "oc_name" }, { x: M + 157, w: 112, k: "oc_mobile" }, { x: M + 278, w: 112, k: "oc_arrival" }, { x: M + 399, w: 114, k: "form_by" }];
  cf.forEach((c, i) => label(doc, n.contactLabels[i] || "", c.x, y, { size: 5.6, spacing: 1, color: COL.purple }));
  y += 10;
  cf.forEach((c) => inputBox(doc, c.k, c.x, y, c.w, 17));
  y += 32;
  label(doc, n.notesLabel, M, y, { size: 5.6, spacing: 1, color: COL.purple });
  y += 10;
  inputBox(doc, "extra_notes", M, y, W, 30, { multiline: true });
  y += 40;
  doc.font("regular").fontSize(6.5).fillColor(COL.body).text(r.declaration, M, y, { width: W });
  y = doc.y + 12;

  // Office use
  panel(doc, M, y, W, 44, { fill: null, stroke: "#d9cdef", dash: true });
  label(doc, r.office.title, M + 16, y + 10, { size: 5.6, spacing: 1.2, color: "#b3a6cf" });
  const ow = (W - 32) / Math.max(1, r.office.labels.length);
  r.office.labels.forEach((l, i) => {
    const x = M + 16 + i * ow;
    doc.font("regular").fontSize(6).fillColor("#b3a6cf").text(l, x, y + 21, { lineBreak: false });
    doc.save().moveTo(x, y + 34).lineTo(x + ow - 14, y + 34).lineWidth(0.5).strokeColor("#d9cdef").stroke().restore();
  });
  y += 56;

  // Contact band
  const bh = Math.max(96, BOTTOM + 6 - y);
  const band = doc.linearGradient(M, y, M + W, y + bh).stop(0, "#3d1f78").stop(0.5, "#6a2ca6").stop(1, "#d6409a");
  doc.save().roundedRect(M, y, W, bh, 12).fill(band).restore();
  const white = asset("logo-white.png");
  if (white) doc.image(white, M + 24, y + 16, { height: 38 });
  label(doc, m.contact.tagline, M + 24, y + bh - 30, { size: 7.4, spacing: 1.8, color: "#ffffff", font: "bold" });
  doc.fillOpacity(1);
  doc.font("regular").fontSize(6.4).fillColor("#ffffff", 0.8).text(m.contact.site, M + 24, y + bh - 17, { lineBreak: false });
  const rx = M + W - 24;
  label(doc, m.contact.dates, M, y + 18, { size: 7.4, spacing: 1.6, color: "#ffffff", font: "bold", width: W - 24, align: "right" });
  doc.font("regular").fontSize(6.4).fillColor("#ffffff", 0.88).text(m.contact.address, M, y + 31, { width: W - 24, align: "right", lineBreak: false });
  let cy = y + 47;
  for (const [l, v] of m.contact.lines) {
    if (!l && !v) continue;
    doc.font("bold").fontSize(6.6);
    const vw = doc.widthOfString(v);
    doc.fillColor("#ffffff", 1).text(v, rx - vw, cy, { lineBreak: false });
    doc.font("regular").fontSize(6.4);
    const lt = `${l}  -  `;
    doc.fillColor("#ffffff", 0.8).text(lt, rx - vw - doc.widthOfString(lt), cy + 0.2, { lineBreak: false });
    cy += 11;
  }
}

/**
 * The manual as a PDF Buffer. `manual`: staff's saved wording (cleaned again here);
 * `booth`: cleanBooth() fields for this exhibitor.
 */
export function buildExhibitorManual(manual = DEFAULT_MANUAL, booth = {}) {
  const m = cleanManual(manual);
  const b = cleanBooth(booth);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4", margins: { top: TOP, bottom: 0, left: M, right: M }, bufferPages: true, autoFirstPage: false,
      info: {
        Title: "The Tech Festival Canada 2026 - Exhibitor Manual & Run of Show",
        Author: "The Tech Festival Canada / AtlasLink Markets Inc.",
        Subject: "Exhibitor move-in, booth inclusions, run of show and return form",
      },
    });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      registerFonts(doc);
      // The form's default font is Courier, so each field's own Helvetica + size is written out
      // (pdfkit only sets a field's size when its font differs from the default).
      doc.font("Courier");
      doc.initForm();
      const newPage = () => doc.addPage({ size: "A4", margins: { top: TOP, bottom: 0, left: M, right: M } });
      newPage(); pageOne(doc, m, b);
      newPage(); pageTwo(doc, m, b);
      newPage(); pageThree(doc, m);
      newPage(); pageFour(doc, m, b);
      const { start, count } = doc.bufferedPageRange();
      for (let i = start; i < start + count; i++) {
        doc.switchToPage(i);
        header(doc, m);
        footer(doc, m, i + 1, count);
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
