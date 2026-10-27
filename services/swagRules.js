/* =========================================================
   "Win the TTFC swag kit" (Oct 22 2026): the settings and the rules. Pure.
   ---------------------------------------------------------
   The organiser: "add offers like download the app and get a chance
   to win the swag kit … and they can win that through the gamified
   version in the app". The top `swag.kits` people on the points
   leaderboard at `swag.cutoff` win; winners are told in the app at
   `swag.announce`, only when management clicks "Announce winners"
   (routes/swag.js). Settings are app content keys (Admin › Website &
   app; services/adminHelpers.js CONTENT_KEYS), so GET /api/app/content
   carries them too; GET /api/app/swag gives them worked out.
   Oct 22 2026, the organiser: it's "an advertisement for the app …
   download the app, and then only you can get a chance to win this.
   Very important … Winners will be told end of day 1." The offer is in
   the app invite email (services/appInviteEmail.js), not a campaign of
   its own; the cutoff is Day 1, 4 PM, the announcement Day 1, 5 PM.
   Oct 26 2026, the organiser: "Keep the 5 PM announcement automatic
   within the app." swag.autoAnnounce (on by default, management only):
   at swag.announce the minute job announces the winners itself
   (services/swag.js runSwagAutoAnnounce), exactly as management's
   "Announce winners" would; the button still works before then, and
   whichever comes first wins.
   Oct 27 2026, about 2:30 AM, the organiser: the leaderboard winners
   do NOT get a swag kit (swag kits go to everyone who tags TTFC on
   LinkedIn or Instagram). The leaderboard is now an appreciation for
   starting conversations and meeting people: "you've been the best
   networker; people like you make the TTFC experience great". So:
     - swag.celebrate (on by default, management only) is what the
       leaderboard snapshot, the 5 PM announcement (automatic or the
       button) and the winners in GET /api/app/swag and
       /api/console/swag depend on: "celebrate the top {kits}
       networkers at swag.announce";
     - swag.enabled now only means "show the old prize banner in the
       app versions that still have it" (1.0.3 / 1.0.6, and the app
       invite email's old block); it's off;
     - no prize wording in the defaults: the title, the note (rules),
       the pitch, the notification ("You're one of TTFC's top
       networkers!"); nothing about collecting a kit, a skill-testing
       question or Quebec residents (no contest, no contest rules);
     - at the announcement one official feed post names them
       (swag.feedPost, {list}), not pushed to everyone.
========================================================= */

export const SWAG_DEFAULTS = Object.freeze({
  "swag.enabled": false,                                   // old apps' prize banner (1.0.3 / 1.0.6): off since Oct 27 2026
  "swag.kits": "3",                                        // how many top networkers to celebrate
  "swag.cutoff": "2026-10-26T16:00:00-04:00",              // the leaderboard is kept then (production: Day 2, 5 PM)
  "swag.announce": "2026-10-26T17:00:00-04:00",            // the top networkers are celebrated then
  "swag.title": "Top networkers of TTFC 2026",
  "swag.rules": "The leaderboard is our thank-you to the people who start conversations and meet people at TTFC 2026. You earn points in the TTFC app by connecting with people, saving sessions, posting and taking part. At {announce} we'll celebrate the top {kits} networkers in the app: people like them make the TTFC experience great. It's an appreciation, not a contest: there's no prize, nothing to buy and nothing to enter. Only attendees with 'Show me on the leaderboard' on are shown; TTFC staff and volunteers aren't included.",
  "swag.autoAnnounce": true,                               // celebrate them by itself at swag.announce
  "swag.celebrate": true,                                  // celebrate the top {kits} networkers at swag.announce
  "swag.feedPost": "Our top networkers at TTFC 2026: {list}. Thank you for starting conversations and meeting people — people like you make TTFC great. Thank you to everyone who connected this week!",
});
/** The admin panel's labels for the keys (GET /api/console/app-content `label`). */
export const SWAG_LABELS = Object.freeze({
  "swag.enabled": "Old apps (1.0.3 / 1.0.6): show the swag kit prize banner",
  "swag.kits": "How many top networkers to celebrate",
  "swag.cutoff": "Leaderboard closes at",
  "swag.announce": "Celebrate the top networkers at",
  "swag.title": "Leaderboard title",
  "swag.rules": "Leaderboard note ({kits}, {cutoff}, {announce})",
  "swag.autoAnnounce": "Celebrate them automatically at that time",
  "swag.celebrate": "Celebrate the top networkers (leaderboard snapshot, announcement, winners card)",
  "swag.feedPost": "Feed post naming the top networkers ({list} = 1. Name, Organisation · 2. …)",
});
export const SWAG_KEYS = Object.freeze(Object.keys(SWAG_DEFAULTS));
export const MAX_KITS = 50;
export const SWAG_PAGE = "https://www.thetechfestival.com/swag";
export const SWAG_PHOTO = "https://www.thetechfestival.com/swag/swag-kit-1200.jpg";
export const INSTALL_URL = "https://www.thetechfestival.com/app/install";
/** What each top networker gets in the app (a notification and a push), since Oct 27 2026: no prize. */
export const WINNER_NOTE = Object.freeze({
  title: "You're one of TTFC's top networkers!",
  body: "Thank you for starting conversations and meeting people at TTFC 2026. People like you make the TTFC experience great.",
});
/** Where the notification opens: the Profile tab, where the apps keep Points and the leaderboard (web: /app/profile). */
export const LEADERBOARD_LINK = "ttfc://tab/profile";
export const LEADERBOARD_URL = "/app/profile";
/** The line for the apps and the website (Oct 27 2026: an appreciation, not a prize). */
export const SWAG_PITCH = "Start conversations and meet people in the TTFC app";

const TZ = "America/Toronto";
const str = (v) => String(v ?? "");

/** A saved value for a swag key, checked: [key, value] or null (refused). */
export function cleanSwagContent(key, value) {
  if (key === "swag.kits") {
    const n = Number(str(value).trim());
    return Number.isInteger(n) && n >= 1 && n <= MAX_KITS ? [key, String(n)] : null;
  }
  if (key === "swag.feedPost") {
    const t = str(value).trim().slice(0, 2000);
    return t.includes("{list}") ? [key, t] : null;   // it must name them
  }
  if (key === "swag.cutoff" || key === "swag.announce") {
    const s = str(value).trim();
    return s && !Number.isNaN(new Date(s).getTime()) && /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? [key, s] : null;   // with its offset
  }
  return undefined;   // not special: the usual cleaning
}

const when = (v, fallback) => {
  const d = new Date(str(v).trim());
  return Number.isNaN(d.getTime()) ? new Date(fallback) : d;
};

/** "3:00 PM on Tuesday, October 27" (Toronto). */
export function longTime(d) {
  const t = new Date(d);
  const time = t.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
  const day = t.toLocaleDateString("en-US", { timeZone: TZ, weekday: "long", month: "long", day: "numeric" });
  return `${time} on ${day}`;
}
/** "Oct 27, 3 PM" (Toronto): the apps' banner. */
export function shortTime(d) {
  const t = new Date(d);
  const day = t.toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric" });
  const time = t.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).replace(":00", "");
  return `${day}, ${time}`;
}

/** Stored values (AppContent rows' { key: value }) → the settings, defaults filled in, parsed. */
export function swagSettings(stored = {}) {
  const v = (k) => (stored[k] === undefined || stored[k] === null || stored[k] === "" ? SWAG_DEFAULTS[k] : stored[k]);
  const enabled = v("swag.enabled") === true || v("swag.enabled") === "true";
  const autoAnnounce = !(v("swag.autoAnnounce") === false || v("swag.autoAnnounce") === "false");
  const celebrate = !(v("swag.celebrate") === false || v("swag.celebrate") === "false");
  const kitsN = Number(v("swag.kits"));
  const kits = Number.isInteger(kitsN) && kitsN >= 1 && kitsN <= MAX_KITS ? kitsN : 3;
  const cutoff = when(v("swag.cutoff"), SWAG_DEFAULTS["swag.cutoff"]);
  const announce = when(v("swag.announce"), SWAG_DEFAULTS["swag.announce"]);
  return {
    enabled, kits, cutoff, announce, autoAnnounce, celebrate,
    feedPostText: str(v("swag.feedPost")).trim().includes("{list}") ? str(v("swag.feedPost")).trim() : SWAG_DEFAULTS["swag.feedPost"],
    title: str(v("swag.title")).trim() || SWAG_DEFAULTS["swag.title"],
    rulesText: str(v("swag.rules")).trim() || SWAG_DEFAULTS["swag.rules"],
  };
}

/** "5 PM", "4:30 PM" (Toronto): who announced automatically ("Automatic (5 PM)"). */
export function clockTime(d) {
  return new Date(d).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).replace(":00", "");
}

/** Why a swag key's value was refused, in plain words ("" = no particular reason). */
export function swagContentError(key, value) {
  if (key === "swag.feedPost" && !str(value).includes("{list}")) return "The feed post must contain {list}, where the top networkers are named.";
  return "";
}

/** The feed post naming them: {list} = "1. Name, Organisation · 2. …" (and {kits} {cutoff} {announce}). */
export function feedPostFor(s, winners = []) {
  const list = winners.map((w, i) => `${i + 1}. ${str(w.name).trim()}${str(w.organization).trim() ? `, ${str(w.organization).trim()}` : ""}`).join(" · ");
  return fillSwag(str(s.feedPostText || SWAG_DEFAULTS["swag.feedPost"]), s).replace(/\{list\}/g, list).slice(0, 4000);
}

/** {kits}, {cutoff}, {announce} in a text (the rules, the email). */
export function fillSwag(text, s) {
  return str(text).replace(/\{(kits|cutoff|announce)\}/g, (m, k) =>
    (k === "kits" ? String(s.kits) : k === "cutoff" ? longTime(s.cutoff) : longTime(s.announce)));
}

/** "open" (before the cutoff) | "closed" (counting is over) | "announced" (winners told). */
export function swagPhase(s, { now = new Date(), announced = false } = {}) {
  if (announced) return "announced";
  return new Date(now) < s.cutoff ? "open" : "closed";
}

/** GET /api/app/swag. `winners` (publicWinners, an array) are added once the winners are announced, never before. */
export function publicSwag(s, { now = new Date(), announced = false, winners = null } = {}) {
  return {
    enabled: s.enabled, title: s.title, kits: s.kits, appOnly: true, pitch: SWAG_PITCH,
    cutoff: s.cutoff.toISOString(), announce: s.announce.toISOString(),
    cutoffLabel: longTime(s.cutoff), cutoffShort: shortTime(s.cutoff), announceLabel: longTime(s.announce),
    rules: fillSwag(s.rulesText, s),
    celebrate: s.celebrate !== false, mode: "appreciation",
    phase: swagPhase(s, { now, announced }), announced,
    rulesUrl: SWAG_PAGE, photoUrl: SWAG_PHOTO, installUrl: INSTALL_URL,
    ...(announced && Array.isArray(winners) ? { winners } : {}),
  };
}

/* Oct 26 2026: the cutoff moved after the leaderboard was kept. The organiser moved swag.cutoff and swag.announce
   from Day 1 (4 PM / 5 PM) to Day 2, 5 PM, the evening of Day 1, after the minute job had already kept the
   leaderboard at the old cutoff (AppContent "swag.snapshot", takenAt Oct 26 20:00:48Z). A kept leaderboard now
   counts only for the cutoff it was kept at: taken at or after the current cutoff, or at most
   SNAPSHOT_TOLERANCE_MS before it (server clocks, a cutoff nudged by a minute after the job ran). One kept at an
   earlier cutoff is stale: the winners are worked out live until the new cutoff, and the job keeps a fresh one then
   (services/swag.js takeSnapshot, which keeps the stale one under "swag.snapshot.previous"). */
export const SNAPSHOT_TOLERANCE_MS = 5 * 60 * 1000;

/** Does this kept leaderboard ({ takenAt, rows }) count for this cutoff? */
export function snapshotCounts(snap, cutoff, toleranceMs = SNAPSHOT_TOLERANCE_MS) {
  const taken = snap?.takenAt ? new Date(snap.takenAt).getTime() : NaN;
  const cut = cutoff ? new Date(cutoff).getTime() : NaN;
  return Number.isFinite(taken) && Number.isFinite(cut) && taken >= cut - toleranceMs;
}

/**
 * The announced winners as the apps show them (GET /api/app/swag, the podium and the confetti): the announced
 * record's winners in its order. `rank` is the podium place (1, 2, 3 …); `boardRank` their place on the leaderboard
 * at the cutoff (people who can't win are passed over, so it can be 4 for the first winner). `avatarOf(userId)`: the
 * photo now (services/socialHelpers.js avatarFor on their account; "" none). Never an email.
 */
export function publicWinners(announced, avatarOf = () => "") {
  const list = Array.isArray(announced?.winners) ? announced.winners : [];
  return list.map((w, i) => {
    const userId = str(w?.userId);
    return {
      rank: i + 1, boardRank: Number(w?.rank) || 0, name: str(w?.name), organization: str(w?.organization),
      avatarUrl: str(avatarOf(userId) || ""), points: Number(w?.points) || 0, userId,
    };
  });
}

const isBooth = (t) => /^BOOTH-/i.test(str(t?.ticketId)) || /^booth/i.test(str(t?.type));

/**
 * Can this person win? On the leaderboard (not opted out or hidden from the attendee list), a pass of their own,
 * not staff or a volunteer (role or type) or a moderator, not suspended. `types` / `rights`: services/appRights.js
 * personAccess. People hidden from the app are left out by the caller (they're not on the leaderboard either).
 */
export function swagEligible(user, { types = [], rights = {} } = {}) {
  if (!user || user.banned) return false;
  if (user.role === "admin" || user.role === "volunteer") return false;
  if (types.includes("staff") || types.includes("volunteer") || rights?.moderate) return false;
  if (user.hideFromLeaderboard || user.directoryHidden) return false;
  return (Array.isArray(user.tickets) ? user.tickets : []).some((t) => t?.ticketId && !isBooth(t));
}

/** The leaderboard's rows (rank order) and who's eligible → the first `kits` eligible: [{ userId, name, organization, points, rank }]. */
export function pickWinners(rows = [], eligible = () => true, kits = 3) {
  const out = [];
  for (const r of rows) {
    if (out.length >= kits) break;
    const id = str(r?.user?.id || r?.userId);
    if (!id || !eligible(id)) continue;
    out.push({ userId: id, name: str(r.user?.name || r.name), organization: str(r.user?.organization || r.organization), points: Number(r.points) || 0, rank: Number(r.rank) || 0 });
  }
  return out;
}
