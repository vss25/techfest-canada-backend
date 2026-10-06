import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  EVENT, inclusionsFor, knowBeforeYouGo, displayPassName, isBoothId,
} from "./ticketInfo.js";

/* ============================================================
   TTFC 2026 — delegate pass PDF (attached to the ticket email)

   One US-Letter page: dark brand header, a ticket card with the
   attendee, pass, ticket ID and a large QR, then what the pass
   includes, practical tips, the app-coming-soon note and contact
   details.

   QR payload is the bare ticket ID — exactly what the emailed PDF
   has always carried and what the website door scanner
   (POST /api/checkin/scan) matches on. Do not change it.

   Fonts live in services/fonts/ (Orbitron for headings, Archivo
   for text — both SIL OFL, same files the iOS app ships). A
   missing file falls back to Helvetica so a bad deploy degrades
   instead of throwing. Override the folder with TTFC_FONT_DIR.
   ============================================================ */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = process.env.TTFC_FONT_DIR || path.join(__dirname, "fonts");

/* ---- brand palette ---- */
const DARK    = "#06020f";
const PURPLE  = "#7a3fd1";
const PINK    = "#E8458B";
const GOLD    = "#f5b942";
const INK     = "#140a26";
const MUTED   = "#6b6480";
const LABEL   = "#7a3fd1";
const HAIR    = "#e9e2f8";
const PAGE_BG = "#f6f3fc";
const PANEL   = "#f8f5ff";

const PAGE = { w: 612, h: 792 };

export function resolveAttendeeName(ticket = {}) {
  const clean = (v) => (typeof v === "string" ? v.trim() : "");

  const first = clean(ticket.firstName || ticket.first_name || ticket.givenName || ticket.details?.firstName);
  const last  = clean(ticket.lastName  || ticket.last_name  || ticket.familyName || ticket.details?.lastName);
  if (first || last) return [first, last].filter(Boolean).join(" ");

  const whole = clean(
    ticket.name || ticket.fullName || ticket.full_name ||
    ticket.customerName || ticket.customer_name ||
    (ticket.customer && ticket.customer.name) ||
    (ticket.billing_details && ticket.billing_details.name)
  );
  if (whole && whole.toLowerCase() !== "guest") return whole;

  const email = clean(ticket.email || (ticket.customer && ticket.customer.email));
  if (email.includes("@")) {
    const local = email.split("@")[0].replace(/[._-]+/g, " ").trim();
    if (local) {
      return local.split(" ").filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(" ");
    }
  }
  return "Guest";
}

function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Toronto" });
}

function registerFont(doc, alias, file, fallback) {
  try {
    const full = path.join(FONT_DIR, file);
    if (fs.existsSync(full)) { doc.registerFont(alias, full); return alias; }
  } catch (_) { /* ignore */ }
  return fallback;
}

/**
 * @param {object} ticket  { ticketId, tier|type, name | firstName+lastName | details, email,
 *                           purchaseDate, walletUrl }
 * @returns {Promise<Buffer>}
 */
export async function generateTicketPDF(ticket = {}) {
  const ticketId = String(ticket.ticketId || ticket.id || "").trim();
  if (!ticketId) throw new Error("Ticket ID missing when generating the ticket PDF");

  const tier      = ticket.tier || ticket.type || "";
  const attendee  = resolveAttendeeName(ticket);
  const passLabel = displayPassName(tier, ticketId);
  const booth     = isBoothId(ticketId);
  const purchased = formatDate(ticket.purchaseDate || ticket.createdAt);
  const walletUrl = booth ? "" : String(ticket.walletUrl || "");

  const doc = new PDFDocument({
    size: [PAGE.w, PAGE.h],
    margin: 0,
    info: {
      Title: `${EVENT.shortName} ${passLabel} — ${attendee}`,
      Author: "The Tech Festival Canada",
      Subject: `${passLabel} · Ticket ${ticketId}`,
    },
  });
  const buffers = [];
  doc.on("data", buffers.push.bind(buffers));
  const done = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);
  });

  const F = {
    display: registerFont(doc, "orb-xb",  "Orbitron-ExtraBold.ttf", "Helvetica-Bold"),
    head   : registerFont(doc, "orb-b",   "Orbitron-Bold.ttf",      "Helvetica-Bold"),
    bold   : registerFont(doc, "ar-bold", "Archivo-Bold.ttf",       "Helvetica-Bold"),
    semi   : registerFont(doc, "ar-semi", "Archivo-SemiBold.ttf",   "Helvetica-Bold"),
    medium : registerFont(doc, "ar-med",  "Archivo-Medium.ttf",     "Helvetica"),
    regular: registerFont(doc, "ar-reg",  "Archivo-Regular.ttf",    "Helvetica"),
    mono   : "Courier-Bold",
  };

  const qrPng = await QRCode.toBuffer(ticketId, {
    errorCorrectionLevel: "H", margin: 0, width: 720,
    color: { dark: INK, light: "#ffffff" },
  });

  /* ---------- helpers ---------- */
  const one = (text, x, y, font, size, color, opts = {}) =>
    doc.font(font).fontSize(size).fillColor(color).text(String(text), x, y, { lineBreak: false, ...opts });

  const label = (text, x, y, color = LABEL, opts = {}) =>
    one(String(text).toUpperCase(), x, y, F.bold, 7, color, { characterSpacing: 1.8, ...opts });

  const wrap = (text, font, size, maxWidth) => {
    doc.font(font).fontSize(size);
    const out = [];
    let line = "";
    for (const word of String(text).split(/\s+/)) {
      const trial = line ? `${line} ${word}` : word;
      if (doc.widthOfString(trial) > maxWidth && line) { out.push(line); line = word; }
      else line = trial;
    }
    if (line) out.push(line);
    return out;
  };

  const check = (x, y) => {
    doc.circle(x + 5, y + 5, 5.5).fill("#efe6ff");
    doc.save().lineWidth(1.4).strokeColor(PURPLE).lineCap("round").lineJoin("round")
       .moveTo(x + 2.4, y + 5.2).lineTo(x + 4.3, y + 7.1).lineTo(x + 7.8, y + 3.2).stroke().restore();
  };

  const dot = (x, y) => doc.circle(x + 2.5, y + 2.5, 2.2).fill(PINK);

  /* ================= PAGE ================= */
  doc.rect(0, 0, PAGE.w, PAGE.h).fill(PAGE_BG);

  /* ================= HEADER ================= */
  const HEAD_H = 122;
  doc.rect(0, 0, PAGE.w, HEAD_H).fill(DARK);
  doc.save();
  doc.rect(0, 0, PAGE.w, HEAD_H).clip();
  const glow = doc.radialGradient(520, 10, 0, 520, 10, 230);
  glow.stop(0, PURPLE, 0.55).stop(1, PURPLE, 0);
  doc.circle(520, 10, 230).fill(glow);
  const glow2 = doc.radialGradient(60, 140, 0, 60, 140, 180);
  glow2.stop(0, PINK, 0.25).stop(1, PINK, 0);
  doc.circle(60, 140, 180).fill(glow2);
  doc.restore();

  const bar = doc.linearGradient(0, 0, PAGE.w, 0);
  bar.stop(0, PURPLE).stop(0.6, PINK).stop(1, GOLD);
  doc.rect(0, HEAD_H - 4, PAGE.w, 4).fill(bar);

  one("TTFC 2026", 40, 34, F.display, 30, "#ffffff", { characterSpacing: 1.5 });
  one("THE TECH FESTIVAL CANADA", 41, 76, F.semi, 8.5, "#c9b8f2", { characterSpacing: 2.6 });

  const R = PAGE.w - 40;
  one(booth ? "EXHIBITOR CONFIRMATION" : "OFFICIAL DELEGATE PASS", 0, 40, F.bold, 8, GOLD,
      { width: R, align: "right", characterSpacing: 2 });
  one(EVENT.datesShort, 0, 56, F.head, 13, "#ffffff", { width: R, align: "right", characterSpacing: 1 });
  one(`${EVENT.venue.replace(/^The /, "")} · Toronto`, 0, 78, F.medium, 9, "#c9b8f2",
      { width: R, align: "right" });

  /* ================= TICKET CARD ================= */
  const CX = 32, CY = 146, CW = PAGE.w - 64, CH = 300;
  const PERF = 368;               // perforation x
  doc.roundedRect(CX, CY, CW, CH, 16).fill("#ffffff");

  // Stub panel to the right of the perforation + gradient spine on the left edge
  doc.save();
  doc.roundedRect(CX, CY, CW, CH, 16).clip();
  doc.rect(PERF, CY, CX + CW - PERF, CH).fill(PANEL);
  const spine = doc.linearGradient(0, CY, 0, CY + CH);
  spine.stop(0, PURPLE).stop(1, PINK);
  doc.rect(CX, CY, 6, CH).fill(spine);
  doc.restore();
  doc.lineWidth(1).strokeColor(HAIR).roundedRect(CX + 0.5, CY + 0.5, CW - 1, CH - 1, 16).stroke();

  doc.lineWidth(1).strokeColor("#d8ccf3").dash(3, { space: 3.5 });
  doc.moveTo(PERF, CY + 14).lineTo(PERF, CY + CH - 14).stroke();
  doc.undash();
  doc.circle(PERF, CY, 9).fill(PAGE_BG);
  doc.circle(PERF, CY + CH, 9).fill(PAGE_BG);

  /* ---- left: attendee ---- */
  const LX = 60, LW = PERF - LX - 24;

  let nameSize = 26, nameLines = wrap(attendee, F.bold, nameSize, LW);
  while (nameLines.length > 2 && nameSize > 15) {
    nameSize -= 2;
    nameLines = wrap(attendee, F.bold, nameSize, LW);
  }
  nameLines = nameLines.slice(0, 2);
  const nameLead = nameSize * 1.12;
  // A one-line name sits a little lower so the block stays balanced in the card
  const nameTop = CY + 40 + (2 - nameLines.length) * nameLead * 0.6;
  label("Attendee", LX, nameTop - 14);
  nameLines.forEach((ln, i) =>
    one(ln, LX, nameTop + i * nameLead, F.bold, nameSize, INK, { width: LW, ellipsis: true, characterSpacing: -0.3 }));
  const chipY = nameTop + nameLines.length * nameLead + 12;

  // pass chip
  doc.font(F.head).fontSize(10.5);
  const chipText = passLabel.toUpperCase();
  const chipW = Math.min(LW, doc.widthOfString(chipText, { characterSpacing: 1.4 }) + 30);
  const chip = doc.linearGradient(LX, 0, LX + chipW, 0);
  chip.stop(0, PURPLE).stop(1, PINK);
  doc.roundedRect(LX, chipY, chipW, 26, 13).fill(chip);
  one(chipText, LX, chipY + 8, F.head, 10.5, "#ffffff", { width: chipW, align: "center", characterSpacing: 1.4 });

  // ticket id + purchased
  const ROW1 = CY + 168;
  label(booth ? "Booking reference" : "Ticket ID", LX, ROW1);
  one(ticketId, LX, ROW1 + 13, F.mono, 14, INK, { characterSpacing: 1 });
  if (purchased) {
    label("Purchased", LX + 170, ROW1);
    one(purchased, LX + 170, ROW1 + 13, F.semi, 11, INK);
  }

  doc.lineWidth(1).strokeColor(HAIR).moveTo(LX, ROW1 + 40).lineTo(PERF - 24, ROW1 + 40).stroke();

  const ROW2 = ROW1 + 54;
  label("Dates", LX, ROW2);
  one("Oct 26–27, 2026", LX, ROW2 + 13, F.semi, 11, INK);
  one("Mon & Tue", LX, ROW2 + 28, F.regular, 9, MUTED);

  label("Venue", LX + 130, ROW2);
  one(EVENT.venue, LX + 130, ROW2 + 13, F.semi, 11, INK);
  one("1 Harbour Square, Toronto, ON", LX + 130, ROW2 + 28, F.regular, 9, MUTED);

  /* ---- right: QR stub ---- */
  const SX = PERF + 12, SW = CX + CW - SX - 12;
  const QR = 156;
  const qrX = SX + (SW - QR) / 2, qrY = CY + 30;
  doc.roundedRect(qrX - 10, qrY - 10, QR + 20, QR + 20, 12).fill("#ffffff");
  doc.lineWidth(1).strokeColor("#ddd0f6").roundedRect(qrX - 10, qrY - 10, QR + 20, QR + 20, 12).stroke();
  doc.image(qrPng, qrX, qrY, { width: QR, height: QR });

  one(booth ? "BOOKING REFERENCE" : "SCAN AT REGISTRATION", SX, qrY + QR + 20, F.bold, 7.5, LABEL,
      { width: SW, align: "center", characterSpacing: 1.8 });
  if (!booth) {
    one("Phone screen or printed — both work", SX, qrY + QR + 33, F.regular, 8.5, MUTED, { width: SW, align: "center" });
  }

  if (walletUrl) {
    const bw = 150, bh = 30, bx = SX + (SW - bw) / 2, by = CY + CH - 50;
    doc.roundedRect(bx, by, bw, bh, 8).fill("#000000");
    doc.lineWidth(0.75).strokeColor("#a6a6a6").roundedRect(bx, by, bw, bh, 8).stroke();
    one("Add to", bx, by + 6, F.regular, 6.5, "#ffffff", { width: bw, align: "center" });
    one("Apple Wallet", bx, by + 14, F.semi, 10, "#ffffff", { width: bw, align: "center" });
    doc.link(bx, by, bw, bh, walletUrl);
  } else {
    one(booth ? ticketId : `Ticket ${ticketId}`, SX, CY + CH - 38, F.mono, 9, MUTED, { width: SW, align: "center" });
  }

  /* ================= INCLUDES + TIPS ================= */
  const TOP = CY + CH + 28;
  const COL_L = 40, COL_LW = 238;
  const COL_R = 304, COL_RW = PAGE.w - 40 - COL_R;

  one(booth ? "YOUR BOOKING" : "YOUR PASS INCLUDES", COL_L, TOP, F.head, 9.5, INK, { characterSpacing: 1.2 });
  let ly = TOP + 22;
  const items = booth
    ? [passLabel, `Questions about your booth? ${EVENT.supportEmail}`]
    : inclusionsFor(tier);
  const lead = items.length > 8 ? 15.5 : 18;
  for (const it of items) {
    check(COL_L, ly - 0.5);
    one(it, COL_L + 17, ly, /lounge|pre-matched|preferential/i.test(it) ? F.semi : F.regular, 9.5, INK,
        { width: COL_LW - 17, ellipsis: true });
    ly += lead;
  }

  one("KNOW BEFORE YOU GO", COL_R, TOP, F.head, 9.5, INK, { characterSpacing: 1.2 });
  let ry = TOP + 22;
  for (const tip of knowBeforeYouGo(tier)) {
    dot(COL_R, ry + 3);
    const ls = wrap(tip, F.regular, 9, COL_RW - 14);
    ls.forEach((ln, i) => one(ln, COL_R + 14, ry + i * 12, F.regular, 9, "#3a3350"));
    ry += ls.length * 12 + 7;
  }

  /* ================= APP COMING SOON ================= */
  const AH = 66, AX = 32, AW = PAGE.w - 64;
  const AY = Math.min(Math.max(ly, ry) + 8, PAGE.h - 46 - 22 - AH);  // keep clear of the footer
  const app = doc.linearGradient(AX, 0, AX + AW, 0);
  app.stop(0, DARK).stop(1, "#2b0f5c");
  doc.roundedRect(AX, AY, AW, AH, 14).fill(app);

  // phone glyph
  const gx = AX + 20, gy = AY + 14;
  const tile = doc.linearGradient(gx, gy, gx + 38, gy + 38);
  tile.stop(0, PURPLE).stop(1, PINK);
  doc.roundedRect(gx, gy, 38, 38, 10).fill(tile);
  doc.lineWidth(1.6).strokeColor("#ffffff").roundedRect(gx + 12.5, gy + 7, 13, 24, 3).stroke();
  doc.circle(gx + 19, gy + 27.5, 1.2).fill("#ffffff");

  one("COMING SOON TO THE APP STORE", gx + 52, AY + 14, F.bold, 7, GOLD, { characterSpacing: 1.8 });
  one("The TTFC mobile app", gx + 52, AY + 25, F.head, 12, "#ffffff", { characterSpacing: 0.4 });
  one("Your agenda, your pass, networking and chat — all in one place.", gx + 52, AY + 44, F.regular, 8.8, "#d6cbf3");

  // "Coming soon" outline pill (not a store badge — the app isn't live yet)
  const pw = 92, px = AX + AW - pw - 18, py = AY + (AH - 24) / 2;
  doc.lineWidth(1).strokeColor("#8f78c9").roundedRect(px, py, pw, 24, 12).stroke();
  one("COMING SOON", px, py + 8, F.bold, 7.5, "#ffffff", { width: pw, align: "center", characterSpacing: 1.6 });

  /* ================= FOOTER ================= */
  const FY = PAGE.h - 46;
  doc.lineWidth(1).strokeColor("#e2d9f5").moveTo(40, FY - 10).lineTo(PAGE.w - 40, FY - 10).stroke();
  const footer = `${EVENT.websiteLabel}   ·   ${EVENT.supportEmail}   ·   ${EVENT.phone}`;
  doc.font(F.semi).fontSize(9);
  const fx = (PAGE.w - doc.widthOfString(footer)) / 2;
  one(footer, fx, FY, F.semi, 9, INK);
  doc.link(fx, FY - 2, doc.font(F.semi).fontSize(9).widthOfString(EVENT.websiteLabel), 13, EVENT.website);
  one("This pass admits the named attendee only. Keep it handy — you'll need the QR code at registration.",
      0, FY + 15, F.regular, 7.5, MUTED, { width: PAGE.w, align: "center" });

  doc.end();
  return done;
}

export default generateTicketPDF;
