import express from "express";
import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import Subscription from "../models/Subscription.js";
import CampaignSend from "../models/CampaignSend.js";
import { AdminAudit } from "../models/Admin.js";
import { requireAdmin, requireManagement } from "../middleware/adminAuth.js";
import { makeLimiter } from "../services/ticketAccess.js";
import { sendSequentially } from "../services/profileRequest.js";
import {
  CAMPAIGN_KEY, SAMPLE_RECIPIENT, planRecipients, sendCounts, usableEmail, withSendStatus,
} from "../services/attendingCampaign.js";
import { attendingEmailFor, sendAttendingEmail } from "../services/attendingEmail.js";

/* =========================================================
   /api/console/attending-campaign: the "I'm attending" email
   (Admin → Marketing → I'm attending campaign). Staff only;
   sending is management only and audited.

   GET  /preview-sample      → { to: "", subject, html, text, link } (Jane Doe, made up)
   GET  /recipients          → { counts, skipped, recipients: [{ email, name, title, company,
                                 tiers, sources, status, sentAt, error }], job }
   POST /send-test { to }    → { sent: true, to } (the sample, subject "[Test] …"; not recorded)
   POST /send-all { confirm: "SEND" }
                             → 202 { started: true, toSend, alreadySent, unconfirmed }
                               Runs in the background; poll /recipients (job + counts).

   Re-running never double-sends: each recipient is claimed in
   CampaignSend (unique campaign + email) before Resend is called,
   "sent" and "sending" rows are skipped, "failed" ones are retried.
   Sends are spaced 600 ms apart (Resend allows ~2 a second).
   Nothing here is called automatically.
========================================================= */

const router = express.Router();
router.use(requireAdmin);

export const SEND_GAP_MS = 600;
const testPerAdmin = makeLimiter({ max: 10, windowMs: 60 * 60 * 1000 });

async function audit(req, action, detail = "") {
  await AdminAudit.create({
    adminId: req.user._id, adminName: req.user.name, action, targetType: "campaign",
    targetId: CAMPAIGN_KEY, detail: String(detail).slice(0, 500),
  }).catch(() => {});
}

/** The live recipient list (tickets now), with each person's send status. */
async function currentRecipients() {
  const [users, guests, optedOut, sends] = await Promise.all([
    User.find({ "tickets.0": { $exists: true } }).select("name email jobTitle organization banned tickets").lean(),
    Attendee.find({}).select("name email ticketId ticketType details hiddenByStaff purchaseDate").lean(),
    Subscription.find({ subscribed: false }).select("email").lean(),
    CampaignSend.find({ campaign: CAMPAIGN_KEY }).select("email status sentAt error attempts").lean(),
  ]);
  const { recipients, skipped } = planRecipients({ users, guests, optedOut: optedOut.map((s) => s.email) });
  const rows = withSendStatus(recipients, sends);
  return { rows, skipped, counts: sendCounts(rows) };
}

/* One background send at a time (per server). Progress is also in CampaignSend, so it survives a restart. */
let job = { running: false, startedAt: null, finishedAt: null, by: "", total: 0, sent: 0, failed: 0, skipped: 0 };
const jobView = () => ({ ...job });

router.get("/preview-sample", (req, res) => {
  const { subject, html, text, link } = attendingEmailFor(SAMPLE_RECIPIENT, { inline: true });
  res.json({ to: "", subject, html, text, link });
});

router.get("/recipients", async (req, res) => {
  const { rows, skipped, counts } = await currentRecipients();
  res.json({
    counts,
    skipped,
    recipients: rows.map(({ email, name, title, company, tiers, sources, status, sentAt, error }) =>
      ({ email, name, title, company, tiers, sources, status, sentAt, error })),
    job: jobView(),
  });
});

router.post("/send-test", requireManagement, async (req, res) => {
  const to = usableEmail(req.body?.to);
  if (!to) return res.status(400).json({ error: "Enter a valid email address." });
  if (!testPerAdmin.hit(String(req.user._id))) return res.status(429).json({ error: "That's a lot of test emails. Try again in an hour." });
  try {
    await sendAttendingEmail({ to, recipient: SAMPLE_RECIPIENT, subjectPrefix: "[Test] " });
  } catch (err) {
    await audit(req, "attending_campaign_test_failed", `${to}: ${err?.message || err}`);
    return res.status(502).json({ error: `Couldn't send: ${err?.message || "the email service refused it"}` });
  }
  await audit(req, "attending_campaign_test", to);
  res.json({ sent: true, to });
});

/** Claims one recipient for this run. False = already sent (or being sent) by another run. */
async function claim(r, by) {
  const now = new Date();
  const retry = await CampaignSend.updateOne(
    { campaign: CAMPAIGN_KEY, email: r.email, status: "failed" },
    { $set: { status: "sending", name: r.name || "", lastTriedAt: now, sentBy: by }, $inc: { attempts: 1 } },
  );
  if (retry.matchedCount) return true;
  try {
    await CampaignSend.create({ campaign: CAMPAIGN_KEY, email: r.email, name: r.name || "", status: "sending", attempts: 1, lastTriedAt: now, sentBy: by });
    return true;
  } catch (err) {
    if (err?.code === 11000) return false; // a row exists and isn't "failed": sent, or in flight
    throw err;
  }
}

async function sendOne(r, by) {
  if (!(await claim(r, by))) { job.skipped++; return; }
  try {
    const data = await sendAttendingEmail({ to: r.email, recipient: r });
    await CampaignSend.updateOne({ campaign: CAMPAIGN_KEY, email: r.email },
      { $set: { status: "sent", sentAt: new Date(), resendId: data.id || "", error: "" } });
    job.sent++;
  } catch (err) {
    const msg = String(err?.message || err || "Send failed").slice(0, 300);
    await CampaignSend.updateOne({ campaign: CAMPAIGN_KEY, email: r.email }, { $set: { status: "failed", error: msg } }).catch(() => {});
    job.failed++;
    throw err;
  }
}

router.post("/send-all", requireManagement, async (req, res) => {
  if (req.body?.confirm !== "SEND") return res.status(400).json({ error: "Type SEND to confirm." });
  if (job.running) return res.status(409).json({ error: "A send to everyone is already running.", job: jobView() });
  job = { running: true, startedAt: new Date(), finishedAt: null, by: req.user.name || req.user.email || "", total: 0, sent: 0, failed: 0, skipped: 0 };
  let todo, counts;
  try {
    const current = await currentRecipients();
    counts = current.counts;
    todo = current.rows.filter((r) => r.status === "pending" || r.status === "failed");
  } catch (err) {
    job.running = false;
    job.finishedAt = new Date();
    return res.status(500).json({ error: `Couldn't read the recipients: ${err?.message || err}` });
  }
  job.total = todo.length;
  await audit(req, "attending_campaign_send_all_start", `${todo.length} to send, ${counts.sent} already sent, ${counts.sending} unconfirmed`);
  res.status(202).json({ started: true, toSend: todo.length, alreadySent: counts.sent, unconfirmed: counts.sending, job: jobView() });

  const by = String(req.user.email || req.user._id);
  (async () => {
    try {
      await sendSequentially(todo, (r) => sendOne(r, by), { delayMs: SEND_GAP_MS });
    } catch (err) {
      console.error("ATTENDING CAMPAIGN SEND-ALL ERROR:", err?.message || err);
    } finally {
      job.running = false;
      job.finishedAt = new Date();
      await audit(req, "attending_campaign_send_all_done", `sent ${job.sent}, failed ${job.failed}, skipped ${job.skipped} of ${job.total}`);
    }
  })();
});

export default router;
