import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BROCHURES, DEFAULT_BROCHURE, DEDUPE_WINDOW_MS, DEFAULT_ATTACH_MAX_BYTES, SALES_INBOX,
  validateBrochureRequest, isHoneypotFilled, isRandomToken, botReason, MIN_FILL_MS, cleanPage, cleanReferrer, dedupeSince, websiteBase, brochureUrl,
  salesInbox, attachMaxBytes, shouldAttach, loadAttachment, downloadsFilter, downloadRow, csvCell, downloadsCsv,
} from "../services/brochureDownloads.js";
import { buildBrochureEmail, buildBrochureReceiptEmail, BROCHURE_SUBJECT } from "../services/brochureEmail.js";

const GOOD = {
  firstName: " Alex ", lastName: "Chen", company: "Acme Corp", jobTitle: "CTO", industry: "Artificial Intelligence",
  email: " Alex@Acme.COM ", phone: "+1 (416) 000-0000", brochure: "sponsorship",
  page: "/brochures?utm_source=x#top", referrer: "https://www.google.com/search?q=secret",
};
const brochure = BROCHURES.sponsorship;

/* ---------- validation ---------- */
test("a normal submission is cleaned and accepted", () => {
  const r = validateBrochureRequest(GOOD);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, {
    firstName: "Alex", lastName: "Chen", company: "Acme Corp", jobTitle: "CTO", industry: "Artificial Intelligence",
    email: "alex@acme.com", phone: "+1 (416) 000-0000", brochure: "sponsorship",
    page: "/brochures", referrer: "https://www.google.com/search",
  });
});

test("only first name, last name and email are required; brochure defaults", () => {
  const r = validateBrochureRequest({ firstName: "A", lastName: "B", email: "a@b.co" });
  assert.equal(r.ok, true);
  assert.equal(r.value.brochure, DEFAULT_BROCHURE);
  assert.equal(r.value.company, "");
  assert.equal(r.value.page, "");
});

test("missing or bad required fields are refused with the field name", () => {
  const cases = [
    [{ ...GOOD, firstName: "  " }, "firstName"],
    [{ ...GOOD, lastName: undefined }, "lastName"],
    [{ ...GOOD, email: "" }, "email"],
    [{ ...GOOD, email: "alex@acme" }, "email"],
    [{ ...GOOD, email: "al ex@acme.com" }, "email"],
    [{ ...GOOD, email: { $gt: "" } }, "email"],          // no Mongo operators
    [{ ...GOOD, firstName: ["Alex"] }, "firstName"],     // arrays are not text
    [{ ...GOOD, phone: "call me maybe" }, "phone"],
    [{ ...GOOD, phone: "1 www.spam.example" }, "phone"],
    [{ ...GOOD, phone: "+--()" }, "phone"],
    [{ ...GOOD, brochure: "secret-deck" }, "brochure"],
    [{ ...GOOD, brochure: "__proto__" }, "brochure"],
  ];
  for (const [body, field] of cases) {
    const r = validateBrochureRequest(body);
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.equal(r.field, field, JSON.stringify(body));
    assert.ok(r.error);
  }
  assert.equal(validateBrochureRequest(null).ok, false);
  assert.equal(validateBrochureRequest("x").ok, false);
});

test("over-long fields are refused, not silently cut", () => {
  const r = validateBrochureRequest({ ...GOOD, company: "x".repeat(161) });
  assert.equal(r.ok, false);
  assert.equal(r.field, "company");
  assert.equal(validateBrochureRequest({ ...GOOD, email: `${"a".repeat(250)}@b.co` }).field, "email");
});

test("links and markup in names are refused (they go into emails)", () => {
  for (const [k, v] of [["firstName", "Win $$$ http://spam.example"], ["lastName", "www.spam.example"], ["company", "<b>Acme</b>"], ["jobTitle", "https://x.y"]]) {
    const r = validateBrochureRequest({ ...GOOD, [k]: v });
    assert.equal(r.ok, false, v);
    assert.equal(r.field, k);
  }
});

test("control characters and newlines are flattened", () => {
  const r = validateBrochureRequest({ ...GOOD, firstName: "Al\r\nex\u0000", company: "Acme\tCorp" });
  assert.equal(r.value.firstName, "Al ex");
  assert.equal(r.value.company, "Acme Corp");
});

test("phone numbers allow the usual formats", () => {
  for (const p of ["4165550000", "+44 20 7946 0958", "(416) 555-0000 x12", "416.555.0000 ext. 4", "416 555 0000 (mobile)", ""]) {
    assert.equal(validateBrochureRequest({ ...GOOD, phone: p }).ok, true, p);
  }
});

test("honeypot", () => {
  assert.equal(isHoneypotFilled({ _hp: "http://bot" }), true);
  assert.equal(isHoneypotFilled({ _hp: "" }), false);
  assert.equal(isHoneypotFilled({ _hp: "   " }), false);
  assert.equal(isHoneypotFilled({}), false);
  assert.equal(isHoneypotFilled(undefined), false);
});

test("page and referrer keep only safe, useful parts", () => {
  assert.equal(cleanPage("/sponsor"), "/sponsor");
  assert.equal(cleanPage("//evil.example/x"), "");
  assert.equal(cleanPage("https://evil.example"), "");
  assert.equal(cleanPage("/" + "a".repeat(300)).length, 200);
  assert.equal(cleanReferrer("https://www.linkedin.com/feed/?trk=abc"), "https://www.linkedin.com/feed/");
  assert.equal(cleanReferrer("javascript:alert(1)"), "");
  assert.equal(cleanReferrer("not a url"), "");
  assert.equal(cleanReferrer(""), "");
});

/* ---------- dedupe, links, settings ---------- */
test("dedupe window is ten minutes", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  assert.equal(DEDUPE_WINDOW_MS, 10 * 60 * 1000);
  assert.equal(dedupeSince(now).toISOString(), "2026-10-10T11:50:00.000Z");
});

test("brochure link points at the public website", () => {
  assert.equal(websiteBase({}), "https://www.thetechfestival.com");
  assert.equal(websiteBase({ BROCHURE_BASE_URL: "https://preview.example.com/" }), "https://preview.example.com");
  assert.equal(brochureUrl(brochure, "https://www.thetechfestival.com/"), "https://www.thetechfestival.com/Brochure.pdf");
});

test("sales inbox defaults to sales@ and can be overridden", () => {
  assert.deepEqual(salesInbox({}), [SALES_INBOX]);
  assert.equal(SALES_INBOX, "sales@thetechfestival.com");
  assert.deepEqual(salesInbox({ BROCHURE_SALES_INBOX: "a@x.com, b@x.com" }), ["a@x.com", "b@x.com"]);
});

test("attach size limit", () => {
  assert.equal(attachMaxBytes({}), DEFAULT_ATTACH_MAX_BYTES);
  assert.equal(attachMaxBytes({ BROCHURE_ATTACH_MAX_MB: "0" }), 0);
  assert.equal(attachMaxBytes({ BROCHURE_ATTACH_MAX_MB: "12" }), 12 * 1024 * 1024);
  assert.equal(attachMaxBytes({ BROCHURE_ATTACH_MAX_MB: "500" }), 25 * 1024 * 1024);
  assert.equal(attachMaxBytes({ BROCHURE_ATTACH_MAX_MB: "lots" }), DEFAULT_ATTACH_MAX_BYTES);
  assert.equal(shouldAttach(2_000_000), true);
  assert.equal(shouldAttach(15_604_925), false); // today's Brochure.pdf → link only
  assert.equal(shouldAttach(null), false);
  assert.equal(shouldAttach("0"), false);
  assert.equal(shouldAttach(100, 0), false);
});

/* ---------- loadAttachment (fake fetch, no network) ---------- */
function fakeFetch({ size, body = Buffer.from("%PDF-1.7 test"), ok = true, fail = false }) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || "GET" });
    if (fail) throw new Error("offline");
    return {
      ok,
      headers: { get: (h) => (h.toLowerCase() === "content-length" && size != null ? String(size) : null) },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
    };
  };
  fn.calls = calls;
  return fn;
}

test("a small PDF is fetched and attached", async () => {
  const body = Buffer.from("%PDF-1.7 small");
  const f = fakeFetch({ size: body.length, body });
  const a = await loadAttachment(brochure, { base: "https://site.test", fetchImpl: f });
  assert.equal(a.filename, brochure.filename);
  assert.equal(a.content.toString(), "%PDF-1.7 small");
  assert.deepEqual(f.calls.map((c) => c.method), ["HEAD", "GET"]);
  assert.equal(f.calls[0].url, "https://site.test/Brochure.pdf");
});

test("a big, unknown-size, non-PDF or unreachable file is linked instead (never downloaded when too big)", async () => {
  const big = fakeFetch({ size: 15_604_925 });
  assert.equal(await loadAttachment(brochure, { fetchImpl: big }), null);
  assert.deepEqual(big.calls.map((c) => c.method), ["HEAD"]);
  assert.equal(await loadAttachment(brochure, { fetchImpl: fakeFetch({ size: null }) }), null);
  const html = Buffer.from("<html>not found</html>");
  assert.equal(await loadAttachment(brochure, { fetchImpl: fakeFetch({ size: html.length, body: html }) }), null);
  assert.equal(await loadAttachment(brochure, { fetchImpl: fakeFetch({ size: 10, ok: false }) }), null);
  assert.equal(await loadAttachment(brochure, { fetchImpl: fakeFetch({ fail: true }) }), null);
  assert.equal(await loadAttachment(brochure, { maxBytes: 0, fetchImpl: fakeFetch({ size: 10 }) }), null);
});

/* ---------- admin list + CSV ---------- */
test("search filter escapes regex characters and matches full names", () => {
  assert.deepEqual(downloadsFilter(""), {});
  const f = downloadsFilter("a.c+");
  assert.equal(f.$or[0].firstName.test("a.c+"), true);
  assert.equal(f.$or[0].firstName.test("abc+"), false);
  const full = downloadsFilter("Alex Chen").$or.at(-1);
  assert.equal(full.firstName.test("alex"), true);
  assert.equal(full.lastName.test("CHEN"), true);
});

test("old rows without email fields show as legacy", () => {
  const r = downloadRow({ _id: "abc", firstName: "A", lastName: "B", email: "a@b.co", createdAt: new Date(0) });
  assert.equal(r.name, "A B");
  assert.equal(r.brochure, "sponsorship");
  assert.equal(r.emailStatus, "legacy");
  assert.equal(r.salesNotified, false);
});

test("CSV cells are quoted and spreadsheet formulas are neutralised", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(csvCell("=HYPERLINK(\"http://x\")"), "\"'=HYPERLINK(\"\"http://x\"\")\"");
  assert.equal(csvCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csvCell("-2+3"), "'-2+3");
  assert.equal(csvCell(true), "Yes");
  assert.equal(csvCell(null), "");
});

test("CSV has a BOM, a header and one line per download", () => {
  const csv = downloadsCsv([
    { _id: "1", firstName: "Alex", lastName: "Chen", email: "alex@acme.com", company: "Acme, Inc", brochure: "sponsorship",
      emailStatus: "sent", delivery: "link", salesNotified: true, createdAt: new Date("2026-10-10T12:00:00Z") },
  ]);
  assert.ok(csv.startsWith("﻿"));
  const [head, line] = csv.slice(1).split("\n");
  assert.match(head, /^Downloaded \(UTC\),First name,Last name,Email/);
  assert.match(line, /^2026-10-10 12:00:00,Alex,Chen,alex@acme.com,"Acme, Inc"/);
  assert.match(line, /Sent \(link\),Yes$/);
});

/* ---------- emails ---------- */
test("brochure email with a link (PDF too big to attach)", () => {
  const link = "https://www.thetechfestival.com/Brochure.pdf";
  const e = buildBrochureEmail({ firstName: "Alex", brochure, link, attached: false });
  assert.equal(e.subject, BROCHURE_SUBJECT);
  assert.match(e.html, /Hi Alex,/);
  assert.ok(e.html.includes(`href="${link}"`));
  assert.match(e.html, /Download the brochure/);
  assert.match(e.html, /14 pages/);
  assert.match(e.html, /sales@thetechfestival\.com/);
  assert.doesNotMatch(e.html, /attached/i);
  assert.match(e.text, /Download your copy here:\nhttps:\/\/www\.thetechfestival\.com\/Brochure\.pdf/);
  assert.doesNotMatch(e.html, /undefined|null/);
});

test("brochure email when the PDF is attached", () => {
  const e = buildBrochureEmail({ firstName: "Alex", brochure, link: "https://x.test/Brochure.pdf", attached: true });
  assert.match(e.html, /attached to this email/);
  assert.match(e.text, /attached to this email/);
  assert.match(e.preheader, /attached/);
});

test("brochure email escapes the name and greets without one", () => {
  const e = buildBrochureEmail({ firstName: "<script>x</script>", brochure, link: "https://x.test/a.pdf" });
  assert.doesNotMatch(e.html, /<script>x/);
  assert.match(e.html, /&lt;script&gt;/);
  assert.match(buildBrochureEmail({ brochure, link: "https://x.test/a.pdf" }).html, /Hi there,/);
});

test("sales receipt lists who downloaded what, when and how it was sent", () => {
  const lead = {
    firstName: "Alex", lastName: "Chen", email: "alex@acme.com", company: "Acme & Co", jobTitle: "CTO",
    industry: "Artificial Intelligence", phone: "+1 416 000 0000", page: "/brochures", referrer: "https://www.google.com/",
    createdAt: new Date("2026-10-10T16:30:00Z"),
  };
  const e = buildBrochureReceiptEmail({ lead, brochure, delivery: "link" });
  assert.equal(e.subject, "Brochure download: Alex Chen, Acme & Co");
  assert.match(e.html, /Acme &amp; Co/);
  assert.match(e.html, /mailto:alex@acme\.com/);
  assert.match(e.html, /TTFC 2026 Sponsorship Brochure/);
  assert.match(e.html, /Sent, with a download link/);
  assert.match(e.text, /When: Oct 10, 2026, 12:30 p\.m\. \(Toronto\)/);
  assert.match(e.text, /Phone: \+1 416 000 0000/);
  assert.match(e.text, /Came from: https:\/\/www\.google\.com\//);
  assert.doesNotMatch(e.html, /Questions about sponsoring/);
});

test("sales receipt shows a failed brochure email and blank fields", () => {
  const e = buildBrochureReceiptEmail({ lead: { firstName: "A", lastName: "B", email: "a@b.co" }, brochure, delivery: "failed" });
  assert.match(e.html, /Not delivered/);
  assert.match(e.text, /Company: -/);
  assert.doesNotMatch(e.html, /undefined|null/);
});

test("receipt subject can't carry header-breaking newlines", () => {
  const e = buildBrochureReceiptEmail({ lead: { firstName: "A\r\nBcc: x@y.z", email: "a@b.co" }, brochure });
  assert.doesNotMatch(e.subject, /[\r\n]/);
});

test("bot sign-ups: random mixed-case text is caught, real names and brands are not", () => {
  for (const w of ["sBjcqBNbVdtgTqNpaFfxDebP", "XxXAhojHXZmQCaDSuKhDn", "TFHxUdRnhbpsGQWunh", "AaTTIShYYHSCnLsjq"]) assert.ok(isRandomToken(w), w);
  for (const w of ["McDonaldson", "LinkedInLearning", "YouTubeShorts", "IFINGLOBALGROUP", "SanJenko", "Aspuru-Guzik", "DeVries", "rvf"]) assert.ok(!isRandomToken(w), w);
  assert.match(botReason({ firstName: "WVELBrevkzkRIOpPLoSXg", lastName: "KVZEjfaHtJSWDUfaRrH", company: "x" }), /firstName/);
  assert.match(botReason({ firstName: "Ann", lastName: "Lee", company: "YUhpdHxxilJeXSSrOlsygvu" }), /company/);
  assert.equal(botReason({ firstName: "Fabiana", lastName: "Montoya", company: "Scotiabank", jobTitle: "Director, Innovation" }), "");
});

test("bot sign-ups: a form filled faster than a person can type is caught; no timing is fine", () => {
  const v = { firstName: "Ann", lastName: "Lee", company: "Acme" };
  assert.match(botReason(v, { elapsedMs: 400 }), /too fast/);
  assert.equal(botReason(v, { elapsedMs: MIN_FILL_MS + 1 }), "");
  assert.equal(botReason(v, {}), "");
  assert.equal(botReason(v, { elapsedMs: "nope" }), "");
});
