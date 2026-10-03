import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PKPass } from "passkit-generator";

/* =========================================================
   Apple Wallet delegate pass (eventTicket)
   =========================================================
   Mirrors the PDF ticket (services/pdfTicket.js): purple spine
   colour as the background, orange labels, white values, and the
   same QR the website wallet and the door scanner use:
       TECHFEST:<ticketId>

   Signing needs an Apple Developer "Pass Type ID" certificate.
   Configure on Render (base64 so newlines survive):
     WALLET_PASS_TYPE_ID      e.g. pass.com.atlaslinkmarkets.ttfc
     WALLET_TEAM_ID           10-char Apple team id
     WALLET_SIGNER_CERT_B64   base64 of the pass certificate (PEM)
     WALLET_SIGNER_KEY_B64    base64 of its private key (PEM)
     WALLET_SIGNER_KEY_PASS   key passphrase (optional)
     WALLET_WWDR_CERT_B64     base64 of Apple WWDR G4 intermediate (PEM)
========================================================= */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = path.join(__dirname, "..", "assets", "wallet");

const b64 = (k) => (process.env[k] ? Buffer.from(process.env[k], "base64").toString("utf8") : "");

export function isConfigured() {
  return ["WALLET_PASS_TYPE_ID", "WALLET_TEAM_ID", "WALLET_SIGNER_CERT_B64", "WALLET_SIGNER_KEY_B64", "WALLET_WWDR_CERT_B64"]
    .every((k) => Boolean(process.env[k]));
}

const TIER_NAMES = { discover: "Discover Pass", connect: "Connect Pass", influence: "Influence Pass", power: "Power Pass", apex: "Apex Pass", vip: "Apex Pass" };
export const tierLabel = (key) => TIER_NAMES[String(key || "").toLowerCase()] || `${String(key || "Delegate")} Pass`;

/** Pure: the pass.json-level props + fields. Exported for tests. */
export function passContent({ ticketId, tier, name, purchaseDate }) {
  return {
    props: {
      formatVersion: 1,
      passTypeIdentifier: process.env.WALLET_PASS_TYPE_ID || "pass.com.atlaslinkmarkets.ttfc",
      teamIdentifier: process.env.WALLET_TEAM_ID || "TEAMID0000",
      serialNumber: String(ticketId),
      organizationName: "AtlasLink Markets Inc.",
      description: "The Tech Festival Canada 2026 — Delegate Pass",
      logoText: "TTFC 2026",
      foregroundColor: "rgb(255, 255, 255)",
      backgroundColor: "rgb(89, 38, 167)",   // #5926a7 — PDF spine
      labelColor: "rgb(244, 118, 0)",        // #f47600 — PDF eyebrow
      sharingProhibited: true,
    },
    header: [{ key: "dates", label: "OCT", value: "26–27" }],
    primary: [{ key: "attendee", label: "ATTENDEE", value: name || "Delegate" }],
    secondary: [
      { key: "pass", label: "PASS", value: tierLabel(tier) },
      { key: "venue", label: "VENUE", value: "Westin Harbour Castle" },
    ],
    auxiliary: [
      { key: "city", label: "CITY", value: "Toronto" },
      { key: "ticket", label: "TICKET", value: String(ticketId) },
    ],
    back: [
      { key: "address", label: "Address", value: "1 Harbour Square, Toronto, ON M5J 1A6" },
      { key: "doors", label: "Doors", value: "Registration opens 8:00 AM on Oct 26 and 8:30 AM on Oct 27." },
      ...(purchaseDate ? [{ key: "purchased", label: "Purchased", value: new Date(purchaseDate).toDateString() }] : []),
      { key: "support", label: "Help", value: "info@thetechfestival.com · thetechfestival.com" },
    ],
    barcode: { message: `TECHFEST:${ticketId}`, format: "PKBarcodeFormatQR", messageEncoding: "iso-8859-1", altText: String(ticketId) },
    relevantDate: "2026-10-26T08:00:00-04:00",
    location: { latitude: 43.6408, longitude: -79.3763, relevantText: "Welcome to TTFC 2026 — show this at registration." },
  };
}

function loadAssets() {
  const files = {};
  for (const f of fs.readdirSync(ASSET_DIR)) {
    if (f.endsWith(".png")) files[f] = fs.readFileSync(path.join(ASSET_DIR, f));
  }
  return files;
}

/** Builds and signs a .pkpass buffer. Throws when not configured. */
export async function buildPass(input, certificates = null) {
  const certs = certificates || {
    wwdr: b64("WALLET_WWDR_CERT_B64"),
    signerCert: b64("WALLET_SIGNER_CERT_B64"),
    signerKey: b64("WALLET_SIGNER_KEY_B64"),
    signerKeyPassphrase: process.env.WALLET_SIGNER_KEY_PASS || undefined,
  };
  const c = passContent(input);
  const pass = new PKPass(loadAssets(), certs, c.props);
  pass.type = "eventTicket";
  pass.headerFields.push(...c.header);
  pass.primaryFields.push(...c.primary);
  pass.secondaryFields.push(...c.secondary);
  pass.auxiliaryFields.push(...c.auxiliary);
  pass.backFields.push(...c.back);
  pass.setBarcodes(c.barcode);
  pass.setRelevantDate(new Date(c.relevantDate));
  pass.setLocations(c.location);
  return pass.getAsBuffer();
}
