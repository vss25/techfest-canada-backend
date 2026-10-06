import test from "node:test";
import assert from "node:assert/strict";
import {
  signTicketId, verifyTicketSig, walletLinkSecret, walletPassUrl, ticketQrUrl, apiBaseUrl,
} from "../services/walletLink.js";
import {
  inclusionsFor, knowBeforeYouGo, emailTips, displayPassName, firstNameFor, googleCalendarUrl, escapeHtml, EVENT,
} from "../services/ticketInfo.js";
import { buildTicketEmail } from "../services/ticketEmail.js";
import { generateTicketPDF } from "../services/pdfTicket.js";

const SECRET = "unit-test-secret";

/* ---------------- signed wallet links ---------------- */

test("wallet link: sign + verify round-trips, tampering fails", () => {
  const sig = signTicketId("a1b2c3d4e5f6", SECRET);
  assert.match(sig, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(verifyTicketSig("a1b2c3d4e5f6", sig, SECRET), true);
  assert.equal(verifyTicketSig("a1b2c3d4e5f7", sig, SECRET), false, "other ticket");
  assert.equal(verifyTicketSig("a1b2c3d4e5f6", sig, "other-secret"), false, "other secret");
  assert.equal(verifyTicketSig("a1b2c3d4e5f6", sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A"), SECRET), false);
  assert.equal(verifyTicketSig("a1b2c3d4e5f6", "short", SECRET), false);
  assert.equal(verifyTicketSig("a1b2c3d4e5f6", "", SECRET), false);
  assert.equal(verifyTicketSig("a1b2c3d4e5f6", undefined, SECRET), false);
  assert.equal(verifyTicketSig("a1b2c3d4e5f6", ["x"], SECRET), false);
});

test("wallet link: no secret → no links, nothing verifies", () => {
  assert.equal(signTicketId("abc", ""), "");
  assert.equal(verifyTicketSig("abc", signTicketId("abc", SECRET), ""), false);
  assert.equal(walletPassUrl("abc", { secret: "", base: "https://api.test" }), "");
});

test("wallet link: secret prefers WALLET_LINK_SECRET, falls back to JWT_SECRET", () => {
  assert.equal(walletLinkSecret({ WALLET_LINK_SECRET: "w", JWT_SECRET: "j" }), "w");
  assert.equal(walletLinkSecret({ JWT_SECRET: "j" }), "j");
  assert.equal(walletLinkSecret({}), "");
  assert.equal(apiBaseUrl({ API_URL: "https://api.test/" }), "https://api.test");
});

test("wallet link: URLs carry the ticket and a verifiable sig", () => {
  const url = new URL(walletPassUrl("a1b2c3", { secret: SECRET, base: "https://api.test" }));
  assert.equal(url.origin + url.pathname, "https://api.test/api/wallet/pass/a1b2c3");
  assert.equal(verifyTicketSig("a1b2c3", url.searchParams.get("sig"), SECRET), true);
  const qr = new URL(ticketQrUrl("a1b2c3", { secret: SECRET, base: "https://api.test" }));
  assert.equal(qr.pathname, "/api/wallet/qr/a1b2c3");
});

/* ---------------- per-tier content ---------------- */

test("inclusions per pass match the website", () => {
  assert.deepEqual(inclusionsFor("connect"), ["2x Day Conference Access", "Expo Floor Access", "Networking Breaks"]);
  assert.ok(inclusionsFor("influence").includes("2x Luncheons"));
  assert.ok(!inclusionsFor("influence").includes("1x Awards Night"));
  assert.ok(inclusionsFor("power").includes("1x Gala Dinner & Networking Reception"));
  assert.ok(!inclusionsFor("power").some((f) => /lounge/i.test(f)));
  assert.equal(inclusionsFor("apex").length, 10);
  assert.ok(inclusionsFor("APEX").includes("Private Scotch & Cocktail Lounge (19+)"));
  assert.deepEqual(inclusionsFor("vip"), inclusionsFor("apex"));
  assert.deepEqual(inclusionsFor("something-new"), inclusionsFor("connect"));
  // callers can't mutate the shared list
  inclusionsFor("apex").push("x");
  assert.equal(inclusionsFor("apex").length, 10);
});

test("19+ lounge tip only for Apex; venue address stays in the tips", () => {
  assert.ok(knowBeforeYouGo("apex").some((t) => /19\+/.test(t)));
  assert.ok(!knowBeforeYouGo("power").some((t) => /19\+/.test(t)));
  assert.ok(knowBeforeYouGo("connect").some((t) => t.includes("1 Harbour Square")));
  assert.ok(!emailTips("connect").some((t) => t.includes("1 Harbour Square")));
});

test("pass names, greeting names, calendar link", () => {
  assert.equal(displayPassName("influence", "abc"), "Influence Pass");
  assert.equal(displayPassName("gold", "BOOTH-GOLD"), "Exhibition Booth — Gold");
  assert.equal(firstNameFor({ firstName: " Priya ", name: "Someone Else" }), "Priya");
  assert.equal(firstNameFor({ name: "Jane Doe" }), "Jane");
  assert.equal(firstNameFor({ name: "Guest" }), "");
  const cal = new URL(googleCalendarUrl());
  assert.equal(cal.hostname, "calendar.google.com");
  assert.equal(cal.searchParams.get("dates"), "20261026/20261028");
  assert.match(cal.searchParams.get("location"), /Westin Harbour Castle/);
});

/* ---------------- email ---------------- */

test("email contains the wallet link, QR, inclusions, app note and plain text", () => {
  const walletUrl = walletPassUrl("a1b2c3", { secret: SECRET, base: "https://api.test" });
  const qrUrl = ticketQrUrl("a1b2c3", { secret: SECRET, base: "https://api.test" });
  const e = buildTicketEmail({ name: "Jane Doe", firstName: "Jane", ticketId: "a1b2c3", tier: "apex", walletUrl, qrUrl });
  const htmlWallet = escapeHtml(walletUrl);
  assert.ok(e.html.includes(`href="${htmlWallet}"`), "wallet button links to the signed URL");
  assert.ok(e.html.includes("Apple Wallet"));
  assert.ok(e.html.includes(`src="${escapeHtml(qrUrl)}"`));
  assert.ok(e.html.includes("You're in, Jane."));
  assert.ok(e.html.includes("Private Scotch &amp; Cocktail Lounge (19+)"));
  assert.ok(e.html.includes("Your ticket PDF is attached"));
  assert.ok(e.html.includes("calendar.google.com"));
  assert.match(e.html, /coming soon to the App Store/i);
  assert.ok(!/apps\.apple\.com/.test(e.html), "no App Store link — the app isn't live");
  assert.ok(e.html.includes(EVENT.supportEmail));
  assert.match(e.subject, /Apex Pass/);
  assert.ok(e.text.includes(walletUrl));
  assert.ok(e.text.includes("Ticket ID: a1b2c3"));
  assert.ok(!/<[a-z]/i.test(e.text), "plain text has no tags");
});

test("email escapes the attendee name", () => {
  const e = buildTicketEmail({
    name: `<img src=x onerror="alert(1)"> O'Brien & Co`, firstName: "<b>Eve</b>",
    ticketId: "a1b2c3", tier: "connect",
  });
  assert.ok(!e.html.includes("<img src=x"));
  assert.ok(!e.html.includes("<b>Eve</b>"));
  assert.ok(e.html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; O&#39;Brien &amp; Co"));
  assert.ok(e.html.includes("You're in, &lt;b&gt;Eve&lt;/b&gt;."));
});

test("email without a wallet link (certs not configured) or for a booth", () => {
  const plain = buildTicketEmail({ name: "Jane Doe", ticketId: "a1b2c3", tier: "power" });
  assert.ok(!plain.html.includes("Apple Wallet"));
  assert.ok(!plain.html.includes("<img "));
  assert.ok(plain.html.includes("Your ticket PDF is attached"));
  assert.ok(!plain.html.includes("Lounge"));

  const booth = buildTicketEmail({ name: "Jane Doe", ticketId: "BOOTH-GOLD", tier: "booth-gold", walletUrl: "https://x/y" });
  assert.ok(!booth.html.includes("Apple Wallet"), "no wallet pass for booth bookings");
  assert.match(booth.subject, /Exhibition Booth/);
});

/* ---------------- PDF ---------------- */

test("ticket PDF renders one page and links the wallet pass", async () => {
  const walletUrl = "https://api.test/api/wallet/pass/a1b2c3?sig=abc";
  const buf = await generateTicketPDF({ ticketId: "a1b2c3", tier: "apex", name: "Jane Doe", walletUrl });
  const pdf = buf.toString("latin1");
  assert.ok(pdf.startsWith("%PDF-"));
  assert.equal((pdf.match(/\/Type \/Page\b/g) || []).length, 1, "exactly one page");
  assert.ok(pdf.includes(walletUrl), "wallet link annotation");
  await assert.rejects(() => generateTicketPDF({ tier: "apex" }), /Ticket ID missing/);
});
