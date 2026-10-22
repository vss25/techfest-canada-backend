import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import forge from "node-forge";
import {
  DEFAULT_WALLET_COLORS, WALLET_COLORS, loadAssets, makePass, passContent, walletColorsFor, walletTagFor,
} from "../services/walletPass.js";
import { profileTagOfPass } from "../services/profileTag.js";
import { exhibitorIndex } from "../services/teamRoles.js";

/* Apple Wallet in the holder's Profile colour (Oct 20 2026, the organiser: "the pass in apple wallet is the same
   as the hue they're getting in the profile section (golden pass for vip, etc.)"). Both ways a pass is made: a
   signed-in account's ticket and the signed email link for a pass-only person. No gold VIP pass since Oct 21 2026
   ("Don't label anyone as VIP"): a VIP's pass is in their next tag's colour. Fictional people. */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(HERE, "..", "assets", "wallet");
const t = (ticketId, type, extra = {}) => ({ ticketId, type, purchaseDate: new Date("2026-10-01"), ...extra });

test("Wallet colours: each Profile tag's background, values and labels, in Wallet's rgb() format", () => {
  const want = {
    media: ["rgb(11, 61, 145)", "rgb(255, 255, 255)", "rgb(201, 215, 242)", "light"],
    speaker: ["rgb(208, 31, 47)", "rgb(255, 255, 255)", "rgb(250, 212, 216)", "light"],
    staff: ["rgb(123, 47, 208)", "rgb(255, 255, 255)", "rgb(227, 210, 247)", "light"],
    volunteer: ["rgb(255, 107, 0)", "rgb(58, 21, 0)", "rgb(90, 36, 0)", "dark"],
    pass: ["rgb(24, 169, 87)", "rgb(5, 46, 22)", "rgb(11, 74, 38)", "dark"],
  };
  assert.deepEqual(Object.keys(WALLET_COLORS), Object.keys(want));
  for (const [key, [bg, fg, label, logo]] of Object.entries(want)) {
    assert.deepEqual(walletColorsFor({ key, label: "x" }), { backgroundColor: bg, foregroundColor: fg, labelColor: label, logo }, key);
  }
  // The same hues as the Profile page (services/profileTag.js PROFILE_TAG_COLORS); no gold VIP pass.
  assert.equal("vip" in WALLET_COLORS, false);
  assert.equal(WALLET_COLORS.media.background, "#0B3D91");
  assert.equal(WALLET_COLORS.pass.foreground, "#052E16");
});

test("no tag (or an unknown one): today's purple pass, unchanged", () => {
  const before = { backgroundColor: "rgb(89, 38, 167)", foregroundColor: "rgb(255, 255, 255)", labelColor: "rgb(244, 118, 0)", logo: "light" };
  assert.deepEqual(walletColorsFor(null), before);
  assert.deepEqual(walletColorsFor({ key: "gold" }), before);
  assert.deepEqual(walletColorsFor({ key: "vip", label: "VIP" }), before);   // an old "vip" tag: no gold
  assert.equal(DEFAULT_WALLET_COLORS.background, "#5926A7");
  const c = passContent({ ticketId: "a1b2c3", tier: "connect", name: "Nia Example" });
  assert.deepEqual([c.props.backgroundColor, c.props.foregroundColor, c.props.labelColor], [before.backgroundColor, before.foregroundColor, before.labelColor]);
});

test("pass.json takes the tag's colours; the QR, fields and pass type stay as they are", () => {
  const plain = passContent({ ticketId: "a1b2c3", tier: "power", name: "Vera Example" });
  const vip = passContent({ ticketId: "a1b2c3", tier: "power", name: "Vera Example", tag: { key: "speaker", label: "Speaker" } });
  assert.deepEqual([vip.props.backgroundColor, vip.props.foregroundColor, vip.props.labelColor], ["rgb(208, 31, 47)", "rgb(255, 255, 255)", "rgb(250, 212, 216)"]);
  assert.deepEqual(vip.barcode, plain.barcode);
  assert.equal(vip.barcode.message, "TECHFEST:a1b2c3");
  assert.deepEqual([vip.header, vip.primary, vip.secondary, vip.auxiliary, vip.back], [plain.header, plain.primary, plain.secondary, plain.auxiliary, plain.back]);
  const { backgroundColor, foregroundColor, labelColor, ...restVip } = vip.props; // eslint-disable-line no-unused-vars
  const { backgroundColor: b2, foregroundColor: f2, labelColor: l2, ...restPlain } = plain.props; // eslint-disable-line no-unused-vars
  assert.deepEqual(restVip, restPlain);
});

test("a signed-in account's ticket: the same tag as GET /auth/me (types, passes marked on the index; never VIP)", () => {
  const acc = (extra) => ({ _id: "u1", name: "Pat Example", role: "user", tickets: [t("pow400000001", "power")], ...extra });
  assert.deepEqual(walletTagFor({ account: acc({ vip: true, types: ["speaker"] }) }), { key: "speaker", label: "Speaker" });
  assert.deepEqual(walletTagFor({ account: acc({ vip: true }) }), { key: "pass", label: "Power" });
  assert.deepEqual(walletTagFor({ account: acc({ types: ["speaker", "media"] }) }), { key: "media", label: "Media" });
  assert.deepEqual(walletTagFor({ account: acc({ tickets: [t("spk400000001", "speaker")] }) }), { key: "speaker", label: "Speaker" });
  assert.deepEqual(walletTagFor({ account: acc({ role: "admin" }) }), { key: "staff", label: "Staff" });
  assert.deepEqual(walletTagFor({ account: acc({ role: "volunteer", tickets: [t("con400000001", "connect")] }) }), { key: "volunteer", label: "Volunteer" });
  assert.deepEqual(walletTagFor({ account: acc() }), { key: "pass", label: "Power" });
  assert.equal(walletTagFor({ account: acc({ tickets: [] }) }), null);
  // A pass of theirs marked Media, or an exhibitor pass they claimed (the exhibitor index, as /auth/me); a VIP mark: nothing.
  assert.equal(walletTagFor({ account: acc(), index: exhibitorIndex([], { vipRows: [{ claimedBy: "u1" }] }) }).label, "Power");
  assert.equal(walletTagFor({ account: acc(), index: exhibitorIndex([], { mediaRows: [{ ticketId: "pow400000001" }] }) }).key, "media");
  const eve = acc({ tickets: [t("con400000002", "connect")] });
  assert.deepEqual(walletTagFor({ account: eve, index: exhibitorIndex([{ claimedBy: "u1", ticketId: "con400000002" }]) }), { key: "pass", label: "Exhibitor" });
  // The account wins over the Attendee record when both are given.
  assert.equal(walletTagFor({ account: acc(), attendee: { ticketId: "pow400000001", ticketType: "power", vip: true } }).label, "Power");
});

test("the signed email link for a pass-only person: their Attendee record's marks and pass", () => {
  const a = (extra) => ({ ticketId: "pow400000003", ticketType: "power", name: "Gia Example", ...extra });
  assert.deepEqual(walletTagFor({ attendee: a({ vip: true }) }), { key: "pass", label: "Power" });   // VIP mark: no gold
  assert.deepEqual(walletTagFor({ attendee: a({ media: true }) }), { key: "media", label: "Media" });
  assert.deepEqual(walletTagFor({ attendee: a({ vip: true, media: true }) }), { key: "media", label: "Media" });
  assert.deepEqual(walletTagFor({ attendee: a({ ticketType: "speaker" }) }), { key: "speaker", label: "Speaker" });
  assert.deepEqual(walletTagFor({ attendee: a({ ticketType: "speaker", promoCode: "SPEAKER", media: true }) }), { key: "media", label: "Media" });
  assert.deepEqual(walletTagFor({ attendee: a({ ticketType: "connect", promoCode: "EXHIBITOR" }) }), { key: "pass", label: "Exhibitor" });
  // Staff switched the exhibitor off on this pass: just a Connect Pass.
  assert.deepEqual(walletTagFor({ attendee: a({ ticketType: "connect", promoCode: "EXHIBITOR", exhibitor: false }) }), { key: "pass", label: "Connect" });
  assert.deepEqual(walletTagFor({ attendee: a({ ticketType: "connect", exhibitor: true }) }), { key: "pass", label: "Exhibitor" });
  assert.deepEqual(walletTagFor({ attendee: a({ ticketType: "All Access Pass" }) }), { key: "pass", label: "Power" });
  assert.deepEqual(walletTagFor({ attendee: a() }), { key: "pass", label: "Power" });
  assert.deepEqual(profileTagOfPass(a({ ticketType: "apex" })), { key: "pass", label: "Apex" });
  assert.equal(walletTagFor({}), null);
  assert.equal(profileTagOfPass(null), null);
});

test("pass images: the light passes get the logo with dark words; the icon never changes", () => {
  const light = loadAssets();
  const dark = loadAssets({ logo: "dark" });
  assert.deepEqual(Object.keys(dark).sort(), Object.keys(light).sort());
  for (const f of ["logo.png", "logo@2x.png", "logo@3x.png"]) {
    assert.ok(!dark[f].equals(light[f]), f);
    assert.ok(dark[f].equals(fs.readFileSync(path.join(ASSETS, "dark", f))), f);
  }
  for (const f of ["icon.png", "icon@2x.png", "icon@3x.png"]) assert.ok(dark[f].equals(light[f]), f);
});

/** A throwaway self-signed certificate, only so the pass can be signed and read back in the test. */
function testCertificates() {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date("2026-01-01");
  cert.validity.notAfter = new Date("2027-01-01");
  const attrs = [{ name: "commonName", value: "TTFC test only" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const pem = forge.pki.certificateToPem(cert);
  return { wwdr: pem, signerCert: pem, signerKey: forge.pki.privateKeyToPem(keys.privateKey) };
}

test("the signed .pkpass: pass.json in the tag's colours, the dark-worded logo on green, the QR as before", () => {
  const certs = testCertificates();
  const read = (input) => {
    const raw = makePass(input, certs).getAsRaw();
    return { json: JSON.parse(raw["pass.json"].toString("utf8")), raw };
  };
  const vip = read({ ticketId: "pow400000001", tier: "power", name: "Vera Example", tag: { key: "pass", label: "Power" } });
  assert.deepEqual([vip.json.backgroundColor, vip.json.foregroundColor, vip.json.labelColor], ["rgb(24, 169, 87)", "rgb(5, 46, 22)", "rgb(11, 74, 38)"]);
  assert.ok(vip.raw["logo@3x.png"].equals(fs.readFileSync(path.join(ASSETS, "dark", "logo@3x.png"))));
  assert.equal(vip.json.barcodes[0].message, "TECHFEST:pow400000001");
  assert.equal(vip.json.barcodes[0].format, "PKBarcodeFormatQR");
  const media = read({ ticketId: "pow400000002", tier: "power", name: "Max Example", tag: { key: "media", label: "Media" } });
  assert.equal(media.json.backgroundColor, "rgb(11, 61, 145)");
  assert.ok(media.raw["logo@3x.png"].equals(fs.readFileSync(path.join(ASSETS, "logo@3x.png"))));
  const none = read({ ticketId: "con400000003", tier: "connect", name: "Nia Example" });
  assert.deepEqual([none.json.backgroundColor, none.json.labelColor], ["rgb(89, 38, 167)", "rgb(244, 118, 0)"]);
  assert.ok(none.raw["logo@3x.png"].equals(fs.readFileSync(path.join(ASSETS, "logo@3x.png"))));
});
