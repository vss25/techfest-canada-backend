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
import { verifyUnsubscribe } from "../services/unsubscribe.js";

/* The app invite email (Oct 20 2026, the organiser: "send emails to all people associated with the event to
   download the web app … allow customization as usual … sent from enquire"). Fictional people, example.com. */

process.env.TRACKING_SECRET ||= "app-invite-test-secret";

test("wording: every field has a section and built-in text; staff's text is cleaned, defaults aren't stored", () => {
  for (const f of FIELDS) {
    assert.ok(SECTIONS.some((s) => s.key === f.section), f.key);
    assert.ok(DEFAULT_COPY[f.key] !== undefined, `default for ${f.key}`);
  }
  assert.equal(DEFAULT_COPY.button, "Open the web app");
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

test("the email: greeting, why, the App Store and Google Play buttons first, the web app link, the sign-in address, escaped", () => {
  const e = buildAppInviteEmail({ firstName: "Jane", email: "jane.doe@example.com" });
  assert.equal(e.subject, "Your TTFC 2026 app is ready");
  assert.match(e.html, /Hi Jane,/);
  for (const f of DEFAULT_COPY.features) assert.ok(e.html.includes(f.replace(/&/g, "&amp;")), f);
  // Oct 22–23 2026: the store apps are the call to action: "Get the TTFC app", why, and two official-style badges.
  assert.match(e.html, />Get the TTFC app</);
  assert.match(e.html, />Your pass, the schedule, live polls and messages, all on your phone\.</);
  const links = (href) => (e.html.match(new RegExp(`<a href="${href.replace(/[.?]/g, "\\$&")}" target="_blank"`, "g")) || []).length;
  assert.equal(links("https://apps.apple.com/ca/app/the-tech-festival-canada/id6820764803"), 2, "the App Store badge: logo and words are links");
  assert.equal(links(PLAY_STORE_URL), 2, "the Google Play badge: logo and words are links");
  // Black, a grey edge, both exactly 200 × 58, stacking on a phone.
  assert.equal((e.html.match(/<table role="presentation" class="sbt" width="200" height="58" cellpadding="0" cellspacing="0" border="0" bgcolor="#000000" style="width:200px;height:58px;margin:0 auto;background:#000000;border:1px solid #a6a6a6;border-radius:12px;/g) || []).length, 2);
  assert.match(e.html, /\.sb \{ display:block !important; width:100% !important;/);
  // The words are live text (the stores' own), the logos small PNGs on the website with alt text; no SVG, no gradient.
  assert.match(e.html, />Download on the<\/span><span[^>]*>App Store<\/span>/);
  assert.match(e.html, />GET IT ON<\/span><span[^>]*>Google Play<\/span>/);
  assert.match(e.html, /<img src="https:\/\/www\.thetechfestival\.com\/email\/store-apple@2x\.png" width="28" height="28" alt="Apple"/);
  assert.match(e.html, /<img src="https:\/\/www\.thetechfestival\.com\/email\/store-play@2x\.png" width="28" height="28" alt="Play"/);
  const cta = e.html.slice(e.html.indexOf("<!-- The main call to action"), e.html.indexOf("<!-- Signing in -->"));
  assert.doesNotMatch(cta, /<svg|gradient/i);
  assert.ok(cta.indexOf("store-apple") < cta.indexOf("store-play"), "App Store first");
  assert.match(cta, />Free on iPhone and Android\.</);
  assert.ok(e.html.indexOf(">Get the TTFC app<") < e.html.indexOf(">Open the web app</a>"), "the stores before the web app");
  // The web app is a small secondary link (no big button) and nothing tells anyone to add it to the home screen.
  assert.match(e.html, /<div class="mut" style="[^"]*font-size:12px;[^"]*">Rather not download anything\? Use TTFC in your phone&#39;s browser: <a href="https:\/\/www\.thetechfestival\.com\/app\/"[^>]*>Open the web app<\/a>/);
  assert.doesNotMatch(e.html, /class="btn"/);
  assert.doesNotMatch(e.html, /home screen|Home Screen|Add to Home|Safari|Install app|nothing to download/i);
  assert.match(e.preheader, /Free on the App Store and Google Play\.$/);
  assert.match(e.html, /Download it free on the App Store or Google Play\./);
  assert.match(e.html, /Sign in with this email: jane\.doe@example\.com/);
  assert.match(e.html, /prefers-color-scheme: light/);          // the light version for mail apps that ask
  assert.doesNotMatch(e.html, /\/api\/t\/o\//);                  // no pixel without a real send
  assert.equal(e.link, APP_URL);
  // Plain text: both store links, clearly, then the web app's.
  assert.ok(e.text.includes([
    "GET THE TTFC APP",
    "Your pass, the schedule, live polls and messages, all on your phone.",
    "",
    "  iPhone (App Store): https://apps.apple.com/ca/app/the-tech-festival-canada/id6820764803",
    "  Android (Google Play): https://play.google.com/store/apps/details?id=com.atlaslinkmarkets.ttfc",
    "",
    "Free on iPhone and Android.",
    "",
    "Rather not download anything? Use TTFC in your phone's browser:",
    "Open the web app: https://www.thetechfestival.com/app/",
  ].join("\n")), e.text);
  assert.doesNotMatch(e.text, /home screen|Add to Home|Safari/i);
  assert.match(e.text, /Sign in with this email: jane\.doe@example\.com/);
  // Old saved wording for the removed home-screen section is ignored.
  const old = buildAppInviteEmail({ copy: { homeTitle: "Add it to your home screen", iphoneSteps: ["Tap Share"], playText: "Prefer the Android app?" } });
  assert.doesNotMatch(old.html + old.text, /Add it to your home screen|Tap Share|Prefer the Android app/);
  // No name: "Hi there,". Staff's text is plain text, never HTML.
  assert.match(buildAppInviteEmail({ email: "x@example.com" }).html, /Hi there,/);
  const evil = buildAppInviteEmail({ copy: { heading: "<script>alert(1)</script>", features: ["<b>bold</b>"], storesTitle: "<i>x</i>" }, firstName: "<i>J</i>" });
  assert.doesNotMatch(evil.html, /<script>alert|<b>bold<\/b>|<i>J<\/i>|<i>x<\/i>/);
  assert.match(evil.html, /&lt;script&gt;/);
});

test("the badges' switches: both on by default; the App Store one only with its link; neither = the web app's big button", () => {
  const base = { firstName: "Jane", email: "jane@example.com" };
  const store = "https://apps.apple.com/ca/app/the-tech-festival-canada/id6820764803";
  const both = buildAppInviteEmail(base);
  assert.ok(both.html.includes(store) && both.html.includes(PLAY_STORE_URL));
  // No App Store link (APP_STORE_URL unusable): Google Play alone, still 200 wide.
  const noIos = buildAppInviteEmail({ ...base, storeUrl: "" });
  assert.ok(noIos.html.includes(PLAY_STORE_URL));
  assert.doesNotMatch(noIos.html, />App Store<|store-apple/);
  assert.doesNotMatch(noIos.text, /App Store\):/);
  assert.equal((noIos.html.match(/class="sbt" width="200" height="58"/g) || []).length, 1);
  // Switched off one at a time.
  const noPlay = buildAppInviteEmail({ ...base, options: { play: false } });
  assert.ok(noPlay.html.includes(store) && !noPlay.html.includes(PLAY_STORE_URL));
  assert.ok(!buildAppInviteEmail({ ...base, options: { appStore: false } }).html.includes(store));
  // Both off: the web app is the big button again, no panel.
  const none = buildAppInviteEmail({ ...base, options: { play: false, appStore: false } });
  assert.ok(!none.html.includes(store) && !none.html.includes(PLAY_STORE_URL));
  assert.doesNotMatch(none.html, />Get the TTFC app<|class="cta"/);
  assert.match(none.html, /class="btn"[\s\S]*>Open the web app</);
  assert.match(none.text, /Open the web app:\nhttps:\/\/www\.thetechfestival\.com\/app\//);
  // Staff's words around the badges (the badges' own words are the stores').
  const words = buildAppInviteEmail({ ...base, copy: { storesTitle: "Download TTFC", storesIntro: "It's free.", buttonNote: "Works offline too." } });
  assert.match(words.html, />Download TTFC<[\s\S]*>It&#39;s free\.<[\s\S]*>Download on the<[\s\S]*>Works offline too\.</);
  // The server's setting: only an apps.apple.com link counts; the live listing by default.
  assert.equal(appStoreUrl({}), store);
  assert.equal(appStoreUrl({ APP_STORE_URL: "https://apps.apple.com/us/app/id6820764803" }), "https://apps.apple.com/us/app/id6820764803");
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
  assert.deepEqual([m.from, m.reply_to], [FROM, ENQUIRE_EMAIL]);
  // One-click unsubscribe (RFC 8058): their own signed https link first, the mailto second; the same link in the footer.
  const unsub = /^<(https:\/\/[^>]+\/api\/unsubscribe\?t=([^>]+))>, <mailto:enquire@thetechfestival\.com\?subject=unsubscribe>$/.exec(m.headers["List-Unsubscribe"]);
  assert.ok(unsub, m.headers["List-Unsubscribe"]);
  assert.equal(verifyUnsubscribe(unsub[2]), "jane.doe@example.com");
  assert.equal(m.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.ok(m.html.includes(`href="${unsub[1]}"`) && m.html.includes("Unsubscribe from TTFC emails"));
  assert.ok(m.text.includes(`Unsubscribe from TTFC emails: ${unsub[1]}`));
  assert.doesNotMatch(m.text, /Reply with "unsubscribe"/);
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
  // …and no personal unsubscribe link: the preview page and the mailto only (a test can't unsubscribe anyone).
  assert.equal(calls[1].headers["List-Unsubscribe"], "<mailto:enquire@thetechfestival.com?subject=unsubscribe>");
  assert.equal(calls[1].headers["List-Unsubscribe-Post"], undefined);
  assert.match(calls[1].html, /\/api\/unsubscribe\/preview/);
  assert.doesNotMatch(calls[1].html, /\/api\/unsubscribe\?t=/);
  assert.equal(noted.length, 1);
  // Resend refusing it throws (recorded as failed by the sender).
  const no = { emails: { send: async () => ({ data: null, error: { message: "rate limited" } }) } };
  await assert.rejects(sendAppInviteEmail({ to: "a@example.com", person: {}, client: no }), /rate limited/);
  // Previews: inline images, never a token.
  const prev = appInviteEmailFor({ firstName: "Jane", email: "jane@example.com" });
  assert.match(prev.html, /data:image\/png;base64/);
  assert.equal(prev.tracked, false);
  assert.match(prev.html, /\/api\/unsubscribe\/preview/);
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
