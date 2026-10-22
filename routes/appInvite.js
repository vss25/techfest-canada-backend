import express from "express";
import CampaignSend from "../models/CampaignSend.js";
import Subscription from "../models/Subscription.js";
import EmailEngagement from "../models/EmailEngagement.js";
import EmailTemplate from "../models/EmailTemplate.js";
import { AdminAudit } from "../models/Admin.js";
import { requireAdmin, requireManagement, isManagement } from "../middleware/adminAuth.js";
import { makeLimiter } from "../services/ticketAccess.js";
import { sendSequentially } from "../services/profileRequest.js";
import { SINGLE_SEND_LIMIT, staffNote } from "../services/staffPowers.js";
import { usableEmail } from "../services/attendingCampaign.js";
import {
  APP_INVITE_CAMPAIGN, APP_URL, COOLDOWN_DAYS, GROUP_SIZES, MAX_BATCH, PLAY_STORE_URL, SAMPLE_PERSON, TYPE_SEND_FROM, appInviteJob, appStoreUrl,
  droppedSummary, inviteStats, inviteSendKey, pickBatch, planAppInvites,
} from "../services/appInvite.js";
import {
  DEFAULT_COPY, DEFAULT_OPTIONS, FIELDS, OPTIONS, PLACEHOLDERS, SECTIONS, changedWording, cleanCopy, cleanOptions, wordingToSave,
} from "../services/appInviteCopy.js";
import { appInviteEmailFor, sendAppInviteEmail } from "../services/appInviteEmail.js";
import { inviteInputs, loadInviteTemplate, makeInviteSender, saveInviteTemplate } from "../services/appInviteSend.js";
import { directory } from "./people.js";
import { loadSwag } from "../services/swag.js";
import { publicSwag } from "../services/swagRules.js";

/* =========================================================
   /api/console/app-invite: the app invite email (Oct 20 2026,
   Admin › Website & app › App invite email). Staff only. Saving the
   wording and sending to everyone are management only; a test to
   yourself and a send to one person are for staff too (like the
   single sends in People). Every send is audited. Nothing here is
   called automatically. Rules: services/appInvite.js.

   GET  /template            → { copy, options, defaults, defaultOptions, fields, sections, optionsMeta,
                                 placeholders, appStoreUrl, playUrl, appUrl, updatedBy, updatedAt, canEdit }
   PUT  /template { ...fields, options } (management) → the same
   POST /preview { ...draft fields, options?, as? } → { subject, preheader, html, text, to }
                               Jane Doe (made up), or `as`: a recipient's email (their name and address).
   GET  /recipients?skipUsing=1|0 → { counts, stats, rows, job, cooldownDays, groupSizes, typeSendFrom }
                               rows[]: …, ticket (bought / given: services/appInvite.js ticketOf), sendAgain, canSelect
   POST /send-test { ...draft fields, options? } → { sent, to } (to yourself, "[Test] ", no tracking, not recorded)
   POST /send-one { email } → { sent, email, sentAt } (waits COOLDOWN_DAYS after the last one)
   POST /send-all { confirm: "SEND", skipUsing?, only?: "failed" } (management) → 202 { started, toSend }
                               Runs in the background, SEND_GAP_MS apart; poll /recipients (job, counts).
   POST /send-batch { kind: "next" | "selected", emails: [...], size?, skipUsing?, confirm } (management)
                               → 202 { started, toSend, dropped: [{ email, name, reason, label }], droppedText, job }
                               A group ("Send next 20": `size` 10 / 20 / 50 / 100, the next people who'll get it in
                               the list's order and filter) or the people ticked on the page. `emails` is only a
                               wish list: it's intersected with who can get it now (services/appInvite.js
                               pickBatch), in that order; the rest come back in `dropped`. confirm "SEND" for
                               TYPE_SEND_FROM or more, else "CONFIRM". The same background job as /send-all.
========================================================= */

const router = express.Router();
router.use(requireAdmin);

/** Resend allows a few a second: one every 600 ms, like the "I'm attending" send. */
export const SEND_GAP_MS = 600;
const testPerStaff = makeLimiter({ max: 10, windowMs: 60 * 60 * 1000 });
const oneByOne = makeLimiter(SINGLE_SEND_LIMIT);
const MODELS = { Subscription, CampaignSend, EmailEngagement };

async function audit(req, action, detail = "") {
  await AdminAudit.create({
    adminId: req.user._id, adminName: req.user.name, action, targetType: "campaign",
    targetId: APP_INVITE_CAMPAIGN, detail: String(detail).slice(0, 500),
  }).catch(() => {});
}

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error("APP INVITE ERROR:", err);
  if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Try again." });
});

const skipUsingOf = (v) => !(v === false || v === "0" || v === "false");

/** Everyone it could go to now (the People directory), with their send status for the version that goes now
    (the swag version's own sends while the contest is on). → the plan plus `swag` (the contest's settings). */
async function currentPlan({ skipUsing = true, mode = "all", fresh = false } = {}) {
  const swag = await loadSwag();
  const [d, inputs] = await Promise.all([directory({ fresh }), inviteInputs(MODELS, null, { swag: swag.enabled })]);
  return { ...planAppInvites(d.people, { ...inputs, skipUsing, mode, swag: swag.enabled }), swag };
}

async function templatePayload(req) {
  const [t, swag] = await Promise.all([loadInviteTemplate(EmailTemplate), loadSwag()]);
  return {
    // The swag kit contest (services/swagRules.js): while it's on the email carries the swag block and swagSubject.
    swagOn: swag.enabled, swag: publicSwag(swag), version: swag.enabled ? "swag" : "standard",
    copy: t.copy, options: t.options, defaults: DEFAULT_COPY, defaultOptions: DEFAULT_OPTIONS,
    fields: FIELDS, sections: SECTIONS, optionsMeta: OPTIONS, placeholders: PLACEHOLDERS,
    appStoreUrl: appStoreUrl(), playUrl: PLAY_STORE_URL, appUrl: APP_URL,
    updatedBy: t.updatedBy, updatedAt: t.updatedAt, canEdit: isManagement(req.user),
  };
}

/** A draft from the editor (unsaved), over the saved wording. */
async function draftOf(body = {}) {
  const t = await loadInviteTemplate(EmailTemplate);
  const draft = cleanCopy(body);
  return { copy: { ...t.copy, ...draft }, options: { ...t.options, ...cleanOptions(body.options) } };
}

router.get("/template", wrap(async (req, res) => res.json(await templatePayload(req))));

router.put("/template", requireManagement, wrap(async (req, res) => {
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const before = await loadInviteTemplate(EmailTemplate);
  const copy = wordingToSave(b);
  const options = { ...DEFAULT_OPTIONS, ...cleanOptions(b.options) };
  const after = await saveInviteTemplate(EmailTemplate, copy, options, String(req.user?.name || req.user?.email || ""));
  const changed = changedWording(before, after);
  await audit(req, "app_invite_template", changed.length ? `wording: ${changed.join(", ")}` : "wording unchanged");
  res.json(await templatePayload(req));
}));

router.post("/preview", wrap(async (req, res) => {
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const [{ copy, options }, swag] = await Promise.all([draftOf(b), loadSwag()]);
  let person = SAMPLE_PERSON;
  if (b.as) {
    const as = usableEmail(b.as);
    const row = as && (await currentPlan({ skipUsing: false, mode: "one" })).rows.find((r) => r.email === as);
    if (!row) return res.status(404).json({ error: "That email isn't on the list." });
    person = row;
  }
  const e = appInviteEmailFor(person, { inline: true, copy, options, swag });
  res.json({ subject: e.subject, preheader: e.preheader, html: e.html, text: e.text, to: person.email });
}));

router.get("/recipients", wrap(async (req, res) => {
  const skipUsing = skipUsingOf(req.query.skipUsing);
  const plan = await currentPlan({ skipUsing, mode: "all", fresh: req.query.refresh === "1" });
  res.json({
    counts: plan.counts,
    stats: inviteStats(plan.rows),
    skipUsing,
    // Which version goes now: "swag" (the contest is on; sends claimed under APP_INVITE_SWAG_KEY, so people who got
    // the earlier invite can get it once) or "standard".
    version: plan.swag.enabled ? "swag" : "standard", sendKey: inviteSendKey(plan.swag.enabled),
    rows: plan.rows.map(({ id, name, email, roles, ticket, usingApp, status, sentAt, sends, opened, clicked, usingAfter, willGet, sendAgain, canSelect, reason, label, error, version, earlierSentAt }) =>
      ({ id, name, email, roles, ticket, usingApp, status, sentAt, sends, opened, clicked, usingAfter, willGet, sendAgain, canSelect, reason, label, error, version, earlierSentAt })),
    job: appInviteJob.view(),
    cooldownDays: COOLDOWN_DAYS,
    groupSizes: GROUP_SIZES,
    typeSendFrom: TYPE_SEND_FROM,
  });
}));

router.post("/send-test", wrap(async (req, res) => {
  const to = usableEmail(req.user?.email);
  if (!to) return res.status(400).json({ error: "Your staff account has no email address to send a test to." });
  if (!testPerStaff.hit(String(req.user._id))) return res.status(429).json({ error: "That's a lot of test emails. Try again in an hour." });
  const [{ copy, options }, swag] = await Promise.all([draftOf(req.body || {}), loadSwag()]);
  try {
    await sendAppInviteEmail({ to, person: { ...SAMPLE_PERSON, email: to }, copy, options, swag: swag.enabled ? swag : null, subjectPrefix: "[Test] " });
  } catch (err) {
    await audit(req, "app_invite_test_failed", `${to}: ${err?.message || err}`);
    return res.status(502).json({ error: `Couldn't send: ${err?.message || "the email service refused it"}` });
  }
  await audit(req, "app_invite_test", to);
  res.json({ sent: true, to });
}));

/** Send to one person (this page, and a profile in People: routes/people.js). → { status, body } */
export async function sendInviteToOne(email, { by = "", fresh = true } = {}) {
  if (appInviteJob.state.running) return { status: 409, body: { code: "running", error: "A send to many people is running. Try again when it finishes." } };
  const plan = await currentPlan({ mode: "one", fresh });
  const row = plan.rows.find((r) => r.email === email && r.reason !== "duplicate");
  if (!row) return { status: 404, body: { error: "That email isn't on the list (people with a pass or a role at TTFC 2026)." } };
  if (!row.willGet) return { status: 409, body: { code: row.reason, error: row.label } };
  const template = await loadInviteTemplate(EmailTemplate);
  const sentAt = await makeInviteSender({ CampaignSend, template, swag: plan.swag })(row, by);
  if (sentAt === "unsubscribed") return { status: 409, body: { code: "unsubscribed", error: "They unsubscribed from our emails." } };
  if (sentAt === "skipped") return { status: 409, body: { code: "skipped", error: "They were emailed very recently, or someone is sending to them right now." } };
  return { status: 200, body: { sent: true, email, sentAt } };
}

router.post("/send-one", wrap(async (req, res) => {
  const email = usableEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: "Enter a valid email address." });
  if (!oneByOne.hit(String(req.user._id))) return res.status(429).json({ error: "That's a lot of single sends in an hour. Try again later." });
  const note = staffNote(isManagement(req.user));
  try {
    const r = await sendInviteToOne(email, { by: String(req.user.email || req.user._id) });
    if (r.status === 200) await audit(req, "app_invite_send_one", `${email}${note}`);
    return res.status(r.status).json(r.body);
  } catch (err) {
    await audit(req, "app_invite_send_one_failed", `${email}${note}: ${String(err?.message || err).slice(0, 200)}`);
    return res.status(502).json({ error: `Couldn't send: ${err?.message || "the email service refused it"}` });
  }
}));

/** Sends `todo` one by one in the background (the job is already started), then audits `<doneAction>`. `swag`: the
    contest's settings (the swag version while it's on); `recheck`: skip anyone who signed in to the app since the list
    was read (when the send skips people already using the app), counted as usingApp. */
function runInBackground(req, todo, template, doneAction, { swag = null, recheck = false } = {}) {
  const by = String(req.user.email || req.user._id);
  const sendTo = makeInviteSender({ CampaignSend, template, swag, recheck });
  (async () => {
    try {
      await sendSequentially(todo, async (r) => {
        try {
          const out = await sendTo(r, by);
          if (out === "usingApp") appInviteJob.state.usingApp = (appInviteJob.state.usingApp || 0) + 1;
          else if (out === "skipped" || out === "unsubscribed") appInviteJob.state.skipped++;
          else appInviteJob.state.sent++;
        } catch (err) {
          appInviteJob.state.failed++;
          throw err;
        }
      }, { delayMs: SEND_GAP_MS });
    } catch (err) {
      console.error("APP INVITE SEND ERROR:", err?.message || err);
    } finally {
      appInviteJob.finish();
      const s = appInviteJob.state;
      await audit(req, doneAction, `sent ${s.sent}, failed ${s.failed}, skipped ${s.skipped}${s.usingApp ? `, now using the app ${s.usingApp}` : ""} of ${s.total}${swag?.enabled ? " (swag version)" : ""}`);
    }
  })();
}

router.post("/send-all", requireManagement, wrap(async (req, res) => {
  const b = req.body && typeof req.body === "object" ? req.body : {};
  if (b.confirm !== "SEND") return res.status(400).json({ error: "Type SEND to confirm." });
  if (appInviteJob.state.running) return res.status(409).json({ error: "A send is already running.", job: appInviteJob.view() });
  const skipUsing = b.skipUsing !== false;
  const mode = b.only === "failed" ? "failed" : "all";
  appInviteJob.start(req.user.name || req.user.email || "", mode === "failed" ? "app-invite-retry" : "app-invite", 0, { kind: mode === "failed" ? "retry" : "all", usingApp: 0 });
  let todo, template, swag;
  try {
    const plan = await currentPlan({ skipUsing, mode, fresh: true });
    todo = plan.targets;
    swag = plan.swag;
    template = await loadInviteTemplate(EmailTemplate);
  } catch (err) {
    appInviteJob.finish();
    return res.status(500).json({ error: `Couldn't read the list: ${err?.message || err}` });
  }
  appInviteJob.state.total = todo.length;
  await audit(req, mode === "failed" ? "app_invite_retry_start" : "app_invite_send_all_start", `${todo.length} to send${skipUsing ? ", skipping people already using the app" : ""}`);
  res.status(202).json({ started: true, toSend: todo.length, job: appInviteJob.view() });
  runInBackground(req, todo, template, "app_invite_send_all_done", { swag, recheck: skipUsing });
}));

/** A group ("Send next N") or the people ticked on the page: see the header. */
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
  if (appInviteJob.state.running) return res.status(409).json({ error: "A send is already running.", job: appInviteJob.view() });
  const skipUsing = b.skipUsing !== false;
  const before = appInviteJob.start(req.user.name || req.user.email || "", `app-invite-${kind}`, 0, { kind, size: kind === "next" ? size : 0, usingApp: 0 });
  let pick, template, swag;
  try {
    const plan = await currentPlan({ skipUsing, mode: "all", fresh: true });
    pick = pickBatch(plan, emails, { kind });
    swag = plan.swag;
    template = await loadInviteTemplate(EmailTemplate);
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
  const what = kind === "next" ? `next ${size}` : `${emails.length} picked`;
  await audit(req, `app_invite_send_${kind}_start`,
    `${what}: ${todo.length} to send${dropped.length ? `, ${dropped.length} dropped (${[...new Set(dropped.map((d) => d.reason))].join(", ")})` : ""}${skipUsing ? ", skipping people already using the app" : ""}`);
  res.status(202).json({ started: true, toSend: todo.length, dropped, droppedText: droppedSummary(dropped), job: appInviteJob.view() });
  runInBackground(req, todo, template, `app_invite_send_${kind}_done`, { swag, recheck: skipUsing });
}));

export default router;
