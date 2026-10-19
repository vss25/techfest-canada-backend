/* Every word of the pass emails editable (Oct 19 2026): services/passEmailCopy.js, services/passEmail.js
   (speakers', issued and exhibitor passes) and services/ticketEmail.js (the purchase confirmation).
   Pure: no database, nothing sent. Fictional people only (example.com). */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { issuedVariant, issuedPassDoc } from "../services/issuedPasses.js";
import { exhibitorCopyFor, EXHIBITOR_PROMO, defaultExhibitorCopy } from "../services/exhibitorPasses.js";
import { buildTicketEmail, purchaseEmailDefaults } from "../services/ticketEmail.js";
import {
  SPEAKER_ACCESS, SPEAKER_PASS_NAME, VIP_LOUNGE, accessFor, buildPassEmail, ownCopy, passEmailDefaults, passVariant, speakerIncludes,
  SAMPLE_RUN_OF_SHOW, cleanPassLabel,
} from "../services/passEmail.js";
import {
  TIERS, carryPassRules, changedFields, cleanFields, compact, fieldsFor, fillText, mergeCopy, sameAsDefault, templateCopy, templateFor,
  templateSet, textHtml,
} from "../services/passEmailCopy.js";

/* ---------- the emails with no edits ----------
   The same people, passes and settings the builders rendered before staff could edit every part
   of them (at f268fb1, claude/four-passes); fixtures/pass-email-baseline.json holds hashes of
   that output. Changed on purpose since (the organiser, Oct 19 2026), and taken out before
   comparing: the speakers' pass is a "Speaker Pass" with SPEAKER_ACCESS and its own list
   (checked on their own below), and "All Access" only describes the Power Pass, so an Apex
   pass's access line is "Apex" (the old builder was given "Apex" for those). */

const IMG = { qrSrc: "cid:ttfc-speaker-qr", logoSrc: "cid:ttfc-logo" };
const SAMPLE_ROS = {
  sessions: [
    { day: 1, start: "10:00", end: "10:40", title: "Frontier AI in Practice", format: "Panel", role: "Panellist",
      lineup: [{ name: "Ada Example", role: "Moderator", org: "Example Labs" }, { name: "Jane Doe", role: "Panellist", org: "Example Corp" }] },
    { day: 2, start: "14:00", end: "14:20", title: "Quantum Next", format: "Keynote", role: "", lineup: [] },
  ],
};

const issued = (v, extra = {}) => ({ ...issuedPassDoc({ name: "Sam Example", emails: ["sam@example.com"], ...v }, { ticketId: "a1b2c3d4e5f6", now: new Date("2026-10-19T12:00:00Z") }), ...extra });
/** A pass email's builder input: the person, the images and the pass's variant + wording.
    `makeVariant`: issuedVariant for the old builder, passVariant (services/passEmail.js) for the new one. */
const pass = (a, copyFor) => (makeVariant = issuedVariant) => ({
  name: a.name, title: a.details?.jobTitle, company: a.details?.organisation, ticketId: a.ticketId, ...IMG,
  copy: a.issuedPass?.copy || {}, variant: makeVariant(a, copyFor ? { copyFor } : {}),
});
const purchase = (args) => ({ kind: "purchase", args: () => args });
const apex = (args) => ({ ...args, variant: { ...args.variant, access: "Apex" } });

/* kind "speaker": the speakers' email (no variant); "pass": an issued / exhibitor pass; "purchase": buildTicketEmail.
   `old`: the input the old builder needs to show what's expected now (the Apex access line). */
const SCENARIOS = {
  "speaker: no run of show": { kind: "speaker", args: () => ({ name: "Dr. Jane Doe", title: "Chief AI Officer", company: "Example Corp", ticketId: "a1b2c3d4e5f6", ...IMG }) },
  "speaker: run of show": { kind: "speaker", args: () => ({ name: "Jane Doe", title: "CTO", company: "Example Corp", ticketId: "a1b2c3d4e5f6", runOfShow: SAMPLE_ROS, ...IMG }) },
  "speaker: via a contact, no logo": { kind: "speaker", args: () => ({ name: "Jane Doe", ticketId: "a1b2c3d4e5f6", runOfShow: { sessions: [SAMPLE_ROS.sessions[0]] }, contact: "handler", qrSrc: "data:image/png;base64,AAAA" }) },
  "speaker: saved wording": { kind: "speaker", args: () => ({ name: "Jane Doe", ticketId: "a1b2c3d4e5f6", ...IMG, copy: { subject: "{firstName}, hello", headline: "Hi {fullName}", message: "Line one\nline two\n\nPara two" } }) },
  "issued: connect": { kind: "pass", args: pass(issued({ tier: "connect" })) },
  "issued: influence, title + company": { kind: "pass", args: pass(issued({ tier: "influence", title: "VP Growth", company: "Example Inc" })) },
  "issued: power": { kind: "pass", args: pass(issued({ tier: "power" })) },
  "issued: apex": { kind: "pass", args: pass(issued({ tier: "apex" })), old: apex },
  "issued: power with CxO on": { kind: "pass", args: pass(issued({ tier: "power", cxoBreakfast: true })) },
  "issued: apex with CxO off": { kind: "pass", args: pass(issued({ tier: "apex", cxoBreakfast: false })), old: apex },
  "issued: no RSVP, own label": { kind: "pass", args: pass(issued({ tier: "influence", rsvp: false, label: "Influence Pass · Guest" })) },
  "issued: saved wording": { kind: "pass", args: pass(issued({ tier: "power", copy: { subject: "Your pass, {firstName}", message: "Hello {fullName}." } })) },
  "exhibitor: built-in": { kind: "pass", args: pass(issued({ tier: "connect", company: "Booth Co", booth: { booth: "07", zone: "Zone A", passes: "4" } }, { promoCode: EXHIBITOR_PROMO }), exhibitorCopyFor(null)) },
  "exhibitor: saved template": { kind: "pass", args: pass(issued({ tier: "connect" }, { promoCode: EXHIBITOR_PROMO }), exhibitorCopyFor({ subject: "{firstName}, your booth pack", headline: "", message: "See you at the booth." })) },
  "purchase: connect": purchase({ name: "Jane Doe", firstName: "Jane", ticketId: "a1b2c3d4e5f6", tier: "connect", walletUrl: "https://api.example.com/w", qrUrl: "https://api.example.com/q", logoSrc: "cid:ttfc-logo" }),
  "purchase: influence": purchase({ name: "Jane Doe", ticketId: "a1b2c3d4e5f6", tier: "influence", walletUrl: "https://api.example.com/w", qrUrl: "https://api.example.com/q", logoSrc: "cid:ttfc-logo" }),
  "purchase: power": purchase({ name: "Jane Doe", firstName: "Jane", ticketId: "a1b2c3d4e5f6", tier: "power", walletUrl: "https://api.example.com/w", qrUrl: "https://api.example.com/q", logoSrc: "cid:ttfc-logo" }),
  "purchase: apex": purchase({ name: "Jane Doe", firstName: "Jane", ticketId: "a1b2c3d4e5f6", tier: "apex", walletUrl: "https://api.example.com/w", qrUrl: "https://api.example.com/q", logoSrc: "cid:ttfc-logo" }),
  "purchase: power with CxO": purchase({ name: "Jane Doe", firstName: "Jane", ticketId: "a1b2c3d4e5f6", tier: "power", cxoBreakfast: true, qrUrl: "https://api.example.com/q", logoSrc: "cid:ttfc-logo" }),
  "purchase: apex without CxO": purchase({ name: "Jane Doe", firstName: "Jane", ticketId: "a1b2c3d4e5f6", tier: "apex", cxoBreakfast: false, logoSrc: "cid:ttfc-logo" }),
  "purchase: guest, no logo": purchase({ name: "Guest", ticketId: "a1b2c3d4e5f6", tier: "power" }),
  "purchase: booth": purchase({ name: "Jane Doe", firstName: "Jane", ticketId: "BOOTH-GOLD", tier: "booth-gold", walletUrl: "https://api.example.com/w", qrUrl: "https://api.example.com/q", logoSrc: "cid:ttfc-logo" }),
};

/**
 * The speakers' email with the parts that changed on purpose taken out: the pass name, the access
 * line and the "includes" list (checked on their own). `name` / `access`: what this output says.
 */
function withoutSpeakerChanges(e, { name, access }) {
  const out = {};
  const upper = name.toUpperCase();
  const swap = (s) => String(s).split(name).join("‹PASS›").split(upper).join("‹PASS›").split(access).join("‹ACCESS›");
  out.subject = swap(e.subject);
  out.preheader = swap(e.preheader);
  out.html = swap(e.html.replace(/<!-- Included -->[\s\S]*?<\/table>\s*<\/td>\s*<\/tr>/, "‹INCLUDES›"));
  out.text = swap(e.text.replace(/YOUR PASS INCLUDES\n(  - .*\n)+/, "‹INCLUDES›\n"));
  return out;
}

const BASELINE = JSON.parse(fs.readFileSync(new URL("./fixtures/pass-email-baseline.json", import.meta.url), "utf8"));
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const render = (sc) => (sc.kind === "purchase" ? buildTicketEmail(sc.args()) : buildPassEmail(sc.kind === "pass" ? sc.args(passVariant) : sc.args()));

test("no edits: every pass email is exactly what it was (subject, preheader, HTML and plain text)", () => {
  assert.equal(Object.keys(SCENARIOS).length, Object.keys(BASELINE).length);
  for (const [name, sc] of Object.entries(SCENARIOS)) {
    let e = render(sc);
    if (sc.kind === "speaker") e = withoutSpeakerChanges(e, { name: SPEAKER_PASS_NAME, access: SPEAKER_ACCESS });
    const b = BASELINE[name];
    assert.ok(b, name);
    assert.equal(e.subject, b.subject, `${name}: subject`);
    assert.equal(e.preheader, b.preheader, `${name}: preheader`);
    assert.equal(sha(e.html), b.html, `${name}: HTML`);
    assert.equal(sha(e.text), b.text, `${name}: plain text`);
  }
});

test("an empty template, or empty fields, change nothing", () => {
  for (const [name, sc] of Object.entries(SCENARIOS)) {
    const plain = render(sc);
    const blanks = Object.fromEntries(fieldsFor(sc.kind === "pass" ? "issued" : sc.kind).map((f) => [f.key, f.type === "line" || f.type === "text" ? "" : []]));
    const e = sc.kind === "purchase"
      ? buildTicketEmail({ ...sc.args(), template: { ...blanks, tiers: { power: { includes: [], passName: "" } } } })
      : buildPassEmail({ ...(sc.kind === "pass" ? sc.args(passVariant) : sc.args()), copy: { ...blanks, ...((sc.kind === "pass" ? sc.args(passVariant) : sc.args()).copy || {}) } });
    assert.equal(e.html, plain.html, name);
    assert.equal(e.text, plain.text, name);
  }
});

test("the Speaker Pass by default: its name, its access line and Power + CxO Breakfasts + VIP Lounge (no Apex extras)", () => {
  const e = buildPassEmail({ name: "Jane Doe", ticketId: "a1b2c3", runOfShow: SAMPLE_ROS });
  assert.equal(e.subject, "Jane, your Speaker Pass and run of show for TTFC 2026");
  assert.match(e.html, /SPEAKER PASS/);
  assert.match(e.text, /YOUR SPEAKER PASS/);
  assert.match(e.text, /Access: {4}Speaker · Power \+ CxO Breakfasts \+ VIP Lounge/);
  const heads = speakerIncludes().map((r) => r[0]);
  assert.deepEqual(heads, ["2× CxO Breakfasts", "1× Gala Dinner & Networking Reception", "1× Catalyst Awards Night", "2× Luncheons",
    "2× Day Conference Access", "Expo Floor Access", "Networking Breaks", "VIP Lounge Access (both days)"]);
  for (const h of heads) assert.ok(e.text.includes(`  - ${h}:`), h);
  assert.doesNotMatch(e.html + e.text, /Pre-Matched|Preferential Seating|Scotch/);
  // "All Access" only ever describes the Power Pass.
  assert.doesNotMatch(e.html + e.text + e.subject + e.preheader, /all[- ]access/i);
  assert.equal(passEmailDefaults().passName, "Speaker Pass");
});

test('"All Access" only describes the Power Pass: Apex says "Apex", the Speaker Pass says what it is', () => {
  const apex = buildPassEmail({ name: "Ann Example", ticketId: "x", variant: passVariant({ ticketType: "apex" }) });
  assert.match(apex.text, /Access: {4}Apex\n/);
  assert.doesNotMatch(apex.html + apex.text, /all access/i);
  const power = buildPassEmail({ name: "Pat Example", ticketId: "x", variant: passVariant({ ticketType: "power" }) });
  assert.match(power.text, /Access: {4}All Access\n/);
  assert.equal(accessFor("apex", "All Access + Apex"), "Apex");
  assert.equal(accessFor("speaker", "All Access"), SPEAKER_ACCESS);
  assert.equal(accessFor("power", "All Access"), "All Access");
  assert.equal(accessFor("influence", "Conference, Expo & Luncheons"), "Conference, Expo & Luncheons");
});

/* ---------- every field renders ---------- */

const marker = (k) => `Zq${k}Zq`;
/** Every field of an email set to a marker; lists get one marked row. */
function everyField(email, level = "template") {
  const out = {};
  for (const f of fieldsFor(email, { level })) {
    out[f.key] = f.type === "pairs" ? [[marker(`${f.key}H`), marker(`${f.key}S`)]] : f.type === "list" ? [marker(f.key)] : marker(f.key);
  }
  return out;
}
const shows = (e, k) => [e.subject, e.preheader, e.html, e.text].some((s) => s.includes(k));

test("every field of the speakers' email renders when it's set", () => {
  const copy = everyField("speaker");
  const e = buildPassEmail({ name: "Jane Doe", ticketId: "a1b2c3", runOfShow: SAMPLE_ROS, contact: "handler", copy });
  for (const f of fieldsFor("speaker")) {
    const keys = f.type === "pairs" ? [marker(`${f.key}H`), marker(`${f.key}S`)] : [marker(f.key)];
    // The pass name is upper case on the badge and in the plain-text heading, as built in.
    for (const k of keys) assert.ok(shows(e, k) || (f.key === "passName" && shows(e, k.toUpperCase())), `${f.key} doesn't show`);
  }
  assert.match(e.html, new RegExp(marker("passName").toUpperCase()));
  // The day plan wording replaces the fixed events' wording on both days.
  for (const k of ["rosRegTitle", "rosBreakfastWhere", "rosEvening1Title", "rosMicFittingTitle"]) assert.ok(e.text.includes(marker(k)), k);
  for (const k of ["rosLunchNote", "rosEvening2Note", "rosMicFittingNote"]) assert.ok(e.html.includes(marker(k)), k); // notes: the HTML day plan only, as built in
  assert.doesNotMatch(e.text, /Arrival, registration and badge pick-up|Networking Reception and Gala Dinner/);
  // Plain text too, for the fields that have a line there.
  for (const k of ["greeting", "headline", "message", "rsvpTitle", "rsvpText", "rsvpNote", "contactTitle", "contactText", "signoff", "signature", "footer", "footerNote", "qrTextNote", "contactNotice"]) {
    assert.ok(e.text.includes(k === "rsvpTitle" ? marker(k).toUpperCase() : marker(k)), `${k} not in the plain text`);
  }
});

test("every field of the issued and exhibitor pass emails renders when it's set (template level, per pass type too)", () => {
  for (const email of ["issued", "exhibitor"]) {
    const all = everyField(email);
    const tierKeys = fieldsFor(email).filter((f) => f.tier).map((f) => f.key);
    const generic = Object.fromEntries(Object.entries(all).filter(([k]) => !tierKeys.includes(k)));
    const tiers = { influence: Object.fromEntries(Object.entries(all).filter(([k]) => tierKeys.includes(k))) };
    const a = issuedPassDoc({ name: "Sam Example", emails: ["sam@example.com"], tier: "influence" }, { ticketId: "a1b2c3", promo: email === "exhibitor" ? EXHIBITOR_PROMO : "ISSUED" });
    const template = { ...generic, tiers };
    const variant = passVariant(a, { copyFor: email === "exhibitor" ? defaultExhibitorCopy : undefined, template });
    const e = buildPassEmail({ name: a.name, ticketId: a.ticketId, copy: mergeCopy({}, template), variant });
    for (const f of fieldsFor(email)) {
      const keys = f.type === "pairs" ? [marker(`${f.key}H`), marker(`${f.key}S`)] : [marker(f.key)];
      for (const k of keys) assert.ok(shows(e, k) || (f.key === "passName" && shows(e, k.toUpperCase())), `${email}: ${f.key} doesn't show`);
    }
  }
});

test("every field of the purchase email renders when it's set; a booth confirmation takes only the shared sections", () => {
  const all = everyField("purchase");
  const tierKeys = fieldsFor("purchase").filter((f) => f.tier).map((f) => f.key);
  const template = {
    ...Object.fromEntries(Object.entries(all).filter(([k]) => !tierKeys.includes(k))),
    tiers: { apex: Object.fromEntries(Object.entries(all).filter(([k]) => tierKeys.includes(k))) },
  };
  const args = { name: "Jane Doe", firstName: "Jane", ticketId: "a1b2c3", walletUrl: "https://api.example.com/w", qrUrl: "https://api.example.com/q", template };
  const e = buildTicketEmail({ ...args, tier: "apex" });
  for (const f of fieldsFor("purchase")) assert.ok(shows(e, marker(f.key)), `${f.key} doesn't show`);
  // Per pass type: an Influence buyer gets the generic fields and Influence's own built-in name and list.
  const inf = buildTicketEmail({ ...args, tier: "influence" });
  assert.match(inf.html, /Influence Pass/);
  assert.ok(!shows(inf, marker("passName")) && !shows(inf, marker("includes")) && !shows(inf, marker("tips")));
  assert.ok(shows(inf, marker("subject")) && shows(inf, marker("helpText")));
  // A booth: header, event details, app and footer only.
  const booth = buildTicketEmail({ ...args, ticketId: "BOOTH-GOLD", tier: "booth-gold" });
  for (const f of fieldsFor("purchase")) assert.equal(shows(booth, marker(f.key)), !!f.booth, `booth: ${f.key}`);
  assert.equal(booth.subject, "Your TTFC 2026 Exhibition Booth — Gold is confirmed");
});

/* ---------- levels ---------- */

test("one pass's wording beats the template, which beats the built-in text", () => {
  const template = { headline: "Template headline", rsvpButton: "Template button", footerNote: "Template note", passName: "Template Pass" };
  const own = { headline: "Pass headline", rsvpButton: "" };
  const a = { issuedPass: { label: "Speaker Pass · Keynote", copy: own } };
  const copy = mergeCopy({}, ownCopy(a), template);
  const e = buildPassEmail({ name: "Jane Doe", ticketId: "x", copy });
  assert.match(e.html, /Pass headline/);
  assert.doesNotMatch(e.html, /Template headline/);
  assert.match(e.html, />Template button</); // empty at the pass level: the template's
  assert.match(e.html, /Template note/);
  assert.match(e.html, /SPEAKER PASS · KEYNOTE/); // the pass's own name beats the template's
  assert.match(e.subject, /your Speaker Pass · Keynote for TTFC/);
  // This send's wording beats both.
  assert.match(buildPassEmail({ name: "Jane Doe", ticketId: "x", copy: mergeCopy({ headline: "Send" }, ownCopy(a), template) }).html, /Send/);
});

test("issued passes: the template's pass name / list / access per pass type, the pass's own name still wins", () => {
  const template = { tiers: { power: { passName: "Power Pass · VIP", access: "Everything, both days", rsvpText: "Tell us which dinners." } } };
  const plain = issuedPassDoc({ name: "Pat Example", emails: [], tier: "power" }, { ticketId: "x" });
  const v = passVariant(plain, { template });
  assert.deepEqual([v.label, v.access, v.rsvpReason], ["Power Pass · VIP", "Everything, both days", "Tell us which dinners."]);
  assert.equal(v.subject, "{firstName}, your Power Pass · VIP for TTFC 2026"); // the built-in wording follows the name
  const own = passVariant({ ...plain, issuedPass: { ...plain.issuedPass, label: "Guest of Honour" } }, { template });
  assert.equal(own.label, "Guest of Honour");
  // Another pass type isn't touched.
  assert.equal(passVariant(issuedPassDoc({ name: "Con Example", emails: [], tier: "connect" }, { ticketId: "y" }), { template }).label, "Connect Pass");
});

/* ---------- escaping and placeholders ---------- */

test("everything staff type is escaped: no HTML gets through, line breaks are kept", () => {
  const evil = `<script>alert("x")</script> & <b>bold</b>`;
  const copy = Object.fromEntries(fieldsFor("speaker").map((f) => [f.key, f.type === "pairs" ? [[evil, evil]] : f.type === "list" ? [evil] : evil]));
  copy.message = `${evil}\nsecond line\n\nnew paragraph`;
  copy.contactText = `Line one ${evil}\nwrite to a@example.com`;
  const e = buildPassEmail({ name: `Ada <i>Lovelace</i>`, ticketId: "x", runOfShow: SAMPLE_ROS, contact: "handler", copy });
  assert.doesNotMatch(e.html, /<script|<b>bold|<i>Lovelace/);
  assert.match(e.html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; &lt;b&gt;bold&lt;\/b&gt;/);
  assert.match(e.html, /second line/);
  assert.match(e.html, /<br>second line/);
  assert.match(e.html, /<a href="mailto:a@example.com"/); // an address in the contact box becomes a link, nothing else
  const p = buildTicketEmail({ name: "Jane Doe", ticketId: "a1", tier: "power", template: {
    message: evil, helpText: evil, footerNote: `${evil}\nnext`, tiers: { power: { includes: [evil], tips: [evil], blurb: evil, tagline: evil } } } });
  assert.doesNotMatch(p.html, /<script|<b>bold/);
  assert.match(p.html, /&amp; &lt;b&gt;bold&lt;\/b&gt;<br>next/);
  // Stored values are plain text: control characters out, one-line fields on one line, limits kept.
  const c = cleanFields({ greeting: "Hi\u0007 there\n you", message: "a\r\n\r\n\r\nb", rsvpButton: "x".repeat(99), includes: [["  A ", " b "], ["", "dropped"], "C"] }, "speaker");
  assert.deepEqual(c, { greeting: "Hi there you", message: "a\n\nb", rsvpButton: "x".repeat(40), includes: [["A", "b"], ["C", ""]] });
});

test("placeholders: {firstName}, {fullName}, {name}, {passName}, {ticketId}, {sessions}", () => {
  const e = buildPassEmail({ name: "Dr. Jane Doe", ticketId: "ab12", runOfShow: SAMPLE_ROS, copy: {
    subject: "{firstName} / {fullName} / {name} / {passName} / {ticketId}", rosTitle: "{sessions} for {firstName}", greeting: "Hi {firstName}," } });
  assert.equal(e.subject, "Jane / Dr. Jane Doe / Dr. Jane Doe / Speaker Pass / AB12");
  assert.match(e.html, /sessions for Jane/);
  assert.match(e.html, /Hi Jane,/);
  // Filled once: a name that looks like a placeholder isn't filled again; unknown ones stay as typed.
  assert.equal(fillText("{firstName} {fullName} {unknown}", { firstName: "{fullName}", fullName: "X" }), "{fullName} X {unknown}");
  // A value is escaped, and can be styled (the purchase intro's pass name is bold, the ticket ID in the ticket style).
  assert.equal(textHtml("Your {passName}", { passName: "<A>" }, { wrap: { passName: (v) => `<b>${v}</b>` } }), "Your <b>&lt;A&gt;</b>");
  const p = buildTicketEmail({ name: "Jane Doe", firstName: "Jane", ticketId: "a1b2", tier: "apex", template: {
    message: "Welcome {firstName}: your {passName}.", helpText: "Quote {ticketId}, or write to help@example.com.", tiers: { apex: { passName: "Apex Pass · Gold" } } } });
  assert.match(p.html, /Welcome Jane: your <strong style="color:#ffffff;">Apex Pass · Gold<\/strong>\./);
  assert.match(p.html, /Quote <span style="font-family:[^"]+;color:#f5a623;">a1b2<\/span>, or write to <a href="mailto:help@example.com"/);
  assert.match(p.subject, /Apex Pass · Gold is confirmed/);
  assert.match(p.html, /APEX PASS · GOLD|Apex Pass · Gold/);
});

/* ---------- the "includes" list ---------- */

test("includes: add, remove, reorder and reword for one pass", () => {
  const variant = passVariant(issuedPassDoc({ name: "Pat Example", emails: [], tier: "power" }, { ticketId: "x" }));
  const list = [["Networking Breaks", "Coffee, all day"], ["A private tour", "Just for you"], ["1× Gala Dinner & Networking Reception", "Day 2"]];
  const e = buildPassEmail({ name: "Pat Example", ticketId: "x", variant, copy: { includes: list } });
  const shown = [...e.text.matchAll(/^ {2}- (.*)$/gm)].map((m) => m[1]);
  assert.deepEqual(shown, ["Networking Breaks: Coffee, all day", "A private tour: Just for you", "1× Gala Dinner & Networking Reception: Day 2"]);
  assert.doesNotMatch(e.text, /Luncheons/);
  // A row without a detail line has none.
  assert.match(buildPassEmail({ name: "P E", ticketId: "x", variant, copy: { includes: [["Only a heading", ""]] } }).text, / {2}- Only a heading\n/);
});

test("includes: the template's list per pass type still follows each pass's CxO Breakfast switch", () => {
  const template = { tiers: { power: { includes: [["Gala", "Day 2"], ["Lunch", "Both days"]] }, apex: { includes: [["Meetings", "Two"], ["2× CxO Breakfasts", "Mornings"], ["Gala", "Day 2"]] } } };
  const pass = (tier, cxoBreakfast) => passVariant({ ...issuedPassDoc({ name: "Pat Example", emails: [], tier }, { ticketId: "x" }), cxoBreakfast }, { template });
  assert.deepEqual(pass("power").includes.map((r) => r[0]), ["Gala", "Lunch"]);
  assert.deepEqual(pass("power", true).includes.map((r) => r[0]), ["2× CxO Breakfasts", "Gala", "Lunch"]);
  assert.deepEqual(pass("apex").includes.map((r) => r[0]), ["Meetings", "2× CxO Breakfasts", "Gala"]);
  assert.deepEqual(pass("apex", false).includes.map((r) => r[0]), ["Meetings", "Gala"]);
  // The purchase email: the same for its plain lines.
  const p = (cxoBreakfast) => buildTicketEmail({ name: "Jane Doe", ticketId: "a1", tier: "power", cxoBreakfast, template: { tiers: { power: { includes: ["2x Day Conference Access", "A dinner"] } } } });
  assert.deepEqual([...p().text.matchAll(/^ {2}- (.*)$/gm)].map((m) => m[1]).slice(0, 3), ["2x Day Conference Access", "A dinner", "Bring a government-issued photo ID that matches the name on this pass."]);
  assert.match(p(true).text, / {2}- 2x Day Conference Access\n {2}- 2x CxO Breakfasts\n {2}- A dinner/);
  assert.deepEqual(carryPassRules(["a", "b"], ["a"], ["a", "x"]), ["a", "x", "b"]);
});

test("a list (or text) saved exactly as the built-in one is no edit, so it keeps following the pass's rules", () => {
  const d = passEmailDefaults();
  assert.deepEqual(sameAsDefault({ includes: d.includes, greeting: d.greeting, headline: "Mine" }, [d]), { includes: [], greeting: "", headline: "Mine" });
  const tierDefaults = { power: purchaseEmailDefaults({ tier: "power" }) };
  assert.deepEqual(sameAsDefault({ tiers: { power: { includes: tierDefaults.power.includes, passName: "P" } } }, [], { tierDefaults }).tiers.power, { includes: [], passName: "P" });
});

/* ---------- storage helpers ---------- */

test("template row ↔ fields: subject / headline / message in their columns, the rest in `fields`, per pass type in tiers", () => {
  const clean = cleanFields({ subject: "S", preheader: "P", passName: "ignored at the top", tiers: { apex: { passName: "Apex+", includes: [["X", "y"]] }, nope: { passName: "no" } } }, "issued", { tiers: true });
  // The pass name is per pass type in these templates (not at the top), and only the known pass types are kept.
  assert.deepEqual(clean, { subject: "S", preheader: "P", tiers: { apex: { passName: "Apex+", includes: [["X", "y"]] } } });
  const set = templateSet(clean, "Ann");
  assert.deepEqual(set, { subject: "S", headline: "", message: "", fields: { preheader: "P", tiers: { apex: { passName: "Apex+", includes: [["X", "y"]] } } }, updatedBy: "Ann" });
  const back = templateCopy({ ...set, fields: { ...set.fields, bogus: "x" } }, "issued");
  assert.deepEqual(back, { subject: "S", preheader: "P", tiers: { apex: { passName: "Apex+", includes: [["X", "y"]] } } });
  assert.deepEqual(templateFor(back, "apex"), { subject: "S", preheader: "P", passName: "Apex+", includes: [["X", "y"]] });
  assert.deepEqual(changedFields({ subject: "S" }, back), ["preheader", "passName (apex)", "includes (apex)"]);
  assert.deepEqual(changedFields(back, { preheader: "P" }), ["subject reset", "passName reset (apex)", "includes reset (apex)"]);
  assert.ok(TIERS.includes("speaker"));
  // One pass's level has no pass name field (that's the pass's own "Name on the pass").
  assert.ok(!fieldsFor("issued", { level: "pass" }).some((f) => f.key === "passName"));
  assert.ok(fieldsFor("speaker").some((f) => f.key === "rosRegTitle") && !fieldsFor("issued").some((f) => f.key.startsWith("ros")));
  assert.equal(cleanPassLabel("All Access Pass"), "");
  assert.equal(cleanPassLabel("Speaker Pass · Keynote"), "Speaker Pass · Keynote");
  assert.deepEqual(compact({ a: "", b: [], c: "x", tiers: { power: { d: "" } } }), { c: "x" });
  assert.ok(Array.isArray(VIP_LOUNGE));
});

test("every field's built-in text is what the email shows (the editor's grey placeholders are true)", () => {
  const unescape = (s) => s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&middot;/g, "·").replace(/&nbsp;/g, " ");
  const check = (e, defaults, vars, skip = []) => {
    const flat = (s) => s.replace(/\s+/g, " ");
    const all = flat(unescape(`${e.subject}\n${e.preheader}\n${e.html.replace(/<br>\s*/g, "\n").replace(/<[^>]+>/g, "")}\n${e.text}`));
    for (const [k, v] of Object.entries(defaults)) {
      if (skip.includes(k)) continue;
      const parts = Array.isArray(v) ? v.flat() : [v];
      for (const part of parts.filter(Boolean)) assert.ok(all.includes(flat(fillText(part, vars))), `${k}: "${fillText(part, vars)}"`);
    }
  };
  const e = buildPassEmail({ name: "Jane Doe", ticketId: "ab12", runOfShow: SAMPLE_RUN_OF_SHOW, contact: "handler" });
  check(e, e.defaults, { firstName: "Jane", fullName: "Jane Doe", passName: "Speaker Pass", ticketId: "AB12", sessions: "session" });
  const p = buildTicketEmail({ name: "Jane Doe", firstName: "Jane", ticketId: "ab12", tier: "apex", walletUrl: "https://w", qrUrl: "https://q" });
  check(p, p.defaults, { firstName: "Jane", fullName: "Jane Doe", passName: "Apex Pass", ticketId: "ab12" });
});
