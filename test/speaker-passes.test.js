import { test, mock } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import {
  parseSpeakerDocs, isExcludedSpeaker, planSpeakerPasses, syncSpeakerPasses, speakerPassDoc, validateSpeakerEmail,
  passStatus, speakerPassRow, speakerPassCounts, readyToSend, speakerFirstName, speakerLastName, rsvpNameParts, SAMPLE_SPEAKER,
  SPEAKER_PASS_QUERY,
} from "../services/speakerPasses.js";
import {
  buildSpeakerPassEmail, speakerPassAttachments, speakerPassEmailFor, qrPayload, personalRsvpUrl, QR_CID, LOGO_CID, RSVP_URL,
  RSVP_REASON, CONTACT_EMAIL,
} from "../services/speakerPassEmail.js";
import { escapeHtml } from "../services/ticketInfo.js";
import { tierFromTicketType, resolvePass, checkOptions, DAY_KEYS, OPTION_KEYS, TIER_LABELS } from "../services/rsvp.js";
import { passName } from "../services/ticketAccess.js";
import { collectTickets, duplicateKeys, salesSummary } from "../services/staffTickets.js";
import Attendee from "../models/Attendee.js";
import User from "../models/User.js";
import ticketAuth from "../routes/ticketAuth.js";

/* ---------- Sync ---------- */

const SANITY = {
  result: [
    { _id: "s1", name: "  Hon. Evan  Solomon ", title: "Minister ", company: " ISED" },
    { _id: "s2", name: "Dr. Chris Golden ", title: "Colonel (Ret)", company: "USAF" },
    { _id: "s3", name: "Heling (Alex) Pu", title: "COO", company: "Quantum Bridge" },
    { _id: "drafts.s3", name: "Heling (Alex) Pu", title: "COO (draft)", company: "" },
    { _id: "s4", name: "", title: "No name" },
    { _id: "s3", name: "Heling (Alex) Pu", title: "dupe", company: "" },
  ],
};

/** An in-memory Attendee collection with the unique speakerId index. */
function memoryStore() {
  const docs = [];
  return {
    docs,
    existingSpeakerIds: async () => docs.map((d) => d.speakerId),
    create: async (doc) => {
      if (docs.some((d) => d.speakerId === doc.speakerId)) {
        throw Object.assign(new Error("E11000 duplicate key error index: speakerId_1"), { code: 11000 });
      }
      docs.push(doc);
      return doc;
    },
  };
}

test("the sync reads _id, name, title and company of every speaker", () => {
  assert.equal(SPEAKER_PASS_QUERY, '*[_type=="speaker"]{_id,name,title,company}');
  assert.deepEqual(parseSpeakerDocs(SANITY), [
    { speakerId: "s1", name: "Hon. Evan Solomon", title: "Minister", company: "ISED" },
    { speakerId: "s2", name: "Dr. Chris Golden", title: "Colonel (Ret)", company: "USAF" },
    { speakerId: "s3", name: "Heling (Alex) Pu", title: "COO", company: "Quantum Bridge" },
  ]);
  assert.deepEqual(parseSpeakerDocs(null), []);
});

test("Chris Golden never gets a pass, however his name is written", () => {
  for (const n of ["Chris Golden", "Dr. Chris Golden ", "dr chris golden", "CHRIS GOLDEN", "Christopher Golden", "Prof. Chris  Golden, PhD"]) {
    assert.ok(isExcludedSpeaker(n), n);
  }
  for (const n of ["Christy Clark", "Chris Goldenberg", "Chris Gold", "Jane Golden"]) assert.ok(!isExcludedSpeaker(n), n);
});

test("the sync creates one pass per speaker, excludes Chris Golden and is idempotent", async () => {
  const store = memoryStore();
  let n = 0;
  const deps = {
    loadSpeakers: async () => parseSpeakerDocs(SANITY), existingSpeakerIds: store.existingSpeakerIds, create: store.create,
    newTicketId: () => `0000000000${String(++n).padStart(2, "0")}`, now: () => new Date("2026-10-11T12:00:00Z"),
  };
  const first = await syncSpeakerPasses(deps);
  assert.deepEqual(first, {
    total: 3, created: 2, existing: 0, excluded: 1,
    createdNames: ["Hon. Evan Solomon", "Heling (Alex) Pu"], excludedNames: ["Dr. Chris Golden"],
  });
  assert.equal(store.docs.length, 2);
  const evan = store.docs[0];
  assert.deepEqual(evan, {
    name: "Hon. Evan Solomon", email: "", ticketId: "000000000001", ticketType: "speaker", promoCode: "SPEAKER",
    speakerId: "s1", purchaseDate: new Date("2026-10-11T12:00:00Z"), details: { jobTitle: "Minister", organisation: "ISED" },
  });

  const again = await syncSpeakerPasses(deps);
  assert.deepEqual(again, { total: 3, created: 0, existing: 2, excluded: 1, createdNames: [], excludedNames: ["Dr. Chris Golden"] });
  assert.equal(store.docs.length, 2);
  assert.equal(store.docs[0].ticketId, "000000000001"); // ticket IDs never change

  // Two clicks at once: the unique index stops the second copy, which counts as existing.
  const racing = await syncSpeakerPasses({ ...deps, existingSpeakerIds: async () => [] });
  assert.equal(racing.created, 0);
  assert.equal(racing.existing, 2);
  assert.equal(store.docs.length, 2);
});

test("a speaker pass gets a random 12-hex ticket ID like comp tickets", () => {
  const d = speakerPassDoc({ speakerId: "x", name: "Jane Doe", title: "", company: "" });
  assert.match(d.ticketId, /^[0-9a-f]{12}$/);
  assert.equal(d.details, undefined);
  assert.equal(planSpeakerPasses([{ speakerId: "x", name: "Jane Doe" }], ["x"]).existing.length, 1);
});

test("a speaker pass may have no email; every other pass still needs one", () => {
  const speaker = new Attendee(speakerPassDoc({ speakerId: "s9", name: "Jane Doe", title: "CAIO", company: "Example" }));
  assert.equal(speaker.validateSync(), undefined);
  const comp = new Attendee({ name: "App Review", email: "", ticketId: "abcabcabcabc", ticketType: "power" });
  assert.ok(comp.validateSync()?.errors?.email);
});

/* ---------- Admin rows and emails ---------- */

test("speaker emails are validated; empty clears", () => {
  assert.deepEqual(validateSpeakerEmail(" Jane.Doe@Example.COM "), { ok: true, email: "jane.doe@example.com" });
  assert.deepEqual(validateSpeakerEmail(""), { ok: true, email: "" });
  assert.equal(validateSpeakerEmail("jane@").ok, false);
  assert.equal(validateSpeakerEmail("a b@c.de").ok, false);
  assert.equal(validateSpeakerEmail(undefined).ok, false);
  assert.equal(validateSpeakerEmail(`${"a".repeat(250)}@b.co`).ok, false);
});

test("status: no email → ready → sent (a corrected email is ready again)", () => {
  const sentAt = new Date("2026-10-12T10:00:00Z");
  assert.equal(passStatus({ email: "" }), "no-email");
  assert.equal(passStatus({ email: "a@b.co" }), "ready");
  assert.equal(passStatus({ email: "a@b.co", passEmailSentAt: sentAt, passEmailSentTo: "a@b.co" }), "sent");
  assert.equal(passStatus({ email: "new@b.co", passEmailSentAt: sentAt, passEmailSentTo: "a@b.co" }), "ready");

  const docs = [
    { _id: "1", name: "A", ticketId: "t1", email: "" },
    { _id: "2", name: "B", ticketId: "t2", email: "b@x.co", claimedBy: "u1", checkedIn: true },
    { _id: "3", name: "C", ticketId: "t3", email: "c@x.co", passEmailSentAt: sentAt, passEmailSentTo: "c@x.co", passEmailSentCount: 2,
      details: { jobTitle: "CEO", organisation: "Acme" }, speakerId: "s3" },
  ];
  const rows = docs.map(speakerPassRow);
  assert.deepEqual(rows[2], {
    id: "3", speakerId: "s3", name: "C", title: "CEO", company: "Acme", ticketId: "t3", email: "c@x.co", alsoTo: [], emails: ["c@x.co"],
    emailSentAt: sentAt, emailSentTo: "c@x.co", sentCount: 2, status: "sent", claimed: false, checkedIn: false, createdAt: null,
    runOfShow: null, sessions: 0, contact: "", invitesSentAt: null, invitesSentCount: 0, nudgedAt: null, nudgeCount: 0, manual: false,
  });
  assert.equal(rows[1].claimed, true);
  assert.equal(rows[1].checkedIn, true);
  assert.deepEqual(speakerPassCounts(rows), { passes: 3, rsvpd: 0, withRunOfShow: 0, withEmail: 2, sent: 1, ready: 1 });
  assert.deepEqual(readyToSend(docs).map((d) => d.name), ["B"]);
});

test("first and last names for the greeting and sign-in", () => {
  assert.equal(speakerFirstName("Hon. Evan Solomon"), "Evan");
  assert.equal(speakerFirstName("Dr. Rulan S. Parekh"), "Rulan");
  assert.equal(speakerFirstName("Heling (Alex) Pu"), "Alex");
  assert.equal(speakerFirstName('Kulbir "Colin" Singh Dhillon'), "Colin");
  assert.equal(speakerFirstName(" Vance Lockton"), "Vance");
  assert.equal(speakerLastName("Dr. Rulan S. Parekh"), "Parekh");
  assert.equal(speakerLastName("Jane Doe, PhD"), "Doe");
  assert.equal(speakerLastName("Heling (Alex) Pu"), "Pu");
});

test("RSVP link names: last word is the last name, the rest (no honorifics) the first", () => {
  assert.deepEqual(rsvpNameParts("Jane Doe"), { first: "Jane", last: "Doe" });
  assert.deepEqual(rsvpNameParts("Dr. Rulan S. Parekh"), { first: "Rulan S.", last: "Parekh" });
  assert.deepEqual(rsvpNameParts("  Hon.  Evan Solomon "), { first: "Evan", last: "Solomon" });
  assert.deepEqual(rsvpNameParts("Hon. Dr. Mary Anne de Vries, PhD"), { first: "Mary Anne de", last: "Vries" });
  assert.deepEqual(rsvpNameParts("Heling (Alex) Pu"), { first: "Heling", last: "Pu" });
  assert.deepEqual(rsvpNameParts('Kulbir "Colin" Singh Dhillon'), { first: "Kulbir Singh", last: "Dhillon" });
  assert.deepEqual(rsvpNameParts("Dr. Smith"), { first: "", last: "Smith" });
  assert.deepEqual(rsvpNameParts(""), { first: "", last: "" });
});

test("the personal RSVP link carries ticket and names in the URL fragment, encoded", () => {
  assert.equal(personalRsvpUrl("Jane Doe", "a1b2c3d4e5f6"), "https://www.thetechfestival.com/rsvp#t=A1B2C3D4E5F6&fn=Jane&ln=Doe");
  assert.equal(personalRsvpUrl("Dr. Rulan S. Parekh", " 5ea4e2c0ffee "),
    "https://www.thetechfestival.com/rsvp#t=5EA4E2C0FFEE&fn=Rulan%20S.&ln=Parekh");
  const u = new URL(personalRsvpUrl("Zoë A&B O'Brien-Núñez", "x&y=z#w"));
  assert.equal(u.origin + u.pathname, RSVP_URL);
  assert.equal(u.search, "", "nothing in the query string");
  const h = new URLSearchParams(u.hash.slice(1));
  assert.deepEqual([...h.keys()], ["t", "fn", "ln"]);
  assert.equal(h.get("t"), "X&Y=Z#W");
  assert.equal(h.get("fn"), "Zoë A&B");
  assert.equal(h.get("ln"), "O'Brien-Núñez");
});

test("the speaker email: personal, complete and on brand", () => {
  const e = buildSpeakerPassEmail({ ...SAMPLE_SPEAKER, ticketId: "a1b2c3d4e5f6", qrSrc: `cid:${QR_CID}`, logoSrc: `cid:${LOGO_CID}` });
  assert.equal(e.subject, "Jane, your Speaker Pass for TTFC 2026");
  const link = `${RSVP_URL}#t=A1B2C3D4E5F6&fn=Jane&ln=Doe`;
  assert.match(e.preheader, /^We're delighted to have you speaking at TTFC 2026\./);
  for (const s of [
    "Dear Jane,", "delighted to have you speaking at TTFC&nbsp;2026.", "We look forward to welcoming you to Toronto",
    "SPEAKER PASS", "Jane Doe", "Chief AI Officer", "Example Corp",
    "October 26–27, 2026", "The Westin Harbour Castle", "A1B2C3D4E5F6", `src="cid:${QR_CID}"`, `src="cid:${LOGO_CID}"`,
    `href="${RSVP_URL}#t=A1B2C3D4E5F6&amp;fn=Jane&amp;ln=Doe"`, "Save your seat", escapeHtml(RSVP_REASON), "RSVP Now",
    // Oct 19 2026: Power's privileges plus both CxO Breakfasts and the VIP Lounge; no Apex extras.
    `mailto:${CONTACT_EMAIL}`, "2× Day Conference Access", "2× CxO Breakfasts", "2× Luncheons", "The Gala Dinner",
    "Catalyst Awards Night", "VIP Lounge Access (both days)", "Power + CxO Breakfasts &amp; VIP Lounge", "#06020f", "#7a3fd1", "#e8458b", "#f5a623",
  ]) assert.ok(e.html.includes(s), s);
  assert.ok(!/data:image/.test(e.html), "no data: URIs in a sent email");
  for (const s of ["Dear Jane,", "We're delighted to have you speaking at TTFC 2026.", "Ticket ID: A1B2C3D4E5F6", link,
    RSVP_REASON, CONTACT_EMAIL, "Gala Dinner", "VIP Lounge"]) {
    assert.ok(e.text.includes(s), s);
  }
  // Forward-looking, and the removed pieces are gone from both versions.
  for (const body of [e.html, e.text, e.preheader]) {
    for (const gone of [/thank you for speaking/i, /Speaker Lounge/, /Pre-matched meetings/i, /Preferential Seating/i, /Scotch/i,
      /All[- ]Access/i, /Exhibitor Pass/i, /Three quick steps/i,
      /Sign in to the TTFC app/, /Show your QR code at registration/, /we've made sure/i, /agree to take the stage/]) {
      assert.ok(!gone.test(body), String(gone));
    }
  }
  assert.ok(!e.html.includes(`href="${RSVP_URL}"`), "the button opens the personal link");
  assert.ok(!e.html.includes(`${RSVP_URL}?`) && !e.text.includes(`${RSVP_URL}?`), "never a query string");
});

test("every value in the speaker email is HTML-escaped", () => {
  const evil = '<script>alert("x")</script>';
  const e = buildSpeakerPassEmail({
    name: `Jane ${evil} O'Brien`, title: `<img src=x onerror=alert(1)>`, company: `"Acme" & <b>Co</b>`,
    ticketId: `abc"><svg onload=alert(1)>`, qrSrc: `cid:x" onerror="alert(1)`,
  });
  assert.ok(!e.html.includes("<script>"));
  assert.ok(!e.html.includes("<img src=x"));
  assert.ok(!e.html.includes("<b>Co</b>"));
  assert.ok(!e.html.includes("<svg"));
  assert.ok(!e.html.includes('" onerror="'));
  assert.ok(e.html.includes("O&#39;Brien"));
  assert.ok(e.html.includes("&quot;Acme&quot; &amp; &lt;b&gt;Co&lt;/b&gt;"));
  assert.ok(!/[\r\n]/.test(e.subject));
  // The RSVP href is URL-encoded, then HTML-escaped: nothing breaks out of the attribute.
  const href = /href="([^"]*thetechfestival\.com\/rsvp#[^"]*)"/.exec(e.html)?.[1];
  assert.ok(href, "personal RSVP href present");
  assert.ok(!/[<>"'\s]/.test(href), href);
  assert.ok(!/"[^"]*<svg/.test(e.html));
});

test("the QR is TECHFEST:<ticketId>, sent as an inline CID image", async () => {
  assert.equal(qrPayload("a1b2c3d4e5f6"), "TECHFEST:a1b2c3d4e5f6");
  const { srcs, attachments } = await speakerPassAttachments("a1b2c3d4e5f6");
  assert.deepEqual(srcs, { qrSrc: `cid:${QR_CID}`, logoSrc: `cid:${LOGO_CID}` });
  assert.deepEqual(attachments.map((a) => a.content_id), [QR_CID, LOGO_CID]);
  for (const a of attachments) {
    assert.equal(a.content_type, "image/png");
    assert.equal(Buffer.from(a.content, "base64").subarray(1, 4).toString(), "PNG");
  }
  const preview = await speakerPassEmailFor({ ...SAMPLE_SPEAKER }, { inline: true });
  assert.ok(preview.html.includes('src="data:image/png;base64,'));
  assert.deepEqual(preview.attachments, []);
});

/* ---------- Tier everywhere else ---------- */

test('tierFromTicketType("speaker") is "speaker": the RSVP page offers Power\'s options plus the CxO Breakfasts', () => {
  assert.equal(tierFromTicketType("speaker"), "speaker");
  assert.equal(tierFromTicketType("Speaker Pass"), "speaker");
  assert.equal(TIER_LABELS.speaker, "Speaker Pass");
  assert.equal(passName("speaker"), "Speaker Pass");
  assert.deepEqual(resolvePass({ kind: "ticket", tier: "speaker", verified: true }, ""), { ok: true, tier: "speaker", tierVerified: true, kind: "ticket" });
  // Name on the speaker list + a verified Speaker Pass ticket: proven.
  assert.deepEqual(resolvePass({ kind: "speaker", tier: "speaker", verified: true, ticket: { type: "speaker" } }, ""),
    { ok: true, tier: "speaker", tierVerified: true, kind: "speaker", detectedTier: "speaker" });
  assert.ok(checkOptions("speaker", DAY_KEYS, OPTION_KEYS.filter((k) => k !== "meetings" && k !== "lounge")).ok);
  assert.equal(checkOptions("speaker", DAY_KEYS, ["meetings"]).ok, false);
  assert.equal(checkOptions("speaker", DAY_KEYS, ["lounge"]).ok, false);
});

test("speaker passes are not sales and never duplicates of a bought ticket", () => {
  const rows = collectTickets([], [
    { ticketId: "sp1", name: "Jane Doe", email: "jane@x.co", ticketType: "speaker", purchaseDate: "2026-10-11" },
    { ticketId: "pw1", name: "Jane Doe", email: "jane@x.co", ticketType: "power", purchaseDate: "2026-09-01" },
  ]);
  assert.deepEqual(duplicateKeys(rows), []);
  const s = salesSummary(rows, { power: 999 }, { range: "all", now: new Date("2026-10-12") });
  assert.equal(s.totals.totalTickets, 1);
  assert.equal(s.totals.hiddenTickets, 0);
  assert.deepEqual(s.byTier.map((t) => t.tier), ["power"]);
});

/* ---------- App sign-in ---------- */

async function withTicketLogin(fn) {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", ticketAuth);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/api/auth/ticket-login`);
  } finally {
    server.close();
    mock.restoreAll();
  }
}

test("ticket sign-in works for a speaker pass with no email", async () => {
  process.env.JWT_SECRET ||= "test-secret";
  const pass = new Attendee(speakerPassDoc({ speakerId: "s1", name: "Dr. Rulan S. Parekh", title: "VP", company: "WCH" }, { ticketId: "5ea4e2c0ffee" }));
  const saved = [];
  mock.method(User, "findOne", async () => null);
  mock.method(User, "findById", async () => null);
  mock.method(Attendee, "findOne", async (q) => (q.ticketId.$in.includes("5ea4e2c0ffee") ? pass : null));
  mock.method(User.prototype, "save", async function () { saved.push(this); return this; });
  mock.method(Attendee.prototype, "save", async function () { await this.validate(); return this; });

  await withTicketLogin(async (url) => {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lastName: "parekh", ticketId: "TECHFEST:5EA4E2C0FFEE" }) });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.created, true);
    assert.equal(String(jwt.verify(body.token, process.env.JWT_SECRET).id), String(saved[0]._id));
  });
  const user = saved[0];
  assert.equal(user.email, "5ea4e2c0ffee@ticket.thetechfestival.com"); // the existing fallback
  assert.equal(user.tickets[0].type, "speaker");
  assert.equal(user.tickets[0].ticketId, "5ea4e2c0ffee");
  assert.equal(String(pass.claimedBy), String(user._id));
  assert.equal(pass.email, "");
});

test("a speaker pass carrying a staff email never signs in to the staff account", async () => {
  process.env.JWT_SECRET ||= "test-secret";
  const pass = new Attendee({ ...speakerPassDoc({ speakerId: "s2", name: "Baldeep Singh Pahwa" }, { ticketId: "0ddba11c0ffe" }), email: "staff@x.co" });
  const admin = new User({ name: "Staff", email: "staff@x.co", role: "admin" });
  mock.method(User, "findOne", async (q) => (q.email === "staff@x.co" ? admin : null));
  mock.method(Attendee, "findOne", async () => pass);
  mock.method(User.prototype, "save", async function () { throw new Error("must not save"); });
  mock.method(Attendee.prototype, "save", async function () { throw new Error("must not save"); });
  await withTicketLogin(async (url) => {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lastName: "Pahwa", ticketId: "0ddba11c0ffe" }) });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Staff accounts/);
  });
});
