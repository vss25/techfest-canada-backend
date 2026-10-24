/* The one door QR text (services/doorQr.js, Oct 24 2026): every place that draws a ticket's QR uses it, so the pass
   emails, the purchase email's image, the PDF ticket and Apple Wallet all hold "TECHFEST:<ticketId>" (the apps draw the
   same: iOS QRPayload.techfestTicket, Android TicketCatalog.qrPayload, the web app src/app/lib/qr.js passPayload). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanTicketId, doorQrText, DOOR_QR_PREFIX } from "../services/doorQr.js";
import { qrPayload } from "../services/speakerPassEmail.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

test("the door QR text: TECHFEST: and the ticket ID as stored, whatever form it came in", () => {
  assert.equal(DOOR_QR_PREFIX, "TECHFEST:");
  for (const form of ["c3be67cfd55f", "C3BE67CFD55F", "TECHFEST:c3be67cfd55f", "techfest:C3BE67CFD55F", " c3be 67cf d55f "]) {
    assert.equal(cleanTicketId(form), "c3be67cfd55f", form);
    assert.equal(doorQrText(form), "TECHFEST:c3be67cfd55f", form);
  }
  assert.equal(cleanTicketId(""), "");
  // The pass emails (issued, speaker, exhibitor, awards) draw exactly this text.
  assert.equal(qrPayload("c3be67cfd55f"), "TECHFEST:c3be67cfd55f");
});

test("every QR generator on the server uses the one text", () => {
  for (const f of ["services/pdfTicket.js", "routes/wallet.js", "services/walletPass.js", "services/speakerPassEmail.js"]) {
    assert.match(read(f), /doorQrText\(/, f);
  }
  // No QR drawn straight from a bare ticket ID any more.
  for (const f of ["services/pdfTicket.js", "routes/wallet.js"]) assert.doesNotMatch(read(f), /QRCode\.toBuffer\(ticketId[,)]/, f);
  assert.doesNotMatch(read("services/walletPass.js"), /message: `TECHFEST:\$\{ticketId\}`/);
});
