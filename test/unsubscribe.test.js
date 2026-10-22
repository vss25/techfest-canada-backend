/* Unsubscribing from TTFC's bulk emails (Oct 22 2026), the pure parts: signed links, the one-click headers, staff's
   pasted lists, the link in each campaign email (real sends only) and the last check before each email. No database,
   no network. Fictional people, example.com. */
import test from "node:test";
import assert from "node:assert/strict";

process.env.TRACKING_SECRET ||= "unsubscribe-test-secret";
process.env.RESEND_API_KEY ||= "re_dummy";

const U = await import("../services/unsubscribe.js");
const { sendAttendingEmail, attendingEmailFor } = await import("../services/attendingEmail.js");
const { sendRsvpReminder, makeReminderSender } = await import("../services/rsvpReminder.js");

const SECRET = "unsubscribe-test-secret";

test("tokens: sign → verify gives the address back; tampered, foreign or unsigned tokens give nothing", () => {
  const t = U.signUnsubscribe("  Jane.Doe@Example.com ", SECRET);
  assert.match(t, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
  assert.equal(U.verifyUnsubscribe(t, SECRET), "jane.doe@example.com");
  const [body, sig] = t.split(".");
  const other = Buffer.from("john.roe@example.com").toString("base64url");
  assert.equal(U.verifyUnsubscribe(`${other}.${sig}`, SECRET), "", "someone else's address with Jane's signature");
  assert.equal(U.verifyUnsubscribe(`${body}.${sig.slice(0, -1)}A`, SECRET), "");
  assert.equal(U.verifyUnsubscribe(t, "another-secret"), "");
  assert.equal(U.verifyUnsubscribe("", SECRET), "");
  assert.equal(U.verifyUnsubscribe("not a token", SECRET), "");
  assert.equal(U.verifyUnsubscribe(t, ""), "", "no secret: nothing verifies");
  assert.equal(U.signUnsubscribe("jane@example.com", ""), "", "no secret: nothing is signed");
  assert.equal(U.signUnsubscribe("not an email", SECRET), "");
});

test("links and headers: one-click for a real send, the preview page and the mailto otherwise", () => {
  const base = "https://api.example.com";
  const url = U.unsubscribeUrl("jane@example.com", { base, secret: SECRET });
  assert.match(url, /^https:\/\/api\.example\.com\/api\/unsubscribe\?t=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
  assert.equal(U.verifyUnsubscribe(url.split("?t=")[1], SECRET), "jane@example.com");

  const real = U.unsubscribeFor("jane@example.com", { real: true, mailto: "enquire@example.com", base, secret: SECRET });
  assert.equal(real.url, url);
  assert.deepEqual(real.headers, {
    "List-Unsubscribe": `<${url}>, <mailto:enquire@example.com?subject=unsubscribe>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  });

  const preview = U.unsubscribeFor("jane@example.com", { real: false, mailto: "enquire@example.com", base, secret: SECRET });
  assert.equal(preview.url, "https://api.example.com/api/unsubscribe/preview");
  assert.deepEqual(preview.headers, { "List-Unsubscribe": "<mailto:enquire@example.com?subject=unsubscribe>" });

  // No secret: a real send still says how (the mailto), never a link that can't work.
  const unsigned = U.unsubscribeFor("jane@example.com", { real: true, mailto: "enquire@example.com", base, secret: "" });
  assert.deepEqual(unsigned.headers, { "List-Unsubscribe": "<mailto:enquire@example.com?subject=unsubscribe>" });
  assert.deepEqual(U.unsubscribeHeaders("", {}), {});
  assert.deepEqual(U.unsubscribeHeaders("http://insecure.example.com/x", { mailto: "a@example.com" }), { "List-Unsubscribe": "<mailto:a@example.com?subject=unsubscribe>" });
});

test("addresses: cleaned, masked for the page", () => {
  assert.equal(U.cleanEmail(" MAILTO:Jane@Example.COM "), "jane@example.com");
  for (const bad of ["", "jane", "jane@", "@example.com", "jane@example", "a b@example.com", "<jane@example.com>", null, undefined]) assert.equal(U.cleanEmail(bad), "", String(bad));
  assert.equal(U.maskEmail("jane.doe@example.com"), "j••••••@example.com");
  assert.equal(U.maskEmail("j@example.com"), "j•@example.com");
  assert.equal(U.maskEmail("nope"), "");
});

test("pasted lists: any separators, names, a forwarded email; unique, in order; junk with an @ reported", () => {
  const pasted = `From: Jane Doe <Jane.Doe@example.com>
Subject: Re: Baldeep, show the world you're attending TTFC 2026
unsubscribe

john.roe@example.com, "Ann Lee" <ann.lee@example.org>; mailto:bo@example.net.
jane.doe@example.com
broken@ and @nothing and not-an-email`;
  const r = U.parseEmailList(pasted);
  assert.deepEqual(r.emails, ["jane.doe@example.com", "john.roe@example.com", "ann.lee@example.org", "bo@example.net"]);
  assert.deepEqual(r.invalid, ["broken@", "@nothing"]);
  assert.deepEqual(U.parseEmailList(["a@example.com", "A@example.com", "b@example.com"]).emails, ["a@example.com", "b@example.com"]);
  assert.deepEqual(U.parseEmailList(undefined), { emails: [], invalid: [] });
});

/* ---------- the campaign emails ---------- */

const fakeClient = (calls) => ({ emails: { send: async (m) => { calls.push(m); return { data: { id: `re_${calls.length}` }, error: null }; } } });
const linkIn = (headers) => /^<(https:\/\/[^>]+\/api\/unsubscribe\?t=([^>]+))>/.exec(headers?.["List-Unsubscribe"] || "");

test("'I'm attending': a real send carries their own link (footer, text, headers); a test send the preview link", async () => {
  const calls = [];
  await sendAttendingEmail({ to: "Jane.Doe@example.com", recipient: { firstName: "Jane" }, client: fakeClient(calls), track: true, noteTracked: () => {} });
  const m = calls[0];
  const l = linkIn(m.headers);
  assert.ok(l, m.headers["List-Unsubscribe"]);
  assert.equal(U.verifyUnsubscribe(l[2]), "jane.doe@example.com");
  assert.match(m.headers["List-Unsubscribe"], /, <mailto:marcom@thetechfestival\.com\?subject=unsubscribe>$/);
  assert.equal(m.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.ok(m.html.includes(`href="${l[1]}"`));
  assert.ok(m.text.includes(`Unsubscribe: ${l[1]}`));
  assert.doesNotMatch(m.html + m.text, /Reply with/);

  await sendAttendingEmail({ to: "staff@example.com", recipient: { firstName: "Jane" }, client: fakeClient(calls), subjectPrefix: "[Test] ", noteTracked: () => {} });
  assert.deepEqual(calls[1].headers, { "List-Unsubscribe": "<mailto:marcom@thetechfestival.com?subject=unsubscribe>" });
  assert.match(calls[1].html, /\/api\/unsubscribe\/preview/);
  assert.match(attendingEmailFor({ firstName: "Jane" }).html, /\/api\/unsubscribe\/preview/, "the admin preview");
});

test("RSVP reminder: a real send carries their own link and one-click headers; a test send doesn't", async () => {
  const row = { firstName: "Jane", tickets: [{ ticketId: "ab0000000001", firstName: "Jane", lastName: "Doe" }] };
  const calls = [];
  await sendRsvpReminder({ to: "jane.doe@example.com", row, client: fakeClient(calls), track: true, noteTracked: () => {} });
  const l = linkIn(calls[0].headers);
  assert.ok(l);
  assert.equal(U.verifyUnsubscribe(l[2]), "jane.doe@example.com");
  assert.match(calls[0].headers["List-Unsubscribe"], /, <mailto:enquire@thetechfestival\.com\?subject=unsubscribe>$/);
  assert.equal(calls[0].headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.ok(calls[0].html.includes(`href="${l[1]}"`) && calls[0].text.includes(l[1]));
  await sendRsvpReminder({ to: "staff@example.com", row, client: fakeClient(calls), subjectPrefix: "[Test] ", noteTracked: () => {} });
  assert.equal(calls[1].headers["List-Unsubscribe-Post"], undefined);
  assert.doesNotMatch(calls[1].html, /\/api\/unsubscribe\?t=/);
});

test("the last check before each email: someone on the list is never sent to, even with force", async () => {
  const out = new Set(["una@example.com"]);
  const claimed = [];
  const store = {
    optedOut: async (e) => out.has(e),
    claim: async (e) => { claimed.push(e); return true; },
    sent: async () => {}, failed: async () => {},
  };
  const mails = [];
  const sendTo = makeReminderSender({ store, send: async ({ to }) => { mails.push(to); return { id: "re_1" }; } });
  assert.equal(await sendTo({ email: "una@example.com" }, "staff"), "unsubscribed");
  assert.equal(await sendTo({ email: "una@example.com" }, "staff", { force: true }), "unsubscribed");
  assert.ok((await sendTo({ email: "ann@example.com" }, "staff")) instanceof Date);
  assert.deepEqual([claimed, mails], [["ann@example.com"], ["ann@example.com"]]);
  // A store without the check (older callers, tests' fakes) still sends.
  const plain = makeReminderSender({ store: { claim: async () => true, sent: async () => {}, failed: async () => {} }, send: async () => ({ id: "x" }) });
  assert.ok((await plain({ email: "una@example.com" })) instanceof Date);
});
