/* Email engagement (Oct 19 2026): the signed tokens, what each email carries (real sends only), the rows
   per person in People (filters, counts, profile), the nudge leaving out confirmed posters, and the RSVP
   lookup telling about a form open without changing its answer. No database, no network: Resend is a
   fake client, the store is a fake. Fictional people, example.com. */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  TRACK_TOKEN_MAX, isTrackTokenShape, openPixelUrl, pixelHtml, pixelUrlFor, signTrack, trackSecret, verifyTrack, withPixel,
} from "../services/trackToken.js";
import {
  CAMPAIGNS, ENGAGEMENT_KINDS, OPENS_NOTE, RSVP_EMAIL_LABELS, UNATTRIBUTED_POSTS, attendingEngagementOf, engagementIndex, engagementKey,
  engagementUpdate, rsvpEngagementOf, trackedUpdate,
} from "../services/engagement.js";
import { passEmailPixel, recordEngagement, trackLater } from "../services/engagementStore.js";
import { CAMPAIGN_KEY, SAMPLE_RECIPIENT, attendingLink } from "../services/attendingCampaign.js";
import { attendingEmailFor, buildAttendingEmail, sendAttendingEmail } from "../services/attendingEmail.js";
import { REMINDER_CAMPAIGN, SAMPLE_REMINDER, buildRsvpReminderEmail, reminderEmailFor, sendRsvpReminder } from "../services/rsvpReminder.js";
import { buildPassEmail } from "../services/passEmail.js";
import { buildPeople, filterPeople, peopleCounts, personDetail, personRow } from "../services/people.js";
import { planAttendingNudges } from "../services/attendingNudge.js";
import { makeRsvpHandlers } from "../services/rsvpHandler.js";
import { makeOpenPixel, PIXEL_GIF } from "../routes/engagement.js";

const SECRET = "test-only-secret";
const OTHER = "another-secret";
process.env.TRACKING_SECRET = SECRET;
process.env.API_URL = "https://api.example.test";

/* ---------- tokens ---------- */

test("tokens: sign and verify round trip, short enough for a link, ours only", () => {
  const t = signTrack({ c: "attending-2026", e: " Jane.Doe@Example.com " }, SECRET);
  assert.ok(isTrackTokenShape(t));
  assert.ok(t.length < 120, `${t.length} characters`);
  assert.deepEqual(verifyTrack(t, SECRET), { c: "attending-2026", e: "jane.doe@example.com", t: "" });
  const withTicket = signTrack({ c: "issued-pass-2026", e: "a@example.com", t: "TECHFEST:INF 4000 01" }, SECRET);
  assert.deepEqual(verifyTrack(withTicket, SECRET), { c: "issued-pass-2026", e: "a@example.com", t: "inf400001" });
  assert.deepEqual(verifyTrack(signTrack({ c: "rsvp-form", t: "ABC123" }, SECRET), SECRET), { c: "rsvp-form", e: "", t: "abc123" });
  // The same payload always signs the same (the link and the pixel can share one).
  assert.equal(signTrack({ c: "attending-2026", e: "jane.doe@example.com" }, SECRET), t);
});

test("tokens: tampering, another secret, no secret, junk", () => {
  const t = signTrack({ c: "attending-2026", e: "jane@example.com" }, SECRET);
  const [body, sig] = t.split(".");
  // Someone else's address with the old signature.
  const forged = `${Buffer.from(JSON.stringify({ c: "attending-2026", e: "mallory@example.com" })).toString("base64url")}.${sig}`;
  assert.equal(verifyTrack(forged, SECRET), null);
  // One character of the signature changed.
  assert.equal(verifyTrack(`${body}.${sig.slice(0, -1)}${sig.at(-1) === "A" ? "B" : "A"}`, SECRET), null);
  // A valid signature over a body that isn't a payload we'd sign.
  const sign = (b) => crypto.createHmac("sha256", SECRET).update(`ttfc-track:v1:${b}`).digest().subarray(0, 16).toString("base64url");
  const noWho = Buffer.from(JSON.stringify({ c: "attending-2026" })).toString("base64url");
  assert.equal(verifyTrack(`${noWho}.${sign(noWho)}`, SECRET), null);
  const notJson = Buffer.from("not json at all").toString("base64url");
  assert.equal(verifyTrack(`${notJson}.${sign(notJson)}`, SECRET), null);
  // Another key, or none.
  assert.equal(verifyTrack(t, OTHER), null);
  assert.equal(verifyTrack(t, ""), null);
  assert.equal(signTrack({ c: "attending-2026", e: "jane@example.com" }, ""), "");
  for (const junk of [null, undefined, 42, {}, "", "abc", `${body}.`, `.${sig}`, `${body}.${sig}.x`, "x".repeat(500)]) assert.equal(verifyTrack(junk, SECRET), null);
  // Nothing to say who it is, a bad campaign, or too long for a link: not signed.
  assert.equal(signTrack({ c: "attending-2026" }, SECRET), "");
  assert.equal(signTrack({ c: "Attending 2026!", e: "jane@example.com" }, SECRET), "");
  assert.equal(signTrack({ c: "attending-2026", e: "not-an-email" }, SECRET), "");
  assert.equal(signTrack({ c: "attending-2026", e: `${"x".repeat(240)}@example.com`, t: "t".repeat(60) }, SECRET), "");
  assert.ok(TRACK_TOKEN_MAX <= 400);
});

test("tokens: TRACKING_SECRET, else JWT_SECRET, else nothing", () => {
  assert.equal(trackSecret({ TRACKING_SECRET: "a", JWT_SECRET: "b" }), "a");
  assert.equal(trackSecret({ JWT_SECRET: "b" }), "b");
  assert.equal(trackSecret({}), "");
  assert.equal(openPixelUrl({ c: "attending-2026", e: "jane@example.com" }, { secret: "" }), "");
  assert.match(openPixelUrl({ c: "attending-2026", e: "jane@example.com" }, { base: "https://api.example.test", secret: SECRET }),
    /^https:\/\/api\.example\.test\/api\/t\/o\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}\.gif$/);
  assert.equal(pixelUrlFor(""), "");
});

test("pixel html: one hidden 1×1 image before </body>, nothing without a source", () => {
  const html = "<html><body><p>Hi</p></body></html>";
  assert.equal(withPixel(html, ""), html);
  assert.equal(pixelHtml(""), "");
  const out = withPixel(html, "https://api.example.test/api/t/o/a.b.gif?x=1&y=2");
  assert.match(out, /<img src="https:\/\/api\.example\.test\/api\/t\/o\/a\.b\.gif\?x=1&amp;y=2" width="1" height="1" alt=""[^>]*>\n<\/body><\/html>$/);
  assert.equal(withPixel("<p>no body</p>", "https://x.test/p.gif").endsWith('opacity:0;">'), true);
});

/* ---------- what each email carries ---------- */

const PIXEL = /<img src="https:\/\/api\.example\.test\/api\/t\/o\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22})\.gif"/;

test("I'm attending email: a real send carries their token in the link and the pixel; previews and test sends don't", async () => {
  const preview = attendingEmailFor(SAMPLE_RECIPIENT, { inline: true });
  assert.equal(preview.tracked, false);
  assert.doesNotMatch(preview.html, /\/api\/t\/o\//);
  assert.doesNotMatch(preview.link, /[#&]r=/);
  // Even asked to, an inline (preview) render has no token.
  assert.equal(attendingEmailFor(SAMPLE_RECIPIENT, { inline: true, track: "jane@example.com" }).tracked, false);

  const real = attendingEmailFor({ firstName: "Jane", lastName: "Doe" }, { inline: false, track: "jane@example.com" });
  assert.equal(real.tracked, true);
  const token = PIXEL.exec(real.html)?.[1];
  assert.ok(token, "pixel in the html");
  assert.deepEqual(verifyTrack(token), { c: CAMPAIGN_KEY, e: "jane@example.com", t: "" });
  assert.equal(real.link, `https://www.thetechfestival.com/attending#fn=Jane&ln=Doe&r=${token}`);
  assert.ok(real.html.includes(`href="https://www.thetechfestival.com/attending#fn=Jane&amp;ln=Doe&amp;r=${token}"`));
  assert.ok(real.text.includes(real.link));
  // Without a token the email is exactly what it was.
  assert.equal(buildAttendingEmail({ firstName: "Jane" }).html, buildAttendingEmail({ firstName: "Jane", pixelSrc: "" }).html);
  assert.equal(attendingLink({ firstName: "Jane", r: "not a token" }), "https://www.thetechfestival.com/attending#fn=Jane");

  const sent = [];
  const noted = [];
  const client = { emails: { send: async (msg) => { sent.push(msg); return { data: { id: `re_${sent.length}` }, error: null }; } } };
  await sendAttendingEmail({ to: "jane@example.com", recipient: SAMPLE_RECIPIENT, subjectPrefix: "[Test] ", client, noteTracked: (k) => noted.push(k) });
  assert.doesNotMatch(sent[0].html, /\/api\/t\/o\//);
  assert.doesNotMatch(sent[0].html, /[#&;]r=/);
  assert.deepEqual(noted, []);
  await sendAttendingEmail({ to: "Jane@Example.com", recipient: SAMPLE_RECIPIENT, client, track: true, noteTracked: (k) => noted.push(k) });
  assert.match(sent[1].html, PIXEL);
  assert.deepEqual(noted, [{ campaign: "attending-2026", email: "jane@example.com", ticketId: "" }]);
});

test("RSVP reminder: the pixel only on a real send; the RSVP links stay as they were", async () => {
  const preview = reminderEmailFor(SAMPLE_REMINDER, { inline: true });
  assert.doesNotMatch(preview.html, /\/api\/t\/o\//);
  const real = reminderEmailFor(SAMPLE_REMINDER, { inline: false, track: "jane@example.com" });
  assert.equal(real.tracked, true);
  assert.deepEqual(verifyTrack(PIXEL.exec(real.html)[1]), { c: REMINDER_CAMPAIGN, e: "jane@example.com", t: "" });
  assert.deepEqual(real.links, preview.links);
  assert.equal(buildRsvpReminderEmail(SAMPLE_REMINDER).html, buildRsvpReminderEmail({ ...SAMPLE_REMINDER, pixelSrc: "" }).html);

  const sent = [];
  const noted = [];
  const client = { emails: { send: async (msg) => { sent.push(msg); return { data: { id: "re_1" }, error: null }; } } };
  await sendRsvpReminder({ to: "jane@example.com", row: SAMPLE_REMINDER, subjectPrefix: "[Test] ", client, noteTracked: (k) => noted.push(k) });
  assert.doesNotMatch(sent[0].html, /\/api\/t\/o\//);
  await sendRsvpReminder({ to: "jane@example.com", row: SAMPLE_REMINDER, client, track: true, noteTracked: (k) => noted.push(k) });
  assert.match(sent[1].html, PIXEL);
  assert.deepEqual(noted, [{ campaign: REMINDER_CAMPAIGN, email: "jane@example.com", ticketId: "" }]);
});

test("pass emails: a pixel only with the RSVP button and no cc (a cc'd copy would count as their open)", () => {
  const a = passEmailPixel({ campaign: CAMPAIGNS.issuedPass, email: "Ana@Example.com", ticketId: "TECHFEST:INF400001" });
  assert.deepEqual(a.key, { campaign: "issued-pass-2026", email: "ana@example.com", ticketId: "inf400001" });
  assert.deepEqual(verifyTrack(/\/api\/t\/o\/(.+)\.gif$/.exec(a.pixel)[1]), { c: "issued-pass-2026", e: "ana@example.com", t: "inf400001" });
  assert.deepEqual(passEmailPixel({ campaign: CAMPAIGNS.issuedPass, email: "ana@example.com", ticketId: "INF400001", cc: ["staff@example.com"] }), { pixel: "", key: null });
  assert.deepEqual(passEmailPixel({ campaign: CAMPAIGNS.exhibitorPass, email: "ana@example.com", ticketId: "CON1", rsvp: false }), { pixel: "", key: null });
  assert.deepEqual(passEmailPixel({ campaign: CAMPAIGNS.speakerPass, email: "ana@example.com", ticketId: "" }), { pixel: "", key: null });
  const pass = { name: "Ana Able", ticketId: "INF400001" };
  const plain = buildPassEmail(pass);
  assert.equal(buildPassEmail({ ...pass, pixelSrc: "" }).html, plain.html);
  const tracked = buildPassEmail({ ...pass, pixelSrc: a.pixel });
  assert.equal(tracked.html.replace(/<img src="https:\/\/api\.example\.test\/api\/t\/o\/[^"]+"[^>]*>\n/, ""), plain.html);
  assert.equal(tracked.text, plain.text);
});

/* ---------- rows ---------- */

test("engagementKey: one row per address for the attending and reminder emails, per pass for pass emails, per ticket for the form", () => {
  assert.equal(CAMPAIGNS.attending, CAMPAIGN_KEY);
  assert.equal(CAMPAIGNS.rsvpReminder, REMINDER_CAMPAIGN);
  assert.deepEqual(engagementKey({ c: "attending-2026", e: " A@B.co ", t: "X1" }), { campaign: "attending-2026", email: "a@b.co", ticketId: "" });
  assert.deepEqual(engagementKey({ c: "issued-pass-2026", e: "a@b.co", t: "TECHFEST:X1" }), { campaign: "issued-pass-2026", email: "a@b.co", ticketId: "x1" });
  assert.deepEqual(engagementKey({ c: "rsvp-form", e: "a@b.co", t: "X1" }), { campaign: "rsvp-form", email: "", ticketId: "x1" });
  assert.equal(engagementKey({ c: "rsvp-form", e: "a@b.co" }), null);
  assert.equal(engagementKey({ c: "attending-2026" }), null);
  assert.equal(engagementKey({ c: "$where", e: "a@b.co" }), null);
  assert.deepEqual(UNATTRIBUTED_POSTS, { campaign: "attending-2026", email: "", ticketId: "" });
});

test("engagementUpdate: a counter and its first / last time; a post keeps only a real LinkedIn post link", () => {
  const at = new Date("2026-10-19T15:00:00Z");
  assert.deepEqual(ENGAGEMENT_KINDS, ["open", "visit", "post", "share", "manual"]);
  assert.deepEqual(engagementUpdate("open", { at }), { $inc: { opens: 1 }, $min: { firstOpenAt: at }, $max: { lastOpenAt: at } });
  assert.deepEqual(engagementUpdate("visit", { at }), { $inc: { visits: 1 }, $min: { firstVisitAt: at }, $max: { lastVisitAt: at } });
  const url = "https://www.linkedin.com/feed/update/urn:li:share:7123/";
  assert.deepEqual(engagementUpdate("post", { at, postUrl: url }), { $inc: { posts: 1 }, $min: { postedAt: at }, $max: { lastPostedAt: at }, $set: { postUrl: url } });
  assert.equal(engagementUpdate("post", { at, postUrl: "https://evil.example/" }).$set, undefined);
  assert.equal(engagementUpdate("delete", { at }), null);
  assert.deepEqual(trackedUpdate(at), { $inc: { trackedSends: 1 }, $max: { trackedAt: at } });
});

test("recordEngagement: upserts the row, adds to it when two raced, never throws", async () => {
  const calls = [];
  let raced = true;
  const model = {
    async updateOne(filter, update, opts) {
      calls.push([filter, Object.keys(update), opts?.upsert || false]);
      if (opts?.upsert && raced) { raced = false; throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 }); }
      return { matchedCount: 1 };
    },
  };
  const key = engagementKey({ c: "attending-2026", e: "jane@example.com" });
  assert.equal(await recordEngagement(key, "open", {}, { model }), true);
  assert.deepEqual(calls.map((c) => c[2]), [true, false]);
  assert.deepEqual(calls[0][0], { campaign: "attending-2026", email: "jane@example.com", ticketId: "" });
  const broken = { async updateOne() { throw new Error("db down"); } };
  const logged = [];
  assert.equal(await recordEngagement(key, "open", {}, { model: broken, log: { error: (...a) => logged.push(a.join(" ")) } }), false);
  assert.match(logged[0], /ENGAGEMENT RECORD ERROR: open attending-2026 db down/);
  assert.equal(await recordEngagement(null, "open", {}, { model }), false);
  assert.equal(await recordEngagement(key, "nope", {}, { model }), false);
  // trackLater returns straight away and swallows everything.
  assert.equal(trackLater(key, "open", {}, { model: broken, log: { error() {} } }), undefined);
  assert.equal(trackLater(null, "open"), undefined);
});

test("the open pixel: always the GIF, never cached; recorded only for our tokens, a few times per token", () => {
  const recorded = [];
  let n = 0;
  const handler = makeOpenPixel({ record: (key, kind) => recorded.push([key, kind]), perToken: { hit: () => ++n <= 2 } });
  const res = () => ({ headers: {}, set(h) { Object.assign(this.headers, h); return this; }, status(c) { this.code = c; return this; }, end(b) { this.body = b; } });
  const good = signTrack({ c: "attending-2026", e: "jane@example.com" });
  for (const [file, method] of [[`${good}.gif`, "GET"], [`${good}.gif`, "HEAD"], ["junk.gif", "GET"], [`${good}`, "GET"],
    [`${signTrack({ c: "attending-2026", e: "jane@example.com" }, OTHER)}.gif`, "GET"], [`${good}.gif`, "GET"], [`${good}.gif`, "GET"]]) {
    const r = res();
    handler({ method, params: { file } }, r);
    assert.equal(r.code, 200);
    assert.equal(r.body, PIXEL_GIF);
    assert.equal(r.headers["Content-Type"], "image/gif");
    assert.match(r.headers["Cache-Control"], /no-store/);
  }
  // GET with our token: 3 times, the per-token limit lets 2 through. HEAD, junk, no .gif and another key's: none.
  assert.deepEqual(recorded, [
    [{ campaign: "attending-2026", email: "jane@example.com", ticketId: "" }, "open"],
    [{ campaign: "attending-2026", email: "jane@example.com", ticketId: "" }, "open"],
  ]);
  assert.equal(PIXEL_GIF.subarray(0, 6).toString(), "GIF89a");
});

/* ---------- People ---------- */

const D = (s) => new Date(`2026-10-${s}Z`);
const users = [
  { _id: "u1", name: "Ana Able", email: "ana@example.com", tickets: [{ ticketId: "con100000001", type: "connect", purchaseDate: D("01T10:00:00") }] },
  { _id: "u2", name: "Ben Bee", email: "ben@example.com", tickets: [{ ticketId: "inf100000001", type: "influence", purchaseDate: D("02T10:00:00") }] },
  { _id: "u3", name: "Cy Sea", email: "cy@example.com", tickets: [{ ticketId: "pow100000001", type: "power", purchaseDate: D("03T10:00:00") }] },
  { _id: "u4", name: "Di Dee", email: "di@example.com", tickets: [{ ticketId: "apx100000001", type: "apex", purchaseDate: D("04T10:00:00") }] },
];
const attendees = [
  { _id: "a1", name: "Eve Issued", email: "eve@example.com", ticketId: "ISS100000001", ticketType: "influence", promoCode: "ISSUED",
    passEmailSentAt: D("18T10:00:00"), passEmailRsvp: true, details: { firstName: "Eve", lastName: "Issued" } },
];
const attending = ["ana", "ben", "cy", "di"].map((n) => ({ email: `${n}@example.com`, status: "sent", sentAt: D("19T09:00:00"), sends: 0 }));
const rsvps = [{ _id: "r1", key: "t:pow100000001", ticketId: "POW100000001", ticketVerified: true, firstName: "Cy", lastName: "Sea", name: "Cy Sea",
  nameKey: "cy sea", source: "attendee", attendeeSubmittedAt: D("19T12:00:00"), days: ["day1"], options: [], createdAt: D("19T12:00:00"), updatedAt: D("19T12:00:00") }];
const reminders = [{ email: "ben@example.com", sentAt: D("19T08:00:00") }, { email: "di@example.com", sentAt: D("19T08:00:00") }];
const engagement = [
  // Ana: opened twice, visited, posted (confirmed).
  { campaign: "attending-2026", email: "ana@example.com", ticketId: "", opens: 2, firstOpenAt: D("19T10:00:00"), lastOpenAt: D("19T18:00:00"),
    visits: 1, firstVisitAt: D("19T10:01:00"), lastVisitAt: D("19T10:01:00"), posts: 1, postedAt: D("19T10:05:00"), lastPostedAt: D("19T10:05:00"),
    postUrl: "https://www.linkedin.com/feed/update/urn:li:share:7001/", trackedAt: D("19T09:00:00") },
  // Ben: opened the attending email only; the RSVP reminder went with the pixel and wasn't opened, but he opened the form.
  { campaign: "attending-2026", email: "ben@example.com", ticketId: "", opens: 1, firstOpenAt: D("19T11:00:00"), lastOpenAt: D("19T11:00:00"), trackedAt: D("19T09:00:00") },
  { campaign: "rsvp-reminder-2026", email: "ben@example.com", ticketId: "", opens: 0, trackedAt: D("19T08:00:00") },
  { campaign: "rsvp-form", email: "", ticketId: "inf100000001", visits: 2, firstVisitAt: D("19T12:00:00"), lastVisitAt: D("19T15:00:00") },
  // Cy: shared from his phone (not confirmed); the form opened and RSVP'd.
  { campaign: "attending-2026", email: "cy@example.com", ticketId: "", visits: 1, firstVisitAt: D("19T10:00:00"), shares: 1, sharedAt: D("19T10:02:00"), trackedAt: D("19T09:00:00") },
  { campaign: "rsvp-form", email: "", ticketId: "pow100000001", visits: 1, firstVisitAt: D("19T11:59:00"), lastVisitAt: D("19T11:59:00") },
  // Di: the RSVP reminder opened; nothing recorded for the attending email (sent before tracking).
  { campaign: "rsvp-reminder-2026", email: "di@example.com", ticketId: "", opens: 1, firstOpenAt: D("19T13:00:00"), lastOpenAt: D("19T13:00:00"), trackedAt: D("19T08:00:00") },
  // Eve's issued pass email opened (by ticket).
  { campaign: "issued-pass-2026", email: "eve@example.com", ticketId: "iss100000001", opens: 3, firstOpenAt: D("18T11:00:00"), lastOpenAt: D("19T07:00:00"), trackedAt: D("18T10:00:00") },
  // Two posts from links without a token.
  { campaign: "attending-2026", email: "", ticketId: "", posts: 2, postedAt: D("19T09:30:00") },
];

const world = () => buildPeople({ users, attendees, rsvps, attending, reminders, engagement });
const names = (list) => list.map((p) => p.name).sort();

test("People: each person's furthest step on the I'm attending page and their RSVP email / form", () => {
  const { people, unattributedPosts } = world();
  const by = (n) => people.find((p) => p.name === n);
  assert.equal(unattributedPosts, 2);
  assert.deepEqual(personRow(by("Ana Able")).engagement.attending, {
    stage: "posted", stageLabel: "Posted on LinkedIn", tracked: true, postedAt: D("19T10:05:00"), postUrl: "https://www.linkedin.com/feed/update/urn:li:share:7001/",
  });
  // The send status stays as it was.
  assert.deepEqual(personRow(by("Ana Able")).attending, { status: "sent", label: "Sent", sentAt: D("19T09:00:00"), nudges: 0 });
  assert.equal(personRow(by("Ben Bee")).engagement.attending.stage, "opened");
  assert.equal(personRow(by("Cy Sea")).engagement.attending.stageLabel, "Shared from phone");
  assert.deepEqual(personRow(by("Di Dee")).engagement.attending, { stage: "", stageLabel: "", tracked: false, postedAt: null, postUrl: "" });
  assert.deepEqual(personRow(by("Ben Bee")).engagement.rsvp, {
    emailOpened: false, lastOpenAt: null, tracked: true, formOpened: true, formOpens: 2, lastFormAt: D("19T15:00:00"),
  });
  const eve = personDetail(by("Eve Issued")).engagement;
  assert.deepEqual([eve.rsvp.emailOpened, eve.rsvp.opens, eve.rsvp.openedVia, eve.rsvp.firstOpenAt], [true, 3, ["Pass email"], D("18T11:00:00")]);
  assert.equal(eve.note, OPENS_NOTE);
  const ana = personDetail(by("Ana Able")).engagement.attending;
  assert.deepEqual([ana.opens, ana.firstOpenAt, ana.lastOpenAt, ana.visits, ana.posts], [2, D("19T10:00:00"), D("19T18:00:00"), 1, 1]);
  assert.deepEqual(personDetail(by("Di Dee")).engagement.rsvp.openedVia, [RSVP_EMAIL_LABELS["rsvp-reminder-2026"]]);
});

test("People filters: the engagement values of I'm Attending, RSVP Email Sent? and RSVP Status", () => {
  const { people } = world();
  const f = (q) => names(filterPeople(people, q));
  assert.deepEqual(f({ attending: "yes" }), ["Ana Able", "Ben Bee", "Cy Sea", "Di Dee"]);
  assert.deepEqual(f({ attending: "no" }), ["Eve Issued"]);
  assert.deepEqual(f({ attending: "opened" }), ["Ana Able", "Ben Bee", "Cy Sea"]);
  assert.deepEqual(f({ attending: "visited" }), ["Ana Able", "Cy Sea"]);
  assert.deepEqual(f({ attending: "posted" }), ["Ana Able"]);
  assert.deepEqual(f({ attending: "maybe" }), ["Cy Sea"]);
  assert.deepEqual(f({ attending: "noPost" }), ["Ben Bee"]);
  assert.deepEqual(f({ rsvpEmail: "yes" }), ["Ben Bee", "Di Dee", "Eve Issued"]);
  assert.deepEqual(f({ rsvpEmail: "opened" }), ["Di Dee", "Eve Issued"]);
  assert.deepEqual(f({ rsvpEmail: "unopened" }), ["Ben Bee"]);
  assert.deepEqual(f({ rsvp: "form" }), ["Ben Bee"]); // Cy opened it and RSVP'd
  assert.deepEqual(f({ rsvp: "form", attending: "noPost" }), ["Ben Bee"]);
  // Unknown values change nothing, as before.
  assert.equal(filterPeople(people, { attending: "bogus" }).length, people.length);
});

test("People counts: people (not events) at each step, plus the posts nobody could be named for", () => {
  const { people } = world();
  const c = peopleCounts(people);
  assert.deepEqual(
    [c.attendingSent, c.attendingOpened, c.attendingVisited, c.attendingPosted, c.attendingMaybe, c.rsvpEmailOpened, c.rsvpFormOpened, c.rsvpFormNotSent, c.byRsvp.attendee],
    [4, 3, 2, 1, 1, 2, 2, 1, 1],
  );
  assert.equal(engagementIndex(engagement).unattributedPosts, 2);
});

test("engagement per person: every address and ticket of theirs, the earliest first time, the newest post link", () => {
  const idx = engagementIndex([
    { campaign: "attending-2026", email: "a@example.com", opens: 1, firstOpenAt: D("19T10:00:00"), lastOpenAt: D("19T10:00:00"), posts: 1,
      postedAt: D("19T10:00:00"), lastPostedAt: D("19T10:00:00"), postUrl: "https://www.linkedin.com/feed/update/urn:li:share:1/" },
    { campaign: "attending-2026", email: "a.work@example.com", opens: 2, firstOpenAt: D("18T10:00:00"), lastOpenAt: D("20T10:00:00"), posts: 1,
      postedAt: D("20T09:00:00"), lastPostedAt: D("20T09:00:00"), postUrl: "https://www.linkedin.com/feed/update/urn:li:share:2/" },
    { campaign: "speaker-pass-2026", email: "someone.else@example.com", ticketId: "spk1", opens: 1, trackedAt: D("19T00:00:00") },
    { campaign: "speaker-pass-2026", email: "a@example.com", ticketId: "not-theirs", opens: 5 },
  ]);
  const a = attendingEngagementOf(["A@example.com", "a.work@example.com", ""], idx);
  assert.deepEqual([a.opens, a.firstOpenAt, a.lastOpenAt, a.posts, a.postUrl], [3, D("18T10:00:00"), D("20T10:00:00"), 2, "https://www.linkedin.com/feed/update/urn:li:share:2/"]);
  // A pass email counts for whoever holds that pass, not for whoever's address it went to.
  const r = rsvpEngagementOf({ emails: ["a@example.com"], tickets: ["SPK1"] }, idx);
  assert.deepEqual([r.emailOpened, r.opens, r.openedVia, r.tracked], [true, 1, ["Speaker Pass email"], true]);
  assert.deepEqual(attendingEngagementOf([], idx).stage, "");
});

test("LinkedIn nudge: confirmed posters (from the directory's rows) are left out", () => {
  const { people } = world();
  const plan = planAttendingNudges(people, { sends: [], now: Date.now() });
  assert.deepEqual(plan.skipped.filter((s) => s.reason === "posted").map((s) => s.name), ["Ana Able"]);
  assert.ok(plan.targets.some((t) => t.email === "cy@example.com"), "a phone share can't be confirmed: still nudged");
});

/* ---------- the RSVP form ---------- */

test("RSVP lookup: a verified ticket tells onFormOpen, after answering, with the same answer as without it", async () => {
  const fakeRes = () => ({ statusCode: 200, headersSent: false, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } });
  const lookup = async (q) => (/^abc123def$/i.test(q.ticketId) && q.lastName === "Doe"
    ? { kind: "ticket", tier: "power", verified: true, displayName: q.firstName, ticket: { ticketId: "ABC123DEF", type: "power" }, cxoBreakfast: false, extras: {} }
    : { kind: "none", verified: false, ticket: null });
  const store = { findByKey: async () => null, findByNameKey: async () => [] };
  const opened = [];
  const withHook = makeRsvpHandlers({ lookup, store, log: { error() {} }, onFormOpen: (id, ip) => opened.push([id, ip]) });
  const plain = makeRsvpHandlers({ lookup, store, log: { error() {} } });
  const throwing = makeRsvpHandlers({ lookup, store, log: { error() {} }, onFormOpen: () => { throw new Error("db down"); } });
  const run = async (h, body) => { const res = fakeRes(); await h.lookup({ body, ip: "9.9.9.9" }, res); return res; };
  const body = { firstName: "Jane", lastName: "Doe", ticketId: "ABC123DEF" };
  const a = await run(withHook, body);
  const b = await run(plain, body);
  const c = await run(throwing, body);
  assert.deepEqual(a.body, b.body);
  assert.deepEqual(c.body, b.body);
  assert.equal(a.body.ticketMatched, true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(opened, [["ABC123DEF", "9.9.9.9"]]);
  // No verified ticket: nothing to tell.
  await run(withHook, { firstName: "Jane", lastName: "Smith", ticketId: "ABC123DEF" });
  await new Promise((r) => setImmediate(r));
  assert.equal(opened.length, 1);
});
