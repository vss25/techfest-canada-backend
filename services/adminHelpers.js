/* Pure helpers for analytics and the admin console (unit-tested). */

const NAME_RX = /^[a-z][a-z0-9_]{1,40}$/;

/** Clean one event from the app; returns null when unusable. */
export function cleanEvent(e, now = Date.now()) {
  if (!e || typeof e !== "object") return null;
  const name = String(e.name || "").trim().toLowerCase();
  if (!NAME_RX.test(name)) return null;
  const at = new Date(e.at || now);
  const t = isNaN(at) ? new Date(now) : at;
  // Ignore clocks more than a day in the future or a month in the past.
  if (t.getTime() > now + 864e5 || t.getTime() < now - 30 * 864e5) return null;
  const props = {};
  if (e.props && typeof e.props === "object") {
    for (const [k, v] of Object.entries(e.props).slice(0, 20)) {
      if (!/^[a-zA-Z0-9_]{1,40}$/.test(k)) continue;
      if (typeof v === "string") props[k] = v.slice(0, 300);
      else if (typeof v === "number" || typeof v === "boolean") props[k] = v;
    }
  }
  return {
    name,
    screen: String(e.screen || "").slice(0, 60),
    target: String(e.target || "").slice(0, 120),
    props,
    at: t,
  };
}

/** Editable app texts: the keys the app understands, with defaults. */
export const CONTENT_KEYS = {
  "login.tagline": "Canada's first-of-its-kind\ndeal-making technology platform.",
  "welcome.subtitle": "Glad you're here",
  "home.announcement": "",
  "home.announcement_link": "",
  "home.spotlight_title": "Your spotlight",
  "home.partners_title": "Event partners",
  "feed.empty": "Be the first to post — everyone at TTFC will see it.",
  "network.empty": "Scan someone's badge QR when you meet, or open a speaker profile and tap 'Connect'.",
  "schedule.title": "Schedule",
  "ticket.help": "Bought with a different email? Enter the last name and ticket ID from that ticket email.",
  "support.email": "info@thetechfestival.com",
  "privacy.notice": "We record how you use the app (screens, taps, searches and interests) to run the event, match you with people and improve TTFC. Staff can review messages to keep the community safe.",
  "flag.show_partners": true,
  "flag.show_news": true,
  "flag.allow_posts": true,
  "flag.allow_groups": true,
};

/** Validates a content update; returns [key, value] or null. */
export function cleanContent(key, value) {
  if (!Object.prototype.hasOwnProperty.call(CONTENT_KEYS, key)) return null;
  const def = CONTENT_KEYS[key];
  if (typeof def === "boolean") return [key, value === true || value === "true"];
  return [key, String(value ?? "").slice(0, 2000)];
}

/** "Most used" summary from a list of events. */
export function summarize(events) {
  const count = (f) => {
    const m = new Map();
    for (const e of events) { const k = f(e); if (k) m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => ({ key: k, count: n }));
  };
  return {
    total: events.length,
    screens: count((e) => (e.name === "screen_view" ? e.screen : null)),
    taps: count((e) => (e.name === "tap" ? `${e.screen} › ${e.target}` : null)),
    interests: count((e) => e.props?.topic || e.props?.company || e.props?.speaker || null),
    searches: count((e) => (e.name === "search" ? e.props?.query : null)),
    lastSeen: events.reduce((m, e) => (!m || e.at > m ? e.at : m), null),
  };
}
