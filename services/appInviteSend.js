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

import User from "../models/User.js";
import { APP_INVITE_CAMPAIGN, COOLDOWN_MS, inviteSendKey } from "./appInvite.js";
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

/**
 * What planAppInvites needs besides the people: unsubscribes, the sends of the key claimed under now (the swag
 * version's while `swag` is on, with the earlier invite's as earlierSends) and the engagement (optionally for some emails).
 */
export async function inviteInputs({ Subscription, CampaignSend, EmailEngagement }, emails = null, { swag = false } = {}) {
  const only = Array.isArray(emails) ? { email: { $in: emails } } : {};
  const [optedOut, sends, earlierSends, engagement] = await Promise.all([
    Subscription.find({ subscribed: false, ...only }).select("email").lean(),
    CampaignSend.find({ campaign: inviteSendKey(swag), ...only }).select("email status sentAt sends error").lean(),
    swag ? CampaignSend.find({ campaign: APP_INVITE_CAMPAIGN, ...only }).select("email status sentAt sends error").lean() : [],
    EmailEngagement.find({ campaign: APP_INVITE_CAMPAIGN, ...only }).select("campaign email opens visits lastOpenAt lastVisitAt").lean(),
  ]);
  return { optedOut: optedOut.map((s) => s.email), sends, earlierSends, engagement, swag };
}

/** Signed in to the app since the list was read? (their account by id, or any account with that email). */
export async function onAppNow(row) {
  const who = [{ email: row.email }];
  const id = /^u-([a-f0-9]{24})$/.exec(String(row.id || ""))?.[1];
  if (id) who.push({ _id: id });
  return !!(await User.exists({ $and: [{ $or: who }, { $or: [{ appOnboarded: true }, { lastActiveAt: { $ne: null } }] }] }));
}

/**
 * sendTo(row, by, { force }) → the Date it went, "skipped" (someone else has it, or sent within the cool-down) or, with
 * `recheck` (sends that skip people already on the app), "usingApp" (they signed in since the list was read).
 * Throws when the email service refuses it (recorded as failed). `template`: loadInviteTemplate's result; `swag`: the
 * contest's settings (services/swagRules.js swagSettings): while it's on the email carries the offer and the send is
 * claimed under the swag version's key.
 */
export function makeInviteSender({ CampaignSend, template, swag = null, recheck = false, send = sendAppInviteEmail }) {
  const on = !!swag?.enabled;
  const sendTo = makeReminderSender({
    store: campaignSendStore(CampaignSend, { campaign: inviteSendKey(on), cooldownMs: COOLDOWN_MS }),
    send: ({ to, row, track }) => send({ to, person: row, copy: template?.copy || {}, options: template?.options, swag: on ? swag : null, track }),
  });
  return async (row, by, opts) => (recheck && (await onAppNow(row)) ? "usingApp" : sendTo(row, by, opts));
}
