import express from "express";
import Subscription from "../models/Subscription.js";
import { makeLimiter } from "../services/ticketAccess.js";
import { escapeHtml as esc } from "../services/ticketInfo.js";
import { maskEmail, recordUnsubscribe, verifyUnsubscribe } from "../services/unsubscribe.js";

/* =========================================================
   /api/unsubscribe: the link in every TTFC bulk email (Oct 22 2026)
   Public, no sign-in: the signed token says whose address it is
   (services/unsubscribe.js). Mounted before the kill switch, so it
   works while the site is offline.

   GET  /?t=<token>   a page with one button (mail scanners open links, so a GET never changes anything)
   POST /?t=<token>   unsubscribes: the page's button (form field from=page → a "Done" page), or a mail app's own
                      Unsubscribe button (RFC 8058: body "List-Unsubscribe=One-Click") → 200 { ok: true }
   GET  /preview      what the link in a preview or a [Test] send opens: says so, changes nothing
   30 an IP per 15 minutes. A token that isn't ours → 400 with how else to unsubscribe.
========================================================= */

const router = express.Router();
const perIp = makeLimiter({ max: 30, windowMs: 15 * 60 * 1000 });
const CONTACT = "enquire@thetechfestival.com";
const SITE = "https://www.thetechfestival.com";

const page = (title, body) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#06020f;color:#ddd5ef;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{max-width:440px;padding:32px 24px;text-align:center}h1{color:#fff;font-size:22px;line-height:1.3}p{line-height:1.55}a{color:#fff}button,a.b{display:inline-block;margin-top:18px;padding:14px 26px;border:0;border-radius:999px;background:#e8458b;color:#fff;font-size:16px;font-weight:700;text-decoration:none;cursor:pointer}</style></head>
<body><main>${body}</main></body></html>`;

const invalid = () => page("Link not valid", `<h1>This link isn't valid</h1><p>To stop getting emails from The Tech Festival Canada, reply to any of our emails with "unsubscribe" or write to <a href="mailto:${CONTACT}?subject=unsubscribe">${CONTACT}</a>.</p>`);

function noStore(res) {
  res.set("Cache-Control", "no-store");
  res.set("X-Robots-Tag", "noindex");
}

router.get("/preview", (req, res) => {
  noStore(res);
  res.type("html").send(page("Unsubscribe link (preview)", `<h1>This is the unsubscribe link from a preview</h1><p>In a real email it takes the person to a page with one button that stops our emails to their address. Nothing has changed.</p>`));
});

router.get("/", (req, res) => {
  noStore(res);
  const t = String(req.query.t || "");
  const email = verifyUnsubscribe(t);
  if (!email) return res.status(400).type("html").send(invalid());
  res.type("html").send(page("Unsubscribe", `<h1>Unsubscribe from The Tech Festival Canada emails?</h1><p>We'll stop sending announcements, invitations and reminders to <strong>${esc(maskEmail(email))}</strong>. Emails you ask for, like your pass or a sign-in code, still arrive.</p>
<form method="post" action="?t=${esc(encodeURIComponent(t))}"><input type="hidden" name="from" value="page"><button type="submit">Unsubscribe</button></form>`));
});

router.post("/", express.urlencoded({ extended: false, limit: "2kb" }), async (req, res) => {
  noStore(res);
  if (!perIp.hit(req.ip || "?")) return res.status(429).json({ error: "Too many requests. Try again in a few minutes." });
  const fromPage = req.body?.from === "page";
  const email = verifyUnsubscribe(String(req.query.t || req.body?.t || ""));
  if (!email) {
    return fromPage ? res.status(400).type("html").send(invalid()) : res.status(400).json({ error: `That link isn't valid. Write to ${CONTACT} to unsubscribe.` });
  }
  try {
    await recordUnsubscribe(Subscription, email, { source: fromPage ? "link" : "one-click" });
  } catch (err) {
    console.error("UNSUBSCRIBE ERROR:", err?.message || err);
    return fromPage
      ? res.status(500).type("html").send(page("Try again", `<h1>That didn't work</h1><p>Please try again in a minute, or write to <a href="mailto:${CONTACT}?subject=unsubscribe">${CONTACT}</a>.</p>`))
      : res.status(500).json({ error: "Try again." });
  }
  if (!fromPage) return res.json({ ok: true });
  res.type("html").send(page("Unsubscribed", `<h1>You're unsubscribed</h1><p>You won't get any more announcements, invitations or reminders from The Tech Festival Canada at <strong>${esc(maskEmail(email))}</strong>. Changed your mind? Write to <a href="mailto:${CONTACT}">${CONTACT}</a>.</p><a class="b" href="${SITE}">thetechfestival.com</a>`));
});

export default router;
