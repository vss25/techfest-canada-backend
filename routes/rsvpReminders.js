import express from "express";
import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import Subscription from "../models/Subscription.js";
import Rsvp from "../models/Rsvp.js";
import CampaignSend from "../models/CampaignSend.js";
import { AdminAudit } from "../models/Admin.js";
import { requireAdmin, requireManagement } from "../middleware/adminAuth.js";
import { makeLimiter } from "../services/ticketAccess.js";
import { sendSequentially } from "../services/profileRequest.js";
import { planRecipients, usableEmail } from "../services/attendingCampaign.js";
import {
  REMINDER_CAMPAIGN, REMINDER_COOLDOWN_MS, SAMPLE_REMINDER, planReminders, reminderCounts, reminderEmailFor,
  sendRsvpReminder, withReminderStatus,
} from "../services/rsvpReminder.js";

/* =========================================================
   /api/console/rsvp-reminders: Admin → Marketing → RSVP reminders.
   Staff only; sending is management only and audited.

   GET  /                    → { counts: { holders, rsvpd, notRsvpd, due, reminded }, rows: [{ email, name,
                                 tiers, tickets: n, holders: [names], status, reminders, sentAt, due, error }],
                                 cooldownHours, job }
   GET  /preview-sample      → { subject, html, text } (Jane Doe, made up)
   POST /send-test { to }    → { sent: true, to } (the sample, "[Test] …"; not recorded)
   POST /send-one { email }  → { sent: true, email, sentAt } (one person, even if reminded recently)
   POST /send-all { confirm: "SEND" }
                             → 202 { started: true, toSend }. Everyone not RSVP'd who wasn't
                               reminded in the last 20 hours; runs in the background.

   Each send is recorded in CampaignSend (campaign "rsvp-reminder-2026",
   one row per email: last send, how many went out). A send claims the
   row first, so two runs at once never email someone twice.
========================================================= */

const router = express.Router();
router.use(requireAdmin);

export const SEND_GAP_MS = 600;
const testPerAdmin = makeLimiter({ max: 10, windowMs: 60 * 60 * 1000 });

async function audit(req, action, detail = "") {
  await AdminAudit.create({
    adminId: req.user._id, adminName: req.user.name, action, targetType: "campaign",
    targetId: REMINDER_CAMPAIGN, detail: String(detail).slice(0, 500),
  }).catch(() => {});
}

/** Everyone with a ticket and no RSVP yet, with their reminder history. */
async function currentRows() {
  const [users, guests, optedOut, rsvps, sends] = await Promise.all([
    User.find({ "tickets.0": { $exists: true } }).select("name email jobTitle organization banned tickets").lean(),
    Attendee.find({}).select("name email ticketId ticketType details hiddenByStaff purchaseDate").lean(),
    Subscription.find({ subscribed: false }).select("email").lean(),
    Rsvp.find({ spam: { $ne: true } }).select("ticketId firstName lastName spam").lean(),
    CampaignSend.find({ campaign: REMINDER_CAMPAIGN }).select("email status sentAt error sends").lean(),
  ]);
  const { recipients } = planRecipients({ users, guests, optedOut: optedOut.map((s) => s.email) });
  const { rows, rsvpd } = planReminders(recipients, rsvps);
  const withStatus = withReminderStatus(rows, sends);
  return { rows: withStatus, counts: reminderCounts(withStatus, rsvpd) };
}

let job = { running: false, startedAt: null, finishedAt: null, by: "", total: 0, sent: 0, failed: 0, skipped: 0 };
const jobView = () => ({ ...job });

/** Claims one person for a send. `force` (a single send) ignores the cool-down. False = someone else has it. */
async function claim(r, by, { force = false } = {}) {
  const now = new Date();
  const filter = force
    ? { campaign: REMINDER_CAMPAIGN, email: r.email }
    : { campaign: REMINDER_CAMPAIGN, email: r.email, $or: [
      { status: "failed" },
      { status: "sent", $or: [{ sentAt: { $lt: new Date(now.getTime() - REMINDER_COOLDOWN_MS) } }, { sentAt: null }] },
    ] };
  const upd = await CampaignSend.updateOne(filter, {
    $set: { status: "sending", name: r.name || "", lastTriedAt: now, sentBy: by }, $inc: { attempts: 1 },
  });
  if (upd.matchedCount) return true;
  try {
    await CampaignSend.create({ campaign: REMINDER_CAMPAIGN, email: r.email, name: r.name || "", status: "sending", attempts: 1, lastTriedAt: now, sentBy: by });
    return true;
  } catch (err) {
    if (err?.code === 11000) return false; // reminded recently, or being sent right now
    throw err;
  }
}

async function sendTo(r, by, opts) {
  if (!(await claim(r, by, opts))) return "skipped";
  try {
    const data = await sendRsvpReminder({ to: r.email, row: r });
    const sentAt = new Date();
    await CampaignSend.updateOne({ campaign: REMINDER_CAMPAIGN, email: r.email },
      { $set: { status: "sent", sentAt, resendId: data.id || "", error: "" }, $inc: { sends: 1 } });
    return sentAt;
  } catch (err) {
    const msg = String(err?.message || err || "Send failed").slice(0, 300);
    await CampaignSend.updateOne({ campaign: REMINDER_CAMPAIGN, email: r.email }, { $set: { status: "failed", error: msg } }).catch(() => {});
    throw err;
  }
}

router.get("/", async (req, res) => {
  const { rows, counts } = await currentRows();
  res.json({
    counts,
    cooldownHours: REMINDER_COOLDOWN_MS / 3600000,
    rows: rows.map((r) => ({
      email: r.email, name: r.name, tiers: r.tiers, tickets: r.tickets.length,
      holders: r.tickets.map((t) => [t.firstName, t.lastName].filter(Boolean).join(" ")).filter(Boolean),
      status: r.status, reminders: r.reminders, sentAt: r.sentAt, due: r.due, error: r.error,
    })),
    job: jobView(),
  });
});

router.get("/preview-sample", (req, res) => {
  const { subject, html, text } = reminderEmailFor(SAMPLE_REMINDER, { inline: true });
  res.json({ subject, html, text });
});

router.post("/send-test", requireManagement, async (req, res) => {
  const to = usableEmail(req.body?.to);
  if (!to) return res.status(400).json({ error: "Enter a valid email address." });
  if (!testPerAdmin.hit(String(req.user._id))) return res.status(429).json({ error: "That's a lot of test emails. Try again in an hour." });
  try {
    await sendRsvpReminder({ to, row: SAMPLE_REMINDER, subjectPrefix: "[Test] " });
  } catch (err) {
    return res.status(502).json({ error: `Couldn't send: ${err?.message || "the email service refused it"}` });
  }
  await audit(req, "rsvp_reminder_test", to);
  res.json({ sent: true, to });
});

router.post("/send-one", requireManagement, async (req, res) => {
  const email = usableEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: "Enter a valid email address." });
  if (job.running) return res.status(409).json({ error: "A send to everyone is running. Try again when it finishes." });
  const { rows } = await currentRows();
  const r = rows.find((x) => x.email === email);
  if (!r) return res.status(404).json({ error: "They've RSVP'd already, or that email has no ticket." });
  const by = String(req.user.email || req.user._id);
  try {
    const sentAt = await sendTo(r, by, { force: true });
    if (sentAt === "skipped") return res.status(409).json({ error: "Someone else is sending to them right now." });
    await audit(req, "rsvp_reminder_send_one", email);
    return res.json({ sent: true, email, sentAt });
  } catch (err) {
    await audit(req, "rsvp_reminder_send_one_failed", `${email}: ${err?.message || err}`);
    return res.status(502).json({ error: `Couldn't send: ${err?.message || "the email service refused it"}` });
  }
});

router.post("/send-all", requireManagement, async (req, res) => {
  if (req.body?.confirm !== "SEND") return res.status(400).json({ error: "Type SEND to confirm." });
  if (job.running) return res.status(409).json({ error: "A send is already running.", job: jobView() });
  job = { running: true, startedAt: new Date(), finishedAt: null, by: req.user.name || req.user.email || "", total: 0, sent: 0, failed: 0, skipped: 0 };
  let todo;
  try {
    todo = (await currentRows()).rows.filter((r) => r.due);
  } catch (err) {
    job.running = false;
    job.finishedAt = new Date();
    return res.status(500).json({ error: `Couldn't read the list: ${err?.message || err}` });
  }
  job.total = todo.length;
  await audit(req, "rsvp_reminder_send_all_start", `${todo.length} to send`);
  res.status(202).json({ started: true, toSend: todo.length, job: jobView() });

  const by = String(req.user.email || req.user._id);
  (async () => {
    try {
      await sendSequentially(todo, async (r) => {
        try {
          const out = await sendTo(r, by);
          if (out === "skipped") job.skipped++; else job.sent++;
        } catch (err) {
          job.failed++;
          throw err;
        }
      }, { delayMs: SEND_GAP_MS });
    } catch (err) {
      console.error("RSVP REMINDER SEND-ALL ERROR:", err?.message || err);
    } finally {
      job.running = false;
      job.finishedAt = new Date();
      await audit(req, "rsvp_reminder_send_all_done", `sent ${job.sent}, failed ${job.failed}, skipped ${job.skipped}`);
    }
  })();
});

export default router;
