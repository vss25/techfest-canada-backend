/* =========================================================
   App invite email: the saved wording, the send records and the
   sender, shared by Admin › Website & app › App invite email
   (routes/appInvite.js) and a person's profile in People
   (routes/people.js). The rules are in services/appInvite.js.

   One CampaignSend row per email (campaign "app-invite-2026"),
   claimed before Resend is called (services/rsvpReminder.js
   campaignSendStore: a failed row is retried, a sent one only after
   the cool-down, an unconfirmed one never), so a re-run never
   emails anyone twice. Models are passed in (tests use a throwaway
   database).
========================================================= */

import { APP_INVITE_CAMPAIGN, COOLDOWN_MS } from "./appInvite.js";
import { TEMPLATE_KEY, templateCopy, templateSet } from "./appInviteCopy.js";
import { sendAppInviteEmail } from "./appInviteEmail.js";
import { campaignSendStore, makeReminderSender } from "./rsvpReminder.js";

/** The saved wording → { copy, options, updatedAt, updatedBy }. Never throws (the built-in text when it can't be read). */
export async function loadInviteTemplate(EmailTemplate) {
  try {
    const row = await EmailTemplate.findOne({ key: TEMPLATE_KEY }).lean();
    return { ...templateCopy(row), updatedAt: row?.updatedAt || null, updatedBy: row?.updatedBy || "" };
  } catch (err) {
    return { ...templateCopy(null), updatedAt: null, updatedBy: "", error: String(err?.message || err) };
  }
}

/** Saves the whole wording (anything left out goes back to the built-in text) → loadInviteTemplate's shape. */
export async function saveInviteTemplate(EmailTemplate, copy, options, by = "") {
  await EmailTemplate.findOneAndUpdate({ key: TEMPLATE_KEY }, { $set: templateSet(copy, options, by) }, { upsert: true, new: true });
  return loadInviteTemplate(EmailTemplate);
}

/** What planAppInvites needs besides the people: unsubscribes, this campaign's sends and engagement (optionally for some emails). */
export async function inviteInputs({ Subscription, CampaignSend, EmailEngagement }, emails = null, { campaign = APP_INVITE_CAMPAIGN } = {}) {
  const only = Array.isArray(emails) ? { email: { $in: emails } } : {};
  const [optedOut, sends, engagement] = await Promise.all([
    Subscription.find({ subscribed: false, ...only }).select("email").lean(),
    CampaignSend.find({ campaign, ...only }).select("email status sentAt sends error").lean(),
    EmailEngagement.find({ campaign, ...only }).select("campaign email opens visits lastOpenAt lastVisitAt").lean(),
  ]);
  return { optedOut: optedOut.map((s) => s.email), sends, engagement };
}

/**
 * sendTo(row, by, { force }) → the Date it went, or "skipped" (someone else has it, or sent within the cool-down).
 * Throws when the email service refuses it (recorded as failed). `template`: loadInviteTemplate's result.
 */
export function makeInviteSender({ CampaignSend, template, send = sendAppInviteEmail }) {
  return makeReminderSender({
    store: campaignSendStore(CampaignSend, { campaign: APP_INVITE_CAMPAIGN, cooldownMs: COOLDOWN_MS }),
    send: ({ to, row, track }) => send({ to, person: row, copy: template?.copy || {}, options: template?.options, track }),
  });
}
