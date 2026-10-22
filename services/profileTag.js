/* =========================================================
   The app Profile page's colour (Oct 20 2026)
   ---------------------------------------------------------
   The organiser: "Make the app profile page color such that a
   person marked as VIP is gold, speaker is red, staff is purple,
   media is dark blue, a person who is merely exhibitor, connect,
   influence, power, apex is green, volunteer is orange … so that I
   can see the color and figure out what kind of pass holder the
   individual is even if they show the app from a distance."
   And: "All VIPs are speakers, but all speakers not VIPs. So VIP
   overrules everything. Some speakers are media. So, media colors
   takes precedence over speaker color. All Volunteers are staff, but
   only few staff are organizers. Organizer color overrides volunteer
   color." (The "Organizer" type is called "Staff" since then.)

   Oct 21 2026, the organiser: "Don't label anyone as VIP." VIP left the
   precedence: a VIP gets the tag they'd have without the flag (Media >
   Speaker > Staff > Volunteer > pass). The flag itself stays (admin
   panel, CxO Breakfasts, messaging), it just never shows.

   GET /api/auth/me → `profileTag`: { key, label } or null. The first
   that applies:
     media      "Media"      the media type
     speaker    "Speaker"    the speaker type, or a Speaker Pass
     staff      "Staff"      the staff type (role admin, or staff's type)
     volunteer  "Volunteer"  the volunteer type (role volunteer, or the type)
     pass       their pass   any other pass holder: the best of their passes
                             ("Connect" < "Influence" < "Power" < "Apex";
                             an old "All Access" pass is Power), or
                             "Exhibitor" for the exhibitor type on a Connect
                             Pass (or with no pass)
   null: no pass and none of those. Booth orders aren't passes.
   Only the person's own Profile page uses it (the apps and the web
   app); badges elsewhere stay as they are (services/teamRoles.js
   KIND_PRIORITY). Colours (the apps and the web app use the same):
   PROFILE_TAG_COLORS. Pure, unit-tested (test/profile-tag.test.js).
========================================================= */

import { effectiveTypes, isMediaPass, isSpeakerPass, isExhibitorPass } from "./teamRoles.js";
import { tierFromTicketType } from "./rsvp.js";

/** In the order they win. */
export const PROFILE_TAG_KEYS = Object.freeze(["media", "speaker", "staff", "volunteer", "pass"]);
export const PROFILE_TAG_LABELS = Object.freeze({ media: "Media", speaker: "Speaker", staff: "Staff", volunteer: "Volunteer" });
/** Background and text colour of each, for reference (the apps and the web app hold their own copy). */
export const PROFILE_TAG_COLORS = Object.freeze({
  media: Object.freeze({ bg: "#0B3D91", text: "#FFFFFF" }),
  speaker: Object.freeze({ bg: "#D01F2F", text: "#FFFFFF" }),
  staff: Object.freeze({ bg: "#7B2FD0", text: "#FFFFFF" }),
  volunteer: Object.freeze({ bg: "#FF6B00", text: "#3A1500" }),
  pass: Object.freeze({ bg: "#18A957", text: "#052E16" }),
});

/** The four passes on sale, lowest first, and their names on the Profile page. */
const PASS_ORDER = ["connect", "influence", "power", "apex"];
const PASS_LABELS = Object.freeze({ connect: "Connect", influence: "Influence", power: "Power", apex: "Apex" });
export const EXHIBITOR_LABEL = "Exhibitor";

const isBooth = (t) => /^BOOTH-/i.test(String(t?.ticketId || "")) || /^booth/i.test(String(t?.type ?? t?.ticketType ?? ""));

/** The best of these passes' tiers ("connect" … "apex"), or "" when none is one of the four (a Speaker Pass isn't). */
export function bestPassTier(passes = []) {
  let best = -1;
  for (const p of Array.isArray(passes) ? passes : []) {
    if (!p || isBooth(p)) continue;
    const i = PASS_ORDER.indexOf(tierFromTicketType(p.type ?? p.ticketType));
    if (i > best) best = i;
  }
  return best < 0 ? "" : PASS_ORDER[best];
}

const tag = (key) => ({ key, label: PROFILE_TAG_LABELS[key] });

/**
 * The tag for a pass-only person (no app account yet): their Attendee record as the pass (its ticket type) and the
 * marks staff put on it: Media (Attendee.media), exhibitor (isExhibitorPass, staff's switch first), a Speaker
 * Pass. The same precedence as profileTagOf (a VIP mark changes nothing). Apple Wallet's signed link uses it.
 */
export function profileTagOfPass(attendee) {
  if (!attendee) return null;
  return profileTagOf({ tickets: [] }, { attendees: [attendee] });
}

/**
 * The Profile page's tag for an account → { key, label } | null (see the top of this file).
 *   user       the User document (role, types, typesOff, tickets)
 *   attendees  Attendee rows of their passes (claimed by them or with one of their ticket IDs): their
 *              Attendee.media and exhibitor marks count, and their pass types too
 *   types      what the caller already worked out (GET /auth/me: services/rightsStore.js accessOf), so the
 *              answer agrees with the rest of the response; left out = worked out here from `attendees`
 * The VIP flag (User.vip, Attendee.vip, `vip` from the caller) is never a tag since Oct 21 2026.
 */
export function profileTagOf(user, { attendees = [], types } = {}) {
  if (!user) return null;
  const rows = (Array.isArray(attendees) ? attendees : []).filter(Boolean);
  const passes = [...(Array.isArray(user.tickets) ? user.tickets : []), ...rows].filter((p) => p && !isBooth(p));
  const list = Array.isArray(types) ? types : effectiveTypes(user, { exhibitor: rows.some(isExhibitorPass), media: rows.some(isMediaPass) });
  const has = (t) => list.includes(t);
  if (has("media")) return tag("media");
  if (has("speaker") || passes.some(isSpeakerPass)) return tag("speaker");
  if (has("staff")) return tag("staff");
  if (has("volunteer")) return tag("volunteer");
  const best = bestPassTier(passes);
  // Exhibitors hold Connect Passes: "Exhibitor" says more. A better pass of theirs is named instead.
  if (has("exhibitor") && (!best || best === "connect")) return { key: "pass", label: EXHIBITOR_LABEL };
  return best ? { key: "pass", label: PASS_LABELS[best] } : null;
}
