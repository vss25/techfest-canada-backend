import PDFDocument from "pdfkit";
import { money, totals, SETTING_DEFAULTS } from "./contracts.js";

/* =========================================================
   A contract as a PDF (Nov 18 2026), in the brand colours: navy #151035 header, magenta #D6308C
   accents, gold #F5A623 rule. Letter size.
   `issuer` = TTFC's fixed details from Contract settings (company, HST number, signatories with
   their signature images, header / footer / confidential label, the standard clauses), as frozen on
   the contract when it was sent or signed, else the current settings for a draft.
   Directors' signature images print only once the contract is sent or signed, never on a draft.
   A contract whose prices still wait for approval prints "DRAFT: prices not yet approved".
========================================================= */

const NAVY = "#151035", MAGENTA = "#D6308C", GOLD = "#F5A623", INK = "#1F1B33", DIM = "#6B6880", RULE = "#E4E2EC";

const day = (d) => (d ? new Date(d).toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric", timeZone: "America/Toronto" }) : "");
const imageOf = (dataUrl) => {
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(String(dataUrl || ""));
  return m ? Buffer.from(m[2], "base64") : null;
};

/** → Promise<Buffer> */
export function contractPdf(c, { approvedPrices = true, issuer = null } = {}) {
  const I = issuer || SETTING_DEFAULTS;
  const co = { ...SETTING_DEFAULTS.company, ...(I.company || {}) };
  const docText = { ...SETTING_DEFAULTS.document, ...(I.document || {}) };
  const signatories = (I.signatories || []).filter((s) => s.name || s.title);
  const clauses = (I.clauses || []).filter((x) => x.title || x.body);
  const final = c.status === "sent" || c.status === "signed";

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", bufferPages: true, margins: { top: 48, bottom: 56, left: 54, right: 54 },
                                  info: { Title: `${c.number || "Contract"} · ${c.company?.name || ""}`, Author: co.legalName } });
    const chunks = [];
    doc.on("data", (b) => chunks.push(b));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const W = doc.page.width, L = 54, R = W - 54, CW = R - L;
    const contact = [co.website, co.email, co.phone].filter(Boolean).join("  ·  ");

    // Header band
    doc.rect(0, 0, W, 104).fill(NAVY);
    doc.rect(0, 104, W, 4).fill(GOLD);
    doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(16).text(co.legalName.toUpperCase(), L, 26, { width: CW - 190 });
    let hy = doc.y + 3;
    doc.font("Helvetica").fontSize(8.5).fillColor("#C9C4E0");
    if (co.address) { doc.text(co.address.replace(/\n/g, ", "), L, hy, { width: CW - 190 }); hy = doc.y + 1; }
    if (contact) { doc.text(contact, L, hy, { width: CW - 190 }); hy = doc.y + 1; }
    if (co.hstNumber) doc.text(`HST/GST no. ${co.hstNumber}`, L, hy, { width: CW - 190 });
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#FFFFFF").text(docText.header, L, 26, { width: CW, align: "right" });
    doc.font("Helvetica").fontSize(9.5).fillColor("#C9C4E0").text(c.number || "Draft", L, 44, { width: CW, align: "right" });
    doc.text(day(c.sentAt || c.updatedAt || Date.now()), L, 58, { width: CW, align: "right" });
    if (docText.confidential) doc.font("Helvetica-Bold").fontSize(8.5).fillColor(GOLD).text(docText.confidentialLabel, L, 76, { width: CW, align: "right", characterSpacing: 1 });

    let y = 126;
    const newPage = () => { doc.addPage(); y = 54; };
    const room = (h) => { if (y + h > doc.page.height - 70) newPage(); };
    const banner = c.status === "cancelled" ? "CANCELLED"
      : !approvedPrices ? "DRAFT: prices not yet approved by TTFC management"
      : c.status === "draft" ? "DRAFT" : "";
    if (banner) {
      doc.roundedRect(L, y, CW, 24, 4).fill("#FDECF4");
      doc.fillColor(MAGENTA).font("Helvetica-Bold").fontSize(10).text(banner, L, y + 7, { width: CW, align: "center" });
      y += 36;
    }

    // Parties
    const half = (CW - 24) / 2;
    const party = (x, title, lines) => {
      doc.fillColor(MAGENTA).font("Helvetica-Bold").fontSize(9).text(title, x, y, { width: half, characterSpacing: 0.6 });
      let yy = y + 15;
      lines.filter(Boolean).forEach((t, i) => {
        doc.fillColor(i === 0 ? INK : DIM).font(i === 0 ? "Helvetica-Bold" : "Helvetica").fontSize(i === 0 ? 11 : 9.5).text(t, x, yy, { width: half });
        yy = doc.y + 2;
      });
      return yy;
    };
    const y1 = party(L, "PARTNER", [c.company?.name, c.company?.address, c.company?.website,
      [c.contact?.name, c.contact?.title].filter(Boolean).join(", "), c.contact?.email, c.contact?.phone]);
    const y2 = party(L + half + 24, "EVENT", [c.eventName || c.eventKey, co.legalName]);
    y = Math.max(y1, y2) + 16;

    // Items
    const cols = [{ w: CW - 250 }, { w: 50, a: "right" }, { w: 100, a: "right" }, { w: 100, a: "right" }];
    const row = (cells, { bold = false, color = INK, size = 9.5 } = {}) => {
      let x = L, h = 0;
      cells.forEach((cell, i) => {
        doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size);
        h = Math.max(h, doc.heightOfString(String(cell ?? ""), { width: cols[i].w - 8 }));
      });
      room(h + 10);
      cells.forEach((cell, i) => {
        doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(color)
          .text(String(cell ?? ""), x + (i ? 4 : 0), y, { width: cols[i].w - 8, align: cols[i].a || "left" });
        x += cols[i].w;
      });
      y += h + 8;
    };
    doc.rect(L, y - 4, CW, 22).fill("#F4F2F9");
    y += 2;
    row(["Item", "Qty", "Unit price", "Amount"], { bold: true, color: NAVY, size: 9 });
    for (const l of c.lines || []) {
      const sub = [l.description, ...(l.items || []).map((it) => `• ${it.qty} × ${it.name}`)].filter(Boolean).join("\n");
      const unit = l.unitPrice < l.listPrice ? `${money(l.unitPrice)}\n(list ${money(l.listPrice)})` : money(l.unitPrice);
      row([l.name, String(l.qty), unit, money(l.unitPrice * l.qty)], { bold: true });
      if (sub) { y -= 4; row([sub, "", "", ""], { color: DIM, size: 8.5 }); }
      doc.moveTo(L, y - 3).lineTo(R, y - 3).strokeColor(RULE).lineWidth(0.6).stroke();
    }

    // Totals
    const t = totals(c.lines || [], c.taxRate);
    y += 6;
    const tot = (label, value, strong) => {
      room(20);
      doc.font(strong ? "Helvetica-Bold" : "Helvetica").fontSize(strong ? 11 : 9.5).fillColor(strong ? NAVY : INK)
        .text(label, R - 260, y, { width: 150, align: "right" }).text(value, R - 100, y, { width: 100, align: "right" });
      y += strong ? 20 : 15;
    };
    if (t.discount > 0) tot("Partner discount", `-${money(t.discount)}`);
    tot("Subtotal", money(t.subtotal));
    tot(t.taxRate ? `Tax (${t.taxRate}%)` : "Tax", money(t.tax));
    doc.moveTo(R - 260, y - 2).lineTo(R, y - 2).strokeColor(GOLD).lineWidth(1.2).stroke();
    y += 4;
    tot("Total (CAD)", money(t.total), true);

    // Payment, special terms, standard clauses
    const heading = (title) => {
      room(60);
      y += 8;
      doc.fillColor(MAGENTA).font("Helvetica-Bold").fontSize(9).text(title, L, y, { characterSpacing: 0.6 });
      y = doc.y + 4;
    };
    const para = (body, { bold = "" } = {}) => {
      doc.font("Helvetica").fontSize(9);
      const h = doc.heightOfString(`${bold}${body}`, { width: CW, lineGap: 2 });
      room(Math.min(h, 120));
      if (bold) doc.font("Helvetica-Bold").fillColor(INK).text(bold, L, y, { continued: true, width: CW, lineGap: 2 }).font("Helvetica").text(body, { width: CW, lineGap: 2 });
      else doc.fillColor(INK).text(body, L, y, { width: CW, lineGap: 2 });
      y = doc.y + 6;
    };
    if (c.paymentTerms) { heading("PAYMENT"); para(c.paymentTerms); }
    if (c.terms) { heading("SPECIAL TERMS FOR THIS AGREEMENT"); para(c.terms); }
    if (clauses.length) {
      heading("TERMS AND CONDITIONS");
      clauses.forEach((cl, i) => para(cl.body || "", { bold: `${i + 1}. ${cl.title ? `${cl.title}. ` : ""}` }));
    }

    // Signatures: the partner on the left, TTFC's signatories on the right
    room(150);
    y += 20;
    doc.fillColor(INK).font("Helvetica").fontSize(9).text("Signed by the parties on the dates below.", L, y);
    y = doc.y + 12;
    const sigLine = (x, label, name, title, image) => {
      if (image && final) { try { doc.image(image, x, y, { fit: [half * 0.6, 34] }); } catch { /* bad image: leave the line blank */ } }
      doc.moveTo(x, y + 38).lineTo(x + half, y + 38).strokeColor(INK).lineWidth(0.7).stroke();
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(9).text(name || " ", x, y + 43, { width: half });
      doc.fillColor(DIM).font("Helvetica").fontSize(8.5).text([title, label].filter(Boolean).join(" · "), x, doc.y + 1, { width: half });
      doc.text("Date: ____________________", x, doc.y + 6, { width: half });
    };
    const startY = y;
    sigLine(L, `For ${c.company?.name || "the partner"}`, c.signerName || c.contact?.name || "", c.contact?.title || "", null);
    let rightY = startY;
    (signatories.length ? signatories : [{ name: "", title: "" }]).forEach((sg) => {
      y = rightY;
      room(80);
      sigLine(L + half + 24, `For ${co.legalName}`, sg.name, sg.title, imageOf(sg.signature));
      rightY = doc.y + 18;
    });

    // Footer on every page
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0;
      const parts = [docText.confidential ? docText.confidentialLabel : "", c.number || "Draft", c.company?.name || "", `Page ${i + 1} of ${range.count}`].filter(Boolean);
      doc.fillColor(DIM).font("Helvetica").fontSize(8).text(parts.join(" · "), L, doc.page.height - 40, { width: CW, align: "center", lineBreak: false });
      if (docText.footer) doc.fontSize(7.5).text(docText.footer, L, doc.page.height - 28, { width: CW, align: "center", lineBreak: false });
    }
    doc.end();
  });
}
