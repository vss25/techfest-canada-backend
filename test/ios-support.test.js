import test from "node:test";
import assert from "node:assert/strict";
import { toVerdict } from "../services/deepcleer.js";
import { parseCard } from "../services/gemini.js";
import { sanitizeProfilePatch } from "../routes/profile.js";
import { companiesFor } from "../data/intelCompanies.js";
import { appReturnHtml } from "../routes/payments.js";

test("DeepCleer PASS → not flagged", () => {
  const v = toVerdict({ code: 1100, riskLevel: "PASS", riskLabel1: "normal" });
  assert.equal(v.flagged, false);
  assert.equal(v.riskLevel, "PASS");
});

test("DeepCleer REJECT → flagged with reason", () => {
  const v = toVerdict({ code: 1100, riskLevel: "REJECT", riskLabel1: "Abuse", riskDescription: "Abusive language" });
  assert.equal(v.flagged, true);
  assert.equal(v.reason, "Abusive language");
  assert.deepEqual(v.labels, ["Abuse"]);
});

test("DeepCleer REVIEW is held by default and allowed when holdOnReview=false", () => {
  assert.equal(toVerdict({ code: 1100, riskLevel: "REVIEW", riskLabel1: "Ads" }).flagged, true);
  assert.equal(toVerdict({ code: 1100, riskLevel: "REVIEW", riskLabel1: "Ads" }, { holdOnReview: false }).flagged, false);
});

test("DeepCleer non-1100 code → not ok, not flagged", () => {
  const v = toVerdict({ code: 1901, message: "QPS limit" });
  assert.equal(v.ok, false);
  assert.equal(v.flagged, false);
});

test("Gemini reply with prose around JSON parses and is capped", () => {
  const card = parseCard('Sure! {"whatTheyDo":"Makes GPUs.","updates":[{"headline":"Bought X","source":"Reuters","dateLabel":"Sep 1"},{"headline":"B"},{"headline":"C"},{"headline":"D"}]} thanks');
  assert.equal(card.whatTheyDo, "Makes GPUs.");
  assert.equal(card.updates.length, 3);
  assert.equal(card.updates[0].source, "Reuters");
});

test("Gemini garbage → null", () => {
  assert.equal(parseCard("no json here"), null);
  assert.equal(parseCard(""), null);
});

test("profile patch keeps only editable fields and normalises LinkedIn", () => {
  const p = sanitizeProfilePatch({ linkedinUrl: "linkedin.com/in/x", fieldOfWork: " Ops ", role: "admin", password: "nope", topics: ["AI", 3, ""] });
  assert.deepEqual(p, { linkedinUrl: "https://linkedin.com/in/x", fieldOfWork: "Ops", topics: ["AI"] });
  assert.equal("role" in p, false);
});

test("companiesFor dedupes across topics in order", () => {
  const c = companiesFor(["Cybersecurity", "Robotics & Automation"]);
  assert.equal(c.filter((x) => x === "Terranova Aerospace & Defense").length, 1);
  assert.equal(c[0], "Canadian Cybersecurity Network");
});

test("app-return page deep-links into the app and escapes input", () => {
  const html = appReturnHtml({ status: "success", tier: "influence", sessionId: "cs_123" });
  assert.match(html, /ttfc:\/\/checkout-complete\?status=success&tier=influence&session_id=cs_123/);
  const evil = appReturnHtml({ status: "cancel", tier: '"><script>', sessionId: "" });
  assert.doesNotMatch(evil, /<script>alert/);
  assert.match(evil, /status=cancel/);
});
