import mongoose from "mongoose";
import { createHash } from "node:crypto";
import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import Rsvp from "../models/Rsvp.js";
import {
  SocialPost, SocialComment, SocialConnection, SocialMessage,
  SessionRegistration, SessionQuestion, SessionVote,
} from "../models/Social.js";
import { Discussion, DiscussionReply, CommunityGroup, GroupMessage } from "../models/Community.js";
import { AppEvent, Block, Report } from "../models/Admin.js";
import AppNotification from "../models/AppNotification.js";
import ActivityEvent from "../models/ActivityEvent.js";
import Brochure from "../models/Brochure.js";
import Agenda from "../models/Agenda.js";
import FormSubmission from "../models/FormSubmission.js";
import Subscription from "../models/Subscription.js";
import CampaignSend from "../models/CampaignSend.js";
import EmailTracking from "../models/EmailTracking.js";
import Lead from "../models/Lead.js";
import Nomination from "../models/Nomination.js";
import Audience from "../models/Audience.js";
import SignInRequest from "../models/SignInRequest.js";
import PavilionApplication from "../models/PavilionApplication.js";
import PavilionDeposit from "../models/PavilionDeposit.js";
import Kyc from "../models/Kyc.js";
import { normalizeTicketId } from "./ticketAccess.js";

/* =========================================================
   Removing people
   ---------------------------------------------------------
   deleteAccount   the app's "Delete my account" (Apple guideline
                   5.1.1(v)) and Admin › App › People: the account and
                   everything it posted. Paid tickets survive: each goes
                   back to a guest Attendee record so it still works at
                   the door and in the admin attendee list.
   deletePerson    Admin › People › Delete person (management, Oct 19
                   2026: "deletes them from the entire database"): the
                   same app cascade, plus every pass and ticket row,
                   their RSVPs and everything kept under an email address
                   only they use (brochure downloads, form submissions,
                   newsletter, email sends and tracking, sales leads,
                   nominations they sent or received, agenda downloads,
                   sign-in codes, marketing lists). planPersonDeletion
                   counts the same filters first, so what the dialog shows
                   is what goes.
   Never deleted here: Stripe's payment records (Stripe keeps them), the
   website's speaker list (Sanity, Admin › Speakers), company records that
   only name them as a contact (exhibitor KYC forms, India Pavilion
   applications and deposits) and the admin audit log. Those are counted
   and listed as kept.
========================================================= */

/** The app cascade for one account id: [{ key, label, model, filter, update? }] (no update = delete). */
function socialOps(id, refIds = [], postIds = [], discussionIds = []) {
  const uid = String(id);
  return [
    { key: "comments", label: "Comments (theirs, and on their posts)", model: SocialComment, filter: { $or: [{ authorId: id }, { postId: { $in: postIds } }] } },
    { key: "posts", label: "Posts", model: SocialPost, filter: { authorId: id } },
    { key: "connections", label: "Connections and requests", model: SocialConnection, filter: { $or: [{ fromUserId: id }, { toUserId: id }] } },
    { key: "messages", label: "Chat messages (both sides of their chats)", model: SocialMessage, filter: { $or: [{ fromUserId: id }, { toUserId: id }] } },
    { key: "savedSessions", label: "Sessions saved in the app", model: SessionRegistration, filter: { userId: id } },
    { key: "questions", label: "Session Q&A questions", model: SessionQuestion, filter: { authorId: id } },
    { key: "pollVotes", label: "Poll votes", model: SessionVote, filter: { userId: id } },
    { key: "discussions", label: "Discussions they started", model: Discussion, filter: { authorId: id } },
    { key: "replies", label: "Discussion replies (theirs, and in their discussions)", model: DiscussionReply, filter: { $or: [{ authorId: id }, { discussionId: { $in: discussionIds } }] } },
    { key: "groupMessages", label: "Group chat messages", model: GroupMessage, filter: { authorId: id } },
    { key: "groupMemberships", label: "Group memberships (they leave the group)", model: CommunityGroup, filter: { members: id }, update: { $pull: { members: id } } },
    { key: "groupsOwned", label: "Groups they started (kept for the members, owner shown as \"Former attendee\")", model: CommunityGroup, filter: { ownerId: id }, update: { $set: { ownerName: "Former attendee" } } },
    { key: "likes", label: "Likes on others' posts (taken off)", model: SocialPost, filter: { $or: [{ likes: id }, { everLiked: id }] }, update: { $pull: { likes: id, everLiked: id } } },
    { key: "mentions", label: "Mentions of them in others' posts (taken off)", model: SocialPost, filter: { mentions: { $elemMatch: { type: "user", id: uid } } }, update: { $pull: { mentions: { type: "user", id: uid } } } },
    { key: "upvotes", label: "Q&A upvotes (taken off)", model: SessionQuestion, filter: { upvotes: id }, update: { $pull: { upvotes: id } } },
    { key: "follows", label: "Discussions they follow (unfollowed)", model: Discussion, filter: { $or: [{ followers: id }, { unfollowed: id }] }, update: { $pull: { followers: id, unfollowed: id } } },
    { key: "blocks", label: "Blocks (by them or of them)", model: Block, filter: { $or: [{ userId: id }, { blockedId: id }] } },
    { key: "reports", label: "Reports they made or about them", model: Report, filter: { $or: [{ reporterId: id }, { targetType: "user", targetId: uid }] } },
    { key: "notifications", label: "App notifications", model: AppNotification, filter: { userId: id } },
    { key: "activity", label: "Activity (likes, comments, mentions, replies)", model: ActivityEvent, filter: { $or: [{ userId: id }, { actorId: id }, { refId: { $in: refIds } }] } },
  ];
}

/** Ids of what the account wrote that others' rows point at. */
async function authored(id) {
  const [posts, discussions] = await Promise.all([
    SocialPost.find({ authorId: id }).select("_id").lean(),
    Discussion.find({ authorId: id }).select("_id").lean(),
  ]);
  const postIds = posts.map((p) => p._id);
  const discussionIds = discussions.map((d) => d._id);
  return { postIds, discussionIds, refIds: [...postIds, ...discussionIds] };
}

const runOp = (op) => (op.update ? op.model.updateMany(op.filter, op.update) : op.model.deleteMany(op.filter));
const countOp = (op) => op.model.countDocuments(op.filter);
const doneCount = (r, op) => (op.update ? r?.modifiedCount ?? 0 : r?.deletedCount ?? 0);

/* Deletes an account and everything it posted (Apple guideline 5.1.1(v)).
   Paid tickets survive: each one goes back to a guest Attendee record so
   it still works at the door and in the admin attendee list. */
export async function deleteAccount(userId) {
  const user = await User.findById(userId);
  if (!user) return false;
  const id = user._id;

  for (const t of user.tickets || []) {
    if (!t.ticketId || /^BOOTH-/i.test(t.ticketId)) continue;
    const existing = await Attendee.findOne({ ticketId: t.ticketId });
    if (existing) {
      existing.claimedBy = undefined;
      existing.directoryHidden = true;   // they left the app: don't list them again
      existing.checkedIn = existing.checkedIn || !!t.checkedIn;
      await existing.save();
    } else {
      await Attendee.create({
        name: user.name || "Guest", email: user.email, ticketId: t.ticketId, ticketType: t.type,
        purchaseDate: t.purchaseDate, checkedIn: !!t.checkedIn, checkedInAt: t.checkedInAt,
        directoryHidden: true,
      });
    }
  }

  const { postIds, discussionIds, refIds } = await authored(id);
  const ops = [...socialOps(id, refIds, postIds, discussionIds), { key: "appEvents", model: AppEvent, filter: { userId: id } }];
  await Promise.all(ops.map(runOp));
  await User.deleteOne({ _id: id });
  return true;
}

/* ---------- Admin › People › Delete person ---------- */

const PLACEHOLDER = /@ticket\.thetechfestival\.com$/i;
const escRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exactCi = (s) => new RegExp(`^\\s*${escRx(s)}\\s*$`, "i");
const isOid = (v) => mongoose.isValidObjectId(String(v || "")) && /^[a-f0-9]{24}$/i.test(String(v || ""));
const realEmail = (e) => { const s = String(e || "").trim().toLowerCase(); return s && !PLACEHOLDER.test(s) ? s : ""; };

/** sha256 of an email, first 16 hex characters, for the audit row (never the address itself). */
export const emailHash = (email) => (realEmail(email) ? createHash("sha256").update(realEmail(email)).digest("hex").slice(0, 16) : "");

/**
 * What a directory person (services/people.js buildPeople) is made of, for deletion. Pure.
 * `everyone`: the whole directory, so an email another person also uses (a buyer who bought a
 * colleague's pass under their own address) is never used to delete anything.
 * → { userId, attendeeIds, ticketIds, ticketKeys, rsvpIds, dupRsvpIds, emails, sharedEmails, mainEmail, speaker }
 */
export function personDeletionScope(p, everyone = []) {
  const userId = p?.user?._id ? String(p.user._id) : "";
  const attendeeIds = [...new Set((p?.attendees || []).map((a) => String(a._id)))];
  const raw = new Set();
  for (const t of p?.passList || []) if (t.ticketId) raw.add(String(t.ticketId));
  for (const a of p?.attendees || []) if (a.ticketId) raw.add(String(a.ticketId));
  for (const t of p?.user?.tickets || []) if (t?.ticketId) raw.add(String(t.ticketId));
  const ticketIds = [...new Set([...raw].flatMap((t) => [t, normalizeTicketId(t), normalizeTicketId(t).toUpperCase()]).filter(Boolean))];
  const ticketKeys = [...new Set([...raw].filter((t) => !/^BOOTH-/i.test(t)).map((t) => `t:${normalizeTicketId(t)}`))];
  const emailsOf = (o) => new Set([realEmail(o?.user?.email), ...[...(o?.emails || [])].map(realEmail)].filter(Boolean));
  const mine = emailsOf(p);
  const others = new Set();
  for (const o of everyone || []) if (o !== p) for (const e of emailsOf(o)) others.add(e);
  return {
    userId, attendeeIds, ticketIds, ticketKeys,
    // Tickets kept on the account itself (bought while signed in: no pass row of their own); they go with it.
    accountTickets: (p?.user?.tickets || []).filter((t) => t?.ticketId).length,
    rsvpIds: [...new Set((p?.rsvps || []).map((r) => String(r._id)))],
    dupRsvpIds: [...new Set((p?.dupRsvps || []).map((r) => String(r._id)))],
    emails: [...mine].filter((e) => !others.has(e)),
    sharedEmails: [...mine].filter((e) => others.has(e)),
    mainEmail: realEmail(p?.user?.email) || realEmail(p?.email) || [...mine][0] || "",
    speaker: p?.speaker ? { id: String(p.speaker._id || ""), name: String(p.speaker.name || "") } : null,
  };
}

/** Every delete / update for a person, in the order they run (the account last, so a failure can be run again). */
async function personOps(scope) {
  const ops = [];
  const id = isOid(scope.userId) ? new mongoose.Types.ObjectId(scope.userId) : null;
  const emailRx = scope.emails.map(exactCi);
  if (id) {
    const { postIds, discussionIds, refIds } = await authored(id);
    ops.push(...socialOps(id, refIds, postIds, discussionIds));
    // Analytics and web-app (PWA) events: theirs, and the signed-out ones from devices only they used.
    const devices = (await AppEvent.distinct("deviceId", { userId: id })).filter(Boolean);
    const shared = devices.length ? await AppEvent.distinct("deviceId", { deviceId: { $in: devices }, userId: { $nin: [null, id] } }) : [];
    const own = devices.filter((d) => !shared.includes(d));
    ops.push({
      key: "appEvents", label: "App and web-app (PWA) usage events", model: AppEvent,
      filter: { $or: [{ userId: id }, ...(own.length ? [{ deviceId: { $in: own }, userId: null }] : [])] },
    });
  }
  const attendeeOids = scope.attendeeIds.filter(isOid).map((x) => new mongoose.Types.ObjectId(x));
  const passOr = [
    ...(attendeeOids.length ? [{ _id: { $in: attendeeOids } }] : []),
    ...(scope.ticketIds.length ? [{ ticketId: { $in: scope.ticketIds } }] : []),
    ...(id ? [{ claimedBy: id }] : []),
  ];
  if (passOr.length) ops.push({ key: "passes", label: "Passes and ticket records (with their check-ins)", model: Attendee, filter: { $or: passOr } });
  const rsvpOids = scope.rsvpIds.filter(isOid).map((x) => new mongoose.Types.ObjectId(x));
  const rsvpOr = [
    ...(rsvpOids.length ? [{ _id: { $in: rsvpOids } }] : []),
    ...(scope.rsvpIds.length ? [{ mergedInto: { $in: scope.rsvpIds } }] : []),
    ...(scope.ticketKeys.length ? [{ key: { $in: scope.ticketKeys } }] : []),
  ];
  if (rsvpOr.length) {
    ops.push({ key: "rsvps", label: "RSVPs (and older copies merged into them)", model: Rsvp, filter: { $or: rsvpOr } });
    // A possible duplicate of their RSVP (someone with the same name) stays as its own RSVP, as Leads › RSVPs › Delete does.
    if (scope.rsvpIds.length) {
      ops.push({ key: "rsvpDuplicatesUnflagged", label: "Possible duplicates of their RSVP (kept, no longer flagged)", model: Rsvp,
        filter: { duplicateOf: { $in: scope.rsvpIds } }, update: { $unset: { duplicateOf: "" } } });
    }
  }
  if (emailRx.length) {
    const byEmail = { email: { $in: emailRx } };
    ops.push(
      { key: "brochureDownloads", label: "Brochure download leads", model: Brochure, filter: byEmail },
      { key: "agendaDownloads", label: "Agenda download sign-ups", model: Agenda, filter: byEmail },
      { key: "formSubmissions", label: "Website form submissions", model: FormSubmission, filter: byEmail },
      { key: "nominations", label: "Award nominations they sent or received", model: Nomination, filter: { $or: [{ nominatorEmail: { $in: emailRx } }, { nomineeEmail: { $in: emailRx } }] } },
      { key: "salesLeads", label: "Sales leads", model: Lead, filter: byEmail },
      { key: "newsletter", label: "Newsletter subscription", model: Subscription, filter: byEmail },
      { key: "campaignSends", label: "Email send records (reminders, campaigns)", model: CampaignSend, filter: byEmail },
      { key: "emailTracking", label: "Email open and click tracking", model: EmailTracking, filter: byEmail },
      { key: "signInCodes", label: "Sign-in codes", model: SignInRequest, filter: byEmail },
      { key: "marketingLists", label: "Marketing lists they're on (taken off the list)", model: Audience,
        filter: { "contacts.email": { $in: emailRx } }, update: { $pull: { contacts: { email: { $in: emailRx } } } } },
    );
  }
  if (id) ops.push({ key: "account", label: "App and website account (profile, contact card, push tokens, points)", model: User, filter: { _id: id } });
  return ops;
}

/** Records that stay, listed in the dialog (with counts where we have them). */
async function keptCounts(scope) {
  const emailRx = scope.emails.map(exactCi);
  const none = Promise.resolve(0);
  const [pavilion, deposits, kyc] = await Promise.all([
    emailRx.length ? PavilionApplication.countDocuments({ repEmail: { $in: emailRx } }) : none,
    emailRx.length ? PavilionDeposit.countDocuments({ $or: [{ email: { $in: emailRx } }, { contactEmail: { $in: emailRx } }] }) : none,
    emailRx.length ? Kyc.countDocuments({ primary_email: { $in: emailRx } }) : none,
  ]);
  return [
    { key: "stripe", label: "Stripe's payment records: Stripe keeps them (refunds and receipts are done in Stripe)" },
    scope.speaker
      ? { key: "speakerList", label: `The website speaker list in the CMS (Sanity): ${scope.speaker.name} stays on it until removed in Admin › Speakers`, onWebsite: true }
      : { key: "speakerList", label: "The website speaker list in the CMS (Sanity): they're not on it", onWebsite: false },
    ...(pavilion ? [{ key: "pavilion", label: "India Pavilion applications naming them as the contact (the company's record)", count: pavilion }] : []),
    ...(deposits ? [{ key: "deposits", label: "India Pavilion deposits paid under their email (payment records)", count: deposits }] : []),
    ...(kyc ? [{ key: "kyc", label: "Exhibitor KYC forms naming them as the contact (the company's record)", count: kyc }] : []),
    { key: "audit", label: "The admin audit log (staff history; this deletion is logged without their name or email)" },
    ...(scope.sharedEmails.length
      ? [{ key: "sharedEmail", label: "Records under an email another person here also uses (a buyer's or a colleague's): left alone", count: scope.sharedEmails.length }]
      : []),
  ];
}

/** The account's own tickets, listed before the account they're deleted with. */
function withAccountTickets(items, scope) {
  if (!scope.accountTickets || !items.some((x) => x.key === "account" && x.count)) return items;
  const at = items.findIndex((x) => x.key === "account");
  const row = { key: "accountTickets", label: "Tickets and passes on their account (with their check-ins)", count: scope.accountTickets, change: "delete" };
  return [...items.slice(0, at), row, ...items.slice(at)];
}
const totalOf = (items) => items.filter((x) => x.change === "delete").reduce((n, x) => n + x.count, 0);

/** What deletePerson would remove: { items: [{ key, label, count, change }], kept: [...], total }. Counts only. */
export async function planPersonDeletion(scope) {
  const ops = await personOps(scope);
  const counts = await Promise.all(ops.map(countOp));
  const items = withAccountTickets(ops.map((op, i) => ({ key: op.key, label: op.label, count: counts[i], change: op.update ? "update" : "delete" })), scope);
  return { items, kept: await keptCounts(scope), total: totalOf(items) };
}

/** Removes the person (see the top of this file) → { items: [{ key, label, count, change }], total } (what was done). */
export async function deletePerson(scope) {
  const ops = await personOps(scope);
  const items = [];
  for (const op of ops) {
    const r = await runOp(op);
    items.push({ key: op.key, label: op.label, count: doneCount(r, op), change: op.update ? "update" : "delete" });
  }
  const all = withAccountTickets(items, scope);
  return { items: all, total: totalOf(all) };
}
