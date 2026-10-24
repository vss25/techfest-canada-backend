import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PKPass } from "passkit-generator";
import { typeInfo } from "./teamRoles.js";
import { profileTagOf, profileTagOfPass } from "./profileTag.js";
import { doorQrText } from "./doorQr.js";

/* =========================================================
   Apple Wallet delegate pass (eventTicket)
   =========================================================
   Mirrors the PDF ticket (services/pdfTicket.js): purple spine
   colour as the background, orange labels, white values, and the
   same QR the website wallet and the door scanner use:
       TECHFEST:<ticketId>
   Since Oct 20 2026 the pass is in the holder's Profile colour
   (the organiser: "the pass in apple wallet is the same as the hue
   they're getting in the profile section (golden pass for vip,
   etc.)"): services/profileTag.js decides (Media > Speaker > Staff >
   Volunteer > any other pass; VIP left it on Oct 21 2026: "Don't
   label anyone as VIP", so there's no gold pass any more),
   WALLET_COLORS has the background, values and labels for each, and
   someone with no tag keeps the purple pass. On the light passes
   (Volunteer orange, other passes green) the logo's words are dark
   (assets/wallet/dark). Wallet draws the QR on its own white panel,
   whatever the colours. A pass already in someone's Wallet keeps the
   colours it was added with (no Wallet web service): adding it again
   gets the new ones.

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

const TIER_NAMES = { discover: "Discover Pass", connect: "Connect Pass", influence: "Influence Pass", power: "Power Pass", apex: "Apex Pass", vip: "Apex Pass", speaker: "Speaker Pass" };
// "All Access" is the Power Pass's other name (Oct 19 2026); the internal Speaker Pass shows as "Speaker Pass".
export const tierLabel = (key) => {
  const k = String(key || "").trim().toLowerCase();
  return TIER_NAMES[/^all[- ]?access( pass)?$/.test(k) ? "power" : k] || `${String(key || "Delegate")} Pass`;
};

const rgb = (hex) => {
  const n = parseInt(String(hex).replace("#", ""), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

/** The pass's colours for each Profile tag (services/profileTag.js), the same hue as the Profile page. `logo`:
    which logo the colour needs ("dark": the words in dark ink, for the light backgrounds). */
export const WALLET_COLORS = Object.freeze({
  media: Object.freeze({ background: "#0B3D91", foreground: "#FFFFFF", label: "#C9D7F2", logo: "light" }),
  speaker: Object.freeze({ background: "#D01F2F", foreground: "#FFFFFF", label: "#FAD4D8", logo: "light" }),
  staff: Object.freeze({ background: "#7B2FD0", foreground: "#FFFFFF", label: "#E3D2F7", logo: "light" }),
  volunteer: Object.freeze({ background: "#FF6B00", foreground: "#3A1500", label: "#5A2400", logo: "dark" }),
  pass: Object.freeze({ background: "#18A957", foreground: "#052E16", label: "#0B4A26", logo: "dark" }),
});
/** No tag (no pass and none of the tags): the purple pass, as before. */
export const DEFAULT_WALLET_COLORS = Object.freeze({ background: "#5926A7", foreground: "#FFFFFF", label: "#F47600", logo: "light" });

/** { backgroundColor, foregroundColor, labelColor } in Wallet's "rgb(r, g, b)" and the logo, for a profileTag. */
export function walletColorsFor(tag) {
  const c = WALLET_COLORS[tag?.key] || DEFAULT_WALLET_COLORS;
  return { backgroundColor: rgb(c.background), foregroundColor: rgb(c.foreground), labelColor: rgb(c.label), logo: c.logo };
}

/**
 * The Profile tag of whoever holds the pass, from the records the route found (pure; the route loads them):
 *   account   their User (role, types, typesOff, tickets): the same tag GET /auth/me sends, with
 *             `index` (services/exhibitorCache.js loadExhibitors) for a pass of theirs marked Media / exhibitor
 *   attendee  a pass-only person's Attendee record (no account has the ticket)
 * → { key, label } | null
 */
export function walletTagFor({ account = null, attendee = null, index = null } = {}) {
  if (account) {
    const { types } = typeInfo(account, index);
    return profileTagOf(account, { types });
  }
  return attendee ? profileTagOfPass(attendee) : null;
}

/** Pure: the pass.json-level props + fields. Exported for tests. `tag`: the holder's profileTag (walletTagFor). */
export function passContent({ ticketId, tier, name, purchaseDate, tag = null }) {
  const colors = walletColorsFor(tag);
  return {
    props: {
      formatVersion: 1,
      passTypeIdentifier: process.env.WALLET_PASS_TYPE_ID || "pass.com.atlaslinkmarkets.ttfc",
      teamIdentifier: process.env.WALLET_TEAM_ID || "TEAMID0000",
      serialNumber: String(ticketId),
      organizationName: "AtlasLink Markets Inc.",
      description: "The Tech Festival Canada 2026 — Delegate Pass",
      logoText: "TTFC 2026",
      // The holder's Profile colour (WALLET_COLORS); no tag: #5926a7 (the PDF spine) with #f47600 labels (its eyebrow).
      foregroundColor: colors.foregroundColor,
      backgroundColor: colors.backgroundColor,
      labelColor: colors.labelColor,
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
      { key: "support", label: "Help", value: "enquire@thetechfestival.com · thetechfestival.com" },
    ],
    barcode: { message: doorQrText(ticketId), format: "PKBarcodeFormatQR", messageEncoding: "iso-8859-1", altText: String(ticketId) },
    relevantDate: "2026-10-26T08:00:00-04:00",
    location: { latitude: 43.6408, longitude: -79.3763, relevantText: "Welcome to TTFC 2026 — show this at registration." },
  };
}

/** The pass images (icon, logo). `logo` "dark": the logo with its words in dark ink (assets/wallet/dark). */
export function loadAssets({ logo = "light" } = {}) {
  const files = {};
  for (const f of fs.readdirSync(ASSET_DIR)) {
    if (f.endsWith(".png")) files[f] = fs.readFileSync(path.join(ASSET_DIR, f));
  }
  if (logo === "dark") {
    const dir = path.join(ASSET_DIR, "dark");
    for (const f of fs.readdirSync(dir)) if (f.endsWith(".png")) files[f] = fs.readFileSync(path.join(dir, f));
  }
  return files;
}

/** The pass, ready to sign (`certificates`: the Pass Type ID cert, else the env's). buildPass signs it. */
export function makePass(input, certificates = null) {
  const certs = certificates || {
    wwdr: b64("WALLET_WWDR_CERT_B64"),
    signerCert: b64("WALLET_SIGNER_CERT_B64"),
    signerKey: b64("WALLET_SIGNER_KEY_B64"),
    signerKeyPassphrase: process.env.WALLET_SIGNER_KEY_PASS || undefined,
  };
  const c = passContent(input);
  const pass = new PKPass(loadAssets({ logo: walletColorsFor(input?.tag).logo }), certs, c.props);
  pass.type = "eventTicket";
  pass.headerFields.push(...c.header);
  pass.primaryFields.push(...c.primary);
  pass.secondaryFields.push(...c.secondary);
  pass.auxiliaryFields.push(...c.auxiliary);
  pass.backFields.push(...c.back);
  pass.setBarcodes(c.barcode);
  pass.setRelevantDate(new Date(c.relevantDate));
  pass.setLocations(c.location);
  return pass;
}

/** Builds and signs a .pkpass buffer. Throws when not configured. */
export async function buildPass(input, certificates = null) {
  return makePass(input, certificates).getAsBuffer();
}
