import express from "express";
import User from "../models/User.js";
import CampaignSend from "../models/CampaignSend.js";
import Subscription from "../models/Subscription.js";
import EmailEngagement from "../models/EmailEngagement.js";
import EmailTemplate from "../models/EmailTemplate.js";
import { AdminAudit } from "../models/Admin.js";
import { requireAdmin, requireManagement, isManagement } from "../middleware/adminAuth.js";
import { makeLimiter } from "../services/ticketAccess.js";
import { sendSequentially } from "../services/profileRequest.js";
import { usableEmail } from "../services/attendingCampaign.js";
import {
  COOLDOWN_MS, GROUP_SIZES, MAX_BATCH, SAMPLE_PERSON, TYPE_SEND_FROM, appInviteJob, droppedSummary, inviteStats, pickBatch, planAppInvites,
} from "../services/appInvite.js";
import { inviteInputs } from "../services/appInviteSend.js";
import { campaignSendStore, makeReminderSender } from "../services/rsvpReminder.js";
import {
  DEFAULT_COPY, FIELDS, PLACEHOLDERS, SECTIONS, TEMPLATE_KEY, changedWording, cleanCopy, templateCopy, templateSet, wordingToSave,
} from "../services/swagInviteCopy.js";
import { APP_SWAG_CAMPAIGN, sendSwagInviteEmail, swagInviteEmailFor } from "../services/swagInviteEmail.js";
import { loadSwag } from "../services/swag.js";
import { publicSwag } from "../services/swagRules.js";
import { directory } from "./people.js";

/* =========================================================
   /api/console/app-swag: the "Win the swag kit" email (Oct 22 2026,
   Admin › Website & app › App invite email › campaign "Win the swag
   kit"), campaign APP_SWAG_CAMPAIGN ("app-swag-2026"). The same list
   and picker as the app invite (routes/appInvite.js, rules in
   services/appInvite.js) with its own send records (one CampaignSend
   row per email, so each person gets it once), but only ever for
   people who haven't signed in to the app yet: they're the only ones
   who can be picked, and each is checked again just before their email
   goes (signed in since → skipped, counted as usingApp). Staff only;
   saving the wording and sending are management only; the contest
   must be on (swag.enabled) before anything is sent. Test sends and
   previews carry no tracking and record nothing. One send to many
   people at a time on this server, shared with the app invite.

   GET  /template            → { copy, defaults, fields, sections, placeholders, updatedBy, updatedAt, canEdit, swag }
   PUT  /template { ...fields } (management) → the same
   POST /preview { ...draft fields, as? } → { subject, preheader, html, text, to }   (Jane Doe, or `as`: one of the list's emails)
   GET  /recipients          → { campaign, counts, stats, rows, job, groupSizes, typeSendFrom, swagEnabled }   (as the app invite's)
   POST /send-test { ...draft fields } → { sent, to }   (to yourself, "[Test] ")
   POST /send-batch { kind: "next" | "selected", emails, size?, confirm } (management) → 202 { started, toSend, dropped, droppedText, job }
   POST /send-all { confirm: "SEND", only?: "failed" } (management) → 202 { started, toSend, job }
   409 { code: "swag_off" } for the sends while the contest is off.
========================================================= */

const router = express.Router();
router.use(requireAdmin);

export const SEND_GAP_MS = 600;
const testPerStaff = makeLimiter({ max: 10, windowMs: 60 * 60 * 1000 });
const MODELS = { Subscription, CampaignSend, EmailEngagement };
const SWAG_OFF = { code: "swag_off", error: "Turn on the swag kit contest (Website & app › Swag kit) before sending this email." };

async function audit(req, action, detail = "") {
  await AdminAudit.create({
    adminId: req.user._id, adminName: req.user.name, action, targetType: "campaign", targetId: APP_SWAG_CAMPAIGN, detail: String(detail).slice(0, 500),
  }).catch(() => {});
}
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error("APP SWAG EMAIL ERROR:", err?.message || err);
  if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Try again." });
});

/* ---------- the wording ---------- */

export async function loadSwagTemplate() {
  try {
    const row = await EmailTemplate.findOne({ key: TEMPLATE_KEY }).lean();
    return { ...templateCopy(row), updatedAt: row?.updatedAt || null, updatedBy: row?.updatedBy || "" };
  } catch (err) {
    return { ...templateCopy(null), updatedAt: null, updatedBy: "", error: String(err?.message || err) };
  }
}
async function templatePayload(req) {
  const [t, swag] = await Promise.all([loadSwagTemplate(), loadSwag()]);
  return {
    copy: t.copy, defaults: DEFAULT_COPY, fields: FIELDS, sections: SECTIONS, placeholders: PLACEHOLDERS,
    updatedBy: t.updatedBy, updatedAt: t.updatedAt, canEdit: isManagement(req.user), swag: publicSwag(swag),
  };
}
const draftOf = async (body = {}) => ({ ...(await loadSwagTemplate()).copy, ...cleanCopy(body) });

router.get("/template", wrap(async (req, res) => res.json(await templatePayload(req))));

router.put("/template", requireManagement, wrap(async (req, res) => {
  const before = await loadSwagTemplate();
  const copy = wordingToSave(req.body && typeof req.body === "object" ? req.body : {});
  await EmailTemplate.findOneAndUpdate({ key: TEMPLATE_KEY }, { $set: templateSet(copy, String(req.user?.name || req.user?.email || "")) }, { upsert: true, new: true });
  const after = await loadSwagTemplate();
  const changed = changedWording(before, after);
  await audit(req, "app_swag_template", changed.length ? `wording: ${changed.join(", ")}` : "wording unchanged");
  res.json(await templatePayload(req));
}));

/* ---------- the list ---------- */

/** Everyone it could go to now: people not using the app yet (the app invite's rules, this campaign's records). */
async function currentPlan({ mode = "all", fresh = false } = {}) {
  const [d, inputs] = await Promise.all([directory({ fresh }), inviteInputs(MODELS, null, { campaign: APP_SWAG_CAMPAIGN })]);
  return planAppInvites(d.people, { ...inputs, skipUsing: true, mode, campaign: APP_SWAG_CAMPAIGN });
}

router.post("/preview", wrap(async (req, res) => {
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const [copy, swag] = await Promise.all([draftOf(b), loadSwag()]);
  let person = SAMPLE_PERSON;
  if (b.as) {
    const as = usableEmail(b.as);
    const row = as && (await currentPlan({ mode: "one" })).rows.find((r) => r.email === as);
    if (!row) return res.status(404).json({ error: "That email isn't on the list." });
    person = row;
  }
  const e = swagInviteEmailFor(person, { inline: true, copy, swag });
  res.json({ subject: e.subject, preheader: e.preheader, html: e.html, text: e.text, to: person.email });
}));

router.get("/recipients", wrap(async (req, res) => {
  const [plan, swag] = await Promise.all([currentPlan({ mode: "all", fresh: req.query.refresh === "1" }), loadSwag()]);
  res.json({
    campaign: APP_SWAG_CAMPAIGN,
    counts: plan.counts,
    stats: inviteStats(plan.rows),
    rows: plan.rows.map(({ id, name, email, roles, ticket, usingApp, status, sentAt, sends, opened, clicked, usingAfter, willGet, sendAgain, canSelect, reason, label, error }) =>
      ({ id, name, email, roles, ticket, usingApp, status, sentAt, sends, opened, clicked, usingAfter, willGet, sendAgain, canSelect, reason, label, error })),
    job: appInviteJob.view(), groupSizes: GROUP_SIZES, typeSendFrom: TYPE_SEND_FROM, swagEnabled: swag.enabled,
  });
}));

/* ---------- sending ---------- */

/** Signed in to the app since the list was read? (their account by id, or any account with that email). */
export async function onAppNow(row) {
  const who = [{ email: row.email }];
  const id = /^u-([a-f0-9]{24})$/.exec(String(row.id || ""))?.[1];
  if (id) who.push({ _id: id });
  return !!(await User.exists({ $and: [{ $or: who }, { $or: [{ appOnboarded: true }, { lastActiveAt: { $ne: null } }] }] }));
}

/** sendTo(row, by) → the Date it went, "skipped" (someone else has it, or already sent) or "usingApp" (signed in since). */
export function makeSwagSender({ template, swag, send = sendSwagInviteEmail }) {
  const sendTo = makeReminderSender({
    store: campaignSendStore(CampaignSend, { campaign: APP_SWAG_CAMPAIGN, cooldownMs: COOLDOWN_MS }),
    send: ({ to, row, track }) => send({ to, person: row, copy: template?.copy || {}, swag, track }),
  });
  return async (row, by) => ((await onAppNow(row)) ? "usingApp" : sendTo(row, by));
}

function runInBackground(req, todo, template, swag, doneAction) {
  const by = String(req.user.email || req.user._id);
  const sendTo = makeSwagSender({ template, swag });
  (async () => {
    try {
      await sendSequentially(todo, async (r) => {
        try {
          const out = await sendTo(r, by);
          if (out === "usingApp") appInviteJob.state.usingApp = (appInviteJob.state.usingApp || 0) + 1;
          else if (out === "skipped") appInviteJob.state.skipped++;
          else appInviteJob.state.sent++;
        } catch (err) {
          appInviteJob.state.failed++;
          throw err;
        }
      }, { delayMs: SEND_GAP_MS });
    } catch (err) {
      console.error("APP SWAG SEND ERROR:", err?.message || err);
    } finally {
      appInviteJob.finish();
      const s = appInviteJob.state;
      await audit(req, doneAction, `sent ${s.sent}, failed ${s.failed}, skipped ${s.skipped}, now using the app ${s.usingApp || 0} of ${s.total}`);
    }
  })();
}

router.post("/send-test", wrap(async (req, res) => {
  const to = usableEmail(req.user?.email);
  if (!to) return res.status(400).json({ error: "Your staff account has no email address to send a test to." });
  if (!testPerStaff.hit(String(req.user._id))) return res.status(429).json({ error: "That's a lot of test emails. Try again in an hour." });
  const [copy, swag] = await Promise.all([draftOf(req.body || {}), loadSwag()]);
  try {
    await sendSwagInviteEmail({ to, person: { ...SAMPLE_PERSON, email: to }, copy, swag, subjectPrefix: "[Test] " });
  } catch (err) {
    await audit(req, "app_swag_test_failed", `${to}: ${err?.message || err}`);
    return res.status(502).json({ error: `Couldn't send: ${err?.message || "the email service refused it"}` });
  }
  await audit(req, "app_swag_test", to);
  res.json({ sent: true, to });
}));

router.post("/send-all", requireManagement, wrap(async (req, res) => {
  const b = req.body && typeof req.body === "object" ? req.body : {};
  if (b.confirm !== "SEND") return res.status(400).json({ error: "Type SEND to confirm." });
  const swag = await loadSwag();
  if (!swag.enabled) return res.status(409).json(SWAG_OFF);
  if (appInviteJob.state.running) return res.status(409).json({ error: "A send is already running.", job: appInviteJob.view() });
  const mode = b.only === "failed" ? "failed" : "all";
  const before = appInviteJob.start(req.user.name || req.user.email || "", mode === "failed" ? "app-swag-retry" : "app-swag", 0, { kind: mode === "failed" ? "retry" : "all", usingApp: 0 });
  let todo, template;
  try {
    todo = (await currentPlan({ mode, fresh: true })).targets;
    template = await loadSwagTemplate();
  } catch (err) {
    appInviteJob.restore(before);
    return res.status(500).json({ error: `Couldn't read the list: ${err?.message || err}` });
  }
  appInviteJob.state.total = todo.length;
  await audit(req, mode === "failed" ? "app_swag_retry_start" : "app_swag_send_all_start", `${todo.length} to send (people not on the app yet)`);
  res.status(202).json({ started: true, toSend: todo.length, job: appInviteJob.view() });
  runInBackground(req, todo, template, swag, "app_swag_send_all_done");
}));

router.post("/send-batch", requireManagement, wrap(async (req, res) => {
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const kind = b.kind === "next" ? "next" : b.kind === "selected" ? "selected" : "";
  if (!kind) return res.status(400).json({ error: "Send a group (kind: next) or the people you picked (kind: selected)." });
  const emails = Array.isArray(b.emails) ? b.emails.filter((e) => typeof e === "string").map((e) => e.slice(0, 200)) : [];
  if (!emails.length) return res.status(400).json({ error: "Pick who to send it to first." });
  if (emails.length > MAX_BATCH) return res.status(400).json({ error: `That's more than ${MAX_BATCH} people. Use Send to everyone instead.` });
  const size = Number(b.size) || 0;
  if (kind === "next" && (!GROUP_SIZES.includes(size) || emails.length > size)) {
    return res.status(400).json({ error: `Pick a group of ${GROUP_SIZES.slice(0, -1).join(", ")} or ${GROUP_SIZES.at(-1)} people.` });
  }
  const typed = emails.length >= TYPE_SEND_FROM;
  if (typed ? b.confirm !== "SEND" : !["SEND", "CONFIRM"].includes(b.confirm)) {
    return res.status(400).json({ error: typed ? "Type SEND to confirm." : "Confirm the send first." });
  }
  const swag = await loadSwag();
  if (!swag.enabled) return res.status(409).json(SWAG_OFF);
  if (appInviteJob.state.running) return res.status(409).json({ error: "A send is already running.", job: appInviteJob.view() });
  const before = appInviteJob.start(req.user.name || req.user.email || "", `app-swag-${kind}`, 0, { kind, size: kind === "next" ? size : 0, usingApp: 0 });
  let pick, template;
  try {
    pick = pickBatch(await currentPlan({ mode: "all", fresh: true }), emails, { kind });
    template = await loadSwagTemplate();
  } catch (err) {
    appInviteJob.restore(before);
    return res.status(500).json({ error: `Couldn't read the list: ${err?.message || err}` });
  }
  const { todo, dropped } = pick;
  if (!todo.length) {
    appInviteJob.restore(before);
    return res.status(409).json({ code: "none", error: `None of them can get it now: ${droppedSummary(dropped)}.`, toSend: 0, dropped });
  }
  Object.assign(appInviteJob.state, { total: todo.length, dropped: dropped.length });
  await audit(req, `app_swag_send_${kind}_start`,
    `${kind === "next" ? `next ${size}` : `${emails.length} picked`}: ${todo.length} to send${dropped.length ? `, ${dropped.length} dropped (${[...new Set(dropped.map((d) => d.reason))].join(", ")})` : ""}`);
  res.status(202).json({ started: true, toSend: todo.length, dropped, droppedText: droppedSummary(dropped), job: appInviteJob.view() });
  runInBackground(req, todo, template, swag, `app_swag_send_${kind}_done`);
}));

export default router;
