/* "Stay updated": the TTFC 2027 waitlist (Oct 23 2026). Pure parts (services/waitlist.js), the confirmation email
   (services/waitlistEmail.js) and the request handler with fakes (services/waitlistHandler.js): no database, nothing
   is sent (the email clients are stubs). Fictional people only (example.com / acme.example). */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.RESEND_API_KEY ||= "re_test_stub"; // modules make a Resend client on import (never used here)

import {
  CONFIRM_EVERY_MS, DEFAULT_MESSAGE, INTERESTS, PAGE_URL, STAY_DEFAULTS, STAY_KEYS, alertSubject, buildWaitlistAlert, cleanInterests,
  confirmDue, ipHash, phoneDigits, stayCopy, telHref, validateSignup, waitlistCounts, waitlistCsv, waitlistFilter, waitlistInbox, waitlistRow,
} from "../services/waitlist.js";
import { ATTENDING, ENQUIRE_EMAIL, WAITLIST_CAMPAIGN, askedAbout, buildWaitlistEmail, sendWaitlistEmail, waitlistEmailFor } from "../services/waitlistEmail.js";
import { FAILED, TOO_MANY, makeWaitlistHandler } from "../services/waitlistHandler.js";
import { CONTENT_KEYS, cleanContent } from "../services/adminHelpers.js";
import { DEFAULT_JOURNEY, DEFAULT_JOURNEY_JSON } from "../services/stayJourney.js";
import { makeLimiter } from "../services/ticketAccess.js";

/* ---------- the wording ---------- */

test("the page's wording: the organiser's facts only, every piece an app content key (editable in Admin)", () => {
  assert.equal(STAY_DEFAULTS["stay.hero_title"], "TTFC 2027 · Toronto · November 2027");
  assert.equal(STAY_DEFAULTS["stay.journey_title"], "TTFC 2027 across Canada");
  assert.equal(STAY_DEFAULTS["stay.journey_intro"], "Five focused one-day briefings, each on one technology pillar and one sector, lead to two days in Toronto in November 2027. Dates to be announced for every event.");
  assert.equal(STAY_DEFAULTS["stay.journey"], DEFAULT_JOURNEY_JSON, "the journey's default is the organiser's six stops");
  // The 5 × 5 programme, "What to expect", the old events list and the attendee line are gone (the organiser, Oct 23 2026).
  for (const k of ["stay.program_title", "stay.program_intro", "stay.pillars_title", "stay.pillars", "stay.sectors_title", "stay.sectors",
    "stay.expect_title", "stay.expect", "stay.briefings_title", "stay.briefings_intro", "stay.briefings", "stay.stat"]) {
    assert.equal(k in STAY_DEFAULTS, false, k);
    assert.equal(k in CONTENT_KEYS, false, k);
  }
  const words = Object.entries(STAY_DEFAULTS).filter(([k]) => k !== "stay.journey").map(([, v]) => v).join("\n");
  const all = `${words}\n${DEFAULT_JOURNEY.map((s) => Object.values(s).join(" ")).join("\n")}`;
  // No attendee count anywhere on 2027 material, and no other numbers.
  assert.doesNotMatch(all, /attendees|delegates/i, "no attendee count");
  assert.doesNotMatch(all.replace(/\b2027\b/g, ""), /\d{3,}|\d[\d,+ ]*\s*(attendees|delegates|people|speakers)/i, "no other counts or years");
  // The only dates the organiser gave are months; every exact date and venue is to be announced.
  assert.doesNotMatch(all.replace(/\b(February|April|June|September|November) 2027\b/g, ""), /\b(2027-|January|February|March|April|May|June|July|August|September|October|November|December)\b/, "no invented dates");
  assert.doesNotMatch(all, /Westin|Harbour/i, "no 2027 venue");
  assert.match(STAY_DEFAULTS["stay.hero_intro"], /Vancouver, Montreal, Calgary, Toronto and Ottawa.*two days in Toronto in November 2027\. Dates to be announced for every event\./);
  assert.match(STAY_DEFAULTS["stay.email_intro"], /one-day briefings in Vancouver, Montreal, Calgary, Toronto and Ottawa, then The Tech Festival Canada, two days in Toronto in November 2027\. Dates to be announced/);
  assert.ok(STAY_DEFAULTS["stay.seo_description"].length <= 160, "fits a search result");
  assert.equal(DEFAULT_MESSAGE, "Thank you for your interest. Someone from our team will reach out.");
  // Every key is in CONTENT_KEYS (GET /api/app/content, Admin's editor) with this default; the texts save as plain text.
  for (const k of STAY_KEYS) {
    assert.equal(CONTENT_KEYS[k], STAY_DEFAULTS[k], k);
    assert.ok(STAY_DEFAULTS[k].length <= 2000, `${k} fits the editor`);
  }
  assert.deepEqual(cleanContent("stay.thanks", "  Thanks!  "), ["stay.thanks", "  Thanks!  "]);
});

test("stayCopy: saved values over the defaults; empty or unknown values are ignored", () => {
  const c = stayCopy([{ key: "stay.thanks", value: "Thanks, we'll be in touch." }, { key: "stay.button", value: "   " }, { key: "site.x_url", value: "x" }]);
  assert.equal(c["stay.thanks"], "Thanks, we'll be in touch.");
  assert.equal(c["stay.button"], STAY_DEFAULTS["stay.button"]);
  assert.equal("site.x_url" in c, false);
  assert.deepEqual(stayCopy(), { ...STAY_DEFAULTS });
});

/* ---------- what the form sends ---------- */

const GOOD = { email: " Jane@Acme.Example ", phone: "+1 (416) 555-0100", interests: ["exhibitor", "sponsorship", "sponsorship", "golf"], source: "ios", consent: true };

test("validateSignup: email and phone required, 7–20 digits after + spaces dashes parens, consent, known ticks only", () => {
  const ok = validateSignup(GOOD);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { email: "jane@acme.example", phone: "+1 (416) 555-0100", phoneDigits: "14165550100", interests: ["sponsorship", "exhibitor"], source: "ios", consent: true });
  const field = (b) => validateSignup({ ...GOOD, ...b });
  assert.deepEqual([field({ email: "" }).field, field({ email: "" }).error], ["email", "Enter your email address."]);
  for (const email of ["jane", "jane@acme", "jane@@acme.example", "jane acme@x.example", `${"a".repeat(250)}@x.example`]) {
    assert.equal(field({ email }).field, "email", email);
  }
  assert.deepEqual([field({ phone: "" }).field, field({ phone: "" }).error], ["phone", "Enter your phone number."]);
  for (const phone of ["555-010", "12345", "phone me", "416.555.0100", "+1 416 555 0100 ext 4", "1".repeat(21), "<b>4165550100</b>"]) {
    assert.equal(field({ phone }).field, "phone", phone);
  }
  for (const phone of ["5550100", "416-555-0100", "+44 20 7946 0958", "(416) 555 0100", "1".repeat(20)]) assert.equal(field({ phone }).ok, true, phone);
  assert.equal(field({ consent: false }).field, "consent");
  assert.equal(field({ consent: undefined }).field, "consent");
  assert.equal(field({ consent: "true" }).ok, true);
  assert.equal(field({ source: "fax" }).value.source, "website");
  assert.equal(field({ source: "WebApp" }).value.source, "webapp");
  assert.deepEqual(field({ interests: "delegation,sponsorship" }).value.interests, ["sponsorship", "delegation"]);
  assert.deepEqual(field({ interests: undefined }).value.interests, []);
  assert.equal(validateSignup(null).field, "email");
  assert.deepEqual(cleanInterests(["DELEGATION", "exhibitor"]), ["exhibitor", "delegation"]);
  assert.equal(phoneDigits("+1 (416) 555-0100"), "14165550100");
  assert.equal(telHref("+1 (416) 555-0100"), "tel:+14165550100");
  assert.equal(telHref("416 555 0100"), "tel:4165550100");
});

test("ipHash: the same address gives the same value; never the address itself", () => {
  const a = ipHash("203.0.113.9", "secret");
  assert.equal(a, ipHash("203.0.113.9", "secret"));
  assert.notEqual(a, ipHash("203.0.113.10", "secret"));
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.ok(!a.includes("203"));
  assert.equal(ipHash(""), "");
});

test("WAITLIST_INBOX: default enquire@, comma-separated override", () => {
  assert.deepEqual(waitlistInbox({}), ["enquire@thetechfestival.com"]);
  assert.deepEqual(waitlistInbox({ WAITLIST_INBOX: "a@example.com, b@example.com" }), ["a@example.com", "b@example.com"]);
  assert.deepEqual(waitlistInbox({ WAITLIST_INBOX: "not an email" }), ["enquire@thetechfestival.com"]);
});

/* ---------- the team's email ---------- */

test("the team's subject: interests, or Attending; a repeat ends (updated)", () => {
  assert.equal(alertSubject({ email: "jane@acme.example", interests: ["exhibitor", "sponsorship"] }), "TTFC 2027 waitlist: Sponsorship + Exhibitor interest – jane@acme.example");
  assert.equal(alertSubject({ email: "jane@acme.example", interests: [] }), "TTFC 2027 waitlist: Attending – jane@acme.example");
  assert.equal(alertSubject({ email: "jane@acme.example", interests: ["delegation"], updated: true }), "TTFC 2027 waitlist: Delegation interest – jane@acme.example (updated)");
  assert.equal(alertSubject({ email: "a@b.example", interests: INTERESTS }), "TTFC 2027 waitlist: Sponsorship + Exhibitor + Delegation interest – a@b.example");
});

test("the team's email: email, phone as a tel: link, interests, source, Toronto time; escaped; reply-to the person; no app block", () => {
  const row = {
    email: "jane@acme.example", phone: "+1 (416) 555-0100", interests: ["sponsorship"], lastInterests: ["sponsorship"], source: "android", sources: ["android"],
    count: 1, createdAt: new Date("2026-10-23T18:05:00Z"), lastSubmittedAt: new Date("2026-10-23T18:05:00Z"),
  };
  const e = buildWaitlistAlert(row, { adminUrl: "https://www.example.test/admin/waitlist-2027" });
  assert.equal(e.subject, "TTFC 2027 waitlist: Sponsorship interest – jane@acme.example");
  assert.equal(e.replyTo, "jane@acme.example");
  assert.match(e.html, /<a href="tel:\+14165550100"[^>]*>\+1 \(416\) 555-0100<\/a>/);
  assert.match(e.html, /<a href="mailto:jane@acme\.example"/);
  assert.match(e.text, /Phone: \+1 \(416\) 555-0100/);
  assert.match(e.text, /Interested in: Sponsorship/);
  assert.match(e.text, /Signed up from: Android app/);
  assert.match(e.text, /Time: Oct 23, 2026, 2:05 p\.m\. \(Toronto\)/);
  assert.match(e.html, /href="https:\/\/www\.example\.test\/admin\/waitlist-2027"/);
  assert.doesNotMatch(`${e.html}\n${e.text}`, /Get the TTFC app|GET THE TTFC APP|apps\.apple\.com|play\.google\.com/);
  assert.doesNotMatch(e.text, /First signed up/);

  const upd = buildWaitlistAlert({ ...row, interests: ["sponsorship", "delegation"], lastInterests: ["delegation"], source: "website", sources: ["android", "website"], count: 3 }, { updated: true });
  assert.equal(upd.subject, "TTFC 2027 waitlist: Sponsorship + Delegation interest – jane@acme.example (updated)");
  assert.match(upd.text, /Ticked this time: Delegation/);
  assert.match(upd.text, /Signed up from: Website \(also: Android app\)/);
  assert.match(upd.text, /Sign-ups from this address: 3/);
  assert.match(upd.text, /First signed up: Oct 23, 2026/);

  const none = buildWaitlistAlert({ ...row, interests: [], lastInterests: [] });
  assert.match(none.text, /Interested in: Attending \(nothing ticked\)/);
  // Whatever someone types is escaped (the phone can't carry HTML past validation, but the builder doesn't rely on it).
  const nasty = buildWaitlistAlert({ ...row, phone: "<script>x</script>" });
  assert.doesNotMatch(nasty.html, /<script>/);
});

test("confirmDue: the first time, then only a day after the last one", () => {
  const now = new Date("2026-10-24T12:00:00Z");
  assert.equal(confirmDue({}, now), true);
  assert.equal(confirmDue({ confirmedAt: null }, now), true);
  assert.equal(confirmDue({ confirmedAt: new Date(now - CONFIRM_EVERY_MS + 60_000) }, now), false);
  assert.equal(confirmDue({ confirmedAt: new Date(now - CONFIRM_EVERY_MS) }, now), true);
});

/* ---------- the admin list ---------- */

test("admin list: filter by interest (or attending), source and search; rows; counts; CSV with formulas neutralised", () => {
  assert.deepEqual(waitlistFilter({ interest: "sponsorship" }), { interests: "sponsorship" });
  assert.deepEqual(waitlistFilter({ interest: "attending" }), { interests: { $size: 0 } });
  assert.deepEqual(waitlistFilter({ interest: "golf", source: "fax" }), {});
  assert.deepEqual(waitlistFilter({ source: "ios" }), { sources: "ios" });
  assert.deepEqual(waitlistFilter({ q: "Jane.D" }).$or, [{ email: { $regex: "jane\\.d", $options: "i" } }]);
  assert.equal(waitlistFilter({ q: "416 555" }).$or[1].phoneDigits.$regex, "416555");
  const d = { _id: "a1", email: "jane@acme.example", phone: "416-555-0100", interests: ["exhibitor"], source: "website", sources: ["website", "ios"], count: 2, createdAt: new Date("2026-10-23T18:00:00Z") };
  const r = waitlistRow(d);
  assert.deepEqual([r.interestLabels, r.tel, r.count, r.sources], [["Exhibitor"], "tel:4165550100", 2, ["website", "ios"]]);
  assert.deepEqual(waitlistCounts({ total: 5, attending: 2, byInterest: [{ _id: "sponsorship", n: 3 }, { _id: "golf", n: 9 }], bySource: [{ _id: "ios", n: 1 }] }),
    { total: 5, attending: 2, sponsorship: 3, exhibitor: 0, delegation: 0, website: 0, webapp: 0, ios: 1, android: 0 });
  const csv = waitlistCsv([d, { ...d, _id: "a2", email: "=cmd@x.example", interests: [] }]);
  const lines = csv.replace(/^﻿/, "").split("\n");
  assert.equal(lines[0], "Signed up (Toronto),Last sign-up (Toronto),Email,Phone,Sponsorship,Exhibitor,Delegation,Interested in,Signed up from,Sign-ups,Team emailed,Confirmation email");
  assert.match(lines[1], /jane@acme\.example,416-555-0100,No,Yes,No,Exhibitor,"Website, iOS app",2,,$/);
  assert.match(lines[2], /,'=cmd@x\.example,/);
  assert.match(lines[2], /,Attending,/);
});

/* ---------- the person's confirmation ---------- */

test("the confirmation: the subject, their ticks in the page's words (or Attending), the next step, the page link, the app block, unsubscribe", () => {
  const e = buildWaitlistEmail({ interests: ["delegation", "sponsorship"], unsubscribeUrl: "https://api.example.test/api/unsubscribe?t=x" });
  assert.equal(e.subject, "You're on the TTFC 2027 waitlist");
  assert.equal(e.link, PAGE_URL);
  assert.equal(PAGE_URL, "https://www.thetechfestival.com/stay-updated");
  assert.match(e.html, />You&#39;re on the TTFC 2027 waitlist\.</);
  assert.match(e.html, /Thank you for your interest in TTFC 2027: one-day briefings in Vancouver, Montreal, Calgary, Toronto and Ottawa, then The Tech Festival Canada, two days in Toronto in November 2027\. Dates to be announced for every event\./);
  assert.ok(e.html.indexOf(">Sponsorship<") < e.html.indexOf(">Bringing a delegation<"), "both ticks, in order");
  assert.match(e.html, />Someone from our team will reach out\.</);
  assert.match(e.html, /href="https:\/\/www\.thetechfestival\.com\/stay-updated"/);
  assert.match(e.html, /href="https:\/\/api\.example\.test\/api\/unsubscribe\?t=x"[^>]*>Unsubscribe from TTFC emails</);
  assert.match(e.text, /WHAT YOU ASKED ABOUT\n  • Sponsorship\n  • Bringing a delegation\n\nSomeone from our team will reach out\./);
  assert.match(e.text, /See what's coming in 2027: https:\/\/www\.thetechfestival\.com\/stay-updated/);
  assert.match(e.text, /Unsubscribe: https:\/\/api\.example\.test\/api\/unsubscribe\?t=x/);
  assert.doesNotMatch(e.html + e.text, /2026|Westin/, "nothing about the 2026 event's dates or venue");
  assert.deepEqual(askedAbout([]), [ATTENDING]);
  assert.match(buildWaitlistEmail({ interests: [] }).text, /WHAT YOU ASKED ABOUT\n  • Attending TTFC 2027/);
  // Staff's wording (escaped), and a renamed tick.
  const custom = buildWaitlistEmail({ interests: ["exhibitor"], copy: { "stay.email_subject": "Thanks <3", "stay.email_next": "We'll call you.", "stay.interest_exhibitor": "A booth", "stay.email_intro": "" } });
  assert.equal(custom.subject, "Thanks <3");
  assert.match(custom.html, /<title>Thanks &lt;3<\/title>/);
  assert.match(custom.html, />A booth</);
  assert.match(custom.html, />We&#39;ll call you\.</);
  assert.match(custom.html, /Dates to be announced for every event/, "an empty field uses the default");
  // The sender's postal address (MAIL_POSTAL_ADDRESS, as in the campaign footer), escaped; "Toronto" without one.
  const addr = buildWaitlistEmail({ postal: "Example Org <Inc>, 1 Example St, Toronto, ON" });
  assert.match(addr.html, /The Tech Festival Canada &middot; Example Org &lt;Inc&gt;, 1 Example St, Toronto, ON &middot;/);
  assert.match(addr.text, /The Tech Festival Canada · Example Org <Inc>, 1 Example St, Toronto, ON · https:\/\/www\.thetechfestival\.com/);
  assert.match(buildWaitlistEmail({ postal: "" }).text, /The Tech Festival Canada · Toronto · /);
});

test("sending the confirmation: from and reply-to enquire@, the logo inline, one-click unsubscribe headers, tagged", async () => {
  process.env.JWT_SECRET ||= "local-test-only";
  const sent = [];
  const client = { emails: { send: async (m) => { sent.push(m); return { data: { id: "em_1" } }; } } };
  const r = await sendWaitlistEmail({ to: "jane@acme.example", interests: ["exhibitor"], client });
  assert.equal(r.id, "em_1");
  const m = sent[0];
  assert.equal(m.from, "The Tech Festival Canada <enquire@thetechfestival.com>");
  assert.equal(m.reply_to, ENQUIRE_EMAIL);
  assert.equal(m.to, "jane@acme.example");
  assert.equal(m.subject, "You're on the TTFC 2027 waitlist");
  assert.deepEqual(m.tags, [{ name: "campaign", value: WAITLIST_CAMPAIGN }]);
  assert.equal(m.attachments[0].content_id, "ttfc-logo");
  assert.match(m.html, /src="cid:ttfc-logo"/);
  assert.match(m.headers["List-Unsubscribe"], /^<https:\/\/[^>]+\/api\/unsubscribe\?t=[^>]+>, <mailto:enquire@thetechfestival\.com\?subject=unsubscribe>$/);
  assert.equal(m.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  // A preview: the data: logo and the preview unsubscribe page, no one-click header.
  const p = waitlistEmailFor({ interests: [] }, { inline: true });
  assert.match(p.html, /src="data:image\/png;base64,/);
  assert.match(p.html, /\/api\/unsubscribe\/preview/);
  assert.equal(p.headers["List-Unsubscribe-Post"], undefined);
  await assert.rejects(sendWaitlistEmail({ to: "a@b.example", client: { emails: { send: async () => ({ error: { message: "nope" } }) } } }), /nope/);
});

/* ---------- the handler (fakes) ---------- */

function fakeRes() {
  const res = { statusCode: 0, body: null, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; res.headersSent = true; return res; };
  return res;
}

function setup({ saveFails = false, alertFails = false, confirmFails = false, unsubscribed = [], copy = STAY_DEFAULTS, gate = null, clock = () => new Date("2026-10-24T12:00:00Z") } = {}) {
  const rows = new Map();
  const alerts = [];
  const confirmations = [];
  const jobs = [];
  let id = 0;
  const store = {
    async upsert(v, meta) {
      if (saveFails) throw new Error("db down");
      const r = rows.get(v.email);
      if (r) {
        Object.assign(r, { phone: v.phone, lastInterests: v.interests, source: v.source, lastSubmittedAt: meta.at, ipHash: meta.ipHash, userAgent: meta.userAgent });
        r.interests = INTERESTS.filter((k) => r.interests.includes(k) || v.interests.includes(k));
        r.sources = [...new Set([...r.sources, v.source])];
        r.count += 1;
        return { row: { ...r }, first: false };
      }
      const row = { _id: `r${++id}`, ...v, lastInterests: v.interests, sources: [v.source], count: 1, createdAt: meta.at, lastSubmittedAt: meta.at, confirmedAt: null, ipHash: meta.ipHash, userAgent: meta.userAgent };
      rows.set(v.email, row);
      return { row: { ...row }, first: true };
    },
    async setAlert(rid, set) { Object.assign([...rows.values()].find((r) => r._id === rid), set); },
    async claimConfirmation(rid, before, at) {
      const r = [...rows.values()].find((x) => x._id === rid);
      if (r.confirmedAt && r.confirmedAt > before) return null;
      const was = { ...r };
      r.confirmedAt = at; r.confirmStatus = "sending";
      return was;
    },
    async setConfirm(rid, set) { Object.assign([...rows.values()].find((r) => r._id === rid), set); },
  };
  const handler = makeWaitlistHandler({
    store,
    sendAlert: async (m) => { if (gate) await gate; if (alertFails) throw new Error("resend down"); alerts.push(m); return { id: `al${alerts.length}` }; },
    sendConfirmation: async (m) => { if (gate) await gate; if (confirmFails) throw new Error("resend down"); confirmations.push(m); return { id: `cf${confirmations.length}` }; },
    isUnsubscribed: async (e) => unsubscribed.includes(e),
    loadCopy: async () => copy,
    env: { WAITLIST_INBOX: "team@example.com" },
    ipLimiter: makeLimiter({ max: 300, windowMs: 60_000 }),
    emailLimiter: makeLimiter({ max: 5, windowMs: 60_000 }),
    now: clock,
    background: (p) => jobs.push(p),
    log: { error() {} },
  });
  const call = async (body, ip = "198.51.100.7") => {
    const res = fakeRes();
    await handler({ body, ip, headers: { "user-agent": `Mozilla/5.0 ${"x".repeat(300)}` } }, res);
    return res;
  };
  const settle = () => Promise.all(jobs.splice(0));
  return { call, settle, rows, alerts, confirmations };
}

test("a first sign-up: 200 with the thank-you, then the team's email and the person's confirmation", async () => {
  const t = setup();
  const r = await t.call({ ...GOOD });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { ok: true, message: "Thank you for your interest. Someone from our team will reach out." });
  await t.settle();
  assert.equal(t.alerts.length, 1);
  assert.deepEqual(t.alerts[0].to, ["team@example.com"]);
  assert.equal(t.alerts[0].subject, "TTFC 2027 waitlist: Sponsorship + Exhibitor interest – jane@acme.example");
  assert.equal(t.alerts[0].replyTo, "jane@acme.example");
  assert.deepEqual(t.confirmations, [{ to: "jane@acme.example", interests: ["sponsorship", "exhibitor"], copy: STAY_DEFAULTS }]);
  const row = t.rows.get("jane@acme.example");
  assert.deepEqual([row.alertStatus, row.confirmStatus, row.count], ["sent", "sent", 1]);
  assert.match(row.ipHash, /^[0-9a-f]{32}$/);
  assert.equal(row.userAgent.length, 160);
});

test("the answer never waits for the emails", async () => {
  let open;
  const gate = new Promise((ok) => { open = ok; });
  const t = setup({ gate });
  const r = await t.call({ ...GOOD });
  assert.equal(r.statusCode, 200, "answered while both emails are still on their way");
  assert.equal(t.alerts.length + t.confirmations.length, 0);
  open();
  await t.settle();
  assert.equal(t.alerts.length, 1);
  assert.equal(t.confirmations.length, 1);
});

test("a repeat: the team gets (updated); the person isn't emailed again within a day, then is", async () => {
  let now = new Date("2026-10-24T12:00:00Z");
  const t = setup({ clock: () => now });
  await t.call({ ...GOOD, interests: [] }); await t.settle();
  assert.equal(t.alerts[0].subject, "TTFC 2027 waitlist: Attending – jane@acme.example");
  now = new Date(now.getTime() + 60 * 60 * 1000);
  const r = await t.call({ ...GOOD, interests: ["delegation"], source: "webapp" });
  assert.deepEqual(r.body, { ok: true, message: DEFAULT_MESSAGE }, "the same answer: nobody learns who is on the list");
  await t.settle();
  assert.equal(t.alerts[1].subject, "TTFC 2027 waitlist: Delegation interest – jane@acme.example (updated)");
  assert.equal(t.confirmations.length, 1, "not again within a day");
  now = new Date(now.getTime() + CONFIRM_EVERY_MS);
  await t.call({ ...GOOD, interests: ["sponsorship"] }); await t.settle();
  assert.equal(t.confirmations.length, 2, "again after a day");
  assert.deepEqual(t.confirmations[1].interests, ["sponsorship", "delegation"]);
  assert.equal(t.rows.get("jane@acme.example").count, 3);
});

test("someone on the unsubscribe list: the team is told, the person isn't emailed", async () => {
  const t = setup({ unsubscribed: ["jane@acme.example"] });
  const r = await t.call({ ...GOOD });
  assert.equal(r.statusCode, 200);
  await t.settle();
  assert.equal(t.alerts.length, 1);
  assert.equal(t.confirmations.length, 0);
  assert.equal(t.rows.get("jane@acme.example").confirmStatus, "unsubscribed");
});

test("a failed confirmation can go on the next sign-up; a failed team email is recorded", async () => {
  const t = setup({ confirmFails: true, alertFails: true });
  await t.call({ ...GOOD }); await t.settle();
  const row = t.rows.get("jane@acme.example");
  assert.deepEqual([row.alertStatus, row.confirmStatus, row.confirmedAt], ["failed", "failed", null]);
  assert.match(row.alertError, /resend down/);
});

test("staff's thank-you text is the answer", async () => {
  const t = setup({ copy: { ...STAY_DEFAULTS, "stay.thanks": "Thanks! We'll be in touch soon." } });
  assert.equal((await t.call({ ...GOOD })).body.message, "Thanks! We'll be in touch soon.");
});

test("bad input: 400 with the field and plain words; nothing saved or sent", async () => {
  const t = setup();
  const r = await t.call({ ...GOOD, phone: "call me" });
  assert.equal(r.statusCode, 400);
  assert.deepEqual(r.body, { ok: false, field: "phone", error: "That phone number doesn't look right. Use digits, with + ( ) - or spaces if you like." });
  await t.settle();
  assert.equal(t.rows.size + t.alerts.length + t.confirmations.length, 0);
});

test("the honeypot: the same answer as a person, nothing saved or sent", async () => {
  const t = setup();
  const r = await t.call({ ...GOOD, _hp: "http://spam.example" });
  assert.deepEqual([r.statusCode, r.body.ok], [200, true]);
  await t.settle();
  assert.equal(t.rows.size + t.alerts.length + t.confirmations.length, 0);
});

test("limits: 5 an hour per email (429, plain words); a venue's shared address is not one person", async () => {
  const t = setup();
  for (let i = 0; i < 5; i++) assert.equal((await t.call({ ...GOOD }, `10.0.0.${i}`)).statusCode, 200);
  const r = await t.call({ ...GOOD }, "10.0.0.99");
  assert.deepEqual([r.statusCode, r.body], [429, { ok: false, error: TOO_MANY }]);
  // Many people on one address (the venue's Wi-Fi): fine.
  for (let i = 0; i < 40; i++) assert.equal((await t.call({ ...GOOD, email: `p${i}@acme.example` }, "10.9.9.9")).statusCode, 200);
  await t.settle();
});

test("the save fails: the team's email is the only copy, so it's waited for; both failing is a 500", async () => {
  const t = setup({ saveFails: true });
  const r = await t.call({ ...GOOD });
  assert.equal(r.statusCode, 200);
  assert.equal(t.alerts.length, 1, "sent before answering");
  assert.equal(t.confirmations.length, 0, "no row to count the person's email by");
  const t2 = setup({ saveFails: true, alertFails: true });
  const r2 = await t2.call({ ...GOOD });
  assert.deepEqual([r2.statusCode, r2.body], [500, { ok: false, error: FAILED }]);
});
