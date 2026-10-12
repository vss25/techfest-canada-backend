import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  CAMPAIGN_KEY, LI_COOKIE, LI_SCOPE, SAMPLE_RECIPIENT, attendingLink, attendingReturnUrl, greetingName, isAttendingState,
  isPlaceholderEmail, licdnPhotoUrl, linkedinAuthUrl, linkedinConfigured, newLinkedinState, personFrom, planRecipients,
  readCookie, sendCounts, splitName, statesMatch, usableEmail, withSendStatus,
} from "../services/attendingCampaign.js";
import {
  LOGO_CID, PREVIEW_CID, attendingAttachments, attendingEmailFor, buildAttendingEmail, sendAttendingEmail,
} from "../services/attendingEmail.js";
import attendingRouter, { attendingLinkedinCallback } from "../routes/attending.js";

/* ---------- emails ---------- */

test("placeholder and unusable emails are refused", () => {
  assert.equal(isPlaceholderEmail("5ea4e2c0ffee@ticket.thetechfestival.com"), true);
  assert.equal(isPlaceholderEmail("JANE@Ticket.TheTechFestival.com"), true);
  assert.equal(isPlaceholderEmail("jane@thetechfestival.com"), false);
  assert.equal(usableEmail(" Jane@Example.COM "), "jane@example.com");
  assert.equal(usableEmail("abc@ticket.thetechfestival.com"), "");
  assert.equal(usableEmail("not-an-email"), "");
  assert.equal(usableEmail(""), "");
  assert.equal(usableEmail({ $ne: "" }), "");
});

/* ---------- names ---------- */

test("names come from checkout details, then the account, then the ticket name", () => {
  assert.deepEqual(splitName("  Jane  Q. Doe "), { firstName: "Jane Q.", lastName: "Doe" });
  assert.deepEqual(splitName("Guest"), { firstName: "", lastName: "" });
  assert.deepEqual(splitName("Cher"), { firstName: "Cher", lastName: "" });
  assert.deepEqual(
    personFrom({ name: "Card Holder", details: { firstName: "Jane", lastName: "Doe", jobTitle: "CTO", organisation: "Acme" } }),
    { firstName: "Jane", lastName: "Doe", title: "CTO", company: "Acme" },
  );
  assert.deepEqual(
    personFrom({ name: "Jane Doe", details: null, profile: { jobTitle: "VP AI", organization: "Initech" } }),
    { firstName: "Jane", lastName: "Doe", title: "VP AI", company: "Initech" },
  );
  assert.equal(greetingName({ firstName: "Jane Q.", lastName: "Doe" }), "Jane");
  assert.equal(greetingName({ firstName: "", lastName: "" }), "");
});

/* ---------- recipients ---------- */

const users = [
  {
    _id: "u1", name: "Jane Doe", email: "Jane@Example.com", jobTitle: "Profile title", organization: "Profile Co",
    tickets: [
      { ticketId: "t-old", type: "connect", purchaseDate: "2026-05-01", details: { firstName: "Jane", lastName: "Doe", organisation: "Acme" } },
      { ticketId: "t-new", type: "power", purchaseDate: "2026-09-01", details: { firstName: "Janet", lastName: "Doe" } },
    ],
  },
  { _id: "u2", name: "Test Buyer", email: "test@example.com", tickets: [{ ticketId: "t-hidden", type: "connect", hiddenByStaff: true }] },
  { _id: "u3", name: "Banned Person", email: "banned@example.com", banned: true, tickets: [{ ticketId: "t-b", type: "connect" }] },
  { _id: "u4", name: "Guest", email: "abc@ticket.thetechfestival.com", tickets: [{ ticketId: "t-ph", type: "connect" }] },
  { _id: "u5", name: "Booth Co", email: "booth@example.com", tickets: [{ ticketId: "BOOTH-1", type: "booth-a" }] },
];
const guests = [
  { name: "Jane Doe", email: "jane@example.com", ticketId: "t-new", ticketType: "power" }, // already on u1's account
  { name: "Sam Smith", email: "sam@example.com", ticketId: "g1", ticketType: "influence", purchaseDate: "2026-08-01", details: { jobTitle: "Founder" } },
  { name: "Sam Smith", email: "SAM@example.com", ticketId: "g2", ticketType: "connect", purchaseDate: "2026-07-01", details: { organisation: "SamCo" } },
  { name: "Dr. Rulan Parekh", email: "", ticketId: "sp1", ticketType: "speaker", details: { jobTitle: "Prof" } },
  { name: "Ana Lima", email: "ana@example.com", ticketId: "sp2", ticketType: "speaker", details: { jobTitle: "CEO", organisation: "Lima AI" } },
  { name: "Unsub Person", email: "unsub@example.com", ticketId: "g3", ticketType: "connect" },
  { name: "Hidden Guest", email: "hg@example.com", ticketId: "g4", ticketType: "connect", hiddenByStaff: true },
  { name: "Booth Guest", email: "bg@example.com", ticketId: "BOOTH-2", ticketType: "booth" },
];

test("recipients: one per email, hidden / placeholder / no-email / banned / unsubscribed / booths left out", () => {
  const { recipients, skipped } = planRecipients({ users, guests, optedOut: ["UNSUB@example.com"] });
  assert.deepEqual(recipients.map((r) => r.email).sort(), ["ana@example.com", "jane@example.com", "sam@example.com"]);
  const jane = recipients.find((r) => r.email === "jane@example.com");
  // newest ticket's name; what it lacks comes from the account profile before older tickets
  assert.equal(jane.firstName, "Janet");
  assert.equal(jane.company, "Profile Co");
  assert.equal(jane.title, "Profile title");
  assert.deepEqual(jane.tiers.sort(), ["connect", "power"]);
  const sam = recipients.find((r) => r.email === "sam@example.com");
  assert.equal(sam.title, "Founder");
  assert.equal(sam.company, "SamCo");
  const ana = recipients.find((r) => r.email === "ana@example.com");
  assert.deepEqual(ana.sources, ["speaker"]);
  assert.equal(ana.company, "Lima AI");
  assert.deepEqual(skipped, { hidden: 2, booth: 2, noEmail: 1, placeholder: 1, invalidEmail: 0, banned: 1, unsubscribed: 1, duplicate: 2 });
});

test("a hidden duplicate doesn't drop someone who also has a visible ticket", () => {
  const { recipients } = planRecipients({
    users: [],
    guests: [
      { name: "A B", email: "a@example.com", ticketId: "x1", ticketType: "connect", hiddenByStaff: true },
      { name: "A B", email: "a@example.com", ticketId: "x2", ticketType: "connect" },
    ],
  });
  assert.equal(recipients.length, 1);
});

/* ---------- the personal link ---------- */

test("attending link: values URL-encoded in the fragment, empty ones left out", () => {
  const link = attendingLink({ firstName: "Zoë", lastName: "O'Neil", title: "VP, R&D", company: "A+B <Labs>" });
  assert.ok(link.startsWith("https://www.thetechfestival.com/attending#"));
  assert.ok(!link.includes(" ") && !link.includes("<") && !link.includes("+"));
  const p = new URLSearchParams(link.split("#")[1]);
  assert.equal(p.get("fn"), "Zoë");
  assert.equal(p.get("ln"), "O'Neil");
  assert.equal(p.get("title"), "VP, R&D");
  assert.equal(p.get("co"), "A+B <Labs>");
  assert.equal(attendingLink({ firstName: "Jane" }), "https://www.thetechfestival.com/attending#fn=Jane");
  assert.equal(attendingLink({}), "https://www.thetechfestival.com/attending");
});

/* ---------- send status ---------- */

test("send status per recipient and the counts", () => {
  const rows = withSendStatus(
    [{ email: "a@x.com" }, { email: "b@x.com" }, { email: "c@x.com" }, { email: "d@x.com" }],
    [{ email: "a@x.com", status: "sent", sentAt: new Date(0) }, { email: "B@x.com", status: "failed", error: "boom" }, { email: "c@x.com", status: "sending" }],
  );
  assert.deepEqual(rows.map((r) => r.status), ["sent", "failed", "sending", "pending"]);
  assert.equal(rows[1].error, "boom");
  assert.deepEqual(sendCounts(rows), { recipients: 4, sent: 1, failed: 1, sending: 1, pending: 1 });
});

/* ---------- LinkedIn ---------- */

test("LinkedIn: state, cookie, auth URL and config", () => {
  const s = newLinkedinState();
  assert.ok(isAttendingState(s));
  assert.equal(isAttendingState("abc123"), false);
  assert.equal(statesMatch(s, s), true);
  assert.equal(statesMatch(s, newLinkedinState()), false);
  assert.equal(statesMatch(s, ""), false);
  assert.equal(readCookie(`a=1; ${LI_COOKIE}=${encodeURIComponent(s)}; b=2`, LI_COOKIE), s);
  assert.equal(readCookie("a=1", LI_COOKIE), "");
  const url = new URL(linkedinAuthUrl({ clientId: "cid", redirectUri: "https://api.example/cb", state: s }));
  assert.equal(url.searchParams.get("scope"), LI_SCOPE);
  assert.equal(url.searchParams.get("redirect_uri"), "https://api.example/cb");
  assert.equal(linkedinConfigured({ LINKEDIN_CLIENT_ID: "a", LINKEDIN_CLIENT_SECRET: "b" }), false);
  assert.equal(linkedinConfigured({ LINKEDIN_CLIENT_ID: "a", LINKEDIN_CLIENT_SECRET: "b", LINKEDIN_REDIRECT_URI: "c" }), true);
});

test("only https LinkedIn CDN pictures pass", () => {
  const ok = "https://media.licdn.com/dms/image/v2/abc/profile-displayphoto-shrink_800_800/0/1?e=1&v=beta&t=x";
  assert.equal(licdnPhotoUrl(ok), ok);
  assert.ok(licdnPhotoUrl("https://media-exp1.licdn.com/dms/image/x"));
  for (const bad of [
    "http://media.licdn.com/x", "https://media.licdn.com.evil.com/x", "https://evil.com/media.licdn.com",
    "https://user:pw@media.licdn.com/x", "https://media.licdn.com:8443/x", "https://licdn.com/x", "javascript:alert(1)", "",
  ]) assert.equal(licdnPhotoUrl(bad), "", bad);
});

test("the trip back to /attending carries names and the picture in the fragment", () => {
  const url = attendingReturnUrl("https://www.thetechfestival.com/", { firstName: "Jane", lastName: "Doe", picture: "https://media.licdn.com/p.jpg?a=1&b=2" });
  assert.ok(url.startsWith("https://www.thetechfestival.com/attending#li=1"));
  const p = new URLSearchParams(url.split("#")[1]);
  assert.equal(p.get("pic"), "https://media.licdn.com/p.jpg?a=1&b=2");
  assert.equal(p.get("ln"), "Doe");
  const evil = new URLSearchParams(attendingReturnUrl("https://x", { picture: "https://evil.com/p.jpg" }).split("#")[1]);
  assert.equal(evil.get("pic"), null);
  assert.equal(attendingReturnUrl("https://x", { error: "cancelled" }), "https://x/attending#li_error=cancelled");
});

function fakeRes() {
  const res = { headers: {}, cookies: [], statusCode: 200, location: "" };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.append = (k, v) => { if (k === "Set-Cookie") res.cookies.push(v); return res; };
  res.redirect = (code, url) => { res.statusCode = code; res.location = url; return res; };
  return res;
}

test("callback: other LinkedIn sign-ins fall through; a forged attending state is refused", async () => {
  let passed = false;
  await attendingLinkedinCallback({ query: { state: "plainhexstate", code: "c" }, headers: {} }, fakeRes(), () => { passed = true; });
  assert.equal(passed, true);

  const res = fakeRes();
  const state = newLinkedinState();
  await attendingLinkedinCallback({ query: { state, code: "c" }, headers: { cookie: `${LI_COOKIE}=${newLinkedinState()}` }, secure: true },
    res, () => assert.fail("should not fall through"));
  assert.equal(res.statusCode, 302);
  assert.match(res.location, /\/attending#li_error=expired$/);
  assert.match(res.cookies[0], /Max-Age=0/); // the state cookie is single use

  const cancelled = fakeRes();
  await attendingLinkedinCallback({ query: { state, error: "user_cancelled_login" }, headers: { cookie: `${LI_COOKIE}=${state}` } }, cancelled, () => {});
  assert.match(cancelled.location, /li_error=cancelled$/);
});

test("photo proxy refuses anything but LinkedIn picture URLs", async () => {
  const app = express();
  app.use("/api/attending", attendingRouter);
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/attending/photo`;
    for (const u of ["https://evil.com/x.png", "http://127.0.0.1:5000/secret", "file:///etc/passwd", ""]) {
      const r = await fetch(`${base}?u=${encodeURIComponent(u)}`);
      assert.equal(r.status, 400, u);
    }
  } finally {
    server.close();
  }
});

test("LinkedIn start without configuration sends people back with li_error=unavailable", async () => {
  const saved = process.env.LINKEDIN_CLIENT_ID;
  delete process.env.LINKEDIN_CLIENT_ID;
  const app = express();
  app.use("/api/attending", attendingRouter);
  const server = app.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/attending/linkedin`, { redirect: "manual" });
    assert.equal(r.status, 302);
    assert.match(r.headers.get("location"), /\/attending#li_error=unavailable$/);
  } finally {
    server.close();
    if (saved !== undefined) process.env.LINKEDIN_CLIENT_ID = saved;
  }
});

/* ---------- the email ---------- */

test("email: personal subject, escaped values, the personal link and a plain-text version", () => {
  const e = buildAttendingEmail({ firstName: "Jane", lastName: "Doe", title: "VP <script>", company: "R&D \"Labs\"", logoSrc: "cid:x", previewSrc: "cid:y" });
  assert.equal(e.subject, "Jane, show the world you're attending TTFC 2026");
  assert.ok(!e.html.includes("<script>"));
  assert.ok(e.html.includes('href="https://www.thetechfestival.com/attending#fn=Jane&amp;ln=Doe&amp;title='));
  assert.ok(e.text.includes(e.link));
  assert.ok(e.text.includes("Create my LinkedIn post"));
  assert.ok(e.html.includes("Create my LinkedIn post"));
  assert.ok(e.html.includes('src="cid:y"'));
  assert.equal(buildAttendingEmail({}).subject, "Show the world you're attending TTFC 2026");
  assert.ok(buildAttendingEmail({}).html.includes("Hello,"));
});

test("email: inline images for previews, CID attachments for sending", () => {
  const preview = attendingEmailFor(SAMPLE_RECIPIENT, { inline: true });
  assert.ok(preview.html.includes("data:image/jpeg;base64,"));
  assert.deepEqual(preview.attachments, []);
  const { srcs, attachments } = attendingAttachments();
  assert.equal(srcs.previewSrc, `cid:${PREVIEW_CID}`);
  assert.deepEqual(attachments.map((a) => a.content_id), [LOGO_CID, PREVIEW_CID]);
  assert.ok(attachments.every((a) => a.content.length > 1000));
});

test("sending: Resend gets reply-to, unsubscribe header, campaign tag and the inline images; refusals throw", async () => {
  const calls = [];
  const client = { emails: { send: async (p) => { calls.push(p); return { data: { id: "re_1" }, error: null }; } } };
  const data = await sendAttendingEmail({ to: "jane@example.com", recipient: SAMPLE_RECIPIENT, subjectPrefix: "[Test] ", client });
  assert.equal(data.id, "re_1");
  const p = calls[0];
  assert.equal(p.to, "jane@example.com");
  assert.equal(p.reply_to, "enquire@thetechfestival.com");
  assert.ok(p.subject.startsWith("[Test] Jane, show the world"));
  assert.match(p.headers["List-Unsubscribe"], /mailto:enquire@thetechfestival\.com/);
  assert.deepEqual(p.tags, [{ name: "campaign", value: CAMPAIGN_KEY }]);
  assert.equal(p.attachments.length, 2);
  assert.ok(p.text && p.html.includes(`cid:${PREVIEW_CID}`));

  const refusing = { emails: { send: async () => ({ data: null, error: { message: "rate limited" } }) } };
  await assert.rejects(sendAttendingEmail({ to: "a@b.co", recipient: SAMPLE_RECIPIENT, client: refusing }), /rate limited/);
  await assert.rejects(sendAttendingEmail({ to: "", recipient: SAMPLE_RECIPIENT, client }), /Missing email/);
});
