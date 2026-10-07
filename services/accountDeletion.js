import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import {
  SocialPost, SocialComment, SocialConnection, SocialMessage,
  SessionRegistration, SessionQuestion, SessionVote,
} from "../models/Social.js";
import { Discussion, DiscussionReply, CommunityGroup, GroupMessage } from "../models/Community.js";
import { AppEvent, Block, Report } from "../models/Admin.js";
import AppNotification from "../models/AppNotification.js";

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
      existing.checkedIn = existing.checkedIn || !!t.checkedIn;
      await existing.save();
    } else {
      await Attendee.create({
        name: user.name || "Guest", email: user.email, ticketId: t.ticketId, ticketType: t.type,
        purchaseDate: t.purchaseDate, checkedIn: !!t.checkedIn, checkedInAt: t.checkedInAt,
      });
    }
  }

  const posts = await SocialPost.find({ authorId: id }).select("_id").lean();
  await Promise.all([
    SocialComment.deleteMany({ $or: [{ authorId: id }, { postId: { $in: posts.map((p) => p._id) } }] }),
    SocialPost.deleteMany({ authorId: id }),
    SocialConnection.deleteMany({ $or: [{ fromUserId: id }, { toUserId: id }] }),
    SocialMessage.deleteMany({ $or: [{ fromUserId: id }, { toUserId: id }] }),
    SessionRegistration.deleteMany({ userId: id }),
    SessionQuestion.deleteMany({ authorId: id }),
    SessionVote.deleteMany({ userId: id }),
    Discussion.deleteMany({ authorId: id }),
    DiscussionReply.deleteMany({ authorId: id }),
    GroupMessage.deleteMany({ authorId: id }),
    CommunityGroup.updateMany({}, { $pull: { members: id } }),
    AppEvent.deleteMany({ userId: id }),
    Block.deleteMany({ $or: [{ userId: id }, { blockedId: id }] }),
    Report.deleteMany({ reporterId: id }),
    AppNotification.deleteMany({ userId: id }),
  ]);
  await User.deleteOne({ _id: id });
  return true;
}
