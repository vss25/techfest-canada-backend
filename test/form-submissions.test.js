import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FORMS, FORM_KEYS, FORMS_INBOX, STATUSES, isForm, validateFormSubmission, cleanFields, formBotReason, formsInbox,
  esc, safeHttpUrl, buildFormEmail, submissionFields, submissionsFilter, summaryOf, submissionRow, submissionDetail,
  cleanSubmissionPatch, submissionsCsv, CSV_HEAD, mapImportRow, planImport, importKey, fieldLabel, splitName,
  FIELDS_MAX_KEYS, FIELD_MAX_LENGTH, IMPORT_MAX_ROWS,
} from "../services/formSubmissions.js";
import { makeFormSubmitHandler, FAILED, TOO_MANY } from "../services/formSubmitHandler.js";
import { makeLimiter } from "../services/ticketAccess.js";

const VOLUNTEER = {
  firstName: " Jane ", lastName: "Doe", email: " Jane@Example.COM ", phone: "+1 416 555 0100",
  message: "I love tech.\r\nAnd people.",
  fields: { preferredRole1: "Registration & Check-In", preferredRole2: "" },
  page: "/volunteer?utm=x", referrer: "https://www.google.com/search?q=secret",
  _hp: "", elapsedMs: 42000,
};

/* ---------- the form list ---------- */
test("every website form has a label and a subject tag", () => {
  assert.deepEqual(FORM_KEYS, ["volunteer", "speaker", "exhibit", "sponsor", "partnership", "inquiry"]);
  for (const k of FORM_KEYS) {
    assert.ok(FORMS[k].label && FORMS[k].tag, k);
  }
  assert.equal(isForm("volunteer"), true);
  assert.equal(isForm("__proto__"), false);
  assert.equal(isForm("constructor"), false);
  assert.equal(isForm(undefined), false);
  assert.deepEqual(STATUSES, ["new", "contacted", "accepted", "declined", "archived"]);
});

/* ---------- validation ---------- */
test("a volunteer application is cleaned and accepted", () => {
  const r = validateFormSubmission("volunteer", VOLUNTEER);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, {
    form: "volunteer", name: "Jane Doe", firstName: "Jane", lastName: "Doe", email: "jane@example.com",
    phone: "+1 416 555 0100", company: "", jobTitle: "", message: "I love tech.\nAnd people.",
    fields: { preferredRole1: "Registration & Check-In" },
    page: "/volunteer", referrer: "https://www.google.com/search", fillMs: 42000,
  });
});

test("a single name field is split into first and last", () => {
  const r = validateFormSubmission("speaker", { name: "Ada  Mary Lovelace", email: "ada@x.io", jobTitle: "CTO", fields: { linkedin: "https://linkedin.com/in/ada" } });
  assert.equal(r.ok, true);
  assert.equal(r.value.name, "Ada Mary Lovelace");
  assert.equal(r.value.firstName, "Ada");
  assert.equal(r.value.lastName, "Mary Lovelace");
  assert.deepEqual(splitName("  "), ["", ""]);
});

test("required fields depend on the form", () => {
  const cases = [
    ["volunteer", { firstName: "", lastName: "", email: "a@b.co" }, "firstName"],
    ["speaker", { email: "a@b.co" }, "name"],
    ["speaker", { name: "A B" }, "email"],
    ["exhibit", { firstName: "A", lastName: "B", email: "not-an-email" }, "email"],
    ["partnership", { firstName: "A", lastName: "B", email: "a@b.co", message: "  " }, "message"],
    ["inquiry", { firstName: "A", lastName: "B", email: "a@b.co" }, "message"],
    ["sponsor", { firstName: "A", lastName: "B", email: "bad@" }, "email"],          // optional, but must be valid when given
    ["volunteer", { firstName: { $gt: "" }, lastName: ["B"], email: "a@b.co" }, "firstName"], // no Mongo operators or arrays
    ["volunteer", { firstName: "A", lastName: "B", email: { $ne: null } }, "email"],
    ["inquiry", { firstName: "Win http://spam.example", lastName: "B", email: "a@b.co", message: "x" }, "firstName"],
    ["speaker", { name: "<b>A</b>", email: "a@b.co" }, "name"],
  ];
  for (const [form, body, field] of cases) {
    const r = validateFormSubmission(form, body);
    assert.equal(r.ok, false, `${form} ${JSON.stringify(body)}`);
    assert.equal(r.field, field, `${form} ${JSON.stringify(body)}`);
    assert.equal(r.status, 400);
  }
  // Sponsor never required an email
  assert.equal(validateFormSubmission("sponsor", { firstName: "A", lastName: "B", phone: "416" }).ok, true);
  assert.equal(validateFormSubmission("volunteer", null).ok, false);
  assert.equal(validateFormSubmission("volunteer", ["x"]).ok, false);
});

test("unknown forms are a 404", () => {
  for (const f of ["", "admin", "__proto__", "Volunteer"]) {
    const r = validateFormSubmission(f, VOLUNTEER);
    assert.equal(r.ok, false);
    assert.equal(r.status, 404, f);
  }
});

test("long text is cut, not refused; control characters are flattened", () => {
  const r = validateFormSubmission("inquiry", {
    firstName: "Al\u0000ex", lastName: "x".repeat(500), email: "a@b.co", company: "c".repeat(400), message: "m".repeat(9000),
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.firstName, "Al ex");
  assert.equal(r.value.lastName.length, 80);
  assert.equal(r.value.company.length, 160);
  assert.equal(r.value.message.length, 5000);
  assert.ok(r.value.name.length <= 160);
});

test("extra fields are kept, sanitised and size-limited", () => {
  const body = {
    firstName: "A", lastName: "B", email: "a@b.co",
    fields: {
      booth: "Booth 10x10", count: 3, ok: true, list: ["a", "b", { x: 1 }], nested: { a: 1 },
      "$where": "x", "a.b": "x", __proto__: { polluted: 1 }, constructor: "x", empty: "  ", nul: null,
      long: "z".repeat(FIELD_MAX_LENGTH + 50),
    },
    topLevelExtra: "kept too",
    _hp: "", elapsedMs: 9000, page: "/x", referrer: "", form: "admin",
  };
  const f = cleanFields(body);
  assert.deepEqual(Object.keys(f).sort(), ["booth", "count", "list", "long", "ok", "topLevelExtra"]);
  assert.equal(f.count, "3");
  assert.equal(f.ok, "Yes");
  assert.equal(f.list, "a, b");
  assert.equal(f.long.length, FIELD_MAX_LENGTH);
  assert.equal(Object.getPrototypeOf(f), Object.prototype);
  assert.equal({}.polluted, undefined);
  // Core and meta keys never end up in `fields`
  assert.equal(f.email, undefined);
  assert.equal(f._hp, undefined);

  const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, "v"]));
  assert.equal(Object.keys(cleanFields({ fields: many })).length, FIELDS_MAX_KEYS);
  const big = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, "v".repeat(FIELD_MAX_LENGTH)]));
  const total = Object.values(cleanFields({ fields: big })).join("").length;
  assert.ok(total <= 12000, String(total));
  assert.deepEqual(cleanFields(null), {});
  assert.deepEqual(cleanFields({ fields: ["x"] }), {});
});

test("field labels are readable", () => {
  assert.equal(fieldLabel("preferredRole1"), "Preferred role 1");
  assert.equal(fieldLabel("linkedin"), "LinkedIn");
  assert.equal(fieldLabel("booth_specs"), "Booth specs");
  assert.equal(fieldLabel("howDidYouHear"), "How did you hear");
});

/* ---------- bots ---------- */
test("bot detection: honeypot, random text, instant fill", () => {
  const ok = validateFormSubmission("volunteer", VOLUNTEER).value;
  assert.equal(formBotReason(ok, VOLUNTEER), "");
  assert.equal(formBotReason(ok, { ...VOLUNTEER, _hp: "http://x" }), "hidden field filled");
  assert.equal(formBotReason({ ...ok, firstName: "sBjcqBNbVdtgTqNpaFfxDebP" }, VOLUNTEER), "random text in first name");
  assert.equal(formBotReason({ ...ok, company: "kQwErTyUiOpAsDfGh" }, VOLUNTEER), "random text in company");
  assert.equal(formBotReason({ name: "xKcdQwErTyUiOp", firstName: "", lastName: "" }, {}), "random text in first name");
  assert.equal(formBotReason(ok, { ...VOLUNTEER, elapsedMs: 300 }), "form filled too fast");
  // Real names and brands are fine; no timing → no verdict on timing
  assert.equal(formBotReason({ firstName: "Mary", lastName: "McDonald", company: "LinkedIn", jobTitle: "VP" }, {}), "");
});

/* ---------- inbox ---------- */
test("inbox defaults to baldeep@ and FORMS_INBOX overrides", () => {
  assert.equal(FORMS_INBOX, "baldeep@thetechfestival.com");
  assert.deepEqual(formsInbox({}), ["baldeep@thetechfestival.com"]);
  assert.deepEqual(formsInbox({ FORMS_INBOX: " a@x.com, B@Y.com ,," }), ["a@x.com", "b@y.com"]);
  assert.deepEqual(formsInbox({ FORMS_INBOX: "not an email" }), ["baldeep@thetechfestival.com"]);
});

/* ---------- the email ---------- */
test("escaping and safe links", () => {
  assert.equal(esc(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  assert.equal(safeHttpUrl("https://linkedin.com/in/ada"), "https://linkedin.com/in/ada");
  assert.equal(safeHttpUrl("HTTP://x.example/a?b=1"), "http://x.example/a?b=1");
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "mailto:a@b.co", "//evil.example", "linkedin.com/in/x", " java\nscript:alert(1)", "https://"]) {
    assert.equal(safeHttpUrl(bad), "", bad);
  }
});

test("the email has a clear subject, every field, and reply-to the person", () => {
  const v = validateFormSubmission("volunteer", VOLUNTEER).value;
  const m = buildFormEmail({ ...v, createdAt: new Date("2026-10-11T14:00:00Z") });
  assert.equal(m.subject, "[Volunteer] Jane Doe");
  assert.equal(m.replyTo, "jane@example.com");
  for (const s of ["First name", "Jane", "Doe", "Preferred role 1", "Registration &amp; Check-In", "Why they want to volunteer", "I love tech.<br>And people.", "mailto:jane@example.com", "/volunteer"]) {
    assert.ok(m.html.includes(s), s);
  }
  assert.ok(m.text.includes("Preferred role 1: Registration & Check-In"));
  assert.ok(m.text.includes("Why they want to volunteer:\nI love tech.\nAnd people."));
});

test("whatever the visitor types is escaped in the email; only http(s) links are clickable", () => {
  const evil = {
    form: "speaker", name: `Eve "<script>alert(1)</script>`, email: "eve@x.io", company: `<img src=x onerror=alert(1)>`,
    jobTitle: `"><a href="javascript:alert(1)">click</a>`, message: `<b>hi</b>\n<iframe src="https://evil.example"></iframe>`,
    fields: { linkedin: "javascript:alert(document.cookie)", website: "https://ok.example/?a=<x>&b=\"y\"", note: "' onmouseover='alert(1)" },
    page: "/speakers", referrer: "https://ref.example/", createdAt: new Date(),
  };
  const m = buildFormEmail(evil);
  for (const bad of ["<script", "<img", "<iframe", "<b>hi", 'href="javascript:', "onerror=alert(1)>", "' onmouseover='"]) {
    assert.equal(m.html.includes(bad), false, bad);
  }
  assert.ok(m.html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  // The javascript: "LinkedIn" is shown as text, the https one is a link (escaped)
  assert.ok(m.html.includes("javascript:alert(document.cookie)"));
  assert.equal(/href="javascript/i.test(m.html), false);
  assert.ok(m.html.includes('href="https://ok.example/?a=%3Cx%3E&amp;b=%22y%22"'));
  // Every href in the email is mailto: or http(s)
  for (const [, href] of m.html.matchAll(/href="([^"]*)"/g)) assert.match(href, /^(mailto:|https?:\/\/)/, href);
  // No line breaks in the subject (header injection)
  const s = buildFormEmail({ form: "inquiry", name: "A\r\nBcc: x@y.z", email: "a@b.co" }).subject;
  assert.equal(/[\r\n]/.test(s), false);
});

test("no email given (sponsor) → no reply-to, a note in the email", () => {
  const m = buildFormEmail({ form: "sponsor", firstName: "Sam", lastName: "Lee", name: "Sam Lee", phone: "416", company: "Acme", fields: { industry: "AI" } });
  assert.equal(m.subject, "[Sponsor] Sam Lee (Acme)");
  assert.equal(m.replyTo, "");
  assert.ok(m.html.includes("No email address was given"));
});

test("drawer/email field rows skip empty values", () => {
  const rows = submissionFields({ form: "exhibit", firstName: "A", lastName: "", email: "a@b.co", fields: { booth: "Corner", boothSpecs: "10x20" }, message: "" });
  assert.deepEqual(rows.map((r) => r.key), ["firstName", "email", "fields.booth", "fields.boothSpecs"]);
  assert.equal(rows.find((r) => r.key === "fields.boothSpecs").label, "Booth size");
});

/* ---------- admin list ---------- */
test("admin filter: form, status and search are safe", () => {
  assert.deepEqual(submissionsFilter({}), {});
  assert.deepEqual(submissionsFilter({ form: "nope", status: "weird" }), {});
  assert.equal(submissionsFilter({ form: "speaker" }).form, "speaker");
  assert.equal(submissionsFilter({ status: "archived" }).status, "archived");
  const f = submissionsFilter({ q: "a.b (c)" });
  assert.ok(f.$or.some((c) => c.email && c.email.test("A.B (C)")));
  assert.equal(f.$or[0].name.test("aXb (c)"), false); // "." is literal
  const two = submissionsFilter({ q: "Jane Doe" });
  assert.ok(two.$or.some((c) => c.firstName && c.lastName));
  assert.equal(submissionsFilter({ q: { $ne: 1 } }).$or, undefined);
});

test("rows, summaries and details for the admin panel", () => {
  const doc = {
    _id: "665f1c2b9b1e8a0012345678", form: "volunteer", name: "Jane Doe", firstName: "Jane", lastName: "Doe",
    email: "jane@example.com", phone: "416", message: "Because.", fields: { preferredRole1: "Registration", preferredRole2: "Hospitality" },
    source: "recovered", emailStatus: "skipped", notes: "called", createdAt: new Date("2026-10-06T10:00:00Z"),
  };
  const r = submissionRow(doc);
  assert.equal(r.id, "665f1c2b9b1e8a0012345678");
  assert.equal(r.formLabel, "Volunteer application");
  assert.equal(r.summary, "Registration / Hospitality — Because.");
  assert.equal(r.status, "new");
  assert.equal(r.source, "recovered");
  assert.equal(r.hasNotes, true);
  const d = submissionDetail(doc);
  assert.equal(d.notes, "called");
  assert.ok(d.fields.some((f) => f.label === "Preferred role 2"));
  assert.ok(summaryOf({ form: "inquiry", message: "x".repeat(500) }).length <= 120);
});

test("staff edits: status and notes only", () => {
  assert.deepEqual(cleanSubmissionPatch({ status: "archived" }), { ok: true, set: { status: "archived" } });
  assert.deepEqual(cleanSubmissionPatch({ notes: " hi \r\n there " }), { ok: true, set: { notes: "hi\nthere" } });
  assert.equal(cleanSubmissionPatch({ status: "spam" }).ok, false);
  assert.equal(cleanSubmissionPatch({ notes: { $set: 1 } }).ok, false);
  assert.equal(cleanSubmissionPatch({ notes: "x".repeat(5001) }).ok, false);
  assert.equal(cleanSubmissionPatch({ email: "x@y.z" }).ok, false);
});

/* ---------- CSV ---------- */
test("CSV: header, formula escaping, quoting, BOM", () => {
  const csv = submissionsCsv([{
    form: "sponsor", name: "=HYPERLINK(\"http://evil\")", firstName: "+cmd", lastName: "-1", email: "@x.co", phone: "+1 416",
    company: "Acme, Inc.", message: "line1\nline2", fields: { industry: "AI" }, status: "contacted", notes: "\tx",
    source: "recovered", emailStatus: "skipped", createdAt: new Date("2026-10-07T09:08:07Z"),
  }]);
  assert.ok(csv.startsWith("﻿"));
  const [head, ...rest] = csv.slice(1).split("\n");
  assert.equal(head, CSV_HEAD.join(","));
  const row = rest.join("\n");
  assert.ok(row.startsWith("2026-10-07 09:08:07,Sponsor enquiry,"));
  assert.ok(row.includes(`"'=HYPERLINK(""http://evil"")"`));
  assert.ok(row.includes(",'+cmd,'-1,'@x.co,'+1 416,"));
  assert.ok(row.includes(`"Acme, Inc."`));
  assert.ok(row.includes(`"line1\nline2"`));
  assert.ok(row.includes("Industry: AI"));
  assert.ok(row.includes("Contacted"));
  assert.ok(row.includes("'\tx"));
  assert.ok(row.includes("Recovered from EmailJS"));
  assert.ok(row.includes("Not sent (recovered)"));
});

/* ---------- import (recovered from EmailJS) ---------- */
test("import maps a recovered row and never marks it for email", () => {
  const m = mapImportRow({
    form: "Volunteer", name: "Jane Doe", email: "JANE@x.io", phone: "416", company: "", message: "Hi",
    fields: { preferredRole1: "Registration", "$bad": 1 }, receivedAt: "2026-10-06T15:04:00Z",
  });
  assert.equal(m.ok, true);
  assert.equal(m.doc.form, "volunteer");
  assert.equal(m.doc.source, "recovered");
  assert.equal(m.doc.emailStatus, "skipped");
  assert.equal(m.doc.status, "new");
  assert.equal(m.doc.spam, false);
  assert.equal(m.doc.email, "jane@x.io");
  assert.equal(m.doc.firstName, "Jane");
  assert.equal(m.doc.lastName, "Doe");
  assert.deepEqual(m.doc.fields, { preferredRole1: "Registration" });
  assert.equal(m.doc.createdAt.toISOString(), "2026-10-06T15:04:00.000Z");
});

test("import refuses bad rows with a reason", () => {
  const bad = [
    [{ form: "nope", name: "A", receivedAt: "2026-10-06" }, /Unknown form/],
    [{ form: "speaker", name: "A" }, /receivedAt/],
    [{ form: "speaker", name: "A", receivedAt: "yesterday" }, /receivedAt/],
    [{ form: "speaker", name: "A", receivedAt: "2099-01-01" }, /future/],
    [{ form: "speaker", receivedAt: "2026-10-06" }, /name or an email/],
    [{ form: "speaker", name: "A", email: "nope", receivedAt: "2026-10-06" }, /Email/],
    [null, /object/],
  ];
  for (const [row, rx] of bad) {
    const m = mapImportRow(row);
    assert.equal(m.ok, false, JSON.stringify(row));
    assert.match(m.error, rx);
  }
});

test("import skips duplicates: same form + email + receivedAt", () => {
  const row = { form: "inquiry", name: "A B", email: "a@b.co", message: "x", receivedAt: "2026-10-06T10:00:00Z" };
  const p = planImport({ rows: [row, { ...row, email: "A@B.CO" }, { ...row, form: "sponsor" }, { form: "x" }] });
  assert.equal(p.ok, true);
  assert.equal(p.docs.length, 2);
  assert.deepEqual(p.skipped.map((s) => s.index), [1, 3]);
  assert.equal(p.skipped[0].reason, "duplicate");

  const existing = new Set([importKey({ form: "inquiry", email: "a@b.co", createdAt: "2026-10-06T10:00:00Z" })]);
  const again = planImport({ rows: [row] }, existing);
  assert.equal(again.docs.length, 0);
  assert.equal(again.skipped[0].reason, "duplicate");

  assert.equal(planImport({}).ok, false);
  assert.equal(planImport({ rows: [] }).ok, false);
  assert.equal(planImport({ rows: Array(IMPORT_MAX_ROWS + 1).fill(row) }).ok, false);
});

/* ---------- POST /api/forms/:form with fake storage and mailer ---------- */
function fakeRes() {
  return {
    statusCode: 0, body: null, headersSent: false,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
  };
}

function setup({ saveFails = false, sendFails = false, env = {}, gate = null } = {}) {
  const calls = [];
  const saved = [];
  const sent = [];
  const updates = [];
  const jobs = [];
  const handler = makeFormSubmitHandler({
    env,
    ipLimiter: makeLimiter({ max: 3, windowMs: 60_000 }),
    emailLimiter: makeLimiter({ max: 2, windowMs: 60_000 }),
    save: async (doc) => {
      calls.push("save");
      if (saveFails) throw new Error("db down");
      const d = { ...doc, _id: `id${saved.length + 1}`, createdAt: new Date() };
      saved.push(d);
      return d;
    },
    update: async (id, set) => { calls.push("update"); updates.push({ id, set }); },
    send: async (msg) => {
      calls.push("send");
      if (gate) await gate;
      if (sendFails) throw new Error("resend down");
      sent.push(msg);
      return { id: "re_123" };
    },
    background: (p) => jobs.push(p),
    log: { error() {} },
  });
  const run = async (form, body, ip = "1.1.1.1") => {
    const res = fakeRes();
    await handler({ params: { form }, body, ip, headers: { "user-agent": "Test" } }, res);
    return res;
  };
  return { run, calls, saved, sent, updates, jobs, settle: () => Promise.all(jobs) };
}

test("saves first, answers 201, then emails the inbox in the background", async () => {
  let open;
  const t = setup({ gate: new Promise((r) => { open = r; }) });
  const res = await t.run("volunteer", VOLUNTEER);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.success, true);
  assert.deepEqual(t.calls, ["save", "send"]); // answered while the email is still going
  assert.equal(t.sent.length, 0);
  open();
  assert.equal(t.saved[0].emailStatus, "sending");
  assert.equal(t.saved[0].source, "website");
  assert.equal(t.saved[0].userAgent, "Test");
  await t.settle();
  assert.deepEqual(t.calls, ["save", "send", "update"]);
  assert.deepEqual(t.sent[0].to, ["baldeep@thetechfestival.com"]);
  assert.equal(t.sent[0].subject, "[Volunteer] Jane Doe");
  assert.equal(t.sent[0].replyTo, "jane@example.com");
  assert.equal(t.updates[0].set.emailStatus, "sent");
  assert.equal(t.updates[0].set.emailId, "re_123");
});

test("FORMS_INBOX changes the recipient", async () => {
  const t = setup({ env: { FORMS_INBOX: "ops@example.com" } });
  await t.run("inquiry", { firstName: "A", lastName: "B", email: "a@b.co", message: "Hi" });
  await t.settle();
  assert.deepEqual(t.sent[0].to, ["ops@example.com"]);
});

test("a failed email is recorded; the visitor still sees success", async () => {
  const t = setup({ sendFails: true });
  const res = await t.run("speaker", { name: "Ada L", email: "ada@x.io" });
  assert.equal(res.statusCode, 201);
  await t.settle();
  assert.equal(t.updates[0].set.emailStatus, "failed");
  assert.match(t.updates[0].set.emailError, /resend down/);
});

test("a failed save still emails and answers success", async () => {
  const t = setup({ saveFails: true });
  const res = await t.run("exhibit", { firstName: "A", lastName: "B", email: "a@b.co", fields: { booth: "10x10" } });
  assert.equal(res.statusCode, 201);
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].subject, "[Exhibit] A B");
});

test("only when both the save and the email fail is it a 500, with the fallback address", async () => {
  const t = setup({ saveFails: true, sendFails: true });
  const res = await t.run("partnership", { firstName: "A", lastName: "B", email: "a@b.co", message: "Hi" });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.message, FAILED);
  assert.match(FAILED, /baldeep@thetechfestival\.com/);
});

test("bots are saved as spam and never emailed", async () => {
  const t = setup();
  const hp = await t.run("volunteer", { ...VOLUNTEER, _hp: "http://bot.example" });
  const fast = await t.run("volunteer", { ...VOLUNTEER, email: "b@x.io", elapsedMs: 200 }, "2.2.2.2");
  const rnd = await t.run("inquiry", { firstName: "sBjcqBNbVdtgTqNp", lastName: "B", email: "c@x.io", message: "x" }, "3.3.3.3");
  for (const r of [hp, fast, rnd]) assert.equal(r.statusCode, 201);
  await t.settle();
  assert.equal(t.sent.length, 0);
  assert.equal(t.saved.length, 3);
  assert.ok(t.saved.every((d) => d.spam === true && d.emailStatus === "blocked" && d.spamReason));
});

test("a honeypot hit with junk input gets a quiet 201 and nothing is saved", async () => {
  const t = setup();
  const res = await t.run("volunteer", { _hp: "x", email: "nope" });
  assert.equal(res.statusCode, 201);
  assert.equal(t.saved.length, 0);
});

test("bad input is a 400 with the field; unknown form a 404; nothing saved", async () => {
  const t = setup();
  const bad = await t.run("inquiry", { firstName: "A", lastName: "B", email: "a@b.co" });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.field, "message");
  const unknown = await t.run("payroll", VOLUNTEER);
  assert.equal(unknown.statusCode, 404);
  assert.equal(t.saved.length, 0);
});

test("rate limits per IP and per email", async () => {
  const t = setup();
  const body = { firstName: "A", lastName: "B", email: "same@x.io", message: "Hi" };
  assert.equal((await t.run("inquiry", body, "9.9.9.1")).statusCode, 201);
  assert.equal((await t.run("inquiry", body, "9.9.9.2")).statusCode, 201);
  const third = await t.run("inquiry", body, "9.9.9.3"); // email limit is 2 in this test
  assert.equal(third.statusCode, 429);
  assert.equal(third.body.message, TOO_MANY);

  const u = setup();
  for (let i = 0; i < 3; i++) await u.run("inquiry", { ...body, email: `p${i}@x.io` }, "7.7.7.7");
  assert.equal((await u.run("inquiry", { ...body, email: "p9@x.io" }, "7.7.7.7")).statusCode, 429);
});
