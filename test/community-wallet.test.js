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

import { toUpdates, dateLabel, queryFor } from "../services/newsFeed.js";

test("GDELT articles become dated, de-duplicated updates", () => {
  const json = { articles: [
    { title: "DHL Group expands cold-chain network across Canada", url: "https://a", domain: "www.reuters.com", seendate: "20261002T120000Z" },
    { title: "DHL Group expands cold-chain network across Canada", url: "https://b", domain: "x.com", seendate: "20261002T130000Z" },
    { title: "short", url: "https://c", domain: "y.com", seendate: "20261001T000000Z" },
    { title: "DHL opens a new Toronto hub for e-commerce parcels", url: "https://d", domain: "globenewswire.com", seendate: "20260930T000000Z" },
  ] };
  const u = toUpdates(json);
  assert.equal(u.length, 2);
  assert.equal(u[0].source, "reuters.com");
  assert.equal(u[0].dateLabel, dateLabel("20261002T120000Z"));
  assert.equal(u[1].url, "https://d");
});

test("GDELT query hints disambiguate short names", () => {
  assert.match(queryFor("BDC"), /Business Development Bank of Canada/);
  assert.match(queryFor("NVIDIA"), /"NVIDIA" sourcelang:english/);
});
