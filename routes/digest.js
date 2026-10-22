import express from "express";
import User from "../models/User.js";
import { AdminAudit } from "../models/Admin.js";
import { requireAdmin, requireManagement, isManagement } from "../middleware/adminAuth.js";
import { makeLimiter } from "../services/ticketAccess.js";
import { usableEmail } from "../services/attendingCampaign.js";
import { escapeHtml as esc } from "../services/ticketInfo.js";
import {
  digestStatus, setDigestEnabled, missedFor, verifyUnsubscribe, unsubscribeUrl, RUN_LIMIT, SEND_GAP_MS,
} from "../services/digest.js";
import { buildDigestEmail, sendDigestEmail, SAMPLE_ITEMS } from "../services/digestEmail.js";
import { MAX_PER_DAY, QUIET_FROM, QUIET_TO } from "../services/digestRules.js";
import { RIGHTS_SELECT } from "../services/rightsStore.js";

/* =========================================================
   "What you missed" emails (Oct 22 2026), services/digest.js.

   Public (the email's links, no sign-in; the token says whose):
     POST /api/app/digest/unsubscribe?t=<token>   one click (List-Unsubscribe-Post): "Email me a summary of
                                                  what I missed" off → 200 { ok: true }
     GET  /api/app/digest/unsubscribe?t=<token>   a page with one button that does the same (mail scanners
                                                  open links, so a GET never changes anything)

   Admin › Website & app › "What you missed" emails (/api/console/digest, staff):
     GET  /            → { enabled, sentToday, failedToday, waiting, dailyCap, day, lastRun, canEdit, rules }
     PUT  / { enabled } (management) → the same; audited digest_on / digest_off
     POST /preview     → { subject, preheader, html, text, sample } built from your own app activity of the
                         last 2 days (whatever you've seen too), else made-up sample items
     POST /test        → { sent, to, sample } the same, to your own email, "[Test] " (not counted, nothing marked)
========================================================= */

export const publicRouter = express.Router();
export const adminRouter = express.Router();

const offPerIp = makeLimiter({ max: 30, windowMs: 15 * 60 * 1000 });
const testPerStaff = makeLimiter({ max: 10, windowMs: 60 * 60 * 1000 });

async function turnOff(token) {
  const id = verifyUnsubscribe(token);
  if (!id) return false;
  await User.updateOne({ _id: id }, { $set: { "notifyPrefs.digestEmail": false } });
  return true;
}

const page = (title, body) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#06020f;color:#ddd5ef;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{max-width:420px;padding:32px 24px;text-align:center}h1{color:#fff;font-size:22px}button,a.b{display:inline-block;margin-top:18px;padding:14px 26px;border:0;border-radius:999px;background:#e8458b;color:#fff;font-size:16px;font-weight:700;text-decoration:none;cursor:pointer}</style></head>
<body><main>${body}</main></body></html>`;

publicRouter.post("/unsubscribe", express.urlencoded({ extended: false, limit: "2kb" }), async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!offPerIp.hit(req.ip || "?")) return res.status(429).json({ error: "Too many requests. Try again in a few minutes." });
  const ok = await turnOff(String(req.query.t || req.body?.t || ""));
  if (!ok) return res.status(400).json({ error: "That link isn't valid any more. Turn these emails off in the app: Settings › Notifications." });
  if (req.is("application/x-www-form-urlencoded") && req.body?.from === "page") {
    return res.type("html").send(page("Done", `<h1>Done</h1><p>You won't get "What you missed" emails any more. You can turn them back on in the TTFC app: Settings › Notifications.</p><a class="b" href="https://www.thetechfestival.com/app/">Open TTFC</a>`));
  }
  res.json({ ok: true });
});

publicRouter.get("/unsubscribe", (req, res) => {
  res.set("Cache-Control", "no-store");
  const t = String(req.query.t || "");
  if (!verifyUnsubscribe(t)) {
    return res.status(400).type("html").send(page("Link not valid", `<h1>This link isn't valid any more</h1><p>Turn these emails off in the TTFC app: Settings › Notifications.</p>`));
  }
  res.type("html").send(page("Turn off these emails", `<h1>Turn off "What you missed" emails?</h1><p>You'll still get pushes and everything else in the app.</p>
<form method="post" action="?t=${esc(encodeURIComponent(t))}"><input type="hidden" name="from" value="page"><button type="submit">Turn them off</button></form>`));
});

/* ---------- admin ---------- */

adminRouter.use(requireAdmin);

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error("DIGEST ADMIN ERROR:", err?.message || err);
  if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Try again." });
});

async function audit(req, action, detail = "") {
  await AdminAudit.create({
    adminId: req.user._id, adminName: req.user.name, action, targetType: "campaign", targetId: "digest", detail: String(detail).slice(0, 500),
  }).catch(() => {});
}

const RULES = Object.freeze({
  delayHours: 3, fivePm: "5:00 PM", skipWindow: "4:00–5:00 PM (the 5 PM one covers it)",
  quietHours: `${QUIET_FROM - 12}:00 PM – ${QUIET_TO}:00 AM (due then → ${QUIET_TO}:00 AM)`, minGapMinutes: 60, maxPerDay: MAX_PER_DAY,
  perRun: RUN_LIMIT, sendGapMs: SEND_GAP_MS, timezone: "America/Toronto",
});

const statusPayload = async (req) => ({ ...(await digestStatus()), canEdit: isManagement(req.user), rules: RULES });

adminRouter.get("/", wrap(async (req, res) => res.json(await statusPayload(req))));

adminRouter.put("/", requireManagement, wrap(async (req, res) => {
  if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ error: "enabled must be true or false" });
  await setDigestEnabled(req.body.enabled, req.user?.name || req.user?.email || "");
  await audit(req, req.body.enabled ? "digest_on" : "digest_off");
  res.json(await statusPayload(req));
}));

/** Their own last 2 days in the app (seen or not), else the sample. */
async function previewItems(req) {
  const me = await User.findById(req.user._id).select(`${RIGHTS_SELECT} email appOnboarded activitySeen notifyPrefs`).lean();
  const now = new Date();
  const own = me ? await missedFor({ ...me, lastActiveAt: null, activitySeen: {} }, { since: new Date(now.getTime() - 48 * 3_600_000), now }) : [];
  return own.length ? { items: own, sample: false } : { items: SAMPLE_ITEMS, sample: true };
}

adminRouter.post("/preview", wrap(async (req, res) => {
  const { items, sample } = await previewItems(req);
  const e = buildDigestEmail({ firstName: String(req.user?.name || "").split(/\s+/)[0], items, unsubscribeUrl: unsubscribeUrl(req.user._id) });
  res.json({ subject: e.subject, preheader: e.preheader, html: e.html, text: e.text, sections: e.sections, sample });
}));

adminRouter.post("/test", wrap(async (req, res) => {
  const to = usableEmail(req.user?.email);
  if (!to) return res.status(400).json({ error: "Your staff account has no email address to send a test to." });
  if (!testPerStaff.hit(String(req.user._id))) return res.status(429).json({ error: "That's a lot of test emails. Try again in an hour." });
  const { items, sample } = await previewItems(req);
  try {
    await sendDigestEmail({ to, firstName: String(req.user?.name || "").split(/\s+/)[0], items, unsubscribeUrl: unsubscribeUrl(req.user._id), subjectPrefix: "[Test] " });
  } catch (err) {
    await audit(req, "digest_test_failed", `${to}: ${err?.message || err}`);
    return res.status(502).json({ error: `Couldn't send: ${err?.message || "the email service refused it"}` });
  }
  await audit(req, "digest_test", to);
  res.json({ sent: true, to, sample });
}));

export default adminRouter;
