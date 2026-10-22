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
========================================================= */

export const SWAG_DEFAULTS = Object.freeze({
  "swag.enabled": false,                                   // management turns it on
  "swag.kits": "3",
  "swag.cutoff": "2026-10-27T15:00:00-04:00",              // Toronto (EDT)
  "swag.announce": "2026-10-27T16:00:00-04:00",
  "swag.title": "Win the TTFC swag kit",
  "swag.rules": "Earn points in the TTFC app by connecting, saving sessions, posting and taking part. The top {kits} people on the leaderboard at {cutoff} each win a TTFC swag kit. Open to registered TTFC 2026 attendees with 'Show me on the leaderboard' on; TTFC staff, volunteers and their families can't win. Winners are told in the app at {announce} and collect their kit at the registration desk, Harbour Ballroom foyer, after answering a skill-testing question. No purchase necessary. Prizes have no cash value and can't be exchanged.",
});
export const SWAG_KEYS = Object.freeze(Object.keys(SWAG_DEFAULTS));
export const MAX_KITS = 50;
export const SWAG_PAGE = "https://www.thetechfestival.com/swag";
export const SWAG_PHOTO = "https://www.thetechfestival.com/swag/swag-kit-1200.jpg";
export const INSTALL_URL = "https://www.thetechfestival.com/app/install";
export const WINNER_NOTE = Object.freeze({ title: "You won a TTFC swag kit!", body: "Collect it at the registration desk." });

const TZ = "America/Toronto";
const str = (v) => String(v ?? "");

/** A saved value for a swag key, checked: [key, value] or null (refused). */
export function cleanSwagContent(key, value) {
  if (key === "swag.kits") {
    const n = Number(str(value).trim());
    return Number.isInteger(n) && n >= 1 && n <= MAX_KITS ? [key, String(n)] : null;
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
  const kitsN = Number(v("swag.kits"));
  const kits = Number.isInteger(kitsN) && kitsN >= 1 && kitsN <= MAX_KITS ? kitsN : 3;
  const cutoff = when(v("swag.cutoff"), SWAG_DEFAULTS["swag.cutoff"]);
  const announce = when(v("swag.announce"), SWAG_DEFAULTS["swag.announce"]);
  return {
    enabled, kits, cutoff, announce,
    title: str(v("swag.title")).trim() || SWAG_DEFAULTS["swag.title"],
    rulesText: str(v("swag.rules")).trim() || SWAG_DEFAULTS["swag.rules"],
  };
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

/** GET /api/app/swag. */
export function publicSwag(s, { now = new Date(), announced = false } = {}) {
  return {
    enabled: s.enabled, title: s.title, kits: s.kits,
    cutoff: s.cutoff.toISOString(), announce: s.announce.toISOString(),
    cutoffLabel: longTime(s.cutoff), cutoffShort: shortTime(s.cutoff), announceLabel: longTime(s.announce),
    rules: fillSwag(s.rulesText, s),
    phase: swagPhase(s, { now, announced }), announced,
    rulesUrl: SWAG_PAGE, photoUrl: SWAG_PHOTO, installUrl: INSTALL_URL,
  };
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
