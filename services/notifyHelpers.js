/* Pure helpers for personal notifications (staff → one or a few app users).
   Kept free of Mongoose so they're unit-testable. Used by routes/console.js
   (/api/console/notify…) and routes/social.js (/api/social/notifications…). */

export const TITLE_MAX = 80;
export const BODY_MAX = 500;
export const MAX_RECIPIENTS = 100;
export const LINK_MAX = 500;

/** Tabs the apps know how to open from `ttfc://tab/<name>`. */
export const APP_TABS = ["home", "feed", "network", "schedule", "venue", "profile", "ticket"];

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Where tapping the notification goes. Only our own app links and https web
 * pages are allowed (no javascript:, http:, tel:, other apps' schemes…).
 * Returns the cleaned link ("" = just open the app), or null when not allowed.
 */
export function cleanLink(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (s.length > LINK_MAX || /\s/.test(s)) return null;
  const tab = /^ttfc:\/\/tab\/([a-z]+)\/?$/i.exec(s);
  if (tab) return APP_TABS.includes(tab[1].toLowerCase()) ? `ttfc://tab/${tab[1].toLowerCase()}` : null;
  const session = /^ttfc:\/\/session\/([^/?#]+)(\/live)?\/?$/i.exec(s);
  if (session) return SESSION_ID.test(session[1]) ? `ttfc://session/${session[1]}${session[2] ? "/live" : ""}` : null;
  if (/^https:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (u.protocol !== "https:" || !u.hostname || !u.hostname.includes(".") || u.username || u.password) return null;
      return u.toString();
    } catch {
      return null;
    }
  }
  return null;
}

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const tidyBody = (s) => String(s ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

/**
 * Validates POST /api/console/notify. Over-long text is rejected (the panel
 * shows counters) rather than silently cut.
 * → { error } or { value: { userIds, title, body, link } }
 */
export function validateNotify(input) {
  const b = input && typeof input === "object" ? input : {};
  const title = oneLine(b.title);
  const body = tidyBody(b.body);
  if (!title) return { error: "Add a title." };
  if (title.length > TITLE_MAX) return { error: `Keep the title to ${TITLE_MAX} characters.` };
  if (!body) return { error: "Add a message." };
  if (body.length > BODY_MAX) return { error: `Keep the message to ${BODY_MAX} characters.` };
  const link = cleanLink(b.link);
  if (link === null) return { error: "That link can't be used. Pick a screen in the app, a session, or an https:// web page." };
  const raw = Array.isArray(b.userIds) ? b.userIds : [];
  const userIds = [...new Set(raw.map((x) => String(x ?? "").trim()).filter((x) => OBJECT_ID.test(x)))];
  if (!userIds.length) return { error: "Pick at least one person." };
  if (userIds.length > MAX_RECIPIENTS) return { error: `You can send to at most ${MAX_RECIPIENTS} people at once.` };
  return { value: { userIds, title, body, link } };
}

/** Same rule as the app's `onApp`: signed into the app at least once. */
export const ON_APP_FILTER = { $or: [{ appOnboarded: true }, { lastActiveAt: { $ne: null } }] };

const escapeRx = (q) => String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Mongo filter for the recipient picker: people on the app who aren't
 * suspended, optionally matching a search across name / email / company /
 * job title (every word must match somewhere).
 */
export function recipientFilter(q = "", ids = []) {
  const and = [ON_APP_FILTER, { banned: { $ne: true } }];
  const idList = (Array.isArray(ids) ? ids : []).map(String).filter((x) => OBJECT_ID.test(x));
  if (idList.length) and.push({ _id: { $in: idList } });
  const words = String(q || "").trim().split(/\s+/).filter(Boolean).slice(0, 5);
  for (const w of words) {
    const rx = new RegExp(escapeRx(w), "i");
    and.push({ $or: [{ name: rx }, { email: rx }, { organization: rx }, { jobTitle: rx }] });
  }
  return { $and: and };
}

/** A row in the panel's recipient search. */
export function recipientDTO(u) {
  const id = String(u._id || u.id);
  return {
    id,
    name: u.name || "",
    email: u.email || "",
    company: u.organization || "",
    jobTitle: u.jobTitle || "",
    avatarUrl: u.avatarVersion ? `/api/files/avatar/${id}?v=${u.avatarVersion}` : "",
    lastActiveAt: u.lastActiveAt || null,
  };
}

/** What the app gets for each of its notifications. */
export function notificationDTO(n) {
  return {
    id: String(n._id || n.id),
    title: n.title || "",
    body: n.body || "",
    link: n.link || "",
    kind: n.kind || "personal",
    sentByName: n.sentByName || "",
    createdAt: n.createdAt,
    readAt: n.readAt || null,
  };
}

/** `?since=` → Date, or null when missing/invalid. */
export function parseSince(s) {
  if (!s) return null;
  const d = new Date(String(s));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** POST /api/social/notifications/read → { all: true } | { ids: [...] } | null */
export function parseReadBody(b) {
  if (b?.all === true) return { all: true };
  const ids = [...new Set((Array.isArray(b?.ids) ? b.ids : []).map(String).filter((x) => OBJECT_ID.test(x)))].slice(0, 200);
  return ids.length ? { ids } : null;
}

/**
 * Groups notifications (newest first) into the sends they came from, for
 * "Recently sent" in the panel. `names` maps userId → display name.
 */
export function groupHistory(rows, names = new Map(), limit = 30) {
  const groups = new Map();
  for (const n of rows) {
    const key = n.batchId || String(n._id);
    let g = groups.get(key);
    if (!g) {
      if (groups.size >= limit) continue;
      g = { id: key, createdAt: n.createdAt, title: n.title, body: n.body, link: n.link || "",
            sentByName: n.sentByName || "", recipients: [], readCount: 0 };
      groups.set(key, g);
    }
    const uid = String(n.userId);
    g.recipients.push({ id: uid, name: names.get(uid) || "Deleted account", readAt: n.readAt || null });
    if (n.readAt) g.readCount += 1;
  }
  return [...groups.values()].map((g) => ({ ...g, total: g.recipients.length }));
}
