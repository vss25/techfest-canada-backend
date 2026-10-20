import test from "node:test";
import assert from "node:assert/strict";
import {
  APP_INVITE_CAMPAIGN, APP_URL, PLAY_STORE_URL, SKIP_LABELS, appInviteLink, appStoreUrl, inviteStats, planAppInvites, rolesOf, usesApp,
} from "../services/appInvite.js";
import {
  DEFAULT_COPY, DEFAULT_OPTIONS, FIELDS, SECTIONS, changedWording, cleanCopy, cleanOptions, effectiveCopy, fillInvite, templateCopy, templateSet, wordingToSave,
} from "../services/appInviteCopy.js";
import { ENQUIRE_EMAIL, FROM, appInviteEmailFor, buildAppInviteEmail, sendAppInviteEmail } from "../services/appInviteEmail.js";
import { makeAppVisit } from "../routes/engagement.js";
import { engagementKey, CAMPAIGNS } from "../services/engagement.js";
import { signTrack, verifyTrack } from "../services/trackToken.js";

/* The app invite email (Oct 20 2026, the organiser: "send emails to all people associated with the event to
   download the web app … allow customization as usual … sent from enquire"). Fictional people, example.com. */

process.env.TRACKING_SECRET ||= "app-invite-test-secret";

test("wording: every field has a section and built-in text; staff's text is cleaned, defaults aren't stored", () => {
  for (const f of FIELDS) {
    assert.ok(SECTIONS.some((s) => s.key === f.section), f.key);
    assert.ok(DEFAULT_COPY[f.key] !== undefined, `default for ${f.key}`);
  }
  assert.equal(DEFAULT_COPY.button, "Open the TTFC app");
  assert.deepEqual(DEFAULT_OPTIONS, { play: true, appStore: true });
  // Unknown keys ignored, one-line fields squashed, lists trimmed.
  assert.deepEqual(cleanCopy({ subject: "  Hi\nthere  ", nope: "x", features: ["  A ", "", "B"] }), { subject: "Hi there", features: ["A", "B"] });
  // The built-in value again is no change (it keeps following the built-in text).
  assert.deepEqual(wordingToSave({ subject: DEFAULT_COPY.subject, button: "Open the app", features: [...DEFAULT_COPY.features] }), { button: "Open the app" });
  assert.deepEqual(cleanOptions({ play: false, appStore: "yes", other: true }), { play: false });
  // The template row: subject in its column, the rest and the switches in `fields`.
  const set = templateSet({ subject: "S", heading: "H" }, { play: false }, "Mia");
  assert.deepEqual(set, { subject: "S", headline: "", message: "", fields: { heading: "H", options: { play: false, appStore: true } }, updatedBy: "Mia" });
  assert.deepEqual(templateCopy({ subject: set.subject, fields: set.fields }), { copy: { subject: "S", heading: "H" }, options: { play: false, appStore: true } });
  assert.deepEqual(templateCopy(null), { copy: {}, options: { play: true, appStore: true } });
  assert.deepEqual(changedWording({ copy: { subject: "S" }, options: { play: true } }, { copy: { heading: "H" }, options: { play: false } }), ["subject reset", "heading", "play off"]);
  assert.equal(effectiveCopy({ heading: "Mine" }).heading, "Mine");
  assert.equal(effectiveCopy({}).heading, DEFAULT_COPY.heading);
  assert.equal(fillInvite("Hi {firstName}, use {email}", { firstName: "Jane", email: "j@example.com" }), "Hi Jane, use j@example.com");
  assert.equal(fillInvite("Hi {firstName},", {}), "Hi there,");
});

test("the email: greeting, why, the big button to the web app, home-screen steps, the sign-in address, escaped", () => {
  const e = buildAppInviteEmail({ firstName: "Jane", email: "jane.doe@example.com" });
  assert.equal(e.subject, "Your TTFC 2026 app is ready");
  assert.match(e.html, /Hi Jane,/);
  for (const f of DEFAULT_COPY.features) assert.ok(e.html.includes(f.replace(/&/g, "&amp;")), f);
  assert.match(e.html, /href="https:\/\/www\.thetechfestival\.com\/app\/"/);
  assert.match(e.html, />Open the TTFC app</);
  assert.match(e.html, /Add it to your home screen/);
  assert.match(e.html, /Tap Add to Home Screen, then Add\./);
  assert.match(e.html, /Tap Install app/);
  assert.match(e.html, /Sign in with this email: jane\.doe@example\.com/);
  assert.match(e.html, /prefers-color-scheme: light/);          // the light version for mail apps that ask
  assert.doesNotMatch(e.html, /\/api\/t\/o\//);                  // no pixel without a real send
  assert.equal(e.link, APP_URL);
  // Plain text: the link and every step.
  assert.match(e.text, /Open the TTFC app:\nhttps:\/\/www\.thetechfestival\.com\/app\//);
  assert.match(e.text, /iPhone:\n {2}1\. Open the link in Safari\./);
  assert.match(e.text, /Sign in with this email: jane\.doe@example\.com/);
  // No name: "Hi there,". Staff's text is plain text, never HTML.
  assert.match(buildAppInviteEmail({ email: "x@example.com" }).html, /Hi there,/);
  const evil = buildAppInviteEmail({ copy: { heading: "<script>alert(1)</script>", features: ["<b>bold</b>"] }, firstName: "<i>J</i>" });
  assert.doesNotMatch(evil.html, /<script>alert|<b>bold<\/b>|<i>J<\/i>/);
  assert.match(evil.html, /&lt;script&gt;/);
});

test("optional lines: Google Play on by default; the App Store line only with its switch on and the iPhone app's link set", () => {
  const base = { firstName: "Jane", email: "jane@example.com" };
  const on = buildAppInviteEmail({ ...base, storeUrl: "" });
  assert.ok(on.html.includes(PLAY_STORE_URL));
  assert.match(on.text, /Prefer the Android app\? Get it on Google Play: https:\/\/play\.google\.com/);
  assert.doesNotMatch(on.html, /App Store/);
  const off = buildAppInviteEmail({ ...base, options: { play: false }, storeUrl: "" });
  assert.ok(!off.html.includes(PLAY_STORE_URL));
  const store = "https://apps.apple.com/ca/app/id6820764803";
  assert.ok(buildAppInviteEmail({ ...base, storeUrl: store }).html.includes(store));
  assert.ok(!buildAppInviteEmail({ ...base, storeUrl: store, options: { appStore: false } }).html.includes(store));
  // The server's setting: only an apps.apple.com link counts; none today.
  assert.equal(appStoreUrl({}), "");
  assert.equal(appStoreUrl({ APP_STORE_URL: store }), store);
  assert.equal(appStoreUrl({ APP_STORE_URL: "https://evil.example.com/app" }), "");
});

test("who it goes to: everyone with a pass or a role, one per address, with the reasons it doesn't", () => {
  const pass = (tier = "power", extra = {}) => ({ ticketId: `t-${Math.random()}`, tier, label: "Power Pass", hidden: false, ...extra });
  const person = (id, extra = {}) => ({ id, name: `${id} Example`, firstName: id, email: `${id.toLowerCase()}@example.com`, types: [], passList: [], user: null, ...extra });
  const people = [
    person("Ana", { passList: [pass()] }),                                                   // a pass
    person("Sol", { speaker: { name: "Sol" }, types: ["speaker"] }),                          // speaker, no pass yet
    person("Sam", { user: { role: "admin" } }),                                               // staff account
    person("Val", { user: { role: "volunteer" } }),                                           // volunteer
    person("Max", { types: ["media"] }),                                                      // media
    person("Vic", { vip: true }),                                                             // VIP
    person("Eve", { types: ["exhibitor"], passList: [pass("connect")] }),                     // exhibitor
    person("Ida", { user: { role: "user" } }),                                                // an account, no pass or role
    person("Rae"),                                                                            // an RSVP only
    person("Bob", { passList: [pass("power", { ticketId: "BOOTH-GOLD" })] }),                // a booth order only
    person("Hid", { passList: [pass("power", { hidden: true })] }),                          // hidden by staff
    person("Pia", { email: "x1@ticket.thetechfestival.com", passList: [pass()] }),           // pass-ID placeholder
    person("Noe", { email: "", passList: [pass()] }),                                         // no email
    person("Ban", { passList: [pass()], user: { role: "user", banned: true } }),             // suspended
    person("Uns", { passList: [pass()] }),                                                    // unsubscribed
    person("App", { passList: [pass()], user: { role: "user", lastActiveAt: new Date("2026-10-18") } }), // uses the app
    person("Onb", { passList: [pass()], user: { role: "user", appOnboarded: true } }),        // uses the app
    person("Dup", { email: "ana@example.com", passList: [pass()] }),                         // the same address as Ana
    person("Snt", { passList: [pass()] }),                                                    // already sent
    person("Ing", { passList: [pass()] }),                                                    // unconfirmed
    person("Fal", { passList: [pass()] }),                                                    // failed: retried
  ];
  const sends = [
    { email: "snt@example.com", status: "sent", sentAt: new Date("2026-10-19T10:00:00Z") },
    { email: "ing@example.com", status: "sending" },
    { email: "fal@example.com", status: "failed", error: "Resend said no" },
  ];
  const p = planAppInvites(people, { optedOut: ["UNS@example.com"], sends });
  const by = Object.fromEntries(p.rows.map((r) => [r.name.split(" ")[0], r.reason || "yes"]));
  assert.deepEqual(by, {
    Ana: "yes", Sol: "yes", Sam: "yes", Val: "yes", Max: "yes", Vic: "yes", Eve: "yes",
    Pia: "placeholder", Noe: "noEmail", Ban: "banned", Uns: "unsubscribed", App: "usingApp", Onb: "usingApp",
    Dup: "duplicate", Snt: "alreadySent", Ing: "sending", Fal: "yes",
  });
  assert.ok(!("Ida" in by) && !("Rae" in by) && !("Bob" in by) && !("Hid" in by));
  assert.deepEqual(p.rows.find((r) => r.name.startsWith("Sol")).roles, ["Speaker"]);
  assert.deepEqual(rolesOf(people[6]), ["Connect Pass", "Exhibitor"]);
  assert.equal(p.rows.find((r) => r.name.startsWith("App")).label, SKIP_LABELS.usingApp);
  assert.deepEqual([p.counts.people, p.counts.usingApp, p.counts.willGet], [14, 2, 8]); // usable addresses (no placeholder, no empty, no duplicate)
  // The switch off: people using the app get it too.
  assert.equal(planAppInvites(people, { optedOut: ["uns@example.com"], sends, skipUsing: false }).counts.willGet, 10);
  // Retry failures only.
  assert.deepEqual(planAppInvites(people, { sends, mode: "failed" }).targets.map((r) => r.email), ["fal@example.com"]);
  // One person: a cool-down after the last send, not "already sent"; using the app doesn't stop it.
  const now = new Date("2026-10-20T10:00:00Z").getTime();
  const one = (name, s, extra = {}) => planAppInvites([person(name, { passList: [pass()], ...extra })], { sends: s, mode: "one", now }).rows[0];
  assert.equal(one("Snt", sends).reason, "recent");
  assert.equal(one("Snt", [{ email: "snt@example.com", status: "sent", sentAt: new Date("2026-10-15") }]).willGet, true);
  assert.equal(one("App", [], { user: { lastActiveAt: new Date() } }).willGet, true);
  assert.equal(usesApp(null), false);
});

test("stats: sent, opened, clicked the button, now using the app (signed in after the email)", () => {
  const person = (id, user) => ({ id, name: id, firstName: id, email: `${id}@example.com`, types: [], passList: [{ ticketId: id, tier: "power", label: "Power Pass" }], user });
  const sentAt = new Date("2026-10-19T10:00:00Z");
  const people = [person("a", { lastActiveAt: new Date("2026-10-19T12:00:00Z") }), person("b", { lastActiveAt: new Date("2026-10-18") }), person("c", null), person("d", null)];
  const sends = ["a", "b", "c"].map((x) => ({ email: `${x}@example.com`, status: "sent", sentAt }));
  const engagement = [
    { campaign: APP_INVITE_CAMPAIGN, email: "a@example.com", opens: 2, visits: 1 },
    { campaign: APP_INVITE_CAMPAIGN, email: "c@example.com", opens: 1, visits: 0 },
    { campaign: "attending-2026", email: "b@example.com", opens: 5, visits: 5 },
  ];
  const p = planAppInvites(people, { sends, engagement, skipUsing: false });
  assert.deepEqual(inviteStats(p.rows), { sent: 3, opened: 2, clicked: 1, usingAfter: 1, failed: 0, unconfirmed: 0 });
});

test("a real send: from and reply-to enquire@, List-Unsubscribe, the tracked button and pixel; a test send has neither", async () => {
  const calls = [];
  const client = { emails: { send: async (m) => { calls.push(m); return { data: { id: `re_${calls.length}` }, error: null }; } } };
  const noted = [];
  await sendAppInviteEmail({ to: "Jane.Doe@example.com", person: { firstName: "Jane" }, client, track: true, noteTracked: (k) => noted.push(k) });
  const m = calls[0];
  assert.equal(FROM, "The Tech Festival Canada <enquire@thetechfestival.com>");
  assert.deepEqual([m.from, m.reply_to, m.headers["List-Unsubscribe"]], [FROM, ENQUIRE_EMAIL, "<mailto:enquire@thetechfestival.com?subject=unsubscribe>"]);
  assert.deepEqual(m.tags, [{ name: "campaign", value: APP_INVITE_CAMPAIGN }]);
  assert.deepEqual(m.attachments.map((a) => a.content_id), ["ttfc-logo", "ttfc-logo-dark"]);
  const token = /href="https:\/\/www\.thetechfestival\.com\/app\/#r=([^"]+)"/.exec(m.html)?.[1];
  assert.ok(token, "the button carries their token");
  assert.deepEqual(verifyTrack(token), { c: APP_INVITE_CAMPAIGN, e: "jane.doe@example.com", t: "" });
  assert.ok(m.html.includes(`/api/t/o/${token}.gif`));
  assert.ok(m.text.includes(`/app/#r=${token}`));
  assert.match(m.html, /Sign in with this email: Jane\.Doe@example\.com/);
  assert.deepEqual(noted, [{ campaign: APP_INVITE_CAMPAIGN, email: "jane.doe@example.com", ticketId: "" }]);
  // A test: "[Test] ", no token, no pixel, nothing noted.
  await sendAppInviteEmail({ to: "staff@example.com", person: { firstName: "Jane" }, client, subjectPrefix: "[Test] ", noteTracked: (k) => noted.push(k) });
  assert.equal(calls[1].subject, "[Test] Your TTFC 2026 app is ready");
  assert.doesNotMatch(calls[1].html, /#r=|\/api\/t\/o\//);
  assert.equal(noted.length, 1);
  // Resend refusing it throws (recorded as failed by the sender).
  const no = { emails: { send: async () => ({ data: null, error: { message: "rate limited" } }) } };
  await assert.rejects(sendAppInviteEmail({ to: "a@example.com", person: {}, client: no }), /rate limited/);
  // Previews: inline images, never a token.
  const prev = appInviteEmailFor({ firstName: "Jane", email: "jane@example.com" });
  assert.match(prev.html, /data:image\/png;base64/);
  assert.equal(prev.tracked, false);
  assert.equal(appInviteLink(""), APP_URL);
  assert.equal(appInviteLink("not a token"), APP_URL);
});

test("POST /api/t/v: a visit for the app invite's token; other campaigns, bad tokens and floods are ignored", () => {
  const recorded = [];
  const visit = makeAppVisit({ record: (k, kind) => recorded.push([k, kind]) });
  const res = () => { const r = { code: 0, set() { return r; }, status(c) { r.code = c; return r; }, end() { return r; }, json() { return r; } }; return r; };
  const good = signTrack({ c: APP_INVITE_CAMPAIGN, e: "jane@example.com" });
  assert.equal(visit({ ip: "1", body: { r: good } }, res()).code, 204);
  assert.deepEqual(recorded, [[{ campaign: APP_INVITE_CAMPAIGN, email: "jane@example.com", ticketId: "" }, "visit"]]);
  visit({ ip: "1", body: { r: signTrack({ c: "attending-2026", e: "jane@example.com" }) } }, res());
  visit({ ip: "1", body: { r: `${good.slice(0, -2)}xx` } }, res());
  visit({ ip: "1", body: {} }, res());
  assert.equal(recorded.length, 1);
  // One row per address for this campaign.
  assert.deepEqual(engagementKey({ c: CAMPAIGNS.appInvite, e: "A@Example.com", t: "abc" }), { campaign: APP_INVITE_CAMPAIGN, email: "a@example.com", ticketId: "" });
});
