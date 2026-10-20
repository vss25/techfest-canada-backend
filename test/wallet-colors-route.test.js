import { test, mock, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import forge from "node-forge";
import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import walletRouter from "../routes/wallet.js";
import { signTicketId } from "../services/walletLink.js";
import { clearExhibitorCache } from "../services/exhibitorCache.js";

/* GET /api/wallet/pass/:ticketId builds the pass in the holder's Profile colour, both ways: a signed-in account
   (Bearer, the apps / web app / website) and the signed email link (?sig=), for an account's ticket or a pass-only
   person's Attendee record. The models are mocked (no database); the pass is really built and signed with a
   throwaway self-signed certificate made here. Fictional people. */

const SECRET = "wallet-colors-test-jwt";
const LINK_SECRET = "wallet-colors-test-sig";
const saved = {};
const KEYS = ["JWT_SECRET", "WALLET_LINK_SECRET", "WALLET_PASS_TYPE_ID", "WALLET_TEAM_ID", "WALLET_SIGNER_CERT_B64", "WALLET_SIGNER_KEY_B64", "WALLET_WWDR_CERT_B64"];

function testCertEnv() {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "02";
  cert.validity.notBefore = new Date("2026-01-01");
  cert.validity.notAfter = new Date("2027-01-01");
  cert.setSubject([{ name: "commonName", value: "TTFC test only" }]);
  cert.setIssuer([{ name: "commonName", value: "TTFC test only" }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const b64 = (s) => Buffer.from(s).toString("base64");
  const pem = forge.pki.certificateToPem(cert);
  return {
    WALLET_PASS_TYPE_ID: "pass.test.ttfc", WALLET_TEAM_ID: "TEAM000000",
    WALLET_SIGNER_CERT_B64: b64(pem), WALLET_WWDR_CERT_B64: b64(pem), WALLET_SIGNER_KEY_B64: b64(forge.pki.privateKeyToPem(keys.privateKey)),
  };
}

const ID = (c) => c.repeat(24);
const users = new Map([
  // Vera: VIP and a speaker, on a Power Pass. Max: media + speaker. Pat: a plain Power Pass. Sam: staff (admin).
  [ID("a"), { _id: ID("a"), name: "Vera Example", role: "user", vip: true, types: ["speaker"], tickets: [{ ticketId: "pow500000001", type: "power" }] }],
  [ID("b"), { _id: ID("b"), name: "Max Example", role: "user", types: ["speaker", "media"], tickets: [{ ticketId: "pow500000002", type: "power" }] }],
  [ID("c"), { _id: ID("c"), name: "Pat Example", role: "user", tickets: [{ ticketId: "pow500000003", type: "power" }] }],
  [ID("d"), { _id: ID("d"), name: "Sam Example", role: "admin", tickets: [] }],
]);
// Pass-only people (no account has these tickets).
const attendees = new Map([
  ["pow500000010", { ticketId: "pow500000010", name: "Gia Example", ticketType: "power", promoCode: "ISSUED", vip: true }],
  ["con500000011", { ticketId: "con500000011", name: "Val Example", ticketType: "connect", promoCode: "ISSUED" }],
  ["spk500000012", { ticketId: "spk500000012", name: "Sol Example", ticketType: "speaker", promoCode: "SPEAKER" }],
  ["con500000013", { ticketId: "con500000013", name: "Eve Example", ticketType: "connect", promoCode: "EXHIBITOR" }],
]);
// Passes marked Media, for the exhibitor index: Pat claimed one.
const mediaRows = [{ claimedBy: ID("c"), ticketId: "pow500000003" }];

let server;
let base;
before(async () => {
  for (const k of KEYS) saved[k] = process.env[k];
  Object.assign(process.env, { JWT_SECRET: SECRET, WALLET_LINK_SECRET: LINK_SECRET, ...testCertEnv() });
  const app = express();
  app.use("/api/wallet", walletRouter);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}/api/wallet`;
});
after(() => {
  server?.close();
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

let marks = [];
beforeEach(() => {
  mock.restoreAll();
  clearExhibitorCache();
  marks = [];
  const one = (v) => ({ select: () => Object.assign(Promise.resolve(v), { lean: async () => v }) });
  mock.method(User, "findById", (id) => one(users.get(String(id)) || null));
  mock.method(User, "findOne", (q) => one([...users.values()].find((u) => u.tickets.some((t) => t.ticketId === q["tickets.ticketId"])) || null));
  mock.method(Attendee, "findOne", (q) => one(attendees.get(q.ticketId) || null));
  // loadExhibitors: exhibitor passes, VIP passes, Media passes.
  mock.method(Attendee, "find", (q) => ({ select: () => ({ lean: async () => (q?.media === true ? marks : []) }) }));
});

/** The pass.json colours of a .pkpass (stored uncompressed in the zip). */
async function colours(res) {
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(res.headers.get("content-type"), "application/vnd.apple.pkpass");
  const zip = Buffer.from(await res.arrayBuffer()).toString("latin1");
  const at = (k) => (zip.match(new RegExp(`"${k}":"(rgb\\([^)]*\\))"`)) || [])[1];
  return { bg: at("backgroundColor"), fg: at("foregroundColor"), label: at("labelColor"), qr: (zip.match(/"message":"(TECHFEST:[^"]+)"/) || [])[1] };
}
const bearer = (id) => ({ Authorization: `Bearer ${jwt.sign({ id }, SECRET)}` });
const viaApp = (ticketId, id) => fetch(`${base}/pass/${ticketId}`, { headers: bearer(id) });
const viaLink = (ticketId) => fetch(`${base}/pass/${ticketId}?sig=${signTicketId(ticketId, LINK_SECRET)}`);

test("signed in (apps, web app, website): the account's Profile colour", async () => {
  assert.deepEqual(await colours(await viaApp("pow500000001", ID("a"))),
    { bg: "rgb(245, 196, 0)", fg: "rgb(61, 46, 0)", label: "rgb(92, 69, 0)", qr: "TECHFEST:pow500000001" });           // VIP gold
  assert.equal((await colours(await viaApp("pow500000002", ID("b")))).bg, "rgb(11, 61, 145)");                    // media blue
  assert.equal((await colours(await viaApp("pow500000003", ID("c")))).bg, "rgb(24, 169, 87)");                    // a pass: green
  // Staff fetching Pat's pass with a password sign-in get Pat's colour, not staff purple.
  assert.equal((await colours(await viaApp("pow500000003", ID("d")))).bg, "rgb(24, 169, 87)");
  // A pass of Pat's marked Media (the exhibitor index, as /auth/me): dark blue.
  marks = mediaRows;
  clearExhibitorCache();
  assert.equal((await colours(await viaApp("pow500000003", ID("c")))).bg, "rgb(11, 61, 145)");
});

test("the signed email link: an account's ticket gets the account's colour", async () => {
  assert.equal((await colours(await viaLink("pow500000001"))).bg, "rgb(245, 196, 0)");
  assert.equal((await colours(await viaLink("pow500000002"))).bg, "rgb(11, 61, 145)");
});

test("the signed email link for a pass-only person: their Attendee record decides", async () => {
  const gia = await colours(await viaLink("pow500000010"));                                                       // marked VIP
  assert.deepEqual([gia.bg, gia.fg, gia.qr], ["rgb(245, 196, 0)", "rgb(61, 46, 0)", "TECHFEST:pow500000010"]);
  assert.equal((await colours(await viaLink("spk500000012"))).bg, "rgb(208, 31, 47)");                            // a Speaker Pass: red
  assert.equal((await colours(await viaLink("con500000013"))).bg, "rgb(24, 169, 87)");                            // exhibitor: green
  assert.deepEqual(await colours(await viaLink("con500000011")),
    { bg: "rgb(24, 169, 87)", fg: "rgb(5, 46, 22)", label: "rgb(11, 74, 38)", qr: "TECHFEST:con500000011" });    // Connect: green
});

test("the rules around it are unchanged: bad signature, someone else's ticket, unknown ticket", async () => {
  assert.equal((await fetch(`${base}/pass/pow500000010?sig=nope`, { headers: { Accept: "application/json" } })).status, 404);
  assert.equal((await viaApp("pow500000002", ID("a"))).status, 404);
  assert.equal((await fetch(`${base}/pass/zzz000000000?sig=${signTicketId("zzz000000000", LINK_SECRET)}`, { headers: { Accept: "application/json" } })).status, 404);
});
