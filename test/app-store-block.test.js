/* "Get the TTFC app" in every email (Oct 23 2026, the organiser: "make sure all emails now have details of downloading
   apps whether android or iOS"): services/appStoreBlock.js and every email an attendee, speaker, exhibitor, juror,
   nominator or subscriber can get. Staff alerts stay as they were. Pure builders and stubbed email clients only:
   nothing is sent. Fictional people only (example.com). */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.RESEND_API_KEY ||= "re_test_stub"; // route modules make a Resend client on import (never used here)

import {
  APP_BLOCK, STORE_BADGES, appStoreBlockCss, appStoreBlockHtml, appStoreBlockLines, appStoreBlockText, campaignAppBlock, storeBadgeTable, storeLinks,
} from "../services/appStoreBlock.js";
import { IOS_APP_STORE_URL, PLAY_STORE_URL } from "../services/ticketInfo.js";
import { STORE_BADGES as INVITE_BADGES, appInviteEmailFor } from "../services/appInviteEmail.js";
import { SAMPLE_RUN_OF_SHOW, buildPassEmail, passVariant } from "../services/passEmail.js";
import { issuedPassDoc } from "../services/issuedPasses.js";
import { EXHIBITOR_PROMO, exhibitorCopyFor } from "../services/exhibitorPasses.js";
import { buildSessionInvite } from "../services/speakerInvites.js";
import { SAMPLE_REMINDER, reminderEmailFor, sendRsvpReminder } from "../services/rsvpReminder.js";
import { attendingEmailFor, sendAttendingEmail } from "../services/attendingEmail.js";
import { SAMPLE_ITEMS, buildDigestEmail, sendDigestEmail } from "../services/digestEmail.js";
import { buildNoTicketEmail, buildSignInEmail } from "../services/signInEmail.js";
import { buildProfileRequestEmail } from "../services/profileEmail.js";
import { buildBrochureEmail, buildBrochureReceiptEmail } from "../services/brochureEmail.js";
import { BROCHURES } from "../services/brochureDownloads.js";
import { buildJuryCodeEmail, buildJuryEmail, sendJuryEmail } from "../services/juryEmail.js";
import { varsFor } from "../services/juryEmailCopy.js";
import { buildTicketEmail } from "../services/ticketEmail.js";
import { buildPurchaseAlert } from "../services/purchaseAlert.js";
import { sosEmail } from "../services/sos.js";
import { buildRsvpEmail } from "../services/rsvp.js";
import { buildFormEmail } from "../services/formSubmissions.js";

const { buildResetPasswordEmailHtml, buildWelcomeEmailHtml, generateCampaignFooter } = await import("../services/emailService.js");
const nominations = await import("../routes/nominations.js");
const pavilion = await import("../routes/pavilion.js");
const media = await import("../routes/media.js");

const count = (s, needle) => String(s).split(needle).length - 1;
const FULL_BADGE = '<table role="presentation" class="sbt" width="200" height="58"';
const COMPACT_BADGE = '<table role="presentation" class="sbt-c" width="160" height="46"';
const HEADLINE = ">Get the TTFC app</div>";

/** The block is there once, with both badges (full or compact) and their plain links; the text has both store lines. */
function hasBlock(e, { compact = false, text = true, label = "" } = {}) {
  const html = e.html;
  assert.equal(count(html, HEADLINE), 1, `${label}: one headline`);
  assert.equal(count(html, APP_BLOCK.line), 1, `${label}: the line`);
  assert.equal(count(html, compact ? COMPACT_BADGE : FULL_BADGE), 2, `${label}: two ${compact ? "compact" : "full"} badges`);
  // Logo + words are links, straight to the stores (no click tracking of their own).
  assert.equal(count(html, `href="${IOS_APP_STORE_URL}"`), 2, `${label}: App Store links`);
  assert.equal(count(html, `href="${PLAY_STORE_URL}"`), 2, `${label}: Google Play links`);
  assert.match(html, /<img src="https:\/\/www\.thetechfestival\.com\/email\/store-apple@2x\.png" width="\d+" height="\d+" alt="Apple"/, label);
  assert.match(html, /<img src="https:\/\/www\.thetechfestival\.com\/email\/store-play@2x\.png" width="\d+" height="\d+" alt="Play"/, label);
  if (text) {
    assert.ok(e.text.includes(`GET THE TTFC APP\n${APP_BLOCK.line}\n  iPhone (App Store): ${IOS_APP_STORE_URL}\n  Android (Google Play): ${PLAY_STORE_URL}`), `${label}: plain text`);
  }
  return html.indexOf(HEADLINE);
}

/* ---------- the block ---------- */

test("the block: headline, one line, the App Store then Google Play badge (black, grey edge, 200 × 58), no SVG or gradients", () => {
  const html = appStoreBlockHtml();
  assert.equal(count(html, FULL_BADGE), 2);
  assert.equal(count(html, "background:#000000;border:1px solid #a6a6a6;border-radius:12px;"), 2);
  assert.ok(html.indexOf("store-apple") < html.indexOf("store-play"), "App Store first");
  assert.ok(html.includes(">Download on the</span>") && html.includes(">App Store</span>"), "live text");
  assert.ok(html.includes(">GET IT ON</span>") && html.includes(">Google Play</span>"));
  assert.doesNotMatch(html, /<svg|gradient|data:image/i);
  // The purple emails' panel (the app invite's look): #0d0620, a 2px purple edge.
  assert.match(html, /class="ab-panel"[^>]*background:#0d0620;border:2px solid #7a3fd1;border-radius:18px;/);
  assert.equal(APP_BLOCK.headline, "Get the TTFC app");
  assert.equal(APP_BLOCK.line, "Your pass, the schedule, live polls and messages, on your phone. Free on iPhone and Android.");
  // Side by side when there's room (inline-blocks), Outlook's two-cell table, stacked under 620px by the CSS.
  assert.equal(count(html, 'class="ab-sb" style="display:inline-block;vertical-align:top;width:212px;'), 2);
  assert.equal(count(html, "<!--[if mso]>"), 3);
  assert.match(appStoreBlockCss(), /@media only screen and \(max-width:620px\) \{ \.ab-sb \{ display:block !important; width:100% !important; \} \}/);
});

test("compact: 160 × 46 badges, a lighter panel; light theme: white with dark words", () => {
  const c = appStoreBlockHtml({ compact: true });
  assert.equal(count(c, COMPACT_BADGE), 2);
  assert.equal(count(c, FULL_BADGE), 0);
  assert.match(c, /border:1px solid #7a3fd1;border-radius:14px;/);
  assert.equal(count(c, "width:172px;"), 2);
  const l = appStoreBlockHtml({ theme: "light" });
  assert.match(l, /class="ab-panel"[^>]*background:#ffffff;/);
  assert.match(l, /class="ab-hd" style="[^"]*color:#140a26;/);
  // The other colour scheme, for emails that have one.
  assert.match(appStoreBlockCss({ adapt: "light" }), /prefers-color-scheme: light\) \{ \.ab-panel \{ background:#ffffff !important; \}/);
  assert.match(appStoreBlockCss({ adapt: "dark" }), /prefers-color-scheme: dark\) \{ \.ab-panel \{ background:#0d0620 !important; \}/);
  assert.doesNotMatch(appStoreBlockCss(), /prefers-color-scheme/);
});

test("the links: services/ticketInfo.js (APP_STORE_URL override); no App Store link = Google Play alone", () => {
  assert.deepEqual(storeLinks().map((x) => x.href), [IOS_APP_STORE_URL, PLAY_STORE_URL]);
  const other = "https://apps.apple.com/ca/app/example/id1";
  assert.deepEqual(storeLinks({ storeUrl: other }).map((x) => x.href), [other, PLAY_STORE_URL]);
  const play = appStoreBlockHtml({ storeUrl: "" });
  assert.equal(count(play, FULL_BADGE), 1);
  assert.doesNotMatch(play, /store-apple|apps\.apple\.com/);
  assert.deepEqual(appStoreBlockLines({ storeUrl: "" }), ["GET THE TTFC APP", APP_BLOCK.line, `  Android (Google Play): ${PLAY_STORE_URL}`]);
  assert.equal(appStoreBlockText(), `GET THE TTFC APP\n${APP_BLOCK.line}\n  iPhone (App Store): ${IOS_APP_STORE_URL}\n  Android (Google Play): ${PLAY_STORE_URL}`);
});

test("the app invite draws the same badges (its own panel and words, unchanged)", () => {
  assert.equal(INVITE_BADGES, STORE_BADGES);
  const e = appInviteEmailFor({ firstName: "Jane", email: "jane@example.com" }, { inline: true });
  assert.ok(e.html.includes(storeBadgeTable({ ...STORE_BADGES.appStore, href: IOS_APP_STORE_URL })));
  assert.ok(e.html.includes(storeBadgeTable({ ...STORE_BADGES.play, href: PLAY_STORE_URL })));
  assert.equal(count(e.html, 'class="ab-panel"'), 0, "no second block in the app invite");
});

/* ---------- every attendee email ---------- */

const IMG = { qrSrc: "cid:ttfc-speaker-qr", logoSrc: "cid:ttfc-logo" };
const issued = (v, extra = {}) => ({ ...issuedPassDoc({ name: "Sam Example", emails: ["sam@example.com"], ...v }, { ticketId: "a1b2c3d4e5f6", now: new Date("2026-10-19T12:00:00Z") }), ...extra });
const passArgs = (a, copyFor) => ({ name: a.name, ticketId: a.ticketId, ...IMG, copy: a.issuedPass?.copy || {}, variant: passVariant(a, copyFor ? { copyFor } : {}) });

test("pass emails (Speaker Pass, nudges, issued, exhibitor): after the RSVP section, before the contact box; not a field", () => {
  const cases = {
    speaker: buildPassEmail({ name: "Jane Doe", ticketId: "a1b2c3d4e5f6", runOfShow: SAMPLE_RUN_OF_SHOW, ...IMG }),
    "speaker nudge (saved wording)": buildPassEmail({ name: "Jane Doe", ticketId: "a1b2c3d4e5f6", ...IMG, copy: { subject: "Reminder", message: "Please RSVP." } }),
    issued: buildPassEmail(passArgs(issued({ tier: "power" }))),
    exhibitor: buildPassEmail(passArgs(issued({ tier: "connect", company: "Booth Co" }, { promoCode: EXHIBITOR_PROMO }), exhibitorCopyFor(null))),
  };
  for (const [label, e] of Object.entries(cases)) {
    const at = hasBlock(e, { label });
    assert.ok(e.html.indexOf("Save your seat") < at && at < e.html.indexOf("Questions, travel or session details?"), `${label}: placement`);
    assert.ok(e.text.indexOf("SAVE YOUR SEAT") < e.text.indexOf("GET THE TTFC APP"), `${label}: text placement`);
    assert.ok(e.html.includes(".ab-sb { display:block"), `${label}: the stacking rule`);
  }
  // Without the RSVP button it's still there, before the contact box.
  const noRsvp = buildPassEmail(passArgs(issued({ tier: "influence", rsvp: false })));
  const at = hasBlock(noRsvp, { label: "no RSVP" });
  assert.ok(at < noRsvp.html.indexOf("Questions, travel or session details?"));
  // Staff can't edit or remove it: blanking every field leaves it.
  const blank = buildPassEmail({ name: "Jane Doe", ticketId: "x", ...IMG, copy: { message: "", contactTitle: "", footer: "" } });
  hasBlock(blank, { label: "blank fields" });
  assert.equal("appStore" in (blank.defaults || {}), false);
});

test("Speaker calendar invites: the compact light block after the questions line", () => {
  const e = buildSessionInvite({ name: "Jane Doe", ticketId: "A1B2C3D4E5F6", session: SAMPLE_RUN_OF_SHOW.sessions[0], to: "jane@example.com", now: new Date("2026-10-23T12:00:00Z") });
  const at = hasBlock(e, { compact: true, label: "invite" });
  assert.ok(e.html.indexOf("Accept the invite") < at);
  assert.match(e.html, /class="ab-panel"[^>]*background:#ffffff;/);
});

test("RSVP reminder: under the buttons, before the sign-off; the open pixel exactly as before", async () => {
  const e = reminderEmailFor(SAMPLE_REMINDER, { inline: true });
  const at = hasBlock(e, { label: "reminder" });
  assert.ok(e.html.indexOf("Already RSVP'd?") < at && at < e.html.indexOf("Questions? Just reply"));
  assert.deepEqual(e.links, ["https://www.thetechfestival.com/rsvp#t=A1B2C3D4E5F6&fn=Jane&ln=Doe"], "the RSVP links are still the only ones counted");
  // A real send: one pixel, last, after the block (stubbed client: nothing leaves).
  const prev = process.env.TRACKING_SECRET;
  process.env.TRACKING_SECRET = "test-secret-app-block";
  try {
    const sent = [];
    const client = { emails: { send: async (m) => { sent.push(m); return { data: { id: "em_1" } }; } } };
    await sendRsvpReminder({ to: "jane@example.com", row: SAMPLE_REMINDER, client, track: true, noteTracked: () => {} });
    const html = sent[0].html;
    hasBlock({ html, text: sent[0].text }, { label: "reminder sent" });
    assert.equal(count(html, 'width="1" height="1"'), 1);
    assert.ok(html.indexOf(HEADLINE) < html.indexOf('width="1" height="1"'));
    assert.ok(html.indexOf('width="1" height="1"') < html.lastIndexOf("</body>"));
  } finally {
    if (prev === undefined) delete process.env.TRACKING_SECRET; else process.env.TRACKING_SECRET = prev;
  }
});

test('"I\'m attending": after "How it works", before the sign-off (sent with a stubbed client too)', async () => {
  const e = attendingEmailFor({ firstName: "Jane", lastName: "Doe" }, { inline: true });
  const at = hasBlock(e, { label: "attending" });
  assert.ok(e.html.indexOf("How it works") < at && at < e.html.indexOf("Thank you for helping us spread the word"));
  const sent = [];
  await sendAttendingEmail({ to: "jane@example.com", recipient: { firstName: "Jane" }, subjectPrefix: "[Test] ", client: { emails: { send: async (m) => { sent.push(m); return { data: { id: "em_2" } }; } } } });
  hasBlock(sent[0], { label: "attending sent" });
});

test('"What you missed": under "Open TTFC", with the light version\'s colours', async () => {
  const e = buildDigestEmail({ firstName: "Jane", items: SAMPLE_ITEMS, unsubscribeUrl: "https://api.example.com/off" });
  const at = hasBlock(e, { label: "digest" });
  assert.ok(e.html.indexOf(">Open TTFC<") < at && at < e.html.indexOf("Turn off these emails"));
  assert.ok(e.text.indexOf("Open TTFC:") < e.text.indexOf("GET THE TTFC APP"));
  assert.match(e.html, /prefers-color-scheme: light\) \{ \.ab-panel/);
  const sent = [];
  await sendDigestEmail({ to: "jane@example.com", items: SAMPLE_ITEMS, client: { emails: { send: async (m) => { sent.push(m); return { data: { id: "em_3" } }; } } } });
  hasBlock(sent[0], { label: "digest sent" });
});

test("sign-in link / code and no-ticket emails: the compact block below the code, so the code never moves down", () => {
  const before = buildSignInEmail({ link: "https://www.thetechfestival.com/app-login?token=t", code: "482913" });
  const at = hasBlock(before, { compact: true, label: "sign-in" });
  assert.ok(before.html.indexOf("482 913") < at, "the code comes first");
  assert.ok(before.html.indexOf("Didn't ask to sign in?") < at);
  assert.ok(before.text.indexOf("482913") < before.text.indexOf("GET THE TTFC APP"));
  const none = buildNoTicketEmail({ email: "jane@example.com" });
  assert.ok(none.html.indexOf("Get your pass") < hasBlock(none, { compact: true, label: "no ticket" }));
});

test("complete-your-profile and brochure emails: before the help footer", () => {
  const p = buildProfileRequestEmail({ firstName: "Jane", tier: "power", link: "https://www.thetechfestival.com/complete-profile?t=x" });
  assert.ok(p.html.indexOf("Button not working?") < hasBlock(p, { label: "profile" }));
  assert.ok(hasBlock(p) < p.html.indexOf("Need a hand?"));
  const b = buildBrochureEmail({ firstName: "Jane", brochure: BROCHURES.sponsorship, link: "https://www.thetechfestival.com/Brochure.pdf" });
  const at = hasBlock(b, { label: "brochure" });
  assert.ok(b.html.indexOf("Button not working?") < at && at < b.html.indexOf("Questions about sponsoring"));
});

test("Catalyst Awards jury invite, reminder and code: compact; below the code in the code email", async () => {
  const vars = varsFor({ name: "Jane Doe", email: "jane@example.com" }, { assigned: 4 }, "October 24");
  for (const kind of ["invite", "reminder"]) {
    const e = buildJuryEmail({ kind, vars });
    const at = hasBlock(e, { compact: true, label: kind });
    assert.ok(e.html.indexOf(e.link) < at, `${kind}: after the portal button`);
    assert.match(e.html, /prefers-color-scheme: light\) \{ \.ab-panel/);
  }
  const code = buildJuryCodeEmail({ code: "482913", name: "Jane Doe" });
  const at = hasBlock(code, { compact: true, label: "jury code" });
  assert.ok(code.html.indexOf("482 913") < at && code.html.indexOf("Jury portal:") < at);
  const sent = [];
  await sendJuryEmail({ to: "jane@example.com", kind: "invite", vars, subjectPrefix: "[Test] ", client: { emails: { send: async (m) => { sent.push(m); return { data: { id: "em_4" } }; } } } });
  hasBlock(sent[0], { compact: true, label: "jury sent" });
});

test("nominator, India Pavilion and media confirmations: the compact light block", () => {
  const nom = nominations.buildConfirmationEmail({ nominatorName: "Jane Doe", nomineeName: "Sam Example", categoryType: "matrix", pillar: "AI", sector: "Healthcare" });
  assert.ok(nom.indexOf("View the Awards") < hasBlock({ html: nom }, { compact: true, text: false, label: "nominator" }));
  const app = pavilion.buildConfirmationEmail({ repName: "Jane Doe", legalName: "Example Pvt Ltd", boothTier: "x" });
  hasBlock({ html: app }, { compact: true, text: false, label: "pavilion application" });
  const receipt = pavilion.buildPaymentReceiptEmail({ companyName: "Example Pvt Ltd" });
  hasBlock({ html: receipt }, { compact: true, text: false, label: "pavilion receipt" });
  const ack = media.buildAckEmail({ fullName: "Jane Doe" });
  assert.ok(hasBlock({ html: ack }, { compact: true, text: false, label: "media" }) < ack.indexOf("marcom@thetechfestival.com"));
});

test("password reset and welcome emails: the compact block under the button", () => {
  const r = buildResetPasswordEmailHtml("https://www.thetechfestival.com/reset-password/abc");
  assert.ok(r.indexOf("Reset Password") < hasBlock({ html: r }, { compact: true, text: false, label: "reset" }));
  hasBlock({ html: buildWelcomeEmailHtml("Jane") }, { compact: true, text: false, label: "welcome" });
});

test("Audience campaigns and automation: in the shared footer, after staff's content, before the sender line and Unsubscribe", () => {
  const f = generateCampaignFooter("https://api.example.com", "cmp1", "jane@example.com");
  const at = hasBlock({ html: f }, { text: false, label: "campaign" });
  assert.ok(at < f.indexOf("The Tech Festival Canada •") && at < f.indexOf(">Unsubscribe</a>"));
  assert.ok(f.startsWith(campaignAppBlock()));
  // The badges go straight to the stores: never through /api/track/click.
  assert.doesNotMatch(f.slice(0, f.indexOf("The Tech Festival Canada •")), /api\/track/);
  // The automation's built-in template has a footer inside it and gets the real one too: only one block.
  const inner = generateCampaignFooter("https://api.example.com", "fallback", "recipient@example.com", { app: false });
  assert.equal(count(inner, HEADLINE), 0);
  assert.ok(inner.includes(">Unsubscribe</a>"));
});

test("emails that already had the stores keep their own: the app invite, the purchase email", () => {
  const invite = appInviteEmailFor({ firstName: "Jane", email: "jane@example.com" }, { inline: true });
  assert.equal(count(invite.html, 'class="ab-panel"'), 0, "its own panel only");
  assert.equal(count(invite.html, HEADLINE), 1, "its own \"Get the TTFC app\" (storesTitle)");
  const purchase = buildTicketEmail({ name: "Jane Doe", ticketId: "a1b2c3d4e5f6", tier: "power" });
  assert.equal(count(purchase.html, 'class="ab-panel"'), 0);
  assert.ok(purchase.html.includes(IOS_APP_STORE_URL) && purchase.html.includes(PLAY_STORE_URL));
});

test("staff alerts never get it: new ticket, RSVP, SOS, website forms, brochure downloads", () => {
  const staff = {
    purchase: buildPurchaseAlert({ session: { id: "cs_test_1", amount_total: 1000, currency: "cad", customer_details: { email: "a@example.com", name: "Ann" }, metadata: { tier: "power" } }, ticketIds: ["a1b2c3d4e5f6"], paidAt: new Date("2026-10-23T12:00:00Z") }),
    rsvp: buildRsvpEmail({ firstName: "Ann", lastName: "Lee", tier: "connect" }),
    sos: sosEmail({ _id: "abc", name: "Ann", email: "a@example.com", category: "medical", message: "help", location: "Hall" }),
    form: buildFormEmail({ type: "general", name: "Ann", email: "a@example.com", message: "hi", createdAt: new Date("2026-10-23T12:00:00Z") }),
    brochure: buildBrochureReceiptEmail({ lead: { firstName: "A", lastName: "B", email: "a@example.com" }, brochure: BROCHURES.sponsorship, delivery: "link" }),
  };
  for (const [label, e] of Object.entries(staff)) {
    assert.doesNotMatch(`${e.html}\n${e.text}`, /Get the TTFC app|GET THE TTFC APP|apps\.apple\.com|play\.google\.com/, label);
  }
});
