import test from "node:test";
import assert from "node:assert/strict";
import { passContent, tierLabel } from "../services/walletPass.js";

test("wallet pass carries the door-scanner QR and the ticket tier", () => {
  const c = passContent({ ticketId: "a1b2c3", tier: "influence", name: "Alex Tester" });
  assert.equal(c.barcode.message, "TECHFEST:a1b2c3");
  assert.equal(c.barcode.format, "PKBarcodeFormatQR");
  assert.equal(c.primary[0].value, "Alex Tester");
  assert.equal(c.secondary[0].value, "Influence Pass");
  assert.equal(c.props.serialNumber, "a1b2c3");
  assert.match(c.secondary[1].value, /Westin Harbour Castle/);
});

test("tierLabel maps backend keys", () => {
  assert.equal(tierLabel("power"), "Power Pass");
  assert.equal(tierLabel("vip"), "Apex Pass");
});
