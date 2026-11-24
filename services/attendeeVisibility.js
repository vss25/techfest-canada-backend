import EventConfig from "../models/EventConfig.js";
import Attendee from "../models/Attendee.js";

/* =========================================================
   Per-event attendee visibility (Phase 2)
   ---------------------------------------------------------
   The policy lives on the event (models/EventConfig.js
   `attendeeVisibility`): what the event exposes about its own
   attendees (`mode`: hidden | count | names | profiles) and to
   whom (`audience`: public | own-event | all-events | staff-only),
   plus `sharedWith`: extra eventKeys the event is shared with.

   This service is the one place that turns (viewer, target event)
   into an answer. Every people-reading endpoint asks it first and
   shapes its payload from `visibleMode`:

     hidden    no people, no count
     count     a number only, never a person row
     names     first/last name + company + title, nothing else
     profiles  the endpoint's full payload, as before

   Rules that never bend:
   - Staff (an account with role "admin", the same check as
     middleware/adminAuth.js requireAdmin and routes/social.js
     isAdmin) always get profiles.
   - A missing EventConfig means the closed default
     (hidden + staff-only): an event nobody configured exposes
     nothing.
   - Attendee.directoryHidden (the per-pass flag) always wins:
     `directoryHiddenPeople` gives the endpoints the people to
     leave out whatever the event's mode says.
   - Sharing is mutual for reads: if either event lists the other
     in sharedWith, both events' attendees can read each other
     (subject to the mode). Admin's matrix writes one side; the
     read treats the pair as shared either way.

   Events are identified by eventKey. Requests that carry no
   eventKey are about the 2026 main event (DEFAULT_EVENT_KEY):
   its record is seeded profiles + own-event, so the shipped apps
   see exactly the directory they see today.
========================================================= */

export const DEFAULT_EVENT_KEY = "ttfc-2026-main";
export const VISIBILITY_MODES = ["hidden", "count", "names", "profiles"];
export const VISIBILITY_AUDIENCES = ["public", "own-event", "all-events", "staff-only"];

const CLOSED_POLICY = Object.freeze({ mode: "hidden", audience: "staff-only", sharedWith: [] });

/** The event a request is about: its `eventKey` query value, or the 2026 main event. */
export const eventKeyOf = (value) => {
  const key = typeof value === "string" ? value.trim() : "";
  return key || DEFAULT_EVENT_KEY;
};

/** A Mongo clause for one event's rows (Nov 23 2026): `field` is `key`, or, for the 2026 main event, missing too
    (rows from before the event spine). No key → {} (every event, as before). */
export const eventClause = (key, field = "eventKey") => {
  const k = typeof key === "string" ? key.trim().slice(0, 80) : "";
  if (!k) return {};
  return { [field]: k === DEFAULT_EVENT_KEY ? { $in: [k, null] } : k };
};

/** Accounts and passes cut down to one event's passes (Nov 23 2026): each account keeps only that event's tickets
    (none left: dropped), passes for other events are dropped. For a campaign about one event. */
export function onlyEventPasses({ users = [], guests = [] } = {}, key = DEFAULT_EVENT_KEY) {
  return {
    users: (users || []).map((u) => ({ ...u, tickets: (u?.tickets || []).filter((t) => ticketEventKey(t) === key) })).filter((u) => u.tickets.length),
    guests: (guests || []).filter((g) => ticketEventKey(g) === key),
  };
}

/** Staff = an admin account (the check every staff gate in this codebase uses). */
export const isStaffViewer = (user) => !!user && user.role === "admin";

/** A pass's event: the stored eventKey, or the 2026 main event for rows from before the event spine. */
export const ticketEventKey = (ticket) =>
  (typeof ticket?.eventKey === "string" && ticket.eventKey) || DEFAULT_EVENT_KEY;

/** The events an account holds passes for, from the passes stored on the account itself. */
export function accountEventKeys(user) {
  const keys = new Set();
  for (const t of Array.isArray(user?.tickets) ? user.tickets : []) keys.add(ticketEventKey(t));
  return keys;
}

/**
 * Every event the viewer holds a pass for: the passes on their account plus
 * their Attendee records (passes they claimed, and guest passes carrying
 * their email — the same "same person" rule the directory merges by).
 */
export async function viewerEventKeys(user) {
  const keys = accountEventKeys(user);
  if (!user?._id) return keys;
  const clauses = [{ claimedBy: user._id }];
  const email = String(user.email || "").trim().toLowerCase();
  if (email) clauses.push({ email });
  const rows = await Attendee.find({ $or: clauses }).distinct("eventKey");
  for (const k of rows) keys.add(typeof k === "string" && k ? k : DEFAULT_EVENT_KEY);
  return keys;
}

/** The event's stored policy, normalised; the closed default when there is no record. */
export async function visibilityPolicy(eventKey) {
  const doc = await EventConfig.findOne({ eventKey }).select("attendeeVisibility").lean();
  const v = doc?.attendeeVisibility;
  if (!v) return { ...CLOSED_POLICY };
  return {
    mode: VISIBILITY_MODES.includes(v.mode) ? v.mode : "hidden",
    audience: VISIBILITY_AUDIENCES.includes(v.audience) ? v.audience : "staff-only",
    sharedWith: Array.isArray(v.sharedWith) ? v.sharedWith.filter((k) => typeof k === "string") : [],
  };
}

/**
 * The answer for one viewer looking at one event:
 *   { eventKey, policy, staff, relationship, audiencePass, visibleMode }
 * relationship: "staff" | "own-event" | "shared" | "all-events" | "public" | "none"
 * visibleMode folds the audience in: a viewer the audience shuts out gets
 * "hidden" whatever the stored mode says.
 */
export async function resolveVisibility({ user = null, targetEventKey } = {}) {
  const eventKey = eventKeyOf(targetEventKey);
  const policy = await visibilityPolicy(eventKey);

  if (isStaffViewer(user)) {
    return { eventKey, policy, staff: true, relationship: "staff", audiencePass: true, visibleMode: "profiles" };
  }
  if (!user) {
    const audiencePass = policy.audience === "public";
    return { eventKey, policy, staff: false, relationship: "public", audiencePass, visibleMode: audiencePass ? policy.mode : "hidden" };
  }

  const mine = await viewerEventKeys(user);
  // An account with no passes at all counts as the default event's own for the
  // default event only: before the event spine every account was a 2026
  // account and sign-in was the only gate, so the 2026 event must keep
  // answering its policy to them exactly as it does to its pass holders.
  // For any later event, no pass still means no relationship.
  const own = mine.has(eventKey) || (mine.size === 0 && eventKey === DEFAULT_EVENT_KEY);
  // sharedWith is an explicit grant on top of the audience rule (the schema's
  // own wording), and reads are mutual: my event listing theirs counts too.
  let shared = policy.sharedWith.some((k) => mine.has(k));
  if (!shared && mine.size) {
    shared = !!(await EventConfig.exists({
      eventKey: { $in: [...mine] },
      "attendeeVisibility.sharedWith": eventKey,
    }));
  }

  let relationship = "none";
  let audiencePass = false;
  if (own) {
    relationship = "own-event";
    audiencePass = policy.audience !== "staff-only";
  } else if (shared) {
    relationship = "shared";
    audiencePass = true;
  } else if (mine.size) {
    relationship = "all-events";
    audiencePass = policy.audience === "all-events" || policy.audience === "public";
  } else if (policy.audience === "public") {
    relationship = "public";
    audiencePass = true;
  }
  return { eventKey, policy, staff: false, relationship, audiencePass, visibleMode: audiencePass ? policy.mode : "hidden" };
}

/** May this viewer be shown person rows at all (names or profiles)? */
export const canSeePeople = (vis) => vis.visibleMode === "names" || vis.visibleMode === "profiles";

/**
 * Does this account belong to the event (as a directory entry)? An account
 * with passes belongs to their events; an account with no passes at all
 * (staff, volunteers, people on the app before buying) belongs to the
 * default event only — which is where they show today.
 */
export function userBelongsToEvent(user, eventKey) {
  const tickets = Array.isArray(user?.tickets) ? user.tickets : [];
  if (!tickets.length) return eventKey === DEFAULT_EVENT_KEY;
  return tickets.some((t) => ticketEventKey(t) === eventKey);
}

/** Does this guest pass belong to the event? */
export const guestBelongsToEvent = (guest, eventKey) =>
  (typeof guest?.eventKey === "string" && guest.eventKey ? guest.eventKey : DEFAULT_EVENT_KEY) === eventKey;

/**
 * The people an event's directory must leave out whatever the mode says:
 * passes flagged Attendee.directoryHidden for this event.
 * → { userIds: Set<account id> (from claimedBy), attendeeIds: Set<Attendee _id> (guest rows) }
 */
export async function directoryHiddenPeople(eventKey) {
  const rows = await Attendee.find({ eventKey, directoryHidden: true }).select("_id claimedBy").lean();
  return {
    userIds: new Set(rows.map((r) => r.claimedBy).filter(Boolean).map(String)),
    attendeeIds: new Set(rows.map((r) => String(r._id))),
  };
}

/** Is this directory entry one of the directoryHidden people? (Entry ids: account ids, or `guest:<Attendee _id>`.) */
export function isHiddenEntry(person, hidden) {
  if (!hidden) return false;
  const id = String(person?.id || "");
  if (hidden.userIds.has(id)) return true;
  return id.startsWith("guest:") && hidden.attendeeIds.has(id.slice("guest:".length));
}

export const splitName = (name) => {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || "", lastName: parts.slice(1).join(" ") };
};

/**
 * The `names` mode payload for one person: first/last name + company +
 * title, and nothing else — no email, phone, socials, avatar, topics or
 * ticket details, and nothing nested that could carry them.
 */
export function namesShape(person) {
  const { firstName, lastName } = splitName(person?.name);
  return {
    id: person?.id != null ? String(person.id) : person?._id ? String(person._id) : "",
    name: person?.name || "",
    firstName,
    lastName,
    organization: person?.organization || "",
    jobTitle: person?.jobTitle || "",
  };
}
