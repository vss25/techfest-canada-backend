import zlib from "node:zlib";
import PDFDocument from "pdfkit";

/* =========================================================
   An MOU as a PDF (pdfkit, the contracts' brand colours) and as a Word file (.docx), Nov 23 2026.
   Both draw the same document from services/mou.js mouDocument(). The Word file is written by hand
   (a few XML parts in a zip; no new dependency): plain paragraphs, bold leads, bullets and a
   signature table, so it opens in Word, Google Docs and Pages and the partner can mark it up.
   TTFC's signature images print on the PDF of an exported MOU only, never on a draft.
========================================================= */

const NAVY = "#151035", MAGENTA = "#D6308C", GOLD = "#F5A623", INK = "#1F1B33", DIM = "#6B6880";
const imageOf = (dataUrl) => {
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(String(dataUrl || ""));
  return m ? Buffer.from(m[2], "base64") : null;
};

/** → Promise<Buffer> */
export function mouPdf(d) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", bufferPages: true, margins: { top: 48, bottom: 56, left: 54, right: 54 },
                                  info: { Title: `${d.number} · ${d.parties.partner[0] || ""}`, Author: d.parties.ttfc[0] } });
    const chunks = [];
    doc.on("data", (b) => chunks.push(b));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const W = doc.page.width, L = 54, R = W - 54, CW = R - L;

    doc.rect(0, 0, W, 96).fill(NAVY);
    doc.rect(0, 96, W, 4).fill(GOLD);
    doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(16).text(String(d.parties.ttfc[0]).toUpperCase(), L, 26, { width: CW - 210 });
    doc.font("Helvetica").fontSize(8.5).fillColor("#C9C4E0").text(d.parties.ttfc.slice(1).join("\n").replace(/\n(?=.)/g, "\n"), L, doc.y + 3, { width: CW - 210 });
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#FFFFFF").text(d.title, L, 26, { width: CW, align: "right" });
    doc.font("Helvetica").fontSize(9.5).fillColor("#C9C4E0").text(d.number, L, 44, { width: CW, align: "right" });
    doc.text(d.dateLabel, L, 58, { width: CW, align: "right" });

    let y = 118;
    const room = (h) => { if (y + h > doc.page.height - 70) { doc.addPage(); y = 54; } };
    if (d.banner) {
      doc.roundedRect(L, y, CW, 24, 4).fill("#FDECF4");
      doc.fillColor(MAGENTA).font("Helvetica-Bold").fontSize(10).text(d.banner, L, y + 7, { width: CW, align: "center" });
      y += 36;
    }

    const half = (CW - 24) / 2;
    const party = (x, title, lines) => {
      doc.fillColor(MAGENTA).font("Helvetica-Bold").fontSize(9).text(title, x, y, { width: half, characterSpacing: 0.6 });
      let yy = y + 15;
      lines.forEach((t, i) => {
        doc.fillColor(i === 0 ? INK : DIM).font(i === 0 ? "Helvetica-Bold" : "Helvetica").fontSize(i === 0 ? 11 : 9.5).text(t, x, yy, { width: half });
        yy = doc.y + 2;
      });
      return yy;
    };
    const y1 = party(L, "BETWEEN", d.parties.ttfc.slice(0, 2));
    const y2 = party(L + half + 24, "AND", d.parties.partner);
    y = Math.max(y1, y2) + 8;
    doc.fillColor(DIM).font("Helvetica").fontSize(9.5).text(`About: ${d.event}`, L, y, { width: CW });
    y = doc.y + 10;

    for (const s of d.sections) {
      room(60);
      y += 6;
      doc.fillColor(MAGENTA).font("Helvetica-Bold").fontSize(9).text(s.title, L, y, { characterSpacing: 0.6, width: CW });
      y = doc.y + 5;
      for (const p of s.paras) {
        const x = p.bullet ? L + 12 : L, w = p.bullet ? CW - 12 : CW;
        doc.font("Helvetica").fontSize(9.5);
        room(Math.min(doc.heightOfString(`${p.lead || ""}${p.text}`, { width: w, lineGap: 2 }), 120) + 4);
        if (p.bullet) doc.fillColor(MAGENTA).text("•", L, y);
        if (p.lead) doc.font("Helvetica-Bold").fillColor(INK).text(p.lead, x, y, { continued: true, width: w, lineGap: 2 }).font("Helvetica").text(p.text, { width: w, lineGap: 2 });
        else doc.fillColor(INK).text(p.text, x, y, { width: w, lineGap: 2 });
        y = doc.y + 5;
      }
    }

    room(140);
    y += 18;
    doc.fillColor(INK).font("Helvetica").fontSize(9).text("Signed by the parties on the dates below.", L, y);
    y = doc.y + 12;
    d.signers.forEach((sg, i) => {
      const x = i % 2 ? L + half + 24 : L;
      if (i % 2 === 0) room(90);
      const top = y;
      const img = imageOf(sg.signature);
      if (img) { try { doc.image(img, x, top, { fit: [half * 0.6, 34] }); } catch { /* bad image: blank line */ } }
      doc.moveTo(x, top + 38).lineTo(x + half, top + 38).strokeColor(INK).lineWidth(0.7).stroke();
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(9).text(sg.name, x, top + 43, { width: half });
      doc.fillColor(DIM).font("Helvetica").fontSize(8.5).text([sg.title, `For ${sg.side}`].filter(Boolean).join(" · "), x, doc.y + 1, { width: half });
      doc.text("Date: ____________________", x, doc.y + 6, { width: half });
      if (i % 2 === 1 || i === d.signers.length - 1) y = doc.y + 18;
    });

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0;
      doc.fillColor(DIM).font("Helvetica").fontSize(8)
        .text([d.number, d.parties.partner[0], `Page ${i + 1} of ${range.count}`].filter(Boolean).join(" · "), L, doc.page.height - 40, { width: CW, align: "center", lineBreak: false });
    }
    doc.end();
  });
}

/* ---------------- Word (.docx) ---------------- */

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const run = (t, { bold = false, size = 20, color = "" } = {}) =>
  `<w:r><w:rPr>${bold ? "<w:b/>" : ""}${color ? `<w:color w:val="${color}"/>` : ""}<w:sz w:val="${size}"/></w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
const par = (runs, { align = "", after = 120, indent = 0 } = {}) =>
  `<w:p><w:pPr><w:spacing w:after="${after}"/>${indent ? `<w:ind w:left="${indent}" w:hanging="240"/>` : ""}${align ? `<w:jc w:val="${align}"/>` : ""}</w:pPr>${runs}</w:p>`;

export function mouDocumentXml(d) {
  const body = [];
  body.push(par(run(d.title, { bold: true, size: 32, color: "151035" }), { align: "center", after: 60 }));
  body.push(par(run(`${d.number} · ${d.dateLabel}`, { size: 20, color: "6B6880" }), { align: "center", after: 240 }));
  if (d.banner) body.push(par(run(d.banner, { bold: true, color: "D6308C" }), { align: "center" }));
  body.push(par(run("Between ", { color: "6B6880" }) + run(d.parties.ttfc[0], { bold: true }) + (d.parties.ttfc[1] ? run(`, ${d.parties.ttfc[1]}`) : "")));
  body.push(par(run("and ", { color: "6B6880" }) + run(d.parties.partner[0] || "", { bold: true }) + (d.parties.partner.length > 1 ? run(`, ${d.parties.partner.slice(1).join(", ")}`) : "")));
  body.push(par(run(`About: ${d.event}`, { color: "6B6880" }), { after: 240 }));
  for (const s of d.sections) {
    body.push(par(run(s.title, { bold: true, size: 20, color: "D6308C" }), { after: 80 }));
    for (const p of s.paras) {
      body.push(par((p.bullet ? run("•\t") : "") + (p.lead ? run(p.lead, { bold: true }) : "") + run(p.text), { indent: p.bullet ? 360 : 0 }));
    }
  }
  body.push(par(run("Signed by the parties on the dates below."), { after: 240 }));
  const cell = (sg) => `<w:tc><w:tcPr><w:tcW w:w="4500" w:type="dxa"/></w:tcPr>${sg
    ? par(run("_______________________________")) + par(run(sg.name, { bold: true }), { after: 0 }) + par(run([sg.title, `For ${sg.side}`].filter(Boolean).join(" · "), { size: 18, color: "6B6880" }), { after: 0 }) + par(run("Date: ______________", { size: 18 }), { after: 240 })
    : par("")}</w:tc>`;
  const rows = [];
  for (let i = 0; i < d.signers.length; i += 2) rows.push(`<w:tr>${cell(d.signers[i])}${cell(d.signers[i + 1])}</w:tr>`);
  if (rows.length) body.push(`<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders/></w:tblPr><w:tblGrid><w:gridCol w:w="4500"/><w:gridCol w:w="4500"/></w:tblGrid>${rows.join("")}</w:tbl>`);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join("")}<w:p/><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
}

/** A zip of { name: string | Buffer } (stored, not compressed: small files, no dependency). */
export function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const nameBuf = Buffer.from(name, "utf8");
    const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12); cen.writeUInt16LE(0x21, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    parts.push(local, nameBuf, data);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  const n = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(n, 8); end.writeUInt16LE(n, 10);
  end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cenBuf, end]);
}

/** → Buffer (.docx) */
export function mouDocx(d) {
  return zip({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": mouDocumentXml(d),
  });
}
