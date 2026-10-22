import User from "../models/User.js";
import { avatarFor } from "./socialHelpers.js";

/* Avatar URLs for the authors of a list (posts, comments, discussion replies, group messages): their uploaded
   photo, else a speaker's website photo (services/speakerPhotos.js), else none. Oct 22 2026. */

/** authorId → avatar URL, for the people who have one (one query). */
export async function avatarUrls(ids) {
  const uniq = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!uniq.length) return new Map();
  const rows = await User.find({ _id: { $in: uniq } }).select("name email tickets.ticketId avatarVersion").lean();
  return new Map(rows.map((u) => [String(u._id), avatarFor(u)]).filter(([, url]) => url));
}

/** The `authorAvatarUrl` for one author from avatarUrls()'s map ("" when none). */
export const authorAvatar = (avatars, authorId) => avatars.get(String(authorId)) || "";
