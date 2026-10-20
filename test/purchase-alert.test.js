/* The organisers' "New ticket" email (services/purchaseAlert.js): the content, amounts, code, channel and
   source, escaping, who gets it, which checkouts get one, and once per session. Fake people (example.com);
   Resend and the database are fakes here, nothing is sent. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PURCHASE_ALERT_TO, ALERT_CAMPAIGN, ALERT_FROM, alertRecipients, alertKind, money, channelOf, cleanLine,
  stripePaymentUrl, adminPersonUrl, buildPurchaseAlert, makePurchaseAlerter,
} from "../services/purchaseAlert.js";
import { detailsFromMetadata } from "../services/attendeeDetails.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://www.thetechfestival.com";

/** A completed Power Pass checkout as Stripe sends it: 20% code, 13% HST, bought on the website. */
function powerSession(over = {}) {
  return {
    id: "cs_live_a1B2c3D4e5", object: "checkout.session", mode: "payment", status: "complete", livemode: true,
    payment_status: "paid", payment_intent: "pi_3Q9ZexampleAbC", currency: "cad", created: 1792432440,
    amount_subtotal: 99900, amount_total: 90310, total_details: { amount_discount: 19980, amount_tax: 10390, amount_shipping: 0 },
    customer_details: { email: "Jane.Doe@Example.com", name: "Jane Q Doe", phone: null },
    metadata: {
      salutation: "Dr.", firstName: "Jane", lastName: "Doe", name: "Jane Doe", email: "jane.doe@example.com",
      organisation: "Example Robotics", jobTitle: "Head of Innovation", businessNumber: "+1 416 555 0100",
      country: "Canada", linkedin: "https://www.linkedin.com/in/jane-doe-example", jobLevel: "Director",
      jobFunction: "Engineering", topics: "Artificial Intelligence; Robotics", objectives: "Meet partners; Learn",
      consentTerms: "true", consentUpdates: "true",
      client: "web", type: "ticket", tier: "power", basePrice: "999", taxMode: "manual", taxPercent: "13",
      promoCode: "SPRING20", discount: "20",
      src_visit: "LinkedIn ad · utm: linkedin / paid-social / oct-launch · landed /tickets · referrer linkedin.com · Oct 19, 2:14 p.m. Toronto time",
      src_first: "landed / · referrer google.com · Oct 2, 9:05 a.m. Toronto time",
      ...(over.metadata || {}),
    },
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "metadata")),
  };
}
const PAID_AT = new Date("2026-10-19T18:14:00Z");

/* ---------- content ---------- */

test("a Power Pass with a code: who bought, the pass and ticket ID, the code, Stripe's amounts, channel, source, links", () => {
  const m = buildPurchaseAlert({ session: powerSession(), ticketIds: ["a1b2c3d4e5f6"], account: "none", paidAt: PAID_AT, site: SITE });
  assert.equal(m.subject, "New ticket: Power Pass · Jane Doe · CA$903.10");
  assert.equal(m.replyTo, "jane.doe@example.com");
  for (const s of [m.html, m.text]) {
    for (const want of [
      "Dr. Jane Doe", "jane.doe@example.com", "+1 416 555 0100", "Head of Innovation", "Example Robotics", "Director",
      "Engineering", "Canada", "Artificial Intelligence; Robotics", "Meet partners; Learn", "No account yet",
      "Power Pass", "a1b2c3d4e5f6", "SPRING20 (20% off)",
      "CA$999.00", "−CA$199.80", "HST (13%)", "CA$103.90", "CA$903.10", "CAD", "Paid",
      "Website", "LinkedIn ad · utm: linkedin / paid-social / oct-launch · landed /tickets · referrer linkedin.com",
      "landed / · referrer google.com", "Oct 19, 2026, 2:14 p.m. (Toronto)", "pi_3Q9ZexampleAbC", "cs_live_a1B2c3D4e5",
      "https://dashboard.stripe.com/payments/pi_3Q9ZexampleAbC",
      "https://www.thetechfestival.com/admin/people/t-a1b2c3d4e5f6",
      "Reply to this email to write to Jane Doe directly.",
    ]) assert.ok(s.includes(want), `missing ${want}`);
  }
  // The card holder's name differs from the form's: both shown.
  assert.match(m.text, /Name on the payment: Jane Q Doe/);
  // Text lines are "Label: value".
  assert.match(m.text, /^Code: SPRING20 \(20% off\)$/m);
  assert.match(m.text, /^Total paid: CA\$903\.10$/m);
  assert.match(m.text, /^Bought on: Website$/m);
  assert.match(m.html, /href="https:\/\/www\.linkedin\.com\/in\/jane-doe-example"/);
  assert.match(m.html, /href="mailto:jane\.doe@example\.com"/);
  // Nothing about raw click IDs or the metadata keys themselves.
  assert.doesNotMatch(m.html + m.text, /src_visit|src_first|fbclid|gclid/);
});

test("no code: \"No code\", no discount line; the amounts are Stripe's, not worked out again", () => {
  const s = powerSession({
    metadata: { promoCode: "", discount: "0" },
    amount_subtotal: 99900, amount_total: 112887, total_details: { amount_discount: 0, amount_tax: 12987 },
  });
  const m = buildPurchaseAlert({ session: s, ticketIds: ["a1b2c3d4e5f6"], paidAt: PAID_AT, site: SITE });
  assert.equal(m.subject, "New ticket: Power Pass · Jane Doe · CA$1,128.87");
  assert.match(m.text, /^Code: No code$/m);
  assert.doesNotMatch(m.text, /^Discount:/m);
  assert.match(m.text, /^HST \(13%\): CA\$129\.87$/m);
  assert.match(m.text, /^App account: Not known$/m);
  // Stripe's figure wins even if the metadata says something else.
  const odd = buildPurchaseAlert({ session: { ...s, amount_total: 100 }, ticketIds: ["x1"], site: SITE });
  assert.match(odd.subject, /CA\$1\.00$/);
});

test("a $0 checkout with a 100% code is still the buyer's: $0.00, the code, nothing to pay, no Stripe payment link", () => {
  const s = powerSession({
    metadata: { promoCode: "FULL100", discount: "100" }, payment_status: "no_payment_required", payment_intent: null,
    amount_subtotal: 99900, amount_total: 0, total_details: { amount_discount: 99900, amount_tax: 0 },
  });
  const m = buildPurchaseAlert({ session: s, ticketIds: ["f0f0f0f0f0f0"], paidAt: PAID_AT, site: SITE });
  assert.equal(m.subject, "New ticket: Power Pass · Jane Doe · CA$0.00");
  assert.match(m.text, /^Code: FULL100 \(100% off\)$/m);
  assert.match(m.text, /^Discount: −CA\$999\.00$/m);
  assert.match(m.text, /^Status: Nothing to pay: the code covered the full price$/m);
  assert.doesNotMatch(m.text, /^Stripe payment:/m);
  assert.doesNotMatch(m.html, /dashboard\.stripe\.com/);
  assert.match(m.text, /^Checkout session: cs_live_a1B2c3D4e5$/m);
});

test("channel from metadata.client; no source sent: Not known (the native apps say which app)", () => {
  const app = (client) => buildPurchaseAlert({ session: powerSession({ metadata: { client, src_visit: "", src_first: "" } }), ticketIds: ["x1"], site: SITE });
  assert.match(app("ios").text, /^Bought on: iOS app$/m);
  assert.match(app("ios").text, /^This visit: Not known \(bought in the iOS app\)$/m);
  assert.match(app("android").text, /^This visit: Not known \(bought in the Android app\)$/m);
  assert.match(app("web").text, /^This visit: Not known$/m);
  assert.match(app("web").text, /^First visit: Not known$/m);
  assert.match(app("").text, /^Bought on: Not known$/m);
  assert.deepEqual(["web", "ios", "android", "IOS", "kiosk", undefined].map(channelOf), ["Website", "iOS app", "Android app", "iOS app", "Not known", "Not known"]);
});

test("a signed-in buyer: the account and the admin link; a test-mode payment links to Stripe's test dashboard", () => {
  const s = powerSession({ livemode: false, metadata: { userId: "65f0c0ffee0000000000abcd" } });
  const m = buildPurchaseAlert({ session: s, ticketIds: ["a1b2c3d4e5f6"], account: "signed-in", site: SITE });
  assert.match(m.text, /^App account: Yes, bought while signed in$/m);
  assert.match(m.html, /https:\/\/dashboard\.stripe\.com\/test\/payments\/pi_3Q9ZexampleAbC/);
  assert.equal(buildPurchaseAlert({ session: s, account: "exists", ticketIds: ["a"] }).text.match(/^App account: (.*)$/m)[1], "Yes, an account uses this email");
  assert.equal(stripePaymentUrl({ payment_intent: { id: "pi_123abc" }, livemode: true }), "https://dashboard.stripe.com/payments/pi_123abc");
  assert.equal(stripePaymentUrl({ payment_intent: "pi_1/../evil" }), "");
  assert.equal(stripePaymentUrl({ payment_intent: null }), "");
  assert.equal(adminPersonUrl({ site: SITE, ticketId: "a1b2c3d4e5f6" }), `${SITE}/admin/people/t-a1b2c3d4e5f6`);
  assert.equal(adminPersonUrl({ site: SITE, userId: "65f0c0ffee0000000000abcd" }), `${SITE}/admin/people/u-65f0c0ffee0000000000abcd`);
  assert.equal(adminPersonUrl({ site: SITE, ticketId: "<x>" }), "");
  assert.equal(adminPersonUrl({ site: "javascript:alert(1)", ticketId: "a1b2c3d4e5f6" }), "");
});

test("a booth is labelled Booth: subject, header and section; no ticket ID", () => {
  const s = powerSession({
    metadata: { type: "booth", tier: "booth-single", promoCode: "", discount: "0", firstName: "", lastName: "", name: "", email: "", organisation: "" },
    customer_details: { email: "sales@acme.example.com", name: "Acme Robotics Inc." },
    amount_subtotal: 500000, amount_total: 565000, total_details: { amount_discount: 0, amount_tax: 65000 },
  });
  assert.equal(alertKind(s), "booth");
  const m = buildPurchaseAlert({ session: s, site: SITE });
  assert.equal(m.subject, "New booth: Exhibition Booth — Single · Acme Robotics Inc. · CA$5,650.00");
  assert.match(m.html, />New booth</);
  assert.match(m.text, /^BOOTH$/m);
  assert.match(m.text, /^Booth: Exhibition Booth — Single$/m);
  assert.doesNotMatch(m.text, /Ticket ID/);
  assert.equal(m.replyTo, "sales@acme.example.com");
});

test("everything the buyer typed and the website's source text is escaped; only http(s) links; one-line subject", () => {
  const s = powerSession({
    metadata: {
      firstName: "<script>alert(1)</script>", lastName: "Doe\r\nBcc: victim@example.com",
      organisation: "\"><img src=x onerror=alert(1)>", jobTitle: "CEO & <b>Founder</b>",
      linkedin: "javascript:alert(document.cookie)",
      src_visit: "utm: <a href=\"https://evil.example\">click</a> / x\u0000\u001b[31m \u202egnp.exe · landed /tickets",
      src_first: "x".repeat(2000),
    },
    customer_details: { email: "jane.doe@example.com", name: "Jane" },
  });
  const m = buildPurchaseAlert({ session: s, ticketIds: ["a1b2c3d4e5f6"], site: SITE });
  assert.doesNotMatch(m.html, /<script|<img|<b>|href="javascript|href="https:\/\/evil/i);
  assert.match(m.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(m.html, /&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(m.html, /CEO &amp; &lt;b&gt;Founder&lt;\/b&gt;/);
  assert.match(m.html, /utm: &lt;a href=&quot;https:\/\/evil\.example&quot;&gt;click&lt;\/a&gt;/);
  assert.doesNotMatch(m.subject, /[\r\n]/);
  assert.doesNotMatch(m.html + m.text, /[\u0000\u001b\u202e]/);
  // The LinkedIn text is shown, not linked.
  assert.match(m.text, /^LinkedIn: javascript:alert\(document\.cookie\)$/m);
  // A source line is one line of at most 500 characters.
  assert.equal(m.text.match(/^First visit: (x+)$/m)[1].length, 500);
  assert.equal(cleanLine("a\u0007b\u2066c\u200fd  e"), "a b c d e");
  assert.equal(cleanLine({ toString: () => "x" }), "");
});

test("the source fields never land in the attendee's saved details", () => {
  const d = detailsFromMetadata({ firstName: "Jane", src_visit: "landed /tickets", src_first: "direct (no referrer)" });
  assert.deepEqual(Object.keys(d).sort(), ["firstName", "source"]);
  assert.equal(d.source, "checkout");
});

test("money: Stripe's cents as CA$1,234.56", () => {
  assert.deepEqual(
    [money(112887), money(0), money(-19980), money(123456789), money(5, "cad"), money(500, "usd"), money(undefined), money("x")],
    ["CA$1,128.87", "CA$0.00", "−CA$199.80", "CA$1,234,567.89", "CA$0.05", "USD 5.00", "", ""],
  );
});

/* ---------- who gets it ---------- */

test("recipients: the four organisers by default; PURCHASE_ALERT_TO (comma-separated) replaces them", () => {
  assert.deepEqual(PURCHASE_ALERT_TO, [
    "vishwa@thetechfestival.com", "lubna@thetechfestival.com", "shweta@thetechfestival.com", "baldeep@thetechfestival.com",
  ]);
  assert.deepEqual(alertRecipients({}), [...PURCHASE_ALERT_TO]);
  assert.deepEqual(alertRecipients({ PURCHASE_ALERT_TO: "" }), [...PURCHASE_ALERT_TO]);
  assert.deepEqual(alertRecipients({ PURCHASE_ALERT_TO: " Ops@Example.com, sales@example.com ,ops@example.com, not-an-email" }),
    ["ops@example.com", "sales@example.com"]);
  // Nothing usable: the default stands (never nobody).
  assert.deepEqual(alertRecipients({ PURCHASE_ALERT_TO: "nobody, ;" }), [...PURCHASE_ALERT_TO]);
});

/* ---------- which checkouts ---------- */

test("which checkouts get one: tickets and booths; never pavilion deposits, upgrades, other types or sessions without a pass", () => {
  const s = (metadata, over = {}) => ({ id: "cs_1", mode: "payment", status: "complete", metadata, ...over });
  assert.equal(alertKind(s({ type: "ticket", tier: "power" })), "ticket");
  assert.equal(alertKind(s({ tier: "apex" })), "ticket");   // no type = a ticket, as the webhook reads it
  assert.equal(alertKind(s({ type: "booth", tier: "booth-double" })), "booth");
  assert.equal(alertKind(s({ type: "ticket", tier: "booth-single" })), "booth");
  assert.equal(alertKind(s({ type: "pavilion-deposit", companyName: "Acme" })), "");
  assert.equal(alertKind(s({ type: "pavilion-deposit", tier: "x" })), "");
  assert.equal(alertKind(s({ type: "upgrade", tier: "apex", upgradeFrom: "a1" })), "");
  assert.equal(alertKind(s({ type: "issued", tier: "connect" })), "");
  assert.equal(alertKind(s({ type: "ticket" })), "");
  assert.equal(alertKind(s({ type: "ticket", tier: "power" }, { mode: "subscription" })), "");
  assert.equal(alertKind(s({ type: "ticket", tier: "power" }, { status: "expired" })), "");
  assert.equal(alertKind({ metadata: { type: "ticket", tier: "power" } }), "");
  assert.equal(alertKind(null), "");
});

test("only the Stripe webhook sends it: no staff route or pass service imports the alert", () => {
  const files = [];
  for (const dir of ["routes", "services", "middleware", "models"]) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) if (f.endsWith(".js")) files.push(`${dir}/${f}`);
  }
  files.push("server.js");
  const importers = files.filter((f) => /from\s+["'][./]*(services\/)?purchaseAlert\.js["']/.test(fs.readFileSync(path.join(ROOT, f), "utf8")));
  assert.deepEqual(importers, ["routes/webhook.js"]);
  // In the webhook: after the ticket and after the booth confirmation, never in the upgrade or deposit branches.
  const hook = fs.readFileSync(path.join(ROOT, "routes/webhook.js"), "utf8");
  const calls = [...hook.matchAll(/alertPurchase\(\{/g)].map((x) => x.index);
  assert.equal(calls.length, 2);
  assert.ok(calls[0] > hook.indexOf('console.log("✅ Ticket created:"'), "ticket alert after the ticket is saved");
  assert.ok(calls[1] > hook.indexOf('console.log("✅ Booth purchase confirmed:"'), "booth alert after the confirmation");
  assert.ok(hook.indexOf('"pavilion-deposit"') < hook.indexOf("return res.json({ received: true });"), "deposits answer before any alert");
});

/* ---------- sending: once per session, never throws ---------- */

/** A claim store with the unique index's behaviour, and a Resend that only records. */
function fakes({ failSend = null, failClaim = false } = {}) {
  const rows = new Map();
  const outbox = [];
  const store = {
    async claim(id) {
      if (failClaim) throw new Error("database down");
      await new Promise((r) => setImmediate(r));
      if (rows.has(id)) return false;
      rows.set(id, { status: "sending" });
      return true;
    },
    async sent(id, resendId) { rows.set(id, { status: "sent", resendId }); },
    async failed(id, error) { rows.set(id, { status: "failed", error }); },
  };
  const resend = {
    emails: {
      async send(msg) {
        outbox.push(msg);
        if (failSend === "throw") throw new Error("network down");
        if (failSend === "error") return { data: null, error: { message: "Resend says no" } };
        return { data: { id: `re_${outbox.length}` }, error: null };
      },
    },
  };
  const logged = [];
  const log = { log: () => {}, error: (...a) => logged.push(a.join(" ")) };
  return { rows, outbox, store, resend, log, logged };
}

test("sends one email to everyone, from the tickets sender, reply-to the buyer; a second delivery sends nothing", async () => {
  const f = fakes();
  const looked = [];
  const alert = makePurchaseAlerter({ ...f, env: {}, site: SITE, accountFor: async (who) => { looked.push(who); return "exists"; } });
  const r = await alert({ session: powerSession(), ticketIds: ["a1b2c3d4e5f6"], paidAt: PAID_AT });
  assert.deepEqual(r, { status: "sent", id: "re_1" });
  assert.equal(f.outbox.length, 1);
  const msg = f.outbox[0];
  assert.deepEqual(msg.to, [...PURCHASE_ALERT_TO]);
  assert.equal(msg.from, ALERT_FROM);
  assert.equal(msg.from, "TechFest Canada <tickets@thetechfestival.com>");
  assert.equal(msg.reply_to, "jane.doe@example.com");
  assert.equal(msg.subject, "New ticket: Power Pass · Jane Doe · CA$903.10");
  assert.deepEqual(msg.tags, [{ name: "campaign", value: ALERT_CAMPAIGN }]);
  assert.match(msg.text, /^App account: Yes, an account uses this email$/m);
  assert.deepEqual(looked, [{ userId: "", email: "jane.doe@example.com" }]);
  assert.deepEqual(f.rows.get("cs_live_a1B2c3D4e5"), { status: "sent", resendId: "re_1" });

  assert.deepEqual(await alert({ session: powerSession(), ticketIds: ["a1b2c3d4e5f6"] }), { status: "duplicate" });
  assert.equal(f.outbox.length, 1);
});

test("deliveries at the same moment: still one email", async () => {
  const f = fakes();
  const alert = makePurchaseAlerter({ ...f, env: { PURCHASE_ALERT_TO: "ops@example.com" }, site: SITE });
  const s = powerSession({ id: "cs_live_same_moment" });
  const results = await Promise.all(Array.from({ length: 5 }, () => alert({ session: s, ticketIds: ["a1"], signedIn: true })));
  assert.deepEqual(results.map((x) => x.status).sort(), ["duplicate", "duplicate", "duplicate", "duplicate", "sent"]);
  assert.equal(f.outbox.length, 1);
  assert.deepEqual(f.outbox[0].to, ["ops@example.com"]);
  assert.match(f.outbox[0].text, /^App account: Yes, bought while signed in$/m);
});

test("skipped without a claim: pavilion deposits, upgrades and anything that isn't a ticket or booth checkout", async () => {
  const f = fakes();
  const alert = makePurchaseAlerter({ ...f, env: {}, site: SITE });
  for (const metadata of [
    { type: "pavilion-deposit", companyName: "Acme", contactEmail: "a@example.com", applicationRef: "IP-7K3QXM" },
    { type: "upgrade", tier: "apex", upgradeFrom: "a1b2c3d4e5f6", fromTier: "power" },
    { type: "issued", tier: "connect" },
  ]) {
    assert.deepEqual(await alert({ session: { id: `cs_${metadata.type}`, mode: "payment", status: "complete", metadata } }), { status: "skipped" });
  }
  assert.deepEqual(await alert({}), { status: "skipped" });
  assert.equal(f.outbox.length, 0);
  assert.equal(f.rows.size, 0);
});

test("a failure never throws: Resend refusing, Resend unreachable, the claim failing; the row says failed and isn't retried", async () => {
  for (const failSend of ["error", "throw"]) {
    const f = fakes({ failSend });
    const alert = makePurchaseAlerter({ ...f, env: {}, site: SITE });
    const r = await alert({ session: powerSession(), ticketIds: ["a1"] });
    assert.equal(r.status, "failed");
    assert.equal(f.rows.get("cs_live_a1B2c3D4e5").status, "failed");
    assert.ok(f.logged.some((l) => l.startsWith("PURCHASE ALERT ERROR:")));
    // A later delivery of the same session doesn't send it again.
    assert.deepEqual(await alert({ session: powerSession(), ticketIds: ["a1"] }), { status: "duplicate" });
    assert.equal(f.outbox.length, 1);
  }
  const f = fakes({ failClaim: true });
  const alert = makePurchaseAlerter({ ...f, env: {}, site: SITE });
  assert.equal((await alert({ session: powerSession(), ticketIds: ["a1"] })).status, "failed");
  assert.equal(f.outbox.length, 0);
  // An account lookup that fails only leaves "Not known".
  const g = fakes();
  const alert2 = makePurchaseAlerter({ ...g, env: {}, site: SITE, accountFor: () => { throw new Error("db"); } });
  assert.equal((await alert2({ session: powerSession(), ticketIds: ["a1"] })).status, "sent");
  assert.match(g.outbox[0].text, /^App account: Not known$/m);
});
