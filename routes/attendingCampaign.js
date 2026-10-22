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
import { attendingJob } from "../services/attendingNudge.js";
import { isUnsubscribed } from "../services/unsubscribe.js";

/* =========================================================
   /api/console/attending-campaign: the "I'm attending" email
   (Admin → Marketing → I'm attending campaign). Staff only;
   sending is management only and audited.

   GET  /preview-sample      → { to: "", subject, html, text, link } (Jane Doe, made up)
   GET  /recipients          → { counts, skipped, recipients: [{ email, name, title, company,
                                 tiers, sources, status, sentAt, error }], job }
   POST /send-test { to, as? } → { sent: true, to, as } (subject "[Test] …"; not recorded).
                               `as` = a recipient's email: personalise it with their name, title
                               and company. Without it, the Jane Doe sample.
   POST /send-one { email, again? } → { sent: true, email, sentAt } (one person; recorded like
                               the send to everyone. Already emailed → 409 unless again: true)
   POST /send-all { confirm: "SEND" }
                             → 202 { started: true, toSend, alreadySent, unconfirmed }
                               Runs in the background; poll /recipients (job + counts).

   Re-running never double-sends: each recipient is claimed in
   CampaignSend (unique campaign + email) before Resend is called,
   "sent" and "sending" rows are skipped, "failed" ones are retried.
   Sends are spaced 600 ms apart (Resend allows ~2 a second).
   Nothing here is called automatically. Real sends (not tests) carry
   the person's tracking token: who opened it, opened their page and
   posted shows in People (services/engagement.js).
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

/* One background send at a time (per server), shared with Admin › People's LinkedIn nudge (services/attendingNudge.js).
   Progress is also in CampaignSend, so it survives a restart. */
const jobView = () => attendingJob.view();

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
  let recipient = SAMPLE_RECIPIENT;
  const as = req.body?.as ? usableEmail(req.body.as) : "";
  if (req.body?.as) {
    const found = as && (await currentRecipients()).rows.find((r) => r.email === as);
    if (!found) return res.status(404).json({ error: "That email isn't on the recipient list." });
    recipient = found;
  }
  if (!testPerAdmin.hit(String(req.user._id))) return res.status(429).json({ error: "That's a lot of test emails. Try again in an hour." });
  try {
    await sendAttendingEmail({ to, recipient, subjectPrefix: "[Test] " });
  } catch (err) {
    await audit(req, "attending_campaign_test_failed", `${to}: ${err?.message || err}`);
    return res.status(502).json({ error: `Couldn't send: ${err?.message || "the email service refused it"}` });
  }
  await audit(req, "attending_campaign_test", as ? `${to} (as ${as})` : to);
  res.json({ sent: true, to, as });
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
  // The last check: someone who unsubscribed after the list was read (services/unsubscribe.js) is left out.
  if (await isUnsubscribed(Subscription, r.email)) { attendingJob.state.skipped++; return; }
  if (!(await claim(r, by))) { attendingJob.state.skipped++; return; }
  try {
    const data = await sendAttendingEmail({ to: r.email, recipient: r, track: true });
    await CampaignSend.updateOne({ campaign: CAMPAIGN_KEY, email: r.email },
      { $set: { status: "sent", sentAt: new Date(), resendId: data.id || "", error: "" } });
    attendingJob.state.sent++;
  } catch (err) {
    const msg = String(err?.message || err || "Send failed").slice(0, 300);
    await CampaignSend.updateOne({ campaign: CAMPAIGN_KEY, email: r.email }, { $set: { status: "failed", error: msg } }).catch(() => {});
    attendingJob.state.failed++;
    throw err;
  }
}

router.post("/send-one", requireManagement, async (req, res) => {
  const email = usableEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: "Enter a valid email address." });
  if (attendingJob.state.running) return res.status(409).json({ error: "A send to everyone is running. Try again when it finishes." });
  const { rows } = await currentRecipients();
  const r = rows.find((x) => x.email === email);
  if (!r) return res.status(404).json({ error: "That email isn't on the recipient list." });
  const again = req.body?.again === true;
  if ((r.status === "sent" || r.status === "sending") && !again) {
    return res.status(409).json({
      code: "already_sent",
      error: r.status === "sent" ? "They've had it already." : "A send to them wasn't confirmed. Check Resend before sending again.",
    });
  }
  const by = String(req.user.email || req.user._id);
  const now = new Date();
  if (again) {
    await CampaignSend.updateOne({ campaign: CAMPAIGN_KEY, email: r.email },
      { $set: { status: "sending", lastTriedAt: now, sentBy: by }, $inc: { attempts: 1 } });
  } else if (!(await claim(r, by))) {
    return res.status(409).json({ code: "already_sent", error: "Someone else is sending to them right now, or they've had it." });
  }
  try {
    const data = await sendAttendingEmail({ to: r.email, recipient: r, track: true });
    const sentAt = new Date();
    await CampaignSend.updateOne({ campaign: CAMPAIGN_KEY, email: r.email },
      { $set: { status: "sent", sentAt, resendId: data.id || "", error: "" } });
    await audit(req, again ? "attending_campaign_send_one_again" : "attending_campaign_send_one", r.email);
    return res.json({ sent: true, email: r.email, sentAt });
  } catch (err) {
    const msg = String(err?.message || err || "Send failed").slice(0, 300);
    await CampaignSend.updateOne({ campaign: CAMPAIGN_KEY, email: r.email }, { $set: { status: "failed", error: msg } }).catch(() => {});
    await audit(req, "attending_campaign_send_one_failed", `${r.email}: ${msg}`);
    return res.status(502).json({ error: `Couldn't send: ${msg}` });
  }
});

router.post("/send-all", requireManagement, async (req, res) => {
  if (req.body?.confirm !== "SEND") return res.status(400).json({ error: "Type SEND to confirm." });
  if (attendingJob.state.running) return res.status(409).json({ error: "A send to everyone is already running.", job: jobView() });
  attendingJob.start(req.user.name || req.user.email || "", "attending-campaign");
  let todo, counts;
  try {
    const current = await currentRecipients();
    counts = current.counts;
    todo = current.rows.filter((r) => r.status === "pending" || r.status === "failed");
  } catch (err) {
    attendingJob.finish();
    return res.status(500).json({ error: `Couldn't read the recipients: ${err?.message || err}` });
  }
  attendingJob.state.total = todo.length;
  await audit(req, "attending_campaign_send_all_start", `${todo.length} to send, ${counts.sent} already sent, ${counts.sending} unconfirmed`);
  res.status(202).json({ started: true, toSend: todo.length, alreadySent: counts.sent, unconfirmed: counts.sending, job: jobView() });

  const by = String(req.user.email || req.user._id);
  (async () => {
    try {
      await sendSequentially(todo, (r) => sendOne(r, by), { delayMs: SEND_GAP_MS });
    } catch (err) {
      console.error("ATTENDING CAMPAIGN SEND-ALL ERROR:", err?.message || err);
    } finally {
      attendingJob.finish();
      const job = attendingJob.state;
      await audit(req, "attending_campaign_send_all_done", `sent ${job.sent}, failed ${job.failed}, skipped ${job.skipped} of ${job.total}`);
    }
  })();
});

export default router;
