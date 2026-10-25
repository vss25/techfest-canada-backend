/* The apps' networking (Connect) QR at the door (Oct 24 2026), the pure parts: services/connectQr.js reads the codes the
   iOS / Android / web apps make (the Android QRPayloadTest vectors, produced by the iOS code) and refuses edited ones. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONNECT_SCAN_ERRORS, connectCheck, connectPassNote, connectRefusal, isAppQr, parseConnectQr } from "../services/connectQr.js";

const PRIYA = "TTFC2026|C|Priya Raman|Director%2C Supply Chain AI|DHL|linkedin.com/in/priyaraman|priya.raman@dhl.com|8f92d1";
const PRIYA_ID = "TTFC2026|C|Priya Raman|Director%2C Supply Chain AI|DHL|linkedin.com/in/priyaraman|priya.raman@dhl.com|64f1a2b3c4d5e6f708192a3b|341000";
const REAL = "TTFC2026|C|Baldeep Singh Pahwa|Founder|The Tech Festival Canada|||6ac1ad136c1df1b328fd29a6|facbf7"; // the code scanned at the door

test("connect QR: the apps' check digit, byte for byte (the iOS vectors)", () => {
  assert.equal(connectCheck(PRIYA.split("|").slice(0, -1)), "8f92d1");
  assert.equal(connectCheck(PRIYA_ID.split("|").slice(0, -1)), "341000");
  assert.equal(connectCheck("TTFC2026|C|Jos%C3%A9 %7C O%27Brien|R%26D Lead|Caf%C3%A9 Labs||".split("|")), "e88fe9");
});

test("connect QR: the userId (9 parts), or the email of an older code (8 parts)", () => {
  assert.deepEqual(parseConnectQr(REAL), { ok: true, userId: "6ac1ad136c1df1b328fd29a6", email: "", legacy: false });
  assert.deepEqual(parseConnectQr(` ${PRIYA_ID}\n`), { ok: true, userId: "64f1a2b3c4d5e6f708192a3b", email: "priya.raman@dhl.com", legacy: false });
  assert.deepEqual(parseConnectQr(PRIYA), { ok: true, userId: "", email: "priya.raman@dhl.com", legacy: true });
  // An escaped email reads as the app wrote it.
  const fields = ["TTFC2026", "C", "Ada", "", "", "", "Ada%2BTTFC@Example.com"];
  assert.equal(parseConnectQr([...fields, connectCheck(fields)].join("|")).email, "ada+ttfc@example.com");
  // A userId that isn't an account id is no id (the email is still read).
  const odd = ["TTFC2026", "C", "Ada", "", "", "", "ada@example.com", "abc123"];
  assert.deepEqual(parseConnectQr([...odd, connectCheck(odd)].join("|")), { ok: true, userId: "", email: "ada@example.com", legacy: false });
});

test("connect QR: an edited code, a foreign app code, a ticket QR", () => {
  assert.deepEqual(parseConnectQr(PRIYA.replace("priya.raman@dhl.com", "evil@x.com")), { ok: false });
  assert.deepEqual(parseConnectQr(REAL.replace("6ac1ad136c1df1b328fd29a6", "6ac1ad136c1df1b328fd29a7")), { ok: false });
  assert.deepEqual(parseConnectQr(REAL.replace("|facbf7", "|FACBF7")), { ok: false });
  assert.deepEqual(parseConnectQr("TTFC2026|T|ttfc-2026-004821|influence|Priya Raman|4ee1a2"), { ok: false }); // the old demo ticket
  assert.deepEqual(parseConnectQr("TTFC2026|X|a|b|000000"), { ok: false });
  assert.deepEqual(parseConnectQr("TTFC2026|"), { ok: false });
  for (const raw of ["", null, undefined, "TECHFEST:a1b2c3d4e5f6", "a1b2c3d4e5f6", "ttfc://session/d1/live", "https://example.com/x", "ttfc2026|C|x"]) {
    assert.equal(parseConnectQr(raw), null, String(raw));
    assert.equal(isAppQr(raw), false);
  }
  assert.equal(isAppQr(REAL), true);
});

test("connect QR: the refusals never carry an email; the note for several passes", () => {
  for (const k of Object.keys(CONNECT_SCAN_ERRORS)) {
    const r = connectRefusal(k);
    assert.equal(r.status, "invalid");
    assert.equal(r.code, k);
    assert.equal(r.message, r.error);
    assert.doesNotMatch(r.message, /@/);
  }
  assert.equal(connectRefusal("networking_qr").message, "That's their networking QR. Ask for the entry pass QR (app › Pass, or the email/PDF).");
  assert.equal(connectPassNote({ count: 1, passName: "Power Pass" }), "");
  assert.match(connectPassNote({ count: 2, passName: "Speaker Pass" }), /2 passes, so their Speaker Pass/);
});
