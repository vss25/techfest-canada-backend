/* =========================================================
   "New ticket" email to the organisers
   ---------------------------------------------------------
   The organiser (Oct 19 2026): email Vishwa, Lubna, Shweta and
   Baldeep every time a ticket is purchased, with who bought, the
   code they applied, what they paid and where they came from; none
   for passes staff issue.

   Sent only from the Stripe webhook (routes/webhook.js), after a
   completed ticket or booth checkout is saved and the buyer's own
   email has gone. Passes staff make (Issue passes, exhibitor,
   speaker and complimentary passes, imports, Stripe sync) never come
   through here: only the webhook imports this file
   (test/purchase-alert.test.js checks). Not for India Pavilion
   deposits or pass upgrades.

   - One email to everyone in PURCHASE_ALERT_TO (comma-separated;
     default the four organisers), reply-to the buyer.
   - At most one per Checkout Session, even when Stripe delivers the
     event twice or twice at once: a CampaignSend row (campaign
     "purchase-alert-2026", email = the session id; unique index) is
     claimed before Resend is called. A failed send is marked
     "failed" on that row and not retried.
   - Amounts are Stripe's own (subtotal, discount, tax, total), never
     worked out again here.
   - Everything the buyer typed, and the source text the website
     sends (metadata src_visit / src_first), is untrusted: cleaned to
     one line and HTML-escaped; only http(s) links are clickable.
   - Never throws: a failure is logged and never touches the ticket,
     the buyer's email or the webhook's answer.

   Pure parts unit-tested in test/purchase-alert.test.js; through the
   webhook in test/purchase-alert-db.test.js.
========================================================= */

import { Resend } from "resend";
import { C, SANS, DISPLAY, MONO } from "./ticketEmail.js";
import { EVENT, displayPassName, escapeHtml as esc } from "./ticketInfo.js";
import { detailsFromMetadata, displayName } from "./attendeeDetails.js";
import { safeHttpUrl } from "./formSubmissions.js";

export const PURCHASE_ALERT_TO = Object.freeze([
  "vishwa@thetechfestival.com",
  "lubna@thetechfestival.com",
  "shweta@thetechfestival.com",
  "baldeep@thetechfestival.com",
]);
export const ALERT_CAMPAIGN = "purchase-alert-2026";
export const ALERT_FROM = "TechFest Canada <tickets@thetechfestival.com>";
const SITE = String(process.env.FRONTEND_URL || EVENT.website).replace(/\/+$/, "");

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;

/** One line of untrusted text: control and text-direction characters out, spaces collapsed, at most `max` characters. */
export function cleanLine(v, max = 500) {
  if (v == null || (typeof v !== "string" && typeof v !== "number")) return "";
  return String(v)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, max).trim();
}

/** Who gets it: PURCHASE_ALERT_TO (comma-separated) when it holds a valid address, else the four organisers. */
export function alertRecipients(env = process.env) {
  const list = String(env?.PURCHASE_ALERT_TO || "").split(",")
    .map((s) => cleanLine(s, 200).toLowerCase()).filter((s) => EMAIL_RE.test(s));
  return list.length ? [...new Set(list)] : [...PURCHASE_ALERT_TO];
}

/**
 * "ticket" | "booth" for a completed Checkout Session that gets the email, else "".
 * The webhook's own reading: no type = a ticket. Upgrades, India Pavilion deposits and anything else: "".
 */
export function alertKind(session) {
  const meta = session?.metadata || {};
  const type = String(meta.type || "ticket").trim().toLowerCase();
  const tier = String(meta.tier || "").trim().toLowerCase();
  if (!session?.id || !tier) return "";
  if (session.mode && session.mode !== "payment") return "";
  if (session.status && session.status !== "complete") return "";
  if (type === "booth") return "booth";
  if (type === "ticket") return tier.startsWith("booth-") ? "booth" : "ticket";
  return "";
}

/** Stripe's minor units → "CA$1,234.56" ("−CA$12.00" below zero; other currencies "USD 12.00"). "" when not a number. */
export function money(cents, currency = "cad") {
  if (cents === null || cents === undefined || cents === "") return "";
  const n = Number(cents);
  if (!Number.isFinite(n)) return "";
  const cur = String(currency || "cad").trim().toUpperCase();
  const abs = Math.abs(Math.round(n));
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const prefix = cur === "CAD" ? "CA$" : `${cur} `;
  return `${n < 0 ? "−" : ""}${prefix}${whole}.${String(abs % 100).padStart(2, "0")}`;
}

const CHANNELS = { web: "Website", ios: "iOS app", android: "Android app" };
/** metadata.client → "Website" | "iOS app" | "Android app" | "Not known". */
export const channelOf = (client) => CHANNELS[String(client || "").trim().toLowerCase()] || "Not known";

const ACCOUNT = {
  "signed-in": "Yes, bought while signed in",
  exists: "Yes, an account uses this email",
  none: "No account yet",
};

const torontoTime = (d) => new Date(d || Date.now()).toLocaleString("en-CA", {
  timeZone: "America/Toronto", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});

/** The payment in the Stripe dashboard, or "" ($0 checkouts have no payment). */
export function stripePaymentUrl(session) {
  const pi = typeof session?.payment_intent === "string" ? session.payment_intent : session?.payment_intent?.id;
  if (!/^pi_[A-Za-z0-9]+$/.test(String(pi || ""))) return "";
  return `https://dashboard.stripe.com/${session.livemode === false ? "test/" : ""}payments/${pi}`;
}

/** Admin › People profile: whoever holds the ticket (t-<ticket ID>), else the buyer's account (u-<id>), else "". */
export function adminPersonUrl({ site = SITE, ticketId = "", userId = "" } = {}) {
  const base = safeHttpUrl(site).replace(/\/+$/, "");
  if (!base) return "";
  if (/^[A-Za-z0-9-]{4,40}$/.test(String(ticketId))) return `${base}/admin/people/t-${encodeURIComponent(ticketId)}`;
  if (/^[a-f0-9]{24}$/i.test(String(userId))) return `${base}/admin/people/u-${userId}`;
  return "";
}

/**
 * The email.
 * @param {object} p
 * @param {object} p.session    the completed Stripe Checkout Session (amounts, customer_details, metadata)
 * @param {string} [p.kind]     "ticket" | "booth" (alertKind)
 * @param {string[]} [p.ticketIds]
 * @param {string} [p.account]  "signed-in" | "exists" | "none" | "" (not known)
 * @param {Date}   [p.paidAt]   when Stripe said it was paid (the event's time)
 * @param {string} [p.site]     the website, for the Admin › People link
 * @returns {{ subject, preheader, html, text, replyTo }}
 */
export function buildPurchaseAlert({ session = {}, kind = alertKind(session), ticketIds = [], account = "", paidAt, site = SITE } = {}) {
  const meta = session.metadata || {};
  const d = detailsFromMetadata(meta) || {};
  const cd = session.customer_details || {};
  const line = (v, max) => cleanLine(v, max);
  const isBooth = kind === "booth";

  const email = line(cd.email || session.customer_email || meta.email, 200).toLowerCase();
  const formEmail = line(meta.email, 200).toLowerCase();
  const billingName = line(cd.name, 120);
  const formName = line(displayName(d), 120);
  const name = formName || billingName || email || "Someone";
  const fullName = formName && d.salutation ? `${line(d.salutation, 20)} ${formName}` : name;
  const org = line(d.organisation, 120);

  const pass = displayPassName(line(meta.tier, 40));
  const ids = (Array.isArray(ticketIds) ? ticketIds : [ticketIds]).map((t) => line(t, 40)).filter(Boolean);

  const code = line(meta.promoCode, 40).toUpperCase();
  const pct = Number(meta.discount);
  const codeText = code ? `${code}${pct > 0 ? ` (${pct}% off)` : ""}` : "No code";

  const cur = String(session.currency || "cad");
  const total = money(session.amount_total, cur);
  const discount = Number(session.total_details?.amount_discount) || 0;
  const taxPct = Number(meta.taxPercent);
  const taxLabel = String(meta.taxMode || "manual") === "manual" && taxPct > 0 ? `HST (${taxPct}%)` : "Tax";
  const status = session.payment_status === "paid" ? "Paid"
    : session.payment_status === "no_payment_required" ? (code ? "Nothing to pay: the code covered the full price" : "Nothing to pay")
    : session.payment_status === "unpaid" ? "Not confirmed yet: Stripe is still processing the payment"
    : "Not known";

  const channel = channelOf(meta.client);
  const app = channel.endsWith(" app");
  const unknownSource = app ? `Not known (bought in the ${channel})` : "Not known";
  const visit = line(meta.src_visit) || unknownSource;
  const first = line(meta.src_first) || "Not known";

  const when = `${torontoTime(paidAt || (session.created ? session.created * 1000 : Date.now()))} (Toronto)`;
  const pi = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id || "";
  const stripeUrl = stripePaymentUrl(session);
  const personUrl = adminPersonUrl({ site, ticketId: ids[0], userId: account === "signed-in" ? line(meta.userId, 40) : "" });

  const link = (href, label) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" style="color:#c9b8f2;text-decoration:underline;">${esc(label)}</a>`;
  const mail = (e) => (EMAIL_RE.test(e) ? `<a href="mailto:${esc(e)}" style="color:#c9b8f2;text-decoration:underline;">${esc(e)}</a>` : esc(e));
  const mono = (v) => `<span style="font-family:${MONO};color:${C.gold};">${esc(v)}</span>`;
  const linkedin = line(d.linkedin, 300);
  const linkedinHref = safeHttpUrl(linkedin);
  const list = (v) => (Array.isArray(v) ? v.map((x) => line(x, 120)).filter(Boolean).join("; ") : "");

  // [label, plain text, optional html]; a row with no text is left out.
  const sections = [
    ["Buyer", [
      ["Name", fullName],
      ["Email", email, mail(email)],
      formEmail && formEmail !== email ? ["Email on the form", formEmail, mail(formEmail)] : null,
      ["Phone", line(d.phone || cd.phone, 40)],
      ["Job title", line(d.jobTitle, 120)],
      ["Organisation", org],
      ["Job level", line(d.jobLevel, 160)],
      ["Job function", line(d.jobFunction, 120)],
      ["Country", line(d.country, 80)],
      ["LinkedIn", linkedin, linkedinHref ? link(linkedinHref, linkedin) : ""],
      ["Topics", list(d.topics)],
      ["Objectives", list(d.objectives)],
      typeof d.consentUpdates === "boolean" ? ["Agreed to updates", d.consentUpdates ? "Yes" : "No"] : null,
      billingName && billingName.toLowerCase() !== formName.toLowerCase() && formName ? ["Name on the payment", billingName] : null,
      ["App account", ACCOUNT[account] || "Not known"],
    ]],
    [isBooth ? "Booth" : "Pass", [
      [isBooth ? "Booth" : "Pass", pass],
      ...(isBooth ? [] : [[ids.length > 1 ? "Ticket IDs" : "Ticket ID", ids.join(", "), ids.map((t) => mono(t)).join(", ")]]),
    ]],
    ["Payment", [
      ["Code", codeText],
      ["Subtotal", money(session.amount_subtotal, cur)],
      discount > 0 ? ["Discount", money(-discount, cur)] : null,
      [taxLabel, money(Number(session.total_details?.amount_tax) || 0, cur)],
      ["Total paid", total || "Not known", total ? `<strong style="color:#ffffff;">${esc(total)}</strong>` : ""],
      ["Currency", cur.toUpperCase()],
      ["Status", status],
    ]],
    ["Where they came from", [
      ["Bought on", channel],
      ["This visit", visit],
      ["First visit", first],
    ]],
    ["Reference", [
      ["Time", when],
      ["Stripe payment", stripeUrl ? `${pi} (${stripeUrl})` : pi, pi ? `${mono(pi)}${stripeUrl ? `<br>${link(stripeUrl, "Open in Stripe")}` : ""}` : ""],
      ["Checkout session", line(session.id, 120), mono(line(session.id, 120))],
      ["Admin panel", personUrl, personUrl ? link(personUrl, `Open ${name} in Admin › People`) : ""],
    ]],
  ].map(([title, rows]) => [title, rows.filter((r) => r && r[1])]);

  const word = isBooth ? "booth" : "ticket";
  const subject = cleanLine(`New ${word}: ${pass} · ${name} · ${total || "amount not known"}`, 200);
  const preheader = cleanLine(`${codeText} · ${channel} · ${visit}`, 200);
  const replyTo = EMAIL_RE.test(email) ? email : "";
  const replyNote = replyTo
    ? `Reply to this email to write to ${name} directly.`
    : "No email address came with this purchase, so replying won't reach the buyer.";

  const sectionHtml = ([title, rows]) => `
<tr><td bgcolor="${C.panel}" class="em-pad" style="background:${C.panel};padding:22px 32px 4px;">
  <div style="font-family:${SANS};font-size:11px;line-height:14px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:#c2a9f5;margin:0 0 6px;">${esc(title)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
    ${rows.map(([k, plain, rich]) => `<tr>
      <td valign="top" style="padding:8px 14px 8px 0;border-bottom:1px solid ${C.hair};font-family:${SANS};font-size:13px;line-height:20px;color:${C.muted};width:150px;">${esc(k)}</td>
      <td valign="top" style="padding:8px 0;border-bottom:1px solid ${C.hair};font-family:${SANS};font-size:14px;line-height:20px;color:${C.text};word-break:break-word;">${rich || esc(plain)}</td>
    </tr>`).join("\n    ")}
  </table>
  ${title === "Where they came from" ? `<div style="font-family:${SANS};font-size:12px;line-height:18px;color:${C.dim};margin:8px 0 0;">First visit is only known for visitors who chose Accept All in the cookie banner.</div>` : ""}
</td></tr>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<style>
  body { margin:0; padding:0; -webkit-text-size-adjust:100%; }
  a[x-apple-data-detectors] { color:inherit !important; text-decoration:none !important; }
  @media only screen and (max-width:620px) { .em-pad { padding-left:20px !important; padding-right:20px !important; } }
</style>
</head>
<body style="margin:0;padding:0;background:${C.bg};" bgcolor="${C.bg}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${C.bg};">${esc(preheader)}&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.bg}" style="background:${C.bg};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border-radius:18px;overflow:hidden;">

<tr><td bgcolor="${C.dark}" class="em-pad" style="background:${C.dark};background-image:radial-gradient(circle at 90% 0%,rgba(122,63,209,0.55),rgba(6,2,15,0) 60%);padding:24px 32px 22px;">
  <div style="font-family:${DISPLAY};font-size:15px;line-height:20px;font-weight:800;letter-spacing:2px;color:#ffffff;">TTFC 2026 <span style="font-family:${SANS};font-size:10px;font-weight:600;letter-spacing:2.4px;color:#c9b8f2;">&nbsp;THE TECH FESTIVAL CANADA</span></div>
  <div style="font-family:${SANS};font-size:11px;line-height:14px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:${C.gold};margin:18px 0 0;">New ${word}</div>
  <div style="font-family:${SANS};font-size:24px;line-height:30px;font-weight:800;color:#ffffff;margin:6px 0 0;">${esc(pass)} &middot; ${esc(total || "amount not known")}</div>
  <div style="font-family:${SANS};font-size:15px;line-height:22px;color:#ddd3f5;margin:4px 0 0;">${esc(fullName)}${org ? ` &middot; ${esc(org)}` : ""} &middot; ${esc(codeText)}</div>
</td></tr>
<tr><td height="4" bgcolor="${C.pink}" style="height:4px;line-height:4px;font-size:0;background:${C.pink};background-image:linear-gradient(90deg,${C.purple},${C.pink} 60%,${C.gold});">&nbsp;</td></tr>
${sections.map(sectionHtml).join("")}
<tr><td bgcolor="${C.panel}" class="em-pad" style="background:${C.panel};padding:18px 32px 26px;">
  <div style="font-family:${SANS};font-size:13px;line-height:20px;color:${C.text};">${esc(replyNote)}</div>
</td></tr>
<tr><td bgcolor="${C.dark}" class="em-pad" style="background:${C.dark};padding:18px 32px;">
  <div style="font-family:${SANS};font-size:11px;line-height:16px;color:#7f74a3;">Sent automatically to the TTFC team for every pass or booth bought at checkout on the website or in the apps. Passes issued by staff are never included.</div>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    `New ${word}: ${pass} · ${total || "amount not known"}`,
    `${fullName}${org ? ` · ${org}` : ""} · ${codeText}`,
    ...sections.flatMap(([title, rows]) => ["", title.toUpperCase(), ...rows.map(([k, plain]) => `${k}: ${plain}`)]),
    "",
    replyNote,
  ].join("\n");

  return { subject, preheader, html, text, replyTo };
}

/** The claim rows in CampaignSend (unique campaign + email; email = the session id, lowercased by the model). */
export function alertStore(CampaignSend, campaign = ALERT_CAMPAIGN) {
  const key = (id) => String(id).trim().toLowerCase();
  return {
    /** True when this delivery may send; false when another one has (or is sending) it. */
    async claim(sessionId) {
      try {
        await CampaignSend.create({ campaign, email: key(sessionId), status: "sending", attempts: 1, lastTriedAt: new Date(), sentBy: "stripe-webhook" });
        return true;
      } catch (err) {
        if (err?.code === 11000) return false;
        throw err;
      }
    },
    async sent(sessionId, resendId = "") {
      await CampaignSend.updateOne({ campaign, email: key(sessionId) }, { $set: { status: "sent", sentAt: new Date(), resendId, error: "" }, $inc: { sends: 1 } });
    },
    async failed(sessionId, error = "") {
      await CampaignSend.updateOne({ campaign, email: key(sessionId) }, { $set: { status: "failed", error: String(error).slice(0, 300) } });
    },
  };
}

/** A Resend client made on first use (so a missing key only fails the send, which is caught). */
export function lazyResend(key = () => process.env.RESEND_API_KEY) {
  let client = null;
  return { emails: { send: (msg) => (client ||= new Resend(key())).emails.send(msg) } };
}

/**
 * alertPurchase({ session, ticketIds, signedIn, paidAt }) → { status: "sent" | "duplicate" | "skipped" | "failed", … }.
 * Never throws.
 * @param {object} deps
 * @param {object} deps.store       alertStore(CampaignSend) or a fake with claim / sent / failed
 * @param {object} deps.resend      { emails: { send(msg) → { data, error } } } (a Resend client)
 * @param {(who: {userId, email}) => Promise<"signed-in"|"exists"|"none">} [deps.accountFor]
 * @param {object} [deps.env]       for PURCHASE_ALERT_TO
 */
export function makePurchaseAlerter({ store, resend, accountFor = async () => "", env = process.env, site = SITE, log = console }) {
  return async function alertPurchase({ session, ticketIds = [], signedIn = false, paidAt } = {}) {
    const id = String(session?.id || "");
    try {
      const kind = alertKind(session);
      if (!kind) return { status: "skipped" };
      if (!(await store.claim(id))) return { status: "duplicate" };
      try {
        const email = cleanLine(session.customer_details?.email || session.customer_email || session.metadata?.email, 200).toLowerCase();
        let account = signedIn ? "signed-in" : "";
        if (!account) account = await Promise.resolve().then(() => accountFor({ userId: cleanLine(session.metadata?.userId, 40), email })).catch(() => "");
        const mail = buildPurchaseAlert({ session, kind, ticketIds, account, paidAt, site });
        const { data, error } = (await resend.emails.send({
          from: ALERT_FROM,
          to: alertRecipients(env),
          ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
          tags: [{ name: "campaign", value: ALERT_CAMPAIGN }],
        })) || {};
        if (error) throw new Error(error.message || "Resend refused the email");
        if (!data?.id) throw new Error("Resend did not accept the email");
        await Promise.resolve().then(() => store.sent(id, data.id))
          .catch((err) => log.error?.("PURCHASE ALERT: sent but not recorded:", id, err?.message || err));
        log.log?.("📣 Purchase alert sent:", id);
        return { status: "sent", id: data.id };
      } catch (err) {
        await Promise.resolve().then(() => store.failed(id, err?.message || err)).catch(() => {});
        throw err;
      }
    } catch (err) {
      log.error?.("PURCHASE ALERT ERROR:", id, err?.message || err);
      return { status: "failed", error: String(err?.message || err) };
    }
  };
}
