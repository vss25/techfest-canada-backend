import { test } from "node:test";
import assert from "node:assert/strict";
import { hashResetToken, isResetToken, newResetToken, passwordProblem, resetLinkFor } from "../services/passwordReset.js";

test("reset tokens: 64 hex characters, stored only as a hash", () => {
  const t = newResetToken();
  assert.ok(isResetToken(t));
  assert.equal(hashResetToken(t).length, 64);
  assert.notEqual(hashResetToken(t), t);
  assert.equal(isResetToken({ $ne: "" }), false);
  assert.equal(isResetToken("abc"), false);
});

test("staff asking from the admin sign-in get the admin link; everyone else the website's", () => {
  const t = "a".repeat(64);
  const base = "https://www.thetechfestival.com/";
  assert.equal(resetLinkFor({ role: "admin" }, t, { base, admin: true }), `https://www.thetechfestival.com/admin-login?reset=${t}`);
  assert.equal(resetLinkFor({ role: "volunteer" }, t, { base, admin: true }), `https://www.thetechfestival.com/admin-login?reset=${t}`);
  assert.equal(resetLinkFor({ role: "user" }, t, { base, admin: true }), `https://www.thetechfestival.com/reset-password/${t}`);
  assert.equal(resetLinkFor({ role: "admin" }, t, { base }), `https://www.thetechfestival.com/reset-password/${t}`);
});

test("new passwords need 8 characters", () => {
  assert.match(passwordProblem("short"), /8 characters/);
  assert.match(passwordProblem(undefined), /8 characters/);
  assert.equal(passwordProblem("long enough"), "");
});
