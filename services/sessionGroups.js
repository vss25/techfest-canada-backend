/* =========================================================
   Session chats (Oct 21 2026)
   ---------------------------------------------------------
   The organiser: "Create a session group automatically 30 min
   before each session starts; add everyone who showed interest in
   attending; the group stays active after the session. Not for
   breakfast, lunch or dinner sessions."

   Every minute one server (an atomic claim on the JobLock row
   "session-groups", so with several servers each run happens once)
   reads the agenda (Sanity `session` docs, cached 60 s) and, for each
   session that starts within LEAD_MIN minutes and hasn't ended,
   makes its group chat if it has none:
     name         the session title (at most 60 characters)
     description  "Session chat · Mon 26 Oct 9:05 AM · <room>"
     sessionId    the id the apps use (Sanity sessionId, else _id),
                  unique in the collection (models/Community.js), so a
                  session gets one group even if two servers race
     owner        the system (SYSTEM_ID, "TTFC"), status approved
     members      everyone registered for it (SessionRegistration,
                  the apps' only "interested / going" marker) except
                  suspended accounts. People hidden from the app are
                  added like anyone else and stay invisible to others,
                  as in every group (services/appHide.js).
   and posts one welcome message from the system ("Welcome to the
   <title> chat. It starts at <time> in <room>."), with no push: only
   messages people send push, under the usual group rules.

   Staff and moderators aren't added: the moderate right already lets
   them read, write in and moderate any group's chat.

   After that: registering before the session ends adds them at once
   (onRegistration, from POST /api/social/sessions/:id/register) and
   every run tops the group up from the registrations; un-registering
   before it starts takes them out, after the start they stay. Someone
   who leaves the chat isn't added back unless they register again.
   The group is never archived or closed.

   Skipped (no group): meals and breaks: a title or type with
   breakfast, brunch, lunch, luncheon, dinner (gala dinner too),
   break (coffee break, networking break; not "break-out") or
   registration, and the agenda's own break slots (isBreak, format
   "break").

   Times are Toronto (EDT, UTC-4) on 26-27 Oct 2026 (services/runOfShow.js).
   The pure parts are exported and unit-tested (test/session-groups.test.js).
========================================================= */

import os from "node:os";
import mongoose from "mongoose";
import User from "../models/User.js";
import JobLock from "../models/JobLock.js";
import { CommunityGroup, GroupMessage } from "../models/Community.js";
import { SessionRegistration } from "../models/Social.js";
import { makeAgendaCache } from "./points.js";
import { SANITY_PROJECT } from "./rsvp.js";
import { DAYS, UTC_OFFSET, fmtTime } from "./runOfShow.js";

export const LEAD_MIN = 30;
export const NAME_MAX = 60;
/** The system's id: the owner of session chats and the author of their welcome message (no account has it). */
export const SYSTEM_ID = new mongoose.Types.ObjectId("000000000000000000000000");
export const SYSTEM_NAME = "TTFC";
/** The room the apps show when the agenda has none (iOS SessionService, Android, the web app). */
export const DEFAULT_ROOM = "Centre Stage · Harbour Ballroom";
export const JOB_ID = "session-groups";
const EVERY_MS = 60_000;
const CLAIM_MS = 50_000;   // a little under the interval, so the next minute's run can claim it

const line = (v, max = 200) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The id the apps use for a session: its `sessionId`, else its Sanity `_id`. */
export const appSessionId = (s) => line(s?.sessionId, 80) || line(s?._id, 80);
/** Every id a registration for this session may carry. */
export const sessionIds = (s) => [...new Set([line(s?.sessionId, 80), line(s?._id, 80)].filter(Boolean))];

const MEAL_RX = /\b(breakfast|brunch|lunch|luncheon|dinner|registration)\b|\bbreak\b(?!\s*-?\s*out)/i;

/** A meal, a break or registration: no chat. Title or type words, or the agenda's own break flag / format. */
export function isMealOrBreak(s) {
  if (!s) return true;
  if (s.isBreak === true || String(s.format || "").toLowerCase() === "break") return true;
  return MEAL_RX.test(String(s.title || "")) || MEAL_RX.test(String(s.type || ""));
}

/** { startsAt, endsAt } (Dates) for a session on day 1 or 2, or null when its day or times can't be read. */
export function sessionTimes(s) {
  const day = DAYS[Number(s?.day)];
  const start = String(s?.time || "").trim();
  const end = String(s?.endTime || "").trim();
  if (!day || !HHMM.test(start)) return null;
  const startsAt = new Date(`${day.date}T${start}:00${UTC_OFFSET}`);
  let endsAt = HHMM.test(end) ? new Date(`${day.date}T${end}:00${UTC_OFFSET}`) : null;
  // No end, or an end before the start: an hour.
  if (!endsAt || endsAt <= startsAt) endsAt = new Date(startsAt.getTime() + 60 * 60_000);
  return { startsAt, endsAt };
}

/** The room the apps show for it. */
export const roomOf = (s) => line(s?.stage, 80) || DEFAULT_ROOM;

/** The group's name: the session title, at most NAME_MAX characters (cut at a word, with "…"). */
export function groupName(title) {
  const t = line(title, 400) || "Session";
  if (t.length <= NAME_MAX) return t;
  const cut = t.slice(0, NAME_MAX - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > NAME_MAX / 2 ? cut.slice(0, at) : cut).replace(/[\s,;:.–—-]+$/, "")}…`;
}

/** "Session chat · Mon 26 Oct 9:05 AM · Harbour Ballroom" */
export function groupDescription(s) {
  const day = DAYS[Number(s?.day)];
  return `Session chat · ${day ? day.short : ""} ${fmtTime(String(s?.time || "").trim())} · ${roomOf(s)}`.replace(/\s+/g, " ");
}

/** "Welcome to the <title> chat. It starts at 9:05 AM in Harbour Ballroom." */
export function welcomeMessage(s) {
  const title = line(s?.title, 200).replace(/[.!?]+$/, "") || "session";
  return `Welcome to the ${title} chat. It starts at ${fmtTime(String(s?.time || "").trim())} in ${roomOf(s)}.`;
}

/** Sessions whose chat should exist now: not a meal or break, starting within LEAD_MIN minutes (or started) and not ended. */
export function dueSessions(sessions = [], now = new Date()) {
  const t = now.getTime();
  const out = [];
  const seen = new Set();
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || typeof s !== "object" || isMealOrBreak(s)) continue;
    const id = appSessionId(s);
    const times = sessionTimes(s);
    if (!id || !times || seen.has(id)) continue;
    if (t >= times.startsAt.getTime() - LEAD_MIN * 60_000 && t < times.endsAt.getTime()) {
      seen.add(id);
      out.push({ ...s, id, ...times });
    }
  }
  return out;
}

/** What a session's group should say now (the job keeps it in step if staff move or rename the session). */
export function groupFields(s) {
  const times = s.startsAt ? { startsAt: s.startsAt, endsAt: s.endsAt } : sessionTimes(s);
  return {
    name: groupName(s.title),
    description: groupDescription(s),
    sessionDocId: line(s._id, 80),
    sessionStartsAt: times?.startsAt,
    sessionEndsAt: times?.endsAt,
  };
}

/* ================= database ================= */

const AGENDA_QUERY = '*[_type=="session" && !(_id in path("drafts.**"))]{_id,sessionId,day,time,endTime,title,type,format,isBreak,stage}';
const AGENDA_URL = `https://${SANITY_PROJECT}.apicdn.sanity.io/v2021-10-21/data/query/production?query=${encodeURIComponent(AGENDA_QUERY)}`;
const rows = (json) => (Array.isArray(json?.result) && json.result.length ? json.result : null);
let agenda = makeAgendaCache({ url: AGENDA_URL, parse: rows, label: "SESSION GROUPS AGENDA", ttlMs: 60_000, fetchImpl: (...a) => globalThis.fetch(...a) });

/** For tests: a fresh agenda read. */
export function forgetSessionAgenda() {
  agenda = makeAgendaCache({ url: AGENDA_URL, parse: rows, label: "SESSION GROUPS AGENDA", ttlMs: 60_000, fetchImpl: (...a) => globalThis.fetch(...a) });
}

const INSTANCE = `${os.hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
const isDup = (err) => err?.code === 11000 || /E11000/.test(String(err?.message || ""));

/** Take this minute's run (true) unless another server holds it. Atomic: the row only moves while `until` has passed. */
export async function claimRun({ owner = INSTANCE, now = new Date(), ms = CLAIM_MS } = {}) {
  try {
    const r = await JobLock.findOneAndUpdate(
      { _id: JOB_ID, until: { $lte: now } },
      { $set: { until: new Date(now.getTime() + ms), owner } },
      { upsert: true, returnDocument: "after", projection: { owner: 1 } },
    ).lean();
    return r?.owner === owner;
  } catch (err) {
    if (isDup(err)) return false;   // the row exists and is held (the upsert lost the race)
    throw err;
  }
}

/** Registered people for a session (any of its ids), suspended accounts left out. */
async function registrants(s) {
  const ids = await SessionRegistration.find({ sessionId: { $in: sessionIds(s) } }).distinct("userId");
  if (!ids.length) return [];
  return User.find({ _id: { $in: ids }, banned: { $ne: true } }).distinct("_id");
}

/** The welcome message, at most once per group: claimed on the group before it's written. */
async function postWelcome(group, s, now) {
  const r = await CommunityGroup.updateOne({ _id: group._id, welcomePostedAt: { $exists: false } }, { $set: { welcomePostedAt: now } });
  if (!r.modifiedCount) return false;
  await GroupMessage.create({ groupId: group._id, authorId: SYSTEM_ID, authorName: SYSTEM_NAME, body: welcomeMessage(s), status: "approved" });
  return true;
}

/** Make the session's group if it has none → { group, created }. Safe with several servers (unique sessionId). */
async function ensureGroup(s, now) {
  const existing = await CommunityGroup.findOne({ sessionId: s.id }).lean();
  if (existing) return { group: existing, created: false };
  const members = await registrants(s);
  try {
    const g = await CommunityGroup.create({
      ...groupFields(s), sessionId: s.id, tags: [], ownerId: SYSTEM_ID, ownerName: SYSTEM_NAME,
      members, status: "approved", system: true,
    });
    return { group: g.toObject(), created: true };
  } catch (err) {
    if (!isDup(err)) throw err;
    return { group: await CommunityGroup.findOne({ sessionId: s.id }).lean(), created: false };
  }
}

/** Late registrants: add everyone registered who isn't in it and didn't leave it. One conditional update each, so
    someone leaving at the same moment isn't put back. → how many were added. */
async function topUp(group, s) {
  const have = new Set((group.members || []).map(String));
  const left = new Set((group.leftBy || []).map(String));
  const add = (await registrants(s)).filter((id) => !have.has(String(id)) && !left.has(String(id)));
  let n = 0;
  for (const id of add) {
    const r = await CommunityGroup.updateOne({ _id: group._id, leftBy: { $ne: id } }, { $addToSet: { members: id } });
    n += r.modifiedCount;
  }
  return n;
}

/** Staff moved or renamed the session: the group's name, description and times follow (until the session ends). */
async function keepInStep(group, s) {
  const want = groupFields(s);
  const changed = want.name !== group.name || want.description !== group.description
    || +want.sessionStartsAt !== +new Date(group.sessionStartsAt || 0) || +want.sessionEndsAt !== +new Date(group.sessionEndsAt || 0);
  if (changed) await CommunityGroup.updateOne({ _id: group._id }, { $set: want });
}

/**
 * One run: claim it, then make or top up the groups of the sessions due now.
 * → { claimed, due, created, added } (claimed false: another server has this minute). Never throws.
 * `held`: the caller already took the claim (claimRun), for tests of two servers working at once.
 */
export async function runSessionGroups({ now = new Date(), owner = INSTANCE, sessions = null, log = console, held = false } = {}) {
  const out = { claimed: false, due: 0, created: 0, added: 0 };
  try {
    if (!held && !(await claimRun({ owner, now }))) return out;
    out.claimed = true;
    const list = sessions || (await agenda.get());
    if (!list) return out;
    const due = dueSessions(list, now);
    out.due = due.length;
    for (const s of due) {
      try {
        const { group, created } = await ensureGroup(s, now);
        if (!group) continue;
        if (created) out.created += 1;
        else await keepInStep(group, s);
        await postWelcome(group, s, now);
        if (!created) out.added += await topUp(group, s);
      } catch (err) {
        log.error?.(`SESSION GROUP ERROR (${s.id}):`, err?.message || err);
      }
    }
    if (out.created) log.log?.(`💬 Session chats: ${out.created} made`);
  } catch (err) {
    log.error?.("SESSION GROUPS ERROR:", err?.message || err);
  }
  return out;
}

/**
 * Someone registered (registered true) or un-registered for a session (any of its ids), from
 * POST /api/social/sessions/:id/register. Before its group exists nothing happens (the job adds them).
 * Registering until the session ends adds them (and forgets that they left it); un-registering before
 * it starts takes them out; after the start they stay. → "added" | "removed" | "" . Never throws.
 */
export async function onRegistration(userId, sessionId, registered, { now = new Date(), log = console } = {}) {
  try {
    const id = line(sessionId, 80);
    if (!id || !userId) return "";
    const uid = new mongoose.Types.ObjectId(String(userId));
    const filter = { $or: [{ sessionId: id }, { sessionDocId: id }], system: true };
    if (registered) {
      const r = await CommunityGroup.updateOne({ ...filter, sessionEndsAt: { $gt: now } }, { $addToSet: { members: uid }, $pull: { leftBy: uid } });
      return r.modifiedCount ? "added" : "";
    }
    const r = await CommunityGroup.updateOne({ ...filter, sessionStartsAt: { $gt: now } }, { $pull: { members: uid } });
    return r.modifiedCount ? "removed" : "";
  } catch (err) {
    log.error?.("SESSION GROUP REGISTRATION ERROR:", err?.message || err);
    return "";
  }
}

/** Leave (join false) or join (true) a session chat as a member. Leaving is remembered (leftBy). */
export function membershipUpdate(userId, join) {
  const uid = new mongoose.Types.ObjectId(String(userId));
  return join ? { $addToSet: { members: uid }, $pull: { leftBy: uid } } : { $pull: { members: uid }, $addToSet: { leftBy: uid } };
}

/** Every minute while the server runs (after the collection's indexes exist). */
export function startSessionGroups({ everyMs = EVERY_MS } = {}) {
  const tick = () => { runSessionGroups(); };
  CommunityGroup.init().catch((err) => console.error("SESSION GROUPS INDEX ERROR:", err?.message || err)).finally(tick);
  const t = setInterval(tick, everyMs);
  t.unref?.();
  return t;
}
