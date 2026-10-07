import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeEmail, isValidEmail, hashToken, hashCode, cleanCode, newCode, newToken, createSignInSecrets,
  looksLikeToken, requestState, checkCode, messageFor, codeMessageFor, signInLink, frontendBase, cleanClient, emailRegex,
  sameHash, LINK_TTL_MS, MAX_CODE_ATTEMPTS,
} from "../services/emailLink.js";
import { buildSignInEmail, buildNoTicketEmail, SIGN_IN_SUBJECT, NO_TICKET_SUBJECT } from "../services/signInEmail.js";
import { createEmailLinkRouter } from "../routes/emailLink.js";

const NOW = Date.parse("2026-10-06T12:00:00Z");

/* ---------- emails ---------- */
test("emails are normalised and loosely validated", () => {
  assert.equal(normalizeEmail("  Jane.Doe@Acme.COM "), "jane.doe@acme.com");
  assert.equal(isValidEmail("jane@acme.com"), true);
  assert.equal(isValidEmail(" JANE@acme.co "), true);
  for (const bad of ["", "jane", "jane@", "@acme.com", "jane@acme", "ja ne@acme.com", null, undefined]) {
    assert.equal(isValidEmail(bad), false, String(bad));
  }
});

test("emailRegex matches case-insensitively and escapes regex characters", () => {
  const re = emailRegex("J.Doe+tag@Acme.com");
  assert.equal(re.test("j.doe+tag@acme.com"), true);
  assert.equal(re.test("J.DOE+TAG@ACME.COM"), true);
  assert.equal(re.test("jxdoe+tag@acme.com"), false);      // "." is literal
  assert.equal(re.test("j.doe+tag@acme.com.evil"), false); // anchored
});

/* ---------- secrets ---------- */
test("tokens are 32 random bytes in base64url and look like tokens", () => {
  const a = newToken();
  const b = newToken();
  assert.equal(a.length, 43);
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.equal(looksLikeToken(a), true);
  for (const bad of ["", "short", "has spaces in it but is long enough to pass", "a".repeat(80), 123, null]) {
    assert.equal(looksLikeToken(bad), false, String(bad));
  }
});

test("codes are always six digits, including leading zeros", () => {
  assert.equal(newCode(() => 42), "000042");
  assert.equal(newCode(() => 999999), "999999");
  for (let i = 0; i < 200; i++) assert.match(newCode(), /^\d{6}$/);
});

test("cleanCode accepts spaced or dashed codes and refuses anything else", () => {
  assert.equal(cleanCode("123456"), "123456");
  assert.equal(cleanCode(" 123 456 "), "123456");
  assert.equal(cleanCode("123-456"), "123456");
  for (const bad of ["12345", "1234567", "12a456", "", null, undefined, "１２３４５６"]) {
    assert.equal(cleanCode(bad), "", String(bad));
  }
});

test("only hashes are stored, and the code hash is bound to the email", () => {
  const { token, code, record } = createSignInSecrets("Jane@Acme.com", { now: NOW });
  assert.equal(record.email, "jane@acme.com");
  assert.equal(record.tokenHash, hashToken(token));
  assert.equal(record.codeHash, hashCode("jane@acme.com", code));
  assert.equal(record.codeHash, hashCode(" JANE@acme.com", code));
  assert.notEqual(record.codeHash, hashCode("other@acme.com", code));
  assert.equal(JSON.stringify(record).includes(token), false);
  assert.equal(JSON.stringify(record).includes(`"${code}"`), false);
  assert.match(record.tokenHash, /^[0-9a-f]{64}$/);
  assert.equal(record.expiresAt.getTime(), NOW + LINK_TTL_MS);
  assert.equal(LINK_TTL_MS, 15 * 60 * 1000);
  assert.equal(record.status, "pending");
  assert.equal(record.attempts, 0);
});

test("sameHash is a strict equality check", () => {
  const h = hashToken("abc");
  assert.equal(sameHash(h, hashToken("abc")), true);
  assert.equal(sameHash(h, hashToken("abd")), false);
  assert.equal(sameHash("", ""), false);
  assert.equal(sameHash(h, h.slice(1)), false);
});

/* ---------- state ---------- */
function pending(extra = {}) {
  const { code, record } = createSignInSecrets("jane@acme.com", { now: NOW });
  return { code, req: { ...record, ...extra } };
}

test("requestState covers missing, used, replaced, locked and expired", () => {
  const { req } = pending();
  assert.equal(requestState(req, NOW), "ok");
  assert.equal(requestState(req, NOW + LINK_TTL_MS - 1), "ok");
  assert.equal(requestState(req, NOW + LINK_TTL_MS), "expired");
  assert.equal(requestState(null, NOW), "missing");
  assert.equal(requestState({ ...req, status: "used" }, NOW), "used");
  assert.equal(requestState({ ...req, status: "replaced" }, NOW), "expired");
  assert.equal(requestState({ ...req, status: "locked" }, NOW), "locked");
  assert.equal(requestState({ ...req, attempts: MAX_CODE_ATTEMPTS }, NOW), "locked");
});

test("checkCode accepts the right code and counts wrong ones down to a lock", () => {
  const { code, req } = pending();
  assert.equal(checkCode(req, "jane@acme.com", code, NOW).ok, true);
  assert.equal(checkCode(req, "JANE@acme.com", ` ${code.slice(0, 3)} ${code.slice(3)} `, NOW).ok, true);
  assert.equal(checkCode(req, "other@acme.com", code, NOW).ok, false); // code is bound to the email

  const wrong = code === "000000" ? "111111" : "000000";
  let r = req;
  for (let i = 1; i < MAX_CODE_ATTEMPTS; i++) {
    const res = checkCode(r, "jane@acme.com", wrong, NOW);
    assert.equal(res.ok, false);
    assert.equal(res.state, "wrong");
    assert.equal(res.attempts, i);
    assert.equal(res.lock, false);
    assert.match(res.error, new RegExp(`${MAX_CODE_ATTEMPTS - i} tr(y|ies) left`));
    r = { ...r, attempts: res.attempts };
  }
  const last = checkCode(r, "jane@acme.com", wrong, NOW);
  assert.equal(last.lock, true);
  assert.equal(last.state, "locked");
  assert.equal(last.error, codeMessageFor("locked"));
  // Once locked, even the right code is refused.
  assert.equal(checkCode({ ...r, attempts: MAX_CODE_ATTEMPTS }, "jane@acme.com", code, NOW).ok, false);
});

test("checkCode refuses expired and used requests with friendly messages", () => {
  const { code, req } = pending();
  const exp = checkCode(req, "jane@acme.com", code, NOW + LINK_TTL_MS + 1);
  assert.equal(exp.ok, false);
  assert.equal(exp.state, "expired");
  assert.match(exp.error, /expired/);
  const used = checkCode({ ...req, status: "used" }, "jane@acme.com", code, NOW);
  assert.equal(used.state, "used");
  assert.match(used.error, /already been used/);
  assert.equal(checkCode(null, "jane@acme.com", code, NOW).state, "missing");
});

/* ---------- links ---------- */
test("the email link points at the website's /app-login page", () => {
  assert.equal(frontendBase({}), "https://www.thetechfestival.com");
  assert.equal(frontendBase({ FRONTEND_URL: "http://localhost:5173/ " }), "http://localhost:5173");
  const link = signInLink("abc_DEF-123", "https://www.thetechfestival.com");
  const u = new URL(link);
  assert.equal(u.origin + u.pathname, "https://www.thetechfestival.com/app-login");
  assert.equal(u.searchParams.get("token"), "abc_DEF-123");
});

test("cleanClient falls back to web", () => {
  assert.equal(cleanClient("iOS"), "ios");
  assert.equal(cleanClient("android"), "android");
  assert.equal(cleanClient("<script>"), "web");
  assert.equal(cleanClient(undefined), "web");
});

/* ---------- email HTML ---------- */
test("sign-in email contains the link, the code and the expiry", () => {
  const link = "https://www.thetechfestival.com/app-login?token=abc_DEF-123";
  const { subject, html, text, preheader } = buildSignInEmail({ link, code: "042917", minutes: 15 });
  assert.equal(subject, SIGN_IN_SUBJECT);
  assert.equal(subject, "Your TTFC sign-in link");
  assert.ok(html.includes(`href="${link}"`));
  assert.ok(html.includes("042 917"));
  assert.ok(html.includes("Or enter this code in the app"));
  assert.ok(html.includes("15 minutes"));
  assert.match(html, /Didn&#39;t ask to sign in\?|Didn't ask to sign in\?/);
  assert.ok(text.includes(link));
  assert.ok(text.includes("042917"));
  assert.ok(preheader.includes("042917"));
  assert.ok(html.trim().startsWith("<!DOCTYPE html>"));
  assert.ok(html.trim().endsWith("</html>"));
});

test("sign-in email escapes what goes into the HTML", () => {
  const { html } = buildSignInEmail({ link: `https://x.test/app-login?token=a"><script>alert(1)</script>&b=1`, code: "<b>1</b>" });
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("<b>1</b>"), false);
  assert.ok(html.includes("&quot;&gt;&lt;script&gt;"));
  assert.ok(html.includes("&amp;b=1"));
});

test("no-ticket email names the address, links to tickets and escapes", () => {
  const { subject, html, text } = buildNoTicketEmail({
    email: `jane<img src=x onerror=alert(1)>@acme.com`,
    ticketsUrl: "https://www.thetechfestival.com/tickets",
  });
  assert.equal(subject, NO_TICKET_SUBJECT);
  assert.ok(html.includes('href="https://www.thetechfestival.com/tickets"'));
  assert.ok(html.includes("email you used at checkout"));
  assert.equal(html.includes("<img src=x"), false);
  assert.ok(html.includes("jane&lt;img"));
  assert.ok(text.includes("https://www.thetechfestival.com/tickets"));
  assert.equal(html.includes("app-login"), false); // never carries a sign-in link
});

/* ---------- router ---------- */
test("the router builds without a Resend key and exposes both routes", () => {
  const router = createEmailLinkRouter({ send: async () => {} });
  const paths = router.stack.map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
  assert.deepEqual(paths, ["post /email-link", "post /email-link/verify"]);
});
