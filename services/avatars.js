import User from "../models/User.js";
import { avatarFor } from "./socialHelpers.js";
import { speakerIdOf } from "./speakerPhotos.js";

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

/** authorId → { authorAvatarUrl, authorSpeakerId } for the authors of a list (one query): their photo, and the website
    speaker they are ("" when not one), so a tap on the name opens the speaker page, else their profile (authorId). */
export async function authorInfo(ids) {
  const uniq = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!uniq.length) return new Map();
  const rows = await User.find({ _id: { $in: uniq } }).select("name email tickets.ticketId avatarVersion").lean();
  return new Map(rows.map((u) => [String(u._id), { authorAvatarUrl: avatarFor(u), authorSpeakerId: speakerIdOf(u) }]));
}

/** The author fields for one id from authorInfo()'s map ("" when unknown). */
export const authorFields = (info, authorId) => info.get(String(authorId)) || { authorAvatarUrl: "", authorSpeakerId: "" };

/** The same for the signed-in person (a User doc with name, avatarVersion and tickets / email). */
export const ownAuthorFields = (user) => ({ authorAvatarUrl: avatarFor(user), authorSpeakerId: speakerIdOf(user) });
