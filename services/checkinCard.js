import { profileTagOf, profileTagOfPass, PROFILE_TAG_COLORS, PROFILE_TAG_KEYS, PROFILE_TAG_LABELS, EXHIBITOR_LABEL } from "./profileTag.js";
import { effectiveTypes, isVip, isVipPass, isMediaPass, isExhibitorPass, isSpeakerPass } from "./teamRoles.js";
import { tierKey, displayPassName } from "./ticketInfo.js";
import { displayName } from "./attendeeDetails.js";
import { effectiveExtras, extrasOverride } from "./passExtras.js";
import { passHolder } from "./issuedPasses.js";
import { avatarFor } from "./socialHelpers.js";
import { namesAgree, speakerPhotoFor } from "./speakerPhotos.js";

/* =========================================================
   The door check-in card (Oct 22 2026)
   ---------------------------------------------------------
   The organiser: "When I scan someone's pass from the check-in
   page on the admin panel, show me their colour of the pass
   (green, red, gold etc.) and their photo (image) as well as pass
   type (Connect etc.)." For door staff on Oct 26–27.

   POST /api/checkin/scan (routes/checkin.js) adds to its answers
   (checked in now, and already checked in):
     badge      { key, label, bg, text }: the colour band, STAFF-FACING, so VIP is in it
                (the apps' Profile tag dropped VIP on Oct 21; door staff need it). The first that applies:
                  vip        "VIP"        gold   #F5C400 / #3D2E00   the VIP flag (services/teamRoles.js isVip,
                                                                     isVipPass for a pass-only person)
                  media      "Media"      #0B3D91 / white            ┐ the Profile tag
                  speaker    "Speaker"    #D01F2F / white            │ (services/profileTag.js, same
                  staff      "Staff"      #7B2FD0 / white            │ rules and colours)
                  volunteer  "Volunteer"  #FF6B00 / #3A1500          ┘
                  pass       the scanned pass's name ("Power Pass"), or "Exhibitor" when the Profile tag
                             says so (an exhibitor on a Connect Pass)  green #18A957 / #052E16
     avatarUrl  the holder's uploaded photo, else their speaker photo (services/speakerPhotos.js), else ""
     passName   "Connect Pass" | "Influence Pass" | "Power Pass" | "Apex Pass" | "Speaker Pass"
                (services/ticketInfo.js displayPassName: an exhibitor pass is a Connect Pass, an old
                "All Access" one the Power Pass; neither old name is printed at check-in)
     ticketType, speaker  as before
     name, title, company
     extras     { cxo, lunch, gala, awards }: what the pass includes (services/passExtras.js, staff's
                switches first), and cxoBreakfast (= extras.cxo)

   Whose card: the person holding the pass, never just whoever's
   account or email it sits on (holderIsAccount):
     - a ticket on an account is the account's, unless the checkout
       form names someone else on it (a buyer signed in and bought
       for a colleague): then the name on the pass, no photo of the
       account, and the colour of the pass's own record;
     - a guest / issued / speaker / exhibitor pass (Attendee) is the
       account that claimed it, else an account with its email AND
       an agreeing name (services/speakerPhotos.js namesAgree, the
       People directory's rule), else the pass alone: its Media /
       VIP / exhibitor marks, a Speaker Pass, its tier, and the
       speaker photo only when the speaker's name agrees.
   Pure: routes/checkin.js loads the records. Unit-tested in
   test/checkin-card.test.js, the route in test/checkin-db.test.js.
========================================================= */

/** In the order they win. */
export const CHECKIN_BADGE_KEYS = Object.freeze(["vip", ...PROFILE_TAG_KEYS]);
export const VIP_LABEL = "VIP";
/** Background and text colour of each band (the website's check-in page uses them as sent). */
export const CHECKIN_BADGE_COLORS = Object.freeze({
  vip: Object.freeze({ bg: "#F5C400", text: "#3D2E00" }),
  ...PROFILE_TAG_COLORS,
});

const str = (v) => String(v ?? "").trim();

/**
 * The band for a holder: `vip` (the flag), `tag` (their Profile tag, services/profileTag.js, or null), `passName`
 * (the scanned pass's name, the green band's words). → { key, label, bg, text }
 */
export function checkinBadge({ vip = false, tag = null, passName = "" } = {}) {
  let key = "pass";
  if (vip) key = "vip";
  else if (tag && tag.key !== "pass" && CHECKIN_BADGE_COLORS[tag.key]) key = tag.key;
  let label;
  if (key === "vip") label = VIP_LABEL;
  else if (key !== "pass") label = PROFILE_TAG_LABELS[key];
  else label = tag?.label === EXHIBITOR_LABEL ? EXHIBITOR_LABEL : str(passName) || "Pass";
  return { key, label, bg: CHECKIN_BADGE_COLORS[key].bg, text: CHECKIN_BADGE_COLORS[key].text };
}

/** The name the pass carries: the checkout form's first + last name, else the guest record's name ("" when none). */
const nameOnPass = (ticket, attendee) => (ticket ? displayName(ticket.details) : displayName(attendee?.details, attendee?.name));

/**
 * Is `account` the person holding this pass? Claimed by them: yes. Otherwise the name on the pass (the checkout
 * form's, else the guest record's) must agree with theirs; a pass that names nobody is the account's.
 */
export function holderIsAccount({ account = null, ticket = null, attendee = null } = {}) {
  if (!account) return false;
  if (attendee?.claimedBy && str(attendee.claimedBy) === str(account._id || account.id)) return true;
  const named = nameOnPass(ticket, attendee);
  return !named || namesAgree(account.name, named);
}

/**
 * The card for a scanned ticket, from the records routes/checkin.js found:
 *   ticketId  as scanned (without TECHFEST:)
 *   account   the User whose tickets hold it, or who claimed it / has its email (null: none)
 *   ticket    that account's ticket (User.tickets[] entry) when it's on an account
 *   attendee  the Attendee row with this ticket ID (a guest / issued / speaker / exhibitor pass, or the claimed
 *             copy of an account's ticket), or null
 *   rows      the account's Attendee rows (claimed by them or with one of their ticket IDs): their VIP, Media and
 *             exhibitor marks
 * → { name, title, company, badge, avatarUrl, passName, ticketType, speaker, extras, cxoBreakfast }
 */
export function checkinCard({ ticketId = "", account = null, ticket = null, attendee = null, rows = [] } = {}) {
  const rec = ticket || attendee || {};
  const tier = ticket ? ticket.type : attendee?.ticketType;
  const passName = displayPassName(tier, ticketId);
  const details = (ticket ? ticket.details : attendee?.details) || {};
  // The pass as profileTagOfPass reads it: the guest record's marks, the scanned tier (an upgraded ticket's own).
  const pass = { ...(attendee || {}), ticketType: tier, promoCode: ticket?.promoCode || attendee?.promoCode };

  let name, title, company, vip, tag, extras, avatarUrl;
  if (holderIsAccount({ account, ticket, attendee })) {
    const marks = [...(Array.isArray(rows) ? rows : []), ...(attendee ? [attendee] : [])].filter(Boolean);
    const types = effectiveTypes(account, { exhibitor: marks.some(isExhibitorPass), media: marks.some(isMediaPass) });
    vip = isVip(account, { vipPass: marks.some(isVipPass) });
    tag = profileTagOf(account, { attendees: marks, types });
    extras = effectiveExtras({ ticketType: tier, types, vip, override: extrasOverride(ticket, attendee) });
    name = str(account.name) || nameOnPass(ticket, attendee);
    title = str(account.jobTitle) || str(details.jobTitle);
    company = str(account.organization) || str(details.organisation);
    avatarUrl = avatarFor(account);
  } else {
    // The pass alone (a pass-only person, or someone else's pass on an account): its own marks and tier.
    vip = isVipPass(attendee);
    tag = profileTagOfPass(pass);
    extras = effectiveExtras({ ticketType: tier, ...passHolder(attendee), override: extrasOverride(ticket, attendee) });
    name = nameOnPass(ticket, attendee) || str(attendee?.name);
    title = str(details.jobTitle);
    company = str(details.organisation);
    // A speaker's website photo when this pass is theirs (their Speaker Pass by ticket ID, names agreeing). Only the
    // guest record's own email: an account's email on a colleague's pass isn't the colleague's.
    avatarUrl = speakerPhotoFor({ name, tickets: [{ ticketId }], email: ticket ? "" : attendee?.email });
  }

  return {
    name,
    title,
    company,
    badge: checkinBadge({ vip, tag, passName }),
    avatarUrl: avatarUrl || "",
    passName,
    ticketType: tierKey(tier),
    speaker: isSpeakerPass(rec),
    extras,
    cxoBreakfast: !!extras.cxo,
  };
}

/** What the scanner still shows when the card couldn't be worked out (the check-in itself never waits on it). */
export function plainCard({ ticketId = "", name = "", tier = "", rec = null } = {}) {
  const passName = displayPassName(tier, ticketId);
  return {
    name: str(name), title: "", company: "",
    badge: checkinBadge({ passName }), avatarUrl: "", passName, ticketType: tierKey(tier), speaker: isSpeakerPass(rec),
  };
}
