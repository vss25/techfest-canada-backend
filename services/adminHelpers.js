/* Pure helpers for analytics and the admin console (unit-tested). */

import { SITE_FILE_KEYS, cleanSiteFileUrl } from "./siteFiles.js";
import { SWAG_DEFAULTS, cleanSwagContent } from "./swagRules.js";
import { STAY_DEFAULTS } from "./waitlist.js";

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

/** Where a batch of events came from. */
export const EVENT_PLATFORMS = Object.freeze(["ios", "android", "web"]);

/** `platform` from POST /api/app/events: "ios" | "android" | "web". The
    Android app (Analytics.kt) doesn't send it yet but ends appVersion with
    "android" ("1.0.1 (3) android"); anything else or missing is an iOS build. */
export function eventPlatform(body) {
  const p = String(body?.platform ?? "").trim().toLowerCase();
  if (EVENT_PLATFORMS.includes(p)) return p;
  if (/\bandroid\b/i.test(String(body?.appVersion ?? ""))) return "android";
  return "ios";
}

/** Editable app texts: the keys the app understands, with defaults. */
export const CONTENT_KEYS = {
  "login.tagline": "Canada's first-of-its-kind\ndeal-making technology platform.",
  "welcome.subtitle": "Glad you're here",
  "home.announcement": "",
  "home.announcement_link": "",
  "home.spotlight_title": "Your spotlight",
  "home.partners_title": "In attendance",
  "feed.empty": "Be the first to post — everyone at TTFC will see it.",
  "network.empty": "Scan someone's badge QR when you meet, or open a speaker profile and tap 'Connect'.",
  "schedule.title": "Schedule",
  "ticket.help": "Bought with a different email? Enter the last name and ticket ID from that ticket email.",
  "support.email": "enquire@thetechfestival.com",
  "privacy.notice": "We record how you use the app (screens, taps, searches and interests) to run the event, match you with people and improve TTFC. Staff can review messages to keep the community safe.",
  "community.rules": "Be respectful. There is zero tolerance for harassment, hate, sexual or violent content, spam or scams. Anything that breaks these rules is removed and the account can be suspended. Report or block anyone from the … menu.",
  "flag.show_partners": true,
  "flag.show_news": true,
  "flag.allow_posts": true,
  "flag.allow_groups": true,
  "flag.polls": true,                      // off = live polls hidden in the apps, votes refused
  "flag.qa": true,                         // off = audience Q&A hidden in the apps, questions refused
  /* Pass upgrades (Oct 19 2026, the organiser: "don't offer upgrades at all"). Off = no upgrade offers on the
     website, the web app or the apps, and GET /payments/upgrade-quote and upgrade checkouts are refused
     (403 upgrades_off). Speakers' passes are never upgraded, even when this is on. */
  "flag.upgrades": false,
  /* Ticket offer shown to guests in the web app (/app). It only shows while the code is live
     (POST /api/promos/validate) and before offer.guest_ends. Promotions are banned (Oct 18 2026): it was
     switched off then, defaults to off, and the console refuses switching it on for anyone
     (services/staffPowers.js). The admin panel no longer shows these five settings. */
  "flag.guestOffer": false,
  "offer.guest_code": "APP50",
  "offer.guest_discount": "50",
  "offer.guest_ends": "2026-10-21T23:59:00-04:00",   // ISO time with offset (Toronto)
  "offer.guest_passes": "Connect, Influence and Power",

  /* Website (Site settings page in the admin panel). Empty text = use the built-in default. */
  "site.announcement": "",                 // bar across the top of every page
  "site.announcement_link": "",
  "site.ticket_sales_open": true,          // off = buy buttons disabled, message shown
  "site.ticket_sales_message": "Ticket sales are paused right now. Please check back soon.",
  "site.nominations_open": true,
  /* "Show award applications in the app" (Oct 21 2026): the Catalyst Awards Applications list in the apps and the
     web app (GET /api/app/awards/applications, services/awardApplications.js). Off = the list is empty
     ({ enabled: false }) and the apps hide the Applications entry; the category count still shows. */
  "site.award_applications": true,
  "site.volunteer_open": true,
  "site.show_agenda": true,
  "flag.pwaPrompt": false,                 // on = the website offers "install the app" (the PWA at /app/)
  "site.hero_tagline": "",
  "site.contact_email": "enquire@thetechfestival.com",
  "site.linkedin_url": "",
  "site.instagram_url": "",
  "site.x_url": "",
  /* Large site files (Admin › Site settings › Large site files): the Sanity CDN copies of the home page
     video and the brochure PDF, uploaded through POST /api/cms/upload-file. Empty = the website's own copy
     (public/hero-bg.mp4, public/Brochure.pdf). Only "" or this project's cdn.sanity.io file URLs are saved
     (services/siteFiles.js). */
  "site.hero_video_url": "",
  "site.brochure_url": "",
  /* "Win the TTFC swag kit" (Oct 22 2026, services/swagRules.js): swag.enabled (off until management turns it on),
     swag.kits (1–50), swag.cutoff and swag.announce (ISO times with their offset, Toronto), swag.title, swag.rules
     ({kits}, {cutoff}, {announce} filled in by GET /api/app/swag). Management only (services/staffPowers.js). */
  ...SWAG_DEFAULTS,
  /* "Stay updated": the TTFC 2027 waitlist page (website /stay-updated, the web app's /app/stay-updated) and the
     person's "You're on the TTFC 2027 waitlist" email (Oct 23 2026, services/waitlist.js). Plain text, any staff;
     empty = the default. stay.thanks is also POST /api/stay-updated's answer. */
  ...STAY_DEFAULTS,
};

/** Validates a content update; returns [key, value] or null. */
export function cleanContent(key, value) {
  if (!Object.prototype.hasOwnProperty.call(CONTENT_KEYS, key)) return null;
  const def = CONTENT_KEYS[key];
  if (typeof def === "boolean") return [key, value === true || value === "true"];
  if (Object.prototype.hasOwnProperty.call(SITE_FILE_KEYS, key)) {
    const url = cleanSiteFileUrl(key, value);
    return url === null ? null : [key, url];
  }
  const swag = cleanSwagContent(key, value);
  if (swag !== undefined) return swag;
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
