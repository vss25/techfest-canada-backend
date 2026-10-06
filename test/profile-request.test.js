import { test } from "node:test";
import assert from "node:assert/strict";
import {
  signProfileTicket, verifyProfileSig, profileLink, frontendUrl, maskEmail, publicProfileView,
  cleanAttendeeSubmission, hasAnswers, mergeAttendeeSubmission, normaliseLinkedin,
  planProfileRequests, missingKeyDetails, requestStamp, sendSequentially, countReasons,
} from "../services/profileRequest.js";
import { signTicketId, verifyTicketSig } from "../services/walletLink.js";
import { buildProfileRequestEmail, PROFILE_EMAIL_SUBJECT } from "../services/profileEmail.js";
import { collectTickets } from "../services/staffTickets.js";

const SECRET = "test-secret-not-real";

/* ---------- signing ---------- */
test("profile links verify with their own signature only", () => {
  const sig = signProfileTicket("ab12cd34", SECRET);
  assert.ok(sig.length > 20);
  assert.equal(verifyProfileSig("ab12cd34", sig, SECRET), true);
  assert.equal(verifyProfileSig("ab12cd35", sig, SECRET), false);           // another ticket
  assert.equal(verifyProfileSig("ab12cd34", sig, "other-secret"), false);   // another key
  assert.equal(verifyProfileSig("ab12cd34", "", SECRET), false);
  assert.equal(verifyProfileSig("ab12cd34", undefined, SECRET), false);
  assert.equal(verifyProfileSig("ab12cd34", sig, ""), false);               // no secret configured
});

test("a wallet signature is never a profile signature (and vice versa)", () => {
  const wallet = signTicketId("ab12cd34", SECRET);
  const profile = signProfileTicket("ab12cd34", SECRET);
  assert.notEqual(wallet, profile);
  assert.equal(verifyProfileSig("ab12cd34", wallet, SECRET), false);
  assert.equal(verifyTicketSig("ab12cd34", profile, SECRET), false);
  assert.equal(verifyTicketSig("ab12cd34", wallet, SECRET), true);
});

test("profile link points at the website form", () => {
  const link = profileLink("ab12cd34", { base: "https://www.thetechfestival.com", secret: SECRET });
  const u = new URL(link);
  assert.equal(u.origin + u.pathname, "https://www.thetechfestival.com/complete-profile");
  assert.equal(u.searchParams.get("t"), "ab12cd34");
  assert.equal(verifyProfileSig("ab12cd34", u.searchParams.get("s"), SECRET), true);
  assert.equal(profileLink("ab12cd34", { secret: "" }), "");
  assert.equal(frontendUrl({}), "https://www.thetechfestival.com");
  assert.equal(frontendUrl({ FRONTEND_URL: "http://localhost:5173/" }), "http://localhost:5173");
});

/* ---------- public view ---------- */
test("public view shows names, pass and own details, never staff notes or the full email", () => {
  const v = publicProfileView({
    name: "Jane Q Doe", email: "jane.doe@acme.com", tier: "apex", ticketId: "t1",
    details: { organisation: "Acme", topics: ["AI"], notes: "VIP, call first", editedByStaff: true, profileRequestedAt: "2026-10-01T00:00:00Z" },
  });
  assert.equal(v.firstName, "Jane");
  assert.equal(v.lastName, "Q Doe");
  assert.equal(v.pass, "Apex Pass");
  assert.equal(v.email, "ja•••@acme.com");
  assert.deepEqual(v.details, { organisation: "Acme", topics: ["AI"] });
  assert.equal(v.completed, false);
  assert.equal(JSON.stringify(v).includes("VIP"), false);
  assert.equal(maskEmail("a@b.co"), "a•••@b.co");
  assert.equal(maskEmail("nope"), "");
  assert.equal(publicProfileView({ name: "Guest", tier: "power", ticketId: "x" }).firstName, "");
});

/* ---------- cleaning ---------- */
test("attendee submission is whitelisted, trimmed and capped", () => {
  const c = cleanAttendeeSubmission({
    firstName: "  Jane ", lastName: "Doe\n", jobTitle: "x".repeat(500), organisation: " Acme ",
    phone: "+1 (416) 555-0100 <b>", linkedin: "linkedin.com/in/jane", country: "Canada",
    jobLevel: "Other", jobLevelOther: " Founder ", jobFunction: "Product",
    topics: ["AI", " AI ", 42, { $gt: "" }, "Banking, Financial Services & Insurance", ""],
    objectives: "Networking", consentUpdates: "true",
    notes: "I am staff now", source: "staff", editedByStaff: false, profileCompletedAt: "1999", role: "admin",
  });
  assert.equal(c.firstName, "Jane");
  assert.equal(c.lastName, "Doe");
  assert.equal(c.jobTitle.length, 150);
  assert.equal(c.organisation, "Acme");
  assert.equal(c.phone, "+1 (416) 555-0100");
  assert.equal(c.linkedin, "https://linkedin.com/in/jane");
  assert.equal(c.jobLevel, "Other: Founder");
  assert.deepEqual(c.topics, ["AI", "Banking, Financial Services & Insurance"]);
  assert.equal("objectives" in c, false);                 // not an array → ignored
  assert.equal(c.consentUpdates, true);
  for (const k of ["notes", "source", "editedByStaff", "profileCompletedAt", "role"]) assert.equal(k in c, false, k);
  assert.equal(cleanAttendeeSubmission({ consentUpdates: "yes please" }).consentUpdates, undefined);
  assert.equal(cleanAttendeeSubmission({ consentUpdates: false }).consentUpdates, false);
  assert.equal(hasAnswers(cleanAttendeeSubmission({})), false);
  assert.equal(hasAnswers(cleanAttendeeSubmission({ jobTitle: "   " })), false);
  assert.equal(hasAnswers(cleanAttendeeSubmission({ jobTitle: "CTO" })), true);
});

test("linkedin values become https links; other schemes are dropped", () => {
  assert.equal(normaliseLinkedin("https://www.linkedin.com/in/jane"), "https://www.linkedin.com/in/jane");
  assert.equal(normaliseLinkedin("www.linkedin.com/in/jane"), "https://www.linkedin.com/in/jane");
  assert.equal(normaliseLinkedin("jane-doe"), "https://www.linkedin.com/in/jane-doe");
  assert.equal(normaliseLinkedin("javascript:alert(1)"), "");
  assert.equal(normaliseLinkedin("data:text/html,hi"), "");
});

test("attendee answers never erase staff notes or existing answers with blanks", () => {
  const before = { organisation: "Acme", phone: "123", notes: "Staff only", editedByStaff: true, source: "checkout",
                   profileRequestedAt: "2026-10-01T00:00:00.000Z", profileRequestCount: 2, topics: ["AI"] };
  const next = mergeAttendeeSubmission(before, cleanAttendeeSubmission({
    organisation: "", jobTitle: "CTO", phone: "  ", topics: [], objectives: ["Networking"], consentUpdates: false,
  }), new Date("2026-10-06T12:00:00Z"));
  assert.equal(next.organisation, "Acme");
  assert.equal(next.phone, "123");
  assert.equal(next.jobTitle, "CTO");
  assert.deepEqual(next.topics, ["AI"]);
  assert.deepEqual(next.objectives, ["Networking"]);
  assert.equal(next.consentUpdates, false);
  assert.equal(next.notes, "Staff only");
  assert.equal(next.editedByStaff, true);
  assert.equal(next.profileRequestCount, 2);
  assert.equal(next.source, "attendee");
  assert.equal(next.profileCompletedAt, "2026-10-06T12:00:00.000Z");
  assert.equal(before.jobTitle, undefined);                // input not mutated
  assert.equal(mergeAttendeeSubmission(null, { jobTitle: "VP" }).jobTitle, "VP");
});

/* ---------- eligibility ---------- */
const NOW = new Date("2026-10-06T12:00:00Z");
const d = (s) => new Date(s);
const users = [
  { _id: "u1", name: "Ann Lee", email: "ann@acme.com", tickets: [
    { ticketId: "a1", type: "apex", purchaseDate: d("2026-09-01") },                                                     // no details
    { ticketId: "a2", type: "power", purchaseDate: d("2026-09-02"), hiddenByStaff: true },                              // hidden
  ] },
  { _id: "u2", name: "Bo Chan", email: "bo@x.com", tickets: [
    { ticketId: "b1", type: "connect", purchaseDate: d("2026-09-03"), details: { jobTitle: "CTO", organisation: "X" } }, // complete
  ] },
  { _id: "u3", name: "Cy", email: "cy@x.com", tickets: [
    { ticketId: "c1", type: "connect", purchaseDate: d("2026-09-04"), details: { jobTitle: "CTO", profileRequestedAt: "2026-10-05T12:00:00Z" } }, // asked yesterday
  ] },
];
const guests = [
  { ticketId: "g1", name: "Dee", email: "dee@x.com", ticketType: "power", purchaseDate: d("2026-09-05"), details: { organisation: "Org" } },
  { ticketId: "g2", name: "Dee", email: "dee@x.com", ticketType: "power", purchaseDate: d("2026-09-06") },               // newer → g1 is the duplicate
  { ticketId: "g3", name: "Eve", email: "eve@x.com", ticketType: "influence", purchaseDate: d("2026-09-07"),
    details: { profileCompletedAt: "2026-10-02T00:00:00Z" } },                                                            // already done
  { ticketId: "g4", name: "Fay", email: "", ticketType: "connect", purchaseDate: d("2026-09-08") },                     // no email
  { ticketId: "g5", name: "Gus", email: "gus@x.com", ticketType: "connect", purchaseDate: d("2026-09-09"), details: { profileRequestedAt: "2026-09-20T00:00:00Z" } }, // asked long ago
];

test("missing key details = no job title or no organisation", () => {
  assert.equal(missingKeyDetails({ details: null }), true);
  assert.equal(missingKeyDetails({ details: { jobTitle: "CTO" } }), true);
  assert.equal(missingKeyDetails({ details: { organisation: "X", jobTitle: " " } }), true);
  assert.equal(missingKeyDetails({ details: { organisation: "X", jobTitle: "CTO" } }), false);
});

test("bulk send: visible, not duplicate, missing details, not completed, not asked in 3 days", () => {
  const rows = collectTickets(users, guests);
  const { eligible, skipped } = planProfileRequests(rows, { now: NOW });
  assert.deepEqual(eligible.map((r) => r.ticketId).sort(), ["a1", "g2", "g5"]);
  const why = Object.fromEntries(skipped.map((s) => [s.key, s.reason]));
  assert.equal(why["u:u1:a2"], "hidden");
  assert.equal(why["u:u2:b1"], "has_details");
  assert.equal(why["u:u3:c1"], "recently_asked");
  assert.equal(why["g:g1"], "duplicate");
  assert.equal(why["g:g3"], "completed");
  assert.equal(why["g:g4"], "no_email");
  assert.deepEqual(countReasons(skipped), { hidden: 1, has_details: 1, recently_asked: 1, duplicate: 1, completed: 1, no_email: 1 });
  // force is ignored for bulk sends
  assert.deepEqual(planProfileRequests(rows, { now: NOW, force: true }).eligible.map((r) => r.ticketId).sort(), ["a1", "g2", "g5"]);
});

test("specific keys: only those; a single ticket needs force to resend within 3 days", () => {
  const rows = collectTickets(users, guests);
  const two = planProfileRequests(rows, { keys: ["u:u1:a1", "u:u3:c1", "g:nope"], now: NOW, force: true });
  assert.deepEqual(two.eligible.map((r) => r.ticketId), ["a1"]);
  assert.deepEqual(two.skipped.map((s) => s.reason).sort(), ["not_found", "recently_asked"]);

  const one = planProfileRequests(rows, { keys: ["u:u3:c1"], now: NOW });
  assert.deepEqual(one.eligible, []);
  assert.equal(one.skipped[0].reason, "recently_asked");
  assert.deepEqual(planProfileRequests(rows, { keys: ["u:u3:c1"], now: NOW, force: true }).eligible.map((r) => r.ticketId), ["c1"]);
  // a deliberate single send works even when job + company are known
  assert.deepEqual(planProfileRequests(rows, { keys: ["u:u2:b1"], now: NOW }).eligible.map((r) => r.ticketId), ["b1"]);
  // …but never to a ticket without an email
  assert.equal(planProfileRequests(rows, { keys: ["g:g4"], now: NOW, force: true }).skipped[0].reason, "no_email");
});

test("staff rows carry when the link was sent and when it was completed", () => {
  const rows = collectTickets(users, guests);
  assert.equal(rows.find((r) => r.ticketId === "c1").profileRequestedAt, "2026-10-05T12:00:00Z");
  assert.equal(rows.find((r) => r.ticketId === "g3").profileCompletedAt, "2026-10-02T00:00:00Z");
  assert.equal(rows.find((r) => r.ticketId === "a1").profileRequestedAt, null);
});

test("request stamp counts sends", () => {
  assert.deepEqual(requestStamp(null, NOW), { profileRequestedAt: "2026-10-06T12:00:00.000Z", profileRequestCount: 1 });
  assert.equal(requestStamp({ profileRequestCount: 2 }, NOW).profileRequestCount, 3);
});

test("sequential sending pauses between emails and keeps going after a failure", async () => {
  const waits = [];
  const order = [];
  const { sent, failed } = await sendSequentially(["a", "b", "c"], async (x) => {
    order.push(x);
    if (x === "b") throw new Error("rate limited");
  }, { delayMs: 600, wait: async (ms) => { waits.push(ms); } });
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.deepEqual(sent, ["a", "c"]);
  assert.deepEqual(failed, [{ item: "b", error: "rate limited" }]);
  assert.deepEqual(waits, [600, 600]);
});

/* ---------- email ---------- */
test("profile email escapes the name, carries the link and the pass, and never says the app is live", () => {
  const link = "https://www.thetechfestival.com/complete-profile?t=ab12&s=xyz-_1";
  const e = buildProfileRequestEmail({ firstName: `<img src=x onerror="alert(1)">Jo`, tier: "power", link });
  assert.equal(e.subject, PROFILE_EMAIL_SUBJECT);
  assert.equal(e.html.includes("<img src=x"), false);
  assert.ok(e.html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;Jo"));
  assert.ok(e.html.includes(`href="${link.replace("&", "&amp;")}"`));   // & is escaped in HTML attributes
  assert.ok(e.html.includes("Complete my profile"));
  assert.ok(e.html.includes("Power Pass"));
  assert.ok(e.html.includes("info@thetechfestival.com"));
  assert.ok(e.html.includes("max-width:600px"));
  assert.ok(e.html.includes("prefers-color-scheme: dark"));
  assert.ok(e.text.includes(link));
  assert.ok(e.text.includes("Power Pass"));
  assert.ok(/about a minute/i.test(e.text));
  assert.ok(/only shared with the TTFC organisers/i.test(e.text));
  assert.equal(/app store|download the app|mobile app/i.test(e.html + e.text), false);
  assert.ok(buildProfileRequestEmail({ link }).text.startsWith("Hi there,"));
  assert.ok(buildProfileRequestEmail({ firstName: "Guest", link }).text.startsWith("Hi there,"));
});

test("a hostile link can't break out of the href", () => {
  const e = buildProfileRequestEmail({ firstName: "Jo", link: `https://x.test/?a="><script>alert(1)</script>` });
  assert.equal(e.html.includes("<script>"), false);
});
